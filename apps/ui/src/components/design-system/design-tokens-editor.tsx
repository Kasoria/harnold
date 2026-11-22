import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import type { DesignSystemDetail, FlatToken, TokenTree } from "@/types";
import { cn, isActionEnter } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Loader2 } from "lucide-react";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";

type DesignTokensEditorProps = {
  designSystem: DesignSystemDetail;
  /** Light/dark switch is rendered by the parent. */
  mode: "base" | "dark";
  /** Bumps when files changed on disk (reloads component thumbnails). */
  reloadCounter: number;
  onSaved: (savedSystem: DesignSystemDetail) => void;
  onError: (unknownError: unknown) => void;
};

type SectionKey = "colors" | "typography" | "spacing" | "radius" | "shadow" | "other";

const sectionTitles: Record<SectionKey, string> = {
  colors: t("Farben"),
  typography: t("Typografie"),
  spacing: t("Abstände"),
  radius: t("Radien"),
  shadow: t("Schatten"),
  other: t("Weitere"),
};

function sectionOf(flatToken: FlatToken): SectionKey {
  const lowerPath = flatToken.path.toLowerCase();
  if (flatToken.type === "color") return "colors";
  if (flatToken.type === "shadow" || /shadow|elevation/.test(lowerPath)) return "shadow";
  if (/radius|radii|rounded/.test(lowerPath)) return "radius";
  if (flatToken.type === "fontFamily" || flatToken.type === "fontWeight" || /font|typography|text|line-height|letter/.test(lowerPath)) return "typography";
  if (/space|spacing|gap|size|inset/.test(lowerPath)) return "spacing";
  return "other";
}

/** Sets a value at a flat token path in the tree (or in `$modes[mode]`), keeping `$value` leaves intact. */
function setTokenValue(tokenTree: TokenTree, tokenPath: string, nextValue: string, mode: string | null): TokenTree {
  const nextTree = structuredClone(tokenTree);
  let targetTree = nextTree;
  if (mode) {
    const modes = (nextTree.$modes ??= {}) as Record<string, TokenTree>;
    targetTree = modes[mode] ??= {};
  }
  const pathSegments = tokenPath.split(".");
  let currentNode: Record<string, unknown> = targetTree;
  for (const pathSegment of pathSegments.slice(0, -1)) {
    let childNode = currentNode[pathSegment] as Record<string, unknown> | undefined;
    if (!childNode || typeof childNode !== "object") childNode = currentNode[pathSegment] = {};
    if ("$value" in childNode && childNode.$value && typeof childNode.$value === "object") childNode = childNode.$value as Record<string, unknown>;
    currentNode = childNode;
  }
  const leafKey = pathSegments.at(-1)!;
  const existingLeaf = currentNode[leafKey];
  const typedValue = typeof existingLeaf === "number" && /^-?\d*\.?\d+$/.test(nextValue) ? Number(nextValue) : nextValue;
  if (existingLeaf && typeof existingLeaf === "object" && "$value" in existingLeaf) (existingLeaf as Record<string, unknown>).$value = typedValue;
  else currentNode[leafKey] = typedValue;
  return nextTree;
}

