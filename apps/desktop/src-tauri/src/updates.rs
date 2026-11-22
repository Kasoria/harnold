// Auto update: checks GitHub Releases (latest.json) shortly after start and then every few hours,
// asks before installing, then restarts. Updates are verified with the updater key (tauri.conf.json).
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

fn german() -> bool {
    sys_locale::get_locale().map(|locale| locale.starts_with("de")).unwrap_or(true)
}

fn text<'a>(german_text: &'a str, english_text: &'a str) -> &'a str {
    if german() {
        german_text
    } else {
        english_text
    }
}

/// Runs in the background for the whole app lifetime; debug builds never update.
pub fn start_update_checks(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK_DELAY).await;
        loop {
            if let Err(update_error) = check_and_offer(&app).await {
                eprintln!("[updates] {update_error}");
            }
            tokio_sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

async fn check_and_offer(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else { return Ok(()) };

    let current_version = app.package_info().version.to_string();
    let message = if german() {
        format!("Harnold {} ist verfügbar (installiert: {current_version}).\n\nJetzt laden und neu starten? Laufende Agent-Durchläufe werden dabei beendet.", update.version)
    } else {
        format!("Harnold {} is available (installed: {current_version}).\n\nDownload and restart now? Running agent turns will be stopped.", update.version)
    };
    let dialog_handle = app.clone();
    let install_now = tauri::async_runtime::spawn_blocking(move || {
        dialog_handle
            .dialog()
            .message(message)
            .title(text("Update verfügbar", "Update available"))
            .buttons(MessageDialogButtons::OkCancelCustom(text("Jetzt aktualisieren", "Update now").into(), text("Später", "Later").into()))
            .blocking_show()
    })
    .await
    .map_err(|error| error.to_string())?;
    if !install_now {
        return Ok(());
    }

    if let Err(install_error) = update.download_and_install(|_chunk_length, _content_length| {}, || {}).await {
        let error_text = install_error.to_string();
        let dialog_handle = app.clone();
        let dialog_message = format!("{}\n\n{error_text}", text("Update fehlgeschlagen.", "Update failed."));
        let _ = tauri::async_runtime::spawn_blocking(move || {
            dialog_handle
                .dialog()
                .message(dialog_message)
                .kind(MessageDialogKind::Error)
                .blocking_show()
        })
        .await;
        return Err(error_text);
    }
    crate::stop_core(app);
    app.restart();
}
