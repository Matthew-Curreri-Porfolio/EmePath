// gateway/routes/private.js
import { loginUseCase, requireAuth } from "../usecases/auth.js";
import { memoryShortUseCase, memoryLongUseCase, memoryList, memoryGet, memoryDelete } from "../usecases/memory.js";
import { validate } from "../middleware/validate.js";
import { MemoryWriteSchema } from "../validation/schemas.js";

export function registerPrivate(app, deps, { memoryLimiter } = {}) {
  // Auth
  app.post("/auth/login", async (req, res) => {
    await loginUseCase(req, res, deps);
  });

  // Memory short/long CRUD
  app.get("/memory/short", requireAuth, async (req, res) => {
    await memoryList(req, res, "short");
  });
  app.get("/memory/short/:memid", requireAuth, async (req, res) => {
    await memoryGet(req, res, "short");
  });
  app.post("/memory/short", requireAuth, memoryLimiter, validate(MemoryWriteSchema), async (req, res) => {
    await memoryShortUseCase(req, res, deps);
  });
  app.delete("/memory/short/:memid", requireAuth, memoryLimiter, async (req, res) => {
    await memoryDelete(req, res, "short");
  });

  app.get("/memory/long", requireAuth, async (req, res) => {
    await memoryList(req, res, "long");
  });
  app.get("/memory/long/:memid", requireAuth, async (req, res) => {
    await memoryGet(req, res, "long");
  });
  app.post("/memory/long", requireAuth, memoryLimiter, validate(MemoryWriteSchema), async (req, res) => {
    await memoryLongUseCase(req, res, deps);
  });
  app.delete("/memory/long/:memid", requireAuth, memoryLimiter, async (req, res) => {
    await memoryDelete(req, res, "long");
  });
}

export default { registerPrivate };
