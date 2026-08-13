// BoeufTrack API - Backend Express
//Redeploy trigger
// v2.1 : ajoute la couche analytique carcasse (slaughters, precision, yield)
// Pipeline hybride CV + LLM : voir ./lib/pipeline.js
// TODO PROD : remplacer le store en mémoire par Postgres

'use strict';

const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { analyzePhotos, MAX_IMAGES } = require('./lib/pipeline');
const yieldsLib = require('./lib/yields');
const analytics = require('./lib/analytics');
const training = require('./lib/training');

// --- Env check ---
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY env var missing');
  process.exit(1);
}
if (!process.env.HF_API_KEY) {
  console.warn('[warn] HF_API_KEY absent : détection externe désactivée (dégradation gracieuse).');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================================
// IN-MEMORY STORE (MVP)
// ============================================================
const boeufs = new Map();
const weighings = [];
const slaughters = [];  // { id, boeufId, date, carcassWeight, yieldOverride, aiWeightAtSlaughter, notes, createdAt }

(function seed() {
  const id = 'demo-boeuf-001';
  boeufs.set(id, {
    id,
    name: 'Démo - Zébu 01',
    breed: 'Zébu Azawak',
    birthDate: '2024-06-15',
    tagId: 'AZ-001',
    notes: 'Bœuf de démonstration. Supprime-le une fois tes vrais animaux ajoutés.',
    photoDataUrl: null,
    createdAt: new Date().toISOString()
  });
  const base = new Date();
  base.setDate(base.getDate() - 60);
  for (let i = 0; i < 4; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i * 20);
    weighings.push({
      id: randomUUID(),
      boeufId: id,
      weight: 280 + i * 22 + Math.round(Math.random() * 4),
      date: d.toISOString(),
      confidence: 75,
      bcs: 3,
      rangeMin: null,
      rangeMax: null,
      notes: 'Pesée de démonstration',
      photoDataUrl: null
    });
  }
})();

// ============================================================
// ROUTES SYSTÈME
// ============================================================
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.status(200).json({
  name: 'BoeufTrack API',
  version: '2.3.0',
  pipeline: 'hybrid-cv',
  detection: Boolean(process.env.HF_API_KEY),
  endpoints: [
    '/health', '/analyze',
    '/boeufs', '/weighings', '/boeufs/:id/gmq',
    '/slaughters', '/analytics/precision', '/analytics/yield', '/analytics/timeline',
    '/training', '/config/yields', '/config/calibration'
  ],
  calibrationEnabled: training.isEnabled()
}));

