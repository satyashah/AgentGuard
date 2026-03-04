/**
 * In-memory guard: tracks usage events, enforces limits, detects spikes, and reports.
 */

import type { Breach, GuardConfig, Tags, UsageEvent } from "./types.js";

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

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

  private prune() {
    const now = Date.now();
    const keepFrom = now - Math.max(this.cfg.windowMs, this.cfg.baselineWindowMs) - 5_000;
    let i = 0;
    while (i < this.events.length && this.events[i].ts < keepFrom) i++;
    if (i > 0) this.events.splice(0, i);
  }

  private sumCost(fromTs: number, toTs: number): number {
    let sum = 0;
    for (const e of this.events) {
      if (e.ts < fromTs) continue;
      if (e.ts > toTs) break;
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
