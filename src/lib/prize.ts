// 돈 계산 — bigint wei 만 쓴다. 부동소수점은 1 WLD = 10^18 wei 앞에서 조용히 틀린다.
//
// 규칙(Rules 화면과 같은 문장):
//  - 수수료 = **그 라운드 판매액 × feeBps**(운영 1%), 내림. 이월금에는 다시 떼지 않는다.
//  - pot = 이월금 + 판매액 − 수수료
//  - 당첨 티켓 1장당 = floor(pot ÷ 당첨 티켓 수). 나눗셈 자투리(당첨 티켓 수 미만의 wei)는 다음 라운드로.
//  - 당첨 티켓이 없으면 pot 전액 이월.
//  - VOID 라운드는 전액 환불(수수료 없음), 이월금은 그대로 다음 라운드로.
//
// SQL 에서 나눗셈을 하지 않는다: numeric / numeric 은 소수 스케일을 만든다. 계산은 여기서만 하고
// DB 는 결과를 저장만 한다. 검증기가 같은 함수를 다시 부른다.

export type Wei = bigint;

export const WEI_PER_WLD = 10n ** 18n;
export const BPS_DENOMINATOR = 10_000n;

export type MoneyParams = { ticketPriceWei: Wei; feeBps: number };

export type RoundMoney = {
  salesWei: Wei;
  feeWei: Wei;
  potWei: Wei;
  winningTickets: number;
  prizePerTicketWei: Wei;
  prizesTotalWei: Wei;
  carryOutWei: Wei;
};

function assertParams(p: MoneyParams) {
  if (p.ticketPriceWei <= 0n) throw new Error("ticket price must be positive");
  if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps > 10_000) throw new Error("feeBps must be 0..10000");
}

export function feeOf(p: MoneyParams, salesWei: Wei): Wei {
  assertParams(p);
  return (salesWei * BigInt(p.feeBps)) / BPS_DENOMINATOR;
}

/** 라운드의 돈 흐름. 불변식이 깨지면 던진다(깨졌다면 이 함수가 틀린 것이다). */
export function computeRoundMoney(
  p: MoneyParams,
  x: { carryInWei: Wei; ticketCount: number; winningTickets: number },
): RoundMoney {
  assertParams(p);
  if (x.carryInWei < 0n) throw new Error("carry-in must be ≥ 0");
  if (!Number.isSafeInteger(x.ticketCount) || x.ticketCount < 0) throw new Error("bad ticket count");
  if (!Number.isSafeInteger(x.winningTickets) || x.winningTickets < 0 || x.winningTickets > x.ticketCount) {
    throw new Error("bad winning ticket count");
  }
  const salesWei = BigInt(x.ticketCount) * p.ticketPriceWei;
  const feeWei = feeOf(p, salesWei);
  const potWei = x.carryInWei + salesWei - feeWei;
  const tw = BigInt(x.winningTickets);
  const prizePerTicketWei = tw > 0n ? potWei / tw : 0n;
  const prizesTotalWei = prizePerTicketWei * tw;
  const carryOutWei = potWei - prizesTotalWei;

  if (potWei - x.carryInWei !== salesWei - feeWei) throw new Error("invariant: pot − carry-in = sales − fee");
  if (prizesTotalWei + carryOutWei !== potWei) throw new Error("invariant: prizes + carry-out = pot");
  if (tw > 0n && carryOutWei >= tw) throw new Error("invariant: dust < winning tickets");
  return { salesWei, feeWei, potWei, winningTickets: x.winningTickets, prizePerTicketWei, prizesTotalWei, carryOutWei };
}

/** 판매 중 화면용: 지금 pot(이월금이 아직 확정 전이면 null). */
export function livePot(p: MoneyParams, carryInWei: Wei | null, ticketCount: number): Wei | null {
  if (carryInWei === null) return null;
  const salesWei = BigInt(ticketCount) * p.ticketPriceWei;
  return carryInWei + salesWei - feeOf(p, salesWei);
}

