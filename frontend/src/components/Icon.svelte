<script lang="ts">
  /**
   * 手写 SVG 图标（feather 风格描边），不依赖任何图标库。
   *
   * 【小尺寸清晰度】
   * viewBox 固定 24，实际渲染到 size 像素。描边线宽是 viewBox 单位，
   * 缩放到 16px 时视觉线宽只有 1.8 × 16/24 ≈ 1.2px，1x 屏上会发虚。
   * 这里按尺寸反向放大 stroke-width，让视觉线宽稳定在 1.5~1.8px。
   */
  let { name, size = 16 }: { name: string; size?: number } = $props();

  const strokeWidth = $derived(size <= 16 ? 2.3 : size <= 20 ? 2 : 1.8);

  /** 描边图标（feather 风格：fill="none" + stroke="currentColor"） */
  const icons: Record<string, string> = {
    settings:
      '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
    outline:
      '<rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="13" y1="8" x2="17" y2="8"></line>',
    code: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>',
    columns:
      '<path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"></path>',
    /* 表格（底栏插入表格 / 行列选择浮窗） */
    table:
      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line>',
    /* 行（横向线条，浮窗行列数量提示用） */
    rows: '<line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line>',
    /* 列（纵向线条，浮窗行列数量提示用） */
    cols: '<line x1="6" y1="4" x2="6" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line><line x1="18" y1="4" x2="18" y2="20"></line>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>',
    close:
      '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    "chevron-left": '<polyline points="15 18 9 12 15 6"></polyline>',
    "chevron-right": '<polyline points="9 18 15 12 9 6"></polyline>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    /* 刷新（横幅「重新加载」） */
    refresh:
      '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
    /* 软盘（保存） */
    floppy:
      '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline>',
    /* 垃圾桶（丢弃） */
    trash:
      '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
    /* 外部链接（使用外部程序打开） */
    external:
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
    /* 箭头（可编辑表格的行移动菜单项） */
    "arrow-up":
      '<line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>',
    "arrow-down":
      '<line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline>',

    /* ---------- 表格行 / 列操作（feather 描边风格，与上面一致） ---------- */
    /* 上方插入行：表格轮廓 + 上方加号 */
    "table-row-plus-before":
      '<rect x="3" y="10" width="18" height="11" rx="1.5"></rect><line x1="3" y1="15.5" x2="21" y2="15.5"></line><line x1="12" y1="2" x2="12" y2="8"></line><line x1="9" y1="5" x2="15" y2="5"></line>',
    /* 下方插入行：表格轮廓 + 下方加号 */
    "table-row-plus-after":
      '<rect x="3" y="3" width="18" height="11" rx="1.5"></rect><line x1="3" y1="8.5" x2="21" y2="8.5"></line><line x1="12" y1="16" x2="12" y2="22"></line><line x1="9" y1="19" x2="15" y2="19"></line>',
    /* 上移行 */
    "table-arrow-up":
      '<rect x="3" y="10" width="18" height="11" rx="1.5"></rect><line x1="3" y1="15.5" x2="21" y2="15.5"></line><line x1="12" y1="2" x2="12" y2="7"></line><polyline points="9 5 12 2 15 5"></polyline>',
    /* 下移行 */
    "table-arrow-down":
      '<rect x="3" y="3" width="18" height="11" rx="1.5"></rect><line x1="3" y1="8.5" x2="21" y2="8.5"></line><line x1="12" y1="17" x2="12" y2="22"></line><polyline points="9 19 12 22 15 19"></polyline>',
    /* 复制行：上方实线长条 = 原行，下方虚线长条 = 副本（副本插到下方） */
    "table-row-copy":
      '<rect x="3" y="4" width="18" height="6" rx="1.5"></rect><rect x="3" y="14" width="18" height="6" rx="1.5" stroke-dasharray="3 3" stroke-linecap="round"></rect>',
    /* 删除行 */
    "table-row-remove":
      '<rect x="3" y="3" width="18" height="11" rx="1.5"></rect><line x1="3" y1="8.5" x2="21" y2="8.5"></line><line x1="9" y1="17" x2="15" y2="22"></line><line x1="15" y1="17" x2="9" y2="22"></line>',
    /* 左侧插入列 */
    "table-column-plus-before":
      '<rect x="10" y="3" width="11" height="18" rx="1.5"></rect><line x1="15.5" y1="3" x2="15.5" y2="21"></line><line x1="2" y1="12" x2="8" y2="12"></line><line x1="5" y1="9" x2="5" y2="15"></line>',
    /* 右侧插入列 */
    "table-column-plus-after":
      '<rect x="3" y="3" width="11" height="18" rx="1.5"></rect><line x1="8.5" y1="3" x2="8.5" y2="21"></line><line x1="16" y1="12" x2="22" y2="12"></line><line x1="19" y1="9" x2="19" y2="15"></line>',
    /* 左移列 */
    "table-arrow-left":
      '<rect x="10" y="3" width="11" height="18" rx="1.5"></rect><line x1="15.5" y1="3" x2="15.5" y2="21"></line><line x1="2" y1="12" x2="7" y2="12"></line><polyline points="5 9 2 12 5 15"></polyline>',
    /* 右移列 */
    "table-arrow-right":
      '<rect x="3" y="3" width="11" height="18" rx="1.5"></rect><line x1="8.5" y1="3" x2="8.5" y2="21"></line><line x1="17" y1="12" x2="22" y2="12"></line><polyline points="19 9 22 12 19 15"></polyline>',
    /* 复制列：左侧实线竖条 = 原列，右侧虚线竖条 = 副本（副本插到右侧） */
    "table-column-copy":
      '<rect x="4" y="3" width="6" height="18" rx="1.5"></rect><rect x="14" y="3" width="6" height="18" rx="1.5" stroke-dasharray="3 3" stroke-linecap="round"></rect>',
    /* 删除列 */
    "table-column-remove":
      '<rect x="3" y="3" width="11" height="18" rx="1.5"></rect><line x1="8.5" y1="3" x2="8.5" y2="21"></line><line x1="16" y1="9" x2="22" y2="15"></line><line x1="22" y1="9" x2="16" y2="15"></line>',
  };

  /**
   * 实心图标（fill 填充、无描边）的扩展位。
   * 目前为空：行列操作图标已改为描边风格；未来如需混合 MDI 实心图标，
   * 可加到这里——渲染时会包一层 <g fill="currentColor" stroke="none">，
   * 避免继承根节点上的 fill="none" / stroke。
   */
  const filledIcons: Record<string, string> = {};
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if filledIcons[name]}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <g fill="currentColor" stroke="none">{@html filledIcons[name]}</g>
  {:else}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html icons[name] ?? ""}
  {/if}
</svg>
