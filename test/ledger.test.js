'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Registre isolé dans un dossier temporaire (n'altère pas les données réelles).
process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ledger-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../lib/ledger');
const model = require('../lib/model');

ledger.init();

test('append + verifyChain : chaîne valide et signée', () => {
  ledger.append(model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 1000000 }));
  ledger.append(model.buildTDR({ operatorId: 'moov', type: 'CASHOUT', amount: 30000 }));
  const v = ledger.verifyChain();
  assert.equal(v.valid, true);
  assert.equal(v.total, 2);
});

test('verifyChain : détecte une falsification du contenu', () => {
  const file = path.join(process.env.SUMO_DATA_DIR, 'tdr-ledger.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.payload.amountXaf = 999999999; // altération
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const v = ledger.verifyChain();
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 1);
});

test('canonical : insensible aux clés undefined (hash stable après aller-retour JSON)', () => {
  const a = ledger.canonical({ x: 1, y: undefined, z: 'a' });
  const b = ledger.canonical(JSON.parse(JSON.stringify({ x: 1, y: undefined, z: 'a' })));
  assert.equal(a, b);
});
