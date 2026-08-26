'use strict';

// =============================================================================
// Cartographie (Leaflet auto-hébergé). Cellules / stations de base + flux live.
//
// CORRECTIF P0 n°8 — FOND DE CARTE SOUVERAIN.
// Les tuiles provenaient auparavant d'un CDN étranger. Or une tuile est une
// requête : chaque déplacement de la carte révélait à ce tiers la zone examinée
// par un enquêteur de la DCTLF — c'est-à-dire, en creux, l'objet de l'enquête.
// Aucune donnée n'était « exfiltrée » au sens strict, et c'est précisément ce qui
// rendait la fuite discrète.
//
// Désormais : aucun fournisseur par défaut. Le fond est dessiné LOCALEMENT
// (graticule + villes du référentiel), ce qui suffit à situer les cellules. Une
// URL de tuiles peut être configurée (SUMO_TILE_URL) pour brancher un serveur
// maîtrisé — l'origine est alors ajoutée à la CSP côté serveur.
// =============================================================================

window.HubMap = (function () {
  let map = null;
  const txMarkers = [];
  let cellLayer = null;
  let baseLayer = null;   // tuiles, seulement si configurées
  let graticule = null;   // fond local
  let cities = [];
  let basemap = { url: null, attribution: '' };

  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const gridColor = () => (theme() === 'light' ? 'rgba(15,23,42,.13)' : 'rgba(255,255,255,.10)');
  const borderColor = () => (theme() === 'light' ? 'rgba(15,23,42,.45)' : 'rgba(229,231,235,.38)');
  const landFill = () => (theme() === 'light' ? 'rgba(5,150,105,.06)' : 'rgba(16,185,129,.05)');
  const labelClass = () => (theme() === 'light' ? 'map-label map-label-light' : 'map-label');
  const countryClass = () => labelClass() + ' map-label-pays';

  // Emprise du territoire national, arrondie au degré.
  const BOUNDS = { latMin: -4, latMax: 3, lngMin: 8, lngMax: 15 };
  // Emprise NAVIGABLE : le territoire plus une marge d'orientation. La carte d'un
  // dispositif national n'a aucune raison de laisser dériver la vue vers un autre
  // hémisphère — la délimiter, c'est aussi délimiter ce que l'écran peut montrer.
  const VIEW_BOUNDS = [[-6.5, 5.2], [4.8, 17.8]]; // le Gabon et son voisinage CEEAC
  // Frontières embarquées (générées par scripts/build-frontieres.js depuis
  // Natural Earth, figées dans le dépôt — aucune requête à l'exécution).
  const FRONTIERES = window.GABON_FRONTIERES || null;
  const SOUS_REGION = window.AFRIQUE_CENTRALE || null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Fond local : frontières nationales simplifiées + réticule d'un degré +
  // repères de villes. Le tracé délimite le territoire ; le réticule donne
  // l'échelle ; les villes donnent l'orientation.
  function drawGraticule() {
    if (!map) return;
    if (graticule) map.removeLayer(graticule);
    graticule = L.layerGroup().addTo(map);
    const style = { color: gridColor(), weight: 1, interactive: false };

    // --- Sous-région d'Afrique centrale (contexte, sous le territoire) ------
    // Trait plus fin et fill plus discret que le Gabon : le voisinage oriente,
    // il ne rivalise pas avec le territoire supervisé.
    if (SOUS_REGION) {
      for (const p of SOUS_REGION.pays) {
        L.polygon(p.polygones, {
          color: gridColor(), weight: 1.1,
          fillColor: gridColor(), fillOpacity: 0.35,
          interactive: false,
        }).addTo(graticule);
        L.marker(p.label, {
          interactive: false,
          icon: L.divIcon({ className: countryClass(), html: esc(p.nom), iconSize: [180, 14], iconAnchor: [90, 7] }),
        }).addTo(graticule);
      }
      // La mer n'a pas de polygone : on la nomme, pour l'orientation.
      L.marker([-2.9, 7.6], {
        interactive: false,
        icon: L.divIcon({ className: countryClass(), html: 'OCÉAN ATLANTIQUE', iconSize: [180, 14], iconAnchor: [90, 7] }),
      }).addTo(graticule);
    }

    // --- Territoire national (au-dessus du voisinage, sous les cellules) ----
    if (FRONTIERES) {
      L.polygon(FRONTIERES.contour, {
        color: borderColor(), weight: 1.8,
        fillColor: landFill(), fillOpacity: 1,
        interactive: false,
      }).addTo(graticule);
    }

    for (let lat = BOUNDS.latMin; lat <= BOUNDS.latMax; lat++) {
      L.polyline([[lat, BOUNDS.lngMin], [lat, BOUNDS.lngMax]], style).addTo(graticule);
    }
    for (let lng = BOUNDS.lngMin; lng <= BOUNDS.lngMax; lng++) {
      L.polyline([[BOUNDS.latMin, lng], [BOUNDS.latMax, lng]], style).addTo(graticule);
    }
    // L'équateur traverse le Gabon : il mérite d'être distingué.
    L.polyline([[0, BOUNDS.lngMin], [0, BOUNDS.lngMax]],
      { color: gridColor(), weight: 1.5, dashArray: '6 5', interactive: false }).addTo(graticule);

    for (const c of cities) {
      L.circleMarker([c.lat, c.lng], {
        radius: 2, color: gridColor(), fillColor: gridColor(), fillOpacity: 1, weight: 0, interactive: false,
      }).addTo(graticule);
      L.marker([c.lat, c.lng], {
        interactive: false,
        icon: L.divIcon({ className: labelClass(), html: esc(c.name), iconSize: [90, 14], iconAnchor: [-6, 7] }),
      }).addTo(graticule);
    }
  }

  function applyBaseLayer() {
    if (!map) return;
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
    if (basemap.url) {
      baseLayer = L.tileLayer(basemap.url, { maxZoom: 19, attribution: basemap.attribution || '' }).addTo(map);
      if (graticule) { map.removeLayer(graticule); graticule = null; }
    } else {
      drawGraticule();
    }
  }

  // `config` provient de l'INIT WebSocket : villes du référentiel + fond éventuel.
  function configure(config) {
    if (!config) return;
    if (Array.isArray(config.cities)) cities = config.cities;
    if (config.basemap) basemap = config.basemap;
    if (map) applyBaseLayer();
  }

  function init() {
    if (map || !window.L) return;
    map = L.map('map', {
      center: [-0.6, 11.5], zoom: 6, zoomControl: true,
      // L'attribution porte la mention réglementaire du fond local ; avec des
      // tuiles configurées, elle porte celle du fournisseur.
      attributionControl: true,
      // Vue DÉLIMITÉE : minZoom cadré sur le pays, panoramique borné (le « mur »
      // est franc : viscosité maximale).
      minZoom: 6, maxBounds: VIEW_BOUNDS, maxBoundsViscosity: 1.0,
    });
    map.attributionControl.setPrefix(false);
    if (!basemap.url && FRONTIERES) map.attributionControl.addAttribution(esc(FRONTIERES.mention));
    applyBaseLayer();
    // Cadrage initial : le territoire, plus une marge suffisante pour que le
    // voisinage de la sous-région (étiquettes comprises) soit visible d'emblée.
    if (!basemap.url && FRONTIERES) map.fitBounds(L.latLngBounds(FRONTIERES.contour).pad(0.22));
    cellLayer = L.layerGroup().addTo(map);
  }

  function applyTheme() {
    if (!map) return;
    if (basemap.url && baseLayer) baseLayer.setUrl(basemap.url);
    else drawGraticule();
  }

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
        .bindPopup(`<div class="map-popup"><b>${esc(c.id)}</b> · ${esc(c.city)}<br>${c.count} transactions<br>${c.anomalies} anomalie(s)<br>type: ${esc(c.siteType)}</div>`);
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
    m.bindPopup(`<div class="map-popup"><b>${esc(tx.operator.name)}</b> · ${esc(tx.type)}<br>${fmt.format(tx.amountXaf)} XAF<br>${esc(tx.cellOrigin.id)} · ${esc(tx.cellOrigin.city)}<br>${flagged ? '⚠ ' + esc((tx.anomaly && tx.anomaly.reason) || 'anomalie') : 'OK'}</div>`);
    txMarkers.push(m);
    if (txMarkers.length > 60) map.removeLayer(txMarkers.shift());
  }

  function clear() { txMarkers.forEach((m) => map && map.removeLayer(m)); txMarkers.length = 0; }
  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 120); }

  return { init, configure, setCells, addTx, clear, invalidate, applyTheme };
})();
