/**
 * 块映射 / 文本统计的纯函数工具（零依赖，可同时被主线程与 worker 引用）。
 *
 * - blockIndexForLine：源码行号 → 预览块下标（滚动同步 / 大纲跳转的二分映射）；
 * - blocksCoverDoc：校验块行界是否无缝覆盖整个文档（增量解析自愈判据）；
 * - countTextAs：字数统计（只算当前口径；worker 内计算后回传，主线程不扫全文）。
 */
import type { CountMode, PreviewBlock } from "../types";

/**
 * 行号 → 预览块下标（二分查找：找到 startLine <= line 的最后一个块）。
 * 用于「编辑器 → 预览」的同步滚动。
 */
export function blockIndexForLine(blocks: PreviewBlock[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let res = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].startLine <= line) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/**
 * 行切分（全管线唯一行语义）：\r\n、\r、\n 均为换行——与 remark/micromark
 * 的行计数及 CodeMirror 默认 lineSeparator 完全一致。
 * 必须用本函数而非 src.split("\n")：含孤立 \r（旧 Mac 式 / 混合换行）的
 * 文档（如网络小说 txt）两者行数不一致 → 锚点行号超出 split("\n") 行数
 * → blocksCoverDoc 恒失败 → worker 10s idle 自愈每 10s 重复一次全量解析。
 * 尾随换行产出空串元素，与 micromark 的行号语义（root.position.end.line）
 * 一致。
 */
export function splitLines(src: string): string[] {
  return src.split(/\r\n|\r|\n/);
}

/**
 * 校验块行界是否连续覆盖整个文档（1..行数）：
 * 通过 → 增量解析结果与全量一致，无需周期性全量重算（自愈）。
 * 空白文档（无任何可渲染块）视为已覆盖：全量解析对空白文档恒产出 0 块，
 * 若按行数严格校验会永远失败 → worker 每 10s 空转一次全量自愈。
 */
export function blocksCoverDoc(blocks: PreviewBlock[], src: string): boolean {
  if (src.trim() === "") return blocks.length === 0;
  const totalLines = splitLines(src).length;
  let expect = 1;
  for (const b of blocks) {
    if (b.startLine !== expect || b.endLine < b.startLine) return false;
    expect = b.endLine + 1;
  }
  return expect - 1 === totalLines;
}

/* ---------------- 字数统计 ----------------
 *
 * 三种统计方式（CountMode，设置项），解耦为独立口径、只计算当前口径：
 * - 字符（character）：以统一码用户感知字符（grapheme cluster）为最小单元，
 *   对文本做一次 Intl.Segmenter grapheme 分段后计数；
 * - 单词（word）：以单词为最小单元，Intl.Segmenter word 分段后按
 *   isWordLike 判定计数（依赖 isWordLike）；
 * - 字词（hybrid）：先做 word 分词，再对每个 segment 做 CJK 判定——
 *   含 CJK 的段收集起来合并后只调用一次 grapheme 分段按字计数
 *   （去掉 CJK 标点，即全角符号）；不含 CJK 的段只加一。
 *   字符模式与字词模式都不依赖 isWordLike 判定。
 *
 * worker 内只对「当前设置的口径」做一次统计（countTextAs），
 * 切换统计方式时由 worker 按内容哈希缓存重算/命中回传——不再一次
 * 全文分段算出三种口径（旧 countText 的做法，编辑热路径三倍浪费）。
 *
 * 全部 Intl.Segmenter 实例的 locales 始终显式设为 "en"：
 * 分词结果与界面语言解耦，行为跨环境确定。CJK 段在字词模式下按
 * grapheme 展开计数，其结果不受 word 分词粒度（字典是否可用）影响。
 *
 * 可加性约定（worker 块级增量统计依赖，见 parse.worker.ts）：
 * 文本以块为单位切分后按 "\n" 连接还原全文，三种口径在块间均可加——
 * grapheme 簇不跨 "\n"；word 词元不跨 "\n"；hybrid 的 CJK 段收集
 * 顺序与合并结果不受块切分影响。唯一的例外是 CRLF（"\r\n" 为单一
 * grapheme 簇，"\r" 与分隔 "\n" 跨块合并）：由块文本提取时剥除行尾
 * "\r"（extractBlockText）保证与全文统计口径一致。
 */

/** Intl.Segmenter 可用性兜底（极旧 WebView 下回退正则统计，不致崩溃） */
const HAS_SEGMENTER =
  typeof Intl !== "undefined" &&
  typeof (Intl as { Segmenter?: unknown }).Segmenter === "function";

interface SegmentData {
  segment: string;
  isWordLike?: boolean;
}

interface SegmenterLike {
  segment(input: string): Iterable<SegmentData>;
}

/** locales 始终显式为 "en"（见模块注释） */
const graphemeSegmenter: SegmenterLike = HAS_SEGMENTER
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null as unknown as SegmenterLike;
const wordSegmenter: SegmenterLike = HAS_SEGMENTER
  ? new Intl.Segmenter("en", { granularity: "word" })
  : null as unknown as SegmenterLike;

