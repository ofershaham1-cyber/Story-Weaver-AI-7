import { Volume2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TtsTranslationMode } from "@/hooks/use-settings";

interface Props {
  value: TtsTranslationMode;
  onChange: (mode: TtsTranslationMode) => void;
  /** Whether any translations are currently selected. Affects the title text. */
  hasTranslations: boolean;
}

const LABELS: Record<TtsTranslationMode, string> = {
  off: "Original",
  with: "Both",
  only: "Translation",
};

const TITLES: Record<TtsTranslationMode, string> = {
  off: "Play original paragraphs only",
  with: "Play original then each selected translation",
  only: "Play only the selected translations (skip original)",
};

/**
 * Compact selector for {@link TtsTranslationMode}. Lives in the story
 * header alongside the other voice/translation controls.
 *
 * Disabled-looking when no translations are picked but still functional —
 * the user can pre-select a mode and then add languages.
 */
export function TtsTranslationModeSwitcher({
  value,
  onChange,
  hasTranslations,
}: Props) {
  const titleSuffix = hasTranslations
    ? ""
    : " (pick languages from the View dropdown to enable)";

  return (
    <Select value={value} onValueChange={(v) => onChange(v as TtsTranslationMode)}>
      <SelectTrigger
        aria-label="Translation playback mode"
        title={`${TITLES[value]}${titleSuffix}`}
        data-testid="select-tts-translation-mode"
        className="h-8 gap-1 px-2 border-border/60 bg-transparent text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent/40 [&>svg:last-child]:hidden focus:ring-0 focus:ring-offset-0 w-auto min-w-0"
      >
        <Volume2 className="w-4 h-4 shrink-0" />
        <span className="text-[10px] uppercase tracking-wide font-sans font-medium opacity-70 leading-none">
          Play
        </span>
        <SelectValue>{LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="max-h-72">
        <SelectItem value="off">
          Original{" "}
          <span className="text-muted-foreground font-mono text-xs">
            (skip translations)
          </span>
        </SelectItem>
        <SelectItem value="with">
          Both{" "}
          <span className="text-muted-foreground font-mono text-xs">
            (original + translations)
          </span>
        </SelectItem>
        <SelectItem value="only">
          Translation{" "}
          <span className="text-muted-foreground font-mono text-xs">
            (skip original)
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
