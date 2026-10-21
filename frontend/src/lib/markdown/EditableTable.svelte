<script lang="ts">
  /**
   * 可编辑表格组件：预览区 HAST <table> 的原地编辑渲染。
   *
   * 【与增量解析 worker 的分工】
   * - 单元格「显示内容」完全来自增量解析 worker 产出的 HAST（本组件接受
   *   HAST 元素），单元格内的 markdown 解析不在组件内重复做；
   * - 组件内部状态 = 原始单元格源矩阵（rows，懒定位自编辑器源码）。内部
   *   状态更新（单元格提交 / 行列操作）时反向更新编辑区：按表格来源标记
   *   （markdown → 格式化 GFM 表格；html → 格式化 HTML RAW）序列化后经
   *   EditorApi 替换对应源码行 → doc$ 变化 → worker 重解析 → HAST 回流
   *   更新显示。整个编辑闭环不引入第二条解析链路。
   *
   * 【表格来源标记】markdown-core 在解析链路中为 <table> 注入
   * data-md-table（Markdown/GFM）或 data-html-table（raw HTML），
   * 见 tableOriginFromEl / table-source.ts。
   *
   * 【编辑交互】
   * - 单击单元格 → 原地 CM6 编辑器（与编辑区同配置，见
   *   codemirrorSetup.createCellEditor）编辑原始源码；实例懒创建（首次
   *   编辑单元格才构建），结束编辑后冻结复用（不销毁，下次编辑重新
   *   挂载换文档）；blur / Ctrl+Enter 提交，Esc 取消；
   * - 单元格解析策略与编辑区相同：编辑期间对单元格内容做带防抖的
   *   实时解析（复用 markdown-core 同款编译管线），编辑结束后再应用
   *   解析后的样式（本地即时应用，不等 worker 回流）；反向更新依旧
   *   保持在编辑结束后；
   * - 右键单元格 → ContextMenu 行/列操作（插入 / 移动 / 复制 / 删除），
   *   复制固定插到当前行/列之后（无方向性），操作后立即回写；
   * - 源码定位失败的表格（如区块定位漂移、含 colspan/rowspan）静态渲染。
   */
  import type { Element, ElementContent } from "hast";
  import { get } from "svelte/store";
  import { untrack } from "svelte";
  import MarkdownNode from "./MarkdownNode.svelte";
  import { editorApi$, blocks$ } from "../stores";
  import {
    createCellEditor,
    type CellEditorHandle,
  } from "../editor/codemirrorSetup";
  import { compileMarkdown } from "./markdown-core";
  import { openContextMenu } from "../contextmenu";
  import { t } from "../i18n.svelte";
  import {
    locateTableSource,
    relocateNearest,
    rangeMatches,
    serializeMarkdownTable,
    serializeHtmlTable,
    tableOriginFromEl,
    type TableAlign,
    type TableSource,
  } from "./table-source";

  let {
    node,
    blockIndex = null,
  }: { node: Element; blockIndex?: number | null } = $props();

  /* ---------------- HAST 显示结构（worker 解析产物） ---------------- */

  interface DisplayRow {
    /** 原始行号（rows 矩阵与源码行同序） */
    idx: number;
    cells: Element[];
    isHeader: boolean;
  }

  function extractDisplayRows(table: Element): DisplayRow[] {
    const rows: DisplayRow[] = [];
    let idx = 0;
    for (const section of (table.children ?? []) as ElementContent[]) {
      if (section.type !== "element") continue;
      const tag = section.tagName;
      const isHeadSection = tag === "thead";
      if (tag !== "thead" && tag !== "tbody" && tag !== "tfoot" && tag !== "tr")
        continue;
      const trs =
        tag === "tr"
          ? [section]
          : (((section.children ?? []) as ElementContent[]).filter(
              (c) => c.type === "element" && (c as Element).tagName === "tr",
            ) as Element[]);
      for (const tr of trs) {
        const cells = ((tr.children ?? []) as ElementContent[]).filter(
          (c) =>
            c.type === "element" &&
            ((c as Element).tagName === "td" ||
              (c as Element).tagName === "th"),
        ) as Element[];
        rows.push({ idx: idx++, cells, isHeader: isHeadSection });
      }
    }
    /* 无 thead 的 HTML 表格：首个含 th 的行视为表头（与源码解析判定一致） */
    if (!rows.some((r) => r.isHeader) && rows.length > 0) {
      const first = rows[0];
      if (first.cells.some((c) => c.tagName === "th")) first.isHeader = true;
    }
    return rows;
  }

  const displayRows = $derived(extractDisplayRows(node));
  const colCount = $derived(
    displayRows.reduce((m, r) => Math.max(m, r.cells.length), 0),
  );
  const origin = $derived(tableOriginFromEl(node));
  /** colspan/rowspan 表格不做原地编辑（朴素序列化会破坏合并结构） */
  const hasSpan = $derived(
    displayRows.some((r) =>
      r.cells.some((c) => {
        const p = c.properties as Record<string, unknown> | undefined;
        const col = Number(p?.colspan ?? 1);
        const row = Number(p?.rowspan ?? 1);
        return (
          (Number.isFinite(col) && col > 1) || (Number.isFinite(row) && row > 1)
        );
      }),
    ),
  );

  /** 列对齐（显示用；HAST 单元格自带 align 属性，直接透传） */
  function alignStyle(cell: Element | undefined): string | undefined {
    const p = (cell?.properties ?? {}) as Record<string, unknown>;
    const a = typeof p.align === "string" ? p.align.toLowerCase() : undefined;
    if (a === "left" || a === "center" || a === "right")
      return `text-align: ${a};`;
    const style = typeof p.style === "string" ? p.style : "";
    const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
    return m ? `text-align: ${m[1].toLowerCase()};` : undefined;
  }

  /* ---------------- 内部状态：原始单元格源 + 源码定位 ---------------- */

  let src = $state<TableSource | null>(null);
  let editing = $state<{ r: number; c: number } | null>(null);
  let editValue = $state("");
  /** 单元格 CM6 编辑器宿主（仅编辑中的单元格渲染该节点） */
  let editorHost = $state<HTMLElement | null>(null);
  /** 冻结复用的 CM6 单元格编辑器实例（懒创建：首次编辑单元格才构建；
   * 结束编辑不销毁，仅随宿主节点脱离文档，下次编辑重新挂载换文档） */
  let cellEditor: CellEditorHandle | null = null;
  /** 本地解析样式覆盖（编辑结束后应用，key "r:c" → HAST 子节点）；
   * worker 回流（node 引用变化）后清除，显示回归 worker 产物 */
  let localDisplay = $state.raw<Map<string, ElementContent[]> | null>(null);
  let tableEl = $state<HTMLTableElement | null>(null);
  /** 嵌套表格（raw HTML 单元格内的表格）：挂载后经 DOM 判定，只读渲染 */
  let nested = $state(false);

  $effect(() => {
    // 父链上出现 td/th/table 即嵌套表格：整表定位会命中外层表格源码，
    // 原地编辑会以外层序列化覆盖嵌套结构 → 静态渲染兜底
    nested = Boolean(tableEl?.parentElement?.closest("td, th, table"));
  });

  /* node 引用变化（worker 重解析回流）→ 源码缓存失效，交互时重新定位；
   * 本地解析样式同时失效（worker 产物自此接管显示） */
  $effect(() => {
    void node;
    src = null;
    localDisplay = null;
  });

  /* 组件卸载：销毁冻结中的单元格编辑器实例 */
  $effect(() => {
    return () => {
      cellEditor?.destroy();
      cellEditor = null;
    };
  });

  /* 进入编辑态 → 挂载/复用 CM6 单元格编辑器：
   * - 懒创建：首次进入编辑才构建实例（不编辑单元格则不存在实例）；
   * - 复用：把冻结实例的 dom 重新挂载进新宿主并整体换文档（撤销历史
   *   随 history 卸载重装清空）；光标定位到文档末尾（与旧行为一致）。
   * 源码定位走 untrack：编辑器内容只由「进入编辑」驱动，禁止 node
   * 引用变化（worker 回流）触发重跑——那会在编辑中重置编辑器文档。 */
  $effect(() => {
    if (!editing || !editorHost) return;
    const e = editing;
    const s = untrack(() => ensureSource());
    const initial = s?.rows[e.r]?.[e.c] ?? "";
    if (!cellEditor) {
      cellEditor = createCellEditor(editorHost, initial, {
        onchange: (doc) => {
          editValue = doc;
          scheduleCellParse();
        },
        oncommit: () => commitEdit(),
        oncancel: () => cancelEdit(),
      });
    } else {
      editorHost.appendChild(cellEditor.dom);
      cellEditor.setDoc(initial);
    }
    cellEditor.focusEnd();
    cellEditor.requestMeasure();
  });

  /** 懒定位表格源码（缓存在交互期间复用；node 变化后自动失效） */
  function ensureSource(): TableSource | null {
    if (src) return src;
    if (hasSpan || nested) return null;
    const api = get(editorApi$);
    if (!api) return null;
    const doc = api.getDoc();
    const blocks = get(blocks$);
    const block = blockIndex != null ? blocks[blockIndex] : undefined;
    const seed = block
      ? { startLine: block.startLine, endLine: block.endLine }
      : null;
    const found = locateTableSource(doc, seed, origin);
    if (!found) return null;
    /* 行列对齐显示尺寸（源解析与 HAST 显示在正常情况下一致；补齐兜底） */
    while (found.rows.length < displayRows.length) found.rows.push([]);
    for (const row of found.rows) {
      while (row.length < colCount) row.push("");
    }
    while (found.aligns.length < colCount) found.aligns.push(null);
    src = found;
    return src;
  }

  /** 回写：内部状态 → 格式化源码 → 编辑器（反向更新）。
   * anchor：锚定单元格 → 序列化时记录其偏移作为替换后光标落点。 */
  function writeBack(s: TableSource, anchor?: { r: number; c: number }): void {
    const api = get(editorApi$);
    if (!api) return;
    const doc = api.getDoc();
    const lines = doc.split("\n");
    let range = rangeMatches(lines, s, s.text)
      ? { startLine: s.startLine, endLine: s.endLine }
      : relocateNearest(doc, s.text, s.startLine);
    if (!range) return;

    const serialized =
      s.origin === "markdown"
        ? serializeMarkdownTable(
            s.rows,
            s.aligns as (TableAlign | null)[],
            anchor,
          )
        : serializeHtmlTable(
            s.rows,
            s.aligns as (TableAlign | null)[],
            s.hasHeader,
            anchor,
          );

    /* 三条抑制（deadline/注解/显式选区）都在 replaceLines 内部完成；
     * 残留同步状态由 App 注册的 onBeforeReplace 钩子清理 */
    api.replaceLines(
      range.startLine,
      range.endLine,
      serialized.text,
      serialized.cellOffset,
    );

    s.startLine = range.startLine;
    s.endLine = range.startLine + serialized.text.split("\n").length - 1;
    s.text = serialized.text;
  }

  /* ---------------- 单元格编辑 ---------------- */

  function startEdit(r: number, c: number): void {
    if (editing) return; // 已有编辑态（blur 提交后才会触发新的 startEdit）
    const s = ensureSource();
    if (!s || r >= s.rows.length) return;
    editing = { r, c };
    editValue = s.rows[r]?.[c] ?? "";
  }

  function commitEdit(): void {
    const e = editing;
    if (!e) return;
    editing = null;
    const s = ensureSource();
    if (!s || e.r >= s.rows.length) return;
    while (s.rows[e.r].length <= e.c) s.rows[e.r].push("");
    /* 编辑结束 → 应用解析后的样式（本地即时，不等 worker 回流） */
    applyParsedStyle(s, e);
    if (s.rows[e.r][e.c] === editValue) return; // 内容未变不回写
    s.rows[e.r][e.c] = editValue;
    /* 反向更新依旧保持在编辑结束后 */
    writeBack(s, { r: e.r, c: e.c });
  }

  /** 取消编辑（Esc）：丢弃改动与暂存的防抖解析结果 */
  function cancelEdit(): void {
    editing = null;
    pendingParsed = null;
    if (cellParseTimer !== undefined) {
      clearTimeout(cellParseTimer);
      cellParseTimer = undefined;
    }
  }

  /* ---------------- 单元格实时解析（与编辑区相同，带防抖） ----------------
   * 策略与编辑区一致：内容变化后静默 CELL_PARSE_DEBOUNCE_MS 才解析
   * （连续输入不打出解析洪峰）。解析复用 markdown-core 的 compileMarkdown
   * （worker 同款纯编译管线：remark-parse → GFM → rehype-raw → sanitize），
   * 且直接解析「序列化后的表格源码」——即 writeBack 将写入编辑区的同一份
   * 文本，保证本地应用的样式与 worker 回流后的结果完全一致。
   * 解析结果仅暂存（pendingParsed），编辑结束后才应用到单元格显示。 */

  /** 与编辑区解析防抖一致（stores.ts PARSE_DEBOUNCE_MS） */
  const CELL_PARSE_DEBOUNCE_MS = 200;

  let cellParseTimer: ReturnType<typeof setTimeout> | undefined;
  /** 防抖解析的暂存结果与其对应的单元格内容（过期则 commit 时重解析） */
  let pendingParsed: Map<string, ElementContent[]> | null = null;
  let pendingParsedValue = "";

  /**
   * 编译单元格矩阵（含正在编辑的单元格）为本地显示映射。
   * key "r:c" → 该单元格渲染用的 HAST 子节点。
   */
  function parseCellsPreview(
    s: TableSource,
    editingCell: { r: number; c: number },
    value: string,
  ): Map<string, ElementContent[]> | null {
    const rows = s.rows.map((row) => [...row]);
    while (rows.length <= editingCell.r) rows.push([]);
    while (rows[editingCell.r].length <= editingCell.c)
      rows[editingCell.r].push("");
    rows[editingCell.r][editingCell.c] = value;

    // serialize* 返回 { text, cellOffset }，这里只需要 text
    const serialized =
      s.origin === "markdown"
        ? serializeMarkdownTable(rows, s.aligns as (TableAlign | null)[])
        : serializeHtmlTable(
            rows,
            s.aligns as (TableAlign | null)[],
            s.hasHeader,
          );

    const table = compileMarkdown(serialized.text).children.find(
      (n): n is Element => n.type === "element" && n.tagName === "table",
    );
    if (!table) return null;
    const map = new Map<string, ElementContent[]>();
    for (const dr of extractDisplayRows(table)) {
      dr.cells.forEach((cell, ci) => map.set(`${dr.idx}:${ci}`, cell.children));
    }
    return map;
  }

  /** 编辑期间：内容变化后重起防抖，静默后解析并暂存（不应用显示） */
  function scheduleCellParse(): void {
    if (cellParseTimer !== undefined) clearTimeout(cellParseTimer);
    cellParseTimer = setTimeout(() => {
      cellParseTimer = undefined;
      const e = editing;
      const s = ensureSource();
      if (!e || !s) return;
      pendingParsedValue = editValue;
      pendingParsed = parseCellsPreview(s, e, editValue);
    }, CELL_PARSE_DEBOUNCE_MS);
  }

  /** 编辑结束：应用解析后的样式（本地覆盖 worker 回流前的显示） */
  function applyParsedStyle(s: TableSource, e: { r: number; c: number }): void {
    const fresh =
      pendingParsed && pendingParsedValue === editValue ? pendingParsed : null;
    pendingParsed = null;
    if (cellParseTimer !== undefined) {
      clearTimeout(cellParseTimer);
      cellParseTimer = undefined;
    }
    /* 防抖未及触发（提交早于静默期结束）：同步补一次解析 */
    localDisplay = fresh ?? parseCellsPreview(s, e, editValue);
  }

  /* ---------------- 右键菜单：行 / 列操作 ---------------- */

  function openCellMenu(ev: MouseEvent, r: number, c: number): void {
    ev.preventDefault();
    ev.stopPropagation();
    const s = ensureSource();
    if (!s) return;
    const rows = s.rows;
    const canDelRow = rows.length > 1;
    const canDelCol = colCount > 1;
    const apply = (fn: (t: TableSource) => void) => () => {
      const cur = ensureSource();
      if (!cur) return;
      fn(cur);
      writeBack(cur, { r, c });
    };
    const emptyRow = () => new Array(colCount).fill("");
    const addCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at, 0, "");
      t.aligns.splice(at, 0, null);
    };
    /* 移动（带方向性）：与相邻行/列交换位置；列移动同步交换列对齐 */
    const moveRow = (from: number, dir: -1 | 1) => (t: TableSource) => {
      const to = from + dir;
      if (to < 0 || to >= t.rows.length) return;
      const tmp = t.rows[from];
      t.rows[from] = t.rows[to];
      t.rows[to] = tmp;
    };
    const moveCol = (from: number, dir: -1 | 1) => (t: TableSource) => {
      const to = from + dir;
      if (to < 0 || to >= colCount) return;
      for (const row of t.rows) {
        const tmp = row[from];
        row[from] = row[to];
        row[to] = tmp;
      }
      const tmp = t.aligns[from];
      t.aligns[from] = t.aligns[to];
      t.aligns[to] = tmp;
    };
    /* 复制（无方向性）：副本固定插到当前行/列之后。
     * 插入位置 from+1 始终落在 [1, rows.length] 区间内，永不失序；
     * 列复制同步复制列对齐。 */
    const copyRow = (from: number) => (t: TableSource) => {
      t.rows.splice(from + 1, 0, [...(t.rows[from] ?? [])]);
    };
    const copyCol = (from: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(from + 1, 0, row[from] ?? "");
      t.aligns.splice(from + 1, 0, t.aligns[from] ?? null);
    };
    const delCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at, 1);
      t.aligns.splice(at, 1);
    };
    openContextMenu(ev.clientX, ev.clientY, [
      { kind: "header", label: $t("table.row") },
      {
        icon: "table-row-plus-before",
        label: $t("table.rowAbove"),
        action: apply((t) => t.rows.splice(r, 0, emptyRow())),
      },
      {
        icon: "table-row-plus-after",
        label: $t("table.rowBelow"),
        action: apply((t) => t.rows.splice(r + 1, 0, emptyRow())),
      },
      {
        icon: "table-arrow-up",
        label: $t("table.rowMoveUp"),
        disabled: r === 0,
        action: apply(moveRow(r, -1)),
      },
      {
        icon: "table-arrow-down",
        label: $t("table.rowMoveDown"),
        disabled: r === rows.length - 1,
        action: apply(moveRow(r, 1)),
      },
      {
        icon: "table-row-copy",
        label: $t("table.rowCopy"),
        action: apply(copyRow(r)),
      },
      {
        icon: "table-row-remove",
        label: $t("table.rowDelete"),
        disabled: !canDelRow,
        action: apply((t) => t.rows.splice(r, 1)),
      },
      { kind: "separator", label: "" },
      { kind: "header", label: $t("table.col") },
      {
        icon: "table-column-plus-before",
        label: $t("table.colLeft"),
        action: apply(addCol(c)),
      },
      {
        icon: "table-column-plus-after",
        label: $t("table.colRight"),
        action: apply(addCol(c + 1)),
      },
      {
        icon: "table-arrow-left",
        label: $t("table.colMoveLeft"),
        disabled: c === 0,
        action: apply(moveCol(c, -1)),
      },
      {
        icon: "table-arrow-right",
        label: $t("table.colMoveRight"),
        disabled: c === colCount - 1,
        action: apply(moveCol(c, 1)),
      },
      {
        icon: "table-column-copy",
        label: $t("table.colCopy"),
        action: apply(copyCol(c)),
      },
      {
        icon: "table-column-remove",
        label: $t("table.colDelete"),
        disabled: !canDelCol,
        action: apply(delCol(c)),
      },
    ]);
  }

  /* ---------------- 模板辅助 ---------------- */

  const headRows = $derived(displayRows.filter((r) => r.isHeader));
  const bodyRows = $derived(displayRows.filter((r) => !r.isHeader));
