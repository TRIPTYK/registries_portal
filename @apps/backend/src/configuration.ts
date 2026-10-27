import { readFileSync } from "node:fs";
import { object, string } from "zod";
import type z from "zod";

/**
 * Drapeau de fonctionnalité : activé sauf `false` explicite.
 *
 * L'asymétrie est voulue. Une variable oubliée dans un environnement doit
 * laisser le produit COMPLET plutôt que d'en amputer une partie en silence :
 * l'accident doit aller vers « trop visible », jamais vers « registre
 * partiellement absent sans que personne ne l'ait décidé ».
 */
function featureFlag() {
  return string()
    .transform((v) => v !== "false")
    .default(true);
}

const schema = object({
  PORT: string().transform(Number),
  // `localhost` par défaut : le proxy Vite du front cible `http://localhost:8000`.
  // En conteneur, `0.0.0.0` pour être joignable depuis le réseau Docker.
  HOST: string().default("localhost"),
  SERVER_URL: string(),
  PRODUCTION_ENV: string().transform((v) => v === "true"),
  DEBUG: string()
    .transform((v) => v === "true")
    .default(false),
  DATABASE_URI: string(),
  SESSION_KEY: string(),
  JWT_SECRET: string(),
  JWT_REFRESH_SECRET: string(),
  SEED: string().default("42").optional(),
  APP_NAME: string().default("Registr"),
  APP_URL: string().default("http://localhost:3000"),
  APP_LOGO_URL: string().optional(),
  SMTP_HOST: string(),
  SMTP_PORT: string(),
  SMTP_USER: string(),
  SMTP_PASSWORD: string(),
  SMTP_SECURE: string().transform((v) => v === "true"),
  EMAIL_FROM_NAME: string().default("Registr Support"),
  EMAIL_FROM_ADDRESS: string().default("support@example.com"),
  EXPORT_SIGNING_KEY: string(),
  // Positionné par les scripts `start:e2e` / `e2e:setup` uniquement. Ne pas le
  // mettre dans un fichier .env : c'est le drapeau qui protège la base de dev.
  E2E: string()
    .transform((v) => v === "true")
    .default(false),

  // ─── Drapeaux de fonctionnalité ────────────────────────────────────────────
  //
  // Un domaine désactivé n'est PAS monté : ses routes n'existent pas, l'API ne
  // les expose pas, et le front masque son entrée de menu. Ce n'est donc pas un
  // contrôle d'accès — une permission répond « vous n'avez pas le droit », un
  // drapeau répond « cela n'existe pas ». Ne jamais utiliser l'un pour l'autre :
  // dans un registre de conformité, un refus d'accès est une information que
  // l'auditeur interprète.
  //
  // Les entités et le schéma de base restent enregistrés quoi qu'il arrive : on
  // masque une surface HTTP, on ne détruit jamais de données. Réactiver un
  // domaine ne coûte donc qu'un redémarrage, et les données écrites avant la
  // désactivation sont intactes.
  //
  // Par défaut TOUT est activé : une variable absente ne change rien au
  // comportement existant, seul un `false` explicite retire quelque chose.
  FEATURE_TODOS: featureFlag(),
  FEATURE_ACCESS_REGISTRY: featureFlag(),
  FEATURE_INCIDENT_REGISTRY: featureFlag(),
});

export type AppConfiguration = z.infer<typeof schema>;

// Base physique dédiée aux tests e2e, distincte de la base de développement.
// @lat: [[apps/e2e-strategy#Base e2e isolée de la base de développement]]
export const E2E_DATABASE_NAME = "database_e2e";

/**
 * Remplace le nom de base d'une URI de connexion, en conservant identifiants,
 * hôte, port et query string.
 */
