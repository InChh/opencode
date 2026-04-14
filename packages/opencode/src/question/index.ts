import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Global } from "../global"
import fs from "fs/promises"
import path from "path"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const ImagePart = z
    .object({
      mime: z.string().describe("Image MIME type (e.g. image/png)"),
      url: z.string().describe("Data URL of the image"),
      filename: z.string().optional().describe("Original filename"),
    })
    .meta({
      ref: "QuestionImagePart",
    })
  export type ImagePart = z.infer<typeof ImagePart>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
    images: z.array(ImagePart).optional().describe("Optional images attached by the user"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  export type Result = {
    answers: Answer[]
    images?: ImagePart[]
  }

  const Stored = Request.extend({
    status: z.enum(["pending", "replied", "rejected"]),
    answers: z.array(Answer).optional(),
    images: z.array(ImagePart).optional(),
    updated_at: z.number(),
  })
  type Stored = z.infer<typeof Stored>
  type Pending = {
    info: Request
    status: "pending" | "replied" | "rejected"
    result?: Result
    init: Promise<void>
    resolve: (result: Result) => void
    reject: (e: unknown) => void
  }

  function dir() {
    return path.join(Global.Path.data, "projects", Instance.project.id, "question")
  }

  function file(id: string) {
    return path.join(dir(), `${id}.json`)
  }

  async function write(row: Stored) {
    await fs.mkdir(dir(), { recursive: true })
    const target = file(row.id)
    const tmp = `${target}.tmp-${crypto.randomUUID()}`
    await Bun.write(tmp, JSON.stringify(row, null, 2))
    await fs.rename(tmp, target)
  }

  async function read(id: string) {
    const target = Bun.file(file(id))
    if (!(await target.exists())) return
    return Stored.parse(await target.json())
  }

  async function drop(id: string) {
    await fs.rm(file(id), { force: true })
  }

  export async function list() {
    const pending = await state().then((x) => x.pending)
    const items = await fs.readdir(dir()).catch(() => [] as string[])
    const rows = await Promise.all(
      items
        .filter((item) => item.endsWith(".json"))
        .map((item) =>
          Bun.file(path.join(dir(), item))
            .json()
            .then((row) => Stored.parse(row))
            .catch(() => undefined),
        ),
    )
    const seen = new Set(rows.filter(Boolean).map((item) => item!.id))
    return rows
      .filter((item): item is Stored => item !== undefined && item.status === "pending")
      .map((item) => ({
        id: item.id,
        sessionID: item.sessionID,
        questions: item.questions,
        tool: item.tool,
      }))
      .concat(
        Object.values(pending)
          .filter((item) => item.status === "pending" && !seen.has(item.info.id))
          .map((item) => ({
            id: item.info.id,
            sessionID: item.info.sessionID,
            questions: item.info.questions,
            tool: item.info.tool,
          })),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  const state = Instance.state(
    async () => {
      const pending: Record<string, Pending> = {}

      return {
        pending,
      }
    },
    async (state) => {
      await Promise.all(
        Object.entries(state.pending).map(async ([id, item]) => {
          delete state.pending[id]
          item.reject(new RejectedError())
          await drop(id).catch(() => undefined)
        }),
      )
    },
  )

  async function wait(id: string, pending: Record<string, Pending>) {
    while (true) {
      const local = pending[id]
      if (local?.status === "rejected") throw new RejectedError()
      if (local?.status === "replied" && local.result) return local.result

      const item = await read(id)
      if (!item || item.status === "pending") {
        if (!item && !pending[id]) throw new RejectedError()
        await Bun.sleep(250)
        continue
      }
      await drop(id).catch(() => undefined)
      if (item.status === "rejected") throw new RejectedError()
      return {
        answers: item.answers ?? [],
        ...(item.images ? { images: item.images } : {}),
      } satisfies Result
    }
  }

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<Result> {
    const s = await state()
    const id = Identifier.ascending("question")
    const info: Request = {
      id,
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
    }

    log.info("asking", { id, questions: input.questions.length })

    return new Promise<Result>((resolve, reject) => {
      s.pending[id] = {
        info,
        status: "pending",
        init: Promise.resolve(),
        resolve,
        reject,
      }
      s.pending[id].init = write({
        ...info,
        status: "pending",
        updated_at: Date.now(),
      })
        .then(() => Bus.publish(Event.Asked, info))
        .then(() => undefined)
      void s.pending[id].init
        .then(() => wait(id, s.pending))
        .then(resolve, reject)
        .finally(() => {
          delete s.pending[id]
        })
    })
  }

  export async function reply(input: { requestID: string; answers: Answer[]; images?: ImagePart[] }): Promise<void> {
    const pending = await state().then((x) => x.pending[input.requestID])
    await pending?.init
    const existing =
      (await read(input.requestID)) ??
      (pending
        ? {
            ...pending.info,
            status: "pending" as const,
            updated_at: Date.now(),
          }
        : undefined)
    if (!existing || existing.status !== "pending") {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    await write({
      ...existing,
      status: "replied",
      answers: input.answers,
      ...(input.images ? { images: input.images } : {}),
      updated_at: Date.now(),
    })

    if (pending) {
      pending.status = "replied"
      pending.result = {
        answers: input.answers,
        ...(input.images ? { images: input.images } : {}),
      }
    }

    Bus.publish(Event.Replied, {
      sessionID: existing.sessionID,
      requestID: existing.id,
      answers: input.answers,
    })
  }

  export async function reject(requestID: string): Promise<void> {
    const pending = await state().then((x) => x.pending[requestID])
    await pending?.init
    const existing =
      (await read(requestID)) ??
      (pending
        ? {
            ...pending.info,
            status: "pending" as const,
            updated_at: Date.now(),
          }
        : undefined)
    if (!existing || existing.status !== "pending") {
      log.warn("reject for unknown request", { requestID })
      return
    }

    log.info("rejected", { requestID })

    await write({
      ...existing,
      status: "rejected",
      updated_at: Date.now(),
    })

    if (pending) pending.status = "rejected"

    Bus.publish(Event.Rejected, {
      sessionID: existing.sessionID,
      requestID: existing.id,
    })
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }
}
