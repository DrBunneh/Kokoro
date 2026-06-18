/**
 * In-app connection diagnostics for LAN play. Both transports, the native
 * plugin bridge, and the LocalPlay screen write timestamped events here so a
 * user can read exactly where the host/follower handshake breaks on each device
 * (and copy the log to report it). Pure + framework-free; the UI subscribes.
 */
export type NetLogLevel = "info" | "warn" | "error";
export type NetLogSide = "host" | "follower" | "net" | "native";

export interface NetLogEntry {
  id: number;
  ts: number;
  side: NetLogSide;
  level: NetLogLevel;
  msg: string;
}

const MAX = 300;

class NetLogStore {
  private entries: NetLogEntry[] = [];
  private subs = new Set<() => void>();
  private seq = 0;

  push(side: NetLogSide, msg: string, level: NetLogLevel = "info"): void {
    this.entries.push({ id: ++this.seq, ts: Date.now(), side, level, msg });
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
    this.subs.forEach((cb) => cb());
  }

  list(): readonly NetLogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.subs.forEach((cb) => cb());
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

export const netLog = new NetLogStore();

/** Convenience logger. */
export function nlog(side: NetLogSide, msg: string, level: NetLogLevel = "info"): void {
  netLog.push(side, msg, level);
}

/** Format the whole log as plain text for copy/paste in a bug report. */
export function formatNetLog(): string {
  return netLog
    .list()
    .map((e) => {
      const d = new Date(e.ts);
      const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
      return `${t} [${e.side}${e.level === "info" ? "" : "/" + e.level}] ${e.msg}`;
    })
    .join("\n");
}
