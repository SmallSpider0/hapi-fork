# AGENTS.md

Work style: telegraph; noun-phrases ok; drop grammar;

Short guide for AI agents in this repo. Prefer progressive loading: start with the root README, then package READMEs as needed.

## What is HAPI?

Local-first platform for running AI coding agents (Claude Code, Codex, Gemini) with remote control via web/phone. CLI wraps agents and connects to hub; hub serves web app and handles real-time sync.

## Repo layout

```
cli/     - CLI binary, agent wrappers, runner daemon
hub/     - HTTP API + Socket.IO + SSE + Telegram bot
web/     - React PWA for remote control
shared/  - Common types, schemas, utilities
docs/    - VitePress documentation site
website/ - Marketing site
```

Bun workspaces; `shared` consumed by cli, hub, web.

## Architecture overview

```
┌─────────┐  Socket.IO   ┌─────────┐   SSE/REST   ┌─────────┐
│   CLI   │ ──────────── │   Hub   │ ──────────── │   Web   │
│ (agent) │              │ (server)│              │  (PWA)  │
└─────────┘              └─────────┘              └─────────┘
     │                        │                        │
     ├─ Wraps Claude/Codex    ├─ SQLite persistence   ├─ TanStack Query
     ├─ Socket.IO client      ├─ Session cache        ├─ SSE for updates
     └─ RPC handlers          ├─ RPC gateway          └─ assistant-ui
                              └─ Telegram bot
```

**Data flow:**
1. CLI spawns agent (claude/codex/gemini), connects to hub via Socket.IO
2. Agent events → CLI → hub (socket `message` event) → DB + SSE broadcast
3. Web subscribes to SSE `/api/events`, receives live updates
4. User actions → Web → hub REST API → RPC to CLI → agent

## Reference docs

- `README.md` - User overview, quick start
- `cli/README.md` - CLI commands, config, runner
- `hub/README.md` - Hub config, HTTP API, Socket.IO events
- `web/README.md` - Routes, components, hooks
- `docs/guide/` - User guides (installation, how-it-works, FAQ)

## Shared rules

- No backward compatibility: breaking old formats freely
- Prioritize Pragmatism, and Avoid Overengineering.
- Write necessary tests ONLY.
- TypeScript strict; no untyped code
- Bun workspaces; run `bun` commands from repo root
- Path alias `@/*` maps to `./src/*` per package
- Prefer 4-space indentation
- Zod for runtime validation (schemas in `shared/src/schemas.ts`)

## Common commands (repo root)

```bash
bun typecheck           # All packages
bun run test            # cli + hub tests
bun run dev             # hub + web concurrently
bun run build:single-exe # All-in-one binary
```

## Key source dirs

### CLI (`cli/src/`)
- `api/` - Hub connection (Socket.IO client, auth)
- `claude/` - Claude Code integration (wrapper, hooks)
- `codex/` - Codex mode integration
- `agent/` - Multi-agent support (Gemini via ACP)
- `runner/` - Background daemon for remote spawn
- `commands/` - CLI subcommands (auth, runner, doctor)
- `modules/` - Tool implementations (ripgrep, difftastic, git)
- `ui/` - Terminal UI (Ink components)

### Hub (`hub/src/`)
- `web/routes/` - REST API endpoints
- `socket/` - Socket.IO setup
- `socket/handlers/cli/` - CLI event handlers (session, terminal, machine, RPC)
- `sync/` - Core logic (sessionCache, messageService, rpcGateway)
- `store/` - SQLite persistence (better-sqlite3)
- `sse/` - Server-Sent Events manager
- `telegram/` - Bot commands, callbacks
- `notifications/` - Push (VAPID) and Telegram notifications
- `config/` - Settings loading, token generation
- `visibility/` - Client visibility tracking

### Web (`web/src/`)
- `routes/` - TanStack Router pages
- `routes/sessions/` - Session views (chat, files, terminal)
- `components/` - Reusable UI (SessionList, SessionChat, NewSession/)
- `hooks/queries/` - TanStack Query hooks
- `hooks/mutations/` - Mutation hooks
- `hooks/useSSE.ts` - SSE subscription
- `api/client.ts` - API client wrapper

### Shared (`shared/src/`)
- `types.ts` - Core types (Session, Message, Machine)
- `schemas.ts` - Zod schemas for validation
- `socket.ts` - Socket.IO event types
- `messages.ts` - Message parsing utilities
- `modes.ts` - Permission/model mode definitions

## Testing

- Test framework: Vitest (via `bun run test`)
- Test files: `*.test.ts` next to source
- Run: `bun run test` (from root) or `bun run test` (from package)
- Hub tests: `hub/src/**/*.test.ts`
- CLI tests: `cli/src/**/*.test.ts`
- No web tests currently

