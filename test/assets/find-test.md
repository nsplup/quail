# 搜索装饰器测试文档

> **操作**：Ctrl+F / Cmd+F 打开搜索面板。输入关键词，切换大小写 / 正则 / 全字。右侧预览实时高亮，与编辑器搜索状态独立。
>
> **实现**：扁平化所有 text 节点 → 在拼接串上匹配 → 映射回节点并拆分 `<mark>`。`script/style/template/noscript` 被跳过。

## 1. 基础匹配

### 1.1 大小写
hello Hello HELLO hElLo HeLLo

搜索 `hello`（关闭大小写）→ 5 处；开启大小写 → 1 处。

### 1.2 全字匹配
cat concatenate category cats scatter

搜索 `cat` + 全字 → 1 处；关闭全字 → 所有含 cat 的片段。

### 1.3 特殊字符（非正则自动转义）
版本 v1.2.3，价格 $9.99，符号 . * + ? ^ $ { } ( ) | [ ] \ /

搜索 `v1.2.3` 或 `$9.99`（关闭正则），点号和美元符按字面量匹配。

## 2. 跨标签匹配

### 2.1 内联强调
**hello** world —— 搜索 `hello world`
*foo*bar —— 搜索 `foobar`
**bold** and *italic* and `code` —— 搜索 `bold and italic and code`

### 2.2 链接
[链接文本](https://example.com) 后续文字

搜索 `链接文本 后续文字` 跨 `<a>` 匹配。
搜索 `example.com` 不应匹配——URL 在 href 属性，不在 text 节点。

### 2.3 嵌套
**hello *world* foo** —— 搜索 `hello world foo`

### 2.4 图片
![图片说明](pic.png) 后面文字 —— 搜索 `图片说明 后面文字`

### 2.5 组合
段落开始 **加粗** 中间 *斜体* 结尾 `代码`

搜索 `加粗 中间 斜体 结尾 代码` 跨 5 个节点。

## 3. 块级边界（已知取舍）

段落一 foo

段落二 bar

搜索 `foo段落二` 会匹配——扁平化直接拼接块级文本，未插入边界哨兵。

## 4. 结构化内容

### 4.1 列表
- 项目一 **加粗**
- 项目二 *斜体*
- 项目三 `代码`

1. 第一项 hello
2. 第二项 world
3. 第三项 hello world

### 4.2 引用
> 引用中的 **hello** world
>
> 第二段 foo

### 4.3 代码块
```js
function helloWorld() {
  const greeting = "Hello, world!";
  return greeting;
}
```

代码块文本同样被收集，搜索 `helloWorld` / `greeting` 可在 `<pre>` 内命中。

### 4.4 GFM 语法（未启用 remark-gfm）

| 列一 | 列二 |
|------|------|
| **加粗** | *斜体* |
| hello | world |

删除线 ~~strike~~、任务列表

- [x] done

按字面量渲染，用于验证降级行为。

## 5. 正则匹配

### 5.1 邮箱
联系：user@example.com，备用 admin@test.org
正则 `\b\w+@\w+\.\w+\b`

### 5.2 电话
138-1234-5678 或 010-87654321
正则 `\d{3}-\d{4}-\d{4}`

### 5.3 日期
2024-01-15 和 2023-12-31
正则 `\d{4}-\d{2}-\d{2}`

### 5.4 URL
https://example.com/path 和 http://test.org
正则 `https?://[^\s]+`

### 5.5 捕获组
搜索 `(hello)` 或 `(world)`：捕获组不影响 `<mark>` 范围（只看 `m[0]`）。

## 6. ReDoS 安全（应被拦截）

- `(a+)+$`
- `(x+x+)+y`
- `(a|a)*$`
- `(a|aa)+$`
- `^(\w+\s?)*$`

对照安全正则（应执行）：`\d+`、`\w+@\w+`、`[a-z]+`

## 7. 零宽守卫（应被拦截）

- `\b`
- `^`
- `$`
- `^*`
- `.*`
- `a*`
- `(?=hello)`

对照非零宽（应执行）：`\bhello\b`、`a+`、`\d+`

## 8. 中英文混排

中文hello世界 —— 搜索 `hello` 或 `中文hello世界`

中英文 mix 混排 test 测试 混搭

## 9. 匹配数量

hello hello hello hello hello hello hello hello hello hello
hello hello hello hello hello hello hello hello hello hello

20 次 hello。超过 1000 条匹配时状态栏提示截断。

## 10. HTML 内联（预期不高亮）

段落中有 <details><summary>折叠标题</summary>折叠内容</details>。

`<details>` 等 HTML 在 remark-rehype 默认配置下成为 raw 节点，不是 text 节点，不参与扁平化。搜索 `折叠标题` 无高亮——预期行为。

`script` / `style` / `template` / `noscript` 在 IGNORE_TAGS 中被额外跳过，永远不参与匹配（此处不实际放置这些标签，以免影响页面）。

## 11. 空搜索

清空搜索框，预览恢复原始渲染，无 `<mark>`。

## 附录：测试矩阵

| 搜索词 | 大小写 | 正则 | 全字 | 预期 |
|--------|--------|------|------|------|
| hello | 关 | 关 | 关 | 5 处 |
| hello | 开 | 关 | 关 | 1 处 |
| cat | 关 | 关 | 开 | 1 处 |
| hello world | 关 | 关 | 关 | 跨 strong |
| \b\w+@\w+\.\w+\b | 关 | 开 | 关 | 2 个邮箱 |
| (a+)+$ | 关 | 开 | 关 | 拦截 |
| \b | 关 | 开 | 关 | 拦截 |
| example.com | 关 | 关 | 关 | 无高亮 |
| 折叠标题 | 关 | 关 | 关 | 无高亮 |
