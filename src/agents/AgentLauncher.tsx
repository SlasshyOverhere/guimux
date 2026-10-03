import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  MAX_AGENT_TILES,
  MAX_TILES_PER_WORKTREE,
  allPaneIds,
  useStore,
} from "../store";
import { errorDialog } from "../dialogs";
import { useModalFocus } from "../modalFocus";

// A picker, not a form. Each agent is a tile you switch on and size by clicking
// the panes you want, and the meter above the footer shows what launching does
// to this worktree: the old dialog asked for a count and then told you, in
// small print, that there were only 12 tiles to spend.

interface Selection {
  /** Agent id, or "custom" for the ad-hoc command. */
  key: string;
  name: string;
  command: string;
  flags: string;
  count: number;
  /** Ad-hoc entries can be remembered as a real agent on launch. */
  custom: boolean;
}

/** How many panes this agent would take, capped by what the worktree has left.
 *  Over-asking is allowed and shown in red rather than silently clamped: the
 *  store launches what fits and reports the rest. */
function Meter({ inUse, queued }: { inUse: number; queued: number }) {
  const cells = Array.from({ length: MAX_TILES_PER_WORKTREE }, (_, i) => {
    if (i < inUse) return "used";
    if (i < inUse + queued) return "queued";
    return "free";
  });
  const over = inUse + queued > MAX_TILES_PER_WORKTREE;
  const free = Math.max(0, MAX_TILES_PER_WORKTREE - inUse - queued);
  return (
    <div className="px-4 py-2.5">
      <div className="flex gap-[3px]" aria-hidden>
        {cells.map((kind, i) => (
          <span
            key={i}
            className="h-[6px] flex-1 rounded-[2px]"
            style={{
              background:
                kind === "used"
                  ? "var(--gm-ink-mute)"
                  : kind === "queued"
                    ? over
                      ? "var(--gm-red)"
                      : "var(--gm-accent)"
                    : "var(--gm-hover)",
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="tnum gm-meta text-meta">
          {inUse} in use · {queued > 0 ? `${queued} queued · ` : ""}
          {over ? `${inUse + queued - MAX_TILES_PER_WORKTREE} over` : `${free} free`}
        </span>
      </div>
    </div>
  );
}

/**
 * The pane picker: one cell per tile this agent would take. Clicking the cell
 * you already have switches the agent off, so the last click always undoes.
 */
function PanePicker({
  agent,
  value,
  onChange,
}: {
  agent: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-[3px]" role="group" aria-label={`Panes for ${agent}`}>
      {Array.from({ length: MAX_AGENT_TILES }, (_, i) => {
        const n = i + 1;
        const on = value >= n;
        return (
          <button
            key={n}
            aria-label={on ? `${n} ${n === 1 ? "pane" : "panes"} for ${agent}` : `Set ${n} panes for ${agent}`}
            aria-pressed={on}
            onClick={() => onChange(value === n ? 0 : n)}
            className="h-4 w-4 rounded-[4px] border transition-colors hover:border-[color:var(--gm-accent)]"
            style={{
              borderColor: on ? "transparent" : "var(--gm-hairline)",
              background: on ? "var(--gm-accent)" : "var(--gm-hover)",
            }}
          />
        );
      })}
    </div>
  );
}

function Tile({
  name,
  command,
  count,
  onCount,
  error,
  children,
}: {
  name: string;
  command: string;
  count: number;
  onCount: (n: number) => void;
  error?: string;
  children?: React.ReactNode;
}) {
  const on = count > 0;
  return (
    <div
      className="rounded-[var(--gm-r-card)] border p-2.5 transition-colors"
      style={{
        borderColor: on ? "transparent" : "var(--gm-hairline-soft)",
        background: on ? "var(--gm-selected)" : "transparent",
        boxShadow: on ? "inset 0 0 0 1px var(--gm-accent)" : undefined,
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={`truncate text-body font-semibold ${on ? "text-ink-100" : "text-ink-300"}`}>
            {name}
          </div>
          <div className="mono truncate text-meta text-ink-500">{command || "no command set"}</div>
        </div>
        {on && (
          <span className="tnum shrink-0 rounded-[var(--gm-r-ctl)] bg-[color:var(--gm-hover)] px-1.5 text-meta font-semibold text-ink-200">
            ×{count}
          </span>
        )}
      </div>
      {error ? (
        <div className="mt-2 text-meta" style={{ color: "var(--gm-red)" }}>
          {error}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <PanePicker agent={name} value={count} onChange={onCount} />
        </div>
      )}
      {/* Reserved height: selecting an agent used to grow its tile, which moved
          every cell below it out from under the pointer mid-click. */}
      <div className="mt-2 h-[26px]">{count > 0 && children}</div>
    </div>
  );
}

export function AgentLauncher() {
  const open = useStore((s) => s.agentOpen);
  const setOpen = useStore((s) => s.setAgentOpen);
  const agents = useStore((s) => s.settings.agents);
  const setSettings = useStore((s) => s.setSettings);
  const launchAgents = useStore((s) => s.launchAgents);
  const inUse = useStore((s) => allPaneIds(s.layout).length);
  const dialogRef = useModalFocus<HTMLDivElement>(open);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [flags, setFlags] = useState<Record<string, string>>({});
  const [customName, setCustomName] = useState("");
  const [customCmd, setCustomCmd] = useState("");
  const [customFlags, setCustomFlags] = useState("");
  const [customCount, setCustomCount] = useState(0);
  const [saveCustom, setSaveCustom] = useState(true);

  useEffect(() => {
    if (!open) return;
    // Counts persist while the dialog is open; only new agents start at zero.
    setCounts((prev) => {
      const next: Record<string, number> = {};
      agents.forEach((a) => {
        next[a.id] = prev[a.id] ?? 0;
      });
      return next;
    });
    // Flags prefill from the saved defaults.
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

  const selections: Selection[] = agents
    .filter((a) => (counts[a.id] ?? 0) > 0)
    .map((a) => ({
      key: a.id,
      name: a.name || a.command || "agent",
      command: [a.command.trim(), (flags[a.id] ?? "").trim()].filter(Boolean).join(" "),
      flags: flags[a.id] ?? "",
      count: counts[a.id] ?? 0,
      custom: false,
    }));
  if (customCmd.trim() && customCount > 0) {
    selections.push({
      key: "custom",
      name: customName.trim() || customCmd.trim().split(/\s+/)[0],
      command: [customCmd.trim(), customFlags.trim()].filter(Boolean).join(" "),
      flags: customFlags,
      count: customCount,
      custom: true,
    });
  }
  const total = selections.reduce((s, x) => s + x.count, 0);
  const nameless = selections.filter((x) => !x.command);

  const launch = () => {
    if (total === 0 || nameless.length > 0) return;
    // Per-agent flags are written back so the next launch is prefilled. Only
    // agents actually launched are touched.
    const touched = agents.some(
      (a) => (counts[a.id] ?? 0) > 0 && (flags[a.id] ?? "") !== a.flags,
    );
    if (touched) {
      setSettings({
        agents: agents.map((a) =>
          (counts[a.id] ?? 0) > 0 ? { ...a, flags: (flags[a.id] ?? "").slice(0, 200) } : a,
        ),
      });
    }
    const custom = selections.find((x) => x.custom);
    if (custom && saveCustom) {
      setSettings({
        agents: [
          ...useStore.getState().settings.agents,
          {
            id: `agent-${Date.now().toString(36)}`,
            name: custom.name.slice(0, 40),
            command: custom.command.split(/\s+/)[0].slice(0, 200),
            flags: custom.flags.trim().slice(0, 200),
          },
        ],
      });
    }
    const launched = launchAgents(
      selections.map((s) => ({ command: s.command, count: s.count, label: s.name })),
    );
    if (launched < total) {
      void errorDialog(
        `Only ${launched} of ${total} tiles fit in this worktree. Close a pane and launch again.`,
      );
    }
    setCustomName("");
    setCustomCmd("");
    setCustomFlags("");
    setCustomCount(0);
    setOpen(false);
  };

  const overflow = inUse + total > MAX_TILES_PER_WORKTREE;

  return (
    <div className="gm-scrim" onClick={() => setOpen(false)}>
      <div
        ref={dialogRef}
        // Focus the card, not its first button: opening a picker should not
        // park Enter on "Close".
        data-autofocus
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Launch agents"
        className="gm-dialog flex w-[520px] max-w-full flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gm-rule flex items-start justify-between gap-4 px-4 py-3">
          <div>
            <div className="text-strong font-semibold text-ink-100">Launch agents</div>
            <div className="gm-meta mt-0.5 text-meta">
              Clean panes are reused in place; busy ones split.
            </div>
          </div>
          <button
            className="gm-icon-btn gm-icon-btn--sm shrink-0"
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <Meter inUse={inUse} queued={total} />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <div className="grid grid-cols-2 gap-2">
            {agents.map((a) => (
              <Tile
                key={a.id}
                name={a.name || a.command || "agent"}
                command={a.command}
                count={counts[a.id] ?? 0}
                onCount={(n) => setCounts((c) => ({ ...c, [a.id]: n }))}
                error={a.command.trim() ? undefined : "Set a command in Settings first"}
              >
                {(counts[a.id] ?? 0) > 0 && (
                  <input
                    className="gm-field mono px-1.5 py-1 text-meta"
                    placeholder="Flags, saved on launch"
                    value={flags[a.id] ?? ""}
                    onChange={(e) => setFlags((f) => ({ ...f, [a.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") launch();
                    }}
                    aria-label={`Flags for ${a.name || "agent"}, saved on launch`}
                  />
                )}
              </Tile>
            ))}

            {/* Ad-hoc command: same tile shape, so it reads as one more choice
                rather than a separate form bolted underneath the list. */}
            <div
              className="rounded-[var(--gm-r-card)] border p-2.5"
              style={{
                borderColor: customCount > 0 ? "transparent" : "var(--gm-hairline-soft)",
                background: customCount > 0 ? "var(--gm-selected)" : "transparent",
                boxShadow: customCount > 0 ? "inset 0 0 0 1px var(--gm-accent)" : undefined,
              }}
            >
              <div className="flex items-start gap-2">
                <Plus size={13} strokeWidth={2} className="mt-[3px] shrink-0 text-ink-400" />
                <input
                  className="mono min-w-0 flex-1 bg-transparent text-body text-ink-200 outline-none placeholder:text-ink-500"
                  placeholder="Custom command"
                  value={customCmd}
                  onChange={(e) => setCustomCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && customCmd.trim() && customCount > 0) launch();
                  }}
                  aria-label="Custom command"
                />
                {customCount > 0 && (
                  <span className="tnum shrink-0 rounded-[var(--gm-r-ctl)] bg-[color:var(--gm-hover)] px-1.5 text-meta font-semibold text-ink-200">
                    ×{customCount}
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <PanePicker
                  agent="the custom command"
                  value={customCount}
                  onChange={(n) => setCustomCount(n)}
                />
              </div>
              {/* Same reserved slot as the agent tiles, so picking a count here
                  does not shift the grid either. */}
              {customCount > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <input
                    className="gm-field px-1.5 py-1 text-meta"
                    placeholder="Name (optional)"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    aria-label="Custom agent name"
                  />
                  <input
                    className="gm-field mono px-1.5 py-1 text-meta"
                    placeholder="Flags"
                    value={customFlags}
                    onChange={(e) => setCustomFlags(e.target.value)}
                    aria-label="Custom command flags"
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-meta text-ink-400">
                    <input
                      type="checkbox"
                      className="accent-[color:var(--gm-accent)]"
                      checked={saveCustom}
                      onChange={(e) => setSaveCustom(e.target.checked)}
                    />
                    Remember this command
                  </label>
                </div>
              ) : (
                <div className="mt-2 h-[26px]" />
              )}
            </div>
          </div>

          {agents.length === 0 && (
            <div className="gm-meta mt-2 text-meta">
              No agents saved yet — the custom command above works without one.
            </div>
          )}
        </div>

        <div className="gm-rule-top flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="gm-meta min-w-0 truncate text-meta">
            {nameless.length > 0
              ? "An agent has no command"
              : overflow
                ? "Won't all fit — close a pane first"
                : total > 0
                  ? selections.map((s) => `${s.count}× ${s.name}`).join(" · ")
                  : `Up to ${MAX_AGENT_TILES} per agent, ${MAX_TILES_PER_WORKTREE} tiles per worktree`}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <button className="gm-btn-ghost text-body" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="gm-btn px-4 py-1.5 text-body"
              onClick={launch}
              disabled={total === 0 || nameless.length > 0}
            >
              {total > 0 ? `Launch ${total} ${total === 1 ? "pane" : "panes"}` : "Launch"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
