import { describe, expect, it } from "vitest";
import { encodeSignal, decodeSignal, encodeChunks, ChunkAssembler } from "@/net/sdp-codec";

// A realistic-ish SDP blob (long, repetitive — compresses well).
const SDP = {
  type: "offer",
  sdp: Array.from({ length: 40 }, (_, i) => `a=candidate:${i} 1 udp 2122260223 192.168.1.${i} 5400${i} typ host`).join("\r\n"),
};

describe("signalling codec", () => {
  it("round-trips a value through gzip+base64url", () => {
    expect(decodeSignal(encodeSignal(SDP))).toEqual(SDP);
  });

  it("produces a URL-safe payload", () => {
    expect(encodeSignal(SDP)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("chunks and reassembles in arbitrary order", () => {
    const chunks = encodeChunks(SDP, 200);
    expect(chunks.length).toBeGreaterThan(1);
    const asm = new ChunkAssembler();
    let progress = { done: false } as { done: boolean };
    for (const c of [...chunks].reverse()) progress = asm.add(c);
    expect(progress.done).toBe(true);
    expect(asm.decode()).toEqual(SDP);
  });

  it("reports progress as chunks arrive", () => {
    const chunks = encodeChunks(SDP, 200);
    const asm = new ChunkAssembler();
    const first = asm.add(chunks[0]!);
    expect(first.have).toBe(1);
    expect(first.total).toBe(chunks.length);
    expect(first.done).toBe(false);
  });
});
