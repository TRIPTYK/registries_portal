import { databaseConfig } from "#src/app/database.connection.js";
import { migrateDatabase } from "#src/app/database.migrate.js";
import { createUserAccount } from "#src/app/user.create.js";
import { withDatabaseName } from "#src/configuration.js";
import { migrationsList } from "#src/migrations/index.js";
import { verifyPassword } from "@libs/users-backend";
import { PermissionRuleEntity, RoleEntity } from "@libs/permissions-backend";
import { MikroORM } from "@mikro-orm/postgresql";
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Une base vide à part dans le testcontainer, comme la prod au premier
// déploiement : la base partagée des autres tests est créée par schema.refresh,
// pas par les migrations.
describe("Migration de la base au déploiement", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    const uri = withDatabaseName(process.env.TEST_DATABASE_URL ?? "", `migrate_${Date.now()}`);
    orm = await MikroORM.init(databaseConfig({ DATABASE_URI: uri }));
    await orm.schema.ensureDatabase({ create: true });
  });

  afterAll(async () => {
    await orm.close(true);
  });

  // @lat: [[apps/deployment#Migrations au déploiement#Une base vide arrive au niveau du code]]
  it("une base vide arrive au niveau des entités, triggers et rôles compris", async () => {
    expect(await migrateDatabase(orm)).toEqual(migrationsList.map((m) => m.name));

    // Une entité modifiée sans sa migration fait échouer ce test (= migration:check).
    expect(await orm.migrator.checkSchema()).toBe(false);

    // La base migrée est celle des entités. Seul écart : les triggers
    // append-only, inconnus des entités, que le diff de schéma de MikroORM
    // supprimerait — d'où l'interdiction de schema:update hors du dev.
    const diff = await orm.schema.getUpdateSchemaSQL({ wrap: false });
    const nonTriggerChanges = diff
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !/^drop (trigger|function) if exists "\w+_no_\w+"/.test(line));
    expect(nonTriggerChanges).toEqual([]);

    const triggers = await orm.em.execute<{ tgname: string }[]>(
      "select tgname from pg_trigger where not tgisinternal order by tgname",
    );
    expect(triggers.map((t) => t.tgname)).toEqual(
      expect.arrayContaining([
        "incident_no_mutation",
        "access_record_no_mutation",
        "audit_event_no_mutation",
      ]),
    );

    const em = orm.em.fork();
    const roles = await em.find(RoleEntity, {}, { orderBy: { name: "asc" } });
    expect(roles.map((r) => r.name)).toEqual(["auditor", "dpo", "encoder", "tech_admin"]);
  });

  // @lat: [[apps/deployment#Migrations au déploiement#Rejouable à chaque déploiement]]
  it("un second passage n'applique rien et ne duplique aucune donnée", async () => {
    const rulesBefore = await orm.em.fork().count(PermissionRuleEntity);

    expect(await migrateDatabase(orm)).toEqual([]);
    expect(await orm.em.fork().count(RoleEntity)).toBe(4);
    expect(await orm.em.fork().count(PermissionRuleEntity)).toBe(rulesBefore);
  });

  // @lat: [[apps/deployment#Migrations au déploiement#Créer un utilisateur]]
  it("crée un utilisateur connectable, et refuse doublon, rôle inconnu et mot de passe court", async () => {
    const account = {
      email: "admin@example.com",
      firstName: "Ada",
      lastName: "Admin",
      roleName: "tech_admin",
      password: "un-mot-de-passe-long",
    };

    const user = await createUserAccount(orm.em.fork(), account);
    expect(user.role.name).toBe("tech_admin");
    expect(user.passwordChangedAt).not.toBeNull();
    expect(await verifyPassword(user.password, account.password)).toBe(true);

    await expect(createUserAccount(orm.em.fork(), account)).rejects.toThrow("existe déjà");
    await expect(
      createUserAccount(orm.em.fork(), { ...account, email: "b@example.com", roleName: "root" }),
    ).rejects.toThrow("rôle inconnu");
    await expect(
      createUserAccount(orm.em.fork(), { ...account, email: "c@example.com", password: "court" }),
    ).rejects.toThrow("12 caractères");
  });
});

// @lat: [[apps/deployment#Migrations au déploiement#Liste explicite des migrations]]
describe("Liste des migrations", () => {
  it("contient chaque fichier de migration du dossier", () => {
    const files = readdirSync(new URL("../../src/migrations/", import.meta.url))
      .filter((file) => /^Migration\d+.*\.ts$/.test(file))
      .map((file) => file.replace(/\.ts$/, ""));

    expect(migrationsList.map((m) => m.name).sort()).toEqual(files.sort());
  });
});
