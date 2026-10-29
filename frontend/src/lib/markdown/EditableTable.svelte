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
    emptyCell,
    isStaticTable,
    locateTableSource,
    parseTableSource,
    relocateNearest,
    rangeMatches,
    serializeMarkdownTable,
    serializeHtmlTable,
    tableOriginFromEl,
    type TableAlign,
    type TableSource,
  } from "./table-source";
  import { previewSearchState$ } from "../preview/previewSearch";

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

  /**
   * 源码侧静态拒绝标记：ensureSource 定位源码后发现单元格反编译失败
   * （HTML 来源含未知标签/属性，见 table-source 的 CellSource.lang）→
   * 整表降级静态（isStatic 的 "attrs" 分支）。node 回流时随缓存一并复位。
   */
  let srcRejected = $state(false);

  /**
   * 静态化判定统一入口（单一事实源，模板与交互守卫共用）：
   * - "span"：colspan/rowspan 合并（isStaticTable 纯函数，span 读取经
   *   readNumberAttr 兼容 colSpan/colspan 键名与 number/string 值）；
   * - "nested"：嵌套表格（raw HTML 单元格内的表格，DOM 判定）；
   * - "attrs"：源码侧单元格反编译失败（HTML 来源单元格含未知标签/属性，
   *   P4 接入：ensureSource 定位后发现 → 整表静态）。
   * 命中任一条件 → 整表只读渲染，禁止原地编辑与行/列操作。
   */
  function isStatic(node: Element): {
    static: boolean;
    reason?: "span" | "nested" | "attrs";
  } {
    if (isStaticTable(node).static) return { static: true, reason: "span" };
    if (nested) return { static: true, reason: "nested" };
    if (srcRejected) return { static: true, reason: "attrs" };
    return { static: false };
  }
  const staticInfo = $derived(isStatic(node));

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
  /* 查找面板是否激活：作为"本地覆盖失效"的额外触发源。
   用 $derived 收窄 store 整体变化 → 只追踪 active 布尔值，
   切换 current / 匹配集变化不会误触发。 */
  const searchActive = $derived($previewSearchState$.active);

  $effect(() => {
    // 父链上出现 td/th/table 即嵌套表格：整表定位会命中外层表格源码，
    // 原地编辑会以外层序列化覆盖嵌套结构 → 静态渲染兜底
    nested = Boolean(tableEl?.parentElement?.closest("td, th, table"));
  });

  /* node 引用变化（worker 重解析回流）→ 源码缓存失效，交互时重新定位；
   * 本地解析样式同时失效（worker 产物自此接管显示）；源码侧静态拒绝
   * 标记一并复位（新回流可能已能反编译）。
   * searchActive 也作为触发源：查找面板开合时清空本地覆盖——否则「先无
   * 查找编辑（设 localDisplay）→ 后开查找」会把裸 HAST 一直挂着，装饰丢失。 */
  $effect(() => {
    void node;
    void searchActive;
    src = null;
    srcRejected = false;
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
    const initial = s?.rows[e.r]?.[e.c]?.raw ?? "";
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
    if (src) {
      if (src.staticReason) {
        /* 回读后发现反编译失败（如单元格产生 md-image 等未知标签）：
         * 整表静态，缓存弃用 */
        srcRejected = true;
        src = null;
        return null;
      }
      if (src.dirty) {
        /* 回读失败的缓存（dirty）：强制重定位（就近全文搜索重建区间） */
        src = null;
      } else {
        return src;
      }
    }
    /* 静态表格（span 合并 / 嵌套 / 源码侧反编译失败）不定位、不缓存 */
    if (isStatic(node).static) return null;
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
    if (found.staticReason) {
      /* P4：HTML 来源单元格反编译失败（未知标签 / 白名单外属性）→
       * 整表降级静态（isStatic 的 "attrs" 分支），不缓存 */
      srcRejected = true;
      return null;
    }
    /* 行列对齐显示尺寸（源解析与 HAST 显示在正常情况下一致；补齐兜底） */
    while (found.rows.length < displayRows.length) found.rows.push([]);
    for (const row of found.rows) {
      while (row.length < colCount) row.push(emptyCell());
    }
    while (found.aligns.length < colCount) found.aligns.push(null);
    src = found;
    return src;
  }

  /** 回写：内部状态 → 格式化源码 → 编辑器（反向更新）。
   * anchor：锚定单元格 → 序列化时记录其偏移作为替换后光标落点。
   * P3：序列化产物为「裸」内容行，replaceLines(preservePrefix=true) 按
   * 现文档逐行保留前缀（缩进 / 引用 > / 列表标记），表格上下文不再被
   * 反向更新冲掉；回写后立即整表回读（parseTableSource），以解析结果
   * 覆盖内存矩阵——源码为唯一事实源（"  text" 回读为 "text" 等
   * 归一化差异在此对齐），连续编辑不再累积漂移。 */
  function writeBack(s: TableSource, anchor?: { r: number; c: number }): void {
    const api = get(editorApi$);
    if (!api) return;
    const doc = api.getDoc();
    const lines = doc.split("\n");
    let range = rangeMatches(lines, s, s.text)
      ? { startLine: s.startLine, endLine: s.endLine }
      : relocateNearest(doc, s.text, s.startLine);
    if (!range) {
      s.dirty = true;
      return;
    }

    /*
     * 两条路径的外层前缀处理不同：
     * - markdown：serializeMarkdownTable 输出裸行（`| a | b |` 无前导空白），
     *   由 replaceLines(preservePrefix=true) 逐行取现文档前缀，多次回写不
     *   累积（前缀取自现文档，稳定不变）；
     * - html：serializeHtmlTable 输出自带内部结构缩进（2/4 空格层级），若
     *   仍走 preservePrefix，会在「内部已带缩进的行」前再拼一次现文档前缀
     *   （来自上次回写产物 → 含内部缩进），每次回写缩进翻倍（无限缩进）。
     *   故这里取首行前缀作为 outerPrefix 传入，由 serializeHtmlTable 一次性
     *   生成完整前缀 + 内部缩进，然后关闭 preservePrefix。
     */
    const isHtml = s.origin === "html";
    const outerPrefix = isHtml ? (s.linePrefixes[0] ?? "") : "";
    const serialized = isHtml
      ? serializeHtmlTable(
          s.rows,
          s.aligns as (TableAlign | null)[],
          s.hasHeader,
          anchor,
          outerPrefix,
        )
      : serializeMarkdownTable(
          s.rows,
          s.aligns as (TableAlign | null)[],
          anchor,
        );

    api.replaceLines(
      range.startLine,
      range.endLine,
      serialized.text,
      serialized.cellOffset,
      !isHtml, // ← HTML 关掉 preservePrefix（前缀已在 outerPrefix 里）
    );

    /* 整表回读：replaceLines 的 dispatch 同步生效，getDoc 即新文档；
     * 行数 = 序列化产物行数（HTML 版行数由结构决定，可能与原表格不同），
     * 区间右端 = 起点 + 行数 - 1 */
    const newLineCount = serialized.text.split("\n").length;
    s.startLine = range.startLine;
    s.endLine = range.startLine + newLineCount - 1;
    s.text = api
      .getDoc()
      .split("\n")
      .slice(s.startLine - 1, s.endLine)
      .join("\n");
    const fresh = parseTableSource(s.text, s.origin);
    if (fresh) {
      s.rows = fresh.rows;
      s.aligns = fresh.aligns;
      s.hasHeader = fresh.hasHeader;
      s.linePrefixes = fresh.linePrefixes;
      s.staticReason = fresh.staticReason;
      s.dirty = false;
    } else {
      s.dirty = true;
    }
  }

  /* ---------------- 单元格编辑 ---------------- */

  /** 当前 window 选区是否位于本表格内部（阻止拖拽选文本后误入编辑）。
   *  用本表格而非整个预览区作为范围：需求语义就是"在单元格上选取"；
   *  且 startEdit 只在 td/th 的 click 中调用，click 落在 td 上时
   *  mousedown/mouseup 与选区必然都在本表格内——与预览区范围判定等价，
   *  但更局部、不依赖 CSS class、未来 startEdit 增加入口时更安全。 */
  function isSelectionInTable(): boolean {
    const el = tableEl;
    if (!el) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const container =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as HTMLElement)
        : node.parentElement;
    return !!container && el.contains(container);
  }

  function startEdit(r: number, c: number, ev?: MouseEvent): void {
    if (isStatic(node).static) return;
    if (editing) return;

    // 守卫 A：点击单元格内链接 → 不进入编辑，交给 PreviewPane 处理导航
    if (ev) {
      const target = ev.target instanceof Element ? ev.target : null;
      if (target?.closest("a")) return;
    }

    // 守卫 B：拖拽选文本后 mouseup 的 click（选区非折叠，且必然在本表格内）
    if (isSelectionInTable()) return;

    const s = ensureSource();
    if (!s || r >= s.rows.length) return;
    editing = { r, c };
    editValue = s.rows[r]?.[c]?.raw ?? "";
  }

  function commitEdit(): void {
    const e = editing;
    if (!e) return;
    editing = null;
    const s = ensureSource();
    if (!s || e.r >= s.rows.length) return;
    while (s.rows[e.r].length <= e.c) s.rows[e.r].push(emptyCell());
    /* 编辑结束 → 应用解析后的样式（本地即时，不等 worker 回流） */
    applyParsedStyle(s, e);
    if (s.rows[e.r][e.c].raw === editValue) return; // 内容未变不回写
    /* 暂存新值供 writeBack 序列化（结构化单元格：保留 spans/attrs，只替换
     * raw；用户输入恒为 markdown 源（单元格编辑器 = md 源码视图），lang
     * 统一标 "markdown"——HTML 来源表格序列化时经 encodeCell 编译回
     * inline HTML（P4 单元格语言统一）；P3 回写后以整表回读结果为准） */
    s.rows[e.r][e.c].raw = editValue;
    s.rows[e.r][e.c].lang = "markdown";
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
      rows[editingCell.r].push(emptyCell());
    /* 结构化矩阵：编辑单元格以「替换 raw」覆盖（保留 lang/spans/attrs） */
    rows[editingCell.r][editingCell.c] = {
      ...rows[editingCell.r][editingCell.c],
      raw: value,
    };

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

  /** 编辑结束：应用解析后的样式（本地覆盖 worker 回流前的显示）。
   * 查找面板打开时跳过本地覆盖：localDisplay 是未经装饰器处理的裸 HAST
   * （无 mark），会整体覆盖 worker 产物的查找装饰——表现为提交编辑后
   * 高亮丢失。让 worker 回流接管（node 变化 / searchActive 变化 →
   * $effect 清空），装饰自然恢复。面板关闭时保持原有即时应用行为。 */
  function applyParsedStyle(s: TableSource, e: { r: number; c: number }): void {
    const fresh =
      pendingParsed && pendingParsedValue === editValue ? pendingParsed : null;
    pendingParsed = null;
    if (cellParseTimer !== undefined) {
      clearTimeout(cellParseTimer);
      cellParseTimer = undefined;
    }
    if (searchActive) {
      localDisplay = null; // 清空可能残留的裸 HAST，让 worker 产物接管
      return;
    }
    localDisplay = fresh ?? parseCellsPreview(s, e, editValue);
  }

  /* ---------------- 右键菜单：行 / 列操作 ---------------- */
  let menuCell = $state<{ r: number; c: number } | null>(null);
  let menuToken = 0;

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
    const emptyRow = () => Array.from({ length: colCount }, () => emptyCell());
    const addCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at, 0, emptyCell());
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
     * 列复制同步复制列对齐。复制单元格做浅拷贝（结构体不再共享引用）。 */
    const copyRow = (from: number) => (t: TableSource) => {
      t.rows.splice(
        from + 1,
        0,
        (t.rows[from] ?? []).map((cell) => ({ ...cell })),
      );
    };
    const copyCol = (from: number) => (t: TableSource) => {
      for (const row of t.rows)
        row.splice(from + 1, 0, row[from] ? { ...row[from] } : emptyCell());
      t.aligns.splice(from + 1, 0, t.aligns[from] ?? null);
    };
    const delCol = (at: number) => (t: TableSource) => {
      for (const row of t.rows) row.splice(at, 1);
      t.aligns.splice(at, 1);
    };
    const token = ++menuToken;
    openContextMenu(
      ev.clientX,
      ev.clientY,
      [
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
      ],
      {
        onClosed: () => {
          if (menuToken === token) menuCell = null;
        },
      },
    );

    menuCell = { r, c };
  }

  /* ---------------- 模板辅助 ---------------- */

  const headRows = $derived(displayRows.filter((r) => r.isHeader));
  const bodyRows = $derived(displayRows.filter((r) => !r.isHeader));
