import type { MikroORM } from "@mikro-orm/postgresql";
import { APPEND_ONLY_DDL } from "../cli/append-only.sql.js";
import { seedReferentials } from "../seeders/seed-data/referentials.js";
import { seedRolesAndPermissions } from "../seeders/seed-data/roles.js";

/**
 * Met la base au niveau du code sans rien détruire, et peut être rejouée à
 * chaque déploiement : migrations en attente, triggers append-only, puis
 * données de référence (rôles, permissions, référentiels).
 *
 * Les triggers sont réappliqués à chaque passage plutôt que figés dans une
 * migration : une base sans eux accepte en silence la falsification des
 * registres, et APPEND_ONLY_DDL reste la seule définition, partagée avec
 * schema:fresh.
 *
 * @lat: [[apps/deployment#Migrations au déploiement]]
 */
export async function migrateDatabase(orm: MikroORM): Promise<string[]> {
  const applied = await orm.migrator.up();
  await orm.em.execute(APPEND_ONLY_DDL);

  const em = orm.em.fork();
  await seedRolesAndPermissions(em);
  await seedReferentials(em);
  await em.flush();

  return applied.map((migration) => migration.name);
}
