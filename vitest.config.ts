import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // *.live.test.ts 는 실제 drand 네트워크를 쓴다 → npm run test:live 로만.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    testTimeout: 30_000,
  },
});
