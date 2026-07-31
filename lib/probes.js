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
// réduit à l'échelle du prototype), scelle chaque mesure au journal probant.
function runCampaign({ perCell = 2 } = {}) {
  const t0 = Date.now();
  let n = 0;
  const sampleProvinces = PROVINCES.slice().sort(() => Math.random() - 0.5).slice(0, 4);
  for (const op of ref.OPERATORS) {
    for (const canal of PROBE_CHANNELS) {
      for (const province of sampleProvinces) {
        const vias = (canal === 'USSD' || canal === 'API') ? ['WALLET', 'PSP'] : ['WALLET'];
        for (const via of vias) {
          for (let i = 0; i < perCell; i++) {
            const m = measureOnce(op, canal, province, via);
            measures.push(m);
            if (measures.length > MAX_MEASURES) measures.shift();
            journal.append({ kind: 'MESURE_N3', ...m });
            n++;
          }
        }
      }
    }
  }
  campaigns++;
  lastCampaign = { at: t0, measurements: n, provinces: sampleProvinces, durationMs: Date.now() - t0 };
  logger.info('probes.campaign', { measurements: n, provinces: sampleProvinces.length });
  evaluateGaps();
  return lastCampaign;
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
      const key = `${op.id}|DISPONIBILITE`; const keyT = `${op.id}|TARIF_CONSTATE`;
      return {
        operatorId: op.id, name: op.name, color: op.color,
        measured: { flag: 'MESURE', ...meas, ussdSuccessRate: ussd.successRate },
        declared: { flag: 'DECLARE', ...decl },
        ecartDispoPts: ecartPts,
        verdict: (ecartPts != null && ecartPts >= SEUIL_DISPO_PTS) || feeGaps >= 3 ? 'ECART' : 'CONFORME',
        tarifConstats: mine.filter((m) => m.success).length,
        tarifEcarts: feeGaps,
        contradictoireId: openContradictoires.get(key) || openContradictoires.get(keyT) || null,
      };
    });

  const byChannel = PROBE_CHANNELS.map((canal) => ({ canal, flag: 'MESURE', ...agg(wallet.filter((m) => m.canal === canal)) }));
  const byProvince = PROVINCES.map((p) => ({ province: p, ...agg(wallet.filter((m) => m.province === p)) })).filter((r) => r.total > 0);

  return {
    flags: { DECLARE: 'Valeur transmise par l\'assujetti', CONTROLE: 'Recalculée par la plateforme depuis les TDR', MESURE: 'Constatée par sonde indépendante (journal probant signé)' },
    campaign: { count: campaigns, last: lastCampaign, retained: measures.length },
    journal: { ...journal.stats(), integrity: journal.verifyChain({ limit: 500 }) },
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

module.exports = { init, runCampaign, report, channelComparison, comparisonByOperator, size, journal, PROBE_CHANNELS, PROVINCES };
