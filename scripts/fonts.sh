#!/usr/bin/env bash
# Rebuilds site/public/fonts/newsreader.<hash>.woff2 from the pinned upstream source.
# Needs fonttools and brotli; run by hand, since CI and the build never download.
set -euo pipefail

COMMIT=cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155
TTF_SHA=8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1
OFL_SHA=fdfad38143ec470553cae82a1e45320bdd1b9ec70415d37bd0171051d8a4ded8
BASE="https://raw.githubusercontent.com/productiontype/Newsreader/${COMMIT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/site/public/fonts"
CSS="${ROOT}/site/src/styles/settings/fonts.css"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "${BASE}/fonts/variable/ttf/Newsreader%5Bopsz,wght%5D.ttf" -o "${WORK}/source.ttf"
curl -fsSL "${BASE}/OFL.txt" -o "${WORK}/OFL.txt"
echo "${TTF_SHA}  ${WORK}/source.ttf" | sha256sum -c -
echo "${OFL_SHA}  ${WORK}/OFL.txt" | sha256sum -c -

fonttools varLib.instancer "${WORK}/source.ttf" opsz=32 wght=400:700 -q -o "${WORK}/instance.ttf"
# The instancer stamps the clock into head.modified; pin it to head.created so builds repeat.
python3 -I -c 'import sys; from fontTools.ttLib import TTFont; f = TTFont(sys.argv[1], recalcTimestamp=False); f["head"].modified = f["head"].created; f.save(sys.argv[1])' "${WORK}/instance.ttf"
pyftsubset "${WORK}/instance.ttf" \
  --unicodes="U+0020-007E,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+00B7,U+203A,U+2026" \
  --layout-features="tnum,kern,liga" \
  --no-hinting --desubroutinize --no-recalc-timestamp --flavor=woff2 \
  --output-file="${WORK}/newsreader.woff2"
# The name carries the content hash so a long immutable cache header is safe.
NAME="newsreader.$(sha256sum "${WORK}/newsreader.woff2" | cut -c1-8).woff2"
mkdir -p "${DEST}"
rm -f "${DEST}"/newsreader.*.woff2
cp "${WORK}/newsreader.woff2" "${DEST}/${NAME}"
cp "${WORK}/OFL.txt" "${DEST}/OFL.txt"
sed -i -E "s#/fonts/newsreader\\.[0-9a-f]{8}\\.woff2#/fonts/${NAME}#" "${CSS}"
sha256sum "${DEST}/${NAME}"
