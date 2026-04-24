import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log, Trace } from "@/util"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"

const log = Log.create({ service: "server" })
const trace = Trace.create("server.event", "packages/opencode/src/server/routes/instance/event.ts")

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      trace.info("TUI/客户端已连接事件流", {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      })
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let done = false

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )
        trace.info("事件流已发送 server.connected")

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
          trace.info("TUI/客户端事件流已断开")
        }

        const unsub = Bus.subscribeAll((event) => {
          trace.info("事件流向 TUI/客户端写入 Bus 事件", {
            type: event.type,
            properties: event.properties,
          })
          q.push(JSON.stringify(event))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
