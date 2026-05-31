import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Allow importing .ts source via .js specifiers (TypeScript ESM convention)
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.ts"], // CLI entry point — tested via integration, not unit tests
      reporter: ["text", "json", "html"],
      thresholds: { lines: 80 },
    },
  },
});
