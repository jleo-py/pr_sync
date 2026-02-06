/**
 * GitHub operations module - SAFETY SCOPED
 *
 * This module ONLY exposes specific, safe operations:
 * - Read: list PRs, get PR details, get workflow runs
 * - Write: update branch with base, re-run failed workflows
 *
 * NO generic command execution is exposed. This is intentional.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { PR, User, WorkflowRun, UpdateResult } from "./types.js";

const execAsync = promisify(exec);

// Global rate limiter to prevent bursts of API calls
// GitHub's secondary rate limiting can trigger 401 errors when too many requests hit at once
const MIN_REQUEST_INTERVAL_MS = 100; // Minimum 100ms between API calls
let rateLimitQueue: Promise<void> = Promise.resolve();

function waitForRateLimit(): Promise<void> {
  // Chain onto the queue to ensure requests are serialized with proper spacing
  rateLimitQueue = rateLimitQueue.then(
    () =>
      new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS)),
  );
  return rateLimitQueue;
}

// For testing: allow injecting a mock executor
export type CommandExecutor = (
  command: string,
) => Promise<{ stdout: string; stderr: string }>;
let executor: CommandExecutor = execAsync;

export function setExecutor(newExecutor: CommandExecutor): void {
  executor = newExecutor;
}

export function resetExecutor(): void {
  executor = execAsync;
}

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * Execute a command with retry logic for transient network errors
 */
async function executeWithRetry(
  command: string,
  retries = MAX_RETRIES,
): Promise<{ stdout: string; stderr: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Rate limit to prevent bursts that trigger GitHub's secondary rate limiting
      await waitForRateLimit();
      return await executor(command);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message.toLowerCase();

      // Check if this is a transient network error worth retrying
      // Note: Do NOT include "api.github.com" as that matches auth errors (401)
      // which are not transient and should not be retried
      const isTransient =
        message.includes("connection refused") ||
        message.includes("econnreset") ||
        message.includes("connection reset by peer") || // Go-style ECONNRESET from gh CLI
        message.includes("etimedout") ||
        message.includes("enotfound") ||
        message.includes("socket hang up") ||
        message.includes("dial tcp") ||
        message.includes("error connecting") ||
        message.includes("connect:") ||
        message.includes("getaddrinfo");

      if (!isTransient || attempt === retries) {
        throw lastError;
      }

      // Exponential backoff
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============================================
// READ OPERATIONS
// ============================================

/**
 * Get the currently authenticated GitHub user
 */
export async function getAuthenticatedUser(): Promise<User> {
  const { stdout } = await executeWithRetry("gh api user --jq '.login'");
  return { login: stdout.trim() };
}

/**
 * List all open PRs authored by a user in an organization
 */
export async function listOpenPRs(org: string, author: string): Promise<PR[]> {
  // Use GraphQL API instead of gh search prs - the REST search has indexing delays
  const graphqlQuery = `
query {
  search(query: "is:open is:pr author:${author} org:${org}", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number
        repository {
          nameWithOwner
        }
      }
    }
  }
}`;

  const { stdout } = await executeWithRetry(
    `gh api graphql -f query='${graphqlQuery.replace(/\n/g, " ")}'`,
  );

  const response = JSON.parse(stdout) as {
    data: {
      search: {
        nodes: Array<{
          number: number;
          repository: { nameWithOwner: string };
        }>;
      };
    };
  };

  const results = response.data.search.nodes.filter((n) => n.number); // Filter out any null nodes

  // Get full details for each PR (title, branch, mergeable state, etc.)
  const prs: PR[] = await Promise.all(
    results.map(async (r) => {
      const details = await getPRDetails(r.repository.nameWithOwner, r.number);
      return details;
    }),
  );

  return prs;
}

/**
 * Get detailed information about a specific PR
 */
export async function getPRDetails(
  repo: string,
  prNumber: number,
): Promise<PR> {
  const { stdout } = await executeWithRetry(
    `gh pr view ${prNumber} --repo ${repo} --json number,title,headRefName,baseRefName,url,isDraft,mergeable,commits`,
  );

  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    url: string;
    isDraft: boolean;
    mergeable: string;
    commits: Array<{ oid: string }>;
  };

  // Check how far behind the PR is
  const behindBy = await getBehindCount(
    repo,
    data.baseRefName,
    data.headRefName,
  );

  return {
    number: data.number,
    title: data.title,
    repo,
    headRef: data.headRefName,
    baseRef: data.baseRefName,
    url: data.url,
    isDraft: data.isDraft,
    mergeable: data.mergeable as PR["mergeable"],
    behindBy,
  };
}

