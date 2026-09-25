import type { FastifyInstance } from "fastify";
import { listModels } from "../config/index.js";
export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async (_request, reply) => {
    const models = listModels();
    reply.status(200).send(models);
  });
}
