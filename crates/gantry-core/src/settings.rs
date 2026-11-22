//! The application settings file: `settings.json` in the app config directory.
//!
//! The core keeps the settings as one JSON object and reads and writes it as a whole. The value
//! types and their defaults belong to the frontend, which sanitizes every value it reads. The
//! directory is a parameter, so the core needs no Tauri.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// The settings as stored: a JSON object.
pub type Settings = Map<String, Value>;

/// The name of the settings file inside the app config directory.
pub const SETTINGS_FILE: &str = "settings.json";

/// The path of the settings file in `dir`.
pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join(SETTINGS_FILE)
}

fn failure(path: &Path, message: impl std::fmt::Display) -> Error {
    Error::Settings {
        path: path.display().to_string(),
        message: message.to_string(),
    }
}

/// Reads the settings of `dir`. A missing file gives empty settings (the defaults apply); a file
/// that cannot be read or is not a JSON object is an error that names the path.
pub fn read_settings(dir: &Path) -> Result<Settings> {
    let path = settings_path(dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Settings::new()),
        Err(error) => return Err(failure(&path, error)),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(settings)) => Ok(settings),
        Ok(_) => Err(failure(&path, "expected a JSON object")),
        Err(error) => Err(failure(&path, error)),
    }
}

/// Writes `settings` to `dir` atomically: a temporary file in the same directory, then a rename,
/// so a crash never leaves a half-written file. Creates `dir` when missing.
pub fn write_settings(dir: &Path, settings: &Settings) -> Result<()> {
    let path = settings_path(dir);
    let text = serde_json::to_string_pretty(settings).map_err(|e| failure(&path, e))?;
    fs::create_dir_all(dir).map_err(|e| failure(dir, e))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|e| failure(&temporary, e))?;
    fs::rename(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        failure(&path, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Settings {
        json!({ "appearance": { "theme": "dark" } })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_settings(dir.path()).unwrap().is_empty());
        assert!(read_settings(&dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn a_written_value_is_read_back() {
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &sample()).unwrap();
        assert_eq!(read_settings(dir.path()).unwrap(), sample());
    }

    #[test]
    fn writing_creates_the_directory_and_leaves_no_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("config").join("gantry");
        write_settings(&dir, &sample()).unwrap();
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [SETTINGS_FILE]);
    }

    #[test]
    fn a_write_replaces_the_previous_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &sample()).unwrap();
        write_settings(dir.path(), &Settings::new()).unwrap();
        assert!(read_settings(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn an_unreadable_file_is_an_error_with_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        for content in ["{ not json", "[1, 2]"] {
            fs::write(&path, content).unwrap();
            let message = read_settings(dir.path()).unwrap_err().to_string();
            assert!(message.contains(&path.display().to_string()), "{message}");
        }
        // A directory in place of the file cannot be read either.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let message = read_settings(dir.path()).unwrap_err().to_string();
        assert!(message.contains(SETTINGS_FILE), "{message}");
    }

    #[test]
    fn a_failed_write_is_an_error_with_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        fs::write(&blocker, "x").unwrap();
        let message = write_settings(&blocker, &sample()).unwrap_err().to_string();
        assert!(
            message.contains(&blocker.display().to_string()),
            "{message}"
        );
    }
}
