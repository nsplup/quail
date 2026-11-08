/**
 * 弹层遮罩状态（全局 STORE）。
 *
 * 独立轻量模块（不随 stores.ts 的解析管线/后端桥导入链）：Overlay.svelte
 * 挂载/卸载时注册/注销实例，快捷键安装器（shortcuts.ts）、CM6 editable
 * 同步（codemirrorSetup.ts）、file:dropped 守卫（App.svelte）等原先用
 * 「settingsOpen$ || confirm$ !== null」组合判断遮罩是否开启的分支，
 * 一律消费派生的 overlayOpen$。
 */
import { writable, derived } from "svelte/store";

/** 开启中的遮罩实例集合（Overlay.svelte 挂载/卸载时增删，symbol 去重）。
 *  任何弹层遮罩（设置面板 / confirm 弹窗，未来可扩展）开启即注册进这里，
 *  自身的开合状态由此统一暴露给全局。 */
export const overlayRegistry$ = writable<ReadonlySet<symbol>>(new Set());
/** 派生布尔：是否存在开启中的遮罩。原先「settingsOpen$ || confirm$ !== null」
 *  的组合判断分支（全局快捷键守卫 / file:dropped 守卫 / CM6 editable 同步）
 *  一律改用本状态，口径与弹层数量解耦。 */
export const overlayOpen$ = derived(overlayRegistry$, (s) => s.size > 0);
