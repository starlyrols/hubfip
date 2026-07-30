# M14 — Dictionnaire machine des lots de collecte (schémas JSON)

Ces schémas (JSON Schema draft 2020-12) sont la contrepartie machine des gabarits Excel de
[docs/gabarits/](../) : ils définissent les **contrôles bloquants d'ingestion** exigés par
EX-L2-02 (types, plages, énumérations, complétude) pour les lots convertis en JSON — dépôt
API ou conversion automatique des classeurs à l'ingestion.

| Schéma | Gabarit Excel correspondant | Périodicité | Déclarant |
|---|---|---|---|
| [n0-operateur-mm.schema.json](n0-operateur-mm.schema.json) | `gabarit-N0-operateur.xlsx` | Mensuelle | Opérateurs / EME |
| [n0-poste.schema.json](n0-poste.schema.json) | `gabarit-N0-poste.xlsx` (SP-A..D) | Trimestrielle | Opérateur postal |
| [n0-registre-psp.schema.json](n0-registre-psp.schema.json) | `gabarit-N0-registre-psp.xlsx` (L8 / AT-01..03) | Trimestrielle | Opérateur hôte |
| [manifeste.schema.json](manifeste.schema.json) | — (accompagne chaque dépôt, EX-L2-01) | À chaque dépôt | Tous |

## Règles d'usage

1. **Validation bloquante** : un lot qui ne valide pas contre son schéma est rejeté et le
   déclarant notifié (EX-L2-02). Le taux de rejet par acteur est un indicateur interne.
2. **Contrôles inter-champs** : les règles non exprimables en JSON Schema (sommes croisées,
   chronologies, vraisemblance) sont déclarées dans la clé `x-controles` de chaque schéma,
   avec leur niveau (`bloquant` ou `non bloquant — signalement`). Le moteur d'ingestion les
   implémente ; la liste fait foi.
3. **Aucune donnée nominative** : les champs texte libres utilisent le type
   `texteCourtSansMsisdn`, qui rejette tout motif de MSISDN (+241…) ou longue suite de
   chiffres — application d'EX-L5-01 dès le niveau N0.
4. **Versionnage** : toute évolution d'un schéma incrémente `version_schema` du manifeste ;
   les gabarits Excel et les schémas évoluent ensemble (même décision, REF-06).
5. **Énumérations** : les codes (provinces, canaux, types d'opération, services postaux,
   statuts) sont les référentiels opposables ; les libellés français des classeurs Excel y
   sont mappés à l'ingestion.

## Correspondance libellés Excel ↔ codes machine

| Excel (classeur) | Code (schéma) |
|---|---|
| Dépôt (cash-in) / Retrait (cash-out) | `CASHIN` / `CASHOUT` |
| P2P intra-réseau / P2P inter-réseaux | `P2P_INTRA` / `P2P_INTER` |
| Paiement marchand / Paiement de facture | `MARCHAND` / `FACTURE` |
| Recharge de crédit / Transfert international | `AIRTIME` / `INTERNATIONAL` |
| STK (SIM Toolkit) / Application mobile / API (PSP tiers) | `STK` / `APP` / `API` |
| USSD dédié / USSD mutualisé / API de gros | `USSD_DEDIE` / `USSD_MUTUALISE` / `API_GROS` |

Le schéma des lots détaillés N1 (`n1-evenements`) sera publié avec la décision de collecte
N1 (phase 1 du plan L11), après validation de l'AIPD — il n'est volontairement pas défini ici.
