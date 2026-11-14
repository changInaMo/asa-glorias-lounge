// Asa Gloria's Lounge server: runs every table, deals the cards, and sends each player only what they may see.
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");
const E = require("./public/engine.js");

const PORT = process.env.PORT || 3000;
const ACTIVE = ["preflop", "flop", "turn", "river"];
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Starting chips and the blinds that go with them (the same choices in both modes)
const STAKES = {
  "20000": { stack: 20000, sb: 100, bb: 200 },
  "100000": { stack: 100000, sb: 500, bb: 1000 },
  "600000": { stack: 600000, sb: 3000, bb: 6000 },
  "1000000": { stack: 1000000, sb: 5000, bb: 10000 },
};
const LEVEL_MINS = [3, 5, 8, 10]; // tournament: blinds double this often
const MAX_BUYINS = 2;             // casual: buy-ins per player per table, counting the first one
const TIMERS = [0, 30, 45, 90];
const GONE_MS = 25000;        // a player with no open page for this long gets folded / sat out
const HOST_HANDOFF_MS = 60000; // host controls move to another player after this long away
const MAX_TABLES = 300;

const app = express();
// "no-cache" makes browsers check for a newer version every time, so updates show up on refresh
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
app.get("/healthz", (_q, r) => r.send("ok"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 });

const tables = new Map(); // code -> table
const conns = new Set();
const isActive = (st) => ACTIVE.includes(st.phase);
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 18);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const uidFor = (token) => "p" + crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);

function genCode() {
  for (;;) {
    const c = Array.from(crypto.randomBytes(5), (b) => CODE_CH[b % CODE_CH.length]).join("");
    if (!tables.has(c)) return c;
  }
}
function hlog(st, text) { st.log.push(text); if (st.log.length > 60) st.log.splice(0, st.log.length - 60); }
function newSeat(uid, name, stack, buyins = 1) {
  return { uid, name: cleanName(name) || "Player", stack, sitOut: false, inHand: false, folded: false, allIn: false, bet: 0, committed: 0, acted: false, buyins, timeouts: 0, lastAct: "" };
}
const isTour = (st) => st.settings.mode === "tournament";
const canPlay = (st, s) => !!s && E.eligibleForHand(st, s);
// "Sitting in": has chips, isn't out, isn't sitting out or leaving. A hand is only dealt when at least 2 players are sitting in,
// so the game never deals to one player and auto-checks for everyone else.
const sittingIn = (s) => !!s && !s.out && !s.leaving && !s.sitOut && s.stack > 0;

