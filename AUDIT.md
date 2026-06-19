# Audit approfondi — HuBFIP (Plateforme Nationale de Monitoring Financier)

**Date :** 19 juin 2026
**Périmètre :** `server.js`, `public/index.html`, `public/js/{app,charts,map}.js`, `package.json`
**Méthode :** 6 auditeurs spécialisés (architecture, sécurité applicative, sécurité réseau/infra, logique métier, système/DevOps, frontend/UX) + vérification adversariale de chaque constat par relecture du code réel + critique de complétude. 51 constats, tous vérifiés.

---

## 1. Verdict global

> **HuBFIP n'est pas une plateforme de supervision financière fonctionnelle : c'est une maquette de démonstration purement front-end.**

L'application réellement exécutée est intégralement contenue dans un script *inline* (`index.html:407-857`). Elle **fabrique toutes ses données côté navigateur avec `Math.random()`**, toutes les 1,5 s. Aucune banque, Mobile Money ou EMF n'est connectée ; aucune donnée réelle n'est ingérée.

Trois faits structurants, **confirmés indépendamment par les 6 dimensions d'audit** (confiance haute) :

1. **Le serveur est inerte vis-à-vis de l'UI.** Le serveur WebSocket et l'endpoint `POST /api/v1/iso8583` (`server.js:72-104`) ne sont **jamais** consommés. `server.js` ne sert en pratique qu'à héberger les fichiers statiques (`express.static`, `server.js:14`).
2. **`public/js/app.js`, `charts.js`, `map.js` sont du code mort.** Aucune balise `<script src>` ne les charge (`index.html` ne charge que 3 CDN : Tailwind l.7, Chart.js l.8, Leaflet l.11). Ils constituent une **seconde implémentation divergente**, jamais exécutée (~409 lignes).
3. **Toutes les garanties de sécurité affichées sont du texte décoratif.** mTLS, AES-256-GCM, PKI souveraine « ECDSA P-384 / post-quantique », horodatage RFC 3161, registre immuable non-répudiable, ISO 8583, ISO 27001, Zero-Trust, SLA 99.99 % : **aucune** n'a la moindre implémentation. Le serveur écoute en **HTTP clair** (`http.createServer`, `server.js:8`).

**Le risque dominant est non technique :** l'application se présente comme une **infrastructure souveraine officielle** (CA « O=Gouvernement Gabonais, C=GA », marques de banques réelles, mentions COBAC/ISO 27001) alors qu'elle ne capte rien. Présentée telle quelle à un régulateur (BEAC/COBAC), à un décideur ou au public, elle constitue une **représentation trompeuse** des capacités, doublée d'un **risque juridique** (usurpation de marques et d'identité étatique).

### Décision préalable à toute action

Avant tout correctif, **trancher la nature du produit** :
- **Option A — Assumer la maquette/démo** : afficher en permanence « DÉMONSTRATION — données fictives », retirer les allégations de sécurité/conformité et l'identité étatique, supprimer le code mort. *(Effort faible, supprime le risque de tromperie.)*
- **Option B — Viser une vraie plateforme** : c'est un projet à reconstruire (ingestion réelle, auth, crypto, persistance, conformité). L'existant sert de prototype d'IHM. *(Effort majeur ; la quasi-totalité des recommandations « production » ci-dessous s'appliquent.)*

---

## 2. Tableau de bord des constats

