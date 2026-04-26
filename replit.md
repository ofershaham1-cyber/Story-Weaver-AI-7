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
- **TTS playback order**: `settings.ttsPlayOrder: string[]` is an ordered list whose entries are either the sentinel `PLAY_ORIGINAL` ("original") or a BCP-47 code from `viewLanguages`. The `buildPlayUnits()` helper in `story.tsx` walks this list and emits one TTS unit per entry — original entries speak the source paragraph (with word-by-word highlighting), translation entries fetch via the same react-query cache as `<TranslatedLine>` and speak the translated text. The `tts-play-order-dialog.tsx` (ListOrdered icon in the header) lets the user reorder, remove, and re-add items. `viewLanguages` and `ttsPlayOrder` are kept in sync via `syncPlayOrderForView()` whenever the View dropdown changes — newly picked languages auto-append to the play queue, removed ones drop out.
- **Blind-mode / manual-play interlock**: the blind-mode auto-loop in `story.tsx` reads the latest assistant message via its own `voice.speak()` whenever a new one arrives. Without a guard this races against the manual Play All / per-message Play loops and interrupts in-flight translation utterances mid-word. The blind-loop effect therefore checks `isPlayingStoryRef.current` and `playingMsgIdRef.current` (a ref-mirror of the `playingMsgId` state) and bails out *without* recording the cycle key when a manual playback is in flight; the effect then re-runs once `playingMsgId` / `isPlayingStory` clear, picking up the read-listen cycle for any newly-arrived message.
- **Translation line BCP-47 badge**: each `<TranslatedLine>` renders a small mono-styled language-code chip (e.g. `fr-FR`) inline before the translated text so users running multiple translations can identify each line at a glance.
- **Settings schema versioning**: `use-settings.ts` carries a `settingsVersion` field (current = 2). The `load()` migration re-applies select defaults for any payload below the current version. v1 fixed a bad default for the now-removed `ttsTranslationMode`; v2 derives `ttsPlayOrder` from the prior `ttsTranslationMode` + `viewLanguages` so users keep the playback intent they had configured.
- **Hot-reloadable config**: `artifacts/api-server/config.json` is read on every OpenRouter request (no module-level cache), so changing `apiKey`/`apiUrl`/`model` takes effect without an API server restart.
- **Browser console capture (dev)**: `vite.config.ts` includes a `clientLogPlugin` that injects a script wrapping `console.{log,info,warn,error,debug}` plus `window.onerror` / `unhandledrejection`, batched-POSTed to `/__client-log` and appended to `artifacts/story-app/logs/client.log`.
- **Click-to-play & active-line border**: every paragraph wraps its `<MessageBody>` in a clickable box and every `<TranslatedLine>` is itself clickable. Clicks call `handlePlayMessage(msg, startItem)` where `startItem` is `PLAY_ORIGINAL` or a BCP-47 code; the unit list from `buildPlayUnits` is sliced to start at that item, falling back to an ad-hoc one-shot unit if the requested item isn't in `ttsPlayOrder`. A `playingItem` state (set in both Play-All and Play-One loops alongside `playingMsgId`) drives a primary-coloured ring/border on whichever line is currently being spoken — original wrapper or `<TranslatedLine>` (the component takes an `isPlaying` prop). Tapping the live line stops playback.
- **Per-message action icons**: the Play / Edit / Regenerate / Delete buttons on each message use `w-5 h-5` icons (was `w-3.5 h-3.5`) for easier tap targets and to match the header buttons.
- **Server request logging**: the pino-http req serializer in `artifacts/api-server/src/app.ts` adds a `body` field built by `sanitizeBody()` (redacts `apiKey`/`apiUrl`/`token`/etc., trims long strings to ~2 KB, caps array previews at 20 items, depth-limits to 4). All four `client.chat.completions.create` call sites in `routes/openrouter/index.ts` are preceded by `logOpenRouterRequest(source, payload)` which logs `{ source, model, max_tokens, temperature, stream, messageCount, totalChars, messages }` with the messages array trimmed to head+tail previews so log volume stays sane.
- **Client error surface**: `story.tsx` keeps a local `actionError` state alongside the existing `streamError` from `useStoryStream`. The error banner shows `displayedError = streamError ?? actionError`. `handleRegenerateMessage`, `saveEdit`, and `handleDeleteMessage` now wrap their mutations in try/catch and call `setActionError(formatActionError(prefix, err))` on failure (alongside the existing error sound), so users see the actual cause instead of just hearing a beep. The dismiss button clears both.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
