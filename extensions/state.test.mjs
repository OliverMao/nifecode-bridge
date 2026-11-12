// state.ts 的自检：node extensions/state.test.mjs
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { digestOf, isDirtyFile, MAX_DIFF_CHARS, MAX_INLINE_SELECTION, pathKey, resolveTarget, stateBlock } from "./state.ts";

const base = (over = {}) => ({
	root: "D:/p",
	file: "D:/p/a.ts",
	dirty: [],
	host: null,
	cursor: { file: "D:/p/a.ts", line: 1 },
	selection: null,
	...over,
});

// --- pathKey：Windows 大小写不敏感，其它平台不能乱降级 ---
assert.equal(pathKey("D:\\p\\A.ts", "win32"), "d:/p/a.ts", "win32 反斜杠+大小写");
assert.equal(pathKey("/home/U/a.ts", "linux"), "/home/U/a.ts", "linux 保留大小写");
assert.equal(pathKey(null), "", "空值");

// --- resolveTarget：相对路径按 cwd 解析，绝对路径原样 ---
assert.equal(resolveTarget("a.ts", "/home/u/p"), "/home/u/p/a.ts", "相对路径");
assert.equal(resolveTarget("/home/u/p/a.ts", "/other"), "/home/u/p/a.ts", "绝对路径");
assert.equal(resolveTarget("  ", "/home/u/p"), null, "空路径");

// --- digestOf：状态没变就一样，动了光标/脏文件/选中就要变 ---
assert.equal(digestOf(base()), digestOf(base()), "同样状态摘要相同");
assert.notEqual(digestOf(base()), digestOf(base({ cursor: { file: "D:/p/a.ts", line: 2 } })), "光标变了");
assert.notEqual(digestOf(base()), digestOf(base({ dirty: ["D:/p/b.ts"] })), "脏文件变了");
assert.notEqual(
	digestOf(base()),
	digestOf(base({ selection: { file: "D:/p/a.ts", startLine: 3, endLine: 9, text: "x" } })),
	"有选中了",
);

// --- stateBlock：短的选中直接带上原文，长的只给位置 ---
const short = stateBlock(
	base({ selection: { file: "D:/p/a.ts", startLine: 3, endLine: 9, text: "const a = 1;" } }),
	{ base: "http://127.0.0.1:7317" },
);
assert.match(short, /第 3-9 行/, "选中行号");
assert.match(short, /const a = 1;/, "短选中带原文");
assert.match(short, /127\.0\.0\.1:7317/, "接口地址");

const long = stateBlock(
	base({ selection: { file: "D:/p/a.ts", startLine: 1, endLine: 900, text: "x".repeat(MAX_INLINE_SELECTION + 1) } }),
	{ base: "http://x" },
);
assert.doesNotMatch(long, /x{50}/, "长选中不带原文");
assert.match(long, /太长没带过来/, "长选中给个说明");

// --- stateBlock：没选中 / 工作目录和编辑器 root 不一致时要说出来 ---
assert.match(stateBlock(base(), { base: "http://x" }), /没有选中内容/, "没选中");
assert.match(stateBlock(base(), { base: "http://x" }), /跑在它的终端里/, "只在编辑器终端里注入");
assert.match(stateBlock(base(), { base: "http://x", cwd: "/home/u" }), /不是同一个目录/, "cwd 不一致要提");
assert.doesNotMatch(stateBlock(base(), { base: "http://x", cwd: "D:\\p\\" }), /不是同一个目录/, "同一个目录不废话");

// --- isDirtyFile：脏文件匹配是自动保存拦持的唯一依据，大小写/斜杠/相对路径都得对得上 ---
assert.equal(isDirtyFile(["D:\\p\\A.ts"], "D:/p/a.ts", "win32"), true, "win32 大小写+斜杠都能匹配");
assert.equal(isDirtyFile(["/home/u/p/a.ts"], "/home/u/p/b.ts"), false, "不同文件不匹配");
assert.equal(isDirtyFile([], "/home/u/p/a.ts"), false, "没脏文件");
assert.equal(isDirtyFile(null, "/home/u/p/a.ts"), false, "脏文件为 null 不能报错");

// --- 常量：diff 阈值是个正数，别被写成 0 ---
assert.ok(MAX_DIFF_CHARS > 1000, "diff 阈值合理");

console.log("state 自检通过（22 项）");
