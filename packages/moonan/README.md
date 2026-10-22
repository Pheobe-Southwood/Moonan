# moonan

让 AI 角色扮演更沉浸，支持灵活的插件系统。
Immersive AI roleplay with a flexible plugin system.

```bash
npx @moonan_ai/moonan@alpha
```

打开 <http://127.0.0.1:21315>，在 **提供商** 里填一个 API 密钥，在 **Agent** 里选好模型，就可以开始说话。

Open <http://127.0.0.1:21315>, add a provider key, pick a model, start talking.

```bash
moonan --port 21315 --data-dir ~/.moonan   # 默认值 / defaults
```

- 数据全部明文存在 `~/.moonan/moonan.db`，可以随时用任何 SQLite 客户端打开。
- 模型的心理描写留在日志面板，只有 `send_message` 工具的输出会出现在对话窗口；打开对话窗不会触发模型。
- 五个面板本身就是插件，外部插件放在 `~/.moonan/plugins` 即可加载。

文档：[架构](https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/architecture.md) ·
[插件](https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/plugins.md) ·
[数据](https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/data.md)

MIT
