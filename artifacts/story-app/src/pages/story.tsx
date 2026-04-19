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

  const { sendMessage, isTyping, streamedContent } = useStoryStream(
    id,
    settings
  );
  const updateMessage = useUpdateOpenrouterMessage();

  const voice = useVoice(settings.blindMode);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Composer (normal mode)
  const [draft, setDraft] = useState("");

  // Blind mode status text shown to the user
  const [blindStatus, setBlindStatus] = useState("");

  const endOfStoryRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Tracks which AI message id has been processed by the blind loop
  const lastHandledMsgIdRef = useRef<number | null>(null);
  // Prevents concurrent blind-mode loops
  const blindLoopRunningRef = useRef(false);
  // Allows the in-flight loop to detect blind-mode toggle-off
  const blindModeEnabledRef = useRef(settings.blindMode);

  useEffect(() => {
    blindModeEnabledRef.current = settings.blindMode;
    if (!settings.blindMode) {
      voice.stopSpeaking();
      // STT will time out / resolve on its own
    }
  }, [settings.blindMode, voice]);

  // Auto-scroll whenever content changes
  useEffect(() => {
    endOfStoryRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedContent, isTyping]);

  // --- Blind mode auto-loop ---
  useEffect(() => {
    if (!settings.blindMode) return;
    if (isTyping) return; // AI is still writing — wait
    if (blindLoopRunningRef.current) return; // loop already in flight
    if (!messages) return; // data not yet loaded

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

    // Already handled this AI turn
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

        // 2. Keep listening until the user says something
        let transcript = "";
        while (!transcript.trim()) {
          if (!blindModeEnabledRef.current) return;
          setBlindStatus("Listening… speak your paragraph.");
          transcript = await voice.listenOnce();

          if (!blindModeEnabledRef.current) return;

          if (!transcript.trim()) {
            // Nothing heard — briefly announce and retry
            setBlindStatus("Didn't catch that. Listening again…");
            await voice.speak("I didn't catch that. Please speak your paragraph.");
            if (!blindModeEnabledRef.current) return;
          }
        }

        // 3. Show what was heard and auto-submit
        setDraft(transcript.trim());
        setBlindStatus("Sending your paragraph…");
        await sendMessage(transcript.trim());
        setDraft("");
        setBlindStatus("");
      } finally {
        blindLoopRunningRef.current = false;
      }
    }

    runLoop();
  }, [messages, isTyping, settings.blindMode, voice, sendMessage]);

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

  // Normal mode send
  const handleSend = useCallback(async () => {
    if (!draft.trim() || isTyping) return;
    const content = draft.trim();
    setDraft("");
    await sendMessage(content);
  }, [draft, isTyping, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

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
    <div className="max-w-3xl mx-auto min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="py-6 px-6 md:px-8 border-b border-border/40 sticky top-0 bg-background/95 backdrop-blur-sm z-10 flex items-center justify-between">
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
          /* --- Blind mode: fully automatic, no touch needed --- */
          <div className="space-y-3">
            {/* Live voice indicator */}
            <div className="flex items-center justify-center gap-3 py-2">
              {isSpeaking && (
                <Volume2 className="w-5 h-5 text-primary animate-pulse shrink-0" />
              )}
              {isListening && (
                <Mic className="w-5 h-5 text-destructive animate-pulse shrink-0" />
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

            {/* Transcript preview (so a sighted helper can see what was heard) */}
            {draft && (
              <div className="px-4 py-3 rounded-lg bg-background/70 border border-border/40 font-serif text-base leading-relaxed text-primary/80">
                {draft}
              </div>
            )}
          </div>
        ) : (
          /* --- Normal text composer --- */
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
              className="min-h-[120px] resize-none pr-16 font-serif text-lg leading-relaxed bg-background/50 border-border/50 focus-visible:ring-primary/50 placeholder:italic placeholder:font-serif"
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!draft.trim() || isTyping}
              className="absolute bottom-4 right-4 h-10 w-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all"
            >
              <Send className="w-4 h-4 ml-0.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
