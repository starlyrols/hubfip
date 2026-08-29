'use strict';

// =============================================================================
// Correctifs P0 n°8 (internalisation des ressources front) et n°10 (encadrement
// du tunnel de démonstration).
//
// Ces deux constats se recoupent : ils portent tous deux sur ce que la plateforme
// LAISSE SORTIR — vers un CDN étranger d'un côté, vers Internet de l'autre.
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-souv-'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
require('../lib/audit').init();
const { createApp } = require('../lib/createApp');

const RACINE = path.resolve(__dirname, '..');
const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// Adresse publique arbitraire : reproduit un appel arrivant par le tunnel.
const DISTANT = { 'X-Forwarded-For': '41.158.20.7' };

// ---------------------------------------------------------------------------
// P0 n°8 — plus rien ne part vers un tiers
// ---------------------------------------------------------------------------
test('P0-8 : aucun fichier du front ne référence une origine externe', () => {
  const racineFront = path.join(RACINE, 'public');
  const fichiers = [];
  (function parcourir(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (/\.(html|css|js)$/.test(e.name)) fichiers.push(p);
    }
  }(racineFront));
  assert.ok(fichiers.length >= 6, 'les fichiers du front sont bien inspectés');

  const fautifs = [];
  for (const f of fichiers) {
    const contenu = fs.readFileSync(f, 'utf8');
    // On cherche des RÉFÉRENCES chargées (src/href/url/@import), pas les URL
    // citées en commentaire.
    const refs = contenu.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)]+|@import\s+url\(\s*["']?https?:\/\/[^)]+/gi) || [];
    if (refs.length) fautifs.push(`${path.relative(RACINE, f)} → ${refs[0]}`);
  }
  assert.deepEqual(fautifs, [], 'la console doit fonctionner sur un site isolé');
});

test('P0-8 : la CSP servie ne porte plus ni unsafe-eval ni origine tierce', async () => {
  const s = await listen(createApp({ serveStatic: true }));
  const r = await fetch(base(s) + '/login.html');
  const csp = r.headers.get('content-security-policy') || '';

  assert.ok(csp.includes("script-src 'self'"), 'script-src doit être restreint à l\'origine propre');
  assert.ok(!csp.includes('unsafe-eval'), 'unsafe-eval était imposé par le compilateur Tailwind du navigateur');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'aucun script inline autorisé');
  for (const hote of ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cartocdn.com']) {
    assert.ok(!csp.includes(hote), `${hote} ne doit plus figurer dans la CSP`);
  }
  // style-src conserve 'unsafe-inline' : Leaflet positionne ses couches par
  // attribut style. C'est un choix documenté, pas un oubli.
  assert.ok(/style-src[^;]*'unsafe-inline'/.test(csp));
  s.close();
});

test('P0-8 : les ressources sont servies par la plateforme elle-même', async () => {
  const s = await listen(createApp({ serveStatic: true }));
  for (const chemin of [
    '/css/tailwind.css',
    '/vendor/fontawesome/css/all.min.css',
    '/vendor/fontawesome/webfonts/fa-solid-900.woff2',
    '/vendor/inter/inter-latin-400-normal.woff2',
    '/vendor/leaflet/leaflet.css',
    '/js/nav.js',
  ]) {
    const r = await fetch(base(s) + chemin);
    assert.equal(r.status, 200, `${chemin} doit être servi localement`);
  }
  s.close();
});

