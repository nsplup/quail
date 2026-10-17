/**
 * 构建信息生成器（构建时自动执行，见 package.json 的 build / build:dev 脚本）。
 *
 * 输出（frontend/src/lib/generated/）：
 * - version.ts：UTC 构建时间（SemVer 兼容的 YYYY.MDD.HHMMSS）+ 显示用
 *   ISO 风格时间戳 + 当前 commit 全长 hash（非 git 环境为 "unknown"）；
 * - frontend-deps.json：node_modules 内全部前端依赖（含传递依赖）的
 *   名称 / 版本 / 许可证标识 / 版权声明（自动从 LICENSE 类文件提取）。
 *
 * 后端依赖的同类信息由 tools/licgen（go run）生成 backend-deps.json。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // frontend/scripts
const frontendRoot = path.resolve(here, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const outDir = path.join(frontendRoot, "src", "lib", "generated");
mkdirSync(outDir, { recursive: true });

/* ---------------- 版本信息 ---------------- */

/**
 * 用传入的时间戳转换为 UTC 时间字段生成 SemVer 兼容的版本号。
 * - APP_VERSION：三段数字 `YYYY.MDD.HHMMSS`
 */
function makeVersion(date) {
  const p = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const mdd = String(Number(`${p.month}${pad(p.day)}`));          // 1月7日 -> "107"
  const hms = String(p.hour * 10000 + p.minute * 100 + p.second); // 00:00:00 -> "0"
  return `${p.year}.${mdd}.${hms}`;
}

let commit = "unknown";
let sourceDate = new Date(); // 非 git 环境兜底
let sourceTime = sourceDate.toISOString(); // 非 git 环境兜底的时间戳

try {
  commit =
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
  })
  .toString()
  .trim() || "unknown";

  // %cI：committer date，ISO 8601（如 2026-10-17T14:30:12+08:00）
  const iso = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
  })
  .toString()
  .trim();

  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      sourceDate = d;
      sourceTime = iso; // 直接携带拿到的原始时间戳
    }
  }
} catch {
  /* 非 git 环境（如直接解压源码包构建）：保持兜底值 */
}

const version = makeVersion(sourceDate);

writeFileSync(
  path.join(outDir, "version.ts"),
              `/** 构建时自动生成（frontend/scripts/generate-build-info.mjs），请勿手工修改。 */` +
              "\n" +
              `export const APP_VERSION = ${JSON.stringify(version)};` +
              "\n" +
              `export const SOURCE_TIME = ${JSON.stringify(sourceTime)};` +
              "\n" +
              `export const COMMIT_HASH = ${JSON.stringify(commit)};`
);

/* ---------------- 前端依赖许可收集 ---------------- */

/** 在包目录中查找 LICENSE / COPYING / NOTICE 类文件 */
function findLicenseFile(pkgDir) {
  let names;
  try {
    names = readdirSync(pkgDir);
  } catch {
    return null;
  }
  const hit = names.find((n) =>
  /^(licen[cs]e|copying|copyright|notice|unlicense)(\..*)?$/i.test(n)
  );
  return hit ? path.join(pkgDir, hit) : null;
}

/** 从许可证文本中提取版权声明行（最多 3 行，去重、保持出现顺序） */
function extractCopyright(text) {
  const hits = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 200) continue;
    if (!/copyright|\(c\)|©/i.test(line)) continue;
    if (hits.some((h) => h.toLowerCase() === line.toLowerCase())) continue;
    hits.push(line);
    if (hits.length >= 3) break;
  }
  return hits.join("\n");
}

/** 许可证文本无法直接给出标识时的轻量猜测 */
function guessLicenseType(text) {
  const t = text.slice(0, 8000);
  if (/Apache License/i.test(t)) return "Apache-2.0";
  if (/Mozilla Public License/i.test(t)) return "MPL-2.0";
  if (
    /ISC License|Permission to use, copy, modify, and\/or distribute this software/i.test(
      t
    )
  )
    return "ISC";
    if (/MIT License|Permission is hereby granted, free of charge/i.test(t))
      return "MIT";
  if (/BSD \d-Clause|Redistribution and use in source and binary forms/i.test(t))
    return "BSD";
  if (/Creative Commons/i.test(t)) {
    const m = t.match(/CC[- ]BY[- ]?[0-9.]+|CC0/i);
    return m ? m[0].toUpperCase() : "CC";
  }
  return "unknown";
}

/** 仓库地址归一化为可访问的 https URL */
function normalizeRepoUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  u = u.replace(/^git\+/, "");
  u = u.replace(/^(git|ssh):\/\/(.*@)?/, "https://");
  u = u.replace(/^https:\/\/(.*@)?/, "https://");
  u = u.replace(/^www\./, "");
  u = u.replace(/\.git$/i, "");
  if (!/^https?:\/\//i.test(u)) return "";
    return u;
}

function readPackage(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!pkg.name) return null;

  let license = "";
  if (typeof pkg.license === "string") license = pkg.license;
  else if (Array.isArray(pkg.licenses))
    license = pkg.licenses.map((l) => l?.type ?? String(l)).join(", ");

  let copyright = "";
  const licFile = findLicenseFile(pkgDir);
  if (licFile) {
    try {
      const text = readFileSync(licFile, "utf8");
      copyright = extractCopyright(text);
      if (!license || /^(see license|unlicense)/i.test(license)) {
        const guessed = guessLicenseType(text);
        if (guessed !== "unknown") license = guessed;
      }
    } catch {
      /* 读取失败：保留元数据里的信息 */
    }
  }

  const repo = pkg.repository;
  const repoUrl =
  pkg.homepage || (typeof repo === "string" ? repo : repo?.url) || "";

  return {
    name: pkg.name,
    version: pkg.version ?? "",
    license: license || "unknown",
    copyright,
    url: normalizeRepoUrl(repoUrl),
  };
}

const seen = new Set();
const deps = [];

function addPackage(pkgDir) {
  const p = readPackage(pkgDir);
  if (!p) return;
  const key = `${p.name}@${p.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  deps.push(p);
}

/** 扫描一个 node_modules 目录（npm 扁平布局 + 包内嵌套依赖递归） */
function walkNodeModules(nmDir) {
  let entries;
  try {
    entries = readdirSync(nmDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === ".bin") continue;
    const full = path.join(nmDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    if (name.startsWith("@")) {
      let scoped;
      try {
        scoped = readdirSync(full);
      } catch {
        continue;
      }
      for (const s of scoped) {
        const sfull = path.join(full, s);
        if (!existsSync(path.join(sfull, "package.json"))) continue;
        addPackage(sfull);
        walkNodeModules(path.join(sfull, "node_modules"));
      }
      continue;
    }

    if (!existsSync(path.join(full, "package.json"))) continue;
    addPackage(full);
    walkNodeModules(path.join(full, "node_modules"));
  }
}

walkNodeModules(path.join(frontendRoot, "node_modules"));
deps.sort((a, b) =>
a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
);

writeFileSync(
  path.join(outDir, "frontend-deps.json"),
              JSON.stringify(deps, null, 2) + "\n"
);

console.log(
  `[generate-build-info] version=${version} sourceTime=${sourceTime} commit=${commit} frontend-deps=${deps.length}`
);
