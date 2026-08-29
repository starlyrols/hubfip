'use strict';

// =============================================================================
// Test de charge dimensionnant (correctif P2 n°26).
//
// Le cahier vise « des millions de TDR par jour ». Personne ne l'avait vérifié :
// les seuls chiffres disponibles venaient du simulateur, qui produit une
// transaction toutes les 1,5 seconde. Ce harnais injecte du flux RÉEL par le
// connecteur — signature nominative comprise — et mesure ce que la plateforme
// encaisse.
//
// Il mesure aussi, en parallèle, la LATENCE DE LA CONSOLE : un débit d'ingestion
// flatteur obtenu en gelant l'interface de supervision ne vaut rien. C'est
// précisément le défaut qu'avait le constat D1.
//
//   npm run loadtest -- --rate 200 --duration 30
//
// Options : --rate (TDR/s visés) · --duration (s) · --url · --operator
// =============================================================================

const crypto = require('crypto');
const path = require('path');

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const RATE = Number(arg('rate', 100));
const DUREE_S = Number(arg('duration', 20));
const URL = arg('url', 'http://127.0.0.1:3000');
const OPERATOR = arg('operator', 'airtel');

// Identifiants du connecteur : lus dans le magasin local (le harnais tourne sur
// la machine du service, ou avec une copie du répertoire de données).
process.env.SUMO_DATA_DIR = process.env.SUMO_DATA_DIR || path.join(__dirname, '..', 'data');
const connectors = require('../lib/connectors');
const vault = require('../lib/crypto-store');
connectors.load();
const cred = connectors._state().operators[OPERATOR];
if (!cred) { console.error(`Connecteur inconnu : ${OPERATOR}`); process.exit(2); }
const KEY = cred.key;
const SECRET = vault.decryptField(cred.secret);

const percentile = (tri, p) => (tri.length ? tri[Math.min(tri.length - 1, Math.floor(p * tri.length))] : 0);

function enveloppe(i) {
  return JSON.stringify({
    operatorId: OPERATOR,
    record: {
      transaction_id: `LOAD-${process.pid}-${i}`,
      timestamp: new Date().toISOString(),
      transaction_type: 'P2P',
      amount: 1000 + (i % 500_000),
      currency: 'XAF',
      fee_amount: 200 + (i % 50),
      tax_amount: 36,
      status: 'SUCCESS',
      channel: 'USSD',
      sender_msisdn: `+2410741${String(i % 100000).padStart(5, '0')}`,
      receiver_msisdn: `+2410662${String((i * 7) % 100000).padStart(5, '0')}`,
      latency_ms: 600 + (i % 400),
      city: 'Libreville',
    },
  });
}

function entetes(corps) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${nonce}.`).update(corps).digest('hex');
  return {
    'content-type': 'application/json',
    'x-sumo-key': KEY,
    'x-sumo-signature': sig,
    'x-sumo-timestamp': String(ts),
    'x-sumo-nonce': nonce,
  };
}

const latences = [];
const consoleLatences = [];
const codes = new Map();
let envoyes = 0; let acceptes = 0;
const noter = (c) => codes.set(c, (codes.get(c) || 0) + 1);

async function injecter(i) {
  const corps = enveloppe(i);
  const t0 = process.hrtime.bigint();
  try {
    const r = await fetch(URL + '/api/v1/iso8583', { method: 'POST', headers: entetes(corps), body: corps });
    latences.push(Number(process.hrtime.bigint() - t0) / 1e6);
    noter(r.status);
    if (r.status === 202) acceptes++;
  } catch (e) {
    latences.push(Number(process.hrtime.bigint() - t0) / 1e6);
    noter(`ERR:${e.code || e.message}`);
  }
}

// Sonde de réactivité de la console, en parallèle de l'injection.
async function sonderConsole() {
  const t0 = process.hrtime.bigint();
  try { await fetch(URL + '/healthz'); } catch { /* comptabilisé par la latence */ }
  consoleLatences.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

async function main() {
  console.log('Test de charge SUMo');
  console.log(`  Cible      : ${URL}`);
  console.log(`  Assujetti  : ${OPERATOR} (clé ${KEY})`);
  console.log(`  Débit visé : ${RATE} TDR/s pendant ${DUREE_S} s\n`);

  const intervalMs = 1000 / RATE;
  const debut = Date.now();
  const fin = debut + DUREE_S * 1000;
  const enVol = new Set();

  const sondeTimer = setInterval(sonderConsole, 250);

  while (Date.now() < fin) {
    const prochain = Date.now() + intervalMs;
    const p = injecter(envoyes++);
    enVol.add(p);
    p.finally(() => enVol.delete(p));
    // Contre-pression du harnais : au-delà, c'est le client qui sature, pas le
    // serveur — et la mesure ne voudrait plus rien dire.
    if (enVol.size > 500) await Promise.race(enVol);
    const reste = prochain - Date.now();
    if (reste > 0) await new Promise((r) => setTimeout(r, reste));
  }
  await Promise.allSettled([...enVol]);
  clearInterval(sondeTimer);

  const ecoule = (Date.now() - debut) / 1000;
  const tri = latences.slice().sort((a, b) => a - b);
  const triC = consoleLatences.slice().sort((a, b) => a - b);
  const debit = acceptes / ecoule;

  console.log('Résultats');
  console.log(`  Durée réelle       : ${ecoule.toFixed(1)} s`);
  console.log(`  Envoyés / acceptés : ${envoyes} / ${acceptes}`);
  console.log(`  Débit soutenu      : ${debit.toFixed(1)} TDR/s  →  ${Math.round(debit * 86400).toLocaleString('fr-FR')} TDR/jour`);
  console.log(`  Latence ingestion  : p50 ${percentile(tri, 0.5).toFixed(1)} ms · p95 ${percentile(tri, 0.95).toFixed(1)} ms · p99 ${percentile(tri, 0.99).toFixed(1)} ms`);
  console.log(`  Latence console    : p50 ${percentile(triC, 0.5).toFixed(1)} ms · p95 ${percentile(triC, 0.95).toFixed(1)} ms · max ${(triC[triC.length - 1] || 0).toFixed(1)} ms`);
  console.log(`  Réponses           : ${[...codes.entries()].map(([c, n]) => `${c}×${n}`).join(' · ')}`);

  console.log('\nLecture');
  const consoleMax = triC[triC.length - 1] || 0;
  if (consoleMax > 1000) console.log(`  ⚠ La console a atteint ${consoleMax.toFixed(0)} ms sous charge : un traitement bloque le fil principal.`);
  else console.log(`  ✓ La console est restée réactive (max ${consoleMax.toFixed(0)} ms) : l'ingestion ne gèle pas la supervision.`);
  if (acceptes < envoyes * 0.99) console.log(`  ⚠ ${envoyes - acceptes} déclarations non acceptées — vérifiez les codes ci-dessus (quota, rejeu, contrat).`);
  console.log(`  Dimensionnement    : ce nœud tient ~${Math.round(debit * 86400 / 1e6 * 10) / 10} million(s) de TDR/jour.`);
  console.log('  Au-delà, la trajectoire du cahier (§4) s\'applique : ingestion Kafka, entrepôt ClickHouse,');
  console.log('  registre en service d\'écriture dédié — voir docs/TRAJECTOIRE-P2.md.');
}

main().catch((e) => { console.error(e); process.exit(1); });
