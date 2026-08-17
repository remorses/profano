---
'profano': minor
---

Accept Chrome Performance **Save profile** traces (`Trace-*.json`) with no convert step.

The Performance panel writes Chromium trace JSON, not a V8 `.cpuprofile`. Pass that file to profano the same way you pass a CPU profile:

```bash
profano ~/Downloads/Trace-20260817T115835.json --sort total
```

Profano extracts `Profile` / `ProfileChunk` / `CpuProfile` samples, prefers the page main thread (`CrRendererMain`), and keeps time monotonic when Chrome emits negative deltas.

Printed source lines are now **1-based** (editors and humans). Protocol values stay 0-based internally.
