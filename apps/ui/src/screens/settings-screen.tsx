import { useEffect, useState } from "react";
import type { AgentBackendsView, AgentRoleSettings, ClaudeAuthStatus, CodexStatus, ProvidersView, ImageProvider, ImageSettings, ImageSettingsView, SttProvider, TtsProvider, VoiceSecretKey, VoiceSettings, VoiceSettingsView } from "@/types";
import { api } from "@/api";
import { Brain, Image as ImageIcon, Keyboard, Loader2, Mic, SlidersHorizontal, Sparkles } from "lucide-react";
import { AgentConnection } from "@/components/agent-connection";
import { cn } from "@/lib/utils";
import { ScreenLayout } from "./screen-layout";
import { MemorySettingsSection } from "./settings/memory-settings-section";
import { QuickChatAutoDeleteSetting } from "./settings/quick-chat-settings";
import { ShortcutsSection } from "./settings/shortcuts-section";
import { AgentRolesSection } from "./settings/agent-roles-section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/form-field";
import { safeStorage } from "@/lib/storage";
import type { ThemePreference } from "@/hooks/use-theme";
import { AppVersionSetting } from "@/screens/settings/app-version-setting";
import { currentLanguage, languages, setLanguage, t, type Language } from "@/lib/i18n";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";

export type SettingsSection = "claude" | "general" | "voice" | "images" | "memory" | "shortcuts";
export const settingsSectionNames: SettingsSection[] = ["claude", "general", "shortcuts", "voice", "images", "memory"];

type SettingsScreenProps = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  themePreference: ThemePreference;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  voiceSettings: VoiceSettingsView | null;
  onVoiceSettingsChange: (voiceSettings: VoiceSettingsView) => void;
  claudeStatus: ClaudeAuthStatus | null;
  providers: ProvidersView | null;
  backends: AgentBackendsView | null;
  codex: CodexStatus | null;
  onBackendsChange: (backends: AgentBackendsView) => void;
  onCodexChange: (codex: CodexStatus) => void;
  onProvidersChange: (providers: ProvidersView) => void;
  defaultModel: string;
  onDefaultModelChange: (defaultModel: string) => void;
  onAgentRolesChange: (roles: AgentRoleSettings) => void;
  onClaudeStatusChange: (claudeStatus: ClaudeAuthStatus) => void;
  onError: (unknownError: unknown) => void;
};

const settingsSections: { value: SettingsSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "claude", label: t("Agent"), icon: Sparkles },
  { value: "general", label: t("Allgemein"), icon: SlidersHorizontal },
  { value: "shortcuts", label: t("Tastenkürzel"), icon: Keyboard },
  { value: "voice", label: t("Voice"), icon: Mic },
  { value: "images", label: t("Bilder"), icon: ImageIcon },
  { value: "memory", label: t("Memory"), icon: Brain },
];

const imageProviderLabels: Record<ImageProvider, string> = { none: t("Aus"), gemini: t("Google Gemini"), openai: "OpenAI" };

const sttProviderLabels: Record<SttProvider, string> = {
  none: t("Aus"),
  system: t("System (kostenlos, nur Eingabe in der App)"),
  openai: "OpenAI",
  elevenlabs: t("ElevenLabs"),
  deepgram: t("Deepgram"),
  "whisper-cpp": t("whisper.cpp (lokal)"),
};

const ttsProviderLabels: Record<TtsProvider, string> = {
  none: t("Aus"),
  openai: "OpenAI",
  elevenlabs: t("ElevenLabs"),
  piper: t("Piper (lokal)"),
};

type OptionFieldDefinition = { key: string; label: string; placeholder?: string };

const sttOptionFields: Record<SttProvider, OptionFieldDefinition[]> = {
  none: [],
  system: [],
  openai: [{ key: "openaiSttModel", label: t("Modell"), placeholder: "gpt-4o-transcribe" }],
  elevenlabs: [{ key: "elevenlabsSttModel", label: t("Modell"), placeholder: "scribe_v1" }],
  deepgram: [{ key: "deepgramModel", label: t("Modell"), placeholder: "nova-3" }],
  "whisper-cpp": [
    { key: "whisperBinary", label: t("Programm"), placeholder: "whisper-cli" },
    { key: "whisperModelPath", label: t("Modelldatei"), placeholder: "/pfad/ggml-base.bin" },
  ],
};

