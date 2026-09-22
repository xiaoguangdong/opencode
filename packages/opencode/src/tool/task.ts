// 引入工具定义模块
import * as Tool from "./tool"
// 引入工具描述文本
import DESCRIPTION from "./task.txt"
import z from "zod"
// 引入 Session 服务
import { Session } from "../session"
// 引入会话 ID / 消息 ID schema
import { SessionID, MessageID } from "../session/schema"
// 引入消息类型
import { MessageV2 } from "../session/message-v2"
// 引入 Agent 服务
import { Agent } from "../agent/agent"
// 引入 SessionPrompt 类型(仅用于类型)
import type { SessionPrompt } from "../session/prompt"
// 引入配置服务
import { Config } from "../config"
import { Effect } from "effect"

/**
 * TaskTool 需要的外部操作集合(由调用方注入到 ctx.extra.promptOps):
 * - cancel:            取消指定会话
 * - resolvePromptParts: 把 prompt 模板解析为消息 Part 列表
 * - prompt:             向目标会话发送一次 prompt 并获取回复
 */
export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

// 工具名称
const id = "task"

/**
 * task 工具入参 schema
 * - description:    任务简述(3~5 词)
 * - prompt:         要求子 agent 执行的具体任务
 * - subagent_type:  使用哪种专用 agent
 * - task_id:        续跑之前任务时传入(可选)
 * - command:        触发本次 task 的命令(可选)
 */
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

/**
 * task 工具定义:
 *  - 从父会话派生出一个子会话(或复用已有 task_id 对应的会话)
 *  - 由指定的 subagent 在该子会话中执行 prompt
 *  - 返回 task_id 与子 agent 的最终文本输出
 */
export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    // 依赖注入
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    /**
     * 执行主逻辑
     */
    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      // 除非显式绕过,先请求 task 权限
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      // 获取目标 subagent 的元信息
      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      // 目标 agent 是否允许 task / todowrite
      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      // 若传了 task_id,则尝试复用已有会话
      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      // 复用或新建子会话
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          // 根据子 agent 权限构造禁止规则,并允许 experimental.primary_tools 中的工具
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      // 读取当前 assistant 消息以确定使用的模型
      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      // 优先使用子 agent 指定的模型,否则沿用父消息的模型
      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // 上报工具执行进度(标题 + 子会话 ID / 模型)
      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      // 获取由调用方注入的 prompt 操作集合
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()

      // 中止时取消子会话
      function cancel() {
        ops.cancel(nextSession.id)
      }

      // 用 acquireUseRelease 保证中止监听器被正确移除
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            // 解析 prompt 为消息 Part 列表
            const parts = yield* ops.resolvePromptParts(params.prompt)
            // 向子会话发送 prompt 并等待回复
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              agent: next.name,
              // 根据子 agent 权限关闭对应工具
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })

            // 返回结果:task_id 用于后续续跑,<task_result> 内为最后一条文本输出
            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
