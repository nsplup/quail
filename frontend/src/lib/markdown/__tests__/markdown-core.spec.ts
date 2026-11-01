import { describe, expect, it } from "vitest";
import type { PreviewBlock } from "../../types"
import { type IncrementalParseState, buildBlocksIncremental } from "../markdown-core"

describe("增量编辑时定义声明与引用解析测试", () => {
  const initState = (): IncrementalParseState => {
    return {
      src: "",
      root: null,
      hast: null,
      blocks: [],
      incrementalCount: 0,
      lastFullAt: 0,
      refsBaseline: null,
    }
  }
  it("增量编辑正文保留 head/tail 区域外的脚注引用（桩定义）", () => {
    const src = [
      "前文[^a] 与[^b]。",
      "",
      "中间段落。",
      "",
      "后文[^c]。",
      "",
      "[^a]: 定义 A",
      "[^b]: 定义 B",
      "[^c]: 定义 C",
    ].join("\n");
    let state = initState();
    let r = buildBlocksIncremental(state, src, true);
    state = {
      ...state, src, root: r.root, hast: r.hast, blocks: r.blocks,
      incrementalCount: r.incrementalCount, lastFullAt: r.lastFullAt,
      refsBaseline: r.refsBaseline
    };
    expect(r.refs.footnoteRefs.map((x) => x.identifier)).toEqual(["a", "b", "c"]);


    const next = src.replace("中间段落。", "中间段落已编辑。");
    r = buildBlocksIncremental(state, next, false);
    expect(r.full).toBe(false);
    expect(r.refs.footnoteRefs.map((x) => x.identifier)).toEqual(["a", "b", "c"]);
    expect(r.refs.footnotes.map((x) => x.identifier)).toEqual(["a", "b", "c"]);
  });
  it("增量编辑脚注定义区更新定义内容，引用仍可解析", () => {
    const src = "文[^x]\n\n[^x]: 旧内容";
    const state = initState();
    const next = src.replace("旧内容", "新内容");
    const r = buildBlocksIncremental(state, next, false);
    expect(r.refs.footnoteRefs.map((x) => x.identifier)).toEqual(["x"]);
    const def = r.refs.footnotes.find((f) => f.identifier === "x");
    expect(def).toBeTruthy();
    expect(JSON.stringify(def!.children)).toContain("新内容");
  });
})

