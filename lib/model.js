'use strict';

// Modèle de transaction RÉEL (corrige l'angle métier : comptabilité en partie
// double, devise, cycle de vie de règlement, idempotency key — gaps de l'audit).
// Une transaction porte des écritures (legs) débit/crédit ÉQUILIBRÉES.

const crypto = require('crypto');
const { byId, cityByName, CITIES, TYPES } = require('./referentiel');
const iso = require('./iso8583');

const STATUS = Object.freeze(['AUTHORIZED', 'CLEARED', 'SETTLED', 'REJECTED']);
const CURRENCY_XAF = '950'; // ISO 4217 numérique
const CLEARING_ACCOUNT = 'GA-CLEARING-BEAC'; // compte de compensation (démo)

let stanCounter = Math.floor(Date.now() % 1000000);
function nextStan() {
  stanCounter = (stanCounter + 1) % 1000000;
  return String(stanCounter).padStart(6, '0');
}

function processingCodeFor(type) {
  switch (type) {
    case TYPES.MOMO: return '260000';   // transfert / Mobile Money
    case TYPES.EMF: return '210000';    // dépôt microfinance
    case TYPES.GATEWAY: return '300000'; // compensation inter-établissements
    default: return '000000';            // achat / paiement bancaire
  }
}

function responseCodeFor(status) {
  return status === 'REJECTED' ? '12' : '00'; // 00 = approuvé, 12 = transaction invalide
}

function isoDateTimeParts(d) {
  const p = (n, l) => String(n).padStart(l, '0');
  const MM = p(d.getUTCMonth() + 1, 2);
  const DD = p(d.getUTCDate(), 2);
  const hh = p(d.getUTCHours(), 2);
  const mm = p(d.getUTCMinutes(), 2);
  const ss = p(d.getUTCSeconds(), 2);
  return {
    transmissionDateTime: MM + DD + hh + mm + ss,
    localTime: hh + mm + ss,
    localDate: MM + DD,
  };
}

// Construit une transaction normalisée + équilibrée à partir d'une entrée simple.
function buildTransaction(input) {
  const op = byId.get(input.operatorId);
  if (!op) throw new Error(`Opérateur inconnu: ${input.operatorId}`);

  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide');

  let city = input.cityName ? cityByName.get(input.cityName) : undefined;
  if (!city) city = CITIES[0];

  const status = STATUS.includes(input.status) ? input.status : 'AUTHORIZED';
  const when = input.datetime ? new Date(input.datetime) : new Date();
  const stan = input.stan || nextStan();
  const id = input.id || crypto.randomUUID();
  const idempotencyKey = input.idempotencyKey || crypto.createHash('sha256')
    .update(`${op.id}|${amount}|${stan}|${when.getTime()}`).digest('hex').slice(0, 24);

  const counterparty = input.counterpartyId
    ? (byId.get(input.counterpartyId) || { id: CLEARING_ACCOUNT, name: 'Compensation nationale', type: TYPES.GATEWAY })
    : { id: CLEARING_ACCOUNT, name: 'Compensation nationale', type: TYPES.GATEWAY };

  // Partie double : DÉBIT émetteur, CRÉDIT bénéficiaire. Somme nette = 0.
  const legs = [
    { account: `acct:${op.id}`, direction: 'DEBIT', amount, currency: 'XAF' },
    { account: `acct:${counterparty.id}`, direction: 'CREDIT', amount, currency: 'XAF' },
  ];
  const net = legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0);
  if (net !== 0) throw new Error('Écritures déséquilibrées (partie double rompue)');

  const dt = isoDateTimeParts(when);
  const isoFields = {
    pan: `${op.id}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 19) || '0',
    processingCode: processingCodeFor(op.type),
    amountMinor: amount, // XAF : pas de sous-unité
    transmissionDateTime: dt.transmissionDateTime,
    stan,
    localTime: dt.localTime,
    localDate: dt.localDate,
    acquirerId: op.id.toUpperCase().slice(0, 11),
    rrn: ('R' + stan + String(when.getTime()).slice(-5)).slice(0, 12),
    responseCode: responseCodeFor(status),
    terminalId: ('T' + op.id.toUpperCase()).slice(0, 8),
    cardAcceptorLocation: `${city.name}, GA`,
    currency: CURRENCY_XAF,
  };
  const mti = '0200'; // demande d'autorisation financière
  const iso8583Message = iso.pack(mti, isoFields);

  return {
    id,
    idempotencyKey,
    epoch: when.getTime(),
    datetime: when.toISOString(),
    operator: { id: op.id, name: op.name, type: op.type },
    counterparty: { id: counterparty.id, name: counterparty.name, type: counterparty.type },
    amount,
    currency: 'XAF',
    status,
    legs,
    location: { city: city.name, province: city.province, lat: city.lat, lng: city.lng },
    source: input.source === 'EXTERNAL' ? 'EXTERNAL' : 'SIMULATION',
    anomaly: status === 'REJECTED'
      ? { flagged: true, reason: input.anomalyReason || 'Échec de vérification de signature' }
      : { flagged: false, reason: null },
    iso8583: { mti, stan, message: iso8583Message },
  };
}

// Reconstruit une entrée transaction depuis un message ISO 8583 entrant (injection externe).
function fromIso8583(message, meta = {}) {
  const { fields } = iso.unpack(message);
  const operatorId = (meta.operatorId || (fields.acquirerId || '').toLowerCase());
  return buildTransaction({
    operatorId,
    amount: Number(fields.amountMinor),
    cityName: meta.cityName,
    status: fields.responseCode === '00' ? 'AUTHORIZED' : 'REJECTED',
    source: 'EXTERNAL',
    stan: fields.stan,
  });
}

module.exports = { STATUS, CURRENCY_XAF, buildTransaction, fromIso8583, nextStan };
