import mikroOrmConfig from "#src/mikro-orm.config.ts";
import { createUserAccount } from "#src/app/user.create.ts";
import { MikroORM } from "@mikro-orm/postgresql";
import { parseArgs } from "node:util";

// Usage : NEW_USER_PASSWORD=… vite-node src/cli/create-user.ts \
//           --email a@b.c --first-name A --last-name B --role tech_admin
//
// Le mot de passe passe par l'environnement, jamais en argument : une ligne de
// commande est lisible par tout `ps`. Pas par stdin non plus : Vite prend la fin
// de stdin pour la mort du processus parent et arrête vite-node en silence, avec
// le code 0, au milieu de la première requête.
const { values } = parseArgs({
  options: {
    email: { type: "string" },
    "first-name": { type: "string" },
    "last-name": { type: "string" },
    role: { type: "string" },
  },
});

const { email, "first-name": firstName, "last-name": lastName, role } = values;
const password = process.env.NEW_USER_PASSWORD;
if (!email || !firstName || !lastName || !role || !password) {
  console.error("✗ --email, --first-name, --last-name, --role et NEW_USER_PASSWORD sont requis");
  process.exit(1);
}

const orm = await MikroORM.init(mikroOrmConfig);

try {
  const user = await createUserAccount(orm.em.fork(), {
    email,
    firstName,
    lastName,
    roleName: role,
    password,
  });
  console.log(`✓ ${user.email} créé avec le rôle ${role}`);
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
