// BoeufTrack - Référence race
// Ancrage sur des fourchettes biologiquement plausibles pour réduire l'hallucination LLM.
// Sources : FAO DAD-IS + ILRI + littérature élevage Sahel (ordres de grandeur).
// Poids adulte mâle en bon état. Veaux / jeunes : le LLM ajuste via ageEstimate.

'use strict';

const BREEDS = {
  azawak: {
    key: 'azawak',
    label: 'Zébu Azawak',
    aliases: ['azawak', 'zebu azawak', 'zébu azawak', 'azaouak'],
    minKg: 250,
    maxKg: 500,
    meanKg: 380,
    notes: 'Zébu Sahel. Bosse thoracique, robe claire, conformation moyenne.'
  },
  ndama: {
    key: 'ndama',
    label: "N'Dama",
    aliases: ['ndama', "n'dama", 'n dama'],
    minKg: 220,
    maxKg: 380,
    meanKg: 290,
    notes: 'Taurin trypanotolérant. Format compact, cornes en lyre.'
  },
  gudali: {
    key: 'gudali',
    label: 'Gudali',
    aliases: ['gudali', 'goudali', 'adamawa'],
    minKg: 300,
    maxKg: 600,
    meanKg: 450,
    notes: 'Zébu d\'Afrique centrale/ouest. Gabarit important, bonne aptitude boucherie.'
  },
  maure: {
    key: 'maure',
    label: 'Maure',
    aliases: ['maure', 'bovin maure', 'mauri'],
    minKg: 230,
    maxKg: 420,
    meanKg: 320,
    notes: 'Zébu mauritanien/malien. Robe claire, rustique.'
  },
  kouri: {
    key: 'kouri',
    label: 'Kouri',
    aliases: ['kouri', 'kuri'],
    minKg: 300,
    maxKg: 550,
    meanKg: 420,
    notes: 'Taurin lac Tchad. Grandes cornes, format lourd.'
  },
  metis: {
    key: 'metis',
    label: 'Métis (croisement)',
    aliases: ['metis', 'métis', 'cross', 'croisement', 'crossbreed'],
    minKg: 250,
    maxKg: 550,
    meanKg: 380,
    notes: 'Croisement local. Fourchette large, à préciser au cas par cas.'
  },
  default: {
    key: 'default',
    label: 'Bovin africain (race non identifiée)',
    aliases: [],
    minKg: 200,
    maxKg: 600,
    meanKg: 350,
    notes: 'Fourchette générique bovin africain adulte — à affiner via morphologie.'
  }
};

function norm(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findByAlias(s) {
  const n = norm(s);
  if (!n) return null;
  for (const breed of Object.values(BREEDS)) {
    if (breed.aliases.some(a => norm(a) === n || n.includes(norm(a)))) return breed;
  }
  return null;
}

// resolveBreed : priorité à l'utilisateur, fallback sur l'IA, sinon default.
function resolveBreed(userInput, aiGuess) {
  return findByAlias(userInput) || findByAlias(aiGuess) || BREEDS.default;
}

module.exports = { BREEDS, resolveBreed };
