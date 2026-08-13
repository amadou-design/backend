// BoeufTrack - Analyse LLM par image (Claude Vision), ancrée race + qualité + détection.
// Objectif : le LLM ne devine plus dans le vide. Il reçoit :
//   - Une fourchette biologique plausible (breedInfo.minKg / maxKg / meanKg)
//   - Les signaux de qualité et (si dispo) la bbox + angle estimé
//   - Un prompt structuré en 4 étapes : détection → morphologie → ancrage race → estimation
// Sortie stricte : JSON. Un clamp hard empêche le LLM de sortir de la plage race ± marge.

'use strict';

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 1200;

let _client;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function num(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function buildPrompt({ breedInfo, userContext, userAngle, quality, detection, bboxFeatures, imageIndex, total }) {
  const detPart = detection && detection.detected
    ? `Un détecteur d'objet a localisé un bovin dans l'image (score ${detection.score}). Bbox couvre ~${Math.round((bboxFeatures?.coverage || 0) * 100)}% du cadre, ratio largeur/hauteur ${bboxFeatures?.aspectRatio || '?'} → angle probable : ${bboxFeatures?.angleHint || 'inconnu'}.`
    : (detection && detection.available === false
        ? 'Aucun détecteur d\'objet externe n\'est disponible, tu dois vérifier toi-même la présence du bovin.'
        : `Le détecteur d'objet n'a pas confirmé la présence d'un bovin (raison : ${detection?.reason || 'inconnue'}). Traite l'image avec méfiance.`);

  const qualityPart = quality
    ? `Qualité image (mesurée en pixel) : score ${quality.qualityScore} — netteté ${quality.sharpnessScore}, exposition ${quality.exposureScore}, résolution ${quality.resolutionScore}${quality.warnings && quality.warnings.length ? ` ; warnings : ${quality.warnings.join(', ')}` : ''}.`
    : 'Qualité image non mesurée.';

  return `Tu es expert en élevage bovin africain (zébu Azawak, N'Dama, Gudali, Maure, Kouri, métis). Tu estimes le poids vif à partir d'UNE SEULE photo.

CONTEXTE IMAGE ${imageIndex + 1}/${total}${userAngle ? ` · angle déclaré : ${userAngle}` : ''}
${detPart}
${qualityPart}

ANCRAGE RACE (très important — ne sors pas de cette plage sans justification solide)
- Race de référence : ${breedInfo.label}
- Fourchette biologique adulte en bon état : ${breedInfo.minKg}–${breedInfo.maxKg} kg (moyenne ${breedInfo.meanKg} kg)
- Note : ${breedInfo.notes}
- Si animal jeune ou maigre, tu peux descendre sous minKg mais tu DOIS le justifier dans "reasoning".
- Si animal exceptionnellement gros, tu peux dépasser maxKg mais seulement avec une justification morphologique explicite.

${userContext ? `Contexte éleveur : ${userContext}` : ''}

MÉTHODE OBLIGATOIRE EN 4 ÉTAPES (remplis tous les champs)
1) Détection : un bovin est-il visible ? Quelles parties du corps sont visibles (tête, garrot, flanc, ventre, arrière-train, pattes, bassin) ?
2) Angle réel de la photo : profil gauche, profil droit, face, arrière, trois-quarts, dessus ?
3) Morphologie : tour de poitrine apparent, profondeur de flanc, longueur dos, largeur bassin, musculature cuisse/épaule, état des côtes, bosse, fanon. Évalue le BCS (1–5, incréments 0.5).
4) Estimation poids : pars de la moyenne de race, ajuste par BCS et morphologie. Fournis weightKg (entier), rangeMin et rangeMax (entiers) cohérents avec la qualité. Confiance 0–100 : basse si floue, tronquée, ou angle inexploitable.

RÉPONDS UNIQUEMENT EN JSON VALIDE, sans balise markdown, sans texte avant ou après :
{
  "hasBovine": <boolean>,
  "visibleParts": "<string>",
  "angle": "<profil_gauche|profil_droit|face|arriere|trois_quarts|dessus|inconnu>",
  "frameCoverage": "<faible|moyen|bon>",
  "bcs": <number between 1 and 5>,
  "breedGuess": "<string or null>",
  "ageEstimate": "<veau|jeune|adulte|vieux|inconnu>",
  "weightKg": <integer>,
  "rangeMin": <integer>,
  "rangeMax": <integer>,
  "confidence": <integer 0-100>,
  "reasoning": "<1 to 3 phrases expliquant l'estimation>",
  "limitations": "<ce qui manque pour mieux estimer>"
}`;
}

function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// validate : force types + clamp à la plage race élargie. Coupe les hallucinations grossières.
function validate(raw, breedInfo) {
  if (!raw || typeof raw !== 'object') return null;

  const hasBovine = Boolean(raw.hasBovine);
  // Fourchette élargie de ±25% autour de la plage race pour laisser respirer l'exception
  const hardMin = Math.max(30, Math.round(breedInfo.minKg * 0.5));
  const hardMax = Math.round(breedInfo.maxKg * 1.5);

  const weightKg = Math.round(clamp(num(raw.weightKg, breedInfo.meanKg), hardMin, hardMax));
  let rangeMin = Math.round(clamp(num(raw.rangeMin, weightKg - 30), hardMin, weightKg));
  let rangeMax = Math.round(clamp(num(raw.rangeMax, weightKg + 30), weightKg, hardMax));
  if (rangeMin > rangeMax) [rangeMin, rangeMax] = [rangeMax, rangeMin];

  const confidence = Math.round(clamp(num(raw.confidence, 50), 0, 100));
  const bcs = clamp(num(raw.bcs, 3), 1, 5);

  return {
    hasBovine,
    visibleParts: String(raw.visibleParts || ''),
    angle: String(raw.angle || 'inconnu'),
    frameCoverage: String(raw.frameCoverage || 'moyen'),
    bcs: Number(bcs.toFixed(1)),
    breedGuess: raw.breedGuess ? String(raw.breedGuess) : null,
    ageEstimate: String(raw.ageEstimate || 'inconnu'),
    weightKg,
    rangeMin,
    rangeMax,
    confidence,
    reasoning: String(raw.reasoning || ''),
    limitations: String(raw.limitations || '')
  };
}

async function analyzeImage({ imageBase64, mediaType, breedInfo, userContext, userAngle, quality, detection, bboxFeatures, imageIndex = 0, total = 1 }) {
  const prompt = buildPrompt({ breedInfo, userContext, userAngle, quality, detection, bboxFeatures, imageIndex, total });

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  const text = (msg.content || []).map(c => c.text || '').join('');
  const raw = extractJson(text);
  const parsed = validate(raw, breedInfo);
  if (!parsed) {
    throw new Error('Réponse LLM non parsable: ' + text.slice(0, 200));
  }
  return parsed;
}

module.exports = { analyzeImage };
