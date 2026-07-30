# Module M14 — Supervision des Services Financiers Numériques (DFS)

**Spécifications fonctionnelles et techniques**
Extension de la plateforme *ARCEP Administration Digitale* (modules M1–M13)

| | |
|---|---|
| Statut | **Projet — v0.9 pour revue interne** (non opposable en l'état) |
| Rédaction | Architecture solutions — RegTech/GovTech |
| Destinataires | Direction générale, Direction marché/QoS, Direction juridique, DSI |
| Préalable de validité | Revalidation de **toutes** les références juridiques par la Direction juridique (voir Annexe B) avant toute citation officielle ou notification aux acteurs régulés |

---

## 0. Cadrage

### 0.1 Objet

Le module M14 dote l'ARCEP d'une capacité de **supervision de la couche communications électroniques et postale des services financiers numériques** (mobile money, portefeuilles électroniques, services financiers postaux, services des PSP/fintechs empruntant les canaux des opérateurs).

Le module **ne supervise pas** la solidité financière des émetteurs de monnaie électronique et **ne se substitue pas** à la LBC/FT. Ces domaines relèvent respectivement de la BEAC/COBAC et de l'ANIF ; le module s'y **interface** (L1) sans en exercer les compétences.

### 0.2 Périmètre — les sept points de rattachement

Toute exigence du présent document porte un rattachement explicite à l'un des points suivants. Une fonctionnalité non rattachable est écartée (les écarts sont motivés en L10 et en Annexe C).

| Réf. | Point du périmètre |
|---|---|
| **P1** | Qualité et disponibilité des canaux (USSD, STK, application, API, SMS) |
| **P2** | Accès et tarification de gros des canaux pour PSP/fintechs tiers, non-discrimination |
| **P3** | Transparence tarifaire de bout en bout vers le consommateur |
| **P4** | Réclamations consommateurs et corrélation aux incidents techniques |
| **P5** | Couverture territoriale et inclusion (usage géodésagrégé, réseau de distribution) |
| **P6** | Services financiers de l'opérateur postal |
| **P7** | Indicateurs consolidés vers BEAC/COBAC, ANIF, MEF/DGI dans le cadre de conventions |

### 0.3 Hors périmètre (interfaces uniquement)

| Domaine | Autorité | Ce que M14 fournit | Ce que M14 ne fait pas |
|---|---|---|---|
| Agrément et prudentiel (float, capital, ratios) | BEAC/COBAC | Indicateurs consolidés d'usage et de qualité (P7) | Aucun calcul de couverture du float, aucun avis d'agrément |
| Déclarations de soupçon | ANIF | Indicateurs statistiques agrégés convenus (P7) | Aucune détection LBC/FT nominative, aucune déclaration de soupçon |
| Assiette fiscale | MEF/DGI | Agrégats de frais et commissions perçus (P3/P7, angle redevances) | Aucun contrôle fiscal, aucune donnée nominative |

### 0.4 Référentiel d'inspiration — traitement

Les fonctionnalités alléguées par RX-MFS (RegulX) et Vanrise DFS Monitoring sont traitées comme **allégations commerciales non vérifiées**, reformulées en exigences neutres et passées au filtre P1–P7. Le tri complet (retenu / reformulé / écarté) figure en **L10** et en **Annexe C**. Aucune exigence du présent document ne cite ces produits comme référence normative.

### 0.5 Conventions de numérotation

- Exigences : `EX-<livrable>-<nn>` (ex. `EX-L3-04`). Chaque exigence est testable : elle énonce un comportement observable ou un artefact vérifiable.
- Indicateurs : code famille + numéro (ex. `QS-03`), définis une seule fois en L4.
- Hypothèses : `HYP-<nn>`, récapitulées en Annexe A.
- Références juridiques à revalider : `REF-<nn>`, récapitulées en Annexe B.

### 0.6 Articulation avec M1–M13

M14 est un module de la plateforme existante : il **réutilise** la fédération SSO/IAM, l'API Gateway, la GED/workflow et la boucle de notification (détail en L6). Il n'introduit ni annuaire, ni portail, ni moteur documentaire nouveaux.

---

## L1 — Matrice de compétences et de flux inter-institutions

### L1.1 Matrice

| # | Domaine | Autorité pilote | Rôle ARCEP | Données échangées | Sens | Instrument juridique | Périodicité |
|---|---|---|---|---|---|---|---|
| 1 | Régulation des canaux de communications électroniques supportant les DFS (P1, P2, P3) | **ARCEP** | Pilote | Décisions, mises en demeure, indicateurs QoS/tarifs | ARCEP → acteurs régulés | Loi sur les communications électroniques (REF-01) + décisions ARCEP | Continu |
| 2 | Régulation postale, y compris services financiers postaux (P6) | **ARCEP** | Pilote | Reporting postal, indicateurs SP-xx | Poste → ARCEP | Loi postale (REF-02) + cahier des charges de l'opérateur postal | Mensuel/trimestriel |
| 3 | Prudentiel des EME (agrément, float, ratios) | **BEAC/COBAC** | Contributeur | ARCEP → BEAC : indicateurs consolidés usage/QoS/incidents (P7). BEAC → ARCEP : liste des EME agréés, retraits d'agrément | Bidirectionnel | **Convention ARCEP–BEAC** (à négocier) | Trimestriel + événementiel (agréments) |
| 4 | LBC/FT | **ANIF** | Contributeur | ARCEP → ANIF : statistiques agrégées convenues (volumes par corridor/canal, anomalies techniques de masse) (P7). Aucune donnée nominative | ARCEP → ANIF | **Protocole ARCEP–ANIF** (à négocier) | Trimestriel |
| 5 | Assiette fiscale et redevances | **MEF/DGI** | Contributeur (redevances : pilote) | ARCEP → DGI : agrégats frais/commissions déclarés vs contrôlés (P3/P7) | ARCEP → DGI | **Convention ARCEP–DGI** (à négocier) ; textes redevances (REF-03) | Trimestriel |
| 6 | Protection des données personnelles | **CNPDCP** | Assujetti | Déclarations de traitement, AIPD (L5) | ARCEP → CNPDCP | Loi n°001/2011 (REF-04) | À la mise en service + à chaque évolution |
| 7 | Protection du consommateur (prix, clauses) | Ministère du commerce / DGCC | Contributeur (canaux : pilote) | Signalements croisés, campagnes conjointes (P3, P4) | Bidirectionnel | Protocole léger (à négocier, priorité basse) | Semestriel |
| 8 | Service universel / inclusion | ARCEP (fonds SU) + MEF | Pilote (volet télécom/postal) | Indicateurs de couverture géodésagrégés (P5, P6) | Interne + publication | Textes service universel (REF-05) | Annuel |

### L1.2 Conventions à négocier — ordre de priorité

| Priorité | Convention | Motif de l'ordre | Contenu minimal |
|---|---|---|---|
| 1 | **ARCEP–BEAC/COBAC** | Conditionne la légitimité du partage P7 et évite tout conflit de compétence dès la phase 0 ; la BEAC est aussi source de la liste des EME agréés (référentiel des assujettis de M14) | Objet, liste d'indicateurs (codes L4), périodicité, format, confidentialité, point de contact, clause de non-empiètement |
| 2 | **ARCEP–DGI (via MEF)** | Les agrégats frais/commissions ont une valeur immédiate pour l'assiette (redevances ARCEP et fiscalité) ; faible complexité juridique | Idem + clause d'usage exclusif statistique/fiscal, exclusion de toute donnée nominative |
| 3 | **ARCEP–ANIF** | Utile mais sensible ; exige une doctrine claire « agrégats seulement » pour ne pas franchir la frontière LBC/FT | Liste fermée d'agrégats, seuils d'agrégation minimaux (L5), interdiction de ré-identification |
| 4 | **Protocole opérateur postal** | Peut s'appuyer sur le cahier des charges existant ; nécessaire avant L9 phase 1 | Gabarits de reporting SP, accès sondes N3 aux points de service |
| 5 | **Protocole DGCC** | Optimisation ultérieure (campagnes conjointes) | Signalements croisés |

**Exigences :**

| Code | Exigence (testable) | Rattachement |
|---|---|---|
| EX-L1-01 | La plateforme tient un **registre des conventions** (GED M-workflow) avec statut (à négocier / signée / suspendue), et bloque tout flux sortant P7 vers une institution dont la convention n'est pas au statut « signée ». | P7 |
| EX-L1-02 | Chaque flux sortant P7 est journalisé (destinataire, contenu, date, base conventionnelle) et consultable par la Direction juridique. | P7 |
| EX-L1-03 | Le référentiel des assujettis M14 (opérateurs, EME, PSP, opérateur postal) est mis à jour à réception de la liste BEAC des agréments ; tout écart entre acteurs observés sur les canaux et acteurs agréés produit une alerte interne. | P2, P7 |


---

## L2 — Modèle d'acquisition des données à cinq niveaux

### L2.1 Principe

Cinq niveaux cumulatifs. Chaque indicateur du dictionnaire (L4) déclare son niveau source ; le **drapeau de confiance** en restitution découle mécaniquement du niveau : N0 = *déclaré*, N1/N2 = *contrôlé*, N3 = *mesuré*, N4 = *corroboré*. **N3 est la brique de légitimité centrale du module** : sans mesure indépendante, l'ARCEP ne peut pas opposer ses chiffres aux acteurs régulés (règle d'arbitrage L10).

### L2.2 Tableau des niveaux

