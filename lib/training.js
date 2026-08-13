// BoeufTrack - Couche d'entraînement / calibration statistique
// v2.2 : régression linéaire par race entre estimation IA brute et poids réel.
//
// Principe : l'utilisateur fournit N paires (photos, poids réel connu). Pour chaque paire
// on fait tourner la pipeline actuelle -> on obtient un aiPrediction. Avec ≥5 paires par race
// on ajuste par moindres carrés `real = slope × ai + offset`. On applique cette correction
// aux nouvelles analyses de la même race.
//
// C'est PAS du fine-tuning : la pipeline reste identique, on corrige juste son biais sortant.
// Marche bien tant que la relation IA vs réel est ~linéaire (vérifié via R²).
// TODO PROD : persister samples et calibration en Postgres.

'use strict';

const { randomUUID } = require('crypto');
const { breedKeyFrom } = require('./yields');

// Store en mémoire (MVP)
const samples = []; // { id, label, aiPrediction, realWeight, breedKey, breedLabel, errorPct, source, createdAt }
let calibrationEnabled = false;

// Seuils
const MIN_SAMPLES_PER_BREED = 5;    // en-dessous : on refuse d'appliquer
const R2_MIN_USABLE = 0.30;         // en-dessous : corrélation trop faible pour être utile
const MIN_SAMPLES_GLOBAL = 3;       // pour calibration "default" si race inconnue

// ============================================================
// Régression linéaire par moindres carrés
// pairs = [{ x: aiPrediction, y: realWeight }, ...]
// Retourne { slope, offset, r2, n } ou null si n < 2
// ============================================================
function linearRegression(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const meanY = sumY / n;
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null; // tous les x identiques
  const slope = (n * sumXY - sumX * sumY) / denom;
  const offset = (sumY - slope * sumX) / n;
  const ssRes = pairs.reduce((s, p) => {
    const pred = slope * p.x + offset;
    return s + (p.y - pred) ** 2;
  }, 0);
  const ssTot = pairs.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const r2 = ssTot < 1e-9 ? 1 : 1 - ssRes / ssTot;
  return { slope, offset, r2, n };
}

// ============================================================
// CRUD samples
// ============================================================
function addSample({ label, aiPrediction, realWeight, breedString, source = 'upload' }) {
  const rw = Number(realWeight);
  const ai = Number(aiPrediction);
  if (!Number.isFinite(rw) || rw <= 0) throw new Error('realWeight invalide');
  if (!Number.isFinite(ai) || ai <= 0) throw new Error('aiPrediction invalide');
  const breedKey = breedKeyFrom(breedString);
  const errorPct = ((ai - rw) / rw) * 100;
  const s = {
    id: randomUUID(),
    label: label || '',
    aiPrediction: Number(ai.toFixed(1)),
    realWeight: Number(rw.toFixed(1)),
    breedKey,
    breedLabel: breedString || null,
    errorPct: Number(errorPct.toFixed(2)),
    source,
    createdAt: new Date().toISOString()
  };
  samples.push(s);
  return s;
}

