import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settingsStore } from "./settings.ts";

const execFileAsync = promisify(execFile);

export const sttProviders = ["none", "system", "openai", "elevenlabs", "deepgram", "whisper-cpp"] as const;
export const ttsProviders = ["none", "openai", "elevenlabs", "piper"] as const;

export const voiceSettingsSchema = z.object({
  sttProvider: z.enum(sttProviders),
  ttsProvider: z.enum(ttsProviders),
  language: z.string(),
  /** Non-secret provider options (models, voices, local binary paths). */
  options: z.record(z.string(), z.string()),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

/** Secret keys per provider; options keys per provider (with defaults). */
const secretKeysByProvider: Record<string, string[]> = {
  openai: ["openaiApiKey"],
  elevenlabs: ["elevenlabsApiKey"],
  deepgram: ["deepgramApiKey"],
};
export const voiceSecretKeys = ["openaiApiKey", "elevenlabsApiKey", "deepgramApiKey"] as const;

const optionDefaults: Record<string, string> = {
  openaiSttModel: "gpt-4o-transcribe",
  openaiTtsModel: "gpt-4o-mini-tts",
  openaiVoice: "alloy",
  elevenlabsSttModel: "scribe_v1",
  elevenlabsTtsModel: "eleven_multilingual_v2",
  elevenlabsVoiceId: "",
  deepgramModel: "nova-3",
  whisperBinary: "whisper-cli",
  whisperModelPath: "",
  piperBinary: "piper",
  piperModelPath: "",
  ffmpegBinary: "ffmpeg",
};

const defaultVoiceSettings: VoiceSettings = { sttProvider: "system", ttsProvider: "none", language: "de", options: {} };

export type AudioClip = { data: Buffer; mimeType: string };

export const voiceConfig = {
  read(): VoiceSettings {
    const stored = settingsStore.read<VoiceSettings>("voice", defaultVoiceSettings);
    return { ...stored, options: { ...optionDefaults, ...stored.options } };
  },
  secrets(): Record<string, string> {
    return settingsStore.readSecrets("voice.secrets");
  },
  save(voiceSettings: VoiceSettings, submittedSecrets: Record<string, string | undefined>): void {
    settingsStore.write("voice", voiceSettings);
    const mergedSecrets = { ...voiceConfig.secrets() };
    for (const secretKey of voiceSecretKeys) {
      const submittedValue = submittedSecrets[secretKey]?.trim();
      if (submittedValue) mergedSecrets[secretKey] = submittedValue;
    }
    settingsStore.writeSecrets("voice.secrets", mergedSecrets);
  },
  /** Client-facing view: settings + which secrets are set + whether STT/TTS are usable. */
  present() {
    const voiceSettings = voiceConfig.read();
    const secrets = voiceConfig.secrets();
    const providerReady = (provider: string) =>
      provider !== "none" &&
      (secretKeysByProvider[provider] ?? []).every((secretKey) => Boolean(secrets[secretKey])) &&
      (provider !== "whisper-cpp" || Boolean(voiceSettings.options.whisperModelPath)) &&
      (provider !== "piper" || Boolean(voiceSettings.options.piperModelPath)) &&
      (provider !== "elevenlabs" || voiceSettings.ttsProvider !== "elevenlabs" || Boolean(voiceSettings.options.elevenlabsVoiceId));
    return {
      ...voiceSettings,
      secretsSet: Object.fromEntries(voiceSecretKeys.map((secretKey) => [secretKey, Boolean(secrets[secretKey])])),
      sttReady: providerReady(voiceSettings.sttProvider),
      ttsReady: providerReady(voiceSettings.ttsProvider),
    };
  },
};

const extensionByMimeType = (mimeType: string): string => {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "bin";
};

async function withTemporaryDirectory<Result>(work: (directory: string) => Promise<Result>): Promise<Result> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harnold-voice-"));
  try {
    return await work(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function expectOk(response: Response, providerName: string): Promise<Response> {
  if (!response.ok) throw new Error(`${providerName}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** Converts any audio to the given format via ffmpeg. */
async function convertAudio(audioClip: AudioClip, targetArguments: string[], targetExtension: string): Promise<Buffer> {
  const { options } = voiceConfig.read();
  return withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, `input.${extensionByMimeType(audioClip.mimeType)}`);
    const outputPath = path.join(directory, `output.${targetExtension}`);
    fs.writeFileSync(inputPath, audioClip.data);
    await execFileAsync(options.ffmpegBinary, ["-y", "-loglevel", "error", "-i", inputPath, ...targetArguments, outputPath]);
    return fs.readFileSync(outputPath);
  });
}

export async function toOggOpus(audioClip: AudioClip): Promise<AudioClip> {
  if (audioClip.mimeType.includes("ogg")) return audioClip;
  return { data: await convertAudio(audioClip, ["-c:a", "libopus", "-b:a", "48k", "-ac", "1"], "ogg"), mimeType: "audio/ogg" };
}

export async function transcribe(audioClip: AudioClip): Promise<string> {
  const { sttProvider, language, options } = voiceConfig.read();
  const secrets = voiceConfig.secrets();
  const fileName = `audio.${extensionByMimeType(audioClip.mimeType)}`;
  const audioBlob = new Blob([new Uint8Array(audioClip.data)], { type: audioClip.mimeType });

  switch (sttProvider) {
    case "system":
      throw new Error("Die System-Spracherkennung gibt es nur bei der Eingabe in der App. Für Sprachnachrichten aus Channels einen Anbieter in Einstellungen → Voice wählen.");
    case "openai": {
      const formData = new FormData();
      formData.append("file", audioBlob, fileName);
      formData.append("model", options.openaiSttModel);
      if (language) formData.append("language", language);
      const response = await expectOk(
        await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${secrets.openaiApiKey}` }, body: formData }),
        "OpenAI",
      );
      return String(((await response.json()) as { text?: string }).text ?? "").trim();
    }
    case "elevenlabs": {
      const formData = new FormData();
      formData.append("file", audioBlob, fileName);
      formData.append("model_id", options.elevenlabsSttModel);
      if (language) formData.append("language_code", language);
      const response = await expectOk(
        await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": secrets.elevenlabsApiKey }, body: formData }),
        "ElevenLabs",
      );
      return String(((await response.json()) as { text?: string }).text ?? "").trim();
    }
    case "deepgram": {
      const query = new URLSearchParams({ model: options.deepgramModel, smart_format: "true", ...(language ? { language } : {}) });
      const response = await expectOk(
        await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
          method: "POST",
          headers: { authorization: `Token ${secrets.deepgramApiKey}`, "content-type": audioClip.mimeType },
          body: new Uint8Array(audioClip.data),
        }),
        "Deepgram",
      );
      const payload = (await response.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
      return String(payload.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
    }
    case "whisper-cpp": {
      const wavData = await convertAudio(audioClip, ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"], "wav");
      return withTemporaryDirectory(async (directory) => {
        const wavPath = path.join(directory, "input.wav");
        fs.writeFileSync(wavPath, wavData);
        const { stdout } = await execFileAsync(options.whisperBinary, ["-m", options.whisperModelPath, "-f", wavPath, "-l", language || "auto", "-nt"], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim();
      });
    }
    default:
      throw new Error("Spracherkennung ist nicht eingerichtet (Einstellungen → Voice)");
  }
}

export async function synthesize(text: string): Promise<AudioClip> {
  const { ttsProvider, options } = voiceConfig.read();
  const secrets = voiceConfig.secrets();
  const spokenText = text.replace(/```[\s\S]*?```/g, " (Code ausgelassen) ").replace(/[*_#`>]/g, "").slice(0, 4000);

  switch (ttsProvider) {
    case "openai": {
      const response = await expectOk(
        await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { authorization: `Bearer ${secrets.openaiApiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: options.openaiTtsModel, voice: options.openaiVoice, input: spokenText, response_format: "opus" }),
        }),
        "OpenAI",
      );
      return { data: Buffer.from(await response.arrayBuffer()), mimeType: "audio/ogg" };
    }
    case "elevenlabs": {
      const response = await expectOk(
        await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.elevenlabsVoiceId)}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": secrets.elevenlabsApiKey, "content-type": "application/json" },
          body: JSON.stringify({ text: spokenText, model_id: options.elevenlabsTtsModel }),
        }),
        "ElevenLabs",
      );
      return { data: Buffer.from(await response.arrayBuffer()), mimeType: "audio/mpeg" };
    }
    case "piper":
      return withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, `${randomUUID()}.wav`);
        await new Promise<void>((resolve, reject) => {
          const piperProcess = spawn(options.piperBinary, ["--model", options.piperModelPath, "--output_file", outputPath]);
          let errorOutput = "";
          piperProcess.stderr.on("data", (chunk) => (errorOutput += chunk));
          piperProcess.on("error", reject);
          piperProcess.on("close", (exitCode) => (exitCode === 0 ? resolve() : reject(new Error(`Piper: ${errorOutput.slice(0, 300)}`))));
          piperProcess.stdin.end(spokenText);
        });
        return { data: fs.readFileSync(outputPath), mimeType: "audio/wav" };
      });
    default:
      throw new Error("Sprachausgabe ist nicht eingerichtet (Einstellungen → Voice)");
  }
}
