import { ArrowUpCircle, Download, RotateCcw, X } from "lucide-react";
import { useStore } from "../store";
import { useAutoUpdater } from "../useAutoUpdater";
import { formatBytes } from "../updaterPolicy";
import { confirmUnsavedDiscard } from "../explorer/editorBuffer";
import { confirmDialog } from "../dialogs";

// The card is the update surface; a toast is best-effort by platform. See the
// toast() note in updater.ts for why.
export function UpdateCard() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const editorDirtyCount = useStore((s) => s.editorDirtyCount);
  const u = useAutoUpdater();

  const { status, info, progress } = u;
  if (!info) return null;
  if (status !== "available" && status !== "downloading" && status !== "ready") return null;
  // A running download keeps reporting even if the user dismissed the card.
  if (status === "available" && u.dismissedVersion === info.version) return null;

  const primary = async () => {
    if (status === "ready") {
      if (!(await confirmUnsavedDiscard(editorDirtyCount, confirmDialog, "restart for the update"))) return;
      await u.relaunch();
    } else if (status === "downloading") {
      setSettingsOpen(true);
    } else {
      await u.downloadInstall();
    }
  };

  const installing = status === "downloading" && !!progress?.done;
  const percent = progress?.percent ?? null;
  const total = progress?.total ?? null;
  const showBar = status !== "available";

  const title =
    status === "ready"
      ? "Update ready to install"
      : status === "downloading"
        ? `Downloading Guimux ${info.version}`
        : `Guimux ${info.version} is available`;

  return (
    <div
      className="pointer-events-none fixed right-4 top-14 z-40 w-[320px]"
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto overflow-hidden rounded-xl shadow-pop"
        style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
      >
        {/* Dismiss is a sibling of the title button, never nested in it. */}
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          {status === "ready" ? (
            <RotateCcw size={14} strokeWidth={2} className="shrink-0 text-ink-300" />
          ) : status === "downloading" ? (
            <Download size={14} strokeWidth={2} className="shrink-0 text-ink-300" />
          ) : (
            <ArrowUpCircle size={14} strokeWidth={2} className="shrink-0 text-ink-100" />
          )}
          <button
            className="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold text-ink-100 hover:underline"
            onClick={() => setSettingsOpen(true)}
            title="Open Settings › Updates"
          >
            {title}
          </button>
          {status === "available" && (
            <button
              className="gm-icon-btn gm-icon-btn--sm -mr-1.5 shrink-0"
              onClick={() => u.dismiss()}
              title="Not now"
              aria-label="Dismiss update"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Determinate with a total, sweeping without one. */}
        {showBar && (
          <div className="px-3.5 pb-2.5">
            <div
              className="gm-progress"
              data-indeterminate={percent === null}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent === null ? {} : { "aria-valuenow": percent })}
              aria-label={percent === null ? "Downloading update" : `Downloading update, ${percent} percent`}
            >
              {/* No inline width when indeterminate: the CSS rule owns it, and
                  an inline 0% would make the sweeping segment invisible. */}
              <div className="gm-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            <div className="tnum mt-1.5 flex items-baseline justify-between">
              <span className="gm-meta">
                {status === "ready"
                  ? "Installed"
                  : installing
                    ? "Installing…"
                    : percent === null
                      ? `${formatBytes(progress?.downloaded ?? 0)} downloaded`
                      : `${formatBytes(progress?.downloaded ?? 0)}${
                          total ? ` of ${formatBytes(total)}` : ""
                        }`}
              </span>
              {percent !== null && status !== "ready" && (
                <span className="text-[11px] font-semibold text-ink-300">{percent}%</span>
              )}
            </div>
          </div>
        )}

        <div
          className="flex items-center gap-2 px-3.5 pb-3 pt-1"
          style={{ borderTop: status === "available" ? "1px solid var(--gm-hairline-soft)" : undefined }}
        >
          <span className="gm-meta min-w-0 flex-1 truncate">
            {status === "ready" ? "Restart Guimux to apply it." : `You have ${info.currentVersion}`}
          </span>
          <button
            className="shrink-0 rounded-md px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
            onClick={() => void primary()}
          >
            {status === "ready" ? "Restart" : status === "downloading" ? "Details" : "Update now"}
          </button>
        </div>
      </div>
    </div>
  );
}
