<script lang="ts">
  import { onMount } from "svelte";
  import { createEditorApi, type EditorApi } from "./codemirrorSetup";

  let {
    initialDoc,
    initialIndent,
    onready,
    onchange,
    onsave,
    ontopline,
    oncursorline,
    pct = null,
    lang,
  }: {
    initialDoc: string;
    /** 初始缩进单位："\t" / "  " / "    "（设置里可随时切换） */
    initialIndent: string;
    onready: (api: EditorApi) => void;
    onchange: (doc: string) => void;
    onsave: () => void;
    ontopline: (line: number) => void;
    /** 光标行变化（选区移动/编辑，rAF 合并上报）：光标行同步用 */
    oncursorline: (line: number) => void;
    pct?: number | null;
    /** 初始界面语言（CM6 phrases 用） */
    lang?: string;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);

  onMount(() => {
    if (!host) return;
    // runes 模式下 props 解构是响应式读取，闭包始终拿到最新回调
    const api = createEditorApi(
      host,
      initialDoc,
      {
        onchange: (doc) => onchange(doc),
        onsave: () => onsave(),
        ontopline: (line) => ontopline(line),
        oncursorline: (line) => oncursorline(line),
      },
      initialIndent,
      lang ?? "en"
    );
    api.markClean(); // 初始化：记录干净文档引用
    onready(api);
    return () => api.destroy();
  });
</script>

<div
  class="pane pane-editor"
  bind:this={host}
  style={pct != null
    ? `flex: 0 0 ${pct}%; min-width: 0;`
    : "flex: 1 1 auto; min-width: 0;"}
></div>
