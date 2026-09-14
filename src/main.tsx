// Latin-only subsets: the bare `400.css` entry pulls every unicode subset
// (cyrillic, greek, vietnamese…) — ~13x the woff2 payload for glyphs this
// workbench never renders. Latin covers UI + terminal text.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/ubuntu-mono/latin-400.css";
import "@fontsource/ubuntu-mono/latin-700.css";
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
