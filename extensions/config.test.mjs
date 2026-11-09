// NIFECODE_BRIDGE 解析的自检：node extensions/config.test.mjs
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { resolveBase } from "./config.ts";

const eq = (raw, want, label) => {
  const got = resolveBase(raw);
  assert.equal(got.enabled, want.enabled, `${label}: enabled`);
  assert.equal(got.base, want.base, `${label}: base`);
  assert.equal(!!got.warning, !!want.warning, `${label}: warning`);
};

eq(undefined, { enabled: true, base: "http://127.0.0.1:7317" }, "不设");
eq("", { enabled: true, base: "http://127.0.0.1:7317" }, "空串");
eq("  ", { enabled: true, base: "http://127.0.0.1:7317" }, "空格");
eq("off", { enabled: false, base: "http://127.0.0.1:7317" }, "off");
eq(" OFF ", { enabled: false, base: "http://127.0.0.1:7317" }, "大写+空格");
// 关键：只写端口号必须当成端口，不能悄悄回落到 7317
eq("7318", { enabled: true, base: "http://127.0.0.1:7318" }, "纯端口");
eq("localhost:7318", { enabled: true, base: "http://localhost:7318" }, "host:port");
eq("http://127.0.0.1:7318/", { enabled: true, base: "http://127.0.0.1:7318" }, "带尾斜杠");
eq("https://box:7317", { enabled: true, base: "https://box:7317" }, "https");
// 看不懂的必须闭嘴失败，而不是打默认端口
eq("127.0.0.1", { enabled: false, base: "http://127.0.0.1:7317", warning: true }, "只有主机名");
eq("http:/127.0.0.1:7318", { enabled: false, base: "http://127.0.0.1:7317", warning: true }, "写坏的 scheme");

console.log("config 自检通过（12 项）");
