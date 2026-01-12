#!/usr/bin/env node

/**
 * PR Sync CLI
 *
 * Keep your GitHub PRs updated with their target branch and CI passing.
 *
 * Usage:
 *   pr-sync                  # Run with default config
 *   pr-sync --org MyOrg      # Override organization
 *   pr-sync --batch-size 2   # Override batch size
 *   pr-sync --help           # Show help
 */

import { loadConfig, applyCliOverrides } from "./config.js";
import { syncAllPRs } from "./runner.js";
import { printError } from "./output.js";

interface CliArgs {
  help: boolean;
  org?: string;
  maxConcurrency?: number;
  staggerDelayMs?: number;
  configPath?: string;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "--org":
        result.org = args[++i];
        break;
      case "--max-concurrency":
        result.maxConcurrency = parseInt(args[++i], 10);
        break;
      case "--stagger-delay":
        result.staggerDelayMs = parseInt(args[++i], 10);
        break;
      case "--config":
        result.configPath = args[++i];
        break;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
PR Sync - Keep your GitHub PRs updated with their target branch

USAGE:
  pr-sync [OPTIONS]

OPTIONS:
  -h, --help              Show this help message
  --org <org>             GitHub organization (default: from config)
  --max-concurrency <n>   Max PRs to process concurrently (default: 3)
  --stagger-delay <ms>    Delay between starting concurrent PRs (default: 30000)
  --config <path>         Path to config file (default: ./config.json)

CONFIGURATION:
  Create a config.json file with:
  {
    "org": "YourOrg",              // GitHub organization
    "maxConcurrency": 3,           // Max PRs to process concurrently
    "staggerDelayMs": 30000,       // 30s delay between starting concurrent PRs
    "ciRetryCount": 1,             // Times to retry failed CI
    "waitBetweenBatchesMs": 5000,  // Wait between dependency depth levels
    "ciPollIntervalMs": 30000,     // CI polling interval
    "ciTimeoutMs": 1800000,        // 30 min CI timeout
    "excludeRepos": [],            // Repos to skip
    "includeRepos": null           // null = all repos, or ["repo1", "repo2"]
  }

PREREQUISITES:
  - GitHub CLI (gh) installed and authenticated
  - Run 'gh auth status' to verify

WHAT IT DOES:
  1. Finds all your open PRs in the organization
  2. Groups PRs by dependency depth (stacked PRs are processed after their base)
  3. Updates branches that are behind their target (merge, not rebase)
  4. Processes PRs concurrently within each depth level (with staggered starts)
  5. Waits for CI to complete, retries failed CI once
  6. Reports conflicts and persistent failures for manual attention

SAFETY:
  This tool can ONLY:
  - Update PR branches with their base branch
  - Re-run failed CI jobs
  It CANNOT merge, close, or make other changes to your PRs.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    // Load and apply config
    let config = loadConfig(args.configPath);
    config = applyCliOverrides(config, {
      org: args.org,
      maxConcurrency: args.maxConcurrency,
      staggerDelayMs: args.staggerDelayMs,
    });

    // Run sync
    const summary = await syncAllPRs(config);

    // Exit with error code if there were issues
    if (summary.conflicts.length > 0 || summary.ciFailing.length > 0) {
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
