# panel-plugin

示例插件 C：一个**完全在浏览器里**的插件。

- `server.mjs` 是空壳：它不为这个面板提供任何东西
- `web.js` 是没有构建过的 ESM，浏览器直接在运行时 import 它
- 它把面板注册进 shell 的 `Panels` 注册表，所以 shell 里没有任何一行代码提到它

安装：

```bash
mkdir -p ~/.moonan/plugins
cp -r examples/panel-plugin ~/.moonan/plugins/panel-demo
```

重启 moonan，标签栏里会多出一个「示例面板」。

`web.js` 里的 `import "react"`、`import "@moonan_ai/web-api"` 由 `index.html` 里的
import map 解析到 `/runtime/*.js`，所以它和内置面板共享同一份运行时。真实插件用 TSX
写、`tsc` 构建成 ESM 即可（见 `packages/plugin-*`）。
