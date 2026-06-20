'use strict';

// Page de connexion SUMo : connexion classique (identifiant + mot de passe) et
// accès démonstration « un clic » (gated côté serveur par demoLogin). Aucune donnée
// sensible n'est manipulée ici ; les sessions sont posées en cookie HttpOnly.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await r.json(); } catch { /* corps non-JSON */ }
    return { ok: r.ok, status: r.status, data };
  }

  function showError(msg) {
    const e = $('login-error');
    if (e) { e.textContent = msg; e.classList.remove('hidden'); }
  }

  function goHome() { location.href = '/'; }

  async function doLogin(ev) {
    ev.preventDefault();
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) return showError('Identifiant et mot de passe requis.');
    const { ok, data } = await postJson('/api/v1/auth/login', { username, password });
    if (ok) return goHome();
    showError(data.error || 'Identifiants invalides.');
  }

  async function demoLogin(username) {
    const { ok, data } = await postJson('/api/v1/auth/demo', { username });
    if (ok) return goHome();
    showError(data.error || 'Accès démo indisponible.');
  }

  const ROLE_META = {
    REGULATEUR: { border: 'border-emerald-500/40 hover:bg-emerald-900/20', badge: 'text-emerald-300' },
    OBSERVATOIRE: { border: 'border-emerald-500/30 hover:bg-emerald-900/15', badge: 'text-emerald-300' },
    REVENUS: { border: 'border-amber-500/40 hover:bg-amber-900/20', badge: 'text-amber-300' },
    QOS: { border: 'border-sky-500/40 hover:bg-sky-900/20', badge: 'text-sky-300' },
    ANTIFRAUDE: { border: 'border-red-500/40 hover:bg-red-900/20', badge: 'text-red-300' },
    JURIDIQUE: { border: 'border-indigo-500/40 hover:bg-indigo-900/20', badge: 'text-indigo-300' },
    CONSO: { border: 'border-teal-500/40 hover:bg-teal-900/20', badge: 'text-teal-300' },
    ADMIN: { border: 'border-purple-500/40 hover:bg-purple-900/20', badge: 'text-purple-300' },
    AUDITEUR: { border: 'border-slate-500/40 hover:bg-slate-800/40', badge: 'text-slate-300' },
    OPERATEUR: { border: 'border-gray-700 hover:bg-gray-800/60', badge: 'text-blue-300' },
  };

  const CAT_ORDER = ['Régulateur (corps de métier)', 'Opérateurs Mobile Money'];

  function renderAccounts(payload) {
    const panel = $('demo-panel');
    if (!panel) return;
    if (!payload.demoLogin || !Array.isArray(payload.accounts) || !payload.accounts.length) return;
    panel.classList.remove('hidden');
    if (payload.password && $('demo-pass')) $('demo-pass').textContent = payload.password;

    const groups = {};
    payload.accounts.forEach((a) => { (groups[a.category] = groups[a.category] || []).push(a); });
    const cats = Object.keys(groups).sort((a, b) => {
      const ia = CAT_ORDER.indexOf(a); const ib = CAT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    const container = $('demo-accounts');
    container.innerHTML = '';
    cats.forEach((cat) => {
      let html = `<p class="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mt-4 mb-2 first:mt-0">${esc(cat)}</p><div class="grid grid-cols-1 sm:grid-cols-2 gap-2">`;
      groups[cat].forEach((a) => {
        const meta = ROLE_META[a.role] || ROLE_META.OPERATEUR;
        html += `<button type="button" data-username="${esc(a.username)}" class="demo-btn text-left flex items-center gap-3 p-3 rounded-lg border ${meta.border} bg-gray-900/40 transition">
          <span class="w-8 h-8 shrink-0 rounded ${esc(a.bg || 'bg-emerald-700')} flex items-center justify-center text-white"><i class="fa-solid ${esc(a.icon || 'fa-user')}" aria-hidden="true"></i></span>
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-gray-100 truncate">${esc(a.displayName)}</span>
            <span class="block text-[11px] ${meta.badge} truncate">${esc(a.title)}</span>
          </span>
        </button>`;
      });
      html += '</div>';
      container.insertAdjacentHTML('beforeend', html);
    });

    container.querySelectorAll('.demo-btn').forEach((b) => b.addEventListener('click', () => demoLogin(b.dataset.username)));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if ($('login-form')) $('login-form').addEventListener('submit', doLogin);

    // Déjà authentifié ? On va directement à l'espace de travail.
    try {
      const me = await fetch('/api/v1/auth/me');
      if (me.ok) return goHome();
    } catch { /* ignore */ }

    try {
      const r = await fetch('/api/v1/auth/accounts');
      renderAccounts(await r.json());
    } catch { /* ignore */ }
  });
})();
