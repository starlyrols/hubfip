'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const iso = require('../lib/iso8583');

test('pack/unpack : round-trip des champs FIXED et LLVAR', () => {
  const fields = {
    processingCode: '000000', amountMinor: 1500000, stan: '000042',
    acquirerId: 'BGFI', responseCode: '00', cardAcceptorLocation: 'Libreville, GA', currency: '950',
  };
  const msg = iso.pack('0200', fields);
  const { mti, fields: out } = iso.unpack(msg);
  assert.equal(mti, '0200');
  assert.equal(out.amountMinor, '000001500000'); // n12, padding à gauche
  assert.equal(out.currency, '950');
  assert.equal(out.stan, '000042');
  assert.equal(out.acquirerId, 'BGFI');
  assert.equal(out.responseCode, '00');
  assert.equal(out.cardAcceptorLocation, 'Libreville, GA');
});

test('LLVAR : la longueur est encodée sur 2 chiffres', () => {
  const msg = iso.pack('0200', { acquirerId: 'AB' });
  assert.ok(msg.endsWith('02AB'));
});

test('unpack : rejette un message trop court', () => {
  assert.throws(() => iso.unpack('0200'), /trop court/);
});

test('pack : rejette un MTI invalide', () => {
  assert.throws(() => iso.pack('20', { amountMinor: 1 }), /MTI/);
});

test('pack : rejette un champ inconnu', () => {
  assert.throws(() => iso.pack('0200', { inexistant: 'x' }), /inconnu/);
});
