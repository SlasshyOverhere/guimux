import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  Keyboard,
  LayoutGrid,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal as TerminalIcon,
  Type,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { PREF, readPref, writePref } from "../uiPrefs";
import { UpdatesSection } from "./UpdatesSection";

// Settings is a page, not a dialog. It was a 400px card that scrolled past six
// controls, so nothing could be seen next to the thing it changed. It now owns
// the whole window below the topbar: a section rail on the left, one section
// at a time on the right, and enough width to preview a change while you make
// it. Everything applies immediately, so there is nothing to submit.

type SectionId = "appearance" | "text" | "terminal" | "keyboard" | "agents" | "updates";

const SECTIONS: { id: SectionId; label: string; blurb: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", blurb: "How much room the workbench takes", icon: <LayoutGrid size={14} strokeWidth={2} /> },
  { id: "text", label: "Text", blurb: "Type size in panes and the editor", icon: <Type size={14} strokeWidth={2} /> },
  { id: "terminal", label: "Terminal", blurb: "What a pane keeps and how it reads", icon: <TerminalIcon size={14} strokeWidth={2} /> },
  { id: "keyboard", label: "Keyboard", blurb: "Chords, and whose they are", icon: <Keyboard size={14} strokeWidth={2} /> },
  { id: "agents", label: "Agents", blurb: "CLI tools you can launch", icon: <Bot size={14} strokeWidth={2} /> },
  { id: "updates", label: "Updates", blurb: "Guimux releases", icon: <RefreshCw size={14} strokeWidth={2} /> },
];

const isSection = (v: unknown): SectionId | null =>
  typeof v === "string" && SECTIONS.some((s) => s.id === v) ? (v as SectionId) : null;

/** One preference: what it is, what it does, and a control. The reset button
 *  appears only while the value differs from the default, so the page shows
 *  what you changed without printing a third control on every row. */
