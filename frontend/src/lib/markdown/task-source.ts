/**
 * 可编辑复选框（GFM 任务列表项）的源码侧支撑模块（主线程，
 * EditableCheckbox.svelte 专属，与 table-source.ts 同构的最小实现）。
 *
 * 职责：在编辑器源码的指定行区间内定位 GFM 任务标记行（`- [ ]` /
 * `- [x]`），供预览区复选框反向更新（切换 `[ ]` ↔ `[x]`）使用。
 *
 * 定位策略与可编辑表格一致：种子区间优先（复选框所在预览块的行界，
 * 来自 blocks$ 的 startLine/endLine），行号 1-based 闭区间。
 * 区间内任务标记行与该块渲染出的 task-list-item 在文档顺序上一一对应，
 * 故组件侧用「渲染序号」即可对位到具体源码行（同块内多级嵌套任务
 * 列表同样成立：渲染序 = 源码序）。
 *
 * 与渲染的关系：复选框的「显示状态」完全来自增量解析 worker 产出的
 * HAST（input 的 checked 属性）；本模块只服务于「反向更新」所需的
 * 源码行读写，不引入第二条解析链路。
 */

/** 源码内定位到的单个任务标记行 */
export interface TaskLineInfo {
  /** 行号（1-based） */
  line: number;
  /** 行内 '[' 的字符偏移（0-based）；勾选标记字符偏移 = bracketOffset + 1 */
  bracketOffset: number;
  /** 当前标记字符（" " / "x" / "X"） */
  marker: string;
}

/**
 * 任务标记行匹配：列表标记（- * + 或有序 1. / 1)）后跟 [ ] / [x] / [X]。
 * 允许前导空白与引用标记（`> `）——引用块内的任务列表同样可编辑。
 */
const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/;

/** 在 [startLine, endLine]（1-based 闭区间）内按顺序收集任务标记行 */
export function findTaskMarkerLines(doc: string, startLine: number, endLine: number): TaskLineInfo[] {
  if (startLine > endLine || endLine < 1) return [];
  const lines = doc.split("\n");
  const res: TaskLineInfo[] = [];
  for (let i = Math.max(1, startLine); i <= endLine && i <= lines.length; i++) {
    const m = TASK_LINE_RE.exec(lines[i - 1]);
    if (m) {
      res.push({ line: i, bracketOffset: m[1].length - 1, marker: m[2] });
    }
  }
  return res;
}

/**
 * 切换整行源码的任务标记字符（" " → "x"；x/X → " "），返回新行文本。
 * 非任务标记行返回 null（调用方应放弃本次反向更新）。
 * 勾选统一写入小写 "x"（GFM 常规约定）；取消勾选写回 " "。
 */
export function flipTaskMarker(lineText: string): string | null {
  const m = TASK_LINE_RE.exec(lineText);
  if (!m) return null;
  const next = m[2] === " " ? "x" : " ";
  return lineText.slice(0, m[1].length) + next + lineText.slice(m[1].length + 1);
}
