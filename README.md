# nifecode-bridge

`nife`（CLI agent）的扩展：让它知道本机 [NifeCode](https://github.com/OliverMao/NifeCode) 编辑器正开着什么。

NifeCode 在 `127.0.0.1:7317` 暴露一个本地 HTTP 接口（打开文件 / 读状态 / 保存 / 弹 diff）。
这个扩展做两件事：

1. **注册 `nifecode` 工具** —— agent 直接调用，不用拼 curl，也不依赖 NifeCode 仓库在哪
2. **只在编辑器真的在跑时才把用法和实时状态注入系统提示** —— 没启动就完全静默（30 秒内不重复探测），
   不会像全局 `AGENTS.md` 那样污染所有无关项目的会话

## 安装

```bash
# 固定版本（推荐）
nife install git:github.com/OliverMao/nifecode-bridge@v0.1.0

# 或者跟主线（不推荐，行为可能变）
nife install git:github.com/OliverMao/nifecode-bridge
```

装完开新会话即可，不需要重启 nife 之外的任何东西。卸载：`nife remove git:github.com/OliverMao/nifecode-bridge`。

想先试不装：`nife -e git:github.com/OliverMao/nifecode-bridge@v0.1.0`。

## 它给 agent 什么

工具 `nifecode`：

| command | 作用 |
|---|---|
| `state` | `root` / 当前文件 / 未保存文件 / `selection`（用户选中的内容，≤4000 字）/ `cursor` |
| `open` | 打开文件，`line` 可跳到指定行 —— 「我把人带到改动的地方」 |
| `save` | 保存未保存的文件（不传 `path` = 全部）。**agent 动手改文件前应该先调**，否则读到的是旧内容 |
| `diff` | 传整份新内容，编辑器弹左右对照，**用户点「应用」才落盘** |
| `workspace` | 切换工作区目录 |

系统提示里额外多出几句实时状态，例如：

```
## NifeCode 编辑器（本机正开着，下面这些是实时状态）
工具 `nifecode`：command = state | open | save | diff | workspace（接口 http://127.0.0.1:7317）。
当前：root=D:/proj，file=D:/proj/src/main.ts，未保存=1，光标=D:/proj/src/main.ts:42
用户选中了 D:/proj/src/main.ts 第 3-9 行（原文在 nifecode state 的 selection.text，最长 4000 字）
规则：用户说「这里 / 这段」时以 selection 为准…
```

## 怎么关掉

| 场景 | 做法 |
|---|---|
| 只想这个会话不用 | `NIFECODE_BRIDGE=off nife`（工具不注册、状态不注入，整包哑火） |
| 连别的扩展一起关 | `nife -ne`（`--no-extensions`） |
| 只藏工具、保留注入 | `nife -xt nifecode`（`--exclude-tools`） |
| NifeCode 没开 | 自动静默，什么都不用做 |
| 彻底不用 | `nife remove git:github.com/OliverMao/nifecode-bridge` |
| 只在某个项目里用 | 在那个项目跑 `nife install -l git:github.com/OliverMao/nifecode-bridge@v0.1.1`，写的是 `.nife/settings.json` |

## 端口不是 7317？

设环境变量 `NIFECODE_BRIDGE=http://127.0.0.1:7318` 再启动 nife。

## 兼容性

- 需要 NifeCode **v0.1.5 或更新**（`/save` 是同步的，`/state` 带 `selection` 和 `cursor`）
- 旧版 NifeCode 仍可用 `state` / `open` / `diff` / `workspace`，但 `save` 会立刻回 `{"ok":true}` 而实际不一定写盘，
  且 `selection` 恒为 `null`
- 只连本机回环，不联网，不收集任何东西

## 许可证

GPL-3.0-or-later，见 `LICENSE`；版权声明见 `COPYRIGHT`。
