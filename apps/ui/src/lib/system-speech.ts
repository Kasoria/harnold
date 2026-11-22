/**
 * Free speech-to-text built into the browser / OS (Web Speech API): in the macOS app WebKit uses Apple's speech
 * recognition, Chrome and Edge use their own service. Not available in Firefox.
 */
type RecognitionResultList = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
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
  /** Ends listening and resolves with everything recognized. */
  finish: () => Promise<string>;
  cancel: () => void;
};

export function startSystemSpeech(language: string): SystemSpeechSession {
  const Recognition = recognitionConstructor();
  if (!Recognition) throw new Error("Spracherkennung des Systems ist hier nicht verfügbar.");
  const recognition = new Recognition();
  recognition.lang = language === "en" ? "en-US" : language === "de" ? "de-DE" : language;
  recognition.continuous = true;
  recognition.interimResults = true;

  let transcript = "";
  let recognitionError: string | null = null;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));

  recognition.onresult = (resultEvent) => {
    transcript = Array.from(resultEvent.results)
      .map((result) => result[0]?.transcript ?? "")
      .join("")
      .trim();
  };
  recognition.onerror = (errorEvent) => {
    if (errorEvent.error !== "no-speech" && errorEvent.error !== "aborted") recognitionError = errorEvent.error;
  };
  recognition.onend = () => resolveEnded();
  recognition.start();

  return {
    finish: async () => {
      recognition.stop();
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (recognitionError && !transcript) {
        throw new Error(recognitionError === "not-allowed" || recognitionError === "service-not-allowed" ? "Kein Zugriff auf Mikrofon oder Spracherkennung." : `Spracherkennung: ${recognitionError}`);
      }
      return transcript;
    },
    cancel: () => recognition.abort(),
  };
}
