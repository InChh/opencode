import { EOL } from "os"
import { Config } from "../../../config/config"
import { MemoryHindsightBank } from "../../../memory/hindsight/bank"
import { MemoryHindsightService } from "../../../memory/hindsight/service"
import { MemoryHindsightState } from "../../../memory/hindsight/state"
import { Instance } from "../../../project/instance"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export async function loadHindsightInspect() {
  const cfg = await Config.get()
  const opts = cfg.memory?.hindsight
  const file = MemoryHindsightState.filepath()
  const state = await MemoryHindsightState.load()
  return {
    config: {
      enabled: opts?.enabled ?? false,
      mode: opts?.mode ?? "embedded",
      extract: opts?.extract ?? false,
      recall: opts?.recall ?? false,
      backfill: opts?.backfill ?? false,
      auto_start: opts?.auto_start !== false,
      workspace_scope: opts?.workspace_scope ?? "worktree",
    },
    bank: {
      id: MemoryHindsightBank.bankId(Instance.worktree),
      workspace_hash: state.workspace_hash,
      workspace_scope: state.workspace_scope,
      root: Instance.worktree,
    },
    service: await MemoryHindsightService.get(),
    state: {
      path: file,
      exists: await Bun.file(file).exists(),
      backfill: state.backfill,
    },
  }
}

export const HindsightCommand = cmd({
  command: "hindsight",
  describe: "inspect local Hindsight status",
  async handler() {
    await bootstrap(process.cwd(), async () => {
      process.stdout.write(JSON.stringify(await loadHindsightInspect(), null, 2) + EOL)
    })
  },
})
