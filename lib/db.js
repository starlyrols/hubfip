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

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) { logger.info('db.disabled', { reason: 'DATABASE_URL non défini (stockage en mémoire)' }); return false; }
  let pg;
  try { pg = require('pg'); } catch { logger.warn('db.pg.missing', { hint: 'npm install pg' }); return false; }
  try {
    pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
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
    logger.info('db.connected', { table: 'tdr' });
    return true;
  } catch (e) {
    logger.warn('db.init.failed', { error: e.message });
    ready = false;
    return false;
  }
}

// Persiste un TDR (vue publique masquée). Non bloquant, n'échoue jamais bruyamment.
function persist(tdr, rec) {
  if (!ready || !pool) return;
  const pub = model.toPublic(tdr, { reveal: false });
  pool.query(
    `INSERT INTO tdr (id,seq,hash,epoch,ts,type,channel,operator_id,receiver_operator_id,
       amount_xaf,currency,fee_xaf,status,error_code,interop,cross_border,city,province,risk_score,alerts,payload)
     VALUES ($1,$2,$3,$4,to_timestamp($4/1000.0),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (id) DO NOTHING`,
    [
      tdr.id, rec ? rec.seq : null, rec ? rec.hash : null, tdr.epoch,
      tdr.type, tdr.channel, tdr.operator.id, tdr.receiverOperator.id,
      tdr.amountXaf, tdr.currency, tdr.fee.amount, tdr.status, tdr.errorCode,
      tdr.interop, tdr.crossBorder, tdr.cellOrigin.city, tdr.cellOrigin.province,
      tdr.risk ? tdr.risk.score : 0, tdr.alerts ? tdr.alerts.length : 0,
      JSON.stringify(pub),
    ],
  ).catch((e) => logger.warn('db.persist.failed', { error: e.message }));
}

async function status() {
  if (!process.env.DATABASE_URL) return { enabled: false, reason: 'DATABASE_URL non défini' };
  if (!ready || !pool) return { enabled: false, reason: 'connexion indisponible' };
  try {
    const r = await pool.query('SELECT count(*)::int AS n, max(epoch) AS last FROM tdr');
    return { enabled: true, rows: r.rows[0].n, lastEpoch: r.rows[0].last ? Number(r.rows[0].last) : null };
  } catch (e) { return { enabled: true, error: e.message }; }
}

async function close() { if (pool) { try { await pool.end(); } catch { /* ignore */ } } }

module.exports = { init, persist, status, close, isReady: () => ready };
