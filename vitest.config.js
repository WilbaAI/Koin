import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    environmentMatchGlobs: [["tests/dom/**", "jsdom"]],
    coverage: {
      provider: "v8",
      include: ["validation.js", "compute.js"],
      reporter: ["text", "html"],
    },
  },
});
