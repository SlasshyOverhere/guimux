// Latin-only subsets: the bare `400.css` entry pulls every unicode subset
// (cyrillic, greek, vietnamese…) — ~13x the woff2 payload for glyphs this
// workbench never renders. Latin covers UI + terminal text.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
// Full mono subsets (not latin-only): TUI box-drawing/block glyphs live
// outside latin's unicode-range; latin-only leaves them to a mismatched
// system fallback at a different advance (gappy borders/logos). Inter stays
// latin-only: UI text never needs those glyphs.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/700.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: xterm 5.5.0's Viewport schedules a setTimeout(0) in its
// constructor that reads RenderService.dimensions after dispose. StrictMode's
// dev double-mount disposes the first terminal before that timer fires, so
// every dev reload logs `Cannot read properties of undefined (dimensions)`.
// Harmless in prod (no double-mount), pure noise in dev; dropped instead of
// worked around.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
