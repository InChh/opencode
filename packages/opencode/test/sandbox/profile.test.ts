import { test, expect, beforeAll } from "bun:test"
import { generateProfile, generateFullProfile, type ProfileInput } from "../../src/sandbox/profile"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Use a resolved path to avoid macOS /tmp → /private/tmp issues in assertions
const RAW_PROJECT_ROOT = "/tmp/test-project"
let PROJECT_ROOT = RAW_PROJECT_ROOT

beforeAll(async () => {
  // Resolve /tmp symlink so assertions match the profile output
  const resolvedTmp = await fs.realpath("/tmp").catch(() => "/tmp")
  PROJECT_ROOT = path.join(resolvedTmp, "test-project")
})

function makeInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    projectRoot: RAW_PROJECT_ROOT,
    allowlist: [],
    deny: [],
    extraPaths: [],
    ...overrides,
  }
}

test("empty allowlist produces minimal profile", async () => {
  const profile = await generateProfile(makeInput())
  expect(profile).toContain("(version 1)")
  expect(profile).toContain("(allow default)")
  expect(profile).not.toContain("file-write*")
})

test("directory glob pattern generates regex write allow rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(";; glob: src/**")
  expect(profile).toMatch(/\(regex ".*"\)/)
})

test("directory concrete pattern generates subpath write allow rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src", type: "directory" }],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(subpath "${path.join(PROJECT_ROOT, "src")}")`)
})

test("file pattern generates literal write allow rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "package.json", type: "file" }],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(literal "${path.join(PROJECT_ROOT, "package.json")}")`)
})

test("deny directory generates subpath deny rule", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: "secrets", type: "directory", deniedOperations: ["read", "write"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain("(deny file-read* file-write*")
  expect(profile).toContain(`(subpath "${path.join(PROJECT_ROOT, "secrets")}")`)
})

test("deny file generates literal deny rule", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: ".env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain("(deny file-read* file-write*")
  expect(profile).toContain(`(literal "${path.join(PROJECT_ROOT, ".env")}")`)
})

test("deny rules appear after allow rules", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**", type: "directory" }],
      deny: [{ pattern: "src/secret/**", type: "directory", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  const allowIdx = profile.indexOf("Allowlist write rules")
  const denyIdx = profile.indexOf("Deny rules")
  expect(allowIdx).toBeLessThan(denyIdx)
})

test("symlink resolution for /tmp on macOS", async () => {
  if (process.platform !== "darwin") return
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "/tmp/testdir", type: "directory" }],
    }),
  )
  // On macOS, /tmp → /private/tmp
  expect(profile).toContain("/private/tmp/testdir")
})

test("extra paths added as write allow rules", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["/custom/path"],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(subpath "/custom/path")`)
})

// --- Tilde expansion tests ---

test("extra paths with ~ expand to home directory", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["~/.config"],
    }),
  )
  expect(profile).toContain(`(subpath "${path.join(os.homedir(), ".config")}")`)
  expect(profile).not.toContain("~")
})

test("extra paths strip trailing /** glob", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["~/.agents/**"],
    }),
  )
  expect(profile).toContain(`(subpath "${path.join(os.homedir(), ".agents")}")`)
  expect(profile).not.toContain("**")
})

test("extra paths strip trailing /* glob", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["/custom/path/*"],
    }),
  )
  expect(profile).toContain(`(subpath "/custom/path")`)
  expect(profile).not.toContain("/*")
})

test("extra paths with ~ and /** combined", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["~/.config/**"],
    }),
  )
  const home = os.homedir()
  expect(profile).toContain(`(subpath "${path.join(home, ".config")}")`)
  expect(profile).not.toContain("~")
  expect(profile).not.toContain("**")
})

test("allowlist directory with ~ expands to home directory", async () => {
  const home = os.homedir()
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "~/.agents", type: "directory" }],
    }),
  )
  expect(profile).toContain(`(subpath "${path.join(home, ".agents")}")`)
  expect(profile).not.toContain("~/.agents")
})

test("allowlist file with ~ expands to home directory", async () => {
  const home = os.homedir()
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "~/.env", type: "file" }],
    }),
  )
  expect(profile).toContain(`(literal "${path.join(home, ".env")}")`)
})

test("allowlist glob with ~ expands in regex", async () => {
  const home = os.homedir()
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "~/.agents/**/*.md", type: "file" }],
    }),
  )
  // The comment preserves the original pattern
  expect(profile).toContain(";; glob: ~/.agents/**/*.md")
  // The regex should contain the resolved home path, not ~
  const match = profile.match(/\(regex "([^"]+)"\)/)
  expect(match).not.toBeNull()
  const re = new RegExp(match![1])
  expect(re.test(`${home}/.agents/skill/SKILL.md`)).toBe(true)
})

test("deny directory with ~ expands to home directory", async () => {
  const home = os.homedir()
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: "~/.secret", type: "directory", deniedOperations: ["read", "write"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain(`(subpath "${path.join(home, ".secret")}")`)
})

test("deny glob with ~ expands in regex", async () => {
  const home = os.homedir()
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: "~/.secret/**/*.key", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain(";; glob: ~/.secret/**/*.key")
  const match = profile.match(/\(regex "([^"]+)"\)/)
  expect(match).not.toBeNull()
  const re = new RegExp(match![1])
  expect(re.test(`${home}/.secret/certs/private.key`)).toBe(true)
})

test("paths without ~ are not affected by tilde expansion", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["/absolute/path", "relative/path"],
    }),
  )
  expect(profile).toContain(`(subpath "/absolute/path")`)
  expect(profile).toContain(`(subpath "${path.join(PROJECT_ROOT, "relative/path")}")`)
})

test("full profile .git rule resolves to git repo root when projectRoot is a subdirectory", async () => {
  // Create a temp dir structure: repoRoot/.git + repoRoot/subdir/
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-git-root-"))
  const repoRoot = path.join(tmpBase, "repo")
  const subDir = path.join(repoRoot, "subdir")
  await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true })
  await fs.mkdir(subDir, { recursive: true })

  try {
    const resolvedRepo = await fs.realpath(repoRoot)

    // projectRoot is the subdirectory, but .git is at the parent
    const profile = await generateFullProfile(makeInput({ projectRoot: subDir }))
    expect(profile).toContain(`(subpath "${path.join(resolvedRepo, ".git")}")`)
    // Should NOT contain subdir/.git
    const resolvedSub = await fs.realpath(subDir)
    expect(profile).not.toContain(`(subpath "${path.join(resolvedSub, ".git")}")`)
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
})

test("full profile .git rule falls back to projectRoot when no .git found", async () => {
  // Create a temp dir with no .git anywhere
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-no-git-"))
  const noGitDir = path.join(tmpBase, "norepo")
  await fs.mkdir(noGitDir, { recursive: true })

  try {
    const resolved = await fs.realpath(noGitDir)
    const profile = await generateFullProfile(makeInput({ projectRoot: noGitDir }))
    // Falls back to projectRoot/.git
    expect(profile).toContain(`(subpath "${path.join(resolved, ".git")}")`)
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
})
