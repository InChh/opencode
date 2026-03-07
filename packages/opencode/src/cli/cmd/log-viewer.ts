import type { Argv } from "yargs"
import open from "open"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { LogServer } from "../../log/server"
import { LlmLog } from "../../log/query"

export const LogViewerCommand = cmd({
  command: "log-viewer",
  describe: "launch the LLM log viewer in your browser",
  builder: (yargs: Argv) => {
    return yargs
      .option("port", {
        type: "number",
        describe: "port to serve on",
        default: 19836,
      })
      .option("no-open", {
        type: "boolean",
        describe: "do not auto-open browser",
        default: false,
      })
      .option("reset", {
        type: "boolean",
        describe: "clear all log data (preserves table structure)",
        default: false,
      })
  },
  handler: async (args: { port: number; noOpen: boolean; reset: boolean }) => {
    if (args.reset) {
      const result = LlmLog.reset()
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + "  Reset complete: ",
        UI.Style.TEXT_NORMAL,
        `${result.deleted} log records deleted`,
      )
      return
    }

    const server = await LogServer.start({ port: args.port })

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Log Viewer:       ", UI.Style.TEXT_NORMAL, server.url)
    UI.println(UI.Style.TEXT_DIM + "  Press Ctrl+C to stop the server")
    UI.empty()

    if (!args.noOpen) {
      open(server.url).catch(() => {})
    }

    await new Promise(() => {})
    server.stop()
  },
})
