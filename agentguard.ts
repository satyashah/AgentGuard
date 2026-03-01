/**
 * agentguard-lite-allinone.ts
 *
 * Single-file pre-MVP: wraps OpenAI chat.completions.create, tracks usage in-memory,
 * prints rolling burn + top offenders, and can WARN or BLOCK on breaches.
 *
 * Run demo: npm run demo  (or: npx tsx demo.ts)
 *
 * Notes:
 * - Non-streaming only (streaming needs separate handling).
 * - Pricing table is minimal + overrideable.
 */

import OpenAI from "openai";

/** ---------- Types ---------- */

export type Tags = Record<string, string>;

export type UsageEvent = {
  ts: number;
  provider: "openai";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  tags?: Tags;
};

export type Price = { inPer1k: number; outPer1k: number };
export type PriceTable = Record<string, Price>;

export type Breach =
  | {
      type: "request_cost";
      message: string;
      current: number;
      threshold: number;
      model?: string;
      tags?: Tags;
    }
  | {
      type: "spend_rate";
      message: string;
      current: number; // $/min (short window)
      threshold: number;
      topTags?: Tags;
    }
  | {
      type: "spike";
      message: string;
      current: number; // $/min (short window)
      baseline: number; // $/min (baseline window)
      multiplier: number;
      topTags?: Tags;
    }
  | {
      type: "window_spend";
      message: string;
      current: number; // total USD in window
      threshold: number;
      topTags?: Tags;
    };

export type GuardConfig = {
  /** Recent window kept for reporting/top offenders (e.g., 15 min) */
  windowMs: number;

  /** Baseline window for spike detection (e.g., 60 min) */
  baselineWindowMs: number;

  /** Rolling “short window” for spend rate comparisons (e.g., 5 min) */
  shortWindowMs: number;

  /** Report line interval */
  reportEveryMs?: number;

  /** Spike if short $/min > spikeMultiplier * baseline $/min */
  spikeMultiplier?: number;

  /** Hard max cost per request (USD). Breach triggers warn/block. */
  maxCostPerRequest?: number;

  /** Hard max spend per minute in short window (USD/min). Breach triggers warn/block. */
  maxSpendPerMinute?: number;

  /** warn = emits breach, block = throws on pre-check (and can latch) */
  mode?: "warn" | "block";

  /** Called when a breach is detected */
  onBreach?: (b: Breach) => void;

  /** If true, once breached in block mode, latch and block all future requests */
  latchOnBreach?: boolean;

  /** Used to attribute top contributor */
  topContributorKey?: keyof Tags; // e.g., "agent" | "route" | "tool"
};

export type WrapOptions = {
  guard: InMemoryGuard;
  tags?: Tags;
  priceTable?: PriceTable;
  /** Optional: custom event handler (besides guard) */
  onEvent?: (e: UsageEvent) => void;
};

/** ---------- Minimal pricing ---------- */
/**
 * Keep this tiny for pre-MVP.
 * Users can override via wrapOpenAI(..., { priceTable: { ... } }).
 *
 * NOTE: These numbers are placeholders; update as needed.
 */
const DEFAULT_PRICES: PriceTable = {
  "gpt-4o-mini": { inPer1k: 0.00015, outPer1k: 0.0006 },
};

/** Base model name (e.g. gpt-4o-mini-2024-07-18 -> gpt-4o-mini) for price lookup. */
function baseModelForPricing(model: string): string {
  const dated = /^(.+)-\d{4}-\d{2}-\d{2}$/;
  const m = model.match(dated);
  return m ? m[1]! : model;
}

function computeCostUsd(
  model: string | undefined,
  inTok: number | undefined,
  outTok: number | undefined,
  table: PriceTable
): number | undefined {
  if (!model) return undefined;
  const p = table[model] ?? table[baseModelForPricing(model)];
  if (!p) return undefined;
  return ((inTok ?? 0) / 1000) * p.inPer1k + ((outTok ?? 0) / 1000) * p.outPer1k;
}

/** ---------- In-memory guard ---------- */

export class InMemoryGuard {
  private cfg: Required<
    Pick<
      GuardConfig,
      | "reportEveryMs"
      | "spikeMultiplier"
      | "mode"
      | "latchOnBreach"
      | "topContributorKey"
      | "maxCostPerRequest"
      | "maxSpendPerMinute"
    >
  > &
    Omit<
      GuardConfig,
      | "reportEveryMs"
      | "spikeMultiplier"
      | "mode"
      | "latchOnBreach"
      | "topContributorKey"
      | "maxCostPerRequest"
      | "maxSpendPerMinute"
    > & { onBreach?: (b: Breach) => void };

  private events: UsageEvent[] = [];
  private blocked = false;
  private reporterTimer?: NodeJS.Timeout;

  constructor(cfg: GuardConfig) {
    this.cfg = {
      reportEveryMs: cfg.reportEveryMs ?? 10_000,
      spikeMultiplier: cfg.spikeMultiplier ?? 3,
      mode: cfg.mode ?? "warn",
      latchOnBreach: cfg.latchOnBreach ?? true,
      topContributorKey: cfg.topContributorKey ?? "agent",
      maxCostPerRequest: cfg.maxCostPerRequest ?? Number.POSITIVE_INFINITY,
      maxSpendPerMinute: cfg.maxSpendPerMinute ?? Number.POSITIVE_INFINITY,
      ...cfg,
    };
  }

