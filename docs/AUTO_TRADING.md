# Robinhood Auto-Trading

An unattended, rules-based equity auto-trader for the agentic Robinhood **cash**
account. The risk logic lives in deterministic, unit-tested code; a scheduled
agent runs one *cycle* on a fixed cadence, feeding live data to the planner and
placing exactly the orders it returns.

> **This trades real money.** Read the whole doc, especially *Safety* and
> *Cash-account constraints*, before arming it.

## The rules (as configured)

| Rule | Setting | Where |
|------|---------|-------|
| Daily account stop | Down **3%** on the day → flatten everything + halt new entries until next session | `config.daily.stopPct` |
| Per-position initial stop | **3%** high-cap / **5%** low-priced below entry | `config.risk.initialStopPct` |
| Trail trigger | Once a position is up **>3%**, arm a trailing stop | `config.risk.trailArmPct` |
| Trailing distance | Trail **3%** below the running peak, ratchets up only | `config.risk.trailPct` |
| Break-even lock | Once peak gain ≥ **5%**, the stop never drops below entry | `config.risk.lockBreakevenAfterPct` |
| Reentry | After a stop-out, re-enter when the screen re-confirms, after a **30-min** cooldown, max **2×/symbol/day** | `config.reentry` |
| Universe | Auto-screened mix: **high-cap** (fractional shares) + **low-priced $1.50–$15** (whole shares), momentum-ranked | `config.screen` |
| Sizing | ≤ **5** positions, **60/40** high-cap/low-priced, **5%** cash buffer, **30%** max per position | `config.sizing` |

Everything is a config number in [`src/trading/config.js`](../src/trading/config.js).
Retune there — the engine is fully parameterized.

## How it works

```
┌── scheduled cycle (market hours) ──────────────────────────────────────┐
│ agent gathers live data ─▶ node scripts/trade_cycle.mjs ─▶ order plan   │
│   (Robinhood/Webull MCP)      (deterministic planner)      (SELL→BUY)   │
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

The scheduler fires at most **hourly**, so a Routine runs one cycle per hour of
the regular session — intra-hour moves are unprotected until the next cycle. For
tighter management while you're watching, run cycles by hand (or a short
in-session loop) using the same `SKILL.md` path; it's the same code, just more
often.

## Arming / disarming

**The cycle must run in a session that has the Robinhood (and Webull) MCP
connector tools.** This is the one real constraint on going unattended:

- Scheduled sessions spawned by the CCR trigger tool in this org run **without**
  connector (`mcp__*`) tools, so a cron-fired fresh session **cannot trade** — it
  can't even read the account. (A trigger was attempted during setup and removed
  for exactly this reason.)
- Two ways to actually run cycles, both using the same committed code + `SKILL.md`:
  1. **claude.ai Routines UI (recommended for unattended):** create a recurring
     Routine there, on a session/environment that has the **RobinHood** connector
     enabled, with the prompt "run the auto-trade skill" and a schedule of
     `0 13-21 * * 1-5` UTC (hourly across US regular hours; the skill's Step 0
     gate skips anything outside 09:30–16:00 ET). Because that Routine carries the
     connector, its sessions can place orders.
  2. **Active session (attended / semi-attended):** in a Claude Code session that
     has the RobinHood connector (like the one this was built in), say "run an
     auto-trade cycle" — or loop it (`/loop 60m run an auto-trade cycle`) while the
     session/container stays alive.
- **Disarm (stop all trading):** delete/disable the Routine (or stop the loop).
  Nothing trades once it's gone.
- **Pause for a day:** set `"halted": true` in `data/trading_state.json` (with
  today's `day`) — no new entries until the next day-roll.
- **Flatten now:** ask the agent to sell all positions in `••••8774`.

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
