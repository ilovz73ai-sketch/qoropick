// 봉인 하나를 연 결과와 그 DB 표기. 판정(draw.ts)의 입력이다.
//
// 개봉(seal-crypto.ts, 무거움)과 판정(draw.ts, 가벼움·동기)을 나눈 이유: 개봉은 페어링 연산이라
// 수천 장이면 여러 tick 에 걸쳐 조금씩 하고 결과를 DB 에 쌓는다. 판정은 그 결과 전체를 한 번에 보고
// 순수 함수로 정한다 — 서버·브라우저 검증기·CLI 가 같은 판정 함수를 부른다.

import type { EnvelopeStatus } from "./envelope";

export type SealOpening =
  | { kind: "HEADER_REJECTED"; status: EnvelopeStatus }
  | { kind: "DECRYPT_FAILED" }
  | { kind: "MALFORMED" }
  | { kind: "SPIN"; spin: number };

/** DB 컬럼 entries.opening 의 값. SPIN 일 때만 opened_spin 이 채워진다. */
export type OpeningCode = EnvelopeStatus | "DECRYPT_FAILED" | "MALFORMED" | "SPIN";

export const OPENING_CODES: readonly OpeningCode[] = [
  "BAD_ARMOR",
  "BAD_HEADER",
  "WRONG_ROUND",
  "WRONG_CHAIN",
  "DECRYPT_FAILED",
  "MALFORMED",
  "SPIN",
];

export function openingToRow(o: SealOpening): { opening: OpeningCode; openedSpin: number | null } {
  switch (o.kind) {
    case "HEADER_REJECTED":
      return { opening: o.status, openedSpin: null };
    case "DECRYPT_FAILED":
      return { opening: "DECRYPT_FAILED", openedSpin: null };
    case "MALFORMED":
      return { opening: "MALFORMED", openedSpin: null };
    case "SPIN":
      return { opening: "SPIN", openedSpin: o.spin };
  }
}

export function openingFromRow(opening: string, openedSpin: number | null): SealOpening {
  switch (opening) {
    case "BAD_ARMOR":
    case "BAD_HEADER":
    case "WRONG_ROUND":
    case "WRONG_CHAIN":
      return { kind: "HEADER_REJECTED", status: opening };
    case "DECRYPT_FAILED":
      return { kind: "DECRYPT_FAILED" };
    case "MALFORMED":
      return { kind: "MALFORMED" };
    case "SPIN":
      if (openedSpin === null || !Number.isInteger(openedSpin) || openedSpin < 0 || openedSpin > 999) {
        throw new Error(`opening SPIN needs a spin 0..999 (got ${openedSpin})`);
      }
      return { kind: "SPIN", spin: openedSpin };
    default:
      throw new Error(`unknown opening code ${opening}`);
  }
}
