// `npm run web`: the real backend in a child process, vite, and a browser
// pointed at it. The app is served by vite; every command goes to the backend
// over /rpc, so this is the desktop app minus its window.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import net from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_PORT = 8472;
const VITE_PORT = 8471;
const BACKEND_BIN = join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "guimux-web.exe" : "guimux-web",
);

const kids = [];
const say = (m) => console.log(`[gm-web] ${m}`);

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...opts });
  kids.push(child);
  return child;
}

function tagged(child, tag) {
  createInterface({ input: child.stdout }).on("line", (l) => console.log(`${tag} ${l}`));
  child.stderr.on("data", (d) => process.stderr.write(`${tag} ${d}`));
}

function alive(port, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  return new Promise((done) => {
    const tick = () => {
      const s = net.connect({ host: "127.0.0.1", port });
      const give = () => {
        s.destroy();
        Date.now() < deadline ? setTimeout(tick, 250) : done(false);
      };
      s.setTimeout(500, give);
      s.on("connect", () => (s.destroy(), done(true)));
      s.on("error", give);
    };
    tick();
  });
}

const stop = (code = 0) => {
  for (const k of kids) k.kill();
  process.exit(code);
};
// Orphaned children (a crash above, a closed terminal) would hold port 8472.
process.on("exit", () => {
  for (const k of kids) k.kill();
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const build = run("cargo", ["build", "--bin", "guimux-web", "--manifest-path", "src-tauri/Cargo.toml"]);
tagged(build, "[cargo]");
const buildCode = await new Promise((done) => build.on("close", done));
if (buildCode !== 0 || !existsSync(BACKEND_BIN)) stop(1); // exits

const backend = run(BACKEND_BIN, []);
tagged(backend, "[backend]");
backend.on("close", (code) => {
  say(`backend exited (${code})`);
  stop(1);
});
if (!(await alive(BACKEND_PORT))) {
  say("backend never came up — see [backend] above");
  stop(1); // exits
}

// Vite's bin directly, not `npm run dev`: a shell wrapper survives kill() and
// would hold the port after this script dies.
const vite = run(process.execPath, ["node_modules/vite/bin/vite.js"]);
tagged(vite, "[vite]");
if (!(await alive(VITE_PORT))) {
  say("vite never came up — is port 8471 taken?");
  stop(1);
}

// Vite's own page, on its own origin: plugin-react injects the refresh
// preamble in transformIndexHtml, so a hand-rolled HTML page has no HMR.
const url = `http://localhost:${VITE_PORT}/`;
say(`open ${url}`);
const opener =
  process.platform === "win32"
    ? run("cmd", ["/c", "start", "", url])
    : run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
opener.on("error", () => {});