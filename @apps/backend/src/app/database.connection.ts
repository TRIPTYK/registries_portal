import { defineConfig, MikroORM } from "@mikro-orm/postgresql";
import type { AppConfiguration } from "../configuration.js";
import { RefreshTokenEntity, UserEntity } from "@libs/users-backend";
import { TodoEntity } from "@libs/todos-backend";
import { entities as accessRegistryEntities } from "@libs/access-registry-backend";
import { entities as auditLogEntities } from "@libs/audit-log-backend";
import { entities as incidentRegistryEntities } from "@libs/incident-registry-backend";
import { entities as permissionsEntities } from "@libs/permissions-backend";
import { DatabaseSeeder } from "../seeders/development.seeder.js";
import { E2ESeeder } from "../seeders/e2e.seeder.js";
import { migrationsList } from "../migrations/index.js";

export function databaseConfig(config: Pick<AppConfiguration, "DATABASE_URI">) {
  return defineConfig({
    seeder: {
      pathTs: "./src/seeders",
      // @lat: [[apps/backend-bootstrap#Secrets et seeding déterministe]]
      // Enregistrement explicite : la découverte par glob + import dynamique
      // de MikroORM échoue sous vite-node (`--seed <Class>` ne trouve pas la
      // classe). seedersList résout les noms sans scanner le disque.
      seedersList: [DatabaseSeeder, E2ESeeder],
    },
    migrations: {
      path: "./src/migrations",
      pathTs: "./src/migrations",
      // Sans nom fixe, le snapshot porte le nom de la base : celui de la base de
      // dev ne serait pas celui de la prod, et migration:create comparerait alors
      // les entités à la base locale au lieu du snapshot versionné.
      snapshotName: ".snapshot",
      migrationsList,
    },
    clientUrl: config.DATABASE_URI,
    entities: [
      UserEntity,
      RefreshTokenEntity,
      TodoEntity,
      ...accessRegistryEntities,
      ...auditLogEntities,
      ...incidentRegistryEntities,
      ...permissionsEntities,
    ],
  });
}

export async function createDatabaseConnection(config: Pick<AppConfiguration, "DATABASE_URI">) {
  const orm = await MikroORM.init(databaseConfig(config));
  return orm;
}
