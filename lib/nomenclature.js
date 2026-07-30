'use strict';

// =============================================================================
// Nomenclature institutionnelle ARCEP : les directions et les comptes de
// l'ORGANIGRAMME OFFICIEL (Délibération N°0002/ARCEP/CR/2024). Alimentée par
// scripts/import-arcep-org.js → data/nomenclature.json ; à défaut, le snapshot
// commité lib/nomenclature-defaults.json est utilisé (l'app reste autonome).
// Chargée au require, comme le référentiel : les tests posent SUMO_DATA_DIR
// avant tout require.
// =============================================================================

const path = require('path');
const store = require('./store');
const logger = require('./logger');

const FILE = path.join(store.DATA_DIR, 'nomenclature.json');
const DEFAULTS = require('./nomenclature-defaults.json');

// Valide et normalise le contenu (doublons écartés, compte à direction inconnue
// droppé avec avertissement) ; retombe sur le snapshot si la forme est invalide.
function sanitize(raw) {
  const usable = raw && raw.version === 1 && Array.isArray(raw.directions) && Array.isArray(raw.users);
  if (raw && !usable) logger.warn('nomenclature.invalide.fallback', { file: FILE });
  const src = usable ? raw : DEFAULTS;

  const directions = [];
  const codes = new Set();
  for (const d of src.directions) {
    if (!d || !d.code || codes.has(d.code)) continue;
    codes.add(d.code);
    directions.push({ code: String(d.code), nom: String(d.nom || d.code), type: d.type || null, services: Array.isArray(d.services) ? d.services : [] });
  }

  const users = [];
  const names = new Set();
  for (const u of src.users) {
    if (!u || !u.username || names.has(u.username)) continue;
    if (!codes.has(u.direction)) { logger.warn('nomenclature.user.direction-inconnue', { username: u.username, direction: u.direction }); continue; }
    names.add(u.username);
    users.push({ id: u.id || u.username, username: String(u.username), nom: String(u.nom || u.username), role: String(u.role || 'AGENT'), direction: u.direction });
  }
  return { source: src.source || '', directions, users };
}

const data = sanitize(store.readJson(FILE, null, 'nomenclature'));

const DIRECTIONS = data.directions;
const USERS = data.users;
const directionByCode = new Map(DIRECTIONS.map((d) => [d.code, d]));
const isDirection = (code) => directionByCode.has(code);
const label = (code) => (directionByCode.get(code) || {}).nom || code;

module.exports = { FILE, SOURCE: data.source, DIRECTIONS, USERS, directionByCode, isDirection, label };
