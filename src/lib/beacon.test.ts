import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/beacon-30000000.json";
import { verifyBeacon } from "./beacon";

describe("verifyBeacon (실제 quicknet 비콘, 네트워크 없음)", () => {
  it("진짜 비콘은 통과한다", () => {
    const v = verifyBeacon(fixture);
    expect(v.round).toBe(30000000);
    expect(v.signature).toBe(fixture.signature);
  });

  it("다른 라운드 번호를 붙이면 실패한다", () => {
    expect(() => verifyBeacon({ ...fixture, round: 30000001 })).toThrow(/BLS/);
  });

  it("서명 한 글자만 바꿔도 실패한다", () => {
    const flipped = fixture.signature.slice(0, -1) + (fixture.signature.endsWith("5") ? "6" : "5");
    expect(() => verifyBeacon({ ...fixture, signature: flipped })).toThrow();
  });

  it("randomness 가 서명의 해시가 아니면 실패한다", () => {
    expect(() => verifyBeacon({ ...fixture, randomness: "00".repeat(32) })).toThrow(/randomness/);
  });
});
