use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
  collections::HashMap,
  io::{Read, Write},
  path::Path,
  sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
  },
};
use tauri::{AppHandle, Emitter, Manager, State};

struct TerminalSession {
  writer: Mutex<Box<dyn Write + Send>>,
  master: Mutex<Box<dyn MasterPty + Send>>,
  child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
struct TerminalState {
  next_id: AtomicUsize,
  sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

#[derive(Serialize, Clone)]
struct TerminalOutputPayload {
  id: String,
  data: String,
}

#[derive(Serialize)]
struct TerminalCreatedPayload {
  id: String,
  shell: String,
}

#[derive(Serialize, Clone)]
struct TerminalExitedPayload {
  id: String,
}

fn default_shell() -> String {
  #[cfg(target_os = "windows")]
  {
    let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
    if Path::new(pwsh).exists() {
      return pwsh.to_string();
    }

    return "powershell.exe".to_string();
  }

  #[cfg(not(target_os = "windows"))]
  {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
  }
}

fn with_session<F, T>(state: &State<TerminalState>, id: &str, callback: F) -> Result<T, String>
where
  F: FnOnce(Arc<TerminalSession>) -> Result<T, String>,
{
  let session = state
    .sessions
    .lock()
    .map_err(|_| "terminal state lock poisoned".to_string())?
    .get(id)
    .cloned()
    .ok_or_else(|| format!("unknown terminal session: {id}"))?;

  callback(session)
}

#[tauri::command]
fn create_terminal(
  app: AppHandle,
  state: State<TerminalState>,
  cols: u16,
  rows: u16,
) -> Result<TerminalCreatedPayload, String> {
  let pty_system = native_pty_system();
  let pty_pair = pty_system
    .openpty(PtySize {
      rows,
      cols,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| error.to_string())?;

  let shell = default_shell();
  let mut command = CommandBuilder::new(shell.clone());
  command.env("TERM", "xterm-256color");

  let mut child = pty_pair
    .slave
    .spawn_command(command)
    .map_err(|error| error.to_string())?;

  let killer = child.clone_killer();

  drop(pty_pair.slave);

  let mut reader = pty_pair
    .master
    .try_clone_reader()
    .map_err(|error| error.to_string())?;
  let writer = pty_pair
    .master
    .take_writer()
    .map_err(|error| error.to_string())?;

  let id = state.next_id.fetch_add(1, Ordering::Relaxed).to_string();
  let session = Arc::new(TerminalSession {
    writer: Mutex::new(writer),
    master: Mutex::new(pty_pair.master),
    child_killer: Mutex::new(killer),
  });

  state
    .sessions
    .lock()
    .map_err(|_| "terminal state lock poisoned".to_string())?
    .insert(id.clone(), Arc::clone(&session));

  let app_handle = app.clone();
  let session_id = id.clone();

  std::thread::spawn(move || {
    let mut buffer = [0_u8; 8192];

    loop {
      match reader.read(&mut buffer) {
        Ok(0) => break,
        Ok(size) => {
          let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
          let _ = app_handle.emit(
            "terminal-output",
            TerminalOutputPayload {
              id: session_id.clone(),
              data,
            },
          );
        }
        Err(_) => break,
      }
    }
  });

  let session_id_wait = id.clone();
  let app_handle_wait = app.clone();
  std::thread::spawn(move || {
    let _ = child.wait();

    if let Some(state) = app_handle_wait.try_state::<TerminalState>() {
      if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(&session_id_wait);
      }
    }

    let _ = app_handle_wait.emit(
      "terminal-exited",
      TerminalExitedPayload { id: session_id_wait },
    );
  });

  Ok(TerminalCreatedPayload { id, shell })
}

#[tauri::command]
fn terminal_write(state: State<TerminalState>, id: String, data: String) -> Result<(), String> {
  with_session(&state, &id, |session| {
    let mut writer = session
      .writer
      .lock()
      .map_err(|_| "terminal writer lock poisoned".to_string())?;

    writer
      .write_all(data.as_bytes())
      .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
  })
}

#[tauri::command]
fn terminal_resize(
  state: State<TerminalState>,
  id: String,
  cols: u16,
  rows: u16,
) -> Result<(), String> {
  with_session(&state, &id, |session| {
    session
      .master
      .lock()
      .map_err(|_| "terminal master lock poisoned".to_string())?
      .resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
      })
      .map_err(|error| error.to_string())
  })
}

#[tauri::command]
fn terminal_kill(state: State<TerminalState>, id: String) -> Result<(), String> {
  let session = state
    .sessions
    .lock()
    .map_err(|_| "terminal state lock poisoned".to_string())?
    .remove(&id)
    .ok_or_else(|| format!("unknown terminal session: {id}"))?;

  let mut child = session
    .child_killer
    .lock()
    .map_err(|_| "terminal child lock poisoned".to_string())?;

  child.kill().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(TerminalState::default())
    .invoke_handler(tauri::generate_handler![
      create_terminal,
      terminal_write,
      terminal_resize,
      terminal_kill
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