const ttsOptionFields: Record<TtsProvider, OptionFieldDefinition[]> = {
  none: [],
  openai: [
    { key: "openaiTtsModel", label: t("Modell"), placeholder: "gpt-4o-mini-tts" },
    { key: "openaiVoice", label: t("Stimme"), placeholder: "alloy" },
  ],
  elevenlabs: [
    { key: "elevenlabsTtsModel", label: t("Modell"), placeholder: "eleven_multilingual_v2" },
    { key: "elevenlabsVoiceId", label: "Voice-ID" },
  ],
  piper: [
    { key: "piperBinary", label: t("Programm"), placeholder: "piper" },
    { key: "piperModelPath", label: t("Stimmdatei"), placeholder: "/pfad/de_DE-thorsten-medium.onnx" },
  ],
};

const secretKeyByProvider: Partial<Record<SttProvider | TtsProvider, VoiceSecretKey>> = {
  openai: "openaiApiKey",
  elevenlabs: "elevenlabsApiKey",
  deepgram: "deepgramApiKey",
};

const secretLabels: Record<VoiceSecretKey, string> = {
  openaiApiKey: t("OpenAI API-Key"),
  elevenlabsApiKey: t("ElevenLabs API-Key"),
  deepgramApiKey: t("Deepgram API-Key"),
};

const defaultVoiceSettings: VoiceSettings = { sttProvider: "none", ttsProvider: "none", language: "de", options: {} };

