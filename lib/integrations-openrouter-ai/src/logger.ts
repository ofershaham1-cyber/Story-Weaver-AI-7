import pino from "pino";
import path from "path";
import fs from "fs";

const logLevel = process.env.LOG_LEVEL ?? "debug";
const isProduction = process.env.NODE_ENV === "production";

const logsDir = path.resolve(process.cwd(), "logs");
fs.mkdirSync(logsDir, { recursive: true });
const openrouterLogPath = path.join(logsDir, "openrouter.log");

const devTransport = {
  targets: [
    {
      target: "pino-pretty",
      options: { colorize: true, destination: 1 },
      level: logLevel,
    },
    {
      target: "pino/file",
      options: { destination: openrouterLogPath },
      level: logLevel,
    },
  ],
};

const prodTransport = {
  targets: [
    {
      target: "pino/file",
      options: { destination: openrouterLogPath },
      level: logLevel,
    },
  ],
};

export const openrouterLogger = pino({
  name: "openrouter",
  level: logLevel,
  // redact: {
  //   paths: ["req.headers.authorization", "req.headers.Authorization"],
  //   censor: "[REDACTED]",
  // },
  transport: isProduction ? prodTransport : devTransport,
});
