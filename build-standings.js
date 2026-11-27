#!/usr/bin/env node
/**
 * Build standings.json from one or more Badminton Queue export files.
 * Usage: node build-standings.js exports/*.json
 *
 * Every export is a full snapshot (players + current session + archive),
 * so files overlap heavily. All files are compiled together and matches
 * are deduped by their id — each upload only contributes its increments.
 *
 * The standings shown are for the most recent session that actually has
 * data (live matches, or a finished session with champions), matching
 * the app, where stats reset per session. The podium comes from that
 * session's champions when it has ended.
 *
 * Ranking (matches the offline app exactly):
 *   win rate > point difference > Buchholz median > total wins
 * Buchholz median: opponents' total wins per match faced, drop single
 * highest + lowest when there are 3+ opponents, sum the rest.
 */
'use strict';
const fs = require('fs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node build-standings.js <export.json> [<export2.json> …]');
  process.exit(1);
}

const playersById = {};
const byStarted = new Map(); // session.started -> merged session (files overlap; copies of the same session are combined)

for (const f of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.error(`Skipping unreadable export ${f}: ${e.message}`); continue; }
  (Array.isArray(data.players) ? data.players : []).forEach(p => { playersById[p.id] = p; });
  const add = (s, ts) => {
    if (!s) return;
    const key = s.started || 0;
    const agg = byStarted.get(key) || { started: key, ended: false, champions: [], matchById: {}, freshest: null };
    for (const m of (Array.isArray(s.matches) ? s.matches : [])) if (m && m.id && !agg.matchById[m.id]) agg.matchById[m.id] = m;
    if (s.ended) agg.ended = true;
    if (Array.isArray(s.champions) && s.champions.length) agg.champions = s.champions;
    // The freshest copy (latest export ts) carries the current courts & queue
    if (!agg.freshest || (ts || 0) >= agg.freshest.ts) agg.freshest = { ts: ts || 0, s };
    byStarted.set(key, agg);
  };
  add(data.session, data.ts);
  (Array.isArray(data.archive) ? data.archive : []).forEach(s => add(s, data.ts));
}

// The session to show: the most recent one that has games or a finished podium
const target = [...byStarted.values()]
  .filter(s => Object.keys(s.matchById).length || (s.ended && s.champions.length))
  .sort((a, b) => a.started - b.started)
  .pop();
if (!target) { console.error('No session with matches or champions found in the given exports'); process.exit(1); }

// Newest match last (matches carry ts) — order only affects nothing in the math,
// but keeps opponents arrays deterministic across runs
const matches = Object.values(target.matchById).sort((a, b) => (a.ts || 0) - (b.ts || 0));

const stats = {};
const ensure = (id, name) => {
  if (!stats[id]) {
    const p = playersById[id];
    stats[id] = {
      id, name: (p ? p.name : name || '?'),
      games: 0, wins: 0, losses: 0, pd: 0, opponents: [],
    };
  } else if (!playersById[id] && name) { stats[id].name = name; }
  return stats[id];
};

for (const m of matches) {
  const aWon = m.scoreA > m.scoreB;
  for (const p of m.a) {
    const st = ensure(p.id, p.name);
    st.games++; st.pd += m.scoreA - m.scoreB;
    aWon ? st.wins++ : st.losses++;
    m.b.forEach(o => st.opponents.push(o.id));
  }
  for (const p of m.b) {
    const st = ensure(p.id, p.name);
    st.games++; st.pd += m.scoreB - m.scoreA;
    aWon ? st.losses++ : st.wins++;
    m.a.forEach(o => st.opponents.push(o.id));
  }
}

const winsOf = id => (stats[id] || {}).wins || 0;
const rows = Object.values(stats).map(st => {
  const ow = st.opponents.map(winsOf).sort((a, b) => a - b);
  const buch = ow.length >= 3 ? ow.slice(1, -1).reduce((x, y) => x + y, 0)
                              : ow.reduce((x, y) => x + y, 0);
  return {
    name: st.name, games: st.games, wins: st.wins, losses: st.losses,
    winRate: st.games ? st.wins / st.games : 0,
    pd: st.pd, buchholz: buch,
  };
});
const seenNames = new Set(rows.map(r => r.name));
for (const p of Object.values(playersById)) {
  if (!seenNames.has(p.name)) rows.push({
    name: p.name, games: 0, wins: 0, losses: 0, winRate: 0, pd: 0, buchholz: 0,
  });
}
rows.sort((a, b) =>
  (b.games > 0) - (a.games > 0) ||
  b.winRate - a.winRate || b.pd - a.pd ||
  b.buchholz - a.buchholz || b.wins - a.wins ||
  a.games - b.games || a.name.localeCompare(b.name));

const champions = (target.ended && Array.isArray(target.champions))
  ? target.champions
      .map(id => {
        const p = playersById[id];
        const name = p ? p.name : (matches.flatMap(m => [...m.a, ...m.b]).find(x => x.id === id) || {}).name;
        return rows.find(r => r.name === name);
      })
      .filter(Boolean)
  : [];

// Names only — spectators see who is playing and who is queued, no scores
const src = (target.freshest && target.freshest.s) || {};
const live = {
  courts: (Array.isArray(src.courts) ? src.courts : [])
    .filter(c => c && c.match)
    .map(c => ({ num: c.num, a: c.match.a.map(p => p.name), b: c.match.b.map(p => p.name) })),
  upcoming: (Array.isArray(src.staged) ? src.staged : [])
    .map(s => ({ a: s.a.map(p => p.name), b: s.b.map(p => p.name) })),
};

const out = {
  sample: false,
  ended: !!(target.ended && champions.length),
  updated: Date.now(),
  sessionDate: target.started || Date.now(),
  champions,
  rows,
  live,
};
fs.writeFileSync('standings.json', JSON.stringify(out, null, 2) + '\n');
console.log(`standings.json written from ${files.length} export(s): ` +
  `${rows.length} players, ${matches.length} matches ` +
  `(session of ${new Date(target.started || 0).toISOString().slice(0, 10)}), ended=${out.ended}`);
