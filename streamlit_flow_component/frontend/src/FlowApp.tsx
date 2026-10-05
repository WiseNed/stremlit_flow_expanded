import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps as ReactProps } from "react"
import {
  applyNodeChanges,
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"
import { Streamlit, type ComponentProps } from "streamlit-component-lib"
import ELK from "elkjs/lib/elk.bundled.js"
import { decodeFlowRows, stripBackground, type FlowRow } from "./decode"
import "./FlowApp.css"

type Point = { x: number; y: number }

type MenuField = {
  label: string
  kind: "select" | "number" | "text"
  value?: string | number | null
  step?: string
  options: { id: string; label: string }[]
  required: boolean
}

type MenuKind = "group" | "flyout" | "action" | "form" | "separator"

type MenuRow = {
  kind: MenuKind
  label: string
  disabled: boolean
  checked: boolean
  data: Record<string, unknown>
  buttons: string[]
  fields: MenuField[]
  children: MenuRow[]
}

type FlowNodeData = {
  content: string
  menu: Record<string, unknown>
  payload: Record<string, unknown>
  issue: boolean
  plain: boolean
  matched: boolean
}

type FlowArgs = {
  nodes?: {
    id: string
    content: string
    position: Point | null
    menu?: Record<string, unknown>
    payload?: Record<string, unknown>
  }[]
  edges?: { id: string; source: string; target: string }[]
  height?: number
  fit?: boolean
  viewport?: { x: number; y: number; zoom: number } | null
  pane_menu?: Record<string, unknown>
  filters?: unknown
  tree?: boolean
}

type MenuState = {
  x: number
  y: number
  rows: MenuRow[]
  nodeId: string
  payload: Record<string, unknown>
  open: string[]
  chart: Point
  viewport: { x: number; y: number; zoom: number }
}

const NODE_WIDTH = 260
const ROW_HEIGHT = 20
const TREE_GAP = 240
const NODE_GAP = 28
const MIN_ZOOM = 0.5
const elk = new ELK()

type FlowNodeArg = NonNullable<FlowArgs["nodes"]>[number]
type FlowEdgeArg = NonNullable<FlowArgs["edges"]>[number]

function childrenByParent(edges: FlowEdgeArg[]): Record<string, string[]> {
  const children: Record<string, string[]> = {}
  for (const edge of edges) {
    if (!children[edge.source]) {
      children[edge.source] = []
    }
    children[edge.source].push(edge.target)
  }
  return children
}

function rootsInOrder(nodes: FlowNodeArg[], edges: FlowEdgeArg[]): string[] {
  const targets = new Set(edges.map((edge) => edge.target))
  return nodes.filter((node) => !targets.has(node.id)).map((node) => node.id)
}

function subtreeIds(rootId: string, children: Record<string, string[]>): Set<string> {
  const ids = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    if (id === undefined || ids.has(id)) {
      continue
    }
    ids.add(id)
    for (const child of children[id] || []) {
      stack.push(child)
    }
  }
  return ids
}

async function layoutSubtree(
  nodes: FlowNodeArg[],
  edges: FlowEdgeArg[],
): Promise<{ positions: Record<string, Point>; width: number; height: number }> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": String(NODE_GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(TREE_GAP),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: nodes.map((node) => ({
      id: node.id,
      ...nodeSize(node.content),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  }
  const laid = await elk.layout(graph)
  const positions: Record<string, Point> = {}
  let minX = 0
  let minY = 0
  let right = 0
  let bottom = 0
  let started = false
  for (const child of laid.children || []) {
    const point = { x: child.x || 0, y: child.y || 0 }
    positions[child.id] = point
    const node = nodes.find((item) => item.id === child.id)
    const size = node ? nodeSize(node.content) : { width: NODE_WIDTH, height: 0 }
    if (!started) {
      minX = point.x
      minY = point.y
      started = true
    }
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    right = Math.max(right, point.x + size.width)
    bottom = Math.max(bottom, point.y + size.height)
  }
  if (started) {
    for (const id of Object.keys(positions)) {
      positions[id] = { x: positions[id].x - minX, y: positions[id].y - minY }
    }
    right -= minX
    bottom -= minY
  }
  return { positions, width: right, height: bottom }
}

function lowestPlacedBottom(
  positions: Record<string, Point>,
  nodes: FlowNodeArg[],
): number {
  let bottom = 0
  for (const node of nodes) {
    const point = positions[node.id]
    if (!point) {
      continue
    }
    bottom = Math.max(bottom, point.y + nodeSize(node.content).height)
  }
  return bottom
}

