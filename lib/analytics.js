// BoeufTrack - Analytics précision IA vs carcasse
// v2.1.1 : support aiWeightAtSlaughter (override manuel), fenêtre 365j, matching bidirectionnel,
//          détection rendement impossible (> 0.70) — physiquement impossible.
//
// Méthode : on n'a pas de poids vif bascule, on a le poids carcasse après ressuyage.
// On reconstruit un "poids vif de référence" = carcasse / rendement(race, override),
// puis on compare à l'estimation IA.
//
// Hiérarchie de matching :
//   1) Si slaughter.aiWeightAtSlaughter fourni manuellement → on l'utilise directement.
//   2) Sinon on cherche la pesée IA la plus proche dans une fenêtre ±365j.
//      - On privilégie celles AVANT la date d'abattage (physiologiquement plus propre).
//      - Si rien avant, on prend la plus proche APRÈS (mais on flag isPostSlaughterMatch).
//
// Métriques :
//   - biais (mean signed error %) : + = IA surestime, - = IA sous-estime
//   - MAE (mean absolute error %) : magnitude moyenne de l'écart
//   - RMSE (root mean square error %) : pénalise les grands écarts
//   - rendement implicite moyen : carcasse / IA
//   - distribution : histogramme des erreurs en buckets de 5 %
//   - anomalies : abattages dont |error| > 20 %, rendement hors plage plausible, ou impossible

'use strict';

const { yieldFor, PLAUSIBLE_YIELD_MIN, PLAUSIBLE_YIELD_MAX, breedKeyFrom } = require('./yields');

function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function round(n, d = 2) { return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }

// Fenêtre de matching étendue à 365 jours : un élevage moyen tolère une estimation IA
// vieille de plusieurs mois, on flag juste la fraîcheur dans le UI.
const MATCH_WINDOW_DAYS = 365;

// Seuil rendement physiquement impossible : au-delà, la carcasse dépasse 70% du poids vif IA,
// ce qui n'arrive jamais (limite haute mondiale ~65% sur races à viande européennes).
// > 1.0 = carcasse PLUS LOURDE que le vif = absurde pur.
const IMPOSSIBLE_YIELD_THRESHOLD = 0.70;

// Cherche la pesée IA la plus proche de la date d'abattage, dans ±365 jours.
// Retourne { weighing, daysBetween (signé : + = pesée avant abattage, - = après), isPost }.
function findClosestAiWeighing(weighings, boeufId, slaughterDate) {
  const sd = new Date(slaughterDate).getTime();
  if (!Number.isFinite(sd)) return null;
  const candidates = weighings
    .filter(w => w.boeufId === boeufId && w.weight != null)
    .map(w => {
      const ts = new Date(w.date).getTime();
      return { w, ts, dayDiff: (sd - ts) / 86400000 };
    })
    .filter(x => Number.isFinite(x.ts) && Math.abs(x.dayDiff) <= MATCH_WINDOW_DAYS);
  if (!candidates.length) return null;
  // Priorité : plus proche en distance absolue, avec préférence légère pour AVANT abattage.
  candidates.sort((a, b) => {
    const aBefore = a.dayDiff >= 0 ? 0 : 1;
    const bBefore = b.dayDiff >= 0 ? 0 : 1;
    if (aBefore !== bBefore) return aBefore - bBefore; // before first
    return Math.abs(a.dayDiff) - Math.abs(b.dayDiff);
  });
  const best = candidates[0];
  return { weighing: best.w, daysBetween: best.dayDiff, isPost: best.dayDiff < 0 };
}

