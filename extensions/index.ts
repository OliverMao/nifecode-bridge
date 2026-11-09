// nifecode-bridge —— 让 Nife 用上本机 NifeCode 编辑器的桥接
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 两件事：
// 1. 注册 nifecode 工具（state / open / save / diff / workspace），agent 直接调用，不依赖本机路径
// 2. 每轮开始前探一下端口，**编辑器真在跑**才把接口说明 + 实时状态追加进系统提示；
//    没启动就完全静默（30 秒内不重复探），不会污染无关项目的会话
import { Type } from "typebox";

const BASE = process.env.NIFECODE_BRIDGE ?? "http://127.0.0.1:7317";
const PROBE_MS = 400;
const RETRY_MS = 30_000;
let downUntil = 0;

/** 探一次 /state：通了返回状态对象，没通返回 null 并进入退避 */
async function probe() {
  if (Date.now() < downUntil) return null;
  try {
    const res = await fetch(`${BASE}/state`, { signal: AbortSignal.timeout(PROBE_MS) });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    downUntil = Date.now() + RETRY_MS;
    return null;
  }
}

/** 把一次请求的结果包成工具返回值；失败也返回文本，让模型看得见原因 */
async function call(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(70_000), // /save 同步等前端写盘，最多 60 秒
    });
    const text = await res.text();
    return { content: [{ type: "text", text: res.ok ? text : `HTTP ${res.status}：${text}` }], details: {} };
  } catch (e) {
    downUntil = Date.now() + RETRY_MS;
    return {
      content: [{ type: "text", text: `连不上 NifeCode（${BASE}）：${e.message}\n编辑器没启动时可以忽略这条，照常用文件工具。` }],
      details: {},
    };
  }
}

function stateBlock(state, cwd) {
  const dirty = (state.dirty ?? []).length;
  const sel = state.selection;
  return [
    "## NifeCode 编辑器（本机正开着，下面这些是实时状态）",
    `工具 \`nifecode\`：command = state | open | save | diff | workspace（接口 ${BASE}）。`,
    `当前：root=${state.root}，file=${state.file ?? "无"}，未保存=${dirty}，光标=${
      state.cursor ? `${state.cursor.file}:${state.cursor.line}` : "无"
    }${state.host ? `，远端 host=${state.host}` : ""}`,
    sel
      ? `用户选中了 ${sel.file} 第 ${sel.startLine}-${sel.endLine} 行（原文在 nifecode state 的 selection.text，最长 4000 字）`
      : "用户当前没有选中内容",
    "规则：用户说「这里 / 这段 / 它」时以 selection 为准，别猜；改文件前若未保存数非空，先 `nifecode save`（否则你读到的是旧内容，还可能覆盖用户没保存的改动）；危险或跨文件的改动用 `nifecode diff`，人点「应用」才落盘；你直接改盘上的文件后，编辑器会自动重载。",
    `注意：你的工作目录（${cwd ?? "?"}）和编辑器 root 不一致时，先确认是不是同一个项目。`,
  ].join("\n");
}

export default function (pi) {
  pi.registerTool({
    name: "nifecode",
    label: "NifeCode",
    description:
      "操作本机正在运行的 NifeCode 编辑器。state=读状态（root/当前文件/未保存文件/选中内容/光标）；" +
      "open=打开文件并可跳到某行，让用户看到；save=保存未保存的文件（动手改文件前若有未保存改动先调这个）；" +
      "diff=给出一份修改方案，弹左右对照，用户点「应用」才落盘；workspace=切换工作区目录。",
    parameters: Type.Object({
      command: Type.Union(
        [
          Type.Literal("state"),
          Type.Literal("open"),
          Type.Literal("save"),
          Type.Literal("diff"),
          Type.Literal("workspace"),
        ],
        { description: "要做什么" },
      ),
      path: Type.Optional(Type.String({ description: "文件或目录路径；相对路径按编辑器的工作区根解析，路径一律用 /" })),
      line: Type.Optional(Type.Number({ description: "open 时跳到的行号" })),
      newContent: Type.Optional(Type.String({ description: "diff 时的整份新内容（不是补丁）" })),
    }),
    async execute(_toolCallId, params) {
      switch (params.command) {
        case "state":
          return call("GET", "/state");
        case "open":
          return call("POST", "/open", { path: params.path, line: params.line });
        case "save":
          return call("POST", "/save", params.path ? { path: params.path } : {});
        case "diff":
          return call("POST", "/diff", { path: params.path, newContent: params.newContent ?? "" });
        case "workspace":
          return call("POST", "/workspace", { path: params.path });
        default:
          return { content: [{ type: "text", text: `未知 command：${params.command}` }], details: {} };
      }
    },
  });

  pi.on("before_agent_start", async (event) => {
    const state = await probe();
    if (!state) return undefined; // 编辑器没开：完全不插话
    return { systemPrompt: `${event.systemPrompt}\n\n${stateBlock(state, event.systemPromptOptions?.cwd)}` };
  });
}
