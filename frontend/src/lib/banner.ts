/**
 * 顶部横幅状态：外部修改 / 外部删除事件的非模态响应（替代原 TOAST 提示）。
 *
 * - 横幅不阻塞编辑，也无键盘交互（无默认聚焦按钮、不响应键盘事件），
 *   用户通过鼠标点击「主操作 / 忽略」显式选择；
 * - 主操作（重新加载 / 另存为）由事件订阅方以 onPrimary 回调注入，
 *   组件只负责展示与收起，不感知具体动作实现；
 * - 同类新事件到达时直接覆盖旧状态（横幅始终反映磁盘最新事实）。
 */
import { writable } from "svelte/store";

export type BannerKind = "modified" | "deleted";

export interface BannerState {
  kind: BannerKind;
  /** 触发事件的文件绝对路径（文案展示 + 主操作目标） */
  path: string;
  /** 主操作（重新加载 / 另存为）；点击后横幅先行收起，由回调执行动作 */
  onPrimary: () => void;
}

export const banner$ = writable<BannerState | null>(null);
