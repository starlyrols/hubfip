'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/model');

test('buildTransaction : écritures en partie double équilibrées', () => {
  const tx = model.buildTransaction({ operatorId: 'bgfi', amount: 2000000, cityName: 'Libreville' });
  const net = tx.legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0);
  assert.equal(net, 0);
  assert.equal(tx.legs.length, 2);
  assert.equal(tx.currency, 'XAF');
  assert.ok(tx.iso8583.message.startsWith('0200'));
  assert.equal(tx.source, 'SIMULATION');
});

test('buildTransaction : opérateur inconnu => exception', () => {
  assert.throws(() => model.buildTransaction({ operatorId: 'inconnu', amount: 1 }), /inconnu/);
});

test('buildTransaction : montant invalide => exception', () => {
  assert.throws(() => model.buildTransaction({ operatorId: 'bgfi', amount: -5 }), /Montant/);
});

test('fromIso8583 : reconstruit une transaction depuis un message ISO 8583', () => {
  const src = model.buildTransaction({ operatorId: 'airtel', amount: 50000, cityName: 'Oyem' });
  const tx = model.fromIso8583(src.iso8583.message, { operatorId: 'airtel' });
  assert.equal(tx.amount, 50000);
  assert.equal(tx.source, 'EXTERNAL');
  assert.equal(tx.operator.id, 'airtel');
});
