import { afterAll, aroundEach, beforeAll, expect, test } from "vitest";
import { computeRecordHash, GENESIS_HASH } from "@libs/backend-shared";
import { TestModule } from "#tests/utils/setup-module.js";
import { validIncidentPayload } from "#tests/utils/fixtures.js";
import { frozenIncidentRowAt } from "#tests/unit/canonical-fixtures.js";
import { IncidentEntity } from "#src/entities/incident.entity.js";
import {
  CURRENT_INCIDENT_CANONICAL_VERSION,
  incidentCanonicalString,
} from "#src/utils/incident-canonical.js";

let module: TestModule;

beforeAll(async () => {
  module = await TestModule.init();
});

afterAll(async () => {
  await module.close();
});

aroundEach(async (runTest) => {
  const em = module.em;
  await em.begin();
  await runTest();
  await em.rollback();
});

test("chaîne vide → ok:true, total:0", async () => {
  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, total: 0 });
});

test("chaîne valide après 2 inserts → ok:true", async () => {
  for (let i = 0; i < 2; i++) {
    await module.fastifyInstance.inject({
      method: "POST",
      url: "/incidents",
      headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
      payload: validIncidentPayload,
    });
  }

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, total: 2 });
});

test("falsification détectée après UPDATE SQL direct du hash", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });

  const em = module.em;
  await em.execute(`SET LOCAL session_replication_role = replica`);
  await em.execute(`UPDATE incident SET hash = repeat('f', 64) WHERE seq = 1`);
  await em.execute(`SET LOCAL session_replication_role = DEFAULT`);

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.ok).toBe(false);
  expect(body.brokenAt).toBe(0);
});

test("encoder ne peut pas appeler verify-integrity (403)", async () => {
  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
  });
  expect(response.statusCode).toBe(403);
});

test("UPDATE direct → exception trigger (append-only)", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });

  const em = module.em;
  await expect(
    em.execute(`UPDATE incident SET description = 'tampered' WHERE seq = 1`),
  ).rejects.toThrow(/append-only/i);
});

test("DELETE direct → exception trigger (append-only)", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });

  const em = module.em;
  await expect(em.execute(`DELETE FROM incident WHERE seq = 1`)).rejects.toThrow(/append-only/i);
});

// @lat: [[backend/hash-chain-integrity#Jeu de champs canoniques versionné#Chaîne mixte v1 + v2]]
test("chaîne mixte réelle : ligne v1 insérée puis ligne v2 créée par l'API → ok:true", async () => {
  const em = module.em;

  // Ligne v1 : hachée sous le jeu de champs antérieur au versionnage, exactement
  // comme les lignes déjà présentes en base avant l'ALTER TABLE.
  const v1Row = frozenIncidentRowAt(1);
  const v1Hash = computeRecordHash(GENESIS_HASH, incidentCanonicalString(v1Row, 1));
  await em.getRepository(IncidentEntity).insert({ ...v1Row, hash: v1Hash });

  // Ligne v2 : créée par le chemin d'écriture normal, chaînée sur la v1.
  const created = await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });
  expect(created.statusCode).toBe(200);

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });
  expect(response.json()).toMatchObject({ ok: true, total: 2 });

  const rows = await em.getRepository(IncidentEntity).findAll({ orderBy: { seq: "ASC" } });
  expect(rows.map((r) => r.canonicalVersion)).toEqual([1, CURRENT_INCIDENT_CANONICAL_VERSION]);
  expect(rows[1]!.prevHash).toBe(v1Hash);
});

test("canonical_version est figée par le trigger (pas une colonne lifecycle)", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });

  // Si canonical_version rejoignait le tableau `lifecycle` de
  // forbid_incident_content_mutation(), cet UPDATE passerait : n'importe quel
  // accès applicatif pourrait alors faire déclarer la chaîne rompue.
  await expect(
    module.em.execute(`UPDATE incident SET canonical_version = 1 WHERE seq = 1`),
  ).rejects.toThrow(/append-only/i);
});

test("rétrograder canonical_version (trigger désactivé) casse la chaîne", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/incidents",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validIncidentPayload,
  });

  const em = module.em;
  await em.execute(`SET LOCAL session_replication_role = replica`);
  await em.execute(`UPDATE incident SET canonical_version = 1 WHERE seq = 1`);
  await em.execute(`SET LOCAL session_replication_role = DEFAULT`);

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/incidents/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });
  expect(response.json()).toMatchObject({ ok: false, brokenAt: 0 });
});
