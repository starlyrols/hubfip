'use strict';

// Implémentation RÉELLE (sous-ensemble) de la norme ISO 8583:1987 — corrige ISO-1.
// Couvre : MTI (4 chiffres), bitmap primaire 64 bits (+ secondaire si champ > 64),
// et un jeu de Data Elements suffisant pour une transaction de paiement.
// Pack -> chaîne ASCII ; Unpack -> objet { mti, fields }.
//
// Justification métier des champs (norme ISO 8583) :
//  DE2  PAN / identifiant compte (LLVAR n..19)
//  DE3  Code de traitement (n6)
//  DE4  Montant de la transaction, en unité mineure (n12)
//  DE7  Date/heure de transmission MMDDhhmmss (n10)
//  DE11 STAN — numéro de trace systématique (n6)
//  DE12 Heure locale hhmmss (n6)
//  DE13 Date locale MMDD (n4)
//  DE32 Identifiant institution acquéreur (LLVAR n..11)
//  DE37 Retrieval Reference Number (an12)
//  DE39 Code réponse (an2)
//  DE41 Identifiant terminal (ans8)
//  DE43 Localisation accepteur (LLVAR ans..40)
//  DE49 Code devise ISO 4217 numérique (n3) — 950 = XAF

const FIELDS = {
  2: { name: 'pan', kind: 'LLVAR', max: 19, num: true },
  3: { name: 'processingCode', kind: 'FIXED', len: 6, num: true },
  4: { name: 'amountMinor', kind: 'FIXED', len: 12, num: true },
  7: { name: 'transmissionDateTime', kind: 'FIXED', len: 10, num: true },
  11: { name: 'stan', kind: 'FIXED', len: 6, num: true },
  12: { name: 'localTime', kind: 'FIXED', len: 6, num: true },
  13: { name: 'localDate', kind: 'FIXED', len: 4, num: true },
  32: { name: 'acquirerId', kind: 'LLVAR', max: 11, num: false },
  37: { name: 'rrn', kind: 'FIXED', len: 12, num: false },
  39: { name: 'responseCode', kind: 'FIXED', len: 2, num: false },
  41: { name: 'terminalId', kind: 'FIXED', len: 8, num: false },
  43: { name: 'cardAcceptorLocation', kind: 'LLVAR', max: 40, num: false },
  49: { name: 'currency', kind: 'FIXED', len: 3, num: true },
};
const NAME_TO_DE = Object.fromEntries(Object.entries(FIELDS).map(([de, f]) => [f.name, Number(de)]));

function pad(value, len, numeric) {
  let s = String(value);
  if (s.length > len) s = s.slice(0, len);
  return numeric ? s.padStart(len, '0') : s.padEnd(len, ' ');
}

// fields : objet indexé par nom (ex. { amountMinor: 150000, currency: '950', ... })
function pack(mti, fields) {
  if (!/^\d{4}$/.test(String(mti))) throw new Error('MTI invalide (4 chiffres attendus)');
  const present = [];
  for (const [name, val] of Object.entries(fields)) {
    if (val === undefined || val === null || val === '') continue;
    const de = NAME_TO_DE[name];
    if (!de) throw new Error(`Champ inconnu: ${name}`);
    present.push(de);
  }
  present.sort((a, b) => a - b);

  const needSecondary = present.some((de) => de > 64);
  const bits = new Uint8Array(needSecondary ? 16 : 8);
  if (needSecondary) bits[0] |= 0x80; // bit 1 = présence bitmap secondaire
  for (const de of present) {
    const idx = de - 1;
    bits[Math.floor(idx / 8)] |= 0x80 >> (idx % 8);
  }
  const bitmapHex = Buffer.from(bits).toString('hex').toUpperCase();

  let data = '';
  for (const de of present) {
    const f = FIELDS[de];
    const raw = fields[f.name];
    if (f.kind === 'FIXED') {
      data += pad(raw, f.len, f.num);
    } else if (f.kind === 'LLVAR') {
      let s = String(raw);
      if (s.length > f.max) s = s.slice(0, f.max);
      data += pad(s.length, 2, true) + s;
    }
  }
  return String(mti) + bitmapHex + data;
}

function unpack(message) {
  if (typeof message !== 'string' || message.length < 4 + 16) {
    throw new Error('Message ISO 8583 trop court');
  }
  let pos = 0;
  const mti = message.slice(pos, pos + 4); pos += 4;
  if (!/^\d{4}$/.test(mti)) throw new Error('MTI invalide');

  // Bitmap primaire (16 hex). Bit 1 -> bitmap secondaire présent.
  const primaryHex = message.slice(pos, pos + 16); pos += 16;
  let bytes = Buffer.from(primaryHex, 'hex');
  if (bytes.length !== 8) throw new Error('Bitmap primaire invalide');
  let totalBits = 64;
  if (bytes[0] & 0x80) {
    const secondaryHex = message.slice(pos, pos + 16); pos += 16;
    const sec = Buffer.from(secondaryHex, 'hex');
    if (sec.length !== 8) throw new Error('Bitmap secondaire invalide');
    bytes = Buffer.concat([bytes, sec]);
    totalBits = 128;
  }

  const fields = {};
  for (let de = 2; de <= totalBits; de++) {
    const idx = de - 1;
    const set = (bytes[Math.floor(idx / 8)] >> (7 - (idx % 8))) & 1;
    if (!set) continue;
    const f = FIELDS[de];
    if (!f) throw new Error(`Champ DE${de} présent mais non supporté`);
    if (f.kind === 'FIXED') {
      const v = message.slice(pos, pos + f.len); pos += f.len;
      fields[f.name] = f.num ? v : v.trimEnd();
    } else if (f.kind === 'LLVAR') {
      const ll = parseInt(message.slice(pos, pos + 2), 10); pos += 2;
      if (Number.isNaN(ll) || ll > f.max) throw new Error(`Longueur LLVAR invalide pour DE${de}`);
      fields[f.name] = message.slice(pos, pos + ll); pos += ll;
    }
  }
  return { mti, fields };
}

module.exports = { FIELDS, NAME_TO_DE, pack, unpack };
