// 라운드 스케줄 — 매주 일요일 24:00 KST(= 월 00:00 KST = **일요일 15:00 UTC**) 추첨.
//
// 앱은 모든 시각을 UTC 로 표기한다. KST 는 서머타임이 없으므로 "일요일 15:00 UTC"는 1년 내내 같은
// 순간을 가리킨다 — 그래서 스케줄은 UTC 산술만으로 충분하고, 시간대 라이브러리를 쓰지 않는다.
//
// 추첨 시각 앞의 간격들이 공정성의 뼈대다(자세한 이유는 AGENTS.md):
//   buyClose   구매 시작 마감. 결제 승인에 1분 여유를 준다.
//   salesClose 결제 블록 시각이 이보다 앞서야 유효하다(온체인 사실이라 운영자도 못 바꾼다).
//   lock       DB 시계로 이후 어떤 항목도 붙지 않는다. 이어서 결정 tx(체인 헤드 앵커)를 보낸다.
//   anchorDeadline 결정 tx 의 블록 시각 상한. 넘기면 라운드 VOID(전액 환불).
//   draw       drand 라운드가 공개되어 봉인이 열린다. 정각 분이라 항상 drand 라운드 경계다.

import { roundAfterTime } from "./drand";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type ScheduleName = "weekly" | "test";

export type ScheduleConfig = {
  name: ScheduleName;
  /** 추첨 간격 */
  periodMs: number;
  /** 추첨 → 다음 라운드 오픈 */
  breakMs: number;
  /** 모두 "추첨 몇 ms 전" */
  leads: { buyClose: number; salesClose: number; lock: number; anchorDeadline: number };
  /** 첫 라운드는 최소 이만큼 판매한다 */
  minFirstRoundMs: number;
  /** t 이상인 첫 정렬된 추첨 시각 */
  alignDraw: (tMs: number) => number;
  isAlignedDraw: (drawAtMs: number) => boolean;
};

/** t 이상인 첫 "일요일 15:00:00.000 UTC". */
export function nextSundayDrawUtc(tMs: number): number {
  const d = new Date(tMs);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0, 0);
  const daysUntilSunday = (7 - d.getUTCDay()) % 7;
  let candidate = base + daysUntilSunday * DAY;
  if (candidate < tMs) candidate += 7 * DAY;
  return candidate;
}

export const WEEKLY: ScheduleConfig = {
  name: "weekly",
  periodMs: 7 * DAY,
  // 휴장 3시간(2026-09-27 사용자 결정, 6h → 3h): 개봉·자체검증·지급은 수천 장이어도 수십 분이면 끝난다.
  // 더 짧아도 규칙은 안전하다 — 직전 라운드가 덜 끝난 채 다음 라운드가 잠기면 이월금은 PENDING 으로 커밋되고
  // 정산 때 채워진다(round.e2e.test). 휴장은 drand 지연 같은 장애를 조용히 흡수하는 여유일 뿐이다.
  breakMs: 3 * HOUR,
  leads: { buyClose: 11 * MIN, salesClose: 10 * MIN, lock: 8 * MIN, anchorDeadline: 1 * MIN },
  minFirstRoundMs: 1 * HOUR,
  alignDraw: nextSundayDrawUtc,
  isAlignedDraw: (t) => {
    const d = new Date(t);
    return d.getUTCDay() === 0 && d.getUTCHours() === 15 && d.getUTCMinutes() === 0 && t % MIN === 0;
  },
};

/**
 * 스테이징·모의 E2E 용 10분 라운드. 규칙은 같고 간격만 짧다. 운영 번들의 검증기는 WEEKLY 정렬을
 * 따로 확인하므로 이 스케줄로 만든 라운드가 운영 라운드로 오인될 수 없다.
 */
export const TEST: ScheduleConfig = {
  name: "test",
  periodMs: 10 * MIN,
  breakMs: 2 * MIN,
  leads: { buyClose: 150_000, salesClose: 120_000, lock: 90_000, anchorDeadline: 20_000 },
  minFirstRoundMs: 3 * MIN,
  alignDraw: (t) => Math.ceil(t / (10 * MIN)) * (10 * MIN),
  isAlignedDraw: (t) => t % (10 * MIN) === 0,
};

export function scheduleByName(name: string | undefined): ScheduleConfig {
  if (name === undefined || name === "" || name === "weekly") return WEEKLY;
  if (name === "test") return TEST;
  throw new Error(`unknown ROUND_SCHEDULE "${name}" (weekly | test)`);
}

export type RoundTimes = {
  roundId: number;
  opensAtMs: number;
  buyCloseAtMs: number;
  salesCloseAtMs: number;
  lockAtMs: number;
  anchorDeadlineMs: number;
  drawAtMs: number;
  drandRound: number;
  /** 다음 라운드가 열리는 시각 = drawAt + break */
  nextOpensAtMs: number;
};

