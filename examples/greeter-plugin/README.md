# greeter-plugin

示例插件 B：**消费**另一个插件的能力。

```js
const clock = self.get(Clock, {});
return { text: () => `你好，现在是 ${clock.now()}` };
```

两个要点：

- `Clock` 的定义与 `clock-plugin` 里逐字相同。契约指纹 = 名字 + 版本 + 输入 schema + 成员，
  所以不需要 import 对方的文件，也不需要共享模块实例。
- facet 声明了 `uses: [Clock]`：热重载重新提供 `example.clock` 时，chord 会把消费方重新绑定过去。

安装（必须先装 clock）：

```bash
mkdir -p ~/.moonan/plugins
cp -r examples/clock-plugin ~/.moonan/plugins/clock
cp -r examples/greeter-plugin ~/.moonan/plugins/greeter
```