function separateOverlaps(
  nodes: FlowNodeArg[],
  edges: FlowEdgeArg[],
  positions: Record<string, Point>,
): Record<string, Point> {
  const next: Record<string, Point> = {}
  for (const node of nodes) {
    const point = positions[node.id]
    if (point) {
      next[node.id] = { x: point.x, y: point.y }
    }
  }
  const children = childrenByParent(edges)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ids = nodes.filter((node) => next[node.id]).map((node) => node.id)
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false
    const ordered = [...ids].sort((a, b) => next[a].y - next[b].y || next[a].x - next[b].x)
    for (let i = 0; i < ordered.length; i++) {
      const upperId = ordered[i]
      const upper = next[upperId]
      const upperNode = byId.get(upperId)
      if (!upper || !upperNode) {
        continue
      }
      const upperSize = nodeSize(upperNode.content)
      for (let j = i + 1; j < ordered.length; j++) {
        const lowerId = ordered[j]
        const lower = next[lowerId]
        const lowerNode = byId.get(lowerId)
        if (!lower || !lowerNode || lower.y < upper.y) {
          continue
        }
        const lowerSize = nodeSize(lowerNode.content)
        const xOverlap =
          upper.x < lower.x + lowerSize.width && lower.x < upper.x + upperSize.width
        if (!xOverlap) {
          continue
        }
        const needed = upper.y + upperSize.height + NODE_GAP
        if (lower.y >= needed) {
          continue
        }
        const delta = needed - lower.y
        for (const id of subtreeIds(lowerId, children)) {
          const point = next[id]
          if (!point) {
            continue
          }
          next[id] = { x: point.x, y: point.y + delta }
        }
        moved = true
      }
    }
    if (!moved) {
      break
    }
  }
  return next
}

let eventSeq = 0

function nextSeq(): number {
  eventSeq += 1
  return eventSeq
}

function emit(value: Record<string, unknown>) {
  Streamlit.setComponentValue({ seq: nextSeq(), ...value })
}

function warningReasons(row: FlowRow): string[] | null {
  if (!row.warn) {
    return null
  }
  return row.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function reasonBlockHeight(reasons: string[]): number {
  let lines = 0
  for (const reason of reasons) {
    lines += Math.max(1, Math.ceil(reason.length / 26))
  }
  return Math.max(ROW_HEIGHT * 3, lines * 16 + 12)
}

function nodeSize(content: string): { width: number; height: number } {
  const rows = decodeFlowRows(content)
  if (!rows.length) {
    return { width: NODE_WIDTH, height: ROW_HEIGHT + 12 }
  }
  let height = 12
  for (const row of rows) {
    const reasons = warningReasons(row)
    height += reasons ? reasonBlockHeight(reasons) : ROW_HEIGHT
  }
  return { width: NODE_WIDTH, height }
}

const MINIMAP_NODE = "#334155"
const MINIMAP_ISSUE = "#d32f2f"
const MINIMAP_ISSUE_BORDER = "#ff9800"
const MINIMAP_MATCH = "#2e7d32"
const MINIMAP_MUTED = "#94a3b8"

function nodeHasIssue(node: Node): boolean {
  return Boolean((node.data as FlowNodeData | undefined)?.issue)
}

function filterChoices(payload: Record<string, unknown> | undefined): Record<string, string[]> | null {
  const raw = payload?.filters
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null
  }
  const choices: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      continue
    }
    choices[key] = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  return Object.keys(choices).length ? choices : null
}

type FilterOption = { value: string; label: string }
type FilterField = { key: string; label: string; options: FilterOption[] }

function parseFilters(raw: unknown): FilterField[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const fields: FilterField[] = []
  for (const field of raw) {
    if (!field || typeof field !== "object") {
      continue
    }
    const record = field as Record<string, unknown>
    const key = String(record.key || "").trim()
    if (!key || !Array.isArray(record.options)) {
      continue
    }
    const options: FilterOption[] = []
    for (const option of record.options) {
      if (typeof option === "string") {
        if (option) {
          options.push({ value: option, label: option })
        }
        continue
      }
      if (!option || typeof option !== "object") {
        continue
      }
      const item = option as Record<string, unknown>
      const value = String(item.value ?? item.label ?? "")
      const label = String(item.label ?? item.value ?? "")
      if (!value && !label) {
        continue
      }
      options.push({ value: value || label, label: label || value })
    }
    if (!options.length) {
      continue
    }
    fields.push({ key, label: String(record.label || key), options })
  }
  return fields
}

function filteringActive(fields: FilterField[], excluded: Record<string, string[]>): boolean {
  for (const field of fields) {
    const hidden = excluded[field.key] || []
    const values = field.options.map((option) => option.value)
    if (hidden.some((value) => values.includes(value))) {
      return true
    }
  }
  return false
}

function nodeMatchesFilters(
  payload: Record<string, unknown> | undefined,
  fields: FilterField[],
  excluded: Record<string, string[]>,
): boolean {
  const choices = filterChoices(payload) || {}
  for (const field of fields) {
    const values = field.options.map((option) => option.value)
    const hidden = new Set(excluded[field.key] || [])
    const checked = values.filter((value) => !hidden.has(value))
    if (checked.length === values.length) {
      continue
    }
    const own = choices[field.key]
    if (!own || !own.some((value) => checked.includes(value))) {
      return false
    }
  }
  return true
}

