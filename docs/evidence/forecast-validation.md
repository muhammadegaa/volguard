# Volatility forecast — walk-forward validation

Reproduce: `npm run backtest` · regenerate this file with the command in its footer.

## What this does and does not show

It measures whether the horizon-matched HAR forecast predicts the next *h* sessions of
realized volatility better than the trailing estimators it replaces, strictly out of sample:
at every origin the model sees only prior bars and is scored against a window it has never
seen.

**It validates the forecast, not trading P&L.** No option prices are involved. We have no
historical implied-volatility series, so the trade leg of the variance risk premium remains
unvalidated.

## Two claims this exercise falsified

Both were made confidently before the measurement existed, and both were wrong:

1. *"Realized vol over 10 days is the honest benchmark, and against it AAPL was expensive by
   6.8 points."* `realized20` and `realized10` are the **worst** predictors in the panel.
   Framing the signal against a short trailing window swaps one badly-calibrated baseline for
   a worse one.
2. *"The variance risk premium is positive 80–85% of the time, so five of six symbols reading
   cheap proves the estimator is broken."* That statistic is a property of implied volatility
   carrying a risk premium. No change to a **realized**-vol estimator can produce it, and
   targeting it would mean tuning until the answer looked right.

The horizon mismatch was still a real defect. The honest claim is narrower: the baseline is
now horizon-matched, and better calibrated out of sample.

## Training window is load-bearing

`har260` is what the app fetched before this change. At the 14-session horizon it is **worse**
than the trailing estimator it was meant to replace. 520 sessions fixes it; 1000 adds nothing.
The shipped forecast blends toward the trailing estimate in proportion to fit quality; that
shrinkage was adopted because it measured better, and it is included in the `har*` rows below.

```
SPY: 753 bars
QQQ: 753 bars
IWM: 753 bars
AAPL: 753 bars
MSFT: 753 bars
NVDA: 753 bars

HAR fits: 7866  ·  fell back to trailing: 0

Out-of-sample forecast accuracy (annualized vol points; lower RMSE/MAE better, higher R² better)

horizon 7 sessions
  method        n     RMSE      MAE     bias       R²
  har260       894    14.12     8.99    -0.45   0.285
  har520       894    13.96     8.75    -0.61   0.296
  har1000      894    13.95     8.74    -0.63   0.297
  bipower20    894    14.87     9.44    -0.06   0.262
  realized20   894    15.46     9.91     1.29   0.247
  → HAR(520) RMSE is 6.1% BETTER than trailing bipower20

horizon 14 sessions
  method        n     RMSE      MAE     bias       R²
  har260       882    13.53     8.56    -0.98   0.306
  har520       882    13.07     8.23    -1.06   0.332
  har1000      882    13.08     8.22    -1.10   0.333
  bipower20    882    13.48     8.69    -1.35   0.325
  realized20   882    14.08     9.21    -0.02   0.298
  → HAR(520) RMSE is 3.0% BETTER than trailing bipower20

horizon 30 sessions
  method        n     RMSE      MAE     bias       R²
  har260       846    11.46     7.70    -1.79   0.387
  har520       846    11.37     7.66    -1.56   0.396
  har1000      846    11.36     7.66    -1.61   0.397
  bipower20    846    12.63     8.52    -1.94   0.339
  realized20   846    13.35     9.01    -0.60   0.302
  → HAR(520) RMSE is 10.0% BETTER than trailing bipower20

VERDICT: HAR beat trailing bipower on 3 of 3 horizons by RMSE.
The forecast is an improvement on every horizon tested.
```

Generated 2026-08-20T19:46:22Z by `npm run backtest` against the live Alpaca bar API.
