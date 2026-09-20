// A save made inside guimux writes into the directory the dev server watches,
// and Vite would hot-update the app that made the save. The explorer pane
// remounts, every terminal replays, and a change to a module the whole app
// imports re-renders everything. Announcing the path before the write lets the
// dev server ignore that one event. A packaged build has no HMR client, so this
// does nothing there.
export function announceWrite(...paths: (string | null | undefined)[]) {
  const hot = import.meta.hot;
  if (!hot) return;
  for (const p of paths) if (p) hot.send("guimux:app-write", { path: p });
}
