//! Dev-only HTTP bridge over the real backend, so `npm run web` runs the whole
//! app in a browser: `POST /rpc` carries `{cmd, args}` into the same command
//! handler the desktop app uses, `GET /events` streams the same events out.
//! Never packaged — the release build does not build this bin.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use guimux_lib::{configure, conpty_dll};
use serde_json::{json, Value};
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

    let listener = TcpListener::bind(("127.0.0.1", PORT)).unwrap_or_else(|e| {
        panic!("[gm-web] cannot bind 127.0.0.1:{PORT} ({e}) — is another web run alive?")
    });
    println!("[gm-web] backend on http://127.0.0.1:{PORT}");
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let (app, webview, hub) = (app.handle().clone(), webview.clone(), hub.clone());
        std::thread::spawn(move || {
            let _ = handle(stream, &app, &webview, &hub);
        });
    }
}

fn handle(
    mut stream: TcpStream,
    app: &AppHandle<MockRuntime>,
    webview: &WebviewWindow<MockRuntime>,
    hub: &Hub,
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
                return respond(&mut stream, "403 Forbidden", "text/plain", "origin not allowed");
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
    let body = match call(app, webview, hub, cmd, args) {
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
    port == "8471" && (origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:"))
}

/// Event names are dynamic (`pty:output-7`), so a listener is registered when
/// the frontend asks for one — the same moment Tauri registers a JS listener.
/// Handled here rather than through `on_message` because the mock context
/// carries no ACL, which denies every `plugin:*` command.
fn call(
    app: &AppHandle<MockRuntime>,
    webview: &WebviewWindow<MockRuntime>,
    hub: &Hub,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    if let Some(event) = cmd.strip_prefix("plugin:event|listen") {
        let event = args.get("event").and_then(Value::as_str).unwrap_or(event);
        let id = hub.next_id();
        let hub = hub.clone();
        app.listen_any(event.to_string(), move |e| {
            // EventSource only reads `data:` frames; the payload is the raw
            // JSON Tauri serialized, so it goes in unquoted.
            hub.publish(format!("data: {{\"id\":{id},\"payload\":{}}}\n\n", e.payload()));
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

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::is_vite;

    #[test]
    fn only_the_dev_page_may_drive_the_bridge() {
        assert!(is_vite("http://localhost:8471"));
        assert!(is_vite("http://127.0.0.1:8471"));
        assert!(!is_vite("http://evil.example"));
        assert!(!is_vite("http://localhost:3000"));
        assert!(!is_vite("http://localhost:8471.evil.example"));
    }
}