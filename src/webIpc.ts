// Browser half of `npm run web`. In a page there is no Tauri IPC, so commands
// go to the guimux-web bridge that script starts: POST /rpc for commands, an
// SSE stream on /events for events (the bridge answers plugin:event|listen
// itself). The desktop app never loads this path.
type TauriInternal = {
  metadata: { currentWindow: { label: string } };
  transformCallback(cb: (e: unknown) => void, once?: boolean): number;
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
};

if (!("__TAURI_INTERNALS__" in window)) {
  const callbacks = new Map<number, (e: unknown) => void>();
  const listened = new Map<number, number>(); // bridge listen id -> callback id
  let nextId = 1;

  const stream = new EventSource("/events");
  stream.onmessage = (m) => {
    const { id, payload } = JSON.parse(m.data) as { id: number; payload: unknown };
    callbacks.get(listened.get(id)!)?.({ event: "", id, payload });
  };

  // The browser owns its own window, so the handful of window commands the
  // chrome uses answer here; the rest no-op rather than error.
  const WINDOW: Record<string, unknown> = {
    "plugin:window|inner_size": { width: window.innerWidth, height: window.innerHeight },
    "plugin:window|outer_position": { x: 0, y: 0 },
    "plugin:window|outer_size": { width: window.outerWidth, height: window.outerHeight },
    "plugin:window|is_maximized": false,
  };

  // SAFETY: the desktop app already put a richer object here; this branch
    // only runs in a plain page, which has none.
    (window as unknown as { __TAURI_INTERNALS__: TauriInternal }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, once ? (e) => (callbacks.delete(id), cb(e)) : cb);
      return id;
    },
    async invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen") {
        const id = await call(cmd, args);
        listened.set(id as number, args.handler as number);
        return id;
      }
      if (cmd === "plugin:event|unlisten") {
        listened.delete(args.eventId as number);
        return null;
      }
      if (cmd in WINDOW) return WINDOW[cmd];
      return call(cmd, args);
    },
  };

  async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args }),
    });
    const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!body.ok) throw body.error ?? `${cmd} failed`;
    return body.value;
  }
}