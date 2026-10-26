# Chaîne d'intégrité hash-chain partagée

Le registre d'accès et le registre d'incidents partagent la même primitive de chaînage cryptographique (hash-chain) définie dans `@libs/backend-shared`, garantissant qu'aucune ligne ne peut être falsifiée sans casser la chaîne.

Chaque table append-only (`access_record`, `incident`, `audit_event`) porte `seq`, `hash`, `prevHash`. Le hash d'un enregistrement = `sha256(prevHash + "||" + canonicalSerialize(record sans hash/prevHash))`. Le premier maillon référence `GENESIS_HASH` (64 zéros). Cette logique est centralisée une seule fois et réutilisée par `AppendService` (access-registry), `AppendService` (incident-registry) et `AuditAppendService` (audit-log) — décision d'architecture : ne pas dupliquer le chaînage par domaine.

`canonicalSerialize` ([[@libs/backend-shared/src/hash-chain/canonical.ts#canonicalSerialize]]) trie les clés récursivement et exclut `hash`/`prevHash` du calcul — nécessaire pour que la vérification retrouve un hash identique indépendamment de l'ordre d'insertion JS des propriétés.

L'insertion est protégée par un verrou consultatif Postgres (`pg_advisory_xact_lock`) avec une clé numérique dédiée par domaine : `1_000_000_001` (access-registry), `1_000_000_002` (audit-log), `1_000_000_003` (incident-registry) — pour sérialiser le calcul `seq`/`prevHash` sous concurrence et éviter les collisions de séquence.

[[@libs/backend-shared/src/hash-chain/hash-chain.ts#verifyChain]] rejoue toute la chaîne et renvoie `{brokenAt, reason}` sur le premier maillon incohérent (prevHash mismatch, hash mismatch) — utilisé à la fois par les routes `verify-integrity` de chaque registre et par leurs services d'export respectifs.

`incident-registry-backend` a son propre jeu de champs canoniques ([[@libs/incident-registry-backend/src/utils/incident-canonical.ts#INCIDENT_CANONICAL_VERSIONS]]) — toute évolution du schéma incident doit mettre à jour cette liste sous peine de rompre silencieusement la vérification de chaîne pour les nouveaux enregistrements (les anciens restent valides avec l'ancien jeu de champs, aucune migration de re-hash n'existe).

## Défense en profondeur : triggers Postgres append-only

En plus du chaînage applicatif, des triggers Postgres bloquent physiquement les mutations hors application — deuxième ligne de défense.

`access_record` et `audit_event` sont **totalement** figés (UPDATE/DELETE/TRUNCATE interdits) ; `incident` est figé **sur son contenu uniquement** : ses colonnes lifecycle (versioning/soft-delete) doivent rester mutables.

`forbid_mutation()` (fonction PL/pgSQL définie dans [[@apps/backend/src/cli/append-only.sql.ts#APPEND_ONLY_DDL]]) lève une exception sur toute tentative de mutation ; elle protège `access_record`/`audit_event` (UPDATE+DELETE+TRUNCATE) et, sur `incident`, le DELETE et le TRUNCATE. Pour l'UPDATE d'`incident`, le trigger `incident_no_mutation` utilise `forbid_incident_content_mutation()` qui compare `to_jsonb(OLD)` et `to_jsonb(NEW)` en excluant les 6 colonnes lifecycle (`revision`, `superseded_by_id`, `updated_by`, `updated_at`, `deleted_at`, `deleted_by`) : toute modification d'une colonne de contenu lève une exception, la mutation lifecycle passe. Les triggers sont créés de façon idempotente (`IF NOT EXISTS` sur `pg_trigger`) pour supporter les re-runs de migration/schema-fresh.

Décision explicite : la garantie d'immuabilité ne repose pas uniquement sur la discipline applicative (`AppendService`) — un accès direct psql ou un bug de migration ne peut pas casser la chaîne, car la DB elle-même refuse la mutation. Testé côté access-registry (`@libs/access-registry-backend/tests/integration/verify-integrity.route.test.ts`) : `UPDATE`/`DELETE` directs déclenchent bien l'exception du trigger.

### Contourner les triggers dans un test

Les tests de falsification contournent les triggers par `SET LOCAL session_replication_role = replica`, jamais par `ALTER TABLE … DISABLE TRIGGER`.

Les fichiers d'intégration tournent en parallèle sur une même base. `ALTER TABLE` prend un verrou de table, et croisé avec l'insertion d'un autre fichier sur la même clé `seq`, il provoquait des deadlocks intermittents en CI. `SET LOCAL` ne vaut que pour la transaction du test, annulée à la fin, et ne verrouille rien. Il exige un superutilisateur, ce qu'est l'utilisateur du conteneur de test.

## Jeu de champs canoniques versionné

Décision (ADR, CNIL 0) : la liste des champs entrant dans le hash est **versionnée**, et chaque ligne porte la version sous laquelle elle a été écrite. Le schéma peut donc grandir sans invalider les hashs déjà écrits.

### Le problème réel : deux listes indépendantes, pas une

Le défaut n'était pas que la liste canonique soit une whitelist, mais qu'il en existait **deux**, tenues synchronisées à la main et jamais comparées par un test.

Le chemin d'écriture hachait `{id, seq, reference, encodedAt, prevHash, ...input}` — un *spread* de `NewIncidentInput` — tandis que le chemin de vérification utilisait une whitelist explicite de 48 clés. La panne était donc symétrique, et la moitié la plus dangereuse n'était pas documentée :

- ajouter le champ à la whitelist de vérification casse les **anciennes** lignes ;
- ajouter le champ à `NewIncidentInput` casse les **nouvelles**, immédiatement et silencieusement, parce que l'écriture bouge seule.

Un ticket touchant le schéma Zod et `toNewIncidentInput` déclenchait le second cas sans jamais ouvrir `integrity.ts`. Versionner la seule vérification aurait aggravé la situation : cela aurait numéroté une liste qui n'était pas celle réellement hachée. Les deux chemins passent donc désormais par [[@libs/incident-registry-backend/src/utils/incident-canonical.ts#incidentCanonicalString]], unique source de vérité.

### Options écartées

Quatre alternatives ont été évaluées avant de retenir le versionnage.

- **Omettre les champs nuls ou absents de la chaîne canonique.** Rend `{a: null}` et `{}` indistinguables, change le sens de tous les hashs déjà écrits (y compris access-registry) et échoue sur toute colonne dotée d'un défaut non nul.
- **Stocker la chaîne canonique sur la ligne et hacher cela.** Circulaire : une mutation cohérente du contenu ET de la copie stockée laisse le hash valide. Acceptable comme aide au débogage, jamais comme source de la vérification.
- **Migration de ré-hachage.** Interdite par le trigger `incident_no_mutation`, et autodestructrice : qui peut légitimement ré-hacher peut légitimement falsifier. Invalide aussi tout ancrage externe de la tête de chaîne.
- **Nouveaux champs CNIL dans une table chaînée annexe.** Une jointure n'est pas une chaîne. Place les champs les plus intéressants à falsifier dans la chaîne la plus récente et la moins éprouvée, et double la surface à vérifier.

### canonicalVersion appartient au jeu canonique

Contre-intuitif : le numéro de version est **dans** le hash (depuis la v2 qui l'introduit), et **hors** du tableau `lifecycle` du trigger. Trois raisons, la première étant concrète.

1. `forbid_incident_content_mutation()` autorise explicitement l'UPDATE des colonnes listées dans son tableau `lifecycle`. Y ranger `canonical_version` la rendrait légalement mutable : n'importe quel accès applicatif pourrait alors faire déclarer la chaîne rompue, sans exception ni trace d'audit. Un déni d'intégrité sur un registre de conformité est bon marché à monter et coûteux à réfuter. Hors du tableau, Postgres gèle la colonne gratuitement.
2. Elle ne change jamais après l'écriture. C'est donc du contenu, pas du cycle de vie : les six colonnes lifecycle sont exclues parce qu'elles évoluent légitimement, ce qui n'est pas son cas.
3. C'est une affirmation sur la façon d'interpréter la ligne. Dans le hash, celui-ci **prouve** sous quelle liste la ligne a été écrite ; dehors, on ne peut que constater une cohérence avec la colonne telle qu'elle est lue. Le coût est nul.

À noter, pour ne pas surestimer l'argument : hors du jeu canonique le mécanisme reste *fail-closed* (changer la version change la liste, donc la chaîne canonique, donc le hash — la falsification est détectée dans les deux sens). Le choix se joue sur le risque de trigger et sur la prouvabilité, pas sur une faille.

Conséquence directe : la liste v1 **omet** la clé (les lignes v1 ont été hachées sans elle), la v2 et les suivantes l'incluent.

### Une version identifie une liste DÉPLOYÉE, pas un commit

Règle de numérotation, sans laquelle CNIL 1–9 produiraient dix listes : une version reste ouverte tant qu'aucune de ses lignes n'existe en production. Déployée, elle est figée.

Les neuf tickets CNIL visent donc tous la **v2**. Le passage en v3 n'est requis que pour un champ ajouté après la mise en production de la v2.

### Versions figées par un hash de référence

Une version déployée est immuable, et un commentaire ne l'impose pas. `tests/unit/incident-canonical.test.ts` fige chaque version par deux assertions : la liste triée de ses noms de champs, et le hash sha256 d'une ligne de référence gelée ([[@libs/incident-registry-backend/tests/unit/canonical-fixtures.ts#frozenIncidentRow]]).

Modifier la liste d'une version déployée casse ces tests. C'est la seule protection réelle de la chaîne historique, puisqu'aucune migration de ré-hachage n'est possible.

### Test d'exhaustivité sur les colonnes de l'entité

C'est le garde-fou qui débloque réellement les tickets CNIL. Le test compare les colonnes de `IncidentEntity` à l'union « champs de la version courante + [[@libs/incident-registry-backend/src/utils/incident-canonical.ts#NON_CANONICAL_INCIDENT_FIELDS]] ».

Ajouter une colonne sans décider de son statut canonique fait donc échouer un test unitaire, au lieu de casser silencieusement la vérification des nouvelles lignes des mois plus tard. Le `satisfies Omit<IncidentEntityType, "hash">` de l'`AppendService` joue le même rôle au type-check.

### Chaîne mixte v1 + v2

`verifyIncidentChain` lit la version sur chaque ligne : une chaîne mêlant lignes v1 et v2 se vérifie donc sans ré-hachage. Une version inconnue lève une exception plutôt que de déclarer la ligne intègre (fail-closed).

Couvert à deux niveaux : en unitaire sur une chaîne construite à la main (v1 → v2 → v2, plus falsification d'un champ v1, d'un champ v2 et d'un champ v2-only), et en intégration sur une vraie base — une ligne v1 insérée directement, puis une ligne v2 créée par l'API et chaînée dessus.

### Application de la colonne à une base existante

`schema:fresh` recrée tout. Sur une base contenant déjà des incidents, jamais `schema:update`, qui supprime les triggers d'immuabilité : en prod, une migration ([[deployment#Migrations au déploiement#Ajouter une migration]]), ailleurs, à la main :

```sql
ALTER TABLE incident ADD COLUMN canonical_version int NOT NULL DEFAULT 1;
```

Le défaut à 1 est ce qui rend la migration gratuite : les lignes existantes se vérifient sous la liste v1 qui les a hachées, et l'`AppendService` estampille 2 sur toute nouvelle ligne.

### access-registry et audit-log

Même primitive, même fragilité, pas encore le même besoin. `access_record` n'a pas de colonne de version : sa première évolution de schéma devra en ajouter une (`DEFAULT 1`, liste v1 inchangée, donc gratuit) en réutilisant [[@libs/backend-shared/src/hash-chain/versioned-canonical.ts#pickCanonicalFields]].

Deux dettes constatées et volontairement hors périmètre de CNIL 0 : access-registry maintient **trois** copies de sa liste de champs (append service, `integrity.ts`, et à nouveau en ligne dans sa route `verify-integrity`), et la chaîne `audit_event` n'a **aucun vérificateur** en code de production — seulement une copie de la liste dans un test.
