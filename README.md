# SUMo — Supervision Unifiée du Mobile Money

> ⚠️ **PROTOTYPE / DÉMONSTRATION.** Toutes les données affichées sont **simulées**
> (générées côté serveur). Le projet **ne reflète aucun flux Mobile Money réel**,
> n'est lié à **aucune autorité publique** et **ne doit pas être mis en production**
> en l'état. Voir [LICENSE](LICENSE).

Plateforme de **supervision des flux Mobile Money pour le régulateur télécom**, conçue
selon le cahier des charges « modèle inspiré de M3 / Global Voice Group, adapté aux
marchés africains ». Elle implémente la **fonctionnalité des 13 modules** du cahier sur
un **socle exécutable** (Node.js, un seul nœud), avec un **modèle de données TDR**
(Transaction Detail Record) et un cadrage **régulateur télécom** (statistiques de marché,
revenus/redevances, QoS, antifraude/AML, géolocalisation, reporting).

C'est l'approche **« MVP interne / hybride »** recommandée aux §6–§7 du cahier : prouver la
valeur et l'architecture sur un socle maîtrisé, puis passer à l'échelle (voir
[Trajectoire de production](#trajectoire-de-production)).

## Démarrage

```bash
npm install
npm start                 # http://localhost:3000 (HTTP en clair)
# Pour activer HTTPS/WSS en local :
npm run gen-certs         # certificat auto-signé (openssl)
npm start                 # détecte le certificat et bascule en HTTPS/WSS
npm test                  # 38 tests (node --test)
npm run lint              # ESLint
npm run verify-ledger     # vérifie l'intégrité cryptographique du registre TDR
```

Variables d'environnement (toutes optionnelles) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface d'écoute (`127.0.0.1` derrière un reverse proxy) |
| `STREAM_MS` | `1500` | Cadence initiale du générateur (modifiable à chaud dans Administration) |
| `SUMO_DATA_DIR` | `./data` | Dossier de persistance (registre, clés, config, dossiers) |
| `SUMO_API_KEY` / `SUMO_API_SECRET` | _(auto-générés)_ | Identifiants d'injection des connecteurs (HMAC) |
| `SUMO_DEMO_LOGIN` | `1` (hors prod) | Accès démo « un clic » (désactivé si `NODE_ENV=production`) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Les 13 modules du cahier des charges

| # | Module (cahier §2) | Implémentation |
|---|---|---|
| 1 | **Connecteurs / Collecte** | Endpoint d'injection authentifié `POST /api/v1/iso8583` (HMAC-SHA256), formats **ISO 8583 / JSON / CSV**, simulateur de flux non intrusif — [`createApp.js`](lib/createApp.js), [`simulator.js`](lib/simulator.js) |
| 2 | **Normalisation & Intégration** | Harmonisation des dialectes opérateurs (Comviva/Ericsson/maison) → TDR commun + **contrôle qualité/complétude** — [`normalize.js`](lib/normalize.js) |
| 3 | **Référentiel de données** | Lac de données = **registre signé** append-only ; entrepôt analytique en mémoire — [`ledger.js`](lib/ledger.js), [`warehouse.js`](lib/warehouse.js) |
| 4 | **Statistiques & Observatoire** | Volumes/valeurs/**parts de marché**, séries temporelles, par type/canal/province — [`warehouse.js`](lib/warehouse.js) |
| 5 | **Assurance des revenus & redevances** | Frais perçus vs attendus, **détection des écarts**, assiette & redevance due — [`revenue.js`](lib/revenue.js) |
| 6 | **Qualité de service** | Taux de succès, latence (moy./p95), codes d'erreur, **manquements aux seuils** — [`qos.js`](lib/qos.js) |
| 7 | **Moteur de règles — Fraude/AML** | Règles **paramétrables** : seuil, montant élevé, vélocité, fractionnement, KYC, transfrontalier — [`rules.js`](lib/rules.js) |
| 8 | **Gestion de cas / Investigation** | Dossiers persistés + **traçage de chaînes** de transactions (drill-down) — [`cases.js`](lib/cases.js) |
| 9 | **Géolocalisation** | Corrélation cellule/station ↔ TDR, cartographie, **déplacement impossible** — [`geo.js`](lib/geo.js) |
| 10 | **Analytics avancés** | Détection d'anomalies (z-score) + **scoring de risque** — [`ml.js`](lib/ml.js) |
| 11 | **Reporting réglementaire** | Modèles (observatoire/redevances/QoS/AML) sur période, **exports signés** — [`reporting.js`](lib/reporting.js) |
| 12 | **Sécurité, RBAC & Audit** | Modules **dispatchés par direction/compte** (organigramme ARCEP), **journal d'audit inviolable**, minimisation des données — [`users.js`](lib/users.js), [`audit.js`](lib/audit.js) |
| 13 | **Administration & Configuration** | Tarifs, seuils de règles, QoS, redevance, cadence — modifiables **à chaud** — [`config.js`](lib/config.js) |

## Modèle de données — TDR (cahier §3)

Entité centrale produite/ingérée par le système ([`model.js`](lib/model.js)) :
type (P2P, cash-in/out, marchand, airtime, facture, transfrontalier) · canal (USSD/STK/App/SMS) ·
montant/**devise** + conversion XAF · **frais** (perçus vs attendus) · statut (+ code d'erreur) ·
opérateur **émetteur & récepteur** (interopérabilité) · MSISDN & wallets · agent (cash-in/out) ·
**cellules émettrice & réceptrice** · écritures en **partie double équilibrées** · message **ISO 8583 réel** ·
clé d'idempotence. Entités de référence ([`referentiel.js`](lib/referentiel.js)) : opérateurs (+ moteur),
abonnés/wallets (KYC, niveau), agents, cellules/stations, grilles tarifaires, taux de change.

## Architecture

```
server.js              HTTP(S) + WebSocket. Rejoue le registre, pipeline temps réel, diffusion (scopée + masquée)
lib/referentiel.js     Source unique de vérité (opérateurs, moteurs, canaux, types, agents, cellules, abonnés)
lib/model.js           Modèle TDR (partie double, frais, ISO 8583) + vue publique masquée
lib/iso8583.js         Encodeur/décodeur ISO 8583 réel (MTI + bitmap + data elements)
lib/normalize.js       Normalisation multi-format + qualité d'ingestion
lib/pipeline.js        Enrichissement : règles → géo → risque (partagé toutes sources)
lib/ledger.js          Registre chaîné/signé (factory) — TDR + audit
lib/warehouse.js       Entrepôt analytique (agrégats, séries, parts de marché)
lib/{rules,geo,ml,qos,revenue,reporting,cases}.js   Modules d'analyse
lib/{auth,users,config,audit,subjects}.js           Sessions, comptes (organigramme ARCEP), config, audit, jetons
lib/nomenclature.js    Organigramme officiel ARCEP (directions + comptes), importé d'arcep-digital
lib/modules.js         Registre des modules : « monitoring » (parent) + 13 sous-modules + dispatch
lib/assignments.js     Affectations persistées des modules par direction et par compte
lib/createApp.js       API REST durcie (helmet/CSP, CORS, rate-limit) + gating par utilisateur + audit
public/                Front : login + espace de travail (onglets = modules dispatchés), charts, carte
public/css/theme.css   Thème clair/sombre (variables + surcharges) — bouton ☾/☀ dans l'en-tête,
public/js/theme.js     préférence persistée (localStorage), défaut = thème système
```

Pipeline temps réel : `simulateur | connecteur → normalisation → modèle TDR → enrichissement
(règles/géo/risque) → registre signé → entrepôt → diffusion WebSocket` (TDR masqués, cloisonnés
par opérateur).

## Comptes (organigramme ARCEP) & dispatch des modules

Les comptes sont **alimentés par l'organigramme officiel de l'ARCEP** (Délibération
N°0002/ARCEP/CR/2024, source : `arcep-digital/server/seed.js`, en lecture seule) : gouvernance
(Président, Conseil, Cabinet), Secrétariat Exécutif (+2 adjoints), les **11 directions** (directeurs
et agents instructeurs) — soit **27 comptes internes**, plus le compte **`admin-systeme`** et les
**3 opérateurs Mobile Money** (`airtel`/`moov`/`gimac`, restreints à leurs propres flux, REST +
WebSocket filtrés). Ré-import : `npm run import-org -- "<chemin>/arcep-digital/server/seed.js"
[--defaults]` (un snapshot commité, [`lib/nomenclature-defaults.json`](lib/nomenclature-defaults.json),
rend l'app autonome).

Chaque volet du menu est un **module**, sous-module du module parent **« Monitoring »**
([`lib/modules.js`](lib/modules.js)). La visibilité n'est plus figée par rôle : le compte
**`admin-systeme`** (onglet *Dispatch des modules*) **dispatche** les modules aux **directions**
(tous leurs comptes en héritent) et/ou à des **comptes précis** — affecter « Monitoring » = les 13
sous-modules. Persistance : `data/assignments.json` ([`lib/assignments.js`](lib/assignments.js)) ;
défauts livrés : gouvernance/exécutif → Monitoring complet, DM → observatoire des marchés,
DFC → revenus, DHQR → QoS, DCTLF → antifraude, DJ → juridique, DSIN → admin SI, DCBA → audit.
Le gating est **appliqué côté serveur par utilisateur et à chaud** (`requireModule`) : une
révocation prend effet immédiatement, sans reconnexion. Chaque dispatch est **journalisé**
(`DISPATCH_DIRECTION`/`DISPATCH_USER`, audit chaîné). API : `GET /api/v1/dispatch/state`,
`PUT /api/v1/dispatch/directions/:code`, `PUT /api/v1/dispatch/users/:username` (réservées
`ADMIN_SYSTEME`). Capacités nominatives : **révélation MSISDN** et écriture des dossiers réservées
aux directions **DCTLF/DJ** + **Président/SE** (journalisées) ; la config métier suit le module
`admin` dispatché.

**Accès démo « un clic » (DEV)** : la page de connexion propose un bouton par compte (sans mot de
passe), groupé par direction. **Désactivé** avec `NODE_ENV=production`. Mot de passe commun
(connexion classique) : `SUMO_DEMO_PASSWORD` (défaut `Arcep@2026`).

## Sécurité réellement implémentée (et honnêteté)

- **Registre non-répudiable** : chaque TDR haché (SHA-256), **chaîné** et **signé (ECDSA P-256)**,
  persistant. Vérification : `npm run verify-ledger` ou `GET /api/v1/ledger/verify`.
- **Journal d'audit inviolable** : 2ᵉ chaîne signée — connexions, exports, **révélations de MSISDN**,
  accès dossiers, modifications de config (traçabilité loi 001/2011).
- **Minimisation des données** : MSISDN **masqués par défaut** ; révélation réservée à l'antifraude/
  juridique et **journalisée**. Les alertes exposent un **jeton opaque**, jamais le numéro.
- **Injection authentifiée** : HMAC-SHA256 + validation de schéma + parsing ISO 8583 réel.
- **Exports signés** : SHA-256 + signature ECDSA P-256 (en-têtes de réponse).
- **Durcissement** : helmet + CSP, CORS allowlist, rate-limit, corps plafonné, diffuseur WS unique
  (backpressure + heartbeat), sessions cookie HttpOnly · SameSite=Strict, mots de passe scrypt.

**Volontairement NON implémenté** (documenté, jamais feint) — visible dans l'onglet *Sécurité* :
mTLS mutuel avec PKI d'autorité de confiance, horodatage qualifié RFC 3161, certification ISO 27001,
persistance distribuée / haute disponibilité.

## Trajectoire de production (cahier §4)

Le prototype implémente la *fonctionnalité* en process. À l'échelle (millions de TDR/jour), les
briques se remplacent par la pile cible : **ingestion** Kafka/NiFi, **traitement** Flink/Spark,
**entrepôt** ClickHouse/Druid, **lac** stockage objet (MinIO/S3), **base & géo** PostgreSQL/PostGIS,
**règles** Drools, **ML** Python (scikit-learn), **BI** Superset/Metabase, **IAM** Keycloak,
**déploiement** Kubernetes souverain. Le modèle TDR, le RBAC et les API restent le contrat.

Un premier pas vers cette pile est déjà câblé : un **entrepôt PostgreSQL optionnel**
([lib/db.js](lib/db.js)) — actif si `DATABASE_URL` est défini (sinon NO-OP, l'app reste en mémoire) —
qui persiste chaque TDR (vue masquée) dans une table `tdr`. Voir l'état dans l'onglet *Sécurité*.

## Docker, Makefile & options

```bash
make up        # PRODUCTION : app + reverse proxy TLS (Caddy)       → https://localhost
make dev-up    # DÉV : hot-reload (node --watch), port direct       → http://localhost:3000
make up-db     # PRODUCTION + entrepôt PostgreSQL persistant
make logs / ps / down / certs / clean / test / lint / verify
```

- [Dockerfile](Dockerfile) (non-root, healthcheck) · [docker-compose.yml](docker-compose.yml) (+ [override dev](docker-compose.override.yml), [PostgreSQL](docker-compose.db.yml)) · [Caddyfile](Caddyfile) (TLS).
- Guide pas-à-pas serveur souverain : [docs/DEPLOIEMENT-ONPREM.md](docs/DEPLOIEMENT-ONPREM.md).
- CI : `test → docker → publish (image GHCR) → audit`.
- Un onglet **Aide & guide** intégré explique la plateforme et chaque module (accessible à tous les profils).

## API (extrait)

| Méthode | Route | Module |
|---|---|---|
| GET | `/api/v1/stats` | Observatoire |
| GET | `/api/v1/revenue`, `/revenue/discrepancies` | Revenus |
| GET | `/api/v1/qos` | QoS |
| GET | `/api/v1/fraud/rules`, `/fraud/alerts` | Antifraude |
| GET/POST/PATCH | `/api/v1/cases`, `/api/v1/trace` | Investigation |
| GET | `/api/v1/geo/cells`, `/geo/anomalies` | Géolocalisation |
| GET | `/api/v1/analytics/risk` | Analytics |
| GET | `/api/v1/connectors` | Connecteurs |
| GET | `/api/v1/ledger`, `/ledger/verify` | Registre |
| GET | `/api/v1/reports/generate`, `/reports/export` | Reporting |
| GET | `/api/v1/security`, `/audit` | Sécurité |
| GET/PUT | `/api/v1/config` | Administration |
| POST | `/api/v1/iso8583` | Connecteur (HMAC) |

Exemple d'injection signée (dialecte JSON harmonisé) :

```bash
KEY=...; SECRET=...
BODY='{"operatorId":"airtel","record":{"a_party":"+241074111111","amt":250000,"service":"transfer","bearer":"ussd"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/api/v1/iso8583 \
  -H "content-type: application/json" -H "x-sumo-key: $KEY" -H "x-sumo-signature: $SIG" -d "$BODY"
```

---

*Document & code de travail — à adapter au cadre légal, institutionnel et technique national.
L'audit historique de la maquette d'origine (cadrage financier) est conservé dans [AUDIT.md](AUDIT.md).*
