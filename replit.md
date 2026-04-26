# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: OpenRouter via Replit AI Integrations (lib/integrations-openrouter-ai). Uses env vars `AI_INTEGRATIONS_OPENROUTER_BASE_URL` / `AI_INTEGRATIONS_OPENROUTER_API_KEY` provisioned by the Replit OpenRouter blueprint. Leave `apiKey`/`apiUrl` out of `artifacts/api-server/config.json` so the env vars are used.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Applications

### Story Together (`artifacts/story-app`)
A collaborative storytelling app where the user and AI take turns writing story paragraphs.
- **Frontend**: React + Vite at `/`
- **Model**: `meta-llama/llama-4-scout` via OpenRouter
- **DB tables**: `conversations`, `messages`
- **API routes**: `/api/openrouter/conversations`, `/api/openrouter/conversations/:id/messages` (SSE stream), `/api/openrouter/conversations/:id/ai-turn`, `/api/openrouter/messages/:id` (PATCH/DELETE), `/api/openrouter/messages/:id/regenerate` (POST: rewrites a single paragraph in place using only prior context).
- **AI language**: `settings.stt.aiLanguage` (BCP-47, e.g. `en-US`, `he-IL`) is sent as the `language` body field to AI endpoints; the backend `buildSystemPrompt` helper in `routes/openrouter/index.ts` injects an instruction so the AI replies in that language regardless of the chat history language. Same value also drives TTS playback voice in `useVoice.speak()`.
- **Regenerate UI**: per-message hover button (Sparkles icon) in `story.tsx` next to edit/delete; only the targeted paragraph is replaced, all later paragraphs are preserved.
- **Per-message provenance**: each row in `messages` stores `language` and (for assistant rows) `model`. The story page renders both as small badges under each paragraph and the OpenAPI spec exposes them on `OpenrouterMessage`.
- **TTS playback**: header Play button reads the whole story; per-message Volume2 button reads a single paragraph. Both highlight the currently spoken word using `SpeechSynthesisUtterance.onboundary` (only on the original-language unit, where the on-screen word indices line up). `useVoice.speak()` is independent of the `enabled` flag (only `listen*` requires it), so playback works even when blind mode is off. Each utterance start logs `[tts-play] lang=… speed=… chars=…` for debugging.
- **On-screen translations**: `settings.viewLanguages: string[]` (multi-select via `view-languages-switcher.tsx`, popover + checkboxes) renders one `<TranslatedLine>` per selected BCP-47 code under every paragraph. Translations are fetched once via Google Translate (`lib/translate.ts`) and cached in react-query under `["translation", googleTarget, text]` with `staleTime: Infinity`.
- **TTS translation mode**: `settings.ttsTranslationMode: "off"|"with"|"only"` (`tts-translation-mode-switcher.tsx`) controls whether the Play buttons speak the original only (`off`), original + each selected translation (`with`), or only the translations (`only`). The `buildPlayUnits()` helper in `story.tsx` reuses the same react-query cache as `<TranslatedLine>` so playback never re-fetches translations.
- **Hot-reloadable config**: `artifacts/api-server/config.json` is read on every OpenRouter request (no module-level cache), so changing `apiKey`/`apiUrl`/`model` takes effect without an API server restart.
- **Browser console capture (dev)**: `vite.config.ts` includes a `clientLogPlugin` that injects a script wrapping `console.{log,info,warn,error,debug}` plus `window.onerror` / `unhandledrejection`, batched-POSTed to `/__client-log` and appended to `artifacts/story-app/logs/client.log`.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
