// BoeufTrack - Rendement carcasse (dressing percentage) par race
// Valeurs initiales inspirées de la littérature élevage Afrique de l'Ouest.
// À recalibrer sur TES données dès que tu auras 30+ abattages comparés.
//
// Rendement = poids carcasse après ressuyage / poids vif.
// Zébu Sahel : 48–54 % typique. Races européennes charolais/limousin : 58–65 %.

'use strict';

const { BREEDS } = require('./breeds');

// Défauts par race. Ordre de grandeur, pas vérité absolue.
const DEFAULT_YIELDS = {
  azawak: 0.50,
  ndama:  0.48,
  gudali: 0.54,
  maure:  0.50,
  kouri:  0.52,
  metis:  0.51,
  default: 0.52
};

// Plage plausible : tout ce qui sort est suspect (bascule mal lue, saisie fautive, etc.)
const PLAUSIBLE_YIELD_MIN = 0.40;
const PLAUSIBLE_YIELD_MAX = 0.65;

// État en mémoire, surchargeable via /config/yields (persisté quand on aura Postgres).
let _globalDefault = DEFAULT_YIELDS.default;
let _byBreed = { ...DEFAULT_YIELDS };

function getConfig() {
  return {
    default: _globalDefault,
    byBreed: { ...DEFAULT_YIELDS, ..._byBreed },
    plausibleRange: [PLAUSIBLE_YIELD_MIN, PLAUSIBLE_YIELD_MAX]
  };
}

function setConfig({ default: def, byBreed }) {
  if (typeof def === 'number' && def >= PLAUSIBLE_YIELD_MIN && def <= PLAUSIBLE_YIELD_MAX) {
    _globalDefault = def;
  }
  if (byBreed && typeof byBreed === 'object') {
    for (const [k, v] of Object.entries(byBreed)) {
      if (typeof v === 'number' && v >= PLAUSIBLE_YIELD_MIN && v <= PLAUSIBLE_YIELD_MAX) {
        _byBreed[k] = v;
      }
    }
  }
  return getConfig();
}

// Normalise une chaîne race vers une clé interne (azawak, ndama, ...).
function breedKeyFrom(breedString) {
  if (!breedString) return 'default';
  const n = String(breedString).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, '');
  for (const key of Object.keys(BREEDS)) {
    if (n.includes(key)) return key;
  }
  // alias rapides
  if (n.includes('zebu') && n.includes('azawak')) return 'azawak';
  if (n.includes('goudali')) return 'gudali';
  return 'default';
}

// yieldFor : priorité override > race > défaut global.
function yieldFor(breedString, override) {
  if (typeof override === 'number' && override >= PLAUSIBLE_YIELD_MIN && override <= PLAUSIBLE_YIELD_MAX) {
    return { value: override, source: 'override' };
  }
  const key = breedKeyFrom(breedString);
  const byBreedNow = { ...DEFAULT_YIELDS, ..._byBreed };
  if (byBreedNow[key] != null && key !== 'default') {
    return { value: byBreedNow[key], source: 'breed:' + key };
  }
  return { value: _globalDefault, source: 'default' };
}

function isPlausible(yieldValue) {
  return yieldValue >= PLAUSIBLE_YIELD_MIN && yieldValue <= PLAUSIBLE_YIELD_MAX;
}

module.exports = {
  getConfig,
  setConfig,
  yieldFor,
  breedKeyFrom,
  isPlausible,
  PLAUSIBLE_YIELD_MIN,
  PLAUSIBLE_YIELD_MAX
};
