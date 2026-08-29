'use strict';

// =============================================================================
// Ancrage externe de la racine de chaîne (complément du correctif C2).
//
// Le chiffrement des clés privées protège contre un accès au VOLUME. Il ne protège
// pas contre l'exploitant lui-même : qui détient la clé en mémoire peut réécrire
// l'historique et le resigner. La seule parade est de faire sortir la preuve de la
// machine — périodiquement, on émet un REÇU D'ANCRAGE : { rang, hash de tête,
// horodatage, signature }, destiné à être déposé chez un tiers de confiance ou
// publié (Journal Officiel, greffe, autre autorité).
//
// À partir de là, toute réécriture d'un enregistrement ANTÉRIEUR à un reçu déposé
// devient détectable par ce tiers, sans qu'il ait accès aux données : il suffit de
// recalculer la chaîne jusqu'au rang ancré et de comparer le hash.
//
// Le dépôt lui-même est un acte ORGANISATIONNEL, hors du périmètre logiciel. Le
// module produit le reçu, conserve la trace des reçus émis, et vérifie qu'ils
// concordent toujours avec la chaîne — il ne prétend pas les publier.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'anchors.jsonl');

const fingerprint = (pem) => crypto.createHash('sha256').update(String(pem)).digest('hex').slice(0, 32);

// Émet un reçu d'ancrage pour l'état courant d'une chaîne.
function emit(chain, { note } = {}) {
  const s = chain.stats();
  if (!s.total) throw new Error(`Chaîne « ${s.chain} » vide : rien à ancrer.`);
  const receipt = {
    chain: s.chain,
    seq: s.total,
    headHash: s.lastHash,
    algorithm: s.algorithm,
    publicKeyFingerprint: fingerprint(chain.getPublicKeyPem()),
    emittedAt: new Date().toISOString(),
    note: note ? String(note).slice(0, 300) : null,
  };
  // Le reçu est lui-même signé : un dépôt altéré se détecte sans la chaîne.
  const digest = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  receipt.digest = digest;
  receipt.signature = chain.signHashHex(digest);
  fs.appendFileSync(FILE, JSON.stringify(receipt) + '\n');
  logger.info('anchor.emitted', { chain: receipt.chain, seq: receipt.seq, head: receipt.headHash.slice(0, 12) });
  return receipt;
}

function list(limit = 50) {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

const latestFor = (chainName) => list(500).find((a) => a.chain === chainName) || null;

// Confronte un reçu à l'état RÉEL de la chaîne : le hash de tête au rang ancré
// doit être inchangé. Un écart signifie que l'historique a été réécrit APRÈS le
// dépôt — c'est précisément ce qu'aucune vérification interne ne peut établir.
function verifyAgainst(chain, receipt) {
  if (!receipt) return { anchored: false, reason: 'aucun reçu émis pour cette chaîne' };
  const s = chain.stats();
  if (s.total < receipt.seq) {
    return { anchored: true, valid: false, reason: `la chaîne compte ${s.total} enregistrements, moins que le rang ancré ${receipt.seq} : historique tronqué`, receipt };
  }
  const target = chain.recordAt(receipt.seq);
  if (!target) return { anchored: true, valid: false, reason: `le rang ${receipt.seq} a disparu de la chaîne : l'historique a été tronqué ou réécrit depuis le dépôt`, receipt };
  const ok = target.hash === receipt.headHash;
  return {
    anchored: true,
    valid: ok,
    reason: ok ? null : `le hash au rang ${receipt.seq} diffère du reçu déposé : l'historique a été réécrit`,
    receipt: { seq: receipt.seq, headHash: receipt.headHash, emittedAt: receipt.emittedAt, note: receipt.note },
    observed: target.hash,
  };
}

module.exports = { FILE, emit, list, latestFor, verifyAgainst, fingerprint };
