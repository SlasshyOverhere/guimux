import { useEffect } from "react";
import { Keyboard } from "lucide-react";
import { useStore } from "../store";
import { useBindings, type Binding, type Group } from "../keymap";
import { prettyCombo } from "../combo";
import { useModalFocus } from "../modalFocus";

// Grouped in the order a person learns the app: move between worktrees, drive
// panes, then the chrome around them.
const ORDER: Group[] = ["Worktrees", "Panes", "Files", "View"];

function Chips({ b }: { b: Binding }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="gm-kbd">{prettyCombo(b.combo)}</span>
      {b.alt
        ?.filter((a) => a.scope === "terminal")
        .map((a) => (
          <span key={a.combo} className="gm-kbd" title="Also works from a focused terminal">
            {prettyCombo(a.combo)}
          </span>
        ))}
    </span>
  );
}

function Row({ b }: { b: Binding }) {
  return (
    <div className="flex items-center gap-4 px-4 py-[7px]">
      <span className="min-w-0 flex-1 text-body text-ink-200">{b.label}</span>
      <Chips b={b} />
    </div>
  );
}

/** One row for the nine digit jumps: nine near-identical lines is a list
 *  nobody reads, and the range says the same thing. */
function RangeRow({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-center gap-4 px-4 py-[7px]">
      <span className="min-w-0 flex-1 text-body text-ink-200">{label}</span>
      <span className="gm-kbd">{hint}</span>
    </div>
  );
}

const isDigitJump = (b: Binding) => /^worktree\.[1-9]$/.test(b.id);

/**
 * The shortcut reference. Every line is a live binding, so this sheet is
 * generated rather than written: a chord that stops working disappears here
 * in the same change that broke it.
 */
export function CheatSheet() {
  const open = useStore((s) => s.cheatSheetOpen);
  const setOpen = useStore((s) => s.setCheatSheetOpen);
  const ref = useModalFocus<HTMLDivElement>(open);
  const bindings = useBindings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="gm-scrim" onClick={() => setOpen(false)}>
      <div
        ref={ref}
        className="gm-dialog flex max-h-[80vh] w-[640px] max-w-full flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="gm-rule flex h-10 shrink-0 items-center gap-2 px-4">
          <Keyboard size={14} strokeWidth={2} className="text-ink-400" />
          <span className="text-body font-semibold text-ink-100">Keyboard shortcuts</span>
          <span className="flex-1" />
          <span className="gm-kbd">Ctrl+Shift+?</span>

        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {ORDER.map((group) => {
            const rows = bindings.filter((b) => b.group === group && !isDigitJump(b));
            const digits = bindings.some(isDigitJump);
            if (rows.length === 0 && !(digits && group === "Worktrees")) return null;
            return (
              <div key={group} className="mb-1">
                <div className="gm-sect px-4 pb-1 pt-3">{group}</div>
                {digits && group === "Worktrees" && (
                  <RangeRow label="Go to worktree 1–9" hint="Ctrl+1…9" />
                )}
                {rows.map((b) => (
                  <Row key={b.id} b={b} />
                ))}
              </div>
            );
          })}
          <p className="gm-meta px-4 pb-3 pt-2 leading-5">
            A terminal keeps its own chords. Where the shell owns the plain Ctrl+
            form, a Shift variant works from a focused terminal instead.
          </p>
        </div>
      </div>
    </div>
  );
}