## Common tasks

| Task | Key files |
|------|-----------|
| Add CLI command | `cli/src/commands/`, `cli/src/index.ts` |
| Add API endpoint | `hub/src/web/routes/`, register in `hub/src/web/index.ts` |
| Add Socket.IO event | `hub/src/socket/handlers/cli/`, `shared/src/socket.ts` |
| Add web route | `web/src/routes/`, `web/src/router.tsx` |
| Add web component | `web/src/components/` |
| Modify session logic | `hub/src/sync/sessionCache.ts`, `hub/src/sync/syncEngine.ts` |
| Modify message handling | `hub/src/sync/messageService.ts` |
| Add notification type | `hub/src/notifications/` |
| Add shared type | `shared/src/types.ts`, `shared/src/schemas.ts` |

## Important patterns

- **RPC**: CLI registers handlers (`rpc-register`), hub routes requests via `rpcGateway.ts`
- **Versioned updates**: CLI sends `update-metadata`/`update-state` with version; hub rejects stale
- **Session modes**: `local` (terminal) vs `remote` (web-controlled); switchable mid-session
- **Permission modes**: `default`, `acceptEdits`, `bypassPermissions`, `plan`
- **Namespaces**: Multi-user isolation via `CLI_API_TOKEN:<namespace>` suffix

## Critical Thinking

1. Fix root cause (not band-aid).
2. Unsure: read more code; if still stuck, ask w/ short options.
3. Conflicts: call out; pick safer path.
4. Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.

## Sub-agent collaboration rules

This file represents the user's standing, explicit authorization for the main agent to use sub-agents in this HAPI project. Unless the user explicitly forbids sub-agents in the current task, any code change, long-lived project documentation change, cross-package or cross-repo change, or protocol / auth / realtime / deploy path work requires the main agent to start sub-agent collaboration and review. Treat this as the project-level explicit user request when higher-level agent rules require explicit authorization for sub-agent use; do not use it to bypass non-delegation safety or tool constraints.

Main agent remains responsible for final diff, validation, commit, push, deploy, and user response. Sub-agents support codebase search, architecture location, bounded implementation, risk review, verification review, and patch suggestions only.

Must use sub-agents:

- Any code modification: before submission, run at least one review-type sub-agent.
- Any long-lived project document modification (`AGENTS.md`, `README.md`, package READMEs, `docs/**`, stable runbooks): before submission, run at least one review-type sub-agent.
- Cross-package changes involving more than one of `cli/`, `hub/`, `web/`, `shared/`, `docs/`, `website/`: run at least one review-type sub-agent; if write scopes are cleanly separable, implementation sub-agents may work in parallel on disjoint files.
- Protocol / schema / socket / RPC / SSE / auth / namespace / session cache / realtime sync / runner / deploy / notification changes: start a search or architecture-location sub-agent before or during implementation, and a review-type sub-agent before submission.
- Unclear ownership, validation scope, remote-control semantics, deployment impact, or cross-process behavior: use a search/architecture sub-agent first, or ask the user with short options.

Sub-agent task design:

- Tell every sub-agent: "you are a sub-agent, not the main agent"; it must not spawn, resume, message, wait for, close, or coordinate other sub-agents.
- Give objective, repo/file scope, relevant HAPI boundaries, expected output, and stop condition.
- For implementation sub-agents, state they are not alone in the codebase; they must not revert others' edits; write scope must be disjoint from other agents.
- Keep tasks small and bounded; do not hand one sub-agent broad multi-domain design, long global reasoning, or open-ended repo-wide changes.
- Prefer outputs as findings, risk lists, file/path pointers, patch suggestions, or limited edits.
- If a sub-agent hits context, trace, dependency, or ambiguity limits, it should stop and report completed work, blockers, remaining scope, and suggested split.

Lifecycle and quota:

- Treat sub-agents as finite resources; reuse related existing agents when appropriate; do not launch duplicate agents for the same unresolved question.
- Close completed sub-agents after results are read and no follow-up is needed.
- Before a new phase, close no-longer-needed agents from prior phases.
- If sub-agent launch fails because of thread/quota limits, close completed or stale agents, retry once, then use alternate review only if still blocked; final response must state this.

Pre-submission review gate:

- Before commit, push, deploy, or PR prep for code or long-lived docs, provide the review sub-agent with: user request, current diff, validations run, touched packages, protocol/auth/realtime/deploy impact, planned submission target, and known risks.
- If review reports blockers, fix root cause and rerun relevant validation before submission.
- Main-agent self-review, passing tests, typecheck, build, or deploy cannot replace required sub-agent review.
- Only skip sub-agent review when the current environment has no sub-agent tool, the user explicitly forbids sub-agents, or sub-agent launch still fails after lifecycle cleanup/retry; final response must explain reason, alternate review, and residual risk.