export function withDatabaseName(uri: string, databaseName: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/**
 * Refuse une commande e2e dirigée vers une autre base que `database_e2e`.
 *
 * L'E2ESeeder ne s'exécute que via `schema:fresh --seed E2ESeeder`, qui détruit
 * tout le schéma AVANT de semer : un garde placé dans le seeder arriverait trop
 * tard. On vérifie donc la cible au chargement de la config MikroORM, avant
 * toute connexion. Filet de sécurité pour la troisième entrée e2e — script npm
 * ajouté, étape CI, appel CLI à la main — qui oublierait `E2E=true`.
 *
 * @lat: [[apps/e2e-strategy#Base e2e isolée de la base de développement]]
 */
export function assertE2ECommandTargetsE2EDatabase(uri: string, argv: readonly string[]) {
  if (!argv.some((argument) => argument.includes("E2ESeeder"))) {
    return;
  }

  const databaseName = new URL(uri).pathname.replace(/^\//, "");
  if (databaseName === E2E_DATABASE_NAME) {
    return;
  }

  throw new Error(
    `Commande e2e (E2ESeeder) dirigée vers la base « ${databaseName} » au lieu de ` +
      `« ${E2E_DATABASE_NAME} ». schema:fresh détruit tout le schéma : passe par ` +
      `\`pnpm e2e:setup\` (qui pose E2E=true), jamais par la CLI MikroORM directement.`,
  );
}

/**
 * Charge dans `process.env.KEY` le contenu du fichier désigné par `KEY_FILE`,
 * pour chaque clé du schéma (secrets Docker sous `/run/secrets/`).
 *
 * Limité aux clés du schéma : un `*_FILE` générique chargerait aussi
 * `SOPS_AGE_KEY_FILE` (clé privée age) depuis le shell du développeur.
 *
 * @lat: [[apps/backend-bootstrap#Configuration de production#Secrets livrés en fichier]]
 */
export function applyFileEnvSecrets() {
  for (const key of Object.keys(schema.shape)) {
    const fileVariable = `${key}_FILE`;
    const path = process.env[fileVariable];
    if (path === undefined) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`${fileVariable} : impossible de lire le fichier « ${path} »`, {
        cause: error,
      });
    }

    process.env[key] = content.replace(/[\r\n]+$/, "");
  }
}

export function loadConfiguration() {
  applyFileEnvSecrets();
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const name = issue.path.join(".");
        const reason = process.env[name] === undefined ? "manquante" : issue.message;
        return `  - ${name}: ${reason}`;
      })
      .join("\n");

    throw new Error(
      `Configuration d'environnement invalide. Vérifie ton fichier @apps/backend/.env ` +
        `(source de vérité : .env.enc déchiffré via SOPS, voir scripts/dev-setup.mjs) :\n${details}`,
    );
  }

  // Les tests e2e effacent le schéma (`schema:fresh --seed E2ESeeder`). Ils
  // tournent donc sur leur propre base, quelle que soit la DATABASE_URI héritée
  // du secret déchiffré, pour ne jamais détruire les données de développement.
  if (result.data.E2E) {
    return {
      ...result.data,
      DATABASE_URI: withDatabaseName(result.data.DATABASE_URI, E2E_DATABASE_NAME),
    };
  }

  return result.data;
}

/**
 * Les domaines pilotables par drapeau, et leur état effectif.
 *
 * SOURCE UNIQUE. Le front ne redéclare pas cette liste : il la lit sur
 * `GET /api/v1/status`. Deux listes qui ne s'accordent que par discipline
 * finissent toujours par diverger — c'est le défaut que le versionnage des
 * champs canoniques a dû corriger côté hash.
 *
 * @lat: [[apps/backend-bootstrap#Drapeaux de fonctionnalité par domaine]]
 */
export const FEATURE_NAMES = ["todos", "accessRegistry", "incidentRegistry"] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export function resolveFeatures(configuration: AppConfiguration): Record<FeatureName, boolean> {
  return {
    todos: configuration.FEATURE_TODOS,
    accessRegistry: configuration.FEATURE_ACCESS_REGISTRY,
    incidentRegistry: configuration.FEATURE_INCIDENT_REGISTRY,
  };
}