// Enrichit un slaughter avec les calculs dérivés.
function enrich(slaughter, { boeufs, weighings }) {
  const boeuf = boeufs.get ? boeufs.get(slaughter.boeufId) : null;
  const breedString = boeuf?.breed || null;
  const { value: yAppl, source: ySource } = yieldFor(breedString, slaughter.yieldOverride);

  const reconstructed = slaughter.carcassWeight / yAppl;

  // Source du poids IA : override manuel > matching auto
  let aiWeight = null;
  let aiSource = null;
  let aiWeighingId = null;
  let aiWeighingDate = null;
  let daysBetween = null;
  let isPostSlaughterMatch = false;

  if (typeof slaughter.aiWeightAtSlaughter === 'number' && slaughter.aiWeightAtSlaughter > 0) {
    aiWeight = slaughter.aiWeightAtSlaughter;
    aiSource = 'manual';
    daysBetween = 0;
  } else {
    const m = findClosestAiWeighing(weighings, slaughter.boeufId, slaughter.date);
    if (m) {
      aiWeight = m.weighing.weight;
      aiSource = m.isPost ? 'weighing_after' : 'weighing_before';
      aiWeighingId = m.weighing.id;
      aiWeighingDate = m.weighing.date;
      daysBetween = m.daysBetween;
      isPostSlaughterMatch = m.isPost;
    }
  }

  let errorPct = null;
  let implicitYield = null;
  if (aiWeight != null && aiWeight > 0) {
    errorPct = ((aiWeight - reconstructed) / reconstructed) * 100;
    implicitYield = slaughter.carcassWeight / aiWeight;
  }

  const isImpossible = implicitYield != null && implicitYield > IMPOSSIBLE_YIELD_THRESHOLD;
  const isAnomaly = errorPct != null && Math.abs(errorPct) > 20;
  const isYieldSuspect = implicitYield != null && (implicitYield < PLAUSIBLE_YIELD_MIN || implicitYield > PLAUSIBLE_YIELD_MAX);
  const isStaleMatch = daysBetween != null && Math.abs(daysBetween) > 90;

  return {
    ...slaughter,
    boeufName: boeuf?.name || null,
    boeufBreed: breedString,
    breedKey: breedKeyFrom(breedString),
    yieldApplied: round(yAppl, 3),
    yieldSource: ySource,
    reconstructedLiveWeight: round(reconstructed, 1),
    aiWeight: aiWeight != null ? round(aiWeight, 1) : null,
    aiSource,
    aiWeighingId,
    aiWeighingDate,
    daysBetween: daysBetween != null ? round(daysBetween, 1) : null,
    isPostSlaughterMatch,
    isStaleMatch,
    errorPct: errorPct != null ? round(errorPct, 2) : null,
    implicitYield: implicitYield != null ? round(implicitYield, 3) : null,
    isImpossible,
    isAnomaly,
    isYieldSuspect,
    isMatchable: aiWeight != null
  };
}

// Histogramme bucket 5 % centré sur 0.
function histogram(errors) {
  const BUCKETS = [
    { key: '<-30', min: -Infinity, max: -30 },
    { key: '-30/-25', min: -30, max: -25 },
    { key: '-25/-20', min: -25, max: -20 },
    { key: '-20/-15', min: -20, max: -15 },
    { key: '-15/-10', min: -15, max: -10 },
    { key: '-10/-5',  min: -10, max: -5 },
    { key: '-5/0',    min: -5,  max: 0 },
    { key: '0/5',     min: 0,   max: 5 },
    { key: '5/10',    min: 5,   max: 10 },
    { key: '10/15',   min: 10,  max: 15 },
    { key: '15/20',   min: 15,  max: 20 },
    { key: '20/25',   min: 20,  max: 25 },
    { key: '25/30',   min: 25,  max: 30 },
    { key: '>30',     min: 30,  max: Infinity }
  ];
  const counts = BUCKETS.map(b => ({ ...b, count: 0 }));
  for (const e of errors) {
    for (const b of counts) {
      if (e >= b.min && e < b.max) { b.count++; break; }
    }
  }
  return counts.map(b => ({ bucket: b.key, count: b.count }));
}

