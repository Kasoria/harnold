import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Project } from "./db.ts";
import { resolveInsideProject } from "./files.ts";
import { settingsStore } from "./settings.ts";
import { voiceConfig } from "./voice.ts";
import { placeImagesOnCanvas } from "./canvas.ts";

export const imageProviders = ["none", "gemini", "openai"] as const;
export const aspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

export const imageSettingsSchema = z.object({
  provider: z.enum(imageProviders),
  geminiModel: z.string(),
  openaiModel: z.string(),
});
export type ImageSettings = z.infer<typeof imageSettingsSchema>;
export const imageSecretKeys = ["geminiApiKey", "openaiApiKey"] as const;
type ImageSecretKey = (typeof imageSecretKeys)[number];

const defaultImageSettings: ImageSettings = { provider: "none", geminiModel: "", openaiModel: "" };
const defaultModels = { gemini: "gemini-nano-banana-2.1", openai: "gpt-image-1" } as const;

export const imageRequestSchema = z.object({
  prompt: z.string().min(1),
  /** Project-relative image paths used as references (edit / style). */
  referencePaths: z.array(z.string()).max(4).default([]),
  aspectRatio: z.enum(aspectRatios).default("1:1"),
  count: z.number().int().min(1).max(4).default(1),
  /** Canvas position for the results; null = "Generiert" frame. */
  anchor: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
});
export type ImageRequest = z.infer<typeof imageRequestSchema>;

type GeneratedImage = { data: Buffer; mimeType: string };

// --- Settings ---

export const imageConfig = {
  read(): ImageSettings {
    return { ...defaultImageSettings, ...settingsStore.read<Partial<ImageSettings>>("images", {}) };
  },
  secrets(): Record<string, string> {
    return settingsStore.readSecrets("images.secrets");
  },
  save(imageSettings: ImageSettings, submittedSecrets: Partial<Record<ImageSecretKey, string>>): void {
    settingsStore.write("images", imageSettings);
    const mergedSecrets = { ...imageConfig.secrets() };
    for (const [secretKey, secretValue] of Object.entries(submittedSecrets)) if (secretValue) mergedSecrets[secretKey] = secretValue;
    settingsStore.writeSecrets("images.secrets", mergedSecrets);
  },
  /** OpenAI key: own, else the one from the voice settings. */
  apiKeyFor(provider: "gemini" | "openai"): string | undefined {
    const secrets = imageConfig.secrets();
    if (provider === "gemini") return secrets.geminiApiKey || process.env.GEMINI_API_KEY || undefined;
    return secrets.openaiApiKey || voiceConfig.secrets().openaiApiKey || undefined;
  },
  present() {
    const imageSettings = imageConfig.read();
    const secretsSet = { geminiApiKey: Boolean(imageConfig.apiKeyFor("gemini")), openaiApiKey: Boolean(imageConfig.apiKeyFor("openai")) };
    const ready = imageSettings.provider !== "none" && Boolean(imageConfig.apiKeyFor(imageSettings.provider));
    return { ...imageSettings, secretsSet, ready, defaultModels };
  },
};

// --- Helpers ---

const mimeTypeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const extensionByMimeType: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function readReferenceImages(project: Project, referencePaths: string[]): (GeneratedImage & { fileName: string })[] {
  return referencePaths.map((referencePath) => {
    const mimeType = mimeTypeByExtension[path.extname(referencePath).toLowerCase()];
    if (!mimeType) throw new Error(`Referenz ist kein Bild: ${referencePath}`);
    return { data: fs.readFileSync(resolveInsideProject(project, referencePath)), mimeType, fileName: path.basename(referencePath) };
  });
}

