# Contributing

Contributions are welcome. Keep changes focused, preserve exact JSON tokens on every ordinary
formatting path, and include a deterministic regression test.

```bash
npm install
npm run check
npm run benchmark
```

Performance changes should include at least five identical runs, medians, tail observations,
correctness results, input fixtures, runtime versions, and the exact command boundary.
