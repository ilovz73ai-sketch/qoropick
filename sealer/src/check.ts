import type { Bundle } from "@/lib/bundle";
import { hexToUtf8, parseDecisionPayload, roundSeed, sha256Hex, verifyChain } from "@/lib/chain";
import { fingerprint, normalizeArmor } from "@/lib/envelope";
import { pad3, utcLong } from "@/lib/format";
import { loadSeals, type SavedSeal } from "./store";

// "내 봉인이 잠긴 목록에 들어 있나?" — 운영 서버가 붙여넣은 암호문을 바꿔치기했는지 **사후에** 잡는 도구.
// 번들은 앱에서 받지만, 그 목록이 정말 온체인에 고정된 목록인지는 World Chain RPC 에 직접 물어 확인한다.

const APP_URL = (import.meta.env.VITE_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RPC = import.meta.env.VITE_RPC_URL ?? "https://worldchain-mainnet.g.alchemy.com/public";
const app = document.getElementById("app")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

async function check(roundId: number, ciphertextHash: string): Promise<{ ok: boolean; lines: string[] }> {
  const res = await fetch(`${APP_URL}/api/rounds/${roundId}/bundle`, { cache: "no-store" });
  if (!res.ok) return { ok: false, lines: ["The list isn't out yet, so check again after tickets stop."] };
  const b = (await res.json()) as Bundle;
  const lines: string[] = [];
  let ok = true;

  const seed = roundSeed({ ...b.params, ticketPriceWei: BigInt(b.params.ticketPriceWei) });
  const chain = verifyChain(seed, b.entries, b.head);
  if (seed !== b.seed || !chain.ok) {
    ok = false;
    lines.push("✗ The published list doesn't match its own lock.");
  }
  const mine = b.entries.filter((e) => e.ciphertextHash === ciphertextHash);
  if (mine.length === 0) {
    ok = false;
    lines.push("✗ Your number is NOT in the list, so keep this page and your payment receipt as proof.");
  } else {
    for (const e of mine) {
      if (sha256Hex(e.ciphertext) !== ciphertextHash) {
        ok = false;
        lines.push(`✗ Ticket #${e.seq} has your lock ID but different contents.`);
      } else lines.push(`✓ You're ticket #${e.seq}: pick ${pad3(e.pick)} × ${e.qty}.`);
    }
  }
  if (!b.decision) lines.push("… The list isn't locked on World Chain yet.");
  else {
    const tx = await rpc<{ from: string; to: string; nonce: string; input: string } | null>("eth_getTransactionByHash", [b.decision.txHash]).catch(() => null);
    const payload = tx ? hexToUtf8(tx.input) : null;
    const decision = payload ? parseDecisionPayload(payload) : null;
    if (!tx || tx.from.toLowerCase() !== b.params.anchorAddress || Number(tx.nonce) !== b.params.anchorNonce || !decision) {
      ok = false;
      lines.push("✗ Couldn't find the lock on World Chain.");
    } else if (decision.kind === "ANCHOR" && decision.head === b.head) {
      lines.push("✓ World Chain confirms this exact list was locked.");
    } else if (decision.kind === "VOID") {
      lines.push("This round was cancelled, and everyone gets their WLD back.");
    } else {
      ok = false;
      lines.push("✗ World Chain locked a different list than the one shown.");
    }
  }
  if (b.draw) {
    const idx = b.entries.findIndex((e) => e.ciphertextHash === ciphertextHash);
    if (idx >= 0) {
      const o = b.draw.openings[idx];
      lines.push(`The number is ${pad3(b.draw.winningNumber)}, and yours opened as ${o.opening === "SPIN" ? pad3(o.spin!) : o.opening}.`);
    }
  }
  return { ok, lines };
}

function render(seals: SavedSeal[]) {
  const card = el("section", { class: "card" });
  if (seals.length === 0) card.append(el("p", {}, "No locks on this phone yet, so paste one below."));
  const list = el("ul", { class: "list" });
  for (const s of seals) {
    const out = el("div");
    const btn = el("button", { class: "btn btn-soft", type: "button" }, "Check");
    btn.addEventListener("click", async () => {
      if (!s.roundId) {
        out.replaceChildren(el("p", { class: "warn small" }, "Enter the round number below."));
        return;
      }
      btn.setAttribute("disabled", "");
      btn.textContent = "Checking…";
      try {
        const r = await check(s.roundId, s.ciphertextHash);
        out.replaceChildren(...r.lines.map((l) => el("p", { class: r.ok ? "small" : "small bad" }, l)));
      } catch (err) {
        out.replaceChildren(el("p", { class: "bad small" }, String(err instanceof Error ? err.message : err)));
      } finally {
        btn.removeAttribute("disabled");
        btn.textContent = "Check again";
      }
    });
    list.append(
      el(
        "li",
        {},
        el("div", {}, el("b", {}, s.roundId ? `Round #${s.roundId}` : `drand ${s.drandRound}`), " · secret ", el("b", {}, s.spin !== null ? pad3(s.spin) : "?"), " · ", el("span", { class: "fp" }, fingerprint(s.ciphertextHash))),
        el("div", { class: "muted small" }, s.drawAtMs ? `Result ${utcLong(s.drawAtMs)}` : ""),
        el("div", { class: "row" }, btn),
        out,
      ),
    );
  }
  card.append(list);
  app.append(card);

  // Timevault 등으로 만든 봉인도 확인할 수 있게: 붙여넣기 + 라운드 번호
  const manual = el("section", { class: "card" });
  const ta = el("textarea", { placeholder: "-----BEGIN AGE ENCRYPTED FILE-----" }) as HTMLTextAreaElement;
  const round = el("input", { class: "num", inputmode: "numeric", placeholder: "qoropick round #" }) as HTMLInputElement;
  const go = el("button", { class: "btn btn-primary", type: "button" }, "Check");
  const out = el("div");
  go.addEventListener("click", async () => {
    const armored = normalizeArmor(ta.value);
    if (!armored || !round.value) {
      out.replaceChildren(el("p", { class: "bad small" }, "Paste the lock and the round number."));
      return;
    }
    const r = await check(Number(round.value), sha256Hex(armored)).catch((e) => ({ ok: false, lines: [String(e)] }));
    out.replaceChildren(...r.lines.map((l) => el("p", { class: r.ok ? "small" : "small bad" }, l)));
  });
  manual.append(el("div", { class: "label" }, "Check any lock"), ta, el("div", { class: "row" }, round), el("div", { class: "row" }, go), out);
  app.append(manual);
}

render(loadSeals());
