'use strict';

// =============================================================================
// SUMo — client de supervision. Consomme le flux temps réel (WebSocket) et les
// API REST par module, applique le RBAC (visibilité des onglets selon le profil),
// et n'affiche que des informations vérifiables. Données = DÉMONSTRATION.
// =============================================================================
(function () {
  // ---------- État ----------
  let user = null;
  let perms = { modules: [], canReveal: false, canWriteCases: false, canAdmin: false };
  let ws = null;
  let activeTab = 'observatoire';
  let geoReady = false;

  const REFRESH = new Set(['observatoire', 'antifraude', 'qos', 'revenus', 'analytics', 'securite', 'registre', 'geo', 'mesures', 'tiers', 'reclamations', 'postal', 'workflow']);
  const TITLES = {
    observatoire: ['Observatoire', 'Statistiques de marché en temps réel'],
    operators: ['Opérateurs & moteurs', 'Plateformes Mobile Money et réseaux d\'agents'],
    geo: ['Géolocalisation', 'Cellules / stations de base et anomalies géographiques'],
    registre: ['Registre des TDR', 'Lac de données souverain — chaîne signée ECDSA P-256'],
    revenus: ['Revenus & redevances', 'Frais perçus vs attendus, écarts et redevance due'],
    qos: ['Qualité de service', 'Taux de succès, latence et codes d\'erreur'],
    reporting: ['Reporting réglementaire', 'Modèles de rapports et exports signés'],
    antifraude: ['Antifraude / AML', 'Moteur de règles paramétrable et alertes'],
    investigation: ['Investigation', 'Dossiers d\'enquête et traçage de chaînes'],
    analytics: ['Analytics / Risque', 'Détection d\'anomalies et scoring de risque'],
    connecteurs: ['Connecteurs / Collecte', 'Ingestion multi-format et qualité des données'],
    securite: ['Sécurité & audit', 'Posture réelle, intégrité et journal d\'audit'],
    admin: ['Administration', 'Configuration des règles, tarifs et seuils'],
    dispatch: ['Dispatch des modules', 'Affectation des modules aux directions et aux comptes'],
    workflow: ['Gestion des dossiers', 'Standard BPM : corbeilles, statuts, SLA, avis et décisions'],
    mesures: ['Mesure indépendante (N3)', 'Sondes transactionnelles — le mesuré prime sur le déclaré'],
    tiers: ['Accès des tiers (PSP)', 'Raccordements, tarifs de gros et non-discrimination'],
    reclamations: ['Réclamations consommateurs', 'Suivi agrégé et corrélation aux incidents techniques'],
    postal: ['Services financiers postaux', 'Réseau, activité, qualité et inclusion (service universel)'],
    aide: ['Aide & guide', 'Comprendre la plateforme et lire chaque module'],
  };

  // ---------- Utilitaires ----------
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('fr-FR');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const xaf = (v) => {
    v = Number(v) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Md';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + ' k';
    return nf.format(Math.round(v));
  };
  const pct = (v) => (v == null ? '—' : (100 * v).toFixed(1) + ' %');
  // Formateur unique : la construction d'un Intl.DateTimeFormat est coûteuse
  // (chargement locale + fuseau) et t() est appelé par ligne de tableau.
  const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Libreville' });
  const t = (epoch) => timeFmt.format(new Date(epoch));

  async function getJSON(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('401'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
    return j;
  }
  async function sendJSON(path, method, body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
    return j;
  }

  const panel = (title, inner, cls) => `<div class="glass-panel p-5 rounded-xl ${cls || ''}"><h3 class="text-sm font-semibold mb-3 text-gray-200">${esc(title)}</h3>${inner}</div>`;
  const kpi = (label, value, color) => `<div class="glass-panel p-4 rounded-xl border-t-2 ${color || 'border-t-emerald-500'}"><p class="text-[11px] text-gray-400 uppercase tracking-wider">${esc(label)}</p><h3 class="text-xl font-bold mt-1 text-white">${value}</h3></div>`;
  function table(columns, rows) {
    const head = columns.map((c) => `<th class="p-2 text-left text-[10px] uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-900/90">${esc(c.label)}</th>`).join('');
    const body = rows.length ? rows.map((r) => `<tr class="border-b border-gray-800/40 hover:bg-gray-800/20">${columns.map((c) => `<td class="p-2 ${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="p-3 text-gray-500 italic" colspan="${columns.length}">Aucune donnée pour le moment.</td></tr>`;
    return `<div class="overflow-auto max-h-[60vh]"><table class="w-full text-xs"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const sevBadge = (s) => { const m = { ELEVEE: 'bg-red-500/20 text-red-300 border-red-500/30', MOYENNE: 'bg-amber-500/20 text-amber-300 border-amber-500/30', FAIBLE: 'bg-gray-500/20 text-gray-300 border-gray-500/30' }; return `<span class="px-2 py-0.5 rounded text-[10px] border ${m[s] || m.FAIBLE} font-bold">${esc(s)}</span>`; };
  const riskBadge = (lvl) => { const m = { CRITIQUE: 'bg-red-500/20 text-red-300 border-red-500/30', ELEVE: 'bg-orange-500/20 text-orange-300 border-orange-500/30', MODERE: 'bg-amber-500/20 text-amber-300 border-amber-500/30', FAIBLE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' }; return `<span class="px-2 py-0.5 rounded text-[10px] border ${m[lvl] || m.FAIBLE} font-bold">${esc(lvl)}</span>`; };
  const statusBadge = (s) => s === 'SUCCESS'
    ? '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">SUCCÈS</span>'
    : '<span class="px-2 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 font-bold">ÉCHEC</span>';

  function clockTick() { const el = $('clock'); if (el) el.textContent = t(Date.now()) + ' WAT'; }

  // ==========================================================================
  // WebSocket — flux temps réel
  // ==========================================================================
  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}`);
    ws.onopen = () => setConn(true);
    ws.onclose = () => { setConn(false); setTimeout(connect, 3000); };
    ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'INIT') return onInit(msg.data);
      if (msg.type === 'BACKFILL') return (msg.data || []).forEach((tx) => onTx(tx, true));
      if (msg.type === 'TX') return onTx(msg.data, false);
    };
  }
  function setConn(up) {
    const dot = $('conn-dot'); const lbl = $('conn-label');
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (up ? 'bg-emerald-500 animate-pulse' : 'bg-red-500');
    if (lbl) lbl.textContent = up ? 'Flux connecté' : 'Reconnexion…';
  }
  function onInit(d) {
    if ($('tls-status')) $('tls-status').textContent = d.tls ? 'TLS actif (WSS)' : 'HTTP (dev, sans TLS)';
    if ($('ledger-alg') && d.ledger) $('ledger-alg').textContent = d.ledger.algorithm;
    HubCharts.initDashboard();
  }
  function onTx(tx, silent) {
    // Flux live (table)
    const tb = $('live-tx');
    if (tb) {
      const flagged = tx.anomaly && tx.anomaly.flagged;
      tb.insertAdjacentHTML('afterbegin', `<tr class="${flagged ? 'bg-red-900/10' : ''}">
        <td class="p-1.5 text-gray-500">${esc(t(tx.epoch))}</td>
        <td class="p-1.5 ${esc(tx.operator.color || 'text-gray-300')}">${esc(tx.operator.name.split(' ')[0])}</td>
        <td class="p-1.5 text-gray-400">${esc(tx.type)}</td>
        <td class="p-1.5 text-right text-gray-200">${nf.format(tx.amountXaf)}</td>
        <td class="p-1.5 text-center">${flagged ? '<i class="fa-solid fa-triangle-exclamation text-red-400"></i>' : '<i class="fa-solid fa-check text-emerald-500"></i>'}</td></tr>`);
      while (tb.children.length > 18) tb.removeChild(tb.lastChild);
    }
    if (!silent && geoReady && activeTab === 'geo') HubMap.addTx(tx);
  }

  // ==========================================================================
  // Modules (renderers)
  // ==========================================================================
  async function loadObservatoire() {
    const s = await getJSON('/api/v1/stats?minutes=20');
    $('kpi-volume').textContent = xaf(s.totals.sumXaf) + ' XAF';
    $('kpi-count').textContent = nf.format(s.totals.count);
    $('kpi-success').textContent = pct(s.totals.successRate);
    $('kpi-fees').textContent = xaf(s.totals.feeXaf) + ' XAF';
    $('kpi-alerts').textContent = nf.format(s.totals.alerts || 0);
    HubCharts.pushFlux(s.series);
    HubCharts.setShare(s.byOperator);
    HubCharts.setType(s.byType);
    HubCharts.setChannel(s.byChannel);
  }

  async function loadOperators() {
    const d = await getJSON('/api/v1/operators');
    const cards = d.operators.map((o) => `<div class="glass-panel p-4 rounded-xl">
      <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded ${esc(o.bg)} flex items-center justify-center text-white font-bold text-xs">${esc(o.name.slice(0, 2).toUpperCase())}</div>
        <div><p class="font-semibold text-sm text-gray-100">${esc(o.name)}</p><p class="text-[11px] text-gray-400">Moteur : ${esc(o.engineName || o.engine)}</p></div></div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="bg-gray-800/40 rounded p-2"><p class="text-gray-500">Volume (cumul)</p><p class="font-bold text-emerald-400">${xaf(o.lifetime.sumXaf)} XAF</p></div>
        <div class="bg-gray-800/40 rounded p-2"><p class="text-gray-500">Transactions</p><p class="font-bold text-gray-200">${nf.format(o.lifetime.count)}</p></div>
        <div class="bg-gray-800/40 rounded p-2"><p class="text-gray-500">Agents</p><p class="font-bold text-gray-200">${nf.format(o.agents)}</p></div>
        <div class="bg-gray-800/40 rounded p-2"><p class="text-gray-500">Abonnés (pool)</p><p class="font-bold text-gray-200">${nf.format(o.subscribers)}</p></div>
      </div></div>`).join('');
    $('view-operators').innerHTML = `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-5">${cards}</div>
      ${panel('Volume cumulé par opérateur', '<div class="h-64"><canvas id="opBar"></canvas></div>')}`;
    HubCharts.moduleBar('opBar', d.operators.map((o) => o.name), d.operators.map((o) => o.lifetime.sumXaf), HubCharts.COLOR);
  }

  async function loadRevenus() {
    const d = await getJSON('/api/v1/revenue');
    const disc = await getJSON('/api/v1/revenue/discrepancies');
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${kpi('Frais perçus', xaf(d.totals.feeCollectedXaf) + ' XAF', 'border-t-emerald-500')}
      ${kpi('Frais attendus', xaf(d.totals.feeExpectedXaf) + ' XAF', 'border-t-sky-500')}
      ${kpi('Écart (manque)', xaf(d.totals.discrepancyXaf) + ' XAF', 'border-t-red-500')}
      ${kpi('Redevance due (' + (d.contributionRate * 100).toFixed(1) + '%)', xaf(d.totals.contributionDueXaf) + ' XAF', 'border-t-amber-500')}</div>`;
    const opTable = table([
      { label: 'Opérateur', key: 'name', cls: 'font-semibold' },
      { label: 'Tx', key: 'transactions' },
      { label: 'Perçus', render: (r) => nf.format(r.feeCollectedXaf) },
      { label: 'Attendus', render: (r) => nf.format(r.feeExpectedXaf) },
      { label: 'Écart', render: (r) => `<span class="${r.discrepancyXaf > 0 ? 'text-red-400' : 'text-emerald-400'} font-bold">${nf.format(r.discrepancyXaf)}</span>` },
      { label: '% écart', render: (r) => r.discrepancyPct + ' %' },
      { label: 'Sous-décl.', key: 'underReportedCount' },
      { label: 'Redevance', render: (r) => nf.format(r.contributionDueXaf) },
    ], d.byOperator);
    const discTable = table([
      { label: 'Heure', render: (r) => t(r.epoch) },
      { label: 'Opérateur', key: 'operatorName' },
      { label: 'Type', key: 'type' },
      { label: 'Montant', render: (r) => nf.format(r.amountXaf) },
      { label: 'Perçu', render: (r) => nf.format(r.feeCollected) },
      { label: 'Attendu', render: (r) => nf.format(r.feeExpected) },
      { label: 'Manque', render: (r) => `<span class="text-red-400 font-bold">${nf.format(r.gapXaf)}</span>` },
    ], disc.items);
    $('view-revenus').innerHTML = cards
      + panel('Assurance des revenus & redevances par opérateur', opTable, 'mb-5')
      + panel('Écarts récents (sous-déclaration de frais)', discTable);
  }

  async function loadQos() {
    const d = await getJSON('/api/v1/qos');
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${kpi('Taux de succès', pct(d.overall.successRate), 'border-t-emerald-500')}
      ${kpi('Échecs', nf.format(d.overall.failed), 'border-t-red-500')}
      ${kpi('Latence moy.', d.overall.avgLatencyMs + ' ms', 'border-t-sky-500')}
      ${kpi('Latence p95', d.overall.p95LatencyMs + ' ms', 'border-t-amber-500')}</div>`;
    const opTable = table([
      { label: 'Opérateur', key: 'name', cls: 'font-semibold' },
      { label: 'Tx', key: 'total' },
      { label: 'Succès', render: (r) => `<span class="${r.successRate < d.thresholds.minSuccessRate ? 'text-red-400' : 'text-emerald-400'} font-bold">${pct(r.successRate)}</span>` },
      { label: 'Lat. moy', render: (r) => r.avgLatencyMs + ' ms' },
      { label: 'p95', render: (r) => r.p95LatencyMs + ' ms' },
      { label: 'Top erreur', render: (r) => r.errors[0] ? esc(r.errors[0].label) + ' (' + r.errors[0].count + ')' : '—' },
      { label: 'Manquements', render: (r) => r.breaches.length ? `<span class="text-red-400">${esc(r.breaches.join(' ; '))}</span>` : '<span class="text-emerald-400">conforme</span>' },
    ], d.byOperator);
    const chTable = table([
      { label: 'Canal', key: 'label', cls: 'font-semibold' },
      { label: 'Tx', key: 'total' },
      { label: 'Succès', render: (r) => pct(r.successRate) },
      { label: 'Latence moy.', render: (r) => r.avgLatencyMs + ' ms' },
    ], d.byChannel);
    $('view-qos').innerHTML = cards
      + panel('Qualité de service par opérateur (seuils : succès ≥ ' + (d.thresholds.minSuccessRate * 100) + '%, latence ≤ ' + d.thresholds.maxLatencyMs + ' ms)', opTable, 'mb-5')
      + `<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">${panel('Par canal (USSD/STK/App/SMS)', chTable)}${panel('Taux de succès par opérateur', '<div class="h-56"><canvas id="qosBar"></canvas></div>')}</div>`;
    HubCharts.moduleBar('qosBar', d.byOperator.map((o) => o.name), d.byOperator.map((o) => +(o.successRate * 100).toFixed(1)), '#10b981');
  }

  async function loadAntifraude() {
    const r = await getJSON('/api/v1/fraud/rules');
    const a = await getJSON('/api/v1/fraud/alerts');
    const ruleCards = r.stats.rules.map((rl) => `<div class="bg-gray-800/40 rounded-lg p-3 border border-gray-700/50">
      <div class="flex items-center justify-between"><span class="text-xs font-semibold text-gray-200">${esc(rl.id)}</span>${sevBadge(rl.severity)}</div>
      <p class="text-[11px] text-gray-400 mt-1">${esc(rl.label)}</p>
      <p class="text-lg font-bold mt-1 ${rl.count ? 'text-red-300' : 'text-gray-500'}">${nf.format(rl.count)}</p></div>`).join('');
    const cfg = r.config;
    const cfgInfo = `<div class="text-[11px] text-gray-400 grid grid-cols-2 md:grid-cols-3 gap-2">
      <div>Seuil déclaration : <span class="text-gray-200 font-mono">${nf.format(cfg.reportingThresholdXaf)} XAF</span></div>
      <div>Montant élevé : <span class="text-gray-200 font-mono">${nf.format(cfg.highValueXaf)} XAF</span></div>
      <div>Vélocité : <span class="text-gray-200 font-mono">> ${cfg.velocity.maxCount}/${cfg.velocity.windowMin}min</span></div>
      <div>Fractionnement : <span class="text-gray-200 font-mono">${cfg.structuring.minCount}× &lt; seuil</span></div>
      <div>Transfrontalier : <span class="text-gray-200 font-mono">≥ ${nf.format(cfg.crossBorderReviewXaf)} XAF</span></div>
      <div>KYC à risque : <span class="text-gray-200 font-mono">${esc(cfg.riskyKyc.join(', '))}</span></div></div>`;
    const canTrace = perms.modules.includes('investigation');
    const alertTable = table([
      { label: 'Heure', render: (x) => t(x.epoch) },
      { label: 'Règle', render: (x) => `${esc(x.ruleId)} ${sevBadge(x.severity)}` },
      { label: 'Opérateur', key: 'operatorName' },
      { label: 'Sujet (masqué)', render: (x) => `<span class="font-mono">${esc(x.msisdnMasked)}</span>` },
      { label: 'Montant', render: (x) => nf.format(x.amountXaf) },
      { label: 'Détail', render: (x) => `<span class="text-gray-400">${esc(x.detail || '')}</span>` },
      { label: '', render: (x) => canTrace && x.subjectToken ? `<button class="trace-btn text-emerald-400 hover:text-emerald-300" data-token="${esc(x.subjectToken)}" title="Tracer ce sujet"><i class="fa-solid fa-diagram-project"></i></button>` : '' },
    ], a.alerts);
    $('view-antifraude').innerHTML = panel('Moteur de règles — alertes par règle (' + nf.format(r.stats.totalAlerts) + ' au total · ' + r.stats.trackedMsisdn + ' MSISDN suivis)',
      `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">${ruleCards}</div>${cfgInfo}`, 'mb-5')
      + panel('Alertes récentes', alertTable);
    bindTrace();
  }

  async function loadInvestigation() {
    const d = await getJSON('/api/v1/cases');
    const canWrite = perms.canWriteCases;
    const stat = d.stats;
    const head = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${kpi('Dossiers', nf.format(stat.total), 'border-t-sky-500')}
      ${kpi('Ouverts', nf.format(stat.ouvert), 'border-t-amber-500')}
      ${kpi('En cours', nf.format(stat.enCours), 'border-t-blue-500')}
      ${kpi('Clos', nf.format(stat.clos), 'border-t-emerald-500')}</div>`;
    const casesTable = table([
      { label: 'Réf', key: 'id', cls: 'font-mono text-emerald-400' },
      { label: 'Titre', key: 'title', cls: 'font-semibold' },
      { label: 'Gravité', render: (r) => sevBadge(r.severity) },
      { label: 'Statut', render: (r) => `<span class="px-2 py-0.5 rounded text-[10px] bg-gray-700/50 border border-gray-600">${esc(r.status)}</span>` },
      { label: 'Sujet', render: (r) => `<span class="font-mono">${esc(r.subjectMsisdn ? (r.subjectMsisdn) : '—')}</span>` },
      { label: 'Liées', key: 'linkedCount' },
      { label: 'Créé par', key: 'createdBy' },
    ], d.cases);
    const createForm = canWrite ? panel('Nouveau dossier', `
      <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
        <input id="case-title" class="md:col-span-2 bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs" placeholder="Titre du dossier">
        <select id="case-sev" class="bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs"><option value="ELEVEE">Gravité élevée</option><option value="MOYENNE">Gravité moyenne</option><option value="FAIBLE">Gravité faible</option></select>
        <button id="case-create" class="bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-2 text-xs font-medium">Créer</button>
      </div>
      <input id="case-token" class="hidden">`, 'mb-5') : '';
    const traceBox = panel('Traçage de chaîne', `
      <div class="flex gap-2 mb-3 text-sm">
        <input id="trace-token" class="flex-1 bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs font-mono" placeholder="Jeton de sujet (via une alerte)">
        ${perms.canReveal ? '<label class="flex items-center gap-1 text-xs text-gray-300"><input type="checkbox" id="trace-reveal"> Révéler les numéros</label>' : ''}
        <button id="trace-go" class="bg-sky-700 hover:bg-sky-600 text-white rounded px-3 py-2 text-xs font-medium">Tracer</button>
      </div>
      <div id="trace-result" class="text-xs text-gray-500 italic">Sélectionnez « Tracer » sur une alerte (onglet Antifraude) ou collez un jeton.</div>`);
    $('view-investigation').innerHTML = head + createForm + panel('Dossiers d\'enquête', casesTable, 'mb-5') + traceBox;

    if (canWrite && $('case-create')) $('case-create').addEventListener('click', async () => {
      const title = $('case-title').value.trim(); if (!title) return;
      const token = $('case-token').value || undefined;
      try { await sendJSON('/api/v1/cases', 'POST', { title, severity: $('case-sev').value, subjectToken: token }); loadInvestigation(); }
      catch (e) { alert('Erreur : ' + e.message); }
    });
    if ($('trace-go')) $('trace-go').addEventListener('click', () => runTrace($('trace-token').value.trim(), $('trace-reveal') && $('trace-reveal').checked));
  }

  function bindTrace() {
    document.querySelectorAll('.trace-btn').forEach((b) => b.addEventListener('click', () => openTrace(b.dataset.token)));
  }
  async function openTrace(token) {
    await switchTab('investigation');
    const inp = $('trace-token'); if (inp) inp.value = token;
    const ct = $('case-token'); if (ct) ct.value = token;
    runTrace(token, false);
  }
  async function runTrace(token, reveal) {
    if (!token) return;
    const box = $('trace-result'); if (box) box.innerHTML = '<span class="text-gray-400">Chargement…</span>';
    try {
      const d = await getJSON(`/api/v1/trace?token=${encodeURIComponent(token)}${reveal ? '&reveal=1' : ''}`);
      const c = d.chain;
      const cp = table([
        { label: 'Contrepartie', render: (r) => `<span class="font-mono">${esc(r.counterparty)}</span>` },
        { label: 'Tx', key: 'count' }, { label: 'Volume', render: (r) => nf.format(r.sumXaf) },
      ], c.counterparties);
      const tx = table([
        { label: 'Heure', render: (r) => t(r.epoch) }, { label: 'Sens', key: 'direction' }, { label: 'Type', key: 'type' },
        { label: 'Montant', render: (r) => nf.format(r.amountXaf) }, { label: 'Statut', render: (r) => statusBadge(r.status) },
        { label: 'Contrepartie', render: (r) => `<span class="font-mono">${esc(r.counterparty)}</span>` }, { label: 'Ville', key: 'city' },
      ], c.transactions);
      box.innerHTML = `<div class="mb-3 text-sm"><span class="text-gray-400">Sujet :</span> <span class="font-mono text-emerald-300">${esc(c.subject)}</span> · ${c.totalTx} transactions · ${xaf(c.sumXaf)} XAF · ${c.counterparties.length} contreparties</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div><p class="text-xs text-gray-400 mb-1">Contreparties</p>${cp}</div><div><p class="text-xs text-gray-400 mb-1">Chronologie</p>${tx}</div></div>`;
    } catch (e) { box.innerHTML = `<span class="text-red-400">Erreur : ${esc(e.message)}</span>`; }
  }

  async function loadAnalytics() {
    const d = await getJSON('/api/v1/analytics/risk');
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${kpi('Abonnés profilés', nf.format(d.stats.profiledMsisdn), 'border-t-sky-500')}
      ${kpi('Signalés', nf.format(d.stats.flagged), 'border-t-amber-500')}
      ${kpi('Risque élevé', nf.format(d.stats.eleve), 'border-t-orange-500')}
      ${kpi('Risque critique', nf.format(d.stats.critique), 'border-t-red-500')}</div>`;
    const canTrace = perms.modules.includes('investigation');
    const top = table([
      { label: 'Score', render: (r) => `<span class="font-bold">${r.score}</span>` },
      { label: 'Niveau', render: (r) => riskBadge(r.level) },
      { label: 'Sujet (masqué)', render: (r) => `<span class="font-mono">${esc(r.msisdnMasked)}</span>` },
      { label: 'Opérateur', key: 'operatorId' },
      { label: 'Motifs', render: (r) => `<span class="text-gray-400">${esc((r.reasons || []).join(' · '))}</span>` },
      { label: '', render: (r) => canTrace && r.subjectToken ? `<button class="trace-btn text-emerald-400 hover:text-emerald-300" data-token="${esc(r.subjectToken)}"><i class="fa-solid fa-diagram-project"></i></button>` : '' },
    ], d.top);
    $('view-analytics').innerHTML = cards + panel('Top abonnés à risque (détection statistique : z-score personnel + agrégation de signaux)', top)
      + `<p class="text-[11px] text-gray-500 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>Méthode statistique (pas d'apprentissage profond) — socle à enrichir avec un jeu de données réel étiqueté.</p>`;
    bindTrace();
  }

  async function loadConnecteurs() {
    const d = await getJSON('/api/v1/connectors');
    const ing = d.ingestion;
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${kpi('Reçus', nf.format(ing.received), 'border-t-sky-500')}
      ${kpi('Acceptés', nf.format(ing.accepted), 'border-t-emerald-500')}
      ${kpi('Rejetés', nf.format(ing.rejected), 'border-t-red-500')}
      ${kpi('Complétude moy.', pct(ing.completenessRate), 'border-t-amber-500')}</div>`;
    const conn = table([
      { label: 'Opérateur', key: 'name', cls: 'font-semibold' },
      { label: 'Moteur', key: 'engine' },
      { label: 'Endpoint', render: (r) => `<span class="font-mono text-emerald-400">${esc(r.endpoint)}</span>` },
      { label: 'Auth', key: 'auth' },
      { label: 'Formats', render: (r) => esc(r.formats.join(', ')) },
      { label: 'Signature', render: (r) => `<span class="text-purple-300">${esc(r.signature)}</span>` },
    ], d.connectors);
    const issues = (ing.topIssues || []).length ? table([{ label: 'Problème de qualité', key: 'label' }, { label: 'Occurrences', key: 'count' }], ing.topIssues) : '<p class="text-xs text-gray-500 italic">Aucun problème de qualité détecté.</p>';
    $('view-connecteurs').innerHTML = cards
      + panel('Connecteurs d\'ingestion (non intrusifs · ISO 8583 / JSON / CSV · HMAC-SHA256)', conn, 'mb-5')
      + `<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">${panel('Contrôle qualité / complétude (Module Normalisation)', issues)}
      ${panel('Injection authentifiée', '<p class="text-xs text-gray-400 leading-relaxed">Chaque opérateur pousse ses TDR via <span class="font-mono text-emerald-400">POST /api/v1/iso8583</span>, signés <span class="font-mono">HMAC-SHA256</span>. Les formats hétérogènes (dialectes Comviva/Ericsson/maison) sont harmonisés vers le modèle TDR commun, contrôlés (complétude), puis scellés au registre signé. Aucune connexion intrusive aux cœurs opérateurs.</p>')}</div>`;
  }

  async function loadRegistre() {
    const d = await getJSON('/api/v1/ledger?limit=80');
    let integrity = '<span class="text-gray-400">…</span>';
    try { const v = await getJSON('/api/v1/ledger/verify'); integrity = v.valid ? `<span class="text-emerald-300 font-bold">Chaîne VALIDE — ${v.total} enregistrements</span>` : `<span class="text-red-300 font-bold">RUPTURE au seq ${v.brokenAt}</span>`; } catch { /* */ }
    const tab = table([
      { label: 'Seq', key: 'seq', cls: 'font-mono text-gray-500' },
      { label: 'Heure', render: (r) => t(r.payload.epoch) },
      { label: 'Hash (SHA-256)', render: (r) => `<span class="hash-truncate text-emerald-400" title="${esc(r.hash)}">${esc(r.hash)}</span>` },
      { label: 'Opérateur', render: (r) => `<span class="${esc(r.payload.operator.color || 'text-gray-200')}">${esc(r.payload.operator.name)}</span>` },
      { label: 'Type', render: (r) => esc(r.payload.type) },
      { label: 'Montant', render: (r) => nf.format(r.payload.amountXaf) },
      { label: 'Risque', render: (r) => r.payload.risk ? riskBadge(r.payload.risk.level) : '—' },
      { label: 'Statut', render: (r) => statusBadge(r.payload.status) },
    ], d.records);
    $('view-registre').innerHTML = panel('Intégrité du registre',
      `<div class="flex items-center justify-between"><p class="text-sm">Chaînage SHA-256 + signature ECDSA P-256 · persistant. Intégrité : ${integrity}</p>
       <button id="verify-btn" class="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-3 py-1.5 text-xs">Re-vérifier</button></div>
       <p class="text-[11px] text-gray-500 mt-2">Total : ${nf.format(d.stats.total)} TDR scellés. Numéros masqués (minimisation des données).</p>`, 'mb-5')
      + panel('Derniers TDR scellés', tab);
    if ($('verify-btn')) $('verify-btn').addEventListener('click', loadRegistre);
  }

  async function loadReporting() {
    const d = await getJSON('/api/v1/reports/templates');
    const opts = d.templates.map((tpl) => `<option value="${esc(tpl.id)}">${esc(tpl.label)}</option>`).join('');
    const today = new Date().toISOString().slice(0, 10);
    $('view-reporting').innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div>${panel('Générer un rapport', `
        <div class="space-y-3 text-sm">
          <div><label class="text-gray-300 block mb-1 text-xs">Modèle</label><select id="rep-tpl" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs">${opts}</select></div>
          <div class="grid grid-cols-2 gap-2"><div><label class="text-gray-300 block mb-1 text-xs">Début</label><input type="date" id="rep-start" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs"></div>
          <div><label class="text-gray-300 block mb-1 text-xs">Fin</label><input type="date" id="rep-end" value="${today}" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs"></div></div>
          <div class="flex gap-2 pt-1">
            <button id="rep-gen" class="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-2 text-xs font-medium">Aperçu</button>
            <button id="rep-csv" class="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded px-3 py-2 text-xs">Export CSV</button>
            <button id="rep-json" class="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded px-3 py-2 text-xs">JSON</button>
          </div>
          <p class="text-[11px] text-gray-500">Exports signés (SHA-256 + ECDSA P-256, en-têtes de réponse).</p>
        </div>`)}
        <p class="text-[11px] text-gray-500 mt-3 px-1">${d.templates.map((x) => '<b>' + esc(x.label) + '</b> — ' + esc(x.description)).join('<br>')}</p>
      </div>
      <div class="lg:col-span-2">${panel('Aperçu', '<div id="rep-preview" class="text-sm text-gray-500 italic">Choisissez un modèle puis « Aperçu ».</div>')}</div></div>`;
    const params = () => `template=${encodeURIComponent($('rep-tpl').value)}&start=${$('rep-start').value}&end=${$('rep-end').value}`;
    $('rep-gen').addEventListener('click', async () => {
      const box = $('rep-preview'); box.innerHTML = 'Chargement…';
      try {
        const r = await getJSON('/api/v1/reports/generate?' + params());
        const kpis = Object.entries(r.kpis).map(([k, v]) => `<div class="bg-gray-800/40 rounded p-2"><p class="text-[10px] text-gray-500 uppercase">${esc(k)}</p><p class="font-bold text-emerald-400 text-sm">${typeof v === 'number' ? nf.format(v) : esc(v)}</p></div>`).join('');
        const secs = r.sections.map((s) => panel(s.title, table(s.columns.map((c) => ({ label: c, key: c })), s.rows.slice(0, 40)), 'mb-3')).join('');
        box.innerHTML = `<p class="text-xs text-gray-400 mb-2">${esc(r.label)} · ${r.recordCount} enregistrements · généré ${esc(new Date(r.generatedAt).toLocaleString('fr-FR'))}</p>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">${kpis}</div>${secs}`;
      } catch (e) { box.innerHTML = `<span class="text-red-400">Erreur : ${esc(e.message)}</span>`; }
    });
    $('rep-csv').addEventListener('click', () => download('/api/v1/reports/export?format=csv&' + params()));
    $('rep-json').addEventListener('click', () => download('/api/v1/reports/export?format=json&' + params()));
  }

  function download(url) { const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }

  async function loadSecurite() {
    const s = await getJSON('/api/v1/security');
    const au = await getJSON('/api/v1/audit?limit=80');
    const led = s.ledger.integrity; const aud = s.audit.integrity;
    const posture = `<div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-lock mr-2 ${s.transport.tls ? 'text-emerald-400' : 'text-amber-400'}"></i>Transport</h4><p class="text-xs text-gray-400 mt-1">${esc(s.transport.scheme)}${s.transport.tls ? '' : ' — activable via <span class="font-mono">npm run gen-certs</span>'}</p></div>
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-link mr-2 ${led.valid ? 'text-emerald-400' : 'text-red-400'}"></i>Registre TDR</h4><p class="text-xs text-gray-400 mt-1">${led.valid ? 'Chaîne valide' : 'RUPTURE seq ' + led.brokenAt} · ${nf.format(s.ledger.total)} enregistrements · ${esc(s.ledger.algorithm)}</p></div>
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-clipboard-check mr-2 ${aud.valid ? 'text-emerald-400' : 'text-red-400'}"></i>Journal d'audit</h4><p class="text-xs text-gray-400 mt-1">${aud.valid ? 'Chaîne valide' : 'RUPTURE seq ' + aud.brokenAt} · ${nf.format(s.audit.total)} évènements (inviolable)</p></div>
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-user-lock mr-2 text-emerald-400"></i>Minimisation des données</h4><p class="text-xs text-gray-400 mt-1">MSISDN masqués par défaut. Révélation : ${esc(s.dataMinimization.revealRoles.join(', '))} — journalisée.</p></div>
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-database mr-2 ${s.persistence && s.persistence.enabled ? 'text-emerald-400' : 'text-gray-400'}"></i>Entrepôt PostgreSQL</h4><p class="text-xs text-gray-400 mt-1">${s.persistence && s.persistence.enabled ? ('Actif — ' + nf.format(s.persistence.rows || 0) + ' lignes persistées') : 'Désactivé (stockage en mémoire) — activer via <span class="font-mono">DATABASE_URL</span> / <span class="font-mono">make up-db</span>'}</p></div>
      <div class="bg-gray-800/40 p-3 rounded border border-gray-700 md:col-span-2"><h4 class="font-semibold text-gray-200"><i class="fa-solid fa-triangle-exclamation mr-2 text-amber-400"></i>Objectifs non encore atteints (honnêteté)</h4><ul class="text-xs text-gray-400 mt-1 list-disc list-inside">${s.notImplemented.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul></div>
    </div>`;
    const auditTable = table([
      { label: 'Seq', key: 'seq', cls: 'font-mono text-gray-500' },
      { label: 'Horodatage', render: (r) => esc(new Date(r.ts).toLocaleString('fr-FR')) },
      { label: 'Action', render: (r) => `<span class="font-semibold ${/REVEAL|ECHEC/.test(r.action) ? 'text-amber-300' : 'text-gray-200'}">${esc(r.action)}</span>` },
      { label: 'Acteur', key: 'actor' },
      { label: 'Rôle', key: 'role' },
      { label: 'Cible', render: (r) => `<span class="font-mono text-gray-400">${esc(r.target || '')}</span>` },
    ], au.events);
    $('view-securite').innerHTML = panel('Posture de sécurité (réelle, sans allégation non implémentée)', posture, 'mb-5')
      + panel('Journal d\'audit inviolable (chaîné + signé ECDSA P-256) — ' + nf.format(s.audit.total) + ' évènements', auditTable);
  }

  async function loadAdmin() {
    const d = await getJSON('/api/v1/config');
    const c = d.config;
    const num = (id, val, step) => `<input id="${id}" type="number" step="${step || 1}" value="${val}" class="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-white text-xs">`;
    const feeRows = Object.entries(c.fees).map(([type, g]) => `<tr class="border-b border-gray-800/40"><td class="p-1.5 font-mono text-gray-300">${esc(type)}</td>
      <td class="p-1.5">${num('fee-' + type + '-pct', g.pct, 0.1)}</td><td class="p-1.5">${num('fee-' + type + '-flat', g.flat)}</td>
      <td class="p-1.5">${num('fee-' + type + '-min', g.min)}</td><td class="p-1.5">${num('fee-' + type + '-cap', g.cap)}</td></tr>`).join('');
    $('view-admin').innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      ${panel('Règles AML / fraude', `<div class="grid grid-cols-2 gap-3 text-xs">
        <label class="text-gray-300">Seuil déclaration (XAF)${num('r-thr', c.rules.reportingThresholdXaf)}</label>
        <label class="text-gray-300">Montant élevé (XAF)${num('r-high', c.rules.highValueXaf)}</label>
        <label class="text-gray-300">Vélocité — max tx${num('r-velc', c.rules.velocity.maxCount)}</label>
        <label class="text-gray-300">Vélocité — fenêtre (min)${num('r-velw', c.rules.velocity.windowMin)}</label>
        <label class="text-gray-300">Fractionnement — nb min${num('r-stc', c.rules.structuring.minCount)}</label>
        <label class="text-gray-300">Transfrontalier — revue (XAF)${num('r-xb', c.rules.crossBorderReviewXaf)}</label>
      </div>`)}
      ${panel('QoS, redevance & cadence', `<div class="grid grid-cols-2 gap-3 text-xs">
        <label class="text-gray-300">Taux succès min (0–1)${num('q-succ', c.qos.minSuccessRate, 0.01)}</label>
        <label class="text-gray-300">Latence max (ms)${num('q-lat', c.qos.maxLatencyMs)}</label>
        <label class="text-gray-300">Taux de redevance (0–1)${num('c-rate', c.contributionRate, 0.001)}</label>
        <label class="text-gray-300">Cadence flux démo (ms)${num('s-int', c.stream.intervalMs)}</label>
      </div>`)}
    </div>
    ${panel('Grilles tarifaires par type (pct %, fixe, min, plafond — XAF)', `<table class="w-full text-xs"><thead><tr class="text-gray-500 text-[10px] uppercase"><th class="p-1.5 text-left">Type</th><th class="p-1.5 text-left">% </th><th class="p-1.5 text-left">Fixe</th><th class="p-1.5 text-left">Min</th><th class="p-1.5 text-left">Plafond</th></tr></thead><tbody>${feeRows}</tbody></table>`, 'mt-5')}
    <div class="flex gap-3 mt-5"><button id="cfg-save" class="bg-emerald-700 hover:bg-emerald-600 text-white rounded px-4 py-2 text-sm font-medium">Enregistrer la configuration</button>
      <button id="cfg-reset" class="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded px-4 py-2 text-sm">Réinitialiser</button>
      <span id="cfg-msg" class="text-sm self-center"></span></div>`;

    $('cfg-save').addEventListener('click', async () => {
      const v = (id) => Number($(id).value);
      const fees = {};
      Object.keys(c.fees).forEach((type) => { fees[type] = { pct: v('fee-' + type + '-pct'), flat: v('fee-' + type + '-flat'), min: v('fee-' + type + '-min'), cap: v('fee-' + type + '-cap') }; });
      const patch = {
        fees, contributionRate: v('c-rate'),
        rules: { reportingThresholdXaf: v('r-thr'), highValueXaf: v('r-high'), crossBorderReviewXaf: v('r-xb'), velocity: { maxCount: v('r-velc'), windowMin: v('r-velw') }, structuring: { minCount: v('r-stc') } },
        qos: { minSuccessRate: v('q-succ'), maxLatencyMs: v('q-lat') },
        stream: { intervalMs: v('s-int') },
      };
      try { await sendJSON('/api/v1/config', 'PUT', patch); $('cfg-msg').innerHTML = '<span class="text-emerald-400">Configuration enregistrée ✓</span>'; }
      catch (e) { $('cfg-msg').innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`; }
    });
    $('cfg-reset').addEventListener('click', async () => { try { await sendJSON('/api/v1/config/reset', 'POST', {}); loadAdmin(); } catch (e) { alert(e.message); } });
  }

  // ---------- Dispatch des modules (réservé ADMIN_SYSTEME) ----------
  let dispatchUserSel = null; // compte sélectionné dans la section individuelle
  let dispatchMsg = '';       // feedback transitoire ré-affiché après re-rendu

  async function putDispatch(path, modules) {
    try {
      await sendJSON(path, 'PUT', { modules });
      dispatchMsg = '<span class="text-emerald-400">Affectation enregistrée ✓</span>';
    } catch (e) {
      dispatchMsg = `<span class="text-red-400">Erreur : ${esc(e.message)}</span>`;
    }
    await loadDispatch(); // re-rendu depuis l'état serveur (source de vérité)
  }

  // Lit l'état des cases d'une ligne : parent coché → ['monitoring'] ; sinon la
  // liste des sous-modules cochés.
  function rowModules(scope, key, parentId) {
    const boxes = [...document.querySelectorAll(`input.${scope}[data-key="${key}"]`)];
    const parent = boxes.find((b) => b.dataset.mod === parentId);
    if (parent && parent.checked) return [parentId];
    return boxes.filter((b) => b.dataset.mod !== parentId && b.checked).map((b) => b.dataset.mod);
  }

  async function loadDispatch() {
    const d = await getJSON('/api/v1/dispatch/state');
    const box = $('view-dispatch');
    if (!d.directions.length) {
      box.innerHTML = panel('Nomenclature absente', '<p class="text-sm text-amber-300">Aucune direction chargée — exécuter <span class="font-mono">npm run import-org</span> puis redémarrer le serveur.</p>');
      return;
    }
    const parent = d.modules[0]; // « monitoring » (seul module top-level à ce stade)
    const leaves = parent.children;
    const expand = (mods) => mods.includes(parent.id) ? leaves.map((m) => m.id) : mods;

    const nothing = d.directions.every((dir) => !dir.modules.length) && d.users.every((u) => !u.individualModules.length);
    const banner = nothing ? `<div class="bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm rounded-lg px-4 py-3 mb-5"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Aucun module dispatché : les utilisateurs ne voient que l'Aide. Cochez des modules ci-dessous.</div>` : '';

    // --- 1. Matrice directions × modules (héritage par tous les membres) ---
    const thCls = 'p-1 align-bottom text-center sticky top-0 bg-gray-900 z-10'; // opaque : les lignes ne transparaissent pas sous l'en-tête
    const th = leaves.map((m) => `<th class="${thCls}"><span class="mod-col" title="${esc(m.label)} — ${esc(m.section)}">${esc(m.id)}</span></th>`).join('');
    const rows = d.directions.map((dir) => {
      const whole = dir.modules.includes(parent.id);
      const cells = leaves.map((m) => {
        const checked = whole || dir.modules.includes(m.id);
        return `<td class="p-1 text-center"><input type="checkbox" class="disp-dir accent-emerald-500" data-key="${esc(dir.code)}" data-mod="${esc(m.id)}" ${checked ? 'checked' : ''} ${whole ? 'disabled' : ''} aria-label="${esc(m.label)} pour ${esc(dir.code)}"></td>`;
      }).join('');
      return `<tr class="border-b border-gray-800/40 hover:bg-gray-800/20">
        <td class="p-2"><span class="font-semibold text-gray-200">${esc(dir.code)}</span><span class="block text-[10px] text-gray-500 max-w-[220px] truncate" title="${esc(dir.nom)}">${esc(dir.nom)}</span><span class="block text-[10px] text-gray-600">${dir.membres.length} compte(s)</span></td>
        <td class="p-1 text-center bg-emerald-900/10 border-x border-gray-800/60"><input type="checkbox" class="disp-dir accent-emerald-400" data-key="${esc(dir.code)}" data-mod="${esc(parent.id)}" ${whole ? 'checked' : ''} aria-label="Monitoring complet pour ${esc(dir.code)}"></td>
        ${cells}</tr>`;
    }).join('');
    const matrix = `<div class="overflow-auto max-h-[55vh]"><table class="w-full text-xs">
      <thead><tr><th class="p-2 text-left text-[10px] uppercase tracking-wider text-gray-500 align-bottom sticky top-0 bg-gray-900 z-10">Direction</th><th class="${thCls}"><span class="mod-col text-emerald-400 font-bold" title="${esc(parent.description)}">Monitoring (tout)</span></th>${th}</tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="text-[11px] text-gray-500 mt-2">Cocher « Monitoring (tout) » affecte les ${leaves.length} sous-modules ; chaque clic enregistre immédiatement la ligne (effet en temps réel, sans reconnexion des agents).</p>`;

    // --- 2. Affectations individuelles (modules hors périmètre de la direction) ---
    if (!dispatchUserSel || !d.users.some((u) => u.username === dispatchUserSel)) dispatchUserSel = d.users[0] && d.users[0].username;
    const groups = {};
    d.users.forEach((u) => { const g = u.direction || 'Hors organigramme (opérateurs)'; (groups[g] = groups[g] || []).push(u); });
    const opts = Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((u) => `<option value="${esc(u.username)}" ${u.username === dispatchUserSel ? 'selected' : ''}>${esc(u.displayName)} (${esc(u.username)})</option>`).join('')}</optgroup>`).join('');
    const sel = d.users.find((u) => u.username === dispatchUserSel);
    let indiv = '<p class="text-xs text-gray-500 italic">Aucun compte.</p>';
    if (sel) {
      const dirEntry = d.directions.find((x) => x.code === sel.direction);
      const inherited = dirEntry ? expand(dirEntry.modules) : [];
      const wholeU = sel.individualModules.includes(parent.id);
      const chips = (list, cls) => list.length ? list.map((m) => `<span class="px-1.5 py-0.5 rounded text-[10px] border ${cls} font-mono">${esc(m)}</span>`).join(' ') : '<span class="text-gray-500 italic text-[11px]">aucun</span>';
      const boxes = [`<label class="flex items-center gap-1.5 text-xs text-emerald-300 font-semibold mr-3"><input type="checkbox" class="disp-user accent-emerald-400" data-key="${esc(sel.username)}" data-mod="${esc(parent.id)}" ${wholeU ? 'checked' : ''}>Monitoring (tout)</label>`]
        .concat(leaves.map((m) => {
          const checked = wholeU || sel.individualModules.includes(m.id);
          return `<label class="flex items-center gap-1.5 text-xs text-gray-300"><input type="checkbox" class="disp-user accent-emerald-500" data-key="${esc(sel.username)}" data-mod="${esc(m.id)}" ${checked ? 'checked' : ''} ${wholeU ? 'disabled' : ''}>${esc(m.id)}</label>`;
        })).join('');
      indiv = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-3">
          <div><p class="text-gray-400 mb-1">Hérités de la direction ${sel.direction ? `<span class="font-mono text-gray-300">${esc(sel.direction)}</span>` : '(aucune)'} :</p>${chips(inherited, 'border-gray-600 text-gray-300 bg-gray-800/50')}</div>
          <div><p class="text-gray-400 mb-1">Effectifs (hérités + individuels) :</p>${chips(sel.effectiveModules, 'border-emerald-500/40 text-emerald-300 bg-emerald-900/20')}</div>
        </div>
        <p class="text-gray-400 text-xs mb-1.5">Affectations individuelles (s'ajoutent à l'héritage) :</p>
        <div class="flex flex-wrap gap-x-4 gap-y-2">${boxes}</div>`;
    }
    const indivPanel = `
      <div class="flex items-center gap-3 mb-4 text-sm">
        <label for="disp-user-sel" class="text-gray-300 text-xs">Compte :</label>
        <select id="disp-user-sel" class="flex-1 max-w-md bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs">${opts}</select>
      </div>${indiv}`;

    // --- 3. Entrées orphelines (nomenclature/comptes disparus) ---
    const orphanList = [...d.orphans.directions.map((c) => `direction « ${esc(c)} »`), ...d.orphans.users.map((u) => `compte « ${esc(u)} »`)];
    const orphans = orphanList.length ? panel('Affectations orphelines', `<p class="text-xs text-amber-300"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Entrées persistées sans correspondance dans la nomenclature (inertes) : ${orphanList.join(', ')}.</p>`, 'mt-5 border border-amber-500/20') : '';

    box.innerHTML = banner
      + `<div class="flex items-center justify-between mb-3"><p class="text-xs text-gray-400">Module parent : <span class="text-emerald-300 font-semibold">${esc(parent.label)}</span> — ${esc(parent.description)}</p><span id="disp-msg" class="text-xs">${dispatchMsg}</span></div>`
      + panel(`Modules par direction (${d.directions.length} entités de l'organigramme ARCEP)`, matrix, 'mb-5')
      + panel('Affectations individuelles par compte', indivPanel)
      + orphans;
    dispatchMsg = '';

    box.querySelectorAll('input.disp-dir').forEach((cb) => cb.addEventListener('change', () => {
      putDispatch(`/api/v1/dispatch/directions/${encodeURIComponent(cb.dataset.key)}`, rowModules('disp-dir', cb.dataset.key, parent.id));
    }));
    box.querySelectorAll('input.disp-user').forEach((cb) => cb.addEventListener('change', () => {
      putDispatch(`/api/v1/dispatch/users/${encodeURIComponent(cb.dataset.key)}`, rowModules('disp-user', cb.dataset.key, parent.id));
    }));
    const selEl = $('disp-user-sel');
    if (selEl) selEl.addEventListener('change', () => { dispatchUserSel = selEl.value; loadDispatch(); });
  }

  async function loadGeo() {
    if (!geoReady) { HubMap.init(); geoReady = true; }
    HubMap.invalidate();
    const d = await getJSON('/api/v1/geo/cells');
    const an = await getJSON('/api/v1/geo/anomalies');
    HubMap.setCells(d.cells);
    if ($('geo-stats')) $('geo-stats').textContent = `Cellules actives : ${d.stats.activeCells}/${d.stats.totalCells} | Anomalies : ${d.stats.anomalies}`;
    const list = an.anomalies.map((a) => `<div class="bg-red-900/15 border border-red-500/25 rounded p-2 mb-2 text-xs">
      <div class="flex justify-between"><span class="text-red-300 font-semibold">${esc(t(a.epoch))}</span><span class="font-mono text-gray-400">${esc(a.msisdnMasked)}</span></div>
      <p class="text-gray-300 mt-1">${esc(a.detail)}</p></div>`).join('') || '<p class="text-xs text-gray-500 italic">Aucune anomalie géographique détectée.</p>';
    $('view-geo').innerHTML = `<h3 class="text-sm font-semibold mb-3 text-gray-200">Anomalies (déplacement impossible)</h3><div class="overflow-auto" style="max-height:60vh">${list}</div>`;
  }

  // ---------- Aide & guide (accessible à tous les profils) ----------
  function loadAide() {
    const mod = (icon, name, txt) => `<div class="bg-gray-800/40 rounded-lg p-3 border border-gray-700/50"><h4 class="font-semibold text-sm text-gray-200"><i class="fa-solid ${icon} mr-2 text-emerald-400"></i>${esc(name)}</h4><p class="text-xs text-gray-400 mt-1">${txt}</p></div>`;
    const myModules = (perms.modules || []).join(', ');
    $('view-aide').innerHTML = `
      ${panel('Qu\'est-ce que SUMo ?', `<p class="text-sm text-gray-300 leading-relaxed">Plateforme de <b>supervision des flux Mobile Money</b> pour le régulateur télécom (modèle inspiré de M3). Les opérateurs poussent leurs transactions (TDR) via des connecteurs ; SUMo les normalise, les scelle dans un registre signé, calcule les statistiques de marché, surveille les revenus et la qualité de service, et détecte la fraude. <span class="text-amber-300">Prototype : données simulées.</span></p>`, 'mb-5')}
      ${panel('Les 13 modules', `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        ${mod('fa-plug', '1-2. Connecteurs / Collecte', 'Ingestion ISO 8583 / JSON / CSV (HMAC), harmonisation vers le modèle TDR, contrôle qualité.')}
        ${mod('fa-link', '3. Registre (lac de données)', 'Chaîne append-only signée ECDSA P-256, vérifiable. MSISDN masqués.')}
        ${mod('fa-chart-pie', '4. Observatoire', 'Volumes, valeurs, parts de marché, séries temps réel, par type/canal.')}
        ${mod('fa-coins', '5. Revenus & redevances', 'Frais perçus vs attendus, écarts (sous-déclaration), redevance due.')}
        ${mod('fa-gauge-high', '6. Qualité de service', 'Taux de succès, latence, codes d\'erreur, manquements aux seuils.')}
        ${mod('fa-user-shield', '7. Antifraude / AML', 'Règles paramétrables : seuil, montant élevé, vélocité, fractionnement, KYC, transfrontalier.')}
        ${mod('fa-folder-open', '8. Investigation', 'Dossiers d\'enquête, traçage de chaînes de transactions (drill-down).')}
        ${mod('fa-map-location-dot', '9. Géolocalisation', 'Corrélation cellule ↔ TDR, déplacement impossible (SIM-box).')}
        ${mod('fa-brain', '10. Analytics / Risque', 'Détection statistique (z-score) et scoring de risque par abonné.')}
        ${mod('fa-file-invoice', '11. Reporting', 'Rapports (observatoire/redevances/QoS/AML) sur période, exports signés.')}
        ${mod('fa-shield-halved', '12. Sécurité & audit', 'Modules dispatchés par direction/compte, journal d\'audit inviolable, minimisation.')}
        ${mod('fa-sliders', '13. Administration', 'Grilles tarifaires, seuils de règles, QoS, redevance — à chaud.')}
      </div>`, 'mb-5')}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        ${panel('Le modèle TDR', `<p class="text-xs text-gray-400 leading-relaxed">Chaque transaction porte : type (P2P, cash-in/out, marchand, airtime, facture, transfrontalier), canal (USSD/STK/App/SMS), montant + devise, frais, statut, opérateur émetteur & récepteur, MSISDN & wallets, agent, cellules réseau, écritures en partie double, message ISO 8583. Le MSISDN n'est jamais affiché en clair sauf accès habilité (antifraude/juridique), toujours <b>journalisé</b>.</p>`)}
        ${panel('Lire l\'interface', `<ul class="text-xs text-gray-400 space-y-1 list-disc list-inside">
          <li>Bandeau orange = <b>démonstration, données simulées</b>.</li>
          <li>Pastille verte en bas du menu = flux temps réel connecté.</li>
          <li>Onglets visibles = modules dispatchés à votre direction ou à votre compte par l'admin système.</li>
          <li>Bouton <i class="fa-solid fa-diagram-project"></i> sur une alerte = tracer le sujet (Investigation).</li>
          <li>Exports : fichiers signés (SHA-256 + ECDSA).</li>
        </ul>`)}
      </div>
      ${panel('Votre profil', `<p class="text-sm text-gray-300">Connecté en tant que <b>${esc(user ? user.displayName : '')}</b>. Modules accessibles : <span class="font-mono text-emerald-300 text-xs">${esc(myModules)}</span>${perms.canReveal ? ' · <span class="text-amber-300">révélation MSISDN autorisée (tracée)</span>' : ''}.</p>`, 'mt-5')}`;
  }

  // NB : « dispatch » est volontairement HORS de REFRESH — le poll de 4 s
  // écraserait l'état des cases à cocher en cours de manipulation.
  // ==========================================================================
  // Module M15 — Gestion des dossiers (moteur de workflow BPM)
  // ==========================================================================
  const STATUT_STYLE = {
    ENREGISTRE: 'bg-sky-500/20 text-sky-300 border-sky-500/30', RECEVABLE: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    INCOMPLET: 'bg-amber-500/20 text-amber-300 border-amber-500/30', SUSPENDU_COMPLEMENT: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    EN_INSTRUCTION: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30', EN_AVIS: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    EN_VALIDATION: 'bg-purple-500/20 text-purple-300 border-purple-500/30', EN_ARBITRAGE_SE: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    EN_DELIBERATION_CR: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    ADOPTE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', PUBLIE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    NOTIFIE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', CLOS: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
    REJETE: 'bg-red-500/20 text-red-300 border-red-500/30', CLASSE_SANS_SUITE: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
    RETIRE: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  };
  const statutBadge = (s) => `<span class="px-2 py-0.5 rounded text-[10px] border font-bold ${STATUT_STYLE[s] || STATUT_STYLE.CLOS}">${esc(s.replace(/_/g, ' '))}</span>`;
  const dDate = (e) => (e ? new Date(e).toISOString().slice(0, 10) : '—');
  // Libellés des actions proposées par le serveur (allowedActions).
  const WF_ACTIONS = {
    COMPLETUDE_OK: ['Prononcer la recevabilité', null],
    COMPLETUDE_KO: ['Demander un complément', { piecesManquantes: ['À préciser dans la demande'] }],
    COMPLEMENT_RECU: ['Complément reçu', { note: 'Complément reçu du demandeur' }],
    CLASSER_SANS_SUITE: ['Classer sans suite', { motif: 'Délai de complément échu' }],
    QUALIFIER: ['Confirmer la qualification', {}],
    TRANSMETTRE_AVIS: ['Transmettre (rapport + avis)', { rapport: 'Rapport d\'instruction versé au dossier' }],
    DEMANDER_COMPLEMENT: ['Suspendre (complément)', { note: 'Complément demandé au demandeur' }],
    RENDRE_AVIS: ['Rendre un avis FAVORABLE', { sens: 'FAVORABLE', motivation: 'Avis favorable' }],
    VISER: ['Viser et transmettre au SE', null],
    DECIDER_SE: ['Décider (SE)', { sens: 'ADOPTE', motivation: 'Décision du Secrétariat Exécutif' }],
    DELIBERER_CR: ['Délibérer (CR) — adoption', { sens: 'ADOPTE', motivation: 'Délibération du Conseil' }],
    RETIRER: ['Retirer le dossier', null],
  };
  let wfSelected = null;

  async function wfAction(id, action) {
    const def = WF_ACTIONS[action];
    try {
      await sendJSON(`/api/v1/workflow/dossiers/${id}/action`, 'POST', { action, params: def && def[1] ? def[1] : {} });
      wfSelected = id;
      await loadWorkflow();
    } catch (e) { alert(e.message); }
  }

  function wfDetailHtml(d) {
    const avis = (d.avis || []).length
      ? `<table class="w-full text-xs mb-3"><thead><tr class="text-gray-500 text-[10px] uppercase"><th class="p-1 text-left">Avis</th><th class="p-1 text-left">Sens</th><th class="p-1 text-left">Motivation</th></tr></thead><tbody>${d.avis.map((a) => `<tr class="border-b border-gray-800/40"><td class="p-1 font-mono text-gray-300">${esc(a.direction)}</td><td class="p-1">${a.statut === 'ATTENDU' ? '<span class="text-amber-300">ATTENDU</span>' : esc(a.statut)}</td><td class="p-1 text-gray-400">${esc(a.motivation || '—')}</td></tr>`).join('')}</tbody></table>` : '';
    const actions = (d.actions || []).map((a) => `<button data-wf-action="${esc(a)}" data-wf-id="${esc(d.id)}" class="bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5 text-xs mr-2 mb-2">${esc((WF_ACTIONS[a] || [a])[0])}</button>`).join('') || '<span class="text-gray-500 text-xs italic">Aucune action pour votre profil au statut courant.</span>';
    const suivi = (d.suivi || []).slice(-12).reverse().map((s) => `<tr class="border-b border-gray-800/40"><td class="p-1 text-gray-500">${esc(dDate(s.epoch))}</td><td class="p-1 font-mono text-gray-400">${esc(s.action)}</td><td class="p-1">${esc(s.de || '—')} → ${esc(s.vers || '—')}</td><td class="p-1 text-gray-400">${esc((s.note || '').slice(0, 90))}</td><td class="p-1 text-gray-500">${esc(s.acteur)}</td></tr>`).join('');
    return `
      <div class="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div><span class="font-mono text-emerald-300 text-sm">${esc(d.numero)}</span> ${statutBadge(d.statut)} ${d.sla.enRetard ? '<span class="px-2 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 font-bold">EN RETARD</span>' : ''}
        <p class="text-sm text-gray-200 mt-1">${esc(d.objet)}</p>
        <p class="text-[11px] text-gray-400 mt-0.5">${esc(d.typeLabel)} · pilote ${esc(d.directionPilote || '—')} · demandeur ${esc((d.demandeur || {}).nom || '—')} · échéance ${esc(dDate(d.sla.echeance))}</p></div>
      </div>
      ${d.decision ? `<p class="text-xs mb-2"><span class="font-bold ${d.decision.sens === 'ADOPTE' ? 'text-emerald-300' : 'text-red-300'}">${esc(d.decision.niveau)} — ${esc(d.decision.sens)}</span> <span class="text-gray-400">· acte signé électroniquement (${esc(d.decision.signature.slice(0, 34))}…)</span></p>` : ''}
      ${avis}
      <div class="mb-3">${actions}</div>
      <p class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Suivi (journal du dossier)</p>
      <div class="overflow-auto max-h-52"><table class="w-full text-xs"><tbody>${suivi}</tbody></table></div>`;
  }

  async function loadWorkflow() {
    const d = await getJSON('/api/v1/workflow');
    const sel = wfSelected ? (d.dossiers.find((x) => x.id === wfSelected) || d.corbeille.find((x) => x.id === wfSelected)) : null;
    const rowsOf = (list) => table([
      { label: 'N°', key: 'numero', cls: 'font-mono text-emerald-300', render: (r) => `<a href="#" data-wf-open="${esc(r.id)}" class="font-mono text-emerald-300 hover:underline">${esc(r.numero)}</a>` },
      { label: 'Type', render: (r) => esc(r.typeLabel) },
      { label: 'Objet', render: (r) => esc(r.objet.slice(0, 60)) },
      { label: 'Pilote', key: 'directionPilote', cls: 'font-mono text-gray-400' },
      { label: 'Statut', render: (r) => statutBadge(r.statut) },
      { label: 'Échéance', render: (r) => `${esc(dDate(r.sla.echeance))}${r.sla.enRetard ? ' <span class="text-red-300 font-bold">⏰</span>' : (r.drapeaux.includes('ALERTE_80') ? ' <span class="text-amber-300">!</span>' : '')}` },
      { label: 'À faire', render: (r) => (r.actions.length ? `<span class="text-emerald-300 font-bold">${r.actions.length} action(s)</span>` : '—') },
    ], list);
    const typeOptions = d.types.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${esc(t.decision)}, ${t.slaJours} j)</option>`).join('');
    $('view-workflow').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        ${kpi('Dossiers en cours', nf.format(d.stats.encours), 'border-t-emerald-500')}
        ${kpi('En retard (SLA échu)', nf.format(d.stats.enRetard), d.stats.enRetard ? 'border-t-red-500' : 'border-t-emerald-500')}
        ${kpi('Ma corbeille (actions dues)', nf.format(d.corbeille.length), 'border-t-sky-500')}
        ${kpi('Délai médian de clôture', d.stats.delaiMedianJours == null ? '—' : d.stats.delaiMedianJours + ' j', 'border-t-indigo-500')}
      </div>
      <div class="mb-4 flex items-end gap-2 flex-wrap">
        <div><label class="text-gray-400 block mb-1 text-[10px] uppercase">Déposer un dossier</label>
          <select id="wf-type" class="bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs">${typeOptions}</select></div>
        <input id="wf-objet" placeholder="Objet du dossier…" class="bg-gray-800 border border-gray-700 rounded p-2 text-white text-xs w-72">
        <button id="wf-deposer" class="bg-emerald-700 hover:bg-emerald-600 text-white rounded px-4 py-2 text-xs font-medium">Déposer (accusé immédiat)</button>
      </div>
      ${sel ? panel('Dossier sélectionné', wfDetailHtml(sel)) : ''}
      <div class="grid grid-cols-1 gap-5 ${sel ? 'mt-5' : ''}">
        ${panel(`Ma corbeille — dossiers attendant MON action (${d.corbeille.length})`, rowsOf(d.corbeille))}
        ${panel(`Dossiers visibles par mon profil (${d.dossiers.length}) — cloisonnement RG-16 appliqué`, rowsOf(d.dossiers))}
      </div>`;
    $('view-workflow').querySelectorAll('[data-wf-open]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); wfSelected = a.dataset.wfOpen; loadWorkflow(); }));
    $('view-workflow').querySelectorAll('[data-wf-action]').forEach((b) => b.addEventListener('click', () => wfAction(b.dataset.wfId, b.dataset.wfAction)));
    const dep = $('wf-deposer');
    if (dep) dep.addEventListener('click', async () => {
      try {
        const r = await sendJSON('/api/v1/workflow/dossiers', 'POST', { typeId: $('wf-type').value, objet: $('wf-objet').value });
        wfSelected = r.dossier.id; await loadWorkflow();
      } catch (e) { alert(e.message); }
    });
  }

  // ==========================================================================
  // Module M14 — Services financiers numériques
  // ==========================================================================
  // Drapeau de confiance (M14/L7) : chaque valeur affichée porte sa source.
  const flagBadge = (f) => {
    const m = {
      MESURE: ['MESURÉ', 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', 'Constaté par sonde indépendante (journal probant signé)'],
      CONTROLE: ['CONTRÔLÉ', 'bg-sky-500/20 text-sky-300 border-sky-500/30', 'Recalculé par la plateforme depuis les données collectées'],
      DECLARE: ['DÉCLARÉ', 'bg-amber-500/20 text-amber-300 border-amber-500/30', 'Transmis par l\'assujetti, non vérifié'],
    };
    const [label, cls, tip] = m[f] || m.DECLARE;
    return `<span class="px-1.5 py-0.5 rounded text-[9px] border ${cls} font-bold align-middle" title="${esc(tip)}">${label}</span>`;
  };
  const pctOrDash = (v) => (v == null ? '—' : (100 * v).toFixed(1) + ' %');

  async function loadMesures() {
    const d = await getJSON('/api/v1/probes');
    const opRows = table([
      { label: 'Opérateur', key: 'name', render: (r) => `<span class="${esc(r.color || '')} font-medium">${esc(r.name)}</span>` },
      { label: 'Succès déclaré (USSD)', render: (r) => `${pctOrDash(r.declared.successRate)} ${flagBadge('DECLARE')}` },
      { label: 'Succès mesuré (USSD)', render: (r) => `${pctOrDash(r.measured.ussdSuccessRate)} ${flagBadge('MESURE')}` },
      { label: 'Écart (pts)', render: (r) => (r.ecartDispoPts == null ? '—' : `<span class="${r.ecartDispoPts >= d.seuils.dispoPts ? 'text-red-300 font-bold' : 'text-gray-300'}">${(100 * r.ecartDispoPts).toFixed(1)}</span>`) },
      { label: 'p95 mesuré', render: (r) => (r.measured.p95LatencyMs == null ? '—' : nf.format(r.measured.p95LatencyMs) + ' ms') },
      { label: 'Constats tarifaires', render: (r) => `${nf.format(r.tarifConstats)} (écarts : <span class="${r.tarifEcarts ? 'text-red-300 font-bold' : 'text-emerald-300'}">${r.tarifEcarts}</span>)` },
      { label: 'Verdict', render: (r) => (r.verdict === 'ECART'
        ? `<span class="px-2 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 font-bold">ÉCART</span>${r.contradictoireId ? ` <span class="text-[10px] text-gray-400 font-mono">${esc(r.contradictoireId)}</span>` : ''}`
        : '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">CONFORME</span>') },
    ], d.byOperator);
    const chRows = table([
      { label: 'Canal', key: 'canal', cls: 'font-mono text-gray-300' },
      { label: 'Mesures', render: (r) => nf.format(r.total) },
      { label: 'Taux de succès', render: (r) => `${pctOrDash(r.successRate)} ${flagBadge('MESURE')}` },
      { label: 'Latence moyenne', render: (r) => (r.avgLatencyMs == null ? '—' : nf.format(r.avgLatencyMs) + ' ms') },
      { label: 'p95', render: (r) => (r.p95LatencyMs == null ? '—' : nf.format(r.p95LatencyMs) + ' ms') },
    ], d.byChannel);
    const contra = table([
      { label: 'Dossier', key: 'caseId', cls: 'font-mono text-emerald-300' },
      { label: 'Objet', key: 'title' },
      { label: 'Statut', render: (r) => `<span class="px-2 py-0.5 rounded text-[10px] border font-bold ${r.status === 'CLOS' ? 'bg-gray-500/20 text-gray-300 border-gray-500/30' : 'bg-red-500/20 text-red-300 border-red-500/30'}">${esc(r.status)}</span>` },
      { label: 'Ouvert le', render: (r) => esc((r.createdAt || '').slice(0, 16).replace('T', ' ')) },
    ], d.contradictoires);
    const j = d.journal;
    $('view-mesures').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        ${kpi('Campagnes exécutées', nf.format(d.campaign.count), 'border-t-emerald-500')}
        ${kpi('Mesures retenues (fenêtre)', nf.format(d.campaign.retained), 'border-t-sky-500')}
        ${kpi('Journal probant (scellés)', nf.format(j.total), 'border-t-indigo-500')}
        ${kpi('Intégrité du journal', j.integrity && j.integrity.valid ? 'VALIDE' : 'ROMPUE', j.integrity && j.integrity.valid ? 'border-t-emerald-500' : 'border-t-red-500')}
      </div>
      <div class="mb-4 flex items-center gap-3 flex-wrap">
        <button id="btn-campagne" class="bg-emerald-700 hover:bg-emerald-600 text-white rounded px-4 py-2 text-sm font-medium"><i class="fa-solid fa-satellite-dish mr-2"></i>Lancer une campagne</button>
        <span class="text-xs text-gray-400">Le mesuré prime sur le déclaré : écart ≥ ${(100 * d.seuils.dispoPts).toFixed(0)} pt de disponibilité (ou constat tarifaire ≠ grille) → procédure contradictoire tracée.</span>
      </div>
      ${panel('Mesuré vs déclaré par opérateur (canal USSD)', opRows)}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
        ${panel('Qualité mesurée par canal', chRows)}
        ${panel('Procédures contradictoires ouvertes (N3)', contra)}
      </div>`;
    const btn = $('btn-campagne');
    if (btn) btn.addEventListener('click', async () => { btn.disabled = true; try { await sendJSON('/api/v1/probes/campaign', 'POST', {}); await loadMesures(); } catch (e) { console.error(e); } });
  }

  async function loadTiers() {
    const d = await getJSON('/api/v1/thirdparty');
    const demRows = table([
      { label: 'Demande', key: 'id', cls: 'font-mono text-gray-300' },
      { label: 'PSP', key: 'psp' },
      { label: 'Hôte', key: 'hostOperatorId', cls: 'font-mono' },
      { label: 'Canal', key: 'canal', cls: 'font-mono text-gray-400' },
      { label: 'J0 → J3 (j)', render: (r) => (r.delaiJ3 == null ? `${nf.format(r.ageJours)} j (en cours)` : nf.format(r.delaiJ3) + ' j') },
      { label: 'Statut', render: (r) => `<span class="px-2 py-0.5 rounded text-[10px] border font-bold ${r.statut === 'EN_SERVICE' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : r.statut === 'REFUSEE' ? 'bg-red-500/20 text-red-300 border-red-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'}">${esc(r.statut)}</span>` },
      { label: 'Délais', render: (r) => (r.depassement ? '<span class="text-red-300 font-bold">DÉPASSÉ</span>' : '<span class="text-emerald-300">OK</span>') },
    ], d.demandes);
    const at04 = table([
      { label: 'Canal', key: 'canal', cls: 'font-mono text-gray-300' },
      { label: 'Wallet maison', render: (r) => `${pctOrDash(r.wallet.successRate)} · p95 ${r.wallet.p95LatencyMs == null ? '—' : nf.format(r.wallet.p95LatencyMs) + ' ms'}` },
      { label: 'Canal PSP', render: (r) => `${pctOrDash(r.psp.successRate)} · p95 ${r.psp.p95LatencyMs == null ? '—' : nf.format(r.psp.p95LatencyMs) + ' ms'}` },
      { label: 'Écart (pts)', render: (r) => (r.ecartPts == null ? '—' : `<span class="${r.discrimination ? 'text-red-300 font-bold' : 'text-gray-300'}">${(100 * r.ecartPts).toFixed(1)}</span> ${flagBadge('MESURE')}`) },
      { label: 'Non-discrimination', render: (r) => (r.discrimination ? '<span class="text-red-300 font-bold">À INSTRUIRE</span>' : '<span class="text-emerald-300">CONFORME</span>') },
    ], d.at04);
    const tarifs = table([
      { label: 'Canal', key: 'canal', cls: 'font-mono text-gray-300' },
      { label: 'Unité', key: 'unite' },
      { label: 'Tarif (XAF)', render: (r) => `${nf.format(r.tarifXaf)} ${flagBadge('DECLARE')}` },
      { label: 'PSP', key: 'psp' },
      { label: 'Observation', render: (r) => (r.signalement ? `<span class="text-amber-300">${esc(r.signalement)}</span>` : '—') },
    ], d.at03);
    const plaintes = table([
      { label: 'Réf.', key: 'id', cls: 'font-mono text-gray-300' },
      { label: 'PSP', key: 'psp' },
      { label: 'Hôte', key: 'hostOperatorId', cls: 'font-mono' },
      { label: 'Objet', key: 'objet' },
      { label: 'Statut', key: 'statut', render: (r) => `<span class="text-amber-300 font-bold">${esc(r.statut)}</span>` },
      { label: 'Échéance instruction', render: (r) => `${nf.format(r.joursRestants)} j` },
    ], d.plaintes);
    $('view-tiers').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        ${kpi('Demandes de raccordement', nf.format(d.at01.demandes), 'border-t-emerald-500')}
        ${kpi('Délai médian J0→J3 (AT-01)', d.at01.delaiMedianJ3 == null ? '—' : nf.format(d.at01.delaiMedianJ3) + ' j', 'border-t-sky-500')}
        ${kpi('En attente > 30 j (AT-02)', nf.format(d.at02.enAttentePlus30j), d.at02.enAttentePlus30j ? 'border-t-amber-500' : 'border-t-emerald-500')}
        ${kpi('Délais dépassés', nf.format(d.at02.depassements), d.at02.depassements ? 'border-t-red-500' : 'border-t-emerald-500')}
      </div>
      ${panel(`Registre des raccordements — jalons réglementaires : accusé ≤ ${d.delaisReglementaires.j1JoursOuvres} j ouvrés · réponse ≤ ${d.delaisReglementaires.j2Jours} j · mise en service ≤ ${d.delaisReglementaires.j3Jours} j`, demRows)}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
        ${panel('AT-04 — Qualité comparée wallet maison vs canal PSP (mêmes cellules de mesure)', at04)}
        ${panel('AT-03 — Conditions tarifaires de gros déclarées', tarifs)}
      </div>
      <div class="mt-5">${panel('Plaintes pour discrimination (instruction L8.3)', plaintes)}</div>`;
  }

  async function loadReclamations() {
    const d = await getJSON('/api/v1/complaints');
    const motifRows = table([
      { label: 'Motif', key: 'label' },
      { label: 'Reçues', render: (r) => nf.format(r.recues) },
      { label: 'Closes', render: (r) => nf.format(r.closes) },
    ], d.byMotif);
    const opRows = table([
      { label: 'Opérateur', render: (r) => `<span class="${esc(r.color || '')} font-medium">${esc(r.name)}</span>` },
      { label: 'Reçues', render: (r) => nf.format(r.recues) },
      { label: 'Liées à un incident', render: (r) => nf.format(r.liees) },
      { label: 'Délai médian (j)', render: (r) => (r.delaiMedianJours == null ? '—' : r.delaiMedianJours) },
    ], d.byOperator);
    const corrRows = table([
      { label: 'Code erreur', key: 'code', cls: 'font-mono text-gray-300' },
      { label: 'Incident', key: 'label' },
      { label: 'Réclamations corrélées', render: (r) => nf.format(r.count) },
    ], d.correlation);
    const recRows = table([
      { label: 'Heure', render: (r) => esc(t(r.epoch)) },
      { label: 'Réf.', key: 'id', cls: 'font-mono text-gray-400' },
      { label: 'Opérateur', key: 'operatorId', cls: 'font-mono' },
      { label: 'Canal', key: 'canal', cls: 'font-mono text-gray-400' },
      { label: 'Province', key: 'province' },
      { label: 'Motif', key: 'motif', cls: 'text-gray-300' },
      { label: 'Incident', render: (r) => (r.lieAIncident ? `<span class="text-red-300 font-mono">${esc(r.errorCode || '')}</span>` : '—') },
      { label: 'Statut', key: 'statut', render: (r) => (r.statut === 'CLOSE' ? '<span class="text-emerald-300">CLOSE</span>' : '<span class="text-amber-300">EN COURS</span>') },
    ], d.recent);
    $('view-reclamations').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        ${kpi('Réclamations reçues', nf.format(d.totals.recues) + ' ' + flagBadge(d.flag), 'border-t-emerald-500')}
        ${kpi('En cours', nf.format(d.totals.enCours), 'border-t-amber-500')}
        ${kpi('Liées à un incident technique', d.totals.tauxLieesIncidentPct + ' %', 'border-t-sky-500')}
        ${kpi('Délai médian de traitement', (d.totals.delaiMedianJours == null ? '—' : d.totals.delaiMedianJours + ' j'), 'border-t-indigo-500')}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        ${panel('Par motif', motifRows)}
        ${panel('Par opérateur', opRows)}
        ${panel('Corrélation aux incidents (codes d\'erreur)', corrRows)}
      </div>
      <div class="mt-5">${panel('Réclamations récentes (MSISDN masqués)', recRows)}</div>`;
  }

  async function loadPostal() {
    const d = await getJSON('/api/v1/postal');
    const provRows = table([
      { label: 'Province', key: 'province' },
      { label: 'Points de service', render: (r) => nf.format(r.points) },
      { label: 'Dont accès financier exclusif', render: (r) => (r.exclusifs ? `<span class="text-emerald-300 font-bold">${nf.format(r.exclusifs)}</span>` : '—') },
    ], d.sp01.parProvince);
    const svcRows = table([
      { label: 'Service', key: 'label' },
      { label: 'Opérations', render: (r) => nf.format(r.count) },
      { label: 'Valeur', render: (r) => xaf(r.sumXaf) + ' XAF' },
    ], d.sp02.parService);
    const dispoRows = table([
      { label: 'Province', key: 'province' },
      { label: 'Disponibilité SI guichets', render: (r) => `${pctOrDash(r.dispoSiPct)} ${flagBadge(r.flag)}` },
      { label: 'Délai médian mandat', render: (r) => r.delaiMedianMandatHeures + ' h' },
    ], d.sp03);
    const exclRows = table([
      { label: 'Localité', key: 'localite' },
      { label: 'Province', key: 'province' },
      { label: 'Bureau', key: 'pointId', cls: 'font-mono text-gray-400' },
    ], d.sp06.localites);
    $('view-postal').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        ${kpi('Points de service financiers', nf.format(d.sp01.points) + ' ' + flagBadge(d.sp01.flag), 'border-t-emerald-500')}
        ${kpi('Contrôlés sur place (mystères)', nf.format(d.sp01.controlesSurPlace), 'border-t-sky-500')}
        ${kpi('Passerelle poste ↔ mobile money', nf.format(d.sp05.count) + ' op.', 'border-t-indigo-500')}
        ${kpi('Localités à accès exclusif (SP-06)', nf.format(d.sp06.localites.length), 'border-t-amber-500')}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        ${panel('SP-01 — Réseau par province (' + esc(d.operateur.name) + ')', provRows)}
        ${panel('SP-02 — Activité par service', svcRows)}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
        ${panel('SP-03/04 — Qualité déclarée par province', dispoRows)}
        ${panel('SP-06 — Contribution au service universel : seul accès financier de la localité', exclRows)}
      </div>`;
  }

  const LOADERS = { observatoire: loadObservatoire, operators: loadOperators, revenus: loadRevenus, qos: loadQos, antifraude: loadAntifraude, investigation: loadInvestigation, analytics: loadAnalytics, connecteurs: loadConnecteurs, registre: loadRegistre, reporting: loadReporting, securite: loadSecurite, admin: loadAdmin, dispatch: loadDispatch, geo: loadGeo, aide: loadAide, mesures: loadMesures, tiers: loadTiers, reclamations: loadReclamations, postal: loadPostal, workflow: loadWorkflow };

  // ==========================================================================
  // Navigation
  // ==========================================================================
  async function switchTab(id) {
    if (id !== 'aide' && !perms.modules.includes(id)) return; // 'aide' accessible à tous
    activeTab = id;
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    const p = $(id); if (p) p.classList.remove('hidden');
    if (TITLES[id]) { $('tab-title').textContent = TITLES[id][0]; $('tab-subtitle').textContent = TITLES[id][1]; }
    document.querySelectorAll('#main-nav [role="tab"]').forEach((b) => {
      const active = b.dataset.tab === id;
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.className = 'nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left ' + (active ? 'bg-emerald-900/20 text-emerald-300 border border-emerald-500/30' : 'text-gray-300 hover:bg-gray-800');
    });
    if (p) p.focus({ preventScroll: true });
    closeSidebarMobile();
    try { if (LOADERS[id]) await LOADERS[id](); } catch (e) { if (e.message !== '401') console.error('load', id, e); }
  }

  function refreshActive() { if (REFRESH.has(activeTab) && LOADERS[activeTab]) LOADERS[activeTab]().catch(() => {}); }

  function applyRbac() {
    document.querySelectorAll('#main-nav [data-tab]').forEach((b) => { b.style.display = (b.dataset.tab === 'aide' || perms.modules.includes(b.dataset.tab)) ? '' : 'none'; });
    // Masque les en-têtes de section sans bouton visible.
    document.querySelectorAll('.nav-head').forEach((h) => {
      let n = h.nextElementSibling; let any = false;
      while (n && n.classList.contains('nav-btn')) { if (n.style.display !== 'none') any = true; n = n.nextElementSibling; }
      h.style.display = any ? '' : 'none';
    });
    // Masque l'en-tête parent « Monitoring » si aucun sous-module n'est affecté.
    const group = $('nav-group-monitoring'); const head = $('nav-parent-monitoring');
    if (group && head) {
      const any = [...group.querySelectorAll('.nav-btn')].some((b) => b.style.display !== 'none');
      head.style.display = any ? '' : 'none';
      group.style.display = any ? '' : 'none';
    }
  }

  function renderUser(u) {
    $('user-name').textContent = u.displayName;
    const labels = { PRESIDENT: 'Président du CR', CONSEILLER: 'Conseiller du CR', CABINET: 'Cabinet', SECRETARIAT_CABINET: 'Secrétariat Cabinet', SE: 'Secrétaire Exécutif', SE_ADJOINT: 'SE Adjoint', DIRECTEUR: 'Directeur', AGENT: 'Agent', ADMIN_SYSTEME: 'Admin Système', OPERATEUR: 'Opérateur' };
    $('user-role').textContent = (labels[u.role] || u.role) + (u.direction ? ' · ' + u.direction : '');
    const w = String(u.displayName).split(/\s+/); $('user-avatar').textContent = ((w[0] && w[0][0]) || 'S') + ((w[1] && w[1][0]) || '');
  }

  // Icône du bouton thème : lune (on est en sombre) / soleil (on est en clair).
  function renderThemeIcon() {
    const i = document.querySelector('#btn-theme i');
    if (i) i.className = 'fa-solid ' + (SumoTheme.get() === 'light' ? 'fa-sun' : 'fa-moon');
  }

  async function logout() { try { await fetch('/api/v1/auth/logout', { method: 'POST' }); } catch { /* */ } location.href = '/login.html'; }
  function toggleSidebar() { document.querySelector('aside').classList.toggle('-translate-x-full'); }
  function closeSidebarMobile() { if (window.innerWidth < 768) document.querySelector('aside').classList.add('-translate-x-full'); }

  async function bootstrap() {
    let me;
    try { me = await getJSON('/api/v1/auth/me'); } catch { return; }
    user = me.user; perms = user.permissions || perms;
    renderUser(user); applyRbac();
    clockTick(); setInterval(clockTick, 1000);
    connect();
    setInterval(refreshActive, 4000);
    document.querySelectorAll('#main-nav [data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    if ($('btn-burger')) $('btn-burger').addEventListener('click', toggleSidebar);
    if ($('btn-logout')) $('btn-logout').addEventListener('click', logout);
    if ($('btn-theme')) { $('btn-theme').addEventListener('click', () => SumoTheme.toggle()); renderThemeIcon(); }
    // Bascule de thème : recolore les graphiques vivants et le fond de carte.
    document.addEventListener('sumo:theme', () => { renderThemeIcon(); HubCharts.applyTheme(); HubMap.applyTheme(); });
    // Repli sur l'aide si aucun module n'est affecté (sinon le panneau
    // observatoire, visible par défaut dans le HTML, pollerait en 403).
    const first = perms.modules[0] || 'aide';
    switchTab(first);
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
  window.SUMo = { switchTab };
})();
