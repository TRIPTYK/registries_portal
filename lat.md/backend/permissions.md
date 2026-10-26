# Permissions et contrôle d'accès (CASL)

Module `@libs/permissions-backend`/`@libs/permissions-front` : rôles et permissions pilotés par [CASL](https://casl.js.org/), stockés en base, gérables via une UI — remplace les anciennes comparaisons `user.role === "x"` en dur.

Portabilité délibérée : `permissions-backend` ne dépend d'aucune librairie métier (ni `users-backend`, ni les registres) — l'authentification (JWT) est injectée par la racine de composition, pas importée. But : pouvoir extraire ce module vers un futur template/boilerplate sans modification.

## Modèle de règles CASL en base

Deux entités : `Role` (nom, description) et `PermissionRule` (règles CASL brutes rattachées à un rôle) — pas de table de permissions normalisée séparée.

Chaque règle porte `{action, subject, conditions?, fields?, inverted, order}`. `conditions` supporte le jeton `"$user.id"`, interpolé à la construction de l'ability. `fields` existe mais n'est pas encore exploité par l'UI.

`order` détermine la priorité : CASL fait gagner la dernière règle qui matche, donc les règles `inverted` doivent porter un `order` plus élevé que les `can` qu'elles surclassent — cf. [[permissions#Seed des 4 rôles avec permissions équivalentes au comportement actuel]].

## Construction de l'ability CASL depuis les règles en base

[[@libs/permissions-backend/src/ability/ability-builder.ts#buildAbility]] transforme les `PermissionRule` d'un rôle en `AppAbility` via `createMongoAbility`, pas `AbilityBuilder` — les types stricts de ce dernier ne supportent pas des `action`/`subject` entièrement dynamiques.

Limite de typage assumée : vérifier une condition contre une instance réelle nécessite un cast (`as never`) côté appelant — le tuple `[string, string]` type le 2ᵉ paramètre de `can()` en `string` pur. Voir [[@libs/permissions-backend/tests/unit/ability-builder.test.ts]] pour le pattern.

## Guard requirePermission

[[@libs/permissions-backend/src/middlewares/require-permission.middleware.ts#requirePermission]] remplace l'ancien `requireRole` (supprimé, jamais branché). Il lit `request.ability` déjà construite et vérifie `ability.can(action, subject)` — 401 si absente, 403 si la permission manque.

## Module Fastify PermissionsModule

[[@libs/permissions-backend/src/init.ts#PermissionsModule]] expose les routes CRUD `/roles` (guardées `manage:Role`).

Son `authHook` est **injecté** au constructeur plutôt qu'importé de `users-backend` — c'est le point clé de sa portabilité : [[@apps/backend/src/app/app.ts]] construit `createJwtAuthMiddleware(...)` et le passe en paramètre.

## Attachement de request.ability au chargement de l'utilisateur

[[@libs/users-backend/src/middlewares/jwt-auth.middleware.ts#createJwtAuthMiddleware]] popule `user.role`, charge les `PermissionRule` de ce rôle, et attache `request.ability` à chaque requête.

Pas de mise en cache de l'ability : aucun risque de désynchronisation entre un JWT ancien et un changement de permission fait entre-temps en base.

## Migration de UserEntity.role vers une relation

[[@libs/users-backend/src/entities/user.entity.ts#UserEntity]] : `role` passe de `p.string().default("encoder")` à `p.manyToOne(RoleEntity)`.

Impact en cascade : toute requête qui sérialise/compare `user.role` doit `populate: ["role"]` puis lire `user.role.name`. Ce mécanique a aussi dû être appliqué dans `access-registry-backend`/`incident-registry-backend` (`user.role === "encoder"` → `user.role.name === "encoder"`), sans changer leur logique de guard — le retrofit CASL-natif de ces deux registres reste un chantier séparé.

## Création d'utilisateur guardée par manage:User

[[@libs/users-backend/src/routes/create.route.ts#CreateRoute]] : guard `requirePermission("manage", "User")` + validation `roleId` contre la base (400 si le rôle n'existe pas).

Referme le trou de sécurité documenté dans [[users-auth#RBAC sur le module users : résolu]] — n'importe quel utilisateur authentifié pouvait s'auto-assigner `tech_admin`.

## Édition d'utilisateur guardée par manage:User

[[@libs/users-backend/src/routes/update.route.ts#UpdateRoute]] : même guard, `roleId` optionnel.

Corrige aussi une régression latente — l'ancien body acceptait tous les attributs de `SerializedUserSchema` sans restriction (mass assignment), remplacé par un schéma explicite `{email?, firstName?, lastName?, roleId?}`.

## Fix du claim role manquant au refresh

[[@libs/users-backend/src/routes/refresh.route.ts#RefreshRoute]] régénère le JWT avec le même claim `role` que `LoginRoute` (`user.role.name`).

Le claim reste informationnel — l'autorisation repasse par `request.ability`, reconstruite à chaque requête (cf. [[permissions#Attachement de request.ability au chargement de l'utilisateur]]).

## Sérialisation du rôle dans les réponses users

[[@libs/users-backend/src/serializers/user.serializer.ts#jsonApiSerializeUser]] expose `roleId`/`roleName` (remplace l'ancien champ `role` inexistant côté API).

Le front (`@libs/users-front/src/schemas/users.ts`) suit le même renommage — tout composant lisant `currentUser.user.role` doit désormais lire `.roleName`.

## Guards manquants sur GET/DELETE /users

`ListRoute`, `GetRoute`, `DeleteRoute` (`@libs/users-backend/src/routes/{list,get,delete}.route.ts`) n'avaient aucun guard de permission — n'importe quel utilisateur authentifié pouvait lister, consulter et supprimer n'importe quel autre compte.

Contrairement à `CreateRoute`/`UpdateRoute` déjà gardées, seul le hook JWT du module protégeait ces trois routes. Corrigé en ajoutant `preHandler: [requirePermission("manage", "User")]`, identique au pattern create/update. `GET /profile` (`ProfileRoute`) reste volontairement non gardé : il retourne `request.user` (soi-même), pas la ressource `User` en général.

## Route GET /me/ability

[[@libs/permissions-backend/src/routes/get-my-ability.route.ts#GetMyAbilityRoute]] expose l'ability CASL du user courant au front : renvoie `request.ability.rules`, déjà construite par l'`authHook` injecté.

C'est le mécanisme officiel de CASL pour transmettre une ability serveur→client (`RuleIndex#rules`, cf. `@casl/ability`) : aucune logique de construction dupliquée, le front reconstruit une ability comportementalement identique via `createMongoAbility(rules)`. Les `conditions` (ex. jeton `$user.id`) sont déjà interpolées en valeurs concrètes côté backend au moment où `request.ability` a été construite — le front ne voit jamais le jeton brut.

Contrairement au bloc `/roles` du même `PermissionsModule` (gardé `manage:Role` au niveau du module entier), cette route vit dans un second `fastify.register` avec seulement le hook d'authentification — accessible à **tout** utilisateur authentifié, chacun ayant le droit de connaître ses propres permissions.

## Moteur de permissions front (AbilityService)

Le front dispose désormais d'une vraie ability CASL plutôt que du check `roleName === 'tech_admin'` de l'ancien `hasPermission()` (supprimé). Voir [[frontend/shared-front#Moteur de permissions front (AbilityService)]] pour l'implémentation.

## Édition de la matrice de permissions

[[@libs/permissions-backend/src/routes/update-role-rules.route.ts#UpdateRoleRulesRoute]] (`PUT /roles/:id/rules`) remplace l'intégralité des règles d'un rôle, pas un diff fin.

Côté front, le composant `role-permission-matrix.gts` (`@libs/permissions-front/src/components/role-permission-matrix.gts`) n'édite que `action`/`subject` via cases à cocher — `conditions` et `fields` restent gérés par seed/migration en v1.

## Suppression d'un rôle encore assigné

[[@libs/permissions-backend/src/routes/delete-role.route.ts#DeleteRoleRoute]] laisse la contrainte FK Postgres (`user.role_id`) faire le travail — capture `ForeignKeyConstraintViolationException` et renvoie 409, plutôt qu'une requête de comptage préalable qui couplerait le module à `users-backend`.

## Sélecteur de rôle réservé à tech_admin

Le composant `user-form.gts` (`@libs/users-front/src/components/forms/user-form.gts`) masque le sélecteur de rôle si `this.ability.can('manage', 'User')` est faux — défense en profondeur, la route étant déjà gardée.

`AbilityService` vit dans `@libs/shared-front` (pas `users-front` ni `permissions-front`) : `permissions-front` dépend déjà de `users-front` pour `CurrentUserService`, l'inverse créerait un cycle de dépendances workspace — `shared-front` n'a de dépendance vers aucune des deux, c'est le seul endroit neutre pour un service consommé par les deux. Remplace l'ancien `hasPermission()` (`@libs/users-front/src/utils/has-permission.ts`, supprimé), qui comparait `user.roleName === 'tech_admin'` en dur plutôt que de lire la matrice CASL réelle.

Le tableau de la liste des utilisateurs (composant `UsersTable`, `@libs/users-front/src/components/user-table.gts`) affiche aussi une colonne `roleName`, visible par tous (pas de gate `canManageRole` — lecture seule, contrairement au sélecteur d'édition).

## Seed des 4 rôles avec permissions équivalentes au comportement actuel

[[@apps/backend/src/seeders/seed-data/roles.ts#seedRolesAndPermissions]] crée les 4 rôles existants (`encoder`, `dpo`, `auditor`, `tech_admin`) et leurs `PermissionRule`. Le seeder de dev l'appelle avant les utilisateurs, la migration de prod à chaque déploiement ([[deployment#Migrations au déploiement]]).

`auditor` porte `read AccessRecord` en plus de `read AccessRecordIntegrity`/`read IncidentIntegrity` — gap découvert lors du retrofit CASL d'access-registry-backend/incident-registry-backend (`specs/done/02-permissions-registries-retrofit.md`) : le comportement pré-CASL laissait `auditor` consulter librement le registre d'accès (list/get non restreints), un seed sans cette règle l'aurait bloqué à tort une fois `requirePermission("read", "AccessRecord")` posé sur `get.route.ts`. Les tests d'intégration des deux registres seedent la même liste de règles (`tests/utils/permission-rule-seed.ts` dans chaque lib) pour rester fidèles à ce comportement.

`encoder`, `dpo` et `auditor` portent aussi désormais `read Incident` — un audit de sécurité a révélé que cette règle manquait totalement (seul `encoder` avait `create Incident`), alors que plusieurs routes d'incident-registry-backend n'avaient aucun `requirePermission` propre pour compenser (cf. [[incident-registry#Guards manquants comblés sur list/get/export/export-one]]).

`tech_admin` porte `read AccessRecord` (en plus de `manage User`/`manage Role`) : il accède au **registre d'accès** en lecture (list/get/export/stats/audit-events), remplaçant l'ancien `manage AccessRecord` inversé qui l'en bannissait totalement. Il reste banni du **registre des incidents** (`manage Incident` inversé, `order` 10). Cf. la séparation détaillée dans [[access-registry#RBAC : séparation des rôles]].

Un utilisateur `tech_admin` (`gilles@triptyk.eu`) est seedé avec les deux autres (`encoder`, `dpo`) — sans lui, une base de dev fraîche n'a personne capable de gérer les rôles via l'UI. Un utilisateur `auditor` (`auditor@triptyk.eu`, id `e2e-auditor-user`) est désormais seedé aussi — absent jusqu'ici malgré le rôle lui-même existant depuis le début.

## Matrice de couverture obligatoire

Un test paramétré (`describe.each` sur les 4 rôles, [[@libs/users-backend/tests/integration/permissions-matrix.test.ts]]) exerce `POST /users`, `GET /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id` et `GET /roles` avec un utilisateur fixture par rôle.

Complété par des tests CRUD dédiés sur `/roles` dans [[@libs/permissions-backend/tests/integration/roles.route.test.ts]] (guard, doublon de nom, suppression refusée si rôle utilisé) et sur `/me/ability` dans `@libs/permissions-backend/tests/integration/get-my-ability.route.test.ts` (les rules renvoyées reflètent exactement celles du rôle de l'appelant, jamais celles d'un autre rôle).

Complété côté routage par des tests d'acceptance Ember (`visit()`) dans `@libs/permissions-front/tests/acceptance/roles-test.gts` et `@libs/users-front/tests/acceptance/users-test.gts` — vérifient la redirection de `/dashboard/roles*`/`/dashboard/users*` pour une ability sans la permission requise (avec un flash `danger` visible pour `users-test.gts`), et la non-redirection quand l'ability l'autorise.

Même pattern répliqué dans `@libs/access-registry-front/tests/acceptance/access-records-test.gts` (`/dashboard/access-records`, `/dashboard/access-records/create`, `/dashboard/audit-events`) et `@libs/incident-registry-front/tests/acceptance/incidents-test.gts` (`/dashboard/incidents`, `/dashboard/incidents/create`, `/dashboard/incidents/:incident_id`) — flash `danger` vérifié sur les six routes cette fois. Écrire ces tests a révélé que `/dashboard/audit-events` n'était monté nulle part dans `forRouter()` (cf. [[permissions#Gating manquant sur AccessRecord/Incident côté front]]) et que le bug de glob décrit dans [[permissions#Extensions .gts/.gjs dans le glob du module registry]] existait aussi dans ces deux libs.

## Redirection bloquante dans beforeModel

Un garde de route dans `beforeModel()` doit `return this.router.transitionTo(...)`, pas l'appeler sans le retourner — sinon Ember ne considère pas la transition courante comme abandonnée et `model()` s'exécute quand même.

Bug découvert en écrivant les tests d'acceptance : les redirections de `/dashboard/roles`, `/dashboard/roles/create`, `/dashboard/roles/edit` (et l'équivalent côté `/dashboard/users`) n'avaient aucun effet observable tant que l'appel n'était pas retourné. Ce pattern (garde + flash + redirection) est désormais centralisé dans [[frontend/shared-front#Moteur de permissions front (AbilityService)]] (`requireAbilityOrRedirect`), appelé identiquement par les 6 routes `users-front`/`permissions-front` concernées — plus de duplication du snippet.

## Gating manquant sur AccessRecord/Incident côté front

Un audit a montré qu'un `tech_admin` (aucune règle CASL sur `AccessRecord`/`Incident`) voyait quand même les entrées "Access registry"/"Incident registry" du sidebar et naviguait sur leurs routes, contrairement à `Users`/`Roles` déjà gatées.

Cf. [[permissions#Seed des 4 rôles avec permissions équivalentes au comportement actuel]] pour le rationale du seed sans règle `AccessRecord`/`Incident` pour `tech_admin`.

Le sidebar (`DashboardTemplate#menuItems`, `@apps/front/app/templates/dashboard.gts`) entoure désormais ces deux entrées du même spread conditionnel que `Users`/`Roles` : `...(this.ability.can('read', 'AccessRecord') || this.ability.can('create', 'AccessRecord') ? [...] : [])` (idem `Incident`). Le `||` sur `read`/`create` est nécessaire car un `encoder` n'a que `create AccessRecord` inconditionnel + `read AccessRecord` conditionné à `encodedBy: $user.id` — un simple `can('read', ...)` sans instance suffit déjà à passer (CASL ignore les `conditions` lors d'un check de type sans instance), mais `create` couvre aussi un rôle qui n'aurait que la permission de créer.

Six routes ont reçu le même guard `beforeModel()` que `UsersIndexRoute` (`requireAbilityOrRedirect`, cf. [[permissions#Redirection bloquante dans beforeModel]]) : `access-registry-front/src/routes/dashboard/{access-records/index,access-records/create,audit-events/index}.gts` (`read`/`create`/`read AccessRecord`) et `incident-registry-front/src/routes/dashboard/incidents/{index,create,show}.gts` (`read`/`create`/`read Incident`). Les deux routes qui avaient déjà un `model()` (`access-records/create`, `incidents/show`) gardent leur fetch existant, le guard est juste ajouté en plus.

Testé dans `@apps/front/tests/integration/dashboard-menu-test.gts` (étend la suite `Users`/`Roles` existante) : une ability sans aucune règle sur ces deux subjects masque les entrées, une ability de type `encoder` (`create`/`read` conditionné sur les deux) les affiche.

## Schéma WarpDrive Role manquant dans le store de l'app

`@apps/front/app/services/store.ts` doit enregistrer `RoleSchema` dans son tableau `schemas`, comme chaque autre ressource (`Todo`, `Incident`, `AccessRecord`…) — sinon `store.request(query('roles', {}))` échoue.

Schéma : `@libs/permissions-front/schemas/roles`. Bug découvert en testant `/dashboard/roles` en conditions réelles (hors tests) : la page restait vide sans requête réseau ni erreur console. Corrigé en ajoutant l'import et l'entrée manquants.

## Redémarrage complet requis après ajout d'une nouvelle lib front

Embroider calcule la fusion de l'arbre `_app_` de chaque addon **une seule fois au démarrage** du serveur Vite — ajouter une nouvelle lib comme dépendance de `@apps/front` n'est pas repris par le hot-reload habituel.

Symptôme sur un serveur démarré avant l'ajout de la lib : la route existe (router + fichier JS servis) mais `beforeModel()`/`model()` ne s'exécutent jamais — page silencieusement vide, sans requête réseau ni erreur console. Toujours relancer `pnpm dev` (pas juste compter sur le HMR) après avoir ajouté une nouvelle lib `@libs/*-front` aux dépendances de `@apps/front`.

## Extensions .gts/.gjs dans le glob du module registry

`moduleRegistry()` (`src/index.ts` de chaque lib front) doit lister `.gjs`/`.gts` dans ses patterns `import.meta.glob`, sinon les fichiers `.gts` ne matchent rien et ne sont jamais enregistrés, silencieusement.

Pattern attendu : `'./routes/**/*.{js,ts,gjs,gts}'` (idem pour `templates`, `helpers`, `components`, `services`).

Bug découvert dans `permissions-front` (aucune route de `/dashboard/roles` n'était réellement montée, donc aucun guard ne s'exécutait) puis retrouvé identique dans `users-front`. Corrigé dans [[@libs/permissions-front/src/index.ts#moduleRegistry]] et [[@libs/users-front/src/index.ts#moduleRegistry]].

Même bug retrouvé dans `access-registry-front` et `incident-registry-front` en écrivant leurs tests d'acceptance (cf. [[permissions#Matrice de couverture obligatoire]]) : leurs guards `beforeModel()` n'avaient jamais tourné dans le harnais de test isolé. Corrigé uniquement sur le pattern `routes` dans [[@libs/access-registry-front/src/index.ts#moduleRegistry]] et [[@libs/incident-registry-front/src/index.ts#moduleRegistry]] — `templates`/`helpers`/`components`/`services` restent en `.{js,ts}` dans ces deux libs : leurs templates de route (co-localisés en `*-template.gts` sous `routes/`, déjà couverts par le pattern `routes`) invoquent leurs composants par import lexical direct (`<AccessRecordTable />`), pas par lookup du resolver, donc l'enregistrement de `components`/`templates` n'est pas requis pour le rendu. Élargir aussi ces patterns fait apparaître un rejet de promesse non géré, déterministe mais sans rapport avec les guards (getter `.text` d'un `pageObject` d'ember-cli-page-object évalué par le pretty-printer de Vitest sur un élément déjà démonté d'un test précédent) — non reproduit en élargissant seulement `routes`.
