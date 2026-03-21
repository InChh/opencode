/**
 * Template engine for memory prompt files.
 *
 * Replaces `<!-- INJECT:VAR_NAME -->` markers with actual values.
 * Case-insensitive, allows space variants.
 * Unmatched markers are preserved.
 */
const regex = /<!--\s*inject:\s*(\w+)\s*-->/gi

export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(regex, (match, name) => {
    const key = name.toUpperCase()
    if (key in vars) return vars[key]
    return match
  })
}
