/* oxlint-disable max-lines -- enregistrement des modules + config swagger, scission non pertinente */
import { default as fastifyPassport } from "@fastify/passport";
import { jsonApiValidationPointer } from "@libs/backend-shared";
import fastifySecureSession from "@fastify/secure-session";
import {
  fastify as Fastify,
  type FastifyError,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { appRouter } from "./app.router.js";
import { resolveFeatures } from "#src/configuration.js";
import type { ApplicationContext } from "./application.context.js";
import { logger } from "./logger.js";
import { UserModule, AuthModule, createJwtAuthMiddleware } from "@libs/users-backend";
import { Module as TodoModule } from "@libs/todos-backend";
import { Module as AccessRegistryModule } from "@libs/access-registry-backend";
import { Module as IncidentRegistryModule } from "@libs/incident-registry-backend";
import { AuditAppendService, AuditLogModule } from "@libs/audit-log-backend";
import { PermissionsModule } from "@libs/permissions-backend";

export type FastifyInstanceType = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  any,
  ZodTypeProvider
>;

// Le pointer est normalisé par `@libs/backend-shared` : c'est la MÊME fonction
// qui sert au handler d'erreur de chaque module (`handleJsonApiErrors`), lequel
// répond en réalité pour toutes les routes métier — un handler installé sur un
// scope Fastify interne l'emporte sur celui-ci. Deux implémentations du même
// pointer, c'est exactement la divergence qui avait laissé passer le `//email`.

export class App {
  private constructor(
    private fastify: FastifyInstanceType,
    private context: ApplicationContext,
  ) {}

  // oxlint-disable-next-line max-lines-per-function
  public static async init(context: ApplicationContext) {
    const loggerInstance = logger(context.configuration);
    const fastifyInstance = Fastify({
      loggerInstance,
    });

    // @lat: [[backend/platform#Parser du content-type JSON:API]]
    //
    // La signature est `addContentTypeParser(contentType, opts, parser)` : le
    // parser doit être le TROISIÈME argument. Il était passé en deuxième, donc
    // dans le slot `opts`, et aucune fonction de parsing n'était enregistrée —
    // le `@ts-expect-error` qui accompagnait l'appel masquait précisément cette
    // erreur de signature.
    //
    // Conséquence : tout corps envoyé en `application/vnd.api+json` — c'est-à-dire
    // TOUTE écriture venant du front, WarpDrive posant ce content-type — repartait
    // en 400 `FST_ERR_CTP_INVALID_JSON_BODY` sans jamais être parsé. Aucun
    // incident ne pouvait être créé depuis l'interface. Les lectures (GET, sans
    // corps) n'étant pas concernées, l'application paraissait fonctionner.
    fastifyInstance.addContentTypeParser(
      "application/vnd.api+json",
      { parseAs: "string" },
      fastifyInstance.getDefaultJsonParser("ignore", "ignore"),
    );

    fastifyInstance.register(fastifySecureSession, {
      key: Buffer.from(context.configuration.SESSION_KEY, "hex"),
    });
    fastifyInstance.register(fastifyPassport.default.initialize());
    fastifyInstance.register(fastifyPassport.default.secureSession());

    fastifyInstance.setValidatorCompiler(validatorCompiler);
    fastifyInstance.setSerializerCompiler(serializerCompiler);

    const fastify: FastifyInstanceType = fastifyInstance.withTypeProvider<ZodTypeProvider>();
    await fastify.register(import("@fastify/cors"), {
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    });
    await fastify.register(import("@fastify/swagger"), {
      openapi: {
        info: {
          title: packageJson.name,
          version: packageJson.version,
        },
        servers: [
          {
            url: context.configuration.SERVER_URL,
            description: packageJson.description,
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
      transform: jsonSchemaTransform,
    });

    await fastify.register(import("@fastify/swagger-ui"), {
      routePrefix: "/documentation",
      uiConfig: {
        docExpansion: "full",
        deepLinking: false,
      },
      uiHooks: {
        onRequest: function (_request, _reply, next) {
          next();
        },
        preHandler: function (_request, _reply, next) {
          next();
        },
      },
      staticCSP: true,
      transformStaticCSP: (header) => header,
      transformSpecification: (swaggerObject, _request, _reply) => {
        return swaggerObject;
      },
      transformSpecificationClone: true,
    });

    fastify.register(
      await import("@fastify/static").then(({ default: staticPlugin }) => staticPlugin),
      {
        root: path.join(process.cwd(), "dist/uploads"),
        prefix: "/public/",
      },
    );

    const app = new App(fastify, context);

    await app.setupRoutes();

    return app;
  }

  // oxlint-disable-next-line max-lines-per-function
  private async setupRoutes() {
    this.setupHandlers();

    await appRouter(this.fastify, {
      authModule: AuthModule.init({
        configuration: {
          jwtRefreshSecret: this.context.configuration.JWT_REFRESH_SECRET,
          jwtSecret: this.context.configuration.JWT_SECRET,
        },
        em: this.context.orm.em.fork(),
      }),
      userModule: UserModule.init({
        em: this.context.orm.em.fork(),
        configuration: {
          jwtSecret: this.context.configuration.JWT_SECRET,
        },
      }),
      todosModule: TodoModule.init({
        em: this.context.orm.em.fork(),
        configuration: {
          jwtSecret: this.context.configuration.JWT_SECRET,
        },
      }),
      accessRegistryModule: AccessRegistryModule.init(
        {
          em: this.context.orm.em.fork(),
          configuration: {
            jwtSecret: this.context.configuration.JWT_SECRET,
            exportSigningKey: this.context.configuration.EXPORT_SIGNING_KEY,
          },
        },
        new AuditAppendService(this.context.orm.em.fork()),
      ),
      incidentRegistryModule: IncidentRegistryModule.init(
        {
          em: this.context.orm.em.fork(),
          configuration: {
            jwtSecret: this.context.configuration.JWT_SECRET,
            exportSigningKey: this.context.configuration.EXPORT_SIGNING_KEY,
          },
        },
        new AuditAppendService(this.context.orm.em.fork()),
      ),
      // @lat: [[backend/permissions#Module Fastify PermissionsModule]]
      permissionsModule: PermissionsModule.init(
        { em: this.context.orm.em.fork() },
        createJwtAuthMiddleware(this.context.orm.em.fork(), this.context.configuration.JWT_SECRET),
      ),
      auditLogModule: AuditLogModule.init({
        em: this.context.orm.em.fork(),
        configuration: { jwtSecret: this.context.configuration.JWT_SECRET },
      }),
      features: resolveFeatures(this.context.configuration),
    });
  }

  // @lat: [[backend/platform#Le handler d'erreur global répond en JSON:API]]
  //
  // Ce handler DOIT répondre un document d'erreur JSON:API, et poser le status
  // explicitement. Il renvoyait `{ message, code, status }`, une forme que
  // AUCUNE route ne déclare : les 17 `404`, 15 `403`, 6 `400`, 4 `409`, 4 `401`
  // et 1 `423` du monorepo sont tous déclarés en `jsonApiErrorDocumentSchema`,
  // c'est-à-dire `{ errors: [...] }`. Fastify sérialise la réponse d'erreur
  // contre le schéma déclaré pour ce status : la clé `errors` étant absente, la
  // sérialisation échouait et le client recevait un **500
  // FST_ERR_RESPONSE_SERIALIZATION opaque au lieu du 400 de validation**, sur
  // toutes les routes de tous les modules (vérifié sur POST /incidents et POST
  // /access-records). Le message expliquant le champ fautif était donc perdu,
  // et côté front « enregistrer » ne pouvait rien afficher d'utile.
  private setupHandlers() {
    this.fastify.setErrorHandler((error: FastifyError, request, reply) => {
      // eslint-disable-next-line no-console
      console.error(error);
      const status = error.statusCode ?? 500;
      // `error.validation` porte les issues de validation de requête (body,
      // params, query) : une par champ fautif, avec son pointer.
      const issues = error.validation ?? [];
      const errors = issues.length
        ? issues.map((issue) => ({
            status: String(status),
            code: error.code ?? "VALIDATION_ERROR",
            title: "Validation Error",
            detail: issue.message ?? error.message,
            source: { pointer: jsonApiValidationPointer(issue) },
          }))
        : [
            {
              status: String(status),
              code: error.code ?? "INTERNAL_ERROR",
              title: status >= 500 ? "Internal Server Error" : error.name,
              // Un 5xx ne doit pas fuiter l'interne au client ; les 4xx sont
              // des erreurs du client, leur message lui est utile.
              detail: status >= 500 ? "An unexpected error occurred." : error.message,
            },
          ];
      reply.code(status).send({ errors });
    });

    // Même contrat que le handler d'erreur : document JSON:API + status posé.
    this.fastify.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({
        errors: [{ status: "404", code: "NOT_FOUND", title: "Not Found" }],
      });
    });
  }

  public async start() {
    await this.fastify.listen({
      port: this.context.configuration.PORT,
      host: this.context.configuration.HOST,
    });
  }

  public async stop() {
    await this.fastify.close();
    await this.context.orm.close(true);
  }
}
