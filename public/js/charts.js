'use strict';

// Graphiques (Chart.js auto-hébergé). Exposé en global pour app.js.
window.HubCharts = (function () {
  let fluxChart = null;
  let ecoChart = null;
  let barChart = null;

  const COLOR = { Banque: '#3b82f6', MoMo: '#10b981', Microfinance: '#a855f7', Passerelle: '#9ca3af' };

  function init(operators) {
    Chart.defaults.color = '#9ca3af';
    Chart.defaults.font.family = 'Inter';

    fluxChart = new Chart(document.getElementById('fluxChart'), {
      type: 'line',
      data: {
        labels: Array.from({ length: 12 }, () => ''),
        datasets: [{
          label: 'Débit instantané (XAF)',
          data: Array.from({ length: 12 }, () => 0),
          borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)',
          borderWidth: 2, tension: 0.4, fill: true, pointRadius: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } },
      },
    });

    ecoChart = new Chart(document.getElementById('ecosystemChart'), {
      type: 'doughnut',
      data: {
        labels: ['Banques', 'Mobile Money', 'Microfinance', 'Passerelles'],
        datasets: [{ data: [0, 0, 0, 0], backgroundColor: [COLOR.Banque, COLOR.MoMo, COLOR.Microfinance, COLOR.Passerelle], borderWidth: 0 }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', animation: false, plugins: { legend: { position: 'bottom', labels: { padding: 10, usePointStyle: true } } } },
    });

    barChart = new Chart(document.getElementById('barChart'), {
      type: 'bar',
      data: {
        labels: operators.map((o) => o.name),
        datasets: [{ label: 'Volume cumulé (XAF)', data: operators.map(() => 0), backgroundColor: operators.map((o) => COLOR[o.type] || '#9ca3af'), borderRadius: 4 }],
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { font: { size: 9 } }, grid: { display: false } } } },
    });
  }

  function pushFlux(amount) {
    if (!fluxChart) return;
    const d = fluxChart.data.datasets[0].data;
    d.push(amount); d.shift();
    fluxChart.update('none');
  }

  function setEco(totals) {
    if (!ecoChart) return;
    ecoChart.data.datasets[0].data = [totals.Banque || 0, totals.MoMo || 0, totals.Microfinance || 0, totals.Passerelle || 0];
    ecoChart.update('none');
  }

  function setBar(operators, volById) {
    if (!barChart) return;
    barChart.data.datasets[0].data = operators.map((o) => volById[o.id] || 0);
    barChart.update('none');
  }

  return { init, pushFlux, setEco, setBar };
})();
