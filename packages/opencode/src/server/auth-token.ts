import crypto from "crypto"

/** Server-side auth token state and validation for Bearer token auth (distinct from basic auth). */
export namespace AuthToken {
  let token: string | null = null

  /** Check if the given hostname is a loopback address. */
  export function loopback(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  }

  /** Generate a random UUID auth token. */
  export function generate(): string {
    return crypto.randomUUID()
  }

  /** Set the active auth token. When null, Bearer auth is disabled. */
  export function set(val: string | null) {
    token = val
  }

  /** Get the active auth token. */
  export function get(): string | null {
    return token
  }

  /** Validate a request's Authorization header. Returns true if valid. */
  export function validate(header: string | undefined): boolean {
    if (!token) return true
    if (!header) return false
    if (!header.startsWith("Bearer ")) return false
    return header.slice(7) === token
  }
}
