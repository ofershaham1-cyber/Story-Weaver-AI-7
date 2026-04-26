import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import {
  db,
  conversations as conversationsTable,
  messages as messagesTable,
} from "@workspace/db";
import {
  CreateOpenrouterConversationBody,
  GetOpenrouterConversationParams,
  DeleteOpenrouterConversationParams,
  ListOpenrouterMessagesParams,
  SendOpenrouterMessageParams,
  SendOpenrouterMessageBody,
  TriggerOpenrouterAiTurnBody,
  UpdateOpenrouterMessageParams,
  UpdateOpenrouterMessageBody,
  RegenerateOpenrouterMessageParams,
  RegenerateOpenrouterMessageBody,
} from "@workspace/api-zod";
import {
  openrouter,
  createOpenRouterClient,
} from "@workspace/integrations-openrouter-ai";
import OpenAI from "openai";
import { logger } from "../../lib/logger";

interface AppConfig {
  openrouter?: {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
  };
}

/**
 * Read `config.json` fresh on every call. The file holds the OpenRouter
 * API key/URL/model and operators expect to swap credentials live without
 * restarting the API server. Caching the parsed config at module load
 * meant edits sat dormant until the next deploy — read on demand instead.
 *
 * The file is tiny and reads are cheap; we silently fall back to env
 * vars and built-in defaults when it's missing or malformed so the server
 * stays available even if the file is mid-edit.
 */
function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(join(process.cwd(), "config.json"), "utf-8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {};
  }
}

function getDefaultModel(cfg: AppConfig = loadConfig()): string {
  return (
    cfg.openrouter?.model?.trim() ||
    process.env.OPENROUTER_MODEL ||
    "openrouter/free"
  );
}

/**
 * Emit a single log line summarising what we're about to send to
 * OpenRouter. We trim the messages array to a head/tail preview so the
 * shape and the most-recent turn are visible without dumping kilobytes
 * of conversation history into the log every request.
 */
function logOpenRouterRequest(
  source: string,
  payload: {
    model: string;
    max_tokens?: number;
    temperature?: number | undefined;
    stream?: boolean;
    messages: Array<{ role: string; content: string }>;
  },
): void {
  const totalChars = payload.messages.reduce(
    (n, m) => n + (m.content?.length ?? 0),
    0,
  );
  const PREVIEW_HEAD = 2;
  const PREVIEW_TAIL = 2;
  const PREVIEW_CHARS = 240;
  const trimMsg = (m: { role: string; content: string }) => ({
    role: m.role,
    content:
      (m.content ?? "").length > PREVIEW_CHARS
        ? (m.content ?? "").slice(0, PREVIEW_CHARS) +
          `…(+${(m.content ?? "").length - PREVIEW_CHARS} chars)`
        : m.content,
  });
  let messagesPreview: unknown;
  if (payload.messages.length <= PREVIEW_HEAD + PREVIEW_TAIL) {
    messagesPreview = payload.messages.map(trimMsg);
  } else {
    messagesPreview = [
      ...payload.messages.slice(0, PREVIEW_HEAD).map(trimMsg),
      `…(+${payload.messages.length - PREVIEW_HEAD - PREVIEW_TAIL} more)`,
      ...payload.messages.slice(-PREVIEW_TAIL).map(trimMsg),
    ];
  }
  logger.info(
    {
      source,
      model: payload.model,
      max_tokens: payload.max_tokens,
      temperature: payload.temperature,
      stream: payload.stream ?? false,
      messageCount: payload.messages.length,
      totalChars,
      messages: messagesPreview,
    },
    "openrouter request",
  );
}

const router: IRouter = Router();

/**
 * Build the system prompt for AI completions. Optionally pins the response
 * language so the AI replies in the user's preferred BCP-47 language even if
 * the conversation history is in a different language.
 */
function buildSystemPrompt(opts: {
  maxWords: number;
  language?: string;
  /** "continue" appends a new paragraph; "fit-here" rewrites in place. */
  mode: "continue" | "fit-here";
}): string {
  const { maxWords, language, mode } = opts;
  const langClause =
    language && language.trim()
      ? ` IMPORTANT LANGUAGE RULE: Write your paragraph in ${language} (BCP-47 language code). Use natural, fluent ${language} regardless of what language earlier turns were written in.`
      : "";
  const taskClause =
    mode === "fit-here"
      ? "Write exactly one creative paragraph that fits naturally at this point in the story. The paragraph you produce will REPLACE the existing paragraph at this position, so any later paragraphs will follow yours. Do not summarize what came before, do not conclude the story, and avoid repeating earlier wording."
      : "Write exactly one new creative paragraph that continues the story forward. IMPORTANT: Do not repeat, restate, or paraphrase anything that has already been written — only add brand-new content that hasn't appeared yet. Do not summarize or conclude the story — leave room for the user to continue.";
  return `You are a collaborative storytelling AI friend. The user and you are writing a story together, taking turns. ${taskClause} Be imaginative and engaging. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.${langClause}`;
}

