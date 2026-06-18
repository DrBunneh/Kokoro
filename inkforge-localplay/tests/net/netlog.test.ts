import { describe, expect, it, beforeEach } from "vitest";
import { netLog, nlog, formatNetLog } from "@/net/netlog";

describe("net diagnostics log", () => {
  beforeEach(() => netLog.clear());

  it("records entries and notifies subscribers", () => {
    let calls = 0;
    const unsub = netLog.subscribe(() => calls++);
    nlog("follower", "opening WebSocket");
    nlog("host", "server listening", "info");
    expect(netLog.list()).toHaveLength(2);
    expect(calls).toBe(2);
    unsub();
    nlog("net", "after unsub");
    expect(calls).toBe(2); // no longer notified
  });

  it("formats a copyable, leveled transcript", () => {
    nlog("follower", "WebSocket closed (code 1006, unclean)", "error");
    const text = formatNetLog();
    expect(text).toMatch(/\[follower\/error\] WebSocket closed \(code 1006, unclean\)/);
  });

  it("caps the buffer so it can't grow without bound", () => {
    for (let i = 0; i < 500; i++) nlog("net", `event ${i}`);
    expect(netLog.list().length).toBeLessThanOrEqual(300);
    // Keeps the most recent events.
    expect(netLog.list().at(-1)!.msg).toBe("event 499");
  });
});
