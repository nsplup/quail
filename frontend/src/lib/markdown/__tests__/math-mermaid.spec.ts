/**
 * LaTeX（md-math）与 Mermaid 引入的管线测试：
 *
 * - remark-math 语法接入：$$...$$ → md-math[data-display="1"]（顶层独立
 *   节点，自动获得行号锚独立成段/块）、$...$ → md-math[data-display="0"]；
 * - sanitize 存活：md-math 进 tagNames 白名单后穿透 rehype-raw / sanitize；
 * - mermaid 围栏：language-mermaid class 由 mdast-util-to-hast 默认 code
 *   handler 产出（MarkdownNode 分派 MermaidBlock 的判定依据）；
 * - 查找彻底排除（isSearchExcluded）：md-math 与 mermaid 围栏源码不参与
 *   展平匹配（不计数 / 不导航 / 不装饰）；flattenHastText 与
 *   applyMarksToNodes 双侧同步跳过后偏移仍严格对齐（跨排除节点的命中
 *   区间仍正确落到目标文本上）；
 * - 表格单元格路径：decorateCellMap 共享同一排除口径（单元格内行内公式
 *   被剔除，其余文本照常装饰）。
 */
import { describe, expect, it } from "vitest";
import type { Element, ElementContent, RootContent } from "hast";
import {
  parseMarkdown,
  convertRoot,
  splitSegments,
  blocksFromHast,
} from "../markdown-core";
import {
  flattenHastText,
  findRanges,
  applyMarksToNodes,
  decorateCellMap,
} from "../../preview/previewSearch";

/** 收集子树中第一个匹配 tagName 的元素 */
function firstEl(nodes: RootContent[], tagName: string): Element | null {
  for (const n of nodes) {
    if (n.type === "element") {
      if (n.tagName === tagName) return n;
      const inner = firstEl(n.children as RootContent[], tagName);
      if (inner) return inner;
    }
  }
  return null;
}

/** 收集子树全部文本（含 md-math / code 源码——与 flatten 口径无关） */
function collectAllText(nodes: RootContent[]): string {
  let out = "";
  const walk = (n: RootContent): void => {
    if (n.type === "text") {
      out += n.value;
      return;
    }
    if (n.type === "element") for (const c of n.children) walk(c as RootContent);
  };
  for (const n of nodes) walk(n);
  return out;
}

const MD = [
  "# 数学与图表",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "行内 $x + y$ 公式混排。",
  "",
  "```mermaid",
  "graph TD",
  "A --> B",
  "```",
  "",
].join("\n");

describe("管线：remark-math 语法接入", () => {
  const root = parseMarkdown(MD);
  const { hast } = convertRoot(root);

  it("$$ 块 → md-math[data-display=1]，LaTeX 源码原样承载", () => {
    const math = firstEl(hast.children as RootContent[], "md-math");
    expect(math).not.toBeNull();
    expect((math!.properties as Record<string, unknown>)["data-display"]).toBe("1");
    expect(collectAllText(math!.children as RootContent[])).toContain("E = mc^2");
  });

  it("行内 $ → md-math[data-display=0]，嵌在段落内", () => {
    // 第一处 md-math 是 $$ 块；行内的取 p 内的
    const p = (hast.children as RootContent[]).find(
      (n) =>
        n.type === "element" &&
        (n as Element).tagName === "p" &&
        firstEl(n.children as RootContent[], "md-math"),
    ) as Element | undefined;
    expect(p).toBeDefined();
    const im = firstEl(p!.children as RootContent[], "md-math")!;
    expect((im.properties as Record<string, unknown>)["data-display"]).toBe("0");
    expect(collectAllText(im.children as RootContent[])).toContain("x + y");
  });

  it("mermaid 围栏 → pre>code.language-mermaid（分派判定依据）", () => {
    const pre = (hast.children as RootContent[]).find(
      (n) => n.type === "element" && (n as Element).tagName === "pre",
    ) as Element | undefined;
    expect(pre).toBeDefined();
    const code = firstEl(pre!.children as RootContent[], "code")!;
    const cls = (code.properties as Record<string, unknown>)?.["className"];
    const list = Array.isArray(cls) ? cls.map(String) : [];
    expect(list).toContain("language-mermaid");
    expect(collectAllText(code.children as RootContent[])).toContain("graph TD");
  });

  it("sanitize 后 md-math 存活（tagNames 白名单生效）", () => {
    // convertRoot 已含 rehype-raw 融合 + sanitize（见实现）；此处分段再验
    const segs = splitSegments(hast);
    const mathSeg = segs.find((s) =>
      s.nodes.some(
        (n) => n.type === "element" && (n as Element).tagName === "md-math",
      ),
    );
    expect(mathSeg).toBeDefined();
  });

  it("$$ 块独立成段且块行界无缝覆盖（锚点自动注入）", () => {
    const segs = splitSegments(hast);
    // 段 1 = $$ 块（首个内容节点为 md-math，锚 comment 不计入 nodes）
    expect(segs.length).toBeGreaterThanOrEqual(3);
    const firstContent = segs[1]?.nodes[0];
    expect(firstContent?.type).toBe("element");
    expect((firstContent as Element).tagName).toBe("md-math");
    const blocks = blocksFromHast(hast, MD.split("\n").length).blocks;
    // 行界无缝覆盖：相邻块首尾衔接
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startLine).toBe(blocks[i - 1].endLine + 1);
    }
  });
});

