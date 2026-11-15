"""Generate web/src/lib/generated/abis.ts from Foundry artifacts (run via `./tw.sh abis`).

Keeps the frontend's ABIs byte-for-byte in sync with the deployed Solidity, typed `as const`
so wagmi/viem infer argument and return types.
"""

import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
out = root / "contracts" / "out"
targets = {
    "parallaxExecutorAbi": "ParallaxExecutor.sol/ParallaxExecutor.json",
    "parallaxReactiveAbi": "ParallaxReactive.sol/ParallaxReactive.json",
    "poolSwapTestAbi": "PoolSwapTest.sol/PoolSwapTest.json",
    "mockErc20Abi": "MockERC20.sol/MockERC20.json",
    "parallaxVaultAbi": "ParallaxVault.sol/ParallaxVault.json",
    "parallaxVaultReactiveAbi": "ParallaxVaultReactive.sol/ParallaxVaultReactive.json",
}

lines = ["// AUTO-GENERATED from Foundry artifacts by `./tw.sh abis`. Do not edit by hand.", ""]
for name, rel in targets.items():
    abi = json.loads((out / rel).read_text(encoding="utf-8"))["abi"]
    lines.append(f"export const {name} = {json.dumps(abi, indent=2)} as const;")
    lines.append("")

dest = root / "web" / "src" / "lib" / "generated" / "abis.ts"
dest.write_text("\n".join(lines), encoding="utf-8", newline="\n")
print(f"wrote {dest.relative_to(root)}")
