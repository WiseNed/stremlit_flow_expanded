/// <reference types="vite/client" />

declare module "elkjs/lib/elk.bundled.js" {
  type ElkNode = {
    id: string
    width?: number
    height?: number
    x?: number
    y?: number
    children?: ElkNode[]
    layoutOptions?: Record<string, string>
  }
  type ElkEdge = {
    id: string
    sources: string[]
    targets: string[]
  }
  export default class ELK {
    layout(graph: ElkNode & { edges?: ElkEdge[] }): Promise<ElkNode>
  }
}