function getClient(
  apiKey?: string | null,
  apiUrl?: string | null,
  cfg: AppConfig = loadConfig(),
): OpenAI {
  const resolvedKey =
    (apiKey?.trim() ||
      cfg.openrouter?.apiKey?.trim().split(".")[0] ||
      process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY) ??
    "dummy";

  const resolvedUrl =
    apiUrl?.trim() ||
    cfg.openrouter?.apiUrl?.trim() ||
    process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;

  if (resolvedUrl && resolvedKey) {
    return createOpenRouterClient({
      baseURL: resolvedUrl,
      apiKey: resolvedKey,
    });
  } else {
    logger.error("No API key AND URL provided for OpenRouter");
  }
  return openrouter;
}

router.get("/openrouter/conversations", async (_req, res): Promise<void> => {
  const conversations = await db
    .select()
    .from(conversationsTable)
    .orderBy(conversationsTable.createdAt);
  res.json(conversations);
});

router.post("/openrouter/conversations", async (req, res): Promise<void> => {
  const parsed = CreateOpenrouterConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [conv] = await db
    .insert(conversationsTable)
    .values({ title: parsed.data.title })
    .returning();
  res.status(201).json(conv);
});

router.get("/openrouter/conversations/:id", async (req, res): Promise<void> => {
  const params = GetOpenrouterConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, params.data.id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.id))
    .orderBy(messagesTable.createdAt);
  res.json({ ...conv, messages });
});

router.delete(
  "/openrouter/conversations/:id",
  async (req, res): Promise<void> => {
    const params = DeleteOpenrouterConversationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [conv] = await db
      .delete(conversationsTable)
      .where(eq(conversationsTable.id, params.data.id))
      .returning();
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.sendStatus(204);
  },
);

router.get(
  "/openrouter/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const params = ListOpenrouterMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, params.data.id))
      .orderBy(messagesTable.createdAt);
    res.json(messages);
  },
);

