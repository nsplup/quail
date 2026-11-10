/**
 * HTML → Markdown 转换（编辑器粘贴 text/html 分支用）。
 *
 * 复用项目的 unified 管线：rehype-parse（HTML → hast，fragment 模式）→
 * rehype-remark（hast → mdast 桥）→ remark-gfm + remark-stringify
 * （mdast → markdown）。img 标签的链接（src）经默认 handler 原样保留，
 * 不做改写、不本地化。
 *
 * SHIFT 粘贴（stripStyles = true）：彻底拉平为"无样式纯文本"——
 * 标题降级为段落；加粗/斜体/删除线/链接/行内代码褪壳为纯文本；
 * 列表展平为独立段落（丢弃项目符号与序号）；引用褪壳；
 * 表格展平为逐行段落（单元格内容空格拼接）；代码块褪壳为段落；
 * 分割线丢弃；原始 HTML 节点转为纯文本段落。
 * **图片节点（image / imageReference）原样保留**——图文混排时图片必须存活。
 *
 * 类型说明：hast-util-to-mdast 输出的 mdast Root 与 @types/mdast 兼容，
 * 转换 Walker 按裸结构处理（unist 树均为普通对象）。
 */
import { unified } from "unified";
import type { Root as MdastRoot } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";

/** 行内样式节点类型：SHIFT 粘贴时褪壳为子内容 */
const INLINE_STYLE_TYPES = new Set(["strong", "emphasis", "delete", "link"]);

interface AnyNode {
  type: string;
  value?: string;
  children?: AnyNode[];
  [key: string]: unknown;
}

/** 行内级降级：样式节点褪壳，inlineCode → text，text/break/image 原样 */
function stripInlineNodes(children: AnyNode[]): AnyNode[] {
  const out: AnyNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
      case "break":
      case "image":
      case "imageReference":
        out.push(child);
        break;
      case "inlineCode":
        out.push({ type: "text", value: child.value ?? "" });
        break;
      default:
        if (INLINE_STYLE_TYPES.has(child.type)) {
          out.push(...stripInlineNodes(child.children ?? []));
        } else {
          // 其他未知行内节点：原样保留（不丢内容，不递归重入）
          out.push(child);
        }
    }
  }
  return out;
}

/** 把行内节点摊平为纯文本（表格单元格拼接等辅助用） */
function collectText(nodes: AnyNode[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.type === "text") s += n.value ?? "";
    else if (n.type === "break") s += " "; // 单元格内换行拉平为空格
    else if (n.children) s += collectText(n.children);
  }
  return s;
}

/** 把内联序列按 break 节点拆成若干段落（strip 模式专用）。
 *  HTML `<br>` → mdast break，strip 后若原样输出，remark-stringify
 *  会用硬换行语法（行尾 `\`）连接两行——与"无样式纯文本"语义不符。
 *  改为按 break 拆段：每个"行"独立成段，源码与渲染都干净。 */
function splitParagraphByBreaks(inlines: AnyNode[]): AnyNode[] {
  const groups: AnyNode[][] = [[]];
  for (const n of inlines) {
    if (n.type === "break") {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(n);
    }
  }
  return groups
    .filter((g) => g.length > 0)
    .map((g) => ({ type: "paragraph", children: g }));
}

/**
 * 块级降级：每个块展开为若干段落级节点。
 * - heading / paragraph → 重排行内；
 * - blockquote → 褪壳（递归子块展开，不留引用包裹）；
 * - list → 每项的子块递归展开，丢弃项目符号 / 序号 / 任务勾选；
 * - code → 内容转单段落（丢弃 fence 与语言）；
 * - table → 每行一个段落，单元格内容空格拼接（丢 | 结构）；
 * - thematicBreak / definition → 丢弃；
 * - html → 转为纯文本段落（不解析，避免引入结构）；
 * - 其余未知块：原样（保守不丢内容）。
 */
function stripBlockNodes(nodes: AnyNode[]): AnyNode[] {
  const out: AnyNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
      case "paragraph": {
        const inlines = stripInlineNodes(node.children ?? []);
        out.push(...splitParagraphByBreaks(inlines));
        break;
      }
      case "blockquote":
        out.push(...stripBlockNodes(node.children ?? []));
        break;
      case "list": {
        for (const item of node.children ?? []) {
          out.push(...stripBlockNodes(item.children ?? []));
        }
        break;
      }
      case "code": {
        const value = node.value ?? "";
        if (value) {
          out.push({ type: "paragraph", children: [{ type: "text", value }] });
        }
        break;
      }
      case "table": {
        for (const row of node.children ?? []) {
          if (row.type !== "tableRow") continue;
          const cells: string[] = [];
          for (const cell of row.children ?? []) {
            const txt = collectText(stripInlineNodes(cell.children ?? []));
            if (txt) cells.push(txt);
          }
          if (cells.length > 0) {
            out.push({
              type: "paragraph",
              children: [{ type: "text", value: cells.join("  ") }],
            });
          }
        }
        break;
      }
      case "thematicBreak":
      case "definition":
        break; // 分割线无样式、定义无引用：丢弃
      case "html": {
        const value = node.value ?? "";
        if (value) {
          out.push({ type: "paragraph", children: [{ type: "text", value }] });
        }
        break;
      }
      default:
        out.push(node);
    }
  }
  return out;
}

/**
 * HTML → Markdown。strip 为 true 时丢弃样式（SHIFT 粘贴），false 保留
 * markdown 语义映射（标题/强调/链接/表格等）。
 */
export function htmlToMarkdown(html: string, strip = false): string {
  const proc = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark);
  const hast = proc.parse(html);
  const mdast = proc.runSync(hast) as AnyNode;
  if (strip) {
    mdast.children = stripBlockNodes(mdast.children ?? []);
  }
  const out = unified().use(remarkGfm).use(remarkStringify, { bullet: "-" });
  // stringify 形参是 mdast.Root（强制要求 children）；AnyNode 带 unknown
  // 索引签名与之不兼容，两步 cast 收窄。stringify 返回 string，无需 String()
  return out.stringify(mdast as unknown as MdastRoot).trim();
}