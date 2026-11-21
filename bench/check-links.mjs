// Checks that every transaction linked in the docs exists on its chain and succeeded (or, for refusal proofs,
// reverted on purpose).   node check-links.mjs        (or: ./tw.sh check-links)
//
// Scans README.md, deployments/*.md, docs/*.md and results/*.md for explorer links of the form
//   sepolia.basescan.org/tx/<hash> · sepolia.uniscan.xyz/tx/<hash> · lasna.reactscan.net/tx/<hash>
// and asks each chain's public RPC for the receipt. Exits non-zero if any link is missing.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = {
  "sepolia.basescan.org": process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
  "sepolia.uniscan.xyz": process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
  "lasna.reactscan.net": process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/",
};
const files = [
  "README.md",
  ...["deployments", "docs", "results"].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`)),
];

const links = new Map(); // "host hash" -> [files]
for (const f of files) {
  const text = readFileSync(join(ROOT, f), "utf8");
  for (const m of text.matchAll(/https:\/\/(sepolia\.basescan\.org|sepolia\.uniscan\.xyz|lasna\.reactscan\.net)\/tx\/(0x[0-9a-fA-F]{64})/g)) {
    const k = `${m[1]} ${m[2].toLowerCase()}`;
    links.set(k, [...new Set([...(links.get(k) ?? []), f])]);
  }
}

async function receipt(host, hash) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RPC[host], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      });
      if (res.status === 429) throw new Error("rate limited");
      return (await res.json()).result;
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`RPC unreachable for ${host}`);
}

const entries = [...links.entries()];
const missing = [];
let reverted = 0;
const CONCURRENCY = 4;
for (let i = 0; i < entries.length; i += CONCURRENCY) {
  await Promise.all(
    entries.slice(i, i + CONCURRENCY).map(async ([k, where]) => {
      const [host, hash] = k.split(" ");
      const r = await receipt(host, hash);
      if (!r) missing.push(`${host}/tx/${hash}  (in ${where.join(", ")})`);
      else if (r.status === "0x0") reverted++;
    }),
  );
}

console.log(`${entries.length} linked transactions in ${files.length} files: ${entries.length - missing.length} found` +
  ` (${reverted} reverted on purpose, e.g. refusal proofs), ${missing.length} missing.`);
for (const m of missing) console.log(`  MISSING ${m}`);
process.exit(missing.length ? 1 : 0);
