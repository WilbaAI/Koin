use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn data_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("could not resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.join("koin-data.json")
}

#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<String, String> {
    let path = data_path(&app);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(_) => Ok(String::from("null")),
    }
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = data_path(&app);
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_file_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_path(&app).to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            data_file_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running koin");
}