/* ---------------- tournament clock ---------------- */
// The clock only runs while the game is running, so pausing also pauses the blind timer.
function tourElapsed(st, now) { const c = st.tour; return c.elapsedMs + (c.runningSince ? now - c.runningSince : 0); }
// LEVEL_UNIT_MS is only for automated tests (it speeds the blind clock up); normally a minute is a minute.
const LEVEL_UNIT_MS = Number(process.env.LEVEL_UNIT_MS) || 60000;
function levelLen(st) { return st.settings.levelMins * LEVEL_UNIT_MS; }
function applyLevel(st, now) {
  const lvl = 1 + Math.floor(tourElapsed(st, now) / levelLen(st));
  if (lvl !== st.tour.level) {
    st.tour.level = lvl;
    st.settings.sb = st.settings.baseSb * 2 ** (lvl - 1);
    st.settings.bb = st.settings.baseBb * 2 ** (lvl - 1);
    hlog(st, `Blinds up! Level ${lvl}: ${fmt(st.settings.sb)}/${fmt(st.settings.bb)}`);
  }
}
function clockRun(st, now) { if (!st.tour.runningSince) st.tour.runningSince = now; }
function clockStop(st, now) { if (st.tour.runningSince) { st.tour.elapsedMs += now - st.tour.runningSince; st.tour.runningSince = null; } }
// After each hand: knock out busted players, give them a finishing place, and crown the winner.
function settleTournament(t, now) {
  const st = t.st, tr = st.tour;
  if (!tr.started || tr.finished || tr.checkedHand === st.handNo) return;
  tr.checkedHand = st.handNo;
  const busted = st.seats.filter((s) => s && !s.out && s.stack <= 0);
  const alive = st.seats.filter((s) => s && !s.out && s.stack > 0);
  busted.sort((a, b) => (t.handStart[b.uid] || 0) - (t.handStart[a.uid] || 0));
  busted.forEach((s, k) => {
    s.out = true; s.sitOut = false; s.place = alive.length + 1 + k;
    tr.places[s.uid] = { name: s.name, place: s.place };
    hlog(st, `${s.name} is out in ${ordinal(s.place)} place`);
  });
  if (alive.length === 1) {
    const w = alive[0];
    w.place = 1; tr.places[w.uid] = { name: w.name, place: 1 };
    tr.finished = { uid: w.uid, name: w.name, at: now };
    st.running = false; clockStop(st, now);
    hlog(st, `${w.name} wins the tournament!`);
  }
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
const seatOf = (t, uid) => t.st.seats.findIndex((s) => s && s.uid === uid);
const connsAt = (t) => [...conns].filter((c) => c.code === t.code && c.uid);
const online = (t) => new Set(connsAt(t).map((c) => c.uid));
function isGone(t, uid, now) {
  if (online(t).has(uid)) return false;
  return now - (t.lastSeen[uid] || 0) > GONE_MS;
}

/* ---------------- sending ---------------- */
function send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
function viewFor(t, uid) {
  const st = t.st;
  const v = JSON.parse(JSON.stringify(st));
  const i = seatOf(t, uid);
  v.myHole = i >= 0 && st.seats[i].inHand && t.priv && t.priv.handNo === st.handNo ? t.priv.holes[i] : null;
  v.hostUid = t.hostUid;
  v.online = [...online(t)];
  v.serverNow = Date.now();
  if (isTour(st)) {
    const now = v.serverNow;
    v.tourClock = { msLeft: levelLen(st) - (tourElapsed(st, now) % levelLen(st)), ticking: !!st.tour.runningSince,
      nextSb: st.settings.baseSb * 2 ** st.tour.level, nextBb: st.settings.baseBb * 2 ** st.tour.level };
  }
  v.myBuyins = t.buyins[uid] || 0;
  v.maxBuyins = MAX_BUYINS;
  return v;
}
function broadcast(t) {
  t.updatedAt = Date.now();
  for (const c of connsAt(t)) send(c, { t: "state", table: viewFor(t, c.uid) });
  lobbyDirty();
}
let lobbyTimer = null;
function lobbyList() {
  return [...tables.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 15)
    .map((t) => ({
      code: t.code, name: t.st.name, mode: t.st.settings.mode, seated: t.st.seats.filter(Boolean).length, maxSeats: t.st.seats.length,
      sb: t.st.settings.sb, bb: t.st.settings.bb, playing: isActive(t.st) || t.st.running, watching: online(t).size, updatedAt: t.updatedAt,
    }));
}
function lobbyDirty() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    const list = lobbyList();
    for (const c of conns) if (!c.code && c.uid) send(c, { t: "lobby", tables: list });
  }, 400);
}