/** CJK 码点判定：CJK 部首 / 表意文字（含扩展）、假名、谚文、注音、
 * CJK 标点与全角形式（用于字词模式的 segment 分类） */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK 部首补充
    (cp >= 0x2f00 && cp <= 0x2fdf) || // 康熙部首
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK 符号和标点 + 假名
    (cp >= 0x3100 && cp <= 0x31ff) || // 注音 / 谚文兼容字母 / CJK 笔画等
    (cp >= 0x3200 && cp <= 0x4dbf) || // 兼容表意文字 + CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xa960 && cp <= 0xa97f) || // 谚文字母扩展 A
    (cp >= 0xac00 && cp <= 0xd7ff) || // 谚文音节 + 谚文字母扩展 B
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe10 && cp <= 0xfe4f) || // 竖排形式 / CJK 兼容形式（全角标点）
    (cp >= 0xff00 && cp <= 0xffef) || // 半角及全角形式
    (cp >= 0x20000 && cp <= 0x2ebef) || // CJK 扩展 B–F
    (cp >= 0x30000 && cp <= 0x3134f) // CJK 扩展 G
  );
}

/** CJK 标点（全角符号）码点判定：字词模式统计 CJK 长度时剔除 */
function isCjkPunctCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 符号和标点（。、「」…含表意空格）
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排形式
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff01 && cp <= 0xff0f) || // 全角 ！＂＃＄％＆＇（）＊＋，－．／
    (cp >= 0xff1a && cp <= 0xff20) || // 全角 ：；＜＝＞？＠
    (cp >= 0xff3b && cp <= 0xff40) || // 全角 ［＼］＾＿｀
    (cp >= 0xff5b && cp <= 0xff65) // 全角 ｛｜｝～｟｠｡｢｣､･
  );
}

/** segment 是否含 CJK 码点 */
function containsCjk(seg: string): boolean {
  for (const ch of seg) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) return true;
  }
  return false;
}

/** grapheme 是否为 CJK 标点（全角符号）：整簇均为标点码点才剔除 */
function isCjkPunctCluster(cluster: string): boolean {
  for (const ch of cluster) {
    if (!isCjkPunctCodePoint(ch.codePointAt(0)!)) return false;
  }
  return true;
}

/** 不可用 Intl.Segmenter 时的正则回退（旧实现，行为近似） */
function countEnglishWordsFallback(text: string): number {
  const m = text.match(/[A-Za-z0-9_'’-]+/g);
  return m ? m.length : 0;
}

/** 不可用 Intl.Segmenter 时的正则回退（旧实现，行为近似） */
function countHanCharactersFallback(text: string): number {
  const m = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g);
  return m ? m.length : 0;
}

/**
 * 按指定口径统计文本（三策略解耦后的单一入口）：
 * 只执行 mode 对应的分段，不触碰另外两种口径的分段逻辑。
 * worker 每次解析 / 每次切换口径后对当前内容调用一次，切换口径时的
 * 重算与缓存由 parse.worker.ts 负责（内容哈希 → 各口径统计值）。
 */
export function countTextAs(text: string, mode: CountMode): number {
  if (text === "") return 0;
  if (!HAS_SEGMENTER) {
    // 兜底路径：无 Intl.Segmenter 时退回旧正则口径
    switch (mode) {
      case "character":
        return Array.from(text).length;
      case "word":
        return countEnglishWordsFallback(text);
      case "hybrid":
        return countEnglishWordsFallback(text) + countHanCharactersFallback(text);
    }
  }
  if (mode === "character") {
    // 字符口径：一次 grapheme 分段（含空白字符，统一码即最小单元）
    let chars = 0;
    for (const _ of graphemeSegmenter.segment(text)) chars++;
    return chars;
  }
  if (mode === "word") {
    // 单词口径：一次 word 分段，仅按 isWordLike 判定
    let words = 0;
    for (const s of wordSegmenter.segment(text)) {
      if (s.isWordLike === true) words++;
    }
    return words;
  }
  // 字词口径（hybrid）：word 分段 → CJK 段收集合并后一次 grapheme 分段
  let hybrid = 0;
  let cjkChunks: string[] | null = null;
  for (const s of wordSegmenter.segment(text)) {
    const seg = s.segment;
    // 空白段既不是字也不是词，跳过（不依赖 isWordLike）
    if (!/\S/.test(seg)) continue;
    if (containsCjk(seg)) {
      // 含 CJK 的段先收集，合并后只调用一次 grapheme 分段
      (cjkChunks ??= []).push(seg);
    } else {
      hybrid++;
    }
  }
  if (cjkChunks !== null) {
    // CJK 长度按字统计，去掉 CJK 标点（全角符号）
    for (const g of graphemeSegmenter.segment(cjkChunks.join(""))) {
      if (!isCjkPunctCluster(g.segment)) hybrid++;
    }
  }
  return hybrid;
}
