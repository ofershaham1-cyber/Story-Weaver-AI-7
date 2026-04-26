import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetOpenrouterConversation,
  useListOpenrouterMessages,
  useUpdateOpenrouterMessage,
  useDeleteOpenrouterMessage,
  useRegenerateOpenrouterMessage,
  getGetOpenrouterConversationQueryKey,
  getListOpenrouterMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStoryStream } from "@/hooks/use-story-stream";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import { useSounds } from "@/hooks/use-sounds";
import { OpenrouterSettingsDialog } from "@/components/openrouter-settings-dialog";
import { SttSettingsDialog } from "@/components/stt-settings-dialog";
import { TtsSpeedDialog } from "@/components/tts-speed-dialog";
import { SttLanguageSwitcher } from "@/components/stt-language-switcher";
import { ViewLanguagesSwitcher } from "@/components/view-languages-switcher";
import { TtsPlayOrderDialog } from "@/components/tts-play-order-dialog";
import { TranslatedLine } from "@/components/translated-line";
import { translate, toGoogleLang } from "@/lib/translate";
import {
  PLAY_ORIGINAL,
  syncPlayOrderForView,
  type StorySettings,
} from "@/hooks/use-settings";
import { ThemeToggle } from "@/components/theme-toggle";
import { DebugPanel } from "@/components/debug-panel";
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
  VolumeX,
  Mic,
  MicOff,
  Ear,
  EarOff,
  AlertCircle,
  Trash2,
  RefreshCw,
  Play,
  StopCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Turn an unknown error from a mutation/fetch into a single-line user-
 * facing message. Tries to dig out the most useful field (`message`,
 * server-side `error`, status text) without dumping the whole stack trace
 * into the banner.
 */
function formatActionError(prefix: string, err: unknown): string {
  if (!err) return prefix;
  const anyErr = err as {
    message?: string;
    response?: { data?: { error?: string; message?: string }; statusText?: string; status?: number };
    status?: number;
    statusText?: string;
  };
  const detail =
    anyErr.response?.data?.error ||
    anyErr.response?.data?.message ||
    anyErr.message ||
    anyErr.response?.statusText ||
    anyErr.statusText;
  const code = anyErr.response?.status ?? anyErr.status;
  if (detail && code) return `${prefix}: ${detail} (HTTP ${code})`;
  if (detail) return `${prefix}: ${detail}`;
  if (code) return `${prefix}: HTTP ${code}`;
  try {
    return `${prefix}: ${JSON.stringify(err)}`;
  } catch {
    return `${prefix}: ${String(err)}`;
  }
}

/**
 * Render a message body word-by-word so that during TTS playback we can
 * highlight whichever word the engine is currently announcing.
 *
 * The split (`/(\s+)/`) preserves whitespace runs as separate tokens, and
 * `whitespace-pre-wrap` on the wrapper keeps the original visual spacing
 * (newlines, multiple spaces) intact — so when no word is highlighted the
 * output is visually identical to the previous plain `{msg.content}`
 * rendering.
 *
 * `highlightWord` is the index of the word (0-based, ignoring whitespace
 * runs) that should be highlighted, or `null` for no highlight.
 */
function MessageBody({
  text,
  highlightWord,
}: {
  text: string;
  highlightWord: number | null;
}) {
  const tokens = useMemo(() => text.split(/(\s+)/), [text]);
  let wordIdx = -1;
  return (
    <div className="whitespace-pre-wrap">
      {tokens.map((tok, i) => {
        if (tok.length === 0) return null;
        if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
        wordIdx++;
        const isActive = wordIdx === highlightWord;
        return (
          <span
            key={i}
            className={cn(
              "transition-colors duration-100",
              isActive &&
                "bg-amber-300/50 dark:bg-amber-400/40 text-foreground rounded px-0.5",
            )}
          >
            {tok}
          </span>
        );
      })}
    </div>
  );
}