export function timesFor(cfg: ScheduleConfig, roundId: number, opensAtMs: number, drawAtMs: number): RoundTimes {
  if (!Number.isSafeInteger(roundId) || roundId < 1) throw new Error("roundId must be ≥ 1");
  const t: RoundTimes = {
    roundId,
    opensAtMs,
    buyCloseAtMs: drawAtMs - cfg.leads.buyClose,
    salesCloseAtMs: drawAtMs - cfg.leads.salesClose,
    lockAtMs: drawAtMs - cfg.leads.lock,
    anchorDeadlineMs: drawAtMs - cfg.leads.anchorDeadline,
    drawAtMs,
    drandRound: roundAfterTime(drawAtMs),
    nextOpensAtMs: drawAtMs + cfg.breakMs,
  };
  const problems = checkRoundTimes(t, cfg);
  if (problems.length > 0) throw new Error(`invalid round times: ${problems.join("; ")}`);
  return t;
}

/** 첫 라운드: 지금 열고, 최소 판매 시간이 지난 뒤의 첫 정렬 추첨 시각에 추첨. */
export function firstRoundTimes(cfg: ScheduleConfig, nowMs: number): RoundTimes {
  return timesFor(cfg, 1, nowMs, cfg.alignDraw(nowMs + cfg.minFirstRoundMs));
}

/** 다음 라운드: 직전 추첨 + 휴장에 열고, 직전 추첨 + 주기에 추첨. */
export function nextRoundTimes(cfg: ScheduleConfig, prev: RoundTimes): RoundTimes {
  return timesFor(cfg, prev.roundId + 1, prev.drawAtMs + cfg.breakMs, prev.drawAtMs + cfg.periodMs);
}

/**
 * 시계만으로 정해지는 단계. 추첨 이후(개봉·지급·정산)는 DB 상태가 정한다.
 *  UPCOMING  오픈 전
 *  SELLING   구매 가능
 *  LAST_CALL 새 구매는 못 시작, 진행 중인 결제는 판매 마감 전에 확정되면 유효
 *  CLOSING   판매 마감 ~ lock: 마감 전 결제를 목록에 반영하는 중
 *  LOCKED    목록 동결 · 결정 tx · 추첨 대기
 *  DRAWING   추첨 시각 이후
 */
export type ClockPhase = "UPCOMING" | "SELLING" | "LAST_CALL" | "CLOSING" | "LOCKED" | "DRAWING";

export function clockPhase(t: RoundTimes, nowMs: number): ClockPhase {
  if (nowMs < t.opensAtMs) return "UPCOMING";
  if (nowMs < t.buyCloseAtMs) return "SELLING";
  if (nowMs < t.salesCloseAtMs) return "LAST_CALL";
  if (nowMs < t.lockAtMs) return "CLOSING";
  if (nowMs < t.drawAtMs) return "LOCKED";
  return "DRAWING";
}

/** 순서·drand 라운드·정렬 불변식. 빈 배열이면 통과. 검증기도 부른다. */
export function checkRoundTimes(t: RoundTimes, cfg?: ScheduleConfig): string[] {
  const out: string[] = [];
  const order: [string, number][] = [
    ["opensAt", t.opensAtMs],
    ["buyCloseAt", t.buyCloseAtMs],
    ["salesCloseAt", t.salesCloseAtMs],
    ["lockAt", t.lockAtMs],
    ["anchorDeadline", t.anchorDeadlineMs],
    ["drawAt", t.drawAtMs],
  ];
  for (let i = 1; i < order.length; i++) {
    if (!(order[i - 1][1] < order[i][1])) out.push(`${order[i - 1][0]} must be before ${order[i][0]}`);
  }
  if (t.drawAtMs % MIN !== 0) out.push("drawAt must be a whole UTC minute (a drand round boundary)");
  if (t.drandRound !== roundAfterTime(t.drawAtMs)) out.push("drandRound must equal roundAfterTime(drawAt)");
  if (cfg && !cfg.isAlignedDraw(t.drawAtMs)) out.push(`drawAt is not aligned to the ${cfg.name} schedule`);
  if (cfg) {
    if (t.drawAtMs - t.buyCloseAtMs !== cfg.leads.buyClose) out.push("buyClose lead differs from schedule");
    if (t.drawAtMs - t.salesCloseAtMs !== cfg.leads.salesClose) out.push("salesClose lead differs from schedule");
    if (t.drawAtMs - t.lockAtMs !== cfg.leads.lock) out.push("lock lead differs from schedule");
    if (t.drawAtMs - t.anchorDeadlineMs !== cfg.leads.anchorDeadline) out.push("anchorDeadline lead differs from schedule");
  }
  return out;
}
