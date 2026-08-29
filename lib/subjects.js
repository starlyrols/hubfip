'use strict';

// =============================================================================
// Jetons de sujet — minimisation des données (loi 001/2011).
// Les alertes / scores exposés au client ne portent JAMAIS le MSISDN en clair,
// mais un jeton opaque. Seul le serveur peut le résoudre, et la révélation
// effective (traçage) est réservée aux rôles habilités et journalisée.
//
// SÉCURITÉ (correctif B1) : le jeton est un HMAC-SHA256 sous CLÉ SECRÈTE, jamais
// un hash simple. Un hash non clé du MSISDN est trivialement réversible — le plan
// de numérotation national tient dans moins de 10^8 valeurs, donc l'espace entier
// se pré-calcule en quelques secondes. La clé (256 bits) est générée au premier
// démarrage et persistée hors du registre, en 0600 ; sans elle, un jeton
// intercepté n'apprend rien sur le numéro.
// =============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');
const logger = require('./logger');

const KEY_FILE = path.join(DATA_DIR, 'keys', 'subject_token.key');

// Chargée paresseusement : `store.DATA_DIR` doit exister au premier appel, ce que
// garantit l'initialisation du serveur (mkdir avant ledger.init()).
let secret = null;

function loadOrCreateSecret() {
  if (secret) return secret;
  if (process.env.SUMO_SUBJECT_SECRET) {
    secret = Buffer.from(String(process.env.SUMO_SUBJECT_SECRET), 'utf8');
    return secret;
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      secret = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
      if (secret.length >= 16) return secret;
    }
  } catch (e) { logger.warn('subjects.key.read.failed', { error: e.message }); }
  secret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, secret.toString('hex'), { mode: 0o600 });
    logger.info('subjects.key.generated', { file: KEY_FILE });
  } catch (e) { logger.warn('subjects.key.persist.failed', { error: e.message }); }
  return secret;
}

const tokenToMsisdn = new Map();
const msisdnToToken = new Map();
// Plafond : l'injection externe accepte des MSISDN de cardinalité illimitée ; sans
// éviction, ces tables grossiraient indéfiniment. Le jeton est déterministe (HMAC
// sous clé stable), donc une entrée évincée se reconstruit à l'identique.
const MAX_SUBJECTS = 50_000;

function token(msisdn) {
  if (!msisdn) return null;
  if (msisdnToToken.has(msisdn)) return msisdnToToken.get(msisdn);
  const t = crypto.createHmac('sha256', loadOrCreateSecret()).update(String(msisdn)).digest('hex').slice(0, 16);
  tokenToMsisdn.set(t, msisdn);
  msisdnToToken.set(msisdn, t);
  if (msisdnToToken.size > MAX_SUBJECTS) {
    const oldest = msisdnToToken.keys().next().value;
    tokenToMsisdn.delete(msisdnToToken.get(oldest));
    msisdnToToken.delete(oldest);
  }
  return t;
}

const resolve = (t) => tokenToMsisdn.get(t) || null;

module.exports = { token, resolve, KEY_FILE };
