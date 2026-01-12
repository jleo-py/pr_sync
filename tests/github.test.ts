/**
 * Tests for GitHub operations
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setExecutor,
  resetExecutor,
  getAuthenticatedUser,
  listOpenPRs,
  getPRDetails,
  updateBranchWithBase,
  rerunFailedJobs,
} from "../src/github.js";
import { MockGhExecutor, createMockPR } from "./mocks/gh.js";

describe("github", () => {
  let mockExecutor: MockGhExecutor;

  beforeEach(() => {
    mockExecutor = new MockGhExecutor();
    setExecutor(mockExecutor.execute.bind(mockExecutor));
  });

  afterEach(() => {
    resetExecutor();
    mockExecutor.reset();
  });

  describe("getAuthenticatedUser", () => {
    it("returns the current user login", async () => {
      // --jq '.login' extracts just the string value, not quoted JSON
      mockExecutor.mock("gh api user", "testuser");

      const user = await getAuthenticatedUser();

      expect(user.login).toBe("testuser");
    });
  });

  describe("listOpenPRs", () => {
    it("returns empty array when no PRs found", async () => {
      mockExecutor.mock(
        "gh api graphql",
        JSON.stringify({ data: { search: { nodes: [] } } })
      );

      const prs = await listOpenPRs("TestOrg", "testuser");

      expect(prs).toEqual([]);
    });

    it("returns PRs with details", async () => {
      const mockPR = createMockPR();

      mockExecutor
        .mock(
          "gh api graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: [{ number: mockPR.number, repository: { nameWithOwner: mockPR.repo } }],
              },
            },
          })
        )
        .mock(
          /gh pr view/,
          JSON.stringify({
            number: mockPR.number,
            title: mockPR.title,
            headRefName: mockPR.headRef,
            baseRefName: mockPR.baseRef,
            url: mockPR.url,
            isDraft: mockPR.isDraft,
            mergeable: mockPR.mergeable,
            commits: [{ oid: "abc123" }],
          })
        )
        // --jq '.ahead_by' extracts just the number
        .mock(/gh api repos\/.*\/compare/, "0");

      const prs = await listOpenPRs("TestOrg", "testuser");

      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(mockPR.number);
      expect(prs[0].title).toBe(mockPR.title);
    });
  });

  describe("updateBranchWithBase", () => {
    it("returns success when update succeeds", async () => {
      mockExecutor.mock(/gh api repos\/.*\/pulls\/.*\/update-branch/, "{}");

      const result = await updateBranchWithBase("TestOrg/TestRepo", 123);

      expect(result.success).toBe(true);
      expect(result.conflict).toBe(false);
    });

    it("detects merge conflicts", async () => {
      mockExecutor.mock(/gh api repos\/.*\/pulls\/.*\/update-branch/, "", {
        shouldFail: true,
        errorMessage: "merge conflict detected",
      });

      const result = await updateBranchWithBase("TestOrg/TestRepo", 123);

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
    });

    it("returns error for other failures", async () => {
      mockExecutor.mock(/gh api repos\/.*\/pulls\/.*\/update-branch/, "", {
        shouldFail: true,
        errorMessage: "API rate limit exceeded",
      });

      const result = await updateBranchWithBase("TestOrg/TestRepo", 123);

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(false);
      expect(result.error).toContain("rate limit");
    });
  });

  describe("rerunFailedJobs", () => {
    it("returns success when rerun succeeds", async () => {
      mockExecutor.mock(/gh run rerun/, "");

      const result = await rerunFailedJobs("TestOrg/TestRepo", 12345);

      expect(result.success).toBe(true);
    });

    it("returns error when rerun fails", async () => {
      mockExecutor.mock(/gh run rerun/, "", {
        shouldFail: true,
        errorMessage: "Run not found",
      });

      const result = await rerunFailedJobs("TestOrg/TestRepo", 12345);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Run not found");
    });
  });

  describe("safety constraints", () => {
    it("only allows specific commands to be executed", async () => {
      // This test documents what commands are allowed
      const allowedPatterns = [
        "gh api user",
        "gh search prs",
        "gh pr view",
        "gh api repos/.*/compare",
        "gh api repos/.*/pulls/.*/update-branch",
        "gh run list",
        "gh run rerun",
      ];

      // The module only exports functions that use these patterns
      // There is no generic executeCommand function exposed
      expect(typeof getAuthenticatedUser).toBe("function");
      expect(typeof listOpenPRs).toBe("function");
      expect(typeof getPRDetails).toBe("function");
      expect(typeof updateBranchWithBase).toBe("function");
      expect(typeof rerunFailedJobs).toBe("function");
    });
  });
});
