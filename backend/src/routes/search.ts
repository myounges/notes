import type { FastifyInstance } from "fastify";
import { searchNotes } from "../storage/index.js";

export function attachSearchRoutes(app: FastifyInstance): void {
  app.get("/api/search", async (req) => {
    const q = (req.query as Record<string, string | undefined>).q ?? "";
    const limit = Math.min(Math.max(Number((req.query as Record<string, string | undefined>).limit ?? 20) || 20, 1), 100);
    const offset = Math.max(Number((req.query as Record<string, string | undefined>).offset ?? 0) || 0, 0);
    if (!q.trim()) return { q, results: [], total: 0 };
    const { results, total } = await searchNotes(q, { limit, offset });
    return { q, results, total };
  });
}