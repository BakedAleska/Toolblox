//! Lifecycle ownership for declared widget sidecar processes.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;

use serde::Serialize;

use crate::widgets::WidgetProcess;

const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetProcessEvent {
    pub widget_id: String,
    pub process_id: String,
    pub stream: ProcessStream,
    pub line: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

struct ManagedProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct WidgetProcessManager {
    processes: HashMap<(String, String), ManagedProcess>,
    events_tx: SyncSender<WidgetProcessEvent>,
    events_rx: Receiver<WidgetProcessEvent>,
    pending_events: VecDeque<WidgetProcessEvent>,
}

impl Default for WidgetProcessManager {
    fn default() -> Self {
        let (events_tx, events_rx) = mpsc::sync_channel(1_024);
        Self {
            processes: HashMap::new(),
            events_tx,
            events_rx,
            pending_events: VecDeque::new(),
        }
    }
}

impl WidgetProcessManager {
    pub fn start(
        &mut self,
        widget_id: &str,
        widget_root: &Path,
        declaration: &WidgetProcess,
        arguments: &[String],
    ) -> Result<(), String> {
        validate_arguments(declaration, arguments)?;
        let key = (widget_id.to_owned(), declaration.id.clone());
        if let Some(process) = self.processes.get_mut(&key) {
            match process.child.try_wait() {
                Ok(None) => return Err("The widget process is already running.".into()),
                Ok(Some(_)) => {
                    self.processes.remove(&key);
                }
                Err(_) => return Err("The widget process state couldn't be read.".into()),
            }
        }
        let root = widget_root
            .canonicalize()
            .map_err(|_| "Couldn't resolve the widget directory.".to_string())?;
        let executable = canonical_child(&root, &declaration.executable)?;
        let mut child = Command::new(executable)
            .args(arguments)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| {
                "Couldn't start the widget process. Is the package complete?".to_string()
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Couldn't open the widget process input.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Couldn't open the widget process output.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Couldn't open the widget process error stream.".to_string())?;

        spawn_reader(
            self.events_tx.clone(),
            widget_id.to_owned(),
            declaration.id.clone(),
            ProcessStream::Stdout,
            stdout,
        );
        spawn_reader(
            self.events_tx.clone(),
            widget_id.to_owned(),
            declaration.id.clone(),
            ProcessStream::Stderr,
            stderr,
        );
        self.processes.insert(key, ManagedProcess { child, stdin });
        Ok(())
    }

    pub fn send(&mut self, widget_id: &str, process_id: &str, message: &str) -> Result<(), String> {
        if message.len() > MAX_LINE_BYTES || message.contains(['\n', '\r']) {
            return Err("Widget process messages must be one line under 64 KB.".into());
        }
        serde_json::from_str::<serde_json::Value>(message)
            .map_err(|_| "Widget process messages must be valid JSON.".to_string())?;
        let process = self
            .processes
            .get_mut(&(widget_id.to_owned(), process_id.to_owned()))
            .ok_or_else(|| "The widget process isn't running.".to_string())?;
        process
            .stdin
            .write_all(message.as_bytes())
            .and_then(|_| process.stdin.write_all(b"\n"))
            .and_then(|_| process.stdin.flush())
            .map_err(|_| "Couldn't send data to the widget process.".to_string())
    }

    pub fn stop(&mut self, widget_id: &str, process_id: &str) -> Result<(), String> {
        let Some(mut process) = self
            .processes
            .remove(&(widget_id.to_owned(), process_id.to_owned()))
        else {
            return Ok(());
        };
        if process
            .child
            .try_wait()
            .is_ok_and(|status| status.is_some())
        {
            return Ok(());
        }
        process
            .child
            .kill()
            .map_err(|_| "Couldn't stop the widget process.".to_string())?;
        process
            .child
            .wait()
            .map_err(|_| "Couldn't finish stopping the widget process.".to_string())?;
        Ok(())
    }

    pub fn stop_widget(&mut self, widget_id: &str) {
        let ids: Vec<_> = self
            .processes
            .keys()
            .filter(|(owner, _)| owner == widget_id)
            .cloned()
            .collect();
        for (owner, process_id) in ids {
            let _ = self.stop(&owner, &process_id);
        }
    }

    pub fn stop_all(&mut self) {
        let ids: Vec<_> = self.processes.keys().cloned().collect();
        for (widget_id, process_id) in ids {
            let _ = self.stop(&widget_id, &process_id);
        }
    }

    pub fn drain_events(&mut self, widget_id: &str) -> Vec<WidgetProcessEvent> {
        self.pending_events.extend(self.events_rx.try_iter());
        let mut matching = Vec::new();
        let mut remaining = VecDeque::new();
        while let Some(event) = self.pending_events.pop_front() {
            if event.widget_id == widget_id {
                matching.push(event);
            } else {
                remaining.push_back(event);
            }
        }
        self.pending_events = remaining;
        matching
    }
}

impl Drop for WidgetProcessManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn canonical_child(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "Couldn't resolve the widget process executable.".to_string())?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err("The widget process executable is outside its package.".into());
    }
    Ok(resolved)
}

fn validate_arguments(declaration: &WidgetProcess, arguments: &[String]) -> Result<(), String> {
    if arguments.len() > 32
        || arguments.iter().any(|argument| {
            argument.len() > 1_024 || !declaration.allowed_arguments.contains(argument)
        })
    {
        return Err("The widget requested unsupported process arguments.".into());
    }
    Ok(())
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    sender: SyncSender<WidgetProcessEvent>,
    widget_id: String,
    process_id: String,
    stream: ProcessStream,
    reader: R,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let mut bytes = Vec::new();
            loop {
                let Ok(buffer) = reader.fill_buf() else {
                    return;
                };
                if buffer.is_empty() {
                    return;
                }
                let consumed = buffer
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(buffer.len(), |position| position + 1);
                let remaining = MAX_LINE_BYTES.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..consumed.min(remaining)]);
                let complete = buffer[..consumed].ends_with(b"\n");
                reader.consume(consumed);
                if complete {
                    break;
                }
            }
            while bytes
                .last()
                .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
            {
                bytes.pop();
            }
            let line = String::from_utf8_lossy(&bytes).into_owned();
            if sender
                .send(WidgetProcessEvent {
                    widget_id: widget_id.clone(),
                    process_id: process_id.clone(),
                    stream,
                    line,
                })
                .is_err()
            {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_manifest_arguments_are_allowed() {
        let declaration = WidgetProcess {
            id: "worker".into(),
            executable: "optional-bin/worker".into(),
            allowed_arguments: vec!["--quiet".into()],
        };
        assert!(validate_arguments(&declaration, &["--quiet".into()]).is_ok());
        assert!(validate_arguments(&declaration, &["--shell".into()]).is_err());
    }

    #[test]
    fn process_messages_must_be_single_line_json() {
        let mut manager = WidgetProcessManager::default();
        assert!(manager.send("sample", "worker", "not-json").is_err());
        assert!(manager.send("sample", "worker", "{}\n{}").is_err());
    }

    #[test]
    fn process_events_stay_scoped_to_their_widget() {
        let mut manager = WidgetProcessManager::default();
        for widget_id in ["first", "second"] {
            manager
                .events_tx
                .send(WidgetProcessEvent {
                    widget_id: widget_id.into(),
                    process_id: "worker".into(),
                    stream: ProcessStream::Stdout,
                    line: widget_id.into(),
                })
                .unwrap();
        }
        assert_eq!(manager.drain_events("first").len(), 1);
        let second = manager.drain_events("second");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].widget_id, "second");
    }
}
