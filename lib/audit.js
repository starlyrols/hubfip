'use strict';

// =============================================================================
// Module 12 (volet gouvernance) — Journal d'audit INVIOLABLE (cahier §2 #12, §9).
// Toute action sensible est consignée dans un registre append-only chaîné/signé,
// distinct du registre des TDR. Tracé notamment : connexions, exports, RÉVÉLATION
// de MSISDN (accès nominatif encadré — loi 001/2011), accès/édition de dossiers,
// modifications de configuration. Vérifiable cryptographiquement comme les TDR.
// =============================================================================

const { createChain } = require('./ledger');
const logger = require('./logger');

const chain = createChain({ name: 'audit', file: 'audit-log.jsonl', privName: 'audit_private.pem', pubName: 'audit_public.pem' });

function init() { return chain.init(); }

// event : { action, actor, role, target, meta }
function record(event) {
  const payload = {
    action: String(event.action || 'UNKNOWN'),
    actor: event.actor || 'anonyme',
    role: event.role || null,
    target: event.target != null ? String(event.target) : null,
    meta: event.meta || {},
    at: new Date().toISOString(),
  };
  const rec = chain.append(payload);
  logger.info('audit', { action: payload.action, actor: payload.actor, seq: rec.seq });
  return rec;
}

const recent = (limit = 100) => chain.getRecent(limit).map((r) => ({ seq: r.seq, hash: r.hash, ts: r.ts, ...r.payload }));
const verify = () => chain.verifyChain();
const stats = () => chain.stats();
const getPublicKeyPem = () => chain.getPublicKeyPem();

module.exports = { init, record, recent, verify, stats, getPublicKeyPem };
