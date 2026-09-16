import { invoke } from "@tauri-apps/api/core";
import { useStore, type PaneNode } from "../store";
import { STRESS_KEY } from "./TerminalPane";

// Dev-only stress loop: rapidly split, write, close, and remount panes while
// streaming output, to surface blank-pane races. No test runner, no UI.
// Run: localStorage.setItem('guimux-stress','1'); location.reload()
// Stop: localStorage.removeItem('guimux-stress'); location.reload()
// Progress logs to the devtools console as [gm-stress].

function panes(node: PaneNode | null, out: { id: string; ptyId: number | null }[] = []) {
  if (!node) return out;
  if (node.kind === "pane") out.push({ id: node.id, ptyId: node.ptyId });
  else {
    panes(node.first, out);
    panes(node.second, out);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function maybeStartStress() {
  try {
    if (localStorage.getItem(STRESS_KEY) !== "1") return;
  } catch {
    return;
  }
  let stop = false;
  (window as unknown as { __gmStressStop?: () => void }).__gmStressStop = () => {
    stop = true;
  };
  (async () => {
    let splits = 0;
    let closes = 0;
    let writes = 0;
    let blanks = 0;
    // eslint-disable-next-line no-console
    console.log("[gm-stress] start: split/write/close loop; call __gmStressStop() to stop");
    for (let i = 0; !stop && i < 500; i++) {
      const st = useStore.getState();
      const list = panes(st.layout);
      if (list.length === 0) {
        await sleep(200);
        continue;
      }
      // blank = pane with neither live pty nor restored buffer key
      for (const p of list) {
        if (p.ptyId == null) {
          try {
            if (!localStorage.getItem("guimux-scroll-" + p.id)) blanks++;
          } catch {
            blanks++;
          }
        }
      }
      const pick = list[i % list.length];
      if (list.length < 6 && i % 2 === 0) {
        st.splitPane(pick.id, i % 4 === 0 ? "v" : "h");
        splits++;
      } else if (list.length > 1 && i % 3 === 0) {
        const victim = list[list.length - 1];
        try {
          if (victim.ptyId != null) await invoke("pty_kill", { id: victim.ptyId });
        } catch {
          /* already dead */
        }
        st.closePane(victim.id);
        closes++;
      } else if (pick.ptyId != null) {
        try {
          await invoke("pty_write", { id: pick.ptyId, data: `echo gm-stress-$i\r` });
          writes++;
        } catch {
          /* pane mid-remount */
        }
      }
      if (i % 25 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[gm-stress] i=${i} panes=${list.length} splits=${splits} closes=${closes} writes=${writes} blanks=${blanks}`);
      }
      await sleep(60);
    }
    // eslint-disable-next-line no-console
    console.log(`[gm-stress] done: splits=${splits} closes=${closes} writes=${writes} blanks=${blanks}`);
  })();
}