const isHexColor = (value: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
const expandHex = (value: string) => (value.length === 4 ? `#${[...value.slice(1)].map((character) => character + character).join("")}` : value);
const tokenLabel = (flatToken: FlatToken) => flatToken.path.split(".").slice(1).join(".") || flatToken.path;

/** Text input that commits on blur / Enter (avoids a save per keystroke). */
function TokenValueInput(props: { value: string; muted?: boolean; onCommit: (value: string) => void; className?: string }) {
  const [draftValue, setDraftValue] = useState(props.value);
  useEffect(() => setDraftValue(props.value), [props.value]);
  const commit = () => draftValue !== props.value && props.onCommit(draftValue);
  return (
    <input
      value={draftValue}
      spellCheck={false}
      onChange={(changeEvent) => setDraftValue(changeEvent.target.value)}
      onBlur={commit}
      onKeyDown={(keyboardEvent) => {
        if (isActionEnter(keyboardEvent)) (keyboardEvent.target as HTMLInputElement).blur();
        if (keyboardEvent.key === "Escape") setDraftValue(props.value);
      }}
      className={cn(
        "w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] transition-colors duration-150 outline-none hover:border-border focus:border-ring focus:bg-background",
        props.muted && "text-muted-foreground",
        props.className,
      )}
    />
  );
}

function ColorTokenCard(props: { flatToken: FlatToken; inherited: boolean; onCommit: (value: string) => void }) {
  const [liveColor, setLiveColor] = useState<string | null>(null);
  const displayedColor = liveColor ?? props.flatToken.resolvedValue;
  const commitTimer = useRef<number | undefined>(undefined);
  useEffect(() => setLiveColor(null), [props.flatToken.resolvedValue]);
  const hexValue = isHexColor(props.flatToken.resolvedValue) ? expandHex(props.flatToken.resolvedValue) : null;

  return (
    <div className="group/token min-w-0">
      <label className="relative block h-16 cursor-pointer overflow-hidden rounded-lg border shadow-xs transition-shadow duration-150 hover:shadow-sm" style={{ background: displayedColor }}>
        {hexValue && (
          <input
            type="color"
            value={liveColor ?? hexValue}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            onChange={(changeEvent) => {
              const pickedColor = changeEvent.target.value;
              setLiveColor(pickedColor);
              window.clearTimeout(commitTimer.current);
              commitTimer.current = window.setTimeout(() => props.onCommit(pickedColor), 350);
            }}
            aria-label={t("Farbe {0}", props.flatToken.path)}
          />
        )}
      </label>
      <div className="mt-1.5 truncate px-0.5 text-[12px] font-medium" title={props.flatToken.cssVariable}>
        {tokenLabel(props.flatToken)}
      </div>
      <TokenValueInput value={props.flatToken.value} muted={props.inherited} onCommit={props.onCommit} className="-mx-0.5" />
    </div>
  );
}

function TokenPreview(props: { flatToken: FlatToken; section: SectionKey }) {
  const { resolvedValue } = props.flatToken;
  switch (props.section) {
    case "spacing":
      return (
        <div className="flex h-5 items-center">
          <div className="h-2.5 rounded-sm bg-foreground/70 transition-[width] duration-200" style={{ width: `min(${resolvedValue}, 100%)` }} />
        </div>
      );
    case "radius":
      return <div className="size-9 border-2 border-foreground/60 bg-muted transition-[border-radius] duration-200" style={{ borderRadius: resolvedValue }} />;
    case "shadow":
      return <div className="h-10 w-16 rounded-md bg-card transition-shadow duration-200" style={{ boxShadow: resolvedValue }} />;
    case "typography":
      if (props.flatToken.type === "fontFamily") return <span className="truncate text-[17px]" style={{ fontFamily: resolvedValue }}>{t("Aa Bb Cc 123")}</span>;
      if (props.flatToken.type === "fontWeight") return <span className="text-[16px]" style={{ fontWeight: Number(resolvedValue) || resolvedValue }}>{t("Gewicht")}</span>;
      if (/px|rem|em$/.test(resolvedValue)) return <span className="truncate leading-none" style={{ fontSize: `min(${resolvedValue}, 40px)` }}>{t("Aa")}</span>;
      return null;
    default:
      return null;
  }
}

/** Editable token sections + reference components of one design system. */
export function DesignTokensEditor(props: DesignTokensEditorProps) {
  const [designSystemData, setDesignSystemData] = useState<DesignSystemDetail>(props.designSystem);
  const pendingTreeRef = useRef<TokenTree | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const [savePending, setSavePending] = useState(false);
  const { saved, flashSaved } = useSavedFlash();
  const { onError } = props;
  const designSystemId = props.designSystem.id;

  useEffect(() => {
    if (!pendingTreeRef.current) setDesignSystemData(props.designSystem); // local edit in flight wins
  }, [props.designSystem]);

  const activeMode = props.mode;
  const hasDarkMode = Boolean(designSystemData.modeTokens.dark);
  const mode = activeMode === "dark" && hasDarkMode ? "dark" : null;

  /** Base tokens, with dark overrides merged in when the dark mode is shown. */
  const displayedTokens = useMemo(() => {
    const overridesByPath = new Map((mode ? designSystemData.modeTokens[mode] : []).map((flatToken) => [flatToken.path, flatToken]));
    const merged = designSystemData.flatTokens.map((flatToken) => ({ flatToken: overridesByPath.get(flatToken.path) ?? flatToken, inherited: Boolean(mode) && !overridesByPath.has(flatToken.path) }));
    const basePaths = new Set(designSystemData.flatTokens.map((flatToken) => flatToken.path));
    for (const [overridePath, overrideToken] of overridesByPath) if (!basePaths.has(overridePath)) merged.push({ flatToken: overrideToken, inherited: false });
    return merged;
  }, [designSystemData, mode]);

  const sections = useMemo(() => {
    const groupedTokens = new Map<SectionKey, typeof displayedTokens>();
    for (const displayedToken of displayedTokens) {
      const sectionKey = sectionOf(displayedToken.flatToken);
      groupedTokens.set(sectionKey, [...(groupedTokens.get(sectionKey) ?? []), displayedToken]);
    }
    return (Object.keys(sectionTitles) as SectionKey[]).flatMap((sectionKey) => (groupedTokens.has(sectionKey) ? [{ sectionKey, tokens: groupedTokens.get(sectionKey)! }] : []));
  }, [displayedTokens]);

  const commitToken = (tokenPath: string, nextValue: string) => {
    const nextTree = setTokenValue(pendingTreeRef.current ?? designSystemData.tokens, tokenPath, nextValue, mode);
    pendingTreeRef.current = nextTree;
    // Optimistic: show the raw value right away; the server response resolves references.
    setDesignSystemData((previous) => {
      const patchToken = (flatToken: FlatToken) => (flatToken.path === tokenPath ? { ...flatToken, value: nextValue, resolvedValue: nextValue.includes("{") ? flatToken.resolvedValue : nextValue } : flatToken);
      if (!mode) return { ...previous, tokens: nextTree, flatTokens: previous.flatTokens.map(patchToken) };
      const modeList = previous.modeTokens[mode] ?? [];
      const baseToken = previous.flatTokens.find((flatToken) => flatToken.path === tokenPath);
      const nextModeList = modeList.some((flatToken) => flatToken.path === tokenPath)
        ? modeList.map(patchToken)
        : baseToken
          ? [...modeList, { ...baseToken, value: nextValue, resolvedValue: nextValue }]
          : modeList;
      return { ...previous, tokens: nextTree, modeTokens: { ...previous.modeTokens, [mode]: nextModeList } };
    });
    window.clearTimeout(saveTimerRef.current);
    setSavePending(true);
    saveTimerRef.current = window.setTimeout(() => {
      const treeToSave = pendingTreeRef.current;
      if (!treeToSave) return;
      api
        .saveDesignTokens(designSystemId, treeToSave)
        .then((savedSystem) => {
          if (pendingTreeRef.current === treeToSave) {
            pendingTreeRef.current = null;
            setDesignSystemData(savedSystem);
            flashSaved();
            props.onSaved(savedSystem);
          }
          setSavePending(false);
        })
        .catch((saveError) => {
          pendingTreeRef.current = null;
          setSavePending(false);
          onError(saveError);
        });
    }, 300);
  };

  return (
    <div className="animate-in fade-in duration-200">
        {/* Auto-saved while editing: spinner while it writes, then a short green check. */}
        <div className="flex h-4 items-center justify-end gap-1.5 text-[11.5px] text-muted-foreground">
          {savePending ? (
            <>
              <Loader2 className="size-3 animate-spin" /> {t("Speichert …")}
            </>
          ) : (
            <SavedCheck saved={saved} />
          )}
        </div>
        {designSystemData.error && <p className="mt-3 rounded-lg border border-destructive/40 px-3 py-2 text-[12.5px] text-destructive">{designSystemData.error}</p>}
        {mode && <p className="mb-2 text-[12px] text-muted-foreground">{t("Grau = vom hellen Modus geerbt.")}</p>}

        {sections.map(({ sectionKey, tokens }) => (
          <section key={sectionKey} className="mt-7">
            <h3 className="mb-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{sectionTitles[sectionKey]}</h3>
            {sectionKey === "colors" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3 gap-y-4">
                {tokens.map(({ flatToken, inherited }) => (
                  <ColorTokenCard key={flatToken.path} flatToken={flatToken} inherited={inherited} onCommit={(nextValue) => commitToken(flatToken.path, nextValue)} />
                ))}
              </div>
            ) : (
              <div className="divide-y rounded-xl border">
                {tokens.map(({ flatToken, inherited }) => (
                  <div key={flatToken.path} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium">{flatToken.path}</div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">{flatToken.cssVariable}</div>
                    </div>
                    <div className="min-w-0 overflow-hidden">
                      <TokenPreview flatToken={flatToken} section={sectionKey} />
                    </div>
                    <TokenValueInput value={flatToken.value} muted={inherited} onCommit={(nextValue) => commitToken(flatToken.path, nextValue)} />
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}

        <section className="mt-7 pb-6">
          <h3 className="mb-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("Komponenten")}</h3>
          {designSystemData.components.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {t("Keine Komponenten in")} <code className="font-mono text-[12px]">components/</code>.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {designSystemData.components.map((component) => (
                <button
                  key={component.path}
                  className="group/component overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-shadow duration-150 hover:shadow-md"
                  onClick={() => window.open(api.designSystemFileUrl(designSystemId, component.path), "_blank", "noopener")}
                >
                  <div className="pointer-events-none relative h-32 overflow-hidden border-b bg-white">
                    {/\.html?$/i.test(component.path) ? (
                      <iframe
                        key={props.reloadCounter}
                        title={component.name}
                        tabIndex={-1}
                        sandbox="allow-scripts"
                        src={api.designSystemFileUrl(designSystemId, component.path)}
                        className="absolute top-0 left-0 h-[256px] w-[200%] origin-top-left scale-50"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center font-mono text-[12px] text-muted-foreground">{component.path.split(".").pop()}</div>
                    )}
                  </div>
                  <div className="px-3 py-2 text-[12.5px] font-medium">{component.name}</div>
                </button>
              ))}
            </div>
          )}
        </section>
    </div>
  );
}
