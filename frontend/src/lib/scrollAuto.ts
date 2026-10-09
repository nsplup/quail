/**
 * 滚动条自动隐藏：
 * 滚动时给容器加 .is-scrolling，停止滚动 900ms 后移除；
 * 配合 app.css 中的 .scroll-autohide 样式，实现「非滚动状态下滚动条隐藏」。
 * （WebKit ::-webkit-scrollbar 无法纯 CSS 感知滚动状态，故用极轻量的 class 切换；
 *   Firefox 走 scrollbar-width: thin，不做自动隐藏。）
 */
export function attachScrollbarAutohide(el: HTMLElement): () => void {
  let timer: number | undefined;
  const onScroll = (): void => {
    el.classList.add("is-scrolling");
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => el.classList.remove("is-scrolling"), 900);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    el.removeEventListener("scroll", onScroll);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

/** Svelte action 用法：<div use:autohideScroll> */
export function autohideScroll(node: HTMLElement): { destroy(): void } {
  const off = attachScrollbarAutohide(node);
  return { destroy: off };
}
