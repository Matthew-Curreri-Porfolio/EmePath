import { z } from "zod";

export const ChatSchema = z.object({
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  messages: z.array(z.object({
    role: z.enum(["system","user","assistant"]),
    content: z.string().min(1)
  })).min(1)
});

export const CompleteSchema = z.object({
  language: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  path: z.string().optional(),
  cursor: z.any().optional(),
  budgetMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const ScanSchema = z.object({
  root: z.string().min(1),
  maxFileSize: z.number().int().positive().max(2_000_000).optional()
});

export const QuerySchema = z.object({
  q: z.string().min(1),
  k: z.number().int().positive().max(50).optional()
});

export const WarmupSchema = z.object({
  model: z.string().min(1),
  keepAlive: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const MemoryWriteSchema = z.object({
  memid: z.string().min(1).optional(),
  content: z.string().default(""),
  mode: z.enum(["set","append","clear"]).default("set"),
  separator: z.string().max(2).optional()
});

export const TrainingPutSchema = z.object({
  trainid: z.string().min(1).optional(),
  data: z.record(z.any())
});

export const TrainingPatchSchema = z.object({
  data: z.record(z.any())
});

export const TrainingBuildSchema = z.object({
  includeShort: z.boolean().optional(),
  includeLong: z.boolean().optional(),
  tags: z.array(z.string()).optional()
});

export const CompressionSchema = z.object({
  model: z.string().optional(),
  keepAlive: z.string().optional(),
  maxSummaryChars: z.number().int().positive().max(200000).default(8000),
  chatHistory: z.string().optional()  // optional raw chat to distill; if omitted we synthesize from memory
});


export const OptimizeHwSchema = z.object({
  model: z.string().min(1),
  deep: z.boolean().optional(),
  quick: z.boolean().optional(),
  scope: z.enum(["machine","user"]).optional()
});

// Whoogle search (GET) — supports either `q` or `query`, optional `num`/`n`, and tuning params
export const WhoogleSearchSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Answer (GET) — synthesize a direct answer with citations
export const AnswerSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(8).optional(),
    f: z.coerce.number().int().positive().max(8).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(1024).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Active Answer (GET) — answer with follow-up self-queries
export const ActiveAnswerSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    // base discovery
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(8).optional(),
    f: z.coerce.number().int().positive().max(8).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(1024).optional(),
    // follow-up planning
    k: z.coerce.number().int().positive().max(5).optional(),
    iterations: z.coerce.number().int().positive().max(3).optional(),
    perFollowupNum: z.coerce.number().int().positive().max(8).optional(),
    perFollowupFetchNum: z.coerce.number().int().positive().max(4).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Research (GET) — builds on whoogle, plus fetch/crawl knobs
export const ResearchSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    // discovery
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    // crawl
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    f: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    timeoutMs: z.coerce.number().int().positive().max(30000).optional(),
    maxChars: z.coerce.number().int().positive().max(200000).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Insights (GET) — structured insight synthesis from web/local/hybrid
export const InsightsSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    mode: z.enum(["web", "local", "hybrid"]).optional(),
    // web discovery
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    f: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    // local
    localK: z.coerce.number().int().positive().max(20).optional(),
    // answer formatting
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(2048).optional(),
    // comparison support (comma-separated string or repeated query params handled in route)
    compare: z.string().optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Insights Graph (GET) — knowledge graph extraction (nodes/edges)
export const InsightsGraphSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    mode: z.enum(["web", "local", "hybrid"]).optional(),
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    f: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    localK: z.coerce.number().int().positive().max(20).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(2048).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Debate (GET) — multi-agent structured debate over evidence
export const DebateSchema = z
  .object({
    q: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    mode: z.enum(["web", "local", "hybrid"]).optional(),
    useInsights: z.coerce.boolean().optional(),
    rounds: z.coerce.number().int().positive().max(4).optional(),
    trace: z.coerce.boolean().optional(),
    // discovery knobs when useInsights=true
    num: z.coerce.number().int().positive().max(20).optional(),
    n: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    f: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    c: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    localK: z.coerce.number().int().positive().max(20).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(2048).optional(),
  })
  .refine((d) => Boolean(d.q || d.query), {
    message: "q or query is required",
    path: ["q"],
  });

// Plan (POST) — generate a safe, verifiable runbook
export const PlanSchema = z
  .object({
    query: z.string().min(1),
    target: z.enum(["shell","code","research","general"]).optional(),
    mode: z.enum(["web","local","hybrid"]).optional(),
    constraints: z.string().optional(),
    envOs: z.enum(["linux","macos","windows"]).optional(),
    risk: z.enum(["low","medium","high"]).optional(),
    maxSteps: z.coerce.number().int().positive().max(30).optional(),
    // discovery knobs when mode!=local
    num: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    localK: z.coerce.number().int().positive().max(20).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(2048).optional(),
  });

// Train Loop (POST) — orchestrated self-training cycle
export const TrainLoopSchema = z
  .object({
    topic: z.string().min(1),
    mode: z.enum(["web","local","hybrid"]).optional(),
    iterations: z.coerce.number().int().positive().max(10).optional(),
    perIter: z.coerce.number().int().positive().max(10).optional(),
    difficulty: z.enum(["easy","medium","hard","insane"]).optional(),
    persist: z.coerce.boolean().optional(),
    userId: z.coerce.number().int().optional(),
    workspaceId: z.string().optional(),
    // discovery knobs
    num: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    localK: z.coerce.number().int().positive().max(20).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
    maxAnswerTokens: z.coerce.number().int().positive().max(4096).optional(),
    datasetPath: z.string().optional(),
  });

// Forecasting schemas
export const ForecastSeedSchema = z
  .object({
    topic: z.string().min(1),
    count: z.coerce.number().int().positive().max(20).optional(),
    horizonDays: z.coerce.number().int().positive().max(365).optional(),
    mode: z.enum(["web","local","hybrid"]).optional(),
    num: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
    localK: z.coerce.number().int().positive().max(20).optional(),
    maxContextChars: z.coerce.number().int().positive().max(200000).optional(),
  });

export const ForecastResolveSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    num: z.coerce.number().int().positive().max(20).optional(),
    fetchNum: z.coerce.number().int().positive().max(10).optional(),
    concurrency: z.coerce.number().int().positive().max(6).optional(),
    site: z.string().min(1).optional(),
    lang: z.string().min(1).optional(),
    safe: z.coerce.boolean().optional(),
    fresh: z.enum(["h", "d", "w", "m", "y"]).optional(),
  });

export const ForecastListSchema = z
  .object({
    status: z.enum(["open","resolved"]).optional(),
    topic: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  });
