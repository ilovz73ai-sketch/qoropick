// 검증 번들 — 라운드를 처음부터 다시 계산하는 데 필요한 모든 것. 서버 없이도 이 파일 하나와
// 공개 체인(World Chain RPC)·drand 릴레이만으로 결과를 재현할 수 있어야 한다.
//
// 단계:
//  PREDRAW    결정 tx 채굴 직후. 규칙·항목(암호문 포함)·체인 헤드·결정 tx.
//  DRAW       추첨 직후. + 비콘, 개봉 결과, 판정, 돈 계산, 지급 계획.
//  SETTLEMENT 지급 완료. + 실제 지급 tx.
// 모든 금액은 10진 문자열(wei).

import type { OpeningCode } from "./opening";
import type { SealStatus } from "./draw";

export const BUNDLE_FORMAT = "qoropick-bundle/v1" as const;

export type BundleParams = {
  roundId: number;
  schedule: "weekly" | "test";
  chainId: number;
  wldToken: string;
  treasury: string;
  feeAddress: string;
  ticketPriceWei: string;
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

export type BundleEntry = {
  seq: number;
  address: string;
  pick: number;
  qty: number;
  payTxHash: string;
  payLogIndex: number;
  paidAtSec: number;
  ciphertext: string;
  ciphertextHash: string;
  chainHash: string;
};

export type BundleInbound = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTs: number;
  from: string;
  valueWei: string;
  disposition: "PENDING" | "ENTRY" | "REFUND" | "UNMATCHED" | "IGNORED";
  entrySeq: number | null;
};

export type BundleTransfer = { kind: "PRIZE" | "FEE" | "REFUND"; to: string; amountWei: string; dedupeKey: string };

export type BundlePayout = BundleTransfer & { status: string; txHash: string | null; blockTs: number | null };

export type Bundle = {
  format: typeof BUNDLE_FORMAT;
  stage: "PREDRAW" | "DRAW" | "SETTLEMENT";
  generatedAtMs: number;
  params: BundleParams;
  seed: string;
  carryInWei: string | null;
  head: string;
  entryCount: number;
  ticketCount: number;
  salesWei: string;
  decision: null | {
    kind: "ANCHOR" | "VOID";
    payload: string;
    txHash: string;
    blockNumber: number;
    blockTs: number;
  };
  entries: BundleEntry[];
  inbound: BundleInbound[];
  draw: null | {
    beacon: { round: number; signature: string; randomness: string };
    openings: { seq: number; opening: OpeningCode; spin: number | null }[];
    sealStatuses: SealStatus[];
    validSpinCount: number;
    spinSum: number;
    winningNumber: number;
    winningTickets: number;
    feeWei: string;
    potWei: string;
    prizePerTicketWei: string;
    prizesTotalWei: string;
    carryOutWei: string;
    transfers: BundleTransfer[];
  };
  payouts: BundlePayout[] | null;
};
