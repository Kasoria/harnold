import { useEffect, useState } from "react";
import type { ImageProvider, ImageSettings, ImageSettingsView, SttProvider, TtsProvider, VoiceSecretKey, VoiceSettings, VoiceSettingsView } from "@/types";
import { api } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/segmented-control";
import { FormField } from "@/components/form-field";
import { safeStorage } from "@/lib/storage";
import type { ThemePreference } from "@/hooks/use-theme";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themePreference: ThemePreference;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  voiceSettings: VoiceSettingsView | null;
  onVoiceSettingsChange: (voiceSettings: VoiceSettingsView) => void;
  onError: (unknownError: unknown) => void;
};

type SettingsTab = "general" | "voice" | "images";

const imageProviderLabels: Record<ImageProvider, string> = { none: "Aus", gemini: "Google Gemini", openai: "OpenAI" };

const sttProviderLabels: Record<SttProvider, string> = {
  none: "Aus",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  deepgram: "Deepgram",
  "whisper-cpp": "whisper.cpp (lokal)",
};

const ttsProviderLabels: Record<TtsProvider, string> = {
  none: "Aus",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  piper: "Piper (lokal)",
};

type OptionFieldDefinition = { key: string; label: string; placeholder?: string };

const sttOptionFields: Record<SttProvider, OptionFieldDefinition[]> = {
  none: [],
  openai: [{ key: "openaiSttModel", label: "Modell", placeholder: "gpt-4o-transcribe" }],
  elevenlabs: [{ key: "elevenlabsSttModel", label: "Modell", placeholder: "scribe_v1" }],
  deepgram: [{ key: "deepgramModel", label: "Modell", placeholder: "nova-3" }],
  "whisper-cpp": [
    { key: "whisperBinary", label: "Programm", placeholder: "whisper-cli" },
    { key: "whisperModelPath", label: "Modelldatei", placeholder: "/pfad/ggml-base.bin" },
  ],
};

const ttsOptionFields: Record<TtsProvider, OptionFieldDefinition[]> = {
  none: [],
  openai: [
    { key: "openaiTtsModel", label: "Modell", placeholder: "gpt-4o-mini-tts" },
    { key: "openaiVoice", label: "Stimme", placeholder: "alloy" },
  ],
  elevenlabs: [
    { key: "elevenlabsTtsModel", label: "Modell", placeholder: "eleven_multilingual_v2" },
    { key: "elevenlabsVoiceId", label: "Voice-ID" },
  ],
  piper: [
    { key: "piperBinary", label: "Programm", placeholder: "piper" },
    { key: "piperModelPath", label: "Stimmdatei", placeholder: "/pfad/de_DE-thorsten-medium.onnx" },
  ],
};

const secretKeyByProvider: Partial<Record<SttProvider | TtsProvider, VoiceSecretKey>> = {
  openai: "openaiApiKey",
  elevenlabs: "elevenlabsApiKey",
  deepgram: "deepgramApiKey",
};

const secretLabels: Record<VoiceSecretKey, string> = {
  openaiApiKey: "OpenAI API-Key",
  elevenlabsApiKey: "ElevenLabs API-Key",
  deepgramApiKey: "Deepgram API-Key",
};

const defaultVoiceSettings: VoiceSettings = { sttProvider: "none", ttsProvider: "none", language: "de", options: {} };