  /** Whether the guard has latched (blocking all future requests after a breach). */
  isBlocked(): boolean {
    return this.blocked;
  }

  /** Call before making an LLM request if you want blocking to actually stop runaways. */
  shouldAllowRequest(): boolean {
    if (this.cfg.mode !== "block") return true;
    if (this.blocked) return false;

    const now = Date.now();

    // Pre-check spend rate ceiling (short window = per-minute)
    const short = this.sumCost(now - this.cfg.shortWindowMs, now);
    const spendPerMin = short / (this.cfg.shortWindowMs / 60_000);
    if (spendPerMin > this.cfg.maxSpendPerMinute) {
      const breach: Breach = {
        type: "spend_rate",
        message: `GUARD BLOCK: spend/min ${spendPerMin.toFixed(3)} > max ${this.cfg.maxSpendPerMinute.toFixed(
          3
        )}`,
        current: spendPerMin,
        threshold: this.cfg.maxSpendPerMinute,
        topTags: this.topContributor(now - this.cfg.shortWindowMs, now),
      };
      this.emitBreach(breach);
      if (this.cfg.latchOnBreach) this.blocked = true;
      return false;
    }

    return true;
  }

  /** Ingests an event and triggers breach callbacks. */
  onEvent = (e: UsageEvent) => {
    this.events.push(e);
    this.prune();

    // Request cost threshold
    if (e.ok && (e.costUsd ?? 0) > this.cfg.maxCostPerRequest) {
      const breach: Breach = {
        type: "request_cost",
        message: `REQ COST: $${(e.costUsd ?? 0).toFixed(4)} > max $${this.cfg.maxCostPerRequest.toFixed(4)}`,
        current: e.costUsd ?? 0,
        threshold: this.cfg.maxCostPerRequest,
        model: e.model,
        tags: e.tags,
      };
      this.emitBreach(breach);
      if (this.cfg.mode === "block" && this.cfg.latchOnBreach) this.blocked = true;
    }

    // Spend-rate ceiling (post-event)
    {
      const now = Date.now();
      const short = this.sumCost(now - this.cfg.shortWindowMs, now);
      const spendPerMin = short / (this.cfg.shortWindowMs / 60_000);
      if (spendPerMin > this.cfg.maxSpendPerMinute) {
        const breach: Breach = {
          type: "spend_rate",
          message: `SPEND RATE: $/min ${spendPerMin.toFixed(3)} > max ${this.cfg.maxSpendPerMinute.toFixed(3)}`,
          current: spendPerMin,
          threshold: this.cfg.maxSpendPerMinute,
          topTags: this.topContributor(now - this.cfg.shortWindowMs, now),
        };
        this.emitBreach(breach);
        if (this.cfg.mode === "block" && this.cfg.latchOnBreach) this.blocked = true;
      }
    }

    // Spike detection (short vs baseline)
    {
      const now = Date.now();
      const short = this.sumCost(now - this.cfg.shortWindowMs, now);
      const baseline = this.sumCost(now - this.cfg.baselineWindowMs, now);

      const shortPerMin = short / (this.cfg.shortWindowMs / 60_000);
      const baselinePerMin = baseline / (this.cfg.baselineWindowMs / 60_000);

      // Avoid noisy spikes if baseline is near zero
      if (baselinePerMin > 0 && shortPerMin > this.cfg.spikeMultiplier * baselinePerMin) {
        const breach: Breach = {
          type: "spike",
          message: `SPIKE: $/min ${shortPerMin.toFixed(3)} is ${(
            shortPerMin / baselinePerMin
          ).toFixed(1)}x baseline ${baselinePerMin.toFixed(3)}`,
          current: shortPerMin,
          baseline: baselinePerMin,
          multiplier: shortPerMin / baselinePerMin,
          topTags: this.topContributor(now - this.cfg.shortWindowMs, now),
        };
        this.emitBreach(breach);
      }
    }
  };

  /** Start periodic console reports (status line + top offenders). */
  startConsoleReporter() {
    if (this.reporterTimer) return;
    this.reporterTimer = setInterval(() => {
      const snap = this.snapshot();
      console.log(this.formatStatusLine(snap));
      const offenders = snap.topOffenders;
      if (offenders.length) {
        console.log("Top expensive requests (recent):");
        for (const [i, o] of offenders.entries()) {
          const tagStr = o.tags
            ? Object.entries(o.tags)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")
            : "";
          console.log(
            `${String(i + 1).padStart(2, " ")}) $${(o.costUsd ?? 0).toFixed(4)}  in=${o.inputTokens ?? "?"} out=${
              o.outputTokens ?? "?"
            }  ${o.model ?? "?"}  ${tagStr}`
          );
        }
      }
    }, this.cfg.reportEveryMs);
    this.reporterTimer.unref?.();
  }

