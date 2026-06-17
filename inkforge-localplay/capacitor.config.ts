import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.inkforge.localplay",
  appName: "InkForge LocalPlay",
  webDir: "dist",
  android: {
    // Allow the app to run fully offline; no cleartext needed (images are HTTPS).
    allowMixedContent: false,
  },
};

export default config;
