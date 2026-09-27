// 독립 검증 — 번들 하나와 공개 체인·drand 만으로 라운드를 처음부터 다시 계산한다.
//
// 같은 함수를 세 곳이 부른다: 브라우저의 /verify 화면, 오프라인 CLI(npm run verify), 그리고 서버 자신
// (추첨 확정 전 "자체검증 게이트": 이 검사를 통과하지 못하면 지급을 계획하지 않는다).
// 네트워크가 필요한 검사는 fetchers 로 주입한다 — 주입하지 않으면 skip 으로 표시하고, 거짓 pass 를
// 내지 않는다.

import { verifyBeacon, type Beacon } from "./beacon";
import type { Bundle } from "./bundle";
import { hexToUtf8, parseDecisionPayload, roundSeed, sha256Hex, verifyChain, type RoundParams } from "./chain";
import { resolveDraw } from "./draw";
import { QUICKNET } from "./drand";
import { openingFromRow, openingToRow, type SealOpening } from "./opening";
import { computeRoundMoney, planDrawTransfers, aggregateWinners } from "./prize";
import { checkRoundTimes, scheduleByName, type RoundTimes } from "./schedule";

export type CheckId =
  | "params"
  | "chain"
  | "decision"
  | "payments"
  | "completeness"
  | "beacon"
  | "openings"
  | "draw"
  | "money"
  | "payouts";

export type CheckStatus = "pass" | "fail" | "skip";
export type Check = { id: CheckId; label: string; status: CheckStatus; detail: string };

export const CHECK_LABELS: Record<CheckId, string> = {
  params: "Round rules and times",
  chain: "Ticket list adds up",
  decision: "List was locked before the end",
  payments: "Every ticket was paid",
  completeness: "Every payment is counted",
  beacon: "Time-lock key is genuine",
  openings: "Every secret number reopened",
  draw: "The number and who picked it",
  money: "Shares, fee and carry-over add up",
  payouts: "Shares were sent",
};

export type ChainTx = { from: string; to: string | null; nonce: number; input: string; blockNumber: number | null };
export type ChainReceipt = {
  status: "success" | "reverted";
  blockNumber: number;
  blockTs: number;
  transfers: { logIndex: number; from: string; to: string; value: bigint }[];
};

export type Fetchers = {
  transaction?: (hash: string) => Promise<ChainTx | null>;
  receipt?: (hash: string) => Promise<ChainReceipt | null>;
  /** 릴레이에서 받은 원본 비콘들(검증은 여기서 한다). */
  relayBeacons?: (round: number) => Promise<Beacon[]>;
  /** 봉인 재개봉(무겁다). 브라우저는 Web Worker 에서, CLI 는 그대로 부른다. */
  openSeal?: (ciphertext: string, drandRound: number, beacon: ReturnType<typeof verifyBeacon>) => Promise<SealOpening>;
  onProgress?: (id: CheckId, done: number, total: number) => void;
};

export type VerifyOptions = {
  /** 결제 확인을 앞에서부터 N개만(0 = 전부). 브라우저는 표본, CLI 는 전부. */
  paymentSample?: number;
};

function paramsOf(b: Bundle): RoundParams {
  return { ...b.params, ticketPriceWei: BigInt(b.params.ticketPriceWei) };
}

function timesOf(b: Bundle): RoundTimes {
  const p = b.params;
  return {
    roundId: p.roundId,
    opensAtMs: p.opensAtMs,
    buyCloseAtMs: p.buyCloseAtMs,
    salesCloseAtMs: p.salesCloseAtMs,
    lockAtMs: p.lockAtMs,
    anchorDeadlineMs: p.anchorDeadlineMs,
    drawAtMs: p.drawAtMs,
    drandRound: p.drandRound,
    nextOpensAtMs: p.drawAtMs,
  };
}

const check = (id: CheckId, status: CheckStatus, detail: string): Check => ({ id, label: CHECK_LABELS[id], status, detail });

