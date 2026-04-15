import crypto from "crypto"
import { Instance } from "@/project/instance"

export namespace MemoryHindsightBank {
  function clean(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  }

  export function worktreeHash(root = Instance.worktree) {
    return crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)
  }

  export function bankId(root = Instance.worktree) {
    return `opencode:${worktreeHash(root)}`
  }

  export function tags(input: {
    kind: "memory" | "session_slice" | "observation"
    scope?: string
    status?: string
    categories?: string[]
    tags?: string[]
  }) {
    return [
      input.kind,
      input.scope ? `scope:${clean(input.scope)}` : undefined,
      input.status ? `status:${clean(input.status)}` : undefined,
      ...(input.categories ?? []).map((item) => `category:${clean(item)}`),
      ...(input.tags ?? []).map((item) => `tag:${clean(item)}`),
    ]
      .flatMap((item) => (item ? [item] : []))
      .filter(Boolean)
      .filter((item, i, list) => list.indexOf(item) === i)
      .sort()
  }
}
