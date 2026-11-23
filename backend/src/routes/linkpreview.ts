import type { FastifyInstance } from "fastify";
import { linkPreview } from "../lib/linkpreview.js";

export function attachLinkPreviewRoutes(app: FastifyInstance): void {
  app.get("/api/linkpreview", async (req, reply) => {
    const url = String((req.query as Record<string, unknown> | undefined)?.url ?? "").trim();
    if (!url) return reply.code(400).send({ error: "Missing url parameter" });
    if (url.length > 2048) return reply.code(400).send({ error: "URL too long" });
    const result = await linkPreview(url);
    if (!result) return reply.code(400).send({ error: "Could not preview that URL" });
    return result;
  });
}