// La feuille est un ARTEFACT COMPILÉ versionné : le danger propre à ce choix est
// la dérive — une classe ajoutée au gabarit sans régénération, et la mise en page
// casse en production sans que rien ne le signale. Ce test confronte donc TOUTES
// les classes employées à ce que les feuilles servies couvrent réellement.
test('P0-8 : les feuilles servies couvrent toutes les classes employées (garde anti-dérive)', () => {
  const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8');
  const utilitaires = lire('public', 'css', 'tailwind.css');
  const fontAwesome = lire('node_modules', '@fortawesome', 'fontawesome-free', 'css', 'all.min.css');

  const html = { 'index.html': lire('public', 'index.html'), 'login.html': lire('public', 'login.html') };
  const jsFiles = fs.readdirSync(path.join(RACINE, 'public', 'js'));

  // Classes MAISON : celles définies par le thème, par les blocs <style> des
  // gabarits, ou servant de simple point d'accroche au script (aucun style propre).
  const declarees = new Set();
  const recolter = (css) => { for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) declarees.add(m[1]); };
  recolter(lire('public', 'css', 'theme.css'));
  for (const contenu of Object.values(html)) {
    for (const bloc of contenu.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) recolter(bloc[1]);
  }
  // Marqueurs sémantiques sans style propre : leur apparence vient des utilitaires
  // posés à côté d'eux dans le même attribut.
  const ACCROCHES = new Set(['nav-btn', 'nav-head']);

  // Tokens candidats : ce qui a la FORME d'un utilitaire. Les gabarits construisent
  // des classes par interpolation (`class="${cond ? 'a' : 'b'}"`), ce qui laisse
  // traîner des fragments de code dans l'attribut — ils ne sont pas des classes.
  const FORME_UTILITAIRE = /^([a-z0-9-]+:)*-?[a-z][a-z0-9-]*(\/[0-9.]+)?(\[[^\]]+\])?$/;

  const employees = new Set();
  const sources = [...Object.values(html), ...jsFiles.map((f) => lire('public', 'js', f))];
  for (const contenu of sources) {
    for (const m of contenu.matchAll(/class=["'`]([^"'`]+)["'`]/g)) {
      for (const t of m[1].split(/\s+/)) {
        if (!t || t.includes('$') || t.includes('{') || t.includes('}')) continue;
        if (!FORME_UTILITAIRE.test(t)) continue;
        if (declarees.has(t)) continue;
        employees.add(t);
      }
    }
  }
  assert.ok(employees.size > 150, `inventaire des classes trop maigre (${employees.size})`);

  // Échappement Tailwind : « : » « / » « . » « [ » « ] » « ( » « ) » « % ».
  const selecteur = (c) => '.' + c.replace(/[:/.[\]()%]/g, (ch) => '\\' + ch);
  const icones = [...employees].filter((c) => /^fa[-srb]?($|-)/.test(c));
  const autres = [...employees].filter((c) => !/^fa[-srb]?($|-)/.test(c));

  // Les icônes doivent être couvertes par la feuille Font Awesome LOCALE.
  const iconesAbsentes = icones.filter((c) => !fontAwesome.includes(selecteur(c)));
  assert.deepEqual(iconesAbsentes, [], 'icônes absentes du paquet Font Awesome auto-hébergé');
  assert.ok(icones.length > 20, `couverture d'icônes anormalement faible (${icones.length})`);

  // Une classe absente des feuilles n'est un défaut que si elle n'est pas un simple
  // point d'accroche : soit le script la cible comme sélecteur, soit elle ne sert
  // qu'à marquer sémantiquement un élément dont l'apparence vient des utilitaires.
  const estAccroche = (c) => ACCROCHES.has(c)
    || sources.some((src) => [`'${c}'`, `"${c}"`, `'.${c}'`, `".${c}"`, `'#${c}'`, `"#${c}"`].some((f) => src.includes(f)));
  const absentes = autres.filter((c) => !utilitaires.includes(selecteur(c)) && !estAccroche(c));
  assert.deepEqual(absentes, [], 'classes employées mais absentes de la feuille : régénérez avec « npm run build-css »');

  assert.ok(utilitaires.includes('@font-face'), 'la police doit être déclarée localement');
  assert.ok(!/url\(["']?https?:\/\//.test(utilitaires), 'aucune ressource distante dans la feuille');
});

test('P0-8 : un serveur de tuiles configuré est la SEULE origine externe admise', async () => {
  const s = await listen(createApp({ serveStatic: true, tileUrl: 'https://tuiles.arcep.ga/{z}/{x}/{y}.png' }));
  const csp = (await fetch(base(s) + '/login.html')).headers.get('content-security-policy') || '';
  assert.ok(csp.includes('https://tuiles.arcep.ga'), 'l\'origine désignée par l\'exploitant est admise');
  assert.ok(!csp.includes('cartocdn'), 'aucun fournisseur par défaut ne revient');
  s.close();
});

// ---------------------------------------------------------------------------
// P0 n°10 — les commodités de démonstration ne franchissent pas le tunnel
// ---------------------------------------------------------------------------
test('P0-10 : la connexion « un clic » est refusée à un appelant distant', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false, behindTlsProxy: true }));

  const distant = await fetch(base(s) + '/api/v1/auth/demo', {
    method: 'POST', headers: { 'content-type': 'application/json', ...DISTANT },
    body: JSON.stringify({ username: 'pcr' }),
  });
  assert.equal(distant.status, 403, 'un lien public ne doit pas ouvrir la présidence sans mot de passe');

  const local = await fetch(base(s) + '/api/v1/auth/demo', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'pcr' }),
  });
  assert.equal(local.status, 200, 'la commodité reste disponible en local');
  s.close();
});

test('P0-10 : l\'organigramme et le mot de passe commun ne sortent pas', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false, behindTlsProxy: true }));

  const distant = await (await fetch(base(s) + '/api/v1/auth/accounts', { headers: DISTANT })).json();
  assert.equal(distant.demoLogin, false);
  assert.equal(distant.password, undefined, 'le mot de passe commun ne doit jamais transiter');
  assert.deepEqual(distant.accounts, [], 'l\'organigramme nominatif de l\'autorité reste interne');
  assert.match(distant.note, /appels locaux/);

  const local = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(local.demoLogin, true);
  assert.ok(local.accounts.length > 0, 'en local, le catalogue reste servi');
  s.close();
});

