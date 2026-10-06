import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // the dst/override cases assume the hub runs in europe/berlin
    env: { TZ: "Europe/Berlin" },
  },
});
