import { useEffect, useRef } from "react";
import { menuPos } from "../menuPos";
import { useStore } from "../store";

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  /** Menu box in CSS px, before zoom: used to keep it inside the viewport. */
  size: { w: number; h: number };
  items: MenuItem[];
  onClose: () => void;
}

// Anchored menu with real keyboard support: arrow keys cycle, Home/End jump,
// Escape closes. `role="menu"` without those keys is a lie to screen readers.
export function RowMenu({ x, y, size, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const nodes = () => [...(ref.current?.querySelectorAll("button") ?? [])];
  const step = (delta: number) => {
    const list = nodes();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[at < 0 ? 0 : (at + delta + list.length) % list.length]?.focus();
  };
  const focusEnd = (last: boolean) => {
    const list = nodes();
    list[last ? list.length - 1 : 0]?.focus();
  };

  const at = menuPos(x, y, size, {
    // Zoom lives in the store: reading it at open time keeps the menu correct
    // without re-rendering the panel on Ctrl+= .
    zoom: useStore.getState().settings.uiZoom || 1,
    w: window.innerWidth,
    h: window.innerHeight,
  });

  return (
    <div
      ref={ref}
      className="gm-menu tnum fixed z-50"
      style={{ left: at.left, top: at.top, width: size.w }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") step(1);
        else if (e.key === "ArrowUp") step(-1);
        else if (e.key === "Home") focusEnd(false);
        else if (e.key === "End") focusEnd(true);
        else if (e.key === "Escape" || e.key === "Tab") onClose();
        else return;
        e.preventDefault();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className="gm-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
