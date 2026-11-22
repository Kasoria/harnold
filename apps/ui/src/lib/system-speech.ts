import { t } from "@/lib/i18n";
/**
 * Free speech-to-text built into the browser / OS (Web Speech API): in the macOS app WebKit uses Apple's speech
 * recognition, Chrome and Edge use their own service. Not available in Firefox.
 */
type RecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type RecognitionResultList = ArrayLike<RecognitionResult>;
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((resultEvent: { results: RecognitionResultList }) => void) | null;
  onerror: ((errorEvent: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const recognitionConstructor = (): SpeechRecognitionConstructor | undefined =>
  (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition;

export const systemSpeechAvailable = () => typeof window !== "undefined" && Boolean(recognitionConstructor());

export type SystemSpeechSession = {
  /** Ends listening and resolves with everything recognized so far. */
  finish: () => Promise<string>;
  /** Stops listening right away, keeping what was recognized. */
  abort: () => void;
};

/** Language tag for the recognizer ("de" → "de-DE"). */
const languageTag = (language: string) => (language === "en" ? "en-US" : language === "de" ? "de-DE" : language);

/**
 * Listens and reports the transcript live (`onTranscript`, interim results included). WebKit ends a run after a
 * pause, so a finished run without `finish()` starts the next one and keeps everything said so far.
 */
export function startSystemSpeech(language: string, onTranscript?: (transcript: string) => void): SystemSpeechSession {
  const Recognition = recognitionConstructor();
  if (!Recognition) throw new Error(t("Spracherkennung des Systems ist hier nicht verfügbar."));

  let recognition = new Recognition();
  let committed = "";
  let currentFinal = "";
  let interim = "";
  let stopped = false;
  let recognitionError: string | null = null;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));

  const transcript = () => [committed, currentFinal, interim].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const listen = () => {
    recognition.lang = languageTag(language);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (resultEvent) => {
      let final = "";
      let pending = "";
      for (const result of Array.from(resultEvent.results)) {
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else pending += text;
      }
      currentFinal = final.trim();
      interim = pending.trim();
      onTranscript?.(transcript());
    };
    recognition.onerror = (errorEvent) => {
      if (errorEvent.error !== "no-speech" && errorEvent.error !== "aborted") recognitionError = errorEvent.error;
    };
    recognition.onend = () => {
      committed = [committed, currentFinal].filter(Boolean).join(" ").trim();
      currentFinal = "";
      interim = "";
      if (stopped) {
        resolveEnded();
        return;
      }
      // A pause ended this run: keep listening so dictation does not stop mid-sentence.
      recognition = new Recognition();
      listen();
    };
    try {
      recognition.start();
    } catch {
      // Already started – nothing to do.
    }
  };

  listen();

  const stopInstance = () => {
    try {
      recognition.stop();
    } catch {
      resolveEnded();
    }
  };

  return {
    finish: async () => {
      stopped = true;
      stopInstance();
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000))]);
      const heardText = transcript();
      if (recognitionError && !heardText) {
        throw new Error(
          recognitionError === "not-allowed" || recognitionError === "service-not-allowed" ? t("Kein Zugriff auf Mikrofon oder Spracherkennung.") : t("Spracherkennung: {0}", recognitionError),
        );
      }
      return heardText;
    },
    abort: () => {
      stopped = true;
      try {
        recognition.abort();
      } catch {
        resolveEnded();
      }
    },
  };
}
