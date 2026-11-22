// Harnold desktop: starts the bundled Core (Node sidecar) and shows its UI in a native window.
use std::fs::{self, File};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

mod updates;

/// Own port, so a dev Core on 4317 can run alongside.
const CORE_PORT: u16 = 4327;
const CORE_START_TIMEOUT: Duration = Duration::from_secs(60);
const MAIN_WINDOW_LABEL: &str = "main";

struct CoreProcess(Mutex<Option<Child>>);

fn core_address() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], CORE_PORT))
}

/// GUI apps on macOS get a minimal PATH; the agent needs the user's (git, brew, claude …).
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '__HARNOLD_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started_at = Instant::now();
    while child.try_wait().ok()?.is_none() {
        if started_at.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let shell_path = text.rsplit("__HARNOLD_PATH__").next()?.trim().to_string();
    (!shell_path.is_empty()).then_some(shell_path)
}

fn effective_path() -> String {
    let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string();
    login_shell_path().unwrap_or_else(|| match std::env::var("PATH") {
        Ok(current_path) => format!("{fallback}:{current_path}"),
        Err(_) => fallback,
    })
}

fn start_core(app: &AppHandle) -> Result<Child, String> {
    if TcpListener::bind(core_address()).is_err() {
        return Err(format!("Port {CORE_PORT} ist belegt. Läuft Harnold schon in einem anderen Prozess?"));
    }
    let resource_directory = app.path().resource_dir().map_err(|error| error.to_string())?;
    let core_directory = resource_directory.join("core");
    let executable_directory: PathBuf = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("Programmordner nicht gefunden")?
        .to_path_buf();
    let node_binary = executable_directory.join("node");

    let log_directory = app.path().app_log_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_directory).map_err(|error| error.to_string())?;
    let log_file = File::create(log_directory.join("core.log")).map_err(|error| error.to_string())?;
    let error_log_file = log_file.try_clone().map_err(|error| error.to_string())?;

    Command::new(&node_binary)
        .arg("src/index.ts")
        .current_dir(&core_directory)
        .env("PATH", effective_path())
        .env("HARNOLD_HOST", "127.0.0.1")
        .env("HARNOLD_PORT", CORE_PORT.to_string())
        .env("HARNOLD_UI_DIR", resource_directory.join("ui"))
        .env("NODE_ENV", "production")
        .env("HARNOLD_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(log_file)
        .stderr(error_log_file)
        .spawn()
        .map_err(|error| format!("Core konnte nicht starten: {error}"))
}

fn wait_for_core(app: &AppHandle) -> Result<(), String> {
    let started_at = Instant::now();
    loop {
        if TcpStream::connect_timeout(&core_address(), Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        if let Some(core_child) = app.state::<CoreProcess>().0.lock().unwrap().as_mut() {
            if let Ok(Some(exit_status)) = core_child.try_wait() {
                return Err(format!("Core wurde beendet ({exit_status})."));
            }
        }
        if started_at.elapsed() > CORE_START_TIMEOUT {
            return Err("Core antwortet nicht.".into());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn show_core_error(app: &AppHandle, window: &WebviewWindow, message: &str) {
    let log_path = app.path().app_log_dir().map(|directory| directory.join("core.log").display().to_string()).unwrap_or_default();
    let full_message = format!("{message}\n\nLog: {log_path}");
    let escaped_message = full_message.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
    let _ = window.eval(&format!("window.showCoreError(`{escaped_message}`)"));
}

pub(crate) fn stop_core(app: &AppHandle) {
    let Some(mut core_child) = app.state::<CoreProcess>().0.lock().unwrap().take() else { return };
    // SIGTERM first so the Core can end its agent subprocesses, then force.
    let _ = Command::new("kill").args(["-TERM", &core_child.id().to_string()]).status();
    let stopped_at = Instant::now();
    while stopped_at.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = core_child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = core_child.kill();
    let _ = core_child.wait();
}

fn is_core_url(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob") || matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let navigation_handle = app.clone();
    let new_window_handle = app.clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Harnold")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .center()
        // External links go to the default browser, not into the app window.
        .on_navigation(move |url| {
            if is_core_url(url) {
                return true;
            }
            let _ = navigation_handle.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .on_new_window(move |url, _features| {
            let _ = new_window_handle.opener().open_url(url.as_str(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _working_directory| show_main_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![updates::check_for_update, updates::install_update])
        .setup(|app| {
            let app_handle = app.handle().clone();
            updates::start_update_checks(app_handle.clone());
            let window = create_main_window(&app_handle)?;
            match start_core(&app_handle) {
                Ok(core_child) => {
                    *app_handle.state::<CoreProcess>().0.lock().unwrap() = Some(core_child);
                    thread::spawn(move || match wait_for_core(&app_handle) {
                        Ok(()) => {
                            let core_url = Url::parse(&format!("http://127.0.0.1:{CORE_PORT}/")).expect("valid core url");
                            let _ = window.navigate(core_url);
                        }
                        Err(message) => show_core_error(&app_handle, &window, &message),
                    });
                }
                Err(message) => {
                    // The splash page may still be loading; give it a moment before showing the error.
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(500));
                        show_core_error(&app_handle, &window, &message);
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides the window: Core keeps running (tasks, channels) until the app quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Harnold konnte nicht starten");

    app.run(|app_handle, event| match event {
        RunEvent::Reopen { .. } => show_main_window(app_handle),
        RunEvent::Exit => stop_core(app_handle),
        _ => {}
    });
}
