# Story Together

A collaborative storytelling app where you and an AI take turns writing paragraphs of a story. Supports both typed and hands-free (Blind Mode) interaction using speech-to-text and text-to-speech.

---

## Requirements

- Node.js 20+
- pnpm 9+
- PostgreSQL database

---

## Configuration

### `artifacts/api-server/config.json`

OpenRouter settings are read from this file **first**, before falling back to environment variables. Leave fields empty to use the environment variable fallback.

```json
{
  "openrouter": {
    "apiKey": "",
    "apiUrl": "",
    "model": ""
  }
}
```

| Field    | Env var fallback                          | Description                                      |
|----------|-------------------------------------------|--------------------------------------------------|
| `apiKey` | `AI_INTEGRATIONS_OPENROUTER_API_KEY`      | Your OpenRouter API key                          |
| `apiUrl` | `AI_INTEGRATIONS_OPENROUTER_BASE_URL`     | OpenRouter base URL                              |
| `model`  | `OPENROUTER_MODEL`                        | Model ID, e.g. `meta-llama/llama-4-scout`        |

### Environment variables

| Variable                               | Required | Description                              |
|----------------------------------------|----------|------------------------------------------|
| `DATABASE_URL`                         | Yes      | PostgreSQL connection string             |
| `PORT`                                 | No       | API server port (default: `8080`)        |
| `AI_INTEGRATIONS_OPENROUTER_API_KEY`   | No*      | Fallback OpenRouter API key              |
| `AI_INTEGRATIONS_OPENROUTER_BASE_URL`  | No*      | Fallback OpenRouter base URL             |

\* Required if `config.json` fields are empty and you are not running on Replit with managed keys.

---

## Running without Docker

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set environment variables

Create a `.env` file or export variables in your shell:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/story_together"
export AI_INTEGRATIONS_OPENROUTER_API_KEY="sk-or-..."
export AI_INTEGRATIONS_OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
```

### 3. Run database migrations

```bash
pnpm --filter @workspace/db run push
```

### 4. Start the API server

```bash
PORT=8080 pnpm --filter @workspace/api-server run dev
```

### 5. Start the frontend (in a separate terminal)

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/story-app run dev
```

The app will be available at `http://localhost:5173`.

---

## Running with Docker Compose

### 1. Build and start all services

```bash
docker-compose up --build
```

The app will be available at `http://localhost:5173`.

### 2. Run database migrations (first time only)

```bash
docker-compose exec api pnpm --filter @workspace/db run push
```

### 3. Stop services

```bash
docker-compose down
```

To also remove the database volume:

```bash
docker-compose down -v
```

---

## API Documentation (Swagger UI)

Interactive API docs are served by the API server at:

```
http://localhost:8080/api/docs
```

The raw OpenAPI JSON is available at:

```
http://localhost:8080/api/docs/openapi.json
```

If you change `PORT`, swap `8080` for your value.

To print the URL from the shell:

```bash
pnpm docs
# or, with a custom port:
PORT=8080 pnpm docs
```

The Swagger UI is mounted automatically when the API server starts — no extra
process is needed. The spec is loaded from `lib/api-spec/openapi.yaml`.

---

## Where to find error logs

### Server (API backend) logs

**Development (without Docker):**
The API server uses [Pino](https://github.com/pinojs/pino) structured JSON logging. All logs go to `stdout`. Run with pretty-printing:

```bash
PORT=8080 pnpm --filter @workspace/api-server run dev | pnpm exec pino-pretty
```

Errors appear as `"level": 50` (ERROR) entries in the JSON stream.

**With Docker Compose:**
```bash
docker-compose logs api
docker-compose logs -f api   # follow in real time
```

**On Replit:** Open the "Start Backend" workflow console in the workspace.

### Client (browser frontend) logs

All frontend errors are logged to the **browser developer console**:

- Chrome / Edge: `F12` → **Console** tab
- Firefox: `F12` → **Console** tab

Filter by `Error` level to see only errors. Network errors (failed API calls) also appear in the **Network** tab.

**On Replit:** The browser console output is captured and visible in the agent workspace console panel.

---

## Key commands

| Command                                          | Description                                  |
|--------------------------------------------------|----------------------------------------------|
| `pnpm install`                                   | Install all workspace dependencies           |
| `pnpm run build`                                 | Build all packages                           |
| `pnpm run typecheck`                             | Type-check all packages                      |
| `pnpm --filter @workspace/db run push`           | Push DB schema changes                       |
| `pnpm --filter @workspace/api-spec run codegen`  | Regenerate API hooks and Zod schemas         |
| `pnpm --filter @workspace/api-server run dev`    | Start API server in dev mode                 |
| `pnpm --filter @workspace/story-app run dev`     | Start frontend dev server                    |


---

- create openrouter configuration

```sh
#to set openrouter access - update config file:
cp artifacts/api-server/config.json.example artifacts/api-server/config.json
```

- start client/server:
```sh
scripts/init.app.sh
```

- view logs:
```sh
cat artifacts/api-server/logs/server.log
cat artifacts/api-server/logs/openrouter.log
```