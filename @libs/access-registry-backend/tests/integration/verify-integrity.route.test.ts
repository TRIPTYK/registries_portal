import { afterAll, aroundEach, beforeAll, expect, test } from "vitest";
import { TestModule } from "#tests/utils/setup-module.js";

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

const validPayload = {
  data: {
    type: "access-records",
    attributes: {
      accessedAt: "2024-06-01T09:00:00.000Z",
      accessorRef: "emp-001",
      dataSubjectRef: "cust-abc",
      dataCategories: ["identité"],
      isSpecialCategory: false,
      accessType: "consultation",
      purpose: "support",
      legalBasis: "art6.1b",
      sourceSystem: "CRM",
      justification: "Test",
    },
  },
};

test("chaîne vide → ok:true, total:0", async () => {
  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/access-records/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, total: 0 });
});

test("chaîne valide après 2 inserts → ok:true", async () => {
  for (let i = 0; i < 2; i++) {
    await module.fastifyInstance.inject({
      method: "POST",
      url: "/access-records",
      headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
      payload: validPayload,
    });
  }

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/access-records/verify-integrity",
    headers: { authorization: module.generateBearerToken("auditor-id", "auditor") },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, total: 2 });
});

test("falsification détectée après UPDATE SQL direct du hash", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/access-records",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validPayload,
  });

  // Falsification directe en SQL (contournement des triggers pour le test)
  const em = module.em;
  await em.execute(`SET LOCAL session_replication_role = replica`);
  await em.execute(`UPDATE access_record SET hash = repeat('f', 64) WHERE seq = 1`);
  await em.execute(`SET LOCAL session_replication_role = DEFAULT`);

  const response = await module.fastifyInstance.inject({
    method: "GET",
    url: "/access-records/verify-integrity",
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
    url: "/access-records/verify-integrity",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
  });
  expect(response.statusCode).toBe(403);
});

test("UPDATE direct → exception trigger (append-only)", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/access-records",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validPayload,
  });

  const em = module.em;
  await expect(
    em.execute(`UPDATE access_record SET justification = 'tampered' WHERE seq = 1`),
  ).rejects.toThrow(/append-only/i);
});

test("DELETE direct → exception trigger (append-only)", async () => {
  await module.fastifyInstance.inject({
    method: "POST",
    url: "/access-records",
    headers: { authorization: module.generateBearerToken("encoder-id", "encoder") },
    payload: validPayload,
  });

  const em = module.em;
  await expect(em.execute(`DELETE FROM access_record WHERE seq = 1`)).rejects.toThrow(
    /append-only/i,
  );
});
