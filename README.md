# qoropick — the open parts

[qoropick](https://pick.qoro.ooo) is a weekly number game in World App: **everyone adds a secret number, the sum makes the week's number,
and the community pool is shared by those who picked it.** This repository holds everything you need to check that nobody —
including the people who run qoropick — can steer the result:

| Path | What it is |
|---|---|
| `sealer/` | The **Sealer**: the page where you pick and lock your secret number. It makes **no network requests** (the built page ships a `connect-src 'none'` Content-Security-Policy), so your number never leaves your phone. Deployed from this repo to GitHub Pages; the footer shows the commit it was built from. |
| `scripts/verify.ts` | The **offline verifier**: re-checks a round from its public data, World Chain and the drand network. |
| `src/lib/` | The **rules library** the app itself runs — the same files, copied from the app on every publish. |

## The rules in code

- `src/lib/draw.ts` — `resolveDraw()`: the number is the sum of all valid secret numbers, mod 1000. Invalid or duplicate locks are left out; their tickets still count.
- `src/lib/seal-crypto.ts`, `src/lib/envelope.ts` — locking a number with drand timelock encryption (quicknet) and the strict format checks.
- `src/lib/chain.ts` — the hash chain over every ticket (buyer, pick, amount, payment, lock); its head is anchored on World Chain before the round ends.
- `src/lib/prize.ts` — the money: 1% fee on the round's tickets, equal shares per winning ticket, leftovers carried over.
- `src/lib/verify.ts` — every check the verifier (and the app's own pre-payout gate) runs.

## Check a round yourself

```bash
npm ci
npm test                                   # the rules library's tests
npm run verify -- https://pick.qoro.ooo/api/rounds/<id>/bundle
```

## What you still have to trust

The drand network, World Chain block times, that the operator actually sends the shares (every payment is public on-chain),
that the operator's server enforces the per-person ticket limit, this page's code if you use it instead of drand's Timevault,
and that the server stores the lock you pasted — check that on the Sealer's **Check my lock** page.
