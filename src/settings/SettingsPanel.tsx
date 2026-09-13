import { useEffect } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import { DEFAULT_SETTINGS } from "../types";

function Row({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
      <div className="tnum flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium text-ink-200">{label}</span>
        <span className="text-[12px] text-ink-400">{value.toLocaleString()}</span>
      </div>
      <input
        type="range"
        className="mt-2 w-full"
        style={{ accentColor: "var(--gm-accent)" }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-[400px] max-w-full overflow-hidden rounded-xl shadow-pop"
        style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
        >
          <div>
            <div className="text-[13px] font-semibold text-ink-100">Settings</div>
            <div className="text-[11.5px] text-ink-400">Applies instantly, saved with the workspace.</div>
          </div>
          <button
            className="rounded-md p-1.5 text-ink-400 hover:bg-white/[0.05] hover:text-ink-100"
            onClick={() => setOpen(false)}
            title="Close settings"
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </div>

        <Row
          label="Interface zoom (%)"
          value={Math.round(settings.uiZoom * 100)}
          min={50}
          max={200}
          step={5}
          onChange={(v) => setSettings({ uiZoom: v / 100 })}
        />
        <Row
          label="Terminal text size"
          value={settings.terminalFontSize}
          min={10}
          max={24}
          step={1}
          onChange={(terminalFontSize) => setSettings({ terminalFontSize })}
        />
        <Row
          label="Editor text size"
          value={settings.editorFontSize}
          min={10}
          max={24}
          step={1}
          onChange={(editorFontSize) => setSettings({ editorFontSize })}
        />
        <Row
          label="Terminal scrollback lines"
          value={settings.scrollback}
          min={1000}
          max={50000}
          step={1000}
          onChange={(scrollback) => setSettings({ scrollback })}
        />

        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-ink-200">CLI agents</span>
            <button
              className="text-[12px] font-medium text-ink-400 hover:text-ink-100"
              onClick={() =>
                setSettings({
                  agents: [
                    ...settings.agents,
                    { id: `agent-${Date.now().toString(36)}`, name: "New agent", command: "", flags: "" },
                  ],
                })
              }
            >
              Add agent
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {settings.agents.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5"
                style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
              >
                <div className="min-w-0 flex-1">
                  <input
                    className="w-full bg-transparent text-[12.5px] font-medium text-ink-100 outline-none placeholder:text-ink-400"
                    placeholder="Name (e.g. Claude)"
                    value={a.name}
                    onChange={(e) =>
                      setSettings({
                        agents: settings.agents.map((x) =>
                          x.id === a.id ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                    aria-label="Agent name"
                  />
                  <input
                    className="mono mt-0.5 w-full bg-transparent text-[11.5px] text-ink-400 outline-none placeholder:text-ink-400"
                    placeholder="Launch command (e.g. claude)"
                    value={a.command}
                    onChange={(e) =>
                      setSettings({
                        agents: settings.agents.map((x) =>
                          x.id === a.id ? { ...x, command: e.target.value } : x,
                        ),
                      })
                    }
                    aria-label="Agent launch command"
                  />
                  <input
                    className="mono mt-0.5 w-full bg-transparent text-[11.5px] text-ink-400 outline-none placeholder:text-ink-400"
                    placeholder="Default flags (e.g. --dangerously-skip-permissions)"
                    value={a.flags}
                    onChange={(e) =>
                      setSettings({
                        agents: settings.agents.map((x) =>
                          x.id === a.id ? { ...x, flags: e.target.value } : x,
                        ),
                      })
                    }
                    aria-label="Agent default flags"
                  />
                </div>
                <button
                  className="shrink-0 rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-clay-400"
                  title="Remove agent"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setSettings({ agents: settings.agents.filter((x) => x.id !== a.id) })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {settings.agents.length === 0 && (
              <div className="text-[12px] text-ink-400">No agents — add one to launch from the topbar.</div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <button
            className="text-[12px] font-medium text-ink-400 hover:text-ink-100"
            onClick={() => setSettings({ ...DEFAULT_SETTINGS })}
          >
            Reset to defaults
          </button>
          <button
            className="rounded-md px-4 py-1.5 text-[12.5px] font-semibold"
            style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
            onClick={() => setOpen(false)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
