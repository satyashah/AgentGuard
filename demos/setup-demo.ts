/**
 * AgentGuard barebones: all settings, breach callback, one call.
 * Run: npm run demo  or  npx tsx demos/setup-demo.ts
 */

import OpenAI from "openai";
import {
  InMemoryGuard,
  wrapOpenAI,
  type Breach,
  type PriceTable,
} from "../agentguard.js";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY.");
    process.exit(1);
  }

  // Settings: custom pricing + all guard options
  const priceTable: PriceTable = {
    "gpt-4o-mini": { inPer1k: 0.00015, outPer1k: 0.0006 },
  };

  const guard = new InMemoryGuard({
    windowMs: 15 * 60_000,
    baselineWindowMs: 60_000,
    shortWindowMs: 60_000,
    reportEveryMs: 10_000,
    spikeMultiplier: 5,
    maxCostPerRequest: 0.02,
    maxSpendPerMinute: 1,
    mode: "block",
    latchOnBreach: true,
    topContributorKey: "agent",
    onBreach: (b: Breach) => {
      console.log("Breach:", b.type, "-", b.message);
    },
  });

  const client = wrapOpenAI(new OpenAI({ apiKey }), {
    guard,
    tags: { agent: "demo" },
    priceTable,
  });

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Say hello in one sentence." }],
    max_tokens: 50,
  });

  console.log("Response:", resp.choices?.[0]?.message?.content ?? "");
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
