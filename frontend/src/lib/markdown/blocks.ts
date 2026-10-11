/**
 * 块映射 / 文本统计的纯函数工具（零依赖，可同时被主线程与 worker 引用）。
 *
 * - blockIndexForLine：源码行号 → 预览块下标（滚动同步 / 大纲跳转的二分映射）；
 * - blocksCoverDoc：校验块行界是否无缝覆盖整个文档（增量解析自愈判据）；
 * - countEnglishWords / countHanCharacters：字数统计（worker 内计算后回传）。
 */
import type { PreviewBlock } from "../types";

/**
 * 行号 → 预览块下标（二分查找：找到 startLine <= line 的最后一个块）。
 * 用于「编辑器 → 预览」的同步滚动。
 */
export function blockIndexForLine(blocks: PreviewBlock[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let res = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].startLine <= line) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/**
 * 校验块行界是否连续覆盖整个文档（1..行数）：
 * 通过 → 增量解析结果与全量一致，无需周期性全量重算（自愈）。
 * 空白文档（无任何可渲染块）视为已覆盖：全量解析对空白文档恒产出 0 块，
 * 若按行数严格校验会永远失败 → worker 每 10s 空转一次全量自愈。
 */
export function blocksCoverDoc(blocks: PreviewBlock[], src: string): boolean {
  if (src.trim() === "") return blocks.length === 0;
  const totalLines = src.split("\n").length;
  let expect = 1;
  for (const b of blocks) {
    if (b.startLine !== expect || b.endLine < b.startLine) return false;
    expect = b.endLine + 1;
  }
  return expect - 1 === totalLines;
}

export function countEnglishWords(text: string): number {
  const m = text.match(/[A-Za-z0-9_'’-]+/g);
  return m ? m.length : 0;
}

/** 汉字匹配（CJK 统一表意文字 + 扩展 A） */
export function countHanCharacters(text: string): number {
  const m = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g);
  return m ? m.length : 0;
}
