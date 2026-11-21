# Test coverage

`forge coverage --ir-minimum --report summary` on `contracts/`, 93 tests (unit + fork tests against live Uniswap v4), run 2026-11-21. CI regenerates it on every push (`.github/workflows/test.yml`).

| File                          | % Lines          | % Statements     | % Branches       | % Funcs        |
| src/ParallaxExecutor.sol      | 92.74% (166/179) | 91.86% (203/221) | 67.86% (38/56)   | 92.31% (24/26) |
| src/ParallaxReactive.sol      | 94.92% (112/118) | 96.64% (144/149) | 93.10% (27/29)   | 90.48% (19/21) |
| src/ParallaxVault.sol         | 94.57% (122/129) | 92.63% (176/190) | 70.59% (24/34)   | 88.24% (15/17) |
| src/ParallaxVaultReactive.sol | 87.50% (63/72)   | 87.50% (91/104)  | 74.29% (26/35)   | 66.67% (6/9)   |
| src/base/V4LiquidityOps.sol   | 97.56% (80/82)   | 95.79% (91/95)   | 81.25% (13/16)   | 93.75% (15/16) |
| src/libraries/PoolMath.sol    | 70.00% (7/10)    | 75.00% (12/16)   | 100.00% (1/1)    | 66.67% (2/3)   |
| src/mocks/MockERC20.sol       | 100.00% (5/5)    | 75.00% (3/4)     | 0.00% (0/1)      | 100.00% (2/2)  |
| Total                         | 93.28% (555/595) | 92.43% (720/779) | 75.00% (129/172) | 88.30% (83/94) |
