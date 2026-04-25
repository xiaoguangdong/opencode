# Google 风格 AI Agent 工程面试模拟题

这篇不是普通问答，而是按 onsite 风格来组织：

- 面试题目
- 面试官常见追问
- 高质量作答框架
- 结合 `opencode` 的参考答案

建议使用方式：

1. 先只看题目，自己答 3 到 5 分钟。
2. 再看“追问”部分，继续补充。
3. 最后对照“高质量作答框架”和“结合 `opencode` 的参考答案”。

---

## 1. 设计一个代码 Agent 系统，你会先定义哪些核心抽象？

### 面试官追问

- 为什么这些抽象是最小闭环？
- 哪些是业务抽象，哪些是运行时抽象？
- 如果少掉一个会导致什么问题？

### 高质量作答框架

应优先定义：

1. `Session`
2. `Message`
3. `Agent`
4. `Tool`
5. `Provider`
6. `Permission`
7. `Execution state`

理由：

- `Session` 负责状态与归因边界
- `Message` 负责结构化运行事实
- `Agent` 负责控制循环
- `Tool` 负责动作空间
- `Provider` 负责模型接入隔离
- `Permission` 负责副作用治理
- `Execution state` 负责取消、进行中、完成、失败等状态

### 结合 `opencode` 的参考答案

`opencode` 的主干正好是这套抽象：

- `internal/session`
- `internal/message`
- `internal/llm/agent`
- `internal/llm/tools`
- `internal/llm/provider`
- `internal/permission`
- `activeRequests` + `FinishReason` + `SummaryMessageID`

这说明它已经不是聊天程序，而是一个最小可用 Agent runtime。

---

## 2. 你如何定义一个 Agent 的控制循环？

### 面试官追问

- 和普通 request-response 有什么不同？
- 如何判断循环该结束？
- 如果模型无限调用工具怎么办？

### 高质量作答框架

标准答案应包含：

1. 观察：读取上下文与状态
2. 推理：模型生成动作计划或工具调用
3. 执行：运行工具
4. 反馈：把结果回注入上下文
5. 终止判断：完成、失败、取消、熔断

应明确提出：

- 最大轮数
- 失败回退
- 完成质量判定
- 中途取消

### 结合 `opencode` 的参考答案

`processGeneration` 是这套循环的核心实现：

- 先拉历史消息
- 创建新 user message
- 调 `streamAndHandleEvents`
- 收集 tool calls
- 执行 tool
- 把 `ToolResult` 再喂给下一轮
- 根据 `FinishReason` 判断是否结束

但如果站在更高标准看，它还可以补：

- 最大工具轮数
- 无收益循环检测
- 更显式 completion evidence

---

## 3. 为什么 Agent 系统里 `Message` 不能只存纯文本？

### 面试官追问

- 只存 prompt 和 final answer 不行吗？
- 结构化消息会带来哪些额外收益？

### 高质量作答框架

应指出：

- Agent 的真实运行事实包括 tool call、tool result、finish state
- 文本只能记录叙述，不能记录执行语义
- 结构化消息有利于 replay、审计、eval、故障分析

### 结合 `opencode` 的参考答案

`opencode` 的 `message.ContentPart` 包含：

- `text`
- `reasoning`
- `binary`
- `tool_call`
- `tool_result`
- `finish`

这让系统能回答：

- 模型什么时候用了哪个工具
- 工具结果是什么
- 为什么停在这里

这就是运行事实层。

---

## 4. 如果面试官问你：Agent 的真正核心是模型吗？你怎么答？

### 面试官追问

- 那模型不重要吗？
- 如果不以模型为中心，你以什么为中心？

### 高质量作答框架

回答不能走极端。应该说：

- 模型是核心认知组件，但不是整个系统核心
- 真正系统核心是 runtime control loop + state + tools + safety
- 模型能力越强，越需要外部治理，而不是越可以少治理

### 结合 `opencode` 的参考答案

在 `opencode` 里，模型被 Provider 包起来，而真正主导行为的是：

- `agent.go` 的控制循环
- `ToolResult` 回注入
- `Permission` 风险闸门
- `Session/Message` 持久化

这说明模型是大脑的一部分，不是整个神经系统。

---

