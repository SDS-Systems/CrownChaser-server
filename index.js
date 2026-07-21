// Crownchaser server — global leaderboard + PvP arena rooms (quick play / room codes)
// One service, one deploy. Humans only on the leaderboard — bots never submit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');

const PORT = process.env.PORT || 8787;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'scores.json');
const MAX_SCORES_KEPT = 500;
const MAX_SCORE = 100000; // sanity cap
const MODES = new Set(['speed', 'crownfall', 'team', 'ctf']);

// ---------- leaderboard ----------
let scores = [];
try { scores = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { scores = []; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(scores), () => {});
  }, 250);
}

function cleanName(raw) {
  const s = String(raw || '').replace(/[^\w\- ]/g, '').trim().slice(0, 16);
  return s.length ? s : 'CHASER';
}

// routes are registered onto Colyseus's own express app (0.17 pattern) — see boot
function registerRoutes(app) {
  app.use(cors()); // itch iframes come from html.itch.zone etc.
  app.use(express.json({ limit: '2kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/scores', (req, res) => {
  const mode = MODES.has(req.query.mode) ? req.query.mode : 'speed';
  const top = scores
    .filter((s) => s.mode === mode)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  res.json({ mode, top });
  });

  app.get('/stats', (_req, res) => {
    res.json({ playersToday: seenToday.size, scores: scores.length });
  });

  app.post('/score', (req, res) => {
  const iph = ipHash(req);
  const now = Date.now();
  if (now - (lastSubmit.get(iph) || 0) < 10000) return res.status(429).json({ error: 'slow down' });

  const name = cleanName(req.body.name);
  const score = Math.floor(Number(req.body.score));
  const mode = MODES.has(req.body.mode) ? req.body.mode : 'speed';
  // pid = client-generated stable id (localStorage); hashed IP as backstop identity
  const pid = String(req.body.pid || '').replace(/[^\w-]/g, '').slice(0, 40) || `ip:${iph}`;
  if (!Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
    return res.status(400).json({ error: 'bad score' });
  }
  lastSubmit.set(iph, now);
  seenToday.add(iph);

  // one best score per identity per mode — beat your own record or nothing changes
  const existing = scores.find((s) => s.pid === pid && s.mode === mode);
  let improved = true;
  if (existing) {
    if (score > existing.score) {
      existing.score = score; existing.name = name; existing.at = now;
    } else improved = false;
  } else {
    scores.push({ name, score, mode, at: now, pid });
  }
  scores.sort((a, b) => b.score - a.score);
  if (scores.length > MAX_SCORES_KEPT) scores.length = MAX_SCORES_KEPT;
  persist();
  const modeScores = scores.filter((s) => s.mode === mode);
  const rank = modeScores.findIndex((s) => s.pid === pid) + 1;
  res.json({ ok: true, rank: rank || modeScores.length, improved });
  });
}

// naive per-IP rate limit: 1 submit per 10s. IPs are salted-hashed, never stored raw.
const lastSubmit = new Map();
const seenToday = new Set();
const IP_SALT = process.env.IP_SALT || 'crownchaser-jam-2026';
function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  return crypto.createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 16);
}

// ---------- PvP arena room: quick play + room codes, server-arbitrated robbery ----------
const MAX_HULL = 5;
const RESPAWN_MS = 7000;
const PVP_RANGE_SQ = 130 * 130; // sanity check on claimed hits

class PlayerState extends Schema {}
defineTypes(PlayerState, { name: 'string', x: 'number', y: 'number', z: 'number', yaw: 'number', carry: 'number', banked: 'number', hull: 'number', dead: 'boolean' });

class ArenaState extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
defineTypes(ArenaState, { players: { map: PlayerState } });

class ArenaRoom extends Room {
  onCreate(options = {}) {
    this.maxClients = 4;
    this.code = String(options.code || '');
    this.region = String(options.region || '');
    this.deadUntil = new Map();
    this.setState(new ArenaState());
    this.setPatchRate(50); // 20Hz

    this.onMessage('move', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object') return;
      p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0; p.yaw = +m.yaw || 0;
    });
    this.onMessage('stats', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object') return;
      p.carry = Math.max(0, m.carry | 0);
      p.banked = Math.max(0, m.banked | 0);
    });
    // shooter claims a hit; server owns hulls, deaths, and the robbery
    this.onMessage('pvpHit', (client, m) => {
      const shooter = this.state.players.get(client.sessionId);
      const target = this.state.players.get(m && m.sid);
      if (!shooter || !target || shooter === target) return;
      if (target.dead || shooter.dead) return;
      const pips = Math.min(3, Math.max(1, m.pips | 0));
      const dx = shooter.x - target.x, dy = shooter.y - target.y, dz = shooter.z - target.z;
      if (dx * dx + dy * dy + dz * dz > PVP_RANGE_SQ) return; // impossible shot
      target.hull -= pips;
      this.broadcast('hitfx', { sid: m.sid, pips }, { except: client });
      if (target.hull <= 0) {
        const stolen = target.carry;
        target.carry = 0;
        target.dead = true;
        target.hull = 0;
        this.deadUntil.set(m.sid, Date.now() + RESPAWN_MS);
        client.send('youKilled', { victim: target.name, stolen });
        const victimClient = this.clients.find((c) => c.sessionId === m.sid);
        if (victimClient) victimClient.send('youDied', { killer: shooter.name });
        this.broadcast('killfeed', { killer: shooter.name, victim: target.name, stolen });
      }
    });
    this.onMessage('respawned', (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.dead) return;
      if (Date.now() < (this.deadUntil.get(client.sessionId) || 0) - 500) return; // too early
      p.dead = false;
      p.hull = MAX_HULL;
    });
    this.onMessage('hullSync', (client, m) => {
      // client-side PvE damage (drones) reports hull down; server clamps, never up
      const p = this.state.players.get(client.sessionId);
      if (!p || p.dead) return;
      const h = Math.max(0, Math.min(MAX_HULL, m.hull | 0));
      if (h <= p.hull) p.hull = h;
    });
  }
  onJoin(client, options) {
    const p = new PlayerState();
    p.name = cleanName(options && options.name);
    p.x = 0; p.y = 1.7; p.z = 26; p.yaw = 0;
    p.carry = 0; p.banked = 0; p.hull = MAX_HULL; p.dead = false;
    this.state.players.set(client.sessionId, p);
  }
  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.deadUntil.delete(client.sessionId);
  }
}

// ---------- boot: 0.16 pattern — express + shared http server ----------
const http = require('http');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const app = express();
registerRoutes(app);
const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
// rooms bucket by code (private matches) and region (quick-play geographic preference)
gameServer.define('arena', ArenaRoom).filterBy(['code', 'region']);
gameServer.listen(PORT).then(() => console.log(`crownchaser server on :${PORT}`));
