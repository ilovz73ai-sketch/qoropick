import { describe, expect, it } from "vitest";
import { defaultChainInfo } from "tlock-js";
import { QUICKNET, roundAfterTime, roundEmissionMs } from "./drand";

const G = QUICKNET.genesisTimeMs;
const P = QUICKNET.periodMs;

describe("quicknet 상수", () => {
  it("tlock-js 가 실제 봉인에 쓰는 값과 같다", () => {
    expect(QUICKNET.chainHash).toBe(defaultChainInfo.hash);
    expect(QUICKNET.publicKey).toBe(defaultChainInfo.public_key);
    expect(QUICKNET.genesisTimeMs).toBe(defaultChainInfo.genesis_time * 1000);
    expect(QUICKNET.periodMs).toBe(defaultChainInfo.period * 1000);
    expect(QUICKNET.schemeId).toBe(defaultChainInfo.schemeID);
  });
});

describe("roundEmissionMs", () => {
  it("라운드 1이 genesis 다", () => {
    expect(roundEmissionMs(1)).toBe(G);
    expect(roundEmissionMs(2)).toBe(G + P);
  });
});

describe("roundAfterTime", () => {
  // 여기가 틀리면 암호는 멀쩡히 동작하면서 결과만 조작 가능해진다 — 추첨 전에 이미 공개된 라운드로
  // 봉인하게 되기 때문이다.
  it("발행 시각과 정확히 겹치면 그 라운드다", () => {
    expect(roundAfterTime(G)).toBe(1);
    expect(roundAfterTime(G + P)).toBe(2);
    expect(roundAfterTime(G + 10 * P)).toBe(11);
  });

  it("주기 중간이면 다음 라운드로 올린다 (내리면 안 된다)", () => {
    expect(roundAfterTime(G + 1)).toBe(2);
    expect(roundAfterTime(G + P - 1)).toBe(2);
    expect(roundAfterTime(G + P + 1)).toBe(3);
  });

  it("불변식: 고른 라운드는 t 이후에 나오고, 그 직전 라운드는 t 전에 나온다", () => {
    for (let offset = 0; offset < 20 * P; offset += 137) {
      for (const t of [G + offset, G + offset - 1, G + offset + 1]) {
        if (t < G) continue;
        const r = roundAfterTime(t);
        expect(roundEmissionMs(r)).toBeGreaterThanOrEqual(t);
        expect(roundEmissionMs(r - 1)).toBeLessThan(t);
      }
    }
  });

  it("drand-client 의 roundAt 과 다르다 — 그쪽을 쓰면 조기 복호화가 가능하다", () => {
    const roundAt = (t: number) => Math.floor((t - G) / P) + 1;
    expect(roundAt(G + 1)).toBe(1);
    expect(roundAfterTime(G + 1)).toBe(2);
    expect(roundEmissionMs(roundAt(G + 1))).toBeLessThan(G + 1);
  });

  it("UTC 정각 분은 언제나 라운드 경계다 (Timevault 의 roundAt 과 추첨 시각에서 일치)", () => {
    const roundAt = (t: number) => Math.floor((t - G) / P) + 1;
    const sundayDraw = Date.UTC(2026, 9, 4, 15, 0, 0); // 2026-10-04 (일) 15:00 UTC = 월 00:00 KST
    expect(roundAfterTime(sundayDraw)).toBe(32774212);
    expect(roundEmissionMs(32774212)).toBe(sundayDraw);
    for (let m = 0; m < 24 * 60; m += 7) {
      const t = sundayDraw + m * 60_000;
      expect(roundAt(t)).toBe(roundAfterTime(t));
    }
  });

  it("genesis 이전과 비정상 값은 거부한다", () => {
    expect(() => roundAfterTime(G - 1)).toThrow();
    expect(() => roundAfterTime(Number.NaN)).toThrow();
  });
});