// ============================================================
// /analyze : pipeline hybride
// ============================================================
app.post('/analyze', async (req, res) => {
  try {
    const { images, imageBase64, mediaType = 'image/jpeg', breed, context } = req.body || {};

    let imgs = [];
    if (Array.isArray(images) && images.length > 0) {
      imgs = images.slice(0, MAX_IMAGES).map(it => ({
        data: it.data || it.imageBase64 || '',
        mediaType: it.mediaType || 'image/jpeg',
        angle: it.angle || null
      })).filter(it => it.data);
    } else if (imageBase64) {
      imgs = [{ data: imageBase64, mediaType, angle: null }];
    }
    if (imgs.length === 0) return res.status(400).json({ success: false, error: 'images[] ou imageBase64 requis' });

    const result = await analyzePhotos({ images: imgs, breed, context });

    // Application optionnelle de la calibration statistique (v2.2)
    const breedString = result.breedResolved?.label || result.breedResolved?.key || breed || null;
    const cal = training.applyCalibration(result.weightKg, breedString);
    const rawWeightKg = result.weightKg;
    let outWeight = rawWeightKg;
    let outRangeMin = result.rangeMin;
    let outRangeMax = result.rangeMax;
    if (cal.applied) {
      outWeight = cal.calibratedWeightKg;
      // Décale la fourchette du même offset absolu pour rester cohérente
      const shift = outWeight - rawWeightKg;
      outRangeMin = result.rangeMin != null ? Number((result.rangeMin + shift).toFixed(1)) : null;
      outRangeMax = result.rangeMax != null ? Number((result.rangeMax + shift).toFixed(1)) : null;
    }

    res.json({
      success: true,
      imagesAnalyzed: result.imagesUsed,
      observations: result.narrative,
      limitations: result.limitations,
      anglesUsed: result.anglesDistinct,
      weightKg: outWeight,
      rawWeightKg,
      calibrationApplied: cal.applied,
      calibrationInfo: cal.info || null,
      calibrationReason: cal.reason,
      rangeMin: outRangeMin,
      rangeMax: outRangeMax,
      confidence: result.confidence,
      confidenceBand: result.confidenceBand,
      bcs: result.bcs,
      breedGuess: result.breedGuess,
      narrative: result.narrative,
      breedResolved: result.breedResolved,
      imagesProvided: result.imagesProvided,
      imagesUsed: result.imagesUsed,
      imagesUnreadable: result.imagesUnreadable,
      rejectedCount: result.rejectedCount,
      perImage: result.perImage,
      outliers: result.outliers,
      detectionAvailable: result.detectionAvailable,
      llmFailures: result.llmFailures,
      processingMs: result.processingMs
    });
  } catch (err) {
    console.error('[/analyze]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// /boeufs : CRUD
// ============================================================
app.post('/boeufs', (req, res) => {
  const { name, breed, birthDate, tagId, notes, photoDataUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = randomUUID();
  const boeuf = {
    id, name,
    breed: breed || null,
    birthDate: birthDate || null,
    tagId: tagId || null,
    notes: notes || '',
    photoDataUrl: photoDataUrl || null,
    createdAt: new Date().toISOString()
  };
  boeufs.set(id, boeuf);
  res.status(201).json(boeuf);
});

app.get('/boeufs', (_req, res) => {
  res.json(Array.from(boeufs.values()).sort((a, b) => a.name.localeCompare(b.name)));
});

app.get('/boeufs/:id', (req, res) => {
  const b = boeufs.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  res.json(b);
});

app.patch('/boeufs/:id', (req, res) => {
  const b = boeufs.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  Object.assign(b, req.body, { id: b.id, createdAt: b.createdAt });
  boeufs.set(b.id, b);
  res.json(b);
});

app.delete('/boeufs/:id', (req, res) => {
  if (!boeufs.has(req.params.id)) return res.status(404).json({ error: 'not found' });
  boeufs.delete(req.params.id);
  for (let i = weighings.length - 1; i >= 0; i--) {
    if (weighings[i].boeufId === req.params.id) weighings.splice(i, 1);
  }
  for (let i = slaughters.length - 1; i >= 0; i--) {
    if (slaughters[i].boeufId === req.params.id) slaughters.splice(i, 1);
  }
  res.json({ ok: true });
});

// ============================================================
// /weighings
// ============================================================
app.post('/weighings', (req, res) => {
  const { boeufId, weight, date, confidence, bcs, notes, observations, rangeMin, rangeMax, photoDataUrl } = req.body;
  if (!boeufId || weight == null) return res.status(400).json({ error: 'boeufId + weight required' });
  if (!boeufs.has(boeufId)) return res.status(404).json({ error: 'boeuf not found' });
  const wNum = Number(weight);
  if (!Number.isFinite(wNum) || wNum <= 0) return res.status(400).json({ error: 'weight must be a positive number' });
  // notes est le champ canonique (v2.3). observations gardé pour compat ascendante.
  const notesVal = (notes != null && notes !== '') ? String(notes)
                 : (observations != null && observations !== '') ? String(observations)
                 : '';
  const w = {
    id: randomUUID(),
    boeufId,
    weight: wNum,
    date: date || new Date().toISOString(),
    confidence: confidence != null ? Number(confidence) : null,
    bcs: bcs != null ? Number(bcs) : null,
    rangeMin: rangeMin != null ? Number(rangeMin) : null,
    rangeMax: rangeMax != null ? Number(rangeMax) : null,
    notes: notesVal,
    photoDataUrl: photoDataUrl || null
  };
  weighings.push(w);
  res.status(201).json(w);
});

app.get('/weighings', (req, res) => {
  const { boeufId } = req.query;
  let list = weighings.slice();
  if (boeufId) list = list.filter(w => w.boeufId === boeufId);
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json(list);
});

app.delete('/weighings/:id', (req, res) => {
  const i = weighings.findIndex(w => w.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  weighings.splice(i, 1);
  res.json({ ok: true });
});

// ============================================================
// GMQ
// ============================================================
app.get('/boeufs/:id/gmq', (req, res) => {
  const list = weighings
    .filter(w => w.boeufId === req.params.id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (list.length < 2) return res.json({ gmq: null, reason: 'need at least 2 weighings' });
  const first = list[0];
  const last = list[list.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  if (days <= 0) return res.json({ gmq: null, reason: 'invalid dates' });
  const gmq = (last.weight - first.weight) / days;
  const intervals = [];
  for (let i = 1; i < list.length; i++) {
    const d = (new Date(list[i].date) - new Date(list[i - 1].date)) / 86400000;
    intervals.push({
      from: list[i - 1].date,
      to: list[i].date,
      days: Number(d.toFixed(1)),
      gain: list[i].weight - list[i - 1].weight,
      gmq: d > 0 ? Number(((list[i].weight - list[i - 1].weight) / d).toFixed(3)) : null
    });
  }
  res.json({
    gmq: Number(gmq.toFixed(3)),
    days: Number(days.toFixed(1)),
    firstWeight: first.weight,
    lastWeight: last.weight,
    totalGain: last.weight - first.weight,
    weighings: list.length,
    intervals
  });
});

// ============================================================
// /slaughters : abattages (vérité terrain carcasse)
// ============================================================
app.post('/slaughters', (req, res) => {
  const { boeufId, date, carcassWeight, yieldOverride, aiWeightAtSlaughter, notes } = req.body || {};
  if (!boeufId || carcassWeight == null) return res.status(400).json({ error: 'boeufId + carcassWeight required' });
  if (!boeufs.has(boeufId)) return res.status(404).json({ error: 'boeuf not found' });
  const cw = Number(carcassWeight);
  if (!Number.isFinite(cw) || cw <= 0) return res.status(400).json({ error: 'carcassWeight must be > 0' });
  const yo = yieldOverride != null ? Number(yieldOverride) : null;
  if (yo != null && !yieldsLib.isPlausible(yo)) return res.status(400).json({ error: `yieldOverride hors plage ${yieldsLib.PLAUSIBLE_YIELD_MIN}-${yieldsLib.PLAUSIBLE_YIELD_MAX}` });
  const aiAt = aiWeightAtSlaughter != null && aiWeightAtSlaughter !== '' ? Number(aiWeightAtSlaughter) : null;
  if (aiAt != null && (!Number.isFinite(aiAt) || aiAt <= 0)) return res.status(400).json({ error: 'aiWeightAtSlaughter must be > 0' });

  const s = {
    id: randomUUID(),
    boeufId,
    date: date || new Date().toISOString(),
    carcassWeight: cw,
    yieldOverride: yo,
    aiWeightAtSlaughter: aiAt,
    notes: notes || '',
    createdAt: new Date().toISOString()
  };
  slaughters.push(s);
  // Retourne enrichi tout de suite pour affichage UX immédiat
  res.status(201).json(analytics.enrich(s, { boeufs, weighings }));
});

app.get('/slaughters', (req, res) => {
  const { boeufId } = req.query;
  let list = slaughters.slice();
  if (boeufId) list = list.filter(s => s.boeufId === boeufId);
  list.sort((a, b) => new Date(b.date) - new Date(a.date));
  const enriched = list.map(s => analytics.enrich(s, { boeufs, weighings }));
  res.json(enriched);
});

app.get('/slaughters/:id', (req, res) => {
  const s = slaughters.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(analytics.enrich(s, { boeufs, weighings }));
});

app.delete('/slaughters/:id', (req, res) => {
  const i = slaughters.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  slaughters.splice(i, 1);
  res.json({ ok: true });
});

// ============================================================
// /analytics : précision, rendement, évolution
// ============================================================
app.get('/analytics/precision', (_req, res) => {
  const enriched = slaughters.map(s => analytics.enrich(s, { boeufs, weighings }));
  res.json({
    precision: analytics.precision(enriched),
    config: yieldsLib.getConfig()
  });
});

app.get('/analytics/yield', (_req, res) => {
  const enriched = slaughters.map(s => analytics.enrich(s, { boeufs, weighings }));
  res.json({
    ...analytics.yieldDistribution(enriched),
    config: yieldsLib.getConfig()
  });
});

app.get('/analytics/timeline', (_req, res) => {
  const enriched = slaughters.map(s => analytics.enrich(s, { boeufs, weighings }));
  res.json({ timeline: analytics.timeline(enriched) });
});

// ============================================================
// /config/yields : rendements par défaut et par race
// ============================================================
app.get('/config/yields', (_req, res) => {
  res.json(yieldsLib.getConfig());
});

app.patch('/config/yields', (req, res) => {
  const next = yieldsLib.setConfig(req.body || {});
  res.json(next);
});

// ============================================================
// /training : dataset de calibration (photos + poids réel)
// ============================================================
app.post('/training', async (req, res) => {
  try {
    const { images, imageBase64, mediaType = 'image/jpeg', realWeight, breed, label, context } = req.body || {};
    if (!(Number(realWeight) > 0)) return res.status(400).json({ error: 'realWeight (poids réel > 0) requis' });

    let imgs = [];
    if (Array.isArray(images) && images.length > 0) {
      imgs = images.slice(0, MAX_IMAGES).map(it => ({
        data: it.data || it.imageBase64 || '',
        mediaType: it.mediaType || 'image/jpeg',
        angle: it.angle || null
      })).filter(it => it.data);
    } else if (imageBase64) {
      imgs = [{ data: imageBase64, mediaType, angle: null }];
    }
    if (!imgs.length) return res.status(400).json({ error: 'images[] ou imageBase64 requis' });

    const result = await analyzePhotos({ images: imgs, breed, context });
    const detectedBreed = result.breedResolved?.label || breed || null;
    const sample = training.addSample({
      label,
      aiPrediction: result.weightKg,
      realWeight: Number(realWeight),
      breedString: detectedBreed,
      source: 'upload'
    });
    res.status(201).json({
      sample,
      aiResult: {
        weightKg: result.weightKg,
        rangeMin: result.rangeMin,
        rangeMax: result.rangeMax,
        confidence: result.confidence,
        breedResolved: result.breedResolved,
        imagesUsed: result.imagesUsed
      },
      calibration: training.calibrationByBreed()
    });
  } catch (e) {
    console.error('[/training POST]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/training', (_req, res) => {
  res.json({
    samples: training.listSamples(),
    calibration: training.calibrationByBreed(),
    enabled: training.isEnabled(),
    minSamplesPerBreed: training.MIN_SAMPLES_PER_BREED
  });
});

app.delete('/training/:id', (req, res) => {
  const ok = training.deleteSample(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.patch('/config/calibration', (req, res) => {
  const { enabled } = req.body || {};
  training.setEnabled(!!enabled);
  res.json({ enabled: training.isEnabled() });
});

app.get('/config/calibration', (_req, res) => {
  res.json({ enabled: training.isEnabled(), calibration: training.calibrationByBreed() });
});

// ============================================================
// START + GRACEFUL SHUTDOWN
// ============================================================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`BoeufTrack API v2.3 running on port ${PORT}`);
  console.log(`  detection: ${process.env.HF_API_KEY ? 'enabled (HF DETR)' : 'disabled (no HF_API_KEY)'}`);
});

const shutdown = (sig) => {
  console.log(`${sig} received - shutting down gracefully`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced exit after 10s');
    process.exit(1);
  }, 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); });
process.on('unhandledRejection', (err) => { console.error('unhandledRejection', err); });
