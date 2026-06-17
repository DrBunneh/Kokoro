import { useState } from "react";
import { applyUpdate, checkForUpdate } from "@/lib/updater";

const RELEASE_APK_URL = "https://github.com/DrBunneh/Kokoro/releases/download/web-latest/app-debug.apk";

type Phase =
  | { k: "idle" }
  | { k: "checking" }
  | { k: "downloading"; percent: number }
  | { k: "up-to-date" }
  | { k: "needs-native" }
  | { k: "unsupported" }
  | { k: "error"; message: string };

/** Homepage OTA update control (web-bundle live update). */
export function UpdateButton() {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  async function run() {
    setPhase({ k: "checking" });
    const result = await checkForUpdate();
    switch (result.kind) {
      case "unsupported":
        setPhase({ k: "unsupported" });
        break;
      case "up-to-date":
        setPhase({ k: "up-to-date" });
        break;
      case "needs-native":
        setPhase({ k: "needs-native" });
        break;
      case "error":
        setPhase({ k: "error", message: result.message });
        break;
      case "available":
        setPhase({ k: "downloading", percent: 0 });
        try {
          await applyUpdate(result.manifest, (percent) =>
            setPhase({ k: "downloading", percent: Math.round(percent) }),
          );
          // On success the webview reloads into the new bundle.
        } catch (err) {
          setPhase({ k: "error", message: err instanceof Error ? err.message : "Update failed" });
        }
        break;
    }
  }

  const busy = phase.k === "checking" || phase.k === "downloading";
  const label =
    phase.k === "checking"
      ? "Checking…"
      : phase.k === "downloading"
        ? `Updating… ${phase.percent}%`
        : "Check for updates";

  return (
    <div className="space-y-1 text-center">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="min-h-tap w-full rounded-xl border border-white/10 bg-white/5 text-sm font-medium text-slate-200 active:bg-white/10 disabled:opacity-60"
      >
        {label}
      </button>

      {phase.k === "up-to-date" && <p className="text-xs text-emerald-300">You're up to date.</p>}
      {phase.k === "unsupported" && (
        <button type="button" onClick={() => location.reload()} className="text-xs text-ink-sapphire underline">
          Running in browser — tap to reload for the latest
        </button>
      )}
      {phase.k === "needs-native" && (
        <p className="text-xs text-amber-200">
          A new app version is required.{" "}
          <a href={RELEASE_APK_URL} className="text-ink-sapphire underline">
            Download latest APK
          </a>
        </p>
      )}
      {phase.k === "error" && <p className="text-xs text-rose-300">Update check failed: {phase.message}</p>}
    </div>
  );
}
