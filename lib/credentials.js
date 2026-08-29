'use strict';

// =============================================================================
// Magasin d'identifiants INDIVIDUELS (correctif B3).
//
// AVANT : `users.js` calculait UN hachage unique (`DEMO_HASH`) et l'attribuait aux
// 31 comptes — Président, directeurs, agents, admin système et opérateurs Mobile
// Money compris. Conséquences : aucune imputabilité réelle (le journal d'audit
// nomme un compte, pas une personne — n'importe qui pouvait ouvrir n'importe
// lequel), un secret unique dont la fuite livre toute la plateforme, aucun
// changement au premier accès, aucune expiration, aucun second facteur.
//
// APRÈS : chaque compte porte son propre secret, dérivé par scrypt avec un sel
// distinct, persisté hors du code (data/credentials.json, 0600) :
//   * en PRODUCTION, un mot de passe initial ALÉATOIRE par compte est généré une
//     fois et déposé dans un fichier de remise ; le changement au premier accès
//     est OBLIGATOIRE et bloque l'accès aux modules tant qu'il n'a pas eu lieu ;
//   * politique de robustesse et expiration ;
//   * verrouillage temporaire après échecs répétés (anti-force brute) ;
//   * SECOND FACTEUR TOTP exigé des profils habilités à la révélation.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');
const { hashPassword, verifyPassword } = require('./auth');
const totp = require('./totp');

const FILE = path.join(store.DATA_DIR, 'credentials.json');
const HANDOVER_FILE = path.join(store.DATA_DIR, 'keys', 'mots-de-passe-initiaux.txt');

const MIN_LENGTH = Number(process.env.SUMO_PASSWORD_MIN_LENGTH) || 12;
const MAX_FAILED = Number(process.env.SUMO_LOGIN_MAX_FAILED) || 5;
const LOCK_MS = Number(process.env.SUMO_LOGIN_LOCK_MS) || 15 * 60_000;
const MAX_AGE_DAYS = Number(process.env.SUMO_PASSWORD_MAX_AGE_DAYS) || 180;
const RECOVERY_CODES = 8;

// Refus élémentaire des secrets manifestement faibles. Ce n'est pas un dictionnaire
// exhaustif — c'est le minimum qu'un régulateur ne peut pas ne pas faire.
const FORBIDDEN = new Set(['motdepasse', 'password', 'azertyuiop', 'qwertyuiop', '123456789012', 'arcep@2026', 'administrateur']);

let state = null;

function blank() { return { version: 1, users: {} }; }

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) { logger.error('credentials.persist.failed', { error: e.message }); }
}

