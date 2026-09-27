// 봉인 봉투 검사 — 암호문을 **열지 않고** 확인할 수 있는 모든 것.
//
// 미니앱은 봉인을 하지 않는다(평문 spin 을 만들지도 보지도 않는다). 참가자가 Sealer 나 Timevault 에서
// 만든 암호문을 붙여넣을 뿐이다. 그래서 여기서 막아야 할 것은 셋이다:
//
//  1. **이미 열 수 있는 봉인** — 헤더의 라운드가 이 추첨의 라운드와 다르면(특히 과거 라운드면) 추첨 전에
//     누구나 열어 본다. 원본(qoropick)은 서버가 준 라운드를 믿고 봉인했고 헤더를 검사하지 않았다.
//  2. **같은 봉인의 복제** — spin 은 합산되므로 정직한 암호문을 k번 넣으면 그 spin 이 k배가 된다
//     (범위 1000에서 1000번이면 기여가 0이 되어 결과를 통째로 쥔다). tlock/age 암호문은 키 없이
//     다시 무작위화할 수 없으므로 "같은 봉인"은 곧 "같은 바이트"다 — 단, armor 는 공백·줄바꿈을
//     관대하게 받아서 같은 바이트가 다른 문자열이 될 수 있다. 그래서 **정규형(canonical)만** 받는다:
//     encodeArmor(decodeArmor(s)) === s. 그러면 문자열 해시가 곧 바이트 해시이고, 중복 판정이 새지 않는다.
//  3. **tlock 이 아닌 것 / 형식이 다른 것** — 스탠자가 정확히 하나, `tlock <라운드> <체인해시>` 여야 한다.
//
// 판정은 복호화 쪽(seal-crypto.ts)과 **같은 파서**(tlock-js readAge)를 쓴다. 검사기와 복호기가 헤더를
// 다르게 읽으면, 검사는 통과하고 복호화는 다른 라운드로 되는 틈이 생긴다.

import { Buffer } from "buffer";
import { decodeArmor, encodeArmor } from "tlock-js/age/armor";
import { readAge } from "tlock-js/age/age-reader-writer";
import { QUICKNET } from "./drand";

/** 봉투(헤더) 판정. 이 값이 VALID 가 아니면 그 봉인은 열어 볼 필요도 없이 무효다. */
export type EnvelopeStatus = "BAD_ARMOR" | "BAD_HEADER" | "WRONG_ROUND" | "WRONG_CHAIN";

export const MAX_ARMOR_CHARS = 2048;
const AGE_VERSION = "age-encryption.org/v1";
/** quicknet(G1 서명) 봉인의 스탠자 본문 = U(G2 압축점 96) + V(16) + W(16). */
const TLOCK_BODY_BYTES = 96 + 16 + 16;

export type Envelope = { drandRound: number; drandChainHash: string };

/**
 * 붙여넣은 텍스트를 정규형 armor 로 바꾼다(관대). 줄바꿈 CRLF, 앞뒤 공백, 마지막 줄바꿈 누락 같은
 * 복사·붙여넣기 흔적을 지운다. 바이트는 바뀌지 않는다 — 같은 봉인이 같은 문자열이 될 뿐이다.
 * 서버는 이 결과만 받는다(isCanonicalArmor).
 */
export function normalizeArmor(input: string): string | null {
  try {
    const text = input.replace(/\r\n?/g, "\n").trim();
    return encodeArmor(decodeArmor(text));
  } catch {
    return null;
  }
}

/** 서버 쪽 엄격 검사: 이미 정규형인가. */
export function isCanonicalArmor(armored: string): boolean {
  if (armored.length === 0 || armored.length > MAX_ARMOR_CHARS) return false;
  try {
    return encodeArmor(decodeArmor(armored)) === armored;
  } catch {
    return false;
  }
}

