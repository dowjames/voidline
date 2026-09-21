#!/usr/bin/env bash
# Canonical benchmark entrypoint for the VOIDLINE photorealistic space shooter.
#
# Workload: 1280x720, 24 enemy craft, 320 live projectiles, 2400 particles,
# 6 asteroids, 7000 stars, full post chain (bloom + ACES tone map + lens pass),
# shadows on, one ship-kill explosion every 45 frames.
# Entity counts are held constant by the sim, so every run renders identical load.
#
# Measurement: headless Chrome on the real Metal GPU. Per-frame deltas are forced
# through a readPixels GPU sync, because Chrome's gl.finish() does not actually
# block across the GPU process boundary (verified: identical samples at 720p and
# 1080p with finish, correctly scaled with readPixels).
#
# Primary metric: frame_ms (median; lower is better).
#
# Reproducibility: this is real host GPU time, so concurrent GPU users (a browser
# tab showing this very game, video playback, another benchmark) inflate it ~4x.
# Close competing GPU users before trusting a number. Validated back-to-back
# spread on an idle M2 Pro: 7.4 / 7.5 / 7.6 ms.
set -euo pipefail
cd "$(dirname "$0")"

node build.mjs >/dev/null

exec node bench/driver.mjs \
  --mode synced \
  --width 1280 --height 720 \
  --warmup 120 --measure 240 \
  --metrics