function listSamples() {
  return samples.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function deleteSample(id) {
  const idx = samples.findIndex(s => s.id === id);
  if (idx < 0) return false;
  samples.splice(idx, 1);
  return true;
}

function clearSamples() {
  samples.length = 0;
}

// ============================================================
// Calibration
// ============================================================
function calibrationByBreed() {
  const byBreed = new Map();
  for (const s of samples) {
    const k = s.breedKey || 'default';
    if (!byBreed.has(k)) byBreed.set(k, []);
    byBreed.get(k).push({ x: s.aiPrediction, y: s.realWeight });
  }
  // Ajoute aussi une entrée "default" agrégée si peu de data par race
  const out = {};
  for (const [k, pairs] of byBreed) {
    out[k] = describeCalibration(pairs, k === 'default' ? MIN_SAMPLES_GLOBAL : MIN_SAMPLES_PER_BREED);
  }
  // Fallback global : si des races ont peu d'échantillons, la clé 'default' agrège tout
  if (!out.default && samples.length >= MIN_SAMPLES_GLOBAL) {
    const allPairs = samples.map(s => ({ x: s.aiPrediction, y: s.realWeight }));
    out.default = describeCalibration(allPairs, MIN_SAMPLES_GLOBAL);
  }
  return out;
}

function describeCalibration(pairs, minN) {
  const reg = linearRegression(pairs);
  if (!reg) return { n: pairs.length, usable: false, reason: 'not_enough_data' };
  const rawBias = pairs.reduce((s, p) => s + (p.x - p.y) / p.y, 0) / pairs.length * 100;
  const calBias = pairs.reduce((s, p) => {
    const cal = reg.slope * p.x + reg.offset;
    return s + (cal - p.y) / p.y;
  }, 0) / pairs.length * 100;
  const rawMae = pairs.reduce((s, p) => s + Math.abs((p.x - p.y) / p.y), 0) / pairs.length * 100;
  const calMae = pairs.reduce((s, p) => {
    const cal = reg.slope * p.x + reg.offset;
    return s + Math.abs((cal - p.y) / p.y);
  }, 0) / pairs.length * 100;

  const usable = reg.n >= minN && reg.r2 >= R2_MIN_USABLE;
  return {
    n: reg.n,
    slope: Number(reg.slope.toFixed(4)),
    offset: Number(reg.offset.toFixed(2)),
    r2: Number(reg.r2.toFixed(3)),
    rawBiasPct: Number(rawBias.toFixed(2)),
    calibratedBiasPct: Number(calBias.toFixed(2)),
    rawMaePct: Number(rawMae.toFixed(2)),
    calibratedMaePct: Number(calMae.toFixed(2)),
    usable,
    reason: usable ? 'ok'
          : reg.n < minN ? `need_${minN - reg.n}_more_samples`
          : `low_r2_${reg.r2.toFixed(2)}`
  };
}

// Applique la calibration à une estimation brute.
// Retourne { calibratedWeightKg, applied, reason, info }
function applyCalibration(rawWeightKg, breedString) {
  if (!calibrationEnabled) {
    return { calibratedWeightKg: rawWeightKg, applied: false, reason: 'disabled' };
  }
  const rw = Number(rawWeightKg);
  if (!Number.isFinite(rw) || rw <= 0) {
    return { calibratedWeightKg: rawWeightKg, applied: false, reason: 'invalid_input' };
  }
  const key = breedKeyFrom(breedString);
  const cal = calibrationByBreed();
  // Priorité : race spécifique, sinon fallback default
  const info = (cal[key] && cal[key].usable) ? cal[key] : (cal.default && cal.default.usable ? cal.default : null);
  if (!info) {
    return { calibratedWeightKg: rawWeightKg, applied: false, reason: 'insufficient_data', diag: { breedKey: key, availableByBreed: cal } };
  }
  const calibrated = info.slope * rw + info.offset;
  // Garde-fou : si la correction dérape (> ±50 % du raw), on annule et on log
  const drift = Math.abs(calibrated - rw) / rw;
  if (drift > 0.5) {
    return { calibratedWeightKg: rawWeightKg, applied: false, reason: 'unstable_correction', diag: { drift, info } };
  }
  return {
    calibratedWeightKg: Number(calibrated.toFixed(1)),
    applied: true,
    reason: 'ok',
    info: { slope: info.slope, offset: info.offset, r2: info.r2, n: info.n, breedKey: (cal[key] && cal[key].usable) ? key : 'default' }
  };
}

function setEnabled(v) { calibrationEnabled = !!v; return calibrationEnabled; }
function isEnabled() { return calibrationEnabled; }

module.exports = {
  addSample, listSamples, deleteSample, clearSamples,
  calibrationByBreed, applyCalibration,
  setEnabled, isEnabled,
  MIN_SAMPLES_PER_BREED, R2_MIN_USABLE
};
