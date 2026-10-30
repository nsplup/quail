/**
 * 可编辑表格右键菜单：行 / 列操作纯函数测试。
 * 覆盖点：
 * - 插入 / 移动 / 复制 / 删除的矩阵结果
 * - 越界语义（首行上移 / 末行下移 / 首列左移 / 末列右移均 no-op）
 * - 对齐数组与行的同步（插入 / 移动 / 复制 / 删除列）
 * - 复制语义：浅克隆（不共享 cell 引用，改副本不影响原行/原列）
 */
import { describe, expect, it } from "vitest";
import { markdownCell, type CellSource, type TableAlign } from "../table-source";
import {
  insertRow,
  insertCol,
  moveRow,
  moveCol,
  copyRow,
  copyCol,
  deleteRow,
  deleteCol,
} from "../table-ops";

/* 便捷构造：按 raw 矩阵造 rows */
function makeRows(...grid: string[][]): CellSource[][] {
  return grid.map((row) => row.map((raw) => markdownCell(raw)));
}

function raws(rows: CellSource[][]): string[][] {
  return rows.map((row) => row.map((cell) => cell.raw));
}

describe("右键菜单 · 行操作", () => {
  it("行上方插入：新行含 colCount 个空单元格", () => {
    const rows = makeRows(["a", "b"], ["c", "d"]);
    insertRow(rows, 0, 2);
    expect(raws(rows)).toEqual([
      ["", ""],
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("行下方插入：插到指定行之后", () => {
    const rows = makeRows(["a"], ["b"]);
    insertRow(rows, 1, 1);
    expect(raws(rows)).toEqual([["a"], [""], ["b"]]);
  });

  it("上移 / 下移：与相邻行交换", () => {
    const rows = makeRows(["a"], ["b"], ["c"]);
    moveRow(rows, 1, -1);
    expect(raws(rows)).toEqual([["b"], ["a"], ["c"]]);
    moveRow(rows, 1, 1);
    expect(raws(rows)).toEqual([["b"], ["c"], ["a"]]);
  });

  it("首行上移 / 末行下移：越界 no-op", () => {
    const rows = makeRows(["a"], ["b"]);
    moveRow(rows, 0, -1);
    moveRow(rows, 1, 1);
    expect(raws(rows)).toEqual([["a"], ["b"]]);
  });

  it("复制行：浅克隆插到当前行之后，不与原行共享 cell 引用", () => {
    const rows = makeRows(["a"], ["b"]);
    copyRow(rows, 0);
    expect(raws(rows)).toEqual([["a"], ["a"], ["b"]]);
    expect(rows[0][0]).not.toBe(rows[1][0]);
    /* 修改副本不影响原行 */
    rows[1][0].raw = "x";
    expect(rows[0][0].raw).toBe("a");
  });

  it("删除行：从矩阵中移除指定行", () => {
    const rows = makeRows(["a"], ["b"], ["c"]);
    deleteRow(rows, 1);
    expect(raws(rows)).toEqual([["a"], ["c"]]);
  });
});

describe("右键菜单 · 列操作", () => {
  it("列左侧插入：每行同位置插空单元格，对齐同步插 null", () => {
    const rows = makeRows(["a", "b"], ["c", "d"]);
    const aligns: (TableAlign | null)[] = ["left", "right"];
    insertCol(rows, aligns, 0);
    expect(raws(rows)).toEqual([
      ["", "a", "b"],
      ["", "c", "d"],
    ]);
    expect(aligns).toEqual([null, "left", "right"]);
  });

  it("列右侧插入：插到指定列之后", () => {
    const rows = makeRows(["a", "b"]);
    const aligns: (TableAlign | null)[] = ["left", "right"];
    insertCol(rows, aligns, 1);
    expect(raws(rows)).toEqual([["a", "", "b"]]);
    expect(aligns).toEqual(["left", null, "right"]);
  });

  it("左移 / 右移：所有行同位交换，对齐同步", () => {
    const rows = makeRows(["a", "b", "c"]);
    const aligns: (TableAlign | null)[] = ["left", "center", "right"];
    moveCol(rows, aligns, 1, -1);
    expect(raws(rows)).toEqual([["b", "a", "c"]]);
    expect(aligns).toEqual(["center", "left", "right"]);
    moveCol(rows, aligns, 1, 1);
    expect(raws(rows)).toEqual([["b", "c", "a"]]);
    expect(aligns).toEqual(["center", "right", "left"]);
  });

  it("首列左移 / 末列右移：越界 no-op", () => {
    const rows = makeRows(["a", "b"]);
    const aligns: (TableAlign | null)[] = ["left", "right"];
    moveCol(rows, aligns, 0, -1);
    moveCol(rows, aligns, 1, 1);
    expect(raws(rows)).toEqual([["a", "b"]]);
    expect(aligns).toEqual(["left", "right"]);
  });

  it("复制列：浅克隆插到当前列之后，对齐同步复制、不共享引用", () => {
    const rows = makeRows(["a", "b"]);
    const aligns: (TableAlign | null)[] = ["left", "right"];
    copyCol(rows, aligns, 0);
    expect(raws(rows)).toEqual([["a", "a", "b"]]);
    expect(aligns).toEqual(["left", "left", "right"]);
    expect(rows[0][0]).not.toBe(rows[0][1]);
    rows[0][1].raw = "x";
    expect(rows[0][0].raw).toBe("a");
  });

  it("删除列：所有行同位删除，对齐同步", () => {
    const rows = makeRows(["a", "b", "c"], ["d", "e", "f"]);
    const aligns: (TableAlign | null)[] = ["left", "center", "right"];
    deleteCol(rows, aligns, 1);
    expect(raws(rows)).toEqual([
      ["a", "c"],
      ["d", "f"],
    ]);
    expect(aligns).toEqual(["left", "right"]);
  });
});

describe("右键菜单 · 对齐数组一致性", () => {
  it("复制行不影响对齐（行操作不涉及 aligns）", () => {
    const rows = makeRows(["a"], ["b"]);
    const aligns: (TableAlign | null)[] = ["center"];
    copyRow(rows, 0);
    expect(aligns).toEqual(["center"]);
  });

  it("连续 copyCol 后 aligns 长度 = 列数", () => {
    const rows = makeRows(["a", "b"]);
    const aligns: (TableAlign | null)[] = ["left", "right"];
    copyCol(rows, aligns, 0);
    copyCol(rows, aligns, 2);
    expect(aligns).toEqual(["left", "left", "right", "right"]);
    expect(rows[0].length).toBe(4);
  });
});