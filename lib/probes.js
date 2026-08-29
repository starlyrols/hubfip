'use strict';

// =============================================================================
// Module M14/N3 — Mesure indépendante (sondes transactionnelles simulées).
// Référentiel fonctionnel : « vérification indépendante » (RX-MFS), retenue et
// renforcée par le cadre M14 (L3) : des sondes exécutent des transactions de
// test par canal et par province, journalisées dans une CHAÎNE PROBANTE signée
// (même mécanique que le registre TDR), puis comparées aux valeurs DÉCLARÉES
// par les opérateurs. Principe directeur (L10) : la mesure prime sur le
// déclaratif ; tout écart au-delà du seuil ouvre une procédure CONTRADICTOIRE
// (dossier tracé, module Investigation). Chaque valeur exposée porte son
// DRAPEAU DE CONFIANCE : DECLARE / CONTROLE / MESURE.
// PROTOTYPE : les mesures et les déclarations opérateurs sont simulées.
// =============================================================================

const crypto = require('crypto');
const fs = require('fs');
const ref = require('./referentiel');
const config = require('./config');
const model = require('./model');
const ledger = require('./ledger');
const cases = require('./cases');
const qosMod = require('./qos');
const logger = require('./logger');

// Canaux sondés (l'API de gros s'ajoute aux canaux grand public pour AT-04).
const PROBE_CHANNELS = ['USSD', 'STK', 'APP', 'API'];
const PROVINCES = [...new Set(ref.CITIES.map((c) => c.province))];
const SCENARIOS = ['P2P', 'CASHOUT', 'MERCHANT'];

// Seuils d'écart (L10.2) — au-delà : procédure contradictoire.
const SEUIL_DISPO_PTS = 0.01;      // 1 point de disponibilité
const SEUIL_P95_PCT = 0.20;        // +20 % sur la latence p95
const SEUIL_AT04_PTS = 0.02;       // AT-04 : 2 points wallet vs PSP

// Biais simulés par index d'opérateur (démo) : le 2e opérateur sur-déclare sa
// disponibilité USSD (~2,5 pts), le 3e applique une surfacturation de 100 XAF
// sur les frais P2P constatés (CT-02, tolérance zéro).
const BIAS_DISPO_OP_INDEX = 1;
const BIAS_FEE_OP_INDEX = 2;
const BIAS_PSP_OP_INDEX = 1; // le même opérateur dégrade le canal des PSP tiers (AT-04)

// Journal probant N3 : chaîne signée dédiée (clés distinctes du registre TDR).
const journal = ledger.createChain({ name: 'probes', file: 'probes-ledger.jsonl', privName: 'probes_private.pem', pubName: 'probes_public.pem' });

const MAX_MEASURES = 4000;
const measures = []; // fenêtre récente en mémoire (le journal fait foi)
let lastCampaign = null;
let campaigns = 0;
// Dossiers contradictoires ouverts par (opérateur, type d'écart) — dédup.
const openContradictoires = new Map();
// L'onglet Mesures interroge le rapport toutes les 4 s : la vérification de la
// chaîne probante (relecture + N vérifications de signature) est bornée ET mise
// en cache, sinon chaque poll bloquerait l'event loop. Même parti pris que
// l'instantané d'intégrité du module Sécurité. Le contrôle exhaustif reste
// disponible à la demande via /api/v1/probes/journal/verify.
const INTEGRITY_TTL_MS = 30_000;
let integrityCache = { at: 0, value: null };

const CHANNEL_BASE = { USSD: { ok: 0.965, lat: 900 }, STK: { ok: 0.955, lat: 1200 }, APP: { ok: 0.985, lat: 600 }, API: { ok: 0.99, lat: 350 } };

function opIndex(operatorId) { return ref.OPERATORS.findIndex((o) => o.id === operatorId); }

