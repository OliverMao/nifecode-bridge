# nifecode-bridge

`nife`（CLI agent）的扩展：让它知道本机 [NifeCode](https://github.com/OliverMao/NifeCode) 编辑器正开着什么。

NifeCode 在 `127.0.0.1:7317` 暴露一个本地 HTTP 接口（打开文件 / 读状态 / 保存 / 弹 diff）。
这个扩展做三件事：

1. **注册 `nifecode` 工具** —— agent 直接调用，不用拼 curl，也不依赖 NifeCode 仓库在哪
2. **只在编辑器真的在跑时才把用法和实时状态注入上下文** —— 没启动就完全静默（30 秒退避），
   不会像全局 `AGENTS.md` 那样污染所有无关项目的会话
3. **替 agent 兜底**：写文件前自动保存用户的未保存改动（存不下来就拒绝写），写完后自动滚到改动行

## 安装

```bash
# 固定版本（推荐）
nife install git:github.com/OliverMao/nifecode-bridge@v0.2.0

# 或者跟主线（不推荐，行为可能变）
nife install git:github.com/OliverMao/nifecode-bridge
```

装完开新会话即可，不需要重启 nife 之外的任何东西。卸载：`nife remove git:github.com/OliverMao/nifecode-bridge`。

想先试不装：`nife -e git:github.com/OliverMao/nifecode-bridge@v0.2.0`。

自检（不需要 nife，也不需要编辑器在跑）：

```bash
node extensions/state.test.mjs    # 状态摘要 / 路径归一 / 脏文件匹配，21 项
node extensions/config.test.mjs   # NIFECODE_BRIDGE 解析，12 项
```

## 它给 agent 什么

工具 `nifecode`：

| command | 作用 |
|---|---|
| `state` | `root` / 当前文件 / 未保存文件 / `selection`（用户选中的内容，≤4000 字）/ `cursor` |
| `open` | 打开文件，`line` 可跳到指定行 —— 「我把人带到改动的地方」 |
| `save` | 保存未保存的文件（不传 `path` = 全部）。**agent 动手改文件前应该先调**，否则读到的是旧内容 |
| `diff` | 传整份新内容，编辑器弹左右对照，**用户点「应用」才落盘** |
| `workspace` | 切换工作区目录 |

除了工具，它还会主动替 agent 兜两件事（不用模型记得）：

- **写文件前自动保存**：`write` / `edit` 的目标文件如果在编辑器的未保存列表里，先 `POST /save` 把它存了再放行；存不下来就**直接拒绝这次写入**并说明原因。以前这条只写在提示词里靠模型自觉，漏一次就覆盖掉用户没保存的改动
- **写完之后自动 `POST /open`**（带 `edit` 给的 `firstChangedLine`），把你眼睛带到改动行；同一个文件 1.5 秒内只触发一次

每轮都会把实时状态注入上下文，例如：

```
## NifeCode 编辑器（本机正开着，你就跑在它的终端里；下面是每次请求前的实时状态）
工具 `nifecode`：state | open | save | diff | workspace（接口 http://127.0.0.1:7317）。
当前：root=D:/proj，file=D:/proj/src/main.ts，未保存=1，光标=D:/proj/src/main.ts:42
用户选中 D:/proj/src/main.ts 第 3-9 行：
```
const a = 1;
```
规则：用户说「这里 / 这段 / 它」时以选中内容为准…
```

选中原文不超过 400 字就直接带上，超过只给行号（用 `nifecode state` 取全文）。

**注入走 `context` 事件，不动 system prompt。** system prompt 是 provider 的 prompt 缓存断点，
每轮改它等于整段对话缓存全部失效（光标一变就变），等于每轮按 cache write 重算全部 input。
`context` 注入的是每次 LLM 调用前的临时消息，不落会话、不攒长度，前缀缓存照样命中；
一轮之内状态真变了才补一次。

## 怎么关掉

| 场景 | 做法 |
|---|---|
| 只想这个会话不用 | `NIFECODE_BRIDGE=off nife`（工具不注册、状态不注入，整包哑火） |
| 连别的扩展一起关 | `nife -ne`（`--no-extensions`） |
| 只藏工具、保留注入 | `nife -xt nifecode`（`--exclude-tools`） |
| NifeCode 没开 | 自动静默，什么都不用做 |
| 彻底不用 | `nife remove git:github.com/OliverMao/nifecode-bridge` |
| 只在某个项目里用 | 在那个项目跑 `nife install -l git:github.com/OliverMao/nifecode-bridge@v0.2.0`，写的是 `.nife/settings.json` |

## 怎么知道自己"在 NifeCode 里"

NifeCode 的 PTY 会往每个终端里塞三个环境变量（ssh 终端没有，因为不跨主机）：

| 变量 | 值 |
|---|---|
| `NIFECODE_TERM` | `1` |
| `NIFECODE_BRIDGE` | `http://127.0.0.1:7317` |
| `NIFECODE_ROOT` | 该终端所属工作区的根目录 |

所以扩展的判断顺序是：`NIFECODE_BRIDGE=off` → 关；`NIFECODE_TERM=1` → 确定在编辑器终端里，
提示词里会直说"你就跑在它的终端里"，不用再猜项目是不是同一个；都没有 → 探端口，通了才注入。

## `NIFECODE_BRIDGE` 怎么写

同一个变量既是地址又是开关，所以只认下面这几种写法（解析规则在 `extensions/config.ts`，
自检：`node extensions/config.test.mjs`）：

| 写法 | 含义 |
|---|---|
| 不设 / 空 | 默认 `http://127.0.0.1:7317` |
| `off`（也能写 `0` `none` `false` `no` `disable`） | 关闭，不注册工具、不注入 |
| `7318` | 纯端口号 → `http://127.0.0.1:7318` |
| `localhost:7318` / `127.0.0.1:7318` | `http://localhost:7318` |
| `http://host:7317` / `https://…` | 原样使用 |
| 其它（比如 `localhost`、`http:/127.0.0.1`） | **当场报错**：`Failed to load extension … 不是能识别的地址`，不会悄悄改用 7317 |

## 兼容性

- 需要 NifeCode **v0.1.5 或更新**（`/save` 是同步的，`/state` 带 `selection` 和 `cursor`）
- **旧版 NifeCode 不建议再用**：它的 `/save` 会立刻回 `{"ok":true}` 而实际不一定写盘，
  现在写入前的自动保存以这个返回值为准，可能放行一次会覆盖掉用户未保存改动的写入
- 只连本机回环，不联网，不收集任何东西

## 许可证

GPL-3.0-or-later，见 `LICENSE`；版权声明见 `COPYRIGHT`。
