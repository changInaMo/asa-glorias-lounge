// Texas Hold'em engine: pure functions over a plain JSON table state.
(function (root) {
  const RANKS = "23456789TJQKA";
  const SUITS = "shdc";
  const HAND_NAMES = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];

  function freshDeck() {
    const d = [];
    for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    return d;
  }
  // Fisher-Yates shuffle: every one of the 52! deck orders is equally likely, as with a perfectly shuffled real deck.
  function shuffle(deck, randInt) {
    const a = deck.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // Unbiased random integer in [0, n) from the operating system's cryptographic random source.
  // Rejection sampling removes the tiny bias a plain modulo would add.
  let CR = null;
  function getCrypto() {
    if (CR) return CR;
    CR = (root.crypto && root.crypto.getRandomValues) ? root.crypto : require("crypto").webcrypto;
    return CR;
  }
  function cryptoInt(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(4294967296 / n) * n;
    let x;
    do { getCrypto().getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % n;
  }

  // ---- hand evaluation ----
  function rank5(cards) {
    const rs = cards.map(c => RANKS.indexOf(c[0])).sort((a, b) => b - a);
    const flush = cards.every(c => c[1] === cards[0][1]);
    const uniq = [...new Set(rs)];
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (rs[0] - rs[4] === 4) straightHigh = rs[0];
      else if (rs[0] === 12 && rs[1] === 3) straightHigh = 3; // wheel
    }
    const counts = {};
    rs.forEach(r => (counts[r] = (counts[r] || 0) + 1));
    const groups = Object.entries(counts).map(([r, n]) => [n, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const kick = groups.map(g => g[1]);
    if (straightHigh >= 0 && flush) return [8, straightHigh];
    if (groups[0][0] === 4) return [7, ...kick];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...kick];
    if (flush) return [5, ...rs];
    if (straightHigh >= 0) return [4, straightHigh];
    if (groups[0][0] === 3) return [3, ...kick];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...kick];
    if (groups[0][0] === 2) return [1, ...kick];
    return [0, ...rs];
  }
  function cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  function best(cards) {
    let bestScore = null, bestCards = null;
    const n = cards.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
      for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        const h = [cards[a], cards[b], cards[c], cards[d], cards[e]];
        const s = rank5(h);
        if (!bestScore || cmp(s, bestScore) > 0) { bestScore = s; bestCards = h; }
      }
    return { score: bestScore, cards: bestCards, name: HAND_NAMES[bestScore[0]] };
  }

  // ---- table helpers ----
  const clone = o => JSON.parse(JSON.stringify(o));
  function seatOrder(state, from) {
    // indices after `from`, wrapping, length = seats.length
    const n = state.seats.length, out = [];
    for (let k = 1; k <= n; k++) out.push((from + k + n) % n);
    return out;
  }
  const occupied = (s) => s && s.uid;
  const live = s => occupied(s) && s.inHand && !s.folded;           // still contesting the pot
  const canAct = s => live(s) && !s.allIn;
  function nextIdx(state, from, pred) {
    for (const i of seatOrder(state, from)) if (pred(state.seats[i], i)) return i;
    return -1;
  }
  function potTotal(state) {
    return state.seats.reduce((t, s) => t + (s && s.inHand ? s.committed : 0), 0);
  }
  function log(state, text) {
    state.log.push(text);
    if (state.log.length > 40) state.log.splice(0, state.log.length - 40);
  }

  function newTable(opts) {
    return {
      v: 1,
      settings: { sb: opts.sb || 5, bb: opts.bb || 10, stack: opts.stack || 1000, turnSecs: opts.turnSecs ?? 45, maxSeats: opts.maxSeats || 8 },
      seats: Array(opts.maxSeats || 8).fill(null),
      phase: "waiting", running: false,
      handNo: 0, dealer: -1, toAct: -1, currentBet: 0, minRaise: opts.bb || 10,
      board: [], pot: 0, result: null, log: [], processed: {}, turnStarted: 0,
    };
  }

  // In a tournament, players who sit out are still dealt in (and fold when it's their turn), as in real tournaments.
  function eligibleForHand(state, s) {
    if (!occupied(s) || s.out || s.leaving || s.stack <= 0) return false;
    return !s.sitOut || (state.settings && state.settings.mode === "tournament");
  }

  // Start a hand. Returns {state, priv:{deck, holes}} or null if fewer than 2 players.
  function startHand(prev, randInt = cryptoInt) {
    const state = clone(prev);
    const idxs = state.seats.map((s, i) => (eligibleForHand(state, s) ? i : -1)).filter(i => i >= 0);
    if (idxs.length < 2) return null;
    state.handNo += 1;
    state.board = []; state.result = null;
    state.seats.forEach(s => {
      if (!s) return;
      Object.assign(s, { bet: 0, committed: 0, folded: false, allIn: false, acted: false, inHand: eligibleForHand(state, s), hole: null, shown: null, lastAct: "" });
    });
    state.dealer = nextIdx(state, state.dealer, s => s && s.inHand);
    const heads = idxs.length === 2;
    const sbI = heads ? state.dealer : nextIdx(state, state.dealer, s => s && s.inHand);
    const bbI = nextIdx(state, sbI, s => s && s.inHand);
    let deck = shuffle(freshDeck(), randInt);
    const holes = {};
    // deal two each starting left of dealer
    for (let r = 0; r < 2; r++) {
      for (const i of seatOrder(state, state.dealer)) {
        if (state.seats[i] && state.seats[i].inHand) (holes[i] = holes[i] || []).push(deck.shift());
      }
    }
    const post = (i, amt, label) => {
      const s = state.seats[i];
      const a = Math.min(amt, s.stack);
      s.stack -= a; s.bet += a; s.committed += a;
      if (s.stack === 0) s.allIn = true;
      s.lastAct = label + " " + a;
    };
    post(sbI, state.settings.sb, "SB");
    post(bbI, state.settings.bb, "BB");
    state.sbIdx = sbI; state.bbIdx = bbI;
    state.currentBet = Math.max(state.settings.bb, ...state.seats.map(s => (s && s.inHand ? s.bet : 0)));
    state.minRaise = state.settings.bb;
    state.phase = "preflop";
    state.pot = potTotal(state);
    log(state, `Hand #${state.handNo}. ${state.seats[state.dealer].name} has the button.`);
    state.toAct = nextIdx(state, bbI, (s) => canAct(s));
    // If nobody can act (everyone all-in from blinds), or only one can act and is matched, run it out.
    const priv = { handNo: state.handNo, deck, holes };
    if (state.toAct === -1 || needsNoAction(state)) return finishStreets(state, priv);
    return { state, priv };
  }

  function needsNoAction(state) {
    const actors = state.seats.filter(canAct);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= state.currentBet) {
      return state.seats.filter(live).length > 1;
    }
    return false;
  }

  function legal(state, i) {
    const s = state.seats[i];
    if (!s || i !== state.toAct || !canAct(s)) return null;
    const toCall = Math.max(0, state.currentBet - s.bet);
    const maxTo = s.bet + s.stack;
    const minTo = Math.min(maxTo, state.currentBet === 0 ? state.settings.bb : state.currentBet + state.minRaise);
    return {
      toCall: Math.min(toCall, s.stack),
      canCheck: toCall === 0,
      canRaise: maxTo > state.currentBet,
      minTo, maxTo,
      isBet: state.currentBet === 0,
    };
  }

  // action: {type: 'fold'|'check'|'call'|'raise', to?: number}
  function act(prev, priv, i, action) {
    const state = clone(prev);
    const L = legal(state, i);
    if (!L) return { error: "Not your turn" };
    const s = state.seats[i];
    const name = s.name;
    let t = action.type;
    if (t === "check" && !L.canCheck) return { error: "Can't check" };
    if (t === "call" && L.toCall === 0) t = "check";
    if (t === "fold") {
      s.folded = true; s.lastAct = "Fold";
      log(state, `${name} folds`);
    } else if (t === "check") {
      s.lastAct = "Check"; log(state, `${name} checks`);
    } else if (t === "call") {
      const a = L.toCall;
      s.stack -= a; s.bet += a; s.committed += a;
      if (s.stack === 0) s.allIn = true;
      s.lastAct = s.allIn ? "All-in " + s.bet : "Call " + a;
      log(state, `${name} ${s.allIn ? "calls all-in" : "calls"} ${a}`);
    } else if (t === "raise") {
      if (!L.canRaise) return { error: "Can't raise" };
      let to = Math.floor(Number(action.to));
      if (!Number.isFinite(to)) return { error: "Bad amount" };
      to = Math.min(to, L.maxTo);
      if (to < L.minTo) return { error: `Minimum is ${L.minTo}` };
      const add = to - s.bet;
      s.stack -= add; s.bet = to; s.committed += add;
      if (s.stack === 0) s.allIn = true;
      const raiseBy = to - state.currentBet;
      if (raiseBy >= state.minRaise) state.minRaise = raiseBy;
      const verb = L.isBet ? "bets" : "raises to";
      state.currentBet = Math.max(state.currentBet, to);
      s.lastAct = (s.allIn ? "All-in " : L.isBet ? "Bet " : "Raise ") + to;
      log(state, `${name} ${s.allIn ? "goes all-in" : verb} ${to}`);
      state.seats.forEach((o, j) => { if (o && j !== i && canAct(o)) o.acted = false; });
    } else return { error: "Unknown action" };
    s.acted = true;
    state.pot = potTotal(state);
    // remembered separately, because the table clears action labels when the next card is dealt
    state.lastAction = { seat: i, label: s.lastAct, n: ((prev.lastAction && prev.lastAction.n) || 0) + 1 };
    return advance(state, priv);
  }

  function advance(state, priv) {
    const contenders = state.seats.map((s, i) => (live(s) ? i : -1)).filter(i => i >= 0);
    if (contenders.length === 1) return settle(state, priv, false);
    const next = nextIdx(state, state.toAct, s => canAct(s) && (!s.acted || s.bet < state.currentBet));
    if (next !== -1) {
      state.toAct = next;
      return { state, priv };
    }
    return nextStreet(state, priv);
  }

  function dealStreet(state, priv) {
    const deck = priv.deck;
    if (state.phase === "preflop") { deck.shift(); state.board.push(deck.shift(), deck.shift(), deck.shift()); state.phase = "flop"; }
    else if (state.phase === "flop") { deck.shift(); state.board.push(deck.shift()); state.phase = "turn"; }
    else if (state.phase === "turn") { deck.shift(); state.board.push(deck.shift()); state.phase = "river"; }
    else return false;
    return true;
  }

  function nextStreet(state, priv) {
    priv = clone(priv);
    state.seats.forEach(s => { if (s && s.inHand) { s.bet = 0; s.acted = false; if (!s.folded && !s.allIn) s.lastAct = ""; } });
    state.currentBet = 0; state.minRaise = state.settings.bb;
    if (state.phase === "river") return settle(state, priv, true);
    dealStreet(state, priv);
    log(state, `${state.phase[0].toUpperCase() + state.phase.slice(1)}: ${state.board.join(" ")}`);
    if (needsNoAction(state)) return finishStreets(state, priv);
    state.toAct = nextIdx(state, state.dealer, canAct);
    return { state, priv };
  }

  function finishStreets(state, priv) {
    priv = clone(priv);
    state.seats.forEach(s => { if (s && s.inHand) { s.bet = 0; s.acted = false; } });
    state.currentBet = 0;
    while (state.phase !== "river") dealStreet(state, priv);
    log(state, `Board runs out: ${state.board.join(" ")}`);
    return settle(state, priv, true);
  }

  function settle(state, priv, showdown) {
    state.toAct = -1;
    state.seats.forEach(s => { if (s && s.inHand) s.bet = 0; });
    const seats = state.seats;
    const inHand = seats.map((s, i) => (s && s.inHand ? i : -1)).filter(i => i >= 0);
    // refund uncalled chips
    const sortedC = inHand.map(i => seats[i].committed).sort((a, b) => b - a);
    if (sortedC.length > 1 && sortedC[0] > sortedC[1]) {
      const top = inHand.find(i => seats[i].committed === sortedC[0]);
      const ref = sortedC[0] - sortedC[1];
      seats[top].committed -= ref; seats[top].stack += ref;
    }
    const contenders = inHand.filter(i => !seats[i].folded);
    const winnings = {};
    const handInfo = {};
    const order = seatOrder(state, state.dealer); // left of dealer first for odd chips
    if (!showdown || contenders.length === 1) {
      const w = contenders[0];
      const total = inHand.reduce((t, i) => t + seats[i].committed, 0);
      winnings[w] = total;
      log(state, `${seats[w].name} wins ${total}`);
    } else {
      contenders.forEach(i => { handInfo[i] = best([...priv.holes[i], ...state.board]); });
      const levels = [...new Set(inHand.map(i => seats[i].committed))].filter(x => x > 0).sort((a, b) => a - b);
      let prevL = 0;
      for (const L of levels) {
        let slice = 0;
        inHand.forEach(i => { slice += Math.max(0, Math.min(seats[i].committed, L) - prevL); });
        let elig = contenders.filter(i => seats[i].committed >= L);
        if (!elig.length) elig = contenders.slice().sort((a, b) => seats[b].committed - seats[a].committed).slice(0, 1);
        let bestS = null, winners = [];
        elig.forEach(i => {
          const c = bestS ? cmp(handInfo[i].score, bestS) : 1;
          if (c > 0) { bestS = handInfo[i].score; winners = [i]; } else if (c === 0) winners.push(i);
        });
        winners.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const share = Math.floor(slice / winners.length);
        let rem = slice - share * winners.length;
        winners.forEach(i => { winnings[i] = (winnings[i] || 0) + share + (rem-- > 0 ? 1 : 0); });
        prevL = L;
      }
      contenders.forEach(i => { seats[i].shown = priv.holes[i]; });
      Object.keys(winnings).forEach(i => log(state, `${seats[i].name} wins ${winnings[i]} with ${handInfo[i].name.toLowerCase()}`));
    }
    Object.entries(winnings).forEach(([i, amt]) => { seats[i].stack += amt; });
    state.result = {
      handNo: state.handNo,
      showdown: showdown && contenders.length > 1,
      winners: Object.entries(winnings).map(([i, amt]) => ({ seat: +i, amount: amt, hand: handInfo[i] ? handInfo[i].name : null, cards: handInfo[i] ? handInfo[i].cards : null })),
      hands: Object.fromEntries(Object.entries(handInfo).map(([i, h]) => [i, h.name])),
    };
    state.seats.forEach(s => { if (s && s.inHand) s.committed = 0; });
    state.pot = 0;
    state.phase = "done";
    return { state, priv };
  }

  // ---- plain-language description of a player's hand at any street ----
  const RNAME = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
  const rn = (i) => RNAME[i];
  const rp = (i) => (i === 4 ? "Sixes" : RNAME[i] + "s");
  function hasStraight(ranks) {
    const set = new Set(ranks);
    if (set.has(12)) set.add(-1);
    for (let hi = 12; hi >= 3; hi--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!set.has(hi - k)) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  function describe(hole, board) {
    if (!hole || hole.length < 2) return null;
    board = board || [];
    const hr = hole.map((c) => RANKS.indexOf(c[0])).sort((a, b) => b - a);
    const suited = hole[0][1] === hole[1][1];
    if (board.length < 3) {
      if (hr[0] === hr[1]) return { rank: 1, name: "Pair", detail: "Pocket " + rp(hr[0]), draws: [], cards: hole.slice() };
      const gap = hr[0] - hr[1];
      const draws = [];
      if (suited) draws.push("Suited");
      if (gap === 1 || (hr[0] === 12 && hr[1] === 0)) draws.push("Connected");
      return { rank: 0, name: "High card", detail: `${rn(hr[0])}-${rn(hr[1])} ${suited ? "suited" : "offsuit"}`, draws, cards: hole.slice() };
    }
    const all = [...hole, ...board];
    const b = best(all);
    const sc = b.score, cat = sc[0];
    let name = HAND_NAMES[cat], detail = "";
    if (cat === 0) detail = rn(sc[1]) + " high";
    else if (cat === 1) detail = "Pair of " + rp(sc[1]);
    else if (cat === 2) detail = `${rp(sc[1])} and ${rp(sc[2])}`;
    else if (cat === 3) detail = (hr[0] === hr[1] && hr[0] === sc[1] ? "Set of " : "Three ") + rp(sc[1]);
    else if (cat === 4) detail = rn(sc[1]) + "-high straight";
    else if (cat === 5) detail = rn(sc[1]) + "-high flush";
    else if (cat === 6) detail = `${rp(sc[1])} full of ${rp(sc[2])}`;
    else if (cat === 7) detail = "Four " + rp(sc[1]);
    else if (cat === 8) { if (sc[1] === 12) { name = "Royal flush"; detail = "Ace-high straight flush"; } else detail = rn(sc[1]) + "-high straight flush"; }
    const draws = [];
    if (board.length < 5) {
      if (cat < 5) {
        for (const s of SUITS) {
          const n = all.filter((c) => c[1] === s).length;
          if (n === 4 && hole.some((c) => c[1] === s)) draws.push("Flush draw");
        }
      }
      if (cat < 4) {
        const allR = all.map((c) => RANKS.indexOf(c[0]));
        const boardR = board.map((c) => RANKS.indexOf(c[0]));
        let outs = 0;
        for (let r = 0; r < 13; r++) if (!allR.includes(r) && hasStraight([...allR, r]) && !hasStraight([...boardR, r])) outs++;
        if (outs >= 2) draws.push("Open-ended straight draw");
        else if (outs === 1) draws.push("Gutshot straight draw");
      }
    }
    if (board.length === 5 && cmp(best(board).score, sc) === 0) draws.push("Playing the board");
    const group = cat === 2 ? [sc[1], sc[2]] : [1, 3, 7].includes(cat) ? [sc[1]] : null;
    const core = cat === 0 ? [] : group ? b.cards.filter((c) => group.includes(RANKS.indexOf(c[0]))) : b.cards;
    return { rank: cat, name, detail, draws, cards: core };
  }

  root.PokerEngine = { describe, cryptoInt, eligibleForHand, freshDeck, shuffle, best, rank5, cmp, newTable, startHand, act, legal, potTotal, HAND_NAMES, clone, live, canAct };
  if (typeof module !== "undefined") module.exports = root.PokerEngine;
})(typeof globalThis !== "undefined" ? globalThis : window);
