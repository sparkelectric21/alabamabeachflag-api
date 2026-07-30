# Water temperature and Fort Morgan tides

## Water-temperature selection

The public beach-condition refresh evaluates approved sources in beach priority order. It selects the first fresh direct observation, skipping a delayed preferred source when a lower-priority source is fresh. A delayed observation is returned only when every approved current source fails. Values are never averaged across inlet, nearshore, bay-entrance, and offshore environments.

Active hierarchy:

- Gulf Shores card (`gulf-shores-public-beach`): PPTA1, then NOAA NDBC 42012, then DISL/NDBC Sofar 42357.
- Orange Beach card (`cotton-bayou`): PPTA1, then NOAA NDBC 42012, then DISL/NDBC Sofar 42357.
- Fort Morgan card (`fort-morgan-public-beach`): DPHA1, then DISL/NDBC Sofar 42357, then NOAA NDBC 42012.
- Dauphin Island card (`dauphin-island-public-beach`): NOAA CO-OPS 8735180, then DISL/NDBC Sofar 42357, then DPHA1.

Other beach records retain their existing source hierarchies.

Gulf State Park Pier hydrographic data is standby/disabled until a current machine-readable `WTMP` feed is confirmed. West End CP is disabled until its feed returns and is stable. NOAA station 8734383 has no water-temperature sensor and is prohibited. Upper-Mobile-Bay PORTS stations are not eligible substitutes.

NGOFS2 is a modeled NOAA fallback candidate, but remains disabled: a stable official extraction, completed-cycle test, grid/land-mask validation, and per-beach grid-point review have not yet been completed. Open-Meteo is not used for water temperature.

NDBC parsing scans response rows newest-first and selects the newest row containing a finite plausible `WTMP`; a newer wind or wave row with missing `WTMP` does not change temperature time. `observedAt` is the temperature observation time. `ingestedAt` is backend selection time. They must not be interchanged.

Fresh/current and hard-unavailable thresholds:

| Source | Fresh through | Unavailable after |
| --- | ---: | ---: |
| 42012 | 60 min | 180 min |
| PPTA1 | 90 min | 180 min |
| DPHA1 | 90 min | 180 min |
| 42357 | 120 min | 240 min |
| 8735180 | 30 min | 90 min |

The selected API value includes station identity, environment, observation age, thresholds, ingestion time, observed/model status, and a selection reason. Provider Health retains the aggregate selection domain; source failures and skip reasons are emitted as structured provider diagnostics.

## Fort Morgan tide curve

NOAA station 8734635 is a subordinate prediction station. Its official NOAA high and low events remain authoritative and are preserved separately in `events`.

When at least two chronological, alternating official extrema are available, the backend generates display-only 15-minute points with cosine interpolation between each adjacent event. Every segment is monotonic, cannot overshoot its two endpoints, and passes exactly through official event times and heights. The API labels this `curveMethod: "fittedFromHighLow"`. NOAA interval series use `"noaaInterval"`; incomplete events use `"eventOnly"`.

Generated points are not observations or additional NOAA extrema. The iOS detail sheet explains the fitted curve and continues to render official event markers independently. All NOAA local times are converted using `America/Chicago`, including daylight-saving folds, before interpolation.
