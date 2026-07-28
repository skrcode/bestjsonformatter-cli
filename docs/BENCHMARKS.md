# Reproducible CLI benchmark

This ledger records the exact benchmark that supports the README's bounded performance and
correctness statements. Run it again with:

```bash
npm install
JQ_BIN=/absolute/path/to/jq npm run benchmark
```

## 2026-07-28 baseline

- Machine: Intel Mac, macOS 13.1 (`darwin 22.2.0`, `x64`)
- Runtime: Node.js 24.0.2; Python 3.9.6
- Competitors: Biome 2.5.6, Prettier 3.9.6, jsonc-parser 3.3.1, jq 1.8.2
- Runs: five fresh processes per successful payload and product
- Boundary: identical JSON on stdin until the formatter process exits; stdout discarded
- Conditions: no artificial CPU, network, or filesystem throttling
- Timeout: 15,000 ms per sample; a timed-out size stops rather than hiding an unbounded wait
- Payload: an object containing repeated records with the exact integer `9007199254740993`

The formatters do not all choose identical line wrapping. Each received its normal two-space JSON
formatting path. The comparison measures its real complete CLI journey, not an isolated parser.

### Exactness fixture

```json
{"large":9007199254740993,"decimal":1.2300e-40,"escaped":"\u0061\/b","mode":"first","mode":"second"}
```

| Formatter | Large integer | Number spelling | Escape spelling | Duplicate keys | Fully lossless |
| --- | :---: | :---: | :---: | :---: | :---: |
| Best JSON Formatter 0.2.0 | Yes | Yes | Yes | Yes | **Yes** |
| Biome 2.5.6 | Yes | No | Yes | Yes | No |
| Prettier 3.9.6 | Yes | No | Yes | Yes | No |
| jsonc-parser 3.3.1 | Yes | Yes | Yes | Yes | **Yes** |
| Node 24 `JSON.parse/stringify` | No | No | No | No | No |
| jq 1.8.2 | Yes | No | No | No | No |
| Python 3.9.6 `json.tool` | Yes | No | No | No | No |

### Median and p95

| Formatter | 155 B | 105 KB | 1.07 MB | 5.35 MB |
| --- | ---: | ---: | ---: | ---: |
| Best JSON Formatter | 54 / 58 ms | 76 / 81 ms | 143 / 144 ms | 473 / 487 ms |
| Biome | 58 / 59 ms | 88 / 90 ms | 280 / 282 ms | 1,150 / 1,213 ms |
| Prettier | 120 / 145 ms | 234 / 245 ms | 955 / 983 ms | 3,926 / 3,949 ms |
| jsonc-parser | 63 / 64 ms | 825 / 839 ms | timeout | timeout |
| Native Node, lossy | 47 / 47 ms | 48 / 52 ms | 71 / 74 ms | 152 / 157 ms |
| jq, lossy | 5 / 5 ms | 14 / 16 ms | 105 / 110 ms | 500 / 508 ms |
| Python `json.tool`, lossy | 54 / 62 ms | 65 / 65 ms | 174 / 186 ms | 649 / 654 ms |

Each cell is median / p95. With five samples, p95 is the maximum observation.

### Raw timing samples

| Formatter | 155 B | 105 KB | 1.07 MB | 5.35 MB |
| --- | --- | --- | --- | --- |
| Best JSON Formatter | 54, 53, 58, 53, 55 | 68, 76, 81, 78, 75 | 140, 143, 143, 143, 144 | 473, 461, 476, 448, 487 |
| Biome | 58, 58, 59, 58, 59 | 86, 88, 88, 89, 90 | 280, 280, 279, 282, 281 | 1,154, 1,150, 1,213, 1,144, 1,140 |
| Prettier | 145, 131, 120, 118, 120 | 234, 234, 232, 244, 245 | 955, 983, 929, 978, 938 | 3,926, 3,815, 3,778, 3,932, 3,949 |
| jsonc-parser | 63, 63, 64, 64, 63 | 821, 816, 825, 833, 839 | >15,000 | >15,000 |
| Native Node | 47, 47, 47, 47, 47 | 52, 48, 48, 48, 48 | 74, 71, 71, 72, 70 | 157, 154, 150, 152, 152 |
| jq | 5, 5, 5, 5, 5 | 16, 15, 14, 13, 14 | 108, 105, 102, 104, 110 | 508, 500, 508, 500, 497 |
| Python `json.tool` | 62, 55, 54, 52, 51 | 64, 65, 65, 64, 65 | 174, 173, 180, 186, 174 | 650, 642, 645, 649, 654 |

### Conclusion

Best JSON Formatter was the fastest formatter in this matrix that preserved all tested source
tokens. Native Node, jq, and Python demonstrate the speed available when information may be
discarded; they are shown as useful floors, not equivalent correctness implementations.

The conclusion is deliberately bounded. Hardware, operating system, payload shape, output style,
runtime version, and filesystem behavior can change rankings. Re-run the checked-in harness before
making a new release claim.
