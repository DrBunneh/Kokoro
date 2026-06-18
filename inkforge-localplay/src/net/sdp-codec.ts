/**
 * Signalling codec for WebRTC-over-QR (spec §8.2). SDP/ICE bundles can exceed a
 * single QR, so we gzip + base64url-encode, then chunk into framed parts that
 * reassemble in any order. Pure and environment-agnostic (Node + browser).
 */
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";

function u8ToB64url(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(u8).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToU8(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob !== "undefined") {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Compress + encode any JSON value into a compact base64url string. */
export function encodeSignal(value: unknown): string {
  return u8ToB64url(gzipSync(strToU8(JSON.stringify(value))));
}

export function decodeSignal(payload: string): unknown {
  return JSON.parse(strFromU8(gunzipSync(b64urlToU8(payload))));
}

const FRAME = /^(\d+)\/(\d+):(.*)$/s;

/**
 * Encode a value into N framed chunks (`i/N:payload`) each ≤ ~maxChars, for
 * rendering as multiple QR codes.
 */
export function encodeChunks(value: unknown, maxChars = 1000): string[] {
  const payload = encodeSignal(value);
  const bodyMax = Math.max(1, maxChars - 12); // room for the "i/N:" header
  const parts: string[] = [];
  for (let i = 0; i < payload.length; i += bodyMax) parts.push(payload.slice(i, i + bodyMax));
  const n = parts.length;
  return parts.map((p, i) => `${i}/${n}:${p}`);
}

export interface ChunkProgress {
  have: number;
  total: number;
  done: boolean;
}

/** Accumulates scanned chunks (any order) and decodes once complete. */
export class ChunkAssembler {
  private parts = new Map<number, string>();
  private total = 0;

  add(chunk: string): ChunkProgress {
    const m = chunk.match(FRAME);
    if (!m) return this.progress();
    const i = Number(m[1]);
    this.total = Number(m[2]);
    this.parts.set(i, m[3]!);
    return this.progress();
  }

  private progress(): ChunkProgress {
    return { have: this.parts.size, total: this.total, done: this.total > 0 && this.parts.size === this.total };
  }

  decode(): unknown {
    let payload = "";
    for (let i = 0; i < this.total; i++) payload += this.parts.get(i) ?? "";
    return decodeSignal(payload);
  }
}
