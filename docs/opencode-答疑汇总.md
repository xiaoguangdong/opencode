# opencode 答疑汇总

> 记录对 opencode 源码的实际提问与解答。每则解答里的行号均按提问当时的分支工作区源码复核过；若源码后续有改动（如追踪埋点提交造成的行号下移），以文档「核实基准」节标注的基准为准。
>
> **核实基准**：分支 `trace_v1.14.22`（含提交 `6e663f5c6` 埋点改动后的工作区），路径相对 `packages/opencode/src/`。

## 目录

1. [发 session 请求的不是 HTTP 吗？怎么又到了 Effect 上？](#问题-1发-session-请求发的不是-http-请求吗怎么又到了-effect-上)
2. [路由（session.ts）是怎么调用到 prompt.ts:1583 的？](#问题-2路由是怎么一步步调用到-promptts1583-的)

---

## 问题 1：发 session 请求，发的不是 HTTP 请求吗？怎么又到了 Effect 上？

**问**：我不明白，发 session 请求发的不是 http 请求吗？怎么又到了 effect 上？

**答**：HTTP 和 Effect 不是二选一，它们分别在"进程之间"和"进程之内"两层工作。

### 第 1 层：对客户端而言，确实就是普通 HTTP

opencode 的 server 用 Bun 的 HTTP 服务起进程：

```ts
// server/adapter.bun.ts:12,19
fetch: app.fetch,        // 把 Hono 应用挂成 Bun HTTP server 的 fetch 入口
...
return Bun.serve({ ...args, port })
```

`POST /session/:id/prompt` 走标准 HTTP，请求体是 JSON。这层没有任何特殊之处。

### 第 2 层：HTTP 被接住后，"网络"结束，剩下全是进程内函数调用

Hono（Web 框架，`server/server.ts:2` 引入）按路径把请求分发到 `server/routes/instance/session.ts` 里注册的 handler（prompt 端点在 :875-891）。handler 就是一个普通的 async 函数。

### 第 3 层：handler 内部的业务代码用 Effect 写——"先描述，后执行"

handler 没有直接 `await promptService.prompt(...)`，而是：

```ts
// session.ts:882-888（节选）
const msg = await runRequest(
  "SessionRoutes.prompt",
  c,
  SessionPrompt.Service.use((svc) =>
    svc.prompt({ ...body, sessionID } as unknown as SessionPrompt.PromptInput),
  ),
)
```

`SessionPrompt.Service.use(...)` 此刻**不执行任何业务**，它只是产出一个 Effect 值——一份"程序说明书"：「我需要一个登记为 `@opencode/SessionPrompt` 的服务，拿到后调用它的 `prompt` 方法」。

为什么要绕这一步？因为 `SessionPrompt` 的实现依赖一大批其他服务（LLM、Bus、Permission、Snapshot……）。Effect 用类型系统把这些依赖显式记在账上（`prompt.ts:128` 的接口声明、:136 的 Service 标签），启动时统一装配注入：

- `prompt.ts:2161` `Service.of({ cancel, prompt, loop, shell, command, resolvePromptParts })` —— 把闭包内实现的登记处；
- `prompt.ts:2184` `export const defaultLayer` —— 本服务自身装配；
- `effect/app-runtime.ts:81` `SessionPrompt.defaultLayer` —— 汇入全应用运行时的依赖图。

### 第 4 层：runtime 把"说明书"变成真正的执行

```ts
// server/routes/instance/trace.ts:45-49（节选）
export function runRequest<A, E>(name: string, c: Context, effect: Effect.Effect<A, E, AppEnv>) {
  ...
  return AppRuntime.runPromise(          // ← 这里才真正开始执行
    effect.pipe(... Effect.withSpan(name, ...) ),  // 顺带套上日志与追踪 span
  )
}
```

`AppRuntime.runPromise`（`app-runtime.ts:108-109`）返回一个**普通 Promise**：跑到这时，`prompt.ts:1583` 的实现（`Effect.fn("SessionPrompt.prompt")`）才开始发起模型调用、驱动对话循环。`await` 到结果后，handler 把返回值序列化写进 HTTP 响应流（`session.ts:889` `void stream.write(JSON.stringify(msg))`）。

### 一句话总结

**HTTP 是电话线（机器到机器），Effect 是接起电话后这栋楼里的工作流程单（进程内）。流程单先写好、再交给"执行人"（runtime）统一开工；最后结果还是顺着电话线以 HTTP 响应传回去。**

（补充：`Effect.fn("SessionPrompt.prompt")` 里的字符串只是给这段 Effect 起个可观测用的名字/span 名，不是"实现标签"——真正的实现登记在 `Service.of`。）

---

## 问题 2：路由是怎么一步步调用到 prompt.ts:1583 的？

**问**：`POST /session/:id/prompt` 路由（session.ts）是怎么调用到 prompt.ts:1583 的？看不懂。

**答**：四步链条（行号按当前工作区已重验）：

1. **路由接请求**：`server/routes/instance/session.ts:875-891` 的 POST handler 解析 URL 参数和 JSON 请求体（:870 附近 `validator("json", SessionPrompt.PromptInput...)` 做入参校验）。
2. **构造 Effect 描述**：:885 `SessionPrompt.Service.use((svc) => svc.prompt({...}))` —— 按服务标签 `@opencode/SessionPrompt`（prompt.ts:136）"点名要服务"，此刻仍不执行。
3. **交给 runtime 执行**：:882 把整个 Effect 传给 `runRequest`（trace.ts:45），内部 `AppRuntime.runPromise`（trace.ts:48 → app-runtime.ts:108）驱动；app-runtime.ts:81 装配的 `SessionPrompt.defaultLayer` 在启动时已把 prompt.ts:2161 `Service.of({...})` 登记的实现绑定到该标签。
4. **落到实现**：runtime 解析出标签对应的服务实例，`:885` 里的 `svc.prompt` 即 prompt.ts:1583 的 `Effect.fn("SessionPrompt.prompt")` —— 从这里进入真正的对话轮次引擎（runLoop）。

关键心智转变：**`Service.use` 是"取实现"的间接层**。路由文件里看不到对 prompt.ts 函数的直接调用，调用关系被拆成"标签声明 → layer 绑定 → runtime 查表"三段，这也是在 `git grep Service.use` 时找不到传统意义"调用点"的原因。

---

*格式约定：新问题按"问题 N"追加在末尾，同步更新目录；解答中的行号需按当时工作区重新核实后才写入。*
