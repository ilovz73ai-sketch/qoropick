// 오프라인 검증기 — 이 사이트 없이 라운드 하나를 처음부터 다시 계산한다.
//   npm run verify -- <bundle.json | https://…/api/rounds/12/bundle> [--rpc URL] [--sample N]
// 체인은 World Chain RPC 에, 비콘은 drand 릴레이에 직접 묻는다(qoropick 서버를 믿지 않는다).
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { worldchain } from "viem/chains";
import type { Bundle } from "../src/lib/bundle";
import { QUICKNET, RELAYS } from "../src/lib/drand";
import { openSeal } from "../src/lib/seal-crypto";
import { runChecks, type ChainReceipt, type Fetchers } from "../src/lib/verify";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!src) {
  console.error("usage: npm run verify -- <bundle.json | URL> [--rpc URL] [--sample N]");
  process.exit(2);
}

const WLD = "0x2cfc85d8e48f8eab294be644d9e25c3030863003";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function main() {
  const bundle = (src!.startsWith("http") ? await (await fetch(src!)).json() : JSON.parse(readFileSync(src!, "utf8"))) as Bundle;
  const client = createPublicClient({ chain: worldchain, transport: http(opt("rpc")) });
  const tsCache = new Map<bigint, number>();
  const fetchers: Fetchers = {
    async transaction(h) {
      try {
        const t = await client.getTransaction({ hash: h as `0x${string}` });
        return { from: t.from.toLowerCase(), to: t.to?.toLowerCase() ?? null, nonce: t.nonce, input: t.input, blockNumber: t.blockNumber === null ? null : Number(t.blockNumber) };
      } catch {
        return null;
      }
    },
    async receipt(h): Promise<ChainReceipt | null> {
      try {
        const r = await client.getTransactionReceipt({ hash: h as `0x${string}` });
        let ts = tsCache.get(r.blockNumber);
        if (ts === undefined) {
          ts = Number((await client.getBlock({ blockNumber: r.blockNumber })).timestamp);
          tsCache.set(r.blockNumber, ts);
        }
        return {
          status: r.status,
          blockNumber: Number(r.blockNumber),
          blockTs: ts,
          transfers: r.logs
            .filter((l) => l.address.toLowerCase() === WLD && l.topics[0] === TRANSFER && l.topics.length === 3)
            .map((l) => ({ logIndex: l.logIndex, from: ("0x" + l.topics[1]!.slice(26)).toLowerCase(), to: ("0x" + l.topics[2]!.slice(26)).toLowerCase(), value: BigInt(l.data) })),
        };
      } catch {
        return null;
      }
    },
    async relayBeacons(round) {
      const got = await Promise.all(
        RELAYS.map(async (relay) => {
          try {
            const res = await fetch(`${relay}/${QUICKNET.chainHash}/public/${round}`);
            return res.ok ? await res.json() : null;
          } catch {
            return null;
          }
        }),
      );
      return got.filter(Boolean);
    },
    openSeal: (ct, round, beacon) => openSeal(ct, round, beacon),
    onProgress: (id, done, total) => {
      if (done % 200 === 0 || done === total) process.stderr.write(`\r  ${id}: ${done}/${total}   `);
    },
  };
  console.log(`qoropick round #${bundle.params.roundId} (${bundle.stage}) — ${bundle.entries.length} entries`);
  let failed = 0;
  for await (const c of runChecks(bundle, fetchers, { paymentSample: Number(opt("sample") ?? 0) })) {
    process.stderr.write("\r");
    const icon = c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "⏸️ ";
    console.log(`${icon} ${c.label}\n     ${c.detail}`);
    if (c.status === "fail") failed++;
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed (skipped checks need data that isn't published yet).");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
