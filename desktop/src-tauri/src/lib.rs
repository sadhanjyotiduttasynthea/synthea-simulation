//! Synthea Simulation desktop shell (Tauri 2).
//!
//! Responsibilities:
//! * start the local scientific compute engine (Python/FastAPI) as a sidecar bound to
//!   127.0.0.1 on a free port, protected by a random per-session token;
//! * expose `backend_info` so the web UI can find the engine;
//! * native application menu forwarded to the UI command bus ("menu" events);
//! * stop the engine when the application exits.

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
struct BackendInfo {
    url: String,
    token: String,
    ready: bool,
    version: String,
    data_dir: String,
}

struct Backend {
    port: u16,
    token: String,
    ready: Arc<AtomicBool>,
    data_dir: String,
    child: Mutex<Option<CommandChild>>,
    log: Arc<Mutex<Vec<String>>>,
}

#[tauri::command]
fn backend_info(app: AppHandle, state: tauri::State<'_, Backend>) -> BackendInfo {
    BackendInfo {
        url: format!("http://127.0.0.1:{}", state.port),
        token: state.token.clone(),
        ready: state.ready.load(Ordering::SeqCst),
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.clone(),
    }
}

#[tauri::command]
fn backend_log(state: tauri::State<'_, Backend>) -> Vec<String> {
    state.log.lock().map(|l| l.clone()).unwrap_or_default()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(48765)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("file.new", "New Project", Some("CmdOrCtrl+Alt+N"))?,
            &item("file.open", "Open Project…", Some("CmdOrCtrl+O"))?,
            &item("file.save", "Save", Some("CmdOrCtrl+S"))?,
            &item("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("paper.import", "Import Research PDF…", None)?,
            &item("geometry.importStl", "Import STL Geometry…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Exit"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("view.toggleLeft", "Model Builder", Some("CmdOrCtrl+1"))?,
            &item("view.toggleRight", "Settings", Some("CmdOrCtrl+2"))?,
            &item("view.toggleBottom", "Messages", Some("CmdOrCtrl+3"))?,
            &item("view.resetLayout", "Reset Layout", None)?,
            &item("view.dark", "Toggle Dark Mode", None)?,
        ],
    )?;
    let study = Submenu::with_items(
        app,
        "Study",
        true,
        &[&item("mesh.build", "Build Mesh", None)?, &item("study.compute", "Compute", Some("F5"))?],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&item("help.about", "About Synthea Simulation", None)?])?;
    Menu::with_items(app, &[&file, &edit, &view, &study, &help])
}

fn start_backend(app: &AppHandle, port: u16, token: &str, data_dir: &str, log: Arc<Mutex<Vec<String>>>) -> Option<CommandChild> {
    let push = |l: &Arc<Mutex<Vec<String>>>, s: String| {
        if let Ok(mut v) = l.lock() {
            v.push(s);
            if v.len() > 500 {
                v.remove(0);
            }
        }
    };
    let shell = app.shell();
    // Development: run the engine from the source tree with the configured Python
    // (SYNTHEA_DEV_PYTHON). Release: run the bundled sidecar executable.
    let cmd = if cfg!(debug_assertions) {
        let py = std::env::var("SYNTHEA_DEV_PYTHON").unwrap_or_else(|_| "python".into());
        let backend_dir = std::env::current_dir().ok().map(|d| d.join("../backend")).filter(|d| d.exists())
            .or_else(|| std::env::current_dir().ok().map(|d| d.join("../../backend")));
        let mut c = shell.command(py).args(["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", &port.to_string()]);
        if let Some(d) = backend_dir {
            c = c.current_dir(d);
        }
        c
    } else {
        match shell.sidecar("synthea-backend") {
            Ok(c) => c.args(["--port", &port.to_string()]),
            Err(e) => {
                push(&log, format!("sidecar not found: {e}"));
                return None;
            }
        }
    };
    let cmd = cmd.env("SYNTHEA_TOKEN", token).env("SYNTHEA_DATA_DIR", data_dir);
    match cmd.spawn() {
        Ok((mut rx, child)) => {
            let l2 = log.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => push(&l2, String::from_utf8_lossy(&b).trim_end().to_string()),
                        CommandEvent::Terminated(t) => push(&l2, format!("compute engine exited: {:?}", t.code)),
                        _ => {}
                    }
                }
            });
            Some(child)
        }
        Err(e) => {
            push(&log, format!("failed to start compute engine: {e}"));
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![backend_info, backend_log])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".into());
            let _ = std::fs::create_dir_all(&data_dir);
            let port = free_port();
            let token = uuid::Uuid::new_v4().to_string();
            let ready = Arc::new(AtomicBool::new(false));
            let log = Arc::new(Mutex::new(Vec::new()));
            let child = start_backend(&handle, port, &token, &data_dir, log.clone());
            {
                let ready = ready.clone();
                std::thread::spawn(move || {
                    for _ in 0..240 {
                        if TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok() {
                            ready.store(true, Ordering::SeqCst);
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                });
            }
            app.manage(Backend { port, token, ready, data_dir, child: Mutex::new(child), log });

            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();
                if id == "help.about" {
                    let v = app.package_info().version.to_string();
                    let _ = app.emit("menu", format!("help.about:{v}"));
                } else {
                    let _ = app.emit("menu", id);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Synthea Simulation");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Backend>() {
                if let Ok(mut c) = state.child.lock() {
                    if let Some(child) = c.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
