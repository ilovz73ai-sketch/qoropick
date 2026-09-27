import { describe, expect, it } from "vitest";
import { fetchVerifiedBeacon } from "./beacon";
import { QUICKNET, roundAfterTime, roundEmissionMs } from "./drand";
import { checkEnvelope } from "./envelope";
import { openSeal, sealSpin } from "./seal-crypto";

// 실제 drand 네트워크: 미래 라운드로 봉인 → 발행 전엔 비콘이 없다 → 발행 후 검증된 비콘으로 열린다.
describe("drand quicknet 실제 왕복", () => {
  it("봉인은 추첨 라운드 전에는 열 수 없고, 그 뒤에는 열린다", async () => {
    const round = roundAfterTime(Date.now() + 9_000);
    const sealed = await sealSpin(round, 777);
    expect(checkEnvelope(sealed, { drandRound: round })).toEqual({ ok: true });

    const early = await fetchVerifiedBeacon(round, { timeoutMs: 4000 });
    expect(early.beacon).toBeNull();

    const wait = roundEmissionMs(round) - Date.now() + 2_500;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let beacon = null;
    for (let i = 0; i < 10 && !beacon; i++) {
      beacon = (await fetchVerifiedBeacon(round, { timeoutMs: 4000 })).beacon;
      if (!beacon) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(beacon).not.toBeNull();
    expect(await openSeal(sealed, round, beacon!)).toEqual({ kind: "SPIN", spin: 777 });
  });

  it("두 릴레이가 같은 (검증된) 서명을 준다", async () => {
    const round = roundAfterTime(Date.now()) - 5;
    const { beacon, reports } = await fetchVerifiedBeacon(round);
    expect(beacon?.round).toBe(round);
    const ok = reports.filter((r) => r.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.signature)).size).toBe(1);
    expect(QUICKNET.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
