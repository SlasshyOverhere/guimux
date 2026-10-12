//! Dev-only HTTP bridge over the real backend, so `npm run web` runs the whole
//! app in a browser: `POST /rpc` carries `{cmd, args}` into the same command
//! handler the desktop app uses, `GET /events` streams the same events out.
//! Never packaged — the release build does not build this bin.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use guimux_lib::{configure, conpty_dll};
use serde_json::{json, Map, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Listener, WebviewWindow, WebviewWindowBuilder};

const PORT: u16 = 8472;

/// One lock for every command dispatch: the desktop app runs sync commands
/// inline on a single IPC thread, and `pty_write` depends on that FIFO order.
static DISPATCH: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct HubInner {
    next_id: u64,
    clients: Vec<(u64, Sender<String>)>,
}

#[derive(Default, Clone)]
struct Hub(Arc<Mutex<HubInner>>);

impl Hub {
    fn next_id(&self) -> u64 {
        let mut g = self.lock();
        g.next_id += 1;
        g.next_id
    }

    fn publish(&self, msg: String) {
        self.lock()
            .clients
            .retain(|(_, tx)| tx.send(msg.clone()).is_ok());
    }

    /// Drops every client whose stream is gone: a closed socket makes `send`
    /// fail, and a full buffer would otherwise block the PTY pump.
    fn subscribe(&self) -> (u64, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_id();
        self.lock().clients.push((id, tx));
        (id, rx)
    }

    fn unsubscribe(&self, id: u64) {
        self.lock().clients.retain(|(i, _)| *i != id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn main() {
    #[cfg(windows)]
    if !conpty_dll::ensure_bundled_conpty() {
        eprintln!("[gm-web] refusing startup: bundled ConPTY failed integrity checks");
        return;
    }

    let app = configure(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("[gm-web] backend failed to start");
    let webview = WebviewWindowBuilder::new(&app, "web", Default::default())
        .build()
        .expect("[gm-web] mock webview failed to start");
    let hub = Hub::default();
    let store = DesktopStore::open(desktop_store_path());
    println!("[gm-web] sharing the desktop store at {}", store.path().display());

    let listener = TcpListener::bind(("127.0.0.1", PORT)).unwrap_or_else(|e| {
        panic!("[gm-web] cannot bind 127.0.0.1:{PORT} ({e}) — is another web run alive?")
    });
    println!("[gm-web] backend on http://127.0.0.1:{PORT}");
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let (app, webview, hub, store) = (
            app.handle().clone(),
            webview.clone(),
            hub.clone(),
            store.clone(),
        );
        std::thread::spawn(move || {
            let _ = handle(stream, &app, &webview, &hub, &store);
        });
    }
}

fn handle(
    mut stream: TcpStream,
    app: &AppHandle<MockRuntime>,
    webview: &WebviewWindow<MockRuntime>,
    hub: &Hub,
    store: &DesktopStore,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().unwrap_or(0);
        }
        if name.eq_ignore_ascii_case("origin") {
            let origin = value.trim();
            if !origin.is_empty() && !is_vite(origin) {
                return respond(
                    &mut stream,
                    "403 Forbidden",
                    "text/plain",
                    "origin not allowed",
                );
            }
        }
    }

    if method == "OPTIONS" {
        return respond(&mut stream, "204 No Content", "text/plain", "");
    }
    if method == "GET" && path == "/events" {
        return stream_events(stream, hub);
    }

    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body)?;
    }
    let Ok(req) = serde_json::from_slice::<Value>(&body) else {
        return respond(
            &mut stream,
            "400 Bad Request",
            "application/json",
            r#"{"ok":false,"error":"bad json"}"#,
        );
    };
    let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or_default();
    let args = req.get("args").cloned().unwrap_or(json!({}));
    let body = match call(app, webview, hub, store, cmd, args) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    respond(&mut stream, "200 OK", "application/json", &body.to_string())
}

/// Only vite's page may talk to the bridge: it drives real shells and git, so a
/// page the user happens to be visiting must not reach it.
fn is_vite(origin: &str) -> bool {
    let Some(port) = origin.rsplit(':').next() else {
        return false;
    };
    port == "8471"
        && (origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:"))
}

/// Event names are dynamic (`pty:output-7`), so a listener is registered when
/// the frontend asks for one — the same moment Tauri registers a JS listener.
/// Handled here rather than through `on_message` because the mock context
/// carries no ACL, which denies every `plugin:*` command.
fn call(
    app: &AppHandle<MockRuntime>,
    webview: &WebviewWindow<MockRuntime>,
    hub: &Hub,
    store: &DesktopStore,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    if let Some(rest) = cmd.strip_prefix("plugin:store|") {
        return store.command(rest, &args);
    }
    if let Some(event) = cmd.strip_prefix("plugin:event|listen") {
        let event = args.get("event").and_then(Value::as_str).unwrap_or(event);
        let id = hub.next_id();
        let hub = hub.clone();
        app.listen_any(event.to_string(), move |e| {
            // EventSource only reads `data:` frames; the payload is the raw
            // JSON Tauri serialized, so it goes in unquoted.
            hub.publish(format!(
                "data: {{\"id\":{id},\"payload\":{}}}\n\n",
                e.payload()
            ));
        });
        return Ok(json!(id));
    }
    if cmd.starts_with("plugin:event|") {
        return Ok(Value::Null);
    }

    let _guard = DISPATCH.lock().unwrap_or_else(|e| e.into_inner());
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
    .parse()
    .expect("static url");
    match tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // A local URL keeps the invoke off the remote-origin ACL path.
            url,
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    ) {
        Ok(InvokeResponseBody::Json(raw)) => {
            serde_json::from_str(&raw).map_err(|e| format!("bad response json: {e}"))
        }
        Ok(InvokeResponseBody::Raw(_)) => {
            Err("binary responses are not supported over the web bridge".into())
        }
        Err(e) => Err(match e {
            Value::String(s) => s,
            other => other.to_string(),
        }),
    }
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

fn stream_events(mut stream: TcpStream, hub: &Hub) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut out = stream.try_clone()?;
    let (id, rx) = hub.subscribe();
    while let Ok(msg) = rx.recv() {
        if out.write_all(msg.as_bytes()).is_err() || out.flush().is_err() {
            break;
        }
    }
    hub.unsubscribe(id);
    Ok(())
}

