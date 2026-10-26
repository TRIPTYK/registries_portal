// @lat: [[backend/permissions#Seed des 4 rôles avec permissions équivalentes au comportement actuel]]
// Les 4 rôles et leurs règles CASL : données de référence, pas de test. Le seeder
// de dev et la commande de migration de prod (src/cli/migrate.ts) les écrivent
// depuis cette seule définition.

import { PermissionRuleEntity, RoleEntity, type RoleEntityType } from "@libs/permissions-backend";
import type { EntityManager } from "@mikro-orm/core";
import { randomUUID } from "crypto";

interface RuleSeed {
  action: string;
  subject: string;
  conditions?: Record<string, unknown> | null;
  inverted?: boolean;
  order?: number;
}

// Idempotent : un rôle existant est réutilisé, et un rôle qui porte déjà des
// règles n'en reçoit pas d'autres (celles modifiées depuis l'UI sont conservées).
export async function seedRolesAndPermissions(em: EntityManager) {
  const roles = {
    encoder: await ensureRole(em, "encoder", "Encode les accès et incidents"),
    dpo: await ensureRole(em, "dpo", "Délégué à la protection des données"),
    auditor: await ensureRole(em, "auditor", "Audite l'intégrité des registres"),
    tech_admin: await ensureRole(em, "tech_admin", "Administration technique et comptes"),
  };

  await ensureRules(em, roles.encoder, [
    { action: "create", subject: "AccessRecord" },
    { action: "read", subject: "AccessRecord", conditions: { encodedBy: "$user.id" } },
    { action: "create", subject: "Incident" },
    { action: "read", subject: "Incident" },
    { action: "update", subject: "Incident", conditions: { encodedBy: "$user.id" } },
    { action: "delete", subject: "Incident", conditions: { encodedBy: "$user.id" } },
  ]);
  await ensureRules(em, roles.dpo, [
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
  await ensureRules(em, roles.auditor, [
    { action: "read", subject: "AccessRecord" },
    { action: "read", subject: "AccessRecordIntegrity" },
    { action: "read", subject: "IncidentIntegrity" },
    { action: "read", subject: "AuditEvent" },
    { action: "read", subject: "Incident" },
  ]);
  await ensureRules(em, roles.tech_admin, [
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

async function ensureRole(
  em: EntityManager,
  name: string,
  description: string,
): Promise<RoleEntityType> {
  const existing = await em.findOne(RoleEntity, { name });
  if (existing) return existing;
  return em.create(RoleEntity, { id: randomUUID(), name, description });
}

async function ensureRules(em: EntityManager, role: RoleEntityType, rules: RuleSeed[]) {
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
