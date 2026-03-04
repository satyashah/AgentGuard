/**
 * Shared types for AgentGuard: events, config, breaches, and wrap options.
 */

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

  /** Rolling "short window" for spend rate comparisons (e.g., 5 min) */
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

/** Guard shape required by wrapOpenAI (avoids circular dependency on InMemoryGuard). */
export type GuardLike = {
  onEvent(e: UsageEvent): void;
  shouldAllowRequest(): boolean;
};

export type WrapOptions = {
  guard: GuardLike;
  tags?: Tags;
  priceTable?: PriceTable;
  /** Optional: custom event handler (besides guard) */
  onEvent?: (e: UsageEvent) => void;
};
