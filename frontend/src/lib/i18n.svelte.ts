/**
 * i18n（基于 svelte-i18n 的成熟方案）。
 *
 * - 消息为分组嵌套 JSON（common.* / mode.* / outline.* / settings.* / stats.* / toast.*），
 *   支持 {param} 插值与 ICU 复数（后续扩展直接写消息即可）；
 * - locale 由 svelte-i18n 的响应式 store 驱动：模板中用 $t("key")，脚本中用 get(t)("key")；
 * - 语言持久化经 settings KV（localStorage / 后端配置），初始值回退到 navigator.language；
 * - 回退链：当前语言缺失的键自动回退 fallbackLocale（en）。
 */
import { addMessages, init, t as tStore, locale } from "svelte-i18n";
import { kvGet, kvSet } from "./settings";
import { get } from "svelte/store";
import { zhMessages, enMessages } from "./i18n-messages";

export { cmPhrases } from "./i18n-messages";
import type { Lang } from "./types";

function initialLang(): Lang {
  try {
    const saved = kvGet("md.lang");
    if (saved === "zh" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

addMessages("zh", zhMessages);
addMessages("en", enMessages);

init({
  initialLocale: initialLang(),
  fallbackLocale: "en",
});

function applyDocumentLang(lang: Lang): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}
applyDocumentLang(initialLang());

/** 当前语言（svelte-i18n 响应式 store，模板/响应式上下文用 $locale） */
export { locale };

/** 翻译 store：模板 $t("key")；脚本 get(t)("key") */
export const t = tStore;

/** 切换语言（持久化 + 同步 <html lang>） */
export function setLang(lang: Lang): void {
  try {
    kvSet("md.lang", lang);
  } catch {
    /* ignore */
  }
  void locale.set(lang);
  applyDocumentLang(lang);
}

/** 读取当前语言（非响应式上下文用） */
export function currentLang(): Lang {
  return (get(locale) === "en" ? "en" : "zh") as Lang;
}
