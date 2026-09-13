import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore } from "../store";
import { errorDialog } from "../dialogs";

const CUSTOM_ID = "__custom__";

export function AgentLauncher() {
  const open = useStore((s) => s.agentOpen);
  const setOpen = useStore((s) => s.setAgentOpen);
  const agents = useStore((s) => s.settings.agents);
  const setSettings = useStore((s) => s.setSettings);
  const launchAgents = useStore((s) => s.launchAgents);
  const [picked, setPicked] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  // Per-launch overrides; pre-filled from the picked agent's saved flags.
  const [flags, setFlags] = useState("");
  // Custom one-off: typed inline, launched directly, optionally saved.
  const [customName, setCustomName] = useState("");
  const [customCmd, setCustomCmd] = useState("");
  const [saveCustom, setSaveCustom] = useState(true);

  useEffect(() => {
    if (!open) return;
    setPicked((p) => p ?? agents[0]?.id ?? CUSTOM_ID);
    setFlags("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, agents, setOpen]);

  if (!open) return null;

  const isCustom = picked === CUSTOM_ID || agents.length === 0;
  const agent = isCustom ? null : (agents.find((a) => a.id === picked) ?? agents[0] ?? null);
  // ponytail: typed flags win; saved flags are just the prefill baseline.
  const effectiveFlags = flags.trim();
  const fullCmd = isCustom
    ? [customCmd.trim(), effectiveFlags].filter(Boolean).join(" ")
    : [agent?.command.trim(), effectiveFlags || agent?.flags.trim()].filter(Boolean).join(" ");

  const launch = () => {
    if (isCustom) {
      if (!customCmd.trim()) {
        void errorDialog("Type a launch command first (e.g. aichat).");
        return;
      }
      const name = customName.trim() || customCmd.trim().split(/\s+/)[0];
      if (saveCustom) {
        setSettings({
          agents: [
            ...agents,
            {
              id: `agent-${Date.now().toString(36)}`,
              name: name.slice(0, 40),
              command: customCmd.trim().slice(0, 200),
              flags: effectiveFlags.slice(0, 200),
            },
          ],
        });
      }
      setCustomName("");
      setCustomCmd("");
    } else if (!agent) {
      void errorDialog("No agents defined — add one in Settings first.");
      return;
    }
    launchAgents(fullCmd, count);
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
        className="w-[400px] max-w-full overflow-hidden rounded-xl shadow-pop"
        style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
        >
          <div>
            <div className="text-[13px] font-semibold text-ink-100">Launch agents</div>
            <div className="text-[11.5px] text-ink-400">Terminal tiles auto-arrange for the count.</div>
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

        <div className="px-4 py-3">
          <div className="text-[11px] font-medium text-ink-400">Agent</div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setPicked(a.id);
                  setFlags(a.flags);
                }}
                aria-pressed={a.id === agent?.id}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] ${
                  a.id === agent?.id ? "bg-white/[0.055] font-semibold text-ink-100" : "font-medium text-ink-300 hover:bg-white/[0.03]"
                }`}
                style={
                  a.id === agent?.id
                    ? { boxShadow: "inset 2px 0 0 var(--gm-accent)" }
                    : undefined
                }
              >
                <span className="flex-1 truncate">{a.name}</span>
                <span className="mono max-w-[180px] truncate text-[11px] text-ink-400">
                  {[a.command, a.flags].filter(Boolean).join(" ")}
                </span>
              </button>
            ))}
            <button
              onClick={() => setPicked(CUSTOM_ID)}
              aria-pressed={isCustom}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] ${
                isCustom ? "bg-white/[0.055] font-semibold text-ink-100" : "font-medium text-ink-300 hover:bg-white/[0.03]"
              }`}
              style={isCustom ? { boxShadow: "inset 2px 0 0 var(--gm-accent)" } : undefined}
            >
              <Plus size={13} className="shrink-0 text-ink-400" />
              <span className="flex-1">Custom command</span>
              <span className="text-[11px] text-ink-400">type and launch</span>
            </button>
          </div>
        </div>

        {isCustom && (
          <div className="flex flex-col gap-1.5 px-4 pb-3">
            <input
              autoFocus
              className="w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-400"
              style={{ border: "1px solid var(--gm-hairline)" }}
              placeholder="Name (e.g. Aichat)"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") launch();
              }}
              aria-label="Custom agent name"
            />
            <input
              className="mono w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
              style={{ border: "1px solid var(--gm-hairline)" }}
              placeholder="Command (e.g. aichat)"
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") launch();
              }}
              aria-label="Custom agent command"
            />
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

        <div className="px-4 py-3" style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}>
          <div className="text-[11px] font-medium text-ink-400">Flags for this launch</div>
          <input
            className="mono mt-1.5 w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
            style={{ border: "1px solid var(--gm-hairline)" }}
            placeholder="e.g. --dangerously-skip-permissions --yolo"
            value={flags}
            onChange={(e) => setFlags(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") launch();
            }}
            aria-label="Flags for this launch"
          />
          {fullCmd && (
            <div className="mono mt-1.5 truncate px-0.5 text-[11px] text-ink-400" title={fullCmd}>
              runs: {fullCmd}
            </div>
          )}
        </div>

        <div className="px-4 py-3" style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}>
          <div className="text-[11px] font-medium text-ink-400">How many</div>
          <div className="mt-1.5 flex gap-1.5" role="radiogroup" aria-label="Agent count">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={n === count}
                onClick={() => setCount(n)}
                className={`tnum flex-1 rounded-md py-1.5 text-[12.5px] font-semibold ${
                  n === count ? "text-ink-100" : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
                }`}
                style={n === count ? { background: "var(--gm-accent-wash)" } : undefined}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}>
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
            Launch {count > 1 ? `${count} agents` : "agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
