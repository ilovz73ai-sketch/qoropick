import { describe, expect, it } from "vitest";
import {
  aggregateWinners,
  computeRoundMoney,
  estimatePrizePerTicket,
  formatWld,
  formatWldExact,
  livePot,
  planDrawTransfers,
  planRefund,
  WEI_PER_WLD,
} from "./prize";

const P = { ticketPriceWei: WEI_PER_WLD, feeBps: 500 };
const W = (n: number | bigint) => BigInt(n) * WEI_PER_WLD;

describe("computeRoundMoney", () => {
  it("판매 100장, 이월 없음, 당첨 3장: 수수료 5 WLD, pot 95, 장당 31.666…, 자투리 이월", () => {
    const m = computeRoundMoney(P, { carryInWei: 0n, ticketCount: 100, winningTickets: 3 });
    expect(m.salesWei).toBe(W(100));
    expect(m.feeWei).toBe(W(5));
    expect(m.potWei).toBe(W(95));
    expect(m.prizePerTicketWei).toBe(W(95) / 3n);
    expect(m.prizesTotalWei + m.carryOutWei).toBe(m.potWei);
    expect(m.carryOutWei).toBe(W(95) % 3n); // 2 wei
    expect(m.carryOutWei).toBeLessThan(3n);
  });

  it("무당첨이면 pot 전액 이월", () => {
    const m = computeRoundMoney(P, { carryInWei: W(10), ticketCount: 20, winningTickets: 0 });
    expect(m.potWei).toBe(W(10) + W(20) - W(1));
    expect(m.prizePerTicketWei).toBe(0n);
    expect(m.carryOutWei).toBe(m.potWei);
  });

  it("수수료는 이번 판매액에만: 이월금 1000 WLD 에는 붙지 않는다", () => {
    const m = computeRoundMoney(P, { carryInWei: W(1000), ticketCount: 10, winningTickets: 1 });
    expect(m.feeWei).toBe(W(10) * 5n / 100n);
    expect(m.prizePerTicketWei).toBe(W(1000) + W(10) - m.feeWei);
  });

  it("수수료 내림: 판매 1장이면 0.05 WLD", () => {
    expect(computeRoundMoney(P, { carryInWei: 0n, ticketCount: 1, winningTickets: 0 }).feeWei).toBe(W(1) / 20n);
    const odd = { ticketPriceWei: 7n, feeBps: 500 };
    expect(computeRoundMoney(odd, { carryInWei: 0n, ticketCount: 1, winningTickets: 0 }).feeWei).toBe(0n);
  });

  it("판매 0장·이월 0 도 계산된다", () => {
    const m = computeRoundMoney(P, { carryInWei: 0n, ticketCount: 0, winningTickets: 0 });
    expect(m.potWei).toBe(0n);
    expect(m.carryOutWei).toBe(0n);
  });

  it("이상한 입력은 거부", () => {
    expect(() => computeRoundMoney(P, { carryInWei: 0n, ticketCount: 1, winningTickets: 2 })).toThrow();
    expect(() => computeRoundMoney({ ticketPriceWei: 0n, feeBps: 500 }, { carryInWei: 0n, ticketCount: 1, winningTickets: 0 })).toThrow();
    expect(() => computeRoundMoney({ ...P, feeBps: 10_001 }, { carryInWei: 0n, ticketCount: 1, winningTickets: 0 })).toThrow();
  });
});

describe("지급 계획", () => {
  const entries = [
    { address: "0xbb", qty: 2, isWinner: true },
    { address: "0xaa", qty: 1, isWinner: true },
    { address: "0xbb", qty: 1, isWinner: true },
    { address: "0xcc", qty: 5, isWinner: false },
  ];

  it("주소별로 합치고 주소 순서로 정렬", () => {
    expect(aggregateWinners(entries)).toEqual([
      { address: "0xaa", tickets: 1 },
      { address: "0xbb", tickets: 3 },
    ]);
  });

  it("PRIZE 합계 = prizesTotal, FEE = fee, 키는 라운드·주소별로 유일", () => {
    const money = computeRoundMoney(P, { carryInWei: 0n, ticketCount: 9, winningTickets: 4 });
    const plan = planDrawTransfers({ roundId: 7, money, winners: aggregateWinners(entries), feeAddress: "0xfe" });
    const prizes = plan.filter((t) => t.kind === "PRIZE");
    expect(prizes.map((t) => t.amountWei)).toEqual([money.prizePerTicketWei, money.prizePerTicketWei * 3n]);
    expect(prizes.reduce((a, t) => a + t.amountWei, 0n)).toBe(money.prizesTotalWei);
    expect(plan.find((t) => t.kind === "FEE")).toEqual({ kind: "FEE", to: "0xfe", amountWei: money.feeWei, dedupeKey: "FEE:7" });
    expect(new Set(plan.map((t) => t.dedupeKey)).size).toBe(plan.length);
  });

  it("당첨 티켓 수가 안 맞으면 던진다", () => {
    const money = computeRoundMoney(P, { carryInWei: 0n, ticketCount: 9, winningTickets: 5 });
    expect(() => planDrawTransfers({ roundId: 7, money, winners: aggregateWinners(entries), feeAddress: "0xfe" })).toThrow();
  });

  it("환불 키는 결제 로그 자체", () => {
    expect(planRefund({ payTxHash: "0xabc", payLogIndex: 3, from: "0x11", valueWei: W(2) }).dedupeKey).toBe("REFUND:0xabc:3");
  });
});

describe("화면용", () => {
  it("livePot 은 이월 미정이면 null", () => {
    expect(livePot(P, null, 10)).toBeNull();
    expect(livePot(P, W(1), 10)).toBe(W(1) + W(10) - W(10) / 20n);
  });
  it("예상 당첨금 = (pot + 내 구매 95%) ÷ (그 숫자 티켓 + 내 수량)", () => {
    const est = estimatePrizePerTicket(P, { carryInWei: 0n, ticketCount: 99, ticketsOnPick: 1, buyQty: 1 });
    expect(est).toBe(W(95) / 2n);
  });
  it("formatWld 는 내림하고 천 단위 구분", () => {
    expect(formatWld(W(1234) + WEI_PER_WLD / 2n + 1n)).toBe("1,234.50");
    expect(formatWld(W(95) / 3n, 4)).toBe("31.6666");
    expect(formatWld(0n)).toBe("0.00");
    expect(formatWldExact(W(95) / 3n)).toBe("31.666666666666666666");
    expect(formatWldExact(W(5))).toBe("5");
  });
});
