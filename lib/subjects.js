'use strict';

// =============================================================================
// Jetons de sujet — minimisation des données (loi 001/2011).
// Les alertes / scores exposés au client ne portent JAMAIS le MSISDN en clair,
// mais un jeton opaque (hash tronqué). Seul le serveur peut le résoudre, et la
// révélation effective (traçage) est réservée aux rôles habilités et journalisée.
// =============================================================================

const crypto = require('crypto');

const tokenToMsisdn = new Map();
const msisdnToToken = new Map();

function token(msisdn) {
  if (!msisdn) return null;
  if (msisdnToToken.has(msisdn)) return msisdnToToken.get(msisdn);
  const t = crypto.createHash('sha256').update(String(msisdn)).digest('hex').slice(0, 16);
  tokenToMsisdn.set(t, msisdn);
  msisdnToToken.set(msisdn, t);
  return t;
}

const resolve = (t) => tokenToMsisdn.get(t) || null;

module.exports = { token, resolve };