function randomPassword() {
  // Alphabet sans caractères ambigus (O/0, l/1) : ces mots de passe sont recopiés
  // à la main lors de la remise en main propre.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%+=?';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

// --- Politique de robustesse ----------------------------------------------
function checkPolicy(password, username) {
  const p = String(password || '');
  if (p.length < MIN_LENGTH) throw new Error(`Mot de passe trop court : ${MIN_LENGTH} caractères minimum.`);
  if (p.toLowerCase().includes(String(username).toLowerCase())) throw new Error('Le mot de passe ne peut pas contenir l\'identifiant du compte.');
  if (FORBIDDEN.has(p.toLowerCase())) throw new Error('Mot de passe trop courant.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (classes < 3) throw new Error('Le mot de passe doit combiner au moins trois familles de caractères (minuscules, majuscules, chiffres, symboles).');
  return true;
}

// --- Initialisation --------------------------------------------------------
// `accounts` : [{ username, requiresTotp }]. `demoMode` : hors production, tous les
// comptes partagent le mot de passe de démonstration et ne sont pas contraints au
// changement — mais chacun possède DÉJÀ son entrée propre, donc son propre secret
// dès le premier changement, et l'imputabilité reste individuelle.
function load(accounts, { demoMode = false, demoPassword = null } = {}) {
  state = store.readJson(FILE, null, 'credentials') || blank();
  const created = [];
  const handover = [];
  for (const acc of accounts) {
    if (state.users[acc.username]) {
      state.users[acc.username].requiresTotp = !!acc.requiresTotp;
      continue;
    }
    const initial = demoMode ? demoPassword : randomPassword();
    state.users[acc.username] = {
      hash: hashPassword(initial),
      mustChange: !demoMode,
      updatedAt: new Date().toISOString(),
      failed: 0,
      lockedUntil: null,
      requiresTotp: !!acc.requiresTotp,
      totpSecret: null,
      totpActivatedAt: null,
      recoveryHashes: [],
    };
    created.push(acc.username);
    if (!demoMode) handover.push(`${acc.username.padEnd(24)} ${initial}`);
  }
  if (created.length) {
    persist();
    if (handover.length) writeHandover(handover);
    logger.info('credentials.seeded', { comptes: created.length, mode: demoMode ? 'démonstration' : 'production' });
  }
  return state;
}

// Fichier de REMISE des mots de passe initiaux : écrit une seule fois, en 0600,
// destiné à une distribution en main propre puis à une destruction. Il n'est jamais
// relu par l'application.
function writeHandover(lines) {
  const body = [
    '# SUMo — mots de passe INITIAUX (remise en main propre)',
    '# Générés le ' + new Date().toISOString(),
    '# Chaque titulaire DOIT changer le sien à la première connexion (imposé par la plateforme).',
    '# DÉTRUIRE ce fichier après distribution.',
    '',
    ...lines,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(HANDOVER_FILE), { recursive: true });
    fs.writeFileSync(HANDOVER_FILE, body, { mode: 0o600 });
    logger.warn('credentials.handover.written', { file: HANDOVER_FILE, comptes: lines.length, note: 'à distribuer puis détruire' });
  } catch (e) { logger.error('credentials.handover.failed', { error: e.message }); }
}

const ensure = () => state || blank();
const get = (username) => ensure().users[username] || null;

// --- Authentification ------------------------------------------------------
// Renvoie { ok, reason, mustChange, totpRequired, ... } — jamais un simple booléen :
// l'appelant doit pouvoir distinguer « identifiants faux » de « compte verrouillé »
// ou « second facteur attendu », et journaliser en conséquence.
function authenticate(username, password, otp) {
  const c = get(username);
  if (!c) return { ok: false, reason: 'INCONNU' };

  if (c.lockedUntil && Date.now() < c.lockedUntil) {
    return { ok: false, reason: 'VERROUILLE', retryAt: new Date(c.lockedUntil).toISOString() };
  }

  if (!verifyPassword(password, c.hash)) {
    c.failed = (c.failed || 0) + 1;
    if (c.failed >= MAX_FAILED) {
      c.lockedUntil = Date.now() + LOCK_MS;
      c.failed = 0;
      persist();
      logger.warn('credentials.locked', { username, minutes: Math.round(LOCK_MS / 60000) });
      return { ok: false, reason: 'VERROUILLE', retryAt: new Date(c.lockedUntil).toISOString() };
    }
    persist();
    return { ok: false, reason: 'INVALIDE', remaining: MAX_FAILED - c.failed };
  }

  // Second facteur : exigé des profils habilités dès qu'il est activé. Tant qu'il
  // ne l'est pas, l'accès est ouvert mais CONTRAINT à l'enrôlement (voir gate()).
  if (c.requiresTotp && c.totpActivatedAt) {
    if (!otp) { return { ok: false, reason: 'TOTP_REQUIS' }; }
    if (!totp.verify(c.totpSecret, otp) && !consumeRecovery(c, otp)) {
      c.failed = (c.failed || 0) + 1;
      if (c.failed >= MAX_FAILED) { c.lockedUntil = Date.now() + LOCK_MS; c.failed = 0; }
      persist();
      return { ok: false, reason: 'TOTP_INVALIDE' };
    }
  }

  c.failed = 0; c.lockedUntil = null;
  persist();
  return { ok: true, mustChange: !!c.mustChange, mustEnrollTotp: !!(c.requiresTotp && !c.totpActivatedAt), expired: isExpired(c) };
}

function consumeRecovery(c, code) {
  const given = String(code || '').replace(/\s|-/g, '').toLowerCase();
  const idx = (c.recoveryHashes || []).findIndex((h) => verifyPassword(given, h));
  if (idx === -1) return false;
  c.recoveryHashes.splice(idx, 1); // à usage unique
  logger.warn('credentials.recovery.used', { restants: c.recoveryHashes.length });
  return true;
}

function isExpired(c) {
  if (!MAX_AGE_DAYS || !c.updatedAt) return false;
  return Date.now() - new Date(c.updatedAt).getTime() > MAX_AGE_DAYS * 86_400_000;
}

// --- Contrainte d'accès ----------------------------------------------------
// Évaluée à CHAQUE requête, comme le dispatch des modules : un changement de mot
// de passe lève la contrainte immédiatement, sans reconnexion.
function gate(username) {
  const c = get(username);
  if (!c) return { blocked: true, reason: 'COMPTE_INCONNU' };
  if (c.mustChange) return { blocked: true, reason: 'CHANGEMENT_REQUIS', message: 'Changement du mot de passe initial obligatoire avant tout accès.' };
  if (isExpired(c)) return { blocked: true, reason: 'EXPIRE', message: `Mot de passe expiré (au-delà de ${MAX_AGE_DAYS} jours).` };
  if (c.requiresTotp && !c.totpActivatedAt) return { blocked: true, reason: 'TOTP_ENROLEMENT_REQUIS', message: 'Ce profil est habilité à la révélation des numéros : l\'enrôlement d\'un second facteur est obligatoire.' };
  return { blocked: false };
}

function changePassword(username, current, next) {
  const c = get(username);
  if (!c) throw new Error('Compte inconnu.');
  if (!verifyPassword(current, c.hash)) throw new Error('Mot de passe actuel incorrect.');
  if (String(current) === String(next)) throw new Error('Le nouveau mot de passe doit différer de l\'ancien.');
  checkPolicy(next, username);
  c.hash = hashPassword(next);
  c.mustChange = false;
  c.updatedAt = new Date().toISOString();
  c.failed = 0; c.lockedUntil = null;
  persist();
  logger.info('credentials.password.changed', { username });
  return true;
}

// --- Second facteur --------------------------------------------------------
function beginTotpEnrollment(username) {
  const c = get(username);
  if (!c) throw new Error('Compte inconnu.');
  if (c.totpActivatedAt) throw new Error('Un second facteur est déjà actif sur ce compte.');
  c.totpSecret = totp.generateSecret();
  persist();
  return { secret: c.totpSecret, uri: totp.enrollUri(c.totpSecret, { account: username }) };
}

function activateTotp(username, code) {
  const c = get(username);
  if (!c || !c.totpSecret) throw new Error('Aucun enrôlement en cours.');
  if (!totp.verify(c.totpSecret, code)) throw new Error('Code invalide — vérifiez l\'heure de votre appareil.');
  c.totpActivatedAt = new Date().toISOString();
  // Codes de secours à usage unique : sans eux, un appareil perdu condamne le compte.
  const codes = Array.from({ length: RECOVERY_CODES }, () => crypto.randomBytes(5).toString('hex'));
  c.recoveryHashes = codes.map((x) => hashPassword(x));
  persist();
  logger.info('credentials.totp.activated', { username });
  return { recoveryCodes: codes };
}

// État présentable (jamais de secret).
function describe(username) {
  const c = get(username);
  if (!c) return null;
  return {
    mustChange: !!c.mustChange,
    expired: isExpired(c),
    updatedAt: c.updatedAt,
    locked: !!(c.lockedUntil && Date.now() < c.lockedUntil),
    requiresTotp: !!c.requiresTotp,
    totpActive: !!c.totpActivatedAt,
    recoveryCodesLeft: (c.recoveryHashes || []).length,
  };
}

function summary() {
  const all = Object.entries(ensure().users);
  return {
    comptes: all.length,
    // Un secret partagé se voit : deux comptes au même hachage, c'est le défaut B3.
    secretsDistincts: new Set(all.map(([, c]) => c.hash)).size,
    changementRequis: all.filter(([, c]) => c.mustChange).length,
    expires: all.filter(([, c]) => isExpired(c)).length,
    verrouilles: all.filter(([, c]) => c.lockedUntil && Date.now() < c.lockedUntil).length,
    totpRequis: all.filter(([, c]) => c.requiresTotp).length,
    totpActifs: all.filter(([, c]) => c.totpActivatedAt).length,
    politique: { longueurMin: MIN_LENGTH, familles: 3, expirationJours: MAX_AGE_DAYS, echecsAvantVerrou: MAX_FAILED },
  };
}

module.exports = {
  FILE, HANDOVER_FILE, MIN_LENGTH, MAX_FAILED, MAX_AGE_DAYS,
  load, authenticate, gate, changePassword, checkPolicy,
  beginTotpEnrollment, activateTotp, describe, summary, get,
};