// Une transaction de test : résultat mesuré (succès, latence, frais constatés).
function measureOnce(op, canal, province, via) {
  const base = CHANNEL_BASE[canal];
  let okRate = base.ok - (opIndex(op.id) === BIAS_DISPO_OP_INDEX && canal === 'USSD' ? 0.03 : 0.004 * opIndex(op.id));
  if (via === 'PSP') okRate -= (opIndex(op.id) === BIAS_PSP_OP_INDEX ? 0.035 : 0.008);
  const success = Math.random() < okRate;
  const latencyMs = Math.round((base.lat + Math.random() * base.lat) * (success ? 1 : 4) * (via === 'PSP' && opIndex(op.id) === BIAS_PSP_OP_INDEX ? 1.35 : 1));
  const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const amountXaf = 1000 + Math.floor(Math.random() * 199000);
  const feeExpected = model.computeFee(scenario, amountXaf, config.getFees());
  const feeCharged = success
    ? feeExpected + (opIndex(op.id) === BIAS_FEE_OP_INDEX && scenario === 'P2P' ? 100 : 0)
    : 0;
  return {
    id: crypto.randomUUID(), epoch: Date.now(),
    operatorId: op.id, canal, province, via, scenario,
    amountXaf, feeExpected, feeCharged, success, latencyMs,
  };
}

// Une campagne : échantillonne opérateurs × canaux × provinces (plan L3.2
// réduit à l'échelle du prototype), scelle la campagne au journal probant.
//
// CORRECTIF P1 n°17 — COMPACTION. Chaque mesure était auparavant signée et
// écrite séparément : 144 signatures ECDSA et 144 écritures synchrones toutes
// les 90 secondes, soit 152 Mo en dix jours. L'unité probante n'est pourtant pas
// la mesure isolée mais la CAMPAGNE : elle est désormais scellée d'un seul bloc.
// Le contenu — donc la valeur de preuve — est identique ; le coût est divisé par
// le nombre de mesures.
function runCampaign({ perCell = 2 } = {}) {
  const t0 = Date.now();
  const sampleProvinces = PROVINCES.slice().sort(() => Math.random() - 0.5).slice(0, 4);
  const lot = [];
  for (const op of ref.OPERATORS) {
    for (const canal of PROBE_CHANNELS) {
      for (const province of sampleProvinces) {
        const vias = (canal === 'USSD' || canal === 'API') ? ['WALLET', 'PSP'] : ['WALLET'];
        for (const via of vias) {
          for (let i = 0; i < perCell; i++) {
            const m = measureOnce(op, canal, province, via);
            measures.push(m);
            if (measures.length > MAX_MEASURES) measures.shift();
            lot.push(m);
          }
        }
      }
    }
  }
  campaigns++;
  // Une seule signature, une seule écriture, pour toute la campagne.
  journal.append({
    kind: 'CAMPAGNE_N3',
    campagne: campaigns,
    debut: new Date(t0).toISOString(),
    provinces: sampleProvinces,
    mesures: lot,
  });
  rotateIfNeeded();
  integrityCache = { at: 0, value: null }; // la chaîne vient de s'allonger : l'intégrité en cache est périmée
  lastCampaign = { at: t0, measurements: lot.length, provinces: sampleProvinces, durationMs: Date.now() - t0 };
  logger.info('probes.campaign', { measurements: lot.length, provinces: sampleProvinces.length, ms: Date.now() - t0 });
  evaluateGaps();
  return lastCampaign;
}

// --- Rotation du journal probant (correctif P1 n°17) ------------------------
// Un journal qui grossit sans fin rend toute vérification intégrale impraticable
// — et une preuve qu'on ne peut plus vérifier n'en est plus une. Au-delà du
// seuil, le fichier est ARCHIVÉ tel quel (il reste vérifiable de son côté) et un
// reçu d'ancrage fige sa racine avant de repartir sur un fichier neuf.
const ROTATE_BYTES = Number(process.env.SUMO_PROBES_ROTATE_BYTES) || 256 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(journal.file)) return null;
    if (fs.statSync(journal.file).size < ROTATE_BYTES) return null;

    // La racine est ancrée AVANT rotation : c'est elle qui atteste de l'archive.
    let recu = null;
    try { recu = require('./anchor').emit(journal, { note: 'ancrage de rotation du journal probant N3' }); } catch { /* best effort */ }

    const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = journal.file.replace(/\.jsonl$/, '') + `-${horodatage}.jsonl`;
    journal.close();
    fs.renameSync(journal.file, archive);
    journal.init();  // repart d'un fichier neuf
    logger.warn('probes.journal.rotated', { archive, ancre: recu ? recu.seq : null });
    return { archive, recu };
  } catch (e) {
    logger.error('probes.journal.rotate.failed', { error: e.message });
    return null;
  }
}

