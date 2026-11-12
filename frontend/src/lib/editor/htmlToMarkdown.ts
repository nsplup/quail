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
 * HTML → Markdown
 */
export function htmlToMarkdown(html: string): string {
  const proc = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeNormalizeTableAlign);

  proc.use(rehypeRemark);

  const hast = proc.parse(html);
  const mdast = proc.runSync(hast) as AnyNode;

  const out = unified()
    .use(remarkGfm)
    .use(remarkStringify);

  return out.stringify(mdast as unknown as MdastRoot).trim();
}