/**
 * Mock GitHub CLI responses for testing
 */

import type { PR, WorkflowRun } from "../../src/types.js";

// Mock data factories
export function createMockPR(overrides: Partial<PR> = {}): PR {
  return {
    number: 123,
    title: "Test PR",
    repo: "TestOrg/TestRepo",
    headRef: "feature-branch",
    baseRef: "main",
    url: "https://github.com/TestOrg/TestRepo/pull/123",
    isDraft: false,
    mergeable: "MERGEABLE",
    behindBy: 0,
    ...overrides,
  };
}

export function createMockWorkflowRun(
  overrides: Partial<WorkflowRun> = {}
): WorkflowRun {
  return {
    id: 12345,
    name: "CI",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/TestOrg/TestRepo/actions/runs/12345",
    headSha: "abc123",
    ...overrides,
  };
}

// Mock command responses
export interface MockCommand {
  pattern: RegExp | string;
  response: string | (() => string);
  shouldFail?: boolean;
  errorMessage?: string;
}

export class MockGhExecutor {
  private commands: MockCommand[] = [];
  private callHistory: string[] = [];

  /**
   * Register a mock command response
   */
  mock(
    pattern: RegExp | string,
    response: string | (() => string),
    options?: { shouldFail?: boolean; errorMessage?: string }
  ): this {
    this.commands.push({
      pattern,
      response,
      shouldFail: options?.shouldFail,
      errorMessage: options?.errorMessage,
    });
    return this;
  }

  /**
   * Execute a command against mocks
   */
  async execute(
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.callHistory.push(command);

    for (const mock of this.commands) {
      const matches =
        typeof mock.pattern === "string"
          ? command.includes(mock.pattern)
          : mock.pattern.test(command);

      if (matches) {
        if (mock.shouldFail) {
          throw new Error(mock.errorMessage || "Command failed");
        }

        const response =
          typeof mock.response === "function"
            ? mock.response()
            : mock.response;

        return { stdout: response, stderr: "" };
      }
    }

    throw new Error(`No mock found for command: ${command}`);
  }

  /**
   * Get command call history
   */
  getCalls(): string[] {
    return [...this.callHistory];
  }

  /**
   * Clear mocks and history
   */
  reset(): void {
    this.commands = [];
    this.callHistory = [];
  }
}

// Pre-built mock scenarios
export const mockScenarios = {
  /**
   * User with no open PRs
   */
  noPRs(executor: MockGhExecutor): void {
    executor
      // --jq '.login' extracts just the string value
      .mock("gh api user", "testuser")
      .mock("gh api graphql", JSON.stringify({ data: { search: { nodes: [] } } }));
  },

  /**
   * Single PR, already up to date, CI passing
   */
  singlePRUpToDate(executor: MockGhExecutor): void {
    const pr = createMockPR();
    const run = createMockWorkflowRun();

    executor
      // --jq '.login' extracts just the string value
      .mock("gh api user", "testuser")
      .mock(
        "gh api graphql",
        JSON.stringify({
          data: {
            search: {
              nodes: [{ number: pr.number, repository: { nameWithOwner: pr.repo } }],
            },
          },
        })
      )
      // IMPORTANT: --jq pattern must come BEFORE --json pattern because
      // getLatestCommitSha uses both: "gh pr view ... --json commits --jq ..."
      // and we want to match that specifically, not the getPRDetails call
      .mock(/gh pr view.*--jq/, run.headSha)
      .mock(
        /gh pr view.*--json/,
        JSON.stringify({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
          url: pr.url,
          isDraft: pr.isDraft,
          mergeable: pr.mergeable,
          commits: [{ oid: run.headSha }],
        })
      )
      // --jq '.ahead_by' extracts just the number
      .mock(/gh api repos\/.*\/compare/, "0")
      .mock("gh run list", JSON.stringify([run]));
  },

  /**
   * Single PR, behind base, update succeeds, CI passes
   */
  singlePRNeedsUpdate(executor: MockGhExecutor): void {
    const pr = createMockPR({ behindBy: 5 });
    const run = createMockWorkflowRun();

    executor
      .mock("gh api user", "testuser")
      .mock(
        "gh api graphql",
        JSON.stringify({
          data: {
            search: {
              nodes: [{ number: pr.number, repository: { nameWithOwner: pr.repo } }],
            },
          },
        })
      )
      // IMPORTANT: --jq pattern must come BEFORE --json pattern because
      // getLatestCommitSha uses both: "gh pr view ... --json commits --jq ..."
      // and we want to match that specifically, not the getPRDetails call
      .mock(/gh pr view.*--jq/, run.headSha)
      .mock(
        /gh pr view.*--json/,
        JSON.stringify({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
          url: pr.url,
          isDraft: pr.isDraft,
          mergeable: pr.mergeable,
          commits: [{ oid: run.headSha }],
        })
      )
      // --jq '.ahead_by' extracts just the number - PR is 5 commits behind
      .mock(/gh api repos\/.*\/compare/, "5")
      .mock(/gh api repos\/.*\/pulls\/.*\/update-branch/, "{}")
      .mock("gh run list", JSON.stringify([run]));
  },

  /**
   * Single PR with merge conflict
   */
  singlePRConflict(executor: MockGhExecutor): void {
    const pr = createMockPR({ mergeable: "CONFLICTING" });

    executor
      .mock("gh api user", "testuser")
      .mock(
        "gh api graphql",
        JSON.stringify({
          data: {
            search: {
              nodes: [{ number: pr.number, repository: { nameWithOwner: pr.repo } }],
            },
          },
        })
      )
      .mock(
        /gh pr view.*--json/,
        JSON.stringify({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
          url: pr.url,
          isDraft: pr.isDraft,
          mergeable: "CONFLICTING",
          commits: [{ oid: "abc123" }],
        })
      )
      .mock(/gh api repos\/.*\/compare/, "3");
  },

  /**
   * Single PR, CI failing, retry succeeds
   */
  singlePRCIFailsThenPasses(executor: MockGhExecutor): void {
    const pr = createMockPR({ behindBy: 0 });
    const failingRun = createMockWorkflowRun({
      conclusion: "failure",
    });

    let callCount = 0;

    executor
      .mock("gh api user", "testuser")
      .mock(
        "gh api graphql",
        JSON.stringify({
          data: {
            search: {
              nodes: [{ number: pr.number, repository: { nameWithOwner: pr.repo } }],
            },
          },
        })
      )
      // IMPORTANT: --jq pattern must come BEFORE --json pattern because
      // getLatestCommitSha uses both: "gh pr view ... --json commits --jq ..."
      // and we want to match that specifically, not the getPRDetails call
      .mock(/gh pr view.*--jq/, failingRun.headSha)
      .mock(
        /gh pr view.*--json/,
        JSON.stringify({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
          url: pr.url,
          isDraft: pr.isDraft,
          mergeable: pr.mergeable,
          commits: [{ oid: failingRun.headSha }],
        })
      )
      .mock(/gh api repos\/.*\/compare/, "0")
      .mock("gh run list", () => {
        callCount++;
        if (callCount === 1) {
          // First call: failing
          return JSON.stringify([failingRun]);
        }
        // Subsequent calls: passing
        return JSON.stringify([{ ...failingRun, conclusion: "success" }]);
      })
      .mock(/gh run rerun/, "{}");
  },
};
