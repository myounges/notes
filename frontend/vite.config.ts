import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API + attachments to the backend on :8082.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8082",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-codemirror": [
            "@codemirror/view",
            "@codemirror/state",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/lang-markdown",
            "@uiw/codemirror-themes",
          ],
          "vendor-markdown-it": ["markdown-it"],
        },
      },
    },
  },
});