function Field({
  label,
  hint,
  dirty,
  onReset,
  children,
}: {
  label: string;
  hint?: string;
  dirty?: boolean;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-6 border-b border-[color:var(--gm-hairline-soft)] py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-strong text-ink-100">{label}</div>
        {hint && <div className="gm-meta mt-1 max-w-[52ch] text-meta leading-5">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {children}
        {dirty && onReset && (
          <button
            className="gm-icon-btn gm-icon-btn--sm"
            title={`Restore the default (${label})`}
            aria-label={`Restore the default ${label}`}
            onClick={onReset}
          >
            <RotateCcw size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Slider plus a fixed-width readout, so digits do not shuffle the row. */
function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  label: string;
}) {
  return (
    <>
      <input
        type="range"
        className="w-[180px] accent-[color:var(--gm-accent)]"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className="tnum w-[64px] shrink-0 text-right text-body text-ink-300">
        {format(value)}
      </span>
    </>
  );
}

/**
 * Density preview: a miniature of the workbench itself — tab strip, two list
 * rows, a control — drawn from the same custom properties the real chrome
 * uses. Toggling the segmented control retunes this immediately, which is the
 * only honest way to choose a density.
 */
function DensityPreview() {
  return (
    <div className="mt-3 w-full max-w-[520px] overflow-hidden rounded-[var(--gm-r-card)] border border-[color:var(--gm-hairline)]">
      <div
        className="flex items-stretch border-b border-[color:var(--gm-hairline-soft)] bg-surface-panel"
        style={{ height: "var(--gm-tab-h)" }}
      >
        {["main", "feat-ledger"].map((b, i) => (
          <div
            key={b}
            className={`flex items-center gap-1.5 border-r border-[color:var(--gm-hairline-soft)] px-3 text-body ${
              i === 0 ? "bg-surface-canvas text-ink-100" : "text-ink-400"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: i === 0 ? "var(--gm-accent)" : "var(--gm-ink-mute)" }} />
            {b}
          </div>
        ))}
      </div>
      {[0, 1].map((i) => (
        <div
          key={i}
          className={`flex items-center gap-2 border-b border-[color:var(--gm-hairline-soft)] ${
            i === 0 ? "bg-[color:var(--gm-selected)]" : ""
          }`}
          style={{ padding: "var(--gm-row-y) 12px" }}
        >
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-[color:var(--gm-ink-mute)]" />
          <span className="mono text-body text-ink-200">{`worktree-${i + 1}`}</span>
          <span
            className="ml-auto rounded-[var(--gm-r-ctl)] bg-[color:var(--gm-hover)] px-2 text-label text-ink-400"
            style={{ height: "var(--gm-ctl-h)", display: "inline-flex", alignItems: "center" }}
          >
            Split
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Terminal preview. A pane's background, prompt colour and type size, drawn
 * from the same tokens xterm reads — so the number under the slider is the
 * number you will be typing at, not a promise about it.
 */
function TerminalPreview({ size }: { size: number }) {
  return (
    <div
      className="mono w-full max-w-[520px] overflow-hidden rounded-[var(--gm-r-card)] border border-[color:var(--gm-term-ring)] p-3.5 leading-[1.45]"
      style={{ background: "var(--gm-term)", fontSize: `${size}px` }}
    >
      <div>
        <span style={{ color: "var(--gm-green)" }}>guimux</span>
        <span className="text-ink-400">: main</span>
        <span className="text-ink-500">$ </span>
        <span className="text-ink-100">git status --short</span>
      </div>
      <div style={{ color: "var(--gm-amber)" }}> M src/App.tsx</div>
      <div style={{ color: "var(--gm-amber)" }}>?? src/keymap.ts</div>
      <div>
        <span style={{ color: "var(--gm-green)" }}>guimux</span>
        <span className="text-ink-400">: main</span>
        <span className="text-ink-500">$ </span>
        <span
          className="inline-block w-[7px] translate-y-[2px]"
          style={{ background: "var(--gm-ink)", animation: "none" }}
        />
      </div>
    </div>
  );
}

/** The chords a focused pane handles itself. Every row here is implemented in
 *  TerminalPane's custom key handler or the app keymap; a chord that is not
 *  wired does not belong in this table. */
const PANE_KEYS: { action: string; keys: string[]; note?: string }[] = [
  { action: "Paste", keys: ["Ctrl+V", "Ctrl+Shift+V", "Shift+Insert"], note: "or right-click" },
  { action: "Copy the selection", keys: ["Ctrl+C", "Ctrl+Shift+C"], note: "or right-click with a selection" },
  { action: "Delete the word to the left", keys: ["Ctrl+Backspace", "Ctrl+W"] },
  { action: "Resize this pane's text", keys: ["Ctrl++", "Ctrl+-", "Ctrl+0"] },
  { action: "Split below / right", keys: ["Ctrl+Shift+↓", "Ctrl+Shift+→"] },
  { action: "Focus the next pane", keys: ["Ctrl+Shift+↵"] },
  { action: "Maximize and restore", keys: ["Ctrl+Shift+M"] },
  { action: "Close the pane", keys: ["Ctrl+Shift+W"] },
  { action: "Open the command palette", keys: ["Ctrl+Shift+K"], note: "Ctrl+K belongs to the shell" },
];

const APP_KEYS: { action: string; keys: string[]; note?: string }[] = [
  { action: "Command palette", keys: ["Ctrl+K"] },
  { action: "Settings", keys: ["Ctrl+,"] },
  { action: "Go to worktree 1–9", keys: ["Ctrl+1", "…", "Ctrl+9"] },
  { action: "Next / previous worktree", keys: ["Ctrl+Alt+→", "Ctrl+Alt+←"] },
  { action: "New worktree", keys: ["Ctrl+Shift+N"] },
  { action: "Toggle the sidebar", keys: ["Ctrl+B"] },
  { action: "Toggle the file dock", keys: ["Ctrl+J"] },
  { action: "Zoom in / out / reset", keys: ["Ctrl++", "Ctrl+-", "Ctrl+0"] },
  { action: "Shortcut reference", keys: ["Ctrl+Shift+?"] },
];

function KeyTable({ rows }: { rows: typeof PANE_KEYS }) {
  return (
    <div className="overflow-hidden rounded-[var(--gm-r-card)] border border-[color:var(--gm-hairline)]">
      {rows.map((k, i) => (
        <div
          key={k.action}
          className={`flex items-center gap-4 px-3.5 py-2.5 ${
            i < rows.length - 1 ? "border-b border-[color:var(--gm-hairline-soft)]" : ""
          }`}
        >
          <span className="min-w-0 flex-1 text-body text-ink-200">{k.action}</span>
          <span className="flex shrink-0 items-center gap-1">
            {k.keys.map((c) => (
              <span key={c} className="gm-kbd">
                {c}
              </span>
            ))}
            {k.note && <span className="gm-meta ml-1.5 text-meta">{k.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function AgentEditor() {
  const agents = useStore((s) => s.settings.agents);
  const setSettings = useStore((s) => s.setSettings);
  const patch = (id: string, next: Partial<{ name: string; command: string; flags: string }>) =>
    setSettings({ agents: agents.map((a) => (a.id === id ? { ...a, ...next } : a)) });

  if (agents.length === 0) {
    return (
      <div className="gm-inset px-4 py-6 text-center">
        <div className="text-body text-ink-300">No agents yet</div>
        <div className="gm-meta mt-1 text-meta">
          An agent is a command guimux can launch into a split, like <span className="mono">claude</span> or{" "}
          <span className="mono">codex</span>.
        </div>
      </div>
    );
  }

  // Two columns: a page this wide should not stack three inputs in a line.
  return (
    <div className="grid grid-cols-2 gap-3">
      {agents.map((a) => (
        <div key={a.id} className="gm-inset p-3">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 bg-transparent text-strong text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Name"
              value={a.name}
              onChange={(e) => patch(a.id, { name: e.target.value })}
              aria-label="Agent name"
            />
            <button
              className="gm-icon-btn gm-icon-btn--sm gm-icon-btn--danger shrink-0"
              title={`Remove ${a.name || "agent"}`}
              aria-label={`Remove ${a.name || "agent"}`}
              onClick={() => setSettings({ agents: agents.filter((x) => x.id !== a.id) })}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
          <label className="mt-3 block">
            <span className="gm-sect">Command</span>
            <input
              className="gm-field mono mt-1 px-2 py-1.5 text-body"
              placeholder="claude"
              value={a.command}
              onChange={(e) => patch(a.id, { command: e.target.value })}
              aria-label={`${a.name || "Agent"} launch command`}
            />
          </label>
          <label className="mt-2.5 block">
            <span className="gm-sect">Default flags</span>
            <input
              className="gm-field mono mt-1 px-2 py-1.5 text-body"
              placeholder="--dangerously-skip-permissions"
              value={a.flags}
              onChange={(e) => patch(a.id, { flags: e.target.value })}
              aria-label={`${a.name || "Agent"} default flags`}
            />
          </label>
        </div>
      ))}
    </div>
  );
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  // Remembered so reopening settings lands where you left off.
  const [section, setSection] = useState<SectionId>(() =>
    readPref<SectionId>(PREF.settingsSection, "appearance", isSection),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const go = (id: SectionId) => {
    setSection(id);
    writePref(PREF.settingsSection, id);
  };
  // Agents are the user's data, not a preference: "reset" must not delete a
  // list they typed. Everything else is a knob with a documented default.
  const resetPreferences = () => {
    const { agents: _keep, ...prefs } = DEFAULT_SETTINGS;
    setSettings(prefs as Partial<Settings>);
  };
  const differs = (key: keyof Settings, current: unknown) =>
    current !== DEFAULT_SETTINGS[key]
      ? () => setSettings({ [key]: DEFAULT_SETTINGS[key] } as Partial<Settings>)
      : undefined;

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1 bg-surface-canvas">
      {/* Section rail. A page this size needs somewhere to put its table of
          contents; a scrolling card had nowhere to put six headings. */}
      <nav
        className="gm-divider-r flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-surface-panel p-3"
        aria-label="Settings sections"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className="gm-item"
            data-selected={s.id === section}
            aria-current={s.id === section}
            onClick={() => go(s.id)}
          >
            <span className="shrink-0 text-ink-400">{s.icon}</span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button
          className="gm-item"
          onClick={resetPreferences}
          title="Restore every preference below. Your agents are kept."
        >
          <span className="shrink-0 text-ink-400">
            <RotateCcw size={14} strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1 truncate">Reset preferences</span>
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="gm-rule flex h-14 shrink-0 items-center gap-4 px-6">
          <div className="min-w-0">
            <div className="text-title font-semibold text-ink-100">{current.label}</div>
            <div className="gm-meta mt-0.5 text-meta">{current.blurb}</div>
          </div>
          <div className="flex-1" />
          <button className="gm-btn px-4 py-1.5 text-body" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
          <div className="max-w-[680px] pb-8">
            {section === "appearance" && (
              <>
                <Field
                  label="Density"
                  hint="Row height, control height and type size across the workbench. The preview below is drawn from the same values the app uses."
                  dirty={settings.density !== DEFAULT_SETTINGS.density}
                  onReset={differs("density", settings.density)}
                >
                  <div className="gm-seg" role="radiogroup" aria-label="Density">
                    {(["comfortable", "compact"] as const).map((d) => (
                      <button
                        key={d}
                        role="radio"
                        aria-checked={settings.density === d}
                        data-active={String(settings.density === d)}
                        onClick={() => setSettings({ density: d })}
                      >
                        {d === "comfortable" ? "Comfortable" : "Compact"}
                      </button>
                    ))}
                  </div>
                </Field>
                <DensityPreview />
                <div className="mt-2">
                  <Field
                    label="Interface zoom"
                    hint="Scales the whole window, chrome included. Panes refit themselves as you drag."
                    dirty={settings.uiZoom !== DEFAULT_SETTINGS.uiZoom}
                    onReset={differs("uiZoom", settings.uiZoom)}
                  >
                    <Slider
                      label="Interface zoom"
                      value={Math.round(settings.uiZoom * 100)}
                      min={50}
                      max={200}
                      step={5}
                      format={(v) => `${v}%`}
                      onChange={(uiZoom) => setSettings({ uiZoom: uiZoom / 100 })}
                    />
                  </Field>
                </div>
              </>
            )}

            {section === "text" && (
              <>
                <Field
                  label="Terminal text"
                  hint="Applies to every pane. Ctrl++ and Ctrl+- change it while a pane is focused."
                  dirty={settings.terminalFontSize !== DEFAULT_SETTINGS.terminalFontSize}
                  onReset={differs("terminalFontSize", settings.terminalFontSize)}
                >
                  <Slider
                    label="Terminal text size"
                    value={settings.terminalFontSize}
                    min={10}
                    max={24}
                    step={1}
                    format={(v) => `${v}px`}
                    onChange={(terminalFontSize) => setSettings({ terminalFontSize })}
                  />
                </Field>
                <TerminalPreview size={settings.terminalFontSize} />
                <div className="mt-2">
                  <Field
                    label="Editor text"
                    hint="Applies to the file editor in the dock."
                    dirty={settings.editorFontSize !== DEFAULT_SETTINGS.editorFontSize}
                    onReset={differs("editorFontSize", settings.editorFontSize)}
                  >
                    <Slider
                      label="Editor text size"
                      value={settings.editorFontSize}
                      min={10}
                      max={24}
                      step={1}
                      format={(v) => `${v}px`}
                      onChange={(editorFontSize) => setSettings({ editorFontSize })}
                    />
                  </Field>
                </div>
                <div
                  className="mt-2 max-w-[520px] rounded-[var(--gm-r-card)] border border-[color:var(--gm-hairline)] p-3.5 leading-[1.5]"
                  style={{ fontSize: `${settings.editorFontSize}px` }}
                >
                  <div className="mono text-ink-500">{"// editor.tsx"}</div>
                  <div className="mono text-ink-200">
                    <span style={{ color: "var(--gm-accent)" }}>export function</span>{" "}
                    <span style={{ color: "var(--gm-green)" }}>EditorPane</span>
                    <span className="text-ink-400">({'{'} root {':'}</span>
                    <span style={{ color: "var(--gm-amber)" }}>string</span>
                    <span className="text-ink-400"> {'}'}) {'{'}</span>
                  </div>
                  <div className="mono text-ink-400">{"  return <Monaco theme=\"dark\" />;"}</div>
                  <div className="mono text-ink-400">{"}"}</div>
                </div>
              </>
            )}

            {section === "terminal" && (
              <Field
                label="Scrollback"
                hint="Lines kept per pane, and reloaded from disk when you come back to a worktree. More history costs memory and slows the first paint after a restart."
                dirty={settings.scrollback !== DEFAULT_SETTINGS.scrollback}
                onReset={differs("scrollback", settings.scrollback)}
              >
                <Slider
                  label="Terminal scrollback lines"
                  value={settings.scrollback}
                  min={1000}
                  max={50000}
                  step={1000}
                  format={(v) => v.toLocaleString()}
                  onChange={(scrollback) => setSettings({ scrollback })}
                />
              </Field>
            )}

            {section === "keyboard" && (
              <>
                <div className="gm-sect pb-2 pt-3">Inside a focused pane</div>
                <KeyTable rows={PANE_KEYS} />
                <p className="gm-meta mt-3 max-w-[60ch] text-meta leading-5">
                  Everything else in a pane belongs to the shell. Guimux only takes a chord where
                  the terminal cannot deliver it, which is why the palette is Ctrl+Shift+K from
                  inside a pane and plain Ctrl+K outside one.
                </p>
                <div className="gm-sect pb-2 pt-6">Anywhere in the window</div>
                <KeyTable rows={APP_KEYS} />
                <p className="gm-meta mt-3 max-w-[60ch] text-meta leading-5">
                  Worktrees are addressed by the order they appear in the tab strip, so Ctrl+2 is
                  always the second tab. Ctrl+Shift+? reopens this list.
                </p>
              </>
            )}

            {section === "agents" && (
              <>
                <div className="mb-3 flex items-center gap-3 pt-3">
                  <span className="gm-meta min-w-0 flex-1 text-meta">
                    Launched from the topbar into a new split, one pane per agent.
                  </span>
                  <button
                    className="gm-btn px-3 py-1.5 text-body"
                    onClick={() =>
                      setSettings({
                        agents: [
                          ...settings.agents,
                          { id: `agent-${Date.now().toString(36)}`, name: "", command: "", flags: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={13} strokeWidth={2} className="mr-1 inline" />
                    Add agent
                  </button>
                </div>
                <AgentEditor />
              </>
            )}

            {section === "updates" && <UpdatesSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
