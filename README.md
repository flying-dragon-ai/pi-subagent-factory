# pi-subagent-factory

**Scan any codebase → auto-generate a tailored subagent team for [pi](https://pi.dev), with ready-to-use `subagent_spawn` args.**
**全自动扫描项目技术栈，自动创建并出具合适的 subagent 团队。**

> TL;DR — one tool call scans up to 6,000 files (languages, frameworks, databases, testing, build tooling, monorepo, Docker, CI), then deterministically generates 4–10 specialized subagents with per-agent tool allowlists and thinking levels. The scan is a rules engine: **0 model tokens**. Smoke-tested end to end on a React + Prisma + Vitest project: 8 agents generated in under 5 seconds.

[![pi package](https://img.shields.io/badge/pi.dev-packages-blue)](https://pi.dev/packages)
[![npm](https://img.shields.io/npm/v/%40konbakuyomu%2Fpi-subagent-factory)](https://www.npmjs.com/package/@konbakuyomu/pi-subagent-factory)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## Install

```bash
pi install npm:@konbakuyomu/pi-subagent-factory
```

Try once without installing:

```bash
pi -e npm:@konbakuyomu/pi-subagent-factory
```

## How it works

1. **Scan** — walks the repo (skips `node_modules`, `.git`, build output; caps at 6,000 entries), reads `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pom.xml`, and produces a `ProjectProfile`: language mix, frameworks, databases, test runners, package manager, test/build commands, monorepo / Docker / CI flags, entry points, key directories, LOC.
2. **Generate** — a deterministic roster builder turns the profile into a team. Every agent carries `spawnArgs` that map 1:1 to [`@narumitw/pi-subagents`](https://www.npmjs.com/package/@narumitw/pi-subagents) `subagent_spawn` parameters (`task` / `tools` / `thinkingLevel` / `timeout`).
3. **Dispatch** — the model spawns agents in parallel or sequence (`subagent_wait`, `subagent_send`, `subagent_inspect`, `subagent_cancel` manage the lifecycle). The roster persists at `.pi/team/subagents.json`.

### The base team (every project)

| Agent | thinking | Tools | Mission |
|---|---|---|---|
| `architect` | high | read, grep, find, ls, codemode | structure analysis, implementation plan, acceptance criteria — read-only |
| `implementer` | medium | read, bash, edit, write, grep, find, ls | executes the plan, behavior-preserving, step summaries |
| `reviewer` | high | read, grep, find, bash | reviews diffs: behavior drift, edge cases, over-design, security debt |
| `tester` | medium | bash, read, edit, write, find, grep | runs the project's detected test command, guards regression |

### Stack specialists (added only when detected)

| Detection | Added agent |
|---|---|
| React / Vue / Svelte / Angular / Next.js | `frontend` — components, state, render performance |
| `api/` `server/` `services/` dirs, Express / NestJS / Fastify / FastAPI / Spring… | `api` — routes, auth, error handling, contracts |
| Prisma / Drizzle / TypeORM / SQLAlchemy / pg / Redis… | `data` — schema, migrations (reversible), query slimming |
| Dockerfile / `.github/workflows` | `devops` — build pipeline, deploy scripts |
| `docs/` dir or >200 files | `docs` — README/architecture/change log sync (中文) |
| pnpm-workspace / turbo / nx / lerna | `monorepo-coordinator` — dependency direction, build order |

Each task template embeds the project's measured context — stack, key directories, entry points, test command, build command, scale — so spawned agents start warm, not cold.

## Usage

**Model side (recommended):**

> 扫描这个项目，生成 subagent 团队，把 architect 和 tester 派出去

The model calls the `subagent_factory` tool:

| action | behavior |
|---|---|
| `scan` | scan only, return the `ProjectProfile` |
| `generate` | scan + generate team, write `.pi/team/subagents.json` + `.pi/team/SUBAGENTS.md` |
| `load` | read the previously generated team |

**Command side (no model tokens at all):**

```
/team          # scan + generate (same as /team gen)
/team scan     # show the tech-stack profile only
/team show     # check whether a team already exists
```

## How it compares

| | pi-subagent-factory | [ciscoittech/claude-agent-framework](https://github.com/ciscoittech/claude-agent-framework) | [keysersoose/claude-agent-builder](https://github.com/keysersoose/claude-agent-builder) |
|---|---|---|---|
| Runtime | **pi** (any model) | Claude Code | Claude Code |
| Scan | deterministic rules engine, 0 tokens | LLM prompt-driven | interview + LLM research |
| Output | `subagent_spawn`-ready args (JSON) | `.claude/agents/*.md` + registry + validator | full agent/skill/hook/command file set |
| Speed | seconds | minutes (model turn) | minutes (conversation) |
| Determinism | same repo → same team | model-dependent | model-dependent |

The trade-off is deliberate: no LLM in the loop means the roster is reproducible and free, and every generated `task` is plain text you can edit before dispatch.

## FAQ

**Does it call an LLM during scan/generate?**
No. Scanning and roster generation are a pure rules engine — the only model calls happen later, when spawned subagents do their jobs.

**Which agents get write access?**
Only `implementer`, `tester`, `frontend`, `api`, `data`, `devops`, and `docs`. `architect`, `reviewer`, and `monorepo-coordinator` are read-only by construction (their tool allowlists exclude `edit`/`write`).

**Does it work without `@narumitw/pi-subagents`?**
The `spawnArgs` are plain JSON. Without pi-subagents you can still read the roster and run agents through any mechanism that accepts task text + tool lists.

**Where is the generated team stored?**
`<project>/.pi/team/subagents.json` (structured) and `.pi/team/SUBAGENTS.md` (human-readable table + per-agent dispatch JSON). Re-running `generate` overwrites them.

**What languages/frameworks does detection cover?**
TypeScript/JavaScript (React, Next.js, Vue, Svelte, Angular, Express, NestJS, Fastify, Koa, Hono), Python (FastAPI, Django, Flask, SQLAlchemy), Go (Gin), Rust (Axum, Actix), Java (Spring, Maven), plus Vite/Webpack/esbuild/Rollup/Turborepo, Vitest/Jest/Mocha/Playwright/Cypress/pytest, and monorepo/Docker/CI flags.

## Related

- [pi.dev packages gallery](https://pi.dev/packages) — this package's listing
- [pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [@narumitw/pi-subagents](https://www.npmjs.com/package/@narumitw/pi-subagents) — the dispatcher this factory generates for

## License

MIT
