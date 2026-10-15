/**
 * 构建信息生成器（构建时自动执行，见 package.json 的 build / build:dev 脚本）。
 *
 * 输出（frontend/src/lib/generated/）：
 * - version.ts：构建日期（YYYYMMDD，构建机本地时区，主版本信息）+
 *   当前 commit hash 前 8 位（弱化的次版本信息，非 git 环境为 "unknown"）；
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

/** 本地时区的 YYYYMMDD（非 git 环境下的兜底） */
function localDateYYYYMMDD() {
  const now = new Date();
  return (
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`
  );
}

let commit = "unknown";
let commitDate = localDateYYYYMMDD();
try {
  commit =
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim() || "unknown";

  // 使用 committer date（%cd = committer date，--date=format 直接用
  // committer 本地时区格式化，语义上与 date 命令的 %cd 一致）
  const d = execFileSync(
    "git",
    ["show", "-s", "--date=format:%Y%m%d", "--format=%cd", "HEAD"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }
  )
    .toString()
    .trim();
  if (d) commitDate = d;
} catch {
  /* 非 git 环境（如直接解压源码包构建）：保持兜底值 */
}

writeFileSync(
  path.join(outDir, "version.ts"),
  `/** 构建时自动生成（frontend/scripts/generate-build-info.mjs），请勿手工修改。 */` +
  '\n' + `export const COMMIT_DATE = ${JSON.stringify(commitDate)};` +
  '\n' + `export const COMMIT_HASH = ${JSON.stringify(commit)};`
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
      // "SEE LICENSE IN <file>" 等场景：包描述缺少标识时从文本猜测
      if (!license || /^(see license|unlicense)/i.test(license)) {
        const guessed = guessLicenseType(text);
        if (guessed !== "unknown") license = guessed;
      }
    } catch {
      /* 读取失败：保留元数据里的信息 */
    }
  }

  const repo = pkg.repository;
  const repoUrl = pkg.homepage || (typeof repo === "string" ? repo : repo?.url) || "";

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
      // scoped 包：node_modules/@scope/pkg
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
  `[generate-build-info] date=${commitDate} commit=${commit} frontend-deps=${deps.length}`
);