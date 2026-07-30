'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/model');

test('buildTDR : écritures en partie double équilibrées (net = 0)', () => {
  const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 2000000 });
  const net = tdr.legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0);
  assert.equal(net, 0);
  assert.equal(tdr.legs.length, 2);
  assert.equal(tdr.currency, 'XAF');
  assert.ok(tdr.iso8583.message.startsWith('0200'));
  assert.equal(tdr.source, 'SIMULATION');
});

test('buildTDR : frais calculés selon la grille (P2P > 0, AIRTIME = 0)', () => {
  const p2p = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 100000 });
  const air = model.buildTDR({ operatorId: 'airtel', type: 'AIRTIME', amount: 5000 });
  assert.ok(p2p.fee.amount > 0);
  assert.equal(air.fee.amount, 0);
});

test('buildTDR : transaction échouée → frais nuls + code d\'erreur', () => {
  const ko = model.buildTDR({ operatorId: 'moov', type: 'CASHOUT', amount: 50000, status: 'FAILED', errorCode: '51' });
  assert.equal(ko.fee.amount, 0);
  assert.equal(ko.status, 'FAILED');
  assert.equal(ko.errorCode, '51');
});

test('buildTDR : opérateur inconnu => exception', () => {
  assert.throws(() => model.buildTDR({ operatorId: 'inconnu', amount: 1 }), /inconnu/);
});

test('buildTDR : montant invalide => exception', () => {
  assert.throws(() => model.buildTDR({ operatorId: 'airtel', amount: -5 }), /Montant/);
});

test('fromIso8583 : reconstruit un TDR depuis un message ISO 8583', () => {
  const src = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 50000 });
  const tdr = model.fromIso8583(src.iso8583.message, { operatorId: 'airtel' });
  assert.equal(tdr.amountXaf, 50000);
  assert.equal(tdr.source, 'EXTERNAL');
  assert.equal(tdr.operator.id, 'airtel');
});

test('toPublic : masque le MSISDN par défaut, le révèle sur demande', () => {
  const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 1000, senderMsisdn: '+241074123456' });
  assert.match(model.toPublic(tdr).sender.msisdn, /\*\*\*\*/);
  assert.equal(model.toPublic(tdr, { reveal: true }).sender.msisdn, '+241074123456');
});
