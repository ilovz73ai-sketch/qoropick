// drand quicknet — 추첨의 시계이자 봉인의 열쇠.
//
// 왜 quicknet 인가: League of Entropy 메인넷에서 **타임락 암호화를 지원하는 유일한 체인**이다
// (G1 서명 + bls-unchained-g1-rfc9380).
//
// 왜 상수를 여기 직접 적었나: 원본(qoropick)은 tlock-js 의 defaultChainInfo 를 import 했지만, 그러면
// 카운트다운만 필요한 화면까지 페어링 암호 라이브러리 전체를 끌고 온다(이 앱의 미니앱 번들은 봉인을
// 하지 않는다 — 봉인은 Sealer 에서만 일어난다). 대신 drand.test.ts 가 tlock-js 의 값과 **한 글자도
// 다르지 않은지** 못 박는다. 라이브러리가 실제 봉인에 쓰는 값과 여기 값이 어긋날 여지는 그대로 없다.

export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTimeMs: 1692803367_000,
  periodMs: 3000,
  schemeId: "bls-unchained-g1-rfc9380",
} as const;

/** 라운드 r 이 발행되는 시각(ms). r=1 이 genesis 다. */
export function roundEmissionMs(round: number): number {
  return QUICKNET.genesisTimeMs + (round - 1) * QUICKNET.periodMs;
}

/**
 * 시각 t **이후**(같은 순간 포함) 처음 발행되는 라운드.
 *
 * ⚠ drand-client 의 roundAt() 을 쓰면 안 된다. 그쪽은 floor(...)+1 이라 "t 시점에 **이미 나온**
 *   마지막 라운드"를 준다 — 그 값으로 봉인하면 추첨 전에 누구나 열 수 있다. 암호는 멀쩡히 동작하고
 *   결과만 조작 가능해지는, 가장 나쁜 종류의 실패다.
 *   (quicknet 의 genesis 는 3초의 배수라 **UTC 정각 분은 언제나 라운드 경계**다. 그래서 추첨 시각
 *   15:00:00 에서는 두 함수가 같은 값을 준다 — Timevault 처럼 roundAt 을 쓰는 외부 도구로 봉인해도
 *   맞는 라운드가 나오는 이유다. 경계가 아닌 시각에서는 여전히 이 함수만 옳다.)
 *
 * 불변식: roundEmissionMs(r) >= t 이고 roundEmissionMs(r-1) < t.
 */
export function roundAfterTime(timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error("roundAfterTime: time must be finite");
  if (timeMs < QUICKNET.genesisTimeMs) throw new Error("roundAfterTime: no rounds before genesis");
  return Math.ceil((timeMs - QUICKNET.genesisTimeMs) / QUICKNET.periodMs) + 1;
}

// 운영 주체가 다른 두 릴레이. 비콘은 공개키로 BLS 검증하므로 하나만 있어도 진위는 확정되지만,
// 둘이 같은 서명을 준다는 사실은 암호를 모르는 사람도 이해할 수 있는 증거라 검증 화면이 보여 준다.
export const RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com"] as const;
