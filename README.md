# AgentGuard

Wrap OpenAI `chat.completions.create` with in-memory usage tracking, spend limits, and breach callbacks. Helps prevent runaway costs when building agents or LLM-powered apps.

> **Status:** Work in progress. We're actively improving AgentGuard and would love your feedback, bug reports, and contributions. See [Get in touch](#get-in-touch) below.

---

## Setup

### Prerequisites

- **Node.js** 18+ (or 20+ recommended)
- **npm** (or pnpm / yarn)
- An **OpenAI API key** (for running the demos or using the wrapper)

### Install from GitHub

```bash
npm install github:satyashah/AgentGuard
```

You also need the OpenAI SDK (peer dependency):

```bash
npm install openai
```

### Install in this repo (development)

```bash
git clone https://github.com/satyashah/AgentGuard.git
cd AgentGuard
npm install
npm run build
```

---

## Quick start

1. **Create a guard** with your limits and windows:

```ts
import OpenAI from "openai";
import { InMemoryGuard, wrapOpenAI } from "agentguard";

const guard = new InMemoryGuard({
  windowMs: 15 * 60_000,        // reporting window (e.g. 15 min)
  baselineWindowMs: 60_000,      // baseline for spike detection (e.g. 1 min)
  shortWindowMs: 60_000,        // short window for spend rate (e.g. 1 min)
  maxCostPerRequest: 0.05,      // max USD per single request
  maxSpendPerMinute: 0.5,       // max USD per minute (rolling)
  mode: "block",                // "warn" | "block"
  latchOnBreach: true,          // once breached, block all future requests
  onBreach: (b) => console.log("Breach:", b),
});
guard.startConsoleReporter();   // optional: periodic status to console
```

2. **Wrap your OpenAI client** and use it as usual:

```ts
const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  guard,
  tags: { app: "my-app" },      // optional: for attribution in reports
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hi" }],
  max_tokens: 50,
});
```

All usage is metered; if a limit is exceeded, the guard can warn or block (and optionally latch so further requests throw until you reset).

---

## Demos (this repo)

After cloning and `npm install`:

```bash
# Set your OpenAI key
export OPENAI_API_KEY=your-key   # Linux/macOS
# or: set OPENAI_API_KEY=your-key   (Windows CMD)

# Simple one-request demo
npx tsx demos/setup-demo.ts

# Demo that hits limits (multiple requests until breach)
npx tsx demos/break-demo.ts
```

---

## Development

```bash
npm install
npm run build    # compile src/ to dist/
npm run demo     # run demo (see package.json script)
```

- Source lives in `src/` (types, pricing, guard, OpenAI wrapper).
- Root `agentguard.ts` re-exports from `src/` for local and published use.

---

## Get in touch

AgentGuard is a work in progress. We’d love to hear from you if you:

- Hit bugs or have ideas for fixes
- Want new features or integrations
- Are interested in contributing

**Ways to connect:**

- **LinkedIn:** [Reach out to me on LinkedIn](https://www.linkedin.com/in/satya-shah-founder/) to discuss fixes, additions, or collaboration.

<!-- 
- **Schedule a call:** [Book a short meeting](https://calendly.com/satyashah) to talk through your use case or how you’d like to contribute. *(Replace this link with your actual Calendly or meeting URL.)*
-->

Contributions are welcome—whether it’s opening an issue, suggesting docs improvements, or sending a pull request.

---

## License

MIT
