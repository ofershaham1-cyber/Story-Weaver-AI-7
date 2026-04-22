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
  UpdateOpenrouterMessageParams,
  UpdateOpenrouterMessageBody,
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

function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(join(process.cwd(), "config.json"), "utf-8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {};
  }
}

const config = loadConfig();

const DEFAULT_MODEL =
  config.openrouter?.model?.trim() ||
  process.env.OPENROUTER_MODEL ||
  "openrouter/free";

const router: IRouter = Router();

function getClient(apiKey?: string | null, apiUrl?: string | null): OpenAI {
  const resolvedKey =
    (apiKey?.trim() ||
      config.openrouter?.apiKey?.trim().split(".")[0] ||
      process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY) ??
    "dummy";

  const resolvedUrl =
    apiUrl?.trim() ||
    config.openrouter?.apiUrl?.trim() ||
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

    const client = getClient(apiKey, apiUrl);
    const effectiveModel = model?.trim() || DEFAULT_MODEL;
    const maxWords = maxTokens ?? 10;
    const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

    try {
      const stream = await client.chat.completions.create({
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        temperature: temperature ?? undefined,
        messages: [
          {
            role: "system",
            content: `You are a collaborative storytelling AI friend. The user and you are writing a story together, taking turns. Write exactly one new creative paragraph that continues the story forward. IMPORTANT: Do not repeat, restate, or paraphrase anything that has already been written — only add brand-new content that hasn't appeared yet. Do not summarize or conclude the story — leave room for the user to continue. Be imaginative and engaging. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.`,
          },
          ...chatHistory,
        ],
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
    const bodyParsed = SendOpenrouterMessageBody.safeParse({
      content: "_unused_",
      ...req.body,
    });
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }

    const conversationId = params.data.id;
    const { model, maxTokens, temperature, apiKey, apiUrl } = bodyParsed.data;

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

    const client = getClient(apiKey, apiUrl);
    const effectiveModel = model?.trim() || DEFAULT_MODEL;
    const maxWords = maxTokens ?? 10;
    const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    try {
      const stream = await client.chat.completions.create({
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        temperature: temperature ?? undefined,
        messages: [
          {
            role: "system",
            content: `You are a collaborative storytelling AI friend. The user and you are writing a story together, taking turns. Write exactly one new creative paragraph that continues the story forward. IMPORTANT: Do not repeat, restate, or paraphrase anything that has already been written — only add brand-new content that hasn't appeared yet. Do not summarize or conclude the story — leave room for the user to continue. Be imaginative and engaging. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.`,
          },
          ...chatHistory,
        ],
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
        });
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      const status =
        err instanceof OpenAI.APIError && typeof err.status === "number"
          ? err.status
          : 500;
      const message =
        err instanceof Error ? err.message : "AI completion failed";
      logger.error({ err, status }, "openrouter ai-turn failed");
      res.write(
        `data: ${JSON.stringify({ error: message, status, done: true })}\n\n`,
      );
      res.end();
    }
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
    const [updated] = await db
      .update(messagesTable)
      .set({ content: body.data.content })
      .where(eq(messagesTable.id, params.data.messageId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(updated);
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

  const client = getClient(apiKey, apiUrl);
  const effectiveModel = model?.trim() || DEFAULT_MODEL;
  const maxWords = maxTokens ?? 10;
  const effectiveMaxTokens = Math.ceil(maxWords / 0.75);

  try {
    const completion = await client.chat.completions.create({
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature ?? undefined,
      messages: [
        {
          role: "system",
          content: `You are a collaborative storytelling AI friend. Write exactly one new creative paragraph that continues the story forward. Your response must be at most ${maxWords} words long — stop at a natural sentence boundary within that limit.`,
        },
        { role: "user", content: userContent },
      ],
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
