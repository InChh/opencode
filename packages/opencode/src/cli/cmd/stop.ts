import { cmd } from "./cmd"
import { Lockfile } from "@/server/lockfile"
import { UI } from "@/cli/ui"

export const StopCommand = cmd({
  command: "stop",
  describe: "stop all background workers for the current directory",
  builder: (yargs) =>
    yargs.option("pid", {
      type: "number",
      describe: "stop a specific worker by PID",
    }),
  handler: async (args) => {
    const dir = process.cwd()
    const targetPid = (args as Record<string, unknown>).pid as number | undefined

    if (targetPid) {
      const lock = await Lockfile.acquire(dir, targetPid)
      if (!lock) {
        UI.println(`No running worker with PID ${targetPid} found for this directory.`)
        return
      }
      try {
        process.kill(lock.pid, "SIGTERM")
        UI.println(`Sent SIGTERM to worker (PID ${lock.pid}).`)
      } catch {
        UI.println(`Worker (PID ${lock.pid}) not responding, cleaning up lock file.`)
        await Lockfile.remove(dir, lock.pid)
      }
      return
    }

    const workers = await Lockfile.list(dir)

    if (workers.length === 0) {
      UI.println("No running workers found for this directory.")
      return
    }

    for (const worker of workers) {
      try {
        process.kill(worker.pid, "SIGTERM")
        UI.println(`Sent SIGTERM to worker (PID ${worker.pid}, port ${worker.port}).`)
      } catch {
        UI.println(`Worker (PID ${worker.pid}) not responding, cleaning up lock file.`)
        await Lockfile.remove(dir, worker.pid)
      }
    }
  },
})
