import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Allow importing .ts source via .js specifiers (TypeScript ESM convention)
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    environment: "node",
  },
});
