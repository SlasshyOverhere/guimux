import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { useAutoUpdater } from "../useAutoUpdater";
import { confirmUnsavedDiscard } from "../explorer/editorBuffer";
import { confirmDialog } from "../dialogs";

const HAIRLINE = { borderBottom: "1px solid var(--gm-hairline-soft)" } as const;

export function UpdatesSection() {
  const autoCheck = useStore((s) => s.settings.autoCheckForUpdates);
  const setSettings = useStore((s) => s.setSettings);
  const editorDirtyCount = useStore((s) => s.editorDirtyCount);
  const u = useAutoUpdater();
  const busy = u.status === "checking" || u.status === "downloading";

  return (
    <div className="px-4 py-3" style={HAIRLINE}>
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium text-ink-200">Updates</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-400 hover:text-ink-100">
          <input
            type="checkbox"
            className="accent-current"
            checked={autoCheck}
            onChange={(e) => setSettings({ autoCheckForUpdates: e.target.checked })}
            aria-label="Automatically check for updates"
          />
          Check automatically
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
          style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
          onClick={() => void u.checkNow()}
          disabled={busy}
        >
          <RefreshCw size={13} strokeWidth={2} className={u.status === "checking" ? "animate-spin" : ""} />
          {u.status === "checking" ? "Checking…" : "Check for Updates"}
        </button>
        {u.status === "up-to-date" && (
          <span className="text-[12px] text-ink-400">You&apos;re up to date</span>
        )}
      </div>

      {u.status === "available" && u.info && (
        <div className="mt-2 text-[12px] text-ink-200">
          <div>
            Guimux {u.info.version} is available (you have {u.info.currentVersion}).
          </div>
          <button
            className="mt-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
            onClick={() => void u.downloadInstall()}
            disabled={busy}
          >
            Download & Install
          </button>
        </div>
      )}

      {u.status === "downloading" && (
        <div className="gm-meta mt-2 text-[12px]">Downloading update…</div>
      )}

      {u.status === "ready" && (
        <div className="mt-2 text-[12px] text-ink-200">
          <div>Update installed{u.info ? ` — Guimux ${u.info.version}` : ""}. Restart to apply it.</div>
          <button
            className="mt-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold"
            style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
            onClick={async () => {
              if (!(await confirmUnsavedDiscard(editorDirtyCount, confirmDialog, "restart for the update"))) return;
              await u.relaunch();
            }}
          >
            Restart to Update
          </button>
        </div>
      )}

      {u.status === "error" && u.error && (
        <div className="mt-2 text-[12px]" style={{ color: "var(--gm-red)" }}>
          {u.error}
        </div>
      )}
    </div>
  );
}
