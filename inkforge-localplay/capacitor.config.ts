import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.inkforge.localplay",
  appName: "InkForge LocalPlay",
  webDir: "dist",
  android: {
    // Allow the app to run fully offline; no cleartext needed (images are HTTPS).
    allowMixedContent: false,
  },
  plugins: {
    // OTA web-bundle updates are driven manually by the homepage Update button.
    CapacitorUpdater: {
      autoUpdate: false,
    },
  },
};

export default config;
