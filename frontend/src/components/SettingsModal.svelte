<script lang="ts">
  import Icon from "./Icon.svelte";
  import NumberInput from "./NumberInput.svelte";
  import TextInput from "./TextInput.svelte";
  import VirtualList from "../lib/virtual/VirtualList.svelte";
  import { focusTrap } from "../lib/focusTrap";
  import { t, locale, langSetting, setLang } from "../lib/i18n.svelte";
  import {
    THEMES,
    THEME_CARD_DESC,
    EDITOR_FONT_FALLBACK,
    PREVIEW_FONT_FALLBACK,
  } from "../lib/themes";
  import { licenseEntries } from "../lib/licenses";
  import { APP_VERSION, COMMIT_HASH, SOURCE_TIME } from "../lib/generated/version";
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

  let pressedOnOverlay = false;

  const themeList = [...THEMES].sort((a, b) => {
    if (a.dark !== b.dark) return a.dark ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const desc = $derived(
    $locale === "zh" ? THEME_CARD_DESC.zh : THEME_CARD_DESC.en,
  );
  const currentTheme = $derived(
    themeList.find((tv) => tv.id === $theme) ?? themeList[0],
  );

  const subPageTitle = $derived(
    $settingsSubPage === "theme"
      ? $t("settings.appearance")
      : $settingsSubPage === "licenses"
        ? $t("settings.openSourceLicenses")
        : "",
  );

  /* 面板关闭时复位二级页面，下次打开回到一级（右栏从右侧滑回） */
  $effect(() => {
    if (!$settingsOpen) settingsSubPage.set(null);
  });

  /* 焦点圈定交给 focus-trap（lib/focusTrap.ts 的 attachment 包装）：
   * - allowOutsideClick：放行 trap 外的点击 —— 遮罩点击关闭由 overlay 的
   *   pointerdown/pointerup 处理；二级页打开时头部按钮（返回面包屑 / 关闭）
   *   位于二级页 trap 容器之外，也依赖此项才能点击；
   * - escapeDeactivates 关闭：Esc 返回一级 / 关闭面板由 App 的全局键盘
   *   守卫处理，不交给 focus-trap。
   * 同一个 attachment 工厂同时用于一级卡片与二级页面：每处元素挂载时
   * 各自创建独立的 trap 实例。 */
  const trap = focusTrap({
    allowOutsideClick: true,
    escapeDeactivates: false,
  });

  const crumbArrow =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

  const osiLogo =
    '<svg width="15" height="15" viewBox="21.9 5.4 166 159.6" fill="currentColor" aria-hidden="true"><path d="M114.7,115.5c11.9-4.4,18.1-12.9,18.1-27.5c0-14.6-12.3-27.5-27.7-27.5c-16.2,0-28.5,12.9-28.3,27.5 c0.2,14.7,7.2,24.4,18.4,28l-19.8,48.8c-26.5-6.9-53.5-38.2-53.5-76.7c0-45.7,36.7-82.7,82.7-82.7c46,0,83.3,37,83.3,82.7 c0,39.2-26.7,70-53.9,76.9L114.7,115.5z"></path></svg>';

  function hijackLinks(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    void openExternal(href);
  }

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
    class="fixed inset-0 z-50 grid place-items-center bg-black/45"
    role="dialog"
    aria-modal="true"
    aria-label={$t("settings.title")}
    tabindex="-1"
    onpointerdown={(e) => {
      pressedOnOverlay = e.target === e.currentTarget;
    }}
    onpointerup={(e) => {
      if (pressedOnOverlay && e.target === e.currentTarget)
        settingsOpen.set(false);
      pressedOnOverlay = false;
    }}
  >
    <!--
      卡片改为 flex-col + 固定高度：
      - 固定高度是「左右两栏滑动切换」的前提，否则切换时高度会跳；
      - header 单独占位，不随滑动移动；
      - flex-1 min-h-0 的滑动视窗裁掉溢出，保证只显示一屏。
      一级 trap 挂在卡片上（含 header 与一级页面）：面板打开（卡片挂载）
      时激活，是本面板 trap 队列的第一个；二级页 trap 后激活入栈时本
      trap 自动暂停，二级页销毁后自动恢复。
    -->
    <div
      class="flex h-[70vh] w-[440px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border border-line bg-soft shadow-2xl"
      {@attach trap}
    >
      <header class="flex items-center justify-between px-5 py-4">
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

      <!-- 滑动视窗：overflow-hidden 只露出当前一屏 -->
      <div class="relative min-h-0 flex-1 overflow-hidden">
        <!-- 内层 flex：宽度 = 面板宽，两个子项各占一屏，超出部分被裁；
             translateX(-100%) 相对内层自身宽度（= 面板宽）移动一屏 -->
        <div
          class="flex h-full w-full"
          style:transform={$settingsSubPage
            ? "translateX(-100%)"
            : "translateX(0)"}
        >
          <!-- ============ 一级页面（左栏） ============ -->
          <!-- w-full + shrink-0：各自占满一屏且不被压缩；
               打开面板时由一级 trap 聚焦卡片内首个可聚焦元素 -->
          <section
            class="settings-scroll h-full w-full shrink-0 overflow-y-auto"
          >
            <div class="flex flex-col gap-4 p-5 pt-0">
              <!-- 主题：被选择器样式包裹的当前主题卡片 -->
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

              <!-- 字体与字号 -->
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

              <!-- 应用信息 -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="app-info" onclick={hijackLinks}>
                <img class="app-info-logo" src="/bird.svg" alt="Quail" />
                <div class="app-info-name">Quail</div>
                <div class="app-info-version-group">
                  {#if APP_VERSION}
                    <div class="app-info-version" title={new Date(SOURCE_TIME).toLocaleString()}>Version {APP_VERSION}</div>
                  {/if}
                  <div class="app-info-commit" title="Commit hash">
                    {COMMIT_HASH}
                  </div>
                </div>
                <div class="app-info-copyright">
                  {$t("settings.copyright")}
                </div>
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
            </div>
          </section>

          <!-- ============ 二级页面（右栏） ============ -->
          <!--
            右栏是「容器」，自己不做滚动：内部由子页面决定滚动方式。
            - theme 子页面：普通 overflow-y-auto 的 div；
            - licenses 子页面：VirtualList 直接作为滚动容器（height:100%）。
            两者互斥，同一时刻只有一个滚动容器存在。
            二级页面根节点嵌套在右栏容器内（不与一级页面同级），并且只在
            进入二级页时才创建：其 attachment 在元素挂载时才激活 trap，
            晚于一级 trap 入栈 —— focus-trap 按激活顺序维护队列，二级 trap
            激活时一级 trap 自动暂停，二级页销毁（返回一级）时自动恢复。
          -->
          <div class="relative h-full w-full shrink-0">
            {#if $settingsSubPage === "theme"}
              <div class="h-full w-full" {@attach trap}>
                <div class="settings-scroll h-full w-full overflow-y-auto">
                  <div class="grid grid-cols-2 gap-2 p-5">
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
                </div>
              </div>
            {:else if $settingsSubPage === "licenses"}
              <!--
                VirtualList 自己就是滚动容器（根元素 height:100%）。
                - style 追加在组件内联样式之后，用于覆盖视觉留白；
                - padding 用左右/底部，让首项与顶部留白和左栏对齐；
                - getKey 用 name@version：重排/过滤后按 key 保留实测高度缓存。
                外层包裹二级页根节点并挂 trap（与 theme 子页面同口径）。
              -->
              <div class="h-full w-full" {@attach trap}>
                <VirtualList
                  data={licenseEntries}
                  getKey={(dep) => `${dep.name}@${dep.version}`}
                  estimateSize={80}
                  style="padding: 0 20px 20px 20px;"
                  onclick={hijackLinks}
                >
                  {#snippet children(dep)}
                    <div
                      class="license-card flex flex-col gap-1"
                      style="margin-bottom: 8px;"
                    >
                      <a class="license-name break-all" href={dep.url}
                        >{dep.name}</a
                      >

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
                  {/snippet}
                </VirtualList>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-scroll {
    overflow-y: scroll;
  }
</style>