/* ---------------- game flow ---------------- */
function commit(t, st, priv) {
  const prev = t.st, now = Date.now();
  if (st.toAct !== prev.toAct || st.handNo !== prev.handNo || st.phase !== prev.phase) st.turnStarted = now;
  if (st.phase === "done" && (prev.phase !== "done" || prev.handNo !== st.handNo)) {
    st.doneAt = now;
    t.runout = (prev.handNo === st.handNo ? prev.board.length : 0) < 5 && st.board.length === 5; // board dealt out in one go (all-in)
  }
  if (st.handNo !== prev.handNo) { st.seats.forEach((s) => { if (s) s.showedOff = false; }); t.handStart = {}; st.seats.forEach((s) => { if (s) t.handStart[s.uid] = s.stack + (s.committed || 0); }); }
  t.st = st; t.priv = priv;
}
function schedule(t, ms) {
  clearTimeout(t.timer);
  t.timer = setTimeout(() => step(t), Math.max(50, ms));
}
function step(t) {
  if (!tables.has(t.code)) return;
  const now = Date.now();
  // automatic moves for players who left, closed their page, or ran out of time
  for (let guard = 0; t.priv && isActive(t.st) && t.st.toAct >= 0 && guard < 20; guard++) {
    const st = t.st, i = st.toAct, s = st.seats[i];
    const timedOut = st.settings.turnSecs > 0 && now - st.turnStarted >= st.settings.turnSecs * 1000;
    const gone = isGone(t, s.uid, now) && now - st.turnStarted >= 4000;
    const satOut = isTour(st) && s.sitOut && now - st.turnStarted >= 1200;
    if (!(s.leaving || timedOut || gone || satOut)) break;
    const L = E.legal(st, i);
    const out = E.act(st, t.priv, i, { type: L && L.canCheck ? "check" : "fold" });
    if (out.error) break;
    commit(t, out.state, out.priv);
    if (timedOut && !s.leaving) {
      const ss = t.st.seats[i];
      ss.timeouts = (ss.timeouts || 0) + 1;
      hlog(t.st, `${ss.name} ran out of time`);
      if (ss.timeouts >= 2) { ss.sitOut = true; hlog(t.st, `${ss.name} is sitting out`); }
    }
  }
  // host controls follow whoever is around
  if (isGone(t, t.hostUid, now) && now - (t.lastSeen[t.hostUid] || 0) > HOST_HANDOFF_MS) {
    const on = online(t);
    const next = t.st.seats.find((s) => s && on.has(s.uid));
    if (next && next.uid !== t.hostUid) { t.hostUid = next.uid; hlog(t.st, `${next.name} now has the host controls`); }
  }
  let wait = Infinity;
  const st = t.st;
  if (!isActive(st)) {
    if (isTour(st)) {
      // a player who leaves a running tournament forfeits their chips
      st.seats.forEach((s) => { if (s && s.leaving) { s.leaving = false; s.stack = 0; } });
      if (st.phase === "done") settleTournament(t, now);
    } else {
      st.seats.forEach((s) => { if (s && s.leaving) t.leftStacks[s.uid] = s.stack; });
      st.seats = st.seats.map((s) => (s && s.leaving ? null : s));
    }
    st.seats.forEach((s) => { if (s && !s.out && !s.sitOut && isGone(t, s.uid, now)) { s.sitOut = true; hlog(st, `${s.name} is away and sitting out`); } });
    const eligible = st.seats.filter(sittingIn).length;
    if (st.running && eligible >= 2) {
      // after a showdown, leave time for the cards to be seen (and for an all-in run-out to play) before the next deal
      // a hand won by everyone folding gets a few seconds for the winner to choose to show their cards
      const pause = st.phase === "done" ? (st.result && st.result.showdown ? (t.runout ? 11000 : 8000) : 5500) : 800;
      const left = (st.phase === "done" ? st.doneAt : st.startedAt || 0) + pause - now;
      if (left <= 0) {
        if (isTour(st)) applyLevel(st, now);
        const res = E.startHand(st);
        if (res) commit(t, res.state, res.priv);
      } else wait = left + 30;
    }
  }
  if (isActive(t.st) && t.st.toAct >= 0) {
    wait = Math.min(wait, 5000);
    if (t.st.settings.turnSecs > 0) wait = Math.min(wait, t.st.turnStarted + t.st.settings.turnSecs * 1000 - now + 50);
  } else if (t.st.phase === "done" && t.st.running) wait = Math.min(wait, 4000);
  if (wait < Infinity) schedule(t, wait); else clearTimeout(t.timer);
  broadcast(t);
}