function agg(list) {
  const total = list.length;
  const ok = list.filter((m) => m.success).length;
  const lats = list.map((m) => m.latencyMs).sort((a, b) => a - b);
  return {
    total, successRate: total ? +(ok / total).toFixed(4) : null,
    avgLatencyMs: total ? Math.round(lats.reduce((s, x) => s + x, 0) / total) : null,
    p95LatencyMs: total ? qosMod.percentile(lats, 0.95) : null,
  };
}

// Déclarations opérateurs simulées : la réalité du flux TDR + un biais
// « optimiste » pour l'opérateur qui sur-déclare (drapeau DECLARE).
function declaredFor(op, canal) {
  const base = CHANNEL_BASE[canal];
  const optimism = opIndex(op.id) === BIAS_DISPO_OP_INDEX && canal === 'USSD' ? 0.028 : 0.002;
  return {
    successRate: +Math.min(0.999, base.ok - 0.004 * opIndex(op.id) + optimism).toFixed(4),
    p95LatencyMs: Math.round(base.lat * 1.6),
  };
}

// Ouvre (ou réutilise) un dossier contradictoire pour un écart donné (L3.5).
function openContradictoire(operatorId, type, detail) {
  const key = `${operatorId}|${type}`;
  const existing = openContradictoires.get(key);
  if (existing) {
    const c = cases.get(existing);
    if (c && c.status !== 'CLOS') return existing;
  }
  const op = ref.byId.get(operatorId) || { name: operatorId };
  const c = cases.create({
    title: `CONTRADICTOIRE — ${type} — ${op.name}`,
    severity: 'ELEVEE',
    createdBy: 'sonde-n3',
    fromAlert: { ruleId: `N3_${type}`, detail },
  });
  openContradictoires.set(key, c.id);
  logger.warn('probes.contradictoire.ouvert', { caseId: c.id, operatorId, type });
  return c.id;
}

// Compare mesuré vs déclaré et frais constatés vs grille ; ouvre les
// contradictoires au-delà des seuils. Appelé en fin de campagne.
function evaluateGaps() {
  for (const op of ref.OPERATORS) {
    const mine = measures.filter((m) => m.operatorId === op.id && m.via === 'WALLET');
    if (mine.length < 30) continue; // plancher d'opposabilité (L8.2 / L3.2)
    const meas = agg(mine.filter((m) => m.canal === 'USSD'));
    const decl = declaredFor(op, 'USSD');
    if (meas.successRate != null && decl.successRate - meas.successRate >= SEUIL_DISPO_PTS) {
      openContradictoire(op.id, 'DISPONIBILITE', `USSD : déclaré ${(decl.successRate * 100).toFixed(1)} % vs mesuré ${(meas.successRate * 100).toFixed(1)} % (${mine.length} mesures)`);
    }
    if (meas.p95LatencyMs != null && meas.p95LatencyMs > decl.p95LatencyMs * (1 + SEUIL_P95_PCT)) {
      openContradictoire(op.id, 'LATENCE_P95', `USSD : p95 mesuré ${meas.p95LatencyMs} ms vs déclaré ${decl.p95LatencyMs} ms`);
    }
    const feeGaps = mine.filter((m) => m.success && m.feeCharged !== m.feeExpected);
    if (feeGaps.length >= 3) { // tolérance zéro sur le principe, plancher anti-bruit sur le prototype
      const g = feeGaps[feeGaps.length - 1];
      openContradictoire(op.id, 'TARIF_CONSTATE', `${feeGaps.length} constats ≠ grille déposée (ex. ${g.scenario} ${g.amountXaf} XAF : constaté ${g.feeCharged}, attendu ${g.feeExpected})`);
    }
  }
}

function journalIntegrity() {
  if (!integrityCache.value || Date.now() - integrityCache.at > INTEGRITY_TTL_MS) {
    integrityCache = { at: Date.now(), value: journal.verifyChain({ limit: 500 }) };
  }
  return integrityCache.value;
}

// Un dossier clos ne doit plus être présenté comme la procédure en cours : la
// clé reste dans la table (déduplication) mais le rapport ne l'expose plus.
function openCaseId(key) {
  const id = openContradictoires.get(key);
  if (!id) return null;
  const c = cases.get(id);
  return c && c.status !== 'CLOS' ? id : null;
}

