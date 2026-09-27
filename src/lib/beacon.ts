// drand 비콘 — 봉인을 여는 열쇠. 받아 오고, **공개키로 검증한다.**
//
// 왜 한 번만 받아 검증하나: 원본(qoropick)은 봉인 하나를 열 때마다 tlock-js 가 api.drand.sh 에
// 두 번씩 요청했다. 수천 장이면 레이트리밋(429)에 걸리고, 그 네트워크 오류가 "복호화 실패"로 기록돼
// 정직한 표가 **영구히** 무효가 됐다. 여기서는 비콘을 한 번 받아 BLS 서명을 직접 검증하고
// (VerifiedBeacon), 이후 복호화는 네트워크 없이 그 서명만 쓴다(seal-crypto.ts). 네트워크 실패는
// "아직 못 받음"일 뿐 어떤 표의 운명도 바꾸지 않는다.

import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { QUICKNET, RELAYS } from "./drand";

export type Beacon = {
  round: number;
  /** G1 서명(hex, 48바이트 압축점). 이것이 그 라운드 봉인들의 복호화 키다. */
  signature: string;
  /** sha256(signature). 이 앱의 당첨 계산에는 쓰지 않는다 — 기록·대조용. */
  randomness: string;
};

declare const verified: unique symbol;
/** verifyBeacon 을 통과한 비콘. 검증 안 된 서명이 복호화에 흘러가는 것을 타입으로 막는다. */
export type VerifiedBeacon = Beacon & { readonly [verified]: true };

// quicknet 은 RFC 9380 해시-투-커브를 G1 에서 쓴다. drand-client 의 verifyBeacon 과 같은 식이다
// (그쪽은 index 에서 export 되지 않아 직접 옮겼다 — beacon.test.ts 가 실제 비콘으로 대조한다).
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

function u64be(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n));
  return buf;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("not lowercase hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 서명이 quicknet 공개키로 그 라운드에 대해 유효하고 randomness 가 서명의 해시인지. 실패면 던진다. */
export function verifyBeacon(beacon: Beacon): VerifiedBeacon {
  const sig = beacon.signature.toLowerCase();
  if (!/^[0-9a-f]{96}$/.test(sig)) throw new Error(`beacon ${beacon.round}: signature is not 48 bytes of hex`);
  if (!Number.isSafeInteger(beacon.round) || beacon.round < 1) throw new Error("beacon: bad round");

  const expectedRandomness = bytesToHex(sha256(hexToBytes(sig)));
  if (beacon.randomness.toLowerCase() !== expectedRandomness) {
    throw new Error(`beacon ${beacon.round}: randomness does not match sha256(signature)`);
  }

  const { G1, G2, pairing, fields } = bls12_381;
  const message = sha256(u64be(beacon.round));
  const hm = G1.hashToCurve(message, { DST });
  const pk = G2.ProjectivePoint.fromHex(QUICKNET.publicKey);
  const s = G1.ProjectivePoint.fromHex(sig);
  // e(S, G2) · e(H(m), −PK) == 1  ⇔  e(S, G2) == e(H(m), PK)
  const lhs = pairing(s, G2.ProjectivePoint.BASE, true);
  const rhs = pairing(hm as unknown as typeof s, pk.negate(), true);
  if (!fields.Fp12.eql(fields.Fp12.mul(lhs, rhs), fields.Fp12.ONE)) {
    throw new Error(`beacon ${beacon.round}: BLS signature does not verify against the quicknet public key`);
  }
  return { round: beacon.round, signature: sig, randomness: expectedRandomness } as VerifiedBeacon;
}

export class BeaconNotYetAvailable extends Error {}

/** 릴레이 하나에서 원본 비콘을 받는다(검증 전). 404 는 "아직 안 나옴"이다. */
export async function fetchBeacon(round: number, relay: string, signal?: AbortSignal): Promise<Beacon> {
  const res = await fetch(`${relay}/${QUICKNET.chainHash}/public/${round}`, { signal, cache: "no-store" });
  if (res.status === 404 || res.status === 425) throw new BeaconNotYetAvailable(`round ${round} not yet published`);
  if (!res.ok) throw new Error(`beacon ${round} @ ${relay}: HTTP ${res.status}`);
  const json = (await res.json()) as Partial<Beacon>;
  if (typeof json.signature !== "string" || typeof json.round !== "number" || typeof json.randomness !== "string") {
    throw new Error(`beacon ${round} @ ${relay}: unexpected response shape`);
  }
  if (json.round !== round) throw new Error(`beacon ${round} @ ${relay}: got round ${json.round}`);
  return { round: json.round, signature: json.signature, randomness: json.randomness };
}

export type RelayReport = { relay: string; ok: boolean; signature?: string; error?: string };

/**
 * 모든 릴레이에서 받아 **검증된** 비콘을 돌려준다. 아무 데서도 못 받았으면 null (아직 발행 전이거나
 * 네트워크 문제 — 다음 tick 에 다시 시도하면 된다).
 *
 * 검증을 통과한 서명이 둘 이상 서로 다르면 던진다: BLS 서명은 (메시지, 키)에 대해 유일하므로
 * 그런 일은 수학적으로 불가능하고, 일어났다면 검증 코드가 깨진 것이다 — 조용히 넘어가면 안 된다.
 */
export async function fetchVerifiedBeacon(
  round: number,
  opts: { relays?: readonly string[]; timeoutMs?: number } = {},
): Promise<{ beacon: VerifiedBeacon | null; reports: RelayReport[] }> {
  const relays = opts.relays ?? RELAYS;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const reports = await Promise.all(
    relays.map(async (relay): Promise<RelayReport & { verified?: VerifiedBeacon }> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const raw = await fetchBeacon(round, relay, ctl.signal);
        const v = verifyBeacon(raw);
        return { relay, ok: true, signature: v.signature, verified: v };
      } catch (err) {
        return { relay, ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const good = reports.filter((r) => r.verified);
  const distinct = new Set(good.map((r) => r.signature));
  if (distinct.size > 1) throw new Error(`round ${round}: relays returned different VERIFIED signatures`);
  return {
    beacon: good[0]?.verified ?? null,
    reports: reports.map(({ relay, ok, signature, error }) => ({ relay, ok, signature, error })),
  };
}
