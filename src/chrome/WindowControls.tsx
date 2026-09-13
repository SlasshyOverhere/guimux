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
  const btn = "flex h-11 w-11 items-center justify-center text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-100";
  return (
    <div className="flex shrink-0 items-center">
      <button className={btn} title="Minimize" onClick={() => getCurrentWindow().minimize().catch(() => {})}><Minus size={14} /></button>
      <button className={btn} title={maxed ? "Restore" : "Maximize"} onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}>{maxed ? <Copy size={12} /> : <Square size={12} />}</button>
      <button className="gm-close-btn flex h-11 w-11 items-center justify-center text-ink-400 transition-colors" title="Close" onClick={() => getCurrentWindow().close().catch(() => {})}><X size={15} /></button>
    </div>
  );
}
