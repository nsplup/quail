/**
 * 预填充的超大 Markdown 示例文档。
 * 覆盖：CommonMark 全部块/行内语法 + GFM（表格、任务列表、删除线、自动链接、脚注）+ 内嵌 HTML。
 * 通过模板段落重复生成足够大的文本，用于验证虚拟滚动性能。
 */

const FENCE = "```";

function section(n: number): string {
  const lines: string[] = [];

  lines.push(`## 第 ${n} 章：语法全景示例 ${n}`);
  lines.push("");
  lines.push(
    `这一章演示**行内语法**的完整覆盖：*斜体强调*、**粗体强调**、***粗斜体***、~~删除线~~、\`行内代码\`、[普通链接](https://example.com/${n})、[引用式链接][ref-${n}]、自动链接 <https://example.com/auto/${n}>、图片 ![示例图 ${n}](https://picsum.photos/seed/md-${n}/720/320) 以及脚注引用[^note-${n}]。`
  );
  lines.push("");
  lines.push("### 任务列表");
  lines.push("");
  lines.push("- [x] 解析 Markdown 源码为 AST");
  lines.push("- [x] 由 AST 渲染预览块");
  lines.push("- [ ] 接入真实后端保存接口");
  lines.push("    - [x] 预留 `EditorBackend` 接口");
  lines.push("    - [ ] 实现鉴权");
  lines.push("- [ ] 多人协作（远期）");
  lines.push("");
  lines.push(`### 混合列表 ${n}`);
  lines.push("");
  lines.push("1. 有序项一");
  lines.push("2. 有序项二");
  lines.push("   - 无序子项 A");
  lines.push("   - 无序子项 B");
  lines.push("     1. 再嵌套一层");
  lines.push("     2. 依然正常");
  lines.push("3. 有序项三");
  lines.push(`   > 列表中的引用块：引用可以出现在列表项内部，层级 ${n}。`);
  lines.push("");
  lines.push("### 代码块");
  lines.push("");
  lines.push(`${FENCE}ts`);
  lines.push("// TypeScript 代码块示例");
  lines.push("interface Block {");
  lines.push("  type: string;");
  lines.push("  startLine: number;");
  lines.push("  endLine: number;");
  lines.push("}");
  lines.push("");
  lines.push('export const hash = (b: Block): string => `${b.type}#${b.startLine}`;');
  lines.push(FENCE);
  lines.push("");
  lines.push(`${FENCE}bash`);
  lines.push(`# 构建示例 ${n}`);
  lines.push("npm ci && npm run build");
  lines.push(FENCE);
  lines.push("");
  lines.push(`${FENCE}json`);
  lines.push("{");
  lines.push(`  "name": "svelte-markdown-editor",`);
  lines.push(`  "chapter": ${n},`);
  lines.push(`  "features": ["ast", "virtual-scroll", "sync-scroll"]`);
  lines.push("}");
  lines.push(FENCE);
  lines.push("");
  lines.push(`缩进式代码块（4 空格触发）也支持：`);
  lines.push("");
  lines.push(`    const indented = "code block by indentation";`);
  lines.push("");
  lines.push("### 表格");
  lines.push("");
  lines.push("| 语法 | 示例 | 说明 |");
  lines.push("| :--- | :---: | ---: |");
  lines.push(`| 标题 | \`## 第 ${n} 章\` | 支持 1-6 级 |`);
  lines.push("| 表格 | 本行 | GFM 扩展 |");
  lines.push(`| 脚注 | \`[^note-${n}]\` | 文末汇总 |`);
  lines.push(`| 删除线 | \`~~文本~~\` | ~~已废弃~~ |`);
  lines.push("");
  lines.push("### 引用块");
  lines.push("");
  lines.push(`> 一级引用：AST 是唯一事实来源，预览只读、绝不反向更新源码。`);
  lines.push("> ");
  lines.push(`> > 二级嵌套引用（章节 ${n}）：保存时始终使用 Markdown 源码。`);
  lines.push("> ");
  lines.push("> - 引用中也可以有列表");
  lines.push(`> - 以及 \`行内代码\` 与 **强调**`);
  lines.push("");
  lines.push("### 内嵌 HTML");
  lines.push("");
  lines.push(`<details open>`);
  lines.push(`<summary>点击折叠的 HTML 细节块（章节 ${n}）</summary>`);
  lines.push("");
  lines.push(`HTML 块由 AST 中的 \`html\` 节点原样输出，可用于 <kbd>Ctrl</kbd> + <kbd>S</kbd> 之类的排版。`);
  lines.push("");
  lines.push(`</details>`);
  lines.push("");
  lines.push(`<p align="center">行内 HTML：<b>粗体标签</b>、<i>斜体标签</i>、<mark>高亮标记</mark></p>`);
  lines.push("");
  lines.push("### 分隔线与脚注");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`以上是第 ${n} 章的全部内容。再读一遍脚注[^note-${n}]与引用定义：`);
  lines.push("");
  lines.push(`[ref-${n}]: https://example.com/reference/${n} "引用式链接标题"`);
  lines.push(`[^note-${n}]: 这是第 ${n} 章的脚注，渲染在文末脚注区。`);
  lines.push("");

  return lines.join("\n");
}

/** 生成完整示例文档（约两千行 / 200KB 量级） */
export function buildSampleDoc(): string {
  const head: string[] = [];
  head.push("# Markdown 双栏编辑器 · 全语法示例文档");
  head.push("");
  head.push(
    "> 本文档用于演示编辑器的全部能力：AST 驱动预览、Virtua 动态高度虚拟滚动、双向同步滚动、大纲导航。下方内容重复了 50 章，体量足够触发虚拟滚动。"
  );
  head.push("");
  head.push("## 快速上手");
  head.push("");
  head.push("| 快捷键 | 作用 |");
  head.push("| --- | --- |");
  head.push("| `Ctrl/⌘ + F` | 打开查找替换面板 |");
  head.push("| `Ctrl/⌘ + S` | 保存源码（走后端占位接口） |");
  head.push("| `Esc` | 关闭查找面板 / 弹窗 |");
  head.push("");
  head.push("### 无序列表");
  head.push("");
  head.push("- 第一项");
  head.push("  - 嵌套项");
  head.push("    - 更深一层");
  head.push("      - 最深一层，仍然正确缩进");
  head.push("- 第二项");
  head.push("- 第三项");
  head.push("");
  head.push("### Setext 标题也支持");
  head.push("");
  head.push("这是一个 Setext 一级标题");
  head.push("========================");
  head.push("");
  head.push("这是一个 Setext 二级标题");
  head.push("------------------------");
  head.push("");
  head.push("### 实体与硬换行");
  head.push("");
  head.push("HTML 实体：&copy; &amp; &lt; &gt; &quot; &#9731;");
  head.push("  ");
  head.push("上一行结尾有两个空格，因此这是一个硬换行（<br> 效果）。");
  head.push("");
  head.push("***");
  head.push("");

  const sections: string[] = [];
  for (let i = 1; i <= 50; i++) sections.push(section(i));

  const tail: string[] = [];
  tail.push("## 结束语");
  tail.push("");
  tail.push(
    "到这里，示例已覆盖：ATX/Setext 标题、段落、硬换行、强调（粗/斜/粗斜/删除线）、行内代码与围栏代码块（ts/bash/json）、缩进代码块、有序/无序/嵌套/任务列表、引用（含嵌套与列表内引用）、表格、自动链接、引用式链接、图片、水平线、HTML 块与行内 HTML、实体、脚注。祝使用愉快！"
  );
  tail.push("");

  return [...head, ...sections, ...tail].join("\n");
}
