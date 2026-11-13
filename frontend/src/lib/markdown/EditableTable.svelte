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
  import { editorApi$, blocks$, cellEdit$ } from "../stores";
  import {
    createCellEditor,
    type CellEditorHandle,
  } from "../editor/codemirrorSetup";
  import { compileMarkdown } from "./markdown-core";
  import { type ContextMenuItem } from "../contextmenu";
  import {
    registerContextMenuTarget,
    CONTEXT_MENU_PASSTHROUGH,
    type ResolverResult,
  } from "../contextmenuRegistry";
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
  import {
    previewSearchState$,
    decorateCellMap,
  } from "../preview/previewSearch";
  import {
    insertRow,
    insertCol,
    moveRow,
    moveCol,
    copyRow,
    copyCol,
    deleteRow,
    deleteCol,
  } from "./table-ops";
  import { footnoteById$, linkDefById$ } from "./reference-store";

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
   *   见 table-source 的 CellSource.lang）；
   * - "popover"：浮层上下文（脚注悬停预览等临时副本，DOM 判定）——
   *   浮层内的表格是主文档的副本，悬停结束即卸载，编辑状态无法维持，
   *   且与主文档同一份源码会互相干扰。
   * 命中任一条件 → 整表只读渲染，禁止原地编辑与行/列操作。
   */
  function isStatic(node: Element): {
    static: boolean;
    reason?: "span" | "nested" | "attrs" | "popover";
  } {
    if (isStaticTable(node).static) return { static: true, reason: "span" };
    if (nested) return { static: true, reason: "nested" };
    if (inPopover) return { static: true, reason: "popover" };
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
  /** 本实例在全局 cellEdit$ 中的所有权标识。EditableTable 的 effect 每
   * 个实例都会运行，全局编辑态的写入/清空必须校验 owner——否则滚动时
   * 挂载/卸载的非编辑实例会误清正在编辑实例写入的状态（钉住失效）。 */
  const editOwner = Symbol("editable-table-cell-edit");
  /**
   * 本地解析结果（无装饰）：parseCellsPreview 产物，异步防抖落地或提交时即时设置。
   * worker 回流（node 引用变化）时清空，让 worker 的 HAST 接管。
   */
  let rawLocalDisplay = $state.raw<Map<string, ElementContent[]> | null>(null);
  /**
   * 显示层：查找面板激活时对 rawLocalDisplay 套用装饰（与 worker 装饰
   * 视觉一致），未激活时原样使用。$derived 自动追踪 previewSearchState$
   * 的 active/re 变化——面板开关、查询变化都由这里响应，无需 $effect 手动
   * 清空（避免「提交后新内容被丢弃」的旧行为）。
   */
  const localDisplay = $derived.by(() => {
    if (!rawLocalDisplay) return null;
    return decorateCellMap(rawLocalDisplay, $previewSearchState$);
  });
  let tableEl = $state<HTMLTableElement | null>(null);
  /** 嵌套表格（raw HTML 单元格内的表格）：挂载后经 DOM 判定，只读渲染 */
  let nested = $state(false);
  /**
   * 浮层上下文（脚注悬停预览等）：浮层内容是主文档脚注定义的临时副本，
   * 悬停结束即卸载——在其中编辑会写到主文档同一份源码，浮层消失后编辑
   * 状态无法维持，且同一份表格在主文档与浮层同时存在会互相干扰。
   * 与 nested 同构的挂载后 DOM 判定（选择器预留 [data-popover] 供未来
   * 其他浮层复用；当前命中 FootNoteRef 的 .md-fnref-pop）。
   */
  const POPOVER_SELECTOR = ".md-fnref-pop, [data-popover]";
  let inPopover = $state(false);

  $effect(() => {
    // 父链上出现 td/th/table 即嵌套表格：整表定位会命中外层表格源码，
    // 原地编辑会以外层序列化覆盖嵌套结构 → 静态渲染兜底
    nested = Boolean(tableEl?.parentElement?.closest("td, th, table"));
    // 父链上出现浮层容器：浮层内为临时副本 → 整表静态。
    // 用 closest 从 tableEl 自身开始向上查；tableEl 是 <table>，
    // 浮层容器是 <span>，不会命中自身
    inPopover = Boolean(tableEl?.closest(POPOVER_SELECTOR));
  });

  /* node 引用变化（worker 重解析回流）→ 源码缓存失效，交互时重新定位；
   * 本地解析内容同时失效（worker 产物自此接管显示）；源码侧静态拒绝
   * 标记一并复位（新回流可能已能反编译）。
   *
   * 注：不再监听 searchActive。原先监听是为了在面板开合时清空本地 HAST
   * 让 worker 装饰接管；现在 localDisplay = $derived 会自动套用/撤销装饰
   * （decorateCellMap 的 active/re 分支），rawLocalDisplay 无需因面板开合
   * 而清空——只在 worker 真正回流（node 引用变化）时才失效。 */
  $effect(() => {
    void node;
    src = null;
    srcRejected = false;
    rawLocalDisplay = null;
  });

  /* 组件卸载：销毁冻结中的单元格编辑器实例，并清掉本实例拥有的全局
   * 单元格编辑态。所有权保护（owner 校验）必不可少：虚拟滚动会频繁
   * 挂载/卸载其他表格实例，它们的卸载 effect 也会运行——无守卫的
   * set(null) 会把正在编辑实例写入的状态清掉（钉住随之失效）。 */
  $effect(() => {
    return () => {
      cellEditor?.destroy();
      cellEditor = null;
      cellEdit$.update((v) => (v && v.owner === editOwner ? null : v));
    };
  });

  /* 编辑中的表格所在段索引 → 全局编辑态：预览虚拟滚动据此把该段「钉住」
   * 在渲染范围内（VirtualList pinned），滚出视口也不卸载，编辑状态不丢。
   * 依赖 editing + blockIndex：增量补丁导致段重定位时同步更新钉住索引。
   * 只更新本实例拥有的条目——本 effect 在每个表格实例上都会运行，非
   * 编辑实例（editing 为 null）必须完全无副作用，绝不能清空他表写入的
   * 状态。条目创建与 editing 归 null 的清空分别在编辑器挂载 effect 与
   * commitEdit / cancelEdit（均带 owner 校验）。 */
  $effect(() => {
    if (!editing || blockIndex == null) return;
    const bi = blockIndex; // 收窄为 number（闭包内 const 保持收窄）
    cellEdit$.update((v) =>
      v && v.owner === editOwner ? { ...v, blockIndex: bi } : v,
    );
  });

  /* 进入编辑态 → 挂载/复用 CM6 单元格编辑器：
   * - 懒创建：首次进入编辑才构建实例（不编辑单元格则不存在实例）；
   * - 复用：把冻结实例的 dom 重新挂载进新宿主并整体换文档（撤销历史
   *   随 history 卸载重装清空）；光标定位到文档末尾（与旧行为一致）。
   * - 进入编辑态后向全局 cellEdit$ 写入本实例的编辑态（owner + 段索引
   *   + 句柄），供关闭守卫强制提交、预览虚拟滚动钉住该段；提交/取消/
   *   组件卸载时由所有者清空（见 commitEdit / cancelEdit / 卸载 effect）。
   * 源码定位走 untrack：编辑器内容只由「进入编辑」驱动，禁止 node
   * 引用变化（worker 回流）触发重跑——那会在编辑中重置编辑器文档。
   * blockIndex 同样经 untrack 读取：段重定位时由钉住 effect（只做
   * owner 保护下的索引更新）跟进，编辑器不因此重跑。 */
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
    // 写入全局编辑态（owner + 段索引 + 句柄）；blockIndex 经 untrack 读取
    // 不进依赖，空索引（不应发生）防御性跳过
    untrack(() => {
      if (blockIndex == null) return;
      const bi = blockIndex;
      cellEdit$.set({ owner: editOwner, blockIndex: bi, handle: cellEditor! });
    });
  });

  function tableOrdinalOf(node: Element): number | null {
    const p = (node.properties ?? {}) as Record<string, unknown>;
    const v = p["data-table-ordinal"] ?? p.dataTableOrdinal;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

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
    /* 静态表格（span 合并 / 嵌套 / 源码侧反编译失败 / 浮层上下文）
      不定位、不缓存 */
    if (isStatic(node).static) return null;
    const api = get(editorApi$);
    if (!api) return null;
    const doc = api.getDoc();
    const blocks = get(blocks$);
    const block = blockIndex != null ? blocks[blockIndex] : undefined;
    const seed = block
      ? { startLine: block.startLine, endLine: block.endLine }
      : null;
    const found = locateTableSource(doc, seed, origin, tableOrdinalOf(node));
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

  /**
   * 单元格内「可交互元素」选择器：命中即视为用户想操作该元素本身
   * （链接导航、展开 details、勾选 checkbox、点击按钮、内联编辑器等），
   * 不进入单元格编辑态。
   *
   * 覆盖：
   * - 原生交互控件（链接 / 表单 / 折叠 / 媒体 / 内嵌文档）
   * - contenteditable（子编辑器，例如单元格里渲染的自定义输入组件）
   * - tabindex 非 -1 的键盘可达元素
   * - 常见 ARIA 交互角色（button/link/checkbox/…）
   *
   * 设计取舍：
   * - `a[href]` 而非 `a`：无 href 的锚点（如 markdown 脚注 back-anchor）
   *   不具导航语义，点击应照常进入编辑；
   * - 排除 `[tabindex='-1']`：常见于程序化聚焦，不是用户可交互目标；
   * - 不列 td/th/table：closest 只命中祖先，嵌套表格另由 isStatic 的
   *   "nested" 分支处理。
   */
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    "details",
    "audio[controls]",
    "video[controls]",
    "iframe",
    "object",
    "embed",
    "[contenteditable]:not([contenteditable='false'])",
    "[tabindex]:not([tabindex='-1'])",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='menuitemcheckbox']",
    "[role='menuitemradio']",
    "[role='option']",
    "[role='combobox']",
    "[role='slider']",
    "[role='spinbutton']",
    "[role='textbox']",
    "[role='searchbox']",
  ].join(",");

  function startEdit(r: number, c: number, ev?: MouseEvent): void {
    if (isStatic(node).static) return;
    if (editing) return;

    // 守卫 A：点击单元格内可交互元素 → 不进入编辑，交给该元素处理自身交互
    if (ev) {
      const target = ev.target instanceof Element ? ev.target : null;
      if (target?.closest(INTERACTIVE_SELECTOR)) return;
    }

    // 守卫 B：拖拽选文本后 mouseup 的 click（选区非折叠，且必然在本表格内）
    if (isSelectionInTable()) return;

    const s = ensureSource();
    if (!s || r >= s.rows.length) return;
    editing = { r, c };
    editValue = s.rows[r]?.[c]?.raw ?? "";
  }

  /** 取消待处理的防抖解析（清定时器与暂存结果） */
  function cancelPendingParse(): void {
    pendingParsed = null;
    if (cellParseTimer !== undefined) {
      clearTimeout(cellParseTimer);
      cellParseTimer = undefined;
    }
  }

  function commitEdit(): void {
    const e = editing;
    if (!e) return;
    editing = null;
    // 退出编辑态：同步清空本实例拥有的全局单元格编辑态（关闭守卫以
    // 条目存在与否判定「正在编辑单元格」；owner 校验防误清他表状态）
    cellEdit$.update((v) => (v && v.owner === editOwner ? null : v));
    const s = ensureSource();
    if (!s || e.r >= s.rows.length) return;
    while (s.rows[e.r].length <= e.c) s.rows[e.r].push(emptyCell());

    /* 内容未变：没有任何源码改动，worker 不会重解析、node 不会回流，
     因此绝不能把 rawLocalDisplay 设成本地编译视图——否则它会永久
     覆盖 worker 的正确 HAST（本地视图的链接桩若与文档定义不同步，
     就表现为"链接引用失效"）。清掉残留，直接显示 worker HAST。 */
    if (s.rows[e.r][e.c].raw === editValue) {
      cancelPendingParse();
      rawLocalDisplay = null;
      return;
    }

    /* 内容变化：本地即时应用解析后样式（worker 回流前的过渡显示） */
    applyParsedStyle(s, e);
    s.rows[e.r][e.c].raw = editValue;
    s.rows[e.r][e.c].lang = "markdown";
    writeBack(s, { r: e.r, c: e.c });
  }

  /** 取消编辑（Esc）：丢弃改动与暂存的防抖解析结果 */
  function cancelEdit(): void {
    editing = null;
    // 退出编辑态：同步清空本实例拥有的全局单元格编辑态（owner 校验
    // 防误清他表状态）
    cellEdit$.update((v) => (v && v.owner === editOwner ? null : v));
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

    const serialized =
      s.origin === "markdown"
        ? serializeMarkdownTable(rows, s.aligns as (TableAlign | null)[])
        : serializeHtmlTable(
            rows,
            s.aligns as (TableAlign | null)[],
            s.hasHeader,
          );

    /* 定义桩（仅 markdown 来源）：compileMarkdown 只解析表格文本，不含文档
     * 定义区——micromark 在 parse 阶段对以下语法的识别依赖定义存在：
     * - 脚注引用 [^x]（remark-gfm：无定义回退文本）；
     * - shortcut 链接引用 [text]（CommonMark：无定义回退文本）；
     * - shortcut 引用式图片 ![alt]（同上）。
     * full / collapsed 形式（[text][id] / ![alt][id]）语法明确、mdast 层面
     * 总是产出引用节点，拼桩零成本但对版本差异兜底。
     * 桩只需 identifier 存在（内容由 MarkdownFootnoteRef / MarkdownLinkRef /
     * MarkdownImage 渲染期从 STORE 查）；definition / footnoteDefinition
     * handler 在 mdastToHastRaw 里 return undefined，桩不会进入 HAST 树。
     * HTML 来源表格的单元格是 HTML 片段（引用语法不被识别），不拼桩。 */
    let srcText = serialized.text;
    if (s.origin === "markdown") {
      const stubs: string[] = [];
      for (const id of get(footnoteById$).keys()) stubs.push(`[^${id}]:`);
      for (const id of get(linkDefById$).keys()) stubs.push(`[${id}]: /`);
      if (stubs.length > 0) srcText += "\n\n" + stubs.join("\n\n");
    }

    const table = compileMarkdown(srcText).children.find(
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
   * 提交后立即落地新内容（无装饰）→ localDisplay = $derived 自动根据
   * 当前 previewSearchState$ 套用查找装饰——实时内容与查找装饰兼得。
   * 原 searchActive 短路（丢弃本地覆盖让 worker 接管）已移除：
   * 面板打开时不再"先旧后新"。 */
  function applyParsedStyle(s: TableSource, e: { r: number; c: number }): void {
    const fresh =
      pendingParsed && pendingParsedValue === editValue ? pendingParsed : null;
    pendingParsed = null;
    if (cellParseTimer !== undefined) {
      clearTimeout(cellParseTimer);
      cellParseTimer = undefined;
    }
    rawLocalDisplay = fresh ?? parseCellsPreview(s, e, editValue);
  }

  /* ---------------- 右键菜单：行 / 列操作 ---------------- */
  let menuCell = $state<{ r: number; c: number } | null>(null);
  let menuToken = 0;

  /**
   * 表格右键菜单 resolver（事件由文档根的全局分发器路由，本组件不再
   * 在模板上监听 contextmenu；preventDefault 与坐标由分发器统一处理）：
   * - 从事件目标就近定位 th/td（data-cell-r/c 标注行列下标）；
   * - 编辑中的单元格：右键落在 CM6 单元格编辑器宿主内时返回 null——
   *   编辑器自身已注册全局菜单且注册目标更内层，分发器会优先路由到
   *   编辑器菜单；此处兜底防御。
   */
  function resolveCellMenu(
    ev: MouseEvent,
    r: number,
    c: number,
  ): ResolverResult {
    if (
      editing &&
      editorHost &&
      ev.target instanceof Node &&
      editorHost.contains(ev.target)
    )
      return null; // 编辑中单元格：交给更内层的 CM6 编辑器菜单

    const s = ensureSource();
    if (!s) {
      /* 静态表格（span / nested / popover / attrs）：本表格不处理，
       交还外层（预览区）菜单；非静态但定位失败（dirty / 漂移）：
       保持阻止，避免误落到外层菜单。 */
      return isStatic(node).static ? CONTEXT_MENU_PASSTHROUGH : null;
    }
    const rows = s.rows;
    /* 当前列数快照（$derived 在事件处理器中读取为当前值）；
     * 行列操作统一用这份快照，保证一次菜单动作内 cols 不变 */
    const cols = colCount;
    const canDelRow = rows.length > 1;
    const canDelCol = cols > 1;

    /**
     * 动作包裹：重新 ensureSource（右键与点选之间可能发生异步回写 /
     * node 回流导致 src 失效）→ 就地修改矩阵 → writeBack 回写源码。
     * 行 / 列操作为纯函数（table-ops），只改 t.rows / t.aligns，
     * 序列化与反向更新统一交给 writeBack。
     */
    const apply = (fn: (t: TableSource) => void) => () => {
      const cur = ensureSource();
      if (!cur) return;
      fn(cur);
      writeBack(cur, { r, c });
    };

    const token = ++menuToken;
    const items: ContextMenuItem[] = [
      { kind: "header", label: $t("table.row") },
      {
        icon: "table-row-plus-before",
        label: $t("table.rowAbove"),
        action: apply((t) => insertRow(t.rows, r, cols)),
      },
      {
        icon: "table-row-plus-after",
        label: $t("table.rowBelow"),
        action: apply((t) => insertRow(t.rows, r + 1, cols)),
      },
      {
        icon: "table-arrow-up",
        label: $t("table.rowMoveUp"),
        disabled: r === 0,
        action: apply((t) => moveRow(t.rows, r, -1)),
      },
      {
        icon: "table-arrow-down",
        label: $t("table.rowMoveDown"),
        disabled: r === rows.length - 1,
        action: apply((t) => moveRow(t.rows, r, 1)),
      },
      {
        icon: "table-row-copy",
        label: $t("table.rowCopy"),
        action: apply((t) => copyRow(t.rows, r)),
      },
      {
        icon: "table-row-remove",
        label: $t("table.rowDelete"),
        disabled: !canDelRow,
        action: apply((t) => deleteRow(t.rows, r)),
      },
      { kind: "separator", label: "" },
      { kind: "header", label: $t("table.col") },
      {
        icon: "table-column-plus-before",
        label: $t("table.colLeft"),
        action: apply((t) =>
          insertCol(t.rows, t.aligns as (TableAlign | null)[], c),
        ),
      },
      {
        icon: "table-column-plus-after",
        label: $t("table.colRight"),
        action: apply((t) =>
          insertCol(t.rows, t.aligns as (TableAlign | null)[], c + 1),
        ),
      },
      {
        icon: "table-arrow-left",
        label: $t("table.colMoveLeft"),
        disabled: c === 0,
        action: apply((t) =>
          moveCol(t.rows, t.aligns as (TableAlign | null)[], c, -1),
        ),
      },
      {
        icon: "table-arrow-right",
        label: $t("table.colMoveRight"),
        disabled: c === cols - 1,
        action: apply((t) =>
          moveCol(t.rows, t.aligns as (TableAlign | null)[], c, 1),
        ),
      },
      {
        icon: "table-column-copy",
        label: $t("table.colCopy"),
        action: apply((t) =>
          copyCol(t.rows, t.aligns as (TableAlign | null)[], c),
        ),
      },
      {
        icon: "table-column-remove",
        label: $t("table.colDelete"),
        disabled: !canDelCol,
        action: apply((t) =>
          deleteCol(t.rows, t.aligns as (TableAlign | null)[], c),
        ),
      },
    ];
    menuCell = { r, c };
    return {
      items,
      options: {
        onClosed: () => {
          if (menuToken === token) menuCell = null;
        },
      },
    };
  }

  /* 表格元素整体注册一次（行列下标从事件目标的 data-cell-r/c 解析）；
   * 编辑中的单元格由更内层的 CM6 编辑器注册接管（见 resolveCellMenu） */
  $effect(() => {
    const el = tableEl;
    if (!el) return;
    return registerContextMenuTarget(el, (ev) => {
      const cell =
        ev.target instanceof Element
          ? ev.target.closest<HTMLElement>("th[data-cell-r], td[data-cell-r]")
          : null;
      if (!cell || !el.contains(cell)) return CONTEXT_MENU_PASSTHROUGH;
      const r = Number(cell.getAttribute("data-cell-r"));
      const c = Number(cell.getAttribute("data-cell-c"));
      if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
      return resolveCellMenu(ev, r, c);
    });
  });

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
              data-cell-r={row.idx}
              data-cell-c={ci}
              onclick={(ev) => startEdit(row.idx, ci, ev)}
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
              data-cell-r={row.idx}
              data-cell-c={ci}
              onclick={(ev) => startEdit(row.idx, ci, ev)}
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
