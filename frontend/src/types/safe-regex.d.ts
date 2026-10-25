/**
 * safe-regex 类型声明（无官方 @types 包）。
 * 返回 true = 正则无灾难性回溯风险（star height ≤ 1）；解析失败时可能抛异常，调用方需捕获。
 */
declare module "safe-regex" {
  function safeRegex(re: string | RegExp, opts?: { limit?: number }): boolean;
  export default safeRegex;
}