function createTable(c, m) {
  if (tables.size >= MAX_TABLES) return send(c, { t: "error", msg: "The server is full right now. Try again later." });
  const stake = STAKES[String(m.stake)] || STAKES["20000"];
  const mode = m.mode === "tournament" ? "tournament" : "casual";
  const turnSecs = TIMERS.includes(+m.timer) ? +m.timer : 45;
  const maxSeats = [6, 8].includes(+m.seats) ? +m.seats : 8;
  const st = E.newTable({ sb: stake.sb, bb: stake.bb, stack: stake.stack, turnSecs, maxSeats });
  Object.assign(st.settings, { mode, stake: String(stake.stack), baseSb: stake.sb, baseBb: stake.bb, levelMins: LEVEL_MINS.includes(+m.levelMins) ? +m.levelMins : 5 });
  if (mode === "tournament") st.tour = newTour();
  const code = genCode();
  st.code = code; st.name = cleanName(m.name) || `${c.name}'s table`; st.doneAt = 0; st.turnStarted = 0;
  st.seats[0] = newSeat(c.uid, c.name, stake.stack);
  hlog(st, `${c.name} opened a ${mode} table`);
  const t = { code, st, priv: null, hostUid: c.uid, timer: null, lastSeen: { [c.uid]: Date.now() }, updatedAt: Date.now(), createdAt: Date.now(),
    buyins: { [c.uid]: 1 }, leftStacks: {}, handStart: {} };
  tables.set(code, t);
  c.code = code;
  send(c, { t: "joined", code });
  broadcast(t);
}

function newTour() { return { level: 1, elapsedMs: 0, runningSince: null, started: false, finished: null, places: {}, checkedHand: 0 }; }

