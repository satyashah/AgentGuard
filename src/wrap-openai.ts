/**
 * Wraps OpenAI chat.completions.create with usage tracking and guard enforcement.
 * Non-streaming only; streaming would need separate handling.
 */

import OpenAI from "openai";
import { computeCostUsd, DEFAULT_PRICES } from "./pricing.js";
import type { UsageEvent, WrapOptions } from "./types.js";

export function wrapOpenAI<T extends OpenAI>(client: T, opts: WrapOptions): T {
  const guard = opts.guard;
  const tags = opts.tags;
  const priceTable = opts.priceTable ?? DEFAULT_PRICES;

  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = (async (...args: any[]) => {
    if (!guard.shouldAllowRequest()) {
      throw new Error("AgentGuard: blocked (spend rate exceeded)");
    }

    const start = Date.now();
    try {
      const resp = await (originalCreate as (...a: unknown[]) => Promise<unknown>)(...args);

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
