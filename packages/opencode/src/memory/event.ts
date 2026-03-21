import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Memory } from "./memory"

export namespace MemoryEvent {
  export const Created = BusEvent.define(
    "memory.created",
    z.object({
      info: Memory.Info,
    }),
  )

  export const Updated = BusEvent.define(
    "memory.updated",
    z.object({
      info: Memory.Info,
    }),
  )

  export const Removed = BusEvent.define(
    "memory.removed",
    z.object({
      id: z.string(),
    }),
  )

  export const Confirmed = BusEvent.define(
    "memory.confirmed",
    z.object({
      info: Memory.Info,
    }),
  )

  export const RecallComplete = BusEvent.define(
    "memory.recall.complete",
    z.object({
      sessionID: z.string(),
      injectedCount: z.number(),
      recalledCount: z.number(),
    }),
  )

  export const ConflictDetected = BusEvent.define(
    "memory.conflict.detected",
    z.object({
      sessionID: z.string(),
      conflicts: z.array(
        z.object({
          memoryA: z.string(),
          memoryB: z.string(),
          reason: z.string(),
        }),
      ),
    }),
  )

  export const CapacityWarning = BusEvent.define(
    "memory.capacity.warning",
    z.object({
      poolSize: z.number(),
      poolLimit: z.number(),
      usage: z.number(),
    }),
  )

  export const TeamCandidatesFound = BusEvent.define(
    "memory.team.candidates",
    z.object({
      candidates: z.array(Memory.Info),
    }),
  )
}