## 5. 如果你设计多模型多角色系统，角色应该怎么拆？

### 面试官追问

- 为什么不只用一个强模型？
- 角色拆分的依据是什么？

### 高质量作答框架

角色拆分应按目标函数，而不是按“模型品牌”。

常见角色：

- 主代理：成功率优先
- 子任务代理：低成本检索优先
- 标题/摘要代理：超低成本和短输出优先
- 评审/验证代理：保守性优先

### 结合 `opencode` 的参考答案

`opencode` 里有：

- `coder`
- `task`
- `title`
- `summarizer`

这就是按目标函数拆角色，而不是让主模型包打天下。

---

## 6. 为什么子代理默认只读是一个高级设计判断？

### 面试官追问

- 只读会不会牺牲能力？
- 如果以后要让子代理写，怎么演进？

### 高质量作答框架

回答要体现 tradeoff：

- 只读牺牲了一部分吞吐和并行实现能力
- 但换来安全、可解释性、低冲突和低编排复杂度

如果要演进：

- 引入 path ownership
- 引入 merge protocol
- 引入受限写权限

### 结合 `opencode` 的参考答案

`TaskAgentTools` 只有：

- `glob`
- `grep`
- `ls`
- `sourcegraph`
- `view`

这说明 `opencode` 把子代理定义成 research-only lane，而不是平行主代理。这非常成熟。

---

## 7. 如何设计权限系统，让 Agent 可用但不危险？

### 面试官追问

- 为什么不能只在 UI 上提示一下？
- 授权粒度到什么程度合适？

### 高质量作答框架

权限系统应满足：

- 靠近副作用发生点
- 能表达 action + path + session scope
- 支持 deny / allow once / allow persistent
- 不与具体 UI 实现耦合

### 结合 `opencode` 的参考答案

`permission.Service` 负责：

- `Request`
- `Grant`
- `GrantPersistant`
- `Deny`
- `AutoApproveSession`

而 UI 通过 PubSub 订阅审批事件。这就是比较干净的分层。

---

## 8. 如果模型一直在调用工具不收敛，你会怎么处理？

### 面试官追问

- 你如何判断“没收敛”？
- 是依靠模型自己判断，还是系统硬拦截？

### 高质量作答框架

要提出多层熔断：

1. 最大工具轮数
2. 相同工具重复调用检测
3. 进展度判断
4. 成本预算
5. 用户取消

### 结合 `opencode` 的参考答案

`opencode` 当前主要依赖：

- 模型自然收敛
- 用户取消
- 上下文/成本隐式约束

如果要提高鲁棒性，应把熔断逻辑补到 `processGeneration` 附近，而不是散落在 Tool 内。

---

## 9. 为什么 `ToolResult` 是 Agent 系统最关键的数据结构之一？

### 面试官追问

- 为什么不是 `ToolCall` 更重要？
- 如果不结构化 `ToolResult` 会怎样？

### 高质量作答框架

必须强调：

- `ToolCall` 只是意图
- `ToolResult` 才是现实世界反馈
- 没有反馈，控制循环无法闭环

### 结合 `opencode` 的参考答案

`opencode` 不只是有 `ToolResult`，还把它：

- 持久化进 `Message`
- 在多个 Provider 中重新编码给模型
- 在日志中可追踪

这使得系统具备真正可回放的动作-反馈闭环。

---

## 10. 你如何设计上下文工程，而不是只写一个大 prompt？

### 面试官追问

- 上下文应该分几层？
- 哪些上下文该自动注入，哪些该按需获取？

### 高质量作答框架

建议分层：

1. 系统规则
2. 环境信息
3. 项目规则
4. 会话历史
5. 按需文件上下文
6. 工具反馈上下文

### 结合 `opencode` 的参考答案

`opencode` 正是这样做的：

- `CoderPrompt` 提供系统规则
- 环境信息自动注入 cwd、平台、日期、目录结构
- `ContextPaths` 注入项目上下文文件
- `messages.List` 提供历史消息
- `view/grep/glob` 按需拉文件上下文
- `ToolResult` 回注入反馈

---

## 11. 自动摘要为什么不是“记忆”的全部？

### 面试官追问

- 摘要和长期记忆有什么本质不同？
- 什么时候摘要会伤害系统？

