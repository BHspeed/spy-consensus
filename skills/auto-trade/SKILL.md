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

## Two kinds of pass

- **FULL pass** — the default (hourly Routine, or when you say "Run Auto Trades").
  Screen → enter → manage. Do every step below, including Step 9 (seed the
  15-min manage passes).
- **MANAGE pass** — the 15-minute risk heartbeat. The fire prompt says **"MANAGE
  pass"**. Only checks stops / trailing / the daily breaker on *open* positions —
  **no screening, no new entries**. Do Steps 0–3, then 5–8 with the `--manage`
  flag, and **skip** Step 4 (regime/screen) and Step 9. This keeps a rapid
  re-fire safe: it can only ever tighten risk, never open a duplicate position.

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

**Regime (always compute):** fetch SPY's current price, prior close, and 10-day
EMA (`get_equity_quotes` + `get_equity_technical_indicators` ema period 10 day).
Put them in the bundle as `spy: { price, priorClose, ema }` — the harness runs
the deterministic assessor (green + at/above the 10-day EMA = risk-on).

**SPY call-out (confirming signal):** also compute the repo's SPY direction
consensus and pass it as `spyConsensus: { bias, confidence, score }`. Pull ~60
SPY daily bars + ~2 weeks of hourly (`get_equity_historicals`) and run
`buildVerdict` (src/consensus/engine.js) — or reuse the latest `outbox` SPY
call-out. The harness folds it in: a **bearish** call-out (bias DOWN/STRONG_DOWN)
forces risk-off even on a green day; bullish/neutral passes through. Risk-off ⇒
no new entries (exits still managed).

**Options (only if `config.options.enabled`):** on a **strong** bullish call-out
you may route one slice into a single-leg long call per `config.options`
(level-2 account). Off by default — at ~$100 a SPY contract is unaffordable.

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
`spy:{price,priorClose,ema}` and `spyConsensus:{bias,confidence}` (from Step 4;
the harness derives `regime` from them),
`account:{equity,buyingPower}`, `state` (from Step 1),
`brokerPositions`, `quotes`, `candidates`.

Run: `node scripts/trade_cycle.mjs data/cycle_bundle.json --json`
(On a **MANAGE pass**, add `--manage` and the bundle needs only `now`, `today`,
`marketOpen`, `account`, `state`, `brokerPositions`, and `quotes` for held names
— no `regime`/`candidates`.)

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

## Step 8b — SPY reversal snipe (ALWAYS active, every pass)

The snipe runs **even when the share book is halted** (`config.snipe.alwaysActive`)
— it's a separate defined-risk scalp. Guardrails: at most `snipe.maxPerDay`
snipes/day, and STOP sniping for the day once cumulative snipe losses reach
`snipe.maxDailyLossUsd` (track `snipeCount`/`snipeLossToday` in state).

**Manage an OPEN snipe first** (by its option MARK, via
`consensus/valueFlip.decideExit(entryPremium, marks, {config: cfg.snipe.exit})`,
where `marks = [entryPremium, peakPremium, currentMark]`):
- It TRAILS the peak — a real pop keeps running and banks on the flip; it does
  NOT hard-cut a small dip. Sell-to-close only on TAKE_PROFIT / STOP_OUT.
- Update `peakPremium = max(peakPremium, currentMark)` every pass.
- 0-DTE: also force-close by ~15:40 ET.

**Look for a NEW snipe** (only if none open, under the daily caps): pull ~6 recent
SPY 5-min closes + SPY-below-10d-EMA, call `detectReversal(closes, belowEma, cfg)`.
If `signal`:
1. Pull the SPY call chain for the nearest `snipe.dte`.
2. `selectOption({direction:'long', underlying:'SPY', chain, buyingPower, equity}, {...cfg, options: cfg.snipe})`.
3. `review_option_order` → `place_option_order` (buy-to-open, fresh ref_id); record it in state.options.
No reversal → wait. Never snipe a still-falling tape (the detector enforces this).

## Step 9 — Seed the 15-min manage passes (FULL pass only)

To get a 15-minute risk cadence between the hourly full cycles, after a FULL
pass, if the **market is open**, it's **before ~3:55 PM ET**, and you **hold at
least one open position**, schedule three MANAGE passes into this session using
the `send_later` tool (claude-code-remote) at **+15, +30, +45 minutes**, each
with a message beginning:

> "Auto-trade MANAGE pass (15-min risk check) — real money, account 521158774.
> Invoke the auto-trade skill as a MANAGE pass: check stops/trailing/daily-stop
> on open positions only, place any exits, persist + report. No new entries."

Skip this on a MANAGE pass (they don't re-seed — the next hourly FULL pass
re-seeds), and skip if flat/halted (nothing to manage). This keeps exactly one
full + three manage passes per hour — no runaway chains.

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
