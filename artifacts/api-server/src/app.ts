import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "fs";
import { resolve } from "path";
import router from "./routes";
import { logger } from "./lib/logger";

function loadOpenApiSpec(): Record<string, unknown> | null {
  const candidates = [
    resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
    resolve(process.cwd(), "lib/api-spec/openapi.yaml"),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      return parseYaml(raw) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  logger.warn("OpenAPI spec not found; Swagger UI disabled");
  return null;
}

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const openApiSpec = loadOpenApiSpec();
if (openApiSpec) {
  app.get("/api/docs/openapi.json", (_req, res) => {
    res.json(openApiSpec);
  });
  // Without a trailing slash, the Swagger HTML's relative asset URLs
  // (./swagger-ui.css, ./swagger-ui-bundle.js) resolve to /api/* and 404.
  // Intercept the no-slash case BEFORE the swagger middleware runs.
  app.use((req, res, next) => {
    if (req.method === "GET" && req.path === "/api/docs") {
      res.redirect(301, "/api/docs/");
      return;
    }
    next();
  });
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "Story Together API",
      swaggerOptions: { url: "/api/docs/openapi.json" },
    }),
  );
}

export default app;
