---
name: auto-trade
description: Run one Robinhood auto-trading cycle — screen, manage stops/trailing, enforce the daily 3% halt, and place the exact orders the deterministic planner returns. Invoked by the market-hours schedule or manually. Trigger phrases include "Run Auto Trades", "run auto trade cycle", "start auto trading", "run the auto trader". Robinhood-only, real money.
---

# Auto-Trade Cycle (Robinhood, agentic cash account)

You are the **hands**, not the brain. All risk decisions are made by the
deterministic planner in `src/trading/` — you gather live data, run the planner,
and execute **exactly** the actions it returns. Do not improvise entries, stops,
or sizes. Do not skip the planner.

- **Account (the only tradeable one):** `521158774` — agentic-enabled **cash**
  account, options level 2. Never trade any other account.
- **Strategy (encoded in `src/trading/config.js`):** concentrated momentum
  rotation over a curated liquid universe — **core** (megacaps) + **amp**
  (leveraged ETFs), all fractional. Daily 3% account stop → flatten + halt;
  per-position stop 3% core / 7% amp; trailing stop arms/ratchets per tier;
  new entries only when the market is **risk-on**; reentry after a cooldown;
  deploy settled cash only (cash-account GFV guard).

## Step 0 — Gate: is the regular session open?

Get the current ET time. The strategy trades **regular hours only (09:30–16:00
ET, Mon–Fri, not a market holiday)**. If closed, run Step 1–2 to refresh state
(so stops stay tracked) with `marketOpen:false`, persist state, and **stop** —
place no orders.

## Step 1 — Load persisted state

Read `data/trading_state.json` (git-tracked). If it doesn't exist, use `{}` —
the planner treats that as a fresh first run.

## Step 2 — Pull the broker snapshot (Robinhood MCP)

Call in parallel:
- `get_portfolio` (account `521158774`) → `equity = total_value`,
  `buyingPower = buying_power.buying_power` (this **is** the settled, deployable
  cash in a cash account — the GFV guard depends on it).
- `get_equity_positions` (account `521158774`) → for each position build
  `{ symbol, shares: quantity, avgPrice: average_buy_price, tier }`. Use
  `shares_available_for_sells` when deciding sell quantities.
  (tier: carry it from saved state; if unknown infer from price/market cap.)

## Step 3 — Quotes for everything held

`get_equity_quotes` for all held symbols → `quotes[SYMBOL] = last_trade_price`.

## Step 4 — Market regime (always) + screen the curated universe

**Regime (always compute):** read SPY and QQQ — are they above their 20-day EMA
and green on the day? Set `regime = { riskOn: <bool>, reason: "<why>" }`. Use
Robinhood `get_equity_technical_indicators` / `get_equity_historicals`. Risk-off
⇒ the planner takes no new entries (it still manages exits).

**Screen (only if you may add positions):** skip if already at `maxPositions` or
no settled cash. Otherwise, the universe is **fixed and curated** — the lists in
`config.screen.universe` (`core` megacaps + `amp` leveraged ETFs). Do NOT invent
tickers; only these are tradeable. For each symbol in the universe:

- `price` and `dayChangePct` (intraday % change) — Robinhood `get_equity_quotes`
  (batch).
- `avgDollarVol` (avg volume × price) — from quotes / `get_equity_historicals`.
- `trendScore` in [-1..+1] — a short-term trend read (e.g. price vs 20-EMA
  sign/magnitude) from `get_equity_technical_indicators`.

Pass the whole curated universe as `candidates`; the planner's screener applies
the momentum + uptrend gates and ranks by relative strength. Add each candidate's
price into `quotes` too.

## Step 5 — Run the planner (the decision)

Write a bundle to `data/cycle_bundle.json` with **all** of:
`now` (epoch ms), `today` (ET YYYY-MM-DD), `marketOpen`,
`regime:{riskOn,reason}` (from Step 4),
`account:{equity,buyingPower}`, `state` (from Step 1),
`brokerPositions`, `quotes`, `candidates`.

Run: `node scripts/trade_cycle.mjs data/cycle_bundle.json --json`

The output gives `actions` (ordered SELL→BUY), `nextState`, `dailyStop`,
`halted`, `notes`. **This is the plan. Execute it verbatim.**

## Step 6 — Execute the actions (in the returned order)

Because the owner chose **unattended** operation, you may skip `review_*` and go
straight to `place_equity_order`. Still send a fresh `ref_id` (UUID) per order.
All actions are **fractional market** orders (`orderType:market`):

- **SELL:** `place_equity_order` side=sell, type=market, quantity=shares,
  market_hours=regular_hours.
- **BUY:** side=buy, type=market, quantity=shares (fractional ok),
  market_hours=regular_hours.

Run **all SELLs before any BUY**. If a SELL is rejected, still place the others
and note it. Never place an order the planner did not return.

## Step 7 — Persist + log

1. Write `nextState` back to `data/trading_state.json`.
2. Append a one-line JSON record to `data/trade_cycles.jsonl`:
   `{ts, today, equity, buyingPower, dailyStop, halted, actions, orderResults, notes}`.
   (Both live under `data/` — `logs/` is git-ignored and would not survive a
   container restart; `data/` is tracked.)
3. Commit both to the working branch:
   `git add data/trading_state.json data/trade_cycles.jsonl && git commit -m "trade cycle <today> <HH:MM ET>"` and push. This is the audit trail and the only durable state across container restarts. `data/cycle_bundle.json` is transient input — don't commit it.

## Step 8 — Report

Write one short summary: equity, daily drawdown vs the 3% limit, halted?, orders
placed (with fills/rejections), and current open positions with their stops. If
the daily stop tripped, say so plainly.

Post it to the Discord channel (BEST-EFFORT — never let this block or fail the
cycle): `node scripts/notify_discord.mjs --title "Auto-trade <today> <HH:MM ET>" --file <summary.txt>`.
If it exits non-zero (e.g. `403 Host not in allowlist` — discord.com isn't in the
environment's egress policy, or `DISCORD_WEBHOOK_URL` is unset), just note "Discord
unreachable" and carry on — the git-committed `data/trade_cycles.jsonl` is the
durable record regardless.

## Hard safety rails (always, even unattended)

- **Only** account `521158774`. **Only** `place_equity_order` actions that came
  from the planner output this cycle.
- If `get_portfolio`/`get_equity_positions` fails, **do not trade** — log and stop.
- If a quote is missing for a held name, the planner holds it (stop unchanged) —
  don't force a sell.
- Never deploy more than the planner sized (it already enforces the 5% cash
  buffer, 30% per-position cap, and settled-cash-only GFV guard).
- Options: this system trades **equities only**. Do not place option orders.
- If anything is ambiguous or an unexpected error occurs, stop and surface it
  rather than guessing.