| Gravité (après vérification) | Nombre | Nature |
|---|---|---|
| 🔴 **Critique** | 3 thèmes | Maquette présentée comme opérationnelle ; sécurité fictive ; usurpation marques/État |
| 🟠 **Élevé** | ~7 | HTTP clair, CDN sans SRI, absence anti-DoS, aucune persistance, KPIs inventés, exports factices, ISO 8583 absent |
| 🟡 **Moyen** | ~12 | Bug UBA, référentiels divergents, en-têtes HTTP, filtre dates ignoré, hors-git, pas de tests, accessibilité, modèle financier… |
| 🔵 **Faible / Info** | ~14 | Responsive, code mort résiduel, timezone, `.gitignore`, etc. |
| 🟣 **Latent** (code vulnérable mais non atteignable en l'état) | 4 | XSS DOM, endpoint non authentifié, CSWSH, `JSON.parse` sans garde |

> **Note sur les « latents » :** plusieurs failles classiques (XSS, injection, absence d'auth) existent réellement dans le code, mais dans des fichiers **morts** ou via un endpoint **sans consommateur**. Elles ne sont **pas exploitables aujourd'hui** — mais le deviendraient **immédiatement** si l'on rebranchait `app.js` sur le flux serveur. À corriger **avant** tout câblage réel.

---

## 3. Architecture & implémentation

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| ARCH-1 | `js/app.js`, `charts.js`, `map.js` jamais chargés → code mort, piège de maintenance | Moyen | `index.html:7-11` |
| ARCH-2 | WebSocket serveur + `/api/v1/iso8583` jamais consommés par l'UI | Critique | `server.js:72-104` |
| ARCH-3 | Données = simulation pseudo-aléatoire côté client | Élevé | `index.html:618-692, 847` |
| ARCH-4/5 | **Deux implémentations concurrentes** (2× `OPERATORS`, 2× `switchTab`, 2× rendu/carte) | Moyen | `server.js:17-31` vs `index.html:410-435` |
| ARCH-6 | `getContext('2style')` invalide (devrait être `'2d'`) — symptôme de code jamais exécuté | Info | `charts.js:9` |

**Problème de fond :** il existe **deux produits** dans le dépôt. Le « vrai » (serveur WS + modules `js/` + 13 opérateurs avec type *Passerelle*/GIMAC) et celui réellement affiché (IIFE inline + 19 opérateurs avec type *Microfinance*). Ils sont **structurellement incompatibles** (taxonomies de types différentes) : rebrancher le serveur afficherait de mauvaises catégories.

**Recommandations**
- Choisir **une seule** implémentation. Si l'on garde l'inline : **supprimer** `public/js/` et le code WS/endpoint mort de `server.js`.
- Si l'on veut un vrai backend : extraire l'inline vers des modules, charger via `<script src>`, **unifier le référentiel** `OPERATORS` dans une source unique (JSON serveur exposé via API/WS) et **aligner la taxonomie** des types.
- Documenter explicitement quel code fait foi.

---

## 4. Sécurité applicative

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| APP-1 | **Imposture de sécurité** : mTLS/AES-256/PKI/signature/non-répudiation sans aucune crypto ni auth | Critique (conformité) | `server.js`, `index.html:493,613,836` |
| APP-6 | Frontend = simulation 100 % client, aucune donnée réelle | Élevé (tromperie) | `index.html:407-857` |
| APP-7 | Pas de CSP/en-têtes de sécurité, CDN sans SRI | Moyen | `server.js:13-14` ; `index.html:7-11` |
| APP-2 | Endpoint `/api/v1/iso8583` ouvert à tous, sans auth | 🟣 Latent (faible en l'état) | `server.js:92-104` |
| APP-3 | XSS DOM-based (innerHTML/insertAdjacentHTML non échappés) via payload attaquant | 🟣 Latent (faible en l'état) | `app.js:79-89`, `map.js:51-57` |
| APP-4 | Aucune auth/contrôle d'origine sur le WebSocket (CSWSH + DoS par timers) | 🟣 Latent (moyen) | `server.js:72-89` |
| APP-5 | Validation d'entrée ISO 8583 quasi inexistante (présence de 2 champs) | 🟣 Latent (faible) | `server.js:93-96` |

**À retenir :** la chaîne XSS (POST non authentifié → broadcast `TX_EXTERNAL` → rendu sans échappement) est **réelle dans le source** mais **non atteignable** : `app.js` n'est pas chargé, l'IIFE n'ouvre aucun WebSocket, et même `app.js` ne gère pas le type `TX_EXTERNAL`. C'est une **dette/faille latente**, pas une XSS active.

**Recommandations**
- **Ne jamais présenter l'app comme sécurisée/conforme** tant qu'aucune brique n'existe. Retirer ou requalifier (« non implémenté ») toutes les mentions mTLS/AES/PKI/RFC 3161/ISO 27001.
- Avant tout rebranchement réel : **échappement HTML systématique** (`textContent`/nœuds DOM, jamais de concaténation de données non fiables), **authentification** de l'endpoint et du handshake WS (mTLS réel ou jeton signé), **validation stricte de schéma** du payload.
- Ajouter `helmet()` + **CSP stricte** (interdiction de l'inline), `app.disable('x-powered-by')`, et **SRI** (`integrity` + `crossorigin`) sur chaque ressource CDN — ou auto-héberger les libs.

---

## 5. Sécurité réseau & infrastructure

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| INFRA-1 | **Serveur en HTTP clair** (et `ws://`) malgré les claims mTLS/AES-256-GCM | Critique | `server.js:2,8,106` |
| INFRA-4 | **6 CDN tiers sans SRI** (Tailwind, jsDelivr, cdnjs, unpkg, Google Fonts, CartoCDN) → supply-chain | Élevé | `index.html:7-13,717` |
| INFRA-6 | **Aucun rate-limiting / anti-DoS** : 1 `setInterval` par connexion WS (O(N)), endpoint ouvert | Élevé | `server.js:72-104` |
| INFRA-3 | Aucun en-tête de sécurité (pas de helmet, CSP, HSTS, X-Frame-Options) ; `X-Powered-By` exposé | Moyen | `server.js:13-14` |
| INFRA-8 | Aucune politique CORS explicite | Faible | `server.js:13-14,92` |
| INFRA-5 | `cdn.tailwindcss.com` (build JIT navigateur) déconseillé en production | Faible | `index.html:7` |
| INFRA-9 | Tuiles carto chargées depuis un CDN étranger → fuite de métadonnées + dépendance | Faible | `index.html:717` |
| INFRA-10 | Écoute sur `0.0.0.0`, pas de reverse proxy, pas de gestionnaire de process | Faible | `server.js:11,106` |

**Recommandations (cible production)**
- **TLS partout** : terminaison TLS sur reverse proxy (nginx/Caddy) ou `https.createServer` ; **`wss://`** pour le WebSocket ; **HSTS**. Si mTLS revendiqué : `requestCert:true` + PKI réelle.
- **Souveraineté = auto-hébergement** : servir Tailwind compilé, Chart.js, Leaflet et un serveur de tuiles **localement** (la dépendance à 6 CDN étrangers contredit frontalement le discours « souverain »).
- **Anti-DoS** : un **seul** timer global diffusant à `wss.clients` (pas un par client), `express-rate-limit`, limite de connexions/IP, heartbeat ping/pong, `express.json({ limit: '32kb' })`, surveillance de `ws.bufferedAmount` (backpressure).
- Lier sur `127.0.0.1` derrière le proxy ; déployer via systemd/pm2 en utilisateur non privilégié.

---

## 6. Logique métier & conformité domaine financier

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| DATA-1 | **100 % des données financières sont aléatoires** (`Math.random`), aucune transaction réelle | Critique | `index.html:619-642` |
| DATA-3 | TPS, latence (14 ms), captation (100 %) **inventés**, pas calculés | Élevé | `index.html:642,705,122` |
| ISO-1 | **Aucune normalisation ISO 8583** (pas de MTI, bitmap, Data Elements) — mot purement cosmétique | Élevé | `server.js:92-104` |
| LEDGER-1 | Le « registre immuable RFC 3161 » n'est ni immuable, ni persistant, ni signé (hash aléatoire 160 bits étiqueté « SHA-256 ») | Élevé | `index.html:464,478,670-677` |
| DATA-2 | « Volume Journalier » jamais réinitialisé (cumul depuis l'ouverture de l'onglet, remis à 0 au rechargement) | Moyen | `index.html:459,633,643` |
| EXPORT-1 | Exports « signés PKI » (CSV/Excel/PDF/ISO8583) **ne produisent aucun fichier** (simple `alert`) | Moyen | `index.html:815-837` |
| REF-1 | **UBA Gabon** : champ `type` = `'text-red-500'` (classe CSS) au lieu de `'Banque'` → mal classée, exclue des agrégats, classe CSS affichée à l'écran | Moyen | `index.html:418` |
| REF-2 | Référentiels divergents + statut « Agréés COBAC » affirmé en dur, non sourcé | Moyen | `index.html:179,425-434` |
| PKI-1 | « ECDSA P-384 / post-quantique » : **techniquement faux** (P-384 cassable par Shor) | Moyen | `index.html:393` |

**Angle métier plus profond (non couvert par l'UI actuelle) :** une plateforme de monitoring de flux devrait modéliser des transactions en **partie double** (compte émetteur/récepteur), des **devises**, un **cycle de règlement** (autorisation → compensation → settlement), une **idempotency key** et une **réconciliation inter-établissements** (GIMAC/compensation CEMAC). Ici une « transaction » = un montant positif unique sans contrepartie ni cycle de vie : le modèle est **financièrement incohérent**, pas seulement factice.

**Recommandations**
- Brancher une **ingestion réelle** (ou afficher « DONNÉES SIMULÉES » de façon permanente et visible).
- **Calculer** réellement TPS (fenêtre glissante), latence (mesurée), captation (reçus/attendus). Implémenter une vraie fenêtre 24 h ou renommer le KPI.
- Si « immuable/non-répudiable » est revendiqué : **persistance append-only + chaînage de hashs réels sur le contenu + horodatage qualifié**. Sinon retirer ces mentions.
- **Corriger UBA** : `type:'Banque', color:'text-red-500'`. Ajouter une **validation de schéma** du référentiel (type ∈ liste fermée). Sourcer le statut COBAC sur le registre officiel.
- Générer de **vrais fichiers** (CSV via Blob, PDF via lib) ou marquer les boutons « Démo ». Ne pas afficher « signé par la PKI nationale » sans signature.

---

## 7. Système, DevOps & exploitabilité

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| DEVOPS-2 | **Aucune persistance** (tout en RAM) → SLA 99.99 %, immuabilité et RFC 3161 intenables | Élevé | `server.js:17-31,53-69` |
| DEVOPS-1 | **Hors contrôle de version** (pas de `.git`), pas de README/LICENSE/`.gitignore` | Moyen | racine |
| DEVOPS-3 | Aucun test, CI/CD, lint/format, Dockerfile/IaC | Moyen | `package.json` |
| DEVOPS-5 | Pas de gestion d'erreurs, d'arrêt gracieux (SIGTERM), de `/healthz`, d'observabilité (que `console.log`) | Moyen | `server.js:14,92-104,106` |

**Recommandations**
- `git init` + `.gitignore` (`node_modules`, `.DS_Store`, `.env`, `*.pem`, `*.key`) + dépôt distant ; **README** et **LICENSE** ; champ `license`/`author` et **`engines`** (version Node) dans `package.json`.
- ESLint/Prettier ; tests ; **CI** (incl. `npm audit`/Dependabot) ; **`npm ci`** en déploiement (build figé) ; Dockerfile non-root.
- Middleware d'erreur Express, `process.on('SIGTERM'/'uncaughtException')`, arrêt gracieux (drain des WS), endpoint `/healthz`, logging structuré (pino) + `/metrics`.
- Persistance réelle (PostgreSQL + journal signé), redondance multi-instance + LB, sauvegardes chiffrées, **RTO/RPO** définis. Le process Node mono-instance est un **SPOF total** : retirer le SLA 99.99 % tant qu'il n'est pas tenable.

---

## 8. Frontend, UX & accessibilité

| ID | Constat | Gravité | Réf. |
|---|---|---|---|
| EXPORT-1 | Boutons « Exporter »/« Générer » ne produisent rien (alert) | Élevé | `index.html:815-837` |
| REPORT-1 | **Filtre de période (dates) totalement ignoré** : l'audit « du X au Y » renvoie les ~200 dernières tx | Moyen | `index.html:784-813` |
| REPORT-2 | Le rapport ne couvre que ~200 tx volatiles (~5 min), perdues au rechargement | Moyen | `index.html:464,670-671` |
| A11Y-1 | Accessibilité : pattern ARIA tabs absent, focus non géré, icônes sans `aria-hidden`, contrastes < WCAG AA, pas d'`aria-live` | Moyen | `index.html:49-74,103-105` |
| RESP-1 | Sidebar 288 px non repliable + `overflow-hidden` + hauteurs `calc(100vh-…)` en dur → cassé sur mobile | Faible | `index.html:31,34,192` |
| PERF-1 | `innerHTML +=` en boucle (anti-pattern, mais 1× au chargement → impact négligeable) | Info | `index.html:585-614` |
| ROBUST-1 | `JSON.parse` sans `try/catch` dans le client WS | 🟣 Latent (faible) | `app.js:22` |
| DATA-5 | « Captation » figée à 100 % dès la 1ère transaction (n'informe sur rien) | Faible | `index.html:705` |

**Recommandations**
- Appliquer le filtre dates sur `t.timestamp` (déjà stocké, `index.html:667`) ou masquer les champs.
- Vraie génération de fichiers (cf. §6).
- Accessibilité service public (**RGAA/WCAG 2.1 AA**) : `role=tablist/tab/tabpanel` + `aria-selected`, gestion du focus au changement d'onglet, `aria-hidden` sur icônes décoratives, contrastes ≥ 4.5:1, `aria-live="polite"` sur les zones temps réel, skip-link.
- Sidebar repliable (burger, `hidden md:flex`), hauteurs en `min-height`/flex.
- Fixer le fuseau **`Africa/Libreville`** explicitement (au lieu de dépendre du locale machine) ; harmoniser la langue (mélange FR/EN « WARNING », « DROP AUTOMATIQUE »).

---

## 9. Conformité, juridique & gouvernance *(angles morts — au-delà du code)*

Ce sont les risques **les plus sous-évalués**, car non techniques :

1. **Propriété intellectuelle & usurpation.** Marques de banques réelles (BGFIBank, UBA, Airtel Money, Ecobank…) et **identité étatique** (`CN=HuBFIP-Root-CA, O=Gouvernement Gabonais, C=GA`, `index.html:392`) utilisées en dur. Sans mandat officiel : risque de **contrefaçon de marque** et d'**usurpation d'identité d'autorité publique**. → Retirer/flouter ces éléments ou obtenir les autorisations ; ajouter un `LICENSE`.
2. **Données personnelles.** Une vraie plateforme géolocaliserait des transactions nominatives → **loi gabonaise n° 001/2011** (protection des données personnelles) et **CNPDCP**. Aucune base légale, politique de rétention, minimisation ni anonymisation. → Ne pas suggérer une capacité de **surveillance individualisée** des flux citoyens sans cadre légal.
3. **Continuité (DRP/BCP).** Aucune redondance, aucune sauvegarde, aucun RTO/RPO, aucune sauvegarde de la « CA racine » revendiquée — incompatible avec un statut « critique national ».
4. **Sécurité supplémentaire.** `express.json()` sans `limit` (DoS mémoire) ; payload rediffusé brut (pas de validation de schéma, risque de prototype pollution) ; `op.color` injecté dans des `class=`/`title=` → **injection d'attribut** au-delà du seul `innerHTML`.

---

## 10. Plan d'action priorisé

### P0 — Immédiat (supprime le risque de tromperie/juridique, effort faible)
1. Décider **A (démo) ou B (production)** et le **documenter**.
2. Afficher en permanence **« DÉMONSTRATION — données fictives »** tant que l'app simule.
3. **Retirer** les allégations non implémentées (mTLS, AES-256, PKI/ECDSA post-quantique, RFC 3161, ISO 27001, SLA 99.99 %, « Agréés COBAC ») et l'identité étatique non mandatée.
4. `git init` + `.gitignore` + `LICENSE` ; supprimer `.DS_Store`.

### P1 — Court terme (hygiène & cohérence, que l'on garde A ou B)
5. **Choisir une implémentation** : supprimer le code mort (`public/js/`, WS/endpoint serveur) **ou** le finaliser.
6. Corriger **UBA** (`type:'Banque'`) + validation de schéma du référentiel.
7. Brancher le **filtre de dates** du rapport ; vraie génération de fichiers ou marquage « Démo ».
8. `helmet()` + CSP + `x-powered-by` off + **SRI** sur les CDN ; `express.json({limit})`.
9. Accessibilité WCAG AA (ARIA tabs, contrastes, focus) ; fuseau `Africa/Libreville`.

### P2 — Cible production (uniquement option B, effort majeur)
10. **TLS/wss partout** + reverse proxy + (vrai mTLS si revendiqué).
11. **Ingestion réelle** + parseur **ISO 8583** authentique + auth forte sur API/WS + rate-limiting/anti-DoS (timer global, backpressure).
12. **Persistance** append-only + chaînage de hashs réels + horodatage qualifié (registre vraiment immuable) ; modèle de transaction en **partie double** + cycle de règlement + réconciliation.
13. Tests + CI/CD + Docker + observabilité + DRP/BCP + conformité **loi 001/2011 / CNPDCP**.

---

*Audit réalisé par analyse multi-agents avec vérification adversariale (51 constats, relecture du code source). Les gravités indiquées tiennent compte du fait que l'application est, en l'état, une maquette de démonstration et non un système en production.*
