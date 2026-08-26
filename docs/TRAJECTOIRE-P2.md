# Trajectoire d'industrialisation — ce que les mesures changent

**Objet :** dimensionnement mesuré de la plateforme, et conséquences sur la migration vers la
pile cible du cahier des charges (§4).

**Date :** 24 août 2026 · **Fondement :** `npm run loadtest`, exécuté sur un nœud unique.

---

## 1. Ce que le nœud unique encaisse réellement

Le cahier vise « des millions de TDR par jour ». Personne ne l'avait vérifié : les seuls chiffres
disponibles venaient du simulateur, qui produit une transaction toutes les 1,5 seconde. Le harnais
de charge injecte désormais du flux **réel** par le connecteur — signature nominative, contrôle de
contrat, scellement au registre compris — et mesure en parallèle la **latence de la console**, parce
qu'un débit d'ingestion flatteur obtenu en gelant l'interface de supervision ne vaut rien.

| Configuration | Débit soutenu | Équivalent journalier | Latence console (max) |
|---|---:|---:|---:|
| `fsync` par enregistrement | 177 TDR/s | 15,3 M/jour | **25 108 ms** ⚠ |
| **Validation groupée** (défaut) | **446 TDR/s** | **38,5 M/jour** | **4 ms** ✓ |

Deux enseignements, tous deux issus de la mesure et non de l'estimation :

**Le `fsync` par enregistrement était le goulot dominant.** Un appel système bloquant par
transaction ne tient pas à l'échelle d'un marché : à 400 TDR/s, la console mettait 25 secondes à
répondre. La **validation groupée** — écriture immédiate, synchronisation disque regroupée toutes
les 64 écritures ou 200 ms — multiplie le débit par 2,5 et ramène la console à 4 ms, chaîne
vérifiée valide après charge. La fenêtre de risque est explicite et documentée : une coupure
d'alimentation pourrait coûter les enregistrements des 200 dernières millisecondes. `SUMO_FSYNC=strict`
restaure l'ancien comportement pour qui préfère l'autre arbitrage.

**Le test a révélé un défaut que la revue de code n'avait pas vu.** Le quota général de l'API
(240 requêtes/minute, dimensionné pour un usage humain) s'appliquait au canal d'ingestion : la
plateforme refusait **97 % d'un flux légitime de 400 TDR/s**. Une limite conçue pour protéger une
interface aurait rendu le dispositif inopérant à l'échelle visée. C'est exactement ce qu'un test de
charge est censé trouver, et ce qu'aucune relecture ne trouve.

---

## 2. Ce que cela change pour la migration

**38,5 millions de TDR par jour sur un seul nœud** dépasse largement le volume national attendu.
La conséquence est importante et mérite d'être dite clairement :

> La migration vers Kafka, Flink et ClickHouse **n'est pas commandée par le débit**. Elle l'est par
> la **disponibilité**, la **résilience** et la **séparation des responsabilités**.

Cela déplace l'ordre des priorités. Il serait coûteux et risqué de reconstruire l'ingestion autour
de Kafka pour résoudre un problème de débit qui ne se pose pas. En revanche, un nœud unique reste
un **point de défaillance unique** : c'est là que se situe le vrai motif de migration.

### Ce qui justifie réellement la pile cible

