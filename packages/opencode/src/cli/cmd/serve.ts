import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Lockfile } from "../../server/lockfile"
import { Instance } from "../../project/instance"
import { AuthToken } from "../../server/auth-token"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("auth-token", {
      type: "string",
      describe: "auth token for Bearer authentication (auto-generated when hostname is not loopback)",
    }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

    const dir = process.cwd()

    // Mutual exclusion: if another worker is running, exit with error
    const existing = await Lockfile.acquire(dir)
    if (existing) {
      console.error(`Error: another worker is already running (PID ${existing.pid}, port ${existing.port}).`)
      console.error("Use 'opencode stop' to stop it first.")
      process.exitCode = 1
      return
    }

    const opts = await resolveNetworkOptions(args)

    // Set up auth token when hostname is not loopback
    const token = (() => {
      if (AuthToken.loopback(opts.hostname)) return null
      const val = ((args as Record<string, unknown>)["auth-token"] as string | undefined) ?? AuthToken.generate()
      AuthToken.set(val)
      console.log(`Auth token: ${val}`)
      return val
    })()

    const server = Server.listen(opts)
    const port = server.port!

    const ok = await Lockfile.create(dir, {
      pid: process.pid,
      port,
      token,
      createdAt: Date.now(),
    })

    if (!ok) {
      console.error("Error: failed to create lock file (race condition). Another worker may have just started.")
      await server.stop()
      process.exitCode = 1
      return
    }

    console.log(`opencode server listening on http://${server.hostname}:${port}`)

    const shutdown = async () => {
      await Instance.disposeAll()
      await server.stop()
      await Lockfile.remove(dir)
      process.exit(0)
    }

    process.on("SIGTERM", shutdown)
    process.on("SIGINT", shutdown)

    // Keep process alive — serve mode never auto-exits
    await new Promise(() => {})
  },
})