router.post(
  "/openrouter/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const params = SendOpenrouterMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const bodyParsed = SendOpenrouterMessageBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }

    const conversationId = params.data.id;
    const {
      content: userContent,
      model,
      maxTokens,
      temperature,
      apiKey,
      apiUrl,
      skipAiCompletion,
      language,
    } = bodyParsed.data;

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [savedMessage] = await db
      .insert(messagesTable)
      .values({
        conversationId,
        role: "user",
        content: userContent,
        // Persist the language tag the client claimed for this user message
        // so later TTS playback can read it back in the correct voice.
        language: language ?? null,
      })
      .returning();

    if (skipAiCompletion) {
      res.status(201).json(savedMessage);
      return;
    }

    const allMessages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(messagesTable.createdAt);

    const chatHistory = allMessages
      .filter((m) => m.content.trim() !== "")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const cfg = loadConfig();
    const client = getClient(apiKey, apiUrl, cfg);
    const effectiveModel = model?.trim() || getDefaultModel(cfg);
    const maxWords = maxTokens ?? 10;
    const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

    try {
      const streamMessages = [
        {
          role: "system" as const,
          content: `You are a collaborative storytelling AI friend. The user and you are writing a story together, taking turns. Write exactly one new creative paragraph that continues the story forward. IMPORTANT: Do not repeat, restate, or paraphrase anything that has already been written — only add brand-new content that hasn't appeared yet. Do not summarize or conclude the story — leave room for the user to continue. Be imaginative and engaging. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.`,
        },
        ...chatHistory,
      ];
      logOpenRouterRequest("send-message-stream", {
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        temperature: temperature ?? undefined,
        stream: true,
        messages: streamMessages,
      });
      const stream = await client.chat.completions.create({
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        temperature: temperature ?? undefined,
        messages: streamMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      if (fullResponse.trim()) {
        await db.insert(messagesTable).values({
          conversationId,
          role: "assistant",
          content: fullResponse,
          // Streaming branch carries no explicit AI-language hint, so fall
          // back to the user-message language (best guess for TTS).
          language: language ?? null,
          // Record which model produced this paragraph so the UI can show
          // provenance and debugging stays accurate when the active
          // model is changed mid-conversation.
          model: effectiveModel,
        });
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "AI completion failed";
      res.write(`data: ${JSON.stringify({ error: message, done: true })}\n\n`);
      res.end();
    }
  },
);

router.post(
  "/openrouter/conversations/:id/ai-turn",
  async (req, res): Promise<void> => {
    const params = SendOpenrouterMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const bodyParsed = TriggerOpenrouterAiTurnBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }

    const conversationId = params.data.id;
    const { model, maxTokens, temperature, apiKey, apiUrl, language } =
      bodyParsed.data;

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const allMessages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(messagesTable.createdAt);

    const chatHistory = allMessages
      .filter((m) => m.content.trim() !== "")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    if (chatHistory.length === 0) {
      res.status(400).json({ error: "No messages to respond to" });
      return;
    }

    const cfg = loadConfig();
    const client = getClient(apiKey, apiUrl, cfg);
    const effectiveModel = model?.trim() || getDefaultModel(cfg);
    const maxWords = maxTokens ?? 10;
    const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

    const requestPayload = {
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature ?? undefined,
      messages: [
        {
          role: "system" as const,
          content: buildSystemPrompt({
            maxWords,
            language: language ?? undefined,
            mode: "continue",
          }),
        },
        ...chatHistory,
      ],
    };

    const maxAttempts = Math.max(
      1,
      Number(process.env.AI_MAX_ATTEMPTS ?? "3"),
    );
    const attempts: Array<{
      attempt: number;
      durationMs: number;
      success: boolean;
      error?: { status?: number; message: string };
      finishReason?: string | null;
      empty?: boolean;
    }> = [];

    let lastError:
      | { status: number; message: string; body?: unknown }
      | null = null;
    let successCompletion: OpenAI.Chat.Completions.ChatCompletion | null = null;
    let successContent = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();
      try {
        logOpenRouterRequest(`ai-turn (attempt ${attempt}/${maxAttempts})`, {
          ...requestPayload,
          stream: false,
        });
        const completion = await client.chat.completions.create({
          ...requestPayload,
          stream: false,
        });
        const content = completion.choices[0]?.message?.content?.trim() ?? "";
        const finishReason = completion.choices[0]?.finish_reason ?? null;

        if (!content) {
          attempts.push({
            attempt,
            durationMs: Date.now() - start,
            success: false,
            empty: true,
            finishReason,
            error: { message: "AI returned an empty response" },
          });
          lastError = { status: 502, message: "AI returned an empty response" };
          continue;
        }

        attempts.push({
          attempt,
          durationMs: Date.now() - start,
          success: true,
          finishReason,
        });
        successCompletion = completion;
        successContent = content;
        break;
      } catch (err) {
        const status =
          err instanceof OpenAI.APIError && typeof err.status === "number"
            ? err.status
            : 500;
        const message =
          err instanceof Error ? err.message : "AI completion failed";
        const body =
          err instanceof OpenAI.APIError
            ? (err as { error?: unknown }).error
            : undefined;
        attempts.push({
          attempt,
          durationMs: Date.now() - start,
          success: false,
          error: { status, message },
        });
        lastError = { status, message, body };
        logger.warn(
          { err, status, attempt, maxAttempts },
          "openrouter ai-turn attempt failed",
        );
      }
    }

    if (successCompletion && successContent) {
      const [inserted] = await db
        .insert(messagesTable)
        .values({
          conversationId,
          role: "assistant",
          content: successContent,
          // The AI was instructed to respond in `language`; persist that so
          // TTS playback later reads this paragraph in the matching voice.
          language: language ?? null,
          // Record the actual model that produced this paragraph so the
          // UI can display provenance per-message.
          model: effectiveModel,
        })
        .returning();

      res.status(200).json({
        message: inserted,
        request: requestPayload,
        response: successCompletion,
        attempts,
      });
      return;
    }

    const finalStatus = lastError?.status ?? 500;
    const finalMessage = lastError?.message ?? "AI completion failed";
    logger.error(
      { status: finalStatus, attempts },
      "openrouter ai-turn exhausted retries",
    );
    res.status(finalStatus).json({
      error: finalMessage,
      request: requestPayload,
      response: lastError?.body ?? { message: finalMessage },
      attempts,
    });
  },
);

router.patch(
  "/openrouter/messages/:messageId",
  async (req, res): Promise<void> => {
    const params = UpdateOpenrouterMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateOpenrouterMessageBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.data });
      return;
    }

    const [existing] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, params.data.messageId));
    if (!existing) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // After editing an AI (assistant) message, change owner to user.
    const newRole = existing.role === "assistant" ? "user" : existing.role;

    // Only overwrite `language` when the client explicitly sent one (it's
    // optional in the schema). This avoids wiping a previously-saved tag.
    const updates: { content: string; role: string; language?: string | null } = {
      content: body.data.content,
      role: newRole,
    };
    if (body.data.language !== undefined) {
      updates.language = body.data.language ?? null;
    }

    const [updated] = await db
      .update(messagesTable)
      .set(updates)
      .where(eq(messagesTable.id, params.data.messageId))
      .returning();
    res.json(updated);
  },
);

