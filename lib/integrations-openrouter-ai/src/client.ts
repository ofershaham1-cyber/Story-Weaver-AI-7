import OpenAI from "openai";
import { openrouterLogger } from "./logger";

if (!process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_OPENROUTER_BASE_URL must be set. Did you forget to provision the OpenRouter AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_OPENROUTER_API_KEY must be set. Did you forget to provision the OpenRouter AI integration?",
  );
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = key.toLowerCase() === "authorization" ? "[REDACTED]" : value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = key.toLowerCase() === "authorization" ? "[REDACTED]" : value;
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      out[key] =
        key.toLowerCase() === "authorization" ? "[REDACTED]" : String(value);
    }
  }
  return out;
}

const loggingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const reqHeaders = headersToObject(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  const start = Date.now();
  openrouterLogger.info(
    {
      req: { method, url, headers: reqHeaders },
    },
    "openrouter request",
  );

  const response = await fetch(input as Parameters<typeof fetch>[0], init);
  const durationMs = Date.now() - start;

  if (!response.ok) {
    const cloned = response.clone();
    let body: string | undefined;
    try {
      body = await cloned.text();
    } catch {
      body = "<unreadable body>";
    }
    openrouterLogger.error(
      {
        res: {
          statusCode: response.status,
          statusText: response.statusText,
          body,
        },
        req: { method, url, headers: reqHeaders },
        durationMs,
      },
      "openrouter response error",
    );
  } else {
    openrouterLogger.info(
      {
        res: { statusCode: response.status },
        req: { method, url },
        durationMs,
      },
      "openrouter response",
    );
  }

  return response;
};

export const openrouter = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY,
  fetch: loggingFetch,
});