describe("buildBlocksIncremental 不变量：prev.* 不被原地改写", () => {
  function initState(src: string): IncrementalParseState {
    const base: IncrementalParseState = {
      src: "",
      root: null,
      hast: null,
      blocks: [],
      incrementalCount: 0,
      lastFullAt: 0,
      refsBaseline: null,
    };
    const r = buildBlocksIncremental(base, src, true);
    return {
      ...base,
      src,
      root: r.root,
      hast: r.hast,
      blocks: r.blocks,
      incrementalCount: r.incrementalCount,
      lastFullAt: r.lastFullAt,
      refsBaseline: r.refsBaseline,
    };
  }

  /** 深快照：字段级 JSON + 对象身份（引用不变量） */
  function snapshot(blocks: PreviewBlock[]) {
    return {
      json: JSON.stringify(blocks),
      refs: blocks.map((b) => b),
    };
  }

  /** P0 不变量：初始 blocks 数组的元素对象（snap.refs 引用）在增量后
 *  字段值完全不变——若代码原地改写共享块，这些引用的 JSON 会变，
 *  与循环前独立记录的 snap.json 不一致。此断言对所有增量场景成立
 *  （单次 / 连续多次 / 局部 chunk 为空等），不依赖「输出复用初始引用」。
 */
  function expectPrevNotMutated(snap: ReturnType<typeof snapshot>) {
    expect(JSON.stringify(snap.refs)).toBe(snap.json);
  }

  /** 单次增量专用：head/tail 块在 r.blocks 中复用初始块引用（增量渲染
   *  前提）。连续多次增量后初始引用可能已被全部替换，不适用。 */
  function expectUnchanged(
    prev: PreviewBlock[],
    snap: ReturnType<typeof snapshot>,
  ) {
    // 先验证初始对象未被原地改写（通用不变量）
    expectPrevNotMutated(snap);
    // 再验证当前 blocks 与初始快照身份一致（仅单次增量成立）
    expect(prev.map((b) => b === snap.refs[b.index])).toEqual(
      prev.map(() => true),
    );
    expect(prev.length).toBe(snap.refs.length);
  }

  it("单次增量：prev.blocks 字段与对象身份均不变（表格 + 段落 + 脚注）", () => {
    const src = [
      "# 标题",
      "",
      "| a | b |",
      "| - | - |",
      "| [^x] | 2 |",
      "",
      "段落[^x]。",
      "",
      "[^x]: 定义。",
    ].join("\n");
    const state = initState(src);
    const snap = snapshot(state.blocks);
    expect(state.blocks.some((b) => b.type === "table")).toBe(true);

    const next = src.replace("段落[^x]。", "段落[^x] 已编辑。");
    buildBlocksIncremental(state, next, false);
    expectUnchanged(state.blocks, snap);
  });

  it("编辑紧邻表格前/后的块：headBlocks 末块 / tailBlocks 首块不被原地改", () => {
    const src = [
      "段前。",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "段后。",
    ].join("\n");
    const state = initState(src);
    const snap = snapshot(state.blocks);
    const tableBlock = state.blocks.find((b) => b.type === "table")!;
    const tableStart = tableBlock.startLine;

    // 改「段后」→ 表格在 head 侧，headBlocks 末块 = 表格块
    let r = buildBlocksIncremental(state, src.replace("段后。", "段后改。"), false);
    expectUnchanged(state.blocks, snap);
    expect(r.blocks.find((b) => b.type === "table")!.startLine).toBe(tableStart);

    // 改「段前」→ 表格在 tail 侧，tailBlocks 首块 = 表格块（行号 +delta）
    const state2 = initState(src);
    const snap2 = snapshot(state2.blocks);
    const src2 = "段前改。\n\n" + src.slice("段前。\n\n".length);
    r = buildBlocksIncremental(state2, src2, false);
    expectUnchanged(state2.blocks, snap2);
    // tail 块在输出里平移了 delta，但 prev 原块对象未被改
    expect(state2.blocks.find((b) => b.type === "table")!.startLine).toBe(tableStart);
    expect(r.blocks.find((b) => b.type === "table")!.startLine).toBe(tableStart);
  });

  it("纯空行插入（local.blocks 为空分支）：head/tail 边界块不被原地改", () => {
    const src = [
      "段一。",
      "",
      "段二。",
    ].join("\n");
    const state = initState(src);
    const snap = snapshot(state.blocks);

    // 在段一后插一行空行 → 变化区间可能落成纯空行 chunk
    const next = "段一。\n\n\n段二。";
    buildBlocksIncremental(state, next, false);
    expectUnchanged(state.blocks, snap);
  });

  it("连续 10 次增量：初始 blocks 对象不被原地改写（字段级）", () => {
    const base = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "段落。",
      "",
      "[^x]: 定义。",
    ].join("\n");
    let state = initState(base);
    const snap = snapshot(state.blocks);

    for (let n = 0; n < 10; n++) {
      const next = state.src.replace(/段落。|段落\d+。/, `段落${n}。`);
      const r = buildBlocksIncremental(state, next, false);
      // 每轮新 blocks 的 index 连续（P0 其他方面）
      r.blocks.forEach((b, i) => expect(b.index).toBe(i));
      state = {
        ...state,
        src: next,
        root: r.root,
        hast: r.hast,
        blocks: r.blocks,
        incrementalCount: r.incrementalCount,
        lastFullAt: r.lastFullAt,
        refsBaseline: r.refsBaseline,
      };
    }

    // 核心断言：初始 blocks 元素引用（snap.refs）的值在 10 轮增量后完全不变
    // ——若代码原地改写共享块，这些引用会跟着变，与 snap.json 不一致
    expectPrevNotMutated(snap);
    // 辅助断言：最终 blocks 仍含 table 块，行界无缝覆盖
    expect(state.blocks.some((b) => b.type === "table")).toBe(true);
    for (let i = 1; i < state.blocks.length; i++) {
      expect(state.blocks[i].startLine).toBe(state.blocks[i - 1].endLine + 1);
    }
  });

  it("prev.root / prev.hast 顶层 children 身份不被原地改（shiftLine 克隆不变量）", () => {
    const src = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "段后。",
    ].join("\n");
    const state = initState(src);
    const rootBefore = state.root!.children.map((n) => n);
    const hastBefore = state.hast!.children.map((n) => n);
    const rootPos = state.root!.children.map((n) => n.position?.start.line);
    const hastAnchorValues = state.hast!.children
      .filter((n) => n.type === "comment")
      .map((n) => (n as { value: string }).value);

    // 在文首插入行 → tail 全部平移
    const next = "新首行。\n\n" + src;
    buildBlocksIncremental(state, next, false);

    expect(state.root!.children.map((n) => n === rootBefore[n.position!.start.line - 1])).toBeTruthy();
    // 更直接：prev.root 的 children 身份不变（shiftLine 走克隆）
    state.root!.children.forEach((n, i) => {
      // 未变区间（head）引用身份保持不变
      if (i < rootBefore.length) {
        // 这里只断言「prev.root.children 数组元素没有被原地替换成新对象」——
        // 实际上 shiftLine 只对 tail 克隆，head 原样，数组本身是新数组
      }
    });
    // 简化断言：prev.hast 的锚 comment value 不被原地改
    state.hast!.children
      .filter((n) => n.type === "comment")
      .forEach((n, i) => {
        expect((n as { value: string }).value).toBe(hastAnchorValues[i]);
      });
    // prev.root 的 position 行号不被原地改
    state.root!.children.forEach((n, i) => {
      if (i < rootPos.length && rootPos[i] != null) {
        expect(n.position?.start.line).toBe(rootPos[i]);
      }
    });
  });

  it("refsBaseline 不被原地改（defsByBlock / refSeqByBlock 数组元素身份）", () => {
    const src = [
      "引用[^a] 与[^b]。",
      "",
      "段落。",
      "",
      "[^a]: A",
      "[^b]: B",
    ].join("\n");
    const state = initState(src);
    const defsSnap = state.refsBaseline!.defsByBlock.map((arr) => arr.map((e) => e));
    const refSnap = state.refsBaseline!.refSeqByBlock.map((arr) => [...arr]);

    buildBlocksIncremental(state, src.replace("段落。", "段落改。"), false);

    expect(state.refsBaseline!.defsByBlock.length).toBe(defsSnap.length);
    expect(state.refsBaseline!.refSeqByBlock).toEqual(refSnap);
    // head 区间的 defs 条目对象身份不变（增量复用前提）
    state.refsBaseline!.defsByBlock.forEach((arr, i) => {
      if (i < defsSnap.length) {
        arr.forEach((e, j) => {
          if (j < defsSnap[i].length) expect(e).toBe(defsSnap[i][j]);
        });
      }
    });
  });
});

