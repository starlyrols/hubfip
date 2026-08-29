# Note de cohérence AIPD ↔ implémentation

**Objet :** mise en concordance de l'Analyse d'Impact relative à la Protection des Données
(Pièce 8, canevas CNPDCP) avec l'état **réel** de la plateforme SUMo, préalablement au dépôt.

**Date :** 24 août 2026 · **Établie par :** revue technique · **Destinataire :** Direction Juridique (DJ)

---

## Pourquoi cette note

L'audit du 24 août 2026 a relevé que l'AIPD décrivait des garanties que le code ne mettait pas
en œuvre. Ce n'est pas un détail de rédaction : **une AIPD est un engagement opposable**. Déposer
un document décrivant des mesures inexistantes expose l'ARCEP dès le premier contrôle de la
CNPDCP, et fragilise l'ensemble du dispositif de monitoring — y compris ses volets incontestés.

Les écarts ont depuis été refermés par le code. Cette note recense, engagement par engagement,
**ce qui est désormais vrai**, **ce qui doit être reformulé**, et **ce qui reste à faire** — afin
que le texte déposé décrive l'installation telle qu'elle est.

Trois principes ont guidé les correctifs, et méritent de figurer dans l'AIPD elle-même :

1. **Ne jamais présenter comme mesurée une donnée qui ne l'a pas été.** Un champ non transmis par
   l'assujetti vaut `null` et porte un drapeau de provenance ; il n'est ni estimé, ni comblé.
2. **La minimisation prime sur la commodité.** Le traçage d'un sujet est borné dans le temps par
   défaut, et exige une habilitation nominative.
3. **Dire ce qui subsiste.** Une purge qui laisse des données résiduelles doit l'énoncer, sous
   peine de faire passer une pseudonymisation pour une anonymisation.

---

## 1. Engagements désormais tenus — à confirmer dans le texte

| § AIPD | Engagement | État réel | Formulation suggérée |
|---|---|---|---|
| §9 | « Chiffrement en transit et **au repos** » | **Tenu.** TLS en transit. Au repos : chiffrement **champ par champ** (AES-256-GCM) des identifiants nominatifs (palier P2) et de la localisation précise (P3) ; clés privées de signature en PKCS#8 chiffré ; adresse IP du journal d'audit scellée. La phrase secrète vit **hors du volume de données**. | Préciser que le chiffrement au repos est **applicatif et par palier**, et non un simple chiffrement de volume — c'est une garantie plus forte, elle mérite d'être décrite comme telle. |
| §9 | « Habilitations **nominatives** » | **Tenu.** Un secret propre par compte (scrypt, sel distinct), changement imposé au premier accès, expiration, verrouillage après échecs. **Second facteur TOTP obligatoire** pour les profils habilités à la révélation. | Ajouter la mention du second facteur et de la politique d'expiration : ce sont des mesures que le canevas valorise. |
| §9 | « **Journalisation et horodatage** des accès » | **Tenu.** Journal d'audit chaîné et signé. Sont désormais tracés : connexions et échecs, révélations de MSISDN, **traçages de sujet avec la fenêtre consultée**, accès au palier P3 **et leurs refus**, exports, purges, refus d'ingestion. | Mentionner explicitement que **l'étendue** d'une mesure de surveillance est journalisée, pas seulement son occurrence. |
| §3/§9 | « Cloisonnement des paliers P1/P2/P3 » | **Tenu sur l'accès et sur la clé.** Paliers chiffrés par des clés **distinctes** ; la corrélation abonné ↔ déplacement (P3 nominatif) exige une habilitation propre (DCTLF, DJ, DHQR, Président, SE) ; la cartographie agrégée, qui ne désigne personne, reste ouverte au module. | Reformuler : le cloisonnement est **cryptographique et fonctionnel**. Voir §3 ci-dessous pour la limite de stockage. |
| §7 | Durées de conservation, données « supprimées ou anonymisées » | **Tenu pour P2 et P3** par **effacement cryptographique** : chaque palier de chaque mois porte sa clé ; à l'échéance la clé est détruite, la donnée devient définitivement illisible. Purge **planifiée**, journalisée, et suivie d'un ré-ancrage. | Décrire le mécanisme : c'est lui qui rend l'engagement tenable sur un registre append-only. Voir §2 pour la réserve indispensable. |
| §9 | « Sauvegardes » | **Tenu pour l'outillage.** Sauvegarde chiffrée (AES-256-GCM, phrase **distincte** de celle du service — séparation des rôles) avec manifeste et **vérification de restauration**. | Le **transport hors site** et la **périodicité** restent des actes d'exploitation à décrire dans la procédure, pas dans le code. |
| Décret art. 1ᵉʳ | « Contrôle instantané et vérifié », substitution au déclaratif | **Tenu.** Les 11 champs obligatoires du contrat d'interfaçage sont exigés et conservés ; les frais **déclarés** sont confrontés au barème officiel ; les statuts `PENDING` et `REVERSED` sont conservés ; un enregistrement incomplet est **rejeté**, jamais complété. | Le dispositif vérifie désormais réellement. C'est le cœur de l'argumentaire : à mettre en avant. |
| Décret / AIPD | « Observation non intrusive, hors chemin transactionnel » | **Tenu depuis l'origine.** Architecture en push ; aucun PIN, mot de passe ou secret d'authentification dans le modèle TDR. | Inchangé. |

---

## 2. Réserves à INTRODUIRE dans le texte

