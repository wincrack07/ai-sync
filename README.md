# ai-sync

Keeps Claude Code chats and Codex chats in sync in both directions, on a schedule and on every turn.

- A Claude session gets a mirrored Codex thread, so you can open it with `codex resume`.
- A Codex thread gets a mirrored Claude session titled `[Codex] …`, so you can open it with `claude --resume`.
- Carry on in either copy. New turns are appended to the other copy.

It only uses Node's standard library. The ledger lives in SQLite through the built-in `node:sqlite` module.

## Requirements

- Node 22.13 or newer. Check with `node --version`.
- macOS or Linux.

## Install

```sh
cd ai-sync
npm install
npm run build
npm link                       # puts `ai-sync` on your PATH
ai-sync doctor                 # checks it can read every transcript and rollout
ai-sync sync --dry-run         # shows what the first pass would create; writes nothing
```

Read the dry-run output before going further. By default only conversations touched in the last 7 days are mirrored. To bring in older ones:

```sh
ai-sync sync --dry-run --days 30
ai-sync sync --days 30
```

When the preview looks right:

```sh
ai-sync setup --load   # writes the config, adds hooks, and starts the login agent
ai-sync status
```

`setup` makes these changes, and backs up any file it edits first:

| What | Where |
|---|---|
| Config | `~/.ai-sync/config.json` |
| Hook shim | `~/.ai-sync/bin/ai-sync-hook.sh` |
| Claude `Stop` and `SessionEnd` hooks | `~/.claude/settings.json`, merged into existing hooks |
| Codex `notify` | `~/.codex/config.toml`, added only when no `notify` is set yet |
| Login agent | `~/Library/LaunchAgents/tech.xyzsolutions.ai-sync.plist` on macOS, or a systemd user unit on Linux |

## How syncing is triggered

Every trigger feeds one debounced sync pass, and passes never overlap.

1. **Hooks.** Claude Code runs the shim when a turn finishes. Codex runs it through `notify`. The shim drops a file in `~/.ai-sync/spool/` and exits at once.
2. **File watching.** Changes under `~/.claude/projects` and `~/.codex/sessions` are watched.
3. **Periodic pass.** A full reconcile runs every `intervalSec`, 60 seconds by default. This catches anything the first two missed.
4. **Manual.** `ai-sync sync` asks the running daemon to sync now.

## Commands

```
ai-sync status | links | doctor
ai-sync sync [--dry-run] [--force] [--full] [--days N]
ai-sync pause | resume | reload | stop
ai-sync unlink <id> [--ignore]
ai-sync install-hooks | uninstall-hooks | install-agent [--load] | uninstall-agent
```

## Safety

- **Append only.** ai-sync never rewrites or deletes lines in a transcript or rollout. It only adds new ones.
- **Quiet window.** It will not write into a file another program changed in the last `quiescenceSec` seconds (20 by default). That avoids writing into a chat that is mid-turn. Its own earlier writes don't count as activity.
- **Crash-safe ledger.** Every copied message is logged as pending in `~/.ai-sync/ledger.sqlite` before it is written. After a crash, pending rows are checked against the target file, then confirmed or dropped. Nothing is written twice.
- **No echo.** Each copied message is tracked by id in both directions. As a backup check, a message that already exists at the destination with the same role, text and second is never copied again.
- **Existing pairs are adopted.** If a conversation already exists on both sides, it is paired rather than copied again. That covers a Codex native import, or a lost ledger. Only messages after the last shared one are synced.
- **Resumes and forks.** A new file that carries messages the ledger already knows is treated as a continuation, so the pairing moves to the newer file.
- **Deleted mirrors.** A deleted mirror marks its pairing as broken instead of silently re-creating it. Run `ai-sync unlink <id>` to re-mirror it, or add `--ignore` to leave it alone.

## Config

The config lives at `~/.ai-sync/config.json`. Apply changes with `ai-sync reload`.

| Key | Default | Meaning |
|---|---|---|
| `intervalSec` | 60 | Seconds between periodic passes |
| `quiescenceSec` | 20 | Skip writing into files changed this recently by something else |
| `backfillDays` | 7 | Only auto-mirror conversations touched this recently. 0 means all |
| `includeTools` | `"summary"` | Copy tool calls as one-line summaries. `"none"` copies text only |
| `claudeToCodex`, `codexToClaude` | true | Turn off either direction |
| `projects`, `excludeProjects` | [] | Working-directory prefixes to include or exclude |
| `codex.writeEventMsgs` | true | Also write the event lines the Codex resume screen uses to show history |
| `codex.postCreateCommand` | null | Shell command run after a Codex mirror is created. `{path}` and `{id}` are filled in |

## Assumptions to check on the Mac

This was built and tested against synthetic files in the formats the discovery phase found. It has not yet run against your real `~/.claude` and `~/.codex`. Check these on the first real run:

1. **Codex lists the mirrors.** Run `codex resume` and look for a mirrored thread. Newer Codex builds may keep their own thread registry. If mirrors are missing there, set `codex.postCreateCommand` to whatever registers a rollout. Another option is to rely on the Claude-to-Codex import that Codex already has.
2. **Claude accepts the mirrors.** Run `claude --resume`, open a `[Codex] …` session and send a message. Records written by ai-sync carry an extra `aiSync` field and a `codex-via-ai-sync` model label.
3. **The desktop app shows them.** The Claude desktop app keeps its own index under `~/Library/Application Support/Claude/`. ai-sync does not write to that index. Mirrored sessions may show up in the CLI before the desktop app lists them.
4. **Tool calls are summaries only.** Tool calls travel as one-line text summaries, not as real tool calls, so the other tool sees what was done but cannot replay it.

## Development

```sh
npm test    # builds, then runs the node:test suite
```

| Path | Role |
|---|---|
| `src/claude/transcript.ts` | Claude parser and writer |
| `src/codex/rollout.ts` | Codex parser and writer |
| `src/engine.ts` | Discovery, adoption, reconcile, recovery |
| `src/ledger.ts` | SQLite schema and queries |
| `src/daemon.ts` | Triggers, file watching, control socket |
| `src/install.ts` | Hooks and login agent |
| `src/cli.ts` | Command-line entry point |
