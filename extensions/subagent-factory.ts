/**
 * pi-subagent-factory — 全自动扫描项目，按技术栈生成专属 subagent 团队
 *
 * - 工具 `subagent_factory`：action = scan | generate | load
 *   - scan:    只扫描，返回 ProjectProfile
 *   - generate: 扫描 + 生成团队，写入 <cwd>/.pi/team/subagents.json（+ SUBAGENTS.md）
 *   - load:    读取已生成的团队
 * - 命令 `/team [scan|gen|show]`：不经过模型直接执行
 *
 * 生成的每个 agent 携带 spawnArgs，字段与 @narumitw/pi-subagents 的
 * subagent_spawn（task / tools / thinkingLevel / timeout）一一对应，
 * 模型拿到后可直接逐个 spawn。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";

// ---------- 类型 ----------

interface Profile {
	projectName: string;
	languages: { lang: string; files: number }[];
	frameworks: string[];
	buildTools: string[];
	databases: string[];
	testing: string[];
	packageManager: string;
	testCommand?: string;
	buildCommand?: string;
	monorepo: boolean;
	docker: boolean;
	ci: boolean;
	hasApiLayer: boolean;
	hasDocsDir: boolean;
	entryPoints: string[];
	keyDirs: string[];
	fileCount: number;
	loc: number;
	scannedAt: string;
}

interface SpawnArgs {
	task: string;
	tools: string[];
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeout: number;
}

interface TeamAgent {
	name: string;
	role: string;
	description: string;
	spawnArgs: SpawnArgs;
}

interface Roster {
	project: string;
	generatedAt: string;
	profile: Profile;
	agents: TeamAgent[];
}

// ---------- 扫描 ----------

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
	".output", ".cache", "vendor", "target", "bin", "obj", ".venv", "venv",
	"__pycache__", ".turbo", ".idea", ".vscode", ".gradle", ".mvn", "screenshots",
	".pytest_cache", ".mypy_cache", "site-packages", ".pnpm-store",
]);

const LANG_BY_EXT: Record<string, string> = {
	".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
	".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
	".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
	".cs": "C#", ".php": "PHP", ".rb": "Ruby", ".vue": "Vue", ".svelte": "Svelte",
	".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++",
};

const MAX_ENTRIES = 6000;
const MAX_LOC_FILES = 2500;
const MAX_FILE_BYTES = 512 * 1024;

interface WalkResult {
	files: { rel: string; ext: string }[];
	loc: number;
	keyDirs: string[];
	truncated: boolean;
}

async function walk(root: string): Promise<WalkResult> {
	const files: { rel: string; ext: string }[] = [];
	const dirSet = new Set<string>();
	let loc = 0;
	let locFiles = 0;
	let truncated = false;

	async function visit(dir: string, depth: number): Promise<void> {
		if (depth > 5 || files.length >= MAX_ENTRIES) {
			if (files.length >= MAX_ENTRIES) truncated = true;
			return;
		}
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_ENTRIES) {
				truncated = true;
				return;
			}
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") && entry.name !== ".github") continue;
				if (depth <= 3) dirSet.add(relative(root, abs).replace(/\\/g, "/"));
				await visit(abs, depth + 1);
			} else if (entry.isFile()) {
				const ext = extname(entry.name).toLowerCase();
				const rel = relative(root, abs).replace(/\\/g, "/");
				files.push({ rel, ext });
				if (LANG_BY_EXT[ext] && locFiles < MAX_LOC_FILES) {
					try {
						const st = await stat(abs);
						if (st.size <= MAX_FILE_BYTES) {
							const buf = await readFile(abs, "utf8");
							loc += buf.split("\n").length;
							locFiles++;
						}
					} catch { /* unreadable, skip */ }
				}
			}
		}
	}

	await visit(root, 0);
	const keyDirs = [...dirSet].filter((d) => d && d.split("/").length <= 2).slice(0, 40);
	return { files, loc, keyDirs, truncated };
}

function readJsonSafe(path: string): Promise<Record<string, unknown> | undefined> {
	return readFile(path, "utf8")
		.then((t) => JSON.parse(t) as Record<string, unknown>)
		.catch(() => undefined);
}

