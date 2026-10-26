import { hashPassword, UserEntity, type UserEntityType } from "@libs/users-backend";
import { RoleEntity } from "@libs/permissions-backend";
import type { EntityManager } from "@mikro-orm/core";
import { randomUUID } from "crypto";

// Même seuil que la création par l'API (users-backend, create.route.ts).
const MIN_PASSWORD_LENGTH = 12;

export interface NewUserAccount {
  email: string;
  firstName: string;
  lastName: string;
  roleName: string;
  password: string;
}

/**
 * Crée un compte hors de l'API, pour le premier utilisateur d'une base vide :
 * sans compte tech_admin, personne ne peut en créer depuis l'interface.
 *
 * @lat: [[apps/deployment#Migrations au déploiement#Créer un utilisateur]]
 */
export async function createUserAccount(
  em: EntityManager,
  account: NewUserAccount,
): Promise<UserEntityType> {
  if (account.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`);
  }

  const role = await em.findOne(RoleEntity, { name: account.roleName });
  if (!role) {
    const names = (await em.find(RoleEntity, {})).map((r) => r.name);
    throw new Error(`rôle inconnu « ${account.roleName} » (disponibles : ${names.join(", ")})`);
  }

  if (await em.findOne(UserEntity, { email: account.email })) {
    throw new Error(`un utilisateur existe déjà avec l'adresse ${account.email}`);
  }

  const user = em.create(UserEntity, {
    id: randomUUID(),
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    password: await hashPassword(account.password),
    role,
    passwordChangedAt: new Date().toISOString(),
  });
  await em.flush();

  return user;
}
