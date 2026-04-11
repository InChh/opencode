import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SwarmState } from "../../src/session/swarm-state"

describe("SwarmState", () => {
  test("requires schema version 2", () => {
    expect(() =>
      SwarmState.Snapshot.parse({
        ...SwarmState.Example,
        schema_version: 1,
      }),
    ).toThrow()
  })

  test("writes and reads the canonical state file", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = SwarmState.create({
          id: "SW-v2",
          goal: "Ship v2 state",
          conductor: "SE-conductor",
        })
        await SwarmState.write(state)
        const next = await SwarmState.read("SW-v2")
        expect(next?.schema_version).toBe(2)
        expect(next?.swarm.id).toBe("SW-v2")
        expect(next?.swarm.stage).toBe("planning")
      },
    })
  })
})
