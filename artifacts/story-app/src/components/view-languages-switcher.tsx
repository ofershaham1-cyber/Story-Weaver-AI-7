import { Eye, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { STT_LANGUAGES } from "@/config/stt";
import { cn } from "@/lib/utils";

interface Props {
  /** Selected BCP-47 codes. Empty array = no translations shown. */
  value: string[];
  onChange: (langs: string[]) => void;
  /** Short label rendered inside the trigger (next to the icon). */
  label?: string;
}

/**
 * Multi-select language picker for on-screen translations.
 *
 * Picks zero or more BCP-47 languages from `STT_LANGUAGES`. Each selected
 * language renders its own `<TranslatedLine>` under every story paragraph
 * and (depending on `ttsTranslationMode`) is also spoken aloud during
 * playback.
 *
 * Trigger label summarizes the selection: "Original" when empty, the
 * single code when one is selected, otherwise "<count> langs".
 */
export function ViewLanguagesSwitcher({ value, onChange, label }: Props) {
  const selectedSet = new Set(value);

  const toggle = (code: string) => {
    if (selectedSet.has(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  };

  const clearAll = () => onChange([]);

  const triggerText =
    value.length === 0
      ? "Original"
      : value.length === 1
        ? value[0]
        : `${value.length} langs`;

  const title =
    value.length === 0
      ? "Translations: off (showing original only)"
      : `Translate story to: ${value.join(", ")}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Translation languages"
          title={title}
          data-testid="select-view-languages"
          className="h-8 gap-1 px-2 border border-border/60 bg-transparent text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          <Eye className="w-4 h-4 shrink-0" />
          {label && (
            <span className="text-[10px] uppercase tracking-wide font-sans font-medium opacity-70 leading-none">
              {label}
            </span>
          )}
          <span>{triggerText}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-0 max-h-80 overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
          <span className="text-xs font-sans text-muted-foreground">
            {value.length === 0
              ? "No translations"
              : `${value.length} selected`}
          </span>
          <button
            type="button"
            onClick={clearAll}
            disabled={value.length === 0}
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="clear-view-languages"
          >
            Clear
          </button>
        </div>
        <div className="overflow-y-auto py-1">
          {STT_LANGUAGES.map((l) => {
            const checked = selectedSet.has(l.code);
            return (
              <button
                key={l.code}
                type="button"
                onClick={() => toggle(l.code)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent/40 transition-colors",
                  checked && "bg-accent/20",
                )}
                data-testid={`view-language-option-${l.code}`}
              >
                <span
                  className={cn(
                    "w-4 h-4 rounded border border-border/60 flex items-center justify-center shrink-0",
                    checked && "bg-primary border-primary",
                  )}
                >
                  {checked && (
                    <Check className="w-3 h-3 text-primary-foreground" />
                  )}
                </span>
                <span className="flex-1">{l.label}</span>
                <span className="text-muted-foreground font-mono text-xs">
                  {l.code}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
