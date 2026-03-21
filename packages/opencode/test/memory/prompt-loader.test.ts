import { describe, test, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { load, type PromptName } from "../../src/memory/prompt/loader"

describe("prompt loader", () => {
  test("returns built-in default for known name when no user file", async () => {
    const result = await load("recall", [])
    expect(result).toBeTruthy()
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("memory-recall agent")
  })

  test("returns user file content when found in directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(path.join(memdir, "recall.md"), "custom recall prompt")
      },
    })

    const result = await load("recall", [tmp.path])
    expect(result).toBe("custom recall prompt")
  })

  test("higher priority directory wins over lower", async () => {
    await using low = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(path.join(memdir, "recall.md"), "low priority")
      },
    })
    await using high = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(path.join(memdir, "recall.md"), "high priority")
      },
    })

    const result = await load("recall", [low.path, high.path])
    expect(result).toBe("high priority")
  })

  test("strips frontmatter from user file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(
          path.join(memdir, "recall.md"),
          "---\ndescription: My custom recall\n---\nActual prompt content",
        )
      },
    })

    const result = await load("recall", [tmp.path])
    expect(result).toBe("Actual prompt content")
    expect(result).not.toContain("description")
    expect(result).not.toContain("---")
  })

  test("falls back to default when file read fails", async () => {
    // Pass a non-existent directory — should not crash, should return default
    const result = await load("recall", ["/nonexistent/path/that/does/not/exist"])
    expect(result).toBeTruthy()
    expect(result).toContain("memory-recall agent")
  })

  test("loads all known prompt names without error", async () => {
    const names: PromptName[] = ["recall", "extract", "inject", "optimizer", "remember", "forget", "list"]
    for (const name of names) {
      const result = await load(name, [])
      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(0)
    }
  })

  test("returns default when user file is empty", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(path.join(memdir, "recall.md"), "")
      },
    })

    // Empty file should return default (graceful fallback)
    const result = await load("recall", [tmp.path])
    expect(result).toBeTruthy()
  })

  test("supports frontmatter with description field", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const memdir = path.join(dir, "memory")
        await fs.mkdir(memdir, { recursive: true })
        await Bun.write(
          path.join(memdir, "inject.md"),
          "---\ndescription: Custom injection format\n---\n<memory>\nCustom format\n</memory>",
        )
      },
    })

    const result = await load("inject", [tmp.path])
    expect(result).toContain("<memory>")
    expect(result).toContain("Custom format")
    expect(result).not.toContain("description:")
  })
})
