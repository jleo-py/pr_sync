// Configuration
export interface Config {
  org: string;
  maxConcurrency: number;
  staggerDelayMs: number;
  ciRetryCount: number;
  ciPollIntervalMs: number;
  ciTimeoutMs: number;
  excludeRepos: string[];
  includeRepos: string[] | null; // null means all repos
}

// GitHub User
export interface User {
  login: string;
}

// Pull Request
export interface PR {
  number: number;
  title: string;
  repo: string; // "org/repo" format
  headRef: string; // branch name
  baseRef: string; // target branch (e.g., "main", "master")
  url: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  behindBy: number;
}

// PR processing status
export type PRStatus =
  | { type: "up_to_date"; ciStatus?: CIStatus }
  | { type: "updated"; ciStatus: CIStatus }
  | { type: "conflict" }
  | { type: "update_failed"; error: string }
  | { type: "skipped"; reason: string };

// CI/Workflow
export interface WorkflowRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  url: string;
  headSha: string;
}

export type CIStatus =
  | { type: "passing" }
  | { type: "failing"; runs: WorkflowRun[] }
  | { type: "pending"; runs: WorkflowRun[] }
  | { type: "retried"; outcome: "passing" | "still_failing" }
  | { type: "timeout" }
  | { type: "none" }; // No CI configured

// Results for mutations
export interface UpdateResult {
  success: boolean;
  conflict: boolean;
  error?: string;
}

export interface RerunResult {
  success: boolean;
  error?: string;
}

// Final summary for a PR
export interface PRSummary {
  pr: PR;
  status: PRStatus;
  retriedCI: boolean;
}

// Overall run summary
export interface RunSummary {
  totalPRs: number;
  upToDate: PRSummary[];
  updated: PRSummary[];
  conflicts: PRSummary[];
  ciFailing: PRSummary[];
  errors: PRSummary[];
}