describe("查找彻底排除：md-math / mermaid 围栏", () => {
  const mdMathEl = (tex: string, display: "1" | "0"): Element =>
    ({
      type: "element",
      tagName: "md-math",
      properties: { "data-display": display },
      children: [{ type: "text", value: tex }],
    }) as unknown as Element;

  const pEl = (text: string): Element =>
    ({
      type: "element",
      tagName: "p",
      properties: {},
      children: [{ type: "text", value: text }],
    }) as Element;

  const mermaidPre = (code: string): Element =>
    ({
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-mermaid"] },
          children: [{ type: "text", value: code }],
        },
      ],
    }) as Element;

  it("md-math 源码不参与展平（跨它的命中区间仍正确映射）", () => {
    const nodes: RootContent[] = [
      pEl("before"),
      mdMathEl("E = mc^2", "1"),
      pEl("after"),
    ];
    // 展平剔除公式源码：不含 E = mc^2，前后文本照常
    const flat = flattenHastText(nodes);
    expect(flat).not.toContain("E = mc");
    expect(flat).toContain("before");
    expect(flat).toContain("after");
    // 偏移对齐验证：命中 "after" → 装饰正确落到第二个 p 上（双侧同步跳过）
    const ranges = findRanges(flat, /after/g);
    expect(ranges.length).toBe(1);
    const marked = applyMarksToNodes(nodes,
      ranges.map(([s, e], i) => ({ s, e, id: i })),
    );
    const marks: string[] = [];
    const walk = (ns: RootContent[]): void => {
      for (const n of ns) {
        if (n.type === "element" && n.tagName === "mark") {
          marks.push(collectAllText(n.children as RootContent[]));
        }
        if (n.type === "element") walk(n.children as RootContent[]);
      }
    };
    walk(marked);
    expect(marks).toEqual(["after"]);
    // 排除子树原样保留（未被误切分）
    const math = firstEl(marked, "md-math")!;
    expect(collectAllText(math.children as RootContent[])).toBe("E = mc^2");
  });

  it("mermaid 围栏源码不参与展平", () => {
    const nodes: RootContent[] = [pEl("前文"), mermaidPre("graph TD\nA --> B")];
    const flat = flattenHastText(nodes);
    expect(flat).toContain("前文");
    expect(flat).not.toContain("graph");
    expect(findRanges(flat, /graph/g).length).toBe(0);
  });

  it("普通代码块不受排除影响（language-ts 照常匹配）", () => {
    const nodes: RootContent[] = [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: ["language-ts"] },
            children: [{ type: "text", value: "const graph = 1;" }],
          },
        ],
      } as Element,
    ];
    expect(findRanges(flattenHastText(nodes), /graph/g).length).toBe(1);
  });

  it("decorateCellMap 同口径：单元格内行内公式被剔除", () => {
    const cell: ElementContent[] = [
      { type: "text", value: "甲" },
      mdMathEl("x+y", "0"),
      { type: "text", value: "乙乙" },
    ] as unknown as ElementContent[];
    const out = decorateCellMap(new Map([["k", cell]]), {
      active: true,
      re: /乙乙/g,
    });
    const decorated = out.get("k")!;
    const marks: string[] = [];
    const walk = (ns: RootContent[]): void => {
      for (const n of ns) {
        if (n.type === "element" && n.tagName === "mark") {
          marks.push(collectAllText(n.children as RootContent[]));
        }
        if (n.type === "element") walk(n.children as RootContent[]);
      }
    };
    walk(decorated as RootContent[]);
    expect(marks).toEqual(["乙乙"]);
    expect(collectAllText(decorated as RootContent[])).toContain("x+y");
  });
});