| Niveau | Mécanisme technique | Format | Latence | Volumétrie estimée (HYP-01) | Confiance | Base juridique nécessaire | Coût opérateur |
|---|---|---|---|---|---|---|---|
| **N0 — Déclaratif structuré** | Dépôt de gabarits périodiques sur le portail existant (SSO), contrôles de cohérence automatiques à l'ingestion | XLSX/CSV gabarités + manifeste signé (hash + signature du déclarant) | Mensuel (J+15), trimestriel pour le postal | ~101–102 fichiers/mois, < 50 Mo | **Déclaré** | Pouvoir général de collecte d'informations du régulateur (REF-01, art. à confirmer) ; décision ARCEP fixant les gabarits | Faible (mise en forme) |
| **N1 — Lots détaillés pseudonymisés** | Dépôt SFTP quotidien de journaux d'événements **pseudonymisés à la source** (L5) : événements de transaction (sans montant nominatif ni identité), sessions USSD, tickets d'incident | CSV/Parquet + manifeste signé, dictionnaire de données imposé | J+1 | 3 opérateurs × 0,5–2 M évts/jour ≈ 2–6 Go/jour compressés (HYP-01) | **Contrôlé** (cohérence interne vérifiable) | Décision ARCEP de collecte + conformité loi n°001/2011 (pseudonymisation, L5) ; avis CNPDCP | Moyen (extraction + pseudonymisation ; SDK fourni par l'ARCEP) |
| **N2 — Événementiel technique** | API/webhooks des opérateurs vers l'API Gateway : incidents, indisponibilités de canal, dégradations, fenêtres de maintenance ; heartbeats de disponibilité | JSON signé (JWS), schéma imposé | < 15 min pour un incident majeur (HYP-02) | Faible (102–103 évts/jour) | **Contrôlé** | Obligation de notification d'incident (décision ARCEP, REF-06 à créer/confirmer) | Moyen (intégration API) |
| **N3 — Mesure indépendante** | Sondes transactionnelles ARCEP (USSD, STK, application), campagnes d'agents mystères (canal agent, tarifs affichés), comptes de test chez chaque acteur | Journal probant signé et chaîné (L3.4) | Temps réel (sondes) ; par campagne (mystères) | 9 provinces × sondes × scénarios ≈ 104–105 mesures/mois, < 5 Go/mois | **Mesuré** — source de vérité | Pouvoir d'enquête et de contrôle du régulateur (REF-01) ; comptes de test prévus par décision ; cadre des agents assermentés (REF-07) | Nul (à charge ARCEP) hors mise à disposition de comptes de test |
| **N4 — Recoupement externe** | Réclamations consommateurs (module existant + associations), données BEAC (liste EME, statistiques publiées), résultats des campagnes QoS radio existantes (M-QoS), plaintes PSP (L8), open data | Divers, normalisés à l'ingestion | Variable | Faible | **Corroboré** | Conventions L1 ; textes réclamations (REF-08) | Nul |

### L2.3 Indicateurs atteignables par niveau

| Niveau | Familles d'indicateurs atteignables (codes L4) |
|---|---|
| N0 seul | MU-* (marché/usage déclaré), RD-01..03, SP-* (postal déclaré), CT-01 (publication des grilles), AT-02/03 (déclaratif gros) |
| + N1 | QS-04/08/09 (précision J+1), MU-* géodésagrégés (P5), RC-01..04 (réclamations opérateur), CT-04 (frais appliqués agrégés) |
| + N2 | QS-01/05/09/10 en quasi temps réel ; corrélation incidents↔réclamations (RC-05) |
| + N3 | QS-01..03, QS-05..08 **mesurés** ; CT-02/03 (écart affiché/appliqué) ; AT-04 (écart de qualité tiers vs wallet maison) ; RD-04/05 (mystères réseau d'agents) |
| + N4 | RC-06, corroborations et drapeaux « corroboré » sur MU/QS |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L2-01 | Chaque flux entrant porte un manifeste signé (hash SHA-256 du lot + signature du déclarant) ; tout lot au hash non conforme est rejeté et notifié. | P1–P7 |
| EX-L2-02 | L'ingestion N0/N1 applique des contrôles bloquants (schéma, types, plages, complétude) et **non bloquants** (cohérences inter-fichiers) ; le taux de rejet par acteur est lui-même un indicateur interne. | P1, P7 |
| EX-L2-03 | Le niveau source de chaque valeur est conservé de bout en bout jusqu'à la restitution (aucune valeur « anonyme de source »). | P7 |
| EX-L2-04 | Un SDK de pseudonymisation (bibliothèque + vecteurs de test) est fourni aux opérateurs pour N1 ; la conformité du SDK est testée à l'ingestion (vecteurs de contrôle). | P5 |
| EX-L2-05 | La plateforme fonctionne en mode dégradé documenté si un niveau est indisponible (ex. N1 absent : indicateurs restent servis en N0 avec drapeau « déclaré »). | P1–P7 |

---

## L3 — Dispositif de mesure indépendante (N3)

### L3.1 Architecture des sondes transactionnelles

| Composant | Spécification |
|---|---|
| **Sonde fixe multi-SIM** | Boîtier industriel (alimentation secourue) hébergeant 2 modems GSM/LTE par opérateur supervisé + SIM de test ; exécute des scénarios scriptés USSD et STK ; horloge disciplinée NTP (source tracée) ; stockage local chiffré tampon 72 h |
| **Sonde applicative** | Appareils Android instrumentés (parc géré MDM) exécutant les applications officielles des acteurs via scénarios automatisés ; mesure du parcours complet (lancement → confirmation) |
| **Sonde API (PSP)** | Client d'API synthétique exécutant les parcours d'API de gros offerts aux PSP (quand l'ARCEP dispose d'un accès de test au titre de P2) |
| **Orchestrateur central** | Planifie les campagnes (échantillonnage L3.2), pousse les scénarios signés vers les sondes, collecte les journaux probants, supervise l'état du parc (sonde muette > 30 min → alerte) |
| **Comptes de test** | Chaque acteur régulé met à disposition des comptes de test approvisionnés, à double titre : wallet propre et accès PSP (EX-L3-02) ; les transactions de test sont marquées côté ARCEP et exclues des statistiques de marché |

### L3.2 Plan d'échantillonnage géographique et temporel

| Dimension | Règle |
|---|---|
| Stratification spatiale | 9 provinces × {chef-lieu urbain, axe secondaire, zone rurale} lorsque le service y est commercialisé ; au minimum 1 sonde fixe par chef-lieu de province (phase 2) et 3 sites à Libreville/Owendo/Akanda + Port-Gentil dès la phase 0 (HYP-03) |
| Stratification temporelle | 3 plages : heures pleines (7h–9h, 17h–20h), heures ouvrées, nuit/week-end ; chaque cellule d'analyse (province × opérateur × canal × plage) reçoit ≥ 30 mesures/mois avant toute publication (intervalle de confiance ; en deçà, valeur non publiée) |
| Scénarios minimaux | Consultation de solde, P2P intra-réseau, P2P inter-réseaux, paiement marchand test, session USSD abandonnée (facturation !), parcours PSP tiers équivalent (L8) |
| Rotation | Les SIM/comptes de test sont renouvelés par rotation trimestrielle pour éviter tout traitement préférentiel des identifiants de sonde par l'opérateur (anti-« gaming ») |

### L3.3 Campagnes d'agents mystères (canal agent + transparence tarifaire)

| Élément | Protocole |
|---|---|
| Objet | Réseau de distribution (RD-04/05) : disponibilité de liquidité pour cash-in/cash-out, affichage des tarifs (CT-02), pratiques (frais non prévus, refus, exigences indues) — angle P3/P5 exclusivement, pas de test LBC/FT |
| Échantillon | Tirage aléatoire stratifié dans le registre des points de service déclarés (N0) ; ≥ 5 % des points actifs par province et par semestre (HYP-04) |
| Déroulé | Binôme d'enquêteurs ; grille d'observation numérique standardisée (application mobile hors ligne) ; horodatage et géolocalisation de chaque observation ; double saisie indépendante sur 10 % de l'échantillon (contrôle qualité) |
| Assermentation | Les constats destinés à fonder une procédure sont réalisés ou contresignés par un agent assermenté (REF-07) |
| Restitution | Fiches versées en GED, agrégats alimentant RD-04/05 et CT-02 ; aucune donnée personnelle de l'agent commercial au-delà de l'identifiant professionnel du point de service |

### L3.4 Journalisation probante (format opposable)

| Champ du journal | Contenu |
|---|---|
| Identité de mesure | id unique, sonde, scénario (version signée), opérateur/acteur cible, canal, localisation (cellule/coordonnées), plage |
| Horodatage | Début/fin en UTC + heure locale ; source de temps NTP et décalage mesuré consignés |
| Transcript | Échanges bruts du canal (codes USSD envoyés, écrans reçus, SMS de confirmation, réponses API), montants de test, résultat (succès/échec/type d'échec), latences intermédiaires |
| Intégrité | Hachage SHA-256 de l'enregistrement, **chaînage** au hash précédent, signature du lot par clé de la plateforme (matériel cryptographique dédié, L12) — même patron que le registre probant des modules existants |
| Conservation | 5 ans pour les journaux fondant une procédure, 24 mois pour le reste (HYP-05, à arbitrer avec la Direction juridique) |
| Chaîne de garde | Toute consultation/extraction est journalisée (qui, quand, finalité) ; les exports remis à un tiers portent hash et signature de l'extrait ; le registre de garde est versé en GED |

### L3.5 Procédure contradictoire en cas d'écart

| Étape | Délai (HYP-06) | Contenu |
|---|---|---|
| 1. Détection | — | Écart entre valeur N3 et valeur déclarée N0/N1 supérieur au seuil de la famille (L10) sur une période close |
| 2. Notification écrite | 10 jours après clôture de période | Courrier via GED/notification : valeurs en cause, méthode, extraits du journal probant (hash), délai de réponse |
| 3. Réponse de l'acteur | 15 jours ouvrés | Observations, contre-mesures, données complémentaires |
| 4. Réexamen | 15 jours | Analyse contradictoire, le cas échéant campagne N3 complémentaire ciblée |
| 5. Décision motivée | 10 jours | Classement, correction de la valeur publiée (avec mention), ou transmission au collège pour suite (mise en demeure) |
| 6. Traçabilité | permanent | L'intégralité (notification, échanges, décision) est tracée dans le workflow GED ; le statut de la procédure est visible sur les tableaux de bord internes (L7) |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L3-01 | Toute valeur publiée avec drapeau « mesuré » est reconstructible depuis les journaux probants (rejouabilité du calcul, formule L4). | P1, P3 |
| EX-L3-02 | Les décisions de collecte imposent la mise à disposition de comptes de test wallet **et** d'accès de test PSP, dans des conditions techniques identiques à celles des clients réels. | P1, P2 |
| EX-L3-03 | Une mesure issue d'une sonde dont l'horloge a dérivé au-delà de ±2 s est marquée invalide et exclue des agrégats. | P1 |
| EX-L3-04 | La procédure contradictoire est instanciée automatiquement (workflow) dès franchissement de seuil ; aucun écart supérieur au seuil ne peut être publié sans statut de procédure associé. | P1, P3, P7 |
| EX-L3-05 | Le plan d'échantillonnage est publié (méthodologie) dans le bulletin trimestriel ; les emplacements précis des sondes ne le sont pas. | P1, P5 |

---

## L4 — Dictionnaire d'indicateurs

### L4.1 Conventions

- **Drapeaux de confiance** : `D` = déclaré (N0), `C` = contrôlé (N1/N2), `M` = mesuré (N3), `R` = corroboré (N4). Le drapeau accompagne chaque valeur jusqu'à l'écran (L7) et la publication.
- **Granularité** : sauf mention contraire, tout indicateur est décliné par opérateur/acteur, et — quand la source le permet — par province et par canal.
- **Seuils** : les seuils marqués (HYP-07) sont des valeurs d'amorçage à réviser par décision après 6 mois d'observation.
- **Destinataires** : DG = direction générale, DMQ = direction marché/QoS, DJ = direction juridique, BEAC/ANIF/MEF = via conventions (P7), PUB = bulletin public.

### L4.2 Qualité de service des canaux (P1) — famille QS

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil d'alerte (HYP-07) | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| QS-01 | Disponibilité du canal USSD | Part du temps où le service USSD DFS répond | 1 − (Σ minutes d'indisponibilité constatée ÷ minutes de la période) | N3 (sondes) + N2 (incidents) | opérateur × province | Mensuelle (suivi continu) | < 99,0 % | M | DG, DMQ, PUB, BEAC |
| QS-02 | Taux de succès des sessions USSD | Sessions de test abouties sans erreur ni expiration | sessions réussies ÷ sessions tentées (sondes) | N3 | opérateur × province × plage | Mensuelle | < 95 % | M | DMQ, PUB |
| QS-03 | Latence de bout en bout d'une transaction | Délai initiation → confirmation (SMS/écran) sur transaction de test | médiane et p95 des durées mesurées | N3 | opérateur × canal × province | Mensuelle | p95 > 30 s | M | DMQ, PUB |
| QS-04 | Taux d'échec transactionnel par cause | Répartition des échecs (technique, solde, expiration, autre) | échecs par cause ÷ transactions totales | N1 | opérateur × canal | Mensuelle | technique > 2 % | C | DMQ, BEAC |
| QS-05 | Disponibilité des API de gros PSP | Part du temps où l'API PSP répond conformément | comme QS-01 sur sondes API | N3 + N2 | opérateur × API | Mensuelle | < 99,5 % | M | DMQ, DJ (si L8) |
| QS-06 | Taux de succès STK | Parcours STK de test aboutis | réussites ÷ tentatives | N3 | opérateur × province | Trimestrielle | < 95 % | M | DMQ |
| QS-07 | Taux de succès du parcours applicatif | Parcours applicatif de test abouti (lancement → confirmation) | réussites ÷ tentatives | N3 | opérateur | Mensuelle | < 97 % | M | DMQ |
| QS-08 | Délai de confirmation SMS | Délai transaction → réception du SMS de confirmation | médiane, p95 | N3 (+ N1 en contrôle) | opérateur | Mensuelle | p95 > 60 s | M | DMQ |
| QS-09 | Incidents majeurs | Nombre d'incidents majeurs (indispo > 30 min sur un canal) | comptage sur période | N2 (déclaré) + N3 (constaté) | opérateur × canal | Mensuelle | ≥ 2/mois | C/M | DG, DMQ, BEAC, PUB |
| QS-10 | Délai de rétablissement (MTTR) | Durée moyenne entre début et fin d'incident majeur | Σ durées ÷ nb incidents | N2 + N3 | opérateur | Trimestrielle | > 4 h | C/M | DMQ, BEAC |
| QS-11 | Écart déclaré/mesuré de disponibilité | Écart entre disponibilité déclarée (N0) et mesurée (N3) | QS-01(N0) − QS-01(N3), en points | N0 vs N3 | opérateur × canal | Mensuelle | > 1 pt → contradictoire (L10) | M | DMQ, DJ |

### L4.3 Marché et usage (P5, P7) — famille MU

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| MU-01 | Comptes DFS enregistrés | Comptes ouverts cumulés | comptage déclaré | N0 | opérateur | Trimestrielle | — | D | DG, PUB, BEAC |
| MU-02 | Comptes actifs 90 jours | Comptes avec ≥ 1 opération sur 90 j | comptage (N0), recalcul (N1) | N0/N1 | opérateur × province | Trimestrielle | — | C | DG, PUB, BEAC, MEF |
| MU-03 | Volume de transactions | Nombre d'opérations par type (P2P, dépôt, retrait, marchand, facture) | comptage | N0/N1 | opérateur × type × province | Mensuelle | — | C | DG, PUB, BEAC, MEF |
| MU-04 | Valeur des transactions | Montant cumulé par type (XAF) | Σ montants | N0/N1 | opérateur × type | Mensuelle | — | C | DG, BEAC, MEF |
| MU-05 | Taux d'activité géodésagrégé | Comptes actifs ÷ population adulte de la province | MU-02(prov) ÷ pop. adulte (source INS, HYP-08) | N1 + externe | province | Trimestrielle | — | C | DG, PUB |
| MU-06 | Part des transactions interopérables | Transactions inter-réseaux ÷ total P2P | comptage N1 | N1 | paire d'opérateurs | Trimestrielle | — | C | DMQ, BEAC, PUB |
| MU-07 | Transactions via PSP tiers | Volume initié par des PSP/fintechs via canaux de gros | comptage N1 (marqueur canal API) | N1 | opérateur × PSP | Trimestrielle | — | C | DMQ (L8) |
| MU-08 | Usage par canal | Répartition USSD/STK/app/API des transactions | comptage N1 | N1 | opérateur × canal | Trimestrielle | — | C | DMQ, PUB |

### L4.4 Réseau de distribution et inclusion (P5) — famille RD

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| RD-01 | Points de service déclarés | Agents/points actifs déclarés (≥ 1 opération 30 j) | comptage | N0 | opérateur × province | Trimestrielle | — | D | DMQ, PUB |
| RD-02 | Densité de points de service | Points actifs pour 10 000 adultes | RD-01 ÷ pop. adulte × 10 000 | N0 + externe | province | Trimestrielle | < seuil provincial (HYP-07) | D | DG, PUB |
| RD-03 | Localités couvertes | Part des localités > 500 hab. avec ≥ 1 point de service à < 5 km | comptage géomatique | N0 (géoloc points) | province | Annuelle | — | C | DG, PUB, SU |
| RD-04 | Disponibilité de liquidité (mystère) | Part des visites mystères où le cash-out demandé a pu être servi | visites servies ÷ visites tentées | N3 (mystères) | opérateur × province | Semestrielle | < 85 % | M | DMQ, PUB |
| RD-05 | Conformité d'affichage au point de vente | Part des points affichant grille tarifaire et identifiant agent | points conformes ÷ points visités | N3 (mystères) | opérateur × province | Semestrielle | < 90 % | M | DMQ, DJ |

### L4.5 Conformité et transparence tarifaires (P3) — famille CT

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| CT-01 | Publication des grilles tarifaires | Grille publiée, datée, accessible (site + USSD) et déposée à l'ARCEP | contrôle binaire par acteur | N0 + N3 (constat) | acteur | Mensuelle | non-conformité | M | DJ, PUB |
| CT-02 | Écart tarif affiché / tarif appliqué | Frais réellement prélevés sur transaction de test vs grille publiée | (frais constaté − frais grille) ÷ frais grille | N3 | acteur × type × palier | Mensuelle | ≠ 0 → contradictoire | M | DJ, DMQ, DGI |
| CT-03 | Coût total d'un panier type | Coût mensuel d'un panier de référence (HYP-09 : 2 dépôts, 4 P2P, 2 retraits, 1 facture) | Σ frais du panier au tarif constaté | N3 | acteur | Trimestrielle | — | M | DG, PUB |
| CT-04 | Frais et commissions perçus (agrégats) | Montant total des frais clients et commissions (assiette redevances) | Σ frais (N0) recoupé Σ frais (N1) | N0/N1 | acteur × type | Trimestrielle | écart N0/N1 > 2 % | C | MEF/DGI, DG |
| CT-05 | Facturation des sessions USSD échouées | Part des sessions de test échouées ayant néanmoins généré une facturation | sessions échouées facturées ÷ sessions échouées | N3 | opérateur | Trimestrielle | > 0 | M | DJ, PUB |
| CT-06 | Notification préalable des changements tarifaires | Changements appliqués sans dépôt préalable dans le délai réglementaire | comptage constats | N0 + N3 | acteur | Trimestrielle | > 0 | M | DJ |

### L4.6 Accès des tiers (P2) — famille AT

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| AT-01 | Délai de raccordement PSP | Délai demande complète → mise en service du canal (USSD ou API) | médiane et max des délais du registre L8 | N0 (registre) + N4 (plaintes) | opérateur × type de canal | Trimestrielle | médiane > 90 j (HYP-10) | C | DMQ, DJ, PUB |
| AT-02 | Demandes de raccordement en attente | Stock de demandes > 30 j sans réponse | comptage registre | N0/N4 | opérateur | Mensuelle | > 0 au-delà de 90 j | C | DMQ, DJ |
| AT-03 | Tarif de gros du canal | Prix unitaire (session USSD, appel API, SMS) facturé aux PSP | relevé des conventions de gros déposées | N0 | opérateur × canal | Semestrielle | dispersion inter-PSP non justifiée | D | DMQ, DJ |
| AT-04 | Écart de qualité tiers vs wallet propre | Écart de QS-02/QS-03/QS-05 entre parcours PSP et parcours wallet de l'opérateur, mêmes conditions | QS-0x(PSP) − QS-0x(wallet), même cellule de mesure | N3 | opérateur × PSP | Mensuelle | > 2 pts ou p95 +20 % → contradictoire | M | DMQ, DJ |
| AT-05 | Plaintes pour discrimination | Plaintes PSP recevables ouvertes/clôturées, délai de traitement | comptage workflow L8 | N4 | opérateur | Trimestrielle | délai > 60 j | C | DJ, DG |

### L4.7 Réclamations consommateurs (P4) — famille RC

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| RC-01 | Taux de réclamation | Réclamations DFS pour 100 000 transactions | (réclamations ÷ MU-03) × 100 000 | N1 (opérateur) + N4 (ARCEP) | opérateur × motif | Mensuelle | > seuil famille (HYP-07) | C | DMQ, PUB |
| RC-02 | Délai de traitement opérateur | Délai médian réclamation → clôture chez l'opérateur | médiane des délais N1 | N1 | opérateur | Mensuelle | > 7 j | C | DMQ |
| RC-03 | Taux de résolution au premier contact | Réclamations closes sans réouverture ni escalade | closes 1er contact ÷ total | N1 | opérateur | Trimestrielle | < 70 % | C | DMQ |
| RC-04 | Réclamations escaladées à l'ARCEP | Dossiers reçus par l'ARCEP après échec du SAV opérateur | comptage module réclamations existant | N4 | opérateur × motif | Mensuelle | tendance +50 % | C | DMQ, DJ, PUB |
| RC-05 | Corrélation réclamations ↔ incidents | Part des pics de réclamations expliqués par un incident N2/N3 dans les 72 h | pics corrélés ÷ pics détectés | N1+N2+N3 | opérateur | Trimestrielle | < 60 % (pics inexpliqués) | C | DMQ |
| RC-06 | Litiges tarifaires confirmés | Réclamations tarifaires où CT-02 confirme un écart | comptage croisé | N3+N4 | acteur | Trimestrielle | > 0 | M | DJ |

### L4.8 Services financiers postaux (P6) — famille SP

| Code | Libellé | Définition métier | Formule exacte | Source | Granularité | Périodicité | Seuil | Drapeau | Destinataires |
|---|---|---|---|---|---|---|---|---|---|
| SP-01 | Points de service postaux financiers actifs | Bureaux/points offrant au moins un service financier postal | comptage déclaré, vérif. mystère | N0 + N3 | province | Trimestrielle | régression | C/M | DG, PUB, SU |
| SP-02 | Volumes des services financiers postaux | Opérations par type (mandats, versements, retraits, MM postal) | comptage | N0 | type × province | Trimestrielle | — | D | DG, PUB |
| SP-03 | Disponibilité du système postal | Part du temps où le SI des services financiers postaux est opérationnel aux guichets | déclaré + constats mystères | N0 + N3 | province | Trimestrielle | < 97 % | C/M | DMQ |
| SP-04 | Délai d'exécution d'un mandat | Délai dépôt → disponibilité au retrait | médiane déclarée, vérif. test | N0 + N3 | paire de provinces | Trimestrielle | > 24 h | C/M | DMQ, PUB |
| SP-05 | Interopérabilité poste ↔ mobile money | Existence et usage des passerelles poste↔MM (volumes) | comptage | N0 | acteur | Semestrielle | — | D | DG, SU |
| SP-06 | Contribution au service universel | Part des localités SU où le point postal est le seul point d'accès financier | croisement RD-03 × SP-01 | N0 + géomatique | localité | Annuelle | — | C | DG, SU, PUB |

**Total : 47 indicateurs** (11 QS, 8 MU, 5 RD, 6 CT, 5 AT, 6 RC, 6 SP), dans la fourchette imposée de 40–60.

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L4-01 | Le dictionnaire est versionné ; toute modification de formule ou de seuil est tracée (date, auteur, motif) et publiée dans la note méthodologique du bulletin. | P7 |
| EX-L4-02 | Aucune valeur n'est restituée sans code d'indicateur, période, granularité et drapeau de confiance. | P7 |
| EX-L4-03 | Tout indicateur calculable à deux niveaux (ex. QS-01 en N0 et N3) est stocké dans les deux versions ; l'écart alimente les indicateurs d'écart (QS-11, CT-04) et la règle L10. | P1, P3 |

---

## L5 — Modèle de données pseudonymisé

### L5.1 Principes impératifs

| # | Principe |
|---|---|
| 1 | **Pseudonymisation à la source** : l'identifiant client (MSISDN, n° de compte) est remplacé chez l'opérateur, avant transmission, par `PSEUDO_ID = HMAC-SHA256(identifiant_normalisé, sel_opérateur)` ; le **sel est placé en séquestre chez un tiers** (officier ministériel ou organisme agréé, HYP-11) et n'est connu ni de l'ARCEP ni conservé en clair chez l'opérateur hors du module de pseudonymisation |
| 2 | **Aucune donnée nominative** dans la plateforme : ni identité, ni MSISDN, ni identifiant de compte en clair, ni donnée de contact ; les montants sont transmis en paliers (tranche) pour N1, en valeur exacte seulement pour les agrégats N0 et les transactions de test N3 (comptes ARCEP) |
| 3 | **Ré-identification** : uniquement hors plateforme, par remise du sel séquestré **sur réquisition judiciaire**, à l'autorité requérante ; l'ARCEP n'opère aucune ré-identification |
| 4 | **Seuils d'agrégation en restitution** : toute cellule statistique portant sur < **20** comptes ou < **50** transactions (HYP-12) est supprimée ou fusionnée avant affichage/export ; règle appliquée par la couche de restitution, pas par convention |
| 5 | Rotation annuelle du sel (nouvelle époque de pseudonymes) ; les analyses inter-époques ne sont pas possibles — accepté par conception (arbitrage vie privée > continuité longitudinale au-delà de 12 mois) |

### L5.2 Entités

| Entité | Clé | Attributs principaux | Cardinalités |
|---|---|---|---|
| ACTEUR | `acteur_id` | type (opérateur, EME, PSP, poste), nom, statut d'agrément (source BEAC), date | 1 ACTEUR — n CANAL, n POINT_SERVICE |
| CANAL | `canal_id` | acteur_id, type (USSD, STK, APP, API, SMS, GUICHET), code d'accès (ex. *150#), statut | 1 CANAL — n EVT_TX, n MESURE_N3 |
| EVT_TX (N1) | `evt_id` | acteur_id, canal_id, horodatage, type d'opération, **tranche de montant**, résultat, code d'échec, province, `pseudo_emetteur`, `pseudo_recepteur`, `pseudo_point_service`, marqueur PSP (psp_id si canal de gros) | n EVT_TX — 1 CANAL |
| AGREGAT (N0) | `agregat_id` | acteur_id, code indicateur, période, granularité, valeur, manifeste_id | — |
| POINT_SERVICE | `point_id` | acteur_id, `pseudo_agent` (identifiant professionnel haché), géolocalisation, province, statut d'activité | 1 POINT_SERVICE — n OBS_MYSTERE |
| SONDE | `sonde_id` | type (fixe, mobile, applicative, API), localisation, parc SIM/comptes de test, état | 1 SONDE — n MESURE_N3 |
| SCENARIO | `scenario_id` | version, canal, étapes signées, montant de test | 1 SCENARIO — n MESURE_N3 |
| MESURE_N3 | `mesure_id` | sonde_id, scenario_id, acteur_id, canal_id, horodatage, transcript, latences, résultat, frais constaté, hash, prev_hash, signature | chaînée (L3.4) |
| CAMPAGNE_MYSTERE | `campagne_id` | période, échantillon, protocole version | 1 CAMPAGNE — n OBS_MYSTERE |
| OBS_MYSTERE | `obs_id` | campagne_id, point_id, horodatage, géoloc, grille d'observation, constats, hash, signature | — |
| INCIDENT (N2) | `incident_id` | acteur_id, canal_id, début, fin, gravité, cause déclarée, source (déclaré/constaté) | — |
| RECLAMATION | `recl_id` | acteur_id, motif, canal, dates (dépôt, clôture), issue, `pseudo_plaignant` (si transmise), province | — |
| DEMANDE_ACCES (L8) | `demande_id` | psp_id, acteur_id (hôte), canal demandé, jalons datés, statut, pièces (GED) | 1 DEMANDE — n JALON |
| GRILLE_TARIFAIRE | `grille_id` | acteur_id, version datée, lignes (type, palier, frais), date de dépôt, date d'application | 1 GRILLE — n LIGNE_TARIF |
| PROCEDURE (L3.5/L8) | `proc_id` | type (écart, discrimination), acteur_id, indicateur(s), pièces GED, jalons, décision | — |
| PUBLICATION | `pub_id` | période, indicateurs publiés (valeurs + drapeaux), hash du bulletin | — |

Toutes les clés étrangères sont explicites (`acteur_id`, `canal_id`…) ; aucun attribut nominatif n'existe dans aucune entité ; les identifiants `pseudo_*` sont des HMAC opaques de 32 octets.

### L5.3 Trame de l'AIPD (loi n°001/2011, REF-04)

| Section | Contenu attendu |
|---|---|
| 1. Description du traitement | Finalités (P1–P7), périmètre, responsable (ARCEP), sous-traitants (hébergeur, intégrateur), destinataires conventionnés |
| 2. Base légale | Mission légale du régulateur (REF-01, REF-02) + conventions L1 ; à revalider par la DJ |
| 3. Données traitées | Catégories de L5.2 ; démonstration de l'absence de données nominatives ; caractère indirectement identifiant des pseudonymes et mesures de protection |
| 4. Nécessité et proportionnalité | Justification indicateur par indicateur (renvoi L4) ; tranches de montants ; seuils d'agrégation ; rotation du sel |
| 5. Risques et mesures | Ré-identification (séquestre, rotation, k-anonymat), fuite (chiffrement, cloisonnement L12), détournement de finalité (journalisation des accès, conventions), indisponibilité |
| 6. Droits des personnes | Information générale (site ARCEP), voies d'exercice via l'opérateur (seul détenteur du lien identité↔pseudonyme) |
| 7. Avis et validation | Avis CNPDCP, décision de mise en œuvre, revue annuelle |

### L5.4 Mentions à déclarer à la CNPDCP

1. Identité du responsable de traitement (ARCEP) et du délégué désigné ;
2. Finalités (P1–P7) et base légale ;
3. Catégories de données (pseudonymisées) et personnes concernées (usagers DFS, agents des réseaux de distribution, enquêteurs) ;
4. Destinataires (internes par rôle L6 ; externes par convention L1) ;
5. Durées de conservation (L12.2) ;
6. Mesures de sécurité (résumé L12.3) ;
7. Transferts éventuels hors du Gabon : **aucun** (exigence de souveraineté L12.5) ;
8. Sous-traitants et localisation de l'hébergement.

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L5-01 | Un test automatisé d'ingestion rejette tout lot N1 contenant un motif de MSISDN en clair (expression de détection +241…) ou un champ hors dictionnaire. | P5 |
| EX-L5-02 | La couche de restitution applique les seuils d'agrégation (suppression/fusion) sur **toutes** les sorties : écrans, exports, API conventionnées ; un test de recette le vérifie sur des cas limites. | P7 |
| EX-L5-03 | Le sel de pseudonymisation n'apparaît dans aucun composant de la plateforme ; la preuve de séquestre (procès-verbal) est versée en GED avant la première ingestion N1. | P5 |
| EX-L5-04 | L'AIPD est validée et la déclaration CNPDCP effectuée avant toute ingestion N1 réelle (jalon bloquant du plan L11). | P5, P7 |

---

## L6 — Architecture d'intégration à ARCEP Administration Digitale

### L6.1 Réutilisation obligatoire des briques existantes

| Brique existante | Usage par M14 | Interdit |
|---|---|---|
| **Fédération SSO/IAM** | Tous les comptes internes et externes (déclarants opérateurs, PSP, poste) sont fédérés ; M14 consomme les identités et rôles via le fournisseur d'identité existant | Créer un annuaire, une table d'utilisateurs ou un mécanisme de mot de passe propre à M14 |
| **API Gateway** | Toutes les API de M14 (dépôt N0/N1, webhooks N2, restitution conventionnée P7) sont exposées derrière la passerelle : authentification mutuelle (mTLS) pour les machines, quotas, journalisation | Exposer un port ou une API M14 directement sur le réseau |
| **GED / moteur de workflow** | Procédures contradictoires (L3.5), plaintes discrimination (L8), conventions (L1), rapports et bulletins : documents et étapes portés par le workflow existant | Stocker des pièces de procédure dans la base M14 |
| **Boucle de notification** | Notifications réglementaires (mise en demeure de déposer, ouverture de contradictoire, accusés d'ingestion) via le canal existant (courriel/portail) | Envoi direct de courriels par M14 |
| **Tableau de bord présidentiel** | M14 pousse un jeu réduit d'agrégats (L6.3) via l'API interne existante | Dupliquer le tableau présidentiel |

### L6.2 Extension de la matrice RBAC

Rôles M1–M13 réutilisés tels quels : administrateur plateforme, auditeur interne, lecteur direction générale, gestionnaire GED, déclarant-opérateur (étendu au périmètre DFS par simple attribution de portée, pas de rôle nouveau).

Rôles **strictement nouveaux** :

| Rôle | Portée | Droits principaux | Restrictions |
|---|---|---|---|
| DFS-DMQ (Direction marché/QoS) | national | Lecture de tous les indicateurs et mesures N3, lancement de campagnes, paramétrage des seuils (avec double validation) | Pas d'accès aux pièces de procédure juridique non publiées |
| DFS-JURIDIQUE | national | Conduite des procédures contradictoires, accès aux journaux probants et à la chaîne de garde, gestion du registre des conventions | Pas de paramétrage technique |
| DFS-INVESTIGATEUR | dossier | Accès aux mesures et événements pseudonymisés liés à un dossier ouvert (traçé) | Aucune ré-identification ; accès borné au dossier ; journalisation renforcée |
| DFS-CORR-BEAC | flux conventionné | Lecture du paquet d'indicateurs BEAC (P7) et de son historique d'envoi | Rien d'autre |
| DFS-CORR-ANIF | flux conventionné | Lecture du paquet d'agrégats ANIF (P7) | Rien d'autre |
| DFS-LECTEUR-MEF | flux conventionné | Lecture du paquet MEF/DGI (CT-04, MU-03/04) | Rien d'autre |
| DFS-PSP-DECLARANT | son organisation | Dépôt des demandes L8, suivi des jalons, dépôt de plaintes | Ne voit que ses propres dossiers |
| DFS-POSTE-DECLARANT | opérateur postal | Dépôt des gabarits SP, suivi des constats | Ne voit que son périmètre |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L6-01 | Aucune table d'authentification locale n'existe dans M14 (revue de code + test : création d'utilisateur impossible hors IdP). | — |
| EX-L6-02 | Les rôles conventionnés (CORR-*) sont techniquement incapables d'accéder à une donnée hors de leur paquet : test de recette par tentative d'accès croisé. | P7 |
| EX-L6-03 | Toute consultation d'un journal probant ou d'un événement pseudonymisé par DFS-INVESTIGATEUR est journalisée avec référence de dossier ; le journal d'accès est signé (même patron que L3.4). | P4, P5 |
| EX-L6-04 | Le tableau présidentiel reçoit exactement : MU-02, MU-03, QS-01 (pire opérateur), RC-04, AT-01, SP-01, chacun avec drapeau et tendance ; tout ajout passe par décision DG. | P7 |

### L6.3 Alimentation du tableau de bord présidentiel

Poussée mensuelle (et à l'événement pour QS-09 majeur) via l'API interne existante ; les valeurs portent le drapeau de confiance et un lien de rebond vers l'écran DMQ correspondant (L7). Aucune valeur infra-seuil d'agrégation n'y figure (EX-L5-02 s'applique).

---

## L7 — Tableaux de bord cibles

Règle transversale : **chaque valeur affichée porte visuellement son drapeau de confiance** (pictogramme D/C/M/R + libellé au survol) — EX-L7-01. Les cellules sous seuil d'agrégation n'apparaissent pas (EX-L5-02).

| Profil | Objectif décisionnel | Indicateurs affichés (5–8) | Filtres | Granularité | Rafraîchissement | Actions depuis l'écran |
|---|---|---|---|---|---|---|
| **Direction générale / Présidence** (tableau existant) | Arbitrer, interpeller les acteurs, communiquer | MU-02, MU-03, QS-01 (pire acteur), RC-04, AT-01, SP-01 (+ tendance) | période | national | Mensuel (+ incident majeur) | Rebond vers écrans DMQ ; export note de synthèse (GED) |
| **Direction marché/QoS (DFS-DMQ)** | Détecter les dégradations, piloter les campagnes N3, préparer les décisions | QS-01, QS-02, QS-03, QS-09/10, QS-11, MU-08, RC-01, RC-05 | acteur, province, canal, plage, niveau source | acteur × province × canal | Quotidien (N2 : quasi temps réel) | Lancer/replanifier une campagne N3 ; ouvrir un contradictoire (pré-rempli) ; annoter une valeur ; export |
| **Direction juridique (DFS-JURIDIQUE)** | Conduire contradictoires et mises en demeure | QS-11, CT-02, CT-05, CT-06, AT-04, AT-05, RC-06 + registre des procédures (statuts, délais) | acteur, procédure, statut | dossier | Quotidien | Ouvrir/instruire une procédure (workflow GED) ; générer la notification ; consulter le journal probant lié |
| **Investigateur (DFS-INVESTIGATEUR)** | Documenter un dossier ouvert | Vue dossier : événements pseudonymisés liés, mesures N3 associées, chronologie incidents/réclamations, pièces GED | bornes temporelles du dossier | événement | À la demande | Joindre une pièce ; demander une campagne ciblée (validation DMQ) ; export scellé (hash) du dossier |
| **Correspondant BEAC (DFS-CORR-BEAC)** | Alimenter la surveillance systémique | Paquet conventionné : MU-01..04, MU-06, QS-01, QS-09, CT-04 | période | national × acteur | Trimestriel | Télécharger le paquet signé ; accuser réception |
| **Correspondant ANIF (DFS-CORR-ANIF)** | Contexte statistique LBC/FT | Paquet conventionné : MU-03/04 par corridor et canal, anomalies techniques de masse (agrégées) | période | national | Trimestriel | Télécharger le paquet signé |
| **Lecteur MEF/DGI (DFS-LECTEUR-MEF)** | Assiette et redevances | CT-04, MU-03, MU-04 (+ écarts déclaré/contrôlé) | période, acteur | acteur | Trimestriel | Télécharger le paquet signé |
| **Opérateur / PSP / Poste (déclarants)** | Se situer, corriger, anticiper | Ses propres valeurs vs médiane du marché (anonymisée) : QS-01..03, RC-01/02, CT-01, AT-01 (pour PSP : ses jalons) | période, canal | son périmètre | Mensuel | Déposer un gabarit ; répondre à un contradictoire ; commenter une valeur |
| **Vue publique (bulletin trimestriel)** | Information du marché et des consommateurs | QS-01..03 par acteur, CT-03 (panier), RD-02/04, MU-02/03/08, RC-01, SP-01/04 + note méthodologique | période, province | acteur × province | Trimestriel | Consultation et téléchargement (PDF/CSV signés) ; pas d'action |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L7-01 | Le drapeau de confiance est rendu par un composant unique réutilisé sur tous les écrans et exports ; recette : aucune valeur sans drapeau sur un échantillon de toutes les vues. | P7 |
| EX-L7-02 | La vue publique est générée depuis les mêmes données que les vues internes (aucune ressaisie) ; le bulletin est figé, haché et signé à la publication (entité PUBLICATION). | P3, P7 |
| EX-L7-03 | Toute action d'écran à effet réglementaire (ouverture de contradictoire, notification) transite par le workflow GED — pas d'action « libre » dans M14. | P4 |

---

## L8 — Volet accès des tiers et concurrence (P2)

### L8.1 Registre des demandes de raccordement

| Élément | Spécification |
|---|---|
| Objet | Toute demande d'un PSP/fintech d'accès aux canaux d'un opérateur (USSD dédié ou mutualisé, API de gros, SMS) est enregistrée par le PSP (portail SSO) ou, à défaut, par l'opérateur ; l'existence du registre est imposée par décision (REF-06) |
| Jalons datés | J0 dépôt réputé complet ; J1 accusé de réception (≤ 5 j ouvrés) ; J2 réponse technique et commerciale (≤ 30 j) ; J3 mise en service (≤ 90 j calendaires) — délais HYP-10 à fixer par décision |
| Pièces | Convention de gros signée (dépôt obligatoire, confidentialité restreinte DJ/DMQ), motifs de refus le cas échéant |
| Sorties | AT-01 (délais), AT-02 (stock en attente), AT-03 (tarifs de gros) |

### L8.2 Mesure comparative de qualité (non-discrimination)

Les sondes N3 exécutent, **dans la même cellule de mesure** (même province, même plage, même charge), le parcours du wallet de l'opérateur **et** le parcours équivalent d'un service PSP empruntant le même canal. L'écart alimente AT-04. Conditions d'opposabilité : mêmes scénarios versionnés, ≥ 30 paires de mesures par cellule avant comparaison, écart-type documenté.

### L8.3 Traitement des plaintes pour discrimination

| Étape | Délai (HYP-06) | Contenu |
|---|---|---|
| Dépôt | — | Portail (rôle DFS-PSP-DECLARANT), pièces jointes en GED |
| Recevabilité | 10 j | Vérification du périmètre P2 (sinon réorientation motivée) |
| Instruction | 45 j | Croisement registre L8.1, mesures AT-04, tarifs AT-03 ; demandes d'éléments aux parties (contradictoire) |
| Issue | 15 j | Décision motivée : classement, recommandation, ou transmission au collège (mise en demeure) ; traçée GED ; alimentation AT-05 |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L8-01 | Un jalon J1/J2/J3 dépassé génère automatiquement une alerte à l'opérateur et à DMQ ; trois dépassements sur 12 mois déclenchent une revue formelle (workflow). | P2 |
| EX-L8-02 | AT-04 n'est publié qu'accompagné de sa méthodologie (paires de mesures, cellules) ; tout écart > seuil ouvre un contradictoire avant publication. | P2 |
| EX-L8-03 | Les conventions de gros déposées ne sont accessibles qu'aux rôles DFS-JURIDIQUE et DFS-DMQ (recette d'accès croisé). | P2 |
| EX-L8-04 | Le rapport semestriel « accès des tiers » (AT-01..05, anonymisé côté PSP) est produit automatiquement et versé au bulletin. | P2, P7 |

---

## L9 — Volet services financiers postaux (P6)

### L9.1 Périmètre

Services financiers de l'opérateur postal au titre de son mandat : mandats nationaux et internationaux, versements/retraits, comptes d'épargne postale le cas échéant, mobile money postal et partenariats de distribution. La supervision porte sur la **disponibilité, la qualité, la couverture et la transparence** de ces services (P6), pas sur leur équilibre financier.

### L9.2 Reporting attendu de l'opérateur postal

| Gabarit | Contenu | Niveau | Périodicité |
|---|---|---|---|
| SP-A « Réseau » | Points de service, statut, géolocalisation, services offerts par point | N0 | Trimestriel |
| SP-B « Activité » | Volumes/valeurs par type de service et par province (agrégats) | N0 | Trimestriel |
| SP-C « Qualité » | Disponibilité du SI aux guichets, délais mandats, incidents | N0/N2 | Trimestriel (incidents : 15 min) |
| SP-D « Tarifs » | Grille tarifaire datée et déposée | N0 | À chaque modification |

Les campagnes mystères (L3.3) couvrent les points postaux au même titre que les agents mobile money (SP-01/03/04 en constat, CT-01/02 applicables).

### L9.3 Articulation avec le mobile money et le service universel

- Croisement RD-03 × SP-01 : identification des localités où le point postal est l'unique accès financier (SP-06) — contribution mesurable de la poste à l'inclusion (P5/P6) ;
- SP-05 : suivi des passerelles poste ↔ mobile money (existence, volumes) comme indicateur d'intégration du réseau postal à l'écosystème DFS ;
- Les indicateurs SP alimentent le rapport annuel service universel (destinataire SU) et le bulletin public.

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L9-01 | Les gabarits SP-A..D sont opposables (annexés au protocole L1 priorité 4) et contrôlés à l'ingestion comme les gabarits opérateurs (EX-L2-02). | P6 |
| EX-L9-02 | Le plan de campagnes mystères inclut au moins 10 % de points postaux par vague (HYP-04). | P6 |
| EX-L9-03 | SP-06 est recalculé à chaque mise à jour de RD-03 ou SP-01 et versionné (série longue pour le rapport SU). | P5, P6 |

---

## L10 — Règles d'arbitrage et source de vérité

### L10.1 Principe directeur

**La mesure indépendante (N3) prime sur le déclaratif (N0/N1) en cas d'écart.** Tout écart supérieur au seuil de sa famille déclenche une procédure contradictoire écrite, tracée en GED (L3.5). Tant que la procédure est ouverte, la valeur publiée est la valeur N3, assortie de la mention « contradictoire en cours ».

### L10.2 Règle par famille

| Famille | Source de vérité | Seuil de déclenchement du contradictoire (HYP-07) | Publication pendant contradictoire |
|---|---|---|---|
| QS (qualité) | N3 ; N2 pour la chronologie des incidents | Écart ≥ 1 point de disponibilité ou ≥ 20 % sur une latence p95 | Valeur N3 + mention |
| MU (usage) | N1 (recalcul) ; N0 accepté si écart N0/N1 < 2 % | Écart ≥ 2 % sur volumes/valeurs | Valeur N1 + mention |
| RD (distribution) | N0 corrigé par constats N3 (mystères) | ≥ 10 % de points déclarés actifs introuvables/inactifs dans l'échantillon | Valeur corrigée + mention |
| CT (tarifs) | N3 (constat) contre grille déposée | Tout écart constaté (tolérance zéro sur CT-02/CT-05) | Constat N3 |
| AT (accès tiers) | Registre L8 (jalons horodatés) + N3 pour AT-04 | AT-04 : > 2 pts ou p95 +20 % ; AT-01 : dépassement des délais réglementaires | Valeurs registre/N3 |
| RC (réclamations) | N1 (opérateur) recoupé N4 (ARCEP) | Sous-déclaration ≥ 20 % des dossiers escaladés retrouvés | Valeur recoupée + mention |
| SP (postal) | N0 corrigé par constats N3 | Comme RD/QS selon l'indicateur | Valeur corrigée + mention |

### L10.3 Doublons Vanrise / RX-MFS — arbitrages explicites

| Fonctionnalité alléguée | Origine | Arbitrage M14 | Justification (P1–P7) |
|---|---|---|---|
| KPI de marché et QoS, tableaux régulateur | RX-MFS | **Retenu**, reformulé en L4/L7 | P1, P5, P7 |
| Vérification indépendante | RX-MFS | **Retenu et renforcé** : c'est N3 (L3), traité comme brique centrale | P1, P3 |
| Analyse géodésagrégée / engagement utilisateur | RX-MFS | **Retenu partiellement** : géodésagrégation oui (MU-05, RD-*) ; « engagement utilisateur » reformulé en usage actif (MU-02/08) ; toute analyse comportementale individuelle **écartée** | P5 ; écart : hors mandat + L5 |
| Suivi du float et flux inter-systèmes | Vanrise | **Écarté** (prudentiel BEAC/COBAC) ; seul le **symptôme de service** est retenu : échec de cash-out chez l'agent (RD-04) | Hors périmètre §0.3 ; P5 pour RD-04 |
| Assurance revenus (frais, commissions, MDR) | Vanrise | **Retenu sous deux angles seulement** : transparence consommateur (CT-02/03/05) et agrégats d'assiette (CT-04 → MEF/DGI, redevances) ; tout rapprochement comptable par transaction **écarté** | P3, P7 ; écart : prudentiel/fiscal nominatif |
| Intégration KYC/eKYC et AML | Vanrise | **Écarté** ; interface limitée aux agrégats statistiques conventionnés vers l'ANIF | Hors périmètre §0.3 ; P7 pour les agrégats |
| Couverture élargie des produits (crédit, assurance…) | Vanrise | **Écarté en v1** ; la couche canal (P1) les couvre indirectement si ces produits empruntent USSD/app ; réexamen à 12 mois | P1 uniquement via canaux |
| Supervision « temps réel » généralisée | Les deux | **Écarté** comme exigence générale ; retenu uniquement pour N2 incidents et l'état du parc de sondes (L12.1) | Coût/mandat ; P1 |

**Exigences :**

| Code | Exigence | Rattachement |
|---|---|---|
| EX-L10-01 | Le moteur de calcul stocke, pour chaque indicateur bi-source, les deux valeurs et l'écart ; le déclenchement du contradictoire est automatique et non désactivable sans décision tracée. | P1, P3, P7 |
| EX-L10-02 | Aucune valeur « déclarée » n'écrase une valeur « mesurée » dans l'historique ; les corrections issues d'un contradictoire créent une nouvelle version datée. | P7 |

---

## L11 — Plan de déploiement en quatre phases (structuré par niveau d'acquisition)

| | **Phase 0 — Amorçage déclaratif + N3 pilote** | **Phase 1 — Lots détaillés N1** | **Phase 2 — Mesure indépendante industrialisée (N3) + N2** | **Phase 3 — Recoupements N4 + pleine interinstitutionnalité** |
|---|---|---|---|---|
| **Durée** | **3 mois (impératif)** | 6 mois | 9 mois | 6 mois |
| **Périmètre** | Gabarits N0 (opérateurs + poste) ; 4 sites de sondes pilotes (Libreville ×3, Port-Gentil) sur USSD ; registre L8 ouvert ; dictionnaire L4 v1 (sous-ensemble ~20 indicateurs) | Ingestion N1 quotidienne pseudonymisée des 3 opérateurs ; SDK de pseudonymisation ; indicateurs « contrôlés » ; réclamations N1 | Sondes fixes 9 provinces + sondes applicatives + API ; campagnes mystères semestrielles ; webhooks N2 incidents ; contradictoires actifs ; AT-04 | Corrélations N4 (réclamations ARCEP, M-QoS radio, données BEAC) ; paquets conventionnés BEAC/ANIF/MEF en production ; vue publique enrichie |
| **Prérequis juridiques** | Décision ARCEP « gabarits et comptes de test » (REF-06) ; lettre de cadrage BEAC (convention en négociation) | AIPD validée + déclaration CNPDCP (**bloquant**, EX-L5-04) ; décision de collecte N1 ; séquestre du sel constaté | Décision incidents N2 ; cadre agents assermentés opérationnel (REF-07) ; délais L8 fixés par décision | Conventions BEAC, DGI, ANIF **signées** (EX-L1-01) ; protocole postal signé |
| **Livrables** | **Premier bulletin public d'indicateurs** (obligatoire) ; portail de dépôt opérationnel ; 20 indicateurs servis (drapeau D/M) ; registre L8 | Dictionnaire complet servi (47 indicateurs, drapeaux C) ; premiers écarts N0/N1 documentés | Bulletin avec majorité de drapeaux M sur QS/CT ; première procédure contradictoire menée à terme ; rapport accès des tiers #1 | Rapport annuel inclusion/SU ; paquets P7 automatisés ; bilan de charge et plan de pérennisation |
| **Critères d'acceptation (vérifiables)** | Bulletin publié ≤ M3 ; ≥ 95 % des gabarits attendus déposés et ingérés sans rejet bloquant ; 4 sondes remontant ≥ 30 mesures/cellule/mois ; SSO effectif (0 compte local, EX-L6-01) | 100 % des lots N1 conformes EX-L5-01 sur 30 jours glissants ; écart de recalcul MU-03 N0/N1 documenté pour chaque opérateur ; latence ingestion < 24 h | Couverture ≥ 80 % des cellules d'échantillonnage L3.2 ; 100 % des écarts > seuil avec contradictoire instancié (EX-L3-04) ; MTTR de collecte des incidents N2 < 15 min | 3 paquets conventionnés livrés 2 trimestres de suite dans les délais ; 0 flux sortant sans convention signée (EX-L1-01) ; audit de réversibilité réussi (EX-L12-04) |
| **Charge estimée (HYP-13)** | ARCEP : 2 ETP + intégrateur ~40 j/h ; opérateurs : ~5 j/h chacun | ARCEP : 3 ETP + ~120 j/h ; opérateurs : 20–40 j/h chacun (SDK fourni) | ARCEP : 4 ETP + ~200 j/h + CAPEX sondes (~9 provinces) ; opérateurs : ~15 j/h (N2) | ARCEP : 3 ETP + ~80 j/h |
| **Risques majeurs** | Retard des gabarits (mitigation : mise en demeure de déposer) ; contestation de la publication (mitigation : note méthodologique, drapeaux) | Blocage CNPDCP/AIPD (mitigation : dépôt dès la phase 0) ; qualité des extractions opérateurs (mitigation : SDK + vecteurs de test) | Logistique provinciale des sondes (mitigation : partenariat avec les agences régionales) ; « gaming » des identifiants de test (mitigation : rotation L3.2) | Lenteur des conventions (mitigation : lettres d'intention dès la phase 0 ; le module fonctionne sans, seuls les flux P7 attendent) |

---

## L12 — Recommandations techniques

### L12.1 Ingestion

| Flux | Mode | Justification |
|---|---|---|
| N0 gabarits | Batch (dépôt portail) | Périodicité mensuelle/trimestrielle ; aucune valeur temps réel |
| N1 lots détaillés | **Micro-batch quotidien** (SFTP + traitement en fenêtres) | Les indicateurs L4 sont mensuels/trimestriels ; J+1 suffit ; coût opérateur et complexité bien moindres qu'un flux continu — le temps réel généralisé est écarté (L10.3) |
| N2 incidents | Événementiel (webhooks signés) | La valeur de l'information d'incident décroît en minutes ; volumétrie faible |
| N3 sondes | Événementiel léger (remontée à la mesure) + tampon local 72 h | Suivi d'état du parc et fraîcheur des constats ; tolérance aux coupures |
| N4 | Batch à la disponibilité des sources | Sources externes non maîtrisées |

### L12.2 Stockage et rétention (HYP-05)

| Catégorie | Rétention en ligne | Archivage | Suppression |
|---|---|---|---|
| Événements N1 pseudonymisés | 24 mois | — | Purge automatique attestée |
| Agrégats et indicateurs publiés | 10 ans | Oui (bulletins signés) | — |
| Journaux probants N3 | 24 mois (5 ans si liés à une procédure) | Scellés | Purge attestée hors procédure |
| Pièces de procédure | Durée GED existante (règles M1–M13) | GED | Règles GED |
| Journaux d'accès | 5 ans | Scellés | — |

Modèle en trois couches : **brut** (lots et journaux tels que reçus, immuables), **normalisé** (entités L5.2), **restitution** (indicateurs calculés, versionnés). Le calcul est rejouable de bout en bout (EX-L3-01).

### L12.3 Sécurité et cloisonnement

- Cloisonnement logique par acteur régulé (un déclarant ne voit jamais les données d'un autre — patron déjà exigé sur M1–M13) et par paquet conventionné (EX-L6-02) ;
- Chiffrement en transit (TLS mutualisé à l'API Gateway, mTLS machine) et au repos ; clés de signature des journaux probants et des bulletins dans un module matériel dédié (HSM ou équivalent souverain, HYP-14) ;
- Journalisation d'accès signée et chaînée (même patron que L3.4), revue trimestrielle par l'auditeur interne ;
- Environnements séparés (production / recette / démo) — la bascule démo → production suit la procédure existante de la plateforme.

### L12.4 Réversibilité et absence d'enfermement

| Code | Exigence |
|---|---|
| EX-L12-01 | Tous les formats d'échange (gabarits, lots N1, webhooks, paquets P7) sont documentés et libres de droits ; aucun format propriétaire opaque. |
| EX-L12-02 | Le dictionnaire L4 (définitions + formules) est la propriété de l'ARCEP, livré en format ouvert et exécutable hors de l'outil du fournisseur. |
| EX-L12-03 | Les composants s'appuient sur des standards ouverts (SQL standard, Parquet/CSV, JSON Schema, OpenAPI) ; toute extension propriétaire est isolée derrière une interface documentée. |
| EX-L12-04 | Un **audit de réversibilité** (export complet brut + normalisé + preuves, rejeu d'un mois de calculs hors plateforme) est exécuté avec succès avant la fin de la phase 3, puis annuellement. |

### L12.5 Souveraineté et hébergement

- Hébergement de production **sur le territoire gabonais** (datacenter ARCEP ou hébergeur souverain qualifié, HYP-15) ; aucun transfert de données pseudonymisées hors du Gabon (cohérent avec la déclaration CNPDCP L5.4) ;
- Télémaintenance du fournisseur : accès nominatif, à la demande, journalisé, sans copie de données hors site ;
- Continuité : sauvegardes chiffrées sur site secondaire national ; objectif de reprise ≤ 24 h (HYP-16) — le module n'est pas un système temps réel critique.

---

## L13 — Grille de notation des fournisseurs

### L13.1 Critères pondérés

| # | Critère | Pondération | Éléments d'appréciation (rattachés aux livrables) |
|---|---|---|---|
| 1 | Conformité au périmètre P1–P7 et absence de hors-sujet prudentiel/AML | 10 % | Couverture du dictionnaire L4 ; capacité à désactiver les fonctions hors mandat (L10.3) |
| 2 | **Dispositif de mesure indépendante N3** | **20 %** | Sondes USSD/STK/app/API réellement démontrées ; journalisation probante conforme L3.4 ; plan d'échantillonnage outillé |
| 3 | Modèle d'acquisition N0–N2 et qualité d'ingestion | 10 % | Gabarits, SDK pseudonymisation, contrôles EX-L2-02, mode dégradé EX-L2-05 |
| 4 | Protection des données (L5) | 10 % | Pseudonymisation à la source, seuils d'agrégation en restitution, journal d'accès signé |
| 5 | Intégration aux briques existantes (L6) | 15 % | Démonstration SSO fédéré, exposition via API Gateway, workflow GED pour contradictoires — sans développement spécifique lourd |
| 6 | Tableaux de bord et drapeaux de confiance (L7) | 5 % | Drapeaux natifs, vue publique, granularités |
| 7 | Réversibilité et souveraineté (L12.4/L12.5) | 10 % | Formats ouverts, audit de réversibilité contractualisé, hébergement local |
| 8 | Coût total de possession sur 5 ans | 10 % | Licences, sondes, exploitation, dépendance aux prestations du fournisseur |
| 9 | Références vérifiables auprès de régulateurs (Afrique/CEMAC de préférence) | 5 % | Contacts référents interrogeables, périmètres réellement déployés |
| 10 | **Preuve de concept (L13.2)** | **5 % éliminatoire** | Réussite des critères de sortie ; un échec au PoC est éliminatoire quelle que soit la note pondérée |

Note ≥ 70/100 requise pour l'admission en négociation ; critère 10 éliminatoire.

### L13.2 Protocole de preuve de concept (PoC)

| Élément | Spécification |
|---|---|
| Cadre | 6 semaines, sur données réelles d'un **opérateur pilote volontaire** (convention tripartite ARCEP–opérateur–candidat ; données N1 pseudonymisées via le SDK ; comptes de test réels) |
| Scénarios imposés | (a) ingestion de 30 jours de lots N1 avec contrôles EX-L2-01/02 et rejet démontré d'un lot piégé (EX-L5-01) ; (b) 2 semaines de mesures N3 USSD sur 2 sites avec journaux probants vérifiables ; (c) calcul de 12 indicateurs imposés (dont QS-01/02/03, CT-02, MU-03, RC-01) avec drapeaux ; (d) démonstration d'un contradictoire instancié automatiquement sur écart simulé ; (e) export de réversibilité complet |
| Critères de sortie objectifs | 100 % des lots conformes ingérés, 100 % des lots piégés rejetés ; hash de chaque journal N3 revérifiable par l'ARCEP avec un outil indépendant ; les 12 indicateurs recalculés par l'ARCEP hors outil donnent les mêmes valeurs (tolérance 0) ; export de réversibilité rejouable ; aucune donnée du PoC conservée par le candidat (attestation + vérification) |
| Livrable | Rapport de PoC contradictoire signé des trois parties, versé au dossier de consultation |

---

## Annexe A — Hypothèses posées (à valider)

| Code | Hypothèse | À valider par |
|---|---|---|
| HYP-01 | Volumétries N1 estimées à 0,5–2 M événements/jour/opérateur | DSI + opérateurs (phase 0) |
| HYP-02 | Délai de notification d'incident majeur ≤ 15 min réalisable | DMQ + opérateurs |
| HYP-03 | Sites pilotes phase 0 : Libreville ×3, Port-Gentil | DG |
| HYP-04 | Taux d'échantillonnage mystères : ≥ 5 % des points actifs/province/semestre ; ≥ 10 % de points postaux par vague | DMQ |
| HYP-05 | Durées de conservation (24 mois / 5 ans / 10 ans) | DJ + CNPDCP |
| HYP-06 | Délais des procédures contradictoires et plaintes | DJ |
| HYP-07 | Tous les seuils d'alerte du dictionnaire L4 (valeurs d'amorçage) | DMQ puis décision |
| HYP-08 | Source démographique : projections INS par province | DMQ |
| HYP-09 | Composition du panier type CT-03 | DMQ + associations de consommateurs |
| HYP-10 | Délais de raccordement PSP (5/30/90 jours) | DJ + consultation publique |
| HYP-11 | Séquestre du sel : officier ministériel ou organisme agréé | DJ |
| HYP-12 | Seuils d'agrégation : 20 comptes / 50 transactions | DJ + CNPDCP |
| HYP-13 | Charges estimées du plan L11 | DSI + consultation |
| HYP-14 | Disponibilité d'un HSM ou équivalent souverain | DSI |
| HYP-15 | Hébergeur souverain qualifié disponible | DSI + DG |
| HYP-16 | Objectif de reprise ≤ 24 h | DSI |

## Annexe B — Références juridiques à faire revalider (aucune citation officielle avant validation DJ)

| Code | Référence présumée | Usage dans le document |
|---|---|---|
| REF-01 | Loi/ordonnance régissant les communications électroniques au Gabon (pouvoirs de collecte, d'enquête et de sanction de l'ARCEP) | L1, L2, L3, base légale AIPD |
| REF-02 | Loi/cadre régissant le secteur postal et le cahier des charges de l'opérateur postal | L1, L9 |
| REF-03 | Textes relatifs aux redevances dues au régulateur | L1, CT-04 |
| REF-04 | Loi n°001/2011 relative à la protection des données à caractère personnel et textes CNPDCP | L5 |
| REF-05 | Textes service universel (télécom/postal) | L1, RD-03, SP-06 |
| REF-06 | Décision(s) ARCEP à créer : gabarits de collecte, comptes de test, notification d'incidents, registre et délais de raccordement PSP | L2, L3, L8 |
| REF-07 | Cadre des agents assermentés du régulateur (constats opposables) | L3.3 |
| REF-08 | Textes régissant le traitement des réclamations des consommateurs de communications électroniques | L2 (N4), RC |
| REF-09 | Règlements CEMAC/BEAC applicables aux services de paiement (pour la matrice L1 uniquement — champ BEAC/COBAC) | L1 |

## Annexe C — Fonctionnalités écartées (récapitulatif)

| Fonctionnalité | Origine | Motif d'écart (justification) |
|---|---|---|
| Suivi du float, réconciliation inter-systèmes, ratios prudentiels | Vanrise | Compétence BEAC/COBAC (§0.3) ; M14 ne conserve que le symptôme de service RD-04 |
| Intégration KYC/eKYC, scoring AML, déclarations de soupçon | Vanrise | Compétence ANIF ; seuls des agrégats statistiques conventionnés sortent (P7) |
| Rapprochement comptable par transaction des commissions (MDR) | Vanrise | Prudentiel/fiscal nominatif ; remplacé par CT-02 (constat) et CT-04 (agrégats) |
| Analyse comportementale individuelle (« engagement utilisateur ») | RX-MFS | Incompatible L5 (pas de profil individuel) ; remplacé par MU-02/08 agrégés |
| Supervision temps réel généralisée | Les deux | Sans exigence métier (indicateurs mensuels/trimestriels) ; coût opérateur disproportionné ; conservé uniquement pour N2 incidents |
| Produits financiers élargis (crédit, assurance) en v1 | Vanrise | Non rattachable à P1–P7 au-delà de la couche canal ; réexamen à 12 mois |

---

*Fin du document. Toute évolution passe par une nouvelle version datée, validée DG/DJ/DSI.*
