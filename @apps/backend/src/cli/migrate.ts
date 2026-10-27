import mikroOrmConfig from "#src/mikro-orm.config.ts";
import { migrateDatabase } from "#src/app/database.migrate.ts";
import { MikroORM } from "@mikro-orm/postgresql";

// Lancé par le service `migrate` du compose de production, avant le backend.
const orm = await MikroORM.init(mikroOrmConfig);

try {
  const applied = await migrateDatabase(orm);
  console.log(
    applied.length > 0
      ? `Migrations appliquées : ${applied.join(", ")}`
      : "Aucune migration en attente",
  );
} finally {
  await orm.close(true);
}