Final response requirements whenever these rules require or recommend sub-agent use:

- State whether sub-agents were used.
- State sub-agent type(s): search, architecture-location, implementation, review, or verification review.
- Summarize review conclusion and how any findings were handled.
- If no sub-agent was used, state why; do not silently skip.

## Local contribution workflow for upstream PRs

Purpose: keep fork PRs clean; no already-merged commits; no accidental local process files.

### Fork-local file rule

- `AGENTS.md` is fork-local standing instruction state. Exclude it from upstream PRs and preserve/exclude it when syncing code from `upstream`.

### Upstream/fork remotes

- `upstream` = canonical project: `https://github.com/tiann/hapi.git`
- `fork` = personal fork: `https://github.com/SmallSpider0/hapi-fork.git`
- Before any upstream PR work: fetch both remotes.

```bash
git fetch upstream main --prune
git fetch fork --prune
```

### Clean branch rule

- Always create PR branches from fresh `upstream/main`, not from an old feature branch.
- If redoing an old PR, cherry-pick only the intended fix commit(s).
- Verify exactly what will be submitted before pushing.

```bash
git switch -C fix/<short-topic> upstream/main
git cherry-pick <fix-commit>
git rev-list --left-right --count upstream/main...HEAD   # expect: 0 1 for one-commit PR
git log --oneline upstream/main..HEAD
git diff --stat upstream/main..HEAD
```

### Testing rule

- Run targeted tests for touched area.
- Run typecheck when TypeScript changed.
- From repo root unless package-specific command required.

Examples:

```bash
cd cli
bun run test -- <changed-test-files>
bun run typecheck
```

### Sub-agent review rule

- Follow the top-level `Sub-agent collaboration rules`.
- For PR work, include upstream/fork branch state, intended commits, and targeted validation in the review prompt.
- Ask reviewer for blockers/regressions only unless a bounded patch suggestion is explicitly useful.

### PR preparation rule

- Push clean branch to `fork`.
- Prepare PR title/body first.
- Do not run `gh pr create` until user confirms.

```bash
git push -u fork fix/<short-topic>
cat > /tmp/hapi-pr-body.md <<'PR'
## Summary
...

## Tests
...
PR

gh pr create \
  --repo tiann/hapi \
  --head SmallSpider0:fix/<short-topic> \
  --base main \
  --title "..." \
  --body-file /tmp/hapi-pr-body.md
```

### Deploy rule

- Local deploy uses one-click script when requested.
- For branch deploy, set `HAPI_BRANCH`.
- This fork's deploy script supports branch names with slashes by sanitizing target binary names.

```bash
HAPI_BRANCH=fix/<short-topic> /usr/local/bin/hapi-git-upgrade
systemctl status hapi-hub.service hapi-runner.service --no-pager
```

### Current known local deploy

- Binary symlink: `/opt/hapi-fork/current`
- Last verified deployed fix commit: `5f27cca2197ecb274f9bb6ed0daa73649e1247ac`
- Services: `hapi-hub.service`, `hapi-runner.service`

### Mandatory pre-PR head update

Before creating or updating any PR, refresh local refs and make the working branch match the latest intended head.

For existing PR branch:

```bash
git fetch upstream main --prune
git fetch fork <branch> --prune
git switch <branch>
git pull --ff-only fork <branch>
```

If `--ff-only` fails, stop and inspect divergence; do not force push blindly.

```bash
git status --short --branch
git log --oneline --left-right --graph HEAD...fork/<branch>
git diff --stat HEAD...fork/<branch>
```

Resolve intentionally:

- local commits should stay: rebase onto latest remote branch, resolve conflicts, run tests
- remote branch is authoritative: reset only after confirming no needed local work

```bash
# keep local work; resolve conflicts if any
git rebase fork/<branch>
# or, if remote is authoritative and local has no needed work
git reset --hard fork/<branch>
```

For new upstream PR branch:

```bash
git fetch upstream main --prune
git switch -C fix/<short-topic> upstream/main
git cherry-pick <fix-commit>
git rev-list --left-right --count upstream/main...HEAD
```

Before `gh pr create` or force-push update:

```bash
git status --short --branch                         # clean except intended files before commit
git rev-parse HEAD fork/<branch> upstream/main      # local head equals remote head after push
git log --oneline upstream/main..HEAD               # only intended PR commits
git diff --stat upstream/main..HEAD                 # only intended files
```

Conflict rule: resolve conflicts locally, run targeted tests + typecheck, then push with `--force-with-lease` only when rewriting your own PR branch.