function FlowMiniMapNode({
  x,
  y,
  width,
  height,
  color,
  strokeColor,
}: {
  x: number
  y: number
  width: number
  height: number
  color?: string
  strokeColor?: string
}) {
  const fill = color || MINIMAP_NODE
  const issue = strokeColor === MINIMAP_ISSUE_BORDER
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={fill}
      opacity={fill === MINIMAP_MUTED ? 0.3 : 1}
      stroke={issue ? MINIMAP_ISSUE_BORDER : "none"}
      strokeWidth={issue ? 4 : 0}
      vectorEffect="non-scaling-stroke"
      paintOrder="stroke fill"
    />
  )
}

function menuRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }
  return raw as Record<string, unknown>
}

function packGroups(
  boxes: { positions: Record<string, Point>; width: number; height: number }[],
): Record<string, Point> {
  const positions: Record<string, Point> = {}
  if (!boxes.length) {
    return positions
  }
  let bestScore = Number.POSITIVE_INFINITY
  let best: { boxIndex: number; x: number; y: number }[] = []
  for (let columns = 1; columns <= boxes.length; columns++) {
    const placed: { boxIndex: number; x: number; y: number }[] = []
    let x = 0
    let y = 0
    let rowHeight = 0
    let column = 0
    let width = 0
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index]
      if (column === columns) {
        y += rowHeight + TREE_GAP
        x = 0
        rowHeight = 0
        column = 0
      }
      placed.push({ boxIndex: index, x, y })
      rowHeight = Math.max(rowHeight, box.height)
      x += box.width + TREE_GAP
      width = Math.max(width, x - TREE_GAP)
      column += 1
    }
    const height = y + rowHeight
    const aspect = width / Math.max(height, 1)
    const score = Math.abs(Math.log(aspect))
    if (score < bestScore) {
      bestScore = score
      best = placed
    }
  }
  for (const spot of best) {
    const box = boxes[spot.boxIndex]
    for (const [id, point] of Object.entries(box.positions)) {
      positions[id] = { x: point.x + spot.x, y: point.y + spot.y }
    }
  }
  return positions
}

async function elkPositions(
  nodes: FlowArgs["nodes"],
  edges: FlowArgs["edges"],
): Promise<Record<string, Point>> {
  const nodeList = nodes || []
  const edgeList = edges || []
  const children = childrenByParent(edgeList)
  const boxes: { positions: Record<string, Point>; width: number; height: number }[] = []
  const placed = new Set<string>()
  for (const rootId of rootsInOrder(nodeList, edgeList)) {
    const ids = subtreeIds(rootId, children)
    const subNodes = nodeList.filter((node) => ids.has(node.id))
    const subEdges = edgeList.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    boxes.push(await layoutSubtree(subNodes, subEdges))
    for (const id of Object.keys(boxes[boxes.length - 1].positions)) {
      placed.add(id)
    }
  }
  for (const node of nodeList) {
    if (placed.has(node.id)) {
      continue
    }
    const size = nodeSize(node.content)
    boxes.push({
      positions: { [node.id]: { x: 0, y: 0 } },
      width: size.width,
      height: size.height,
    })
  }
  return packGroups(boxes)
}

function placeMissing(
  nodes: NonNullable<FlowArgs["nodes"]>,
  edges: NonNullable<FlowArgs["edges"]>,
  elkAll: Record<string, Point> | null,
): Record<string, Point> {
  const saved = nodes.some((node) => node.position)
  if (!saved && elkAll) {
    return elkAll
  }
  const positions: Record<string, Point> = {}
  for (const node of nodes) {
    if (node.position) {
      positions[node.id] = { x: node.position.x, y: node.position.y }
    }
  }
  const parentOf: Record<string, string> = {}
  for (const edge of edges) {
    parentOf[edge.target] = edge.source
  }
  for (const node of nodes) {
    if (positions[node.id]) {
      continue
    }
    const parentId = parentOf[node.id]
    if (!parentId) {
      const bottom = lowestPlacedBottom(positions, nodes)
      const y = Object.keys(positions).length ? bottom + TREE_GAP : 0
      positions[node.id] = { x: 0, y }
      continue
    }
    const parent = positions[parentId]
    const size = nodeSize(node.content)
    const parentSize = nodeSize(nodes.find((item) => item.id === parentId)?.content || "")
    const siblingCount = nodes.filter(
      (item) => parentOf[item.id] === parentId && positions[item.id] && item.id !== node.id,
    ).length
    const y = (parent ? parent.y : 0) + siblingCount * (size.height + 20)
    const x = parent ? parent.x + parentSize.width + 72 : 0
    positions[node.id] = { x, y }
  }
  return positions
}

