'use strict';

// Robustesse du magasin d'affectations : un fichier persisté obsolète ou
// corrompu ne doit jamais empêcher le démarrage — ids inconnus/non affectables
// filtrés au chargement, entrées orphelines inertes mais conservées sur disque.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-assign-'));
process.env.SUMO_DATA_DIR = DATA_DIR;

// Fichier volontairement sale, écrit AVANT le require : module retiré du
// registre ('inexistant'), module système non affectable ('dispatch'), doublon,
// liste non-tableau, et clés orphelines (direction/compte hors nomenclature).
fs.writeFileSync(path.join(DATA_DIR, 'assignments.json'), JSON.stringify({
  version: 1,
  directions: {
    DRH: ['qos', 'inexistant', 'dispatch', 'qos'],
    ANCIENNE_DIR: ['observatoire'],
    DM: 'pas-un-tableau',
  },
  users: { fantome: ['monitoring'], airtel: ['registre'] },
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const assignments = require('../lib/assignments');

test('Chargement d\'un fichier sale : ids inconnus/non affectables filtrés, doublons retirés', () => {
  assert.deepEqual(assignments.forDirection('DRH'), ['qos']);
  assert.deepEqual(assignments.forDirection('DM'), [], 'liste non-tableau → vide');
});

test('Les clés orphelines sont conservées (signalées par l\'API, inertes faute de compte)', () => {
  const st = assignments.state();
  assert.deepEqual(st.directions.ANCIENNE_DIR, ['observatoire'], 'conservée sur disque');
  assert.deepEqual(st.users.fantome, ['monitoring'], 'conservée sur disque');
  // Aucun compte réel ne porte ce username : l'entrée n'a d'effet sur personne.
  const { getByUsername } = require('../lib/users');
  assert.equal(getByUsername('fantome'), null);
});

test('modulesForUser : union direction + individuel, ordre canonique', () => {
  const mods = assignments.modulesForUser({ username: 'airtel', direction: 'DRH' });
  assert.deepEqual(mods, ['qos', 'registre'], 'qos (DRH) + registre (individuel), ordre des onglets');
});

test('setDirection remplace l\'ensemble, persiste et retourne le diff', () => {
  const r = assignments.setDirection('DRH', ['observatoire', 'qos']);
  assert.deepEqual(r.added, ['observatoire']);
  assert.deepEqual(r.removed, []);
  const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assignments.json'), 'utf8'));
  assert.deepEqual(disk.directions.DRH, ['observatoire', 'qos'], 'persisté');
});

test('Fichier totalement corrompu (JSON invalide) : défauts en mémoire, fichier préservé', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-assign2-'));
  const file2 = path.join(dir2, 'assignments.json');
  fs.writeFileSync(file2, '{{{ pas du json');
  // Nouveau processus impossible ici : on rejoue load() sur un autre DATA_DIR
  // via un sous-processus Node pour un require frais.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.SUMO_DATA_DIR = ${JSON.stringify(dir2)};
    const a = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'assignments.js'))});
    const mods = a.modulesForUser({ username: 'dctlf', direction: 'DCTLF' });
    console.log(JSON.stringify({ mods, raw: require('fs').readFileSync(${JSON.stringify(file2)}, 'utf8') }));
  `], { encoding: 'utf8' });
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.ok(j.mods.includes('antifraude'), 'défauts en mémoire (DCTLF)');
  assert.equal(j.raw, '{{{ pas du json', 'fichier corrompu préservé pour diagnostic');
});
