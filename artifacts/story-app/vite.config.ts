import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/**
 * Capture browser console output and uncaught errors to a server-side
 * log file so the developer agent (which can't see the user's browser
 * devtools) can inspect what the app actually emitted at runtime.
 *
 * The plugin does two things:
 *   1. Injects a tiny script at the top of `<head>` that wraps
 *      `console.{log,info,warn,error,debug}`, plus `window.onerror` and
 *      `unhandledrejection`, into a batched POST to `/__client-log`.
 *   2. Adds a dev-server middleware on `/__client-log` that appends
 *      newline-delimited JSON entries to `logs/client.log`.
 *
 * Dev-only by design — the middleware is only registered via
 * `configureServer`, so production builds carry no extra surface.
 */
function clientLogPlugin(): Plugin {
  const logDir = path.resolve(import.meta.dirname, "logs");
  const logFile = path.join(logDir, "client.log");

  const ensureLogFile = () => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      // best-effort — if the directory can't be created we silently drop logs
    }
  };

  return {
    name: "story-app-client-log",
    apply: "serve",
    configureServer(server) {
      ensureLogFile();
      server.middlewares.use("/__client-log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const lines = body.split("\n").filter((l) => l.trim().length > 0);
            const out =
              lines
                .map((l) => {
                  try {
                    const e = JSON.parse(l) as {
                      t?: string;
                      level?: string;
                      msg?: string;
                      url?: string;
                    };
                    const stamp = e.t || new Date().toISOString();
                    const lvl = (e.level || "log").toUpperCase();
                    const url = e.url ? ` (${e.url})` : "";
                    return `[${stamp}] [${lvl}]${url} ${e.msg ?? ""}`;
                  } catch {
                    return `[${new Date().toISOString()}] [LOG] ${l}`;
                  }
                })
                .join("\n") + "\n";
            fs.appendFile(logFile, out, () => {});
          } catch {
            // swallow — logging must never break the page
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "script",
            // Plain (non-module) script so it executes synchronously and
            // wraps console BEFORE any app code runs and emits its first
            // log line.
            children: `(function(){
  if (window.__clientLogInstalled) return;
  window.__clientLogInstalled = true;
  // Resolve relative to <base href> so this works under any BASE_PATH.
  var endpoint = new URL("__client-log", document.baseURI).pathname;
  var queue = [];
  var flushTimer = null;
  function flush(){
    if(!queue.length) return;
    var body = queue.splice(0).map(function(e){ return JSON.stringify(e); }).join("\\n");
    try {
      var blob = new Blob([body], { type: "text/plain" });
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, blob)) return;
      fetch(endpoint, { method: "POST", body: body, keepalive: true }).catch(function(){});
    } catch(_){}
  }
  function schedule(){
    if (flushTimer) return;
    flushTimer = setTimeout(function(){ flushTimer = null; flush(); }, 250);
  }
  function fmt(args){
    return Array.prototype.slice.call(args).map(function(a){
      if (a instanceof Error) return (a.stack || a.message || String(a));
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch(_) { return String(a); }
    }).join(" ");
  }
  function push(level, args){
    try {
      queue.push({ t: new Date().toISOString(), level: level, url: location.pathname + location.search, msg: fmt(args) });
      schedule();
    } catch(_){}
  }
  ["log","info","warn","error","debug"].forEach(function(level){
    var orig = console[level] ? console[level].bind(console) : function(){};
    console[level] = function(){
      orig.apply(null, arguments);
      push(level, arguments);
    };
  });
  window.addEventListener("error", function(e){
    var msg = e.error && (e.error.stack || e.error.message) ? (e.error.stack || e.error.message) : (e.message || "unknown error");
    push("error", ["[window.onerror]", msg, "@", e.filename + ":" + e.lineno + ":" + e.colno]);
  });
  window.addEventListener("unhandledrejection", function(e){
    var r = e.reason;
    var msg = (r && (r.stack || r.message)) ? (r.stack || r.message) : String(r);
    push("error", ["[unhandledrejection]", msg]);
  });
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
  setInterval(flush, 2000);
})();`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    clientLogPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