/**
 * 화면용 예상치: 지금 pot 에 내 구매를 더하고, 그 숫자에 이미 걸린 티켓 수와 나눈다.
 * 실제 결과는 마감 때의 pot·당첨 티켓 수로 정해지므로 **추정**이라고 표기한다.
 */
export function estimatePrizePerTicket(
  p: MoneyParams,
  x: { carryInWei: Wei; ticketCount: number; ticketsOnPick: number; buyQty: number },
): Wei {
  const pot = livePot(p, x.carryInWei, x.ticketCount + x.buyQty)!;
  return pot / BigInt(x.ticketsOnPick + x.buyQty);
}

export type WinnerTickets = { address: string; tickets: number };

/** 당첨 항목을 주소별로 합친다(주소 오름차순). 지급은 주소당 한 번이다. */
export function aggregateWinners(
  entries: readonly { address: string; qty: number; isWinner: boolean }[],
): WinnerTickets[] {
  const byAddress = new Map<string, number>();
  for (const e of entries) if (e.isWinner) byAddress.set(e.address, (byAddress.get(e.address) ?? 0) + e.qty);
  return [...byAddress.entries()]
    .map(([address, tickets]) => ({ address, tickets }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

export type PlannedTransfer = {
  kind: "PRIZE" | "FEE" | "REFUND";
  to: string;
  amountWei: Wei;
  /** 같은 지급을 두 번 계획하지 못하게 하는 키(outbox unique). */
  dedupeKey: string;
};

/** 추첨 후 보낼 돈: 당첨 주소별 PRIZE + FEE. 합계가 prizesTotal·fee 와 정확히 같다. */
export function planDrawTransfers(a: {
  roundId: number;
  money: RoundMoney;
  winners: readonly WinnerTickets[];
  feeAddress: string;
}): PlannedTransfer[] {
  const out: PlannedTransfer[] = [];
  let prizeSum = 0n;
  let ticketSum = 0;
  for (const w of a.winners) {
    const amountWei = a.money.prizePerTicketWei * BigInt(w.tickets);
    prizeSum += amountWei;
    ticketSum += w.tickets;
    out.push({ kind: "PRIZE", to: w.address, amountWei, dedupeKey: `PRIZE:${a.roundId}:${w.address}` });
  }
  if (ticketSum !== a.money.winningTickets) throw new Error("winner tickets do not match winning ticket count");
  if (prizeSum !== a.money.prizesTotalWei) throw new Error("prize transfers do not sum to prizes total");
  if (a.money.feeWei > 0n) {
    out.push({ kind: "FEE", to: a.feeAddress, amountWei: a.money.feeWei, dedupeKey: `FEE:${a.roundId}` });
  }
  return out;
}

/** 무효가 된 결제의 환불. 키가 결제 로그 자체라 같은 결제가 두 번 환불될 수 없다. */
export function planRefund(a: { payTxHash: string; payLogIndex: number; from: string; valueWei: Wei }): PlannedTransfer {
  return { kind: "REFUND", to: a.from, amountWei: a.valueWei, dedupeKey: `REFUND:${a.payTxHash}:${a.payLogIndex}` };
}

// ---- 표기 ----------------------------------------------------------------------------------------

/** wei → "1,234.56" (내림, 부동소수점 없음). */
export function formatWld(wei: Wei, fractionDigits = 2): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_WLD;
  const frac = abs % WEI_PER_WLD;
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractionDigits <= 0) return (negative ? "-" : "") + wholeText;
  const fracText = frac.toString().padStart(18, "0").slice(0, Math.min(fractionDigits, 18));
  return `${negative ? "-" : ""}${wholeText}.${fracText}`;
}

/** 정확한 10진 표기(엑셀·검증 화면용): 끝 0 제거, 최대 18자리. */
export function formatWldExact(wei: Wei): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_WLD;
  const frac = (abs % WEI_PER_WLD).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
