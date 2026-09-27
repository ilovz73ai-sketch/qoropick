import { describe, expect, it } from "vitest";
import { resolveDraw, type DrawEntryInput } from "./draw";
import type { SealOpening } from "./opening";

const spin = (s: number): SealOpening => ({ kind: "SPIN", spin: s });
let n = 0;
const h = () => (n++).toString(16).padStart(64, "0");
function entries(...xs: { pick: number; qty?: number; opening: SealOpening; hash?: string }[]): DrawEntryInput[] {
  return xs.map((x, i) => ({ seq: i + 1, pick: x.pick, qty: x.qty ?? 1, ciphertextHash: x.hash ?? h(), opening: x.opening }));
}

describe("당첨 숫자 = 유효 spin 합 mod 1000", () => {
  it("합이 1000을 넘으면 감긴다", () => {
    const r = resolveDraw(entries({ pick: 1, opening: spin(900) }, { pick: 2, opening: spin(300) }));
    expect(r.spinSum).toBe(1200);
    expect(r.winningNumber).toBe(200);
  });

  it("항목이 없으면 0", () => {
    expect(resolveDraw([]).winningNumber).toBe(0);
  });

  it("무효 spin 은 합산에서 빠진다", () => {
    const r = resolveDraw(
      entries(
        { pick: 5, opening: spin(10) },
        { pick: 5, opening: { kind: "DECRYPT_FAILED" } },
        { pick: 5, opening: { kind: "MALFORMED" } },
        { pick: 5, opening: { kind: "HEADER_REJECTED", status: "WRONG_ROUND" } },
        { pick: 5, opening: spin(20) },
      ),
    );
    expect(r.validSpinCount).toBe(2);
    expect(r.winningNumber).toBe(30);
    expect(r.entries.map((e) => e.sealStatus)).toEqual(["VALID", "DECRYPT_FAILED", "MALFORMED", "WRONG_ROUND", "VALID"]);
  });
});

describe("복제 방지: 같은 암호문은 가장 이른 seq 만", () => {
  it("정직한 봉인을 999번 복제해도 그 spin 은 한 번만 더해진다", () => {
    const honest = "f".repeat(64);
    const copies = Array.from({ length: 999 }, () => ({ pick: 0, opening: spin(7), hash: honest }));
    const r = resolveDraw(entries({ pick: 7, opening: spin(7), hash: honest }, ...copies));
    expect(r.spinSum).toBe(7);
    expect(r.winningNumber).toBe(7);
    expect(r.entries.filter((e) => e.sealStatus === "DUPLICATE")).toHaveLength(999);
  });

  it("헤더 거부는 중복보다 먼저 판정된다", () => {
    const x = "e".repeat(64);
    const r = resolveDraw(
      entries(
        { pick: 1, opening: { kind: "HEADER_REJECTED", status: "BAD_HEADER" }, hash: x },
        { pick: 1, opening: { kind: "HEADER_REJECTED", status: "BAD_HEADER" }, hash: x },
      ),
    );
    expect(r.entries.map((e) => e.sealStatus)).toEqual(["BAD_HEADER", "BAD_HEADER"]);
  });
});

describe("당첨 티켓", () => {
  it("pick == W 이면 봉인 상태와 무관하게 당첨, 티켓 수는 qty 합", () => {
    const r = resolveDraw(
      entries(
        { pick: 42, qty: 3, opening: spin(40) },
        { pick: 42, qty: 2, opening: { kind: "DECRYPT_FAILED" } },
        { pick: 41, qty: 10, opening: spin(2) },
      ),
    );
    expect(r.winningNumber).toBe(42);
    expect(r.winnerSeqs).toEqual([1, 2]);
    expect(r.winningTickets).toBe(5);
  });

  it("체인에서 온 값이 어긋나면 던진다", () => {
    expect(() => resolveDraw([{ seq: 2, pick: 1, qty: 1, ciphertextHash: h(), opening: spin(1) }])).toThrow();
    expect(() => resolveDraw(entries({ pick: 1000, opening: spin(1) }))).toThrow();
    expect(() => resolveDraw(entries({ pick: 1, qty: 11, opening: spin(1) }))).toThrow();
  });
});
