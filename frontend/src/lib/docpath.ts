/**
 * 文档路径 / 模式校验的纯函数工具（零依赖，可单测）。
 *
 * - splitSavePath：另存成功后的绝对路径 → { dir, name }。
 *   必须同时识别 / 与 \ 分隔符（Windows 路径是反斜杠，只按 / 切分会把
 *   dir/name 解析成整条路径——本地图片白名单、标题栏随之失真）；
 * - isValidMode：布局模式白名单校验（配置文件可能残留非法值，
 *   直接写入会让布局分支全失配）。
 */

export interface SplitSavePath {
  dir: string;
  name: string;
}

/** 绝对路径 → { dir, name }：按最后出现的 / 或 \ 切分（兼容 Windows）。 */
export function splitSavePath(path: string): SplitSavePath {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSep < 0) {
    return { dir: path, name: path };
  }
  const dir = lastSep > 0 ? path.slice(0, lastSep) : path.slice(0, lastSep + 1);
  const name = path.slice(lastSep + 1);
  return { dir, name: name || path };
}

const VALID_MODES: readonly string[] = ["source", "split", "preview"];

/** 布局模式白名单校验（非法值返回 false，调用方忽略该次回放）。 */
export function isValidMode(mode: unknown): mode is "source" | "split" | "preview" {
  return typeof mode === "string" && VALID_MODES.includes(mode);
}
