/**
 * 可编辑表格右键菜单的行 / 列操作。
 * 纯函数：直接就地修改传入的 rows / aligns 矩阵，不做 I/O。
 * 组件在 apply 里调用，然后统一 writeBack 回写。
 *
 * 约定：
 * - 行 = 单元格数组；aligns 与列同长，null 表示未指定对齐；
 * - 复制操作对 cell 做浅拷贝（结构体不共享引用），跨行/列复制后
 *   编辑副本不影响原单元格的 raw/lang/attrs；
 * - 越界（首行上移 / 末行下移 / 首列左移 / 末列右移）直接 no-op。
 */
import { emptyCell, type CellSource, type TableAlign } from "./table-source";

function colCount(rows: CellSource[][]): number {
  return rows.reduce((m, r) => Math.max(m, r.length), 0);
}

/** 在 at 行前插入一行（含 cols 个空单元格） */
export function insertRow(rows: CellSource[][], at: number, cols: number): void {
  rows.splice(at, 0, Array.from({ length: cols }, () => emptyCell()));
}

/** 在 at 列前插入一列（每行同位置插入空单元格，对齐同步插入 null） */
export function insertCol(
  rows: CellSource[][],
  aligns: (TableAlign | null)[],
  at: number,
): void {
  for (const row of rows) row.splice(at, 0, emptyCell());
  aligns.splice(at, 0, null);
}

/** 上/下移行：与相邻行交换；越界不变 */
export function moveRow(rows: CellSource[][], from: number, dir: -1 | 1): void {
  const to = from + dir;
  if (to < 0 || to >= rows.length) return;
  [rows[from], rows[to]] = [rows[to], rows[from]];
}

/** 左/右移列：所有行同位交换，对齐同步；越界不变 */
export function moveCol(
  rows: CellSource[][],
  aligns: (TableAlign | null)[],
  from: number,
  dir: -1 | 1,
): void {
  const to = from + dir;
  if (to < 0 || to >= colCount(rows)) return;
  for (const row of rows) {
    [row[from], row[to]] = [row[to], row[from]];
  }
  [aligns[from], aligns[to]] = [aligns[to], aligns[from]];
}

/** 复制行：浅克隆插到 from 之后，不共享 cell 引用 */
export function copyRow(rows: CellSource[][], from: number): void {
  rows.splice(from + 1, 0, (rows[from] ?? []).map((cell) => ({ ...cell })));
}

/** 复制列：浅克隆插到 from 之后，对齐同步复制 */
export function copyCol(
  rows: CellSource[][],
  aligns: (TableAlign | null)[],
  from: number,
): void {
  for (const row of rows) {
    row.splice(from + 1, 0, row[from] ? { ...row[from] } : emptyCell());
  }
  aligns.splice(from + 1, 0, aligns[from] ?? null);
}

/** 删除行 */
export function deleteRow(rows: CellSource[][], at: number): void {
  rows.splice(at, 1);
}

/** 删除列：所有行同位删除，对齐同步 */
export function deleteCol(
  rows: CellSource[][],
  aligns: (TableAlign | null)[],
  at: number,
): void {
  for (const row of rows) row.splice(at, 1);
  aligns.splice(at, 1);
}