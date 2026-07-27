# Robinhood Auto-Trading

An unattended, rules-based equity auto-trader for the agentic Robinhood **cash**
account. The risk logic lives in deterministic, unit-tested code; a scheduled
agent runs one *cycle* on a fixed cadence, feeding live data to the planner and
placing exactly the orders it returns.

> **This trades real money.** Read the whole doc, especially *Safety* and
> *Cash-account constraints*, before arming it.

## Strategy (built to compete on return %)

A **concentrated momentum / relative-strength rotation** over a curated, *liquid*
universe — it is deliberately **not** a diversified index. The goal is to
out-return a human account, so it takes the structural edges a small agentic
account actually has and avoids the mistakes that quietly bleed one out:

- **Only liquid names.** At $100 the bid/ask spread *is* your P&L, so the
  universe is a hand-picked list of megacaps + liquid leveraged ETFs — no
  penny-stock spread tax, no single-name blow-ups.
- **Leverage from ETFs, not options.** The "amp" tier is 2–3x index/sector ETFs
  (TQQQ, SOXL, …) bought **fractionally** — tight spreads, no expiry, no theta
  bleed. (Options at $100 would be one contract of pure decay.)
- **Concentration.** ≤3 positions so a winner actually moves the needle.
- **Regime gate.** New longs only when the broad market is risk-on — the #1
  small-account killer is buying momentum into a falling tape.
- **Ride winners, cut losers fast.** Volatility-scaled trailing stops let
  winners run; tight initial stops + the daily 3% breaker cap the downside.

## The rules (as configured)

| Rule | Setting | Where |
|------|---------|-------|
| Daily account stop | Down **3%** on the day → flatten everything + halt new entries until next session | `config.daily.stopPct` |
| Per-position initial stop | **3%** core / **7%** amp below entry (amp is ~3x as volatile) | `config.risk.initialStopPct` |
| Trail trigger | Up **>3%** core / **>5%** amp → arm a trailing stop | `config.risk.trailArmPct` |
| Trailing distance | **3%** core / **6%** amp below the running peak, ratchets up only | `config.risk.trailPct` |
| Break-even lock | Peak gain ≥ **5%** core / **9%** amp → stop never drops below entry | `config.risk.lockBreakevenAfterPct` |
| Reentry | After a stop-out, re-enter when it re-ranks as a buy, after a **45-min** cooldown, max **2×/symbol/day** | `config.reentry` |
| Universe | Curated & liquid: **core** = megacap leaders, **amp** = leveraged ETFs; all fractional, momentum-ranked | `config.screen.universe` |
| Regime | New longs only when the broad market is **risk-on** | `config.screen.requireRiskOn` |
| Sizing | ≤ **3** positions, **50/50** core/amp, **5%** cash buffer, **40%** max per position | `config.sizing` |

Everything is a config number in [`src/trading/config.js`](../src/trading/config.js).
Retune there — the engine is fully parameterized. **This is a strategy, not a
guarantee: it's designed to maximize the competitive edge under these
constraints, but no strategy promises alpha.**

## How it works

```
┌── scheduled cycle (market hours) ──────────────────────────────────────┐
│ agent gathers live data ─▶ node scripts/trade_cycle.mjs ─▶ order plan   │
│   (Robinhood MCP)             (deterministic planner)      (SELL→BUY)   │
│                                        │                                │
│ agent places EXACTLY the returned orders ◀──────────────┘              │
│ agent persists nextState + logs + commits (audit trail)               │
└────────────────────────────────────────────────────────────────────────┘
```

- **Brain (deterministic, tested):** `src/trading/`
  - `config.js` — all tunables.
  - `riskEngine.js` — initial stop, trailing ratchet, exit decision, daily stop, reentry gate.
  - `screener.js` — filter + rank high-cap/low-priced candidates.
  - `sizing.js` — allocate settled cash across the tier mix.
  - `state.js` — day-roll, broker↔engine reconciliation, stop-out records.
  - `planner.js` — one cycle: exits before entries, daily breaker, next state.
- **Hands (the agent):** [`skills/auto-trade/SKILL.md`](../skills/auto-trade/SKILL.md) — the exact per-cycle procedure.
- **Harness / preview:** `node scripts/trade_cycle.mjs <bundle.json>` (or `--demo`).
- **State:** `data/trading_state.json` (git-tracked — durable across container restarts).
- **Audit log:** `data/trade_cycles.jsonl` (one line per cycle).

The agent never decides stops or sizes; it executes the planner's output verbatim.
Risk math has no LLM in the loop.

## Account

Only one account is agentic-tradeable and it is the only one this system touches:

- `••••8774` — **cash**, individual, nickname "Agentic", options level 2, `agentic_allowed=true`.

The other accounts (main margin, both IRAs, the managed account) are **not**
accessible to this agent and must never be traded here.

