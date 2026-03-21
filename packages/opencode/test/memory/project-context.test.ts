import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ProjectContext } from "../../src/memory/engine/project-context"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import * as fs from "fs/promises"

async function withProject<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const [name, content] of Object.entries(files)) {
        const filepath = path.join(dir, name)
        await fs.mkdir(path.dirname(filepath), { recursive: true })
        await fs.writeFile(filepath, content)
      }
    },
  })
  return Instance.provide({
    directory: tmp.path,
    fn: () => fn(tmp.path),
  })
}

describe("ProjectContext", () => {
  describe("detectLanguages", () => {
    test("detects typescript from tsconfig.json", async () => {
      await withProject({ "tsconfig.json": "{}" }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("typescript")
      })
    })

    test("detects python from pyproject.toml", async () => {
      await withProject({ "pyproject.toml": "[project]" }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("python")
      })
    })

    test("detects python from requirements.txt", async () => {
      await withProject({ "requirements.txt": "flask==2.0" }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("python")
      })
    })

    test("detects go from go.mod", async () => {
      await withProject({ "go.mod": "module example.com/foo" }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("go")
      })
    })

    test("detects rust from Cargo.toml", async () => {
      await withProject({ "Cargo.toml": "[package]" }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("rust")
      })
    })

    test("detects javascript from package.json without tsconfig", async () => {
      await withProject({ "package.json": '{"name":"test"}' }, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toContain("javascript")
        expect(langs).not.toContain("typescript")
      })
    })

    test("detects typescript (not javascript) when both package.json and tsconfig exist", async () => {
      await withProject(
        {
          "package.json": '{"name":"test"}',
          "tsconfig.json": "{}",
        },
        async (dir) => {
          const langs = await ProjectContext.detectLanguages(dir)
          expect(langs).toContain("typescript")
          expect(langs).not.toContain("javascript")
        },
      )
    })

    test("detects multiple languages", async () => {
      await withProject(
        {
          "tsconfig.json": "{}",
          "go.mod": "module example.com",
        },
        async (dir) => {
          const langs = await ProjectContext.detectLanguages(dir)
          expect(langs).toContain("typescript")
          expect(langs).toContain("go")
        },
      )
    })

    test("returns empty for empty project", async () => {
      await withProject({}, async (dir) => {
        const langs = await ProjectContext.detectLanguages(dir)
        expect(langs).toEqual([])
      })
    })
  })

  describe("detectTechStack", () => {
    test("detects node.js dependencies from package.json", async () => {
      await withProject(
        {
          "package.json": JSON.stringify({
            name: "test",
            dependencies: { hono: "^4.0.0", "drizzle-orm": "^0.30.0" },
            devDependencies: { vitest: "^1.0.0" },
          }),
        },
        async (dir) => {
          const stack = await ProjectContext.detectTechStack(dir)
          expect(stack).toContain("hono")
          expect(stack).toContain("drizzle")
          expect(stack).toContain("vitest")
        },
      )
    })

    test("detects react from react-dom", async () => {
      await withProject(
        {
          "package.json": JSON.stringify({
            dependencies: { "react-dom": "^18.0.0" },
          }),
        },
        async (dir) => {
          const stack = await ProjectContext.detectTechStack(dir)
          expect(stack).toContain("react")
        },
      )
    })

    test("detects python stack from pyproject.toml", async () => {
      await withProject(
        {
          "pyproject.toml": `[project]
dependencies = ["fastapi>=0.100", "sqlalchemy>=2.0"]`,
        },
        async (dir) => {
          const stack = await ProjectContext.detectTechStack(dir)
          expect(stack).toContain("fastapi")
          expect(stack).toContain("sqlalchemy")
        },
      )
    })

    test("detects go frameworks from go.mod", async () => {
      await withProject(
        {
          "go.mod": `module example.com
require github.com/gin-gonic/gin v1.9.0
require gorm.io/gorm v1.25.0`,
        },
        async (dir) => {
          const stack = await ProjectContext.detectTechStack(dir)
          expect(stack).toContain("gin")
          expect(stack).toContain("gorm")
        },
      )
    })

    test("detects rust crates from Cargo.toml", async () => {
      await withProject(
        {
          "Cargo.toml": `[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = "1.0"`,
        },
        async (dir) => {
          const stack = await ProjectContext.detectTechStack(dir)
          expect(stack).toContain("axum")
          expect(stack).toContain("tokio")
          expect(stack).toContain("serde")
        },
      )
    })

    test("returns empty for empty project", async () => {
      await withProject({}, async (dir) => {
        const stack = await ProjectContext.detectTechStack(dir)
        expect(stack).toEqual([])
      })
    })

    test("handles malformed package.json gracefully", async () => {
      await withProject({ "package.json": "not valid json {{{" }, async (dir) => {
        const stack = await ProjectContext.detectTechStack(dir)
        expect(stack).toEqual([])
      })
    })
  })

  describe("detect (full integration)", () => {
    test("returns complete project context", async () => {
      await withProject(
        {
          "package.json": JSON.stringify({
            name: "my-app",
            dependencies: { hono: "^4.0.0" },
            devDependencies: { vitest: "^1.0.0" },
          }),
          "tsconfig.json": "{}",
        },
        async (dir) => {
          const ctx = await ProjectContext.detect()
          expect(ctx.projectId).toBe(path.basename(dir))
          expect(ctx.languages).toContain("typescript")
          expect(ctx.techStack).toContain("hono")
          expect(ctx.techStack).toContain("vitest")
        },
      )
    })
  })
})
