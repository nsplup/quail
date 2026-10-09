/**
 * 选区同步桥（CM6 扩展，用户手势触发版）：
 * 由 document 级 mouseup（用户手势）驱动——手势结束后从 CM6
 * 拉取当前选区快照，提交到剪贴板（navigator.clipboard.writeText）；
 * 手势上下文保证剪贴板写入不受浏览器安全限制。
 * 同时派发应用内事件 editor-selection（detail 为快照对象）供其他模块跟踪。
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

/** 提交给宿主的选区快照 */
export interface SelectionSnapshot {
  /** 锚点（固定端） */
  anchor: number;
  /** 头部（活动端） */
  head: number;
  /** 起始偏移（min(anchor, head)） */
  from: number;
  /** 结束偏移（max(anchor, head)） */
  to: number;
  /** 选中文本 */
  text: string;
  /** 是否为光标（无选中内容） */
  empty: boolean;
  /** 主选区是否多行 */
  multiline: boolean;
}

function readSelection(view: EditorView): SelectionSnapshot {
  const sel = view.state.selection.main;
  const from = Math.min(sel.from, sel.to);
  const to = Math.max(sel.from, sel.to);
  return {
    anchor: sel.anchor,
    head: sel.head,
    from,
    to,
    text: view.state.doc.sliceString(from, to),
    empty: sel.empty,
    multiline:
      !sel.empty && view.state.doc.lineAt(from).number !== view.state.doc.lineAt(to).number,
  };
}

function submit(snapshot: SelectionSnapshot): void {
  // 提交目标 = 剪贴板（手势触发，writeText 在手势上下文中可行）
  if (snapshot.text) {
    void navigator.clipboard.writeText(snapshot.text).catch(() => {
      /* 剪贴板不可用（权限/无手势）时静默 */
    });
  }
  // 应用内兜底：其他模块可监听该事件跟踪当前选区
  window.dispatchEvent(new CustomEvent("editor-selection", { detail: snapshot }));
}

/**
 * 选区同步扩展（用户手势触发）：
 * document 级 mouseup 后在下一帧拉取 CM6 选区并提交。
 * 仅当选区相对上次提交发生变化时才发送，避免同一选区重复上报。
 */
export function selectionSyncExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private last: string = "";
      private raf = 0;

      constructor(readonly view: EditorView) {
        this.flush = this.flush.bind(this);
        document.addEventListener("mouseup", this.flush, true);
      }

      update(update: ViewUpdate): void {
        // 手势后由 flush 主动拉取；这里仅记录 docChanged 以便手势时读到新坐标
        void update;
      }

      private flush(): void {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          if (!this.view) return;
          const snapshot = readSelection(this.view);
          const key = `${snapshot.anchor}:${snapshot.head}`;
          if (key === this.last) return;
          this.last = key;
          submit(snapshot);
        });
      }

      destroy(): void {
        if (this.raf) cancelAnimationFrame(this.raf);
        document.removeEventListener("mouseup", this.flush, true);
      }
    }
  );
}
