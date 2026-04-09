#!/usr/bin/env bash
set -e
echo "══════════════════════════════════════════════"
echo "  BESS Optimizer — Linux / macOS Setup"
echo "══════════════════════════════════════════════"

command -v node >/dev/null 2>&1 || {
  echo "❌ Node.js not found — install from https://nodejs.org (v18+)"
  exit 1
}
MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
[ "$MAJOR" -ge 18 ] || { echo "❌ Node.js $MAJOR — need v18+"; exit 1; }
echo "✓ Node.js $(node --version)  |  npm $(npm --version)"

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "🎨 Generating icons..."
python3 make_icon.py

echo ""
echo "══════════════════════════════════════════════"
echo "  Ready! Run one of:"
echo ""
echo "  npm run dev           dev mode (live reload)"
echo ""
if [[ "$OSTYPE" == "darwin"* ]]; then
echo "  npm run dist:mac      build macOS .dmg"
echo ""
echo "  After build:"
echo "    open dist-electron/BESS-Optimizer-*.dmg"
else
echo "  npm run dist:linux    build .deb + unpacked dir"
echo ""
echo "  After build:"
echo "    sudo dpkg -i dist-electron/BESS-Optimizer-*.deb"
echo "    bess-optimizer"
echo "    ── or ──"
echo "    ./dist-electron/linux-unpacked/bess-optimizer"
fi
echo "══════════════════════════════════════════════"