/// Where the packaged app keeps `guimux.json`: tauri-plugin-store resolves
/// relative store paths in `app_data_dir` + the bundle identifier, and
/// `GUIMUX_STORE` overrides it for tests.
fn desktop_store_path() -> PathBuf {
    if let Some(path) = std::env::var_os("GUIMUX_STORE") {
        return path.into();
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
            })
    };
    base.unwrap_or_default()
        .join("com.guimux.app")
        .join("guimux.json")
}

/// The four store-plugin commands the app actually calls, backed by the
/// desktop app's own file — so `npm run web` reads and writes the projects the
/// packaged app has instead of a browser-only copy. Both writers own the same
/// key, so the last `save` wins for it (run one or the other, not both).
#[derive(Clone)]
struct DesktopStore(Arc<Mutex<StoreFile>>);

struct StoreFile {
    path: PathBuf,
    entries: Map<String, Value>,
}

impl DesktopStore {
    fn open(path: PathBuf) -> Self {
        let entries = read_map(&path).unwrap_or_default();
        Self(Arc::new(Mutex::new(StoreFile { path, entries })))
    }

    fn path(&self) -> PathBuf {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).path.clone()
    }

    fn command(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        let key = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let mut file = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match cmd {
            // The resource id is opaque to the JS: it hands it back on every
            // other store command and there is only one store here.
            "load" => Ok(json!(1)),
            "get" => Ok(json!([
                file.entries.get(&key("key")).cloned().unwrap_or(Value::Null),
                file.entries.contains_key(&key("key"))
            ])),
            "set" => {
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                file.entries.insert(key("key"), value);
                Ok(Value::Null)
            }
            "save" => {
                // Re-read first: keys the desktop app added since this process
                // loaded the file must survive a browser write.
                let mut base = read_map(&file.path).unwrap_or_default();
                base.extend(file.entries.iter().map(|(k, v)| (k.clone(), v.clone())));
                file.entries = base;
                write_map(&file.path, &file.entries).map(|()| Value::Null)
            }
            other => Err(format!("store.{other} is not implemented by the web bridge")),
        }
    }
}

fn read_map(path: &Path) -> Option<Map<String, Value>> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.as_object().cloned()
}

fn write_map(path: &Path, entries: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(entries.clone()))
        .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text.as_bytes()).is_ok() && std::fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    std::fs::write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{is_vite, DesktopStore};

    #[test]
    fn only_the_dev_page_may_drive_the_bridge() {
        assert!(is_vite("http://localhost:8471"));
        assert!(is_vite("http://127.0.0.1:8471"));
        assert!(!is_vite("http://evil.example"));
        assert!(!is_vite("http://localhost:3000"));
        assert!(!is_vite("http://localhost:8471.evil.example"));
    }

    #[test]
    fn the_browser_writes_the_desktop_apps_own_store() {
        let dir = std::env::temp_dir().join("gm-web-store-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("guimux.json");
        std::fs::write(&path, r#"{"guimux-state-v1":{"projects":[{"id":"a"}]}}"#).unwrap();

        let store = DesktopStore::open(path.clone());
        store.command("load", &serde_json::json!({})).unwrap();
        // The desktop app's projects are visible to the browser build.
        let got = store.command("get", &serde_json::json!({"key":"guimux-state-v1"}));
        assert_eq!(got.unwrap()[0]["projects"][0]["id"], serde_json::json!("a"));
        let missing = store.command("get", &serde_json::json!({"key":"nope"}));
        assert_eq!(missing.unwrap(), serde_json::json!([null, false]));

        store
            .command(
                "set",
                &serde_json::json!({"key":"guimux-state-v1","value":{"projects":[{"id":"b"}]}}),
            )
            .unwrap();
        store.command("save", &serde_json::json!({})).unwrap();

        // ...and what the browser wrote is what the desktop app will read.
        let reopened = DesktopStore::open(path);
        let got = reopened
            .command("get", &serde_json::json!({"key":"guimux-state-v1"}))
            .unwrap();
        assert_eq!(got[0]["projects"][0]["id"], serde_json::json!("b"));
    }
}
