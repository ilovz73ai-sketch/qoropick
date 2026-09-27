// 해시 체인 — 라운드의 참가 목록을 "나중에 바꿀 수 없게" 묶는다.
//
// h_0 = seed = H("qoropick/v1/seed|" + 라운드의 모든 규칙 파라미터)
// h_i = H(h_{i-1} | seq | address | pick | qty | payTxHash | payLogIndex | paidAtSec | ciphertextHash)
//
// 이 식은 SQL(append_entry, create_round)과 **바이트 단위로** 같아야 한다. 어긋나면 구매는 전부 성공하고
// 검증만 실패한다 — 그리고 사용자 눈에는 "조작됨"으로 보인다. fixtures/chain-vectors.json 을 이 파일의
// 테스트와 PGlite 마이그레이션 테스트가 함께 쓴다. 한쪽만 고치면 둘 중 하나가 깨진다.
//
// 왜 pick·qty 가 체인 안에 있나: 원본(qoropick)은 공개 pick 이 체인 밖이었다. 봉인이 열린 뒤 운영자가
// 공개 pick 을 고쳐 적어도 체인·복호화·판정 검사가 전부 통과했다. 여기서는 공개 pick 이 당첨의 근거이므로
// 반드시 체인에 묶는다.
//
// 모든 필드는 고정 형식(10진 정수, 소문자 hex)이라 구분자 '|' 가 어느 필드에도 들어갈 수 없다 —
// 연결 문자열이 유일하게 분해된다. 형식이 다르면 해시를 만들기 전에 던진다(대소문자 섞인 주소 하나가
// SQL 과 TS 의 결과를 조용히 갈라놓는 일을 막는다).

import { sha256 } from "@noble/hashes/sha256";

export const DOMAIN = "qoropick/v1";

const ENCODER = new TextEncoder();

