/**
 * 自定义输入框核心（框架无关，替换原生 <input type="text">）。
 *
 * 元素为单行 contenteditable（优先 plaintext-only，不支持时回退
 * contenteditable=true + beforeinput 拦截换行/富文本插入）。相比原生
 * input 的关键差异全部在本文档化：
 * - 选区与光标监听：focus 期间订阅 document selectionchange（配合
 *   input 事件），把自身选区归一化为 {start,end,collapsed} 文本偏移，
 *   经 onSelectionChange 输出——为后续编辑接口预留；焦点不在本元素时
 *   回调 null（仅一次，不重复刷屏）。
 * - 编辑接口：cut / copy / paste / selectAll，注册全局右键菜单时直接
 *   使用（菜单项：剪切、复制、粘贴、分隔线、全选）。剪切/复制需非空
 *   选区，粘贴走后端 readClipboard（与编辑器粘贴同一条链路，规避
 *   WebView 剪贴板读权限问题），仅消费 text 携带的纯文本。
 * - 值语义：getValue 恒为纯文本；oninput 实时回调；onchange 在 Enter
 *   / 失焦时提交（值与聚焦时刻不同才触发，与原生 change 事件同口径），
 *   是否 trim 由调用方决定。
 *
 * 占位符经 data-empty + data-placeholder 属性由样式侧渲染
 * （.ti-core[data-empty="true"]::before）。
 */
import { get } from "svelte/store";
import {
  registerContextMenuTarget,
  type ContextMenuResolve,
} from "../contextmenuRegistry";
import { type ContextMenuItem } from "../contextmenu";
import { readClipboard } from "../bridge";
import { t } from "../i18n.svelte";

/** 归一化选区（文本偏移；start ≤ end） */
export interface TextInputSelection {
  start: number;
  end: number;
  collapsed: boolean;
}

export interface TextInputOptions {
  /** 追加到 ti-core 基类之外的样式类（如 sp-input） */
  className?: string;
  placeholder?: string;
  spellcheck?: boolean;
  value?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 实时输入回调（内容变化时） */
  oninput?: (v: string) => void;
  /** 提交回调（Enter / 失焦；值未变化不触发） */
  onchange?: (v: string) => void;
  /** 选区/光标变化回调（焦点不在本元素时回调 null） */
  onSelectionChange?: (sel: TextInputSelection | null) => void;
  /** keydown 转发（内部处理之前；返回 true = 已消费，跳过内部处理） */
  onkeydown?: (ev: KeyboardEvent) => boolean | void;
  /** beforeinput 拦截（内部换行/富文本处理之前；返回 true = 已消费） */
  onbeforeinput?: (ev: InputEvent) => boolean | void;
}

/** plaintext-only 支持探测（Chromium / 新版 WebKit 均支持） */
const PLAINTEXT_SUPPORTED = ((): boolean => {
  try {
    const probe = document.createElement("div");
    probe.contentEditable = "plaintext-only";
    return probe.contentEditable === "plaintext-only";
  } catch {
    return false;
  }
})();

/** i18n 快照读取（与 searchPanel.ph 同口径，面板脱离组件树） */
function tr(key: string): string {
  try {
    return get(t)(key) ?? key;
  } catch {
    return key;
  }
}

/** 单行输入：把剪贴板文本里的换行统一压成空格（\r\n 视为一个换行） */
function toSingleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

export class TextInputController {
  readonly el: HTMLDivElement;
  private opts: TextInputOptions;
  private unRegisterMenu: () => void;
  private focused = false;
  /** 聚焦时刻的值（change 事件同口径：与提交时比较） */
  private valueAtFocus = "";
  /** 上次上报的选区键（缓存避免重复回调） */
  private lastReported: string | null = "";

