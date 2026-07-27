# Lessons from the owner's live trading (drives the bot's rules)

Analysis of the personal account's realized **options** P&L, trailing ~30 days
(source: Robinhood realized-PnL). These are the empirical reasons the bot's risk
rules are shaped the way they are.

## The data

| Metric | Value |
|---|---|
| Day win rate | **13 of 20 green days (~65%)** |
| Avg green day | +$100 |
| Avg red day | **−$337** (≈ 3.4× the avg green) |
| 3 worst days | −$841, −$556, −$490 = **−$1,887** |
| Month total (options) | **−$1,063** |

Green days summed to **+$1,295**; the three worst red days alone were **−$1,887**.

## The core finding

**The entries are fine — the loss days are the problem.** A high day-win-rate
(~65%) is dragged negative because losing days are ~3.4× bigger than winning
days, and a handful of blow-up days erase weeks of gains. The blow-ups correlate
with **over-trading and sizing up after losses** (e.g. 7/10 was 13 trades / big
size for −$841), not with bad reads.

A single rule — *"cap the daily loss, then walk away"* — flips the month:
−$150/day cap on the three worst days saves ~$1,437 → the month goes from
**−$1,063 to roughly +$390** with the *same entries*.

## What the bot encodes because of this

1. **Daily loss cap is the #1 edge.** `daily.stopPct` (account halt) +
   `snipe.maxDailyLossUsd` + `snipe.maxPerDay`. The bot always obeys the stop;
   a human in the moment does not. This is the bot's real advantage over manual
   trading — not better entries.
2. **No revenge trading / no sizing up on a red day.** `maxPerDay`, and share
   entries halt for the day once the account stop trips.
3. **Let winners run.** The big wins (+$166/+$180/+$185 days) came from runners.
   The snipe exit is value-flip trailing (`snipe.exit`), not a fixed take-profit,
   so a real pop is ridden and banked on the flip.
4. **SPY is the vehicle.** The live edge is SPY intraday scalping → the snipe
   underlying is SPY.
5. **Consistent small size.** Small, uniform position sizes; the account-killers
   were the outsized bets.

## The one-liner

> Your entries win ~65% of days. Your losses come from the *size and frequency*
> on bad days. The bot's job is to make the loss days small and boring —
> that alone turns the record positive.
