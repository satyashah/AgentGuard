# AgentGuard

Wrap OpenAI `chat.completions.create` with in-memory usage tracking, spend limits, and breach callbacks. Non-streaming only.

## Install from GitHub

```bash
npm install github:yourusername/AgentGuard
```

Replace `yourusername` with your GitHub username (and `AgentGuard` with the repo name if different).

## Quick usage

```ts
import OpenAI from "openai";
import { InMemoryGuard, wrapOpenAI } from "agentguard";

const guard = new InMemoryGuard({
  windowMs: 15 * 60_000,
  baselineWindowMs: 60_000,
  shortWindowMs: 60_000,
  maxCostPerRequest: 0.05,
  maxSpendPerMinute: 0.5,
  mode: "block",
  latchOnBreach: true,
  onBreach: (b) => console.log("Breach:", b),
});
guard.startConsoleReporter();

const base = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = wrapOpenAI(base, { guard, tags: { app: "my-app" } });

// Use client as normal; usage is metered and limited
const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hi" }],
  max_tokens: 50,
});
```

See [example/consumer-demo.ts](example/consumer-demo.ts) for a full runnable demo you can copy into another project after installing.

### Test install from another repo

```bash
mkdir test-agentguard && cd test-agentguard
npm init -y
npm install github:yourusername/AgentGuard openai tsx
```

Copy `node_modules/agentguard/example/consumer-demo.ts` into the project (or create a file that imports from `agentguard` and wraps one request). Then:

```bash
set OPENAI_API_KEY=your-key
npx tsx consumer-demo.ts
```

## Development (this repo)

```bash
npm install
npm run build   # compile to dist/
npm run demo    # run in-repo demo (uses ./agentguard)
```

## License

MIT
