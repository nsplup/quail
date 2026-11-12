/**
 * 粘贴处理器注册表（CM6 → 应用层的解耦桥）。
 *
 * codemirrorSetup 通过 keydown 拦截粘贴快捷键（Mod-v；SHIFT 按下时直接
 * 放行原生粘贴），把粘贴动作转发到这里注册的应用层处理器（App.svelte
 * 启动时经 lib/editor/paste.ts 的 installAppPasteHandler 注册）。注册表
 * 是纯回调存储——CM 模块保持最小构建，不引入 bridge / store / Dialog
 * 依赖链；视图以 unknown 传递，应用层自行收窄为 EditorView（CM 类型
 * 仅出现在 codemirrorSetup 侧）。
 *
 * 处理器契约：返回 true 表示已处理（快捷键层已 preventDefault，原生
 * paste 事件不再触发）；返回 false / void 表示未处理，走原生默认粘贴。
 * 异步业务（图片落盘等）由处理器自行 void 化发起，同步返回 true。
 */
type AppPasteHandler = (event: KeyboardEvent, view: unknown) => boolean;

let handler: AppPasteHandler | null = null;

/** 注册应用层粘贴处理器（覆盖式：后注册者生效）；返回注销函数 */
export function registerPasteHandler(fn: AppPasteHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Mod-v 快捷键转发入口：无注册处理器时返回 false（原生默认粘贴） */
export function runPasteHandler(event: KeyboardEvent, view: unknown): boolean {
  return handler ? handler(event, view) : false;
}
