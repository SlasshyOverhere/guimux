import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port, fail if that port is not available
// Tauri serves prod from the bundled dist root, not dev's `/`:
// relative URLs keep fonts (Inter/Ubuntu Mono) resolving in the build.
export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