  stopConsoleReporter() {
    if (this.reporterTimer) clearInterval(this.reporterTimer);
    this.reporterTimer = undefined;
  }

  snapshot() {
    this.prune();
    const now = Date.now();
    const last5 = this.sumCost(now - 5 * 60_000, now);
    const last15 = this.sumCost(now - 15 * 60_000, now);
    const short = this.sumCost(now - this.cfg.shortWindowMs, now);

    const spendPerMin = short / (this.cfg.shortWindowMs / 60_000);
    const forecastPerDay = spendPerMin * 60 * 24;

    const recentEvents = this.events.filter((e) => e.ts >= now - this.cfg.windowMs && e.ok);
    const costs = recentEvents.map((e) => e.costUsd ?? 0).sort((a, b) => a - b);
    const p95 = costs.length ? percentile(costs, 0.95) : 0;

    const topOffenders = [...recentEvents]
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
      .slice(0, 5);

    // Basic spend by model
    const byModel = new Map<string, number>();
    for (const e of recentEvents) {
      const m = e.model ?? "unknown";
      byModel.set(m, (byModel.get(m) ?? 0) + (e.costUsd ?? 0));
    }

    const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      blocked: this.blocked,
      last5Cost: last5,
      last15Cost: last15,
      spendPerMin,
      forecastPerDay,
      p95ReqCost: p95,
      topModel: topModel ? { model: topModel[0], cost: topModel[1] } : undefined,
      topOffenders,
      eventCount: this.events.length,
    };
  }

  /** ---------- Internals ---------- */

  private prune() {
    const now = Date.now();
    const keepFrom = now - Math.max(this.cfg.windowMs, this.cfg.baselineWindowMs) - 5_000;
    // events are appended in time order; drop prefix
    let i = 0;
    while (i < this.events.length && this.events[i].ts < keepFrom) i++;
    if (i > 0) this.events.splice(0, i);
  }

  private sumCost(fromTs: number, toTs: number): number {
    let sum = 0;
    for (const e of this.events) {
      if (e.ts < fromTs) continue;
      if (e.ts > toTs) break; // usually ordered
      if (e.ok) sum += e.costUsd ?? 0;
    }
    return sum;
  }

  private topContributor(fromTs: number, toTs: number): Tags | undefined {
    const key = this.cfg.topContributorKey;
    const acc = new Map<string, number>();

    for (const e of this.events) {
      if (e.ts < fromTs) continue;
      if (e.ts > toTs) break;
      if (!e.ok) continue;
      const v = e.tags?.[key];
      if (!v) continue;
      acc.set(v, (acc.get(v) ?? 0) + (e.costUsd ?? 0));
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return undefined;
    return { [key]: top[0] };
  }

  private emitBreach(b: Breach) {
    if (this.cfg.onBreach) this.cfg.onBreach(b);
    else console.warn(b.message);
  }

  private formatStatusLine(s: ReturnType<InMemoryGuard["snapshot"]>) {
    const parts = [
      `AgentGuard`,
      `blocked=${s.blocked ? "YES" : "no"}`,
      `$/min=${s.spendPerMin.toFixed(3)}`,
      `last5m=$${s.last5Cost.toFixed(3)}`,
      `p95req=$${s.p95ReqCost.toFixed(4)}`,
      `forecast/day=$${s.forecastPerDay.toFixed(0)}`,
    ];
    if (s.topModel) parts.push(`topModel=${s.topModel.model}($${s.topModel.cost.toFixed(3)})`);
    return parts.join(" | ");
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

/** ---------- OpenAI wrapper ---------- */

export function wrapOpenAI<T extends OpenAI>(client: T, opts: WrapOptions): T {
  const guard = opts.guard;
  const tags = opts.tags;
  const priceTable = opts.priceTable ?? DEFAULT_PRICES;

  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = (async (...args: any[]) => {
    // Pre-call block (this is what stops runaway loops)
    if (!guard.shouldAllowRequest()) {
      throw new Error("AgentGuard: blocked (spend rate exceeded)");
    }

    const start = Date.now();
    try {
      const resp = await (originalCreate as (...a: unknown[]) => Promise<unknown>)(...args);

      // Attempt to extract model + usage
      const req = args?.[0] ?? {};
      const model = (resp as any).model ?? req.model;

      const usage = (resp as any).usage ?? {};
      const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
      const outputTokens = usage.completion_tokens ?? usage.output_tokens;

      const e: UsageEvent = {
        ts: Date.now(),
        provider: "openai",
        model,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(model, inputTokens, outputTokens, priceTable),
        latencyMs: Date.now() - start,
        ok: true,
        tags,
      };

      opts.onEvent?.(e);
      guard.onEvent(e);

      return resp;
    } catch (err: any) {
      const e: UsageEvent = {
        ts: Date.now(),
        provider: "openai",
        latencyMs: Date.now() - start,
        ok: false,
        error: err?.message ?? String(err),
        tags,
      };
      opts.onEvent?.(e);
      guard.onEvent(e);
      throw err;
    }
  }) as any;

  return client;
}