function textSafe(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch(() => undefined);
}

async function scanProfile(root: string): Promise<Profile> {
	const pkg = await readJsonSafe(join(root, "package.json"));
	const deps: Record<string, string> = {
		...((pkg?.dependencies as Record<string, string>) ?? {}),
		...((pkg?.devDependencies as Record<string, string>) ?? {}),
	};
	const scripts = (pkg?.scripts as Record<string, string>) ?? {};
	const has = (...names: string[]) => names.some((n) => n in deps);

	const pyproject = await textSafe(join(root, "pyproject.toml"));
	const requirements = await textSafe(join(root, "requirements.txt"));
	const goMod = await textSafe(join(root, "go.mod"));
	const cargoToml = await textSafe(join(root, "Cargo.toml"));
	const pomXml = await textSafe(join(root, "pom.xml"));
	const pyText = `${pyproject ?? ""}\n${requirements ?? ""}`;

	const walkResult = await walk(root);
	const langCount = new Map<string, number>();
	for (const f of walkResult.files) {
		const lang = LANG_BY_EXT[f.ext];
		if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
	}
	const languages = [...langCount.entries()]
		.map(([lang, files]) => ({ lang, files }))
		.sort((a, b) => b.files - a.files);

	const frameworks: string[] = [];
	if (has("react", "react-dom")) frameworks.push("React");
	if (has("next")) frameworks.push("Next.js");
	if (has("vue") || languages.some((l) => l.lang === "Vue")) frameworks.push("Vue");
	if (has("svelte") || languages.some((l) => l.lang === "Svelte")) frameworks.push("Svelte");
	if (has("@angular/core")) frameworks.push("Angular");
	if (has("react-native")) frameworks.push("React Native");
	if (has("express")) frameworks.push("Express");
	if (has("@nestjs/core")) frameworks.push("NestJS");
	if (has("fastify")) frameworks.push("Fastify");
	if (has("koa")) frameworks.push("Koa");
	if (has("hono")) frameworks.push("Hono");
	if (/fastapi|uvicorn/.test(pyText)) frameworks.push("FastAPI");
	if (/django/.test(pyText)) frameworks.push("Django");
	if (/flask/.test(pyText)) frameworks.push("Flask");
	if (/<spring|springframework/.test(pomXml ?? "")) frameworks.push("Spring");
	if (/axum/.test(cargoToml ?? "")) frameworks.push("Axum");
	if (/actix/.test(cargoToml ?? "")) frameworks.push("Actix");
	if (/gin-gonic/.test(goMod ?? "")) frameworks.push("Gin");

	const buildTools: string[] = [];
	if (has("vite")) buildTools.push("Vite");
	if (has("webpack")) buildTools.push("Webpack");
	if (has("esbuild")) buildTools.push("esbuild");
	if (has("rollup")) buildTools.push("Rollup");
	if (has("turbo")) buildTools.push("Turborepo");
	if (has("typescript")) buildTools.push("TypeScript");
	if (has("tailwindcss")) buildTools.push("Tailwind CSS");
	if (pyproject || requirements) buildTools.push("Python");
	if (goMod) buildTools.push("Go modules");
	if (cargoToml) buildTools.push("Cargo");
	if (pomXml) buildTools.push("Maven");

	const databases: string[] = [];
	if (has("prisma", "@prisma/client")) databases.push("Prisma");
	if (has("drizzle-orm")) databases.push("Drizzle");
	if (has("typeorm")) databases.push("TypeORM");
	if (has("sequelize")) databases.push("Sequelize");
	if (has("mongoose")) databases.push("MongoDB/Mongoose");
	if (has("knex")) databases.push("Knex");
	if (has("pg", "@vercel/postgres", "postgres")) databases.push("PostgreSQL");
	if (has("mysql2", "mysql")) databases.push("MySQL");
	if (has("better-sqlite3", "sqlite3")) databases.push("SQLite");
	if (has("redis", "ioredis")) databases.push("Redis");
	if (/sqlalchemy|alembic/.test(pyText)) databases.push("SQLAlchemy");

	const testing: string[] = [];
	if (has("vitest")) testing.push("Vitest");
	if (has("jest")) testing.push("Jest");
	if (has("mocha")) testing.push("Mocha");
	if (has("@playwright/test")) testing.push("Playwright");
	if (has("cypress")) testing.push("Cypress");
	if (scripts.test) testing.push("npm test");
	if (/pytest/.test(pyText)) testing.push("pytest");
	if (goMod) testing.push("go test");
	if (cargoToml) testing.push("cargo test");

	const packageManager = walkResult.files.some((f) => f.rel === "pnpm-lock.yaml")
		? "pnpm"
		: walkResult.files.some((f) => f.rel === "yarn.lock")
			? "yarn"
			: walkResult.files.some((f) => f.rel === "bun.lockb" || f.rel === "bun.lock")
				? "bun"
				: walkResult.files.some((f) => f.rel === "package-lock.json")
					? "npm"
					: "unknown";

	const monorepo = walkResult.files.some((f) =>
		["pnpm-workspace.yaml", "lerna.json", "turbo.json", "nx.json", "go.work"].includes(f.rel),
	);
	const docker = walkResult.files.some((f) =>
		f.rel === "Dockerfile" || f.rel.endsWith("/Dockerfile") || f.rel.endsWith("docker-compose.yml") || f.rel.endsWith("compose.yaml"),
	);
	const ci = walkResult.files.some((f) => f.rel.startsWith(".github/workflows/"));
	const hasApiLayer = walkResult.files.some((f) => /^(api|server|services)\//.test(f.rel));
	const hasDocsDir = walkResult.files.some((f) => /^docs\//.test(f.rel) || f.rel === "tododocs");

	const entryPoints = walkResult.files
		.filter((f) => /^(index|main|app|server)\.(ts|tsx|js|mjs|py|go)$/.test(f.rel.split("/").pop() ?? "") && !f.rel.includes("/"))
		.map((f) => f.rel)
		.slice(0, 8);

	const testCommand = scripts.test
		? `${packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : "npm"} test`
		: testing.includes("pytest")
			? "pytest"
			: testing.includes("go test")
				? "go test ./..."
				: testing.includes("cargo test")
					? "cargo test"
					: undefined;
	const buildCommand = scripts.build
		? `${packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : "npm"} run build`
		: cargoToml
			? "cargo build"
			: goMod
				? "go build ./..."
				: undefined;

	return {
		projectName: (pkg?.name as string) ?? root.split(/[\\/]/).pop() ?? "project",
		languages,
		frameworks,
		buildTools,
		databases,
		testing,
		packageManager,
		testCommand,
		buildCommand,
		monorepo,
		docker,
		ci,
		hasApiLayer,
		hasDocsDir,
		entryPoints,
		keyDirs: walkResult.keyDirs,
		fileCount: walkResult.files.length,
		loc: walkResult.loc,
		scannedAt: new Date().toISOString(),
	};
}

// ---------- 团队生成 ----------

function stackLine(p: Profile): string {
	const parts: string[] = [];
	if (p.languages.length) parts.push(`语言: ${p.languages.map((l) => `${l.lang}(${l.files})`).join("、")}`);
	if (p.frameworks.length) parts.push(`框架: ${p.frameworks.join("、")}`);
	if (p.databases.length) parts.push(`数据库: ${p.databases.join("、")}`);
	if (p.testing.length) parts.push(`测试: ${p.testing.join("、")}`);
	if (p.buildTools.length) parts.push(`构建: ${p.buildTools.join("、")}`);
	parts.push(`包管理: ${p.packageManager}`);
	if (p.testCommand) parts.push(`测试命令: \`${p.testCommand}\``);
	if (p.buildCommand) parts.push(`构建命令: \`${p.buildCommand}\``);
	if (p.monorepo) parts.push("monorepo");
	if (p.docker) parts.push("Docker");
	if (p.ci) parts.push("CI");
	parts.push(`规模: ~${p.loc} 行 / ${p.fileCount} 文件`);
	return parts.join("；");
}

function baseRules(p: Profile): string {
	return [
		`项目「${p.projectName}」技术栈：${stackLine(p)}。`,
		p.keyDirs.length ? `关键目录：${p.keyDirs.slice(0, 16).join("、")}。` : "",
		p.entryPoints.length ? `入口：${p.entryPoints.join("、")}。` : "",
		`规则：只做分内事；不改与本任务无关的代码；完成后给出改动摘要。`,
	].filter(Boolean).join("\n");
}

function buildRoster(p: Profile): TeamAgent[] {
	const ctxLine = baseRules(p);
	const agents: TeamAgent[] = [];

	agents.push({
		name: "architect",
		role: "架构师",
		description: "通读项目结构与核心流程，产出改造/精简/实施方案，不改代码",
		spawnArgs: {
			task: `${ctxLine}\n\n任务：通读该项目，输出一份结构分析 + 实施方案（目标、改动面、风险、验收标准）。只读不改。`,
			tools: ["read", "grep", "find", "ls", "codemode"],
			thinkingLevel: "high",
			timeout: 1800,
		},
	});

	agents.push({
		name: "implementer",
		role: "实现者",
		description: "按方案执行具体编码改造，小步提交",
		spawnArgs: {
			task: `${ctxLine}\n\n任务：按给你的方案执行编码改造。先读后改，保持行为不变，每完成一步输出改动摘要。`,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			thinkingLevel: "medium",
			timeout: 3600,
		},
	});

	agents.push({
		name: "reviewer",
		role: "评审",
		description: "审查改动：行为不变性、边界条件、过度设计、安全债",
		spawnArgs: {
			task: `${ctxLine}\n\n任务：审查指定改动（git diff 或指定文件），指出行为变化、边界漏洞、残余复杂度和安全债，按严重度排序，不改代码。`,
			tools: ["read", "grep", "find", "bash"],
			thinkingLevel: "high",
			timeout: 1800,
		},
	});

	agents.push({
		name: "tester",
		role: "测试",
		description: `运行与补全测试${p.testCommand ? `（${p.testCommand}）` : ""}，守护行为回归`,
		spawnArgs: {
			task: `${ctxLine}\n\n任务：${p.testCommand ? `运行 \`${p.testCommand}\`` : "为项目补齐可运行的测试"}，报告失败项与定位；可为改动补测试。`,
			tools: ["bash", "read", "edit", "write", "find", "grep"],
			thinkingLevel: "medium",
			timeout: 3600,
		},
	});

	if (p.frameworks.some((f) => ["React", "Vue", "Svelte", "Angular", "Next.js"].includes(f))) {
		agents.push({
			name: "frontend",
			role: "前端专项",
			description: `前端专项（${p.frameworks.filter((f) => ["React", "Vue", "Svelte", "Angular", "Next.js"].includes(f)).join("/")}）：组件、状态、渲染性能`,
			spawnArgs: {
				task: `${ctxLine}\n\n任务：处理前端专项工作（组件精简、状态梳理、渲染性能、样式收敛），保持交互行为不变。`,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				thinkingLevel: "medium",
				timeout: 3600,
			},
		});
	}

	if (p.hasApiLayer || p.frameworks.some((f) => ["Express", "NestJS", "Fastify", "FastAPI", "Spring", "Koa", "Hono"].includes(f))) {
		agents.push({
			name: "api",
			role: "接口专项",
			description: "服务端接口专项：路由、鉴权、错误处理、契约一致性",
			spawnArgs: {
				task: `${ctxLine}\n\n任务：处理服务端/接口专项工作（路由精简、错误处理统一、契约校验），保持对外行为不变。`,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				thinkingLevel: "medium",
				timeout: 3600,
			},
		});
	}

	if (p.databases.length) {
		agents.push({
			name: "data",
			role: "数据专项",
			description: `数据/迁移专项（${p.databases.join("/")}）`,
			spawnArgs: {
				task: `${ctxLine}\n\n任务：处理数据层专项（schema 梳理、迁移脚本、查询精简），迁移必须可回滚。`,
				tools: ["read", "bash", "edit", "write", "grep", "find"],
				thinkingLevel: "medium",
				timeout: 3600,
			},
		});
	}

	if (p.docker || p.ci) {
		agents.push({
			name: "devops",
			role: "构建部署",
			description: "构建/部署/CI 专项",
			spawnArgs: {
				task: `${ctxLine}\n\n任务：处理构建与部署专项（Dockerfile/CI 流水线/脚本精简），保证 ${p.buildCommand ?? "构建"} 可通过。`,
				tools: ["read", "bash", "edit", "write", "find", "grep"],
				thinkingLevel: "low",
				timeout: 1800,
			},
		});
	}

	if (p.hasDocsDir || p.fileCount > 200) {
		agents.push({
			name: "docs",
			role: "文档",
			description: "文档同步专项：README/架构文档/变更记录",
			spawnArgs: {
				task: `${ctxLine}\n\n任务：根据改动同步文档（README、架构说明、变更记录），中文书写，不编造未实现的功能。`,
				tools: ["read", "write", "edit", "grep", "find", "ls"],
				thinkingLevel: "low",
				timeout: 1800,
			},
		});
	}

	if (p.monorepo) {
		agents.push({
			name: "monorepo-coordinator",
			role: "monorepo 协调",
			description: "跨包协调：依赖方向、workspace 脚本、发布顺序",
			spawnArgs: {
				task: `${ctxLine}\n\n任务：梳理 workspace 依赖方向与构建顺序，输出跨包改动计划与执行顺序。`,
				tools: ["read", "bash", "grep", "find", "ls"],
				thinkingLevel: "high",
				timeout: 1800,
			},
		});
	}

	return agents;
}

function rosterMarkdown(r: Roster): string {
	const lines: string[] = [
		`# Subagent 团队 — ${r.project}`,
		``,
		`> 生成时间：${r.generatedAt}　来源：pi-subagent-factory`,
		``,
		`技术栈：${stackLine(r.profile)}`,
		``,
		`| Agent | 角色 | 职责 | thinking | 工具 |`,
		`|---|---|---|---|---|`,
	];
	for (const a of r.agents) {
		lines.push(`| ${a.name} | ${a.role} | ${a.description} | ${a.spawnArgs.thinkingLevel} | ${a.spawnArgs.tools.join(",")} |`);
	}
	lines.push(``, `## 派发`, ``);
	for (const a of r.agents) {
		lines.push(`### ${a.name}`, ``, "```json", JSON.stringify(a.spawnArgs, null, 2), "```", ``);
	}
	return lines.join("\n");
}

// ---------- 工具 / 命令 ----------

const TeamParams = Type.Object({
	action: StringEnum(["scan", "generate", "load"] as const, {
		description: "scan=只扫描；generate=扫描+生成团队并写入 .pi/team/；load=读取已生成团队",
	}),
	path: Type.Optional(Type.String({ description: "目标项目根目录，默认当前会话 cwd" })),
});

async function teamDir(ctx: ExtensionContext, customPath?: string): Promise<string> {
	return join(customPath ?? ctx.cwd, ".pi", "team");
}

function summarizeRoster(r: Roster): string {
	const lines = [
		`项目「${r.project}」subagent 团队（${r.agents.length} 个）：`,
		`栈：${stackLine(r.profile)}`,
		``,
	];
	for (const a of r.agents) {
		lines.push(`- ${a.name}（${a.role}）— ${a.description}｜thinking=${a.spawnArgs.thinkingLevel}｜tools=${a.spawnArgs.tools.join(",")}`);
	}
	lines.push(
		``,
		`已写入 .pi/team/subagents.json 与 .pi/team/SUBAGENTS.md。`,
		`派发方式：对每个 agent 调用 subagent_spawn，参数直接用其 spawnArgs（task/tools/thinkingLevel/timeout）；`,
		`随后用 subagent_wait 等待完成，用 subagent_send 追加指令。`,
	);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_factory",
		label: "Subagent Factory",
		description:
			"全自动扫描当前项目（语言/框架/数据库/测试/构建/monorepo/CI），按技术栈生成专属 subagent 团队。" +
			"action=generate 生成并写入 .pi/team/subagents.json，返回每个 agent 的 subagent_spawn 参数；" +
			"action=scan 只扫描；action=load 读取已生成团队。生成后应立即用 subagent_spawn 逐个派发。",
		parameters: TeamParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = params.path ?? ctx.cwd;

			if (params.action === "scan") {
				const profile = await scanProfile(root);
				return {
					content: [{ type: "text", text: `扫描完成：${profile.projectName}\n${stackLine(profile)}\n关键目录：${profile.keyDirs.slice(0, 12).join("、")}` }],
					details: { action: "scan", profile },
				};
			}

			if (params.action === "generate") {
				const profile = await scanProfile(root);
				const roster: Roster = {
					project: profile.projectName,
					generatedAt: new Date().toISOString(),
					profile,
					agents: buildRoster(profile),
				};
				const dir = await teamDir(ctx, params.path);
				const jsonPath = join(dir, "subagents.json");
				const mdPath = join(dir, "SUBAGENTS.md");
				await mkdir(dir, { recursive: true });
				await withFileMutationQueue(jsonPath, async () => {
					await writeFile(jsonPath, JSON.stringify(roster, null, 2), "utf8");
				});
				await withFileMutationQueue(mdPath, async () => {
					await writeFile(mdPath, rosterMarkdown(roster), "utf8");
				});
				return {
					content: [{ type: "text", text: summarizeRoster(roster) }],
					details: { action: "generate", roster, writtenTo: [jsonPath, mdPath] },
				};
			}

			// load
			const jsonPath = join(await teamDir(ctx, params.path), "subagents.json");
			const raw = await readFile(jsonPath, "utf8").catch(() => undefined);
			if (!raw) {
				throw new Error(`未找到 ${jsonPath}，先执行 action=generate`);
			}
			const roster = JSON.parse(raw) as Roster;
			return {
				content: [{ type: "text", text: summarizeRoster(roster) }],
				details: { action: "load", roster, writtenTo: [jsonPath] },
			};
		},

		renderCall(args, theme) {
			const action = (args as { action?: string }).action ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("subagent_factory ")) + theme.fg("muted", action), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { roster?: Roster; profile?: Profile } | undefined;
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			if (!expanded && details?.roster) {
				return new Text(theme.fg("muted", `团队 ${details.roster.agents.length} 个 agent 已就绪 (.pi/team/subagents.json)`), 0, 0);
			}
			if (!expanded && details?.profile) {
				return new Text(theme.fg("muted", `扫描完成：${details.profile.projectName}`), 0, 0);
			}
			return new Text(raw, 0, 0);
		},
	});

	pi.registerCommand("team", {
		description: "扫描项目并生成专属 subagent 团队（/team [scan|gen|show]，默认 gen）",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const action = sub === "scan" || sub === "show" ? sub : "generate";
			const root = ctx.cwd;

			if (action === "scan") {
				const profile = await scanProfile(root);
				ctx.ui.notify(`扫描完成：${profile.projectName}\n${stackLine(profile)}`, "info");
				return;
			}

			if (action === "show") {
				const raw = await readFile(join(await teamDir(ctx), "subagents.json"), "utf8").catch(() => undefined);
				ctx.ui.notify(raw ? `已存在团队：${join(".pi", "team", "subagents.json")}` : "尚未生成团队，先运行 /team 或让模型调用 subagent_factory(action=generate)", raw ? "info" : "warning");
				return;
			}

			const profile = await scanProfile(root);
			const roster: Roster = {
				project: profile.projectName,
				generatedAt: new Date().toISOString(),
				profile,
				agents: buildRoster(profile),
			};
			const dir = await teamDir(ctx);
			const jsonPath = join(dir, "subagents.json");
			const mdPath = join(dir, "SUBAGENTS.md");
			await mkdir(dir, { recursive: true });
			await withFileMutationQueue(jsonPath, async () => {
				await writeFile(jsonPath, JSON.stringify(roster, null, 2), "utf8");
			});
			await withFileMutationQueue(mdPath, async () => {
				await writeFile(mdPath, rosterMarkdown(roster), "utf8");
			});
			ctx.ui.notify(
				`subagent 团队已生成（${roster.agents.length} 个）：\n${roster.agents.map((a) => `${a.name}(${a.role})`).join("、")}\n写入 ${join(".pi", "team", "subagents.json")}\n下一步：让模型调用 subagent_factory(action=load) 后用 subagent_spawn 派发`,
				"info",
			);
		},
	});
}