/**
 * Get how many commits the head branch is behind the base branch
 */
async function getBehindCount(
  repo: string,
  baseRef: string,
  headRef: string,
): Promise<number> {
  try {
    const { stdout } = await executeWithRetry(
      `gh api repos/${repo}/compare/${headRef}...${baseRef} --jq '.ahead_by'`,
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    // If comparison fails, assume we need to check
    return -1;
  }
}

/**
 * Get workflow runs for a specific ref (branch)
 */
export async function getWorkflowRuns(
  repo: string,
  ref: string,
): Promise<WorkflowRun[]> {
  const { stdout } = await executeWithRetry(
    `gh run list --repo ${repo} --branch ${ref} --json databaseId,name,status,conclusion,url,headSha --limit 20`,
  );

  const runs = JSON.parse(stdout) as Array<{
    databaseId: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    headSha: string;
  }>;

  return runs.map((r) => ({
    id: r.databaseId,
    name: r.name,
    status: r.status as WorkflowRun["status"],
    conclusion: r.conclusion as WorkflowRun["conclusion"],
    url: r.url,
    headSha: r.headSha,
  }));
}

/**
 * Get the latest commit SHA for a PR's head branch
 */
export async function getLatestCommitSha(
  repo: string,
  branch: string,
): Promise<string> {
  const { stdout } = await executeWithRetry(
    `gh api repos/${repo}/git/refs/heads/${branch} --jq '.object.sha'`,
  );
  return stdout.trim();
}

/**
 * Refresh PR status - re-fetch behindBy and mergeable state
 * Used after updating a base PR to check if stacked PRs now need updating
 */
export async function refreshPRStatus(pr: PR): Promise<PR> {
  const { stdout } = await executeWithRetry(
    `gh pr view ${pr.number} --repo ${pr.repo} --json baseRefName,mergeable`,
  );

  const data = JSON.parse(stdout) as {
    baseRefName: string;
    mergeable: string;
  };

  // Check how far behind the PR is now
  const behindBy = await getBehindCount(pr.repo, data.baseRefName, pr.headRef);

  return {
    ...pr,
    baseRef: data.baseRefName,
    mergeable: data.mergeable as PR["mergeable"],
    behindBy,
  };
}

// ============================================
// WRITE OPERATIONS (ONLY TWO ALLOWED)
// ============================================

/**
 * Update a PR's branch with its base branch (merge base into head)
 *
 * This is one of only TWO write operations allowed.
 */
export async function updateBranchWithBase(
  repo: string,
  prNumber: number,
): Promise<UpdateResult> {
  try {
    await executeWithRetry(
      `gh api repos/${repo}/pulls/${prNumber}/update-branch --method PUT`,
    );
    return { success: true, conflict: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for merge conflict
    if (
      message.includes("merge conflict") ||
      message.includes("Merge conflict")
    ) {
      return { success: false, conflict: true, error: message };
    }

    return { success: false, conflict: false, error: message };
  }
}

/**
 * Re-run failed jobs in a workflow run
 *
 * This is one of only TWO write operations allowed.
 */
export async function rerunFailedJobs(
  repo: string,
  runId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await executeWithRetry(`gh run rerun ${runId} --repo ${repo} --failed`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
