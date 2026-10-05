import { defineConfig } from "vitest/config";

export const vitestPreset = defineConfig({
  test: {
    globals: false,
    environment: "node",
    /**
     * Raised from vitest's 5s default, because that default is a *hang* detector and this workspace
     * routinely runs 670 test files across 88 packages at once.
     *
     * The case that forced it: `compliance`'s `resolveCompliancePacks` end-to-end test runs in under
     * a second in isolation and timed out at ~5048ms during a full sweep — twice, reported
     * independently by two agents. Nothing about it was slow; it was waiting for a core. A timeout
     * that fires on contention rather than on a hang teaches people to re-run the suite, which is
     * exactly how a real hang gets ignored.
     *
     * 15s still catches a genuine hang quickly, and no honest test in this repo is near it: the
     * slowest measured single test is a live-free fake-connection sweep at well under two seconds.
     */
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
    },
  },
});
