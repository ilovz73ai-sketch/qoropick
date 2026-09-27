import { sha256Hex } from "@/lib/chain";
import { QUICKNET, roundAfterTime } from "@/lib/drand";
import { armorToBase64Url, fingerprint } from "@/lib/envelope";
import { localDateTimeInput, pad3, utcLong } from "@/lib/format";
import { sealSpin } from "@/lib/seal-crypto";
import { saveSeal } from "./store";

// 봉인 페이지(2026-09-27 사용자 지시):
//  · 기본은 **세 자리를 직접 입력**한다 — 세 칸을 누르면 숫자 키패드가 뜬다(칸 위에 투명한 입력칸 하나).
//  · **Spin** 을 누르면 그때부터 돌고 버튼이 **Stop** 으로 바뀐다. Stop 을 누르면 멈춘 숫자가 칸에 들어가고, 마음에 안 들면
//    다시 Spin 하거나 칸을 눌러 고친다.
//  · **Pick my number** 한 번이면 잠그고 qoropick 으로 저절로 돌아간다. 복사/붙여넣기·기술 설명은 "Advanced" 아래.
//
// Stop 에서 정해지는 숫자는 그 순간의 **암호학적 난수**(uniformSpin)다 — 화면에서 돌던 숫자가 아니다. 돌던 숫자를 그대로 쓰면
// 느린 폰에서는 원하는 숫자에 맞춰 누를 수 있고(균등하지 않다), Math.random 은 예측될 수 있다. 그래서 도는 모습은 읽을 수 없을
// 만큼 빠르게(매 프레임) 두고, Stop 을 누르면 잠깐 느려지다가 정해진 숫자에 멈춘다. 원하는 숫자가 있으면 직접 치면 된다.
//
// 평문 spin 은 이 페이지(와 이 기기의 localStorage) 밖으로 나가지 않는다 — 배포본은 CSP connect-src 'none' 이라
// 네트워크 요청 자체가 불가능하다. 돌아가는 링크는 허용 목록(VITE_ALLOWED_RETURNS)의 주소만 쓴다.
//
// 자동 복귀는 탭 직후(사용자 동작이 유효한 몇 초 안)에 한다 — 한참 뒤의 자동 이동은 폰 브라우저가 앱 링크를 막기도 한다.
// 3초 안에 떠나지 못했으면 "Back to qoropick" 링크를 보여 준다(누르면 같은 곳으로 간다).

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.hash.slice(1));
const drandRound = Number(params.get("r"));
const drawAtMs = Number(params.get("t"));
const roundId = params.get("n") ? Number(params.get("n")) : null;
const ret = params.get("ret");

const allowed = (import.meta.env.VITE_ALLOWED_RETURNS ?? "http://localhost:3000/,http://127.0.0.1:3000/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const returnAllowed = !!ret && ret.includes("{seal}") && allowed.some((p) => ret.startsWith(p));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function uniformSpin(): number {
  // 무편향: 65536 을 1000 으로 나눈 나머지는 치우친다 → 64000 이상은 버리고 다시 뽑는다.
  const buf = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 64000) return buf[0] % 1000;
  }
}

const card = el("section", { class: "card center" });
app.append(card);

const validRound = Number.isSafeInteger(drandRound) && drandRound > 0;
const consistent = validRound && Number.isFinite(drawAtMs) && drawAtMs % 60_000 === 0 && roundAfterTime(drawAtMs) === drandRound;

