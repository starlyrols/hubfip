'use strict';

// Fabriques de jeux d'essai conformes au CONTRAT D'INTERFAÇAGE (« Fiche
// d'interfaçage opérateur ↔ ARCEP »). Depuis le correctif A1, un enregistrement
// externe incomplet est REJETÉ : les tests doivent donc partir d'une déclaration
// complète, et exprimer explicitement ce qu'ils veulent rendre incomplet.

// Enregistrement brut tel qu'un opérateur le transmet (dialecte « maison »).
function contractRecord(over = {}) {
  return {
    transaction_id: 'AM-TEST-' + Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    transaction_type: 'P2P',
    amount: 250000,
    currency: 'XAF',
    fee_amount: 1200,
    tax_amount: 216,
    status: 'SUCCESS',
    channel: 'USSD',
    sender_msisdn: '+241074111111',
    receiver_msisdn: '+241066222222',
    ...over,
  };
}

// Entrée `model.buildTDR` pour un TDR EXTERNE complet (contrat satisfait).
function externalInput(over = {}) {
  return {
    senderOperatorId: 'airtel',
    operatorRef: 'AM-TEST-' + Math.random().toString(36).slice(2, 10),
    datetime: new Date().toISOString(),
    type: 'P2P',
    channel: 'USSD',
    amount: 250000,
    currency: 'XAF',
    feeDeclared: 1200,
    taxDeclared: 216,
    status: 'SUCCESS',
    senderMsisdn: '+241074111111',
    receiverMsisdn: '+241066222222',
    source: 'EXTERNAL',
    ...over,
  };
}

// Enveloppe d'injection JSON signée (POST /api/v1/iso8583).
const injectionBody = (operatorId = 'airtel', over = {}) =>
  JSON.stringify({ operatorId, record: contractRecord(over) });

// En-têtes d'injection signés, dans le schéma du correctif P1 n°11 : clé propre à
// l'assujetti, horodatage et nonce COUVERTS par la signature (anti-rejeu).
function injectionHeaders(body, { operatorId = 'airtel', key, secret, timestamp, nonce } = {}) {
  const crypto = require('node:crypto');
  const connectors = require('../lib/connectors');
  const cred = connectors._state().operators[operatorId];
  const k = key || cred.key;
  const s = secret || require('../lib/crypto-store').decryptField(cred.secret);
  const ts = timestamp != null ? timestamp : Date.now();
  const n = nonce || 'nonce-' + crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', s).update(`${ts}.${n}.`).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-sumo-key': k,
    'x-sumo-signature': sig,
    'x-sumo-timestamp': String(ts),
    'x-sumo-nonce': n,
  };
}

module.exports = { contractRecord, externalInput, injectionBody, injectionHeaders };
