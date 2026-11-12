// nifecode-bridge —— 让 Nife 用上本机 NifeCode 编辑器的桥接
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 三件事：
// 1. 注册 nifecode 工具（state / open / save / diff / workspace），agent 直接调用，不依赖本机路径
// 2. 编辑器真在跑时才把「接口说明 + 实时状态」注入上下文。注入走 `context` 事件（每次 LLM 调用前的
//    临时消息，不落会话），**不动 system prompt**：system prompt 是 prompt 缓存的前缀断点，
//    每轮改它等于整段对话缓存全废。没启动就完全静默（30 秒退避）
// 3. 替 agent 兜底：写文件前自动保存用户的未保存改动（防覆盖），写完后自动把编辑器滚到改动行
import { Type } from "typebox";
import { resolveBase } from "./config.ts";
import { digestOf, isDirtyFile, MAX_DIFF_CHARS, pathKey, resolveTarget, stateBlock } from "./state.ts";

// NIFECODE_BRIDGE 的写法见 config.ts：off 关闭、纯端口号或 http://host:port 指定地址。
// 写错就**当场抛错**（nife 会显示 "Failed to load extension: ..."），绝不悄悄回落到 7317
const CFG = resolveBase(process.env.NIFECODE_BRIDGE);
if (CFG.warning) throw new Error(CFG.warning);
const OFF = !CFG.enabled;
const BASE = CFG.base;
// NifeCode 的 PTY 会给终端里的程序塞这几个变量（ssh 终端不会），
// 有 NIFECODE_TERM 才说明“我这个进程就是编辑器开出来的终端里的”，
// 探端口只能证明“这台机器上有个编辑器开着”，跟当前会话一点关系都没有（可能在看别的项目、
// 也可能是用户在普通 PowerShell 里跑 nife）。所以闸门只认环境变量，不认端口。
const IN_NIFECODE = process.env.NIFECODE_TERM === "1";
const PROBE_MS = 400;
const RETRY_MS = 30_000;
const POLL_MS = 2_000; // 跟编辑器推快照的节奏对齐
const OPEN_THROTTLE_MS = 1_500;
const STATE_TYPE = "nifecode-state";

/** 最近一次探到的状态；后台轮询写入，事件回调只读它（不阻塞首 token） */
let lastState = null;
let lastOkAt = 0;
let downUntil = 0;
/** 上一轮注入用的状态摘要。每轮清空：注入的消息不落会话，不清就会有一轮什么都没有 */
let lastDigest = "";
/** 写完之后自动 open 的节流 */
const openedAt = new Map();

/** 探一次 /state：通了写进 lastState，没通进入退避并清空 */
async function probe() {
	if (Date.now() < downUntil) return null;
	try {
		const res = await fetch(`${BASE}/state`, { signal: AbortSignal.timeout(PROBE_MS) });
		if (!res.ok) throw new Error(String(res.status));
		lastState = await res.json();
		lastOkAt = Date.now();
		return lastState;
	} catch {
		downUntil = Date.now() + RETRY_MS;
		lastState = null;
		return null;
	}
}

/** 缓存够新就直接用，过期才同步探一次（正常情况下走不到 probe） */
async function freshState() {
	if (lastState && Date.now() - lastOkAt < POLL_MS * 2) return lastState;
	return probe();
}

/** 调一次接口，返回 { ok, status, text }；连不上也返回，让调用方决定怎么说 */
async function call(method, path, body) {
	try {
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(70_000), // /save 同步等前端写盘，最多 60 秒
		});
		const text = await res.text();
		return { ok: res.ok, status: res.status, text };
	} catch (e) {
		downUntil = Date.now() + RETRY_MS;
		lastState = null;
		return { ok: false, status: 0, text: `连不上 NifeCode（${BASE}）：${e.message}` };
	}
}

/** 包成工具返回值：失败也回文本，让模型看得见原因 */
function toolText(r) {
	return {
		content: [{ type: "text", text: r.ok ? r.text : `HTTP ${r.status}：${r.text}` }],
		details: {},
	};
}

function plainText(text) {
	return { content: [{ type: "text", text }], details: {} };
}

