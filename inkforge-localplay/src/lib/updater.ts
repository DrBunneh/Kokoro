/**
 * OTA web-bundle updates (homepage "Update" button).
 *
 * The installed APK loads its web assets locally; this lets the web layer (UI +
 * engine — the bulk of development) update without reinstalling. A GitHub
 * Release (`web-latest`) holds the latest `web-bundle.zip` + a `latest.json`
 * manifest published by CI. The button checks the manifest, downloads the
 * bundle via @capgo/capacitor-updater, and reloads.
 *
 * Native changes (new Capacitor plugins — P2 image cache, P3 WebRTC) live in
 * the compiled binary and cannot be OTA'd; the manifest's `minNativeBuild`
 * lets us detect that and ask the user to install a fresh APK instead.
 */
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { CapacitorUpdater } from "@capgo/capacitor-updater";

const MANIFEST_URL =
  "https://github.com/DrBunneh/Kokoro/releases/download/web-latest/latest.json";

export interface UpdateManifest {
  version: string;
  url: string;
  minNativeBuild: number;
  builtAt?: string;
}

export type UpdateCheck =
  | { kind: "unsupported" } // running in a browser, not the native app
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; manifest: UpdateManifest; current: string }
  | { kind: "needs-native"; manifest: UpdateManifest; nativeBuild: number }
  | { kind: "error"; message: string };

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Tell the updater the current bundle booted successfully, so it isn't rolled
 * back. Must run on every startup (no-op on web).
 */
export async function notifyReady(): Promise<void> {
  if (!isNative()) return;
  try {
    await CapacitorUpdater.notifyAppReady();
  } catch {
    /* ignore — only relevant after an OTA swap */
  }
}

async function currentBundleVersion(): Promise<string> {
  try {
    const cur = await CapacitorUpdater.current();
    return cur.bundle?.version ?? "builtin";
  } catch {
    return "builtin";
  }
}

async function nativeBuild(): Promise<number> {
  try {
    const info = await App.getInfo();
    return Number.parseInt(info.build, 10) || 0;
  } catch {
    return 0;
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isNative()) return { kind: "unsupported" };
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return { kind: "error", message: `Manifest ${res.status}` };
    const manifest = (await res.json()) as UpdateManifest;
    const [current, build] = await Promise.all([currentBundleVersion(), nativeBuild()]);

    if (manifest.minNativeBuild > build) {
      return { kind: "needs-native", manifest, nativeBuild: build };
    }
    if (manifest.version === current) {
      return { kind: "up-to-date", version: current };
    }
    return { kind: "available", manifest, current };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Download + activate a bundle, reporting download progress (0–100). On success
 * the webview reloads into the new bundle.
 */
export async function applyUpdate(
  manifest: UpdateManifest,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const listener = await CapacitorUpdater.addListener("download", (info) => {
    onProgress?.(info.percent ?? 0);
  });
  try {
    const bundle = await CapacitorUpdater.download({
      url: manifest.url,
      version: manifest.version,
    });
    await CapacitorUpdater.set(bundle); // activates + reloads the webview
  } finally {
    await listener.remove();
  }
}
