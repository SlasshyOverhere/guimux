import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { confirmUnsavedDiscard } from "../explorer/editorBuffer";
import { confirmDialog } from "../dialogs";
import { useStore } from "../store";

export function WindowControls() {
  const [maxed, setMaxed] = useState(false);
  const allowClose = useRef(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      try {
        setMaxed(await getCurrentWindow().isMaximized());
        off = await getCurrentWindow().onResized(async () => setMaxed(await getCurrentWindow().isMaximized()));
      } catch { /* vite browser dev: buttons no-op */ }
    })();
    return () => off?.();
  }, []);
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        off = await win.onCloseRequested(async (event) => {
          if (allowClose.current) return;
          const count = useStore.getState().editorDirtyCount;
          if (count === 0) return;
          event.preventDefault();
          if (!(await confirmUnsavedDiscard(count, confirmDialog, "close guimux"))) return;
          allowClose.current = true;
          try {
            await win.close();
          } catch (error) {
            allowClose.current = false;
            throw error;
          }
        });
      } catch { /* vite browser dev: window close no-op */ }
    })();
    return () => off?.();
  }, []);
  const btn = "flex h-11 w-11 items-center justify-center text-ink-400 transition-colors hover:bg-[var(--gm-hover)] hover:text-ink-100";
  return (
    <div className="ml-1.5 flex shrink-0 items-center" style={{ borderLeft: "1px solid var(--gm-hairline-soft)" }}>
      <button className={btn} title="Minimize" onClick={() => getCurrentWindow().minimize().catch(() => {})}><Minus size={14} strokeWidth={2} /></button>
      <button className={btn} title={maxed ? "Restore" : "Maximize"} onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}>{maxed ? <Copy size={12} strokeWidth={2} /> : <Square size={12} strokeWidth={2} />}</button>
      <button className="gm-close-btn flex h-11 w-11 items-center justify-center text-ink-400 transition-colors" title="Close" onClick={() => getCurrentWindow().close().catch(() => {})}><X size={15} strokeWidth={2} /></button>
    </div>
  );
}
