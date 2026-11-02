# Markdown 引用/脚注/图片验收文档

## 1. 脚注：前向引用、重复引用、未定义回退

前向引用：[^later]；同一脚注第二次引用：[^later]。

未定义脚注应保持字面量：[^ghost]。

中文脚注：[^中文脚注]。

大小写归一：[^CaseNote]。

重复定义 first-wins：[^dup-note]。

嵌套脚注：[^nested]。

## 2. 链接引用：已定义、大小写、CJK、重复、不可用、XSS

已定义：[普通链接][ref-one]。

大小写归一：[混合大小写][mixed-case]。

CJK 全等：[中文链接][中文 定义]。

重复定义 first-wins：[重复链接][dup]。

未定义链接应字面量：[未定义][missing-ref]。

空链接不可用：[空链接][empty]。

危险协议拦截：[危险链接][xss-js]。

## 3. 图片与 raw img

引用式图片已定义：![示例图][img-one]

引用式图片未定义应保留标记/字面量：![未定义图][img-missing]

## 4. 表格与查找/Codec 回归

| 列A | 列B |
| --- | --- |
| [表格内链接][ref-one] | 表格内脚注[^later] |

在应用内搜索“脚注”“表格”，并切换源码/预览、保存重开，检查表格、引用装饰、脚注回跳不被破坏。

## 5. 复杂脚注

这里是一个带有复杂脚注的句子[^complex]。

[^complex]: 这是脚注的第一段，直接写在冒号后面。
    
    这是脚注的第二段。因为前面缩进了 4 个空格，所以它依然属于这个脚注。
  
    > 这是一个嵌套在脚注内部的引用块。
  
    ```javascript
    // 这是一个嵌套在脚注内部的代码块
    console.log("Hello from footnote!");
    ```

    |  A  |  B  |
    | --- | --- |
    |  2  |  3  |
    |  1  |  4  |

[ref-one]: https://example.com/ref-one
[MiXeD-Case]: https://example.com/mixed
[中文 定义]: https://example.com/cjk
[dup]: https://example.com/first
[dup]: https://example.com/second
[empty]: <>
[xss-js]: javascript:alert('xss')
[img-one]: https://picsum.photos/600/400
[^later]: 前向脚注内容。
[^中文脚注]: 中文脚注定义。
[^casenote]: 大小写脚注定义。
[^dup-note]: 第一个重复脚注定义。
[^dup-note]: 第二个重复脚注定义。
[^nested]: 嵌套脚注内容：
    - 项 A
    - 项 B
    并引用另一个脚注[^later]。