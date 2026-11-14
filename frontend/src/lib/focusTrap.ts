/**
 * focus-trap 的 Svelte 5 attachment 包装。
 *
 * - 用法：`<div {@attach focusTrap({ ...options })}></div>`；
 * - attachment 保证元素已挂载到 DOM 后才会执行：此时才创建并激活 trap，
 *   元素销毁时（attachment 清理函数）自动 deactivate；
 * - 多个 trap 并存时（设置面板一级 ↔ 二级、confirm 叠加在设置面板之上），
 *   依赖 focus-trap 内部共享的激活顺序栈：后激活的 trap 压栈并自动暂停
 *   先前的 trap，自身销毁时出栈并恢复先前 trap。因此 trap 容器必须按
 *   「先一级、后二级」的顺序创建/激活 —— 调用方需保证后进入的层级的
 *   容器是在进入操作后才创建的（attachment 在元素创建时才激活 trap）。
 * - 清理时使用 focus-trap 默认的 returnFocus 行为：把焦点还给 trap 激活
 *   前的元素；若该元素已被移除则静默失败，不会阻断卸载流程。
 */
import { createFocusTrap } from "focus-trap";
import type { Options as FocusTrapOptions } from "focus-trap";
import type { Attachment } from "svelte/attachments";

export function focusTrap(
  options: FocusTrapOptions = {}
): Attachment<HTMLElement> {
  return (element) => {
    const trap = createFocusTrap(element, {
      ...options,
      // 关键：把"初始焦点"钉死为 trap 容器自身。
      // - 点击卡片空白 / 点击二级页面容器时，focus-trap 拉回的永远是
      //   容器，而不是内部的 contenteditable（contenteditable 在 tabbable
      //   的候选选择器里，很容易被误选为第一个可聚焦项，导致输入框
      //   焦点不丢）。
      // - 函数无参，返回闭包捕获的 element —— 类型即 () => HTMLElement，
      //   属于 FocusTargetOrFalse，编译通过。
      initialFocus: () => element,
      // 兜底：万一 initialFocus 因故没生效（如容器不可聚焦），
      // fallbackFocus 仍指向容器，让 trap 报错路径也能落到容器上。
      fallbackFocus: () => element,
    });
    trap.activate();
    return () => {
      trap.deactivate();
    };
  };
}