### 高质量作答框架

应明确区分：

- 摘要是短期上下文压缩
- 记忆是长期知识管理与召回

摘要会伤害系统的场景：

- 调试任务还需要细粒度局部事实
- 摘要错误放大偏差
- 无法追溯原始上下文

### 结合 `opencode` 的参考答案

`opencode` 的 `AutoCompact + SummaryMessageID` 是优秀的上下文压缩设计，但它不是完整长期记忆系统。

这正是面试里应该说清的边界。

---

## 12. 如果让你评价 `opencode` 的记忆架构，你会怎么说？

### 面试官追问

- 它现在有记忆吗？
- 缺了什么？

### 高质量作答框架

应避免二元回答。正确说法是：

- 它有会话历史记忆
- 有摘要承接
- 有项目上下文文件
- 但缺长期、结构化、可召回的多类型记忆体系

### 结合 `opencode` 的参考答案

当前有：

- session history
- summary continuation
- context file injection

未来若要增强，应补：

- user preference memory
- project memory
- task execution memory
- retrieval quality eval

---

## 13. 如何定义一个 Agent 系统的“完成”？

### 面试官追问

- 模型说完成就算完成吗？
- 你如何避免 false completion？

### 高质量作答框架

应区分：

- 模型完成
- 系统完成
- 任务完成
- 验证完成

### 结合 `opencode` 的参考答案

`opencode` 当前主要依据 `FinishReason` 和执行链路结束来认定完成。

更高标准下，可以补：

- `completed_verified`
- `completed_unverified`
- `stopped_by_permission`
- `provider_failed`
- `cancelled`

这样的完成分级。

---

## 14. 你会如何评测一个 Agent 系统？

### 面试官追问

- 只看 final answer 对不对够吗？
- 你会收集哪些分层指标？

### 高质量作答框架

至少分四层指标：

1. 任务成功率
2. 工具调用正确率
3. 成本与延迟
4. 失败模式分类

### 结合 `opencode` 的参考答案

`opencode` 已具备：

- cost 统计
- ToolResult 持久化基础
- Session 与 Message 结构

这为后续做更系统的 replay 和 eval 打下了很好的地基。

---

## 15. 为什么完成判定和评测是两个问题？

### 面试官追问

- 不是完成了就说明成功了吗？

### 高质量作答框架

不是。

- 完成判定是 runtime 当下是否停止执行
- 评测是离线或事后判断这个停止是否真的成功

### 结合 `opencode` 的参考答案

`FinishReason` 只是 runtime 信号，不是严格意义上的任务成功证明。这正是后续应该补 verification layer 的原因。

---

## 16. 如果你要设计一个 Agent 系统的 replay，你会重放什么？

### 面试官追问

- 为什么不是只回放最终文本？
- 哪些事件必须具备确定性？

### 高质量作答框架

最小 replay 单元应包括：

- prompt snapshot
- message history
- tool calls
- tool results
- provider events
- finish reason

### 结合 `opencode` 的参考答案

`opencode` 已经持有其中大部分元素，但还缺更完整的 execution timeline 视图。换句话说，它有 replay 资产，但还没有完整 replay 产品形态。

---

## 17. 如果让你设计多租户 Agent 平台，`opencode` 哪些地方需要重构？

### 面试官追问

- 哪些对象现在是进程级假设？
- 哪些地方未来会成为瓶颈？

### 高质量作答框架

要指出：

- `App` 生命周期
- `activeRequests`
- `LSPClients`
- `ContextPaths` 缓存
- MCP tool 缓存
- 本地 shell / filesystem 权限边界

### 结合 `opencode` 的参考答案

当前设计对单机 CLI 非常合适，但若做服务端平台，这些都要从“单进程本地 runtime”改成“可隔离、可租户、可观测”的控制平面资源。

---

## 18. 为什么并发代理很难？

### 面试官追问

- 多开几个子代理不就好了？
- 最大难点是什么？

### 高质量作答框架

要点：

- 并发不是多开模型请求，而是多条执行链并存
- 难点在 ownership、merge、冲突检测、取消传播、成本归因

### 结合 `opencode` 的参考答案

