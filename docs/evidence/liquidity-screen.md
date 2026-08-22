# Options-liquidity screen for the tradable universe

Reproduce: `node --env-file=.env.local scripts/screen-liquidity.mjs`

## Why this exists

The risk engine rejects any leg whose relative bid–ask spread exceeds 8%
(`VOLGUARD_MAX_SPREAD_PERCENT`). A symbol whose options rarely clear that gate is not
tradable however well known it is — the agent will analyse it, select a spread, and
then refuse it on liquidity, wasting the scan slot.

Two of the original six symbols were exactly that. AAPL cleared the gate on **47%** of
near-the-money contracts and MSFT on **28%**, which is why runs repeatedly ended
`DATA_UNAVAILABLE: long leg: spread 16.2% > 8.0% limit`. Both were removed.

Measured on the free `indicative` feed the agent itself uses — not a paid OPRA feed,
so these numbers reflect what VolGuard can actually trade.

```
sym    price   contracts  medSpread  %<=8%  tradable
IWM       300       500       2.6%     98%   YES
TSLA      363       434       3.1%     96%   YES
PLTR      180       182       3.9%     94%   YES
NVDA      215       254       3.7%     90%   YES
SLV        63       488       4.0%     89%   YES
TLT        82       500       2.6%     88%   YES
SPY       766       500       3.3%     87%   YES
QQQ       713       500       2.6%     86%   YES
DIA       532       500       5.1%     82%   YES
AMZN      259       298       5.8%     69%   YES
MU        967       500       6.7%     65%   YES
NFLX       80       240       5.8%     65%   YES
GLD       423       500       6.8%     60%   YES
TSM       419       274       8.0%     52%   YES
BAC        62       160       8.6%     48%   
AAPL      309       354       8.3%     47%   
AVGO      368       370       9.6%     42%   
XLE        64       338       9.1%     40%   
MSTR      120       206       9.6%     39%   
META      550       500       9.7%     38%   
AMD       473       500      10.4%     34%   
SOFI       19        98      12.6%     34%   
INTC       90       332       9.8%     33%   
COIN      187       162      14.1%     30%   
CRM       209       146      10.4%     30%   
MSFT      483       500      12.3%     28%   
ORCL      146       266      10.9%     27%   
XLF        57       500      17.5%     27%   
ARM       243       156      11.0%     25%   
HOOD      108       196      13.9%     23%   
UBER       79       212      14.8%     18%   
BA        214       150      14.2%     18%   
GS       1040       500      17.0%     15%   
QCOM      161       126      15.2%     12%   
UNH       390       244      13.3%     11%   
WMT       104       206      17.5%     11%   
RIVN       17        98      28.3%     11%   
JPM       352       238      19.5%     10%   
NKE        41       126      19.4%      9%   
JNJ       270       180      22.8%      9%   
LCID        6        30      43.0%      8%   
CVX       205       144      31.1%      6%   
SMH       560       500      25.3%      6%   
MRK       153       268      19.4%      6%   
COST      947       500      18.3%      6%   
HD        336       230      30.7%      5%   
WFC        84       208      19.6%      5%   
XOM       165       210      21.3%      5%   
SNAP        5        36      24.0%      4%   
GOOGL     345       342      28.8%      4%   
CAT       828       480      23.2%      4%   
PFE        28       146      29.5%      3%   
ADBE      275       202      24.1%      3%   
OXY        61       160      35.9%      2%   
LLY      1255       500      23.7%      2%   
C         132       288      20.1%      1%   
DIS       108       244      32.6%      1%   
GE        348       222      28.9%      1%   
ABNB      187       198      28.8%      1%   
DE        648       288      42.6%      1%   
SBUX      107       260      47.4%      0%   

failed: none

14 of 61 clear the 8% spread gate on a majority of near-the-money contracts.
SHORTLIST: IWM,TSLA,PLTR,NVDA,SLV,TLT,SPY,QQQ,DIA,AMZN,MU,NFLX,GLD,TSM
```

Generated 2026-08-22T14:42:15Z.
