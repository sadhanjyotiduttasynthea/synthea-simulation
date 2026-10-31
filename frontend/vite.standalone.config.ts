import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the whole interface into ONE self-contained HTML file (../standalone/Synthea-Simulation.html).
// The file is served by the local compute engine at http://localhost:8000; opened directly from disk it shows
// a start page that waits for the engine and then opens the platform.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { outDir: '../standalone', emptyOutDir: false, assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000, cssCodeSplit: false },
})