</script>

<table
  bind:this={tableEl}
  class="md-editable-table"
  data-origin={origin}
  class:md-table-static={staticInfo.static}
>
  {#if headRows.length > 0}
    <thead>
      {#each headRows as row (row.idx)}
        <tr class:md-hl-row={menuCell?.r === row.idx}>
          {#each row.cells as cell, ci (ci)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
            <th
              style={alignStyle(cell)}
              class:md-hl-col={menuCell?.c === ci}
              class:md-cell-active={editing?.r === row.idx && editing?.c === ci}
              onclick={(ev) => startEdit(row.idx, ci, ev)}
              oncontextmenu={(ev) => openCellMenu(ev, row.idx, ci)}
            >
              {#if editing && editing.r === row.idx && editing.c === ci}
                <!-- CM6 单元格编辑器（冻结复用实例）的挂载宿主 -->
                <div class="md-cell-editor-host" bind:this={editorHost}></div>
              {:else}
                <div class="md-cell-content">
                  {#if localDisplay?.has(`${row.idx}:${ci}`)}
                    {#each localDisplay?.get(`${row.idx}:${ci}`) ?? [] as ch (ch)}
                      <MarkdownNode node={ch} />
                    {/each}
                  {:else}
                    {#each cell.children ?? [] as ch (ch)}
                      <MarkdownNode node={ch} />
                    {/each}
                  {/if}
                </div>
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
        <tr class:md-hl-row={menuCell?.r === row.idx}>
          {#each row.cells as cell, ci (ci)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
            <td
              style={alignStyle(cell)}
              class:md-hl-col={menuCell?.c === ci}
              class:md-cell-active={editing?.r === row.idx && editing?.c === ci}
              onclick={(ev) => startEdit(row.idx, ci, ev)}
              oncontextmenu={(ev) => openCellMenu(ev, row.idx, ci)}
            >
              {#if editing && editing.r === row.idx && editing.c === ci}
                <!-- CM6 单元格编辑器（冻结复用实例）的挂载宿主 -->
                <div class="md-cell-editor-host" bind:this={editorHost}></div>
              {:else}
                <div class="md-cell-content">
                  {#if localDisplay?.has(`${row.idx}:${ci}`)}
                    {#each localDisplay?.get(`${row.idx}:${ci}`) ?? [] as ch (ch)}
                      <MarkdownNode node={ch} />
                    {/each}
                  {:else}
                    {#each cell.children ?? [] as ch (ch)}
                      <MarkdownNode node={ch} />
                    {/each}
                  {/if}
                </div>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  {/if}
</table>
