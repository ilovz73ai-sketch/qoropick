import { describe, expect, it } from "vitest";
import { countdown, pad3, shortAddress, utcLong, utcShort, utcStamp, utcTime } from "./format";

const T = Date.UTC(2026, 9, 4, 15, 0, 7);

describe("UTC 표기 (기기 시간대 무관)", () => {
  it("형식", () => {
    expect(utcTime(T)).toBe("15:00 UTC");
    expect(utcTime(T, true)).toBe("15:00:07 UTC");
    expect(utcShort(T)).toBe("Sun, Oct 4 · 15:00 UTC");
    expect(utcLong(T)).toBe("Sun, Oct 4, 2026 · 15:00 UTC");
    expect(utcStamp(T)).toBe("2026-10-04 15:00:07 UTC");
  });
  it("countdown", () => {
    expect(countdown(0)).toBe("00:00");
    expect(countdown(-5)).toBe("00:00");
    expect(countdown(200)).toBe("00:01");
    expect(countdown(65_000)).toBe("01:05");
    expect(countdown(3_600_000)).toBe("01:00:00");
    expect(countdown(6 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000 + 9_000)).toBe("6d 04:12:09");
  });
  it("기타", () => {
    expect(pad3(7)).toBe("007");
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
