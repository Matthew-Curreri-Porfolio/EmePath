import express from "express";
import cors from "cors";
import { log, getTimeoutMs, escapeRe, scanDirectory } from "./utils.js";
import { OLLAMA, MODEL, MOCK, VERBOSE, LOG_BODY } from "./config.js";
import { getIndex, setIndex } from "./state.js";
import registerRoutes from "./routes/index.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

// Register all routes
registerRoutes(app, {
  log,
  getTimeoutMs,
  escapeRe,
  scanDirectory,
  OLLAMA,
  MODEL,
  MOCK,
  VERBOSE,
  LOG_BODY,
  getIndex,
  setIndex,
});

app.listen(3030, () => log({ event: "boot", msg: "gateway listening", url: "http://127.0.0.1:3030" }));