export default function Story() {
  const [, params] = useRoute("/story/:id");
  const id = Number(params?.id);

  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();

  const { data: conversation, isLoading: isLoadingConv } =
    useGetOpenrouterConversation(id, {
      query: {
        enabled: !!id,
        queryKey: getGetOpenrouterConversationQueryKey(id),
      },
    });

  const { data: messages, isLoading: isLoadingMsgs } =
    useListOpenrouterMessages(id, {
      query: {
        enabled: !!id,
        queryKey: getListOpenrouterMessagesQueryKey(id),
      },
    });

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
  const deleteMessage = useDeleteOpenrouterMessage();
  const regenerateMessage = useRegenerateOpenrouterMessage();
  // Track which message is currently being regenerated (so only that row shows
  // the spinner, not all of them).
  const [regeneratingMsgId, setRegeneratingMsgId] = useState<number | null>(
    null,
  );

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
  // Tracks which (lastMsg, refreshTick) pair the blind loop has started for
  const lastCycleKeyRef = useRef<string | null>(null);
  // Prevents concurrent blind-mode loops
  const blindLoopRunningRef = useRef(false);
  // Allows the in-flight loop to detect blind-mode toggle-off
  const blindModeEnabledRef = useRef(settings.blindMode);
  // Track if we already played the error sound this error cycle
  const errorSoundPlayedRef = useRef(false);
  // When true, the loop gave up after max nudges and should not auto-restart
  const gaveUpRef = useRef(false);

  // --- "Play story" full-conversation TTS playback ---
  // Tracks whether the user has pressed the header Play button. We use a ref
  // alongside the state so the async per-message loop can detect a Stop press
  // mid-flight without waiting for React to re-render.
  const [isPlayingStory, setIsPlayingStory] = useState(false);
  const isPlayingStoryRef = useRef(false);

  /**
   * Resolve which BCP-47 language a saved message should be read in. Prefers
   * the language stored on the row (set when the message was first created),
   * but falls back to the user's active STT/AI language for legacy rows that
   * pre-date the schema migration so older stories still play back sensibly.
   */
  const resolveMessageLanguage = useCallback(
    (msg: { role: string; language?: string | null }): string => {
      if (msg.language) return msg.language;
      return msg.role === "assistant"
        ? settings.stt.aiLanguage
        : settings.stt.language;
    },
    [settings.stt.aiLanguage, settings.stt.language],
  );

  /** Look up the configured playback rate for a given language. */
  const rateForLanguage = useCallback(
    (lang: string): number =>
      settings.ttsRates[lang] ?? settings.ttsRateDefault,
    [settings.ttsRates, settings.ttsRateDefault],
  );

  /**
   * Build the ordered list of (text, lang, rate) units that should be
   * spoken for a single message, in the exact order configured by the
   * user via the TTS Play Order dialog (`settings.ttsPlayOrder`).
   *
   * Each entry in `ttsPlayOrder` is either `PLAY_ORIGINAL` (= speak the
   * source paragraph) or a BCP-47 code (= fetch & speak the translation
   * to that language). Entries the user removed are skipped; entries
   * referencing a language that's no longer in `viewLanguages` are also
   * skipped (defensive — the sync helper normally prevents this).
   *
   * Translations are fetched through `queryClient.fetchQuery` using the
   * same key as `<TranslatedLine>` so on-screen translations and
   * playback share the same cache — no duplicate network requests.
   *
   * `isOriginal` is set for the original-language unit so the play
   * handlers can keep highlighting word-by-word in the rendered original
   * paragraph (which matches the visible text). Translation units don't
   * highlight because the visible word-mapping wouldn't line up.
   */
  const buildPlayUnits = useCallback(
    async (msg: {
      id: number;
      content: string;
      role: string;
      language?: string | null;
    }): Promise<
      Array<{ text: string; lang: string; rate: number; isOriginal: boolean }>
    > => {
      const text = msg.content?.trim() ?? "";
      if (!text) return [];

      const units: Array<{
        text: string;
        lang: string;
        rate: number;
        isOriginal: boolean;
      }> = [];

      const origLang = resolveMessageLanguage(msg);
      const viewSet = new Set(settings.viewLanguages);

      for (const item of settings.ttsPlayOrder) {
        if (item === PLAY_ORIGINAL) {
          units.push({
            text,
            lang: origLang,
            rate: rateForLanguage(origLang),
            isOriginal: true,
          });
          continue;
        }
        // Defensive: the sync helper normally prunes stale entries, but
        // bail if a code isn't currently a view language so we don't
        // surprise-translate to something the user removed.
        if (!viewSet.has(item)) continue;
        const googleTarget = toGoogleLang(item);
        try {
          const translated = await queryClient.fetchQuery({
            queryKey: ["translation", googleTarget, text],
            queryFn: () =>
              translate({
                finalTranscriptProxy: text,
                fromLang: "auto",
                toLang: googleTarget,
              }),
            staleTime: Infinity,
            gcTime: Infinity,
          });
          if (translated && translated !== "translation error") {
            units.push({
              text: translated,
              lang: item,
              rate: rateForLanguage(item),
              isOriginal: false,
            });
          } else {
            console.warn(
              `[story] translation empty/error msg=${msg.id} target=${item} → skipped`,
            );
          }
        } catch (err) {
          console.warn(
            `[story] translation fetch failed msg=${msg.id} target=${item}`,
            err,
          );
        }
      }

      return units;
    },
    [
      queryClient,
      resolveMessageLanguage,
      rateForLanguage,
      settings.ttsPlayOrder,
      settings.viewLanguages,
    ],
  );

  /**
   * Which message is currently being read aloud (header Play loop OR a
   * per-message Play button) and which word index inside it the engine
   * just announced via the `boundary` event. Used by `<MessageBody>` to
   * paint a highlight under the spoken word.
   */
  const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
  const [currentWordIdx, setCurrentWordIdx] = useState<number | null>(null);
  // Which item *within* the currently playing message is being spoken
  // right now: either {@link PLAY_ORIGINAL} for the source paragraph or
  // a BCP-47 code for one of its translations. Used to draw a border
  // around the exact line that's audible so the user can follow along
  // when there are several translations stacked under each paragraph.
  const [playingItem, setPlayingItem] = useState<string | null>(null);
  // Ref-mirror of `playingMsgId` so the blind-mode loop (which reads via
  // refs to avoid re-firing on every render) can synchronously check
  // whether a manual per-message playback is currently in progress and
  // bail out — preventing the blind loop from auto-speaking a new
  // assistant message in the middle of a Play-All / Play-One run and
  // interrupting an in-flight translation utterance.
  const playingMsgIdRef = useRef<number | null>(null);
  useEffect(() => {
    playingMsgIdRef.current = playingMsgId;
  }, [playingMsgId]);
  // Local error surface: errors from imperative actions (regenerate,
  // delete, edit) that don't go through `useStoryStream` would otherwise
  // only emit a console.error + a beep; surface them in the same banner
  // as `streamError` so the user can actually see what failed.
  const [actionError, setActionError] = useState<string | null>(null);
  const displayedError = streamError ?? actionError;

  const stopPlayingStory = useCallback(() => {
    isPlayingStoryRef.current = false;
    setIsPlayingStory(false);
    setPlayingMsgId(null);
    setPlayingItem(null);
    setCurrentWordIdx(null);
    voice.stopSpeaking();
  }, [voice]);

  const handlePlayStory = useCallback(async () => {
    console.info(
      `[story] handlePlayStory click playing=${isPlayingStoryRef.current} msgs=${messages?.length ?? 0}`,
    );
    if (isPlayingStoryRef.current) {
      // Second click acts as a Stop button.
      stopPlayingStory();
      return;
    }
    if (!messages || messages.length === 0) return;

    isPlayingStoryRef.current = true;
    setIsPlayingStory(true);
    try {
      for (const msg of messages) {
        if (!isPlayingStoryRef.current) break;
        const units = await buildPlayUnits(msg);
        if (units.length === 0) continue;
        if (!isPlayingStoryRef.current) break;
        setPlayingMsgId(msg.id);
        setCurrentWordIdx(null);
        for (const unit of units) {
          if (!isPlayingStoryRef.current) break;
          console.info(
            `[story] play-all → msg=${msg.id} ${unit.isOriginal ? "original" : "translation"} lang=${unit.lang} rate=${unit.rate} chars=${unit.text.length}`,
          );
          setCurrentWordIdx(null);
          // Tag which line is "live" so its row gets the playing border.
          setPlayingItem(unit.isOriginal ? PLAY_ORIGINAL : unit.lang);
          await voice.speak(unit.text, unit.lang, unit.rate, {
            onWord: unit.isOriginal
              ? ({ wordIndex }) => setCurrentWordIdx(wordIndex)
              : undefined,
          });
        }
      }
    } finally {
      isPlayingStoryRef.current = false;
      setIsPlayingStory(false);
      setPlayingMsgId(null);
      setPlayingItem(null);
      setCurrentWordIdx(null);
    }
  }, [messages, voice, buildPlayUnits, stopPlayingStory]);

  /**
   * Read a single message aloud (per-message Play button). If the same
   * message is already playing, acts as a Stop button. Cancels any other
   * ongoing playback (header loop or another message) so only one voice
   * is ever audible.
   */
  const handlePlayMessage = useCallback(
    async (
      msg: { id: number; content: string; role: string; language?: string | null },
      /**
       * Optional starting item — either {@link PLAY_ORIGINAL} or a
       * BCP-47 code from the message's play queue. When provided, the
       * built unit list is sliced so playback begins at that item and
       * continues through the rest of `ttsPlayOrder`. Used by the
       * click-to-play handlers on the original and translated lines.
       */
      startItem?: string,
    ) => {
      console.info(
        `[story] handlePlayMessage click msg=${msg.id} startItem=${startItem ?? "(default)"} alreadyPlaying=${playingMsgId === msg.id && playingItem === (startItem ?? null)}`,
      );
      // Tapping the *same* line that's currently being spoken stops
      // playback (acts as a toggle). When startItem is omitted we fall
      // back to the prior "same message → stop" behaviour.
      if (
        playingMsgId === msg.id &&
        (startItem === undefined || playingItem === startItem)
      ) {
        stopPlayingStory();
        return;
      }
      // Cancel any ongoing playback (header loop or other message). We do
      // NOT call `voice.stopSpeaking()` here because `voice.speak()` itself
      // safely tears down any prior utterance — calling cancel twice in
      // the same tick triggers a Chrome bug where the new utterance fires
      // its onend immediately with no audio.
      isPlayingStoryRef.current = false;
      setIsPlayingStory(false);

      let units = await buildPlayUnits(msg);
      if (units.length === 0) return;
      // Honour the click-to-play starting point: drop everything before
      // the requested item so playback begins at the line the user
      // actually clicked. If the item isn't in the queue (e.g. the user
      // clicked an old translation that was since removed from
      // ttsPlayOrder) fall back to playing the whole queue.
      if (startItem !== undefined) {
        const startIdx = units.findIndex((u) =>
          startItem === PLAY_ORIGINAL ? u.isOriginal : u.lang === startItem,
        );
        if (startIdx > 0) units = units.slice(startIdx);
        else if (startIdx === -1) {
          // Requested item isn't enabled in ttsPlayOrder. Synthesise a
          // single ad-hoc unit so a click on a visible translation still
          // plays even if the user never added it to the order.
          if (startItem === PLAY_ORIGINAL) {
            const lang = resolveMessageLanguage(msg);
            units = [
              {
                text: msg.content.trim(),
                lang,
                rate: rateForLanguage(lang),
                isOriginal: true,
              },
            ];
          } else {
            try {
              const googleTarget = toGoogleLang(startItem);
              const translated = await queryClient.fetchQuery({
                queryKey: ["translation", googleTarget, msg.content.trim()],
                queryFn: () =>
                  translate({
                    finalTranscriptProxy: msg.content.trim(),
                    fromLang: "auto",
                    toLang: googleTarget,
                  }),
                staleTime: Infinity,
                gcTime: Infinity,
              });
              if (translated && translated !== "translation error") {
                units = [
                  {
                    text: translated,
                    lang: startItem,
                    rate: rateForLanguage(startItem),
                    isOriginal: false,
                  },
                ];
              } else {
                units = [];
              }
            } catch {
              units = [];
            }
          }
        }
      }
      if (units.length === 0) return;
      setPlayingMsgId(msg.id);
      setCurrentWordIdx(null);
      try {
        for (const unit of units) {
          console.info(
            `[story] play-one → msg=${msg.id} ${unit.isOriginal ? "original" : "translation"} lang=${unit.lang} rate=${unit.rate} chars=${unit.text.length}`,
          );
          setCurrentWordIdx(null);
          setPlayingItem(unit.isOriginal ? PLAY_ORIGINAL : unit.lang);
          await voice.speak(unit.text, unit.lang, unit.rate, {
            onWord: unit.isOriginal
              ? ({ wordIndex }) => setCurrentWordIdx(wordIndex)
              : undefined,
          });
        }
      } finally {
        setPlayingMsgId((cur) => (cur === msg.id ? null : cur));
        setPlayingItem(null);
        setCurrentWordIdx(null);
      }
    },
    [
      playingMsgId,
      playingItem,
      voice,
      buildPlayUnits,
      stopPlayingStory,
      queryClient,
      resolveMessageLanguage,
      rateForLanguage,
    ],
  );

  /*
   * Stop any in-flight TTS when the page unmounts. We MUST NOT depend on
   * `voice` here: `useVoice()` returns a fresh object on every render
   * (its internal `state` is part of the returned object), so depending
   * on `voice` would re-run the cleanup on every render and call
   * `cancel()` immediately after `speak()` — which produces an
   * `interrupted` SpeechSynthesisErrorEvent and silent playback.
   *
   * Instead, capture the latest `voice.stopSpeaking` in a ref and run
   * the cleanup only on unmount.
   */
  const stopSpeakingRef = useRef(voice.stopSpeaking);
  stopSpeakingRef.current = voice.stopSpeaking;
  useEffect(() => {
    return () => {
      if (isPlayingStoryRef.current) {
        isPlayingStoryRef.current = false;
        stopSpeakingRef.current();
      }
    };
  }, []);

  useEffect(() => {
    blindModeEnabledRef.current = settings.blindMode;
    if (!settings.blindMode) {
      voice.stopSpeaking();
      voice.stopListening();
      setIsNoResponse(false);
      gaveUpRef.current = false;
    } else {
      // Re-entering blind mode → forget previous cycle so loop fires
      lastCycleKeyRef.current = null;
      gaveUpRef.current = false;
    }
    // IMPORTANT: do NOT depend on `voice` here. `useVoice()` returns a fresh
    // object literal on every render, so depending on `voice` re-runs this
    // effect after every render — including the one triggered by clicking
    // Play (setIsPlayingStory/setPlayingMsgId). That would call
    // `voice.stopSpeaking()` immediately after `voice.speak()` queued an
    // utterance, producing `onerror=interrupted` and silent playback.
    // The individual methods are useCallback-stable, so we depend on them
    // directly instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.blindMode, voice.stopSpeaking, voice.stopListening]);

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

  // Settings ref so the running blind loop always reads the latest values
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Timer for "interval" continue mode auto-restart
  const intervalRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const clearIntervalRetry = useCallback(() => {
    if (intervalRetryTimerRef.current) {
      clearTimeout(intervalRetryTimerRef.current);
      intervalRetryTimerRef.current = null;
    }
  }, []);

  // Bumping this triggers the blind-mode effect to (re)start a listening cycle
  const [refreshTick, setRefreshTick] = useState(0);

  // --- Blind mode auto-loop ---
  useEffect(() => {
    if (!settings.blindMode) return;
    if (isTyping) return;
    if (blindLoopRunningRef.current) return;
    if (gaveUpRef.current) return;
    if (!messages) return;
    // If the user is currently driving a manual playback (Play All header
    // button OR a per-message Play), bail out *without* recording the
    // cycle key so the loop will re-trigger once playback ends. This is
    // critical: otherwise the blind loop's `voice.speak()` call for the
    // newest assistant message races against `handlePlayStory` /
    // `handlePlayMessage` and interrupts in-flight translation
    // utterances mid-word (you'd hear ~0.8s of French then silence).
    if (isPlayingStoryRef.current || playingMsgIdRef.current != null) return;

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastMsgKey = lastMsg ? `${lastMsg.id}` : "empty";
    const cycleKey = `${lastMsgKey}:${refreshTick}`;

    // Skip if we've already started the cycle for this (lastMsg, refreshTick) pair
    if (lastCycleKeyRef.current === cycleKey) return;
    lastCycleKeyRef.current = cycleKey;

    // We re-speak the AI paragraph only the first time we see a new AI msg.
    const shouldSpeak =
      lastMsg?.role === "assistant" &&
      lastHandledMsgIdRef.current !== lastMsg.id;

    blindLoopRunningRef.current = true;

    async function runLoop() {
      try {
        const cur = settingsRef.current;

        // 1. Speak the last AI paragraph (only when it's actually new)
        if (lastMsg?.role === "assistant" && shouldSpeak) {
          lastHandledMsgIdRef.current = lastMsg.id!;
          setBlindStatus("Reading the story aloud…");
          // Prefer the language saved with the message; fall back to the
          // current AI-language setting for legacy rows.
          const lang = lastMsg.language ?? cur.stt.aiLanguage;
          await voice.speak(
            lastMsg.content,
            lang,
            cur.ttsRates[lang] ?? cur.ttsRateDefault,
          );
        }

        if (!blindModeEnabledRef.current) return;

        // 2. Listen — config-driven nudge / silence / language
        setBlindStatus("Listening… speak your paragraph.");
        const transcript = await voice.listenOnce({
          silenceMs: cur.stt.silenceMs,
          nudgeMs: cur.stt.nudgeMs,
          maxNudges: cur.stt.maxNudges,
          maxSpeechMs: cur.stt.maxSpeechMs,
          language: cur.stt.language,
          onNudge: (n) => {
            playSound("nudge");
            setIsNoResponse(true);
            setBlindStatus(
              n < cur.stt.maxNudges
                ? "Still listening… speak whenever you're ready."
                : "Last chance… speak now or listening will stop.",
            );
          },
        });

        // Clear the nudge background once listening ends
        setIsNoResponse(false);

        if (!blindModeEnabledRef.current) return;

        if (!transcript.trim()) {
          // No response — react based on continue mode
          const mode = settingsRef.current.stt.continueMode;
          if (mode === "continuous") {
            setBlindStatus("No response — listening again…");
            // Loop will re-run because we bump the tick after release
            queueMicrotask(() => setRefreshTick((t) => t + 1));
          } else if (mode === "interval") {
            const secs = settingsRef.current.stt.intervalSeconds;
            gaveUpRef.current = true;
            setBlindStatus(
              `No response. Listening again in ${secs}s — tap refresh to retry now.`,
            );
            clearIntervalRetry();
            intervalRetryTimerRef.current = setTimeout(() => {
              if (!blindModeEnabledRef.current) return;
              gaveUpRef.current = false;
              setRefreshTick((t) => t + 1);
            }, secs * 1000);
          } else {
            gaveUpRef.current = true;
            setBlindStatus(
              "No response detected. Tap refresh to listen again.",
            );
          }
          return;
        }

        // 3. Play back what was heard (if option enabled) — use the user's
        //    speech language so the transcript is read in the same voice.
        if (cur.playUserTranscription) {
          setBlindStatus("Playing back your paragraph…");
          await voice.speak(
            transcript.trim(),
            cur.stt.language,
            cur.ttsRates[cur.stt.language] ?? cur.ttsRateDefault,
          );
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
    // See note above: depending on `voice` re-runs this effect on every
    // render and causes a fresh blind-loop iteration to start mid-flight.
    // The individual methods are useCallback-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messages,
    isTyping,
    settings.blindMode,
    voice.speak,
    voice.listenOnce,
    sendMessage,
    playSound,
    refreshTick,
    clearIntervalRetry,
    // Re-run when manual playback ends (playingMsgId → null,
    // isPlayingStory → false) so the blind loop resumes its
    // read-listen cycle for any newly-arrived assistant message.
    playingMsgId,
    isPlayingStory,
  ]);

  // Cleanup the interval-retry timer when blind mode turns off / unmount
  useEffect(() => {
    if (!settings.blindMode) clearIntervalRetry();
    return () => clearIntervalRetry();
  }, [settings.blindMode, clearIntervalRetry]);

  // User-initiated "refresh listening" — abort current STT, reset, listen again
  const handleRefreshListening = useCallback(() => {
    clearIntervalRetry();
    voice.stopSpeaking();
    voice.stopListening();
    gaveUpRef.current = false;
    setIsNoResponse(false);
    setBlindStatus("Restarting…");
    // Force the loop to re-run even if we just listened to the same AI msg
    setRefreshTick((t) => t + 1);
  }, [voice, clearIntervalRetry]);

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
    try {
      await updateMessage.mutateAsync({
        messageId,
        data: { content: editDraft.trim() },
      });
      queryClient.invalidateQueries({
        queryKey: getListOpenrouterMessagesQueryKey(id),
      });
      setEditingId(null);
      setEditDraft("");
    } catch (err) {
      console.error("Save edit failed:", err);
      playSound("error");
      setActionError(formatActionError("Could not save edit", err));
    }
  };

  const handleDeleteMessage = async (messageId: number) => {
    if (!confirm("Delete this paragraph?")) return;
    try {
      await deleteMessage.mutateAsync({ messageId });
      queryClient.invalidateQueries({
        queryKey: getListOpenrouterMessagesQueryKey(id),
      });
    } catch (err) {
      console.error("Delete failed:", err);
      playSound("error");
      setActionError(formatActionError("Delete failed", err));
    }
  };

  // Regenerate (rewrite) a single paragraph in place using AI completion.
  // The AI sees only the paragraphs that came BEFORE this one, so the rest of
  // the story remains untouched.
  const handleRegenerateMessage = async (messageId: number) => {
    if (regeneratingMsgId !== null) return;
    setRegeneratingMsgId(messageId);
    try {
      await regenerateMessage.mutateAsync({
        messageId,
        data: {
          model: settings.model || "openrouter/free",
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
          ...(settings.apiUrl ? { apiUrl: settings.apiUrl } : {}),
          ...(settings.stt.aiLanguage
            ? { language: settings.stt.aiLanguage }
            : {}),
        },
      });
      queryClient.invalidateQueries({
        queryKey: getListOpenrouterMessagesQueryKey(id),
      });
    } catch (err) {
      console.error("Regenerate failed:", err);
      playSound("error");
      // Surface the failure so the user sees more than just a beep.
      setActionError(formatActionError("Regenerate failed", err));
    } finally {
      setRegeneratingMsgId(null);
    }
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
      },
      settingsRef.current.stt.language,
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
              data-testid="button-stop-reading"
            >
              <Volume2 className="w-5 h-5" />
            </Button>
          )}

          {/* Refresh listening — only useful in blind mode */}
          {settings.blindMode && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleRefreshListening}
              aria-label="Refresh listening"
              title="Restart speech recognition"
              data-testid="button-refresh-listening"
            >
              <RefreshCw className="w-5 h-5" />
            </Button>
          )}

          {/* Quick toggle: Blind mode */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              settings.blindMode
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() =>
              updateSettings({ blindMode: !settings.blindMode })
            }
            aria-label={settings.blindMode ? "Disable blind mode" : "Enable blind mode"}
            aria-pressed={settings.blindMode}
            title={settings.blindMode ? "Blind mode: ON" : "Blind mode: OFF"}
            data-testid="button-toggle-blind-mode"
          >
            {settings.blindMode ? (
              <Ear className="w-5 h-5" />
            ) : (
              <EarOff className="w-5 h-5" />
            )}
          </Button>

          {/* Quick toggle: Play back your words */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              settings.playUserTranscription
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() =>
              updateSettings({
                playUserTranscription: !settings.playUserTranscription,
              })
            }
            aria-label={
              settings.playUserTranscription
                ? "Disable playback of your words"
                : "Enable playback of your words"
            }
            aria-pressed={settings.playUserTranscription}
            title={
              settings.playUserTranscription
                ? "Playing back your words: ON"
                : "Playing back your words: OFF"
            }
            data-testid="button-toggle-playback"
          >
            {settings.playUserTranscription ? (
              <Volume2 className="w-5 h-5" />
            ) : (
              <VolumeX className="w-5 h-5" />
            )}
          </Button>

          {/* Quick toggle: Manual AI turn */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              settings.gameMode === "manual"
                ? "text-amber-400"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() =>
              updateSettings({
                gameMode: settings.gameMode === "manual" ? "auto" : "manual",
              })
            }
            aria-label={
              settings.gameMode === "manual"
                ? "Switch to auto AI turns"
                : "Switch to manual AI turns"
            }
            aria-pressed={settings.gameMode === "manual"}
            title={
              settings.gameMode === "manual"
                ? "Manual AI turn: ON (press spark to reply)"
                : "Manual AI turn: OFF (AI replies automatically)"
            }
            data-testid="button-toggle-game-mode"
          >
            {settings.gameMode === "manual" ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </Button>

          {/* Quick STT (speech recognition) language picker */}
          <SttLanguageSwitcher
            label="You"
            value={settings.stt.language}
            onChange={(lang) =>
              updateSettings({ stt: { ...settings.stt, language: lang } })
            }
          />

          {/* Quick AI response language picker — controls the BCP-47
              `language` field sent on every AI completion request. */}
          <SttLanguageSwitcher
            variant="ai"
            label="AI"
            value={settings.stt.aiLanguage}
            onChange={(lang) =>
              updateSettings({ stt: { ...settings.stt, aiLanguage: lang } })
            }
          />

          {/* On-screen translation languages (multi-select). Each selected
              BCP-47 code renders its own translated line below every
              paragraph. The TTS Play Order dialog (next icon) governs
              which of these are also spoken and in what order. */}
          <ViewLanguagesSwitcher
            label="View"
            value={settings.viewLanguages}
            onChange={(langs) =>
              updateSettings({
                viewLanguages: langs,
                // Keep the play queue in step with the visible languages —
                // newly picked languages auto-play, removed ones drop out.
                ttsPlayOrder: syncPlayOrderForView(
                  settings.ttsPlayOrder,
                  langs,
                ),
              })
            }
          />

          {/* TTS playback order — opens a dialog where the user can pick
              which items (original + translations) get spoken and in
              what sequence. */}
          <TtsPlayOrderDialog
            settings={settings}
            onSave={(patch: Partial<StorySettings>) => updateSettings(patch)}
          />

          {/* Play / Stop the entire story — reads each saved message in
              its own configured language, at the per-language playback
              rate set in the speed dialog. Disabled until messages load. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePlayStory}
            disabled={!messages || messages.length === 0}
            className={cn(
              isPlayingStory
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-label={isPlayingStory ? "Stop reading story" : "Play story"}
            aria-pressed={isPlayingStory}
            title={isPlayingStory ? "Stop reading" : "Play story aloud"}
            data-testid="button-play-story"
          >
            {isPlayingStory ? (
              <StopCircle className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5" />
            )}
          </Button>

          <ThemeToggle />
          <TtsSpeedDialog settings={settings} onSave={updateSettings} />
          <SttSettingsDialog settings={settings} onSave={updateSettings} />
          <OpenrouterSettingsDialog settings={settings} onSave={updateSettings} />
        </div>
      </header>

      {/* Error banner — surfaces both streaming errors (AI completion,
          message submit) AND imperative-action errors (regenerate,
          delete, edit) so users actually see what went wrong instead of
          just hearing the error sound. */}
      {displayedError && (
        <div
          className="mx-6 mt-4 flex items-start gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive font-sans text-sm"
          data-testid="error-banner"
          role="alert"
        >
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
          <span className="flex-1 whitespace-pre-wrap break-words">
            {displayedError}
          </span>
          <button
            onClick={() => {
              clearError();
              setActionError(null);
            }}
            className="shrink-0 hover:opacity-70 transition-opacity"
            aria-label="Dismiss error"
            data-testid="button-dismiss-error"
          >
            <X className="w-5 h-5" />
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
                  {/*
                    Wrap the original-text body in a clickable box so
                    tapping the paragraph starts playback from the
                    original (skipping any translations earlier in the
                    queue). When the original is the live unit it gets
                    a colored border that matches the translated-line
                    treatment, so the user can always see what's audible.
                  */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handlePlayMessage(msg, PLAY_ORIGINAL)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handlePlayMessage(msg, PLAY_ORIGINAL);
                      }
                    }}
                    aria-label="Play this passage from the original"
                    data-testid={`message-original-${msg.id}`}
                    data-playing={
                      playingMsgId === msg.id && playingItem === PLAY_ORIGINAL
                        ? "true"
                        : undefined
                    }
                    className={cn(
                      "cursor-pointer rounded-r border-l-2 pl-3 -ml-3 transition-colors hover:bg-muted/30",
                      playingMsgId === msg.id && playingItem === PLAY_ORIGINAL
                        ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                        : "border-transparent",
                    )}
                  >
                    <MessageBody
                      text={msg.content}
                      highlightWord={
                        playingMsgId === msg.id ? currentWordIdx : null
                      }
                    />
                  </div>
                  {settings.viewLanguages.map((lang) => (
                    <TranslatedLine
                      key={lang}
                      text={msg.content}
                      toLang={lang}
                      isPlaying={
                        playingMsgId === msg.id && playingItem === lang
                      }
                      onClick={() => handlePlayMessage(msg, lang)}
                    />
                  ))}
                  {/*
                    Provenance badge: show the BCP-47 language for every
                    message and, for AI-authored messages, also the model
                    that generated this paragraph. Pulled from the row's
                    own columns so historical attribution stays accurate
                    even after the active model is changed mid-story.
                  */}
                  {(msg.language || msg.model) && (
                    <div
                      className="mt-1 flex flex-wrap gap-1 text-[10px] font-sans text-muted-foreground/70 select-none"
                      data-testid={`message-meta-${msg.id}`}
                    >
                      {msg.language && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-muted/40"
                          data-testid={`message-language-${msg.id}`}
                          title="Language this passage was authored in"
                        >
                          {msg.language}
                        </span>
                      )}
                      {msg.role === "assistant" && msg.model && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-muted/40"
                          data-testid={`message-model-${msg.id}`}
                          title="AI model that generated this passage"
                        >
                          {msg.model}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="absolute -right-8 top-0.5 flex flex-col gap-1 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity">
                    <button
                      onClick={() => handlePlayMessage(msg)}
                      aria-label={
                        playingMsgId === msg.id
                          ? "Stop reading this passage"
                          : "Read this passage aloud"
                      }
                      title={
                        playingMsgId === msg.id
                          ? "Stop reading this passage"
                          : "Read this passage aloud"
                      }
                      data-testid={`button-play-message-${msg.id}`}
                      className={cn(
                        "p-1 rounded",
                        playingMsgId === msg.id
                          ? "text-primary"
                          : "text-muted-foreground hover:text-primary",
                      )}
                    >
                      {playingMsgId === msg.id ? (
                        <StopCircle className="w-5 h-5" />
                      ) : (
                        <Volume2 className="w-5 h-5" />
                      )}
                    </button>
                    <button
                      onClick={() => startEdit(msg.id, msg.content)}
                      aria-label="Edit passage"
                      data-testid={`button-edit-message-${msg.id}`}
                      className="text-muted-foreground hover:text-primary p-1 rounded"
                    >
                      <Pencil className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => handleRegenerateMessage(msg.id)}
                      disabled={regeneratingMsgId !== null}
                      aria-label="Regenerate passage with AI"
                      title="Regenerate this paragraph with AI"
                      data-testid={`button-regenerate-message-${msg.id}`}
                      className="text-muted-foreground hover:text-primary p-1 rounded disabled:opacity-30"
                    >
                      {regeneratingMsgId === msg.id ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <Sparkles className="w-5 h-5" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDeleteMessage(msg.id)}
                      disabled={deleteMessage.isPending}
                      aria-label="Delete passage"
                      data-testid={`button-delete-message-${msg.id}`}
                      className="text-muted-foreground hover:text-destructive p-1 rounded disabled:opacity-30"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

        {/* AI is composing (non-streaming) */}
        {isTyping && (
          <div className="relative text-foreground animate-in fade-in duration-300">
            <div className="absolute -left-8 top-1.5 opacity-40 text-secondary-foreground">
              <Sparkles className="w-4 h-4 animate-pulse" />
            </div>
            <div className="italic text-muted-foreground">
              Your co-author is writing
              {streamedContent ? `… ${streamedContent}` : "…"}
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
                  onClick={handleRequestAi}
                  disabled={isTyping}
                  data-testid="button-ai-turn"
                  className="h-10 px-4 rounded-full bg-amber-500 hover:bg-amber-500/90 text-amber-950 font-sans font-medium shadow-sm transition-all gap-2"
                  aria-label="Request AI turn"
                  title="Ask the AI to write the next paragraph"
                >
                  <Sparkles className="w-4 h-4" />
                  AI turn
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <DebugPanel />
    </div>
  );
}
