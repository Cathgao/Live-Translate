// UART serial manager — backend for the desktop client.
//
// Provides Tauri commands:
//   - serial_list                  : list available COM ports
//   - serial_open (SerialConfig)   : open port, return port_id (u32), start RX thread
//   - serial_close (port_id)       : close port + stop RX thread
//   - serial_write (port_id,bytes) : write bytes to port (no line-ending appended by default)
//
// Events emitted to the frontend:
//   - serial-rx-line   { port_id, line, ts_ms }     when a complete line arrives
//   - serial-rx-error  { port_id, error }           on read failure (port unplugged, etc.)
//   - serial-closed    { port_id, reason }          when the port is closed from this side
//
// The serialport crate is synchronous and blocking. RX threads therefore run on
// `tauri::async_runtime::spawn_blocking`, which is the recommended way to mix
// blocking I/O with Tauri's tokio runtime.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use tauri::{AppHandle, Emitter};

/// Config for opening a port.
#[derive(Debug, Clone, Deserialize)]
pub struct SerialConfig {
    pub port_name: String,
    pub baud: u32,
    pub data_bits: u8,   // 5..=8
    pub stop_bits: u8,   // 1 or 2
    pub parity: String,  // "none" | "odd" | "even"
}

/// Info about an available port.
#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub name: String,
    pub kind: String, // "USB" | "Bluetooth" | "PCI" | "Unknown"
    pub label: String,
}

/// Per-port state.
struct PortEntry {
    port: Mutex<Box<dyn SerialPort>>,
    rx_alive: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
pub struct SerialManager {
    /// port_id -> PortEntry
    ports: Mutex<HashMap<u32, PortEntry>>,
    next_id: AtomicU32,
}

impl SerialManager {
    fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn list_ports_inner() -> Vec<PortInfo> {
        match serialport::available_ports() {
            Ok(ports) => ports
                .into_iter()
                .map(|p| {
                    let (kind, label) = match p.port_type {
                        serialport::SerialPortType::UsbPort(info) => {
                            ("USB".to_string(), {
                                let mut s = info.manufacturer.unwrap_or_default();
                                if !s.is_empty() {
                                    s.push(' ');
                                }
                                s.push_str(&info.product.unwrap_or_default());
                                if s.trim().is_empty() {
                                    s = "USB Serial".to_string();
                                }
                                s
                            })
                        }
                        serialport::SerialPortType::BluetoothPort => {
                            ("Bluetooth".to_string(), "Bluetooth Serial".to_string())
                        }
                        serialport::SerialPortType::PciPort => {
                            ("PCI".to_string(), "PCI Serial".to_string())
                        }
                        serialport::SerialPortType::Unknown => {
                            ("Unknown".to_string(), "Serial Port".to_string())
                        }
                    };
                    PortInfo { name: p.port_name, kind, label }
                })
                .collect(),
            Err(e) => {
                eprintln!("[serial] available_ports failed: {e}");
                Vec::new()
            }
        }
    }

    pub fn open_inner(
        &self,
        app: AppHandle,
        cfg: SerialConfig,
    ) -> Result<u32, String> {
        let data_bits = match cfg.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err(format!("invalid data_bits: {}", cfg.data_bits)),
        };
        let stop_bits = match cfg.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err(format!("invalid stop_bits: {}", cfg.stop_bits)),
        };
        let parity = match cfg.parity.to_lowercase().as_str() {
            "none" => Parity::None,
            "odd" => Parity::Odd,
            "even" => Parity::Even,
            _ => return Err(format!("invalid parity: {}", cfg.parity)),
        };

