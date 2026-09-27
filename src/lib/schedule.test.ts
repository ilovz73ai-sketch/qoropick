import { describe, expect, it } from "vitest";
import { roundAfterTime } from "./drand";
import {
  checkRoundTimes,
  clockPhase,
  firstRoundTimes,
  nextRoundTimes,
  nextSundayDrawUtc,
  scheduleByName,
  TEST,
  WEEKLY,
} from "./schedule";

const MIN = 60_000;
const SUN_DRAW = Date.UTC(2026, 9, 4, 15, 0, 0); // 2026-10-04 (일) 15:00 UTC

describe("일요일 24:00 KST = 일요일 15:00 UTC", () => {
  it("KST 로 보면 월요일 00:00 이다", () => {
    const kst = new Date(SUN_DRAW + 9 * 60 * MIN);
    expect([kst.getUTCDay(), kst.getUTCHours(), kst.getUTCMinutes()]).toEqual([1, 0, 0]);
  });

  it("nextSundayDrawUtc: 경계 포함, 1ms 뒤면 다음 주", () => {
    expect(nextSundayDrawUtc(SUN_DRAW)).toBe(SUN_DRAW);
    expect(nextSundayDrawUtc(SUN_DRAW - 1)).toBe(SUN_DRAW);
    expect(nextSundayDrawUtc(SUN_DRAW + 1)).toBe(SUN_DRAW + 7 * 24 * 60 * MIN);
    // 같은 주 월요일·토요일·일요일 새벽에서 모두 그 일요일 15:00
    expect(nextSundayDrawUtc(Date.UTC(2026, 8, 28, 0, 0))).toBe(SUN_DRAW);
    expect(nextSundayDrawUtc(Date.UTC(2026, 9, 3, 23, 59))).toBe(SUN_DRAW);
    expect(nextSundayDrawUtc(Date.UTC(2026, 9, 4, 3, 0))).toBe(SUN_DRAW);
  });
});

describe("주간 라운드 시각", () => {
  const first = firstRoundTimes(WEEKLY, Date.UTC(2026, 8, 30, 9, 0));

  it("첫 라운드는 지금 열리고 다음 일요일 15:00 UTC 에 추첨한다", () => {
    expect(first.roundId).toBe(1);
    expect(first.drawAtMs).toBe(SUN_DRAW);
    expect(first.drandRound).toBe(32774212);
    expect(checkRoundTimes(first, WEEKLY)).toEqual([]);
  });

  it("마감 간격: 14:49 구매 시작 마감, 14:50 판매 마감, 14:52 lock, 14:59 결정 tx 마감", () => {
    expect(first.buyCloseAtMs).toBe(SUN_DRAW - 11 * MIN);
    expect(first.salesCloseAtMs).toBe(SUN_DRAW - 10 * MIN);
    expect(first.lockAtMs).toBe(SUN_DRAW - 8 * MIN);
    expect(first.anchorDeadlineMs).toBe(SUN_DRAW - 1 * MIN);
  });

  it("다음 라운드는 추첨 3시간 뒤(일 18:00 UTC)에 열리고 7일 뒤에 추첨한다", () => {
    const second = nextRoundTimes(WEEKLY, first);
    expect(second.roundId).toBe(2);
    expect(second.opensAtMs).toBe(SUN_DRAW + 3 * 60 * MIN);
    expect(new Date(second.opensAtMs).getUTCHours()).toBe(18);
    expect(second.drawAtMs).toBe(SUN_DRAW + 7 * 24 * 60 * MIN);
    expect(second.drandRound).toBe(roundAfterTime(second.drawAtMs));
    expect(checkRoundTimes(second, WEEKLY)).toEqual([]);
  });

  it("추첨 직전 1시간 안에 시작하면 그다음 주로 넘어간다", () => {
    const late = firstRoundTimes(WEEKLY, SUN_DRAW - 30 * MIN);
    expect(late.drawAtMs).toBe(SUN_DRAW + 7 * 24 * 60 * MIN);
  });
});

describe("clockPhase", () => {
  const t = firstRoundTimes(WEEKLY, Date.UTC(2026, 8, 30, 9, 0));
  it("경계에서 다음 단계로 넘어간다", () => {
    expect(clockPhase(t, t.opensAtMs - 1)).toBe("UPCOMING");
    expect(clockPhase(t, t.opensAtMs)).toBe("SELLING");
    expect(clockPhase(t, t.buyCloseAtMs - 1)).toBe("SELLING");
    expect(clockPhase(t, t.buyCloseAtMs)).toBe("LAST_CALL");
    expect(clockPhase(t, t.salesCloseAtMs)).toBe("CLOSING");
    expect(clockPhase(t, t.lockAtMs)).toBe("LOCKED");
    expect(clockPhase(t, t.drawAtMs - 1)).toBe("LOCKED");
    expect(clockPhase(t, t.drawAtMs)).toBe("DRAWING");
  });
});

describe("검증기용 불변식", () => {
  it("라운드 번호를 바꾸거나 정렬이 어긋나면 잡는다", () => {
    const t = firstRoundTimes(WEEKLY, Date.UTC(2026, 8, 30, 9, 0));
    expect(checkRoundTimes({ ...t, drandRound: t.drandRound - 1 })).toContain("drandRound must equal roundAfterTime(drawAt)");
    expect(checkRoundTimes({ ...t, drawAtMs: t.drawAtMs + 1000 }).length).toBeGreaterThan(0);
    expect(checkRoundTimes({ ...t, lockAtMs: t.anchorDeadlineMs + 1 }).length).toBeGreaterThan(0);
  });

  it("TEST 스케줄 라운드는 WEEKLY 정렬 검사를 통과하지 못한다", () => {
    const t = firstRoundTimes(TEST, Date.UTC(2026, 8, 30, 9, 3));
    expect(checkRoundTimes(t, TEST)).toEqual([]);
    expect(checkRoundTimes(t, WEEKLY).length).toBeGreaterThan(0);
  });

  it("scheduleByName", () => {
    expect(scheduleByName(undefined)).toBe(WEEKLY);
    expect(scheduleByName("test")).toBe(TEST);
    expect(() => scheduleByName("daily")).toThrow();
  });
});
