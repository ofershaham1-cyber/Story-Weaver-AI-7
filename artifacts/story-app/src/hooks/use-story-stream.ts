import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListOpenrouterMessagesQueryKey } from "@workspace/api-client-react";
import { type StorySettings } from "@/hooks/use-settings";

function buildOptionsBody(settings?: StorySettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!settings) return body;
  body.model = settings.model || "openrouter/free";
  body.maxTokens = settings.maxTokens;
  body.temperature = settings.temperature;
  if (settings.apiKey) body.apiKey = settings.apiKey;
  if (settings.apiUrl) body.apiUrl = settings.apiUrl;
  return body;
}

export function useStoryStream(conversationId: number, settings?: StorySettings) {
  const [isTyping, setIsTyping] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: getListOpenrouterMessagesQueryKey(conversationId),
    });
  }, [conversationId, queryClient]);

  const submitUserMessage = useCallback(
    async (content: string): Promise<boolean> => {
      setStreamError(null);
      try {
        const body = { content, skipAiCompletion: true };
        const response = await fetch(
          `/api/openrouter/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) {
          throw new Error(
            `Server error ${response.status}: ${response.statusText}`,
          );
        }
        invalidate();
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Error submitting user message:", error);
        setStreamError(msg);
        return false;
      }
    },
    [conversationId, invalidate],
  );

  const requestAiTurn = useCallback(async (): Promise<boolean> => {
    setIsTyping(true);
    setStreamedContent("");
    setStreamError(null);

    try {
      const response = await fetch(
        `/api/openrouter/conversations/${conversationId}/ai-turn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildOptionsBody(settings)),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Server error ${response.status}: ${response.statusText}`,
        );
      }
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let aiError: string | null = null;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) {
              setStreamedContent((prev) => prev + data.content);
            }
            if (data.error) {
              const status = data.status ? `${data.status} ` : "";
              aiError = `${status}${data.error}`;
            }
            if (data.done) done = true;
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }

      if (aiError) {
        setStreamError(aiError);
        return false;
      }
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Error requesting AI turn:", error);
      setStreamError(msg);
      return false;
    } finally {
      setIsTyping(false);
      setStreamedContent("");
      invalidate();
    }
  }, [conversationId, settings, invalidate]);

  // Convenience: submit user message, then (optionally) request AI turn.
  const sendMessage = useCallback(
    async (content: string, options: { autoAiTurn?: boolean } = {}): Promise<void> => {
      const ok = await submitUserMessage(content);
      if (!ok) return;
      if (options.autoAiTurn) {
        await requestAiTurn();
      }
    },
    [submitUserMessage, requestAiTurn],
  );

  const clearError = useCallback(() => setStreamError(null), []);

  return {
    submitUserMessage,
    requestAiTurn,
    sendMessage,
    isTyping,
    streamedContent,
    streamError,
    clearError,
  };
}
