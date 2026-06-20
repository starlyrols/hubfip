'use strict';

// =============================================================================
// Module 8 — Gestion de cas / Investigation (cahier §2 #8).
// Dossiers d'enquête persistés : création (depuis une alerte ou manuelle), statut,
// notes, transactions liées, et TRAÇAGE DE CHAÎNES de transactions (drill-down :
// suivre un MSISDN/wallet à travers le registre, identifier les contreparties).
// Accès réservé aux corps de métier habilités (antifraude/juridique) et tracé au
// journal d'audit (accès nominatif encadré — cahier Phase 3).
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ref = require('./referentiel');
const ledger = require('./ledger');
const logger = require('./logger');

const DATA_DIR = process.env.SUMO_DATA_DIR || path.join(__dirname, '..', 'data');
const CASES_FILE = path.join(DATA_DIR, 'cases.json');

const STATUSES = ['OUVERT', 'EN_COURS', 'CLOS'];
let cases = [];

function load() {
  try {
    if (fs.existsSync(CASES_FILE)) cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  } catch (e) { logger.warn('cases.load.failed', { error: e.message }); cases = []; }
  return cases;
}

function persist() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 2)); }
  catch (e) { logger.warn('cases.persist.failed', { error: e.message }); }
}

function create({ title, severity, subjectMsisdn, createdBy, linkedTdrIds, fromAlert }) {
  const now = new Date().toISOString();
  const c = {
    id: 'CAS-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
    title: title || 'Dossier sans titre',
    status: 'OUVERT',
    severity: severity || 'MOYENNE',
    subjectMsisdn: subjectMsisdn || null,
    createdBy: createdBy || 'inconnu',
    createdAt: now, updatedAt: now,
    linkedTdrIds: Array.isArray(linkedTdrIds) ? linkedTdrIds : [],
    fromAlert: fromAlert || null,
    notes: [],
  };
  cases.unshift(c);
  persist();
  return c;
}

function get(id) { return cases.find((c) => c.id === id) || null; }

function list({ status, limit = 100 } = {}) {
  let l = cases;
  if (status) l = l.filter((c) => c.status === status);
  return l.slice(0, limit).map((c) => ({ ...c, notesCount: c.notes.length, linkedCount: c.linkedTdrIds.length, notes: undefined }));
}

function update(id, patch, actor) {
  const c = get(id);
  if (!c) return null;
  if (patch.status && STATUSES.includes(patch.status)) c.status = patch.status;
  if (patch.severity) c.severity = patch.severity;
  if (patch.note) c.notes.push({ at: new Date().toISOString(), by: actor || 'inconnu', text: String(patch.note).slice(0, 2000) });
  if (Array.isArray(patch.linkTdrIds)) for (const t of patch.linkTdrIds) if (!c.linkedTdrIds.includes(t)) c.linkedTdrIds.push(t);
  c.updatedAt = new Date().toISOString();
  persist();
  return c;
}

// Traçage de chaîne : toutes les transactions impliquant un MSISDN (émetteur ou
// récepteur), triées, + contreparties distinctes (drill-down). reveal contrôle le
// démasquage des numéros (à journaliser par l'appelant).
function traceChain(msisdn, { reveal = false, limit = 200 } = {}) {
  const records = ledger.readAll((p) => p.sender.msisdn === msisdn || p.receiver.msisdn === msisdn);
  const tx = records.slice(-limit).map(({ seq, hash, payload }) => {
    const counterMsisdn = payload.sender.msisdn === msisdn ? payload.receiver.msisdn : payload.sender.msisdn;
    const direction = payload.sender.msisdn === msisdn ? 'ENVOI' : 'RECEPTION';
    return {
      seq, hash, tdrId: payload.id, epoch: payload.epoch, type: payload.type, channel: payload.channel,
      amountXaf: payload.amountXaf, status: payload.status, direction,
      counterparty: reveal ? counterMsisdn : ref.maskMsisdn(counterMsisdn),
      operatorId: payload.operator.id, city: payload.cellOrigin.city,
    };
  }).sort((a, b) => a.epoch - b.epoch);

  const counterparties = new Map();
  for (const t of tx) {
    const k = t.counterparty;
    if (!counterparties.has(k)) counterparties.set(k, { counterparty: k, count: 0, sumXaf: 0 });
    const e = counterparties.get(k); e.count++; e.sumXaf += t.amountXaf;
  }
  return {
    subject: reveal ? msisdn : ref.maskMsisdn(msisdn),
    totalTx: tx.length,
    sumXaf: tx.reduce((s, t) => s + t.amountXaf, 0),
    counterparties: [...counterparties.values()].sort((a, b) => b.sumXaf - a.sumXaf),
    transactions: tx,
  };
}

function stats() {
  return {
    total: cases.length,
    ouvert: cases.filter((c) => c.status === 'OUVERT').length,
    enCours: cases.filter((c) => c.status === 'EN_COURS').length,
    clos: cases.filter((c) => c.status === 'CLOS').length,
  };
}

module.exports = { STATUSES, load, create, get, list, update, traceChain, stats };
