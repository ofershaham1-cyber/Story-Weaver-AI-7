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

  const speak = useCallback(
    (text: string): Promise<void> => {
      return new Promise((resolve) => {
        if (!enabled || !synthRef.current) {
          resolve();
          return;
        }
        synthRef.current.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1.0;
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
    [enabled]
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
        let nudgeCount = 0;

        const clearAllTimers = () => {
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
          if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
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
            // First speech detected — cancel nudge, begin silence detection
            speechDetected = true;
            if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
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
