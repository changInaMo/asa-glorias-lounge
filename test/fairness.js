const E = require("../public/engine.js");
const N = 200000;
let pairs = 0, suited = 0, aces = 0, flushFlop = 0, setFlop = 0, ppHands = 0;
const pos = Array.from({ length: 52 }, () => 0);
const deckIdx = Object.fromEntries(E.freshDeck().map((c, i) => [c, i]));
for (let h = 0; h < N; h++) {
  const d = E.shuffle(E.freshDeck(), E.cryptoInt);
  const [a, b] = [d[0], d[1]];
  pos[deckIdx[d[0]]]++;
  if (a[0] === b[0]) { pairs++; ppHands++; const f = [d[3], d[4], d[5]]; if (f.some((c) => c[0] === a[0])) setFlop++; }
  if (a[1] === b[1]) { suited++; if ([d[3], d[4], d[5]].every((c) => c[1] === a[1])) flushFlop++; }
  if (a[0] === "A" && b[0] === "A") aces++;
}
const pct = (x, n = N) => (100 * x / n).toFixed(3) + "%";
const exp = N / 52;
const chi = pos.reduce((t, o) => t + (o - exp) ** 2 / exp, 0);
console.log("Hands dealt:", N);
console.log("Pocket pair:         ", pct(pairs), " real odds 5.882%");
console.log("Pocket aces:         ", pct(aces), " real odds 0.452%");
console.log("Suited hole cards:   ", pct(suited), " real odds 23.529%");
console.log("Flop a set w/ pair:  ", pct(setFlop, ppHands), " real odds 11.755%");
console.log("Flop a flush, suited:", pct(flushFlop, suited), " real odds 0.842%");
console.log("Chi-square, 51 dof (each card equally likely on top):", chi.toFixed(1), "(fair deck: usually 35-70)");
