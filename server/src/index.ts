import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { api, apiErrorHandler } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5174);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api", api);
app.use("/api", apiErrorHandler);

// In production, serve the built web app (web/dist) and SPA-fallback to index.html.
const webDist = path.resolve(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`[gitwebui] server listening on http://localhost:${PORT}`);
});
