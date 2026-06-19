'use strict';

// Cartographie (Leaflet auto-hébergé). Exposé en global pour app.js.
window.HubMap = (function () {
  let map = null;
  let markers = [];
  let tracked = 0;
  let anomalies = 0;

  function init(cities) {
    if (map) return;
    map = L.map('map', { center: [-0.8, 11.6], zoom: 6, zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    cities.forEach((c) => {
      L.circleMarker([c.lat, c.lng], { radius: 3, color: '#4b5563', fillColor: '#1f2937', fillOpacity: 0.6 })
        .addTo(map).bindTooltip(c.name, { direction: 'top' });
    });
  }

  function addMarker(tx, filters) {
    if (!map) return;
    if (filters.op !== 'all' && tx.operator.id !== filters.op) return;
    if (filters.type !== 'all' && tx.operator.type !== filters.type) return;
    if (filters.anomaliesOnly && !tx.anomaly.flagged) return;

    const jLat = (Math.random() - 0.5) * 0.04;
    const jLng = (Math.random() - 0.5) * 0.04;
    const color = tx.anomaly.flagged ? '#ef4444' : '#3b82f6';
    const m = L.circleMarker([tx.location.lat + jLat, tx.location.lng + jLng], {
      radius: tx.anomaly.flagged ? 6 : 4, color, fillColor: tx.anomaly.flagged ? '#ef4444' : '#10b981', fillOpacity: 0.8, weight: 1,
    }).addTo(map);
    const fmt = new Intl.NumberFormat('fr-FR');
    m.bindPopup(`<div style="font-size:12px"><b>${escapeHtml(tx.operator.name)}</b><br>${fmt.format(tx.amount)} XAF<br>${tx.anomaly.flagged ? 'Rejet' : 'Validé'}</div>`);
    markers.push(m);
    if (markers.length > 80) map.removeLayer(markers.shift());

    tracked += 1;
    if (tx.anomaly.flagged) anomalies += 1;
    const el = document.getElementById('gps-stats');
    if (el) el.textContent = `Transactions géolocalisées : ${tracked} | Anomalies : ${anomalies}`;
  }

  function clear() {
    markers.forEach((m) => map && map.removeLayer(m));
    markers = []; tracked = 0; anomalies = 0;
    const el = document.getElementById('gps-stats');
    if (el) el.textContent = 'Transactions géolocalisées : 0 | Anomalies : 0';
  }

  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 120); }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return { init, addMarker, clear, invalidate };
})();
