# ⚡ BESS Optimizer

**Battery Energy Storage System Sizing & Financial Optimizer**

[![CI](https://github.com/mlaysam/bess-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/mlaysam/bess-optimizer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mlaysam/bess-optimizer)](https://github.com/mlaysam/bess-optimizer/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-blue)](https://github.com/mlaysam/bess-optimizer/releases/latest)

A free, open-source desktop application for engineers and energy consultants to size BESS systems, model financial viability, and generate professional reports — without spreadsheets or expensive software.

---

## Download

Go to [**Releases**](https://github.com/mlaysam/bess-optimizer/releases/latest):

| Platform | File | Notes |
|----------|------|-------|
| 🪟 Windows | `BESS-Optimizer-x.x.x-Setup.exe` | Installer — Start Menu + Desktop shortcut |
| 🪟 Windows | `BESS-Optimizer-x.x.x-Portable.exe` | No install — single file, run anywhere |
| 🐧 Linux | `BESS-Optimizer-x.x.x.deb` | Ubuntu / Debian package |
| 🐧 Linux | `BESS-Optimizer-x.x.x-linux-unpacked.zip` | Any distro — extract and run |
| 🍎 macOS | `BESS-Optimizer-x.x.x.dmg` | Intel x64 + Apple Silicon arm64 |

### Windows
Double-click `Setup.exe` and follow the installer, or run `Portable.exe` directly.

### Linux
```bash
# .deb — Ubuntu / Debian
sudo dpkg -i BESS-Optimizer-*.deb
bess-optimizer

# Unpacked — any distro
unzip BESS-Optimizer-*-linux-unpacked.zip
./linux-unpacked/bess-optimizer
```

### macOS
1. Open `BESS-Optimizer-*.dmg`
2. Drag **BESS Optimizer** → **Applications**
3. **First launch**: right-click the app → **Open** → **Open**
   *(This bypasses Gatekeeper for unsigned apps — only needed once)*

---

## Features

### 01 · Project
- Project name, client, location, engineer, date, and scope

### 02 · Data & Config
- **Hourly** resolution — 8,760 time steps/year for high-accuracy sizing
- **Daily** resolution — 365 time steps/year for fast initial estimates
- Input: built-in sample data · CSV upload · manual entry
- Technical: max sweep capacity, charge/discharge efficiency, initial SOC
- Financial: CAPEX, tariff, O&M, WACC, degradation model, replacement

### 03 · Simulation
- Monthly energy flow charts: PV→Load, PV→BESS, BESS→Load, Grid, Curtailed
- BESS State of Charge (SOC) profile
- Metrics: self-sufficiency %, PV utilization %, annual grid import, curtailment
- Degradation + annual cash flow overlay chart

### 04 · Financial Optimization
- Sweeps 0 → max capacity to find the **NPV-optimal BESS size**
- Full degradation model: calendar aging + cycle aging
- Automatic or user-defined battery replacement year
- Metrics: **NPV**, **IRR**, **Payback Period**, **LCOS** ($/kWh dispatched)

### 05 · Data Export
- Native OS save dialog — works on all three platforms
- Full CSV: every hourly or daily period with all energy flows + grid cost

### 06 · Report
- Native OS save dialog → HTML report
- Open in browser → Print → Save as PDF

---

## Build from Source

### Requirements
- Node.js v18+ — https://nodejs.org
- Python 3 (icon generation — stdlib only, no pip)

### Linux
```bash
git clone https://github.com/mlaysam/bess-optimizer.git
cd bess-optimizer
./setup.sh

npm run dev             # dev mode
npm run dist:linux      # → dist-electron/
```

### Windows
```bat
git clone https://github.com/mlaysam/bess-optimizer.git
cd bess-optimizer
setup.bat

npm run dev
npm run dist:win        :: → dist-electron\
```

### macOS
```bash
git clone https://github.com/mlaysam/bess-optimizer.git
cd bess-optimizer
# Double-click setup.command  OR:
./setup.sh

npm run dev
npm run dist:mac        # → dist-electron/
```

---

## Automated Releases

Push a version tag → GitHub Actions builds all three platforms automatically:

```bash
git tag v1.0.1
git push origin v1.0.1
# Builds Linux + Windows + macOS and publishes the Release page
```

---
## Roadmap

- [ ] Computations in python
- [ ] Time-of-use (TOU) tariff — peak/off-peak pricing
- [ ] Demand charge modelling
- [ ] Feed-in tariff / grid export revenue
- [ ] Multi-year input datasets

---

## Contributing

```bash
git clone https://github.com/mlaysam/bess-optimizer.git
cd bess-optimizer && npm install && python3 make_icon.py
npm run dev
```

Open an issue before starting large changes. See [CHANGELOG.md](CHANGELOG.md).

---

## Disclaimer

For engineering estimation only. Validate all sizing decisions with qualified engineers before procurement or construction. The authors accept no liability for decisions made using this software.

---

## License

[MIT](LICENSE) — free to use, modify, distribute. Commercial use permitted.

---

## References

- [NREL Battery Cost Report](https://www.nrel.gov/docs/fy24osti/88461.pdf)
- [IRENA Renewable Power Costs](https://www.irena.org/Publications/2023/Aug/Renewable-Power-Generation-Costs-in-2022)
- [Lazard LCOE+](https://www.lazard.com/research-insights/levelized-cost-of-energyplus/)
- [BNEF Battery Price Survey](https://about.bnef.com/blog/battery-pack-prices-hit-record-low-of-139-kwh/)
- [IEA Electricity Market Report](https://www.iea.org/reports/electricity-market-report-2024)
- [Battery University — Cycle Life](https://batteryuniversity.com/article/bu-808-how-to-prolong-lithium-based-batteries)
- [Nature — Battery Degradation](https://www.nature.com/articles/s41560-021-00827-4)
