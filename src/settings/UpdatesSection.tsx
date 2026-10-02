import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { useAutoUpdater } from "../useAutoUpdater";
import { formatBytes } from "../updaterPolicy";
import { confirmUnsavedDiscard } from "../explorer/editorBuffer";
import { confirmDialog } from "../dialogs";

const HAIRLINE = { borderBottom: "1px solid var(--gm-hairline-soft)" } as const;

/** Determinate with a total, sweeping without one. */
function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      className="gm-progress mt-2"
      data-indeterminate={percent === null}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { "aria-valuenow": percent })}
      aria-label={label}
    >
      {/* Omit the inline width when indeterminate so the CSS width applies. */}
      <div className="gm-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

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
        <div className="mt-2">
          <ProgressBar
            percent={u.progress?.percent ?? null}
            label={
              u.progress?.percent === null || u.progress?.percent === undefined
                ? "Downloading update"
                : `Downloading update, ${u.progress.percent} percent`
            }
          />
          <div className="tnum mt-1.5 flex items-baseline justify-between">
            <span className="gm-meta">
              {u.progress?.done
                ? "Installing…"
                : (u.progress?.total ?? null) === null
                  ? `${formatBytes(u.progress?.downloaded ?? 0)} downloaded`
                  : `${formatBytes(u.progress?.downloaded ?? 0)} of ${formatBytes(
                      u.progress?.total ?? 0,
                    )}`}
            </span>
            {u.progress?.percent != null && (
              <span className="text-[11px] font-semibold text-ink-300">{u.progress.percent}%</span>
            )}
          </div>
        </div>
      )}

      {u.status === "ready" && (
        <div className="mt-2 text-[12px] text-ink-200">
          <div>Update installed{u.info ? ` — Guimux ${u.info.version}` : ""}. Restart to apply it.</div>
          <ProgressBar percent={100} label="Update installed" />
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