        // Build the port via the builder pattern (serialport 4.x API).
        let port = serialport::new(&cfg.port_name, cfg.baud)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| {
                format!(
                    "open({})@{},{},{},{:?} failed: {}",
                    cfg.port_name, cfg.baud, cfg.data_bits, cfg.stop_bits, parity, e
                )
            })?;

        let port_id = self.alloc_id();
        let entry = PortEntry {
            port: Mutex::new(port),
            rx_alive: std::sync::atomic::AtomicBool::new(true),
        };

        {
            let mut map = self.ports.lock();
            if map.insert(port_id, entry).is_some() {
                return Err(format!("port_id {} already in use", port_id));
            }
        }

        // Spawn RX thread.
        let app_for_rx = app.clone();
        let ports_handle_ptr = self as *const _ as usize;
        // SAFETY: SerialManager is 'static (managed by Tauri's State). The pointer is
        // only used to look up the map under its Mutex; we never move out of it.
        // Reconstruct a &SerialManager from the raw pointer for the RX thread to call.
        let manager_ref: &SerialManager = unsafe { &*(ports_handle_ptr as *const SerialManager) };

        std::thread::Builder::new()
            .name(format!("serial-rx-{}", port_id))
            .spawn(move || {
                rx_loop(app_for_rx, manager_ref, port_id);
            })
            .map_err(|e| format!("spawn rx thread failed: {}", e))?;

        Ok(port_id)
    }

    pub fn close_inner(&self, app: &AppHandle, port_id: u32) -> Result<(), String> {
        let entry = {
            let mut map = self.ports.lock();
            map.remove(&port_id)
        };
        match entry {
            Some(e) => {
                e.rx_alive.store(false, Ordering::SeqCst);
                // Dropping the port closes it.
                drop(e.port.lock());
                let _ = app.emit("serial-closed", SerialClosedPayload { port_id, reason: "user".to_string() });
                Ok(())
            }
            None => Err(format!("port_id {} not open", port_id)),
        }
    }

    pub fn write_inner(&self, port_id: u32, bytes: Vec<u8>) -> Result<(), String> {
        let map = self.ports.lock();
        let entry = map.get(&port_id).ok_or_else(|| format!("port_id {} not open", port_id))?;
        let mut port = entry.port.lock();
        port.write_all(&bytes)
            .map_err(|e| format!("write failed: {}", e))?;
        port.flush().map_err(|e| format!("flush failed: {}", e))?;
        Ok(())
    }
}

#[derive(Serialize, Clone)]
struct SerialClosedPayload {
    port_id: u32,
    reason: String,
}

#[derive(Serialize, Clone)]
struct RxLinePayload {
    port_id: u32,
    line: String,
    ts_ms: u64,
}

#[derive(Serialize, Clone)]
struct RxErrorPayload {
    port_id: u32,
    error: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// RX loop. Reads one byte at a time on a short timeout, splits on \n.
/// Emits one event per line. Exits on read error or when port is closed.
fn rx_loop(app: AppHandle, mgr: &SerialManager, port_id: u32) {
    let mut buf = [0u8; 1];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    let mut last_emit = std::time::Instant::now();

    loop {
        // Check alive flag.
        let alive = {
            let map = mgr.ports.lock();
            match map.get(&port_id) {
                Some(e) => e.rx_alive.load(Ordering::SeqCst),
                None => false,
            }
        };
        if !alive {
            break;
        }

        // Borrow the port for one read.
        let read_result = {
            let map = mgr.ports.lock();
            let Some(entry) = map.get(&port_id) else { break };
            let mut port = entry.port.lock();
            port.read(&mut buf)
        };

        match read_result {
            Ok(0) => {
                // EOF — port closed by peer.
                break;
            }
            Ok(_) => {
                let b = buf[0];
                if b == b'\n' {
                    // End of line. Emit current line (strip trailing \r if present).
                    while matches!(line.last(), Some(b'\r')) {
                        line.pop();
                    }
                    let s = String::from_utf8_lossy(&line).to_string();
                    line.clear();
                    let _ = app.emit(
                        "serial-rx-line",
                        RxLinePayload { port_id, line: s, ts_ms: now_ms() },
                    );
                    last_emit = std::time::Instant::now();
                } else {
                    line.push(b);
                    // Guard against runaway lines without \n (max 4 KiB).
                    if line.len() > 4096 {
                        let s = String::from_utf8_lossy(&line).to_string();
                        line.clear();
                        let _ = app.emit(
                            "serial-rx-line",
                            RxLinePayload { port_id, line: s, ts_ms: now_ms() },
                        );
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::TimedOut => {
                // Idle: if we've been buffering for > 500ms, emit what we have.
                if !line.is_empty() && last_emit.elapsed() > Duration::from_millis(500) {
                    let s = String::from_utf8_lossy(&line).to_string();
                    line.clear();
                    let _ = app.emit(
                        "serial-rx-line",
                        RxLinePayload { port_id, line: s, ts_ms: now_ms() },
                    );
                }
            }
            Err(e) => {
                // Likely unplugged / port vanished.
                let _ = app.emit(
                    "serial-rx-error",
                    RxErrorPayload { port_id, error: e.to_string() },
                );
                break;
            }
        }
    }

    // Clean up: remove from map so subsequent close() returns an error.
    {
        let mut map = mgr.ports.lock();
        map.remove(&port_id);
    }
    let _ = app.emit(
        "serial-closed",
        SerialClosedPayload { port_id, reason: "rx-exit".to_string() },
    );
}