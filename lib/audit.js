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
const vault = require('./crypto-store');

// Le journal d'audit consigne l'ADRESSE IP de l'agent auteur de chaque action :
// c'est une donnée personnelle d'agent public, conservée longtemps. Elle est donc
// scellée au repos comme les identifiants du registre (correctif F1). Le reste de
// l'évènement — action, acteur, cible, horodatage — demeure lisible : c'est ce qui
// fait la valeur de contrôle du journal.
const chain = createChain({
  name: 'audit', file: 'audit-log.jsonl', privName: 'audit_private.pem', pubName: 'audit_public.pem',
  seal: (p) => (p.meta && p.meta.ip ? { ...p, meta: { ...p.meta, ip: vault.encryptField(p.meta.ip) } } : p),
  unseal: (p) => (p.meta && p.meta.ip ? { ...p, meta: { ...p.meta, ip: vault.decryptField(p.meta.ip) } } : p),
});

function init() { return chain.init(); }
// Ouverture sans verrou, pour une instance en lecture seule (P2 n°23).
function openReadOnly() { return chain.openReadOnly(); }

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
// Par défaut : parcours INTÉGRAL depuis la genèse (chaînage sur 100 % des
// enregistrements, signatures échantillonnées). Les options sont transmises telles
// quelles pour que l'appelant puisse borner la portée — et l'annoncer.
const verify = (opts = { signatures: 'sample' }) => chain.verifyChain(opts);
const stats = () => chain.stats();
const getPublicKeyPem = () => chain.getPublicKeyPem();
const close = () => chain.close();

module.exports = { init, openReadOnly, record, recent, verify, stats, getPublicKeyPem, close };
