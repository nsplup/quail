/**
 * 开源许可清单：前端 / 后端依赖 + LOGO 美术资产。
 *
 * - frontend-deps.json / backend-deps.json 在构建时自动生成：
 *   - 前端：frontend/scripts/generate-build-info.mjs（node_modules 全量扫描）；
 *   - 后端：tools/licgen（`go list -m all` + 模块缓存 LICENSE 提取）；
 * - 条目按名称排序（大小写不敏感）后供「开源许可」二级页面陈列；
 * - 页面内的链接点击劫持与预览区一致：交由后端（Wails Browser）打开。
 */
import frontendDepsJson from "./generated/frontend-deps.json";
import backendDepsJson from "./generated/backend-deps.json";

export interface LicenseEntry {
  /** 依赖名称（排序键） */
  name: string;
  /** 版本（美术资产等无版本概念的条目为空字符串） */
  version: string;
  /** 许可证标识 */
  license: string;
  /** 构建时自动提取的版权声明（多行） */
  copyright: string;
  /** 项目主页（内部链接劫持后交由后端打开） */
  url: string;
}

/** LOGO 美术资产（frontend/public/bird.svg）：来源 Firefox OS Emoji，CC BY 4.0 */
const assetEntry: LicenseEntry[] = [
  {
    name: "Firefox OS Emoji",
    version: "",
    license: "CC BY 4.0",
    copyright:
      "Firefox OS Emoji is a colored Emoji collection designed by Sabrina Smelko and licensed under CC-BY-4.0\n" +
      "Copyright (c) Mozilla Corporation and contributors",
    url: "https://github.com/mozilla/fxemoji",
  },
  {
    name: "VS Code Codicons",
    version: "",
    license: "CC BY 4.0",
    copyright:
      "VS Code Codicons icon set © Microsoft Corporation and other contributors.\n" +
      "Licensed under the Creative Commons Attribution 4.0 International (CC-BY-4.0).",
    url: "https://github.com/microsoft/vscode-codicons",
  },
];

export const licenseEntries: LicenseEntry[] = [
  ...(frontendDepsJson as LicenseEntry[]),
  ...(backendDepsJson as LicenseEntry[]),
  ...assetEntry,
].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
