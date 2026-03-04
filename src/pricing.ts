/**
 * Minimal pricing table and cost computation.
 * Users can override via wrapOpenAI(..., { priceTable: { ... } }).
 *
 * NOTE: Default numbers are placeholders; update as needed.
 */

import type { PriceTable } from "./types.js";

export const DEFAULT_PRICES: PriceTable = {
  "gpt-4o-mini": { inPer1k: 0.00015, outPer1k: 0.0006 },
};

/** Base model name (e.g. gpt-4o-mini-2024-07-18 -> gpt-4o-mini) for price lookup. */
export function baseModelForPricing(model: string): string {
  const dated = /^(.+)-\d{4}-\d{2}-\d{2}$/;
  const m = model.match(dated);
  return m ? m[1]! : model;
}

export function computeCostUsd(
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
