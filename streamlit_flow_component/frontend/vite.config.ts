import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 3001,
    strictPort: true,
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
})
