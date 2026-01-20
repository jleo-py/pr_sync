/**
 * Main orchestration logic for PR sync
 */

import pLimit from "p-limit";
import type { Config, PR, PRSummary, RunSummary, CIStatus } from "./types.js";
import {
  getAuthenticatedUser,
  listOpenPRs,
  updateBranchWithBase,
  refreshPRStatus,
} from "./github.js";
import { getCIStatus, waitForCI, retryAndWaitForCI } from "./ci.js";
import * as output from "./output.js";

interface PRWithDepth {
  pr: PR;
  depth: number;
}

/**
 * Creates a rate limiter that ensures operations are spaced apart by the given delay.
 * Returns a function that waits if needed before allowing the next operation.
 */
function createUpdateRateLimiter(delayMs: number): () => Promise<void> {
  let lastUpdateTime = 0;

  return async () => {
    if (delayMs <= 0) return;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime;

    if (lastUpdateTime > 0 && timeSinceLastUpdate < delayMs) {
      const waitTime = delayMs - timeSinceLastUpdate;
      await sleep(waitTime);
    }

    lastUpdateTime = Date.now();
  };
}

/**
 * Main entry point - sync all PRs
 */
export async function syncAllPRs(config: Config): Promise<RunSummary> {
  output.printHeader();

  // Get current user
  const user = await getAuthenticatedUser();
  output.printSearching(config.org, user.login);

  // Find all open PRs
  let prs = await listOpenPRs(config.org, user.login);

  // Filter by includeRepos/excludeRepos
  prs = filterPRs(prs, config);

  // Sort by dependency chain - PRs targeting master first, then their dependents
  const sortResult = sortPRsByDependencyChain(prs);
  prs = sortResult.prs;

  if (prs.length === 0) {
    output.printNoPRsFound();
    return {
      totalPRs: 0,
      upToDate: [],
      updated: [],
      conflicts: [],
      ciFailing: [],
      errors: [],
    };
  }

  output.printFoundPRs(prs);
  output.printDependencyOrder(sortResult.hasStackedPRs);

  // Process PRs with dependency-aware concurrent queue
  const summaries = await processPRsWithDependencyQueue(
    sortResult.prsWithDepth,
    config
  );

  // Build and print summary
  const summary = buildSummary(summaries);
  output.printSummary(summary);

  return summary;
}

/**
 * Process a single PR
 */
async function processPR(
  pr: PR,
  config: Config,
  waitForUpdateSlot?: () => Promise<void>
): Promise<PRSummary> {
  return processPRWithEarlyResolve(pr, config, waitForUpdateSlot);
}

/**
 * Process a single PR with an optional callback after branch update.
 * The callback is called after the branch is updated (or confirmed up-to-date)
 * but BEFORE waiting for CI. This allows stacked PRs to start updating
 * while the base PR's CI is still running.
 */
async function processPRWithEarlyResolve(
  pr: PR,
  config: Config,
  waitForUpdateSlot?: () => Promise<void>,
  onBranchUpdated?: () => void
): Promise<PRSummary> {
  // Check if PR has conflicts
  if (pr.mergeable === "CONFLICTING") {
    output.printPRStatus(pr, "merge conflict", "\u{1F534}");
    // Still resolve - stacked PRs can try (they'll likely also conflict)
    if (onBranchUpdated) onBranchUpdated();
    return {
      pr,
      status: { type: "conflict" },
      retriedCI: false,
    };
  }

  // Check if PR needs updating
  const needsUpdate = pr.behindBy > 0 || pr.behindBy === -1; // -1 means we couldn't check, so try anyway

  if (!needsUpdate) {
    // Already up to date - resolve immediately so stacked PRs can proceed
    output.printPRStatus(pr, "already up to date", "\u2705");
    if (onBranchUpdated) onBranchUpdated();

    // Check CI status
    let ciStatus = await getCIStatus(pr);

    // If CI is pending, wait for it to complete
    if (ciStatus.type === "pending") {
      output.printWaitingForCI(pr);
      ciStatus = await waitForCI(pr, config);
    }

    output.printCIStatus(ciStatus, pr);

    // If CI is failing, retry
    if (ciStatus.type === "failing" && config.ciRetryCount > 0) {
      output.printRetrying(pr, ciStatus.runs.length);
      ciStatus = await retryAndWaitForCI(pr, ciStatus.runs, config);
      output.printCIStatus(ciStatus, pr);

      return {
        pr,
        status: { type: "up_to_date", ciStatus },
        retriedCI: true,
      };
    }

    return {
      pr,
      status: { type: "up_to_date", ciStatus },
      retriedCI: false,
    };
  }

  // Wait for rate limiter before updating (staggers updates to avoid hammering GitHub)
  if (waitForUpdateSlot) {
    await waitForUpdateSlot();
  }

  // Try to update the branch
  const updateResult = await updateBranchWithBase(pr.repo, pr.number);

  if (!updateResult.success) {
    if (updateResult.conflict) {
      output.printPRStatus(pr, "merge conflict during update", "\u{1F534}");
      // Still resolve - stacked PRs can try
      if (onBranchUpdated) onBranchUpdated();
      return {
        pr,
        status: { type: "conflict" },
        retriedCI: false,
      };
    }

    output.printPRStatus(pr, `update failed: ${updateResult.error}`, "\u274C");
    // Still resolve - stacked PRs can try
    if (onBranchUpdated) onBranchUpdated();
    return {
      pr,
      status: {
        type: "update_failed",
        error: updateResult.error || "Unknown error",
      },
      retriedCI: false,
    };
  }

  output.printPRStatus(pr, "updated", "\u{1F680}");

  // Branch is updated - resolve so stacked PRs can start updating
  if (onBranchUpdated) onBranchUpdated();

  output.printWaitingForCI(pr);

  // Wait for CI to complete (stacked PRs don't wait for this)
  let ciStatus = await waitForCI(pr, config);
  output.printCIStatus(ciStatus, pr);

  let retriedCI = false;

  // If CI failed, retry once
  if (ciStatus.type === "failing" && config.ciRetryCount > 0) {
    output.printRetrying(pr, ciStatus.runs.length);
    retriedCI = true;
    ciStatus = await retryAndWaitForCI(pr, ciStatus.runs, config);
    output.printCIStatus(ciStatus, pr);
  }

  return {
    pr,
    status: { type: "updated", ciStatus },
    retriedCI,
  };
}