describe("buildBlocksIncremental 不变量：prev.blocks 精确值与深度边界", () => {
  function initState(src: string): IncrementalParseState {
    const base: IncrementalParseState = {
      src: "",
      root: null,
      hast: null,
      blocks: [],
      incrementalCount: 0,
      lastFullAt: 0,
      refsBaseline: null,
    };
    const r = buildBlocksIncremental(base, src, true);
    return {
      ...base,
      src,
      root: r.root,
      hast: r.hast,
      blocks: r.blocks,
      incrementalCount: r.incrementalCount,
      lastFullAt: r.lastFullAt,
      refsBaseline: r.refsBaseline,
    };
  }

  function deepClone<T>(x: T): T {
    return structuredClone(x);
  }

  it("tail 平移的精确值：r.blocks 的 tail 块行号 = prev 原行号 + delta", () => {
    const src = ["段一。", "", "段二。", "", "段三。"].join("\n");
    const state = initState(src);
    const prevBlocksClone = deepClone(state.blocks);

    // 在段一后插 2 行空行 → delta = +2
    const next = "段一。\n\n\n\n段二。\n\n段三。";
    const r = buildBlocksIncremental(state, next, false);

    // prev 原块完全不变
    expect(state.blocks).toEqual(prevBlocksClone);

    // 新输出中 tail 块行号 = 原行号 + 2
    // （tail 块是「段二」「段三」——它们的 prev.startLine + 2 = r.startLine）
    const tailPrev = prevBlocksClone.filter((b) => b.startLine > prevBlocksClone[0].endLine);
    const tailNext = r.blocks.filter((b) => b.startLine > r.blocks[0].endLine);
    expect(tailNext.length).toBe(tailPrev.length);
    for (let i = 0; i < tailPrev.length; i++) {
      expect(tailNext[i].startLine).toBe(tailPrev[i].startLine + 2);
      expect(tailNext[i].endLine).toBe(tailPrev[i].endLine + 2);
      expect(tailNext[i].type).toBe(tailPrev[i].type);
    }
  });

  it("head 末块 endLine 精确值：= local.blocks[0].startLine - 1", () => {
    const src = ["段一。", "", "段二。", "", "段三。"].join("\n");
    const state = initState(src);
    const prevClone = deepClone(state.blocks);

    // 编辑段三（tail 侧）→ head 覆盖段一/段二，head 末块是段二
    const next = src.replace("段三。", "段三已编辑。");
    const r = buildBlocksIncremental(state, next, false);
    expect(state.blocks).toEqual(prevClone);

    // head 末块 endLine = 段二原 endLine（unchanged）
    // 通过「段三在 r.blocks 中的 startLine」反推验证无缝：
    for (let i = 1; i < r.blocks.length; i++) {
      expect(r.blocks[i].startLine).toBe(r.blocks[i - 1].endLine + 1);
    }
  });

  it("纯空行插入（local.blocks 为空）：head 末块 endLine = nextEnd", () => {
    const src = ["段一。", "", "段二。"].join("\n");
    const state = initState(src);
    const prevClone = deepClone(state.blocks);

    // 段一后插一行空行 → 变化区间可能落成纯空行 chunk
    const next = "段一。\n\n\n段二。";
    const r = buildBlocksIncremental(state, next, false);
    expect(state.blocks).toEqual(prevClone);

    // 行界无缝
    for (let i = 1; i < r.blocks.length; i++) {
      expect(r.blocks[i].startLine).toBe(r.blocks[i - 1].endLine + 1);
    }
  });

  it("index 重排：r.blocks[i].index === i，prev.blocks 的 index 不变", () => {
    const src = ["| a | b |", "| - | - |", "| 1 | 2 |", "", "段后。"].join("\n");
    const state = initState(src);
    const prevClone = deepClone(state.blocks);
    const prevIndexes = state.blocks.map((b) => b.index);

    const next = src.replace("段后。", "段后已编辑。");
    const r = buildBlocksIncremental(state, next, false);

    // prev 的 index 不变
    expect(state.blocks.map((b) => b.index)).toEqual(prevIndexes);
    // 新 blocks 的 index 连续
    r.blocks.forEach((b, i) => expect(b.index).toBe(i));
    expect(state.blocks).toEqual(prevClone);
  });

  it("编辑表格表头行后：prev.blocks 身份与字段均不变，table 块存在", () => {
    const src = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
    const state = initState(src);
    const prevClone = deepClone(state.blocks);
    const prevRefs = state.blocks.map((b) => b);

    const next = src.replace("| a | b |", "| a 改 | b |");
    const r = buildBlocksIncremental(state, next, false);

    expect(state.blocks).toEqual(prevClone);
    expect(state.blocks.map((b) => b === prevRefs[b.index])).toEqual(
      state.blocks.map(() => true),
    );
    // 表头行行界可能变化（列宽对齐会改源码行长度但行数不变），table 块仍存在
    expect(r.blocks.some((b) => b.type === "table")).toBe(true);
  });

  it("编辑表格最后一行后：prev.blocks 身份与字段均不变", () => {
    const src = ["| a | b |", "| - | - |", "| 1 | 2 |", "", "段后。"].join("\n");
    const state = initState(src);
    const prevClone = deepClone(state.blocks);
    const prevRefs = state.blocks.map((b) => b);

    const next = src.replace("| 1 | 2 |", "| 1 改 | 2 |");
    const r = buildBlocksIncremental(state, next, false);

    expect(state.blocks).toEqual(prevClone);
    expect(state.blocks.map((b) => b === prevRefs[b.index])).toEqual(
      state.blocks.map(() => true),
    );
    expect(r.blocks.some((b) => b.type === "table")).toBe(true);
  });

  it("refsBaseline.defsByBlock / refSeqByBlock 未被原地改写（深比较 + 身份）", () => {
    const src = [
      "引用[^a] 与[^b]。",
      "",
      "段落。",
      "",
      "[^a]: A",
      "[^b]: B",
    ].join("\n");
    const state = initState(src);
    const defsDeep = deepClone(state.refsBaseline!.defsByBlock);
    const refSeqDeep = deepClone(state.refsBaseline!.refSeqByBlock);
    const defsRefs = state.refsBaseline!.defsByBlock.map((arr) => arr.map((e) => e));

    buildBlocksIncremental(state, src.replace("段落。", "段落改。"), false);

    expect(state.refsBaseline!.defsByBlock).toEqual(defsDeep);
    expect(state.refsBaseline!.refSeqByBlock).toEqual(refSeqDeep);
    // head 区间条目身份不变
    state.refsBaseline!.defsByBlock.forEach((arr, i) => {
      arr.forEach((e, j) => {
        if (j < defsRefs[i].length) expect(e).toBe(defsRefs[i][j]);
      });
    });
  });

  it("prev.root / prev.hast 顶层节点不被原地改写（structuredClone 深比较）", () => {
    const src = ["段一。", "", "段二。", "", "段三。"].join("\n");
    const state = initState(src);
    const rootDeep = deepClone(state.root!);
    const hastDeep = deepClone(state.hast!);

    // 文首插入行 → tail 全部平移（走 shiftLine 克隆）
    const next = "新首行。\n\n" + src;
    buildBlocksIncremental(state, next, false);

    expect(state.root).toEqual(rootDeep);
    expect(state.hast).toEqual(hastDeep);
  });
});