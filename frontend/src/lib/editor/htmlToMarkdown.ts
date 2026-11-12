/**
 * HTML → Markdown 转换（编辑器粘贴 text/html 分支用）。
 *
 * 复用项目的 unified 管线：rehype-parse（HTML → hast，fragment 模式）→
 * rehype-remark（hast → mdast 桥）→ remark-gfm + remark-stringify
 * （mdast → markdown）。img 标签的链接（src）经默认 handler 原样保留，
 * 不做改写、不本地化。
 *
 * 表格对齐：rehypeNormalizeTableAlign 把 style="text-align: ..." 归一
 * 为 align 属性，使 hast-util-to-mdast 能产出 mdast table 的 align。
 */
import { unified } from "unified";
import type { Root as MdastRoot } from "mdast";
import type { Root as HastRoot } from "hast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";

interface AnyNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: AnyNode[];
  [key: string]: unknown;
}

/** 把 style="text-align: ..." 归一为 align 属性，保留 GFM 表格对齐。 */
function rehypeNormalizeTableAlign() {
  return (tree: any): void => {
    function walk(node: AnyNode) {
      if (node.type === "element" && node.properties) {
        const tag =
          typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
        if (tag === "td" || tag === "th") {
          const style = node.properties.style;
          if (typeof style === "string" && !node.properties.align) {
            const m = /(?:^|;)\s*text-align\s*:\s*(left|center|right)/i.exec(
              style
            );
            if (m) node.properties.align = m[1].toLowerCase();
          }
        }
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) walk(c);
      }
    }
    walk(tree);
  };
}

/**
 * 可映射 Markdown 标准语义及 GFM 扩展的 HTML 标签集合：
 * - 标准：标题、段落强调（strong/b/em/i）、链接、图片、行内代码与代码块、
 *   无序/有序列表、引用、水平分割线、硬换行；
 * - GFM 扩展：删除线（del/s/strike）、表格（table 系）、任务列表（input）。
 * 段落 p 不计入：p → 纯文本，转换不产生任何 Markdown 语法增益。
 */
const CONVERTIBLE_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "del", "s", "strike",
  "a", "img", "code", "pre", "blockquote", "hr",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "input",
]);

/** 深度遍历 hast：存在任一可转换标签即视为可转换 */
function hastHasConvertibleTag(node: AnyNode): boolean {
  if (
    node.type === "element" &&
    typeof node.tagName === "string" &&
    CONVERTIBLE_TAGS.has(node.tagName.toLowerCase())
  ) {
    return true;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (hastHasConvertibleTag(c)) return true;
    }
  }
  return false;
}

/** HTML → Markdown 结果：convertible=false 时跳过转换输出管线 */
export interface HtmlToMarkdownResult {
  /** 剪贴板 HTML 是否含可映射 Markdown 语义（标准 + GFM）的标签 */
  convertible: boolean;
  /** Markdown 文本（不可转换时为空串） */
  markdown: string;
}

/**
 * HTML → Markdown（含可转换检测）：
 * 完全不存在可转换标签时跳过 rehype-remark / remark-stringify 输出
 * 管线，直接返回 { convertible: false, markdown: "" }，由调用方决定
 * 回退行为（text/html 分支回退插入纯文本）。
 */
const PARSER = unified()
  .use(rehypeParse, { fragment: true })
  .freeze();

const CONVERTER = unified()
  .use(rehypeNormalizeTableAlign)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify)
  .freeze();

export function htmlToMarkdown(html: string): HtmlToMarkdownResult {
  const hast = PARSER.parse(html) as HastRoot;

  if (!hastHasConvertibleTag(hast as unknown as AnyNode)) {
    return { convertible: false, markdown: "" };
  }

  const mdast = CONVERTER.runSync(hast) as unknown as MdastRoot;
  return { convertible: true, markdown: CONVERTER.stringify(mdast).trim() };
}