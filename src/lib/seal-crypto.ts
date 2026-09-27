// 봉인하고 여는 암호 부분. 무겁다(BLS12-381 페어링) — Sealer, 서버 정산, 검증기만 import 한다.
// 미니앱 화면은 envelope.ts(가벼움)만 쓴다.
//
// 네트워크를 전혀 쓰지 않는다:
//  - 봉인: tlock-js 가 체인 정보(공개키)를 HTTP 로 받는 대신, 고정된 quicknet 정보를 주는 오프라인
//    클라이언트를 넘긴다. Sealer 페이지가 CSP `connect-src 'none'` 로도 동작하는 이유다.
//  - 개봉: tlock-js 의 timelockDecrypt 는 봉인마다 비콘을 다시 받아 다시 검증하고, **로컬 시계가
//    라운드보다 이르면** 실패하며, 비콘을 console.log 한다. 시계가 느린 검증자 기기에서는 정직한 표가
//    "복호화 실패"로 보이게 된다. 그래서 age/IBE 단계를 직접 부르고, 이미 검증된 서명 하나만 쓴다.

import { Buffer } from "buffer";
import { defaultChainInfo, timelockEncrypt } from "tlock-js";
import { decryptAge, type Stanza } from "tlock-js/age/age-encrypt-decrypt";
import { decodeArmor } from "tlock-js/age/armor";
import { decryptOnG2 } from "tlock-js/crypto/ibe";
import type { VerifiedBeacon } from "./beacon";
import { QUICKNET } from "./drand";
import { checkEnvelope, normalizeArmor, parseSpinPlaintext, spinPlaintext } from "./envelope";
import type { SealOpening } from "./opening";

export type { SealOpening } from "./opening";

type ChainClient = Parameters<typeof timelockEncrypt>[2];

// 봉인에 필요한 것은 chain().info() 뿐이다. 나머지는 호출되면 안 되므로 던진다.
const offlineQuicknet = {
  options: {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: { chainHash: QUICKNET.chainHash, publicKey: QUICKNET.publicKey },
  },
  chain: () => ({ baseUrl: "offline:quicknet", info: async () => defaultChainInfo }),
  latest: async () => {
    throw new Error("offline client: no network");
  },
  get: async () => {
    throw new Error("offline client: no network");
  },
} as unknown as ChainClient;

/** spin 을 drand 라운드에 봉인한다. 결과는 정규형 armor(서버가 받는 그대로의 문자열). */
export async function sealSpin(drandRound: number, spin: number): Promise<string> {
  if (!Number.isSafeInteger(drandRound) || drandRound < 1) throw new Error("bad drand round");
  const armored = await timelockEncrypt(drandRound, Buffer.from(spinPlaintext(spin), "utf8"), offlineQuicknet);
  const canonical = normalizeArmor(armored);
  // tlock-js 의 출력은 이미 정규형이어야 한다. 아니면 라이브러리 동작이 바뀐 것이다 — 조용히 넘기면
  // 서버가 봉인을 거부하는데 사용자는 이유를 모른다.
  if (canonical !== armored) throw new Error("tlock-js produced a non-canonical armor");
  return armored;
}

/**
 * 검증된 비콘으로 봉인을 연다. 네트워크·시계를 쓰지 않으므로 같은 입력이면 어디서 돌려도 같은 결과다.
 * 던지지 않는다 — 참가자 한 명의 쓰레기 봉인이 추첨 전체를 멈추면 안 된다.
 */
export async function openSeal(armored: string, drandRound: number, beacon: VerifiedBeacon): Promise<SealOpening> {
  const envelope = checkEnvelope(armored, { drandRound });
  if (!envelope.ok) return { kind: "HEADER_REJECTED", status: envelope.status };
  if (beacon.round !== drandRound) throw new Error(`beacon round ${beacon.round} ≠ seal round ${drandRound}`);

  const signature = Buffer.from(beacon.signature, "hex");
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptAge(decodeArmor(armored), async (recipients: Stanza[]) => {
      // checkEnvelope 가 이미 "tlock 스탠자 정확히 1개"를 보장했다.
      const body = recipients[0].body;
      const U = body.subarray(0, 96);
      const V = body.subarray(96, 112);
      const W = body.subarray(112, 128);
      return decryptOnG2(signature, { U, V, W });
    });
  } catch {
    return { kind: "DECRYPT_FAILED" };
  }
  const spin = parseSpinPlaintext(plaintext);
  return spin === null ? { kind: "MALFORMED" } : { kind: "SPIN", spin };
}
