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
npm test                  # 149 tests (node --test)
npm run lint              # ESLint
npm run build-css         # recompile les utilitaires locaux (après tout changement de gabarit)
npm run verify-ledger     # intégrité du registre (lecture seule, service en marche)
npm run anchor            # émet un reçu d'ancrage à déposer chez un tiers
npm run backup            # sauvegarde chiffrée (+ --verify <archive> pour la restauration)
npm run loadtest          # test de charge dimensionnant (débit réel + réactivité console)
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
| `SUMO_KEY_PASSPHRASE` | _(aucune)_ | **Chiffrement au repos** : protège la clé de données et les clés privées de signature. Sans elle → mode dégradé annoncé |
| `SUMO_KEY_PASSPHRASE_FILE` | _(aucun)_ | Idem, lue depuis un secret monté (préférable en conteneur) |
| `SUMO_SUBJECT_SECRET` | _(auto-générée)_ | Clé HMAC des jetons de sujet (persistée en `data/keys/subject_token.key`, mode 0600) |
| `SUMO_PASSWORD_MIN_LENGTH` | `12` | Longueur minimale des mots de passe |
| `SUMO_LOGIN_MAX_FAILED` / `SUMO_LOGIN_LOCK_MS` | `5` / `900000` | Verrouillage après échecs répétés |
| `SUMO_PASSWORD_MAX_AGE_DAYS` | `180` | Expiration des mots de passe |
| `SUMO_TRACE_DEFAULT_DAYS` / `SUMO_TRACE_MAX_DAYS` | `90` / `730` | Fenêtre de traçage d'un sujet (proportionnalité) |
| `SUMO_REPORT_MAX_RECORDS` | `200000` | Plafond d'enregistrements par rapport (troncature signalée) |
| `SUMO_SCAN_TIMEOUT_MS` / `SUMO_SCAN_QUEUE_MAX` | `30000` / `8` | Parcours du registre : délai et file |
| `SUMO_TILE_URL` / `SUMO_TILE_ATTRIBUTION` | _(aucun)_ | Serveur de tuiles **maîtrisé**. Sans lui, la carte se dessine sur un fond local |
| `SUMO_DEMO_LOGIN_UNSAFE` | `0` | Ouvre la démonstration aux appels **distants** (à n'utiliser qu'en connaissance de cause) |
| `SUMO_BACKUP_PASSPHRASE[_FILE]` | _(aucune)_ | Chiffrement des sauvegardes — **distincte** de la phrase du service (séparation des rôles) |
| `SUMO_INGEST_TOLERANCE_MS` | `300000` | Fenêtre d'horodatage acceptée à l'ingestion (anti-rejeu) |
| `SUMO_INGEST_QUOTA_PER_MIN` | `6000` | Quota d'ingestion par assujetti |
| `SUMO_RETENTION_P2_MOIS` / `_P3_MOIS` | `24` / `24` | Échéances d'effacement cryptographique par palier |
| `SUMO_ANCHOR_INTERVAL_MS` / `SUMO_VERIFY_INTERVAL_MS` / `SUMO_PURGE_INTERVAL_MS` | `24h` / `6h` / `24h` | Ancrage, contrôle d'intégrité et purge planifiés |
| `SUMO_DB_BATCH_SIZE` / `SUMO_DB_QUEUE_MAX` / `SUMO_DB_SSL` | `200` / `20000` / auto | Entrepôt PostgreSQL : lots, contre-pression, TLS |
| `SUMO_ROLE` | `writer` | `reader` = instance en **lecture seule**, sans verrou (multi-instance) |
| `SUMO_FSYNC` | _(groupée)_ | `strict` = synchronisation par enregistrement · `0` = aucune (essais) |
| `SUMO_FSYNC_EVERY` / `SUMO_FSYNC_MS` | `64` / `200` | Fenêtre de validation groupée |
| `SUMO_METRICS_TOKEN` | _(aucun)_ | Jeton de collecte `/metrics` (sinon : réseau interne uniquement) |
| `SUMO_VERIFY_ON_START` | `1` | Contrôle d'intégrité intégral des chaînes au démarrage |
| `SUMO_ALLOW_BROKEN_LEDGER` | `0` | Autorise le démarrage sur un registre rompu (reprise explicite, sous responsabilité) |
| `SUMO_FSYNC` | `1` | `fsync` après chaque écriture au registre (durabilité) |
| `SUMO_SIGNATURE_SAMPLE` | `500` | Signatures vérifiées en mode échantillon (le chaînage l'est à 100 %) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Les 13 modules du cahier des charges

| # | Module (cahier §2) | Implémentation |
|---|---|---|
| 1 | **Connecteurs / Collecte** | Endpoint d'injection authentifié `POST /api/v1/iso8583` (HMAC-SHA256), formats **ISO 8583 / JSON / CSV**, simulateur de flux non intrusif — [`createApp.js`](lib/createApp.js), [`simulator.js`](lib/simulator.js) |
| 2 | **Normalisation & Intégration** | Harmonisation des dialectes opérateurs (Comviva/Ericsson/maison) → TDR commun + **contrôle de conformité au contrat d'interfaçage** (11 champs obligatoires ; un enregistrement incomplet est **rejeté**, jamais complété) — [`normalize.js`](lib/normalize.js) |
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
montant/**devise** + conversion XAF · **frais perçus (déclarés) vs attendus (barème)** · **taxe** ·
statut **SUCCESS / FAILED / PENDING / REVERSED** (+ code d'erreur) · **référence de l'assujetti**
(`transaction_id`, réconciliation) · **horodatage déclaré** de la transaction (distinct de l'heure de
réception) · opérateur **émetteur & récepteur** (interopérabilité) · MSISDN & wallets · agent
(cash-in/out) · **cellules émettrice & réceptrice** · latence · écritures en **partie double
équilibrées** · message **ISO 8583 réel** · clé d'idempotence.

**Drapeaux de provenance** (`tdr.provenance`) — la plateforme ne fabrique jamais une valeur qu'un
assujetti ne lui a pas transmise, car le TDR est ensuite haché, chaîné et signé : un champ inventé
revêtu d'une signature acquerrait l'apparence d'une preuve. Un champ non transmis vaut `null` et
porte son drapeau, et il est **exclu des agrégats** au lieu d'être compté pour zéro :

| Drapeau | Sens |
|---|---|
| `DECLARE` | transmis par l'assujetti — valeur opposable |
| `DEDUIT` | dérivé d'un autre champ déclaré (cellule depuis la ville) |
| `BAREME` | recalculé par la plateforme depuis la grille officielle |
| `RECEPTION` | horodatage d'arrivée, et non de la transaction |
| `SIMULE` | produit par le simulateur de démonstration — jamais opposable |
| `SANS_OBJET` | le champ n'a pas lieu d'être (frais sur transaction échouée) |
| `INCONNU` | non transmis : valeur `null`, exclue des indicateurs | Entités de référence ([`referentiel.js`](lib/referentiel.js)) : opérateurs (+ moteur),
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

- **Écrivain unique** : chaque chaîne est protégée par un **verrou exclusif** ; une seconde
  instance sur le même `SUMO_DATA_DIR` **refuse de démarrer** au lieu d'entrelacer ses écritures
  et de rompre le chaînage. Écriture `fsync`ée ; une ligne terminale tronquée (coupure) est
  détectée, tronquée et journalisée.
- **Contrôle d'intégrité au démarrage** : chaînage **et continuité de séquence** sur 100 % des
  enregistrements, signatures échantillonnées. Une chaîne rompue **empêche le démarrage**
  (`SUMO_ALLOW_BROKEN_LEDGER=1` pour forcer, en connaissance de cause).
- **Registre non-répudiable** : chaque TDR haché (SHA-256), **chaîné** et **signé (ECDSA P-256)**,
  persistant. Vérification : `npm run verify-ledger` ou `GET /api/v1/ledger/verify`
  (`?full=1` = depuis la genèse). Toute réponse porte sa **portée** : un contrôle borné annonce
  `anchored: false` et ne certifie **pas** l'historique antérieur.
- **Journal d'audit inviolable** : 2ᵉ chaîne signée — connexions, exports, **révélations de MSISDN**,
  accès dossiers, modifications de config (traçabilité loi 001/2011).
- **Identités individuelles** : chaque compte porte **son propre secret** (scrypt, sel distinct),
  hors du code (`data/credentials.json`, 0600). En production, un mot de passe **aléatoire par
  compte** est généré une fois dans un fichier de remise, le **changement au premier accès est
  imposé** (accès aux modules suspendu tant qu'il n'a pas eu lieu), avec politique de robustesse,
  expiration et **verrouillage après échecs répétés**. Les profils habilités à la révélation
  (DCTLF, DJ, Président, SE, admin système) portent un **second facteur TOTP** obligatoire, avec
  codes de secours à usage unique.
- **Chiffrement au repos** : les identifiants nominatifs (**palier P2** — MSISDN, portefeuilles,
  écritures comptables, message ISO 8583) et la **localisation précise** (**palier P3**) sont
  chiffrés **champ par champ** dans le registre (AES-256-GCM), ainsi que l'**adresse IP** consignée
  au journal d'audit. Les clés privées de signature sont stockées en **PKCS#8 chiffré**. Le tout
  sous une phrase secrète qui vit **hors du volume de données**. Le hachage et la signature portent
  sur la forme scellée : **l'intégrité se vérifie sans déchiffrer**.
- **Ancrage externe** : `npm run anchor` émet un **reçu** { rang, hash de tête, signature } destiné
  à un **dépôt chez un tiers**. Le chiffrement protège du vol de volume, pas de l'exploitant : seul
  un reçu déposé rend détectable une réécriture par qui détient la clé.
- **Minimisation des données** : MSISDN **masqués par défaut**. Les alertes exposent un **jeton
  opaque** — un **HMAC-SHA256 sous clé secrète**, et non un hash du numéro : sans la clé, un jeton
  intercepté n'apprend rien (un hash non clé serait pré-calculable sur tout le plan de numérotation).
- **Accès nominatif (palier P2)** : le **traçage d'un sujet** (`/api/v1/trace`) comme la révélation
  des numéros sont réservés aux profils habilités (DCTLF, DJ, Président, SE) et **journalisés** —
  reconstituer l'historique transactionnel d'une personne est l'acte de surveillance ciblée que le
  décret encadre, indépendamment du démasquage. Les consultations du **palier P3** (localisation)
  sont également tracées (`ACCES_P3`).
- **Canal d'ingestion nominatif** : **une clé HMAC par assujetti** (fin du secret partagé), signature
  couvrant **horodatage + nonce** (anti-rejeu), **idempotence** sur la référence de transaction,
  quota et liste d'adresses par opérateur, empreinte de certificat client quand le **mTLS** est
  terminé au proxy. Un connecteur **ne déclare que pour lui-même** — c'est ce qui rend l'attribution
  opposable en procédure contradictoire. Tout refus est journalisé.
- **Conservation & effacement** : chaque palier de chaque mois est chiffré par **sa propre clé**.
  À l'échéance (AIPD : 24 mois pour P2 et P3), la clé est **détruite** — les identifiants deviennent
  définitivement illisibles **sans toucher un octet du registre** : la chaîne, les signatures et les
  reçus d'ancrage restent vérifiables. Purge planifiée, journalisée, suivie d'un ré-ancrage.
  Ce qui subsiste est **énoncé** ([docs/AIPD-COHERENCE.md](docs/AIPD-COHERENCE.md)).
- **Sauvegarde chiffrée** : archive AES-256-GCM sous phrase **distincte** de celle du service, avec
  manifeste (empreinte, inventaire, racine de chaîne) et **vérification de restauration** réelle.
- **Injection authentifiée** : validation de schéma + parsing ISO 8583 réel.
- **Exports signés** : SHA-256 + signature ECDSA P-256 (en-têtes de réponse).
- **Durcissement** : helmet + CSP, CORS allowlist, rate-limit, corps plafonné, diffuseur WS unique
  (backpressure + heartbeat), sessions cookie HttpOnly · SameSite=Strict, mots de passe scrypt.

- **Débit mesuré, pas estimé** : `npm run loadtest` injecte du flux réel par le connecteur et
  mesure en parallèle la latence de la console. Relevé sur un nœud : **446 TDR/s soutenus
  (38,5 M/jour), console à 4 ms, chaîne valide après charge**. La **validation groupée** des
  écritures (`fsync` toutes les 64 écritures ou 200 ms) a multiplié le débit par 2,5 — le `fsync`
  par enregistrement était le goulot. Voir [docs/TRAJECTOIRE-P2.md](docs/TRAJECTOIRE-P2.md).
- **Observabilité** : `/metrics` au format Prometheus, réservé au réseau interne, avec des
  métriques **métier** — intégrité de chaîne, concordance d'ancrage, couverture déclarative, écart
  de redevance, échéances de purge, secrets distincts. 16 règles d'alerte fournies
  ([docs/observabilite/alertes-prometheus.yml](docs/observabilite/alertes-prometheus.yml)), chacune
  portant sa **conduite à tenir**.
- **Instances en lecture seule** (`SUMO_ROLE=reader`) : le registre n'admet qu'un écrivain, mais les
  lecteurs se multiplient — aucun verrou, aucune écriture, la console et les rapports servis depuis
  le volume partagé.
- **Lecture du registre hors du fil principal** : les parcours (traçage, rapports) s'exécutent dans
  un **fil dédié**, avec file bornée (503 en saturation), délai maximal, résultats plafonnés et
  **troncature signalée**. Le coût réel de chaque parcours est renvoyé (`scanStats`). Le traçage
  d'un sujet est **borné dans le temps** (90 jours par défaut) — proportionnalité autant que
  performance.
- **Aucune ressource tierce, aucune requête sortante** : utilitaires CSS **compilés localement**
  (`npm run build-css`), police et icônes **auto-hébergées**, carte sur **fond local** (graticule +
  villes du référentiel). La CSP est resserrée sur l'origine propre — plus de `'unsafe-eval'`, plus
  de CDN. La console **fonctionne hors ligne**, sur un site isolé. Un serveur de tuiles maîtrisé
  peut être branché (`SUMO_TILE_URL`) : son origine est alors la seule admise par la CSP.
- **Démonstration cloisonnée** : le catalogue des comptes, la connexion « un clic » et le mot de
  passe commun ne sont servis qu'aux **appels locaux**. Publiée par un tunnel, l'instance ne livre
  ni l'organigramme nominatif, ni d'accès sans mot de passe. `npm run demo` impose
  `NODE_ENV=production` et refuse de s'exécuter sur le registre d'exploitation.

**Volontairement NON implémenté** (documenté, jamais feint) — visible dans l'onglet *Sécurité* :
mTLS mutuel avec PKI d'autorité de confiance, horodatage qualifié RFC 3161, certification ISO 27001,
persistance distribuée / haute disponibilité, **HSM/KMS souverain** (la phrase secrète vit en
mémoire du processus : un accès root en cours d'exécution reste hors périmètre).

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

Exemple d'injection signée (dialecte JSON harmonisé). Les **11 champs obligatoires** du
dictionnaire de données de la *Fiche d'interfaçage* sont exigés — un enregistrement incomplet
reçoit un **400** nommant les champs manquants :

```bash
KEY=...; SECRET=...
BODY='{"operatorId":"airtel","record":{
  "transaction_id":"AM-2026-7F3A9C","timestamp":"2026-08-24T14:32:07+01:00",
  "transaction_type":"P2P_OFFNET","amount":250000,"currency":"XAF",
  "fee_amount":200,"tax_amount":36,"status":"SUCCESS","channel":"USSD",
  "sender_msisdn":"+241074111111","receiver_msisdn":"+241066222222",
  "sender_kyc_level":"full","latency_ms":820,"city":"Libreville"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/api/v1/iso8583 \
  -H "content-type: application/json" -H "x-sumo-key: $KEY" -H "x-sumo-signature: $SIG" -d "$BODY"
```

La réponse renvoie les **drapeaux de provenance** retenus et l'**écart au barème** — le
contradictoire commence là :

```json
{ "status":"ACCEPTED", "operatorRef":"AM-2026-7F3A9C",
  "provenance":{"fee":"DECLARE","latencyMs":"DECLARE","cellOrigin":"DEDUIT","datetime":"DECLARE"},
  "fee":{"declared":200,"expected":2500,"ecart":2300} }
```

---

*Document & code de travail — à adapter au cadre légal, institutionnel et technique national.
L'audit historique de la maquette d'origine (cadrage financier) est conservé dans [AUDIT.md](AUDIT.md).*
