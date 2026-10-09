/**
 * 图片源重写：把文档里的图片引用解析为 ImgProxy URL（Wails 桌面环境）。
 *
 * - 相对路径 / 绝对本地路径 → /__imgproxy/local?p=...（后端校验文档目录白名单）；
 * - http(s) → /__imgproxy/remote?url=...（后端下载 + 缓存）；
 * - data: / 已是代理 URL / 浏览器预览环境 → 原样返回。
 *
 * 环境检测与后端当前文档状态由 bridge 提供；无文档时本地路径无法校验，
 * 仍生成代理 URL 交由后端返回 403，前端 md-image 错误态展示。
 */

export function isWailsEnv(): boolean {
  return typeof window !== "undefined" && "__wails" in window;
}

export function rewriteImageSrc(src: string): string {
  if (!src) return src;
  if (src.startsWith("data:") || src.startsWith("/__imgproxy/")) return src;
  if (!isWailsEnv()) return src;

  if (/^https?:\/\//i.test(src)) {
    return `/__imgproxy/remote?url=${encodeURIComponent(src)}`;
  }
  // 本地路径：相对路径原样传，后端相对文档目录解析；绝对路径直接传
  if (src.startsWith("/")) {
    return `/__imgproxy/local?p=${encodeURIComponent(src)}`;
  }
  return `/__imgproxy/local?p=${encodeURIComponent(src)}`;
}
