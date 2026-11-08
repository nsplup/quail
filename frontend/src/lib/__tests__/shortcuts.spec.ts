/**
 * 全局快捷键配置（lib/shortcuts.ts）与弹层遮罩状态（lib/stores.ts）单测。
 *
 * - matchShortcut：组合匹配纯函数的口径矩阵（key 小写化 / mod / shift
 *   三态 / altDeny）；
 * - GLOBAL_SHORTCUTS 完整性：动作覆盖（与原 App.svelte if 链的 7 个快捷键
 *   等价迁移）、顺序优先级（saveAs 先于 save）、无重复 combo（首个匹配
 *   语义不歧义）；
 * - overlayOpen$：遮罩注册/注销派生布尔（Overlay.svelte 状态暴露的全局
 *   STORE 消费口径；注册/注销由组件 $effect 承担，此处直接驱动 registry
 *   验证派生逻辑）。
 */
import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  GLOBAL_SHORTCUTS,
  matchShortcut,
  type ShortcutSpec,
} from "../shortcuts";
import { overlayRegistry$, overlayOpen$ } from "../overlay";

type FakeKey = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

const key = (over: Partial<FakeKey> & { key: string }): FakeKey => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("matchShortcut：组合匹配口径", () => {
  const spec: ShortcutSpec = {
    id: "test",
    combo: { key: "s", mod: true, shift: false, altDeny: true },
    action: "save",
  };

  it("key 大小写不敏感（e.key 小写化比对）", () => {
    expect(matchShortcut(spec, key({ key: "S", ctrlKey: true }))).toBe(true);
  });

  it("mod：Ctrl 或 Cmd 均视为 mod；无修饰键不匹配", () => {
    expect(matchShortcut(spec, key({ key: "s", ctrlKey: true }))).toBe(true);
    expect(matchShortcut(spec, key({ key: "s", metaKey: true }))).toBe(true);
    expect(matchShortcut(spec, key({ key: "s" }))).toBe(false);
  });

  it("shift 三态：false=必须不按 / true=必须按 / undefined=不关心", () => {
    expect(matchShortcut(spec, key({ key: "s", ctrlKey: true }))).toBe(true);
    expect(
      matchShortcut(spec, key({ key: "s", ctrlKey: true, shiftKey: true })),
    ).toBe(false);

    const shiftSpec: ShortcutSpec = {
      id: "t2",
      combo: { key: "s", mod: true, shift: true },
      action: "saveAs",
    };
    expect(
      matchShortcut(shiftSpec, key({ key: "s", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      matchShortcut(shiftSpec, key({ key: "s", ctrlKey: true })),
    ).toBe(false);

    const anyShift: ShortcutSpec = {
      id: "t3",
      combo: { key: "y", mod: true },
      action: "redo",
    };
    expect(matchShortcut(anyShift, key({ key: "y", ctrlKey: true }))).toBe(
      true,
    );
    expect(
      matchShortcut(anyShift, key({ key: "y", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("altDeny：Alt 按下时不匹配；未声明 altDeny 时忽略 Alt", () => {
    expect(matchShortcut(spec, key({ key: "s", ctrlKey: true, altKey: true })))
      .toBe(false);
    const noDeny: ShortcutSpec = {
      id: "t4",
      combo: { key: "s", mod: true, shift: true },
      action: "saveAs",
    };
    expect(
      matchShortcut(
        noDeny,
        key({ key: "s", ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(true);
  });
});

describe("GLOBAL_SHORTCUTS：配置完整性（等价迁移自 App if 链）", () => {
  it("动作覆盖：7 个快捷键 / 8 个动作（redo 由 z 与 y 双组合触发）", () => {
    const actions = new Set(GLOBAL_SHORTCUTS.map((s) => s.action));
    expect([...actions].sort()).toEqual(
      [
        "new",
        "open",
        "quit",
        "redo",
        "save",
        "saveAs",
        "find",
        "undo",
      ].sort(),
    );
  });

  it("顺序优先级：saveAs（Shift+S）先于 save（S）", () => {
    const saveAsIdx = GLOBAL_SHORTCUTS.findIndex(
      (s) => s.action === "saveAs",
    );
    const saveIdx = GLOBAL_SHORTCUTS.findIndex((s) => s.action === "save");
    expect(saveAsIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeGreaterThan(saveAsIdx);
  });

  it("无重复 combo（首个匹配语义不歧义）", () => {
    const sig = (s: ShortcutSpec): string =>
      [
        s.combo.key,
        s.combo.mod,
        s.combo.shift === undefined ? "*" : s.combo.shift,
        s.combo.altDeny === true ? "noAlt" : "any",
      ].join("|");
    const seen = new Set<string>();
    for (const s of GLOBAL_SHORTCUTS) {
      expect(seen.has(sig(s))).toBe(false);
      seen.add(sig(s));
    }
  });

  it("undo/redo 与 save/find 的守卫挂载正确", () => {
    const byId = new Map(GLOBAL_SHORTCUTS.map((s) => [s.id, s]));
    // undo/redo：CM6 / 原生输入控件焦点守卫（共享 notInEditableFocus）
    expect(byId.get("global.undo")?.when).toBeDefined();
    expect(byId.get("global.redoZ")?.when).toBeDefined();
    expect(byId.get("global.redoY")?.when).toBeDefined();
    // save/find：defaultPrevented 守卫（CM6 keymap 已处理的不重复响应）
    expect(byId.get("global.save")?.when).toBeDefined();
    expect(byId.get("global.find")?.when).toBeDefined();
    // new/open/quit/saveAs：无守卫（任何焦点状态均响应）
    expect(byId.get("global.new")?.when).toBeUndefined();
    expect(byId.get("global.open")?.when).toBeUndefined();
    expect(byId.get("global.quit")?.when).toBeUndefined();
    expect(byId.get("global.saveAs")?.when).toBeUndefined();
  });
});

describe("overlayOpen$：遮罩状态派生", () => {
  it("空 registry → false；注册 → true；注销 → false", () => {
    const k1 = Symbol("ov1");
    const k2 = Symbol("ov2");
    expect(get(overlayOpen$)).toBe(false);

    overlayRegistry$.update((s) => new Set(s).add(k1));
    expect(get(overlayOpen$)).toBe(true);

    // 多遮罩叠加（confirm 叠在 settings 之上）：size > 0 仍为 true
    overlayRegistry$.update((s) => new Set(s).add(k2));
    expect(get(overlayOpen$)).toBe(true);

    overlayRegistry$.update((s) => {
      const next = new Set(s);
      next.delete(k1);
      return next;
    });
    expect(get(overlayOpen$)).toBe(true);

    overlayRegistry$.update((s) => {
      const next = new Set(s);
      next.delete(k2);
      return next;
    });
    expect(get(overlayOpen$)).toBe(false);
  });
});
