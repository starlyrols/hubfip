'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Registre isolé dans un dossier temporaire (n'altère pas les données réelles).
process.env.HUBFIP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubfip-ledger-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../lib/ledger');
const model = require('../lib/model');

ledger.init();

test('append + verifyChain : chaîne valide et signée', () => {
  ledger.append(model.buildTransaction({ operatorId: 'bgfi', amount: 1000000, cityName: 'Libreville' }));
  ledger.append(model.buildTransaction({ operatorId: 'moov', amount: 30000, cityName: 'Port-Gentil' }));
  const v = ledger.verifyChain();
  assert.equal(v.valid, true);
  assert.equal(v.total, 2);
});

test('verifyChain : détecte une falsification du contenu', () => {
  const file = path.join(process.env.HUBFIP_DATA_DIR, 'ledger.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.payload.amount = 999999999; // altération
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const v = ledger.verifyChain();
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 1);
});
