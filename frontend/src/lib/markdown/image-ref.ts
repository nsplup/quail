/**
 * 图片引用式插入文本构建（纯函数，无 store / bridge 依赖，可单测）。
 *
 * - 定义引用格式：引用行 `![alt][id]` 与定义块 `[id]: <relPath>` 一起
 *   组成插入文本（伪代码 `[...pics, def.join('\n')].join('\n\n')`）——
 *   引用行以空行分隔，定义行聚在尾部一个块内；
 * - 引用标识符（normalizeImageRefId）：按 micromark normalizeIdentifier
 *   口径（折叠空白为单空格、trim、小写）生成，批内查重 + 追加 -2/-3…
 *   后缀；与现有文档中的引用定义撞名时同样追加后缀（CommonMark 首定义
 *   优先，撞名会让新图引用解析到旧定义）。
 */

/** 保存成功的图片资源（与 bridge.ImportedImage 结构兼容） */
export type ImageAsset = { relPath: string; name: string };

/** 文件名去掉最后一个扩展名（无扩展名原样返回） */
export function imageStemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * 引用标识符规范化（micromark normalizeIdentifier 口径）：折叠空白为
 * 单空格、trim、小写（CJK 原样保留）。空结果回落 "img"。
 */
export function normalizeImageRefId(raw: string): string {
  const id = raw.replace(/[\t\n\v\f\r ]+/g, " ").trim().toLowerCase();
  return id || "img";
}

/** 从现有文档内容收集已占用的引用标识符（`[id]:` 定义行） */
function collectExistingIds(doc: string): Set<string> {
  const taken = new Set<string>();
  for (const m of doc.matchAll(/^\s{0,3}\[(.+?)]:\s*/gm)) {
    taken.add(normalizeImageRefId(m[1]));
  }
  return taken;
}

/**
 * 构建插入文本（定义引用格式）：引用行与定义块以空行分隔，定义行聚在
 * 尾部一个块内（伪代码 `[...pics, def.join('\n')].join('\n\n')`）。
 */
export function buildImageInsertText(
  images: ImageAsset[],
  existingDoc: string
): string {
  const taken = collectExistingIds(existingDoc);
  const pics: string[] = [];
  const defs: string[] = [];
  for (const img of images) {
    const stem = imageStemOf(img.name) || "img";
    const base = normalizeImageRefId(stem);
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    pics.push(`![${stem}][${id}]`);
    defs.push(`[${id}]: ${img.relPath}`);
  }
  return [...pics, defs.join("\n")].join("\n\n");
}
