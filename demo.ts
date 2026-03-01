/**
 * AgentGuard demo: settings, wrapped client, low thresholds, breach hook to stop requests.
 * Run: npm run demo  or  npx tsx demo.ts
 */

import OpenAI from "openai";
import {
  InMemoryGuard,
  wrapOpenAI,
  type Breach,
  type PriceTable,
  type UsageEvent,
} from "./agentguard";

/** Demo settings: custom token costs and spending limits (kept low to trip quickly). */
type DemoSettings = {
  /** Custom token costs per model (USD per 1k input / 1k output). */
  priceTable: PriceTable;
  /** Max spend per minute (USD/min); low so ~3 requests trip it. */
  maxSpendPerMinute: number;
  /** Max cost per single request (USD). */
  maxCostPerRequest: number;
};

function main() {
  console.log("[Step 0] Starting demo.\n");

  // ---------- Step 1: Settings ----------
  console.log("[Step 1] Applying settings (custom token costs + spending limits).");
  const settings: DemoSettings = {
    priceTable: {
      "gpt-4o-mini": { inPer1k: 0.00015, outPer1k: 0.0006 },
    },
    maxSpendPerMinute: 0.000012, // ~3 requests (~$0.0000135) exceed this, then spend_rate breach
    maxCostPerRequest: 0.02,
  };
  console.log("  priceTable (custom token costs):", JSON.stringify(settings.priceTable, null, 2));
  console.log("  maxSpendPerMinute (USD/min):", settings.maxSpendPerMinute);
  console.log("  maxCostPerRequest (USD):", settings.maxCostPerRequest);
  console.log("");

  // ---------- Breach hook: flag + callback ----------
  let breached = false;
  const setBreached = () => {
    breached = true;
    console.log("[Breach hook] Flag set: threshold passed, requests will stop.\n");
  };

  // ---------- Step 2: Create guard with settings ----------
  console.log("[Step 2] Creating guard with above settings and breach callback.");
  const guard = new InMemoryGuard({
    windowMs: 15 * 60_000,
    baselineWindowMs: 60_000, // same as short so spike doesn't fire on cold start
    shortWindowMs: 60_000, // 1 min for per-minute rate
    reportEveryMs: 10_000,
    maxCostPerRequest: settings.maxCostPerRequest,
    maxSpendPerMinute: settings.maxSpendPerMinute,
    mode: "block",
    latchOnBreach: true,
    topContributorKey: "agent",
    onBreach: (b: Breach) => {
      console.log("[Guard] BREACH:", b.type, "-", b.message);
      const unit = b.type === "spend_rate" ? " USD/min" : " USD";
      if ("current" in b && b.current !== undefined) console.log("  current:", b.current.toFixed(6) + unit);
      if ("threshold" in b && b.threshold !== undefined) console.log("  threshold:", b.threshold.toFixed(6) + unit);
      if (b.type === "spike" && "baseline" in b) console.log("  baseline:", b.baseline.toFixed(6), "USD/min  multiplier:", b.multiplier.toFixed(1) + "x");
      if ("topTags" in b && b.topTags && Object.keys(b.topTags).length) console.log("  topTags:", b.topTags);
      setBreached();
    },
  });
  guard.startConsoleReporter();
  console.log("  Guard created; console reporter started.\n");

  // ---------- Step 3: Wrap OpenAI client ----------
  console.log("[Step 3] Wrapping OpenAI client with guard and custom price table.");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY. Set it in the environment or .env.");
    process.exit(1);
  }
  const base = new OpenAI({ apiKey });
  const client = wrapOpenAI(base, {
    guard,
    tags: { agent: "demo-bot", route: "/demo" },
    priceTable: settings.priceTable,
    onEvent: (e: UsageEvent) => {
      console.log("  [Event] costUsd:", e.costUsd ?? "?", "model:", e.model, "tokens:", e.inputTokens, "/", e.outputTokens);
    },
  });
  console.log("  Client wrapped. All requests will be metered and limited.\n");

  // ---------- Step 4: Make requests until threshold or limit ----------
  console.log("[Step 4] Sending requests until spend exceeds threshold (then stop via breach hook).");
  const maxRequests = 20;
  let requestCount = 0;

  (async () => {
    for (let i = 0; i < maxRequests; i++) {
      console.log(`[Step 4] Request ${i + 1}/${maxRequests} - checking guard before call...`);
      if (guard.isBlocked()) {
        console.log(`[Step 4] Guard is blocked (breach latched). Stopping requests.\n`);
        break;
      }
      try {
        const resp = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Reply in one short sentence." },
            { role: "user", content: `Say hello ${i}.` },
          ],
          max_tokens: 50,
        });
        requestCount++;
        const text = resp.choices?.[0]?.message?.content ?? "";
        console.log(`[Step 4] Request ${i + 1} done. Response preview: "${text.slice(0, 40).replace(/\s+/g, " ")}..."`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[Step 4] Request ${i + 1} threw: ${msg}`);
        if (guard.isBlocked()) {
          console.log("[Step 4] Guard blocked this request (threshold exceeded). Stopping.\n");
          break;
        }
        throw err;
      }
      if (breached) {
        console.log("[Step 4] Breach flag is set; stopping after this batch.\n");
        break;
      }
    }
    guard.stopConsoleReporter();
    console.log(`[Done] Finished. Total requests completed: ${requestCount}. Breach flag: ${breached}. Guard blocked: ${guard.isBlocked()}.`);
  })().catch((e) => {
    console.error("Demo error:", e?.message ?? e);
    process.exit(1);
  });
}

main();
