'use strict';

// =============================================================================
// Module 13 — Administration & Configuration (cahier §2 #13).
// Configuration d'exploitation persistée (data/config.json) et modifiable à
// chaud par l'administrateur : grilles tarifaires, paramètres du moteur de règles
// AML/fraude, seuils QoS, taux de redevance, cadence du flux de démonstration.
// Les modules d'analyse lisent TOUJOURS la config courante → un changement admin
// se répercute immédiatement (simulateur, règles, revenus, QoS).
// =============================================================================

const fs = require('fs');
const path = require('path');
const ref = require('./referentiel');
const logger = require('./logger');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function defaults() {
  return {
    fees: JSON.parse(JSON.stringify(ref.DEFAULT_FEES)),
    contributionRate: ref.CONTRIBUTION_RATE,
    rules: {
      reportingThresholdXaf: 1_000_000, // seuil de déclaration unitaire
      structuring: { nearRatio: 0.9, windowMin: 1440, minCount: 3 }, // fractionnement
      velocity: { windowMin: 10, maxCount: 8 }, // rafale de transactions
      highValueXaf: 5_000_000, // transaction de montant élevé
      crossBorderReviewXaf: 2_000_000, // revue transfrontalier
      riskyKyc: ['NON_VERIFIE', 'INCONNU'],
      impossibleTravelKmH: 250, // vitesse implicite max entre 2 cellules
    },
    qos: { minSuccessRate: 0.9, maxLatencyMs: 5000, maxFailureSpike: 0.2 },
    stream: { intervalMs: Number(process.env.STREAM_MS) || 1500 },
  };
}

let current = defaults();

function load() {
  if (fs.existsSync(CONFIG_FILE)) {
    const disk = store.readJson(CONFIG_FILE, null, 'config');
    current = disk ? deepMerge(defaults(), disk) : defaults();
    if (disk) logger.info('config.loaded', { file: CONFIG_FILE });
  } else {
    persist();
  }
  return current;
}

function persist() {
  store.writeJson(CONFIG_FILE, current, 'config');
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

const get = () => current;
const getRules = () => current.rules;
const getFees = () => current.fees;
const getQos = () => current.qos;

// Met à jour une section (validée) et persiste. Renvoie la config courante.
function update(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Patch invalide');
  const next = deepMerge(current, patch);
  validate(next);
  current = next;
  persist();
  logger.info('config.updated', { keys: Object.keys(patch) });
  return current;
}

function reset() {
  current = defaults();
  persist();
  return current;
}

function validate(c) {
  // Le formulaire admin envoie Number('') === 0 pour un champ vidé : chaque champ
  // numérique modifiable doit donc être borné, sinon un 0 persisté casse le moteur
  // (intervalMs=0 → boucle chaude ; highValueXaf=0 → alerte sur chaque transaction).
  if (!(c.contributionRate >= 0 && c.contributionRate <= 1)) throw new Error('contributionRate ∈ [0,1]');
  if (!(c.rules.reportingThresholdXaf > 0)) throw new Error('reportingThresholdXaf > 0 requis');
  if (!(c.rules.velocity.maxCount > 0)) throw new Error('velocity.maxCount > 0 requis');
  if (!(c.rules.velocity.windowMin > 0)) throw new Error('velocity.windowMin > 0 requis');
  if (!(c.rules.structuring.minCount > 0)) throw new Error('structuring.minCount > 0 requis');
  if (!(c.rules.highValueXaf > 0)) throw new Error('rules.highValueXaf > 0 requis');
  if (!(c.rules.crossBorderReviewXaf > 0)) throw new Error('rules.crossBorderReviewXaf > 0 requis');
  if (!(c.qos.minSuccessRate > 0 && c.qos.minSuccessRate <= 1)) throw new Error('qos.minSuccessRate ∈ ]0,1] requis');
  if (!(c.qos.maxLatencyMs > 0)) throw new Error('qos.maxLatencyMs > 0 requis');
  if (!(Number.isFinite(c.stream.intervalMs) && c.stream.intervalMs >= 200 && c.stream.intervalMs <= 60_000)) throw new Error('stream.intervalMs ∈ [200, 60000] requis');
  for (const [t, g] of Object.entries(c.fees)) {
    if (g.pct < 0 || g.flat < 0 || g.cap < 0 || g.min < 0) throw new Error(`Grille tarifaire invalide: ${t}`);
  }
  return true;
}

module.exports = { DATA_DIR, CONFIG_FILE, load, persist, get, getRules, getFees, getQos, update, reset, defaults };
