# Images de déploiement

Deux images construites depuis la racine du monorepo : le backend (`@apps/backend/Dockerfile`) et le front servi par Caddy (`@apps/front/Dockerfile`). Le compose de production les lance, piloté par `deploy.sh`.

```bash
docker build -f @apps/backend/Dockerfile .
docker build -f @apps/front/Dockerfile --build-arg APP_VERSION=v1.2.3 .
```

Les deux suivent les mêmes étapes : `turbo prune <app> --docker`, installation complète, `turbo build`, puis une étape finale qui ne garde que le nécessaire. La configuration et les secrets du backend arrivent à l'exécution : voir [[backend-bootstrap#Configuration de production]].

## Bases épinglées par digest

Chaque `FROM` porte une version exacte et le digest de l'index multi-architecture, pour qu'un rebuild ou un rollback reprenne la même base sur Mac comme sur la VM amd64.

Les digests viennent de `docker buildx imagetools inspect <image:tag>`. Monter de version, c'est changer le tag et le digest ensemble, dans les deux Dockerfiles. pnpm est fixé sur `packageManager` du `package.json` racine, turbo sur la version résolue dans le lockfile.

Le node est en Debian (`bookworm-slim`), jamais en Alpine : `sodium-native`, tiré par `@fastify/secure-session`, ne livre de binaires précompilés que pour glibc. Sur Alpine, le backend ne démarre pas.

## Image backend

L'app tourne en TypeScript via vite-node, avec les `@libs` résolues depuis leur `dist/`, d'où le `turbo build --filter=@apps/backend^...` au build.

Les libs sont construites avec l'installation complète, puis `node_modules` est supprimé et réinstallé en `--prod`, hors ligne depuis le store de l'étape. L'image passe ainsi de 1,32 Go à 682 Mo. Un simple `pnpm install --prod` ne suffit pas : il retire les liens mais laisse les paquets dans `node_modules/.pnpm`.

`git` (dépendances git du lockfile) reste dans l'étape d'installation, et l'étape runtime repart de l'image node nue. Aucun compilateur n'est installé : `argon2` et `sodium-native` livrent des binaires précompilés glibc, et seuls `cpu-features` et le binding optionnel de `ssh2` (dépendances facultatives de testcontainers, pour les tests) échouent sans conséquence. Aucun navigateur Playwright n'est installé : le backend n'utilise pas `playwright`.

### Dépendances de production du backend

Tout ce que le conteneur exécute doit être en `dependencies`, sinon l'installation `--prod` le retire et l'image ne démarre plus.

Côté `@apps/backend`, cela comprend ce que `vite.config.mts` importe (`vite`, `vite-plugin-node`, `vite-tsconfig-paths`), le moteur `vite-node`, la CLI et le driver MikroORM, `@fastify/secure-session` et `@fastify/static`, et `@ngneat/falso`, importé par `mikro-orm.config.ts` et les seeders. À l'inverse, `vitest` et `playwright` sont en `devDependencies` partout : déclarés en `dependencies`, ils tiraient `msw` et `playwright-core` dans l'image. La CLI MikroORM charge sa configuration TypeScript via jiti, sans `ts-node`.

### Utilisateur node et pas de pnpm

Le conteneur tourne en `node`, et le `CMD` appelle `./node_modules/.bin/vite-node` directement : en non-root, pnpm et corepack veulent écrire dans des dossiers appartenant à root.

Toute commande lancée dans le conteneur (migrations, CLI MikroORM) doit donc passer par `./node_modules/.bin/…`. Le seul dossier inscriptible est `@apps/backend/node_modules/.vite-temp`, où vite-node transpile `vite.config.mts` à chaque démarrage.

L'image pose `HOST=0.0.0.0` et `PORT=8000` par défaut. L'image crée aussi `dist/uploads`, vide et à root : c'est la racine du `@fastify/static` monté sur `/public/`, qui sinon émet un avertissement au démarrage, mais rien n'y écrit.