if (!validRound) {
  card.append(el("h1", {}, "Open this page from qoropick."), el("p", { class: "small" }, el("a", { href: "./check.html" }, "Check my lock →")));
} else {
  // ── 세 칸 = 입력칸 ──
  const digits = [0, 1, 2].map(() => el("div", { class: "digit empty" }, "–"));
  const input = el("input", {
    class: "reel-input",
    inputmode: "numeric",
    pattern: "[0-9]*",
    maxlength: "3",
    autocomplete: "off",
    "aria-label": "Your secret number, three digits",
  }) as HTMLInputElement;
  const reel = el("div", { class: "reel-wrap" }, el("div", { class: "reel" }, ...digits), input);
  const spinBtn = el("button", { class: "btn btn-soft", type: "button" }, "Spin") as HTMLButtonElement;
  const pickBtn = el("button", { class: "btn btn-primary", type: "button", disabled: "" }, "Pick my number") as HTMLButtonElement;
  const status = el("div");
  card.append(
    el("div", { class: "label" }, roundId ? `Round #${roundId}` : "qoropick"),
    el("h1", {}, "Pick your secret number."),
    reel,
    el("p", { class: "small muted" }, "Tap the boxes to type it, or spin."),
    el("div", { class: "row" }, spinBtn),
    el("div", { class: "row" }, pickBtn),
    status,
  );
  if (!consistent) {
    card.append(el("p", { class: "bad" }, "This link looks wrong, so go back to qoropick and try again."));
    spinBtn.disabled = true;
    input.disabled = true;
  }

  // ── Advanced: 복사/붙여넣기 · 기술 설명 ──
  const stay = el("input", { type: "checkbox", id: "stay" }) as HTMLInputElement;
  const copyArea = el("div");
  const adv = el(
    "details",
    { class: "card adv" },
    el("summary", {}, "Advanced"),
    el("label", { class: "check small", for: "stay" }, stay, "Stay here after locking, to copy and paste it into qoropick yourself."),
    copyArea,
    el(
      "p",
      { class: "small muted" },
      `Your number is locked with drand timelock encryption to quicknet round ${drandRound}, which opens ${drawAtMs ? `at ${utcLong(drawAtMs)} (${localDateTimeInput(drawAtMs)} your time)` : "when the round ends"}; before that no one can open it — not qoropick, not this page.`,
    ),
    el("p", { class: "small muted" }, "This page is open source, makes no network requests, and keeps a copy of your number in this browser so you can check it later on ", el("a", { href: "./check.html" }, "Check my lock"), "."),
    el("p", { class: "small muted" }, `Build ${__SEALER_COMMIT__} · drand quicknet ${QUICKNET.chainHash.slice(0, 8)}… · drand's Timevault (quicknet) works too.`),
  ) as HTMLDetailsElement;
  app.append(adv);

  // ── 칸 그리기 ──
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let rolling = false;
  /** 입력칸 값(0~3자리)을 세 칸에. 다 차면 짙게 칠한다. */
  const render = () => {
    const v = input.value;
    digits.forEach((d, i) => {
      d.textContent = v[i] ?? "–";
      d.classList.toggle("empty", v[i] === undefined);
      d.classList.toggle("next", i === v.length);
      d.classList.toggle("done", v.length === 3);
    });
    pickBtn.disabled = !consistent || rolling || v.length !== 3;
  };
  const showRolling = (n: number) =>
    pad3(n)
      .split("")
      .forEach((c, i) => {
        digits[i].textContent = c;
        digits[i].classList.remove("empty", "next", "done");
      });

  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 3);
    render();
  });

  // ── Spin / Stop ──
  const roll = () => {
    if (!rolling) return;
    showRolling(Math.floor(Math.random() * 1000)); // 보여 주기용(정해지는 값이 아니다)
    requestAnimationFrame(roll);
  };
  /** Stop: 잠깐 느려지다가 target 에 멈춘다(약 0.6초). */
  const land = (target: number) =>
    new Promise<void>((resolve) => {
      const delays = [40, 50, 60, 75, 90, 110, 140];
      let i = 0;
      const step = () => {
        if (i < delays.length) {
          showRolling(Math.floor(Math.random() * 1000));
          setTimeout(step, delays[i++]);
        } else resolve();
      };
      step();
    });

  spinBtn.addEventListener("click", async () => {
    if (!consistent) return;
    if (reduce) {
      // 움직임 줄이기: 돌리지 않고 바로 정한다.
      input.value = pad3(uniformSpin());
      render();
      return;
    }
    if (!rolling) {
      rolling = true;
      input.disabled = true;
      spinBtn.textContent = "Stop";
      render();
      requestAnimationFrame(roll);
      return;
    }
    rolling = false;
    spinBtn.disabled = true;
    const target = uniformSpin();
    await land(target);
    input.value = pad3(target);
    input.disabled = false;
    spinBtn.disabled = false;
    spinBtn.textContent = "Spin";
    render();
  });

  // ── Pick my number: 잠그고 돌아간다 ──
  const copyButton = (ciphertext: string, cls: string) => {
    const b = el("button", { class: `btn ${cls}`, type: "button" }, "Copy") as HTMLButtonElement;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ciphertext);
        b.textContent = "Copied, so paste it in qoropick";
      } catch {
        adv.open = true;
        (copyArea.querySelector("textarea") as HTMLTextAreaElement | null)?.select();
      }
    });
    return b;
  };

  pickBtn.addEventListener("click", async () => {
    if (!consistent || rolling || !/^\d{3}$/.test(input.value)) return;
    const spin = Number(input.value);
    pickBtn.disabled = true;
    spinBtn.disabled = true;
    input.disabled = true;
    pickBtn.textContent = "Locking…";
    const ciphertext = await sealSpin(drandRound, spin);
    const hash = sha256Hex(ciphertext);
    saveSeal({ roundId, drandRound, drawAtMs: drawAtMs || null, spin, ciphertext, ciphertextHash: hash, createdAtMs: Date.now() });
    pickBtn.textContent = "Locked ✓";

    // 복사/붙여넣기용 원문은 늘 Advanced 안에 둔다(자동 복귀가 안 되는 기기의 비상구).
    const ta = el("textarea", { readonly: "", "aria-label": "Your locked number" }) as HTMLTextAreaElement;
    ta.value = ciphertext;
    copyArea.replaceChildren(el("p", { class: "small" }, "Lock ID ", el("span", { class: "fp" }, fingerprint(hash))), el("div", { class: "row" }, copyButton(ciphertext, "btn-soft")), ta);

    const back = returnAllowed ? ret!.replace("{seal}", armorToBase64Url(ciphertext)) : null;
    if (back && !stay.checked) {
      status.replaceChildren(el("p", { class: "ok" }, `Your secret number ${pad3(spin)} is locked, so we're going back to qoropick.`));
      setTimeout(() => location.assign(back), 700);
      setTimeout(() => status.append(el("div", { class: "row" }, el("a", { class: "btn btn-primary", href: back }, "Back to qoropick"))), 3000);
    } else {
      status.replaceChildren(el("p", { class: "ok" }, `Your secret number ${pad3(spin)} is locked, so copy it and paste it in qoropick.`), el("div", { class: "row" }, copyButton(ciphertext, "btn-primary")));
    }
  });

  render();
}
