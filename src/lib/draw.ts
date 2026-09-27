// 당첨 숫자와 당첨 티켓을 정하는 규칙 — 순수 함수 하나.
//
// 서버 정산·서버 자체검증·브라우저 검증기·오프라인 CLI 가 전부 이 함수를 부른다. 두 벌로 나뉘는 순간
// "서버는 A 라는데 검증기는 B 라고 한다"가 생기고, 그러면 어느 쪽이 맞는지 아무도 모른다. 그래서
// 여기엔 I/O 도 시각도 난수도 없다.
//
// 규칙 (Rules 화면과 같은 문장):
//   당첨 숫자 W = (유효한 spin 의 합) mod 1000.  유효한 spin 이 하나도 없으면 0.
//   pick == W 인 티켓이 당첨이다 — **봉인 상태와 무관하게.** 공개 pick 은 결제·체인으로 확정된 값이고,
//   봉인이 무효라는 것은 "이 spin 은 합산에서 빠진다"는 뜻일 뿐이다. 무효가 될지 말지는 봉인하는 순간
//   (남의 spin 을 전혀 모르는 상태에서) 정해지므로, 일부러 무효를 만들어도 결과를 원하는 쪽으로 밀 수 없다.
//
// 봉인 판정 순서 (seq 오름차순으로, 첫 해당 항목이 이긴다):
//   ① 봉투(BAD_ARMOR / BAD_HEADER / WRONG_ROUND / WRONG_CHAIN)
//   ② DUPLICATE — 앞선 seq 와 같은 ciphertextHash. 암호문 복제로 spin 을 배수 합산하는 공격을 막는다
//      (정규 armor 만 받으므로 같은 봉인은 곧 같은 해시다).
//   ③ DECRYPT_FAILED  ④ MALFORMED(평문 형식 아님)  ⑤ VALID

import type { EnvelopeStatus } from "./envelope";
import type { SealOpening } from "./opening";

export type SealStatus = "VALID" | EnvelopeStatus | "DUPLICATE" | "DECRYPT_FAILED" | "MALFORMED";

export const PICK_RANGE = 1000;

export type DrawEntryInput = {
  seq: number;
  pick: number;
  qty: number;
  ciphertextHash: string;
  opening: SealOpening;
};

export type DrawEntryResult = {
  seq: number;
  sealStatus: SealStatus;
  /** 합산된 spin. VALID 가 아니면 null. */
  spin: number | null;
  isWinner: boolean;
};

export type DrawResult = {
  entries: DrawEntryResult[];
  validSpinCount: number;
  spinSum: number;
  winningNumber: number;
  winningTickets: number;
  winnerSeqs: number[];
};

export function resolveDraw(inputs: readonly DrawEntryInput[]): DrawResult {
  const seen = new Set<string>();
  const statuses: { sealStatus: SealStatus; spin: number | null }[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const e = inputs[i];
    // 이 값들은 체인에 묶여 온 것이다. 어긋났다면 입력을 만든 코드가 틀린 것이니 조용히 넘기지 않는다.
    if (e.seq !== i + 1) throw new Error(`entries must be seq 1..n in order (got ${e.seq} at ${i})`);
    if (!Number.isInteger(e.pick) || e.pick < 0 || e.pick >= PICK_RANGE) throw new Error(`seq ${e.seq}: bad pick`);
    if (!Number.isInteger(e.qty) || e.qty < 1 || e.qty > 10) throw new Error(`seq ${e.seq}: bad qty`);

    const firstTime = !seen.has(e.ciphertextHash);
    seen.add(e.ciphertextHash);

    const o = e.opening;
    if (o.kind === "HEADER_REJECTED") statuses.push({ sealStatus: o.status, spin: null });
    else if (!firstTime) statuses.push({ sealStatus: "DUPLICATE", spin: null });
    else if (o.kind === "DECRYPT_FAILED") statuses.push({ sealStatus: "DECRYPT_FAILED", spin: null });
    else if (o.kind === "MALFORMED") statuses.push({ sealStatus: "MALFORMED", spin: null });
    else {
      if (!Number.isInteger(o.spin) || o.spin < 0 || o.spin >= PICK_RANGE) throw new Error(`seq ${e.seq}: bad spin`);
      statuses.push({ sealStatus: "VALID", spin: o.spin });
    }
  }

  let spinSum = 0;
  let validSpinCount = 0;
  for (const s of statuses) {
    if (s.sealStatus === "VALID") {
      spinSum += s.spin!;
      validSpinCount++;
    }
  }
  const winningNumber = spinSum % PICK_RANGE;

  let winningTickets = 0;
  const winnerSeqs: number[] = [];
  const entries = inputs.map((e, i): DrawEntryResult => {
    const isWinner = e.pick === winningNumber;
    if (isWinner) {
      winningTickets += e.qty;
      winnerSeqs.push(e.seq);
    }
    return { seq: e.seq, sealStatus: statuses[i].sealStatus, spin: statuses[i].spin, isWinner };
  });

  return { entries, validSpinCount, spinSum, winningNumber, winningTickets, winnerSeqs };
}
