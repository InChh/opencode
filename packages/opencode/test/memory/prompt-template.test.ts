import { describe, test, expect } from "bun:test"
import { render } from "../../src/memory/prompt/template"

describe("prompt template engine", () => {
  test("replaces <!-- INJECT:FOO --> with vars.FOO", () => {
    const result = render("Hello <!-- INJECT:FOO --> world", { FOO: "bar" })
    expect(result).toBe("Hello bar world")
  })

  test("case insensitive matching", () => {
    const result = render("<!-- inject:foo -->", { FOO: "bar" })
    expect(result).toBe("bar")
  })

  test("allows space variants", () => {
    expect(render("<!--INJECT:FOO-->", { FOO: "a" })).toBe("a")
    expect(render("<!-- INJECT: FOO -->", { FOO: "b" })).toBe("b")
    expect(render("<!--  INJECT:  FOO  -->", { FOO: "c" })).toBe("c")
  })

  test("preserves unmatched variable markers", () => {
    const tpl = "Hello <!-- INJECT:MISSING --> world"
    expect(render(tpl, {})).toBe(tpl)
  })

  test("replaces multiple different variables", () => {
    const tpl = "<!-- INJECT:A --> and <!-- INJECT:B -->"
    expect(render(tpl, { A: "alpha", B: "beta" })).toBe("alpha and beta")
  })

  test("replaces same variable appearing multiple times", () => {
    const tpl = "<!-- INJECT:X --> then <!-- INJECT:X -->"
    expect(render(tpl, { X: "val" })).toBe("val then val")
  })

  test("returns template unchanged when no markers present", () => {
    expect(render("no markers here", { FOO: "bar" })).toBe("no markers here")
  })

  test("returns empty string for empty template", () => {
    expect(render("", { FOO: "bar" })).toBe("")
  })

  test("handles special characters in values", () => {
    const result = render("<!-- INJECT:V -->", { V: "has $dollar and {braces} and $1 ref" })
    expect(result).toBe("has $dollar and {braces} and $1 ref")
  })

  test("handles multiline values", () => {
    const result = render("before\n<!-- INJECT:CONTENT -->\nafter", { CONTENT: "line1\nline2\nline3" })
    expect(result).toBe("before\nline1\nline2\nline3\nafter")
  })
})
