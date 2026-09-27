import { describe, expect, it } from "vitest";
import vectors from "../../fixtures/chain-vectors.json";
import {
  decisionPayload,
  hexToUtf8,
  nextChainHash,
  parseDecisionPayload,
  roundSeed,
  seedPreimage,
  sha256Hex,
  utf8ToHex,
  verifyChain,
  type RoundParams,
} from "./chain";

const params: RoundParams = { ...vectors.params, ticketPriceWei: BigInt(vectors.params.ticketPriceWei) };

describe("sha256Hex", () => {
  it("표준 벡터", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("공유 벡터 (SQL 테스트도 같은 파일을 읽는다)", () => {
  it("seed 와 각 고리·헤드가 벡터와 같다", () => {
    expect(seedPreimage(params)).toBe(vectors.seedPreimage);
    expect(roundSeed(params)).toBe(vectors.seed);
    let head = vectors.seed;
    for (const l of vectors.links) {
      head = nextChainHash(head, l);
      expect(head).toBe(l.chainHash);
    }
    expect(head).toBe(vectors.head);
    expect(verifyChain(vectors.seed, vectors.links, vectors.head)).toEqual({ ok: true, head: vectors.head });
  });
});

describe("변조 탐지", () => {
  const links = vectors.links;
  it("공개 pick 을 사후에 바꾸면 그 고리에서 깨진다 (원본 qoropick 의 구멍)", () => {
    const tampered = links.map((l) => (l.seq === 2 ? { ...l, pick: 998 } : l));
    expect(verifyChain(vectors.seed, tampered, vectors.head)).toMatchObject({ ok: false, failedAtSeq: 2 });
  });
  it("항목 삭제(중간) = seq 틈, 끝 삭제 = 헤드 불일치", () => {
    expect(verifyChain(vectors.seed, [links[0], links[2]], vectors.head)).toMatchObject({ ok: false, failedAtSeq: 3 });
    expect(verifyChain(vectors.seed, links.slice(0, 2), vectors.head)).toMatchObject({ ok: false, failedAtSeq: null });
  });
  it("다른 라운드 규칙(seed)으로는 같은 고리가 이어지지 않는다", () => {
    const otherSeed = roundSeed({ ...params, feeBps: 400 });
    expect(verifyChain(otherSeed, links, vectors.head)).toMatchObject({ ok: false, failedAtSeq: 1 });
  });
  it("대문자 주소·0x 붙은 해시 같은 비정규 형식은 해시 전에 거부", () => {
    expect(() => nextChainHash(vectors.seed, { ...links[0], address: links[0].address.toUpperCase().replace("0X", "0x") })).toThrow();
    expect(() => nextChainHash(vectors.seed, { ...links[0], ciphertextHash: "0x" + links[0].ciphertextHash })).toThrow();
    expect(() => nextChainHash(vectors.seed, { ...links[0], pick: 1000 })).toThrow();
  });
});

describe("결정 tx payload", () => {
  const anchor = {
    kind: "ANCHOR" as const,
    roundId: 12,
    head: vectors.head,
    entryCount: 3,
    ticketCount: 14,
    salesWei: 14n * 10n ** 18n,
    carryInWei: 123n,
  };
  it("왕복", () => {
    const text = decisionPayload(anchor);
    expect(text).toBe(`qoropick/v1/anchor|12|${vectors.head}|3|14|14000000000000000000|123`);
    expect(parseDecisionPayload(text)).toEqual(anchor);
    expect(hexToUtf8(utf8ToHex(text))).toBe(text);
    const v = decisionPayload({ kind: "VOID", roundId: 12, reason: "MISSED" });
    expect(parseDecisionPayload(v)).toEqual({ kind: "VOID", roundId: 12, reason: "MISSED" });
  });
  it("조금이라도 다르면 결정으로 인정하지 않는다", () => {
    const text = decisionPayload(anchor);
    for (const bad of [text + "|", text.replace("|12|", "|012|"), text.toUpperCase(), "qoropick/v1/void|12|NOPE", ""]) {
      expect(parseDecisionPayload(bad)).toBeNull();
    }
  });
});
