import { createRoot } from "react-dom/client"
import { withStreamlitConnection } from "streamlit-component-lib"
import "@xyflow/react/dist/style.css"
import FlowApp from "./FlowApp"

const Connected = withStreamlitConnection(FlowApp)
const root = document.getElementById("root")
if (root) {
  createRoot(root).render(<Connected />)
}
