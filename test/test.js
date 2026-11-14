const E = require("../public/engine.js");
const assert = require("assert");
const b = (s) => E.best(s.split(" "));
// evaluator
assert.equal(b("As Ks Qs Js Ts 2d 3c").name, "Straight flush");
assert.equal(b("Ah 2d 3c 4s 5h 9d Kc").name, "Straight");
assert.deepEqual(b("Ah 2d 3c 4s 5h 9d Kc").score, [4, 3]);
assert.equal(b("Ah Ad Ac As 5h 9d Kc").name, "Four of a kind");
assert.equal(b("Ah Ad Ac 5s 5h 9d Kc").name, "Full house");
assert.equal(b("2h 7h 9h Jh Kh Ad Ac").name, "Flush");
assert.equal(b("2h 2d 9c 9s Kh Ad 3c").name, "Two pair");
assert(E.cmp(b("Ah Ad 9c 8s 4h 3d 2c").score, b("Ah Ad 9c 7s 4h 3d 2c").score) > 0);
assert(E.cmp(b("Kh Kd Qc Qs 4h 3d 2c").score, b("Kh Kd Qc Qs 5h 3d 2c").score) < 0);

// seeded rng
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }
let errors = 0, hands = 0, showdowns = 0, sidepots = 0;
for (let game = 0; game < 300; game++) {
  const r = rng(game + 1);
  const n = 2 + (game % 7);
  let st = E.newTable({ sb: 5, bb: 10, stack: 500, maxSeats: 8 });
  for (let i = 0; i < n; i++) st.seats[i * (game % 2 ? 1 : 1)] = { uid: "u" + i, name: "P" + i, stack: 200 + Math.floor(r() * 600) };
  const total = () => st.seats.reduce((t, s) => t + (s ? s.stack + (s.inHand ? s.committed : 0) : 0), 0);
  const T0 = total();
  for (let h = 0; h < 60; h++) {
    const res = E.startHand(st, (n) => Math.floor(r() * n));
    if (!res) break;
    st = res.state; let priv = res.priv; hands++;
    let guard = 0;
    while (st.phase !== "done") {
      if (++guard > 500) throw new Error("loop");
      const i = st.toAct;
      const L = E.legal(st, i);
      assert(L, "no legal at " + st.phase + " toAct " + i);
      const x = r();
      let a;
      if (x < 0.15 && !L.canCheck) a = { type: "fold" };
      else if (x < 0.6) a = { type: L.canCheck ? "check" : "call" };
      else if (L.canRaise) a = { type: "raise", to: x > 0.93 ? L.maxTo : L.minTo + Math.floor(r() * (L.maxTo - L.minTo + 1)) };
      else a = { type: "call" };
      const out = E.act(st, priv, i, a);
      if (out.error) { errors++; console.log(out.error, a, L); break; }
      st = out.state; priv = out.priv;
      assert.equal(total(), T0, "chips not conserved mid-hand");
    }
    if (st.result.showdown) showdowns++;
    if (st.result.winners.length > 1) sidepots++;
    assert.equal(total(), T0, "chips not conserved");
    st.seats.forEach(s => s && assert(s.stack >= 0));
    assert.equal(new Set([...st.board]).size, st.board.length);
  }
}
console.log({ hands, showdowns, multiWinner: sidepots, errors });
assert.equal(errors, 0);

// targeted side pot: A all-in 100, B all-in 300, C calls 300 ; board makes A best, B second
{
  let st = E.newTable({ sb: 5, bb: 10, stack: 1000, maxSeats: 3 });
  st.seats = [{ uid: "a", name: "A", stack: 100 }, { uid: "b", name: "B", stack: 300 }, { uid: "c", name: "C", stack: 1000 }];
  const res = E.startHand(st); st = res.state;
  const priv = { handNo: 1, holes: { 0: ["As", "Ad"], 1: ["Ks", "Kd"], 2: ["2c", "2h"] }, deck: ["3c", "9h", "Jd", "4s", "5c", "8d", "Qh", "Tc", "6h"] };
  let p = priv, o;
  while (st.phase !== "done") {
    const i = st.toAct, L = E.legal(st, i);
    o = E.act(st, p, i, L.canRaise && i !== 2 ? { type: "raise", to: L.maxTo } : { type: "call" });
    st = o.state; p = o.priv;
  }
  const w = Object.fromEntries(st.result.winners.map(x => [x.seat, x.amount]));
  console.log("sidepot", w, st.board, st.seats.map(s => s.stack));
  assert.equal(w[0], 300); assert.equal(w[1], 400);
  assert.equal(st.seats[2].stack, 700);
}
const D = (h, b) => E.describe(h.split(" "), b ? b.split(" ") : []);
const show = (h, b) => { const d = D(h, b); return d.name + " | " + d.detail + (d.draws.length ? " | " + d.draws.join(", ") : ""); };
console.log(show("Ks Kd"));
console.log(show("Ah 7h"));
console.log(show("Ah 7h", "2h 9h Kc"));
console.log(show("8c 9d", "Td Jh 2s"));
console.log(show("8c 9d", "Td Qh 2s"));
console.log(show("6c 6d", "6h Jh 2s"));
console.log(show("Kc Qd", "Kh Qh 2s 2d"));
console.log(show("3c 4d", "Ah Kh Qh Jh Th"));
console.log(show("Ac 5d", "2h 3s 4c 9d"));
assert.equal(D("6c 6d", "6h Jh 2s").detail, "Set of Sixes");
assert.equal(D("8c 9d", "Td Jh 2s").draws[0], "Open-ended straight draw");
assert.equal(D("3c 4d", "Ah Kh Qh Jh Th").name, "Royal flush");
console.log("all ok");
