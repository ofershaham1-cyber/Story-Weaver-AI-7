import { Languages, Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STT_LANGUAGES } from "@/config/stt";

interface Props {
  value: string;
  onChange: (lang: string) => void;
  /** Visual variant changes the icon and default labels. */
  variant?: "stt" | "ai";
  /** Override aria-label / title (defaults are derived from variant). */
  ariaLabel?: string;
  title?: string;
  /** Override the data-testid (defaults are derived from variant). */
  testId?: string;
}

/**
 * Compact language picker shown in the story page header. Used both for the
 * speech-recognition language (STT) and for the AI's response language.
 */
export function SttLanguageSwitcher({
  value,
  onChange,
  variant = "stt",
  ariaLabel,
  title,
  testId,
}: Props) {
  const Icon = variant === "ai" ? Sparkles : Languages;
  const defaultAria =
    variant === "ai" ? "AI response language" : "Speech recognition language";
  const defaultTitle =
    variant === "ai"
      ? `AI response language: ${value}`
      : `Speech recognition language: ${value}`;
  const defaultTestId =
    variant === "ai"
      ? "select-ai-language-quick"
      : "select-stt-language-quick";

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel ?? defaultAria}
        title={title ?? defaultTitle}
        data-testid={testId ?? defaultTestId}
        className="h-8 gap-1 px-2 border-border/60 bg-transparent text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent/40 [&>svg:last-child]:hidden focus:ring-0 focus:ring-offset-0 w-auto min-w-0"
      >
        <Icon className="w-4 h-4 shrink-0" />
        {/* Force trigger to show only the code, not the full label */}
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {STT_LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.label}{" "}
            <span className="text-muted-foreground font-mono text-xs">
              {l.code}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
