// Monaco ships locally: @monaco-editor/loader otherwise fetches the AMD
// bundle from jsDelivr at runtime, which needs the network and is blocked by
// this app's `script-src 'self'` CSP in packaged builds.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
// monaco 0.56 resolves subpaths under `esm/vs/` via its exports map, and only
// the explicit `.js` form matches for every worker — without it the json
// worker silently fails to resolve. The full `monaco-editor/esm/vs/...`
// spelling no longer resolves at all.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

// Vite resolves each `?worker` import to its own bundle; Monaco asks for one
// by language label.
const env = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

(self as unknown as { MonacoEnvironment: typeof env }).MonacoEnvironment = env;

loader.config({ monaco });
