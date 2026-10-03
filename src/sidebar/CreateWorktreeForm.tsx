import { useState } from "react";
import { Check, GitBranch, X } from "lucide-react";

// New-worktree form. The branch field is a real combobox: arrow keys move the
// highlight, Enter takes the highlighted option, Escape closes the list first
// and only cancels the form once the list is closed.

const MAX_OPTIONS = 40;
// Option 0 is always "Current HEAD", so the highlight index is off by one.
const CTRL_HEAD = 0;

interface Props {
  branches: string[];
  projectName?: string;
  onSubmit: (values: { name: string; base: string }) => void;
  onCancel: () => void;
}

export function CreateWorktreeForm({ branches, projectName, onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);

  const q = base.trim().toLowerCase();
  const options = (q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches).slice(
    0,
    MAX_OPTIONS,
  );

  const optionId = (i: number) => `gm-base-opt-${i}`;
  const take = (i: number) => {
    setBase(i === CTRL_HEAD ? "" : options[i - 1]);
    setOpen(false);
    setAt(-1);
  };

  const move = (delta: number) => {
    const count = options.length + 1;
    setOpen(true);
    setAt((cur) => (cur < 0 ? (delta > 0 ? 0 : count - 1) : (cur + delta + count) % count));
  };

  const submit = () => onSubmit({ name: name.trim(), base: base.trim() });

  const option = (i: number, label: string, selected: boolean) => (
    <button
      key={label || "head"}
      id={optionId(i)}
      role="option"
      aria-selected={selected}
      className="gm-menu-item mono gap-2 text-body"
      title={label || "Current HEAD"}
      // Keep focus in the field: a blur here would close the list first.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setAt(i)}
      onClick={() => take(i)}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label || "Current HEAD"}</span>
      {selected && <Check size={12} strokeWidth={2} className="shrink-0 text-ink-400" />}
    </button>
  );

  return (
    // overflow-visible: the base-branch list opens upward out of the card, and
    // the dialog's default `overflow: hidden` would cut off the top of a full
    // list (the card is short; the list is 192px tall).
    <div className="gm-dialog overflow-visible p-3">
      <div className="flex items-center justify-between">
        <span className="truncate text-body font-semibold text-ink-100">
          {projectName ? `New worktree in ${projectName}` : "New worktree"}
        </span>
        <button
          className="gm-icon-btn gm-icon-btn--sm"
          onClick={onCancel}
          title="Close"
          aria-label="Close"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>

      <label htmlFor="gm-wt-name" className="gm-meta mt-2 block text-meta">
        Branch name
      </label>
      <input
        id="gm-wt-name"
        autoFocus
        className="gm-field mono mt-1"
        placeholder="feature/my-change (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />

      <label htmlFor="gm-wt-base" className="gm-meta mt-2.5 block text-meta">
        Start from
      </label>
      <div className="relative mt-1">
        <GitBranch
          size={13}
          strokeWidth={2}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500"
        />
        <input
          id="gm-wt-base"
          className="gm-field mono pl-8 pr-7"
          placeholder="Current HEAD"
          value={base}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="gm-base-menu"
          aria-activedescendant={open && at >= 0 ? optionId(at) : undefined}
          onChange={(e) => {
            setBase(e.target.value);
            setOpen(true);
            setAt(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if (e.key === "Enter") {
              // The highlighted option wins while the list is open; a bare
              // With no row highlighted, Enter creates with whatever was typed.
              if (open && at >= 0) take(at);
              else submit();
              return;
            }
            if (e.key === "Escape") {
              if (open) setOpen(false);
              else onCancel();
            }
          }}
        />
        {base && (
          <button
            className="gm-icon-btn gm-icon-btn--sm absolute right-1 top-1/2 -translate-y-1/2"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setBase("")}
            title="Use current HEAD"
            aria-label="Clear start point"
          >
            <X size={12} strokeWidth={2} />
          </button>
        )}
        {open && (
          <div
            id="gm-base-menu"
            role="listbox"
            className="gm-menu absolute bottom-full left-0 right-0 z-30 mb-1 max-h-48 overflow-y-auto"
          >
            {option(CTRL_HEAD, "", !base.trim())}
            {options.map((b, i) => option(i + 1, b, base === b))}
            {q && options.length === 0 && (
              <div className="px-3 py-2 text-meta text-ink-400">
                No match. Enter uses it as-is.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button className="gm-btn flex-1 px-3 py-1.5 text-body" onClick={submit}>
          Create worktree
        </button>
        <button className="gm-btn-ghost px-2 py-1.5 text-body" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
