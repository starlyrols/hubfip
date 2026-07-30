'use strict';

// =============================================================================
// Module 9 — Géolocalisation (cahier §2 #9).
// Corrélation cellule / station de base ↔ transaction, cartographie d'activité,
// et détection d'anomalies géographiques (déplacement IMPOSSIBLE : même MSISDN
// vu dans deux cellules distantes en un temps incompatible avec un déplacement
// physique → SIM-box, fraude d'identité). Seuil de vitesse configurable.
// =============================================================================

const ref = require('./referentiel');
const config = require('./config');
const subjects = require('./subjects');

// Dernière position connue par MSISDN : { cellId, lat, lng, epoch, city }.
// Plafonné (éviction LRU) — cardinalité illimitée possible via l'injection externe.
const lastSeen = new Map();
const MAX_TRACKED = 50_000;
// Activité par cellule : cellId -> { count, sumXaf, anomalies }.
const cellActivity = new Map();
const recentGeo = [];
const GEO_MAX = 200;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180; const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bump(cellId, amountXaf, anomaly) {
  if (!cellActivity.has(cellId)) cellActivity.set(cellId, { count: 0, sumXaf: 0, anomalies: 0 });
  const e = cellActivity.get(cellId);
  e.count++; e.sumXaf += amountXaf; if (anomaly) e.anomalies++;
}

// Évalue un TDR → alerte géo éventuelle (déplacement impossible) | null.
function evaluate(tdr) {
  const r = config.getRules();
  const cell = tdr.cellOrigin;
  let alert = null;

  const msisdn = tdr.sender.msisdn;
  if (msisdn) {
    const prev = lastSeen.get(msisdn);
    if (prev && prev.cellId !== cell.id) {
      const km = haversineKm(prev, cell);
      const hours = Math.max(1 / 3600, (tdr.epoch - prev.epoch) / 3_600_000);
      const speed = km / hours;
      if (km > 25 && speed > r.impossibleTravelKmH) {
        alert = {
          ruleId: 'IMPOSSIBLE_TRAVEL',
          label: 'Déplacement géographique impossible',
          severity: 'ELEVEE',
          detail: `${Math.round(km)} km en ${(hours * 60).toFixed(1)} min (${Math.round(speed)} km/h) — ${prev.city} → ${cell.city}`,
        };
      }
    }
    lastSeen.delete(msisdn); // réinsertion → l'ordre du Map reflète la récence
    lastSeen.set(msisdn, { cellId: cell.id, lat: cell.lat, lng: cell.lng, epoch: tdr.epoch, city: cell.city });
    if (lastSeen.size > MAX_TRACKED) lastSeen.delete(lastSeen.keys().next().value);
  }

  bump(cell.id, tdr.amountXaf, !!alert);
  if (alert) {
    recentGeo.push({ tdrId: tdr.id, epoch: tdr.epoch, operatorId: tdr.operator.id, msisdnMasked: ref.maskMsisdn(msisdn), subjectToken: subjects.token(msisdn), detail: alert.detail });
    if (recentGeo.length > GEO_MAX) recentGeo.shift();
  }
  return alert;
}

// Données cartographiques : cellules + activité (pour la heatmap).
function cells() {
  return ref.CELLS.map((c) => {
    const a = cellActivity.get(c.id) || { count: 0, sumXaf: 0, anomalies: 0 };
    return { ...c, count: a.count, sumXaf: a.sumXaf, anomalies: a.anomalies };
  });
}

function stats() {
  const active = [...cellActivity.values()].filter((e) => e.count > 0).length;
  return { totalCells: ref.CELLS.length, activeCells: active, anomalies: recentGeo.length, trackedMsisdn: lastSeen.size };
}

const recent = (limit = 50) => recentGeo.slice(-limit).reverse();

module.exports = { evaluate, cells, stats, recent, haversineKm };
