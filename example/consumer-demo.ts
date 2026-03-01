/**
 * Consumer demo: use AgentGuard as an installed package.
 *
 * In another repo:
 *   1. npm install github:yourusername/AgentGuard
 *   2. npm install openai tsx
 *   3. Copy this file (or run it with npx tsx example/consumer-demo.ts from the installed package).
 *   4. Set OPENAI_API_KEY and run: npx tsx consumer-demo.ts
 *
 * This file imports from "agentguard" (the package name), not from a local path.
 */

import OpenAI from "openai";
import {
  InMemoryGuard,
  wrapOpenAI,
  type Breach,
  type PriceTable,
} from "agentguard";

function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY in the environment.");
    process.exit(1);
  }

  const priceTable: PriceTable = {
    "gpt-4o-mini": { inPer1k: 0.00015, outPer1k: 0.0006 },
  };

  const guard = new InMemoryGuard({
    windowMs: 15 * 60_000,
    baselineWindowMs: 60_000,
    shortWindowMs: 60_000,
    maxCostPerRequest: 0.05,
    maxSpendPerMinute: 0.5,
    mode: "block",
    latchOnBreach: true,
    onBreach: (b: Breach) => console.log("[Breach]", b.type, b.message),
  });
  guard.startConsoleReporter();

  const client = wrapOpenAI(new OpenAI({ apiKey }), {
    guard,
    tags: { app: "consumer-demo" },
    priceTable,
  });

  (async () => {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello in one sentence." }],
      max_tokens: 50,
    });
    console.log("Response:", res.choices?.[0]?.message?.content ?? "");
    guard.stopConsoleReporter();
  })().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}

main();