// Rapport N3 — chaque bloc porte son drapeau de confiance.
function report(opts = {}) {
  const scoped = (list) => (opts.operatorId ? list.filter((m) => m.operatorId === opts.operatorId) : list);
  const wallet = scoped(measures).filter((m) => m.via === 'WALLET');

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const mine = wallet.filter((m) => m.operatorId === op.id);
      const meas = agg(mine);
      const decl = declaredFor(op, 'USSD');
      const ussd = agg(mine.filter((m) => m.canal === 'USSD'));
      const ecartPts = (ussd.successRate != null) ? +(decl.successRate - ussd.successRate).toFixed(4) : null;
      const feeGaps = mine.filter((m) => m.success && m.feeCharged !== m.feeExpected).length;
      return {
        operatorId: op.id, name: op.name, color: op.color,
        measured: { flag: 'MESURE', ...meas, ussdSuccessRate: ussd.successRate },
        declared: { flag: 'DECLARE', ...decl },
        ecartDispoPts: ecartPts,
        verdict: (ecartPts != null && ecartPts >= SEUIL_DISPO_PTS) || feeGaps >= 3 ? 'ECART' : 'CONFORME',
        tarifConstats: mine.filter((m) => m.success).length,
        tarifEcarts: feeGaps,
        contradictoireId: openCaseId(`${op.id}|DISPONIBILITE`) || openCaseId(`${op.id}|TARIF_CONSTATE`),
      };
    });

  const byChannel = PROBE_CHANNELS.map((canal) => ({ canal, flag: 'MESURE', ...agg(wallet.filter((m) => m.canal === canal)) }));
  const byProvince = PROVINCES.map((p) => ({ province: p, ...agg(wallet.filter((m) => m.province === p)) })).filter((r) => r.total > 0);

  return {
    flags: { DECLARE: 'Valeur transmise par l\'assujetti', CONTROLE: 'Recalculée par la plateforme depuis les TDR', MESURE: 'Constatée par sonde indépendante (journal probant signé)' },
    // « retained » suit le périmètre du demandeur, comme le reste du rapport.
    campaign: { count: campaigns, last: lastCampaign, retained: scoped(measures).length },
    journal: { ...journal.stats(), integrity: journalIntegrity() },
    seuils: { dispoPts: SEUIL_DISPO_PTS, p95Pct: SEUIL_P95_PCT, at04Pts: SEUIL_AT04_PTS },
    byOperator, byChannel, byProvince,
    contradictoires: [...openContradictoires.entries()]
      .filter(([k]) => !opts.operatorId || k.startsWith(`${opts.operatorId}|`))
      .map(([k, caseId]) => {
        const c = cases.get(caseId);
        return c ? { caseId, key: k, title: c.title, status: c.status, createdAt: c.createdAt } : null;
      }).filter(Boolean),
  };
}

// AT-04 — qualité du canal offerte aux PSP tiers vs wallet maison (par canal
// mutualisé), mesurée dans les mêmes cellules (L8.2). Consommé par thirdparty.
function channelComparison(opts = {}) {
  const scoped = opts.operatorId ? measures.filter((m) => m.operatorId === opts.operatorId) : measures;
  return ['USSD', 'API'].map((canal) => {
    const wallet = agg(scoped.filter((m) => m.canal === canal && m.via === 'WALLET'));
    const psp = agg(scoped.filter((m) => m.canal === canal && m.via === 'PSP'));
    const ecartPts = (wallet.successRate != null && psp.successRate != null) ? +(wallet.successRate - psp.successRate).toFixed(4) : null;
    return {
      canal, flag: 'MESURE', wallet, psp, ecartPts,
      discrimination: ecartPts != null && ecartPts >= SEUIL_AT04_PTS,
    };
  });
}

// Comparaisons AT-04 par opérateur hôte (pour le drill-down du volet tiers).
function comparisonByOperator() {
  return ref.OPERATORS.map((op) => ({
    operatorId: op.id, name: op.name, color: op.color,
    canaux: channelComparison({ operatorId: op.id }),
  }));
}

function init() { journal.init(); return module.exports; }

const size = () => measures.length;

const close = () => journal.close();

module.exports = { init, close, runCampaign, rotateIfNeeded, ROTATE_BYTES, report, channelComparison, comparisonByOperator, size, journal, PROBE_CHANNELS, PROVINCES };