export function checkParams(b: Bundle): Check {
  const problems: string[] = [];
  if (b.format !== "qoropick-bundle/v1") problems.push(`unknown format ${b.format}`);
  if (b.params.drandChainHash !== QUICKNET.chainHash) problems.push("drand chain is not quicknet");
  let schedule;
  try {
    schedule = scheduleByName(b.params.schedule);
  } catch {
    problems.push(`unknown schedule ${b.params.schedule}`);
  }
  problems.push(...checkRoundTimes(timesOf(b), schedule));
  let seed = "";
  try {
    seed = roundSeed(paramsOf(b));
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (seed && seed !== b.seed) problems.push("seed does not match the round rules");
  if (problems.length) return check("params", "fail", problems.join("; "));
  const note = b.params.schedule === "test" ? " — TEST schedule (not a production weekly round)" : "";
  return check("params", "pass", `rules hash to seed ${b.seed.slice(0, 12)}…, draw at drand round ${b.params.drandRound}${note}`);
}

export function checkChain(b: Bundle): Check {
  const problems: string[] = [];
  const price = BigInt(b.params.ticketPriceWei);
  let tickets = 0;
  const perAddress = new Map<string, number>();
  for (const e of b.entries) {
    if (sha256Hex(e.ciphertext) !== e.ciphertextHash) problems.push(`seq ${e.seq}: ciphertext hash mismatch`);
    const paidMs = e.paidAtSec * 1000;
    if (paidMs < b.params.opensAtMs || paidMs >= b.params.salesCloseAtMs) problems.push(`seq ${e.seq}: paid outside the sales window`);
    tickets += e.qty;
    perAddress.set(e.address, (perAddress.get(e.address) ?? 0) + e.qty);
  }
  for (const [a, n] of perAddress) if (n > b.params.maxTicketsPerHuman) problems.push(`${a} holds ${n} tickets (> ${b.params.maxTicketsPerHuman})`);
  const verdict = verifyChain(b.seed, b.entries, b.head);
  if (!verdict.ok) problems.push(`chain breaks at ${verdict.failedAtSeq ?? "head"}: ${verdict.reason}`);
  if (b.entryCount !== b.entries.length) problems.push(`entry count ${b.entryCount} ≠ ${b.entries.length} entries`);
  if (b.ticketCount !== tickets) problems.push(`ticket count ${b.ticketCount} ≠ Σ qty ${tickets}`);
  if (BigInt(b.salesWei) !== BigInt(tickets) * price) problems.push("sales ≠ tickets × price");
  if (problems.length) return check("chain", "fail", problems.slice(0, 5).join("; "));
  return check("chain", "pass", `${b.entries.length} entries, ${tickets} tickets chain to head ${b.head.slice(0, 12)}…`);
}

export async function checkDecision(b: Bundle, f: Fetchers): Promise<Check> {
  if (!b.decision) return check("decision", "skip", "not decided yet");
  const d = b.decision;
  const parsed = parseDecisionPayload(d.payload);
  if (!parsed || parsed.roundId !== b.params.roundId) return check("decision", "fail", "decision payload is not valid for this round");
  const inWindow = d.blockTs * 1000 >= b.params.lockAtMs && d.blockTs * 1000 <= b.params.anchorDeadlineMs;
  const expectedKind = parsed.kind === "ANCHOR" && inWindow ? "ANCHOR" : "VOID";
  if (d.kind !== expectedKind) return check("decision", "fail", `round was treated as ${d.kind} but the rule says ${expectedKind}`);
  if (parsed.kind === "ANCHOR") {
    if (parsed.head !== b.head || parsed.entryCount !== b.entryCount || parsed.ticketCount !== b.ticketCount || parsed.salesWei !== BigInt(b.salesWei)) {
      return check("decision", "fail", "the anchored list differs from the published list");
    }
    if (parsed.carryInWei !== null && b.carryInWei !== null && parsed.carryInWei !== BigInt(b.carryInWei)) {
      return check("decision", "fail", "anchored carry-over differs");
    }
  }
  if (!f.transaction || !f.receipt) return check("decision", "skip", "payload is consistent; on-chain lookup not available here");
  const [tx, rc] = await Promise.all([f.transaction(d.txHash), f.receipt(d.txHash)]);
  if (!tx || !rc) return check("decision", "fail", `decision tx ${d.txHash} not found on-chain`);
  const problems: string[] = [];
  if (tx.from !== b.params.anchorAddress) problems.push("not sent by the published anchor address");
  if ((tx.to ?? "") !== b.params.anchorAddress) problems.push("not a self-transaction of the anchor address");
  if (tx.nonce !== b.params.anchorNonce) problems.push(`nonce ${tx.nonce} ≠ pinned ${b.params.anchorNonce}`);
  if (hexToUtf8(tx.input) !== d.payload) problems.push("on-chain data differs from the payload");
  if (rc.status !== "success") problems.push("decision tx reverted");
  if (rc.blockTs !== d.blockTs || rc.blockNumber !== d.blockNumber) problems.push("block differs");
  if (problems.length) return check("decision", "fail", problems.join("; "));
  return check(
    "decision",
    "pass",
    `${d.kind} decision mined at block ${d.blockNumber} (${new Date(d.blockTs * 1000).toISOString()}), nonce ${tx.nonce} — the only possible decision for this round`,
  );
}

export async function checkPayments(b: Bundle, f: Fetchers, opts: VerifyOptions): Promise<Check> {
  if (!f.receipt) return check("payments", "skip", "on-chain lookup not available here");
  const price = BigInt(b.params.ticketPriceWei);
  const list = opts.paymentSample ? b.entries.slice(0, opts.paymentSample) : b.entries;
  const cache = new Map<string, ChainReceipt | null>();
  let done = 0;
  for (const e of list) {
    let rc = cache.get(e.payTxHash);
    if (rc === undefined) {
      rc = await f.receipt(e.payTxHash);
      cache.set(e.payTxHash, rc);
    }
    const log = rc?.transfers.find((t) => t.logIndex === e.payLogIndex);
    if (!rc || rc.status !== "success" || !log) return check("payments", "fail", `seq ${e.seq}: payment not found`);
    if (log.from !== e.address || log.to !== b.params.treasury || log.value !== BigInt(e.qty) * price) {
      return check("payments", "fail", `seq ${e.seq}: payment does not match (from/to/amount)`);
    }
    if (rc.blockTs !== e.paidAtSec) return check("payments", "fail", `seq ${e.seq}: payment time differs`);
    f.onProgress?.("payments", ++done, list.length);
  }
  const sampled = list.length < b.entries.length ? ` (first ${list.length} of ${b.entries.length} — run the CLI for all)` : "";
  return check("payments", "pass", `${list.length} entries match WLD transfers to the treasury${sampled}`);
}

export function checkCompleteness(b: Bundle): Check {
  const entryKeys = new Map(b.entries.map((e) => [`${e.payTxHash}:${e.payLogIndex}`, e.seq]));
  const problems: string[] = [];
  let unmatched = 0;
  let refunds = 0;
  for (const t of b.inbound) {
    const key = `${t.txHash}:${t.logIndex}`;
    if (t.disposition === "ENTRY" && entryKeys.get(key) !== t.entrySeq) problems.push(`${key} marked ENTRY but no such entry`);
    if (t.disposition !== "ENTRY" && entryKeys.has(key)) problems.push(`${key} is an entry but marked ${t.disposition}`);
    if (t.disposition === "UNMATCHED" || t.disposition === "PENDING") unmatched++;
    if (t.disposition === "REFUND") refunds++;
  }
  const inboundKeys = new Set(b.inbound.map((t) => `${t.txHash}:${t.logIndex}`));
  for (const [key, seq] of entryKeys) if (!inboundKeys.has(key)) problems.push(`entry ${seq} missing from the inbound list`);
  if (problems.length) return check("completeness", "fail", problems.slice(0, 5).join("; "));
  return check(
    "completeness",
    "pass",
    `${b.inbound.length} payments in the window: ${b.entries.length} entries, ${refunds} refunded, ${unmatched} awaiting operator review`,
  );
}

export async function checkBeacon(b: Bundle, f: Fetchers): Promise<Check> {
  if (!b.draw) return check("beacon", "skip", "not drawn yet");
  if (b.draw.beacon.round !== b.params.drandRound) return check("beacon", "fail", "beacon is for a different drand round");
  try {
    verifyBeacon(b.draw.beacon);
  } catch (err) {
    return check("beacon", "fail", (err as Error).message);
  }
  if (!f.relayBeacons) return check("beacon", "pass", "BLS signature verifies against the quicknet public key");
  const relays = await f.relayBeacons(b.params.drandRound);
  const agree = relays.filter((r) => r.signature.toLowerCase() === b.draw!.beacon.signature).length;
  if (relays.length > 0 && agree !== relays.length) return check("beacon", "fail", "a drand relay returned a different signature");
  return check("beacon", "pass", `BLS signature verifies; ${agree} independent relay(s) agree`);
}

export async function checkOpenings(b: Bundle, f: Fetchers): Promise<Check> {
  if (!b.draw) return check("openings", "skip", "not drawn yet");
  if (!f.openSeal) return check("openings", "skip", "re-decryption not run here (use the CLI or the verify page)");
  const beacon = verifyBeacon(b.draw.beacon);
  const byseq = new Map(b.draw.openings.map((o) => [o.seq, o]));
  let done = 0;
  for (const e of b.entries) {
    const mine = openingToRow(await f.openSeal(e.ciphertext, b.params.drandRound, beacon));
    const theirs = byseq.get(e.seq);
    if (!theirs || theirs.opening !== mine.opening || (theirs.spin ?? null) !== mine.openedSpin) {
      return check("openings", "fail", `seq ${e.seq}: published ${theirs?.opening}/${theirs?.spin} but it opens as ${mine.opening}/${mine.openedSpin}`);
    }
    f.onProgress?.("openings", ++done, b.entries.length);
  }
  return check("openings", "pass", `all ${b.entries.length} seals re-opened with the beacon and match`);
}

export function checkDraw(b: Bundle): Check {
  if (!b.draw) return check("draw", "skip", "not drawn yet");
  const byseq = new Map(b.draw.openings.map((o) => [o.seq, o]));
  let r;
  try {
    r = resolveDraw(
      b.entries.map((e) => {
        const o = byseq.get(e.seq);
        if (!o) throw new Error(`seq ${e.seq} has no opening`);
        return { seq: e.seq, pick: e.pick, qty: e.qty, ciphertextHash: e.ciphertextHash, opening: openingFromRow(o.opening, o.spin) };
      }),
    );
  } catch (err) {
    return check("draw", "fail", (err as Error).message);
  }
  const d = b.draw;
  const same =
    r.winningNumber === d.winningNumber &&
    r.spinSum === d.spinSum &&
    r.validSpinCount === d.validSpinCount &&
    r.winningTickets === d.winningTickets &&
    r.entries.every((e, i) => e.sealStatus === d.sealStatuses[i]);
  if (!same) return check("draw", "fail", `recomputed winning number ${r.winningNumber} (sum ${r.spinSum}) differs from published ${d.winningNumber}`);
  return check("draw", "pass", `${r.validSpinCount} valid spins sum to ${r.spinSum} → winning number ${r.winningNumber}, ${r.winningTickets} winning ticket(s)`);
}

export function checkMoney(b: Bundle): Check {
  if (!b.draw) return check("money", "skip", "not drawn yet");
  if (b.carryInWei === null) return check("money", "fail", "carry-in is not set");
  const d = b.draw;
  let money;
  try {
    money = computeRoundMoney(
      { ticketPriceWei: BigInt(b.params.ticketPriceWei), feeBps: b.params.feeBps },
      { carryInWei: BigInt(b.carryInWei), ticketCount: b.ticketCount, winningTickets: d.winningTickets },
    );
  } catch (err) {
    return check("money", "fail", (err as Error).message);
  }
  const problems: string[] = [];
  if (money.feeWei !== BigInt(d.feeWei)) problems.push("fee");
  if (money.potWei !== BigInt(d.potWei)) problems.push("pot");
  if (money.prizePerTicketWei !== BigInt(d.prizePerTicketWei)) problems.push("prize per ticket");
  if (money.prizesTotalWei !== BigInt(d.prizesTotalWei)) problems.push("prizes total");
  if (money.carryOutWei !== BigInt(d.carryOutWei)) problems.push("carry-over");
  const winners = aggregateWinners(b.entries.map((e) => ({ address: e.address, qty: e.qty, isWinner: e.pick === d.winningNumber })));
  let plan;
  try {
    plan = planDrawTransfers({ roundId: b.params.roundId, money, winners, feeAddress: b.params.feeAddress });
  } catch (err) {
    return check("money", "fail", `winners in the entry list don't match the published result: ${(err as Error).message}`);
  }
  const key = (t: { dedupeKey: string; to: string; amountWei: bigint | string }) => `${t.dedupeKey}|${t.to}|${t.amountWei.toString()}`;
  const want = new Set(plan.map(key));
  const got = new Set(d.transfers.map(key));
  if (want.size !== got.size || [...want].some((k) => !got.has(k))) problems.push("planned transfers");
  if (problems.length) return check("money", "fail", `mismatch: ${problems.join(", ")}`);
  return check("money", "pass", `pot ${money.potWei} wei, ${d.winningTickets} winning ticket(s), carry-over ${money.carryOutWei} wei`);
}

export async function checkPayouts(b: Bundle, f: Fetchers): Promise<Check> {
  if (!b.payouts) return check("payouts", "skip", "payouts not published yet");
  if (!f.receipt) return check("payouts", "skip", "on-chain lookup not available here");
  const planned = new Map((b.draw?.transfers ?? []).map((t) => [t.dedupeKey, t]));
  let checked = 0;
  for (const p of b.payouts) {
    if (p.kind === "REFUND") continue;
    if (!planned.has(p.dedupeKey)) return check("payouts", "fail", `${p.dedupeKey} was paid but not planned`);
    if (!p.txHash) return check("payouts", "fail", `${p.dedupeKey} has no transaction yet`);
    const rc = await f.receipt(p.txHash);
    const ok = rc?.status === "success" && rc.transfers.some((t) => t.from === b.params.treasury && t.to === p.to && t.value === BigInt(p.amountWei));
    if (!ok) return check("payouts", "fail", `${p.dedupeKey}: transfer not found on-chain`);
    checked++;
  }
  if (checked !== planned.size) return check("payouts", "fail", `${planned.size - checked} planned payout(s) missing`);
  return check("payouts", "pass", `${checked} prize/fee transfer(s) found on-chain with the right amounts`);
}

/** 모든 검사를 순서대로. 앞 단계가 실패해도 나머지를 계속 돌려 한 번에 다 보여 준다. */
export async function* runChecks(b: Bundle, f: Fetchers = {}, opts: VerifyOptions = {}): AsyncGenerator<Check> {
  yield checkParams(b);
  yield checkChain(b);
  yield await checkDecision(b, f);
  yield await checkPayments(b, f, opts);
  yield checkCompleteness(b);
  yield await checkBeacon(b, f);
  yield await checkOpenings(b, f);
  yield checkDraw(b);
  yield checkMoney(b);
  yield await checkPayouts(b, f);
}

export async function runAllChecks(b: Bundle, f: Fetchers = {}, opts: VerifyOptions = {}): Promise<Check[]> {
  const out: Check[] = [];
  for await (const c of runChecks(b, f, opts)) out.push(c);
  return out;
}
