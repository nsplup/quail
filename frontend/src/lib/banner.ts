/**
 * 顶部横幅状态：外部修改 / 外部删除事件的非模态响应（替代原 TOAST 提示）。
 *
 * - 横幅不阻塞编辑，也无键盘交互（无默认聚焦按钮、不响应键盘事件），
 *   用户通过鼠标点击按钮显式选择；
 * - 可配置化：说明文本（messageKey/messageParams，组件内 $t 响应式解析，
 *   语言切换即时生效）与按钮组（buttons，对齐 lib/dialog.ts 的 DialogButton
 *   口径：value/label/icon）完全由发起方注入，组件零业务分支；
 *   差异点：Dialog 是 Promise 化的模态确认（resolve value），横幅为非模态
 *   浮层，动作以 run 回调注入——点击后横幅先行收起再执行；
 * - label 为发起方 set 时的即时翻译文案（与 DialogButton 同口径）：横幅
 *   展示期间语言切换不回翻按钮文案（横幅为短时提示，可接受；说明文本
 *   仍随 $t 响应式回翻）；
 * - 同类新事件到达时直接覆盖旧状态（横幅始终反映磁盘最新事实）。
 */
import { writable } from "svelte/store";

/**
 * 横幅按钮：对齐 lib/dialog.ts 的 DialogButton 口径（value/label/icon）。
 * value 为按钮标识；label 为已翻译文案；icon 复用 Icon.svelte 现有描边
 * 图标名。run 缺省仅收起横幅（忽略语义）。
 */
export type BannerButton = {
  value: string;
  label: string;
  icon?: string;
  /** 点击动作：横幅先行收起再执行（confirm 口径：应答即收） */
  run?: () => void;
};

export interface BannerState {
  /** 说明文本 i18n key（banner.* 命名空间），组件内 $t 解析 */
  messageKey: string;
  /** 说明文本插值参数（如 { path }），组件内以 { values } 传入 */
  messageParams?: Record<string, unknown>;
  /** 按钮组（主操作在前）；「忽略」为组件固有交互，固定追加末尾 */
  buttons: BannerButton[];
}

export const banner$ = writable<BannerState | null>(null);

/**
 * 收起横幅（按钮点击之外的事实消解点调用）：用户绕过横幅直接保存/另存为/
 * 重建成功后，横幅报告的磁盘事实已不复存在，收起可能残留的横幅。
 */
export function closeBanner(): void {
  banner$.set(null);
}