test('P0-10 : le mode production ferme la démonstration, même en local', async () => {
  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'pcr' }),
  });
  assert.equal(r.status, 403);
  const cat = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(cat.demoLogin, false);
  assert.deepEqual(cat.accounts, []);
  s.close();
});

test('P0-10 : le script de tunnel impose la production et protège le registre', () => {
  const sh = fs.readFileSync(path.join(RACINE, 'scripts', 'demo-tunnel.sh'), 'utf8');
  assert.match(sh, /NODE_ENV=production/, 'le tunnel ne doit plus publier une instance de développement');
  assert.match(sh, /REFUS[\s\S]*registre d'exploitation/, 'refus explicite de tourner sur le registre réel');
  assert.ok(!/SUMO_DEMO_LOGIN_UNSAFE/.test(sh), 'le script ne doit pas lever lui-même la restriction');
});

test('P0-8 : le tracé du Gabon est embarqué, fermé, dense et géographiquement plausible', () => {
  const src = fs.readFileSync(path.join(RACINE, 'public', 'js', 'gabon-frontieres.js'), 'utf8');

  // Aucune requête externe : le tracé est une donnée locale, pas un service.
  assert.ok(!/https?:\/\//.test(src), 'un fichier de frontières chargé chez un tiers révélerait la consultation');
  // La mention d'indicativité doit exister : ce tracé ne fait pas foi.
  assert.match(src, /à titre indicatif/);
  // Traçabilité de la donnée : le fichier dit d'où il vient et qu'il est généré.
  assert.match(src, /Natural Earth/);
  assert.match(src, /build-frontieres/);

  const points = [...src.matchAll(/\[(-?\d+\.\d+), (-?\d+\.\d+)\]/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  // Données réelles (10 m simplifié ~400 m) : la densité fait partie du contrat —
  // un retour au tracé grossier dessiné à la main ferait échouer ce seuil.
  assert.ok(points.length >= 500, `tracé trop grossier pour être « représentatif » (${points.length} sommets)`);
  assert.deepEqual(points[0], points[points.length - 1], 'le contour doit être fermé');

  // Plausibilité : tous les sommets dans l'emprise nationale, et les jalons
  // connus à moins de 0,3° de leur position réelle.
  for (const [lat, lng] of points) {
    assert.ok(lat >= -4.1 && lat <= 2.4 && lng >= 8.6 && lng <= 14.6, `sommet hors emprise : [${lat}, ${lng}]`);
  }
  const proche = (lat, lng, tol = 0.3) => points.some(([a, b]) => Math.abs(a - lat) < tol && Math.abs(b - lng) < tol);
  assert.ok(proche(0.39, 9.45), 'l\'estuaire de Libreville doit border le tracé');
  assert.ok(proche(-0.72, 8.78), 'la pointe de Port-Gentil doit marquer l\'ouest du tracé');
  assert.ok(proche(-3.93, 11.13), 'le débouché de la frontière congolaise doit fermer la côte au sud');
  // Jalons fins, atteignables seulement avec des données réelles.
  assert.ok(proche(2.32, 11.6, 0.15), 'la frontière camerounaise doit longer ~2°19′ N');
  assert.ok(proche(1.0, 11.33, 0.15), 'le tripoint de la Guinée équatoriale doit être posé');

  // Et la page le charge AVANT la carte.
  const html = fs.readFileSync(path.join(RACINE, 'public', 'index.html'), 'utf8');
  const iFront = html.indexOf('gabon-frontieres.js');
  const iMap = html.indexOf('/js/map.js');
  assert.ok(iFront > -1 && iFront < iMap, 'gabon-frontieres.js doit précéder map.js');
});

test('P0-8 : la sous-région d\'Afrique centrale est embarquée pour l\'orientation', () => {
  const src = fs.readFileSync(path.join(RACINE, 'public', 'js', 'frontieres-afrique-centrale.js'), 'utf8');
  assert.ok(!/https?:\/\//.test(src), 'le voisinage suit la même règle : aucune requête externe');

  // Le voisinage CEEAC visible depuis l'emprise doit y être.
  for (const pays of ['CAMEROUN', 'GUINÉE ÉQUATORIALE', 'CONGO', 'RD CONGO', 'ANGOLA', 'SÃO TOMÉ']) {
    assert.ok(src.includes(pays), `voisin manquant : ${pays}`);
  }
  const points = [...src.matchAll(/\[(-?\d+\.\d+), (-?\d+\.\d+)\]/g)];
  assert.ok(points.length >= 200, `voisinage trop grossier (${points.length} sommets)`);

  const html = fs.readFileSync(path.join(RACINE, 'public', 'index.html'), 'utf8');
  const iSr = html.indexOf('frontieres-afrique-centrale.js');
  const iMap = html.indexOf('/js/map.js');
  assert.ok(iSr > -1 && iSr < iMap, 'frontieres-afrique-centrale.js doit précéder map.js');
});

after(() => require('../lib/scanner').close());
