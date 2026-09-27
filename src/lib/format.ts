// 표기. **시각은 전부 UTC** — 사용자 기기의 시간대를 절대 쓰지 않는다.
//
// Intl/toLocaleString 대신 UTC getter 로 직접 조립한다: 서버(보통 UTC)와 브라우저(아무 시간대)가
// 같은 문자열을 내야 하이드레이션이 어긋나지 않고, 기기 로캘에 따라 "오전/오후"나 요일 표기가 바뀌지
// 않는다. 유일한 예외는 Timevault 입력 안내(그 도구가 기기 현지시간을 받는다) — localDateTimeInput().

import type { SealStatus } from "./draw";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const p2 = (n: number) => String(n).padStart(2, "0");

/** "15:00 UTC" / "15:00:07 UTC" */
export function utcTime(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return `${withSeconds ? `${hm}:${p2(d.getUTCSeconds())}` : hm} UTC`;
}

/** "Sun, Oct 4 · 15:00 UTC" */
export function utcShort(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()} · ${utcTime(ms)}`;
}

/** "Sun, Oct 4, 2026 · 15:00 UTC" */
export function utcLong(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${utcTime(ms)}`;
}

/** "2026-10-04 15:00:07 UTC" — 표·엑셀용(정렬 가능). */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(
    d.getUTCMinutes(),
  )}:${p2(d.getUTCSeconds())} UTC`;
}

/** "6d 04:12:09" / "04:12:09" / "12:09". 올림(0.2초 남았으면 1초로 보인다), 음수는 0. */
export function countdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${p2(h)}:${p2(m)}:${p2(s)}`;
  if (h > 0) return `${p2(h)}:${p2(m)}:${p2(s)}`;
  return `${p2(m)}:${p2(s)}`;
}

/**
 * Timevault 의 datetime-local 입력칸에 넣을 값 — **이 기기의** 현지 시각. 이 앱에서 현지 시각을 쓰는
 * 유일한 곳이다: 그 도구가 입력을 현지 시각으로 해석하기 때문이다(틀리게 넣으면 다른 drand 라운드로
 * 봉인되고, 미니앱이 붙여넣기 단계에서 WRONG_ROUND 로 거부한다).
 */
export function localDateTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export const pad3 = (n: number) => String(n).padStart(3, "0");

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function shortHash(hash: string, head = 8, tail = 6): string {
  const h = hash.startsWith("0x") ? hash.slice(2) : hash;
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export const SEAL_STATUS_LABEL: Record<SealStatus, string> = {
  VALID: "Counted",
  BAD_ARMOR: "Not a locked number",
  BAD_HEADER: "Unreadable lock",
  WRONG_ROUND: "Locked for another round",
  WRONG_CHAIN: "Locked on another network",
  DUPLICATE: "Copy of an earlier one",
  DECRYPT_FAILED: "Couldn't be opened",
  MALFORMED: "Not a number 0–999",
};
