# Changelog

All notable changes to BESS Optimizer are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026

### Added
- Hourly (8,760 pts) and Daily (365 pts) energy dispatch resolution
- NPV-based financial optimization sweep across BESS capacity range
- Semi-empirical degradation model: calendar aging + cycle aging
- Automatic or user-defined battery replacement year
- Financial metrics: NPV, IRR, payback period, LCOS ($/kWh)
- 6-tab UI: Project · Data & Config · Simulation · Financial Opt. · Data Export · Reportt
- Financial parameter help dialog with definitions, typical values, and references
- Cross-platform builds: Linux (.deb, unpacked), macOS and Windows (installer, portable)
- $ / € currency toggle

---

## Roadmap

### Planned for v1.1.0
- [ ] Computations in python
- [ ] Time-of-use (TOU) tariff support — peak / off-peak pricing
- [ ] Demand charge modelling
- [ ] Feed-in tariff / grid export revenue stream
- [ ] Multi-year input data (not just one representative year)

