import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { decodeArmor, encodeArmor } from "tlock-js/age/armor";
import fixture from "../../fixtures/beacon-30000000.json";
import { verifyBeacon } from "./beacon";
import { QUICKNET } from "./drand";
import {
  armorToBase64Url,
  base64UrlToArmor,
  checkEnvelope,
  isCanonicalArmor,
  normalizeArmor,
  parseEnvelope,
  parseSpinPlaintext,
} from "./envelope";
import { openSeal, sealSpin } from "./seal-crypto";

// 과거 라운드에 봉인하면 실제 비콘(fixture)으로 네트워크 없이 열어 볼 수 있다.
const R = fixture.round;
const beacon = verifyBeacon(fixture);

function rewriteHeader(armored: string, edit: (header: string) => string): string {
  const binary = decodeArmor(armored);
  const macAt = binary.indexOf("\n--- ");
  return encodeArmor(edit(binary.slice(0, macAt)) + binary.slice(macAt));
}

describe("sealSpin / openSeal 왕복", () => {
  it("봉인한 spin 이 그대로 열린다", async () => {
    for (const spin of [0, 7, 482, 999]) {
      const sealed = await sealSpin(R, spin);
      expect(isCanonicalArmor(sealed)).toBe(true);
      expect(await openSeal(sealed, R, beacon)).toEqual({ kind: "SPIN", spin });
    }
  });

  it("같은 spin 이라도 봉인할 때마다 암호문이 다르다 (무작위 봉인)", async () => {
    const a = await sealSpin(R, 482);
    const b = await sealSpin(R, 482);
    expect(a).not.toBe(b);
  });

  it("봉인 라운드와 다른 라운드로 열라고 하면 헤더에서 거부된다", async () => {
    const sealed = await sealSpin(R, 5);
    expect(await openSeal(sealed, R + 1, beacon)).toEqual({ kind: "HEADER_REJECTED", status: "WRONG_ROUND" });
  });

  it("본문을 건드리면 복호화 실패다", async () => {
    const sealed = await sealSpin(R, 5);
    const binary = decodeArmor(sealed);
    const tampered = encodeArmor(binary.slice(0, -1) + String.fromCharCode(binary.charCodeAt(binary.length - 1) ^ 1));
    expect(await openSeal(tampered, R, beacon)).toEqual({ kind: "DECRYPT_FAILED" });
  });
});

describe("봉투 검사", () => {
  it("라운드·체인을 헤더에서 읽는다", async () => {
    const sealed = await sealSpin(R, 1);
    expect(parseEnvelope(sealed)).toEqual({ ok: true, envelope: { drandRound: R, drandChainHash: QUICKNET.chainHash } });
    expect(checkEnvelope(sealed, { drandRound: R })).toEqual({ ok: true });
    expect(checkEnvelope(sealed, { drandRound: R + 1 })).toMatchObject({ ok: false, status: "WRONG_ROUND" });
  });

  it("다른 체인 해시는 WRONG_CHAIN", async () => {
    const sealed = await sealSpin(R, 1);
    const other = rewriteHeader(sealed, (h) => h.replace(QUICKNET.chainHash, "ab".repeat(32)));
    expect(checkEnvelope(other, { drandRound: R })).toMatchObject({ ok: false, status: "WRONG_CHAIN" });
  });

  it("라운드 표기가 정규 10진이 아니면 BAD_HEADER (parseInt 가 받는 '0123' 등)", async () => {
    const sealed = await sealSpin(R, 1);
    for (const bad of [`0${R}`, `${R}abc`, `+${R}`]) {
      const other = rewriteHeader(sealed, (h) => h.replace(`tlock ${R} `, `tlock ${bad} `));
      expect(parseEnvelope(other)).toEqual({ ok: false, status: "BAD_HEADER" });
    }
  });

  it("스탠자가 둘이면 BAD_HEADER", async () => {
    const sealed = await sealSpin(R, 1);
    const doubled = rewriteHeader(sealed, (h) => {
      const [version, ...rest] = h.split("\n");
      return [version, ...rest, ...rest].join("\n");
    });
    expect(parseEnvelope(doubled)).toEqual({ ok: false, status: "BAD_HEADER" });
  });

  it("공백·줄바꿈이 다른 armor 는 거부하되, normalize 하면 같은 문자열이 된다", async () => {
    const sealed = await sealSpin(R, 1);
    const messy = "  " + sealed.replace(/\n/g, "\r\n") + "\n\n";
    expect(isCanonicalArmor(messy)).toBe(false);
    expect(parseEnvelope(messy)).toEqual({ ok: false, status: "BAD_ARMOR" });
    expect(normalizeArmor(messy)).toBe(sealed);
  });

  it("armor 가 아닌 것은 BAD_ARMOR", () => {
    expect(parseEnvelope("hello")).toEqual({ ok: false, status: "BAD_ARMOR" });
    expect(normalizeArmor("hello")).toBeNull();
  });

  it("base64url 왕복이 같은 정규 armor 를 준다", async () => {
    const sealed = await sealSpin(R, 321);
    const b64 = armorToBase64Url(sealed);
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlToArmor(b64)).toBe(sealed);
    expect(base64UrlToArmor("not valid!")).toBeNull();
  });
});

describe("parseSpinPlaintext", () => {
  const p = (s: string) => parseSpinPlaintext(Buffer.from(s, "utf8"));
  it("Timevault 로 손으로 친 값도 받는다", () => {
    expect(p("482")).toBe(482);
    expect(p(" 007\n")).toBe(7);
    expect(p("0")).toBe(0);
    expect(p("999")).toBe(999);
  });
  it("형식이 다르면 null", () => {
    for (const bad of ["", "1000", "0482", "12a", "-1", "4 82", "1.5", "٤٨٢", "482 WLD"]) expect(p(bad)).toBeNull();
  });
});