export function SettingsScreen(props: SettingsScreenProps) {
  const [coreUrl, setCoreUrl] = useState(safeStorage.getItem("harnold.coreUrl") ?? "");
  const [accessToken, setAccessToken] = useState(safeStorage.getItem("harnold.token") ?? "");
  const [voiceDraft, setVoiceDraft] = useState<VoiceSettings>(defaultVoiceSettings);
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<VoiceSecretKey, string>>>({});
  const [savingVoice, setSavingVoice] = useState(false);
  const [imageSettingsView, setImageSettingsView] = useState<ImageSettingsView | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageSettings>({ provider: "none", geminiModel: "", openaiModel: "" });
  const [imageKeyDraft, setImageKeyDraft] = useState("");
  const [savingImages, setSavingImages] = useState(false);
  const imagesSaved = useSavedFlash();
  const voiceSaved = useSavedFlash();

  useEffect(() => {
    setImageKeyDraft("");
    api
      .readImageSettings()
      .then((loadedSettings) => {
        setImageSettingsView(loadedSettings);
        // Show the model that is actually used – never an empty "Standard".
        setImageDraft({
          provider: loadedSettings.provider,
          geminiModel: loadedSettings.geminiModel || loadedSettings.defaultModels.gemini,
          openaiModel: loadedSettings.openaiModel || loadedSettings.defaultModels.openai,
        });
      })
      .catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveImages = async () => {
    setSavingImages(true);
    try {
      const secretKey = imageDraft.provider === "gemini" ? "geminiApiKey" : "openaiApiKey";
      setImageSettingsView(await api.saveImageSettings(imageDraft, imageKeyDraft ? { [secretKey]: imageKeyDraft } : {}));
      setImageKeyDraft("");
      imagesSaved.flashSaved();
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSavingImages(false);
    }
  };

  useEffect(() => {
    if (!props.voiceSettings) return;
    const { sttProvider, ttsProvider, language, options } = props.voiceSettings;
    setVoiceDraft({ sttProvider, ttsProvider, language, options: { ...options } });
    setSecretDrafts({});
  }, [props.voiceSettings]);

  const saveWorkspaceConnection = async () => {
    const trimmedToken = accessToken.trim();
    let address = coreUrl.trim().replace(/\/+$/, "");
    // A bare host name would otherwise be treated as a path on this Core.
    if (address && !/^https?:\/\//i.test(address)) address = `https://${address}`;
    if (address) {
      // Check first, so a wrong address or token shows a clear message instead of a broken app after the reload.
      try {
        const response = await fetch(`${address}/api/auth/check`, { headers: trimmedToken ? { authorization: `Bearer ${trimmedToken}` } : {} });
        if (response.status === 401) return props.onError(new Error(t("Das Zugriffstoken stimmt nicht.")));
        if (!response.ok) return props.onError(new Error(t("Der Server antwortet mit Fehler {0}. Läuft dort Harnold in der aktuellen Version?", response.status)));
      } catch {
        return props.onError(new Error(t("Keine Verbindung zu {0}. Adresse, Zertifikat und Netzwerk prüfen; der Server braucht die aktuelle Harnold-Version.", address)));
      }
      safeStorage.setItem("harnold.coreUrl", address);
    } else safeStorage.removeItem("harnold.coreUrl");
    if (trimmedToken) safeStorage.setItem("harnold.token", trimmedToken);
    else safeStorage.removeItem("harnold.token");
    window.location.reload();
  };

  const saveVoice = async () => {
    setSavingVoice(true);
    try {
      props.onVoiceSettingsChange(await api.saveVoiceSettings(voiceDraft, secretDrafts));
      voiceSaved.flashSaved();
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

  const activeSection = settingsSections.find((sectionEntry) => sectionEntry.value === props.section) ?? settingsSections[0];

  return (
    <ScreenLayout title={t("Einstellungen")}>
      <div className="flex h-full min-h-0">
        <nav className="w-56 shrink-0 space-y-0.5 border-r p-2">
          {settingsSections.map((sectionEntry) => (
            <button
              key={sectionEntry.value}
              onClick={() => props.onSectionChange(sectionEntry.value)}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150",
                sectionEntry.value === activeSection.value ? "bg-foreground/[0.07] font-medium" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )}
            >
              <sectionEntry.icon className="size-4" />
              {sectionEntry.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div key={activeSection.value} className="mx-auto max-w-xl animate-in px-6 py-6 fade-in duration-200">
            <h2 className="mb-5 text-[15px] font-semibold">{activeSection.label}</h2>
            {activeSection.value === "claude" ? (
              <div className="grid gap-6">
                <AgentConnection
                  backends={props.backends}
                  codex={props.codex}
                  claudeStatus={props.claudeStatus}
                  providers={props.providers}
                  onBackendsChange={props.onBackendsChange}
                  onCodexChange={props.onCodexChange}
                  onClaudeStatusChange={props.onClaudeStatusChange}
                  onProvidersChange={props.onProvidersChange}
                  onDefaultModelChange={props.onDefaultModelChange}
                  onError={props.onError}
                />
                <AgentRolesSection onRolesChange={props.onAgentRolesChange} onError={props.onError} />
              </div>
            ) : activeSection.value === "general" ? (
          <div key="general" className="grid animate-in gap-5 fade-in duration-200">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">{t("Erscheinungsbild")}</span>
              <Select value={props.themePreference} onValueChange={(value) => props.onThemePreferenceChange(value as ThemePreference)}>
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("System")}</SelectItem>
                  <SelectItem value="light">{t("Hell")}</SelectItem>
                  <SelectItem value="dark">{t("Dunkel")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">{t("Sprache")}</span>
              <Select value={currentLanguage} onValueChange={(value) => void api.saveLanguage(value as Language).catch(() => undefined).finally(() => setLanguage(value as Language))}>
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((language) => (
                    <SelectItem key={language.value} value={language.value}>
                      {language.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <QuickChatAutoDeleteSetting onError={props.onError} />
            <AppVersionSetting />

            <div className="grid gap-2">
              <span className="text-sm">{t("Workspace")}</span>
              <Input placeholder={t("Core-Adresse, z. B. https://harnold.meinserver.de")} value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} />
              <Input type="password" placeholder={t("Zugriffstoken")} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} />
            </div>
            <div>
              <Button size="sm" onClick={() => void saveWorkspaceConnection()}>{t("Verbinden")}</Button>
            </div>
          </div>
            ) : activeSection.value === "shortcuts" ? (
              <ShortcutsSection />
            ) : activeSection.value === "images" ? (
          <div key="images" className="grid animate-in gap-4 fade-in duration-200">
            <FormField label={t("Anbieter")}>
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
                <FormField label={t("Modell")}>
                  <Input
                    value={imageDraft.provider === "gemini" ? imageDraft.geminiModel : imageDraft.openaiModel}
                    placeholder={imageSettingsView?.defaultModels[imageDraft.provider]}
                    onChange={(changeEvent) =>
                      setImageDraft((previous) => ({ ...previous, [imageDraft.provider === "gemini" ? "geminiModel" : "openaiModel"]: changeEvent.target.value }))
                    }
                  />
                </FormField>
                <FormField
                  label={imageDraft.provider === "gemini" ? t("Gemini API-Key") : t("OpenAI API-Key")}
                  hint={imageDraft.provider === "openai" && !imageSettingsView?.secretsSet.openaiApiKey ? t("Leer = OpenAI-Key aus Voice") : undefined}
                >
                  <Input
                    type="password"
                    value={imageKeyDraft}
                    placeholder={imageSettingsView?.secretsSet[imageDraft.provider === "gemini" ? "geminiApiKey" : "openaiApiKey"] ? t("gespeichert – leer lassen zum Behalten") : ""}
                    onChange={(changeEvent) => setImageKeyDraft(changeEvent.target.value)}
                  />
                </FormField>
              </>
            )}
            <div>
              <Button size="sm" disabled={savingImages} onClick={() => void saveImages()}>
                {savingImages && <Loader2 className="size-3.5 animate-spin" />}
                {t("Speichern")}
                <SavedCheck saved={imagesSaved.saved} />
              </Button>
            </div>
          </div>
            ) : activeSection.value === "voice" ? (
          <div key="voice" className="grid animate-in gap-4 fade-in duration-200">
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("Spracherkennung")}>
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
              <FormField label={t("Sprachausgabe")}>
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

            <FormField label={t("Sprache")}>
              <Input value={voiceDraft.language} placeholder={t("automatisch erkennen")} onChange={(changeEvent) => setVoiceDraft((previous) => ({ ...previous, language: changeEvent.target.value }))} />
            </FormField>

            {neededSecretKeys.map((secretKey) => (
              <FormField key={secretKey} label={secretLabels[secretKey]}>
                <Input
                  type="password"
                  value={secretDrafts[secretKey] ?? ""}
                  placeholder={props.voiceSettings?.secretsSet[secretKey] ? t("gespeichert – leer lassen zum Behalten") : ""}
                  onChange={(changeEvent) => setSecretDrafts((previous) => ({ ...previous, [secretKey]: changeEvent.target.value }))}
                />
              </FormField>
            ))}

            {renderOptionFields(sttOptionFields[voiceDraft.sttProvider])}
            {renderOptionFields(ttsOptionFields[voiceDraft.ttsProvider])}

            {usesLocalProvider && (
              <FormField label="ffmpeg">
                <Input value={voiceDraft.options.ffmpegBinary ?? ""} placeholder="ffmpeg" onChange={(changeEvent) => updateOption("ffmpegBinary", changeEvent.target.value)} />
              </FormField>
            )}
            <div>
              <Button size="sm" disabled={savingVoice} onClick={() => void saveVoice()}>
                {savingVoice && <Loader2 className="size-3.5 animate-spin" />}
                {t("Speichern")}
                <SavedCheck saved={voiceSaved.saved} />
              </Button>
            </div>
          </div>
            ) : (
              <MemorySettingsSection onError={props.onError} />
            )}
          </div>
        </div>
      </div>
    </ScreenLayout>
  );
}
