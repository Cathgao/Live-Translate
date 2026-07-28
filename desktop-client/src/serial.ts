// Tauri bridge — invoke serial_* commands and listen for serial-rx-* events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PortInfo {
  name: string;
  kind: string; // "USB" | "Bluetooth" | "PCI" | "Unknown"
  label: string;
}

export interface SerialConfig {
  port_name: string;
  baud: number;
  data_bits: number;
  stop_bits: number;
  parity: string;
}

export interface RxLinePayload {
  port_id: number;
  line: string;
  ts_ms: number;
}

export interface RxErrorPayload {
  port_id: number;
  error: string;
}

export interface SerialClosedPayload {
  port_id: number;
  reason: string;
}

export async function serialList(): Promise<PortInfo[]> {
  return invoke<PortInfo[]>("serial_list");
}

export async function serialOpen(config: SerialConfig): Promise<number> {
  return invoke<number>("serial_open", { config });
}

export async function serialClose(portId: number): Promise<void> {
  return invoke<void>("serial_close", { portId });
}

export async function serialWrite(portId: number, bytes: number[]): Promise<void> {
  return invoke<void>("serial_write", { portId, bytes });
}

export function onSerialRxLine(cb: (p: RxLinePayload) => void): Promise<UnlistenFn> {
  return listen<RxLinePayload>("serial-rx-line", (e) => cb(e.payload));
}

export function onSerialRxError(cb: (p: RxErrorPayload) => void): Promise<UnlistenFn> {
  return listen<RxErrorPayload>("serial-rx-error", (e) => cb(e.payload));
}

export function onSerialClosed(cb: (p: SerialClosedPayload) => void): Promise<UnlistenFn> {
  return listen<SerialClosedPayload>("serial-closed", (e) => cb(e.payload));
}