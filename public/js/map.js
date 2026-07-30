'use strict';

// Cartographie (Leaflet auto-hébergé). Cellules/stations de base + transactions live.
window.HubMap = (function () {
  let map = null;
  const txMarkers = [];
  let cellLayer = null;
  let baseLayer = null;

  // Fond de carte assorti au thème (mêmes tuiles carto, style clair/sombre —
  // hôte déjà autorisé par la CSP imgSrc).
  const TILES = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  };
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function init() {
    if (map || !window.L) return;
    map = L.map('map', { center: [-0.6, 11.5], zoom: 6, zoomControl: true, attributionControl: false });
    baseLayer = L.tileLayer(TILES[theme()], { maxZoom: 19 }).addTo(map);
    cellLayer = L.layerGroup().addTo(map);
  }

  function applyTheme() { if (baseLayer) baseLayer.setUrl(TILES[theme()]); }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Dessine les cellules : rayon ∝ activité, rouge si anomalies.
  function setCells(cells) {
    if (!map || !cellLayer) return;
    cellLayer.clearLayers();
    const max = Math.max(1, ...cells.map((c) => c.count));
    cells.forEach((c) => {
      const r = 4 + 10 * Math.sqrt(c.count / max);
      const color = c.anomalies > 0 ? '#ef4444' : '#10b981';
      L.circleMarker([c.lat, c.lng], { radius: r, color, fillColor: color, fillOpacity: 0.25, weight: 1 })
        .addTo(cellLayer)
        .bindPopup(`<div style="font-size:12px"><b>${esc(c.id)}</b> · ${esc(c.city)}<br>${c.count} transactions<br>${c.anomalies} anomalie(s)<br>type: ${esc(c.siteType)}</div>`);
    });
  }

  function addTx(tx) {
    if (!map || !tx.cellOrigin) return;
    const jLat = (Math.random() - 0.5) * 0.03;
    const jLng = (Math.random() - 0.5) * 0.03;
    const flagged = tx.anomaly && tx.anomaly.flagged;
    const color = flagged ? '#ef4444' : '#3b82f6';
    const m = L.circleMarker([tx.cellOrigin.lat + jLat, tx.cellOrigin.lng + jLng], { radius: flagged ? 6 : 3, color, fillColor: color, fillOpacity: 0.85, weight: 1 }).addTo(map);
    const fmt = new Intl.NumberFormat('fr-FR');
    m.bindPopup(`<div style="font-size:12px"><b>${esc(tx.operator.name)}</b> · ${esc(tx.type)}<br>${fmt.format(tx.amountXaf)} XAF<br>${esc(tx.cellOrigin.id)} · ${esc(tx.cellOrigin.city)}<br>${flagged ? '⚠ ' + esc((tx.anomaly && tx.anomaly.reason) || 'anomalie') : 'OK'}</div>`);
    txMarkers.push(m);
    if (txMarkers.length > 60) map.removeLayer(txMarkers.shift());
  }

  function clear() { txMarkers.forEach((m) => map && map.removeLayer(m)); txMarkers.length = 0; }
  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 120); }

  return { init, setCells, addTx, clear, invalidate, applyTheme };
})();
