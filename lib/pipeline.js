// BoeufTrack - Orchestrateur estimation poids
// Niveau 1 : qualité image (sharp) + détection bovin (HF DETR, optionnel)
// Niveau 2 : analyse morphologique LLM ancrée race, par image, parallèle
// Niveau 3 : fusion robuste (MAD + moyenne pondérée + resserrement √n + narrative)
//
// Design notes :
// - Buffers : on décode le base64 UNE fois, on les passe à sharp + détecteur.
// - Parallélisme : quality + detection par image en Promise.all ; LLM en Promise.allSettled
//   pour qu'une image qui fail ne fasse pas tomber le reste.
// - Graceful degradation : si sharp échoue -> quality par défaut ; si HF absent -> pas de détection.
// - Extensible : pour brancher un modèle entraîné, remplacer llmAnalyzer.analyzeImage par un
//   regressor local qui renvoie le même shape { hasBovine, weightKg, rangeMin, ..., confidence }.

'use strict';

const { resolveBreed } = require('./breeds');
const { assessQuality } = require('./imageQuality');
const { detect, computeBboxFeatures } = require('./detector');
const { analyzeImage } = require('./llmAnalyzer');
const { fuse } = require('./fusion');

const MAX_IMAGES = 6;

function stripPrefix(b64) {
  if (!b64) return '';
  return b64.includes(',') ? b64.split(',')[1] : b64;
}

function toBuffer(b64) {
  try { return Buffer.from(stripPrefix(b64), 'base64'); } catch { return null; }
}

async function preflight(image, index) {
  const buf = toBuffer(image.data || image.imageBase64 || '');
  if (!buf || buf.length < 1000) {
    return {
      imageIndex: index,
      mediaType: image.mediaType || 'image/jpeg',
      buffer: null,
      quality: { readable: false, qualityScore: 0, warnings: ['image vide ou invalide'] },
      detection: { detected: false, available: false, reason: 'no_buffer' },
      bboxFeatures: null,
      unreadable: true,
      userAngle: image.angle || null,
      base64: ''
    };
  }

  const [quality, detection] = await Promise.all([
    assessQuality(buf).catch(e => ({ readable: false, qualityScore: 0, warnings: ['quality error: ' + e.message] })),
    detect(buf, image.mediaType || 'image/jpeg').catch(e => ({ detected: false, available: false, reason: 'error', error: e.message }))
  ]);

  const bboxFeatures = computeBboxFeatures(detection, quality.width, quality.height);

  return {
    imageIndex: index,
    mediaType: image.mediaType || 'image/jpeg',
    buffer: buf,
    quality,
    detection,
    bboxFeatures,
    unreadable: !quality.readable,
    userAngle: image.angle || null,
    base64: stripPrefix(image.data || image.imageBase64 || '')
  };
}

async function analyzePhotos({ images, breed, context }) {
  const t0 = Date.now();

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('images[] required');
  }

  const imgs = images.slice(0, MAX_IMAGES);

  // Étape 1 : preflight (quality + detection) parallèle
  const preflights = await Promise.all(imgs.map((im, i) => preflight(im, i)));

  // Étape 2 : résolution race (user prioritaire) — on utilise aussi la première guess LLM plus tard si user null
  const breedInfo = resolveBreed(breed, null);

  // Étape 3 : analyse LLM en parallèle sur les images lisibles
  const readable = preflights.filter(p => !p.unreadable);
  const unreadableCount = preflights.length - readable.length;

  const llmCalls = readable.map(p => analyzeImage({
    imageBase64: p.base64,
    mediaType: p.mediaType,
    breedInfo,
    userContext: context,
    userAngle: p.userAngle,
    quality: p.quality,
    detection: p.detection,
    bboxFeatures: p.bboxFeatures,
    imageIndex: p.imageIndex,
    total: readable.length
  }));

  const settled = await Promise.allSettled(llmCalls);

  const estimates = [];
  const llmFailures = [];
  settled.forEach((r, i) => {
    const p = readable[i];
    if (r.status === 'fulfilled') {
      estimates.push({
        imageIndex: p.imageIndex,
        quality: p.quality,
        detection: p.detection,
        bboxFeatures: p.bboxFeatures,
        parsed: r.value
      });
    } else {
      llmFailures.push({ imageIndex: p.imageIndex, error: String(r.reason && r.reason.message || r.reason) });
    }
  });

  // Si après LLM l'utilisateur n'avait pas déclaré de race, on peut raffiner via la race majoritairement devinée.
  // Mais on ne change PAS le breedInfo déjà passé au LLM : on reflète seulement le guess dans le résultat final.
  let effectiveBreedInfo = breedInfo;
  if (!breed && estimates.length > 0) {
    const guesses = estimates.map(e => e.parsed.breedGuess).filter(Boolean);
    if (guesses.length) {
      const refined = resolveBreed(null, guesses[0]);
      if (refined) effectiveBreedInfo = refined;
    }
  }

  // Étape 4 : fusion
  const fused = fuse(estimates, effectiveBreedInfo);

  const processingMs = Date.now() - t0;

  return {
    ...fused,
    breedResolved: {
      key: effectiveBreedInfo.key,
      label: effectiveBreedInfo.label,
      minKg: effectiveBreedInfo.minKg,
      maxKg: effectiveBreedInfo.maxKg,
      meanKg: effectiveBreedInfo.meanKg,
      source: breed ? 'user' : (estimates.length ? 'ai_guess' : 'default')
    },
    imagesProvided: images.length,
    imagesConsidered: imgs.length,
    imagesUnreadable: unreadableCount,
    llmFailures,
    detectionAvailable: preflights.some(p => p.detection && p.detection.available),
    processingMs
  };
}

module.exports = { analyzePhotos, MAX_IMAGES };
