// OSC sequences a pane sees in its raw output stream.
//
// Two families matter here:
//
//   OSC 7  / OSC 9;9   the shell's cwd. Emitted by the powershell bootstrap
//                       in pty.rs on every prompt, so the pane can label
//                       itself and splits inherit the directory.
//   OSC 0/1/2           the window title. Every shell overwrites this with the
//                       cwd on each prompt, but a CLI agent (claude, codex,
//                       opencode) replaces it with its conversation name once
//                       the session has one. That difference is the signal.
//
// Pure functions with no imports: these are byte-level parsers and the only
// honest way to trust them is to feed them awkward input in a test.

/** Strip a control-char prefix a shell puts on its title (`✗`, `➜`, `~`). */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[\x00-\x1f]/g, "")
    .replace(/^[\s✗✘➜➤❯→~·•\-–—|*#]+/, "")
    .replace(/\s+$/, "")
    .trim();
}

// Matches an absolute Windows or POSIX path, with or without a drive letter.
const PATHY = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.{1,2}[\\/]|[~][\\/]?)/;

export interface ParsedOsc {
  cwd: string | null;
  title: string | null;
}

/**
 * Last-wins scan over a buffer. Callers keep a tail of previous output so a
 * sequence split across two chunks still parses; see TerminalPane's snoop.
 */
export function parseOsc(buf: string): ParsedOsc {
  let native: string | null = null;
  let uriPath: string | null = null;
  let title: string | null = null;
  let m: RegExpExecArray | null;

  const re99 = /\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = re99.exec(buf)) !== null) {
    const p = m[1].trim();
    if (p) native = p;
  }
  const re7 = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = re7.exec(buf)) !== null) {
    const uri = m[1].trim();
    const i = uri.indexOf("file://");
    if (i < 0) continue;
    const rest = uri.slice(i + "file://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue;
    let path = rest.slice(slash);
    try {
      path = decodeURIComponent(path);
    } catch {
      /* raw on bad escapes */
    }
    path = path.replace(/\//g, "\\");
    if (/^\\[A-Za-z]:\\/.test(path)) path = path.slice(1);
    if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) uriPath = path;
  }
  // OSC 0 sets icon+window, OSC 1 the icon, OSC 2 the window. The window part
  // is the last `;` segment, and only OSC 0/2 are worth trusting.
  const reTitle = /\x1b\]([02]);(?:[^;]*;)?([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = reTitle.exec(buf)) !== null) {
    const t = cleanTitle(m[2]);
    if (t) title = t;
  }
  return { cwd: native ?? uriPath, title };
}

/** Cwd only, for callers that do not care about the title. */
export function extractLiveCwd(buf: string): string | null {
  return parseOsc(buf).cwd;
}

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Decide whether a window title is an agent's conversation name rather than
 * the shell's cwd echo.
 *
 * The shells in play all set the title to something like
 * `✗ D:\orca-workspace\guimux` on every prompt, and that fires far more often
 * than an agent names a session. So a title is only believed when it does not
 * look like the directory we are standing in, and is not a bare path.
 */
export function sessionNameFrom(title: string | null, cwd: string | null): string | null {
  if (!title) return null;
  const t = cleanTitle(title);
  if (!t || t.length > 120) return null;
  const norm = normalize(t);
  if (cwd) {
    const c = normalize(cwd);
    // Either direction: shells append markers (`✗ dir (branch)`), some agents
    // prefix their own name to the directory.
    if (norm === c || norm.includes(c) || c.includes(norm)) return null;
  }
  if (PATHY.test(t)) return null;
  // A title with no letters is an icon, a spinner or a bare process id.
  if (!/[a-z]/i.test(t)) return null;
  return t;
}
