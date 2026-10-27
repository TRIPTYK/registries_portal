import { hashPassword, UserEntity } from "@libs/users-backend";
import { PermissionRuleEntity, RoleEntity, type RoleEntityType } from "@libs/permissions-backend";
import { DataCategoryEntity, LegalBasisEntity, PurposeEntity } from "@libs/access-registry-backend";
import type { EntityManager } from "@mikro-orm/core";
import { Seeder } from "@mikro-orm/seeder";
import { randomUUID } from "crypto";
import { DATA_CATEGORY_SEEDS, LEGAL_BASIS_SEEDS, PURPOSE_SEEDS } from "./seed-data/referentials.js";

interface RuleSeed {
  action: string;
  subject: string;
  conditions?: Record<string, unknown> | null;
  inverted?: boolean;
  order?: number;
}

/**
 * E2E test seeder - creates users needed for Playwright e2e tests
 *
 * Miroir intentionnel de seed-data/roles.ts#seedRolesAndPermissions pour
 * les règles CASL des rôles dpo/auditor/tech_admin : garde les tests e2e
 * fidèles au comportement de permissions réellement seedé en prod, sans
 * risquer de régression sur le seeder dev en le mutualisant.
 */
export class E2ESeeder extends Seeder {
  // oxlint-disable-next-line max-lines-per-function
  async run(em: EntityManager) {
    const hashedPassword = await hashPassword("123456789");
    const roles = await this.seedRolesAndPermissions(em);
    this.seedReferentials(em);

    // Login user for e2e tests
    em.create(UserEntity, {
      id: "e2e-login-user",
      email: "deflorenne.amaury@triptyk.eu",
      firstName: "Amaury",
      lastName: "Deflorenne",
      password: hashedPassword,
      role: roles.encoder,
    });

    // Mock users that match the MSW mock data
    em.create(UserEntity, {
      id: "1",
      email: "john.doe@example.com",
      firstName: "John",
      lastName: "Doe",
      password: hashedPassword,
      role: roles.encoder,
    });

    em.create(UserEntity, {
      id: "2",
      email: "jane.smith@example.com",
      firstName: "Jane",
      lastName: "Smith",
      password: hashedPassword,
      role: roles.encoder,
    });

    em.create(UserEntity, {
      id: "3",
      email: "bob.johnson@example.com",
      firstName: "Bob Johnson",
      lastName: "Johnson",
      password: hashedPassword,
      role: roles.encoder,
    });

    // Role-specific e2e users (one per role, dedicated to permission specs)
    em.create(UserEntity, {
      id: "e2e-dpo-user",
      email: "dpo-e2e@triptyk.eu",
      firstName: "Dana",
      lastName: "Dpo",
      password: hashedPassword,
      role: roles.dpo,
    });

    em.create(UserEntity, {
      id: "e2e-auditor-user",
      email: "auditor-e2e@triptyk.eu",
      firstName: "Alex",
      lastName: "Auditor",
      password: hashedPassword,
      role: roles.auditor,
    });

    em.create(UserEntity, {
      id: "e2e-tech-admin-user",
      email: "tech-admin-e2e@triptyk.eu",
      firstName: "Tania",
      lastName: "TechAdmin",
      password: hashedPassword,
      role: roles.tech_admin,
    });
  }

  private async seedRolesAndPermissions(em: EntityManager) {
    const roles = {
      encoder: await this.ensureRole(em, "encoder"),
      dpo: await this.ensureRole(em, "dpo"),
      auditor: await this.ensureRole(em, "auditor"),
      tech_admin: await this.ensureRole(em, "tech_admin"),
    };

    await this.ensureRules(em, roles.encoder, [
      { action: "create", subject: "AccessRecord" },
      { action: "read", subject: "AccessRecord", conditions: { encodedBy: "$user.id" } },
      { action: "create", subject: "Incident" },
      { action: "read", subject: "Incident" },
      { action: "update", subject: "Incident", conditions: { encodedBy: "$user.id" } },
      { action: "delete", subject: "Incident", conditions: { encodedBy: "$user.id" } },
    ]);
    await this.ensureRules(em, roles.dpo, [
      { action: "read", subject: "AccessRecord" },
      { action: "manage", subject: "AccessRecordRetention" },
      { action: "read", subject: "AccessRecordIntegrity" },
      { action: "read", subject: "IncidentIntegrity" },
      { action: "read", subject: "AuditEvent" },
      { action: "read", subject: "Incident" },
      { action: "update", subject: "Incident" },
      { action: "delete", subject: "Incident" },
      { action: "restore", subject: "Incident" },
    ]);
    await this.ensureRules(em, roles.auditor, [
      { action: "read", subject: "AccessRecord" },
      { action: "read", subject: "AccessRecordIntegrity" },
      { action: "read", subject: "IncidentIntegrity" },
      { action: "read", subject: "AuditEvent" },
      { action: "read", subject: "Incident" },
    ]);
    await this.ensureRules(em, roles.tech_admin, [
      { action: "manage", subject: "User" },
      { action: "manage", subject: "Role" },
      // tech_admin accède au registre d'accès en lecture (list/get/export/stats/audit-events).
      { action: "read", subject: "AccessRecord" },
      // Le journal reste lisible, mais chaque ligne est filtrée par le domaine
      // qu'elle concerne : tech_admin y verra les événements du registre
      // d'accès, jamais ceux des incidents dont il est banni.
      { action: "read", subject: "AuditEvent" },
      { action: "manage", subject: "Incident", inverted: true, order: 10 },
    ]);

    return roles;
  }

  private async ensureRole(em: EntityManager, name: string): Promise<RoleEntityType> {
    const existing = await em.findOne(RoleEntity, { name });
    if (existing) return existing;
    return em.create(RoleEntity, { id: randomUUID(), name, description: null });
  }

  private async ensureRules(em: EntityManager, role: RoleEntityType, rules: RuleSeed[]) {
    const existingCount = await em.count(PermissionRuleEntity, { role: role.id });
    if (existingCount > 0) return;

    for (const rule of rules) {
      em.create(PermissionRuleEntity, {
        id: randomUUID(),
        role: role.id,
        action: rule.action,
        subject: rule.subject,
        conditions: rule.conditions ?? null,
        fields: null,
        inverted: rule.inverted ?? false,
        order: rule.order ?? 0,
      });
    }
  }

  // Référentiels du registre d'accès (catégories de données, finalités, bases
  // légales). Sans eux, les selects du formulaire d'accès sont vides ; partageant
  // la même base que le dev, un run e2e ne doit pas laisser la base sans
  // référentiels. Les données viennent de seed-data/referentials.ts, partagé
  // avec le seeder de dev pour que les deux ne divergent plus.
  private seedReferentials(em: EntityManager) {
    for (const seed of DATA_CATEGORY_SEEDS) {
      em.create(DataCategoryEntity, seed);
    }
    for (const seed of PURPOSE_SEEDS) {
      em.create(PurposeEntity, seed);
    }
    for (const seed of LEGAL_BASIS_SEEDS) {
      em.create(LegalBasisEntity, seed);
    }
  }
}
