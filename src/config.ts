/**
 * Configuration loading and validation
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Config } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG: Config = {
  org: "PerformYard",
  maxConcurrency: 3,
  staggerDelayMs: 30000, // 30 seconds between starting concurrent PRs
  ciRetryCount: 1,
  waitBetweenBatchesMs: 5000,
  ciPollIntervalMs: 30000,
  ciTimeoutMs: 1800000, // 30 minutes
  excludeRepos: [],
  includeRepos: null,
};

/**
 * Load configuration from file, with defaults
 */
export function loadConfig(configPath?: string): Config {
  const paths = configPath
    ? [configPath]
    : [
        resolve(process.cwd(), "config.json"),
        resolve(__dirname, "..", "config.json"),
      ];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const loaded = JSON.parse(content) as Partial<Config>;
        return validateConfig({ ...DEFAULT_CONFIG, ...loaded });
      } catch (error) {
        throw new Error(
          `Failed to parse config file ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // No config file found, use defaults
  return DEFAULT_CONFIG;
}

/**
 * Validate configuration
 */
function validateConfig(config: Config): Config {
  if (!config.org || typeof config.org !== "string") {
    throw new Error("Config: 'org' must be a non-empty string");
  }

  if (typeof config.maxConcurrency !== "number" || config.maxConcurrency < 1) {
    throw new Error("Config: 'maxConcurrency' must be a positive number");
  }

  if (typeof config.staggerDelayMs !== "number" || config.staggerDelayMs < 0) {
    throw new Error("Config: 'staggerDelayMs' must be a non-negative number");
  }

  if (typeof config.ciRetryCount !== "number" || config.ciRetryCount < 0) {
    throw new Error("Config: 'ciRetryCount' must be a non-negative number");
  }

  if (
    typeof config.waitBetweenBatchesMs !== "number" ||
    config.waitBetweenBatchesMs < 0
  ) {
    throw new Error(
      "Config: 'waitBetweenBatchesMs' must be a non-negative number"
    );
  }

  if (
    typeof config.ciPollIntervalMs !== "number" ||
    config.ciPollIntervalMs < 1000
  ) {
    throw new Error(
      "Config: 'ciPollIntervalMs' must be at least 1000 (1 second)"
    );
  }

  if (typeof config.ciTimeoutMs !== "number" || config.ciTimeoutMs < 0) {
    throw new Error("Config: 'ciTimeoutMs' must be a non-negative number");
  }

  if (!Array.isArray(config.excludeRepos)) {
    throw new Error("Config: 'excludeRepos' must be an array");
  }

  if (config.includeRepos !== null && !Array.isArray(config.includeRepos)) {
    throw new Error("Config: 'includeRepos' must be an array or null");
  }

  return config;
}

/**
 * Override config with CLI arguments
 */
export function applyCliOverrides(
  config: Config,
  args: {
    org?: string;
    maxConcurrency?: number;
    staggerDelayMs?: number;
  }
): Config {
  return {
    ...config,
    ...(args.org && { org: args.org }),
    ...(args.maxConcurrency && { maxConcurrency: args.maxConcurrency }),
    ...(args.staggerDelayMs !== undefined && { staggerDelayMs: args.staggerDelayMs }),
  };
}
