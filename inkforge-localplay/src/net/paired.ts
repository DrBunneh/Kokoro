/**
 * In-process loopback transport pair (spec §8.1, `HotSeatTransport` sibling).
 * Two endpoints that deliver to each other synchronously — used to drive and
 * test the host-authoritative sync protocol without any real networking.
 */
import type { NetMsg, Transport } from "./transport";

export function createPaired(): [Transport, Transport] {
  const aCbs = new Set<(m: NetMsg) => void>();
  const bCbs = new Set<(m: NetMsg) => void>();
  let aStatus: Transport["status"] = "connected";
  let bStatus: Transport["status"] = "connected";

  const a: Transport = {
    role: "host",
    get status() {
      return aStatus;
    },
    send: (m) => bCbs.forEach((cb) => cb(m)),
    onReceive: (cb) => {
      aCbs.add(cb);
      return () => aCbs.delete(cb);
    },
    close() {
      aStatus = "closed";
    },
  };
  const b: Transport = {
    role: "follower",
    get status() {
      return bStatus;
    },
    send: (m) => aCbs.forEach((cb) => cb(m)),
    onReceive: (cb) => {
      bCbs.add(cb);
      return () => bCbs.delete(cb);
    },
    close() {
      bStatus = "closed";
    },
  };
  return [a, b];
}
