# Moonan

[![CI](https://github.com/Pheobe-Southwood/Moonan/actions/workflows/ci.yml/badge.svg)](https://github.com/Pheobe-Southwood/Moonan/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@moonan_ai/moonan/alpha?label=npm)](https://www.npmjs.com/package/@moonan_ai/moonan)

**让 AI 角色扮演更沉浸，支持灵活的插件系统。**
Immersive AI roleplay with a flexible plugin system.

![对话界面](docs/screenshots/chat.png)

Moonan 是一个本地运行的角色扮演工作台。你把角色交给它，它把模型说的话变成角色说的话——中间发生的一切都留在你自己的机器上。

Moonan is a local-first roleplay workbench. You hand it a character; it turns what the model says into what the character says. Everything in between stays on your machine.

---

## 快速开始 · Quick start

```bash
npx @moonan_ai/moonan@alpha
# 或 / or
npm i -g @moonan_ai/moonan@alpha && moonan
```

打开 <http://127.0.0.1:21315>，在 **提供商** 里填一个 API 密钥，在 **Agent** 里选好模型，就可以开始说话。

Open <http://127.0.0.1:21315>, add a provider key, pick a model, start talking.

```bash
moonan --port 21315 --data-dir ~/.moonan   # 默认值 / defaults
moonan --hostname 127.0.0.1                # 只给本机用 / loopback only
```

默认监听 `0.0.0.0`，局域网和 Tailscale 内都能打开：启动时会打印可用地址。
**界面没有登录鉴权**——端口对谁开放，谁就能控制 Agent、密钥和 MCP 工具；只想本机用就传 `--hostname 127.0.0.1`。

By default Moonan listens on `0.0.0.0` so the UI is reachable over your LAN or Tailscale; the startup banner prints the addresses.
**There is no authentication** — anyone who can reach the port can drive the agent, its keys and its MCP tools. Pass `--hostname 127.0.0.1` to keep it local.

## 它做了什么 · What it does

| | |
|---|---|
| **一个角色，一个 Agent** | 角色名、人设、系统提示词都是可编辑的变量，改完立刻生效。 |
| **说与想分开** | 模型的心理描写留在日志里，只有 `send_message` 工具的输出会出现在对话窗口。 |
| **消息自动合批** | 两秒内连发的几条消息会合成一条带时间戳的说明交给模型。 |
| **明文、本地、可查** | 数据在本机 SQLite 里：内核一个库，每个插件一个库。密钥不加密、不上传，随时可以用任何客户端打开。 |
| **插件就是 chord facet** | 内置的五个面板本身就是插件；插件只通过注册表与能力契约接触内核，外部插件放到 `~/.moonan/plugins` 即可加载，`/api/plugins/reload` 热重载。 |

## 截图 · Screenshots

| 日志 · Logs | Agent |
|---|---|
| ![日志](docs/screenshots/logs.png) | ![Agent](docs/screenshots/agents.png) |

| 提供商 · Providers | MCP |
|---|---|
| ![提供商](docs/screenshots/providers.png) | ![MCP](docs/screenshots/mcp.png) |

## 文档 · Documentation

- [架构](docs/architecture.md) — 进程、包、一次对话的完整路径
- [插件](docs/plugins.md) — 写一个插件，服务端与浏览器各一半
- [数据](docs/data.md) — 表结构与文件位置
- [决策记录](docs/adr/) — 为什么是现在这个样子

## 开发 · Development

```bash
pnpm install
pnpm dev        # 服务端 21316 + Vite 21315
pnpm typecheck
pnpm test       # 端到端跑一次真实对话（假模型）
pnpm e2e        # Playwright，截图会写到 docs/screenshots
```

需要 Node.js ≥ 22.19。

## 状态 · Status

`0.0.1-alpha4`：内核大解耦——对话、MCP、日志、面板全部下沉为插件，插件只通过注册表与能力契约接触内核；回合改为「立即确认 + 后台 root」，支持插件热重载。
**升级会丢弃 alpha3 的聊天与 MCP 配置**，详见[数据](docs/data.md#alpha3--alpha4-的破坏性变更)。
OAuth 登录、停止按钮、多 Agent 界面、外部 `web.js` 面板位留到后续版本。

## 许可 · License

MIT
