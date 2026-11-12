/**
 * 编辑器右键菜单（主编辑器与单元格编辑器共用）。
 *
 * 复用全局右键菜单体系（lib/contextmenu 状态 + App 层挂载的
 * ContextMenu.svelte 渲染，自带外点 / Esc / 滚动 / 失焦关闭与视口边缘
 * 收敛），在 EditorView.dom 上注册 contextmenu 监听并组装编辑命令菜单：
 * 剪切、复制、粘贴、粘贴为纯文本、分隔线、全选。
 *
 * 剪切 / 全选命令由调用方注入（两个编辑器差异点：主编辑器用抑制光标
 * 同步的包装版本，单元格编辑器用普通命令）；粘贴走 lib/editor/paste.ts
 * 的 pasteFromMenu——与 Mod-v 快捷键同一条后端剪贴板链路。
 *
 * 交互保障（ContextMenu.svelte 侧已配合处理）：菜单项 mousedown 不再
 * 转移焦点，点击菜单项时编辑器不失焦——单元格编辑器 blur 即提交，
 * 焦点一旦离开，菜单动作将作用于已提交/卸载的视图而丢失。
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { openContextMenu, type ContextMenuItem } from "../contextmenu";
import { t } from "../i18n.svelte";
import { pasteFromMenu } from "./paste";

/** 两个编辑器的命令差异点由调用方注入 */
export interface EditorContextMenuOptions {
  /** 剪切命令（主编辑器：抑制滚动同步的 cutLinewise 包装） */
  cut: (view: EditorView) => boolean;
  /** 全选命令（主编辑器：selectAllSuppressCursorSync；单元格：普通全选） */
  selectAll: (view: EditorView) => boolean;
}

/**
 * 复制命令：有选区复制选区；无选区复制当前行（与 cutLinewise 的
 * linewise 语义一致，非末行时带换行符）。
 */
export function copyLinewise(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection.main;
  let from = sel.from;
  let to = sel.to;
  if (sel.empty) {
    const line = state.doc.lineAt(sel.head);
    from = line.from;
    to = line.number < state.doc.lines ? line.to + 1 : line.to;
  }
  const text = state.sliceDoc(from, to);
  if (!text) return false;
  navigator.clipboard.writeText(text).catch(() => {
    /* 剪贴板权限失败静默：系统级限制，无可靠降级路径 */
  });
  return true;
}

/**
 * 注册编辑器右键菜单；返回注销函数。
 * 菜单动作执行前先 view.focus()（若焦点已不在编辑器，命令需作用于
 * 正确的视图；配合菜单项 mousedown 抑制焦点转移，通常本就保有焦点）。
 */
export function registerEditorContextMenu(
  view: EditorView,
  options: EditorContextMenuOptions
): () => void {
  const onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation(); // 不冒泡：避免外层（表格行列菜单等）重复响应
    const tr = get(t);
    /* 剪切 / 粘贴需要可写视图；复制 / 全选在只读视图下依然可用 */
    const editable =
      view.state.facet(EditorView.editable) &&
      !view.state.facet(EditorState.readOnly);
    const items: ContextMenuItem[] = [
      {
        icon: "scissors",
        label: tr("edit.cut"),
        disabled: !editable,
        action: () => {
          view.focus();
          options.cut(view);
        },
      },
      {
        icon: "copy",
        label: tr("edit.copy"),
        action: () => {
          view.focus();
          copyLinewise(view);
        },
      },
      {
        icon: "clipboard",
        label: tr("edit.paste"),
        disabled: !editable,
        action: () => {
          view.focus();
          pasteFromMenu(view, false);
        },
      },
      {
        label: tr("edit.pastePlain"),
        disabled: !editable,
        action: () => {
          view.focus();
          pasteFromMenu(view, true);
        },
      },
      { kind: "separator", label: "" },
      {
        label: tr("edit.selectAll"),
        action: () => {
          view.focus();
          options.selectAll(view);
        },
      },
    ];
    openContextMenu(ev.clientX, ev.clientY, items);
  };
  view.dom.addEventListener("contextmenu", onContextMenu);
  return () => view.dom.removeEventListener("contextmenu", onContextMenu);
}
