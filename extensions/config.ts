// NIFECODE_BRIDGE 的解析：地址和开关是同一个变量，所以规则必须死板、写错必须响
// SPDX-License-Identifier: GPL-3.0-or-later

export const DEFAULT_BASE = "http://127.0.0.1:7317";
const OFF_WORDS = ["off", "0", "none", "false", "no", "disable", "disabled"];

/**
 * - 不写 / 空 → 默认 7317
 * - off / 0 / none / false / no / disable → 关闭
 * - 纯数字（7318）→ http://127.0.0.1:7318
 * - host:port（localhost:7318）→ http://localhost:7318
 * - http:// / https:// 开头 → 原样（去掉尾部斜杠）
 * - 其他 → 返回 warning，调用方应该直接抛错，不要悄悄回落到 7317
 */
export function resolveBase(raw) {
  const v = (raw ?? "").trim();
  if (!v) return { enabled: true, base: DEFAULT_BASE };
  if (OFF_WORDS.includes(v.toLowerCase())) return { enabled: false, base: DEFAULT_BASE };
  if (/^\d+$/.test(v)) return { enabled: true, base: `http://127.0.0.1:${v}` };
  if (/^[\w.-]+:\d+$/.test(v)) return { enabled: true, base: `http://${v}` };
  if (/^https?:\/\/\S+$/i.test(v)) return { enabled: true, base: v.replace(/\/+$/, "") };
  return {
    enabled: false,
    base: DEFAULT_BASE,
    warning: `NIFECODE_BRIDGE=${v} 不是能识别的地址：写 off 表示关闭，或写端口号（7317）、host:port（localhost:7317）、http://host:port`,
  };
}
