'use strict';

// =============================================================================
// Entrepôt PostgreSQL OPTIONNEL (cahier §4 — trajectoire de production).
// Remplace/complète le stockage en mémoire de l'entrepôt par une base relationnelle
// persistante et distribuable. ACTIF uniquement si `DATABASE_URL` est défini ; sinon
// NO-OP total (l'app fonctionne en mémoire comme avant). « Fire-and-forget » : ne
// bloque jamais et ne lève jamais dans le chemin chaud.
//
// Minimisation : on persiste la vue PUBLIQUE (MSISDN masqués). Le lac de données
// BRUT (numéros en clair, gated) reste le registre signé.
// =============================================================================

const logger = require('./logger');
const model = require('./model');

let pool = null;
let ready = false;

// --- Fiabilisation (correctif P1 n°19) -------------------------------------
// AVANT : un INSERT par TDR, « fire-and-forget », dont l'échec était avalé dans
// un `logger.warn`. L'entrepôt pouvait perdre la totalité du flux pendant des
// jours pendant que `status()` continuait d'annoncer `enabled: true`. Un entrepôt
// qui ment sur sa propre santé est pire qu'un entrepôt absent.
// APRÈS : écriture par LOTS, file BORNÉE (contre-pression explicite plutôt que
// mémoire qui enfle), TLS, et remontée des échecs — comptés, datés, exposés.
const BATCH_SIZE = Number(process.env.SUMO_DB_BATCH_SIZE) || 200;
const FLUSH_MS = Number(process.env.SUMO_DB_FLUSH_MS) || 2000;
const QUEUE_MAX = Number(process.env.SUMO_DB_QUEUE_MAX) || 20_000;

