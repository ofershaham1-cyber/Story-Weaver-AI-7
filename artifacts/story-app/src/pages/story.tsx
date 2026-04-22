import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetOpenrouterConversation,
  useListOpenrouterMessages,
  useUpdateOpenrouterMessage,
  getListOpenrouterMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStoryStream } from "@/hooks/use-story-stream";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import { useSounds } from "@/hooks/use-sounds";
import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Send,
  Sparkles,
  PenLine,
  Pencil,
  Check,
  X,
  Volume2,
  Mic,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function Story() {
  const [, params] = useRoute("/story/:id");
  const id = Number(params?.id);

  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();

  const { data: conversation, isLoading: isLoadingConv } =
    useGetOpenrouterConversation(id, { query: { enabled: !!id } });

  const { data: messages, isLoading: isLoadingMsgs } =
    useListOpenrouterMessages(id, { query: { enabled: !!id } });

  const {
    submitUserMessage,
    requestAiTurn,
    sendMessage,
    isTyping,
    streamedContent,
    streamError,
    clearError,
  } = useStoryStream(id, settings);
  const updateMessage = useUpdateOpenrouterMessage();

  const voice = useVoice(settings.blindMode);
  const { playSound } = useSounds();

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Composer (normal mode)
  const [draft, setDraft] = useState("");

  // Blind mode status text shown to the user
  const [blindStatus, setBlindStatus] = useState("");
  // Amber background when user hasn't responded (nudge state)
  const [isNoResponse, setIsNoResponse] = useState(false);

  const endOfStoryRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Tracks which AI message id has been processed by the blind loop
  const lastHandledMsgIdRef = useRef<number | null>(null);
  // Prevents concurrent blind-mode loops
  const blindLoopRunningRef = useRef(false);
  // Allows the in-flight loop to detect blind-mode toggle-off
  const blindModeEnabledRef = useRef(settings.blindMode);
  // Track if we already played the error sound this error cycle
  const errorSoundPlayedRef = useRef(false);
  // When true, the loop gave up after max nudges and should not auto-restart
  const gaveUpRef = useRef(false);

  useEffect(() => {
    blindModeEnabledRef.current = settings.blindMode;
    if (!settings.blindMode) {
      voice.stopSpeaking();
      setIsNoResponse(false);
      gaveUpRef.current = false;
    }
  }, [settings.blindMode, voice]);

  // Reset gave-up flag whenever new messages arrive (fresh AI turn = fresh chance to listen)
  useEffect(() => {
    gaveUpRef.current = false;
    setIsNoResponse(false);
  }, [messages]);

  // Play error sound once when a stream error occurs
  useEffect(() => {
    if (streamError && !errorSoundPlayedRef.current) {
      errorSoundPlayedRef.current = true;
      playSound("error");
    }
    if (!streamError) {
      errorSoundPlayedRef.current = false;
    }
  }, [streamError, playSound]);

  // Auto-scroll whenever content changes
  useEffect(() => {
    endOfStoryRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedContent, isTyping]);

  // --- Blind mode auto-loop ---
  useEffect(() => {
    if (!settings.blindMode) return;
    if (isTyping) return;
    if (blindLoopRunningRef.current) return;
    if (gaveUpRef.current) return;
    if (!messages) return;

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

    if (
      lastMsg?.role === "assistant" &&
      lastHandledMsgIdRef.current === lastMsg.id
    )
      return;

    blindLoopRunningRef.current = true;

    async function runLoop() {
      try {
        // 1. Speak the last AI paragraph (if any)
        if (lastMsg?.role === "assistant") {
          lastHandledMsgIdRef.current = lastMsg.id!;
          setBlindStatus("Reading the story aloud…");
          await voice.speak(lastMsg.content);
        }

        if (!blindModeEnabledRef.current) return;

        // 2. Listen — nudge after 10.5 s of silence, give up after 2 nudges
        setBlindStatus("Listening… speak your paragraph.");
        const transcript = await voice.listenOnce({
          silenceMs: 4000,
          nudgeMs: 10500,
          maxNudges: 2,
          onNudge: (n) => {
            playSound("nudge");
            setIsNoResponse(true);
            setBlindStatus(
              n < 2
                ? "Still listening… speak whenever you're ready."
                : "Last chance… speak now or listening will stop."
            );
          },
        });

        // Clear the nudge background once listening ends
        setIsNoResponse(false);

        if (!blindModeEnabledRef.current) return;

        if (!transcript.trim()) {
          // Max nudges reached with no response — give up this turn
          gaveUpRef.current = true;
          setBlindStatus("No response detected. Tap the mic to try again.");
          return;
        }

        // 3. Play back what was heard (if option enabled)
        if (settings.playUserTranscription) {
          setBlindStatus("Playing back your paragraph…");
          await voice.speak(transcript.trim());
          if (!blindModeEnabledRef.current) return;
        }

        // 4. Play STT complete sound and submit
        playSound("stt-complete");
        setDraft(transcript.trim());
        setBlindStatus("Sending your paragraph…");
        await sendMessage(transcript.trim(), { autoAiTurn: true });
        setDraft("");
        setBlindStatus("");
      } finally {
        blindLoopRunningRef.current = false;
      }
    }

    runLoop();
  }, [messages, isTyping, settings.blindMode, settings.playUserTranscription, voice, sendMessage, playSound]);

  // Inline edit handlers
  const startEdit = (msgId: number, content: string) => {
    setEditingId(msgId);
    setEditDraft(content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft("");
  };

  const saveEdit = async (messageId: number) => {
    if (!editDraft.trim()) return;
    await updateMessage.mutateAsync({
      messageId,
      data: { content: editDraft.trim() },
    });
    queryClient.invalidateQueries({
      queryKey: getListOpenrouterMessagesQueryKey(id),
    });
    setEditingId(null);
    setEditDraft("");
  };

  // Normal mode voice send
  const handleVoiceSend = useCallback(() => {
    if (isTyping) return;
    const stop = voice.listen(
      (transcript) => {
        setDraft(transcript);
      },
      async () => {
        // STT ended — play completion sound
        playSound("stt-complete");
      }
    );
    return stop;
  }, [isTyping, voice, playSound]);

  // Submit user's typed paragraph (no AI yet); in auto mode, immediately ask AI to take its turn.
  const handleSend = useCallback(async () => {
    if (!draft.trim() || isTyping) return;
    const content = draft.trim();
    setDraft("");
    await sendMessage(content, { autoAiTurn: settings.gameMode === "auto" });
  }, [draft, isTyping, sendMessage, settings.gameMode]);

  // Manual mode: explicitly request the AI to take its turn.
  const handleRequestAi = useCallback(async () => {
    if (isTyping) return;
    await requestAiTurn();
  }, [isTyping, requestAiTurn]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
  const aiTurnAvailable =
    !isTyping &&
    !!lastMessage &&
    lastMessage.role === "user" &&
    lastMessage.content.trim() !== "";

  if (isLoadingConv || isLoadingMsgs) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6 h-screen flex flex-col">
        <div className="h-8 bg-muted animate-pulse rounded w-1/3 mb-12"></div>
        <div className="space-y-6 flex-1">
          <div className="h-24 bg-muted animate-pulse rounded w-full"></div>
          <div className="h-32 bg-muted animate-pulse rounded w-5/6"></div>
          <div className="h-20 bg-muted animate-pulse rounded w-full"></div>
        </div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="max-w-3xl mx-auto py-20 px-6 text-center">
        <h2 className="text-2xl font-serif mb-4">Story not found</h2>
        <Link href="/">
          <Button variant="outline" className="font-sans">
            Return to Library
          </Button>
        </Link>
      </div>
    );
  }

  const isSpeaking = voice.state === "speaking";
  const isListening = voice.state === "listening";

  return (
    <div
      className={cn(
        "max-w-3xl mx-auto min-h-screen flex flex-col transition-colors duration-700",
        isNoResponse
          ? "bg-amber-950/10 dark:bg-amber-900/20"
          : isListening
          ? "bg-blue-950/10 dark:bg-blue-900/20"
          : "bg-background"
      )}
    >
      {/* Header */}
      <header
        className={cn(
          "py-6 px-6 md:px-8 border-b border-border/40 sticky top-0 backdrop-blur-sm z-10 flex items-center justify-between transition-colors duration-700",
          isNoResponse
            ? "bg-amber-950/10 dark:bg-amber-900/20"
            : isListening
            ? "bg-blue-950/10 dark:bg-blue-900/20"
            : "bg-background/95"
        )}
      >
        <div className="flex items-center gap-4 overflow-hidden">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-2xl font-serif font-medium text-foreground truncate">
            {conversation.title}
          </h1>
        </div>
        <div className="flex items-center gap-1">
          {isListening && !isNoResponse && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/15 border border-blue-400/30">
              <Mic className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
              <span className="text-xs text-blue-400 font-sans font-medium">Listening</span>
            </div>
          )}
          {isNoResponse && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/15 border border-amber-400/30">
              <Mic className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
              <span className="text-xs text-amber-400 font-sans font-medium">Waiting…</span>
            </div>
          )}
          {settings.blindMode && isSpeaking && (
            <Button
              variant="ghost"
              size="icon"
              className="text-primary animate-pulse"
              onClick={() => voice.stopSpeaking()}
              aria-label="Stop reading"
            >
              <Volume2 className="w-5 h-5" />
            </Button>
          )}
          <SettingsDialog settings={settings} onSave={updateSettings} />
        </div>
      </header>

      {/* Error banner */}
      {streamError && (
        <div className="mx-6 mt-4 flex items-start gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive font-sans text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{streamError}</span>
          <button
            onClick={clearError}
            className="shrink-0 hover:opacity-70 transition-opacity"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Story Content */}
      <div
        className="flex-1 overflow-y-auto px-6 md:px-12 py-8 font-serif text-lg leading-loose space-y-8"
        ref={scrollContainerRef}
      >
        {messages?.length === 0 && (
          <div className="text-center py-20 text-muted-foreground italic">
            {settings.blindMode
              ? "Blind mode is on. Speak your opening paragraph."
              : "The first page is blank. Write the opening paragraph below…"}
          </div>
        )}

        {messages
          ?.filter((msg) => msg.content.trim() !== "")
          .map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "group relative animate-in fade-in slide-in-from-bottom-2 duration-500",
                msg.role === "assistant"
                  ? "text-foreground"
                  : "text-primary/90"
              )}
            >
              <div
                className={cn(
                  "absolute -left-8 top-1.5 opacity-0 group-hover:opacity-40 transition-opacity",
                  msg.role === "assistant"
                    ? "text-secondary-foreground"
                    : "text-primary"
                )}
              >
                {msg.role === "assistant" ? (
                  <Sparkles className="w-4 h-4" />
                ) : (
                  <PenLine className="w-4 h-4" />
                )}
              </div>

              {editingId === msg.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    autoFocus
                    className="min-h-[100px] resize-none font-serif text-lg leading-relaxed bg-background/80 border-primary/40 focus-visible:ring-primary/50"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") cancelEdit();
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                        saveEdit(msg.id);
                    }}
                  />
                  <div className="flex gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={cancelEdit}
                      className="h-8 text-muted-foreground hover:text-foreground font-sans text-xs"
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveEdit(msg.id)}
                      disabled={!editDraft.trim() || updateMessage.isPending}
                      className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 font-sans text-xs"
                    >
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  <button
                    onClick={() => startEdit(msg.id, msg.content)}
                    aria-label="Edit passage"
                    className="absolute -right-8 top-0.5 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-primary p-1 rounded"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}

        {/* Streaming AI response */}
        {isTyping && (
          <div className="relative text-foreground animate-in fade-in duration-300">
            <div className="absolute -left-8 top-1.5 opacity-40 text-secondary-foreground">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="whitespace-pre-wrap">
              {streamedContent}
              <span className="inline-block w-1.5 h-5 ml-1 align-middle bg-primary/50 animate-pulse"></span>
            </div>
          </div>
        )}

        <div ref={endOfStoryRef} className="h-4" />
      </div>

      {/* Bottom bar */}
      <div className="p-4 md:p-6 border-t border-border/40 bg-card rounded-t-2xl shadow-[0_-4px_20px_rgba(0,0,0,0.02)]">
        {settings.blindMode ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-3 py-2">
              {isSpeaking && (
                <Volume2 className="w-5 h-5 text-primary animate-pulse shrink-0" />
              )}
              {isListening && !isNoResponse && (
                <Mic className="w-5 h-5 text-blue-400 animate-pulse shrink-0" />
              )}
              {isNoResponse && (
                <Mic className="w-5 h-5 text-amber-400 animate-pulse shrink-0" />
              )}
              <p className="text-center text-sm font-sans text-muted-foreground italic">
                {isTyping
                  ? "Your co-author is writing…"
                  : isSpeaking
                  ? "Reading the story aloud…"
                  : isListening
                  ? "Listening… speak your paragraph."
                  : blindStatus || "Ready."}
              </p>
            </div>

            {draft && (
              <div className="px-4 py-3 rounded-lg bg-background/70 border border-border/40 font-serif text-base leading-relaxed text-primary/80">
                {draft}
              </div>
            )}
          </div>
        ) : (
          <div className="relative">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isTyping
                  ? "Your co-author is writing…"
                  : "Write your next paragraph… (Cmd+Enter to send)"
              }
              disabled={isTyping}
              className="min-h-[120px] resize-none pr-24 font-serif text-lg leading-relaxed bg-background/50 border-border/50 focus-visible:ring-primary/50 placeholder:italic placeholder:font-serif"
            />
            <div className="absolute bottom-4 right-4 flex gap-2">
              <Button
                size="icon"
                variant="outline"
                onClick={handleVoiceSend}
                disabled={isTyping || isListening}
                className={cn(
                  "h-10 w-10 rounded-full transition-all",
                  isListening
                    ? "bg-blue-500/20 border-blue-400/50 text-blue-400 animate-pulse"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-label="Dictate"
              >
                <Mic className="w-4 h-4" />
              </Button>
              <Button
                size="icon"
                onClick={handleSend}
                disabled={!draft.trim() || isTyping}
                className="h-10 w-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all"
                aria-label="Send your paragraph"
              >
                <Send className="w-4 h-4 ml-0.5" />
              </Button>
              {settings.gameMode === "manual" && (
                <Button
                  size="icon"
                  variant="secondary"
                  onClick={handleRequestAi}
                  disabled={!aiTurnAvailable}
                  className="h-10 w-10 rounded-full shadow-sm transition-all"
                  aria-label="Request AI turn"
                  title="Request AI turn"
                >
                  <Sparkles className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
