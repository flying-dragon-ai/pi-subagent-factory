---
name: subagent-factory
description: 全自动扫描项目并生成专属 subagent 团队。当用户要求"扫描项目生成 subagent"、"给我这个项目配一个 agent 团队"、"根据项目自动创建 subagent"、"分析项目后并行派活"时使用。工具：subagent_factory（action=scan|generate|load）；命令：/team。生成后用 subagent_spawn 按 spawnArgs 派发。
---

# Subagent Factory

扫描当前项目 → 识别技术栈 → 生成与项目匹配的 subagent 团队 → 输出可直接派发的 `subagent_spawn` 参数。

## 何时使用

- 用户说：扫描项目、生成 agent 团队、按项目配 subagent、并行干活的分工
- 大改造前需要 architect→implementer→reviewer→tester 流水线
- 精简/重构项目需要多角色协作

## 工作流

1. 调用 `subagent_factory`，`action: "generate"`（首次）或 `"load"`（已生成过）。
2. 从返回的每个 `spawnArgs` 构造 `subagent_spawn` 调用：
   - `task`：原样使用（已含项目技术栈上下文与任务目标）
   - `tools`：原样传入 spawn 的 `tools` 参数
   - `thinkingLevel`：原样传入
   - `timeout`：原样传入
3. 无依赖的 agent 并行 spawn；有依赖的（implementer 等 architect 产出）按序派发，用 `subagent_wait` 等待前序完成。
4. 追加指令用 `subagent_send`；查看全部任务用 `subagent_inspect`；取消用 `subagent_cancel`。

## 生成物

- `.pi/team/subagents.json` — 结构化团队（profile + agents + spawnArgs）
- `.pi/team/SUBAGENTS.md` — 人类可读版（表格 + 每个 agent 的派发 JSON）

## 命令

- `/team` 或 `/team gen` — 不经模型直接扫描并生成
- `/team scan` — 只扫描显示技术栈
- `/team show` — 查看是否已生成

## 注意

- 生成的团队是确定性的（规则引擎，不烧模型 token）；重新 generate 会覆盖旧文件
- `architect`/`reviewer`/`monorepo-coordinator` 只读不改；`implementer` 系才有写权限
- 派发前如果项目有 `pnpm verify` 之类的校验脚本，把"完成后运行校验"写进追加指令
