#!/usr/bin/env bash
# Uso: ./video.sh [salida.mp4]   -> video a 30 fps con las fotos de más vieja a más nueva
cd "$(dirname "$0")"
OUT="${1:-timelapse.mp4}"
ffmpeg -y -framerate 30 -pattern_type glob -i 'fotos/*.jpg' \
  -c:v libx264 -pix_fmt yuv420p -crf 20 "$OUT"
