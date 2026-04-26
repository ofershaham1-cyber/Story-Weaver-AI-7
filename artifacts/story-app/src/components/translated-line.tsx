import { useQuery } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import { translate, toGoogleLang } from "@/lib/translate";
import { cn } from "@/lib/utils";

interface Props {
  text: string;
  /** BCP-47 target language. */
  toLang: string;
  /**
   * Whether this line is the unit currently being spoken by the TTS
   * engine. When true the row gets a colored border so the user can
   * follow which line is "live" (the original gets the same treatment
   * via the playingItem state in `story.tsx`).
   */
  isPlaying?: boolean;
  /**
   * Click handler. When provided, clicking anywhere on the translated
   * line starts playback from this language (i.e. the play queue is
   * truncated so the first unit spoken is this translation, then any
   * units after it in `ttsPlayOrder` follow). Implemented in
   * `story.tsx::handlePlayMessage(msg, lang)`.
   */
  onClick?: () => void;
}

/**
 * Renders a translated copy of a story line below the original. Translations
 * are cached by react-query keyed on (text, toLang) so navigating around or
 * re-rendering does not trigger duplicate network calls.
 */
export function TranslatedLine({ text, toLang, isPlaying, onClick }: Props) {
  const trimmed = text.trim();
  const target = toGoogleLang(toLang);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["translation", target, trimmed],
    queryFn: () =>
      translate({
        finalTranscriptProxy: trimmed,
        fromLang: "auto",
        toLang: target,
      }),
    enabled: !!trimmed && !!target,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });

  if (!trimmed) return null;

  // Visual rules for the row container:
  //  * Always have a left rule so translations are clearly tied to the
  //    paragraph above; bump it brighter when this line is the active
  //    TTS unit.
  //  * When clickable, add a hover affordance so the user knows the row
  //    itself is interactive (you can click anywhere on the translation
  //    to start playback from there).
  const interactive = !!onClick;
  return (
    <div
      className={cn(
        "mt-2 pl-3 border-l-2 text-base italic flex gap-2 rounded-r transition-colors",
        isPlaying
          ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40"
          : "border-border/40 text-muted-foreground",
        interactive && "cursor-pointer hover:bg-muted/30",
      )}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      aria-label={interactive ? `Play this ${toLang} translation` : undefined}
      data-testid={`translated-line-${toLang}`}
      data-playing={isPlaying ? "true" : undefined}
    >
      <Languages className="w-4 h-4 mt-1.5 shrink-0 opacity-60" />
      <div className="whitespace-pre-wrap min-w-0 flex-1">
        {/*
          BCP-47 code shown inline so users with multiple translations can
          tell at a glance which language each line is in (e.g. "fr-FR
          Bonjour…"). Mono + smaller + non-italic to make it visually
          distinct from the translated text itself.
        */}
        <span
          className="font-mono not-italic text-xs uppercase tracking-wider mr-2 px-1 py-0.5 rounded bg-muted/40 text-muted-foreground/80 align-middle"
          data-testid={`translated-line-lang-${toLang}`}
        >
          {toLang}
        </span>
        {isLoading
          ? "Translating…"
          : isError || data === "translation error"
            ? "(translation unavailable)"
            : data}
      </div>
    </div>
  );
}
