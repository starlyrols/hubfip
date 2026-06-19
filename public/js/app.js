'use strict';

// Client de supervision HuBFIP — consomme le flux RÉEL du serveur (WebSocket),
// rend l'UI, et n'affiche que des informations vérifiables. Données = DÉMONSTRATION.
(function () {
  // ---------- État ----------
  let operators = [];
  let cities = [];
  let wsConn = null;
  let chartsReady = false;

  const volById = {};
  const ecoTotals = { Banque: 0, MoMo: 0, Microfinance: 0, Passerelle: 0 };
  let volumeTotal = 0;
  let anomalies = 0;
  const endpoints = new Set();
  const arrivals = []; // epochs client pour le calcul TPS réel
  const txBuffer = []; // tampon pour aperçu/export (cap 500)

  // ---------- Utilitaires ----------
  const nf = new Intl.NumberFormat('fr-FR');
  const fmtMoney = (v) => nf.format(Math.round(v));
  const fmtVol = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + ' Mds XAF' : v >= 1e6 ? (v / 1e6).toFixed(1) + ' M XAF' : fmtMoney(v) + ' XAF';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);

  function clockTick() {
    const t = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Libreville' }).format(new Date());
    const el = $('clock'); if (el) el.textContent = t + ' WAT';
  }

  // ---------- WebSocket ----------
  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    wsConn = new WebSocket(`${scheme}://${location.host}`);
    wsConn.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; } // robustesse (corrige ROBUST-1)
      if (msg.type === 'INIT') return onInit(msg.data);
      if (msg.type === 'BACKFILL') return (msg.data || []).forEach((tx) => ingest(tx, { silent: true }));
      if (msg.type === 'TX') return ingest({ ...msg.data, _seq: msg.ledger.seq, _hash: msg.ledger.hash }, {});
    };
    wsConn.onclose = () => { setConnState(false); setTimeout(connect, 3000); };
    wsConn.onerror = () => { try { wsConn.close(); } catch (_) {} };
    wsConn.onopen = () => setConnState(true);
  }

  function setConnState(up) {
    const dot = $('conn-dot'); const lbl = $('conn-label');
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (up ? 'bg-emerald-500 animate-pulse' : 'bg-red-500');
    if (lbl) lbl.textContent = up ? 'Flux connecté' : 'Reconnexion…';
  }

  function onInit(d) {
    operators = d.operators; cities = d.cities;
    HubCharts.init(operators); chartsReady = true;
    HubMap.init(cities);
    renderOperatorPanels();
    renderConnectors();
    renderCertList();
    populateFilters();
    // Statut sécurité honnête (corrige les fausses allégations)
    const tlsEl = $('tls-status');
    if (tlsEl) tlsEl.textContent = d.tls ? 'TLS actif (WSS)' : 'HTTP (dev, sans TLS)';
    const algEl = $('ledger-alg'); if (algEl) algEl.textContent = d.pubkeyAlgorithm;
    loadPublicKey();
    refreshLedgerIntegrity();
  }

  // ---------- Ingestion d'une transaction ----------
  function ingest(tx, { silent }) {
    txBuffer.push(tx);
    if (txBuffer.length > 500) txBuffer.shift();

    volumeTotal += tx.amount;
    volById[tx.operator.id] = (volById[tx.operator.id] || 0) + tx.amount;
    if (ecoTotals[tx.operator.type] !== undefined) ecoTotals[tx.operator.type] += tx.amount;
    endpoints.add(`${tx.operator.id}-${tx.location.city}`);
    if (tx.anomaly.flagged) anomalies += 1;

    if (!silent) {
      arrivals.push(Date.now());
      while (arrivals.length && arrivals[0] < Date.now() - 5000) arrivals.shift();
    }

    updateCounters();
    renderLedgerRow(tx);
    if (chartsReady && !silent) {
      HubCharts.pushFlux(tx.amount);
      HubCharts.setEco(ecoTotals);
      HubCharts.setBar(operators, volById);
    }
    if (!silent) {
      HubMap.addMarker(tx, currentGpsFilters());
      if (tx.anomaly.flagged) pushAlert(tx);
    }
  }

  function updateCounters() {
    $('vol-counter').textContent = fmtVol(volumeTotal);
    $('tps-counter').textContent = String(Math.round(arrivals.length / 5));
    $('endpoints-counter').textContent = String(endpoints.size);
    $('anomaly-counter').textContent = String(anomalies);
    const center = $('eco-center'); if (center) center.textContent = String(txBuffer.length);
  }

  // ---------- Registre (ledger) ----------
  function renderLedgerRow(tx) {
    const tb = $('log-table'); if (!tb) return;
    const status = tx.anomaly.flagged
      ? '<span class="px-2 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 font-bold">REJET</span>'
      : '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">VALIDÉE</span>';
    const hash = tx._hash || '';
    const row = `<tr class="border-b border-gray-800/50 ${tx.anomaly.flagged ? 'bg-red-900/10' : ''}">
      <td class="p-4 text-gray-400 text-xs">${esc(new Date(tx.epoch).toLocaleTimeString('fr-FR'))}</td>
      <td class="p-4 text-gray-300 text-xs">${esc(tx.location.city)}</td>
      <td class="p-4 text-emerald-400 text-xs"><span class="hash-truncate" title="${esc(hash)}">${esc(hash)}</span></td>
      <td class="p-4 text-xs ${esc(tx.operator.color || 'text-white')}">${esc(tx.operator.name)}</td>
      <td class="p-4 text-right font-bold text-xs text-gray-200">${fmtMoney(tx.amount)}</td>
      <td class="p-4 text-center">${status}</td></tr>`;
    tb.insertAdjacentHTML('afterbegin', row);
    while (tb.children.length > 25) tb.removeChild(tb.lastChild);
  }

  // ---------- Panneaux opérateurs ----------
  function renderOperatorPanels() {
    const momo = $('momo-list'); const bank = $('banks-list'); const emf = $('emf-list');
    [momo, bank, emf].forEach((c) => { if (c) c.innerHTML = ''; });
    let hMomo = '', hBank = '', hEmf = '';
    operators.forEach((op) => {
      const card = `<div class="flex items-center justify-between p-3 bg-gray-800/40 rounded-lg border border-gray-700/50">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded ${esc(op.bg)} flex items-center justify-center font-bold text-white text-xs">${esc(op.name.substring(0, 2).toUpperCase())}</div>
          <div><p class="font-semibold text-sm text-gray-200">${esc(op.name)}</p><p class="text-[10px] text-gray-400">${esc(op.type)}</p></div>
        </div>
        <div class="text-right"><p class="font-bold text-sm text-emerald-400" id="vol-op-${esc(op.id)}">0 XAF</p></div></div>`;
      if (op.type === 'Microfinance') hEmf += card;
      else if (op.type === 'Banque') hBank += card;
      else hMomo += card; // MoMo + Passerelle
    });
    if (momo) momo.innerHTML = hMomo; if (bank) bank.innerHTML = hBank; if (emf) emf.innerHTML = hEmf;
  }

  function renderConnectors() {
    const tb = $('connectors-table'); if (!tb) return;
    tb.innerHTML = operators.map((op) => `<tr class="hover:bg-gray-800/20">
      <td class="p-3 font-medium text-sm">${esc(op.name)}</td>
      <td class="p-3 text-xs text-gray-400">${esc(op.type)}</td>
      <td class="p-3 font-mono text-xs text-emerald-400">POST /api/v1/iso8583 (HMAC)</td>
      <td class="p-3 text-xs font-mono text-purple-300">ECDSA P-256 (registre signé)</td>
      <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Démo</span></td></tr>`).join('');
  }

  function renderCertList() {
    const c = $('cert-list'); if (!c) return;
    c.innerHTML = operators.map((op) => `<div class="flex items-center justify-between bg-gray-800/30 p-2 rounded border border-gray-700 text-xs font-mono">
      <span class="font-semibold text-gray-200">${esc(op.name)}</span>
      <span class="text-emerald-300 text-[11px]">Connecteur démo</span></div>`).join('');
  }

  async function loadPublicKey() {
    try {
      const r = await fetch('/api/v1/pubkey'); const j = await r.json();
      const el = $('pki-pubkey'); if (el) el.textContent = j.publicKeyPem.trim();
      const fp = $('pki-fingerprint');
      if (fp && window.crypto && crypto.subtle) {
        const buf = new TextEncoder().encode(j.publicKeyPem);
        const dg = await crypto.subtle.digest('SHA-256', buf);
        fp.textContent = Array.from(new Uint8Array(dg)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join(':');
      }
    } catch (_) {}
  }

  async function refreshLedgerIntegrity() {
    try {
      const r = await fetch('/api/v1/ledger/verify'); const j = await r.json();
      const el = $('ledger-integrity');
      if (el) {
        el.textContent = j.valid ? `Chaîne VALIDE — ${j.total} enregistrements` : `RUPTURE au seq ${j.brokenAt}`;
        el.className = j.valid ? 'text-emerald-300 font-bold' : 'text-red-300 font-bold';
      }
    } catch (_) {}
  }

  // ---------- Alertes ----------
  function pushAlert(tx) {
    const c = $('alerts-container'); if (!c) return;
    c.insertAdjacentHTML('afterbegin', `<div class="bg-red-900/20 p-2 rounded border border-red-500/30 text-xs mb-2">
      <span class="text-red-300 font-bold block">[ALERTE] ${esc(tx.anomaly.reason)}</span>
      ${esc(tx.operator.name)} — ${esc(tx.location.city)}</div>`);
    while (c.children.length > 6) c.removeChild(c.lastChild);
  }

  // ---------- Filtres GPS ----------
  function currentGpsFilters() {
    return {
      op: $('gps-filter-operator') ? $('gps-filter-operator').value : 'all',
      type: $('gps-filter-type') ? $('gps-filter-type').value : 'all',
      anomaliesOnly: $('gps-show-anomalies-only') ? $('gps-show-anomalies-only').checked : false,
    };
  }

  function populateFilters() {
    const gps = $('gps-filter-operator');
    if (gps) operators.forEach((op) => { gps.insertAdjacentHTML('beforeend', `<option value="${esc(op.id)}">${esc(op.name)}</option>`); });
    const today = new Date().toISOString().split('T')[0];
    if ($('report-start')) $('report-start').value = today;
    if ($('report-end')) $('report-end').value = today;
  }

  // ---------- Rapports (corrige REPORT-1 : filtre dates appliqué ; EXPORT-1 : vrai fichier) ----------
  function filteredForReport() {
    const type = $('report-type').value;
    const start = $('report-start').value ? new Date($('report-start').value + 'T00:00:00').getTime() : -Infinity;
    const end = $('report-end').value ? new Date($('report-end').value + 'T23:59:59').getTime() : Infinity;
    return txBuffer.filter((t) => (type === 'all' || t.operator.type === type) && t.epoch >= start && t.epoch <= end);
  }

  function previewReport() {
    const data = filteredForReport();
    const c = $('report-preview-container');
    if (!data.length) { c.innerHTML = '<p class="text-gray-500 text-sm italic">Aucune transaction (tampon de session) ne correspond aux critères.</p>'; return; }
    const sum = data.reduce((s, t) => s + t.amount, 0);
    const anom = data.filter((t) => t.anomaly.flagged).length;
    let h = `<div class="space-y-3 text-xs font-mono">
      <div class="p-3 bg-gray-900/80 rounded border border-gray-800 grid grid-cols-3 gap-2 text-[11px]">
        <div><span class="text-gray-500">TRANSACTIONS</span><br><span class="text-white font-bold">${data.length}</span></div>
        <div><span class="text-gray-500">VOLUME</span><br><span class="text-emerald-400 font-bold">${fmtMoney(sum)} XAF</span></div>
        <div><span class="text-gray-500">ANOMALIES</span><br><span class="text-red-400 font-bold">${anom}</span></div>
      </div><table class="w-full text-left"><thead class="text-gray-500 uppercase text-[9px] border-b border-gray-800">
      <tr><th class="pb-1">Heure</th><th class="pb-1">Institution</th><th class="pb-1">Ville</th><th class="pb-1 text-right">Montant</th></tr></thead><tbody>`;
    data.slice(-12).reverse().forEach((t) => { h += `<tr><td class="py-1 text-gray-500">${esc(new Date(t.epoch).toLocaleTimeString('fr-FR'))}</td><td class="py-1 ${esc(t.operator.color || 'text-white')}">${esc(t.operator.name)}</td><td class="py-1 text-gray-400">${esc(t.location.city)}</td><td class="py-1 text-right font-bold text-gray-300">${fmtMoney(t.amount)}</td></tr>`; });
    h += '</tbody></table></div>';
    c.innerHTML = h;
  }

  function exportReport() {
    const type = $('report-type').value;
    const format = $('report-format').value.toLowerCase();
    const url = `/api/v1/export?format=${encodeURIComponent(format)}&type=${encodeURIComponent(type)}`;
    const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    const tb = $('export-history-table');
    if (tb) tb.insertAdjacentHTML('afterbegin', `<tr><td class="p-2 border-b border-gray-900"><span class="text-gray-300 block font-semibold">${esc(new Date().toLocaleTimeString('fr-FR'))}</span></td><td class="p-2 border-b border-gray-900 text-gray-400"><span class="text-emerald-400 font-bold">[${esc(format.toUpperCase())}]</span> ${esc(type === 'all' ? 'Global' : type)}</td><td class="p-2 border-b border-gray-900 text-right pr-2"><span class="text-emerald-300 text-[9px] font-bold">TÉLÉCHARGÉ</span></td></tr>`);
  }

  // ---------- Onglets accessibles (ARIA tabs) ----------
  const TITLES = {
    dashboard: ['Monitoring global des flux', 'Agrégation du flux de démonstration en temps réel'],
    operators: ['Institutions financières', 'Banques, Mobile Money & Microfinances'],
    gps: ['Géolocalisation des transactions', 'Routage territorial en temps réel'],
    connectors: ['Connecteurs (API)', 'Injection ISO 8583 authentifiée (HMAC) sur le serveur'],
    logs: ['Registre chaîné', 'Chaînage SHA-256 + signature ECDSA P-256 (non-répudiation vérifiable)'],
    reports: ['Rapports & extractions', 'Exports signés (CSV/JSON) générés par le serveur'],
    cybersec: ['Sécurité & intégrité', 'Posture réelle de l’infrastructure (transport, registre)'],
    pki: ['Clé de signature du registre', 'Clé publique ECDSA P-256 vérifiable'],
  };

  function switchTab(tabId, btn) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    const panel = $(tabId); if (panel) panel.classList.remove('hidden');
    $('tab-title').textContent = TITLES[tabId][0];
    $('tab-subtitle').textContent = TITLES[tabId][1];
    document.querySelectorAll('#main-nav [role="tab"]').forEach((b) => {
      const active = b === btn;
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.className = active
        ? 'w-full flex items-center gap-3 px-4 py-3 bg-emerald-900/20 text-emerald-300 rounded-lg border border-emerald-500/30 text-left'
        : 'w-full flex items-center gap-3 px-4 py-3 text-gray-300 hover:bg-gray-800 hover:text-white rounded-lg text-left';
    });
    if (panel) panel.focus({ preventScroll: true });
    if (tabId === 'gps') HubMap.invalidate();
    if (tabId === 'reports') previewReport();
    closeSidebarMobile();
  }

  // ---------- Sidebar responsive ----------
  function toggleSidebar() { document.querySelector('aside').classList.toggle('-translate-x-full'); }
  function closeSidebarMobile() { if (window.innerWidth < 768) document.querySelector('aside').classList.add('-translate-x-full'); }

  // ---------- Démarrage ----------
  document.addEventListener('DOMContentLoaded', () => {
    clockTick(); setInterval(clockTick, 1000);
    connect();

    document.querySelectorAll('#main-nav [data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab, b)));
    ['gps-filter-operator', 'gps-filter-type', 'gps-show-anomalies-only'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', () => HubMap.clear()); });
    if ($('btn-preview')) $('btn-preview').addEventListener('click', previewReport);
    if ($('btn-export')) $('btn-export').addEventListener('click', exportReport);
    if ($('btn-burger')) $('btn-burger').addEventListener('click', toggleSidebar);
    // onglet par défaut
    const first = document.querySelector('#main-nav [data-tab="dashboard"]');
    if (first) switchTab('dashboard', first);
  });
})();