function handle(c, m) {
  if (m.t === "hello") {
    if (typeof m.token !== "string" || m.token.length < 16 || m.token.length > 128) return c.ws.close();
    c.uid = uidFor(m.token);
    c.name = cleanName(m.name) || "Player";
    send(c, { t: "welcome", uid: c.uid });
    return;
  }
  if (!c.uid) return;
  if (m.t === "name") {
    c.name = cleanName(m.name) || c.name;
    const t = tables.get(c.code);
    if (t) { const i = seatOf(t, c.uid); if (i >= 0) { t.st.seats[i].name = c.name; broadcast(t); } }
    return;
  }
  if (m.t === "lobby") { leaveView(c); send(c, { t: "lobby", tables: lobbyList() }); return; }
  if (m.t === "create") { leaveView(c); return createTable(c, m); }
  if (m.t === "join") {
    const code = String(m.code || "").toUpperCase();
    const t = tables.get(code);
    leaveView(c);
    if (!t) return send(c, { t: "notfound", code });
    c.code = code;
    t.lastSeen[c.uid] = Date.now();
    send(c, { t: "joined", code });
    return step(t);
  }
  const t = tables.get(c.code);
  if (!t) return;
  const st = t.st;
  const i = seatOf(t, c.uid);
  const s = i >= 0 ? st.seats[i] : null;
  const live = isActive(st);
  t.lastSeen[c.uid] = Date.now();
  switch (m.t) {
    case "sit": {
      if (s) return;
      if (isTour(st) && st.tour.started) return send(c, { t: "error", msg: "The tournament has already started. You can watch until the next one." });
      const free = (k) => Number.isInteger(k) && k >= 0 && k < st.seats.length && !st.seats[k];
      const k = free(m.seat) ? m.seat : st.seats.findIndex((x) => !x);
      if (k < 0) return send(c, { t: "error", msg: "The table is full." });
      let stack = st.settings.stack;
      if (!isTour(st)) {
        const kept = t.leftStacks[c.uid] || 0;
        if (kept > 0) { stack = kept; delete t.leftStacks[c.uid]; }
        else {
          if ((t.buyins[c.uid] || 0) >= MAX_BUYINS) return send(c, { t: "error", msg: `You've used all ${MAX_BUYINS} buy-ins at this table. You can still watch.` });
          t.buyins[c.uid] = (t.buyins[c.uid] || 0) + 1;
        }
      }
      st.seats[k] = newSeat(c.uid, c.name, stack, t.buyins[c.uid] || 1);
      hlog(st, `${st.seats[k].name} sat down with ${fmt(stack)}`);
      break;
    }
    case "leave":
      if (!s) return;
      if (isTour(st) && st.tour.started && !st.tour.finished) {
        if (s.out) { st.seats[i] = null; break; }
        if (live && s.inHand) s.leaving = true; else s.stack = 0;
        hlog(st, `${s.name} left the tournament`);
        if (!live) settleTournamentNow(t);
        break;
      }
      if (live && s.inHand) s.leaving = true;
      else { if (!isTour(st)) t.leftStacks[c.uid] = s.stack; st.seats[i] = null; }
      hlog(st, `${s.name} left the table`);
      break;
    case "sitout": if (s) s.sitOut = true; break;
    case "sitin": if (s) { s.sitOut = false; s.timeouts = 0; } break;
    case "rebuy":
      if (!s || s.stack > 0 || (live && s.inHand)) return;
      if (isTour(st)) return send(c, { t: "error", msg: "No buy-ins in a tournament. You can watch the rest." });
      if ((t.buyins[c.uid] || 0) >= MAX_BUYINS) return send(c, { t: "error", msg: `You've used all ${MAX_BUYINS} buy-ins at this table.` });
      t.buyins[c.uid] = (t.buyins[c.uid] || 0) + 1;
      s.stack = st.settings.stack; s.buyins = t.buyins[c.uid]; s.sitOut = false;
      hlog(st, `${s.name} bought back in for ${fmt(st.settings.stack)}`);
      break;
    case "act": {
      if (!s || !t.priv || m.hand !== st.handNo || i !== st.toAct || !live) return;
      const out = E.act(st, t.priv, i, { type: String(m.type), to: m.to });
      if (out.error) return send(c, { t: "error", msg: out.error, retry: true });
      commit(t, out.state, out.priv);
      t.st.seats[i].timeouts = 0;
      break;
    }
    case "show": {
      // the winner of a hand where everyone else folded may choose to show their cards
      const r = st.result;
      if (!s || st.phase !== "done" || !r || r.showdown || r.voided || s.shown) return;
      if (!r.winners.some((w) => w.seat === i) || !t.priv || t.priv.handNo !== st.handNo || !t.priv.holes[i]) return;
      s.shown = t.priv.holes[i].slice();
      s.showedOff = true;
      hlog(st, `${s.name} shows ${s.shown.join(" ")}`);
      break;
    }
    case "chat": {
      const text = String(m.text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 240);
      const now = Date.now();
      if (!text || now - (c.lastChat || 0) < 400) return;
      c.lastChat = now;
      for (const o of connsAt(t)) send(o, { t: "chat", name: c.name, uid: c.uid, text });
      return;
    }
    case "host": {
      if (c.uid !== t.hostUid) return send(c, { t: "error", msg: "Only the host can do that." });
      const now = Date.now();
      if (m.cmd === "start") {
        if (isTour(st) && st.tour.finished) return send(c, { t: "error", msg: "This tournament is over. Start a new one from the Host tab." });
        const ready = st.seats.filter(sittingIn).length;
        if (ready < 2) return send(c, { t: "error", code: "players", msg: "Not enough players to start. You need at least 2 players seated and sitting in. Send your friends the invite link." });
        st.running = true; st.startedAt = now;
        if (isTour(st)) {
          if (!st.tour.started) { st.tour.started = true; hlog(st, `The tournament begins! Blinds double every ${st.settings.levelMins} minutes.`); }
          clockRun(st, now);
        } else hlog(st, "Game on.");
      }
      else if (m.cmd === "pause") { st.running = false; if (isTour(st)) clockStop(st, now); hlog(st, "The host paused the game after this hand."); }
      else if (m.cmd === "stake" && STAKES[String(m.value)] && !isTour(st)) {
        const k = STAKES[String(m.value)];
        Object.assign(st.settings, { stake: String(k.stack), stack: k.stack, sb: k.sb, bb: k.bb, baseSb: k.sb, baseBb: k.bb });
        hlog(st, `Stakes change to ${fmt(k.sb)}/${fmt(k.bb)} from the next hand (buy-in ${fmt(k.stack)})`);
      }
      else if (m.cmd === "level" && LEVEL_MINS.includes(+m.value) && isTour(st)) { st.settings.levelMins = +m.value; hlog(st, `Blinds now double every ${m.value} minutes`); }
      else if (m.cmd === "timer" && TIMERS.includes(+m.value)) { st.settings.turnSecs = +m.value; st.turnStarted = now; }
      else if (m.cmd === "newtour" && isTour(st)) {
        if (live) return send(c, { t: "error", msg: "Wait for the hand to finish first." });
        st.tour = newTour(); st.running = false;
        st.settings.sb = st.settings.baseSb; st.settings.bb = st.settings.baseBb;
        st.seats.forEach((x) => { if (x) Object.assign(x, { stack: st.settings.stack, out: false, place: null, sitOut: false, timeouts: 0, lastAct: "", inHand: false }); });
        hlog(st, "A new tournament is ready. Everyone has fresh chips.");
      }
      else if (m.cmd === "kick") {
        const k = +m.seat, ks = st.seats[k];
        if (!ks || ks.uid === c.uid) return;
        if (isTour(st) && st.tour.started && !st.tour.finished && !ks.out) {
          if (live && ks.inHand) ks.leaving = true; else { ks.stack = 0; settleTournamentNow(t); }
        } else if (live && ks.inHand) ks.leaving = true;
        else { if (!isTour(st)) t.leftStacks[ks.uid] = ks.stack; st.seats[k] = null; }
        hlog(st, `${ks.name} was removed from the table`);
      } else if (m.cmd === "close") {
        clearTimeout(t.timer);
        tables.delete(t.code);
        for (const o of connsAt(t)) { send(o, { t: "closed" }); o.code = null; }
        lobbyDirty();
        return;
      }
      break;
    }
    default: return;
  }
  step(t);
}

