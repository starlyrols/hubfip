'use strict';

// =============================================================================
// Module 10 — Analytics avancés (cahier §2 #10).
// Détection d'anomalies par apprentissage en ligne (statistique) et scoring de
// risque. HONNÊTETÉ : il s'agit de méthodes STATISTIQUES (z-score sur l'historique
// personnel via Welford, agrégation pondérée de signaux), PAS d'un modèle d'apprentissage
// profond. C'est le socle « détection par apprentissage » à enrichir (scikit-learn,
// isolation forest…) lorsqu'un jeu de données réel et étiqueté sera disponible.
// =============================================================================

const ref = require('./referentiel');
const subjects = require('./subjects');

// Statistiques en ligne par MSISDN (Welford : moyenne + variance incrémentales).
// Plafonné (éviction LRU) : l'injection externe peut porter des MSISDN de
// cardinalité illimitée, et le processus tourne indéfiniment.
const profile = new Map(); // msisdn -> { n, mean, M2 }
const MAX_PROFILES = 50_000;
// Score de risque max observé par abonné (pour le top-risque de l'onglet Analytics).
// Plafonné : au-delà, l'entrée au score le plus faible est écartée.
const riskBoard = new Map(); // msisdn -> { msisdnMasked, operatorId, score, reasons, epoch }
const MAX_BOARD = 500;

function updateProfile(msisdn, x) {
  let p = profile.get(msisdn);
  if (p) profile.delete(msisdn); // réinsertion → l'ordre du Map reflète la récence
  else {
    p = { n: 0, mean: 0, M2: 0 };
    if (profile.size >= MAX_PROFILES) profile.delete(profile.keys().next().value);
  }
  profile.set(msisdn, p);
  p.n++;
  const d = x - p.mean; p.mean += d / p.n;
  p.M2 += d * (x - p.mean);
  return p;
}

function zScore(p, x) {
  if (!p || p.n < 8) return 0;
  const variance = p.M2 / (p.n - 1);
  const std = Math.sqrt(variance);
  if (std < 1) return 0;
  return (x - p.mean) / std;
}

const LEVELS = (s) => (s >= 80 ? 'CRITIQUE' : s >= 60 ? 'ELEVE' : s >= 30 ? 'MODERE' : 'FAIBLE');

// Calcule le risque d'un TDR à partir des alertes (règles + géo) et de l'historique.
function evaluate(tdr, alerts = []) {
  const msisdn = tdr.sender.msisdn;
  const z = zScore(profile.get(msisdn), tdr.amountXaf);
  updateProfile(msisdn, tdr.amountXaf);

  let score = 5;
  const reasons = [];
  const high = alerts.filter((a) => a.severity === 'ELEVEE').length;
  const other = alerts.length - high;
  if (high) { score += 22 + (high - 1) * 8; reasons.push(`${high} alerte(s) de gravité élevée`); }
  if (other) { score += 10 * other; reasons.push(`${other} alerte(s) de gravité moyenne`); }
  if (Math.abs(z) >= 3) { score += 18; reasons.push(`Montant atypique (z=${z.toFixed(1)}) vs historique`); }
  else if (Math.abs(z) >= 2) { score += 9; reasons.push(`Montant inhabituel (z=${z.toFixed(1)})`); }
  if (['NON_VERIFIE', 'INCONNU'].includes(tdr.sender.kyc)) { score += 10; reasons.push(`KYC faible (${tdr.sender.kyc})`); }
  if (tdr.crossBorder) { score += 8; reasons.push('Transfert transfrontalier'); }
  if (tdr.status === 'FAILED') { score += 4; reasons.push('Transaction échouée'); }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const risk = { score, level: LEVELS(score), reasons, z: +z.toFixed(2) };

  if (msisdn && score >= 30) {
    const prev = riskBoard.get(msisdn);
    if (!prev || score >= prev.score) {
      riskBoard.set(msisdn, { msisdnMasked: ref.maskMsisdn(msisdn), subjectToken: subjects.token(msisdn), operatorId: tdr.operator.id, score, level: risk.level, reasons, epoch: tdr.epoch });
      if (riskBoard.size > MAX_BOARD) {
        let worstKey = null; let worst = Infinity;
        for (const [k, v] of riskBoard) if (v.score < worst) { worst = v.score; worstKey = k; }
        riskBoard.delete(worstKey);
      }
    }
  }
  return risk;
}

// Top abonnés à risque (pour l'onglet Analytics / Risque).
function topRisky(limit = 20) {
  return [...riskBoard.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function stats() {
  const scored = riskBoard.size;
  const critique = [...riskBoard.values()].filter((r) => r.level === 'CRITIQUE').length;
  const eleve = [...riskBoard.values()].filter((r) => r.level === 'ELEVE').length;
  return { profiledMsisdn: profile.size, flagged: scored, critique, eleve };
}

module.exports = { evaluate, topRisky, stats };
