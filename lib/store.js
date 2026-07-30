'use strict';

// =============================================================================
// Emplacement unique des données persistées + helpers JSON partagés.
// Toute résolution du répertoire de données passe par ici : un changement de
// convention (variable d'environnement, chemin par défaut) ne se fait qu'une fois,
// sinon le stockage se scinde silencieusement entre modules.
// =============================================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = process.env.SUMO_DATA_DIR || path.join(__dirname, '..', 'data');

// Lit un fichier JSON ; renvoie `fallback` si absent ou illisible (journalisé).
function readJson(file, fallback, label) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { logger.warn(`${label || 'store'}.load.failed`, { file, error: e.message }); }
  return fallback;
}

// Écrit un fichier JSON (répertoire créé au besoin) ; échec journalisé, non fatal.
function writeJson(file, data, label) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { logger.warn(`${label || 'store'}.persist.failed`, { file, error: e.message }); }
}

module.exports = { DATA_DIR, readJson, writeJson };
