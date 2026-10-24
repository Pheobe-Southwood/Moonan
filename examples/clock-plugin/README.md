# clock-plugin

示例插件 A：**只提供能力**，不注册任何东西。

- 导出 `local()` 契约 `example.clock`，成员只有一个 `now()`
- `api.serve(..., { lifetime: "host" })`：实现跟着进程活，别的插件热重载时不会重启它

安装：

```bash
mkdir -p ~/.moonan/plugins
cp -r examples/clock-plugin ~/.moonan/plugins/clock
```

配套的消费方见 `examples/greeter-plugin`。