`opencode` 通过“子代理只读”有意识地避开了最难的一段复杂度曲线。这不是保守，而是正确地延后复杂度。

---

## 19. 为什么 `ErrSessionBusy` 不是一个小细节？

### 面试官追问

- 没有它会怎样？

### 高质量作答框架

没有 session-level serialization，会导致：

- 消息错序
- 成本归因混乱
- tool result 错绑
- 取消语义混乱

### 结合 `opencode` 的参考答案

`IsSessionBusy` 体现的是“会话级一致性优先于吞吐”。这是很成熟的默认选择。

---

## 20. 如果你要设计附件支持，最关键的抽象是什么？

### 面试官追问

- 为什么不是在 UI 层判断文件类型就行？

### 高质量作答框架

关键是模型能力元数据：

- 哪些模型支持附件
- 哪些 Provider 能正确转码
- 哪些 UI 能上传

### 结合 `opencode` 的参考答案

`SupportsAttachments` 就是这个抽象。`agent.Run` 会根据模型能力决定是否丢弃附件，`filepicker` 也会按模型能力约束 UI。

---

## 21. 如何看待 `CanReason` 这种元数据字段？

### 面试官追问

- 为什么不直接在配置里写 reasoning effort？

### 高质量作答框架

因为 reasoning 不是纯配置项，而是模型能力与 Provider 协议的交集。

### 结合 `opencode` 的参考答案

`CanReason` 配合 `ReasoningEffort`，在 OpenAI / Local / Anthropic 不同 Provider 上走不同策略。这说明能力元数据最终会影响 runtime 行为，不是装饰字段。

---

## 22. 为什么 Provider 抽象是必须的，而不是“多写几个 if”？

### 面试官追问

- 真的有那么大差异吗？

### 高质量作答框架

差异主要在：

- message 编码
- tool schema 编码
- tool result 编码
- reasoning 参数
- streaming event 解析

### 结合 `opencode` 的参考答案

`provider.Provider` 接口之下，OpenAI、Anthropic、Gemini、Copilot 都有各自的转换逻辑。这就是 Provider abstraction 的必要性。

---

## 23. 如果面试官问：你会怎么改进 `opencode` 的可靠性？你怎么答？

### 面试官追问

- 优先级是什么？
- 为什么这些比新增功能更重要？

### 高质量作答框架

先补可靠性，再补功能：

1. 最大工具轮数
2. 重复调用检测
3. 完成质量分级
4. 验证语义
5. replay 与失败归因

### 结合 `opencode` 的参考答案

这些改动应主要落在：

- `agent.processGeneration`
- `message/session` 状态建模
- `logging` / replay tracing

而不是先去加更多模型或更多花哨工具。

---

## 24. 如何回答“你如何让 Agent 既安全又好用”？

### 面试官追问

- 安全和体验是不是天然矛盾？

### 高质量作答框架

回答不应极端。应提出：

- 低风险动作默认放行
- 高风险动作审批
- session-scoped persistent grant
- 人类可中断
- 日志与回放可审计

### 结合 `opencode` 的参考答案

`permission.Request + GrantPersistant + AutoApproveSession + PubSub/TUI` 已经是这条思路的一个很实用版本。

---

## 25. 如果这是 Google onsite 的最后一题：评价 `opencode`，你会怎么总结？

### 面试官追问

- 只说优点不够，短板呢？

### 高质量作答框架

优点：

- runtime 边界清晰
- tool loop 闭环完整
- 多角色、多 Provider 设计合理
- 副作用治理意识强
- replay/eval 基础资产不错

短板：

- control loop 收敛策略偏轻
- 长期记忆体系还弱
- 并发执行与 merge 尚未展开
- 评测和控制平面还不完整

### 结合 `opencode` 的参考答案

一句话总结可以是：

`opencode` 已经具备了一个真实 Agent runtime 的骨架，最值得学习的是它的边界感；最值得继续补的是可靠性、评测和控制平面。

---

## 使用建议

如果你要把这篇真正用作面试训练，我建议这样练：

1. 先自己答，不看答案。
2. 每题强迫自己引用 `opencode` 的具体模块或函数。
3. 每题最后补一句“如果让我改，我先改哪里”。
4. 最后把 25 题压缩成你自己的 10 题核心 checklist。
