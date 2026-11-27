fn main() {
    // App commands must be declared so capabilities can allow them for the Core-served UI (remote origin).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["check_for_update", "install_update", "allow_embedded_origin"])),
    )
    .expect("failed to run tauri-build");
}
