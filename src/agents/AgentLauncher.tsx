import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore } from "../store";
import { errorDialog } from "../dialogs";

const MAX_PER_AGENT = 6;

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const btn =
    "tnum flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-semibold text-ink-300 hover:bg-white/[0.06] hover:text-ink-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-300";
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Pane count">
      <button
        className={btn}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
        aria-label="Fewer panes"
      >
        −
      </button>
      <span
        className="tnum w-5 text-center text-[12.5px] font-semibold text-ink-100"
        aria-live="polite"
      >
        {value}
      </span>
      <button
        className={btn}
        disabled={value >= MAX_PER_AGENT}
        onClick={() => onChange(Math.min(MAX_PER_AGENT, value + 1))}
        aria-label="More panes"
      >
        +
      </button>
    </div>
  );
}

export function AgentLauncher() {
  const open = useStore((s) => s.agentOpen);
  const setOpen = useStore((s) => s.setAgentOpen);
  const agents = useStore((s) => s.settings.agents);
  const setSettings = useStore((s) => s.setSettings);
  const launchAgents = useStore((s) => s.launchAgents);
  // Per-agent pane counts + per-agent flags. Flags prefill from the saved
  // agent defaults and are written back on launch, so they persist.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [flags, setFlags] = useState<Record<string, string>>({});
  const [customName, setCustomName] = useState("");
  const [customCmd, setCustomCmd] = useState("");
  const [customFlags, setCustomFlags] = useState("");
  const [customCount, setCustomCount] = useState(0);
  const [saveCustom, setSaveCustom] = useState(true);

  useEffect(() => {
    if (!open) return;
    setCounts((prev) => {
      // Keep edits made while open; seed newcomers (first agent starts at 1).
      const next: Record<string, number> = {};
      agents.forEach((a, i) => {
        next[a.id] = prev[a.id] ?? (i === 0 ? 1 : 0);
      });
      return next;
    });
    setFlags((prev) => {
      const next: Record<string, string> = {};
      agents.forEach((a) => {
        next[a.id] = prev[a.id] ?? a.flags ?? "";
      });
      return next;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, agents, setOpen]);

  if (!open) return null;

  const items = agents
    .map((a) => {
      const n = counts[a.id] ?? 0;
      if (n <= 0) return null;
      const f = (flags[a.id] ?? "").trim();
      return { command: [a.command.trim(), f].filter(Boolean).join(" "), count: n };
    })
    .filter((x): x is { command: string; count: number } => x !== null);
  if (customCmd.trim() && customCount > 0) {
    items.push({
      command: [customCmd.trim(), customFlags.trim()].filter(Boolean).join(" "),
      count: customCount,
    });
  }
  const total = items.reduce((s, x) => s + x.count, 0);

  const launch = () => {
    if (total === 0) {
      void errorDialog("Pick at least one pane: raise a count above 0 first.");
      return;
    }
    if (items.some((x) => !x.command)) {
      void errorDialog("An agent has no launch command — fix it in Settings first.");
      return;
    }
    // Persist per-agent flags so next launch is prefilled (survives restart
    // via the settings store). Only touches agents actually launched.
    const touched = agents.some((a) => (counts[a.id] ?? 0) > 0 && (flags[a.id] ?? "") !== a.flags);
    if (touched) {
      setSettings({
        agents: agents.map((a) =>
          (counts[a.id] ?? 0) > 0 ? { ...a, flags: (flags[a.id] ?? "").slice(0, 200) } : a,
        ),
      });
    }
    if (customCmd.trim() && customCount > 0 && saveCustom) {
      const name = customName.trim() || customCmd.trim().split(/\s+/)[0];
      setSettings({
        agents: [
          ...useStore.getState().settings.agents,
          {
            id: `agent-${Date.now().toString(36)}`,
            name: name.slice(0, 40),
            command: customCmd.trim().slice(0, 200),
            flags: customFlags.trim().slice(0, 200),
          },
        ],
      });
    }
    launchAgents(items);
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Launch agents"
        className="w-[440px] max-w-full overflow-hidden rounded-xl shadow-pop"
        style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
        >
          <div>
            <div className="text-[13px] font-semibold text-ink-100">Launch agents</div>
            <div className="text-[11.5px] text-ink-400">
              Mix agents per launch. New tiles append, open work is kept.
            </div>
          </div>
          <button
            className="rounded-md p-1.5 text-ink-400 hover:bg-white/[0.05] hover:text-ink-100"
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
          <div className="text-[11px] font-medium text-ink-400">Agents and counts</div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {agents.map((a) => (
              <div
                key={a.id}
                className="rounded-lg px-3 py-2"
                style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-100">
                    {a.name}
                  </span>
                  <span className="mono max-w-[150px] truncate text-[11px] text-ink-400">
                    {a.command}
                  </span>
                  <Stepper
                    value={counts[a.id] ?? 0}
                    onChange={(n) => setCounts((c) => ({ ...c, [a.id]: n }))}
                  />
                </div>
                {(counts[a.id] ?? 0) > 0 && (
                  <input
                    className="mono mt-1.5 w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
                    style={{ border: "1px solid var(--gm-hairline)" }}
                    placeholder="Flags, saved on launch (e.g. --yolo --flex)"
                    value={flags[a.id] ?? ""}
                    onChange={(e) => setFlags((f) => ({ ...f, [a.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") launch();
                    }}
                    aria-label={`Flags for ${a.name}, saved on launch`}
                  />
                )}
              </div>
            ))}
            {agents.length === 0 && (
              <div className="text-[12px] text-ink-400">
                No agents yet — type a custom command below or add one in Settings.
              </div>
            )}
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
            >
              <div className="flex items-center gap-2">
                <Plus size={13} className="shrink-0 text-ink-400" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium text-ink-100 outline-none placeholder:text-ink-400"
                  placeholder="Custom command (e.g. codex --flex)"
                  value={customCmd}
                  onChange={(e) => setCustomCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") launch();
                  }}
                  aria-label="Custom command"
                />
                <Stepper value={customCount} onChange={setCustomCount} />
              </div>
              {(customCount > 0 || customCmd) && (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  <div className="flex gap-1.5">
                    <input
                      className="min-w-0 flex-1 rounded-md bg-ink-950 px-2.5 py-1.5 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-400"
                      style={{ border: "1px solid var(--gm-hairline)" }}
                      placeholder="Name (optional)"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      aria-label="Custom agent name"
                    />
                    <input
                      className="mono min-w-0 flex-1 rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
                      style={{ border: "1px solid var(--gm-hairline)" }}
                      placeholder="Flags (e.g. --yolo)"
                      value={customFlags}
                      onChange={(e) => setCustomFlags(e.target.value)}
                      aria-label="Custom command flags"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 px-0.5 text-[11.5px] text-ink-400">
                    <input
                      type="checkbox"
                      checked={saveCustom}
                      onChange={(e) => setSaveCustom(e.target.checked)}
                      style={{ accentColor: "var(--gm-accent)" }}
                    />
                    Save to my agents for next time
                  </label>
                </div>
              )}
            </div>
          </div>
          {total > 0 && (
            <div className="mono mt-2 truncate px-0.5 text-[11px] text-ink-400">
              {total} {total === 1 ? "tile" : "tiles"}:{" "}
              {items.map((x) => `${x.count}× ${x.command}`).join(" · ")}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}
        >
          <button
            className="rounded-md px-3 py-1.5 text-[12px] font-medium text-ink-300 hover:bg-white/[0.05]"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          <button
            className="rounded-md px-4 py-1.5 text-[12.5px] font-semibold"
            style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
            onClick={launch}
          >
            {total > 0 ? `Launch ${total} ${total === 1 ? "tile" : "tiles"}` : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
