<script lang="ts">
    import Icon from "./Icon.svelte";
  import NumberInput from "./NumberInput.svelte";
  import TextInput from "./TextInput.svelte";
  import { t, locale, langSetting, setLang } from "../lib/i18n.svelte";
  import { THEMES, THEME_CARD_DESC, EDITOR_FONT_FALLBACK, PREVIEW_FONT_FALLBACK } from "../lib/themes";
  import {
    theme$ as theme,
    indent$ as indent,
    countMode$ as countMode,
    fontEditor$ as fontEditor,
    fontPreview$ as fontPreview,
    fontSizeEd$ as fontSizeEd,
    fontSizePv$ as fontSizePv,
    defaultLayout$ as defaultLayout,
    settingsOpen$ as settingsOpen,
  } from "../lib/stores";
  import type { ThemeId, LangSetting, IndentId, CountMode, DefaultLayout } from "../lib/types";



  /* ---------- 主题：一维卡片（明暗两组，组内按主题名排序） ---------- */
  const themeList = [...THEMES].sort((a, b) => {
    if (a.dark !== b.dark) return a.dark ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const desc = $derived($locale === "zh" ? THEME_CARD_DESC.zh : THEME_CARD_DESC.en);

  /* 语言设置：跟随系统（默认）+ 可用语言。zh/en 标签用各自语言原文展示；
     高亮依据 langSetting 原始值（而非解析后的 locale），跟随系统与手动
     选择的生效语言可同时区分 */
  const langs: { id: LangSetting; key?: string; label?: string }[] = [
    { id: "system", key: "settings.langSystem" },
    { id: "zh", label: "中文" },
    { id: "en", label: "English" },
  ];

  const indents: { id: IndentId; key: string }[] = [
    { id: "tab", key: "settings.indentTab" },
    { id: "space2", key: "settings.indentSpace2" },
    { id: "space4", key: "settings.indentSpace4" },
  ];

  const counts: { id: CountMode; key: string }[] = [
    { id: "auto", key: "settings.countAuto" },
    { id: "chars", key: "settings.countChars" },
    { id: "words", key: "settings.countWords" },
  ];

  /* 启动时的默认布局（mode.* 复用源码/双栏/预览文案） */
  const layouts: { id: DefaultLayout; key: string }[] = [
    { id: "memory", key: "settings.layoutMemory" },
    { id: "source", key: "mode.source" },
    { id: "split", key: "mode.split" },
    { id: "preview", key: "mode.preview" },
  ];
</script>

{#if $settingsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 grid place-items-center"
    style="background-color: rgba(0, 0, 0, 0.45);"
    role="dialog"
    aria-modal="true"
    aria-label={$t("settings.title")}
    tabindex="-1"
    onclick={(e) => e.target === e.currentTarget && settingsOpen.set(false)}
  >
    <div
      class="w-[440px] max-w-[calc(100vw-48px)] overflow-hidden rounded-2xl border border-line bg-soft py-5 shadow-2xl"
    >
      <header class="mb-4 flex items-center justify-between px-5">
        <h2 class="text-sm font-semibold text-fg">{$t("settings.title")}</h2>
        <button class="icon-btn" title={$t("common.close")} aria-label={$t("common.close")} onclick={() => settingsOpen.set(false)}>
          <Icon name="close" />
        </button>
      </header>

      <!-- 滚动条常驻占位（scroll 而非 auto）：首帧即按 classic 布局，
           避开 webkitgtk overlay/classic 切换导致的抖动 -->
      <section class="settings-scroll max-h-[70vh] overflow-y-auto">
        <div class="flex flex-col gap-4 p-5 pt-0">
        <!-- 外观：一维主题卡片（每主题一张，卡片样式即主题本身） -->
        <div>
          <div class="mb-2 text-xs text-muted">{$t("settings.appearance")}</div>
          <div class="grid grid-cols-2 gap-2">
            {#each themeList as tv (tv.id)}
              {@const vars = tv.vars}
              <button
                class="theme-card !block !p-0 overflow-hidden text-left"
                class:active={$theme === tv.id}
                style:background={vars["--pv-bg"]}
                style:color={vars["--pv-fg"]}
                style:border-color={$theme === tv.id ? vars["--ui-accent"] : vars["--ui-border"]}
                style:--card-strong={vars["--pv-fg-strong"]}
                style:--card-muted={vars["--pv-muted"]}
                style:--card-link={vars["--pv-link"]}
                onclick={() => theme.set(tv.id)}
              >
                <span class="block px-3 pt-2.5 text-xs font-semibold" style:color={vars["--card-strong"]}>
                  {tv.name}
                </span>
                <span class="theme-desc block px-3 pb-2.5 pt-1 text-[11px] leading-snug">
                  {@html desc}
                </span>
              </button>
            {/each}
          </div>
        </div>

        <!-- 字体与字号：编辑区/预览区交替排布 -->
        <div>
          <div class="mb-2 text-xs text-muted">{$t("settings.fontEditor")}</div>
          <TextInput value={$fontEditor} placeholder={EDITOR_FONT_FALLBACK} onchange={(v) => fontEditor.set(v)} />
          <div class="mb-2 mt-3 flex items-center justify-between">
            <span class="text-xs text-muted">{$t("settings.fontSizeEditor")}</span>
            <NumberInput value={$fontSizeEd} min={11} max={26} step={0.5} onchange={(v) => fontSizeEd.set(v)} />
          </div>
          <div class="mb-2 mt-3 text-xs text-muted">{$t("settings.fontPreview")}</div>
          <TextInput value={$fontPreview} placeholder={PREVIEW_FONT_FALLBACK} onchange={(v) => fontPreview.set(v)} />
          <div class="mb-2 mt-3 flex items-center justify-between">
            <span class="text-xs text-muted">{$t("settings.fontSizePreview")}</span>
            <NumberInput value={$fontSizePv} min={11} max={26} step={0.5} onchange={(v) => fontSizePv.set(v)} />
          </div>
        </div>

        <!-- 通用 -->
        <div>
          <div class="mb-2 text-xs text-muted">{$t("settings.general")}</div>
          <div class="mb-2 text-[11px] text-muted">{$t("settings.defaultLayout")}</div>
          <div class="mb-3 flex gap-2">
            {#each layouts as l (l.id)}
              <button
                class="pill"
                class:active={$defaultLayout === l.id}
                onclick={() => defaultLayout.set(l.id)}
              >
                {$t(l.key)}
              </button>
            {/each}
          </div>
          <div class="mb-2 text-[11px] text-muted">{$t("settings.countMode")}</div>
          <div class="mb-3 flex gap-2">
            {#each counts as c (c.id)}
              <button
                class="pill"
                class:active={$countMode === c.id}
                onclick={() => countMode.set(c.id)}
              >
                {$t(c.key)}
              </button>
            {/each}
          </div>
          <div class="mb-2 text-[11px] text-muted">{$t("settings.language")}</div>
          <div class="mb-3 flex gap-2">
            {#each langs as l (l.id)}
              <button
                class="pill"
                class:active={$langSetting === l.id}
                onclick={() => setLang(l.id)}
              >
                {l.key ? $t(l.key) : l.label}
              </button>
            {/each}
          </div>
          <div class="mb-2 text-[11px] text-muted">{$t("settings.indentUnit")}</div>
          <div class="flex gap-2">
            {#each indents as it (it.id)}
              <button
                class="pill"
                class:active={$indent === it.id}
                onclick={() => indent.set(it.id)}
              >
                {$t(it.key)}
              </button>
            {/each}
          </div>
          <div class="mt-1.5 text-[11px] text-muted">{$t("settings.indentHint")}</div>
        </div>
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  /* 滚动条常驻：scroll（而非 auto）让槽位从首帧起就固定占位，
     webkitgtk 不再在 overlay/classic 间切换，抖动消失 */
  .settings-scroll {
    overflow-y: scroll;
  }
</style>
