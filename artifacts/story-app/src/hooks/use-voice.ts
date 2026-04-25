import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "listening" | "speaking";

// Minimal SpeechRecognition typing — the Web Speech API isn't included in
// TypeScript's default DOM lib so we declare the surface we actually use.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onresult: ((e: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface ListenOptions {
  /** Ms of silence after speech ends before resolving. Default 4000. */
  silenceMs?: number;
  /**
   * Ms of no-speech before the nudge callback fires. Default 0 (disabled).
   * Repeats every `nudgeMs` until `maxNudges` is reached, then stops recognition.
   */
  nudgeMs?: number;
  /** How many nudges to emit before giving up. Default 0 (infinite). */
  maxNudges?: number;
  /** Called each time the nudge timer fires. Receives nudge index (1-based). */
  onNudge?: (nudgeIndex: number) => void;
  /** BCP-47 language tag for SpeechRecognition (e.g. "en-US"). Default "en-US". */
  language?: string;
  /**
   * Hard cap (ms) on listening time once the user has actually started
   * speaking. Useful to prevent the silence detector from getting stuck in
   * noisy environments. Default 0 (disabled).
   */
  maxSpeechMs?: number;
}

export function useVoice(enabled: boolean) {
  const [state, setState] = useState<VoiceState>("idle");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const synthRef = useRef(typeof window !== "undefined" ? window.speechSynthesis : null);

  useEffect(() => {
    return () => {
      synthRef.current?.cancel();
      recognitionRef.current?.abort();
    };
  }, []);

  /**
   * Pick the best available voice for the given BCP-47 lang. Tries an exact
   * match first, then a language-only match (e.g. "en" for "en-US").
   */
  const pickVoice = useCallback((lang: string): SpeechSynthesisVoice | null => {
    const synth = synthRef.current;
    if (!synth) return null;
    const voices = synth.getVoices();
    if (!voices || voices.length === 0) return null;
    const target = lang.toLowerCase();
    const targetBase = target.split("-")[0];
    const exact = voices.find((v) => v.lang.toLowerCase() === target);
    if (exact) return exact;
    const baseMatch = voices.find(
      (v) => v.lang.toLowerCase().split("-")[0] === targetBase,
    );
    return baseMatch ?? null;
  }, []);

  /**
   * Speak `text` using the browser's SpeechSynthesis API.
   *
   * IMPORTANT: `enabled` only gates *listening* (microphone access used by
   * blind-mode auto-loop). Speaking is always permitted because the page
   * exposes a Play button on the header and per-message Play buttons that
   * users invoke explicitly — gating speak on `enabled` made those buttons
   * silently no-op when blind mode was off.
   *
   * @param text     Text to read aloud.
   * @param language BCP-47 tag for the text (e.g. "en-US"). Determines both
   *                 the picked voice and the utterance.lang.
   * @param rate     Playback rate in the SpeechSynthesisUtterance range
   *                 (~0.5–2.0). Defaults to 0.95 to preserve previous
   *                 behaviour. Caller-provided rate lets the story page
   *                 honour per-language playback-speed preferences.
   * @param opts     Optional callbacks. `onWord` is invoked for each word
   *                 boundary the engine reports, mapped from `charIndex`
   *                 to a 0-based word index over the input text. Browsers
   *                 that don't fire `onboundary` simply produce no
   *                 highlights — playback is unaffected.
   */
  const speak = useCallback(
    (
      text: string,
      language: string = "en-US",
      rate: number = 0.95,
      opts?: { onWord?: (info: { wordIndex: number; charIndex: number }) => void },
    ): Promise<void> => {
      return new Promise((resolve) => {
        if (!synthRef.current) {
          resolve();
          return;
        }
        synthRef.current.cancel();

        // Pre-compute [start, end) char ranges for every non-whitespace
        // word in the original text so we can map the engine-reported
        // `charIndex` back to a 0-based word index. Using the same
        // splitting strategy the renderer uses keeps indices aligned.
        const wordRanges: Array<[number, number]> = [];
        if (opts?.onWord) {
          const parts = text.split(/(\s+)/);
          let pos = 0;
          for (const part of parts) {
            if (part.length === 0) continue;
            if (/\S/.test(part)) wordRanges.push([pos, pos + part.length]);
            pos += part.length;
          }
        }

        const utterance = new SpeechSynthesisUtterance(text);
        // Clamp to the spec's allowed range so an out-of-bounds value from
        // settings doesn't silently disable speech.
        utterance.rate = Math.min(Math.max(rate, 0.1), 10);
        utterance.pitch = 1.0;
        // Critical: without setting `lang` (and ideally a matching voice) the
        // browser falls back to the system default, which on some machines is
        // not the language of the text being spoken.
        utterance.lang = language;
        const voice = pickVoice(language);
        if (voice) utterance.voice = voice;

        if (opts?.onWord && wordRanges.length > 0) {
          let lastWordIdx = -1;
          utterance.onboundary = (e: SpeechSynthesisEvent) => {
            // Some engines emit "sentence" or "punctuation" boundaries too;
            // ignore everything except word boundaries.
            if (e.name && e.name !== "word") return;
            const ci = e.charIndex ?? 0;
            // Walk forward from the last reported word — boundaries arrive
            // monotonically so we don't need to re-scan from the start.
            for (let i = Math.max(lastWordIdx, 0); i < wordRanges.length; i++) {
              const [s, end] = wordRanges[i];
              if (ci >= s && ci < end) {
                lastWordIdx = i;
                opts.onWord!({ wordIndex: i, charIndex: ci });
                return;
              }
              if (ci < s) {
                lastWordIdx = i;
                opts.onWord!({ wordIndex: i, charIndex: ci });
                return;
              }
            }
          };
        }

        utterance.onstart = () => setState("speaking");
        utterance.onend = () => {
          setState("idle");
          resolve();
        };
        utterance.onerror = () => {
          setState("idle");
          resolve();
        };
        synthRef.current.speak(utterance);
      });
    },
    [pickVoice]
  );

  const stopSpeaking = useCallback(() => {
    synthRef.current?.cancel();
    setState("idle");
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.abort();
    setState("idle");
  }, []);

  /**
   * Listen until speech is detected and then `silenceMs` of silence elapses.
   *
   * If `nudgeMs` is set and no speech begins within that window, `onNudge` is
   * called and the timer resets. After `maxNudges` nudges recognition stops and
   * the promise resolves with whatever transcript was collected (usually "").
   */
  const listenOnce = useCallback(
    (options: ListenOptions = {}): Promise<string> => {
      const {
        silenceMs = 4000,
        nudgeMs = 0,
        maxNudges = 0,
        onNudge,
        language = "en-US",
        maxSpeechMs = 0,
      } = options;

      return new Promise((resolve) => {
        if (!enabled) {
          resolve("");
          return;
        }

        const Ctor = getSpeechRecognition();
        if (!Ctor) {
          resolve("");
          return;
        }

        const recognition = new Ctor();
        recognitionRef.current = recognition;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = language;

        let transcript = "";
        let speechDetected = false;
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
        let maxSpeechTimer: ReturnType<typeof setTimeout> | null = null;
        let nudgeCount = 0;

        const clearAllTimers = () => {
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
          if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
          if (maxSpeechTimer) { clearTimeout(maxSpeechTimer); maxSpeechTimer = null; }
        };

        const resetSilenceTimer = () => {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => recognition.stop(), silenceMs);
        };

        const scheduleNudge = () => {
          if (!nudgeMs || nudgeMs <= 0) return;
          nudgeTimer = setTimeout(() => {
            if (speechDetected) return; // speech started, nudge no longer relevant
            nudgeCount++;
            onNudge?.(nudgeCount);
            if (maxNudges > 0 && nudgeCount >= maxNudges) {
              // Gave up — stop recognition
              recognition.stop();
            } else {
              scheduleNudge(); // reschedule for next nudge
            }
          }, nudgeMs);
        };

        recognition.onstart = () => {
          setState("listening");
          // Do NOT start the silence timer yet — only start it once speech begins.
          // Start the nudge timer to detect prolonged silence before first speech.
          scheduleNudge();
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recognition.onresult = (e: any) => {
          if (!speechDetected) {
            // First speech detected — cancel nudge, begin silence detection,
            // and arm the hard "max speech" cap if configured.
            speechDetected = true;
            if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
            if (maxSpeechMs > 0) {
              maxSpeechTimer = setTimeout(() => {
                recognition.stop();
              }, maxSpeechMs);
            }
          }
          let hasContent = false;
          for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
              transcript += e.results[i][0].transcript + " ";
              hasContent = true;
            } else if (e.results[i][0].transcript) {
              hasContent = true;
            }
          }
          if (hasContent) resetSilenceTimer();
        };

        recognition.onend = () => {
          clearAllTimers();
          setState("idle");
          resolve(transcript.trim());
        };

        recognition.onerror = () => {
          clearAllTimers();
          setState("idle");
          resolve(transcript.trim());
        };

        recognition.start();
      });
    },
    [enabled]
  );

  /** Manual listen with streaming interim results (used outside of blind auto-loop). */
  const listen = useCallback(
    (
      onResult: (transcript: string) => void,
      onEnd?: () => void,
      language: string = "en-US",
    ): (() => void) => {
      if (!enabled) return () => {};

      const Ctor = getSpeechRecognition();
      if (!Ctor) {
        alert("Your browser does not support voice recognition. Try Chrome or Edge.");
        return () => {};
      }

      const recognition = new Ctor();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = language;

      recognition.onstart = () => setState("listening");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (e: any) => {
        const t = e.results[0]?.[0]?.transcript ?? "";
        onResult(t);
      };
      recognition.onend = () => {
        setState("idle");
        onEnd?.();
      };
      recognition.onerror = () => {
        setState("idle");
        onEnd?.();
      };

      recognition.start();

      return () => {
        recognition.abort();
        setState("idle");
      };
    },
    [enabled]
  );

  return { state, speak, stopSpeaking, stopListening, listen, listenOnce };
}