const file = [];              // lot en attente
let flushTimer = null;
let flushing = false;
const metriques = {
  recus: 0, ecrits: 0, abandonnes: 0,
  lots: 0, echecs: 0, echecsConsecutifs: 0,
  dernierEchec: null, dernierSucces: null,
};

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) { logger.info('db.disabled', { reason: 'DATABASE_URL non défini (stockage en mémoire)' }); return false; }
  let pg;
  try { pg = require('pg'); } catch { logger.warn('db.pg.missing', { hint: 'npm install pg' }); return false; }
  try {
    // TLS : exigé par défaut dès que l'hôte n'est pas local. Un entrepôt qui
    // reçoit des TDR — fussent-ils masqués — ne doit pas dialoguer en clair.
    const distant = !/@(localhost|127\.0\.0\.1|\[::1\])[:/ ]/.test(url);
    const sslDemande = process.env.SUMO_DB_SSL;
    const ssl = sslDemande === '0' ? false
      : (sslDemande === '1' || distant ? { rejectUnauthorized: process.env.SUMO_DB_SSL_INSECURE !== '1' } : false);
    if (distant && ssl === false) logger.warn('db.tls.disabled', { note: 'connexion distante sans TLS — SUMO_DB_SSL=1 recommandé' });

    pool = new pg.Pool({
      connectionString: url, ssl, max: 5,
      connectionTimeoutMillis: 5000,
      statement_timeout: Number(process.env.SUMO_DB_STATEMENT_TIMEOUT_MS) || 15_000,
      application_name: 'sumo',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS tdr (
      id uuid PRIMARY KEY,
      seq bigint, hash text,
      epoch bigint, ts timestamptz,
      type text, channel text,
      operator_id text, receiver_operator_id text,
      amount_xaf bigint, currency text, fee_xaf bigint,
      status text, error_code text,
      interop boolean, cross_border boolean,
      city text, province text,
      risk_score int, alerts int,
      payload jsonb
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS tdr_epoch_idx ON tdr(epoch)');
    await pool.query('CREATE INDEX IF NOT EXISTS tdr_operator_idx ON tdr(operator_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS tdr_type_idx ON tdr(type)');
    ready = true;
    flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
    flushTimer.unref();
    logger.info('db.connected', { table: 'tdr', lot: BATCH_SIZE, fileMax: QUEUE_MAX });
    return true;
  } catch (e) {
    logger.warn('db.init.failed', { error: e.message });
    ready = false;
    return false;
  }
}

// Met un TDR en file pour écriture par lot. Ne bloque jamais le chemin chaud —
// mais, à la différence d'avant, une file pleine est un ÉVÈNEMENT compté et
// signalé, pas une perte silencieuse.
function persist(tdr, rec) {
  if (!ready || !pool) return;
  metriques.recus++;
  if (file.length >= QUEUE_MAX) {
    metriques.abandonnes++;
    if (metriques.abandonnes % 1000 === 1) {
      logger.error('db.backpressure', { fileMax: QUEUE_MAX, abandonnes: metriques.abandonnes, note: 'entrepôt en retard — TDR non répliqués (le registre signé reste la source de vérité)' });
    }
    return;
  }
  const pub = model.toPublic(tdr, { reveal: false });
  file.push([
    tdr.id, rec ? rec.seq : null, rec ? rec.hash : null, tdr.epoch,
    tdr.type, tdr.channel, tdr.operator.id, tdr.receiverOperator.id,
    tdr.amountXaf, tdr.currency, tdr.fee.amount, tdr.status, tdr.errorCode,
    tdr.interop, tdr.crossBorder, tdr.cellOrigin ? tdr.cellOrigin.city : null, tdr.cellOrigin ? tdr.cellOrigin.province : null,
    tdr.risk ? tdr.risk.score : 0, tdr.alerts ? tdr.alerts.length : 0,
    JSON.stringify(pub),
  ]);
  if (file.length >= BATCH_SIZE) flush().catch(() => {});
}

const COLONNES = 20;

// Écriture du lot en une requête multi-valeurs. Les échecs sont comptés et
// remontés : au-delà de quelques échecs consécutifs, c'est une alerte.
async function flush() {
  if (flushing || !ready || !pool || !file.length) return { ecrits: 0 };
  flushing = true;
  const lot = file.splice(0, BATCH_SIZE);
  try {
    const valeurs = [];
    const params = [];
    lot.forEach((ligne, i) => {
      const b = i * COLONNES;
      valeurs.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::bigint,to_timestamp($${b + 4}::bigint/1000.0),$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18},$${b + 19},$${b + 20})`);
      params.push(...ligne);
    });
    await pool.query(
      `INSERT INTO tdr (id,seq,hash,epoch,ts,type,channel,operator_id,receiver_operator_id,
         amount_xaf,currency,fee_xaf,status,error_code,interop,cross_border,city,province,risk_score,alerts,payload)
       VALUES ${valeurs.join(',')}
       ON CONFLICT (id) DO NOTHING`,
      params,
    );
    metriques.ecrits += lot.length;
    metriques.lots++;
    metriques.echecsConsecutifs = 0;
    metriques.dernierSucces = new Date().toISOString();
    return { ecrits: lot.length };
  } catch (e) {
    // Le lot est REMIS EN FILE : un incident transitoire ne doit pas coûter des
    // données. Il ne sera abandonné que si la file sature durablement.
    file.unshift(...lot);
    metriques.echecs++;
    metriques.echecsConsecutifs++;
    metriques.dernierEchec = { at: new Date().toISOString(), error: e.message };
    const niveau = metriques.echecsConsecutifs >= 3 ? 'error' : 'warn';
    logger[niveau]('db.flush.failed', { error: e.message, echecsConsecutifs: metriques.echecsConsecutifs, enFile: file.length });
    return { ecrits: 0, error: e.message };
  } finally { flushing = false; }
}

// L'état renvoie une SANTÉ, pas un simple booléen : « actif » ne veut rien dire
// si l'entrepôt perd le flux depuis une heure.
async function status() {
  if (!process.env.DATABASE_URL) return { enabled: false, reason: 'DATABASE_URL non défini' };
  if (!ready || !pool) return { enabled: false, reason: 'connexion indisponible', metriques };

  const sante = metriques.echecsConsecutifs >= 3 ? 'DEGRADE'
    : (metriques.abandonnes > 0 ? 'PERTE' : (file.length > QUEUE_MAX * 0.5 ? 'RETARD' : 'OK'));
  try {
    const r = await pool.query('SELECT count(*)::int AS n, max(epoch) AS last FROM tdr');
    return {
      enabled: true, sante,
      rows: r.rows[0].n,
      lastEpoch: r.rows[0].last ? Number(r.rows[0].last) : null,
      enFile: file.length, fileMax: QUEUE_MAX, lot: BATCH_SIZE,
      metriques,
      note: sante === 'OK' ? undefined : 'L\'entrepôt est un INDEX de confort : le registre signé reste la source de vérité.',
    };
  } catch (e) { return { enabled: true, sante: 'DEGRADE', error: e.message, enFile: file.length, metriques }; }
}

async function close() {
  if (flushTimer) clearInterval(flushTimer);
  // Dernière chance d'écouler la file avant l'arrêt.
  try { while (file.length) { const r = await flush(); if (!r.ecrits) break; } } catch { /* ignore */ }
  if (pool) { try { await pool.end(); } catch { /* ignore */ } }
}

module.exports = { init, persist, flush, status, close, isReady: () => ready, _metriques: () => metriques };