function FlowNodeView({ data, dragging }: NodeProps<Node<FlowNodeData>>) {
  const size = nodeSize(data.content)
  const className = data.plain ? "flow-node flow-node-plain" : "flow-node"
  if (dragging) {
    return (
      <div className={`${className} flow-node-proxy`} style={{ height: size.height }}>
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
    )
  }
  const rows = decodeFlowRows(data.content)
  return (
    <div className={className}>
      <Handle type="target" position={Position.Left} />
      {rows.map((row, index) => (
        <FlowRowView key={index} row={row} plain={data.plain} />
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

function FlowRowView({ row, plain }: { row: FlowRow; plain: boolean }) {
  const style: Record<string, string> = {}
  if (!plain) {
    if (row.strip) {
      style.backgroundImage = stripBackground(row.strip)
      style.backgroundSize = "100% 100%"
      style.backgroundRepeat = "no-repeat"
      style.backgroundColor = "transparent"
    } else if (row.background) {
      style.backgroundColor = row.background
    }
    if (row.color) {
      style.color = row.color
    }
  }
  const reasons = warningReasons(row)
  const warn = reasons !== null
  const className = ["flow-row", row.bold ? "bold" : "", warn ? "warn" : ""]
    .filter(Boolean)
    .join(" ")
  if (reasons) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          columnGap: "8px",
          alignItems: "start",
          whiteSpace: "normal",
        }}
      >
        <span className="flow-warn-icon">⚠️</span>
        <ul className="flow-warn-list">
          {reasons.map((reason, index) => (
            <li key={`${index}:${reason}`}>{reason}</li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className={className} style={style}>
      {row.text}
    </div>
  )
}

const nodeTypes = { bom: FlowNodeView }

const MENU_KINDS = new Set<MenuKind>(["group", "flyout", "action", "form", "separator"])

function parseOptions(raw: unknown): { id: string; label: string }[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const options: { id: string; label: string }[] = []
  for (const option of raw) {
    if (typeof option === "string") {
      options.push({ id: option, label: option })
      continue
    }
    if (!option || typeof option !== "object") {
      continue
    }
    const record = option as Record<string, unknown>
    const id = String(record.id ?? record.label ?? "")
    const label = String(record.label ?? record.id ?? "")
    if (!id && !label) {
      continue
    }
    options.push({ id: id || label, label: label || id })
  }
  return options
}

function parseFields(raw: unknown): MenuField[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const fields: MenuField[] = []
  for (const field of raw) {
    if (!field || typeof field !== "object") {
      continue
    }
    const record = field as Record<string, unknown>
    const kind = record.kind === "select" || record.kind === "number" ? record.kind : "text"
    fields.push({
      label: String(record.label || ""),
      kind,
      value: record.value === null || record.value === undefined ? "" : (record.value as string | number),
      step: record.step === undefined ? undefined : String(record.step),
      options: parseOptions(record.options),
      required: kind !== "text" && record.required !== false,
    })
  }
  return fields
}

function parseRow(label: string, raw: unknown): MenuRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  const kind = String(record.__kind || "") as MenuKind
  if (!MENU_KINDS.has(kind)) {
    return null
  }
  const children: MenuRow[] = []
  if (kind === "group" || kind === "flyout") {
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith("__")) {
        continue
      }
      const child = parseRow(key, value)
      if (child) {
        children.push(child)
      }
    }
  }
  const buttons = Array.isArray(record.__buttons)
    ? record.__buttons.map((item) => String(item)).filter(Boolean)
    : ["Apply"]
  const data =
    record.__data && typeof record.__data === "object" && !Array.isArray(record.__data)
      ? (record.__data as Record<string, unknown>)
      : {}
  return {
    kind,
    label,
    disabled: Boolean(record.__disabled),
    checked: Boolean(record.__checked),
    data,
    buttons: buttons.length ? buttons : ["Apply"],
    fields: parseFields(record.__fields),
    children,
  }
}

function parseMenu(raw: unknown): MenuRow[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return []
  }
  const rows: MenuRow[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("__")) {
      continue
    }
    const row = parseRow(key, value)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

function locateRow(rows: MenuRow[], label: string): MenuRow | null {
  for (const row of rows) {
    if (row.kind === "separator") {
      continue
    }
    if (row.label === label) {
      return row
    }
    if (row.kind === "group") {
      const nested = locateRow(row.children, label)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

function buildPanels(
  root: MenuRow[],
  open: string[],
): { rows: MenuRow[]; form: MenuRow | null; formPath: string[]; ancestors: string[] }[] {
  const panels: { rows: MenuRow[]; form: MenuRow | null; formPath: string[]; ancestors: string[] }[] = [
    { rows: root, form: null, formPath: [], ancestors: [] },
  ]
  let rows = root
  let ancestors: string[] = []
  for (let cursor = 0; cursor < open.length; cursor += 1) {
    const found = locateRow(rows, open[cursor])
    if (!found || found.label !== open[cursor]) {
      break
    }
    if (found.kind === "group") {
      ancestors = [...ancestors, found.label]
      rows = found.children
      continue
    }
    if (found.kind === "flyout") {
      ancestors = [...ancestors, found.label]
      rows = found.children
      panels.push({ rows, form: null, formPath: [], ancestors: [...ancestors] })
      continue
    }
    if (found.kind === "form") {
      panels.push({
        rows: [],
        form: found,
        formPath: [...ancestors, found.label],
        ancestors: [],
      })
    }
    break
  }
  return panels
}

function fieldMissing(field: MenuField, values: Record<string, string>): boolean {
  if (!field.required) {
    return false
  }
  if (field.kind === "select" && field.options.length === 0) {
    return false
  }
  return !String(values[field.label] || "").trim()
}

function MenuForm({
  row,
  onSubmit,
}: {
  row: MenuRow
  onSubmit: (button: string, values: Record<string, string>) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of row.fields) {
      initial[field.label] =
        field.value === null || field.value === undefined ? "" : String(field.value)
    }
    return initial
  })
  const submitLabel = row.buttons[0] || "Apply"
  const blocked = row.fields.some((field) => fieldMissing(field, values))

  return (
    <form
      className="flow-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) {
          return
        }
        onSubmit(submitLabel, values)
      }}
    >
      {row.fields.map((field) => (
        <label key={field.label}>
          {field.label}
          {field.kind === "select" ? (
            <select
              value={values[field.label] || ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.label]: event.target.value }))
              }
            >
              <option value=""></option>
              {field.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.kind === "number" ? "number" : "text"}
              step={field.step}
              value={values[field.label] || ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.label]: event.target.value }))
              }
            />
          )}
        </label>
      ))}
      <div className="flow-form-actions">
        {row.buttons.map((button, index) =>
          index === 0 ? (
            <button key={button} type="submit" disabled={blocked}>
              {button}
            </button>
          ) : (
            <button key={button} type="button" onClick={() => onSubmit(button, values)}>
              {button}
            </button>
          ),
        )}
      </div>
    </form>
  )
}

