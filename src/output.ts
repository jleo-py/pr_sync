/**
 * Terminal output formatting
 */

import type { PR, RunSummary, CIStatus } from "./types.js";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

// Icons
const icons = {
  check: "\u2705", // ✅
  cross: "\u274C", // ❌
  warning: "\u26A0\uFE0F", // ⚠️
  conflict: "\u{1F534}", // 🔴
  pending: "\u23F3", // ⏳
  rocket: "\u{1F680}", // 🚀
  package: "\u{1F4E6}", // 📦
  search: "\u{1F50D}", // 🔍
  retry: "\u{1F504}", // 🔄
};

export function printHeader(): void {
  console.log();
  console.log(
    `${colors.bold}${colors.cyan}PR Sync - Keep your PRs up to date${colors.reset}`
  );
  console.log(colors.dim + "─".repeat(50) + colors.reset);
  console.log();
}

export function printSearching(org: string, user: string): void {
  console.log(
    `${icons.search} Searching for open PRs by ${colors.bold}${user}${colors.reset} in ${colors.bold}${org}${colors.reset}...`
  );
}

export function printFoundPRs(prs: PR[]): void {
  console.log();
  console.log(
    `${icons.search} Found ${colors.bold}${prs.length}${colors.reset} open PR${
      prs.length === 1 ? "" : "s"
    }`
  );
  console.log();
}

export function printDependencyOrder(hasStackedPRs: boolean): void {
  if (hasStackedPRs) {
    console.log(
      `${colors.dim}  (sorted by dependency chain - base branches first)${colors.reset}`
    );
    console.log();
  }
}

export function printDepthLevelStart(depth: number, count: number): void {
  const label =
    depth === 0
      ? "Base PRs (targeting main/master)"
      : `Stacked PRs (depth ${depth})`;
  console.log(
    `${icons.package} ${colors.bold}${label}${colors.reset} - ${count} PR${
      count === 1 ? "" : "s"
    }`
  );
}

export function printPRStart(pr: PR): void {
  const repoShort = pr.repo.split("/")[1] || pr.repo;
  console.log(
    `  ${colors.dim}├─${colors.reset} ${repoShort}#${pr.number}: ${truncate(
      pr.title,
      40
    )}`
  );
}

export function printPRStatus(pr: PR, status: string, icon: string): void {
  const repoShort = pr.repo.split("/")[1] || pr.repo;
  console.log(
    `  ${icon} ${colors.bold}${repoShort}#${pr.number}${colors.reset} - ${status}`
  );
}

export function printCIStatus(status: CIStatus): void {
  switch (status.type) {
    case "passing":
      console.log(`    ${icons.check} CI passing`);
      break;
    case "failing":
      console.log(
        `    ${icons.warning} CI failing (${status.runs.length} failed run${
          status.runs.length === 1 ? "" : "s"
        })`
      );
      break;
    case "pending":
      console.log(`    ${icons.pending} CI in progress...`);
      break;
    case "retried":
      if (status.outcome === "passing") {
        console.log(`    ${icons.check} CI passing after retry`);
      } else {
        console.log(`    ${icons.warning} CI still failing after retry`);
      }
      break;
    case "timeout":
      console.log(`    ${icons.warning} CI timed out waiting`);
      break;
    case "none":
      console.log(`    ${colors.dim}(no CI configured)${colors.reset}`);
      break;
  }
}

export function printRetrying(pr: PR, runCount: number): void {
  const repoShort = pr.repo.split("/")[1] || pr.repo;
  console.log(
    `    ${icons.retry} Re-running ${runCount} failed job${
      runCount === 1 ? "" : "s"
    }...`
  );
}

export function printWaitingForCI(): void {
  console.log(`    ${icons.pending} Waiting for CI...`);
}

export function printSummary(summary: RunSummary): void {
  console.log();
  console.log(colors.bold + "━".repeat(50) + colors.reset);
  console.log(`${colors.bold}SUMMARY${colors.reset}`);
  console.log();

  // Up to date / passing
  const passing = [...summary.upToDate, ...summary.updated].filter((s) => {
    if (s.status.type === "up_to_date") return true;
    if (s.status.type === "updated") {
      const ci = s.status.ciStatus;
      return (
        ci.type === "passing" ||
        (ci.type === "retried" && ci.outcome === "passing")
      );
    }
    return false;
  });

  if (passing.length > 0) {
    console.log(
      `  ${icons.check} ${colors.green}Passing: ${passing.length}${colors.reset}`
    );
    for (const s of passing) {
      const repoShort = s.pr.repo.split("/")[1] || s.pr.repo;
      console.log(
        `     ${colors.dim}${repoShort}#${s.pr.number}${colors.reset}`
      );
    }
  }

  // Conflicts
  if (summary.conflicts.length > 0) {
    console.log();
    console.log(
      `  ${icons.conflict} ${colors.red}Merge Conflicts: ${summary.conflicts.length}${colors.reset} ${colors.dim}(needs manual resolution)${colors.reset}`
    );
    for (const s of summary.conflicts) {
      const repoShort = s.pr.repo.split("/")[1] || s.pr.repo;
      console.log(`     ${s.pr.url}`);
    }
  }

  // CI Failing
  if (summary.ciFailing.length > 0) {
    console.log();
    console.log(
      `  ${icons.warning} ${colors.yellow}CI Failing: ${summary.ciFailing.length}${colors.reset} ${colors.dim}(needs investigation)${colors.reset}`
    );
    for (const s of summary.ciFailing) {
      const repoShort = s.pr.repo.split("/")[1] || s.pr.repo;
      console.log(`     ${s.pr.url}`);
    }
  }

  // Errors
  if (summary.errors.length > 0) {
    console.log();
    console.log(
      `  ${icons.cross} ${colors.red}Errors: ${summary.errors.length}${colors.reset}`
    );
    for (const s of summary.errors) {
      const repoShort = s.pr.repo.split("/")[1] || s.pr.repo;
      const errorMsg =
        s.status.type === "update_failed" ? s.status.error : "Unknown error";
      console.log(
        `     ${repoShort}#${s.pr.number}: ${colors.dim}${errorMsg}${colors.reset}`
      );
    }
  }

  console.log();
  console.log(colors.bold + "━".repeat(50) + colors.reset);
  console.log();
}

export function printNoPRsFound(): void {
  console.log();
  console.log(`${icons.check} No open PRs found. You're all caught up!`);
  console.log();
}

export function printError(message: string): void {
  console.error(`${icons.cross} ${colors.red}Error: ${message}${colors.reset}`);
}

export function printWarning(message: string): void {
  console.warn(`${icons.warning} ${colors.yellow}${message}${colors.reset}`);
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
