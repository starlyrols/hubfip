'use strict';

// =============================================================================
// Affectations des modules : QUI voit QUOI. Deux niveaux, cumulables :
//   - par DIRECTION : tous les comptes de la direction héritent des modules ;
//   - par COMPTE : affectation individuelle (opérateurs, besoins ponctuels,
//     modules qui ne concernent pas une direction entière).
// Géré par le compte ADMIN_SYSTEME via /api/v1/dispatch/*. Persisté dans
// data/assignments.json. Affecter « monitoring » (module parent) = affecter
// tous ses sous-modules (expansion à la lecture).
//
// Les DÉFAUTS transposent l'ancien RBAC par corps de métier vers les directions
// de l'organigramme ARCEP : DM↔observatoire des marchés, DFC↔revenus,
// DHQR↔qualité de service, DCTLF↔antifraude, DJ↔juridique, DSIN↔admin SI,
// DCBA↔audit, gouvernance/exécutif↔supervision complète. Les opérateurs Mobile
// Money reçoivent leur périmètre historique en affectations individuelles.
// =============================================================================

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const modules = require('./modules');
const ref = require('./referentiel');

const FILE = path.join(store.DATA_DIR, 'assignments.json');
const MAX_ITEMS = 20;
const OPERATOR_DEFAULT = ['observatoire', 'qos', 'revenus', 'connecteurs', 'registre', 'reporting', 'mesures', 'reclamations', 'workflow'];

function defaults() {
  return {
    version: 1,
    directions: {
      PCR: ['monitoring'], CR: ['monitoring'], CAB: ['monitoring'],
      SE: ['monitoring'], SEA1: ['monitoring'], SEA2: ['monitoring'],
      DM: ['observatoire', 'operators', 'geo', 'registre', 'reporting', 'tiers', 'postal', 'workflow'],
      DFC: ['observatoire', 'revenus', 'registre', 'reporting', 'workflow'],
      DHQR: ['observatoire', 'qos', 'connecteurs', 'geo', 'registre', 'reporting', 'mesures', 'reclamations', 'postal', 'workflow'],
      DCTLF: ['observatoire', 'antifraude', 'investigation', 'geo', 'analytics', 'registre', 'reporting', 'workflow'],
      DJ: ['observatoire', 'antifraude', 'investigation', 'securite', 'registre', 'reporting', 'tiers', 'mesures', 'workflow'],
      DSIN: ['observatoire', 'connecteurs', 'geo', 'admin', 'securite', 'registre', 'workflow'],
      DCBA: ['observatoire', 'registre', 'reporting', 'securite', 'workflow'],
      DRH: ['observatoire', 'workflow'], DDSU: ['observatoire', 'workflow'], DIAI: ['observatoire', 'workflow'], DRRRS: ['observatoire', 'workflow'],
    },
    users: Object.fromEntries(ref.OPERATORS.map((o) => [o.id, OPERATOR_DEFAULT.slice()])),
  };
}

let current = null;

// Retire d'une liste persistée les ids inconnus ou non affectables (fichier
// obsolète, module retiré du registre) — journalisé, jamais fatal.
function sanitizeList(list, where) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (!modules.isAssignable(id)) { logger.warn('assignments.module.ignore', { module: id, where }); continue; }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function load() {
  const exists = fs.existsSync(FILE);
  if (!exists) {
    // Premier démarrage : matérialise les défauts, l'admin système part d'un
    // état visible et modifiable.
    current = defaults();
    store.writeJson(FILE, current, 'assignments');
    logger.info('assignments.seeded', { file: FILE });
    return current;
  }
  const disk = store.readJson(FILE, null, 'assignments');
  if (!disk || typeof disk !== 'object') {
    // Fichier illisible : défauts en mémoire, fichier PRÉSERVÉ pour diagnostic
    // (il ne sera réécrit qu'à la première modification par l'admin).
    current = defaults();
    logger.warn('assignments.corrompu.fallback', { file: FILE });
    return current;
  }
  current = { version: 1, directions: {}, users: {} };
  for (const [code, list] of Object.entries(disk.directions || {})) current.directions[code] = sanitizeList(list, `direction:${code}`);
  for (const [u, list] of Object.entries(disk.users || {})) current.users[u] = sanitizeList(list, `compte:${u}`);
  return current;
}

const ensure = () => current || load();
const persist = () => store.writeJson(FILE, current, 'assignments');

const forDirection = (code) => (ensure().directions[code] || []).slice();
const forUser = (username) => (ensure().users[username] || []).slice();

// Remplacement d'ensemble (idempotent — l'UI envoie la ligne entière) : valide,
// dédoublonne, persiste, et retourne le diff pour la journalisation d'audit.
function validateSet(moduleIds) {
  if (!Array.isArray(moduleIds)) throw new Error('« modules » doit être un tableau d\'identifiants.');
  if (moduleIds.length > MAX_ITEMS) throw new Error(`Trop de modules (max ${MAX_ITEMS}).`);
  const out = [];
  for (const raw of moduleIds) {
    const id = String(raw);
    if (!modules.isAssignable(id)) throw new Error(`Module inconnu ou non affectable : « ${id} ».`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const diff = (before, after) => ({ added: after.filter((m) => !before.includes(m)), removed: before.filter((m) => !after.includes(m)) });

function setDirection(code, moduleIds) {
  const clean = validateSet(moduleIds);
  const before = forDirection(code);
  ensure().directions[code] = clean;
  persist();
  return { modules: clean, ...diff(before, clean) };
}

function setUser(username, moduleIds) {
  const clean = validateSet(moduleIds);
  const before = forUser(username);
  ensure().users[username] = clean;
  persist();
  return { modules: clean, ...diff(before, clean) };
}

// Modules EFFECTIFS d'un utilisateur = union(direction, individuel), étendue
// aux feuilles et ordonnée selon l'ordre canonique des onglets. Calculée à
// chaud à chaque requête : une révocation prend effet immédiatement, sans
// invalider les sessions.
function modulesForUser(user) {
  if (!user) return [];
  const set = new Set();
  if (user.direction) for (const m of modules.expand(forDirection(user.direction))) set.add(m);
  for (const m of modules.expand(forUser(user.username))) set.add(m);
  return modules.LEAF_MODULE_IDS.filter((id) => set.has(id));
}

// Copie de l'état brut (les clés orphelines — direction/compte disparus de la
// nomenclature — sont conservées telles quelles ; l'API de dispatch les signale).
function state() {
  const c = ensure();
  return {
    directions: Object.fromEntries(Object.entries(c.directions).map(([k, v]) => [k, v.slice()])),
    users: Object.fromEntries(Object.entries(c.users).map(([k, v]) => [k, v.slice()])),
  };
}

module.exports = { FILE, MAX_ITEMS, load, forDirection, forUser, setDirection, setUser, modulesForUser, state, defaults };
