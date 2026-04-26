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

/**
 * Strip secrets and clamp huge fields out of a JSON-ish request body so
 * we can log it safely. We never want `apiKey` (OpenRouter creds the
 * client may forward) hitting the log stream, and `messages` arrays for
 * AI completions can be enormous — keep a trimmed preview instead.
 */
const SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "apiUrl",
  "api_url",
  "password",
  "token",
  "authorization",
]);
function sanitizeBody(body: unknown, depth = 0): unknown {
  if (body == null || depth > 4) return body;
  if (Array.isArray(body)) {
    if (body.length > 20) {
      return [
        ...body.slice(0, 20).map((v) => sanitizeBody(v, depth + 1)),
        `…(+${body.length - 20} more)`,
      ];
    }
    return body.map((v) => sanitizeBody(v, depth + 1));
  }
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) {
        out[k] = v ? "[redacted]" : v;
      } else {
        out[k] = sanitizeBody(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof body === "string" && body.length > 2000) {
    return body.slice(0, 2000) + `…(+${body.length - 2000} chars)`;
  }
  return body;
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        // Express puts the parsed JSON/urlencoded body on `req.raw.body`
        // when accessed via pino-http's wrapped req, and on `req.body`
        // when the standard middleware runs first. Try both.
        const raw =
          (req as unknown as { raw?: { body?: unknown } }).raw?.body ??
          (req as unknown as { body?: unknown }).body;
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
          ...(raw !== undefined && raw !== null
            ? { body: sanitizeBody(raw) }
            : {}),
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