function MenuList({
  rows,
  ancestors,
  open,
  nested,
  onOpen,
  onAction,
}: {
  rows: MenuRow[]
  ancestors: string[]
  open: string[]
  nested?: boolean
  onOpen: (path: string[]) => void
  onAction: (path: string[], row: MenuRow) => void
}) {
  let previousGroup = false
  return (
    <ul className={nested ? "flow-menu-nested" : "flow-menu"}>
      {rows.map((row) => {
        if (row.kind === "separator") {
          previousGroup = false
          return <hr className="sep" key={row.label} />
        }
        if (row.kind === "group") {
          const showLine = previousGroup
          previousGroup = true
          return (
            <li key={row.label}>
              {showLine ? <hr className="sep" /> : null}
              <div className="flow-menu-group">{row.label}</div>
              <MenuList
                rows={row.children}
                ancestors={[...ancestors, row.label]}
                open={open}
                nested
                onOpen={onOpen}
                onAction={onAction}
              />
            </li>
          )
        }
        previousGroup = false
        const path = [...ancestors, row.label]
        const opened = path.every((label, index) => open[index] === label)
        return (
          <li key={row.label}>
            <button
              type="button"
              className={opened ? "item open" : "item"}
              disabled={row.disabled}
              onClick={() => {
                if (row.disabled) {
                  return
                }
                if (row.kind === "flyout" || row.kind === "form") {
                  onOpen(path)
                  return
                }
                if (row.kind === "action") {
                  onAction(path, row)
                }
              }}
            >
              <span>
                {row.checked ? "✓ " : ""}
                {row.label}
              </span>
              {row.kind === "flyout" || row.kind === "form" ? <span>›</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function MenuPanels({
  menu,
  onOpen,
  onAction,
  onSubmit,
}: {
  menu: MenuState
  onOpen: (path: string[]) => void
  onAction: (path: string[], row: MenuRow) => void
  onSubmit: (path: string[], row: MenuRow, button: string, values: Record<string, string>) => void
}) {
  const panels = buildPanels(menu.rows, menu.open)
  return (
    <div className="flow-menu-layer" style={{ left: menu.x, top: menu.y }}>
      {panels.map((panel, index) =>
        panel.form ? (
          <div className="flow-menu" key={panel.formPath.join("\0")}>
            <MenuForm
              row={panel.form}
              onSubmit={(button, values) => onSubmit(panel.formPath, panel.form as MenuRow, button, values)}
            />
          </div>
        ) : (
          <MenuList
            key={index}
            rows={panel.rows}
            ancestors={panel.ancestors}
            open={menu.open}
            onOpen={onOpen}
            onAction={onAction}
          />
        ),
      )}
    </div>
  )
}

function parentIsUnderChild(
  parent: string,
  child: string,
  edges: { source: string; target: string }[],
): boolean {
  const children: Record<string, string[]> = {}
  for (const edge of edges) {
    if (!children[edge.source]) {
      children[edge.source] = []
    }
    children[edge.source].push(edge.target)
  }
  const stack = [...(children[child] || [])]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()
    if (!id || seen.has(id)) {
      continue
    }
    if (id === parent) {
      return true
    }
    seen.add(id)
    stack.push(...(children[id] || []))
  }
  return false
}

function Canvas({
  args,
  onMenu,
}: {
  args: FlowArgs
  onMenu: (menu: MenuState | null) => void
}) {
  const sourceNodes = args.nodes || []
  const sourceEdges = args.edges || []
  const { getNodes, fitView, getViewport, setViewport, screenToFlowPosition } = useReactFlow()
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [excluded, setExcluded] = useState<Record<string, string[]>>({})
  const [search, setSearch] = useState<Record<string, string>>({})
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [fieldsOpen, setFieldsOpen] = useState<Record<string, boolean>>({})
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const layoutKey = useRef("")
  const fitted = useRef(false)
  const filterFields = useMemo(() => parseFilters(args.filters), [args.filters])
  const tree = args.tree !== false
  const filtersOn = filteringActive(filterFields, excluded)

  const signature = sourceNodes
    .map((node) => `${node.id}:${node.position ? "1" : "0"}:${node.content}`)
    .join("|")

  useEffect(() => {
    let cancel = false
    const missing = sourceNodes.some((node) => !node.position)
    if (!missing) {
      return
    }
    if (layoutKey.current === signature) {
      return
    }
    const allMissing = sourceNodes.every((node) => !node.position)
    ;(async () => {
      const elkAll = allMissing ? await elkPositions(sourceNodes, sourceEdges) : null
      if (cancel) {
        return
      }
      const next = separateOverlaps(
        sourceNodes,
        sourceEdges,
        placeMissing(sourceNodes, sourceEdges, elkAll),
      )
      layoutKey.current = signature
      setPositions(next)
      emit({ type: "drag", id: "", payload: {}, positions: next })
    })()
    return () => {
      cancel = true
    }
  }, [signature, sourceEdges, sourceNodes])

  const builtNodes = useMemo<Node<FlowNodeData>[]>(() => {
    const base: Record<string, Point> = {}
    for (const node of sourceNodes) {
      base[node.id] = node.position || positions[node.id] || { x: 0, y: 0 }
    }
    const placed = separateOverlaps(sourceNodes, sourceEdges, base)
    return sourceNodes.map((node) => {
      const point = placed[node.id] || { x: 0, y: 0 }
      const size = nodeSize(node.content)
      const payload = node.payload || {}
      const matches = nodeMatchesFilters(payload, filterFields, excluded)
      const plain = filtersOn && !matches
      return {
        id: node.id,
        type: "bom",
        position: point,
        data: {
          content: node.content,
          menu: menuRecord(node.menu),
          payload,
          issue: Boolean(payload.issue),
          plain,
          matched: filtersOn && matches,
        },
        width: size.width,
        height: size.height,
        draggable: true,
        selectable: !plain,
        connectable: false,
        deletable: false,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { width: size.width },
      }
    })
  }, [excluded, filterFields, filtersOn, positions, sourceEdges, sourceNodes])
  const dragLive = useRef(false)
  const [nodes, setNodes] = useState(builtNodes)
  if (!dragLive.current && nodes !== builtNodes) {
    setNodes(builtNodes)
  }

  const onNodesChange = useCallback((changes: NodeChange<Node<FlowNodeData>>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const edges = useMemo<Edge[]>(
    () =>
      sourceEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        deletable: false,
        reconnectable: false,
        selectable: true,
        selected: edge.id === selectedEdgeId,
        type: "smoothstep",
        style: edge.id === selectedEdgeId ? { stroke: "#2563eb", strokeWidth: 2 } : undefined,
      })),
    [selectedEdgeId, sourceEdges],
  )

  useEffect(() => {
    if (fitted.current || nodes.length === 0) {
      return
    }
    const ready = sourceNodes.every((node) => node.position || positions[node.id])
    if (!ready) {
      return
    }
    fitted.current = true
    const restore = args.viewport
    const handle = window.setTimeout(() => {
      if (
        restore &&
        Number.isFinite(restore.x) &&
        Number.isFinite(restore.y) &&
        Number.isFinite(restore.zoom)
      ) {
        setViewport({ x: restore.x, y: restore.y, zoom: restore.zoom })
        return
      }
      fitView({ padding: 0.15, minZoom: MIN_ZOOM })
    }, 30)
    return () => window.clearTimeout(handle)
  }, [args.viewport, fitView, nodes.length, positions, setViewport, sourceNodes])

  const onNodeClick = useCallback<NonNullable<ReactProps<typeof ReactFlow>["onNodeClick"]>>(
    (event, node) => {
      setSelectedEdgeId(null)
      if (event.button !== 0) {
        return
      }
      const data = node.data as FlowNodeData
      if (data.plain) {
        return
      }
      emit({ type: "click", id: node.id, payload: data.payload || {} })
    },
    [],
  )

  const openAt = useCallback(
    (
      event: { clientX: number; clientY: number; preventDefault: () => void },
      rows: MenuRow[],
      nodeId: string,
      payload: Record<string, unknown>,
    ) => {
      event.preventDefault()
      if (rows.length === 0) {
        onMenu(null)
        return
      }
      onMenu({
        x: event.clientX,
        y: event.clientY,
        rows,
        nodeId,
        payload,
        open: [],
        chart: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        viewport: getViewport(),
      })
    },
    [getViewport, onMenu, screenToFlowPosition],
  )

  const onNodeContextMenu = useCallback<
    NonNullable<ReactProps<typeof ReactFlow>["onNodeContextMenu"]>
  >((event, node) => {
    event.preventDefault()
    const data = node.data as FlowNodeData
    if (data.plain) {
      return
    }
    openAt(event, parseMenu(data.menu), node.id, data.payload || {})
  }, [openAt])

  const fitToWindow = useCallback(() => {
    fitView({ padding: 0.15, minZoom: MIN_ZOOM, duration: 200 })
  }, [fitView])

  const resetFilters = useCallback(() => {
    setExcluded({})
    setSearch({})
    onMenu(null)
  }, [onMenu])

  const toggleFilter = useCallback(
    (field: string, value: string, checked: boolean) => {
      setExcluded((current) => {
        const next = new Set(current[field] || [])
        if (checked) {
          next.delete(value)
        } else {
          next.add(value)
        }
        return { ...current, [field]: [...next] }
      })
      onMenu(null)
    },
    [onMenu],
  )

  const setFieldExcluded = useCallback(
    (field: string, values: string[]) => {
      setExcluded((current) => ({ ...current, [field]: values }))
      onMenu(null)
    },
    [onMenu],
  )

  const onConnect = useCallback<NonNullable<ReactProps<typeof ReactFlow>["onConnect"]>>(
    (connection) => {
      const parent = connection.source || ""
      const child = connection.target || ""
      if (!parent || !child || parent === child) {
        return
      }
      if (tree && parentIsUnderChild(parent, child, sourceEdges)) {
        return
      }
      if (tree) {
        const current = sourceEdges.find((edge) => edge.target === child)
        if (current && current.source === parent) {
          return
        }
      } else if (sourceEdges.some((edge) => edge.source === parent && edge.target === child)) {
        return
      }
      emit({
        type: tree ? "reparent" : "connect",
        id: child,
        payload: { parent },
        viewport: getViewport(),
      })
    },
    [getViewport, sourceEdges, tree],
  )

  const isValidConnection = useCallback<
    NonNullable<ReactProps<typeof ReactFlow>["isValidConnection"]>
  >(
    (connection) => {
      const parent = connection.source || ""
      const child = connection.target || ""
      if (!parent || !child || parent === child) {
        return false
      }
      return !tree || !parentIsUnderChild(parent, child, sourceEdges)
    },
    [sourceEdges, tree],
  )

  const onNodeDragStart = useCallback(() => {
    dragLive.current = true
  }, [])

  const onNodeDragStop = useCallback<
    NonNullable<ReactProps<typeof ReactFlow>["onNodeDragStop"]>
  >((_, node) => {
    dragLive.current = false
    const next: Record<string, Point> = {}
    for (const item of getNodes()) {
      next[item.id] = { x: item.position.x, y: item.position.y }
    }
    next[node.id] = { x: node.position.x, y: node.position.y }
    setPositions(next)
    emit({ type: "drag", id: node.id, payload: {}, positions: next })
  }, [getNodes])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }
      const edge = edges.find((item) => item.id === selectedEdgeId)
      if (!edge) {
        return
      }
      event.preventDefault()
      emit({ type: "detach", id: edge.target, payload: {}, viewport: getViewport() })
      setSelectedEdgeId(null)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [edges, getViewport, selectedEdgeId])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => {
        onMenu(null)
        setSelectedEdgeId(null)
      }}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onPaneContextMenu={(event) => openAt(event, parseMenu(args.pane_menu), "", {})}
      nodesConnectable
      edgesReconnectable={false}
      deleteKeyCode={null}
      selectionOnDrag={false}
      panOnScroll
      minZoom={MIN_ZOOM}
      proOptions={{ hideAttribution: false }}
    >
      <Background color="transparent" gap={24} />
      <Panel position="top-left" className="flow-tools nopan nodrag nowheel">
        <button type="button" className="flow-fit" onClick={fitToWindow}>
          Fit to window
        </button>
        {filterFields.length > 0 ? (
          <div className="flow-filters">
            <div className="flow-filters-bar">
              <button
                type="button"
                className="flow-filter-toggle"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {filtersOpen ? "▼" : "▶"} Filters
              </button>
              <button
                type="button"
                className="flow-icon-button"
                title="Reset All Filters"
                aria-label="Reset All Filters"
                onClick={resetFilters}
              >
                🔄️
              </button>
            </div>
            {filtersOpen ? (
              <div className="flow-filter-fields">
                {filterFields.map((field) => {
                  const open = Boolean(fieldsOpen[field.key])
                  const query = (search[field.key] || "").toLowerCase()
                  const hidden = new Set(excluded[field.key] || [])
                  const visible = field.options.filter((option) => {
                    return (
                      option.label.toLowerCase().includes(query) ||
                      option.value.toLowerCase().includes(query)
                    )
                  })
                  return (
                    <div className="flow-filter-field" key={field.key}>
                      <button
                        type="button"
                        className="flow-filter-toggle"
                        onClick={() =>
                          setFieldsOpen((current) => ({
                            ...current,
                            [field.key]: !current[field.key],
                          }))
                        }
                      >
                        {open ? "▼" : "▶"} {field.label}
                      </button>
                      {open ? (
                        <>
                          <div className="flow-filter-search-row">
                            <input
                              className="flow-filter-search"
                              type="text"
                              value={search[field.key] || ""}
                              aria-label={`Find ${field.label}`}
                              onChange={(event) => {
                                const value = event.target.value
                                setSearch((current) => ({ ...current, [field.key]: value }))
                              }}
                            />
                            <button
                              type="button"
                              className="flow-icon-button"
                              title="Deselect All"
                              aria-label="Deselect All"
                              onClick={() =>
                                setFieldExcluded(
                                  field.key,
                                  field.options.map((option) => option.value),
                                )
                              }
                            >
                              ❌
                            </button>
                            <button
                              type="button"
                              className="flow-icon-button"
                              title="Select All"
                              aria-label="Select All"
                              onClick={() => setFieldExcluded(field.key, [])}
                            >
                              ✅
                            </button>
                          </div>
                          {visible.map((option) => (
                            <label className="flow-filter-option" key={option.value}>
                              <input
                                type="checkbox"
                                checked={!hidden.has(option.value)}
                                onChange={(event) =>
                                  toggleFilter(field.key, option.value, event.target.checked)
                                }
                              />
                              <span>{option.label}</span>
                            </label>
                          ))}
                        </>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </Panel>
      <MiniMap
        position="top-right"
        pannable
        zoomable
        style={{ width: 240, height: 180 }}
        bgColor="#f8fafc"
        nodeColor={(node) => {
          const data = node.data as FlowNodeData
          if (data.plain) {
            return MINIMAP_MUTED
          }
          if (data.matched) {
            return MINIMAP_MATCH
          }
          return nodeHasIssue(node) ? MINIMAP_ISSUE : MINIMAP_NODE
        }}
        nodeStrokeColor={(node) => {
          const data = node.data as FlowNodeData
          if (data.plain || !nodeHasIssue(node)) {
            return "transparent"
          }
          return MINIMAP_ISSUE_BORDER
        }}
        nodeComponent={FlowMiniMapNode}
        maskColor="rgba(15, 23, 42, 0.45)"
        maskStrokeColor="#2563eb"
        maskStrokeWidth={2}
      />
    </ReactFlow>
  )
}

export default function FlowApp(props: ComponentProps) {
  const args = (props.args || {}) as FlowArgs
  const theme = props.theme
  const fit = Boolean(args.fit)
  const height = Number(args.height || 620)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (fit) {
      return
    }
    Streamlit.setFrameHeight(height)
  }, [fit, height])

  useEffect(() => {
    setMenu(null)
  }, [args.nodes, args.edges])

  useEffect(() => {
    if (!menu) {
      return
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target && menuRef.current?.contains(target)) {
        return
      }
      setMenu(null)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenu(null)
      }
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [menu])

  const style = {
    height: fit ? "100%" : height,
    ["--flow-text" as string]: theme?.textColor || "inherit",
    ["--flow-card" as string]: theme?.secondaryBackgroundColor || "#ffffff",
    ["--flow-font" as string]: theme?.font || "inherit",
    background: "transparent",
  }

  function emitMenu(
    path: string[],
    row: MenuRow,
    button: string,
    values: Record<string, string>,
  ) {
    if (!menu || row.disabled) {
      return
    }
    emit({
      type: "menu",
      id: menu.nodeId,
      payload: menu.payload,
      path,
      button,
      values,
      position: menu.chart,
      viewport: menu.viewport,
      data: row.data,
    })
    setMenu(null)
  }

  return (
    <div className="flow-shell" style={style}>
      <ReactFlowProvider>
        <Canvas args={args} onMenu={setMenu} />
      </ReactFlowProvider>
      {menu ? (
        <div ref={menuRef}>
          <MenuPanels
            menu={menu}
            onOpen={(path) =>
              setMenu((current) => (current ? { ...current, open: path } : current))
            }
            onAction={(path, row) => emitMenu(path, row, "", {})}
            onSubmit={(path, row, button, values) => emitMenu(path, row, button, values)}
          />
        </div>
      ) : null}
    </div>
  )
}

