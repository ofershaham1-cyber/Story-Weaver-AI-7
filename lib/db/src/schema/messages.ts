import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  /**
   * BCP-47 language tag of the text in `content` (e.g. "en-US", "ja-JP").
   * Stored alongside each message so later text-to-speech playback can
   * select the correct voice/language even when individual messages were
   * authored in different languages within the same conversation.
   * Nullable for backwards compatibility with pre-migration rows.
   */
  language: text("language"),
  /**
   * Identifier of the AI model that generated this message
   * (e.g. "meta-llama/llama-4-scout"). Only populated for assistant
   * messages — user-authored rows leave it null. Persisted so the UI
   * can show provenance per-paragraph and so debugging stays accurate
   * when the active model changes mid-conversation.
   */
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
