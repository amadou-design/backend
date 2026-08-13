// BoeufTrack - Évaluation qualité image (vrai pixel-work, pas cosmétique)
// Utilise sharp pour : dimensions, luminosité, variance Laplacien (proxy netteté).
// Retourne un score 0..1 + warnings exploitables par le pipeline et l'UI.

'use strict';

const sharp = require('sharp');

// Noyau Laplacien 3x3 discret. Variance de la réponse = proxy classique de netteté (Pech-Pacheco).
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0]
};

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

async function assessQuality(buffer) {
  const warnings = [];
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (e) {
    return {
      readable: false,
      qualityScore: 0,
      warnings: ['image illisible ou format non supporté'],
      error: e.message
    };
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const bytes = buffer.length;

  if (width < 400 || height < 400) warnings.push('résolution faible (<400px)');
  if (width === 0 || height === 0) warnings.push('dimensions invalides');

  // Downscale gris 512 pour stats rapides et stables
  const small = sharp(buffer).grayscale().resize({ width: 512, withoutEnlargement: false });
  const { data: smallData, info } = await small.raw().toBuffer({ resolveWithObject: true });

  // Luminosité moyenne (0..255)
  let sum = 0;
  for (let i = 0; i < smallData.length; i++) sum += smallData[i];
  const brightness = sum / smallData.length;

  if (brightness < 40) warnings.push('image très sombre');
  else if (brightness > 225) warnings.push('image surexposée');

  // Variance du Laplacien (netteté). sharp applique le noyau puis stats -> stdev²
  let sharpnessVar = 0;
  try {
    const { channels } = await sharp(smallData, { raw: { width: info.width, height: info.height, channels: 1 } })
      .convolve(LAPLACIAN_KERNEL)
      .stats();
    const std = channels && channels[0] && channels[0].stdev ? channels[0].stdev : 0;
    sharpnessVar = std * std;
  } catch (e) {
    sharpnessVar = 0;
  }

  if (sharpnessVar < 40) warnings.push('image floue');

  // Composition du score qualité : netteté x exposition x résolution
  // - sharpness : 40 = flou, 300+ = net
  const sharpnessScore = clamp((sharpnessVar - 40) / 260, 0, 1);
  // - exposure : cloche centrée sur 128
  const expoDist = Math.abs(brightness - 128);
  const exposureScore = clamp(1 - expoDist / 128, 0, 1);
  // - résolution : 400px = bas, 1200+ = bon
  const minSide = Math.min(width || 0, height || 0);
  const resolutionScore = clamp((minSide - 400) / 800, 0, 1);

  const qualityScore = Number(
    (0.55 * sharpnessScore + 0.25 * exposureScore + 0.20 * resolutionScore).toFixed(3)
  );

  return {
    readable: true,
    width, height, bytes,
    brightness: Number(brightness.toFixed(1)),
    sharpnessVar: Number(sharpnessVar.toFixed(1)),
    sharpnessScore: Number(sharpnessScore.toFixed(3)),
    exposureScore: Number(exposureScore.toFixed(3)),
    resolutionScore: Number(resolutionScore.toFixed(3)),
    qualityScore,
    warnings
  };
}

module.exports = { assessQuality };
