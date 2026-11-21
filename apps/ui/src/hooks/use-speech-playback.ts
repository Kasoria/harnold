import { useRef, useState } from "react";
import { api } from "@/api";

/** Plays text via the core's TTS; one clip at a time. */
export function useSpeechPlayback(onError: (unknownError: unknown) => void) {
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = () => {
    audioRef.current?.pause();
    if (audioRef.current?.src) URL.revokeObjectURL(audioRef.current.src);
    audioRef.current = null;
    setSpeakingKey(null);
  };

  const speak = async (playbackKey: string, text: string) => {
    stopSpeaking();
    setLoadingKey(playbackKey);
    try {
      const audioBlob = await api.speak(text);
      const audioElement = new Audio(URL.createObjectURL(audioBlob));
      audioRef.current = audioElement;
      audioElement.onended = stopSpeaking;
      setSpeakingKey(playbackKey);
      await audioElement.play();
    } catch (speechError) {
      stopSpeaking();
      onError(speechError);
    } finally {
      setLoadingKey(null);
    }
  };

  return { speak, stopSpeaking, speakingKey, loadingKey };
}
