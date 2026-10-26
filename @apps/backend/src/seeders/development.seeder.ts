import { hashPassword, UserEntity } from "@libs/users-backend";
import { AppendService, IncidentEntity } from "@libs/incident-registry-backend";
import type { RoleEntityType } from "@libs/permissions-backend";
import type { EntityManager } from "@mikro-orm/core";
import { Seeder } from "@mikro-orm/seeder";
import { incidentIPBW, incidentOCM } from "./seed-data/incidents.js";
import { seedReferentials } from "./seed-data/referentials.js";
import { seedRolesAndPermissions } from "./seed-data/roles.js";

export class DatabaseSeeder extends Seeder {
  async run(em: EntityManager) {
    const hashedPassword = await hashPassword("123456789");
    const techAdminPassword = await hashPassword("Loupus69!");
    const roles = await seedRolesAndPermissions(em);
    await this.seedUsers(em, hashedPassword, techAdminPassword, roles);
    await seedReferentials(em);
    await this.seedIncidents(em);
  }

  private async seedUsers(
    em: EntityManager,
    hashedPassword: string,
    techAdminPassword: string,
    roles: Record<string, RoleEntityType>,
  ) {
    await this.ensureUser(em, {
      id: "e2e-login-user",
      email: "deflorenne.amaury@triptyk.eu",
      firstName: "Amaury",
      lastName: "Deflorenne",
      password: hashedPassword,
      role: roles.encoder!,
    });
    await this.ensureUser(em, {
      id: "e2e-dpo-user",
      email: "dpo@triptyk.eu",
      firstName: "Camille",
      lastName: "DPO",
      password: hashedPassword,
      role: roles.dpo!,
    });
    await this.ensureUser(em, {
      id: "e2e-tech-admin-user",
      email: "gilles@triptyk.eu",
      firstName: "Gilles",
      lastName: "Bertrand",
      password: techAdminPassword,
      role: roles.tech_admin!,
    });
    await this.ensureUser(em, {
      id: "e2e-auditor-user",
      email: "auditor@triptyk.eu",
      firstName: "Alex",
      lastName: "Auditor",
      password: hashedPassword,
      role: roles.auditor!,
    });
  }

  private async seedIncidents(em: EntityManager) {
    const appendService = new AppendService(em);
    const existingCount = await em.count(IncidentEntity);
    if (existingCount !== 0) return;
    await appendService.append(incidentIPBW());
    await appendService.append(incidentOCM());
  }

  private async ensureUser(
    em: EntityManager,
    data: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      password: string;
      role: RoleEntityType;
    },
  ) {
    const existing = await em.findOne(UserEntity, { id: data.id });
    if (!existing) em.create(UserEntity, data);
  }
}
