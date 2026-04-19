import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "listening" | "speaking";

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice(enabled: boolean) {
  const [state, setState] = useState<VoiceState>("idle");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
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

  /** One-shot listen: resolves with the transcript (empty string on silence/error). */
  const listenOnce = useCallback((): Promise<string> => {
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
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      let transcript = "";

      recognition.onstart = () => setState("listening");
      recognition.onresult = (e) => {
        transcript = e.results[0]?.[0]?.transcript ?? "";
      };
      recognition.onend = () => {
        setState("idle");
        resolve(transcript);
      };
      recognition.onerror = () => {
        setState("idle");
        resolve("");
      };

      recognition.start();
    });
  }, [enabled]);

  /** Manual listen with streaming interim results (used outside of blind auto-loop). */
  const listen = useCallback(
    (onResult: (transcript: string) => void, onEnd?: () => void): (() => void) => {
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
      recognition.lang = "en-US";

      recognition.onstart = () => setState("listening");
      recognition.onresult = (e) => {
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

  return { state, speak, stopSpeaking, listen, listenOnce };
}
