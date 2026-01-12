/**
 * Tests for runner orchestration logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setExecutor, resetExecutor } from "../src/github.js";
import { syncAllPRs } from "../src/runner.js";
import { MockGhExecutor, mockScenarios, createMockPR, createMockWorkflowRun } from "./mocks/gh.js";
import type { Config } from "../src/types.js";

// Suppress console output during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const testConfig: Config = {
  org: "TestOrg",
  maxConcurrency: 3,
  staggerDelayMs: 0, // No delay in tests
  ciRetryCount: 1,
  waitBetweenBatchesMs: 0, // No delay in tests
  ciPollIntervalMs: 10, // Fast polling in tests
  ciTimeoutMs: 1000, // Short timeout in tests
  excludeRepos: [],
  includeRepos: null,
};

describe("runner", () => {
  let mockExecutor: MockGhExecutor;

  beforeEach(() => {
    mockExecutor = new MockGhExecutor();
    setExecutor(mockExecutor.execute.bind(mockExecutor));
  });

  afterEach(() => {
    resetExecutor();
    mockExecutor.reset();
  });

  describe("syncAllPRs", () => {
    it("handles no open PRs gracefully", async () => {
      mockScenarios.noPRs(mockExecutor);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(0);
      expect(summary.upToDate).toHaveLength(0);
      expect(summary.updated).toHaveLength(0);
      expect(summary.conflicts).toHaveLength(0);
    });

    it("reports PR already up to date with passing CI", async () => {
      mockScenarios.singlePRUpToDate(mockExecutor);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(1);
      expect(summary.upToDate).toHaveLength(1);
      expect(summary.conflicts).toHaveLength(0);
      expect(summary.ciFailing).toHaveLength(0);
    });

    it("updates PR behind base and reports success", async () => {
      mockScenarios.singlePRNeedsUpdate(mockExecutor);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(1);
      expect(summary.updated).toHaveLength(1);
      expect(summary.conflicts).toHaveLength(0);

      // Verify update-branch was called
      const calls = mockExecutor.getCalls();
      expect(calls.some((c) => c.includes("update-branch"))).toBe(true);
    });

    it("reports merge conflicts without attempting update", async () => {
      mockScenarios.singlePRConflict(mockExecutor);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(1);
      expect(summary.conflicts).toHaveLength(1);
      expect(summary.updated).toHaveLength(0);

      // Verify update-branch was NOT called
      const calls = mockExecutor.getCalls();
      expect(calls.some((c) => c.includes("update-branch"))).toBe(false);
    });

    it("retries failed CI and reports final status", async () => {
      mockScenarios.singlePRCIFailsThenPasses(mockExecutor);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(1);
      // Should have retried and ultimately passed
      expect(summary.ciFailing).toHaveLength(0);

      // Verify rerun was called
      const calls = mockExecutor.getCalls();
      expect(calls.some((c) => c.includes("gh run rerun"))).toBe(true);
    });

    it("filters repos based on includeRepos config", async () => {
      const pr1 = createMockPR({ number: 1, repo: "TestOrg/Repo1" });
      const pr2 = createMockPR({ number: 2, repo: "TestOrg/Repo2" });
      const run = createMockWorkflowRun();

      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  { number: pr1.number, repository: { nameWithOwner: pr1.repo } },
                  { number: pr2.number, repository: { nameWithOwner: pr2.repo } },
                ],
              },
            },
          })
        )
        .mock(
          /gh pr view/,
          JSON.stringify({
            number: pr1.number,
            title: pr1.title,
            headRefName: pr1.headRef,
            baseRefName: pr1.baseRef,
            url: pr1.url,
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          })
        )
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const configWithFilter = {
        ...testConfig,
        includeRepos: ["Repo1"], // Only include Repo1
      };

      const summary = await syncAllPRs(configWithFilter);

      // Should only process Repo1
      expect(summary.totalPRs).toBe(1);
    });

    it("filters repos based on excludeRepos config", async () => {
      const pr1 = createMockPR({ number: 1, repo: "TestOrg/Repo1" });
      const run = createMockWorkflowRun();

      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: [{ number: pr1.number, repository: { nameWithOwner: pr1.repo } }],
              },
            },
          })
        )
        .mock(
          /gh pr view/,
          JSON.stringify({
            number: pr1.number,
            title: pr1.title,
            headRefName: pr1.headRef,
            baseRefName: pr1.baseRef,
            url: pr1.url,
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          })
        )
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const configWithExclude = {
        ...testConfig,
        excludeRepos: ["Repo1"], // Exclude Repo1
      };

      const summary = await syncAllPRs(configWithExclude);

      // Repo1 should be excluded
      expect(summary.totalPRs).toBe(0);
    });
  });

  describe("dependency chain sorting", () => {
    it("processes PRs targeting master before PRs targeting other branches", async () => {
      // PR 1: feature-a → master (depth 0)
      // PR 2: feature-b → feature-a (depth 1 - depends on PR 1)
      const run = createMockWorkflowRun();

      let prViewCallCount = 0;
      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  // Return in reverse order to ensure sorting happens
                  { number: 2, repository: { nameWithOwner: "TestOrg/TestRepo" } },
                  { number: 1, repository: { nameWithOwner: "TestOrg/TestRepo" } },
                ],
              },
            },
          })
        )
        .mock(/gh pr view.*--json/, () => {
          prViewCallCount++;
          // First two calls are for getting PR details during listing
          // Subsequent calls are during processing
          if (prViewCallCount <= 2) {
            // PR details during listing - return in the order they were found (2, then 1)
            const isFirstPR = prViewCallCount === 2; // PR 1 is fetched second
            return JSON.stringify({
              number: isFirstPR ? 1 : 2,
              title: isFirstPR ? "Feature A" : "Feature B",
              headRefName: isFirstPR ? "feature-a" : "feature-b",
              baseRefName: isFirstPR ? "master" : "feature-a", // PR 2 targets PR 1's branch
              url: `https://github.com/TestOrg/TestRepo/pull/${isFirstPR ? 1 : 2}`,
              isDraft: false,
              mergeable: "MERGEABLE",
              commits: [{ oid: run.headSha }],
            });
          }
          // During processing
          return JSON.stringify({
            number: 1,
            title: "Feature A",
            headRefName: "feature-a",
            baseRefName: "master",
            url: "https://github.com/TestOrg/TestRepo/pull/1",
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          });
        })
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(2);
      // Both should be up to date (behindBy: 0)
      expect(summary.upToDate).toHaveLength(2);
    });

    it("handles three-level stacked PRs in correct order", async () => {
      // PR C: feature-c → master (depth 0) - processed first
      // PR B: feature-b → feature-c (depth 1) - processed second
      // PR A: feature-a → feature-b (depth 2) - processed last
      const run = createMockWorkflowRun();

      const prConfigs = [
        { number: 1, head: "feature-a", base: "feature-b", title: "Feature A" }, // depth 2
        { number: 2, head: "feature-b", base: "feature-c", title: "Feature B" }, // depth 1
        { number: 3, head: "feature-c", base: "master", title: "Feature C" }, // depth 0
      ];

      let prDetailCallCount = 0;

      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: prConfigs.map(pr => ({
                  number: pr.number,
                  repository: { nameWithOwner: "TestOrg/TestRepo" },
                })),
              },
            },
          })
        )
        .mock(/gh pr view.*--json/, () => {
          const idx = prDetailCallCount % prConfigs.length;
          prDetailCallCount++;
          const pr = prConfigs[idx];
          return JSON.stringify({
            number: pr.number,
            title: pr.title,
            headRefName: pr.head,
            baseRefName: pr.base,
            url: `https://github.com/TestOrg/TestRepo/pull/${pr.number}`,
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          });
        })
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(3);
      expect(summary.upToDate).toHaveLength(3);
    });

    it("handles PRs in different repos independently", async () => {
      // PR 1 in Repo1: feature → master (depth 0)
      // PR 2 in Repo2: feature → master (depth 0)
      // Even though both have same branch names, they shouldn't affect each other
      const run = createMockWorkflowRun();

      const prConfigs = [
        { number: 1, repo: "TestOrg/Repo1", head: "feature", base: "master" },
        { number: 2, repo: "TestOrg/Repo2", head: "feature", base: "master" },
      ];

      let prDetailCallCount = 0;

      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: prConfigs.map(pr => ({
                  number: pr.number,
                  repository: { nameWithOwner: pr.repo },
                })),
              },
            },
          })
        )
        .mock(/gh pr view.*--json/, () => {
          const idx = prDetailCallCount % prConfigs.length;
          prDetailCallCount++;
          const pr = prConfigs[idx];
          return JSON.stringify({
            number: pr.number,
            title: `PR ${pr.number}`,
            headRefName: pr.head,
            baseRefName: pr.base,
            url: `https://github.com/${pr.repo}/pull/${pr.number}`,
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          });
        })
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(2);
      // Both should be at depth 0 since they're in different repos
      expect(summary.upToDate).toHaveLength(2);
    });
  });

  describe("batch processing", () => {
    it("processes PRs in batches", async () => {
      // Create 5 PRs to test batching with batch size of 3
      const prs = Array.from({ length: 5 }, (_, i) =>
        createMockPR({ number: i + 1, repo: `TestOrg/Repo${i + 1}` })
      );
      const run = createMockWorkflowRun();

      mockExecutor
        .mock("gh api user", "testuser")
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: prs.map((pr) => ({
                  number: pr.number,
                  repository: { nameWithOwner: pr.repo },
                })),
              },
            },
          })
        )
        .mock(/gh pr view.*--json/, () =>
          JSON.stringify({
            number: 1,
            title: "Test",
            headRefName: "feature",
            baseRefName: "main",
            url: "https://github.com/TestOrg/Repo/pull/1",
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: [{ oid: run.headSha }],
          })
        )
        .mock(/gh api repos\/.*\/compare/, "0")
        .mock("gh run list", JSON.stringify([run]))
        .mock(/gh pr view.*--jq/, run.headSha);

      const summary = await syncAllPRs(testConfig);

      expect(summary.totalPRs).toBe(5);
    });
  });
});
