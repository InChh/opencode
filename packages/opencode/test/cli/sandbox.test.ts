import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { loadSandboxStatus, RefreshCommand, StatusCommand } from "../../src/cli/cmd/sandbox"
import { SecurityConfig } from "../../src/security/config"
import { SecurityAccess } from "../../src/security/access"
import * as Sandbox from "../../src/sandbox"
import * as SandboxInit from "../../src/sandbox/init"
import { tmpdir } from "../fixture/fixture"

describe("loadSandboxStatus", () => {
  afterEach(() => {
    mock.restore()
  })

  test("uses cached security config by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = `${dir}/policy.sb`
        await Bun.write(file, "(version 1)")
        return file
      },
    })

    const load = spyOn(SecurityConfig, "loadSecurityConfig").mockResolvedValue({
      version: "1.0",
      roles: [],
      rules: [],
      resolvedAllowlist: [],
    })
    spyOn(SecurityAccess, "setProjectRoot").mockImplementation(() => {})
    spyOn(SandboxInit, "initSandbox").mockResolvedValue({ status: "active" })
    const refresh = spyOn(SandboxInit, "refreshSandboxPolicy").mockResolvedValue({ status: "active" })
    spyOn(Sandbox, "getSandboxStatus").mockReturnValue({ status: "active", error: null })
    spyOn(Sandbox, "getActiveSandbox").mockReturnValue({
      getPolicyPath: () => tmp.extra,
    } as unknown as ReturnType<typeof Sandbox.getActiveSandbox>)

    const result = await loadSandboxStatus(tmp.path, false)

    expect(load).toHaveBeenCalledWith(tmp.path, undefined)
    expect(refresh).not.toHaveBeenCalled()
    expect(result.policyPath).toBe(tmp.extra)
    expect(result.profile).toBe("(version 1)")
  })

  test("forces a full security config rescan for refresh", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = `${dir}/policy.sb`
        await Bun.write(file, "(version 1)")
        return file
      },
    })

    const load = spyOn(SecurityConfig, "loadSecurityConfig").mockResolvedValue({
      version: "1.0",
      roles: [],
      rules: [],
      resolvedAllowlist: [],
    })
    spyOn(SecurityAccess, "setProjectRoot").mockImplementation(() => {})
    spyOn(SandboxInit, "initSandbox").mockResolvedValue({ status: "active" })
    const refresh = spyOn(SandboxInit, "refreshSandboxPolicy").mockResolvedValue({ status: "active" })
    spyOn(Sandbox, "getSandboxStatus").mockReturnValue({ status: "active", error: null })
    spyOn(Sandbox, "getActiveSandbox").mockReturnValue({
      getPolicyPath: () => tmp.extra,
    } as unknown as ReturnType<typeof Sandbox.getActiveSandbox>)

    await loadSandboxStatus(tmp.path, true)

    expect(load).toHaveBeenCalledWith(tmp.path, { forceWalk: true })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe("sandbox commands", () => {
  test("exposes status and refresh subcommands", () => {
    expect(StatusCommand.command).toBe("status")
    expect(RefreshCommand.command).toBe("refresh")
  })
})
