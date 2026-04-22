import { useState, useEffect } from "react";

export type GameMode = "auto" | "manual";

export interface StorySettings {
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
  apiUrl: string;
  blindMode: boolean;
  playUserTranscription: boolean;
  gameMode: GameMode;
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
};

function load(): StorySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
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
