import { useState, useEffect } from "react";
import { STT_DEFAULTS, type SttConfig } from "@/config/stt";

export type GameMode = "auto" | "manual";

/**
 * How translations are spoken when the header Play / per-message Play
 * buttons are pressed.
 *  - "off"  → only the original paragraph is spoken (current behaviour)
 *  - "with" → original first, then each selected translation in order
 *  - "only" → only the translations are spoken; original is skipped
 *
 * `viewLanguages` controls which target languages get spoken (and shown).
 */
export type TtsTranslationMode = "off" | "with" | "only";

export interface StorySettings {
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
  apiUrl: string;
  blindMode: boolean;
  playUserTranscription: boolean;
  gameMode: GameMode;
  stt: SttConfig;
  /**
   * BCP-47 languages to display each story line translated into. Empty
   * array = show only the original text. Multiple entries each render
   * their own translated line below the original (and, depending on
   * `ttsTranslationMode`, are also spoken aloud).
   *
   * Translations are powered by Google Translate's free public endpoint
   * (no API key required).
   */
  viewLanguages: string[];
  /** See {@link TtsTranslationMode}. */
  ttsTranslationMode: TtsTranslationMode;
  /**
   * Per-language playback speed (rate) for text-to-speech, keyed by the
   * BCP-47 language tag (e.g. { "en-US": 1.0, "ja-JP": 0.85 }). When a
   * language is missing from this map the global `ttsRateDefault` is used.
   * Range matches SpeechSynthesisUtterance.rate (typically 0.5–2.0).
   */
  ttsRates: Record<string, number>;
  /** Default playback rate when a language has no explicit override. */
  ttsRateDefault: number;
}

const STORAGE_KEY = "story-together-settings";

const DEFAULTS: StorySettings = {
  model: "openrouter/free",
  maxTokens: 10,
  temperature: 1.0,
  apiKey: "",
  apiUrl: "",
  blindMode: false,
  playUserTranscription: true,
  gameMode: "auto",
  stt: { ...STT_DEFAULTS },
  viewLanguages: [],
  ttsTranslationMode: "off",
  ttsRates: {},
  ttsRateDefault: 0.95,
};

/** Shape of legacy settings persisted before the multi-language migration. */
type LegacyStorySettings = Partial<StorySettings> & {
  /** Replaced by `viewLanguages: string[]`. Migrated on load. */
  viewLanguage?: string;
};

function load(): StorySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LegacyStorySettings;
      // Migrate legacy single `viewLanguage` → `viewLanguages: string[]`.
      // "off" / empty / missing → no translations selected.
      let viewLanguages = parsed.viewLanguages ?? DEFAULTS.viewLanguages;
      if (
        !parsed.viewLanguages &&
        parsed.viewLanguage &&
        parsed.viewLanguage !== "off"
      ) {
        viewLanguages = [parsed.viewLanguage];
      }
      return {
        ...DEFAULTS,
        ...parsed,
        stt: { ...DEFAULTS.stt, ...(parsed.stt ?? {}) },
        ttsRates: { ...DEFAULTS.ttsRates, ...(parsed.ttsRates ?? {}) },
        viewLanguages,
        ttsTranslationMode:
          parsed.ttsTranslationMode ?? DEFAULTS.ttsTranslationMode,
      };
    }
  } catch {}
  return DEFAULTS;
}

export function useSettings() {
  const [settings, setSettingsState] = useState<StorySettings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  const updateSettings = (patch: Partial<StorySettings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }));
  };

  return { settings, updateSettings, DEFAULTS };
}
