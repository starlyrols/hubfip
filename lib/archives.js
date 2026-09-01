'use strict';

// =============================================================================
// Module M15 — ARCHIVAGE ÉLECTRONIQUE des dossiers clos.
//
// Jusqu'ici, « Archivage légal » n'était qu'une ligne de suivi : le dossier
// restait un enregistrement modifiable de data/dossiers.json, et rien ne
// distinguait un dossier archivé d'un dossier simplement fermé. Un archivage
// électronique digne de ce nom exige trois propriétés :
//
//   1. FIGEMENT — l'archive est un instantané complet du dossier (métadonnées,
//      suivi intégral, avis, décision, empreintes des pièces versées), pris à
//      la clôture et jamais retouché ;
//   2. SCELLEMENT — l'instantané est haché, chaîné et signé (ECDSA P-256) dans
//      un REGISTRE D'ARCHIVES dédié, append-only : mêmes garanties
//      cryptographiques que le registre des TDR, mêmes outils de vérification,
//      même ancrage externe possible ;
//   3. VÉRIFIABILITÉ — quiconque détient l'archive et la clé publique peut
//      prouver qu'elle n'a pas changé depuis la clôture, sans faire confiance
//      à la plateforme.
//
// Les identifiants nominatifs éventuels suivent le régime du reste de la
// plateforme : le scellement de chaîne porte la forme stockée, et le registre
// vit dans le même volume protégé (chiffrement au repos, sauvegardes chiffrées,
// rotation ancrée).
// =============================================================================

const crypto = require('crypto');
const ledger = require('./ledger');
const logger = require('./logger');

// Chaîne dédiée : clés distinctes du registre TDR et du journal d'audit.
const chain = ledger.createChain({
  name: 'archives',
  file: 'archives-dossiers.jsonl',
  privName: 'archives_private.pem',
  pubName: 'archives_public.pem',
});

function init() { return chain.init(); }
function openReadOnly() { return chain.openReadOnly(); }
function close() { return chain.close(); }

// Instantané d'archivage : TOUT ce qui fait le dossier, plus rien ne bougera.
function snapshot(d, typeLabel) {
  return {
    kind: 'ARCHIVE_DOSSIER',
    numero: d.numero,
    typeId: d.typeId,
    typeLabel: typeLabel || d.typeId,
    couloir: d.couloir,
    objet: d.objet,
    demandeur: d.demandeur,
    priorite: d.priorite,
    directionPilote: d.directionPilote,
    instructeur: d.instructeur,
    statutFinal: d.statut,
    dates: d.dates,
    suspenduMs: d.suspenduMs || 0,
    rapport: d.rapport || null,
    avis: d.avis,
    decision: d.decision,
    // Les pièces sont archivées par EMPREINTE : le contenu vit dans le dépôt de
    // pièces, l'archive prouve ce qui a été versé, quand, par qui, et que le
    // fichier détenu aujourd'hui est bien celui versé alors.
    pieces: (d.piecesFournies || []).map((p) => ({
      id: p.id, nom: p.nom, mime: p.mime, octets: p.octets, sha256: p.sha256,
      versePar: p.versePar, epoch: p.epoch,
    })),
    piecesAttendues: d.piecesAttendues || [],
    suivi: d.suivi, // intégral — pas la fenêtre des 40 derniers
    archiveLe: new Date().toISOString(),
  };
}

// Scelle l'archive d'un dossier clos. Idempotent par numéro : un dossier ne
// s'archive qu'une fois — la première écriture fait foi.
const dejaArchives = new Set();
function seal(d, typeLabel) {
  if (dejaArchives.has(d.numero)) return null;
  const rec = chain.append(snapshot(d, typeLabel));
  dejaArchives.add(d.numero);
  logger.info('archives.sealed', { numero: d.numero, seq: rec.seq, statut: d.statut });
  return { seq: rec.seq, hash: rec.hash, signature: rec.signature, ts: rec.ts };
}

// Réamorçage au démarrage : les numéros déjà scellés ne le seront pas deux fois.
function seedFromChain() {
  let n = 0;
  for (const r of chain.readAll()) {
    if (r.payload && r.payload.numero) { dejaArchives.add(r.payload.numero); n++; }
  }
  if (n) logger.info('archives.seeded', { archives: n });
  return n;
}

// Archive d'un dossier : l'enregistrement scellé complet, avec de quoi le
// vérifier hors plateforme.
function get(numero) {
  const found = chain.readAll((p) => p.numero === numero);
  if (!found.length) return null;
  const r = found[0];
  return {
    seq: r.seq, hash: r.hash, payload: r.payload,
    algorithm: chain.stats().algorithm,
    publicKeyPem: chain.getPublicKeyPem(),
  };
}

const stats = () => chain.stats();
const verify = (opts) => chain.verifyChain(opts);
const isArchived = (numero) => dejaArchives.has(numero);

// Empreinte utilitaire pour les pièces (module pieces + tests).
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { init, openReadOnly, close, seal, seedFromChain, get, stats, verify, isArchived, snapshot, sha256, chain };
