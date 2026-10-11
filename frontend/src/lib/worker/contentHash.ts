/**
 * 内容指纹（cyrb53 变体）：用于全量重建请求的内容哈希对比。
 *
 * 非加密哈希，仅用于「同一内容不重复重建」的去重判定：
 * - 速度优先：单遍 charCodeAt + Math.imul，1MB 文档 ≈ 2-4ms（worker 内执行）；
 * - 输出折叠 src 长度，进一步压低不同长度内容碰撞的概率；
 * - 碰撞后果可控：最坏情形是跳过一次本可执行的重建，漂移防护由增量
 *   worker 的 10s idle 自愈校验兜底。
 */
export function contentHash(src: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  /* 53 位主哈希 + 长度：不同内容同哈希的概率约 2^-53 量级 */
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16) + ":" + src.length;
}