function precision(enrichedSlaughters) {
  // On exclut les "impossibles" du calcul de précision (ce sont des data issues, pas un signal IA)
  const matched = enrichedSlaughters.filter(s => s.isMatchable && !s.isImpossible);
  const errors = matched.map(s => s.errorPct);
  const absErrors = errors.map(Math.abs);
  const sqErrors = errors.map(e => e * e);
  const implicits = matched.map(s => s.implicitYield).filter(x => x != null);

  const allMatchable = enrichedSlaughters.filter(s => s.isMatchable);
  const anomalySet = allMatchable.filter(s => s.isImpossible || s.isAnomaly || s.isYieldSuspect);

  return {
    n: matched.length,
    nTotal: enrichedSlaughters.length,
    nUnmatched: enrichedSlaughters.length - allMatchable.length,
    nImpossible: allMatchable.filter(s => s.isImpossible).length,
    bias: errors.length ? round(mean(errors), 2) : null,
    mae:  absErrors.length ? round(mean(absErrors), 2) : null,
    rmse: sqErrors.length ? round(Math.sqrt(mean(sqErrors)), 2) : null,
    meanImplicitYield: implicits.length ? round(mean(implicits), 3) : null,
    medianImplicitYield: implicits.length ? round([...implicits].sort((a,b)=>a-b)[Math.floor(implicits.length/2)], 3) : null,
    histogram: histogram(errors),
    anomalies: anomalySet.map(s => ({
      id: s.id,
      boeufId: s.boeufId,
      boeufName: s.boeufName,
      date: s.date,
      carcassWeight: s.carcassWeight,
      aiWeight: s.aiWeight,
      reconstructedLiveWeight: s.reconstructedLiveWeight,
      errorPct: s.errorPct,
      implicitYield: s.implicitYield,
      daysBetween: s.daysBetween,
      reason: s.isImpossible ? 'physically_impossible'
            : s.isAnomaly && s.isYieldSuspect ? 'error_and_yield'
            : s.isAnomaly ? 'error_gt_20pct'
            : 'yield_out_of_range'
    }))
  };
}

function timeline(enrichedSlaughters) {
  const matched = enrichedSlaughters.filter(s => s.isMatchable && !s.isImpossible);
  const byMonth = new Map();
  for (const s of matched) {
    const d = new Date(s.date);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(s.errorPct);
  }
  const points = [];
  for (const [k, errs] of [...byMonth.entries()].sort()) {
    points.push({
      month: k,
      n: errs.length,
      bias: round(mean(errs), 2),
      mae: round(mean(errs.map(Math.abs)), 2)
    });
  }
  return points;
}

function yieldDistribution(enrichedSlaughters) {
  const matched = enrichedSlaughters.filter(s => s.isMatchable && s.implicitYield != null && !s.isImpossible);
  const BUCKETS = [];
  for (let lo = 0.40; lo < 0.65; lo += 0.02) {
    BUCKETS.push({ key: `${lo.toFixed(2)}-${(lo + 0.02).toFixed(2)}`, min: lo, max: lo + 0.02, count: 0 });
  }
  BUCKETS.unshift({ key: '<0.40', min: -Infinity, max: 0.40, count: 0 });
  BUCKETS.push({ key: '>0.65', min: 0.65, max: Infinity, count: 0 });

  const byBreed = new Map();
  for (const s of matched) {
    for (const b of BUCKETS) {
      if (s.implicitYield >= b.min && s.implicitYield < b.max) { b.count++; break; }
    }
    const bk = s.breedKey || 'default';
    if (!byBreed.has(bk)) byBreed.set(bk, []);
    byBreed.get(bk).push(s.implicitYield);
  }

  const perBreed = {};
  for (const [k, vals] of byBreed) {
    perBreed[k] = {
      n: vals.length,
      mean: round(mean(vals), 3),
      min: round(Math.min(...vals), 3),
      max: round(Math.max(...vals), 3)
    };
  }

  return {
    n: matched.length,
    histogram: BUCKETS.map(b => ({ bucket: b.key, count: b.count })),
    perBreed
  };
}

module.exports = {
  enrich,
  precision,
  timeline,
  yieldDistribution,
  findClosestAiWeighing,
  IMPOSSIBLE_YIELD_THRESHOLD,
  MATCH_WINDOW_DAYS
};
