import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Saving through guimux's own editor writes into the directory this server
// watches, so Vite would hot-update the app that made the save: the explorer
// remounts and every terminal replays. The editor announces each write over
// HMR first, and the watcher ignores those paths for a moment. An edit from
// outside guimux still reloads as usual.
const appWrites = new Set<string>();
const APP_WRITE_GRACE_MS = 2000;
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

function ignoreAppWrites(): Plugin {
  // One timer per path: a repeat announce refreshes the window instead of
  // scheduling a second delete that would close it early.
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    name: "guimux-ignore-app-writes",
    apply: "serve",
    configureServer(server) {
      // server.hot, not server.ws: custom events are dispatched through the HMR
      // broadcaster, and a listener on the socket server never receives them.
      server.hot.on("guimux:app-write", (data: { path?: string }) => {
        if (!data?.path) return;
        const key = normPath(data.path);
        appWrites.add(key);
        const prev = expiry.get(key);
        if (prev) clearTimeout(prev);
        expiry.set(
          key,
          setTimeout(() => {
            appWrites.delete(key);
            expiry.delete(key);
          }, APP_WRITE_GRACE_MS),
        );
      });
    },
    // The chokidar `ignored` option above does not filter change events for a
    // file it already tracks, so the suppression has to happen here. An empty
    // array means Vite sends no update for the file.
    // chokidar's `ignored` does not filter change events for a file it already
    // tracks, so the suppression has to happen here: an empty array means Vite
    // sends no update for that file.
    handleHotUpdate(ctx) {
      if (appWrites.has(normPath(ctx.file))) return [];
    },
  };
}

// Tauri expects a fixed port, fail if that port is not available
// Tauri serves prod from the bundled dist root, not dev's `/`:
// relative URLs keep fonts (Inter/Ubuntu Mono) resolving in the build.
export default defineConfig({
  base: "./",
  plugins: [react(), ignoreAppWrites()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        (path: string) => appWrites.has(normPath(path)),
      ]
    }
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
