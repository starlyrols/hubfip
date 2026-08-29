'use strict';

// =============================================================================
// Import de l'organigramme officiel ARCEP (Délibération N°0002/ARCEP/CR/2024)
// depuis le seed de l'application interne arcep-digital — en LECTURE SEULE —
// vers data/nomenclature.json (directions + comptes internes). Avec --defaults,
// met aussi à jour le snapshot commité lib/nomenclature-defaults.json, utilisé
// quand data/ est vierge (l'app reste autonome sans accès au dépôt arcep-digital).
//
//   node scripts/import-arcep-org.js "<chemin>/arcep-digital/server/seed.js" [--defaults]
//   ARCEP_SEED_PATH="<chemin>/seed.js" npm run import-org
//
// Les comptes OPERATEUR du seed ARCEP (portail arcep-digital) sont exclus : les
// opérateurs Mobile Money de SUMo (référentiel) ont déjà leurs propres comptes.
// =============================================================================

const path = require('path');
const store = require('../lib/store');
const ref = require('../lib/referentiel');

const argv = process.argv.slice(2);
const writeDefaults = argv.includes('--defaults');
const seedPath = argv.filter((a) => a !== '--defaults')[0] || process.env.ARCEP_SEED_PATH;

if (!seedPath) {
  console.error('Usage : node scripts/import-arcep-org.js <chemin/vers/arcep-digital/server/seed.js> [--defaults]');
  console.error('        (ou variable d\'environnement ARCEP_SEED_PATH)');
  process.exit(1);
}

const seed = require(path.resolve(seedPath));
if (!Array.isArray(seed.DIRECTIONS) || !Array.isArray(seed.USERS)) {
  console.error(`Seed invalide : ${seedPath} n'exporte pas DIRECTIONS et USERS.`);
  process.exit(1);
}

const codes = new Set();
const directions = seed.DIRECTIONS.map((d) => {
  if (!d.code || codes.has(d.code)) throw new Error(`Direction invalide ou en double : « ${d.code} »`);
  codes.add(d.code);
  return { code: d.code, nom: d.nom, type: d.type || null, services: Array.isArray(d.services) ? d.services : [] };
});

// Usernames réservés côté SUMo : opérateurs Mobile Money + compte admin système.
const reserved = new Set([...ref.OPERATORS.map((o) => o.id), 'admin-systeme']);
const seen = new Set();
const users = seed.USERS
  .filter((u) => u.role !== 'OPERATEUR')
  .map((u) => {
    const username = String(u.id || '').replace(/^u-/, '');
    if (!username) throw new Error(`Compte sans id exploitable : ${JSON.stringify(u)}`);
    if (seen.has(username)) throw new Error(`Username en double après dérivation : « ${username} »`);
    if (reserved.has(username)) throw new Error(`Username « ${username} » en collision avec un compte réservé SUMo`);
    if (!codes.has(u.direction)) throw new Error(`Compte « ${username} » rattaché à une direction inconnue : « ${u.direction} »`);
    seen.add(username);
    return { id: u.id, username, nom: u.nom, role: u.role, direction: u.direction };
  });

const nomenclature = {
  version: 1,
  source: 'arcep-digital/server/seed.js — Délibération N°0002/ARCEP/CR/2024',
  importedAt: new Date().toISOString(),
  directions,
  users,
};

const dataFile = path.join(store.DATA_DIR, 'nomenclature.json');
store.writeJson(dataFile, nomenclature, 'nomenclature');
console.log(`Nomenclature écrite : ${dataFile}`);

if (writeDefaults) {
  const defaultsFile = path.join(__dirname, '..', 'lib', 'nomenclature-defaults.json');
  store.writeJson(defaultsFile, nomenclature, 'nomenclature-defaults');
  console.log(`Snapshot commité mis à jour : ${defaultsFile}`);
}

console.log(`Import : ${directions.length} entités (dont directions), ${users.length} comptes internes.`);
console.log(`Exclus (comptes opérateurs du portail arcep-digital) : ${seed.USERS.length - users.length}.`);
