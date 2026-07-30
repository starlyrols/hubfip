'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Sans DATABASE_URL, l'entrepôt PostgreSQL est DÉSACTIVÉ (no-op) : l'app reste en
// mémoire. On vérifie que rien ne casse dans ce mode (chemin par défaut des tests/CI).
delete process.env.DATABASE_URL;
const db = require('../lib/db');

test('db : désactivé sans DATABASE_URL', async () => {
  const ok = await db.init();
  assert.equal(ok, false);
  assert.equal(db.isReady(), false);
});

test('db : persist() est un no-op sûr quand désactivé', () => {
  assert.doesNotThrow(() => db.persist({}, { seq: 1, hash: 'h' }));
});

test('db : status() signale enabled=false', async () => {
  const s = await db.status();
  assert.equal(s.enabled, false);
});