router.delete(
  "/openrouter/messages/:messageId",
  async (req, res): Promise<void> => {
    const params = UpdateOpenrouterMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [deleted] = await db
      .delete(messagesTable)
      .where(eq(messagesTable.id, params.data.messageId))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.sendStatus(204);
  },
);

router.post(
  "/openrouter/messages/:messageId/regenerate",
  async (req, res): Promise<void> => {
    const params = RegenerateOpenrouterMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const bodyParsed = RegenerateOpenrouterMessageBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }

    const messageId = params.data.messageId;
    const { model, maxTokens, temperature, apiKey, apiUrl, language } =
      bodyParsed.data;

    const [target] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));
    if (!target) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // Build context: every message in this conversation that comes BEFORE
    // the target (by createdAt then id), with non-empty content.
    const allMessages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, target.conversationId))
      .orderBy(messagesTable.createdAt);

    const priorMessages = allMessages.filter((m) => {
      if (m.id === target.id) return false;
      if (m.createdAt < target.createdAt) return true;
      if (m.createdAt > target.createdAt) return false;
      // Same createdAt — fall back to id ordering
      return m.id < target.id;
    });

    const chatHistory = priorMessages
      .filter((m) => m.content.trim() !== "")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const cfg = loadConfig();
    const client = getClient(apiKey, apiUrl, cfg);
    const effectiveModel = model?.trim() || getDefaultModel(cfg);
    const maxWords = maxTokens ?? 10;
    const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

    const requestPayload = {
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature ?? undefined,
      messages: [
        {
          role: "system" as const,
          content: buildSystemPrompt({
            maxWords,
            language: language ?? undefined,
            mode: "fit-here",
          }),
        },
        ...chatHistory,
      ],
    };

    const maxAttempts = Math.max(
      1,
      Number(process.env.AI_MAX_ATTEMPTS ?? "3"),
    );
    let lastError: { status: number; message: string } | null = null;
    let successContent = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logOpenRouterRequest(`regenerate (attempt ${attempt}/${maxAttempts})`, {
          ...requestPayload,
          stream: false,
        });
        const completion = await client.chat.completions.create({
          ...requestPayload,
          stream: false,
        });
        const content = completion.choices[0]?.message?.content?.trim() ?? "";
        if (!content) {
          lastError = { status: 502, message: "AI returned an empty response" };
          continue;
        }
        successContent = content;
        break;
      } catch (err) {
        const status =
          err instanceof OpenAI.APIError && typeof err.status === "number"
            ? err.status
            : 500;
        const message =
          err instanceof Error ? err.message : "AI completion failed";
        lastError = { status, message };
        logger.warn(
          { err, status, attempt, maxAttempts },
          "openrouter regenerate attempt failed",
        );
      }
    }

    if (!successContent) {
      const finalStatus = lastError?.status ?? 500;
      const finalMessage = lastError?.message ?? "AI completion failed";
      res.status(finalStatus).json({ error: finalMessage });
      return;
    }

    const [updated] = await db
      .update(messagesTable)
      .set({
        content: successContent,
        // Regeneration honoured the requested `language`; record it so the
        // refreshed paragraph plays back in the right voice next time.
        ...(language !== undefined ? { language: language ?? null } : {}),
        // The paragraph was just (re)written by `effectiveModel`, so the
        // stored model attribution must reflect that — otherwise the UI
        // would still show the old model badge from the prior generation.
        model: effectiveModel,
      })
      .where(eq(messagesTable.id, messageId))
      .returning();

    res.status(200).json(updated);
  },
);

router.post("/openrouter/completions", async (req, res): Promise<void> => {
  const parsed = SendOpenrouterMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    content: userContent,
    model,
    maxTokens,
    temperature,
    apiKey,
    apiUrl,
  } = parsed.data;

  const cfg = loadConfig();
  const client = getClient(apiKey, apiUrl, cfg);
  const effectiveModel = model?.trim() || getDefaultModel(cfg);
  const maxWords = maxTokens ?? 10;
  const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

  try {
    const completionsMessages = [
      {
        role: "system" as const,
        content: `You are a collaborative storytelling AI friend. Write exactly one new creative paragraph that continues the story forward. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.`,
      },
      { role: "user" as const, content: userContent },
    ];
    logOpenRouterRequest("completions", {
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature ?? undefined,
      messages: completionsMessages,
    });
    const completion = await client.chat.completions.create({
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature ?? undefined,
      messages: completionsMessages,
    });

    const answer = completion.choices[0]?.message?.content ?? "";
    res.json({ answer, model: effectiveModel });
  } catch (err) {
    const status =
      err instanceof OpenAI.APIError && typeof err.status === "number"
        ? err.status
        : 500;
    const message =
      err instanceof Error ? err.message : "AI completion failed";
    logger.error({ err, status }, "openrouter completion failed");
    res.status(status).json({ error: message });
  }
});

export default router;
