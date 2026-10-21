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
   * - 单击单元格 → 原地 textarea 编辑原始源码；blur / Ctrl+Enter 提交，
   *   Esc 取消；单元格内支持多行（markdown 序列化为 <br>）；
   * - 右键单元格 → ContextMenu 行/列操作（插入 / 复制 / 删除），操作后
   *   立即回写；
   * - 源码定位失败的表格（如区块定位漂移、含 colspan/rowspan）静态渲染。
   */
  import type { Element, ElementContent } from "hast";
  import { get } from "svelte/store";
  import MarkdownNode from "./MarkdownNode.svelte";
  import { editorApi$, blocks$ } from "../stores";
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
  let editEl = $state<HTMLTextAreaElement | null>(null);
  let tableEl = $state<HTMLTableElement | null>(null);
  /** 嵌套表格（raw HTML 单元格内的表格）：挂载后经 DOM 判定，只读渲染 */
  let nested = $state(false);

  $effect(() => {
    // 父链上出现 td/th/table 即嵌套表格：整表定位会命中外层表格源码，
    // 原地编辑会以外层序列化覆盖嵌套结构 → 静态渲染兜底
    nested = Boolean(tableEl?.parentElement?.closest("td, th, table"));
  });

  /* node 引用变化（worker 重解析回流）→ 源码缓存失效，交互时重新定位 */
  $effect(() => {
    void node;
    src = null;
  });

  /* 进入编辑态后：聚焦 + 自适应高度 */
  $effect(() => {
    if (editing && editEl) {
      editEl.focus();
      editEl.setSelectionRange(editEl.value.length, editEl.value.length);
      autoSize();
    }
  });

  function autoSize(): void {
    const el = editEl;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

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
    if (s.rows[e.r][e.c] === editValue) return; // 内容未变不回写
    s.rows[e.r][e.c] = editValue;
    writeBack(s, { r: e.r, c: e.c });
  }

  function editKeydown(ev: KeyboardEvent): void {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      editing = null;
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      commitEdit();
    }
  }

  /* ---------------- 右键菜单：行 / 列操作 ---------------- */

  function openCellMenu(ev: MouseEvent, r: number, c: number): void {
    ev.preventDefault();
    ev.stopPropagation();
    const s = ensureSource();
    if (!s) return;
    const originTag =
      s.origin === "markdown" ? $t("table.originMd") : $t("table.originHtml");
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
    const copyCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at + 1, 0, row[at] ?? "");
      t.aligns.splice(at + 1, 0, t.aligns[at] ?? null);
    };
    const delCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at, 1);
      t.aligns.splice(at, 1);
    };
    openContextMenu(ev.clientX, ev.clientY, [
      { kind: "header", label: `${$t("table.row")} · ${originTag}` },
      {
        icon: "rows",
        label: $t("table.rowAbove"),
        action: apply((t) => t.rows.splice(r, 0, emptyRow())),
      },
      {
        icon: "rows",
        label: $t("table.rowBelow"),
        action: apply((t) => t.rows.splice(r + 1, 0, emptyRow())),
      },
      {
        icon: "copy",
        label: $t("table.rowCopy"),
        action: apply((t) => t.rows.splice(r + 1, 0, [...(t.rows[r] ?? [])])),
      },
      {
        icon: "trash",
        label: $t("table.rowDelete"),
        disabled: !canDelRow,
        action: apply((t) => t.rows.splice(r, 1)),
      },
      { kind: "separator", label: "" },
      { kind: "header", label: `${$t("table.col")} · ${originTag}` },
      { icon: "cols", label: $t("table.colLeft"), action: apply(addCol(c)) },
      {
        icon: "cols",
        label: $t("table.colRight"),
        action: apply(addCol(c + 1)),
      },
      { icon: "copy", label: $t("table.colCopy"), action: apply(copyCol(c)) },
      {
        icon: "trash",
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
                <textarea
                  bind:this={editEl}
                  bind:value={editValue}
                  class="md-cell-editor"
                  rows="1"
                  spellcheck="false"
                  onblur={commitEdit}
                  onkeydown={editKeydown}
                  oninput={autoSize}></textarea>
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
                <textarea
                  bind:this={editEl}
                  bind:value={editValue}
                  class="md-cell-editor"
                  rows="1"
                  spellcheck="false"
                  onblur={commitEdit}
                  onkeydown={editKeydown}
                  oninput={autoSize}></textarea>
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