Ces points sont favorables au dispositif, mais les taire reviendrait à reproduire le défaut que
l'audit a relevé.

### 2.1 La purge laisse un résidu — et il faut le dire

Après destruction de la clé d'un segment, **subsistent** :

- les données de **palier P1** (montant, type, canal, horodatage, opérateur), qui ne portent aucun
  identifiant ;
- la **ville** et la **province**, granularité déjà publiée dans les statistiques de marché ;
- l'**empreinte HMAC** du numéro, conservée parce qu'elle est nécessaire au dédoublonnage et à la
  recherche par sujet.

Cette empreinte ne permet pas de remonter au numéro sans la clé, mais elle demeure un
**identifiant stable**. Le régime applicable est donc la **pseudonymisation**, pas l'anonymisation.
L'AIPD doit employer ce terme, et ne pas annoncer des données « anonymisées » à l'échéance.

### 2.2 Le palier P1 n'est pas physiquement supprimable en l'état

L'effacement par clé ne s'applique qu'aux paliers chiffrés. La suppression **physique** des données
de palier P1 à leur échéance (10 ans) suppose la segmentation du fichier de registre — étape
d'industrialisation identifiée mais **non livrée**. À décrire comme telle, avec son échéance de
mise en œuvre.

### 2.3 La limite du chiffrement au repos

La phrase secrète réside en mémoire du processus pendant l'exécution. Un accès `root` sur la
machine en fonctionnement reste hors du périmètre couvert ; seul un **HSM ou un KMS souverain**
lèverait cette limite. La plateforme l'affiche dans sa propre posture de sécurité — l'AIPD gagne
à la reprendre plutôt qu'à laisser supposer une protection absolue.

### 2.4 Ce que le registre ne peut pas faire

Un registre chaîné et signé est **infalsifiable a posteriori par un tiers**, mais pas par
l'exploitant qui détient la clé. La parade retenue est l'**ancrage externe** : émission périodique
d'un reçu (rang, hash de tête, signature) destiné à un **dépôt chez un tiers de confiance**. Le
dépôt est un acte organisationnel : tant qu'il n'est pas effectué et formalisé, la garantie de
non-répudiation vis-à-vis de l'ARCEP elle-même n'est pas acquise. À inscrire dans la convention
avec la BEAC (Pièce 10) ou dans la procédure interne.

---

## 3. Cotation du risque de ré-identification — à réviser

L'AIPD §10 cotait le risque de « ré-identification via agrégats » en **Moyen / Faible**.

**Au moment de l'audit**, cette cotation était intenable : le jeton de sujet était un hachage non
clé du numéro — donc pré-calculable sur l'ensemble du plan de numérotation national — et le
traçage d'un individu n'exigeait qu'un module dispatché. La ré-identification était **triviale et
à la portée de tout titulaire du module `investigation`**.

**Après correctifs**, les mesures effectivement en place sont :

| Mesure | État |
|---|---|
| Jeton de sujet = HMAC-SHA256 **sous clé secrète** persistée hors code | ✅ livré |
| Traçage d'un sujet réservé aux profils habilités, **journalisé avec sa fenêtre** | ✅ livré |
| Fenêtre de traçage **bornée** (90 jours par défaut, plafonnée) — proportionnalité | ✅ livré |
| Palier P3 nominatif sous habilitation distincte | ✅ livré |
| Identifiants chiffrés au repos, par palier et par période | ✅ livré |
| Second facteur pour les profils habilités | ✅ livré |

**Cotation proposée :** vraisemblance **Faible**, gravité **Élevée** (la donnée reste sensible),
risque résiduel **Modéré** — sous réserve que les mesures organisationnelles suivent : habilitations
effectivement nominatives, revue périodique des accès, et dépôt des reçus d'ancrage.

Cette cotation doit être **justifiée par les mesures**, et non affirmée. Les éléments ci-dessus
sont vérifiables dans le code et couverts par la suite de tests.

---

## 4. Engagements restant à porter par la procédure, non par le code

| Engagement | Ce qui manque | Nature |
|---|---|---|
| §6 — destinataires (BEAC, COBAC, CRF, administration fiscale) | Aucun canal de transmission ni traçabilité de communication vers ces destinataires. Seuls des comptes ARCEP existent. | À construire (technique **et** conventionnel — cf. Pièce 10) |
| §9 — « audits réguliers et **tests d'intrusion** » | Aucun test d'intrusion externe réalisé à ce jour. | Organisationnel — à programmer **avant** mise en service |
| §9 — sauvegardes | Outillage livré ; transport hors site, périodicité et test de restauration périodique à formaliser. | Procédure d'exploitation |
| §7 — suppression physique du palier P1 | Segmentation du registre non livrée. | Industrialisation, avec échéance à annoncer |

---

## 5. Recommandation

L'AIPD peut être déposée **une fois les §1 à §3 de la présente note transposés**. Les points du §4
doivent y figurer comme **mesures programmées avec échéance**, ce que le canevas CNPDCP admet
expressément — un engagement daté est recevable, un engagement inexact ne l'est pas.

Le gain, au-delà de la conformité, est d'argument : le dispositif corrigé est **plus protecteur**
que celui que l'AIPD décrivait initialement. Il serait dommage de le sous-vendre.

---

*Note technique établie à l'appui du rapport d'audit du 24 août 2026. Chaque affirmation est
vérifiable dans le code source et couverte par la suite de tests automatisés.*
