'use strict';

// =============================================================================
// Second facteur TOTP (RFC 6238) — sans dépendance externe.
//
// CORRECTIF B3 (volet second facteur) : les profils habilités à la RÉVÉLATION des
// numéros et au traçage des sujets détiennent le pouvoir le plus intrusif de la
// plateforme. Un mot de passe seul, même individuel, ne suffit pas à l'engager :
// il se prête, se note, se rejoue. Ces profils portent donc un second facteur.
//
// Implémentation : HMAC-SHA1 sur un compteur de 30 s, 6 chiffres, tolérance d'un
// pas avant/après (dérive d'horloge). Secret en base32, compatible avec toute
// application d'authentification (otpauth://).
// =============================================================================

const crypto = require('crypto');

const STEP_S = 30;
const DIGITS = 6;
const WINDOW = 1; // ±1 pas
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0; let value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const current = (secretB32, at = Date.now()) => codeAt(secretB32, Math.floor(at / 1000 / STEP_S));

// Comparaison à temps constant sur toute la fenêtre tolérée.
function verify(secretB32, code, at = Date.now()) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(at / 1000 / STEP_S);
  let ok = false;
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const expected = codeAt(secretB32, counter + d);
    const a = Buffer.from(expected); const b = Buffer.from(given);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

// URI d'enrôlement (otpauth://) à présenter en QR code ou à saisir manuellement.
function enrollUri(secretB32, { account, issuer = 'SUMo ARCEP' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

module.exports = { generateSecret, verify, current, enrollUri, base32Encode, base32Decode, STEP_S, DIGITS };
