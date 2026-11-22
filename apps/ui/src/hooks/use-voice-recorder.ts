import { useEffect, useRef, useState } from "react";

const preferredMimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** Records from the microphone via MediaRecorder; resolves with the recording on stop. */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const resolveStopRef = useRef<((recording: Blob | null) => void) | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const start = async () => {
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    const mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    audioChunksRef.current = [];

    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);

    cleanupRef.current = () => {
      window.clearInterval(timer);
      mediaStream.getTracks().forEach((track) => track.stop());
      cleanupRef.current = null;
    };

    mediaRecorder.ondataavailable = (dataEvent) => {
      if (dataEvent.data.size) audioChunksRef.current.push(dataEvent.data);
    };
    mediaRecorder.onstop = () => {
      cleanupRef.current?.();
      setRecording(false);
      const recordedBlob = audioChunksRef.current.length ? new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" }) : null;
      resolveStopRef.current?.(recordedBlob);
      resolveStopRef.current = null;
    };

    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.start();
    setElapsedSeconds(0);
    setRecording(true);
  };

  const stop = () =>
    new Promise<Blob | null>((resolve) => {
      const mediaRecorder = mediaRecorderRef.current;
      if (!mediaRecorder || mediaRecorder.state === "inactive") return resolve(null);
      resolveStopRef.current = resolve;
      mediaRecorder.stop();
    });

  /** Stops and throws the recording away. */
  const discard = async () => {
    await stop();
    audioChunksRef.current = [];
  };

  return { recording, elapsedSeconds, start, stop, discard };
}