</script>

<table
  bind:this={tableEl}
  class="md-editable-table"
  data-origin={origin}
  class:md-table-static={hasSpan || nested}
>
  {#if headRows.length > 0}
    <thead>
      {#each headRows as row (row.idx)}
        <tr>
          {#each row.cells as cell, ci (ci)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
            <th
              style={alignStyle(cell)}
              onclick={() => startEdit(row.idx, ci)}
              oncontextmenu={(ev) => openCellMenu(ev, row.idx, ci)}
            >
              {#if editing && editing.r === row.idx && editing.c === ci}
                <!-- CM6 单元格编辑器（冻结复用实例）的挂载宿主 -->
                <div class="md-cell-editor-host" bind:this={editorHost}></div>
              {:else if localDisplay?.has(`${row.idx}:${ci}`)}
                <!-- 编辑结束应用的本地解析样式（worker 回流后自动清除） -->
                {#each localDisplay?.get(`${row.idx}:${ci}`) ?? [] as ch (ch)}
                  <MarkdownNode node={ch} />
                {/each}
              {:else}
                {#each cell.children ?? [] as ch (ch)}
                  <MarkdownNode node={ch} />
                {/each}
              {/if}
            </th>
          {/each}
        </tr>
      {/each}
    </thead>
  {/if}
  {#if bodyRows.length > 0}
    <tbody>
      {#each bodyRows as row (row.idx)}
        <tr>
          {#each row.cells as cell, ci (ci)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
            <td
              style={alignStyle(cell)}
              onclick={() => startEdit(row.idx, ci)}
              oncontextmenu={(ev) => openCellMenu(ev, row.idx, ci)}
            >
              {#if editing && editing.r === row.idx && editing.c === ci}
                <!-- CM6 单元格编辑器（冻结复用实例）的挂载宿主 -->
                <div class="md-cell-editor-host" bind:this={editorHost}></div>
              {:else if localDisplay?.has(`${row.idx}:${ci}`)}
                <!-- 编辑结束应用的本地解析样式（worker 回流后自动清除） -->
                {#each localDisplay?.get(`${row.idx}:${ci}`) ?? [] as ch (ch)}
                  <MarkdownNode node={ch} />
                {/each}
              {:else}
                {#each cell.children ?? [] as ch (ch)}
                  <MarkdownNode node={ch} />
                {/each}
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  {/if}
</table>