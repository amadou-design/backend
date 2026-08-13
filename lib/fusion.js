// BoeufTrack - Fusion multi-images
// 1) Filtre : images sans bovine détecté par le LLM sont rejetées
// 2) Outliers : MAD (Median Absolute Deviation), rejet si |z_mad| > 3.5 et n >= 3
// 3) Estimation centrale : moyenne pondérée par (qualité * confiance du LLM)
// 4) Range : fusion des [min,max] individuels, resserrement par √n (plus on a d'images cohérentes, plus on resserre)
// 5) Confiance finale : agrégat de qualité, confiance LLM, cohérence inter-images, nombre d'angles utiles
// 6) Narrative : phrase courte pour l'UI

'use strict';

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function mad(arr, med) {
  const m = med != null ? med : median(arr);
  const devs = arr.map(x => Math.abs(x - m));
  const madVal = median(devs);
  // constante 1.4826 -> σ robuste sous hypothèse gaussienne
  return { madVal, sigma: madVal * 1.4826, med: m };
}

function weightedMean(values, weights) {
  let sw = 0, swx = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.max(0, weights[i] || 0);
    sw += w;
    swx += w * values[i];
  }
  return sw > 0 ? swx / sw : values.reduce((a, b) => a + b, 0) / values.length;
}

function confidenceBandLabel(score) {
  if (score >= 75) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

// estimates[i] = { parsed (from llmAnalyzer), quality (from imageQuality), detection, angle, imageIndex }
function fuse(estimates, breedInfo) {
  const withBovine = estimates.filter(e => e.parsed && e.parsed.hasBovine);
  const rejected = [];

  // Si aucune image ne contient de bovin selon le LLM, on renvoie un résultat explicite
  if (withBovine.length === 0) {
    const fallback = {
      weightKg: breedInfo.meanKg,
      rangeMin: breedInfo.minKg,
      rangeMax: breedInfo.maxKg,
      confidence: 0,
      confidenceBand: 'low',
      bcs: null,
      breedGuess: breedInfo.label,
      imagesUsed: 0,
      rejectedCount: estimates.length,
      narrative: 'Aucun bovin reconnu sur les photos fournies. Estimation non fiable — utilise des photos où l\'animal est entièrement visible.',
      limitations: 'Pas de bovin détecté par le modèle sur les images.',
      perImage: estimates.map((e, i) => ({
        index: e.imageIndex ?? i,
        used: false,
        reason: 'no_bovine',
        weightKg: e.parsed?.weightKg ?? null,
        confidence: e.parsed?.confidence ?? null,
        angle: e.parsed?.angle ?? null
      })),
      outliers: []
    };
    return fallback;
  }

  // 1) Outlier detection avec MAD si n >= 3
  const weights = withBovine.map(e => e.parsed.weightKg);
  let keep = withBovine.slice();
  let outliers = [];

  if (withBovine.length >= 3) {
    const { med, madVal, sigma } = mad(weights);
    const threshold = sigma > 0 ? 3.5 * sigma : Math.max(30, 0.15 * med);
    keep = [];
    for (const e of withBovine) {
      const dist = Math.abs(e.parsed.weightKg - med);
      if (dist > threshold) {
        outliers.push({
          index: e.imageIndex,
          weightKg: e.parsed.weightKg,
          deltaFromMedian: Math.round(dist),
          reason: 'outlier'
        });
      } else {
        keep.push(e);
      }
    }
    // Garde-fou : si MAD a tout rejeté, on garde tout
    if (keep.length === 0) { keep = withBovine.slice(); outliers = []; }
  }

  // 2) Poids de fusion = qualité × confiance LLM
  const w = keep.map(e => {
    const q = (e.quality && typeof e.quality.qualityScore === 'number') ? e.quality.qualityScore : 0.5;
    const c = (e.parsed.confidence || 50) / 100;
    // Petit bonus si un détecteur externe a confirmé le bovin avec un bon score
    const detBonus = (e.detection && e.detection.detected && e.detection.score >= 0.7) ? 1.1 : 1;
    return Math.max(0.05, q * c * detBonus);
  });
  const weightKg = Math.round(weightedMean(keep.map(e => e.parsed.weightKg), w));

  // 3) Range fusionné : moyenne des bornes, resserrée par √n
  const avgMin = weightedMean(keep.map(e => e.parsed.rangeMin), w);
  const avgMax = weightedMean(keep.map(e => e.parsed.rangeMax), w);
  const shrink = 1 / Math.sqrt(keep.length); // n=1 -> 1.0, n=4 -> 0.5
  const baseSpreadLow = weightKg - avgMin;
  const baseSpreadHigh = avgMax - weightKg;
  let rangeMin = Math.round(weightKg - baseSpreadLow * shrink);
  let rangeMax = Math.round(weightKg + baseSpreadHigh * shrink);
  // Clamp dans la plage race élargie
  rangeMin = Math.max(Math.round(breedInfo.minKg * 0.5), rangeMin);
  rangeMax = Math.min(Math.round(breedInfo.maxKg * 1.5), rangeMax);
  if (rangeMin > weightKg) rangeMin = weightKg;
  if (rangeMax < weightKg) rangeMax = weightKg;

  // 4) Confiance finale
  const avgConf = keep.reduce((s, e) => s + (e.parsed.confidence || 0), 0) / keep.length;
  const avgQual = keep.reduce((s, e) => s + ((e.quality?.qualityScore ?? 0.5)), 0) / keep.length;
  // Cohérence inter-images : 1 - dispersion relative (bornée)
  const spread = keep.length > 1
    ? (Math.max(...keep.map(e => e.parsed.weightKg)) - Math.min(...keep.map(e => e.parsed.weightKg)))
    : 0;
  const consistency = keep.length > 1 ? Math.max(0, 1 - spread / (weightKg || 1)) : 0.65;
  const nBonus = keep.length >= 3 ? 1.1 : keep.length === 2 ? 1.0 : 0.85;
  const anglesDistinct = new Set(keep.map(e => e.parsed.angle).filter(Boolean)).size;
  const angleBonus = anglesDistinct >= 2 ? 1.05 : 1;

  let finalConfidence = Math.round(
    (avgConf * 0.55 + avgQual * 100 * 0.25 + consistency * 100 * 0.20) * nBonus * angleBonus
  );
  finalConfidence = Math.max(0, Math.min(95, finalConfidence)); // plafonné à 95 tant qu'on a pas un vrai modèle entraîné

  // 5) BCS / race : moyenne pondérée BCS ; race = majorité simple sinon user/default
  const bcsWeights = keep.map((e, i) => w[i] || 0.1);
  const bcsVals = keep.map(e => e.parsed.bcs || 3);
  const bcs = Number(weightedMean(bcsVals, bcsWeights).toFixed(1));

  const breedVotes = {};
  for (const e of keep) {
    const k = (e.parsed.breedGuess || breedInfo.label || '').toLowerCase();
    if (!k) continue;
    breedVotes[k] = (breedVotes[k] || 0) + 1;
  }
  const topBreed = Object.entries(breedVotes).sort((a, b) => b[1] - a[1])[0];
  const breedGuess = topBreed ? topBreed[0].replace(/\b\w/g, c => c.toUpperCase()) : breedInfo.label;

  // 6) Narrative courte
  const band = confidenceBandLabel(finalConfidence);
  const bandLabel = band === 'high' ? 'élevée' : band === 'medium' ? 'moyenne' : 'faible';
  const anglesTxt = anglesDistinct >= 2
    ? `${keep.length} images / ${anglesDistinct} angles distincts`
    : `${keep.length} image${keep.length > 1 ? 's' : ''}`;
  const narrative = `Estimation basée sur ${anglesTxt} · confiance ${bandLabel} (${finalConfidence}%) · ancrage ${breedInfo.label}.`;

  const limitations = [];
  if (keep.length === 1) limitations.push('une seule image exploitable, ajoute profil + arrière pour resserrer la fourchette');
  if (avgQual < 0.45) limitations.push('qualité image moyenne (flou ou exposition)');
  if (anglesDistinct < 2 && keep.length > 1) limitations.push('angles peu diversifiés');
  if (outliers.length) limitations.push(`${outliers.length} image(s) rejetée(s) comme incohérente(s)`);

  return {
    weightKg,
    rangeMin,
    rangeMax,
    confidence: finalConfidence,
    confidenceBand: band,
    bcs,
    breedGuess,
    imagesUsed: keep.length,
    rejectedCount: estimates.length - keep.length,
    anglesDistinct,
    narrative,
    limitations: limitations.join(' · '),
    perImage: estimates.map((e, i) => {
      const usedHere = keep.includes(e);
      return {
        index: e.imageIndex ?? i,
        used: usedHere,
        reason: usedHere
          ? 'kept'
          : (e.parsed && !e.parsed.hasBovine ? 'no_bovine'
              : outliers.find(o => o.index === e.imageIndex) ? 'outlier'
              : 'filtered'),
        weightKg: e.parsed?.weightKg ?? null,
        confidence: e.parsed?.confidence ?? null,
        angle: e.parsed?.angle ?? null,
        qualityScore: e.quality?.qualityScore ?? null
      };
    }),
    outliers
  };
}

module.exports = { fuse };
