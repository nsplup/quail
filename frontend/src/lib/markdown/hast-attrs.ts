/**
 * HAST properties → Svelte/DOM 属性映射（指南第 5 节属性映射）：
 * - className → class（hast 数组值 join）；
 * - htmlFor → for；
 * - 布尔 true → 空字符串（属性存在），false → 移除属性；
 * - style 对象 → 序列化为字符串（防御分支；parse5 产物恒为字符串）。
 * data-* 键：经 rehype-raw（property-information 规范化）后可能为 dataSrc
 * 或保留 data-src，消费方（MarkdownNode）对两种键都做兼容读取。
 */
import type { Element } from "hast";

const RENAMES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
};

export function hastAttrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(el.properties ?? {})) {
    if (value == null) continue;
    const name = RENAMES[key] ?? key;
    let str: string;
    if (Array.isArray(value)) {
      str = value.join(" ");
    } else if (typeof value === "object") {
      str = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("; ");
    } else if (value === true) {
      str = "";
    } else if (value === false) {
      continue;
    } else {
      str = String(value);
    }
    out[name] = str;
  }
  return out;
}

/**
 * 读取数值属性（colspan / rowspan）：兼容 kebab-case 与 property-information
 * 规范化后的 camelCase 键名、number 与 string 值类型；缺失 / 非法 / < 1 一律
 * 回落为 1（无合并）。只认「数值且 ≥ 2」为真实合并。
 */
export function readNumberAttr(
  props: Record<string, unknown> | undefined,
  name: "colspan" | "rowspan",
): number {
  const p = props ?? {};
  const camel = name === "colspan" ? "colSpan" : "rowSpan";
  const v = p[name] ?? p[camel];
  const n = typeof v === "number" ? v : Number(String(v ?? ""));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
