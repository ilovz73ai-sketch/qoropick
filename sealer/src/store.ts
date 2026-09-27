// 이 기기(= Sealer 사이트의 출처)에만 남는 봉인 기록. qoropick 앱은 다른 출처라 읽을 수 없다.
// spin 을 잊어도 여기서 다시 볼 수 있고, Check 페이지가 "내 봉인이 목록에 있는지" 확인하는 데 쓴다.

export type SavedSeal = {
  roundId: number | null;
  drandRound: number;
  drawAtMs: number | null;
  spin: number | null;
  ciphertext: string;
  ciphertextHash: string;
  createdAtMs: number;
};

const KEY = "qoropick-sealer:seals";

export function loadSeals(): SavedSeal[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedSeal[];
  } catch {
    return [];
  }
}

export function saveSeal(s: SavedSeal) {
  try {
    const all = loadSeals().filter((x) => x.ciphertextHash !== s.ciphertextHash);
    localStorage.setItem(KEY, JSON.stringify([s, ...all].slice(0, 100)));
  } catch {
    /* 저장 불가(사생활 보호 모드) — 봉인 자체는 영향 없다 */
  }
}
