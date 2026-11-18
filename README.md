# GTA VI launch-day Twitch viewers, hour by hour

[![make.fun bounty](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/whatever7410258/makefun-gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/whatever7410258/makefun-gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Entry for [make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour" bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) ($250 in USDC). The program forecasts the concurrent viewers in the Grand Theft Auto VI Twitch category for hours 2–24 of launch day (2026-11-19), as five quantiles (5/25/50/75/95%) per hour, scored by mean pinball loss on the log scale.

## Model

Each case ships the launch-day hourly curves of dozens of past big launches ("comparables"). The forecast uses two anchors for the case's scale:

- **Hour-1 print** — viewers in the first hour of the release day. Noisy for a rolling-midnight launch: hour 1 (00:00–01:00Z) only covers the regions that already unlocked.
- **Pre-launch peak** — the highest hourly viewers in the 24 hours before the release day, from the case's own history. A steadier anchor for launch demand, but only when pre-launch viewership is real (with no early access or pre-release streams it can be tiny).

For each comparable, both log-ratio curves are built (`ln(viewers_h / pre-launch peak)` and `ln(viewers_h / hour-1 print)`). Comparables whose launch-day peak exceeds 20× either anchor are dropped — those are fixed-time global unlocks whose hour-1 print is not a launch level, and their shapes don't transfer to a rolling-midnight launch. Per hour, the forecast quantiles are kernel-weighted empirical quantiles across the remaining comparables, weighting comparables whose anchor level is close to the case's (Gaussian kernel, bandwidth 1 in log space), with the spread shrunk 15% toward the median.

The two anchor forecasts are blended in log space. When the pre-launch peak is at least the hour-1 print, the pre-launch anchor gets 60% weight; when the pre-launch peak is far below the hour-1 print (pre-launch viewership was uninformative), its weight fades toward zero so the forecast tracks the hour-1 anchor instead.

The program never crashes: every case is handled independently, every parse is guarded, and any failure falls back to a flat forecast anchored on the best level available, so a valid output file is always written.

## Practice results

Scored against the four practice cases' actual hourly prints (SullyGnome), mean pinball loss on the log scale:

| case | this entry | house baseline |
| --- | --- | --- |
| p00 Marvel's Wolverine | 0.305 | 0.744 |
| p01 Red Dead Redemption 2 | 0.223 | 0.287 |
| p02 God of War Ragnarök | 0.127 | 0.215 |
| p03 Marvel's Spider-Man 2 | 0.184 | 0.303 |
| **mean** | **0.210** | **0.387** |

## Run

Node 22, standard library only — no dependencies, no network.

```sh
MAKEFUN_INPUT_DIR=<dir with *.in cases> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

Reads every `*.in` case file in the input directory and writes one `<id>.out` per case: `{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, …]}` for hours 2–24.

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=w9y8tk6d&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
