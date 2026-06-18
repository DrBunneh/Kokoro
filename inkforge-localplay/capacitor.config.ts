import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.inkforge.localplay",
  appName: "InkForge LocalPlay",
  webDir: "dist",
  android: {
    // The app is served over https://localhost, so the follower's plain
    // ws:// connection to the host is "mixed content" — the WebView blocks it
    // (silent hang) unless mixed content is allowed. Required for LAN play.
    allowMixedContent: true,
  },
  plugins: {
    // OTA web-bundle updates are driven manually by the homepage Update button.
    CapacitorUpdater: {
      autoUpdate: false,
    },
  },
};

export default config;
