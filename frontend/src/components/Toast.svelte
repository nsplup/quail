<script lang="ts">
    import { toast$ as toast } from "../lib/stores";

  $effect(() => {
    if (!$toast) return;
    const timer = setTimeout(() => toast.set(null), 2400);
    return () => clearTimeout(timer);
  });
</script>

{#if $toast}
  <!-- 居中交给外层 flex 容器（不能用 translate/transform 工具类：会与 fly 过渡的
       transform 叠加导致结束时横向跳动）；内层只负责进出场动画 -->
  <div class="pointer-events-none fixed inset-x-0 bottom-12 z-[60] flex justify-center">
    <div
      class="toast rounded-full border border-line bg-soft px-4 py-2 text-xs text-fg"
      role="status"
    >
      {$toast.msg}
    </div>
  </div>
{/if}