export function SettingsDialog(props: SettingsDialogProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [coreUrl, setCoreUrl] = useState(safeStorage.getItem("harnold.coreUrl") ?? "");
  const [accessToken, setAccessToken] = useState(safeStorage.getItem("harnold.token") ?? "");
  const [voiceDraft, setVoiceDraft] = useState<VoiceSettings>(defaultVoiceSettings);
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<VoiceSecretKey, string>>>({});
  const [savingVoice, setSavingVoice] = useState(false);
  const [imageSettingsView, setImageSettingsView] = useState<ImageSettingsView | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageSettings>({ provider: "none", geminiModel: "", openaiModel: "" });
  const [imageKeyDraft, setImageKeyDraft] = useState("");
  const [savingImages, setSavingImages] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setImageKeyDraft("");
    api
      .readImageSettings()
      .then((loadedSettings) => {
        setImageSettingsView(loadedSettings);
        setImageDraft({ provider: loadedSettings.provider, geminiModel: loadedSettings.geminiModel, openaiModel: loadedSettings.openaiModel });
      })
      .catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const saveImages = async () => {
    setSavingImages(true);
    try {
      const secretKey = imageDraft.provider === "gemini" ? "geminiApiKey" : "openaiApiKey";
      setImageSettingsView(await api.saveImageSettings(imageDraft, imageKeyDraft ? { [secretKey]: imageKeyDraft } : {}));
      props.onOpenChange(false);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSavingImages(false);
    }
  };

  useEffect(() => {
    if (!props.open || !props.voiceSettings) return;
    const { sttProvider, ttsProvider, language, options } = props.voiceSettings;
    setVoiceDraft({ sttProvider, ttsProvider, language, options: { ...options } });
    setSecretDrafts({});
  }, [props.open, props.voiceSettings]);

  const saveWorkspaceConnection = () => {
    if (coreUrl.trim()) safeStorage.setItem("harnold.coreUrl", coreUrl.trim().replace(/\/+$/, ""));
    else safeStorage.removeItem("harnold.coreUrl");
    if (accessToken.trim()) safeStorage.setItem("harnold.token", accessToken.trim());
    else safeStorage.removeItem("harnold.token");
    window.location.reload();
  };

  const saveVoice = async () => {
    setSavingVoice(true);
    try {
      props.onVoiceSettingsChange(await api.saveVoiceSettings(voiceDraft, secretDrafts));
      props.onOpenChange(false);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSavingVoice(false);
    }
  };

  const updateOption = (optionKey: string, optionValue: string) =>
    setVoiceDraft((previous) => ({ ...previous, options: { ...previous.options, [optionKey]: optionValue } }));

  const neededSecretKeys = [...new Set([secretKeyByProvider[voiceDraft.sttProvider], secretKeyByProvider[voiceDraft.ttsProvider]])].filter(
    (secretKey): secretKey is VoiceSecretKey => Boolean(secretKey),
  );
  const usesLocalProvider = voiceDraft.sttProvider === "whisper-cpp" || voiceDraft.ttsProvider === "piper";

  const renderOptionFields = (optionFields: OptionFieldDefinition[]) =>
    optionFields.map((optionField) => (
      <FormField key={optionField.key} label={optionField.label}>
        <Input value={voiceDraft.options[optionField.key] ?? ""} placeholder={optionField.placeholder} onChange={(changeEvent) => updateOption(optionField.key, changeEvent.target.value)} />
      </FormField>
    ));

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Einstellungen</DialogTitle>
          <DialogDescription>
            {settingsTab === "general"
              ? "Darstellung und Verbindung zum Workspace."
              : settingsTab === "voice"
                ? "Spracherkennung und Sprachausgabe für App und Channels."
                : "Bild-Generierung im Canvas und für den Agent."}
          </DialogDescription>
        </DialogHeader>

        <SegmentedControl
          options={[
            { value: "general", label: "Allgemein" },
            { value: "voice", label: "Voice" },
            { value: "images", label: "Bilder" },
          ]}
          value={settingsTab}
          onValueChange={setSettingsTab}
        />

        {settingsTab === "general" ? (
          <div key="general" className="grid animate-in gap-5 fade-in duration-200">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">Erscheinungsbild</span>
              <Select value={props.themePreference} onValueChange={(value) => props.onThemePreferenceChange(value as ThemePreference)}>
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Hell</SelectItem>
                  <SelectItem value="dark">Dunkel</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <span className="text-sm">Workspace</span>
              <Input placeholder="Core-Adresse (leer = lokal)" value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} />
              <Input type="password" placeholder="Zugriffstoken" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} />
            </div>
          </div>
        ) : settingsTab === "images" ? (
          <div key="images" className="grid animate-in gap-4 fade-in duration-200">
            <FormField label="Anbieter">
              <Select value={imageDraft.provider} onValueChange={(value) => setImageDraft((previous) => ({ ...previous, provider: value as ImageProvider }))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(imageProviderLabels).map(([providerValue, providerLabel]) => (
                    <SelectItem key={providerValue} value={providerValue}>
                      {providerLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {imageDraft.provider !== "none" && (
              <>
                <FormField label="Modell" hint="Leer = Standard.">
                  <Input
                    value={imageDraft.provider === "gemini" ? imageDraft.geminiModel : imageDraft.openaiModel}
                    placeholder={imageSettingsView?.defaultModels[imageDraft.provider]}
                    onChange={(changeEvent) =>
                      setImageDraft((previous) => ({ ...previous, [imageDraft.provider === "gemini" ? "geminiModel" : "openaiModel"]: changeEvent.target.value }))
                    }
                  />
                </FormField>
                <FormField
                  label={imageDraft.provider === "gemini" ? "Gemini API-Key" : "OpenAI API-Key"}
                  hint={imageDraft.provider === "gemini" ? "Alternativ Umgebungsvariable GEMINI_API_KEY." : "Leer = Key aus den Voice-Einstellungen."}
                >
                  <Input
                    type="password"
                    value={imageKeyDraft}
                    placeholder={imageSettingsView?.secretsSet[imageDraft.provider === "gemini" ? "geminiApiKey" : "openaiApiKey"] ? "gespeichert – leer lassen zum Behalten" : ""}
                    onChange={(changeEvent) => setImageKeyDraft(changeEvent.target.value)}
                  />
                </FormField>
              </>
            )}
          </div>
        ) : (
          <div key="voice" className="grid max-h-[60vh] animate-in gap-4 overflow-y-auto pr-1 fade-in duration-200">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Spracherkennung">
                <Select value={voiceDraft.sttProvider} onValueChange={(value) => setVoiceDraft((previous) => ({ ...previous, sttProvider: value as SttProvider }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(sttProviderLabels).map(([providerValue, providerLabel]) => (
                      <SelectItem key={providerValue} value={providerValue}>
                        {providerLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Sprachausgabe">
                <Select value={voiceDraft.ttsProvider} onValueChange={(value) => setVoiceDraft((previous) => ({ ...previous, ttsProvider: value as TtsProvider }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ttsProviderLabels).map(([providerValue, providerLabel]) => (
                      <SelectItem key={providerValue} value={providerValue}>
                        {providerLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label="Sprache" hint="ISO-Code, z. B. de oder en. Leer = automatisch.">
              <Input value={voiceDraft.language} onChange={(changeEvent) => setVoiceDraft((previous) => ({ ...previous, language: changeEvent.target.value }))} />
            </FormField>

            {neededSecretKeys.map((secretKey) => (
              <FormField key={secretKey} label={secretLabels[secretKey]}>
                <Input
                  type="password"
                  value={secretDrafts[secretKey] ?? ""}
                  placeholder={props.voiceSettings?.secretsSet[secretKey] ? "gespeichert – leer lassen zum Behalten" : ""}
                  onChange={(changeEvent) => setSecretDrafts((previous) => ({ ...previous, [secretKey]: changeEvent.target.value }))}
                />
              </FormField>
            ))}

            {renderOptionFields(sttOptionFields[voiceDraft.sttProvider])}
            {renderOptionFields(ttsOptionFields[voiceDraft.ttsProvider])}

            {usesLocalProvider && (
              <FormField label="ffmpeg" hint="Lokale Provider brauchen ffmpeg für die Umwandlung.">
                <Input value={voiceDraft.options.ffmpegBinary ?? ""} placeholder="ffmpeg" onChange={(changeEvent) => updateOption("ffmpegBinary", changeEvent.target.value)} />
              </FormField>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Schließen
          </Button>
          {settingsTab === "general" ? (
            <Button onClick={saveWorkspaceConnection}>Verbinden</Button>
          ) : settingsTab === "images" ? (
            <Button disabled={savingImages} onClick={() => void saveImages()}>
              Speichern
            </Button>
          ) : (
            <Button disabled={savingVoice} onClick={() => void saveVoice()}>
              Speichern
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