## Cash-account constraints (important)

This is a **cash** account, which shapes the design:

- **Settled cash only.** Sale proceeds settle **T+1**. Buying with unsettled
  proceeds and then selling before they settle is a **Good Faith Violation
  (GFV)**; 3 GFVs in 12 months restricts the account. The sizer only deploys the
  broker's `buying_power` (the settled, tradeable figure), so a stop-out's
  proceeds aren't redeployed until they settle. This deliberately throttles
  same-day reentry — that's the GFV guard working, not a bug.
- **No shorting, no margin.** Long equity only.
- **Fractional shares are market-only, RTH-only.** High-cap positions are
  fractional, so they enter/exit as **market** orders in regular hours. Robinhood
  has **no resting stop orders on fractional shares** — so stops are
  **engine-managed (synthetic)**: each cycle compares the live price to the stored
  stop and sells when breached.

## Synthetic stops & gap risk (know this)

Stops are enforced **only when a cycle runs**. Between cycles — and overnight —
price can gap through a stop with no protection. Mitigations: positions are
small, cycles run through the session, and the daily 3% breaker caps the worst
day. **Do not treat this as a hard broker stop.** Tighter protection needs a
faster cadence (see *Cadence*) or native whole-share stop orders.

## Cadence

The durable Routine scheduler floors at **hourly**, so we layer two pass types
for a **15-minute risk cadence**:

- **FULL pass** (hourly Routine, or "Run Auto Trades"): screen → enter → manage,
  then seeds the manage passes.
- **MANAGE pass** (+15/+30/+45 min, self-scheduled via `send_later`): checks
  stops, ratchets trailing stops, and enforces the daily breaker on open
  positions — **no new entries**, so a rapid re-fire can only tighten risk.

Net: ~4 passes/hour (1 full + 3 manage), re-seeded each hour so a dropped manage
pass self-heals at the next full cycle. Intra-**15-min** moves (and overnight
gaps) remain unprotected — synthetic stops only act when a pass runs.

## Running it

Just say **"Run Auto Trades"** (or "run an auto-trade cycle" / "start auto
trading") in a session that has the **Robinhood** connector — that invokes the
`auto-trade` skill and runs one cycle. Robinhood is the only connector needed;
the strategy uses Robinhood data end-to-end.

**The cycle must run in a session that has the Robinhood MCP connector tools** —
that's the one real constraint on going unattended:

- Scheduled sessions spawned by the CCR trigger tool in this org run **without**
  connector (`mcp__*`) tools, so a cron-fired fresh session **cannot trade**.
- Two ways to actually run cycles, both using the same committed code + `SKILL.md`:
  1. **Session-bound Routine (what's armed now):** a Routine bound to a live
     session that holds the connector, schedule `30 13-20 * * 1-5` UTC (hourly
     across US market hours; the skill's Step 0 gate skips anything outside
     09:30–16:00 ET). If a fire lands without the connector, the skill fails safe
     (reports it, places nothing).
  2. **claude.ai Routines UI (most robust for unattended):** create a recurring
     Routine there with the **RobinHood** connector enabled and the prompt
     "Run Auto Trades". Because it carries the connector through consent, its
     sessions can always place orders.
- **Disarm (stop all trading):** delete/disable the Routine (or stop the loop).
  Nothing trades once it's gone.
- **Pause for a day:** set `"halted": true` in `data/trading_state.json` (with
  today's `day`) — no new entries until the next day-roll.
- **Flatten now:** ask the agent to sell all positions in `••••8774`.

## Reporting to Discord

Each cycle posts its summary to a Discord channel via
`scripts/notify_discord.mjs` (best-effort — a failed post never blocks trading).
Two things must be in place for it to work, both set in the **environment**
config (not the repo):

1. **Egress:** allow `discord.com` in the environment's network policy. Without
   it the post fails `403 Host not in allowlist` and the cycle just logs
   "Discord unreachable" and continues.
2. **Webhook:** set `DISCORD_WEBHOOK_URL` to the channel webhook. It's read from
   the env (preferred) or `data/discord_webhook.txt` (git-ignored — never commit
   the webhook; it's a credential).

Until both are set, the durable record is the git-committed
`data/trade_cycles.jsonl` plus the per-cycle commit on the branch.

## Testing

```
npm run test:trading      # risk engine, screener, sizing, planner (31 tests)
node scripts/trade_cycle.mjs --demo   # preview a cycle with canned data
```

## Retuning

Edit `src/trading/config.js` and re-run `npm run test:trading`. Common knobs:
initial/trailing stop %, `trailArmPct`, `maxPositions`, `tierSplit`, screener
price/market-cap/liquidity floors, reentry cooldown. A per-cycle override can
also be passed as `bundle.config`.