## Image front

Le build Ember est servi par Caddy (Alpine), qui proxifie aussi `/api/*` vers `backend:8000`, le nom du service dans le compose. Caddy tourne en `1000:1000` sur le port 80.

Le binaire `caddy` de l'image amont porte déjà `cap_net_bind_service`, d'où le port 80 sans root. `admin off` et `auto_https off` : le TLS se termine chez Cloudflare.

### Jamais de mocks MSW en production

Le front démarre MSW sauf si `VITE_MOCK_API` vaut `false`. L'image pose cette variable, puis refuse un bundle qui démarre encore MSW.

Un front de production qui répondrait avec des données fictives serait le pire incident possible pour un registre de conformité. Le contrôle cherche `mockServiceWorker.js` dans le JS de `dist/`, hors du fichier `public/mockServiceWorker.js` lui-même.

Ce marqueur a été retenu en comparant deux builds : avec le mock actif, le bundle principal contient l'URL d'enregistrement du worker, une chaîne que la minification ne peut pas renommer ; avec `VITE_MOCK_API=false`, la branche de [[@apps/front/app/routes/application.ts#ApplicationRoute]] est éliminée et la chaîne disparaît. `setupWorker` et `serviceWorker.register` disparaissent aussi, mais un nom de fonction peut être minifié et un service worker légitime pourrait un jour s'enregistrer.

### Variables déclarées à turbo

turbo 2 filtre les variables d'environnement non déclarées. `VITE_MOCK_API` et `APP_VERSION` sont donc listées dans `tasks.build.env` de `turbo.json`, sinon elles n'atteignent jamais `vite build`.

Le contrôle MSW couvre l'oubli pour `VITE_MOCK_API`. Pour `APP_VERSION`, l'oubli se verrait au filigrane, qui disparaîtrait.

### Filigrane de version

Le front affiche en bas à droite la version du build, pour voir d'un coup d'œil quel tag tourne. Elle vient de `APP_VERSION` au build, `dev` si absente.

`vite.config.mts` l'injecte par un `define` (`__APP_VERSION__`), [[@apps/front/app/config/environment.ts#environmentConfig]] la range dans `APP.version` sauf en mode test, et le template `application` l'affiche. La valeur `dev` est masquée : le filigrane n'apparaît que dans une image.

### Cache et en-têtes

Seuls les fichiers dont le nom porte un hash sont `immutable` ; `index.html`, le repli SPA et les fichiers copiés tels quels depuis `public/` sont `no-cache`.

Vite émet les fichiers hashés à plat dans `dist/assets/`, sous la forme `<nom>-<hash de 8 caractères>.<ext>`. Le Caddyfile les reconnaît par expression régulière, sans sous-dossier, et seulement s'ils existent : un hash disparu après un déploiement retombe sur le repli SPA plutôt que d'être servi en `immutable`. `public/` produit `assets/img/*`, `mockServiceWorker.js` et `robots.txt`, tous sans hash. Un fichier de `public/assets/` nommé comme un fichier hashé serait mal classé.

Toutes les réponses portent `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` et `Referrer-Policy: strict-origin-when-cross-origin`, compressées en `gzip` ou `zstd`.

## Contexte de build

Le `.dockerignore` exclut `**/.env` et `**/.env.*` à tous les niveaux : le `@apps/backend/.env` déchiffré en dev n'entre jamais dans le contexte, donc dans aucune couche.

Il exclut aussi ce qu'aucune image n'utilise ou qu'elle reconstruit : `node_modules`, `dist`, `.turbo` à tous les niveaux, `.git`, `lat.md`, `specs`, `tuto`, `.claude`, `.agentsroom`. `turbo prune` ne copie ni `.npmrc` ni `patches/`, que le lockfile exige : les Dockerfiles les copient à part.

## Compose de production

`deploy/docker-compose.prod.yaml` (projet `registries`) lance `postgres`, `migrate`, `backend`, `caddy` et `cloudflared`. Aucun port n'est publié : le tunnel Cloudflare est la seule entrée.

```
Internet → Access → tunnel → cloudflared → caddy:80
                                             ├── /api/*  → backend:8000 → postgres:5432
                                             └── le reste → le front dans /srv
```

Les images de l'app sont `${REGISTRY}/backend` et `${REGISTRY}/front` au tag `${IMAGE_TAG}`, en `:?` : sans ces variables (ni `TUNNEL_TOKEN`), `docker compose config` échoue en nommant `deploy.sh` plutôt que de tirer une image par défaut. Aucun secret dans ce fichier : ils arrivent par [[deployment#Déployer avec deploy.sh]]. Le schéma de la base est l'affaire du service `migrate` ([[deployment#Migrations au déploiement]]).

Pour tous les services : `restart: unless-stopped` et logs `json-file` tournants (`10m` × 3, ancre `x-logging`), sinon les logs remplissent le disque de la VM. `postgres` et `cloudflared` sont épinglés par version exacte et digest d'index, comme les `FROM` : voir [[deployment#Bases épinglées par digest]].

### Services

Postgres 18 sans port, `migrate` derrière lui en `service_healthy`, le backend derrière `migrate` en `service_completed_successfully`, Caddy et cloudflared en `service_started`.

- `postgres` : même majeure que le compose de dev. L'image 18 pose `PGDATA=/var/lib/postgresql/18/docker` et déclare le volume sur `/var/lib/postgresql` : le volume `postgres-data` y est monté, pas sur `.../data`, qui laisserait les données hors du volume. `POSTGRES_USER` et `POSTGRES_DB` valent `registries` en clair, le mot de passe arrive par `POSTGRES_PASSWORD_FILE`. Healthcheck `pg_isready`.
- `migrate` : l'image backend avec la commande `src/cli/migrate.ts`, `restart: "no"`. Il reprend l'environnement et les secrets du backend par ancres YAML (`&backend-environment`, `&backend-secrets`), car `mikro-orm.config.ts` valide toute la configuration.
- `backend` : configuration non secrète en clair (`HOST=0.0.0.0`, URLs `https://registries.triptyk.be`, drapeaux de [[backend-bootstrap#Drapeaux de fonctionnalité par domaine]], SMTP Mailgun EU en STARTTLS sur 587). Aucun code n'envoie encore de mail : le SMTP ne sert qu'à passer la validation, région et adresse d'envoi sont à confirmer. Healthcheck `fetch` sur `http://127.0.0.1:8000/api/v1/status` — pas `localhost`, qui peut se résoudre en `::1` alors que le backend n'écoute qu'en IPv4 — avec `start_period: 60s` pour vite-node, et `init: true`.
- `caddy` : attend seulement que le backend soit démarré. Il sert le front pendant que l'API démarre, et un backend malade ne fait pas tomber tout le hostname.
- `cloudflared` : `tunnel --no-autoupdate run`, jeton en variable d'environnement.

### Secrets du compose

Huit secrets Compose de source `environment:`, chacune au nom de la clé qu'elle alimente : `DATABASE_URI`, `SESSION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `EXPORT_SIGNING_KEY`, `SMTP_USER`, `SMTP_PASSWORD`, `POSTGRES_PASSWORD`.

Ils sont montés en `/run/secrets/<clé en minuscules>` et relus via `*_FILE` ([[backend-bootstrap#Configuration de production#Secrets livrés en fichier]]) : `docker inspect` du backend ne montre que les chemins. Seule exception, `TUNNEL_TOKEN` : `cloudflared tunnel run` ne lit que la variable, sans `*_FILE`, et sa valeur est visible dans `docker inspect` de `cloudflared`.

Formats attendus, pour que l'étape SOPS les construise justes :

- `POSTGRES_PASSWORD` : généré en hexadécimal (`openssl rand -hex 32`), donc sans `@`, `:` ni `/`, car il est recopié tel quel dans l'URI ;
- `DATABASE_URI` : `postgresql://registries:<POSTGRES_PASSWORD>@postgres:5432/registries`, avec le même mot de passe que le secret `POSTGRES_PASSWORD` ;
- `SESSION_KEY` : 64 caractères hexadécimaux (`openssl rand -hex 32`). Le backend la décode en hex et exige 32 octets ; toute autre valeur l'empêche de démarrer (`key must be 32 bytes`).

### Secrets vides et deploy.sh

Compose ne crée aucun fichier pour un secret dont la valeur est vide, et le backend refuse un `*_FILE` absent : `deploy.sh` matérialise donc un secret vide par un simple retour à la ligne.

Vérifié : avec `SMTP_PASSWORD=` dans le shell, `/run/secrets/smtp_password` n'existe pas et le backend redémarre en boucle sur `SMTP_PASSWORD_FILE : impossible de lire le fichier`.

Le backend relit ce fichier d'un octet comme `""`. Vérifié au déploiement local : `/run/secrets/smtp_password` existe, et `deploy.sh` liste les secrets vides à chaque lancement.

### Côté Cloudflare

La configuration Cloudflare est hors du repo, faite dans le tableau de bord Zero Trust.

- un tunnel géré à distance, dont le jeton devient `TUNNEL_TOKEN` ;
- un hostname public `registries.triptyk.be` routé vers le service `http://caddy:80` — cloudflared résout `caddy` sur le réseau du projet ;
- une application Access sur ce hostname, avec la politique qui fixe qui peut l'atteindre. Le TLS se termine chez Cloudflare, d'où `auto_https off` dans Caddy.

### Valider le compose en local

Sans tunnel : construire les images en `registries/*:local`, puis un override jetable hors du repo publie Caddy sur un port local et met `cloudflared` dans un profil jamais activé.

`/api/v1/status` répond sans schéma en base : aucune migration n'est nécessaire pour cette validation.


## Migrations au déploiement

Le service `migrate` met la base au niveau de l'image avant chaque démarrage du backend. S'il échoue, le backend ne démarre pas et `compose up` s'arrête en erreur.

[[@apps/backend/src/app/database.migrate.ts#migrateDatabase]] enchaîne trois étapes, dans l'ordre :

- les migrations MikroORM en attente (`src/migrations`) ;
- `APPEND_ONLY_DDL`, les triggers d'immuabilité des registres ([[hash-chain-integrity]]). Ils sont réappliqués à chaque passage plutôt que figés dans une migration, pour rester une seule définition, partagée avec `schema:fresh` ;
- les données de référence : les 4 rôles et leurs règles ([[@apps/backend/src/seeders/seed-data/roles.ts#seedRolesAndPermissions]], partagé avec le seeder de dev) et les référentiels du registre d'accès.

Aucun utilisateur, aucune donnée de démonstration : en prod, le seeder de dev n'est jamais lancé.

### Une base vide arrive au niveau du code

Sur une base vide, `migrateDatabase` applique toutes les migrations, pose les triggers et crée les 4 rôles. La base obtenue correspond aux entités.

Le test vérifie aussi `migrator.checkSchema()` : une entité modifiée sans sa migration le fait échouer. Il tient lieu de `migration:check` en CI, sans étape à part, puisque `tests.yaml` lance déjà les tests backend sur testcontainer.

### Rejouable à chaque déploiement

Un second passage n'applique aucune migration et ne duplique ni rôle ni règle. C'est ce qui permet de lancer `migrate` à chaque `deploy.sh`, sans état à suivre.

Un rôle qui porte déjà des règles n'en reçoit pas d'autres : les permissions modifiées depuis l'interface sont conservées. Changer les règles d'un rôle existant en prod demande donc une migration.

### Liste explicite des migrations

La découverte des migrations par glob échoue sous vite-node (`MigrationClass is not a constructor`), comme celle des seeders. `src/migrations/index.ts` les liste donc une à une, dans `migrationsList`.

Un test compare cette liste aux fichiers `Migration*.ts` du dossier : une migration créée mais non listée le fait échouer.

### Ajouter une migration

Après un changement d'entité : `pnpm mikro-orm migration:create`, puis ajouter la classe générée à `migrationsList`.

Le diff se fait contre `src/migrations/.snapshot.json`, versionné avec les migrations. Son nom est fixé (`snapshotName`) : par défaut il porte le nom de la base, qui n'est pas le même en dev et en prod.

Sans snapshot, MikroORM compare les entités à la base locale. En v7, ce diff connaît les triggers append-only, absents des entités, et générerait leur suppression. Pour la même raison, `schema:update` ne doit jamais toucher une base qui porte des registres.

Les migrations générées dépassent `max-lines-per-function` : `.oxlintrc.json` du backend lève cette règle pour `src/migrations/*.ts`.

### Créer un utilisateur

Une base neuve n'a aucun compte, et seul un `tech_admin` peut en créer depuis l'interface. [[@apps/backend/src/app/user.create.ts#createUserAccount]] crée le premier, en ligne de commande.

Elle applique le même seuil de 12 caractères que l'API, et refuse un rôle inconnu ou une adresse déjà prise. Depuis le poste de l'opérateur :

```bash
read -rs NEW_USER_PASSWORD && export NEW_USER_PASSWORD
docker --context registries-prod exec -e NEW_USER_PASSWORD registries-backend-1 \
  ./node_modules/.bin/vite-node src/cli/create-user.ts \
  --email prenom.nom@triptyk.eu --first-name Prénom --last-name Nom --role tech_admin
unset NEW_USER_PASSWORD
```

`-e NEW_USER_PASSWORD`, sans valeur, reprend la variable du shell local : le mot de passe n'apparaît sur aucune ligne de commande.

Il ne passe pas non plus par stdin. Vite prend la fin de stdin pour la mort du processus parent, sauf si `CI=true` : vite-node s'arrête alors en silence avec le code 0, au milieu de la première requête, sans rien créer.

## Secrets de production (SOPS)

Les secrets de production sont chiffrés par SOPS + age dans `deploy/envs/prod.secrets.env.enc`, versionné. Aucune copie en clair n'existe, ni sur le poste ni sur la VM.

### Règle de production

Dans `.sops.yaml`, la règle de `deploy/envs/prod.secrets.env.enc` précède celle de dev : SOPS prend la première qui correspond, et `\.env(\.\w+)?\.enc$` attraperait aussi ce fichier.

Elle ne chiffre que pour la clé de l'opérateur. Les clés de dev, dont celle de la CI (secret `SOPS_AGE_KEY` de `playwright.yml`), n'y figurent pas : la CI ne doit jamais pouvoir déchiffrer la production.

Ajouter ou retirer un opérateur : éditer la liste `age:` de la règle, puis, avec une clé déjà autorisée, rechiffrer la clé de données et commiter le fichier (voir `tuto/2_sops.md`) :

```bash
sops updatekeys --input-type dotenv deploy/envs/prod.secrets.env.enc
```

### Générer les secrets

`deploy/new-prod-secrets.sh` produit le fichier chiffré en une fois, sans fichier en clair ni valeur affichée : le clair ne passe que par un pipe vers `sops encrypt`.

Il respecte les formats de [[deployment#Compose de production#Secrets du compose]] : `POSTGRES_PASSWORD`, `SESSION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET` et `EXPORT_SIGNING_KEY` en `openssl rand -hex 32`, `DATABASE_URI` construite avec le même mot de passe. `SMTP_USER`, `SMTP_PASSWORD` et `TUNNEL_TOKEN` sortent vides.

Il refuse d'écraser un fichier existant : le volume Postgres garde le premier mot de passe qu'il a vu, et `EXPORT_SIGNING_KEY` signe les exports du registre. Régénérer l'un ou l'autre casserait la production.

La règle se choisit d'après `--filename-override deploy/envs/prod.secrets.env.enc`, quel que soit le chemin de sortie. Un `SOPS_AGE_RECIPIENTS` hérité du shell est ignoré : il remplacerait la règle en silence. Pour les essais, `--out` et `--age` chiffrent un autre fichier pour une clé jetable, avec `sops --config /dev/null` pour ne pas exiger de règle.

### Éditer un secret

Les valeurs vides se remplissent plus tard, sans jamais écrire le clair sur disque hors de l'éditeur de `sops` :

```bash
sops edit --input-type dotenv --output-type dotenv deploy/envs/prod.secrets.env.enc
```

`TUNNEL_TOKEN` est requis avant le premier déploiement (voir [[deployment#Compose de production#Côté Cloudflare]]). `SMTP_USER` et `SMTP_PASSWORD` peuvent rester vides tant qu'aucun mail n'est envoyé.

## Poste opérateur

Tout part du poste de l'opérateur : la VM n'a que le moteur Docker, sans plugin compose, sans `docker login` et sans secret.

Une fois par poste :

```bash
docker context create registries-prod --docker "host=ssh://<alias>"   # alias SSH de la VM
docker --context registries-prod info                                 # doit répondre
docker login 17p4mt20.gra7.container-registry.ovh.net                 # Harbor
```

La clé age privée de l'opérateur est dans `~/Library/Application Support/sops/age/keys.txt` (macOS), `~/.config/sops/age/keys.txt` (Linux), ou désignée par `SOPS_AGE_KEY_FILE`. Sa clé publique doit figurer dans [[deployment#Secrets de production (SOPS)#Règle de production]].

Le client Docker transmet les identifiants Harbor de l'opérateur au démon distant à chaque pull. Détenir le contexte, c'est avoir l'équivalent de root sur la VM.

## Déployer avec deploy.sh

`deploy/deploy.sh` déchiffre les secrets en mémoire sur le poste, les injecte dans le compose et pilote le démon de la VM par le contexte Docker distant.

```bash
./deploy/deploy.sh [--context NAME] [--ps] [IMAGE_TAG] [service ...]
./deploy/deploy.sh                       # dernier tag git v*, toute la stack
./deploy/deploy.sh v1.2.0 backend caddy  # deux services seulement
./deploy/deploy.sh --ps                  # état de la stack
```

Défauts : contexte `registries-prod`, `IMAGE_TAG` égal au dernier tag `v*` (`git describe`), `REGISTRY=17p4mt20.gra7.container-registry.ovh.net/registries` surchargeable par l'environnement, fichier de secrets surchargeable par `DEPLOY_SECRETS_FILE`.

### Contrôles avant la VM

Dans l'ordre : le contexte existe (sinon la commande pour le créer), la clé age est trouvée, puis les deux images existent au tag demandé.

Les images sont vérifiées par `docker manifest inspect` depuis le poste, sans `--context` : ce sont les identifiants de l'opérateur qui comptent. Comme `manifest inspect` répond `no such manifest` aussi bien sans identifiants que pour un tag absent, le script distingue les deux par la présence de l'hôte du registre dans la config Docker locale, où `docker login` l'inscrit.

`DEPLOY_TEST_INSECURE_REGISTRY=1` ajoute `--insecure`, pour un registre local en HTTP : réservé aux essais, jamais par défaut.

### Secrets en mémoire

`sops decrypt` alimente une boucle `read` qui `export` chaque clé dans l'environnement du script : ni fichier temporaire, ni `eval`, ni `env VAR=…` qu'un `ps` afficherait.

Un secret vide devient un retour à la ligne (voir [[deployment#Compose de production#Secrets vides et deploy.sh]]) et le script en affiche la liste. Exception : un `TUNNEL_TOKEN` vide arrête le script avant tout `up`, avec la commande `sops edit` pour le renseigner une fois le tunnel créé.

Ensuite : `docker --context … compose -f deploy/docker-compose.prod.yaml up -d --pull always [services]`, puis `compose ps`. `--ps` déchiffre aussi les secrets, car le compose les exige pour s'interpréter, mais saute le contrôle des images et le jeton.

### Validation locale de deploy.sh

Le script a été validé contre le démon local (`--context default`), avec un registre `registry:2` jetable, une clé age jetable et un jeton factice.

Résultat : `postgres` et `backend` `healthy`, `/api/v1/status` répond à travers Caddy, `/run/secrets/smtp_password` existe (1 octet), et aucune valeur secrète n'apparaît dans `docker inspect` du backend. Un tag absent, un contexte inexistant, une clé absente ou un `TUNNEL_TOKEN` vide arrêtent le script avant `up`. `cloudflared` redémarre en boucle avec le jeton factice, comme attendu.

Sur macOS, AirPlay (ControlCenter) écoute aussi le port 5000 en IPv6 : côté client, `localhost:5000` y aboutit. Le registre de test s'adresse donc en `127.0.0.1:5000`.

## Release par la CI

`.github/workflows/release.yaml` construit et pousse les deux images sur un tag `v*`, vers `<HARBOR_REGISTRY>/registries/{backend,front}`, que `deploy.sh` tire ensuite.

Trois étapes, dans l'ordre :

- **garde** : le commit taggé doit être sur `develop` ou `main`. Un tag n'appartient à aucune branche ; sans ce contrôle, un tag posé sur une branche de feature livrerait du code non mergé ;
- **tests** : `tests.yaml` (lint, tests front et backend) et `playwright.yml` (e2e), appelés en `workflow_call` sur le commit taggé. Aucune image n'est construite si l'un échoue. `tests.yaml` ne se déclenche plus sur un push de tag, pour ne pas tourner deux fois ;
- **images** : build `linux/amd64` natif, sans QEMU, un cache GitHub par image. Le front reçoit `APP_VERSION` égal au nom du tag, affiché par le filigrane ([[deployment#Image front#Filigrane de version]]).

Chaque image est publiée sous `1.2.0` et `v1.2.0` ; `deploy.sh` prend par défaut le tag git, donc `v1.2.0`. `latest` ne bouge que pour une version finale : une `rc` ne le déplace pas.

### Prérequis de la release

À faire une fois, avant le premier tag, hors du repo.

- Harbor : un projet `registries` et un compte robot avec le droit push sur ce seul projet ;
- GitHub, dans les secrets du dépôt : `HARBOR_REGISTRY` (l'hôte, `17p4mt20.gra7.container-registry.ovh.net`), `HARBOR_USERNAME` (le robot) et `HARBOR_PASSWORD`. `SOPS_AGE_KEY`, déjà présent pour les e2e, est transmis à `playwright.yml` par `secrets: inherit` ;
- les runners GitHub doivent joindre Harbor.

Aucun secret applicatif n'entre dans la CI : les images ne dépendent pas de l'environnement, et la clé CI ne figure pas parmi les destinataires de la règle SOPS de production ([[deployment#Secrets de production (SOPS)#Règle de production]]).

### Tester la release

Un workflow GitHub ne se teste pas en local : on le valide par un premier tag de pré-release, posé sur un commit de `develop`.

```bash
git tag v0.1.0-rc.1 && git push origin v0.1.0-rc.1
```

Le tag doit être sur `develop` ou `main` : la garde refuse un tag posé sur `ops/backend-prod-config` tant que la branche n'est pas mergée. Vérifier ensuite que les quatre jobs passent, que les deux images apparaissent dans Harbor aux tags `0.1.0-rc.1` et `v0.1.0-rc.1`, puis `./deploy/deploy.sh v0.1.0-rc.1`.
