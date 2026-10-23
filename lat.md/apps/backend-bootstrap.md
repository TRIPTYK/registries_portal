# Bootstrap et assemblage des modules backend

Composition root explicite et sans framework DI : [[@apps/backend/src/configuration.ts#loadConfiguration]] (validation Zod stricte de l'environnement) → [[@apps/backend/src/app/application.context.ts#createApplicationContext]] → [[@apps/backend/src/app/app.ts#App]] qui instancie et branche chaque module `*-backend` à la main.

`loadConfiguration` valide `process.env` avec un schéma Zod unique ; en cas d'échec, l'erreur liste précisément quelles variables manquent vs sont invalides. `createApplicationContext` construit un objet `{configuration, logger, orm}` unique injecté partout — pas de DI framework, juste un objet de contexte passé explicitement. `App` enregistre les plugins Fastify dans un ordre figé (session sécurisée + passport, puis CORS, swagger, fichiers statiques) puis instancie chaque module avec un EntityManager forké (`orm.em.fork()`) par module, cf. [[platform#Contrat de module Fastify partagé]].

## Assemblage incident-registry (module désormais branché)

`@libs/incident-registry-backend` est maintenant instancié dans `App.setupRoutes` et enregistré dans [[platform#Contrat de module Fastify partagé|appRouter]] via `incidentRegistryModule`.

`IncidentRegistryModule.init(...)` prend la même forme que `AccessRegistryModule` : `em` forké + `configuration.{jwtSecret,exportSigningKey}` + une instance `AuditAppendService`.

Historique : ses entités étaient déjà enregistrées dans [[@apps/backend/src/app/database.connection.ts#databaseConfig]] (nécessaire pour que le seeder de dev fonctionne, cf. [[incident-registry#Champs texte long : p.text() requis pour legalContext/description/conclusion]]), mais le module Fastify lui-même ne l'était pas — la route HTTP `/incidents` n'existait donc pas malgré un schéma DB fonctionnel et un code de route complet. Symétrique au branchement frontend, cf. [[front-integration]].

## Secrets et seeding déterministe

Secrets chiffrés SOPS + age (`.env.enc`/`.env.e2e.enc` versionnés), déchiffrés par `scripts/dev-setup.mjs` avec écriture atomique tmp+mv.

`mikro-orm.config.ts` fixe une seed déterministe (`@ngneat/falso`) pour la reproductibilité des données générées.

`seedersList` ([[@apps/backend/src/app/database.connection.ts#databaseConfig]]) enregistre explicitement [[@apps/backend/src/seeders/development.seeder.ts#DatabaseSeeder]] et [[@apps/backend/src/seeders/e2e.seeder.ts#E2ESeeder]] par référence plutôt que par scan disque — la découverte par glob de MikroORM échouait sous vite-node en CI. `E2ESeeder` (utilisateurs seulement) et `DatabaseSeeder` (référentiels RGPD + incidents de démo) sont deux jeux de données volontairement distincts.

## Drapeaux de fonctionnalité par domaine

Un domaine peut être retiré de la production par une variable d'environnement : il n'est alors pas monté, et ses routes n'existent pas.

`FEATURE_TODOS`, `FEATURE_ACCESS_REGISTRY` et `FEATURE_INCIDENT_REGISTRY` sont déclarées dans [[@apps/backend/src/configuration.ts#FEATURE_NAMES]] et résolues par [[@apps/backend/src/configuration.ts#resolveFeatures]] ; [[@apps/backend/src/app/app.router.ts#appRouter]] appelle `setupRoutes` de chaque module sous condition. Une route absente répond **404**, jamais 403.

### Un drapeau n'est pas une permission

La distinction est fonctionnelle, pas stylistique : une permission répond « vous n'avez pas le droit », un drapeau répond « cela n'existe pas ».

Masquer une fonctionnalité inachevée derrière une règle CASL produirait un refus d'accès là où la vérité est « pas encore construit » — information trompeuse pour un auditeur de registre — et la fonctionnalité à moitié faite réapparaîtrait le jour où ce droit serait légitimement accordé. Le test [[@apps/backend/tests/integration/feature-flags.test.ts]] vérifie les deux codes côte à côte : 404 sur un domaine coupé, 401 sur un domaine monté et non authentifié, ce qui prouve que le 404 vient de l'absence de route.

`users` et `permissions` n'ont volontairement pas de drapeau : sans eux personne ne se connecte ni n'administre les droits.

### Activé sauf `false` explicite

`featureFlag()` défaut à `true`, et une variable absente ne retire donc rien.

L'asymétrie est voulue : l'accident de configuration doit aller vers « trop visible », jamais vers « un registre réglementaire disparu sans que personne ne l'ait décidé ». Le même raisonnement gouverne `FeaturesService.isEnabled` côté front.

### Les données ne sont jamais touchées

Seule la surface HTTP est retirée. Les entités restent enregistrées dans `database.connection.ts`, le schéma reste créé, les lignes déjà écrites restent intactes.

Réactiver un domaine ne coûte donc qu'un redémarrage — ce qui compte pour un registre append-only, où rien de ce qui a été écrit ne peut être réécrit.

### Le front ne redéclare pas la liste

`GET /api/v1/status` porte l'état de chaque domaine, et [[@libs/shared-front/src/services/features.ts#FeaturesService]] le lit au démarrage du tableau de bord.

Une seconde liste, alimentée par les variables de build du front, s'accorderait avec celle du serveur par pure discipline : un déploiement coupant un domaine côté API sans rebuild du front laisserait une entrée de menu menant à des 404. C'est le défaut que le versionnage des champs canoniques a dû corriger côté hash — voir [[hash-chain-integrity#Jeu de champs canoniques versionné]].

### Où poser les drapeaux, et où surtout pas

Les drapeaux sont de la configuration de déploiement, pas des secrets : leur place est l'environnement du processus de production, jamais `.env.enc`.

Trois raisons de ne pas les chiffrer. Une bascule imposerait un cycle déchiffrer / éditer / rechiffrer / committer ; le changement serait réservé aux porteurs de la clé age ; et — le point décisif pour un produit de conformité — le fait qu'un registre réglementaire a été coupé deviendrait **invisible en revue**, noyé dans un blob chiffré.

`@apps/backend/.env` ne convient pas non plus : `scripts/dev-setup.mjs` le régénère depuis `.env.enc` à chaque `pnpm dev`, donc toute valeur écrite à la main y disparaît au démarrage suivant. Il sert au développement local, le temps d'une session.

Configuration de production retenue au 2026-09-18 — `todos` est le domaine boilerplate des tutoriels, le registre d'incidents attend la couverture CNIL 1–10 :

```
FEATURE_TODOS=false
FEATURE_INCIDENT_REGISTRY=false
FEATURE_ACCESS_REGISTRY=true
```

Couper `FEATURE_ACCESS_REGISTRY` n'emporte plus le journal d'audit : `GET /audit-events` vit désormais dans `audit-log-backend`, module transverse jamais soumis à un drapeau, et filtre chaque événement par le domaine qu'il concerne — voir [[backend/audit-log]].

## Configuration de production

Réglages propres au déploiement conteneurisé (Docker derrière Caddy et un tunnel Cloudflare), neutres en dev, test et e2e tant qu'aucune variable dédiée n'est posée.

### Secrets livrés en fichier

Pour chaque clé `KEY` du schéma, [[@apps/backend/src/configuration.ts#applyFileEnvSecrets]] lit le fichier désigné par `KEY_FILE` et en écrit le contenu dans `process.env.KEY`, avant le parse Zod.

Docker Compose dépose les secrets sous `/run/secrets/` et n'expose que leur chemin (`DATABASE_URI_FILE=/run/secrets/database_uri`) : `docker inspect` ne montre aucune valeur. Règles :

- seules les clés du schéma sont lues — un `*_FILE` générique chargerait `SOPS_AGE_KEY_FILE` ou `SSL_CERT_FILE` depuis le shell du développeur ;
- `KEY_FILE` l'emporte sur `KEY` en clair ;
- seuls les retours à la ligne finaux sont retirés ; un fichier vide donne `""` (secret optionnel volontairement vide, comme `SMTP_PASSWORD`) ;
- fichier absent ou illisible : erreur immédiate qui nomme la variable `*_FILE` et le chemin, plutôt qu'un démarrage sur une configuration incomplète.

Sans aucune variable `*_FILE`, rien ne change. Le mécanisme s'applique au serveur comme à la CLI MikroORM, qui passent tous deux par `loadConfiguration`.

### Adresse d'écoute

`HOST` (défaut `localhost`) est passé à `fastify.listen` par [[@apps/backend/src/app/app.ts#App#start]]. Le défaut garde le proxy Vite du front (`http://localhost:8000`) ; le compose de production pose `HOST=0.0.0.0` pour que Caddy joigne le backend par le réseau Docker.

### Logger

En production ([[@apps/backend/src/app/logger.ts#logger]] avec `PRODUCTION_ENV=true`), `pino()` sans transport écrit du JSON sur stdout, lu par le driver de logs Docker ; `pino-pretty` est réservé au dev.

L'ancienne config `transport: { target: "pino" }` plantait au démarrage avec `ThreadStream: destination.write is not a function` (reproduit sur pino 10.3.1) : `pino` n'est pas une cible de transport.
