# PR Sync

Keep your GitHub PRs updated with their target branch and CI passing.

## What It Does

1. Finds all your open PRs in the configured organization
2. Updates branches that are behind their target (merge commits, not rebase)
3. Waits for CI to complete
4. Retries failed CI once (handles flaky tests)
5. Reports conflicts and persistent failures for manual attention

## Safety

This tool can **ONLY**:
- Update PR branches with their base branch
- Re-run failed CI jobs

It **CANNOT** merge, close, or make other changes to your PRs.

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) installed and authenticated
  ```bash
  gh auth status  # Verify authentication
  ```

## Installation

```bash
# Clone the repository
git clone https://github.com/jleo-py/pr_sync.git
cd pr_sync

# Install dependencies
pnpm install

# Build
pnpm build
```

## Configuration

Copy the example config and customize:

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "org": "YourOrg",
  "batchSize": 3,
  "ciRetryCount": 1,
  "waitBetweenBatchesMs": 5000,
  "ciPollIntervalMs": 30000,
  "ciTimeoutMs": 1800000,
  "excludeRepos": [],
  "includeRepos": null
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `org` | `"PerformYard"` | GitHub organization to search |
| `batchSize` | `3` | Number of PRs to process in parallel |
| `ciRetryCount` | `1` | Times to retry failed CI (0 = no retries) |
| `waitBetweenBatchesMs` | `5000` | Delay between batches (ms) |
| `ciPollIntervalMs` | `30000` | How often to check CI status (ms) |
| `ciTimeoutMs` | `1800000` | Max time to wait for CI (30 min) |
| `excludeRepos` | `[]` | Repos to skip (e.g., `["legacy-app"]`) |
| `includeRepos` | `null` | Only process these repos (`null` = all) |

## Usage

```bash
# Run with config file
pnpm start

# Or with CLI options
pnpm start --org MyOrg --batch-size 2

# See all options
pnpm start --help
```

## Output

```
PR Sync - Keep your PRs up to date
──────────────────────────────────────────────────

🔍 Searching for open PRs by jleo in PerformYard...

🔍 Found 4 open PRs

📦 Batch 1/2
  ✅ PerformYard#1234 - already up to date
    ✅ CI passing
  🚀 PerformYard#1235 - updated
    ⏳ Waiting for CI...
    ✅ CI passing

📦 Batch 2/2
  🔴 Logan#456 - merge conflict
  🚀 PerformYard#1237 - updated
    ⚠️ CI failing (2 failed runs)
    🔄 Re-running 2 failed jobs...
    ✅ CI passing after retry

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY

  ✅ Passing: 3
     PerformYard#1234
     PerformYard#1235
     PerformYard#1237

  🔴 Merge Conflicts: 1 (needs manual resolution)
     https://github.com/PerformYard/Logan/pull/456

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Development

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Build
pnpm build

# Run without building (dev mode)
pnpm dev
```

## Architecture

```
src/
├── index.ts      # CLI entry point
├── config.ts     # Configuration loading
├── github.ts     # GitHub operations (safety-scoped)
├── ci.ts         # CI status and retries
├── runner.ts     # Orchestration logic
├── output.ts     # Terminal formatting
└── types.ts      # TypeScript types

tests/
├── github.test.ts
├── runner.test.ts
└── mocks/
    └── gh.ts     # Mock gh CLI for testing
```

## Sharing with Teammates

1. Share this directory or create a git repo
2. Each user copies `config.example.json` to `config.json`
3. Users customize `org` if working with different organizations
4. The tool auto-detects the current GitHub user via `gh api user`

## Troubleshooting

**"No PRs found"**
- Verify you're authenticated: `gh auth status`
- Check the organization name in config
- Ensure you have open PRs: `gh pr list --author @me`

**"Command failed" errors**
- Check GitHub CLI is up to date: `gh --version`
- Re-authenticate if needed: `gh auth login`

**Rate limits**
- Reduce `batchSize` in config
- Increase `waitBetweenBatchesMs`