// someone left between hands: settle right away rather than waiting for the next hand to end
function settleTournamentNow(t) { t.st.tour.checkedHand = -1; const h = t.st.handNo; settleTournament(t, Date.now()); t.st.tour.checkedHand = h; }

function leaveView(c) {
  const t = tables.get(c.code);
  c.code = null;
  if (t) { t.lastSeen[c.uid] = Date.now(); setTimeout(() => step(t), GONE_MS + 500); broadcast(t); }
}

wss.on("connection", (ws) => {
  const c = { ws, uid: null, name: "Player", code: null, alive: true };
  conns.add(c);
  ws.on("pong", () => { c.alive = true; });
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    try { handle(c, m); } catch (e) { console.error("handler error", e); }
  });
  ws.on("close", () => { conns.delete(c); if (c.code) { const code = c.code; c.code = null; const t = tables.get(code); if (t) { t.lastSeen[c.uid] = Date.now(); broadcast(t); setTimeout(() => step(t), GONE_MS + 500); setTimeout(() => step(t), HOST_HANDOFF_MS + 500); } } });
});

// keep connections honest and clear out tables nobody has used for a while
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} }
}, 30000);
setInterval(() => {
  const now = Date.now();
  for (const t of tables.values()) if (online(t).size === 0 && now - t.updatedAt > 6 * 3600 * 1000) { clearTimeout(t.timer); tables.delete(t.code); }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Asa Gloria's Lounge running on http://localhost:${PORT}`));
