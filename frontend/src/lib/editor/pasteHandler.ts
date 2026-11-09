/**
 * 粘贴处理器注册表（CM6 → 应用层的解耦桥）。
 *
 * codemirrorSetup 通过 EditorView.domEventHandlers({ paste }) 把粘贴事件
 * 转发到这里注册的应用层处理器（App.svelte 启动时经 lib/editor/paste.ts
 * 的 installAppPasteHandler 注册）。注册表是纯回调存储——CM 模块保持
 * 最小构建，不引入 bridge / store / Dialog 依赖链；视图以 unknown 传递，
 * 应用层自行收窄为 EditorView（CM 类型仅出现在 codemirrorSetup 侧）。
 *
 * 处理器契约：返回 true 表示已处理（调用方 preventDefault，CM6 默认粘贴
 * 不再执行）；返回 false / void 表示未处理，走 CM6 默认粘贴。
 * 异步业务（图片落盘等）由处理器自行 void 化发起，同步返回 true。
 */
type AppPasteHandler = (event: ClipboardEvent, view: unknown) => boolean;

let handler: AppPasteHandler | null = null;

/** 注册应用层粘贴处理器（覆盖式：后注册者生效）；返回注销函数 */
export function registerPasteHandler(fn: AppPasteHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** CM paste 域事件转发入口：无注册处理器时返回 false（CM6 默认行为） */
export function runPasteHandler(event: ClipboardEvent, view: unknown): boolean {
  return handler ? handler(event, view) : false;
}