  constructor(options: TextInputOptions = {}) {
    this.opts = options;
    const el = document.createElement("div");
    el.classList.add("ti-core");
    if (options.className) el.classList.add(options.className);
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "false");
    el.setAttribute(
      "contenteditable",
      PLAINTEXT_SUPPORTED ? "plaintext-only" : "true",
    );
    el.setAttribute("spellcheck", String(options.spellcheck ?? false));
    el.setAttribute("data-empty", "true");
    if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel);
    if (options.placeholder)
      el.setAttribute("data-placeholder", options.placeholder);
    if (options.disabled) this.applyDisabled(el, true);
    el.style.outline = "none";
    /* 单行输入：不换行、溢出隐藏（打字时浏览器仍会把光标滚入视口） */
    el.style.whiteSpace = "pre";
    el.style.overflow = "hidden";
    el.style.minWidth = "0";
    this.el = el;

    if (options.value) el.textContent = options.value;
    this.updateEmptyFlag();

    el.addEventListener("input", this.onInput);
    el.addEventListener("keydown", this.onKeyDown);
    el.addEventListener("beforeinput", this.onBeforeInput);
    el.addEventListener("focus", this.onFocus);
    el.addEventListener("blur", this.onBlur);
    el.addEventListener("paste", this.onPaste);
    document.addEventListener("selectionchange", this.onSelectionChangeDoc);

    /* 全局右键菜单：剪切、复制、粘贴、分隔线、全选 */
    this.unRegisterMenu = registerContextMenuTarget(el, () =>
      this.buildMenuItems(),
    );
  }

  /* ---------------- 值 ---------------- */

  getValue(): string {
    return this.el.textContent ?? "";
  }

  /** 程序化设值：内容相同则跳过（不触发 oninput，防外层回写循环） */
  setValue(v: string): void {
    if (v === this.getValue()) return;
    this.el.textContent = v;
    this.updateEmptyFlag();
    /* 若聚焦：保持光标在末尾（外部驱动更新不丢光标） */
    if (this.focused && document.activeElement === this.el) {
      this.setCaretEnd();
    }
    this.reportSelection();
  }

  setPlaceholder(p: string): void {
    this.opts.placeholder = p;
    if (p) this.el.setAttribute("data-placeholder", p);
    else this.el.removeAttribute("data-placeholder");
  }

  setDisabled(d: boolean): void {
    this.opts.disabled = d;
    this.applyDisabled(this.el, d);
  }

  private applyDisabled(el: HTMLElement, d: boolean): void {
    el.setAttribute(
      "contenteditable",
      d ? "false" : PLAINTEXT_SUPPORTED ? "plaintext-only" : "true",
    );
    el.setAttribute("aria-disabled", String(d));
    el.setAttribute("data-disabled", String(d));
  }

  private updateEmptyFlag(el: HTMLElement = this.el): void {
    el.setAttribute("data-empty", (el.textContent ?? "") === "" ? "true" : "false");
  }

  /* ---------------- 焦点与选区 ---------------- */

  focus(): void {
    this.el.focus();
  }

  blur(): void {
    this.el.blur();
  }

  /** 全选内容 */
  selectAll(): boolean {
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(this.el);
    sel.removeAllRanges();
    sel.addRange(range);
    this.reportSelection();
    return true;
  }

  /** 全选并聚焦（原生 input.select() 语义） */
  select(): boolean {
    this.focus();
    return this.selectAll();
  }

  /** 当前选区（焦点不在本元素时为 null） */
  getSelection(): TextInputSelection | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || document.activeElement !== this.el) {
      return null;
    }
    if (!this.ownsNode(sel.anchorNode) || !this.ownsNode(sel.focusNode)) {
      return null;
    }
    const range = sel.getRangeAt(0);
    const start = this.offsetOf(range.startContainer, range.startOffset);
    const end = this.offsetOf(range.endContainer, range.endOffset);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      collapsed: sel.isCollapsed,
    };
  }

  /** 当前选区文本（仅限归属本元素的选区；无/外部选区为空串） */
  getSelectionText(): string {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    if (!this.ownsNode(sel.anchorNode) || !this.ownsNode(sel.focusNode)) {
      return "";
    }
    return sel.toString();
  }

  private ownsNode(n: Node | null): boolean {
    return !!n && (n === this.el || this.el.contains(n));
  }

  /** 边界容器/偏移 → 元素内文本偏移（Range.toString 累计前缀文本） */
  private offsetOf(node: Node, offset: number): number {
    const range = document.createRange();
    range.selectNodeContents(this.el);
    try {
      range.setEnd(node, offset);
    } catch {
      return 0;
    }
    return range.toString().length;
  }

  private setCaretEnd(): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(this.el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private onSelectionChangeDoc = (): void => {
    if (!this.focused) return;
    this.reportSelection();
  };

  private reportSelection(): void {
    if (!this.opts.onSelectionChange) return;
    const s = this.getSelection();
    const key = s ? `${s.start}:${s.end}` : null;
    if (key === this.lastReported) return;
    this.lastReported = key;
    this.opts.onSelectionChange(s);
  }

  /* ---------------- 编辑接口 ---------------- */

  copy(): boolean {
    const text = this.getSelectionText();
    if (!text) return false;
    navigator.clipboard.writeText(text).catch(() => {
      /* 剪贴板权限失败静默（与编辑器复制同口径） */
    });
    return true;
  }

  cut(): boolean {
    const text = this.getSelectionText();
    if (!text) return false;
    navigator.clipboard.writeText(text).catch(() => {
      /* 同上 */
    });
    this.deleteSelection();
    return true;
  }


  /** 粘贴：后端读剪贴板，仅消费 text 携带的纯文本。
   *  焦点不在本元素时先聚焦并把光标落到末尾（右键聚焦场景）。 */
  async paste(): Promise<boolean> {
    if (document.activeElement !== this.el) {
      this.focus();
      this.setCaretEnd();
    }
    let text: string | undefined;
    try {
      const payload = await readClipboard();
      if (payload.kind === "text") {
        text = payload.text;
      }
    } catch {
      return false; /* 取消 / 后端失败：无动作 */
    }
    if (!text) return false;
    this.insertText(toSingleLine(text));
    return true;
  }

  private deleteSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    this.replaceSelectionManual("");
  }

  private insertText(text: string): void {
    if (!text) return;
    this.replaceSelectionManual(text);
  }

  /** 把光标定位到元素内文本偏移 offset 处（clamp 到有效范围） */
  private setCaretAtOffset(offset: number): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (len > 0 && remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    /* 空内容或 offset 越界：落到末尾 */
    range.selectNodeContents(this.el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 全文拼接 + 光标落到插入末尾（唯一编辑路径） */
  private replaceSelectionManual(text: string): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this.ownsNode(range.startContainer)) return;
    const value = this.getValue();
    const start = this.offsetOf(range.startContainer, range.startOffset);
    const end = this.offsetOf(range.endContainer, range.endOffset);
    const from = Math.min(start, end);
    const next =
      value.slice(0, from) + text + value.slice(Math.max(start, end));
    this.el.textContent = next;
    this.updateEmptyFlag();
    this.setCaretAtOffset(from + text.length); // ← 原 setCaretEnd() 改这里
    this.opts.oninput?.(next);
  }

  /* ---------------- 事件 ---------------- */

  private onInput = (): void => {
    this.updateEmptyFlag();
    this.opts.oninput?.(this.getValue());
    this.reportSelection();
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (this.opts.onkeydown?.(ev) === true) return;
    /* 单行：Enter 提交并阻止换行（原生 input 的 Enter 语义） */
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      this.commit();
    }
  };

  private onBeforeInput = (ev: InputEvent): void => {
    if (this.opts.onbeforeinput?.(ev) === true) return;
    if (PLAINTEXT_SUPPORTED) return;
    if (ev.inputType === "insertParagraph" || ev.inputType === "insertLineBreak") {
      ev.preventDefault();
      return;
    }
    if (
      ev.inputType === "insertFromDrop" ||
      ev.inputType.startsWith("insertReplacementText")
    ) {
      ev.preventDefault();
      const text = ev.dataTransfer?.getData("text/plain");
      if (text) this.insertText(toSingleLine(text));   // 拖拽也单行化
      return;
    }
    if (ev.inputType.startsWith("format")) ev.preventDefault();
  };

  private onFocus = (): void => {
    this.focused = true;
    this.valueAtFocus = this.getValue();
    this.lastReported = "";
    this.reportSelection();
  };

  private onBlur = (): void => {
    this.focused = false;
    this.commit();
    this.reportSelection();
  };

  private onPaste = (ev: ClipboardEvent): void => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData("text/plain");
    if (text) {
      this.insertText(toSingleLine(text));
      return;
    }
    /* clipboardData 读不到（WebView 剪贴板读权限受限）：走后端，与右键菜单同一条链路 */
    void this.pasteFromBackend();
  };

  private async pasteFromBackend(): Promise<void> {
    try {
      const payload = await readClipboard();
      if (payload.kind === "text") {
        const text = toSingleLine(payload.text!);
        if (text) this.insertText(text);
      }
    } catch {
      /* 取消 / 后端失败：无动作 */
    }
  }

  /** Enter / 失焦提交：值与聚焦时刻不同才触发（原生 change 同口径） */
  private commit(): void {
    const value = this.getValue();
    if (value === this.valueAtFocus) return;
    this.valueAtFocus = value;
    this.opts.onchange?.(value);
  }

  /* ---------------- 右键菜单 ---------------- */

  private buildMenuItems(): ContextMenuResolve | null {
    const sel = this.getSelection();
    const hasSel =
      !!sel && !sel.collapsed && this.getSelectionText().length > 0;
    const items: ContextMenuItem[] = [
      {
        icon: "scissors",
        label: tr("edit.cut"),
        disabled: !hasSel || !!this.opts.disabled,
        action: () => {
          this.focus();
          this.cut();
        },
      },
      {
        icon: "copy",
        label: tr("edit.copy"),
        disabled: !hasSel,
        action: () => {
          this.focus();
          this.copy();
        },
      },
      {
        icon: "clipboard",
        label: tr("edit.paste"),
        disabled: !!this.opts.disabled,
        action: () => void this.paste(),
      },
      { kind: "separator", label: "" },
      {
        label: tr("edit.selectAll"),
        disabled: this.getValue() === "",
        action: () => {
          this.focus();
          this.selectAll();
        },
      },
    ];
    return { items };
  }

  /* ---------------- 生命周期 ---------------- */

  destroy(): void {
    this.unRegisterMenu();
    this.el.removeEventListener("input", this.onInput);
    this.el.removeEventListener("keydown", this.onKeyDown);
    this.el.removeEventListener("beforeinput", this.onBeforeInput);
    this.el.removeEventListener("focus", this.onFocus);
    this.el.removeEventListener("blur", this.onBlur);
    document.removeEventListener("selectionchange", this.onSelectionChangeDoc);
  }
}

/** 工厂：searchPanel 等非 Svelte 场景直接创建（el 由调用方挂载） */
export function createTextInput(
  options: TextInputOptions = {},
): TextInputController {
  return new TextInputController(options);
}
