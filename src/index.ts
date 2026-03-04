/**
 * AgentGuard: wrap OpenAI chat completions with in-memory usage tracking,
 * spend limits, and breach callbacks.
 *
 * Run demo: npm run demo  (or: npx tsx demos/break-demo.ts)
 *
 * Notes:
 * - Non-streaming only (streaming needs separate handling).
 * - Pricing table is minimal + overrideable.
 */

export type {
  Breach,
  GuardConfig,
  GuardLike,
  Price,
  PriceTable,
  Tags,
  UsageEvent,
  WrapOptions,
} from "./types.js";
export { InMemoryGuard } from "./guard.js";
export { wrapOpenAI } from "./wrap-openai.js";
export { DEFAULT_PRICES, baseModelForPricing, computeCostUsd } from "./pricing.js";
