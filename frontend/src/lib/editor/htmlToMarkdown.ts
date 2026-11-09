/**
 * HTML → Markdown 转换（编辑器粘贴 text/html 分支用）。
 *
 * 复用项目的 unified 管线：rehype-parse（HTML → hast，fragment 模式）→
 * rehype-remark（hast → mdast 桥）→ remark-gfm + remark-stringify
 * （mdast → markdown）。img 标签的链接（src）经默认 handler 原样保留，
 * 不做改写、不本地化。
 *
 * SHIFT 粘贴（stripStyles = true）：丢弃 HTML 样式——标题降级为段落、
 * 加粗/斜体/删除线/链接褪壳为纯文本、行内代码褪壳为纯文本；图文混排时
 * 图片（image 节点）原样保留（`![alt](src)`）。块级结构（列表 / 引用 /
 * 代码块 / 表格）不属于"样式"，保留。
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
const INLINE_STYLE_TYPES = new Set([
  "strong",
  "emphasis",
  "delete",
  "link",
]);

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
          // 其他未知行内节点：原样保留（不丢失内容，不递归重入）
          out.push(child);
        }
    }
  }
  return out;
}

/** 块级降级：heading → paragraph，paragraph 重排行内，容器递归 */
function stripBlockNode(node: AnyNode): AnyNode {
  switch (node.type) {
    case "heading":
      return { ...node, type: "paragraph", children: stripInlineNodes(node.children ?? []) };
    case "paragraph":
      return { ...node, children: stripInlineNodes(node.children ?? []) };
    case "blockquote":
      return { ...node, children: (node.children ?? []).map(stripBlockNode) };
    case "list": {
      return {
        ...node,
        children: (node.children ?? []).map((item) => ({
          ...item,
          children: (item.children ?? []).map(stripBlockNode),
        })),
      };
    }
    default:
      return node; // code / table / thematicBreak / html 等结构原样
  }
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
    mdast.children = (mdast.children ?? []).map(stripBlockNode);
  }
  const out = unified().use(remarkGfm).use(remarkStringify, { bullet: "-" });
  // stringify 形参是 mdast.Root（强制要求 children）；AnyNode 带 unknown
  // 索引签名与之不兼容，两步 cast 收窄。stringify 返回 string，无需 String()
  return out.stringify(mdast as unknown as MdastRoot).trim();
}