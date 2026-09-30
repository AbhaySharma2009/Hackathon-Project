import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // These are integration tests against a real Supabase project, and the HTTP
    // ones go through the dev server, so the default 5s is far too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Every file talks to the same database, and the suite asserts on shared
    // figures (headcount, pending count, balances) while also mutating them —
    // approving leave spends a balance, deactivating a person changes the
    // headcount. Running files in parallel lets one file's mutation land between
    // another's read and its assertion, which fails intermittently for reasons
    // that have nothing to do with the code under test. Sequential files cost
    // wall-clock time and make the run deterministic.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` throws outside a React Server Component, which is the point
      // in the app but blocks the copilot modules from being imported by a test.
      // The stub keeps the app's guarantee and lets the suite drive the real code.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
});