/** write / edit 的目标文件；别的工具返回 null */
function writeTarget(event) {
	if (event.toolName !== "write" && event.toolName !== "edit") return null;
	const p = event.input?.path;
	return typeof p === "string" && p.trim() ? p : null;
}

export default function (pi) {
	if (OFF || !IN_NIFECODE) return;

	let warm = null;
	const startWarm = () => {
		if (warm) return;
		void probe();
		warm = setInterval(() => void probe(), POLL_MS);
		warm.unref?.(); // 别拖住进程退出
	};
	pi.on("session_start", () => startWarm());
	pi.on("session_shutdown", () => {
		if (warm) clearInterval(warm);
		warm = null;
	});

	pi.registerTool({
		name: "nifecode",
		label: "NifeCode",
		description:
			"操作本机正在运行的 NifeCode 编辑器。state=读状态（root/当前文件/未保存文件/选中内容/光标）；" +
			"open=打开文件并可跳到某行，让用户看到；save=保存未保存的文件；" +
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
					return toolText(await call("GET", "/state"));
				case "open":
					return toolText(await call("POST", "/open", { path: params.path, line: params.line }));
				case "save":
					return toolText(await call("POST", "/save", params.path ? { path: params.path } : {}));
				case "diff": {
					if (!params.path) return plainText("diff 需要 path。");
					const newContent = params.newContent ?? "";
					if (newContent.length > MAX_DIFF_CHARS) {
						return plainText(
							`内容 ${newContent.length} 字符，超过 diff 上限 ${MAX_DIFF_CHARS}（编辑器要整份全文，太大）。` +
								"别走 diff：直接用 write/edit 改盘上的文件，编辑器会自动重载，我再帮你滚到改动行。",
						);
					}
					return toolText(await call("POST", "/diff", { path: params.path, newContent }));
				}
				case "workspace":
					return toolText(await call("POST", "/workspace", { path: params.path }));
				default:
					return plainText(`未知 command：${params.command}`);
			}
		},
	});

	// 写文件前先把用户没保存的改动存了，免得这次写入把人的活覆盖掉。
	// 这条路不指望模型记得，所以放在 tool_call 里拦；存不下来就明确拒绝写。
	pi.on("tool_call", async (event, ctx) => {
		const target = writeTarget(event);
		if (!target) return;
		const st = await freshState();
		if (!st) return; // 编辑器没开：什么都不管
		const abs = resolveTarget(target, ctx?.cwd);
		if (!isDirtyFile(st.dirty, abs)) return;
		const r = await call("POST", "/save", { path: abs });
		if (r.ok) return;
		return {
			block: true,
			reason: `NifeCode 里 ${target} 有未保存改动，自动保存失败（${r.text.trim()}）。先让人处理编辑器里的改动，否则这次写入会覆盖掉。`,
		};
	});

	// 写完之后把人带到改动行。只在编辑器已知存活时发，避免编辑器没开也去连一下、顺手把退避点着
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const target = writeTarget(event);
		if (!target || !lastState) return;
		const abs = resolveTarget(target, ctx?.cwd);
		const key = pathKey(abs);
		const now = Date.now();
		if (now - (openedAt.get(key) ?? 0) < OPEN_THROTTLE_MS) return;
		openedAt.set(key, now);
		const line = event.toolName === "edit" ? event.details?.firstChangedLine : undefined;
		void call("POST", "/open", line ? { path: abs, line } : { path: abs });
	});

	// 每轮开头允许重新注入（注入的消息不落会话，不重置的话第二轮就没有状态了）
	pi.on("before_agent_start", () => {
		lastDigest = "";
	});

	// 状态走临时消息，不动 system prompt：后者是缓存断点，每轮改会让整段对话缓存失效
	pi.on("context", (event, ctx) => {
		const st = lastState;
		if (!st) return;
		const digest = digestOf(st);
		if (digest === lastDigest) return; // 一轮内状态没变就别重复塞
		lastDigest = digest;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: STATE_TYPE,
					content: stateBlock(st, { base: BASE, cwd: ctx?.cwd }),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
}