/** 정규형 armor 의 헤더를 읽는다. 복호화 없이 알 수 있는 것만. */
export function parseEnvelope(armored: string): { ok: true; envelope: Envelope } | { ok: false; status: EnvelopeStatus } {
  if (!isCanonicalArmor(armored)) return { ok: false, status: "BAD_ARMOR" };
  let parsed: ReturnType<typeof readAge>;
  try {
    parsed = readAge(decodeArmor(armored));
  } catch {
    return { ok: false, status: "BAD_HEADER" };
  }
  if (parsed.header.version !== AGE_VERSION) return { ok: false, status: "BAD_HEADER" };
  const stanzas = parsed.header.recipients;
  // 스탠자가 둘 이상이면 복호기가 어느 것을 쓸지(첫 tlock?)에 판정이 기대게 된다. 애초에 받지 않는다.
  if (stanzas.length !== 1) return { ok: false, status: "BAD_HEADER" };
  const [stanza] = stanzas;
  if (stanza.type !== "tlock" || stanza.args.length !== 2) return { ok: false, status: "BAD_HEADER" };
  const [roundText, chainHash] = stanza.args;
  // parseInt 는 "123abc", "0123" 도 받는다. 라운드는 문자열 그대로 정규 10진이어야 한다.
  if (!/^[1-9][0-9]{0,15}$/.test(roundText)) return { ok: false, status: "BAD_HEADER" };
  if (!/^[0-9a-f]{64}$/.test(chainHash)) return { ok: false, status: "BAD_HEADER" };
  if (stanza.body.length !== TLOCK_BODY_BYTES) return { ok: false, status: "BAD_HEADER" };
  const drandRound = Number(roundText);
  if (!Number.isSafeInteger(drandRound)) return { ok: false, status: "BAD_HEADER" };
  return { ok: true, envelope: { drandRound, drandChainHash: chainHash } };
}

/** 이 추첨(라운드 R, quicknet)의 봉투로서 유효한가. */
export function checkEnvelope(
  armored: string,
  expected: { drandRound: number },
): { ok: true } | { ok: false; status: EnvelopeStatus; found?: Envelope } {
  const parsed = parseEnvelope(armored);
  if (!parsed.ok) return parsed;
  const { envelope } = parsed;
  if (envelope.drandChainHash !== QUICKNET.chainHash) return { ok: false, status: "WRONG_CHAIN", found: envelope };
  if (envelope.drandRound !== expected.drandRound) return { ok: false, status: "WRONG_ROUND", found: envelope };
  return { ok: true };
}

/**
 * 복호화된 바이트 → spin. 규칙은 공개되어 누구나 같은 결과를 낸다:
 * ASCII 만(64바이트 이하), 앞뒤 ASCII 공백 제거, 숫자 1~3자리("7", "007", "482"), 0~999.
 * Timevault 사용자가 손으로 타이핑할 수 있어야 해서 형식을 최소로 뒀다.
 */
export function parseSpinPlaintext(bytes: Uint8Array): number | null {
  if (bytes.length === 0 || bytes.length > 64) return null;
  for (const b of bytes) if (b > 0x7f) return null;
  const text = String.fromCharCode(...bytes).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (!/^[0-9]{1,3}$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** Sealer 가 봉인하는 평문. 가장 단순한 형식(parseSpinPlaintext 의 정규 입력). */
export function spinPlaintext(spin: number): string {
  if (!Number.isInteger(spin) || spin < 0 || spin > 999) throw new Error("spin must be an integer 0..999");
  return String(spin);
}

// ---- 전달 형식: 딥링크에 실을 때 --------------------------------------------------------------
// armor 는 줄바꿈이 있어 URL 에 싣기 불편하다. 바이트를 base64url 로 보내고 받는 쪽에서 정규 armor 로
// 되돌린다. 정규형이 유일하므로 왕복해도 같은 문자열·같은 해시다.

export function armorToBase64Url(armored: string): string {
  const binary = decodeArmor(armored);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToArmor(b64url: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(b64url)) return null;
  try {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const binary = Buffer.from(b64, "base64").toString("binary");
    const armored = encodeArmor(binary);
    return isCanonicalArmor(armored) ? armored : null;
  } catch {
    return null;
  }
}

/** 사람이 눈으로 대조하는 지문: ciphertextHash 앞 8자리를 4-4로. */
export function fingerprint(ciphertextHash: string): string {
  return `${ciphertextHash.slice(0, 4)}·${ciphertextHash.slice(4, 8)}`;
}
