import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.orbis.app",
  appName: "Orbis",
  // the Next.js static export; build it with `pnpm --filter @orbis/web build` (or `pnpm mobile:sync` from the root)
  webDir: "../web/out",
  server: {
    // https scheme so cookies/CORS behave like a normal origin; the hub allows https://localhost and capacitor://localhost
    androidScheme: "https",
    iosScheme: "capacitor",
    // allow the app to talk to a hub on the LAN over plain http
    cleartext: true,
  },
  android: { allowMixedContent: true },
  plugins: {
    StatusBar: { style: "DEFAULT", overlaysWebView: false },
  },
};

export default config;
