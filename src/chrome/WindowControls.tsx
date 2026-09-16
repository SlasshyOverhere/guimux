import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

export function WindowControls() {
  const [maxed, setMaxed] = useState(false);
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
  const btn = "flex h-11 w-11 items-center justify-center text-ink-400 transition-colors hover:bg-[var(--gm-hover)] hover:text-ink-100";
  return (
    <div className="ml-1.5 flex shrink-0 items-center" style={{ borderLeft: "1px solid var(--gm-hairline-soft)" }}>
      <button className={btn} title="Minimize" onClick={() => getCurrentWindow().minimize().catch(() => {})}><Minus size={14} strokeWidth={2} /></button>
      <button className={btn} title={maxed ? "Restore" : "Maximize"} onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}>{maxed ? <Copy size={12} strokeWidth={2} /> : <Square size={12} strokeWidth={2} />}</button>
      <button className="gm-close-btn flex h-11 w-11 items-center justify-center text-ink-400 transition-colors" title="Close" onClick={() => getCurrentWindow().close().catch(() => {})}><X size={15} strokeWidth={2} /></button>
    </div>
  );
}