| Composant cible | Motif réel | Urgence |
|---|---|---|
| **Journal distribué** (Kafka/NiFi) | Découpler la réception de la validation : un incident de la plateforme ne doit pas faire perdre les déclarations des assujettis. **C'est le motif le plus fort.** | Haute |
| **Entrepôt analytique** (ClickHouse/Druid) | Les rapports sur période parcourent le registre ; au-delà de quelques dizaines de millions d'enregistrements, un entrepôt colonnaire s'impose pour l'observatoire. | Moyenne |
| **IAM fédéré** (Keycloak) | Fédération avec l'annuaire de l'ARCEP, et second facteur géré centralement. Le mécanisme livré est autonome et fonctionnel, mais il duplique un annuaire. | Moyenne |
| **Orchestration** (Kubernetes souverain) | Redémarrage automatique, montée en charge des lecteurs, gestion des secrets. | Moyenne |
| **PostGIS** | Requêtes géographiques réelles (aujourd'hui : corrélation par identifiant de cellule). | Basse |
| **Flink/Spark** | Traitement à l'échelle du flux. **Le pipeline actuel tient largement le volume national** — à réévaluer seulement si le périmètre s'élargit (sous-région, autres services financiers). | Basse |

---

## 3. Ce qui est déjà livré pour préparer la migration

L'architecture a été rendue **migrable** sans être migrée. Les contrats sont stables ; les pilotes
changent.

**Multi-instance — le pas concret** (`SUMO_ROLE`). Le registre impose un écrivain unique : c'est ce
qui a détruit 108 457 enregistrements le 8 août 2026 quand deux processus ont écrit ensemble. On ne
peut donc pas multiplier les instances complètes — mais on peut multiplier les **lecteurs**. Une
instance `SUMO_ROLE=reader` ne prend aucun verrou, n'ingère rien, ne purge rien, et sert la console
et les rapports depuis le volume partagé. Elle exécute en revanche le contrôle d'intégrité, ce qui
est utile : elle vérifie ce que l'écrivain produit. Écrivain et lecteurs coexistent, vérifié.

**Ce qu'il reste à externaliser pour un multi-instance complet :**

- les **sessions**, aujourd'hui en mémoire — donc affinité de session obligatoire au répartiteur, ou
  passage à un magasin partagé ;
- l'**entrepôt analytique**, aujourd'hui en mémoire par instance ;
- le **verrou d'écrivain**, aujourd'hui un fichier — donc lié à un volume partagé, pas à un quorum.

**Points d'extension déjà en place :** l'entrepôt relationnel est optionnel et pilotable
(`DATABASE_URL`), avec écriture par lots, contre-pression et santé exposée ; le parcours du registre
vit dans un fil dédié qu'un service externe pourrait remplacer ; le modèle TDR, le contrat
d'interfaçage et les API sont le contrat stable de toute migration.

---

## 4. Ce qui est mesuré, et ce qui ne l'est pas

**Mesuré** — débit d'ingestion soutenu, latence d'ingestion et de console sous charge, intégrité de
chaîne après charge, effet de la validation groupée, saturation par le quota console.

**Non mesuré, et à programmer avant mise en service :**

- **Test d'intrusion externe.** L'AIPD s'y engage ; il n'a pas eu lieu. Aucune revue de code, aussi
  minutieuse soit-elle, ne remplace un attaquant.
- **Charge sur registre volumineux.** Les mesures portent sur un registre qui grandit pendant le
  test ; le comportement à plusieurs centaines de millions d'enregistrements — parcours de rapport,
  contrôle intégral, temps de démarrage — reste à établir.
- **Rejeu de reprise après incident.** La procédure existe ; sa durée sur un gros volume n'est pas
  chiffrée.
- **Tenue de la mémoire sur plusieurs semaines.** Les tables plafonnées (sujets, historique de
  règles, profils) sont bornées par conception, mais aucune observation longue ne le confirme.

---

## 5. Recommandation de séquence

1. **Programmer le test d'intrusion externe** — c'est le seul engagement de l'AIPD qui reste
   entièrement ouvert, et il conditionne la mise en service.
2. **Déployer un ou deux lecteurs** derrière le répartiteur : gain de disponibilité immédiat pour
   la consultation, sans toucher à l'architecture d'écriture.
3. **Externaliser les sessions**, ce qui lève l'affinité de session et rend les lecteurs réellement
   interchangeables.
4. **Introduire le journal distribué en réception** — le vrai gain de résilience — en conservant le
   registre signé comme source de vérité en aval.
5. **Entrepôt analytique** quand le volume historique le commandera, et non par anticipation.

Le reste de la pile cible peut attendre que le besoin se manifeste. Migrer ce qui fonctionne, au
motif qu'une architecture de référence le prévoit, coûte du risque sans acheter de garantie.

---

*Mesures reproductibles : `npm run loadtest -- --rate 400 --duration 25`. Le harnais signale
lui-même s'il sature avant le serveur, auquel cas la mesure ne vaut rien et le dit.*
