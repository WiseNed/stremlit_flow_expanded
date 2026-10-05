export const RECORD = "\x1e"
export const FIELD = "\x1f"

export type FlowRow = {
  text: string
  background: string
  color: string
  strip: string
  bold: boolean
  warn: boolean
}

export function decodeFlowRows(content: string): FlowRow[] {
  if (!content) {
    return []
  }
  return content.split(RECORD).map((record) => {
    const [text = "", style = "", flags = ""] = record.split(FIELD)
    const [background = "", color = "", strip = ""] = style.split("|")
    return {
      text,
      background,
      color,
      strip,
      bold: flags.includes("b"),
      warn: flags.includes("w"),
    }
  })
}

export function stripBackground(strip: string): string {
  let b64 = strip.replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4) {
    b64 += "="
  }
  return `url("data:image/png;base64,${b64}")`
}

export function rowCount(content: string): number {
  const rows = decodeFlowRows(content)
  return Math.max(rows.length, 1)
}