/**
 * Filter PRs based on config
 */
function filterPRs(prs: PR[], config: Config): PR[] {
  let filtered = prs;

  // Include only specific repos
  if (config.includeRepos && config.includeRepos.length > 0) {
    const includeSet = new Set(
      config.includeRepos.map((r) =>
        r.includes("/") ? r : `${config.org}/${r}`
      )
    );
    filtered = filtered.filter((pr) => includeSet.has(pr.repo));
  }

  // Exclude specific repos
  if (config.excludeRepos && config.excludeRepos.length > 0) {
    const excludeSet = new Set(
      config.excludeRepos.map((r) =>
        r.includes("/") ? r : `${config.org}/${r}`
      )
    );
    filtered = filtered.filter((pr) => !excludeSet.has(pr.repo));
  }

  return filtered;
}

interface SortResult {
  prs: PR[];
  prsWithDepth: PRWithDepth[];
  hasStackedPRs: boolean;
}

/**
 * Sort PRs by dependency chain depth
 *
 * PRs targeting master/main (or any non-PR branch) are processed first.
 * PRs targeting other PR branches are processed after their dependencies.
 *
 * Example: If PR A → branch-b → PR B → branch-c → PR C → master
 * Order will be: C (depth 0), B (depth 1), A (depth 2)
 */
function sortPRsByDependencyChain(prs: PR[]): SortResult {
  // Build a map of headRef → PR for quick lookup
  // Key is "repo:headRef" to handle PRs in different repos with same branch names
  const headRefToPR = new Map<string, PR>();
  for (const pr of prs) {
    headRefToPR.set(`${pr.repo}:${pr.headRef}`, pr);
  }

  // Calculate depth for each PR (memoized)
  const depthCache = new Map<number, number>();

  function getDepth(pr: PR, visited: Set<number> = new Set()): number {
    // Check cache
    if (depthCache.has(pr.number)) {
      return depthCache.get(pr.number)!;
    }

    // Detect cycles
    if (visited.has(pr.number)) {
      // Cycle detected - treat as depth 0 to avoid infinite loop
      return 0;
    }
    visited.add(pr.number);

    // Check if baseRef is another PR's headRef (in same repo)
    const basePR = headRefToPR.get(`${pr.repo}:${pr.baseRef}`);

    let depth: number;
    if (!basePR) {
      // baseRef is not another PR's branch (e.g., master/main) - depth 0
      depth = 0;
    } else {
      // baseRef is another PR's branch - depth is 1 + that PR's depth
      depth = 1 + getDepth(basePR, visited);
    }

    depthCache.set(pr.number, depth);
    return depth;
  }

  // Calculate depths for all PRs
  const prsWithDepth = prs.map((pr) => ({
    pr,
    depth: getDepth(pr),
  }));

  // Sort by depth ascending (lower depth = closer to master = processed first)
  prsWithDepth.sort((a, b) => a.depth - b.depth);

  // Check if any PRs have depth > 0 (meaning they depend on other PRs)
  const hasStackedPRs = prsWithDepth.some((item) => item.depth > 0);

  return {
    prs: prsWithDepth.map((item) => item.pr),
    prsWithDepth,
    hasStackedPRs,
  };
}

/**
 * Group PRs by their dependency depth
 */
