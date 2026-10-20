# 0002：Agent 运行时用 pi-agent-core，不用 pi-durable

- 状态：接受
- 日期：rc1

## 背景

两个候选：

1. `@earendil-works/pi-agent-core`：通用 Agent（`Agent` 类 + `runAgentLoop` 等底层循环）。
2. `@earendil-works/pi-durable`：带 Session / 文档 / 任务 / 压缩的**持久化运行时**，内置 Harness、CompactionTask、
   以及 read/write/edit/bash 等工具。它自带 SQLite 与 JSONL 存储后端。

`pi-durable` 看起来更省事，但实测它带来的约束与 Moonan 的需求冲突：

- 它自己拥有消息历史的表示（`EntryRecord` / `ContextEdit` / head marker），要改「上下文里某一段」得走它的编辑模型；
- 它的压缩策略、任务调度、Inbox 语义都假设"编码 Agent"的用法；
- 它**不引用** `pi-agent-core`——两套运行时不能简单叠加。

## 决定

用 `pi-agent-core` 的 `runAgentLoop` 作为唯一的生成循环；**不使用 pi-durable**，但它作为数据模型的参考
（`ContextEdit` 的"改动只影响模型视图、不改历史"这一思想被 ActBlock 直接借用）。

持久化自研：`node:sqlite` 的 `DatabaseSync`，schema 见 `apps/moonan/src/store/db.ts`。

## 理由

- Moonan 的核心不变量是"历史里存原文、模型视图里挂 ActBlock"，需要一个**看得见消息数组**的循环。
  `runAgentLoop` 正好把 `transformContext`（渲染模型视图）与 `getSteeringMessages` / `getFollowUpMessages`
  / `finishTurn`（入站消息的三个注入点）开放出来。
- 自研存储只用到两张核心表（`conversation` / `transcript`）加一张队列表，比适配一套通用文档模型更短。

## 后果

- 好：上下文完全可控；ActBlock 的单副本不变量可以用一条 `transformContext` 保证。
- 差：压缩（长会话摘要）、任务重试这些 pi-durable 现成的东西要自己做。rc1 不做压缩，超长会话靠用户自己重开新 Agent。
- 差：必须自己处理"引擎会把流式的 partial 消息替换成等长最终消息"这类细节（见 ADR 0008）。
