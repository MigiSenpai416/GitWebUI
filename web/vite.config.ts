import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the desktop window loads the UI from this dev server for hot
// reload (see desktop/src/main/index.ts); everything else goes over IPC. The
// port is fixed because the main process is pointed at it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
