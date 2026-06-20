'use strict';

// Graphiques (Chart.js auto-hébergé). Exposé en global pour app.js et les modules.
window.HubCharts = (function () {
  const COLOR = ['#10b981', '#3b82f6', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16'];
  let flux = null; let share = null; let typeC = null; let channelC = null;
  const adhoc = {}; // graphiques de module par id de canvas

  function baseDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = '#9ca3af';
    Chart.defaults.font.family = 'Inter';
  }

  function initDashboard() {
    baseDefaults();
    const fc = document.getElementById('fluxChart');
    if (fc && !flux) {
      flux = new Chart(fc, {
        type: 'line',
        data: { labels: Array.from({ length: 20 }, () => ''), datasets: [{ label: 'Volume/min', data: Array.from({ length: 20 }, () => 0), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', borderWidth: 2, tension: 0.4, fill: true, pointRadius: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } } },
      });
    }
    const sc = document.getElementById('shareChart');
    if (sc && !share) {
      share = new Chart(sc, { type: 'doughnut', data: { labels: [], datasets: [{ data: [], backgroundColor: COLOR, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '68%', animation: false, plugins: { legend: { position: 'bottom', labels: { padding: 8, usePointStyle: true, font: { size: 10 } } } } } });
    }
    const tc = document.getElementById('typeChart');
    if (tc && !typeC) typeC = barChart(tc, '#3b82f6');
    const cc = document.getElementById('channelChart');
    if (cc && !channelC) channelC = barChart(cc, '#a855f7');
  }

  function barChart(el, color) {
    return new Chart(el, {
      type: 'bar',
      data: { labels: [], datasets: [{ data: [], backgroundColor: color, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { font: { size: 9 } }, grid: { display: false } } } },
    });
  }

  function pushFlux(series) {
    if (!flux || !series) return;
    flux.data.labels = series.map(() => '');
    flux.data.datasets[0].data = series.map((p) => p.sumXaf);
    flux.update('none');
  }
  function setShare(byOperator) {
    if (!share) return;
    share.data.labels = byOperator.map((o) => o.name);
    share.data.datasets[0].data = byOperator.map((o) => o.sumXaf);
    share.update('none');
  }
  function setType(byType) {
    if (!typeC) return;
    typeC.data.labels = byType.map((t) => t.label || t.key);
    typeC.data.datasets[0].data = byType.map((t) => t.sumXaf);
    typeC.update('none');
  }
  function setChannel(byChannel) {
    if (!channelC) return;
    channelC.data.labels = byChannel.map((c) => c.key);
    channelC.data.datasets[0].data = byChannel.map((c) => c.sumXaf);
    channelC.update('none');
  }

  // Graphique ad hoc pour un module (barres). Crée ou met à jour par id de canvas.
  function moduleBar(canvasId, labels, data, color) {
    baseDefaults();
    const el = document.getElementById(canvasId);
    if (!el) return;
    if (adhoc[canvasId]) { adhoc[canvasId].destroy(); delete adhoc[canvasId]; }
    adhoc[canvasId] = new Chart(el, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: color || COLOR, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { font: { size: 9 } }, grid: { display: false } } } },
    });
  }

  return { COLOR, initDashboard, pushFlux, setShare, setType, setChannel, moduleBar };
})();
