/**
 * i18n（基于 svelte-i18n 的成熟方案）。
 *
 * - 消息为分组嵌套 JSON（common.* / mode.* / outline.* / settings.* / stats.* / toast.*），
 *   支持 {param} 插值与 ICU 复数（后续扩展直接写消息即可）；
 * - locale 由 svelte-i18n 的响应式 store 驱动：模板中用 $t("key")，脚本中用 get(t)("key")；
 * - 语言设置持久化经 settings KV（后端配置文件）：取值 system（跟随系统，默认）/
 *   zh / en；运行时 locale 始终是解析后的具体语言，解析结果不在可用语言
 *   （zh / en）内时回落英语；
 * - 回退链：当前语言缺失的键自动回退 fallbackLocale（en）。
 */
import { addMessages, init, t as tStore, locale } from "svelte-i18n";
import { get, writable } from "svelte/store";
import { kvGet, kvSet } from "./settings";
import { zhMessages, enMessages } from "./i18n-messages";

export { cmPhrases } from "./i18n-messages";
import type { Lang, LangSetting } from "./types";

const LANG_KEY = "md.lang";

/** 系统语言探测：中文系统 → zh，其余一律回落英语 */
function systemLang(): Lang {
  try {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

/** 持久化值规范化：合法的 zh / en 原样保留，其余（含空值/未知值）归为跟随系统 */
function normalizeSetting(raw: string | null): LangSetting {
  return raw === "zh" || raw === "en" ? raw : "system";
}

/** 语言设置 → 实际生效语言：指定语言直接使用，跟随系统则探测；结果超出可用语言回落英语 */
function resolveLang(setting: LangSetting): Lang {
  if (setting === "zh" || setting === "en") return setting;
  return systemLang();
}

/** 启动期读取语言设置（配置快照未加载时为 system → 探测系统语言） */
function initialSetting(): LangSetting {
  try {
    return normalizeSetting(kvGet(LANG_KEY));
  } catch {
    return "system";
  }
}

addMessages("zh", zhMessages);
addMessages("en", enMessages);

const initialResolved = resolveLang(initialSetting());

init({
  initialLocale: initialResolved,
  fallbackLocale: "en",
});

function applyDocumentLang(lang: Lang): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}
applyDocumentLang(initialResolved);

/** 语言设置原始值（system | zh | en，设置面板高亮用；与 locale 区分：locale 是解析后的具体语言） */
export const langSetting = writable<LangSetting>(initialSetting());

/** 当前语言（svelte-i18n 响应式 store，模板/响应式上下文用 $locale） */
export { locale };

/** 翻译 store：模板 $t("key")；脚本 get(t)("key") */
export const t = tStore;

/** 切换语言设置（持久化 + 解析生效 + 同步 <html lang>）。system = 跟随系统 */
export function setLang(setting: LangSetting): void {
  try {
    kvSet(LANG_KEY, setting);
  } catch {
    /* ignore */
  }
  langSetting.set(setting);
  const lang = resolveLang(setting);
  void locale.set(lang);
  applyDocumentLang(lang);
}

/** 读取当前语言（非响应式上下文用） */
export function currentLang(): Lang {
  return (get(locale) === "en" ? "en" : "zh") as Lang;
}
