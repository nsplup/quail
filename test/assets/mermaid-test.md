# Mermaid 渲染测试文档

本文档用于测试 Markdown 渲染器对 Mermaid 图表代码块的支持。

## 1. 流程图 Flowchart

```mermaid
flowchart TD
    A[开始] --> B{条件判断}
    B -- 是 --> C[处理一]
    B -- 否 --> D[处理二]
    C --> E((结束))
    D --> E

    subgraph 子流程
        C --> F[记录日志]
        D --> F
    end

    classDef highlight fill:#f9f,stroke:#333,stroke-width:2px;
    class C highlight;
```

## 2. 时序图 Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant S as 系统
    participant DB as 数据库

    U->>S: 提交请求
    activate S
    S->>DB: 查询数据
    DB-->>S: 返回结果

    alt 成功
        S-->>U: 返回成功
    else 失败
        S-->>U: 返回错误
    end

    deactivate S
```

## 3. 类图 Class Diagram

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +eat() void
        +sleep() void
    }

    class Dog {
        +bark() void
    }

    Animal <|-- Dog
```

## 4. 状态图 State Diagram

```mermaid
stateDiagram-v2
    [*] --> 待处理
    待处理 --> 处理中: 开始
    处理中 --> 已完成: 成功
    处理中 --> 失败: 异常
    已完成 --> [*]
    失败 --> [*]
```

## 5. ER 图 Entity Relationship Diagram

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ ORDER_ITEM : contains
    PRODUCT ||--o{ ORDER_ITEM : includes

    CUSTOMER {
        string id PK
        string name
    }

    ORDER {
        string id PK
        datetime created_at
    }

    PRODUCT {
        string id PK
        string title
    }
```

## 6. 甘特图 Gantt

```mermaid
gantt
    title 项目计划测试
    dateFormat YYYY-MM-DD
    axisFormat %m-%d

    section 设计
    需求分析 :done, a1, 2024-01-01, 7d
    原型设计 :active, a2, after a1, 5d

    section 开发
    编码实现 :a3, after a2, 10d
    测试修复 :a4, after a3, 7d
```

## 7. 饼图 Pie

```mermaid
pie title 浏览器占比测试
    "Chrome" : 60
    "Firefox" : 20
    "Safari" : 15
    "其他" : 5
```

## 8. 用户旅程图 Journey

```mermaid
journey
    title 用户使用流程
    section 浏览
      打开页面: 5: 用户
      搜索内容: 4: 用户
    section 下单
      加入购物车: 3: 用户
      支付: 2: 用户, 系统
```

## 9. Git 图 GitGraph

```mermaid
gitGraph
    commit id: "初始化"
    branch develop
    checkout develop
    commit id: "功能A"
    commit id: "功能B"
    checkout main
    merge develop
    commit id: "发布"
```

## 10. 思维导图 Mindmap

```mermaid
mindmap
  root((测试主题))
    分支A
      子节点A1
      子节点A2
    分支B
      子节点B1
```

## 11. 时间线 Timeline

```mermaid
timeline
    title 时间线测试
    2024-01 : 需求
    2024-02 : 开发
    2024-03 : 测试
    2024-04 : 发布
```

## 12. 测试完成

如果以上图表均能正常显示，则说明 Mermaid 基本图表支持正常。  
注意：`mindmap`、`timeline`、`journey`、`gitGraph` 等图类型对 Mermaid 版本有要求，若未显示，可优先检查渲染器版本。