function groupPRsByDepth(prsWithDepth: PRWithDepth[]): Map<number, PR[]> {
  const groups = new Map<number, PR[]>();
  for (const { pr, depth } of prsWithDepth) {
    const existing = groups.get(depth) || [];
    existing.push(pr);
    groups.set(depth, existing);
  }
  return groups;
}

/**
 * Process PRs using a dependency-aware concurrent queue.
 *
 * Instead of processing by depth level, this starts processing PRs as soon as
 * their dependencies are complete, respecting maxConcurrency at all times.
 *
 * For stacked PRs (depth > 0), the PR status is refreshed from GitHub before
 * processing to detect if the base branch was updated.
 */
async function processPRsWithDependencyQueue(
  prsWithDepth: PRWithDepth[],
  config: Config
): Promise<PRSummary[]> {
  const limit = pLimit(config.maxConcurrency);
  const waitForUpdateSlot = createUpdateRateLimiter(config.staggerDelayMs);

  // Use composite keys (repo:number) to avoid collisions across repos
  const prKey = (pr: PR) => `${pr.repo}:#${pr.number}`;

  // Build a map of headRef -> PR for dependency lookup
  const headRefToPR = new Map<string, PR>();
  for (const { pr } of prsWithDepth) {
    headRefToPR.set(`${pr.repo}:${pr.headRef}`, pr);
  }

  // Track which base PR each PR depends on (if any)
  // Key: prKey, Value: prKey of the dependency
  const dependsOn = new Map<string, string>();

  // For each PR, find what it depends on
  for (const { pr } of prsWithDepth) {
    const basePRKey = `${pr.repo}:${pr.baseRef}`;
    const basePR = headRefToPR.get(basePRKey);
    if (basePR) {
      dependsOn.set(prKey(pr), prKey(basePR));
    }
  }

  // Track summaries and completion promises by prKey
  const summaries = new Map<string, PRSummary>();
  const prPromises = new Map<string, Promise<void>>();
  const prResolvers = new Map<string, () => void>();

  // Create a completion promise for each PR
  for (const { pr } of prsWithDepth) {
    let resolver!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    prPromises.set(prKey(pr), promise);
    prResolvers.set(prKey(pr), resolver);
  }

  // Process a single PR (uses p-limit slot only during actual processing)
  async function processOnePR(item: PRWithDepth): Promise<void> {
    let { pr } = item;
    const { depth } = item;
    const key = prKey(pr);

    // Wait for dependency's BRANCH UPDATE (not CI) before starting
    const depKey = dependsOn.get(key);
    if (depKey) {
      const depPromise = prPromises.get(depKey);
      if (depPromise) {
        await depPromise;
      }
    }

    // Acquire a p-limit slot for processing
    await limit(async () => {
      // For stacked PRs, refresh status since base may have been updated
      if (depth > 0) {
        output.printRefreshingStatus(pr);
        pr = await refreshPRStatus(pr);
      }

      output.printPRStart(pr);

      // Process the PR but resolve dependency promise after branch update (not after CI)
      const summary = await processPRWithEarlyResolve(
        pr,
        config,
        waitForUpdateSlot,
        () => {
          // Resolve promise after branch update so stacked PRs can proceed
          const resolver = prResolvers.get(key);
          if (resolver) resolver();
        }
      );
      summaries.set(key, summary);
    });
  }

  // Start all PRs concurrently - they'll wait for dependencies as needed
  const tasks = prsWithDepth.map((item) => processOnePR(item));
  await Promise.all(tasks);

  // Return summaries in original order
  return prsWithDepth.map(({ pr }) => summaries.get(prKey(pr))!);
}

/**
 * Build summary from PR summaries
 */
function buildSummary(summaries: PRSummary[]): RunSummary {
  const summary: RunSummary = {
    totalPRs: summaries.length,
    upToDate: [],
    updated: [],
    conflicts: [],
    ciFailing: [],
    errors: [],
  };

  for (const s of summaries) {
    switch (s.status.type) {
      case "up_to_date":
        summary.upToDate.push(s);
        // Check if CI is failing for up-to-date PRs too
        if (s.status.ciStatus && isCIFailing(s.status.ciStatus)) {
          summary.ciFailing.push(s);
        }
        break;
      case "updated":
        summary.updated.push(s);
        // Check if CI is still failing
        if (isCIFailing(s.status.ciStatus)) {
          summary.ciFailing.push(s);
        }
        break;
      case "conflict":
        summary.conflicts.push(s);
        break;
      case "update_failed":
        summary.errors.push(s);
        break;
      case "skipped":
        // Not currently used, but here for completeness
        break;
    }
  }

  return summary;
}

function isCIFailing(status: CIStatus): boolean {
  if (status.type === "failing") return true;
  if (status.type === "retried" && status.outcome === "still_failing")
    return true;
  if (status.type === "timeout") return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
