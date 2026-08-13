// BoeufTrack - Détection bovin (HuggingFace Inference API, facebook/detr-resnet-50)
// Objectif : vraie bbox, vrai score, pas une hallucination LLM.
// Si HF_API_KEY absent -> dégradation gracieuse : le pipeline continue sans détection.
// Coût : free tier HF suffit au MVP. Pour prod, passer à un endpoint inference dédié ou
// un petit YOLO local (ultralytics) + ONNX runtime.

'use strict';

const HF_URL = 'https://api-inference.huggingface.co/models/facebook/detr-resnet-50';
const TIMEOUT_MS = 15000;

// DETR COCO labels considérés comme "bovin" (le modèle n'a pas de classe zébu)
const COW_LABELS = new Set(['cow']);

async function hfRequest(buffer, mediaType, apiKey, signal) {
  const res = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': mediaType || 'image/jpeg',
      'Accept': 'application/json'
    },
    body: buffer,
    signal
  });

  if (res.status === 503) {
    // Modèle en cold-start : on ne retente pas ici, on laisse le pipeline tomber en fallback
    const body = await res.text().catch(() => '');
    const err = new Error('HF model loading (503)');
    err.code = 'HF_LOADING';
    err.body = body;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HF error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function detect(buffer, mediaType) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) {
    return { detected: false, available: false, reason: 'no_api_key' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const predictions = await hfRequest(buffer, mediaType, apiKey, ctrl.signal);
    clearTimeout(timer);

    if (!Array.isArray(predictions) || predictions.length === 0) {
      return { detected: false, available: true, reason: 'no_objects' };
    }

    // Garde la meilleure bbox bovine
    const cows = predictions
      .filter(p => p && p.label && COW_LABELS.has(String(p.label).toLowerCase()))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (cows.length === 0) {
      const top = predictions.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      return {
        detected: false,
        available: true,
        reason: 'no_cow_detected',
        topOther: top ? { label: top.label, score: Number((top.score || 0).toFixed(3)) } : null
      };
    }

    const best = cows[0];
    const box = best.box || {};
    return {
      detected: true,
      available: true,
      label: best.label,
      score: Number((best.score || 0).toFixed(3)),
      box: {
        xmin: Math.round(box.xmin || 0),
        ymin: Math.round(box.ymin || 0),
        xmax: Math.round(box.xmax || 0),
        ymax: Math.round(box.ymax || 0)
      },
      allCount: cows.length
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      detected: false,
      available: true,
      reason: err.name === 'AbortError' ? 'timeout' : (err.code || 'error'),
      error: err.message
    };
  }
}

// Extrait des features exploitables de la bbox (indépendant du modèle source)
// coverage : part de l'image occupée par le bovin. Trop petit = photo de loin, peu fiable.
// aspectRatio : largeur / hauteur de la bbox. > 1.4 = profil ; ≈ 1 ou < 1 = face/arrière.
function computeBboxFeatures(detection, imageWidth, imageHeight) {
  if (!detection || !detection.detected || !detection.box) return null;
  const { xmin, ymin, xmax, ymax } = detection.box;
  const bw = Math.max(1, xmax - xmin);
  const bh = Math.max(1, ymax - ymin);
  const area = bw * bh;
  const imgArea = Math.max(1, (imageWidth || 1) * (imageHeight || 1));
  const coverage = Number((area / imgArea).toFixed(3));
  const aspectRatio = Number((bw / bh).toFixed(3));

  let angleHint;
  if (aspectRatio > 1.5) angleHint = 'profile';
  else if (aspectRatio > 1.1) angleHint = 'three_quarter';
  else angleHint = 'face_or_rear';

  // centré ? utile pour détecter animal coupé
  const cx = (xmin + xmax) / 2 / Math.max(1, imageWidth);
  const cy = (ymin + ymax) / 2 / Math.max(1, imageHeight);
  const centeredness = Number((1 - Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5)) * 2).toFixed(3));

  return { coverage, aspectRatio, angleHint, centeredness, bboxWidth: bw, bboxHeight: bh };
}

module.exports = { detect, computeBboxFeatures };