export function sha256Hex(input: string): string {
  const digest = sha256(ENCODER.encode(input));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---- 필드 정규형 ---------------------------------------------------------------------------------

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

function int(name: string, v: number): string {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name}: not a non-negative safe integer (${v})`);
  return String(v);
}
function wei(name: string, v: bigint): string {
  if (typeof v !== "bigint" || v < 0n) throw new Error(`${name}: not a non-negative bigint`);
  return v.toString();
}
function addr(name: string, v: string): string {
  if (!ADDRESS_RE.test(v)) throw new Error(`${name}: address must be 0x + 40 lowercase hex (${v})`);
  return v;
}
function txh(name: string, v: string): string {
  if (!TX_HASH_RE.test(v)) throw new Error(`${name}: tx hash must be 0x + 64 lowercase hex (${v})`);
  return v;
}
function sha(name: string, v: string): string {
  if (!SHA256_RE.test(v)) throw new Error(`${name}: sha256 must be 64 lowercase hex (${v})`);
  return v;
}

// ---- seed: 라운드의 규칙을 체인의 첫 고리로 ------------------------------------------------------

export type RoundParams = {
  roundId: number;
  chainId: number;
  wldToken: string;
  treasury: string;
  feeAddress: string;
  ticketPriceWei: bigint;
  feeBps: number;
  maxTicketsPerHuman: number;
  opensAtMs: number;
  buyCloseAtMs: number;
  salesCloseAtMs: number;
  lockAtMs: number;
  anchorDeadlineMs: number;
  drawAtMs: number;
  drandRound: number;
  drandChainHash: string;
  anchorAddress: string;
  anchorNonce: number;
};

export function seedPreimage(p: RoundParams): string {
  return [
    `${DOMAIN}/seed`,
    int("roundId", p.roundId),
    int("chainId", p.chainId),
    addr("wldToken", p.wldToken),
    addr("treasury", p.treasury),
    addr("feeAddress", p.feeAddress),
    wei("ticketPriceWei", p.ticketPriceWei),
    int("feeBps", p.feeBps),
    int("maxTicketsPerHuman", p.maxTicketsPerHuman),
    int("opensAtMs", p.opensAtMs),
    int("buyCloseAtMs", p.buyCloseAtMs),
    int("salesCloseAtMs", p.salesCloseAtMs),
    int("lockAtMs", p.lockAtMs),
    int("anchorDeadlineMs", p.anchorDeadlineMs),
    int("drawAtMs", p.drawAtMs),
    int("drandRound", p.drandRound),
    sha("drandChainHash", p.drandChainHash),
    addr("anchorAddress", p.anchorAddress),
    int("anchorNonce", p.anchorNonce),
  ].join("|");
}

export function roundSeed(p: RoundParams): string {
  return sha256Hex(seedPreimage(p));
}

// ---- 고리 ----------------------------------------------------------------------------------------

export type ChainLink = {
  seq: number;
  address: string;
  pick: number;
  qty: number;
  payTxHash: string;
  payLogIndex: number;
  paidAtSec: number;
  ciphertextHash: string;
};

export function linkPreimage(prevChainHash: string, l: ChainLink): string {
  if (!Number.isInteger(l.pick) || l.pick < 0 || l.pick > 999) throw new Error(`pick out of range (${l.pick})`);
  if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 10) throw new Error(`qty out of range (${l.qty})`);
  return [
    sha("prevChainHash", prevChainHash),
    int("seq", l.seq),
    addr("address", l.address),
    int("pick", l.pick),
    int("qty", l.qty),
    txh("payTxHash", l.payTxHash),
    int("payLogIndex", l.payLogIndex),
    int("paidAtSec", l.paidAtSec),
    sha("ciphertextHash", l.ciphertextHash),
  ].join("|");
}

export function nextChainHash(prevChainHash: string, l: ChainLink): string {
  return sha256Hex(linkPreimage(prevChainHash, l));
}

export type ChainVerdict =
  | { ok: true; head: string }
  | { ok: false; head: string; failedAtSeq: number | null; reason: string };

/**
 * seed 에서 출발해 고리를 모두 다시 계산하고 공표된 헤드와 대조한다.
 * seq 는 1부터 빈틈없이 이어져야 한다(중간 삭제는 seq 틈으로, 끝 삭제·삽입은 헤드 불일치로 드러난다).
 */
export function verifyChain(
  seed: string,
  links: readonly (ChainLink & { chainHash: string })[],
  publishedHead: string,
): ChainVerdict {
  let head = seed;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (link.seq !== i + 1) return { ok: false, head, failedAtSeq: link.seq, reason: `expected seq ${i + 1}` };
    let next: string;
    try {
      next = nextChainHash(head, link);
    } catch (err) {
      return { ok: false, head, failedAtSeq: link.seq, reason: (err as Error).message };
    }
    if (next !== link.chainHash) return { ok: false, head, failedAtSeq: link.seq, reason: "link hash mismatch" };
    head = next;
  }
  if (head !== publishedHead) return { ok: false, head, failedAtSeq: null, reason: "head mismatch" };
  return { ok: true, head };
}

// ---- 결정 tx: 라운드당 정확히 하나, 봉인이 열리기 전에 온체인에 ----------------------------------

export type AnchorDecision = {
  kind: "ANCHOR";
  roundId: number;
  head: string;
  entryCount: number;
  ticketCount: number;
  salesWei: bigint;
  /** null = 마감 때 직전 라운드가 아직 정산 전("PENDING"). 값은 직전 라운드의 carry-out 으로 정해진다. */
  carryInWei: bigint | null;
};
/** ADMIN/INCIDENT = 운영자가 마감 전에 요청, MISSED = 시스템이 결정 마감을 놓쳤다. */
export type VoidReason = "ADMIN" | "INCIDENT" | "MISSED";
export type VoidDecision = { kind: "VOID"; roundId: number; reason: VoidReason };
export type Decision = AnchorDecision | VoidDecision;

const VOID_REASONS: readonly VoidReason[] = ["ADMIN", "INCIDENT", "MISSED"];

export function decisionPayload(d: Decision): string {
  if (d.kind === "ANCHOR") {
    return [
      `${DOMAIN}/anchor`,
      int("roundId", d.roundId),
      sha("head", d.head),
      int("entryCount", d.entryCount),
      int("ticketCount", d.ticketCount),
      wei("salesWei", d.salesWei),
      d.carryInWei === null ? "PENDING" : wei("carryInWei", d.carryInWei),
    ].join("|");
  }
  if (!VOID_REASONS.includes(d.reason)) throw new Error(`bad void reason ${d.reason}`);
  return [`${DOMAIN}/void`, int("roundId", d.roundId), d.reason].join("|");
}

/** 온체인 calldata(utf8) → 결정. 형식이 조금이라도 다르면 null(= 결정 tx 로 인정하지 않는다). */
export function parseDecisionPayload(text: string): Decision | null {
  const parts = text.split("|");
  const nat = (s: string) => (/^(0|[1-9][0-9]*)$/.test(s) ? Number(s) : NaN);
  if (parts[0] === `${DOMAIN}/anchor` && parts.length === 7) {
    const [, roundId, head, entryCount, ticketCount, salesWei, carryInWei] = parts;
    const natText = /^(0|[1-9][0-9]*)$/;
    if (!SHA256_RE.test(head) || !natText.test(salesWei) || !(natText.test(carryInWei) || carryInWei === "PENDING")) {
      return null;
    }
    const d: AnchorDecision = {
      kind: "ANCHOR",
      roundId: nat(roundId),
      head,
      entryCount: nat(entryCount),
      ticketCount: nat(ticketCount),
      salesWei: BigInt(salesWei),
      carryInWei: carryInWei === "PENDING" ? null : BigInt(carryInWei),
    };
    if (![d.roundId, d.entryCount, d.ticketCount].every(Number.isSafeInteger)) return null;
    return decisionPayload(d) === text ? d : null;
  }
  if (parts[0] === `${DOMAIN}/void` && parts.length === 3) {
    const d: VoidDecision = { kind: "VOID", roundId: nat(parts[1]), reason: parts[2] as VoidReason };
    if (!Number.isSafeInteger(d.roundId) || !VOID_REASONS.includes(d.reason)) return null;
    return decisionPayload(d) === text ? d : null;
  }
  return null;
}

export function utf8ToHex(text: string): `0x${string}` {
  let out = "0x";
  for (const b of ENCODER.encode(text)) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

export function hexToUtf8(hex: string): string | null {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