/** Reads width/height from PNG, JPEG or WebP headers. */
export function readImageSize(imageData: Buffer): { width: number; height: number } {
  if (imageData.subarray(1, 4).toString("ascii") === "PNG") return { width: imageData.readUInt32BE(16), height: imageData.readUInt32BE(20) };
  if (imageData[0] === 0xff && imageData[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < imageData.length) {
      if (imageData[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = imageData[offset + 1];
      const segmentLength = imageData.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) return { height: imageData.readUInt16BE(offset + 5), width: imageData.readUInt16BE(offset + 7) };
      offset += 2 + segmentLength;
    }
  }
  if (imageData.subarray(0, 4).toString("ascii") === "RIFF" && imageData.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunkType = imageData.subarray(12, 16).toString("ascii");
    if (chunkType === "VP8X") return { width: 1 + imageData.readUIntLE(24, 3), height: 1 + imageData.readUIntLE(27, 3) };
    if (chunkType === "VP8L") {
      const bits = imageData.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunkType === "VP8 ") return { width: imageData.readUInt16LE(26) & 0x3fff, height: imageData.readUInt16LE(28) & 0x3fff };
  }
  return { width: 1, height: 1 };
}

function fileSlugOf(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return slug || "bild";
}

async function readErrorText(response: Response): Promise<string> {
  const responseText = await response.text();
  try {
    const parsedError = JSON.parse(responseText) as { error?: { message?: string } };
    return parsedError.error?.message ?? responseText;
  } catch {
    return responseText.slice(0, 500);
  }
}

// --- Providers ---

async function generateWithGemini(request: ImageRequest, references: GeneratedImage[], apiKey: string, model: string): Promise<GeneratedImage[]> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const requestOnce = async (withImageConfig: boolean): Promise<Response> => {
    const promptText = withImageConfig || request.aspectRatio === "1:1" ? request.prompt : `${request.prompt}\n\nSeitenverhältnis: ${request.aspectRatio}.`;
    return fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              ...references.map((reference) => ({ inline_data: { mime_type: reference.mimeType, data: reference.data.toString("base64") } })),
              { text: promptText },
            ],
          },
        ],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"], ...(withImageConfig ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}) },
      }),
    });
  };

  const generateOne = async (): Promise<GeneratedImage> => {
    let response = await requestOnce(true);
    // Some models reject imageConfig – retry with the ratio in the prompt.
    if (response.status === 400) {
      const errorText = await readErrorText(response.clone());
      if (/imageConfig|aspect/i.test(errorText)) response = await requestOnce(false);
    }
    if (!response.ok) throw new Error(`Gemini: ${response.status} ${await readErrorText(response)}`);
    const responseBody = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const parts = responseBody.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData);
    if (!imagePart?.inlineData) {
      const reason = responseBody.promptFeedback?.blockReason ?? responseBody.candidates?.[0]?.finishReason ?? parts.find((part) => part.text)?.text ?? "kein Bild erhalten";
      throw new Error(`Gemini: ${reason}`);
    }
    return { data: Buffer.from(imagePart.inlineData.data, "base64"), mimeType: imagePart.inlineData.mimeType };
  };

  return Promise.all(Array.from({ length: request.count }, generateOne));
}

const openaiSizeByAspectRatio: Record<AspectRatio, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "4:3": "1536x1024", "9:16": "1024x1536", "3:4": "1024x1536" };

async function generateWithOpenai(request: ImageRequest, references: (GeneratedImage & { fileName: string })[], apiKey: string, model: string): Promise<GeneratedImage[]> {
  const size = openaiSizeByAspectRatio[request.aspectRatio];
  let response: Response;
  if (references.length) {
    const formData = new FormData();
    formData.append("model", model);
    formData.append("prompt", request.prompt);
    formData.append("n", String(request.count));
    formData.append("size", size);
    for (const reference of references) formData.append("image[]", new Blob([new Uint8Array(reference.data)], { type: reference.mimeType }), reference.fileName);
    response = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: formData });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: request.prompt, n: request.count, size }),
    });
  }
  if (!response.ok) throw new Error(`OpenAI: ${response.status} ${await readErrorText(response)}`);
  const responseBody = (await response.json()) as { data: { b64_json?: string; url?: string }[] };
  return Promise.all(
    responseBody.data.map(async (imageEntry) => {
      if (imageEntry.b64_json) return { data: Buffer.from(imageEntry.b64_json, "base64"), mimeType: "image/png" };
      if (!imageEntry.url) throw new Error("OpenAI: kein Bild erhalten");
      const imageResponse = await fetch(imageEntry.url);
      return { data: Buffer.from(await imageResponse.arrayBuffer()), mimeType: imageResponse.headers.get("content-type") ?? "image/png" };
    }),
  );
}

// --- Public ---

/** Generates images, stores them under assets/generated/ and places them on the canvas. Returns project paths. */
export async function generateImages(project: Project, request: ImageRequest): Promise<string[]> {
  const imageSettings = imageConfig.read();
  if (imageSettings.provider === "none") throw new Error("Bild-Generierung zuerst in Einstellungen → Bilder einrichten.");
  const apiKey = imageConfig.apiKeyFor(imageSettings.provider);
  if (!apiKey) throw new Error("API-Key für die Bild-Generierung fehlt (Einstellungen → Bilder).");
  const references = readReferenceImages(project, request.referencePaths);

  const generatedImages =
    imageSettings.provider === "gemini"
      ? await generateWithGemini(request, references, apiKey, imageSettings.geminiModel || defaultModels.gemini)
      : await generateWithOpenai(request, references, apiKey, imageSettings.openaiModel || defaultModels.openai);

  const outputDirectory = resolveInsideProject(project, "assets/generated");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const fileBaseName = `${fileSlugOf(request.prompt)}-${timestamp}`;

  const placements = generatedImages.map((generatedImage, imageIndex) => {
    const extension = extensionByMimeType[generatedImage.mimeType] ?? "png";
    let relativePath = `assets/generated/${fileBaseName}${generatedImages.length > 1 ? `-${imageIndex + 1}` : ""}.${extension}`;
    for (let duplicateCounter = 2; fs.existsSync(resolveInsideProject(project, relativePath)); duplicateCounter++) {
      relativePath = relativePath.replace(/(-\d+)?\.(\w+)$/, `-${duplicateCounter}.$2`);
    }
    fs.writeFileSync(resolveInsideProject(project, relativePath), generatedImage.data);
    return { path: relativePath, ...readImageSize(generatedImage.data), title: request.prompt.slice(0, 120) };
  });
  // Synchronously after writing, before the file watcher's debounce triggers the canvas auto-placement.
  placeImagesOnCanvas(project, placements, request.anchor);
  return placements.map((placement) => placement.path);
}
