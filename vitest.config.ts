import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Tests cover `src/lib/**` only.
 *
 * That is not laziness — it is the layering contract. `src/lib` is pure: no
 * Supabase, no fetch, no ambient clock. So the journey rules (late, silent,
 * current position) can be asserted over fixed fixtures without a database,
 * and they are the rules most likely to be quietly wrong.
 *
 * Services and components are verified by `verify:rls` and in the browser
 * respectively, because what matters about them is behaviour a unit test cannot
 * see: whether a policy leaks, and whether a map renders.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
