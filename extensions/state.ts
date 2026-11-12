// 纯函数：状态摘要、路径比较。不碰网络、不依赖 nife，能单独跑测试
// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from "node:path";

/** 选中文本短于这个长度就直接带进上下文，超过就只给位置 */
export const MAX_INLINE_SELECTION = 400;
/** 超过这个字符数的改动不走 diff（编辑器要整份全文，太大会卡） */
export const MAX_DIFF_CHARS = 200_000;

/** 路径比较用：Windows 文件系统大小写不敏感，其它平台保持原样 */
export function pathKey(p, platform = process.platform) {
	const v = String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, ""); // 尾部斜杠不算区别：D:/p 和 D:/p/ 是一个目录
	return platform === "win32" ? v.toLowerCase() : v;
}

/** 工具给的 path 可能是相对 cwd 的，统一成绝对路径（跟节点工具解析出来的路径对得上）；空路径返回 null */
export function resolveTarget(p, cwd) {
	const v = String(p ?? "").trim();
	if (!v) return null;
	return resolve(cwd ?? process.cwd(), v.replace(/\\/g, "/"));
}

/** 这个文件在编辑器的未保存列表里吗（两边都归一化再比） */
export function isDirtyFile(dirty, absPath, platform = process.platform) {
	const key = pathKey(absPath, platform);
	return (dirty ?? []).some((p) => pathKey(p, platform) === key);
}

/** 状态里真正会变的部分：变了才重新注入，没变就整轮只注入一次（省 token，也不打断 prompt 缓存） */
export function digestOf(state) {
	const sel = state?.selection;
	return [
		state?.root ?? "",
		state?.file ?? "",
		state?.host ?? "",
		(state?.dirty ?? []).length,
		state?.cursor?.file ?? "",
		state?.cursor?.line ?? "",
		sel ? `${sel.file}:${sel.startLine}-${sel.endLine}:${(sel.text ?? "").length}` : "",
	].join("|");
}

/**
 * 拼进上下文的实时状态块。故意短：每轮更新一次，长了就是纯烧钱。
 */
export function stateBlock(state, opts = {}) {
	const { base = "", cwd } = opts;
	const sel = state?.selection;
	const lines = [
		"## NifeCode 编辑器（你就跑在它的终端里；下面是每次请求前的实时状态）",
		`工具 \`nifecode\`：state | open | save | diff | workspace（接口 ${base}）。`,
		`当前：root=${state?.root ?? "?"}，file=${state?.file ?? "无"}，未保存=${(state?.dirty ?? []).length}，光标=${
			state?.cursor ? `${state.cursor.file}:${state.cursor.line}` : "无"
		}${state?.host ? `，远端 host=${state.host}` : ""}`,
	];
	if (sel) {
		const text = String(sel.text ?? "");
		lines.push(
			text && text.length <= MAX_INLINE_SELECTION
				? `用户选中 ${sel.file} 第 ${sel.startLine}-${sel.endLine} 行：\n\`\`\`\n${text}\n\`\`\``
				: `用户选中 ${sel.file} 第 ${sel.startLine}-${sel.endLine} 行（原文 ${text.length} 字，太长没带过来，用 \`nifecode state\` 取）`,
		);
	} else {
		lines.push("用户当前没有选中内容");
	}
	lines.push(
		"规则：用户说「这里 / 这段 / 它」时以选中内容为准，别猜；危险或跨文件的改动用 `nifecode diff`，人点「应用」才落盘；你直接写盘后编辑器会自动重载并滚到改动行（写入前会先替你保存用户的未保存改动，不用自己调 save）。",
	);
	if (cwd && state?.root && pathKey(cwd) !== pathKey(state.root)) {
		lines.push(`注意：你的工作目录（${cwd}）和编辑器 root（${state.root}）不是同一个目录，用户可能在看别的项目。`);
	}
	return lines.join("\n");
}
