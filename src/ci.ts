/**
 * CI status checking and retry logic
 */

import type { Config, CIStatus, WorkflowRun, PR } from "./types.js";
import {
  getWorkflowRuns,
  getLatestCommitSha,
  rerunFailedJobs,
} from "./github.js";

// Workflow names to ignore (manual approval checks that stay pending indefinitely)
const IGNORED_WORKFLOWS = [
  "Review Enforcer", // Contains Engineering Code Review and QA Code Review jobs
];

/**
 * Get the current CI status for a PR
 */
export async function getCIStatus(pr: PR): Promise<CIStatus> {
  const runs = await getWorkflowRuns(pr.repo, pr.headRef);

  if (runs.length === 0) {
    return { type: "none" };
  }

  // Get the latest commit SHA to filter runs
  const latestSha = await getLatestCommitSha(pr.repo, pr.headRef);

  // Only consider runs for the latest commit, excluding ignored workflows
  const latestRuns = runs.filter(
    (r) => r.headSha === latestSha && !IGNORED_WORKFLOWS.includes(r.name),
  );

  // Deduplicate by workflow name - keep only the latest run per workflow
  // (gh run list returns newest first, so first seen = most recent)
  const deduped = new Map<string, WorkflowRun>();
  for (const run of latestRuns) {
    if (!deduped.has(run.name)) {
      deduped.set(run.name, run);
    }
  }
  const uniqueRuns = [...deduped.values()];

  if (uniqueRuns.length === 0) {
    // No runs for the latest commit yet - CI might still be starting
    return { type: "pending", runs: [] };
  }

  // Check if any are still in progress
  const inProgress = uniqueRuns.filter(
    (r) => r.status === "queued" || r.status === "in_progress",
  );
  if (inProgress.length > 0) {
    return { type: "pending", runs: inProgress };
  }

  // Check for failures
  const failed = uniqueRuns.filter(
    (r) =>
      r.conclusion === "failure" ||
      r.conclusion === "timed_out" ||
      r.conclusion === "cancelled",
  );
  if (failed.length > 0) {
    return { type: "failing", runs: failed };
  }

  // All completed successfully (or skipped)
  return { type: "passing" };
}

/**
 * Wait for CI to complete, with timeout
 */
export async function waitForCI(
  pr: PR,
  config: Config,
  onStatusUpdate?: (status: CIStatus) => void,
): Promise<CIStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < config.ciTimeoutMs) {
    const status = await getCIStatus(pr);

    if (onStatusUpdate) {
      onStatusUpdate(status);
    }

    // If CI is done (passing, failing, or none), return
    if (
      status.type === "passing" ||
      status.type === "failing" ||
      status.type === "none"
    ) {
      return status;
    }

    // Still pending - wait and poll again
    await sleep(config.ciPollIntervalMs);
  }

  return { type: "timeout" };
}

/**
 * Retry failed CI runs for a PR
 */
export async function retryFailedCI(
  pr: PR,
  failedRuns: WorkflowRun[],
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const run of failedRuns) {
    const result = await rerunFailedJobs(pr.repo, run.id);
    if (!result.success && result.error) {
      errors.push(`${run.name}: ${result.error}`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Retry failed CI and wait for results
 */
export async function retryAndWaitForCI(
  pr: PR,
  failedRuns: WorkflowRun[],
  config: Config,
  onStatusUpdate?: (status: CIStatus) => void,
): Promise<CIStatus> {
  // Trigger re-runs
  const retryResult = await retryFailedCI(pr, failedRuns);

  if (!retryResult.success) {
    // Some re-runs failed to trigger, but continue waiting
    console.warn(
      `Warning: Some CI re-runs failed to trigger: ${retryResult.errors.join(", ")}`,
    );
  }

  // Wait a moment for GitHub to register the re-runs
  await sleep(5000);

  // Wait for CI to complete
  const finalStatus = await waitForCI(pr, config, onStatusUpdate);

  if (finalStatus.type === "passing") {
    return { type: "retried", outcome: "passing" };
  } else if (finalStatus.type === "failing") {
    return { type: "retried", outcome: "still_failing" };
  }

  return finalStatus;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
