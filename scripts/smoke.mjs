/* Smoke harness: load the extension via jiti with alias mapping to pi-web's
 * host packages, register into a mock pi, run generate on a scratch project. */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@agegr/pi-web/node_modules";
const require = createRequire(import.meta.url);

function entryOf(name) {
	const pkgPath = join(WEB, name, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	let entry = pkg.main ?? "index.js";
	if (pkg.exports && pkg.exports["."]) {
		const e = pkg.exports["."];
		entry = (typeof e === "string" ? e : e.default ?? e.import ?? e.require) ?? entry;
	}
	return join(WEB, name, entry);
}

const targets = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
const alias = {};
for (const t of targets) {
	const e = entryOf(t);
	if (existsSync(e)) alias[t] = e;
	else console.log(`[warn] entry missing for ${t}: ${e}`);
}

const { createJiti } = await import("file://" + join(WEB, "jiti/lib/jiti.mjs"));
const jiti = createJiti(join(WEB, "@earendil-works/pi-coding-agent/package.json"), { alias, fsCache: false, moduleCache: false });

const mod = await jiti.import("file:///D:/codingProjects/GITHUB/pi-subagent-factory/extensions/subagent-factory.ts");
console.log("factory type:", typeof mod.default);

const registered = { tools: [], commands: [] };
const mockPi = {
	registerTool: (t) => registered.tools.push(t),
	registerCommand: (n, c) => registered.commands.push({ name: n, ...c }),
	on: () => {},
	registerCommandRenderer: () => {},
};
mod.default(mockPi);

console.log("tools:", registered.tools.map((t) => t.name).join(","));
console.log("commands:", registered.commands.map((c) => c.name).join(","));

const tool = registered.tools[0];
const cwd = "C:/Users/Administrator/AppData/Local/Temp/sf-test";
const ctx = { cwd, ui: { notify: (m) => console.log("[notify]", String(m).slice(0, 120)) } };

const r1 = await tool.execute("t1", { action: "scan" }, undefined, undefined, ctx);
console.log("--- SCAN ---");
console.log(r1.content[0].text);

const r2 = await tool.execute("t2", { action: "generate" }, undefined, undefined, ctx);
console.log("--- GENERATE ---");
console.log(r2.content[0].text);

const r3 = await tool.execute("t3", { action: "load" }, undefined, undefined, ctx);
console.log("--- LOAD OK, agents:", r3.details.roster.agents.length);

const saved = JSON.parse(readFileSync(join(cwd, ".pi/team/subagents.json"), "utf8"));
console.log("saved agents:", saved.agents.map((a) => `${a.name}[${a.spawnArgs.thinkingLevel}:${a.spawnArgs.tools.join("+")}]`).join(" "));
console.log("task sample:", saved.agents[0].spawnArgs.task.slice(0, 160));
console.log("SMOKE PASS");
