#!/usr/bin/env bash
set -euo pipefail

# Convert captured Playwright clips → optimized looping GIFs for the README.
# Default: ffmpeg two-pass palette (small files, no extra deps beyond ffmpeg).
# For maximum quality set GIFSKI=1 (requires `brew install gifski`).
#
# The act clips run ~20s each, so defaults lean toward a small file (the README
# embeds three of them). Bump GIF_WIDTH/GIF_FPS for sharper, heavier GIFs.
# GIF_SPEED>1 tightens dead time (e.g. 1.3 = 30% faster) without dropping frames.
#
#   pnpm --filter @crumb/demos gif
#   GIFSKI=1 pnpm --filter @crumb/demos gif
#   GIF_WIDTH=960 GIF_FPS=15 GIF_SPEED=1.0 pnpm --filter @crumb/demos gif

cd "$(dirname "$0")/.."

CLIPS_DIR="public/clips"
OUT_DIR="../docs/assets/gifs"
FPS="${GIF_FPS:-13}"
WIDTH="${GIF_WIDTH:-820}"
SPEED="${GIF_SPEED:-1.15}"
# setpts factor is the reciprocal of the speed multiplier.
PTS="$(awk "BEGIN{printf \"%.4f\", 1/$SPEED}")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — install it (macOS: brew install ffmpeg)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
shopt -s nullglob
clips=("$CLIPS_DIR"/*.webm)
if [ ${#clips[@]} -eq 0 ]; then
  echo "No clips in $CLIPS_DIR — run \`pnpm --filter @crumb/demos capture\` first." >&2
  exit 1
fi

for f in "${clips[@]}"; do
  name="$(basename "$f" .webm)"
  out="$OUT_DIR/$name.gif"
  echo "→ $out"
  if [ "${GIFSKI:-0}" = "1" ]; then
    tmp="$(mktemp -d)"
    ffmpeg -y -i "$f" -vf "setpts=$PTS*PTS,fps=$FPS,scale=$WIDTH:-1:flags=lanczos" "$tmp/%05d.png" \
      -hide_banner -loglevel error
    gifski --fps "$FPS" --width "$WIDTH" -o "$out" "$tmp"/*.png
    rm -rf "$tmp"
  else
    pal="$(mktemp -t crumbpal).png"
    ffmpeg -y -i "$f" -vf "setpts=$PTS*PTS,fps=$FPS,scale=$WIDTH:-1:flags=lanczos,palettegen=stats_mode=diff" "$pal" \
      -hide_banner -loglevel error
    ffmpeg -y -i "$f" -i "$pal" \
      -lavfi "setpts=$PTS*PTS,fps=$FPS,scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
      "$out" -hide_banner -loglevel error
    rm -f "$pal"
  fi
done

echo "Done → $OUT_DIR"
