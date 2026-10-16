<script lang="ts">
  import Icon from "./Icon.svelte";
  import NumberInput from "./NumberInput.svelte";
  import TextInput from "./TextInput.svelte";
  import { t, locale, langSetting, setLang } from "../lib/i18n.svelte";
  import {
    THEMES,
    THEME_CARD_DESC,
    EDITOR_FONT_FALLBACK,
    PREVIEW_FONT_FALLBACK,
  } from "../lib/themes";
  import { licenseEntries } from "../lib/licenses";
  import { COMMIT_DATE, COMMIT_HASH } from "../lib/generated/version";
  import { openExternal } from "../lib/bridge";
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
    settingsSubPage$ as settingsSubPage,
  } from "../lib/stores";
  import type {
    LangSetting,
    IndentId,
    CountMode,
    DefaultLayout,
  } from "../lib/types";

  /* ---------- 主题：一维卡片（明暗两组，组内按主题名排序） ---------- */
  const themeList = [...THEMES].sort((a, b) => {
    if (a.dark !== b.dark) return a.dark ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const desc = $derived(
    $locale === "zh" ? THEME_CARD_DESC.zh : THEME_CARD_DESC.en,
  );

  /* 一级页面「主题」选择器内展示的当前主题卡片 */
  const currentTheme = $derived(
    themeList.find((tv) => tv.id === $theme) ?? themeList[0],
  );

  /* 二级页面标题（「设置」面包屑之后展示） */
  const subPageTitle = $derived(
    $settingsSubPage === "theme"
      ? $t("settings.appearance")
      : $settingsSubPage === "licenses"
        ? $t("settings.openSourceLicenses")
        : "",
  );

  /* 面板关闭时复位二级页面，下次打开回到一级 */
  $effect(() => {
    if (!$settingsOpen) settingsSubPage.set(null);
  });

  /* 二级页面滚动位置记忆：
     - 进入二级页面时记录一级页面的滚动位置，并把滚动条重置到顶部；
     - 退出二级页面时，待 DOM 恢复为一级页面内容后再还原滚动位置；
     - 面板被直接关闭（未逐级返回）时清空记忆，避免下次打开用过期状态恢复 */
  let scrollEl = $state<HTMLElement | undefined>(undefined);
  let savedScrollTop = 0;
  let prevSubPage: typeof $settingsSubPage = null;

  $effect(() => {
    const el = scrollEl;
    const subPage = $settingsSubPage;

    if (!el) {
      /* 面板未挂载（关闭中/已关闭）：丢弃上一次的记忆 */
      prevSubPage = null;
      savedScrollTop = 0;
      return;
    }

    if (subPage && prevSubPage === null) {
      /* 进入二级页面 */
      savedScrollTop = el.scrollTop;
      el.scrollTop = 0;
    } else if (!subPage && prevSubPage !== null) {
      /* 退出二级页面：等下一帧内容高度已恢复后再还原 */
      const top = savedScrollTop;
      requestAnimationFrame(() => {
        if (el.isConnected) el.scrollTop = top;
      });
    }
    prevSubPage = subPage;
  });

  /* 右向箭头：与查找替换面板 ↑/↓ 按键图标同一绘制方式（feather 描边 polyline），
     仅旋转方向不同 */
  const crumbArrow =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

  /* Open Source Initiative 的 LOGO（keyhole 标志，官方 SVG 提取，单色填充随主题） */
  const osiLogo =
    '<svg width="15" height="15" viewBox="21.9 5.4 166 159.6" fill="currentColor" aria-hidden="true"><path d="M114.7,115.5c11.9-4.4,18.1-12.9,18.1-27.5c0-14.6-12.3-27.5-27.7-27.5c-16.2,0-28.5,12.9-28.3,27.5 c0.2,14.7,7.2,24.4,18.4,28l-19.8,48.8c-26.5-6.9-53.5-38.2-53.5-76.7c0-45.7,36.7-82.7,82.7-82.7c46,0,83.3,37,83.3,82.7 c0,39.2-26.7,70-53.9,76.9L114.7,115.5z"></path></svg>';

  /* 链接劫持：与预览区一致——阻止默认导航，交由后端（Wails Browser）打开 */
  function hijackLinks(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    void openExternal(href);
  }

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
        <h2 class="flex items-center gap-1 text-sm font-semibold text-fg">
          {#if $settingsSubPage}
            <!-- 二级页面：弱化「设置」+ 右向箭头 + 二级页标题（面包屑） -->
            <button
              class="crumb-root"
              onclick={() => settingsSubPage.set(null)}
            >
              {$t("settings.title")}
            </button>
            <span class="crumb-arrow" aria-hidden="true"
              >{@html crumbArrow}</span
            >
            <span>{subPageTitle}</span>
          {:else}
            {$t("settings.title")}
          {/if}
        </h2>
        <button
          class="icon-btn"
          title={$t("common.close")}
          aria-label={$t("common.close")}
          onclick={() => settingsOpen.set(false)}
        >
          <Icon name="close" />
        </button>
      </header>

      <!-- 滚动条常驻占位（scroll 而非 auto）：首帧即按 classic 布局，
           避开 webkitgtk overlay/classic 切换导致的抖动 -->
      <section
        class="settings-scroll max-h-[70vh] overflow-y-auto"
        bind:this={scrollEl}
      >
        <div class="flex flex-col gap-4 p-5 pt-0">
          {#if $settingsSubPage === "theme"}
            <!-- 主题二级页：卡片排布与原外观设置一致（明暗两组，组内按主题名排序） -->
            <div class="grid grid-cols-2 gap-2">
              {#each themeList as tv (tv.id)}
                {@const vars = tv.vars}
                <button
                  class="theme-card !block !p-0 overflow-hidden text-left"
                  class:active={$theme === tv.id}
                  style:background={vars["--pv-bg"]}
                  style:color={vars["--pv-fg"]}
                  style:border-color={$theme === tv.id
                    ? vars["--ui-accent"]
                    : vars["--ui-border"]}
                  style:--card-strong={vars["--pv-fg-strong"]}
                  style:--card-muted={vars["--pv-muted"]}
                  style:--card-link={vars["--pv-link"]}
                  onclick={() => theme.set(tv.id)}
                >
                  <span
                    class="block px-3 pt-2.5 text-xs font-semibold"
                    style:color={vars["--card-strong"]}
                  >
                    {tv.name}
                  </span>
                  <span
                    class="theme-desc block px-3 pb-2.5 pt-1 text-[11px] leading-snug"
                  >
                    {@html desc}
                  </span>
                </button>
              {/each}
            </div>
          {:else if $settingsSubPage === "licenses"}
            <!-- 开源许可二级页：前端 / 后端依赖（含 wails 框架）+ 美术资产，
               按名称排序卡片陈列；链接劫持交由后端打开（与预览区一致） -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="flex flex-col gap-2" onclick={hijackLinks}>
              {#each licenseEntries as dep (`${dep.name}@${dep.version}`)}
                <div class="license-card flex flex-col gap-1">
                  <!-- 第一行：模块名（允许换行并防止长路径溢出） -->
                  <a class="license-name break-all" href={dep.url}>{dep.name}</a
                  >

                  <!-- 第二行：版本号与许可证类型 -->
                  <div
                    class="grid grid-cols-[1fr_auto] items-center gap-2 text-xs font-bold"
                  >
                    <span class="license-version font-mono">
                      {#if dep.version}{dep.version}{/if}
                    </span>
                    <span class="license-type">
                      {#if dep.license && dep.license !== "unknown"}{dep.license}{/if}
                    </span>
                  </div>
                  {#if dep.copyright}
                    <div class="license-copyright">{dep.copyright}</div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <!-- 主题：被选择器样式包裹的当前主题卡片，点击进入主题二级页面 -->
            <div>
              <div class="mb-2 text-xs text-muted">
                {$t("settings.appearance")}
              </div>
              <button
                class="theme-selector"
                title={$t("settings.appearance")}
                onclick={() => settingsSubPage.set("theme")}
              >
                <span
                  class="theme-card active !block !p-0 overflow-hidden text-left"
                  style:background={currentTheme.vars["--pv-bg"]}
                  style:color={currentTheme.vars["--pv-fg"]}
                  style:border-color="transparent"
                  style:--card-strong={currentTheme.vars["--pv-fg-strong"]}
                  style:--card-muted={currentTheme.vars["--pv-muted"]}
                  style:--card-link={currentTheme.vars["--pv-link"]}
                >
                  <span
                    class="block px-3 pt-2.5 text-xs font-semibold"
                    style:color={currentTheme.vars["--card-strong"]}
                  >
                    {currentTheme.name}
                  </span>
                  <span
                    class="theme-desc block px-3 pb-2.5 pt-1 text-[11px] leading-snug"
                  >
                    {@html desc}
                  </span>
                </span>
                <span class="crumb-arrow" aria-hidden="true"
                  >{@html crumbArrow}</span
                >
              </button>
            </div>

            <!-- 字体与字号：编辑区/预览区交替排布 -->
            <div>
              <div class="mb-2 text-xs text-muted">
                {$t("settings.fontEditor")}
              </div>
              <TextInput
                value={$fontEditor}
                placeholder={EDITOR_FONT_FALLBACK}
                onchange={(v) => fontEditor.set(v)}
              />
              <div class="mb-2 mt-3 flex items-center justify-between">
                <span class="text-xs text-muted"
                  >{$t("settings.fontSizeEditor")}</span
                >
                <NumberInput
                  value={$fontSizeEd}
                  min={11}
                  max={26}
                  step={0.5}
                  onchange={(v) => fontSizeEd.set(v)}
                />
              </div>
              <div class="mb-2 mt-3 text-xs text-muted">
                {$t("settings.fontPreview")}
              </div>
              <TextInput
                value={$fontPreview}
                placeholder={PREVIEW_FONT_FALLBACK}
                onchange={(v) => fontPreview.set(v)}
              />
              <div class="mb-2 mt-3 flex items-center justify-between">
                <span class="text-xs text-muted"
                  >{$t("settings.fontSizePreview")}</span
                >
                <NumberInput
                  value={$fontSizePv}
                  min={11}
                  max={26}
                  step={0.5}
                  onchange={(v) => fontSizePv.set(v)}
                />
              </div>
            </div>

            <!-- 通用 -->
            <div>
              <div class="mb-2 text-xs text-muted">
                {$t("settings.general")}
              </div>
              <div class="mb-2 text-[11px] text-muted">
                {$t("settings.defaultLayout")}
              </div>
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
              <div class="mb-2 text-[11px] text-muted">
                {$t("settings.countMode")}
              </div>
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
              <div class="mb-2 text-[11px] text-muted">
                {$t("settings.language")}
              </div>
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
              <div class="mb-2 text-[11px] text-muted">
                {$t("settings.indentUnit")}
              </div>
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
            </div>

            <!-- 应用信息：无设置项文本，固定在所有设置项末尾 -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="app-info" onclick={hijackLinks}>
              <img class="app-info-logo" src="/bird.svg" alt="Quail" />
              <div class="app-info-name">Quail</div>
              <div class="app-info-version-group">
                {#if COMMIT_DATE}
                  <div class="app-info-version">Version {COMMIT_DATE}</div>
                {/if}
                <div class="app-info-commit" title="Commit hash">
                  {COMMIT_HASH}
                </div>
              </div>
              <div class="app-info-copyright">{$t("settings.copyright")}</div>
              <button
                class="license-btn"
                onclick={() => settingsSubPage.set("licenses")}
              >
                <span class="license-btn-icon" aria-hidden="true"
                  >{@html osiLogo}</span
                >
                <span>{$t("settings.openSourceLicenses")}</span>
              </button>
            </div>
          {/if}
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
