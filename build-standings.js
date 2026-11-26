#!/usr/bin/env node
/**
 * Build standings.json from a Badminton Queue export file.
 * Usage: node build-standings.js exports/<file>.json
 *
 * Ranking (matches the offline app exactly):
 *   win rate > point difference > Buchholz median > total wins
 * Buchholz median: opponents' total wins per match faced, drop single
 * highest + lowest when there are 3+ opponents, sum the rest.
 */
'use strict';
const fs = require('fs');

const [exportPath] = process.argv.slice(2);
if (!exportPath) { console.error('Usage: node build-standings.js <export.json>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const players = Array.isArray(data.players) ? data.players : [];
const session = data.session || {};
const matches = Array.isArray(session.matches) ? session.matches : [];

const byId = {}; players.forEach(p => { byId[p.id] = p; });
const stats = {};
const ensure = (id, name) => {
  if (!stats[id]) {
    const p = byId[id];
    stats[id] = {
      id, name: (p ? p.name : name || '?'),
      gender: p ? p.gender : '', level: p ? p.level : '',
      games: 0, wins: 0, losses: 0, pd: 0, opponents: [],
    };
  } else if (!byId[id] && name) { stats[id].name = name; }
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
    name: st.name, gender: st.gender, level: st.level,
    games: st.games, wins: st.wins, losses: st.losses,
    winRate: st.games ? st.wins / st.games : 0,
    pd: st.pd, buchholz: buch,
  };
});
const seen = new Set(rows.map(r => r.name));
for (const p of players) {
  if (!seen.has(p.name)) rows.push({
    name: p.name, gender: p.gender, level: p.level,
    games: 0, wins: 0, losses: 0, winRate: 0, pd: 0, buchholz: 0,
  });
}
rows.sort((a, b) =>
  (b.games > 0) - (a.games > 0) ||
  b.winRate - a.winRate || b.pd - a.pd ||
  b.buchholz - a.buchholz || b.wins - a.wins ||
  a.games - b.games || a.name.localeCompare(b.name));

const champions = (session.ended && Array.isArray(session.champions))
  ? session.champions
      .map(id => {
        const p = byId[id];
        const name = p ? p.name : (matches.flatMap(m => [...m.a, ...m.b]).find(x => x.id === id) || {}).name;
        return rows.find(r => r.name === name);
      })
      .filter(Boolean)
  : [];

const out = {
  sample: false,
  ended: !!session.ended,
  updated: Date.now(),
  sessionDate: session.started || Date.now(),
  champions,
  rows,
};
fs.writeFileSync('standings.json', JSON.stringify(out, null, 2) + '\n');
console.log(`standings.json written: ${rows.length} players, ${matches.length} matches, ended=${out.ended}`);
