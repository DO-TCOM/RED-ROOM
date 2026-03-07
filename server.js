const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── CONFIG ────────────────────────────────────────────────────────────────────
const IPHUB_API_KEY = 'MzA4Mjc6TDZJMnA2OTA1MkpDajJvRXEweDB3Tkp4Zk00Y3FFSjk=';
const STATS_PASSWORD = 'admin123'; // Change ce mot de passe !
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'log.txt');
const DISPLAY_FILE = path.join(DATA_DIR, 'display.txt');
const EXTRAS_FILE = path.join(DATA_DIR, 'extras.json');
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VPN_CACHE_FILE = path.join(DATA_DIR, 'vpn_cache.json');

// Créer le dossier data si pas existant
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
if (!fs.existsSync(DISPLAY_FILE)) fs.writeFileSync(DISPLAY_FILE, '');
if (!fs.existsSync(EXTRAS_FILE)) fs.writeFileSync(EXTRAS_FILE, '{}');
if (!fs.existsSync(BLACKLIST_FILE)) fs.writeFileSync(BLACKLIST_FILE, '[]');
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ redirect_url: '', whitelist_mode: false }, null, 2));
if (!fs.existsSync(VPN_CACHE_FILE)) fs.writeFileSync(VPN_CACHE_FILE, '{}');

// ── HELPERS ───────────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function appendLog(line) {
  fs.appendFileSync(LOG_FILE, line + '\n');
  fs.appendFileSync(DISPLAY_FILE, line + '\n');
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && isValidIP(cf)) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) { const ip = fwd.split(',')[0].trim(); if (isValidIP(ip)) return ip; }
  return req.socket.remoteAddress || 'UNKNOWN';
}
function isValidIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip);
}

function parseUA(ua = '') {
  ua = ua.substring(0, 200);
  if (/mobile|android|iphone/i.test(ua)) return 'Mobile';
  if (/chrome/i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Other';
}

async function getLocation(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    return { city: data.city || 'N/A', country: data.country || 'N/A' };
  } catch { return { city: 'N/A', country: 'N/A' }; }
}

async function isVPN(ip) {
  const cache = readJSON(VPN_CACHE_FILE, {});
  if (cache[ip] && (Date.now() / 1000 - cache[ip].time) < 86400) return cache[ip].is_vpn;
  try {
    const res = await fetch(`http://v2.api.iphub.info/ip/${encodeURIComponent(ip)}`, {
      headers: { 'X-Key': IPHUB_API_KEY }, signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    const isVpn = data.block === 1;
    cache[ip] = { is_vpn: isVpn, time: Math.floor(Date.now() / 1000) };
    writeJSON(VPN_CACHE_FILE, cache);
    return isVpn;
  } catch { return false; }
}

function getLetterForIP(ip) {
  const lines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const m = line.match(new RegExp('IP:\\s*' + ip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|\\s*([A-Z]{1,2})'));
    if (m) return m[1];
  }
  const used = new Set();
  for (const line of lines) {
    const m = line.match(/\|\s*([A-Z]{1,2})\s*\|/);
    if (m) used.add(m[1]);
  }
  for (let i = 65; i <= 90; i++) { const l = String.fromCharCode(i); if (!used.has(l)) return l; }
  for (let i = 65; i <= 90; i++) for (let j = 65; j <= 90; j++) { const l = String.fromCharCode(i) + String.fromCharCode(j); if (!used.has(l)) return l; }
  return 'ZZ';
}

function isBlocked(ip) {
  const blacklist = readJSON(BLACKLIST_FILE, []);
  const config = readJSON(CONFIG_FILE, {});
  const rule = blacklist.find(r => r.ip === ip);
  if (config.whitelist_mode) return !(rule && rule.whitelist);
  return !!(rule && rule.blocked);
}

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'redroom-secret-2024', resave: false, saveUninitialized: false }));

// ── COLLECT (équivalent collect.php) ─────────────────────────────────────────
app.post('/collect', (req, res) => {
  const data = req.body;
  if (!data || !data.ip) return res.json({ ok: false });
  const extras = readJSON(EXTRAS_FILE, {});
  extras[data.ip] = {
    screen: data.screen || 'N/A',
    lang: data.lang || 'N/A',
    timezone: data.timezone || 'N/A',
    cores: data.cores || 'N/A',
    ram: data.ram ? data.ram + ' GB' : 'N/A',
    touch: data.touch != null ? (data.touch ? 'Oui' : 'Non') : 'N/A',
    platform: data.platform || 'N/A',
    darkmode: data.darkmode != null ? (data.darkmode ? '🌙 Dark' : '☀️ Light') : 'N/A',
    battery_level: data.battery_level != null ? data.battery_level + '%' : 'N/A',
    battery_charging: data.battery_charging != null ? (data.battery_charging ? '⚡ Oui' : 'Non') : 'N/A',
    connection: data.connection || 'N/A',
    localstorage: data.localstorage || 'N/A',
    adblock: data.adblock || 'N/A',
    time: Math.floor(Date.now() / 1000),
  };
  writeJSON(EXTRAS_FILE, extras);
  res.json({ ok: true });
});

// ── STATS API ────────────────────────────────────────────────────────────────
app.post('/stats/api/toggle', (req, res) => {
  if (!req.session.auth) return res.json({ ok: false });
  const { ip, field, value } = req.body;
  if (!ip || !['blocked', 'whitelist'].includes(field)) return res.json({ ok: false });
  const blacklist = readJSON(BLACKLIST_FILE, []);
  let rule = blacklist.find(r => r.ip === ip);
  if (!rule) { rule = { ip, blocked: false, whitelist: false }; blacklist.push(rule); }
  rule[field] = value === 'true';
  if (rule[field]) rule[field === 'blocked' ? 'whitelist' : 'blocked'] = false;
  const clean = blacklist.filter(r => r.blocked || r.whitelist);
  writeJSON(BLACKLIST_FILE, clean);
  res.json({ ok: true });
});

app.post('/stats/api/config', (req, res) => {
  if (!req.session.auth) return res.json({ ok: false });
  const config = readJSON(CONFIG_FILE, {});
  if (req.body.whitelist_mode != null) config.whitelist_mode = req.body.whitelist_mode === 'true';
  if (req.body.redirect_url != null) config.redirect_url = req.body.redirect_url.trim();
  writeJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.post('/stats/api/kick', (req, res) => {
  if (!req.session.auth) return res.json({ ok: false });
  const { ip } = req.body;
  if (!ip) return res.json({ ok: false });
  // Kick tous les sockets avec cette IP
  for (const [id, socket] of io.sockets.sockets) {
    if (socket.clientIp === ip) {
      socket.emit('kicked');
      socket.disconnect(true);
    }
  }
  res.json({ ok: true });
});

app.post('/stats/api/delete', (req, res) => {
  if (!req.session.auth) return res.json({ ok: false });
  const { lines } = req.body; // array of line indices to delete, or 'all'
  if (lines === 'all') {
    fs.writeFileSync(DISPLAY_FILE, '');
  } else if (Array.isArray(lines)) {
    const toDelete = new Set(lines.map(Number));
    const all = fs.readFileSync(DISPLAY_FILE, 'utf8').split('\n').filter(Boolean);
    const kept = all.filter((_, i) => !toDelete.has(i));
    fs.writeFileSync(DISPLAY_FILE, kept.join('\n') + (kept.length ? '\n' : ''));
  }
  res.json({ ok: true });
});

app.post('/stats/api/note', (req, res) => {
  if (!req.session.auth) return res.json({ ok: false });
  const { lineIdx, note } = req.body;
  const lines = fs.readFileSync(DISPLAY_FILE, 'utf8').split('\n').filter(Boolean);
  if (lineIdx >= 0 && lineIdx < lines.length) {
    lines[lineIdx] = lines[lineIdx].replace(
      /(\[.*?\]\s*IP:\s*[^|]+\|[^|]+\|[^|]+\|[^|]*\|)\s*[^|]*(\|.*)/,
      `$1 ${note.substring(0, 30)} $2`
    );
    fs.writeFileSync(DISPLAY_FILE, lines.join('\n') + '\n');
  }
  res.json({ ok: true });
});

// ── STATS PAGE ────────────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  if (!req.session.auth) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Stats</title>
    <style>body{font-family:monospace;background:#0a0a0f;color:#d0d0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{background:#111118;border:1px solid #1e1e2e;padding:30px;width:280px}h2{color:#cc2222;margin:0 0 16px}
    input{width:100%;padding:10px;background:#181825;border:1px solid #1e1e2e;color:#d0d0e0;font-family:monospace;font-size:14px;box-sizing:border-box;margin-bottom:10px}
    button{width:100%;padding:10px;background:#cc2222;color:#fff;border:none;cursor:pointer;font-family:monospace;font-weight:bold}
    .err{color:#cc2222;font-size:12px;margin-bottom:8px}</style></head>
    <body><div class="box"><h2>🔒 STATS</h2>
    ${req.query.err ? '<div class="err">Mot de passe incorrect</div>' : ''}
    <form method="POST" action="/stats/login">
    <input type="password" name="password" placeholder="Mot de passe" autofocus required>
    <button>Connexion →</button></form></div></body></html>`);
  }

  const displayLines = fs.existsSync(DISPLAY_FILE) ? fs.readFileSync(DISPLAY_FILE, 'utf8').split('\n').filter(Boolean) : [];
  const extras = readJSON(EXTRAS_FILE, {});
  const blacklist = readJSON(BLACKLIST_FILE, []);
  const config = readJSON(CONFIG_FILE, {});

  // Parse logs
  const parsed = [];
  displayLines.forEach((line, idx) => {
    const m = line.match(/\[([^\]]+)\]\s*IP:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^(]+)\(([^)]+)\)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([^|]+)\s*\|\s*(.+)/);
    if (m) {
      const note = m[7].trim();
      parsed.push({
        idx, date: m[1].trim(), ip: m[2].trim(), letter: m[3].trim(),
        city: m[4].trim(), country: m[5].trim(), vpn: m[6].trim(),
        note: note === 'REDIRECT_CHECK' ? '' : note,
        browser: m[8].trim(), url: m[9].trim()
      });
    }
  });

  // Group by IP
  const groups = {};
  parsed.forEach(r => { if (!groups[r.ip]) groups[r.ip] = []; groups[r.ip].push(r); });
  const blIndex = {};
  blacklist.forEach(r => { if (r.ip) blIndex[r.ip] = r; });

  const groupData = Object.entries(groups).map(([ip, rows]) => {
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const note = rows.find(r => r.note)?.note || '';
    const rule = blIndex[ip] || {};
    return {
      ip, letter: rows[0].letter, city: rows[0].city, country: rows[0].country,
      browser: rows[0].browser, last_date: rows[0].date, count: rows.length,
      pseudos: [...new Set(rows.map(r => r.url.replace(/^\//, '')))],
      vpn: rows.some(r => r.vpn.includes('VPN')),
      note, allIdx: rows.map(r => r.idx), firstIdx: rows[0].idx,
      extras: extras[ip] || null,
      is_blocked: !!(rule.blocked), is_whitelist: !!(rule.whitelist)
    };
  }).sort((a, b) => b.last_date.localeCompare(a.last_date));

  // Active users (connected right now)
  const activeIPs = new Set();
  for (const [, socket] of io.sockets.sockets) {
    if (socket.clientIp) activeIPs.add(socket.clientIp);
  }

  res.send(buildStatsHTML(groupData, displayLines.length, config, activeIPs));
});

app.post('/stats/login', (req, res) => {
  if (req.body.password === STATS_PASSWORD) {
    req.session.auth = true;
    res.redirect('/stats');
  } else {
    res.redirect('/stats?err=1');
  }
});

app.get('/stats/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/stats');
});

function buildStatsHTML(groupData, totalLines, config, activeIPs) {
  const rows = groupData.map(g => {
    const ex = g.extras || {};
    const isActive = activeIPs.has(g.ip);
    const rowClass = g.is_blocked ? 'blocked-row' : g.is_whitelist ? 'whitelist-row' : '';
    const ipHash = g.ip.replace(/[:.]/g, '_');
    return `<tr class="${rowClass}" data-ip="${esc(g.ip)}">
      <td class="c">
        ${g.allIdx.map(i => `<input type="hidden" class="hidx-${ipHash}" value="${i}" disabled>`).join('')}
        <input type="checkbox" class="line-cb cb-sel" onchange="selectGroup(this,'${ipHash}')">
      </td>
      <td class="lettre-big">${esc(g.letter)}${g.count > 1 ? `<span class="count">${g.count}x</span>` : ''}</td>
      <td class="ip-cell">${esc(g.ip)}${isActive ? ' <span style="color:#28a745;font-size:.6rem">● LIVE</span>' : ''}</td>
      <td>${esc(g.city)}<br><small style="color:#888">${esc(g.country)}</small></td>
      <td class="pseudo">${g.pseudos.map(p => `<div>/${esc(p)}</div>`).join('')}</td>
      <td style="font-size:11px;white-space:nowrap">${esc(g.last_date)}</td>
      <td class="c">${esc(g.browser)}</td>
      <td class="c">${g.vpn ? "<span class='vpn'>🔒</span>" : ''}</td>
      <td class="extra xv c"><span class="${batClass(ex.battery_level)}">${esc(ex.battery_level || 'N/A')}</span></td>
      <td class="extra xv c">${esc(ex.battery_charging || 'N/A')}</td>
      <td class="extra xv">${esc(ex.screen || 'N/A')}</td>
      <td class="extra xv">${esc(ex.lang || 'N/A')}</td>
      <td class="extra xv" title="${esc(ex.timezone || '')}">${esc((ex.timezone || 'N/A').replace(/^[^/]+\//, ''))}</td>
      <td class="extra xv c">${esc(ex.cores || 'N/A')}</td>
      <td class="extra xv c">${esc(ex.ram || 'N/A')}</td>
      <td class="extra xv c">${esc(ex.connection || 'N/A')}</td>
      <td class="extra xv c">${esc(ex.touch || 'N/A')}</td>
      <td class="extra xv">${esc(ex.platform || 'N/A')}</td>
      <td class="extra xv c">${esc(ex.darkmode || 'N/A')}</td>
      <td class="extra xv c">${ex.localstorage === 'Oui' ? "<span style='color:#27ae60'>✓</span>" : ex.localstorage === 'Non' ? "<span style='color:#aaa'>✗</span>" : '—'}</td>
      <td class="extra xv c">${ex.adblock === 'Oui' ? "<span style='color:#e67e22'>🛡️</span>" : ex.adblock === 'Non' ? 'Non' : '—'}</td>
      <td><input type="text" class="note-input" data-idx="${g.firstIdx}" value="${esc(g.note)}" onblur="saveNote(this)"></td>
      <td class="c"><input type="checkbox" class="cb-block" ${g.is_blocked ? 'checked' : ''} onchange="toggleField(this,'${esc(g.ip)}','blocked')"></td>
      <td class="c"><input type="checkbox" class="cb-white" ${g.is_whitelist ? 'checked' : ''} onchange="toggleField(this,'${esc(g.ip)}','whitelist')"></td>
      <td class="c"><button class="kick-btn" onclick="kickIP('${esc(g.ip)}')">⚡</button></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Stats RED.ROOM</title>
<style>
*{box-sizing:border-box}
body{font-family:monospace;background:#0a0a0f;padding:14px;margin:0;font-size:13px;color:#d0d0e0}
h1{margin:0 0 10px;font-size:17px;color:#d0d0e0}
table{border-collapse:collapse;width:100%;background:#111118}
th,td{border:1px solid #1e1e2e;padding:4px 7px;text-align:left;vertical-align:middle}
th{background:#cc2222;color:white;white-space:nowrap;font-size:12px;text-align:center}
td.c{text-align:center}
.note-input{width:100px;border:1px solid #1e1e2e;padding:3px 5px;font-size:12px;background:#181825;color:#d0d0e0}
.lettre-big{color:#cc2222;font-size:19px;font-weight:bold;text-align:center;line-height:1.2}
.count{font-size:11px;color:#555568;display:block}
.pseudo{color:#d0d0e0;font-size:12px}
.ip-cell{font-size:11px;color:#aaa;word-break:break-all}
.vpn{color:#cc2222;font-weight:bold}
.btn{border:none;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:bold;font-family:monospace}
.save-btn{background:#28a745;color:white}
.del-all-btn{background:#e74c3c;color:white;cursor:pointer;padding:6px 12px;font-size:12px;font-weight:bold;border:none;font-family:monospace}
.del-sel-btn{background:#e67e22;color:white}
.kick-btn{background:#9b59b6;color:white;border:none;padding:3px 7px;cursor:pointer;font-size:11px;font-family:monospace}
.actions{margin:7px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.extra{display:none}
.xv{font-size:11px;color:#aaa}
.bat-ok{color:#27ae60;font-weight:bold}.bat-low{color:#e74c3c;font-weight:bold}
.blocked-row td{background:#1a0505 !important}
.whitelist-row td{background:#051a0a !important}
.config-panel{background:#111118;border:1px solid #1e1e2e;padding:12px 16px;margin-bottom:11px;display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.config-label{font-size:11px;font-weight:bold;color:#555568;text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:4px}
.redir-input{padding:6px 10px;border:2px solid #cc2222;background:#181825;color:#d0d0e0;font-size:13px;font-family:monospace;width:260px}
.save-redir-btn{background:#cc2222;color:white;border:none;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:bold;font-family:monospace}
.toggle-wrap{display:flex;align-items:center;gap:10px}
.toggle-switch{position:relative;width:48px;height:26px;display:inline-block;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0;position:absolute}
.toggle-slider{position:absolute;inset:0;background:#333;border-radius:26px;transition:.25s}
.toggle-slider:before{content:'';position:absolute;width:20px;height:20px;left:3px;top:3px;background:white;border-radius:50%;transition:.25s}
input:checked+.toggle-slider{background:#28a745}
input:checked+.toggle-slider:before{transform:translateX(22px)}
.wl-label{font-size:13px;font-weight:bold}
.wl-on{color:#28a745}.wl-off{color:#555568}
input[type=checkbox].cb-block{accent-color:#e74c3c;width:17px;height:17px;cursor:pointer}
input[type=checkbox].cb-white{accent-color:#28a745;width:17px;height:17px;cursor:pointer}
input[type=checkbox].cb-sel{width:14px;height:14px;cursor:pointer}
.flash{position:fixed;bottom:18px;right:18px;padding:8px 16px;font-size:13px;font-weight:bold;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;font-family:monospace}
.flash.ok{background:#28a745;color:white}.flash.err{background:#e74c3c;color:white}
a.logout{color:#555568;font-size:11px;text-decoration:none;margin-left:auto}a.logout:hover{color:#cc2222}
</style></head><body>
<h1>📊 Stats RED.ROOM <small style="font-weight:normal;color:#555568">— ${totalLines} entrées · ${groupData.length} IPs</small> <a href="/stats/logout" class="logout">Déconnexion</a></h1>

<div class="config-panel">
  <div>
    <span class="config-label">↪ Rediriger les bloqués vers</span>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="text" class="redir-input" id="redirectInput" value="${esc(config.redirect_url || '')}" placeholder="https://google.com">
      <button class="save-redir-btn" onclick="saveRedirectUrl()">✓ Valider</button>
    </div>
    <div style="font-size:11px;color:#555568;margin-top:3px">Vide = retour à la page précédente</div>
  </div>
  <div>
    <span class="config-label">🛡️ Mode Liste Blanche</span>
    <div class="toggle-wrap">
      <label class="toggle-switch">
        <input type="checkbox" id="wlToggle" ${config.whitelist_mode ? 'checked' : ''} onchange="toggleWhitelistMode(this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span class="wl-label ${config.whitelist_mode ? 'wl-on' : 'wl-off'}" id="wlLabel">
        ${config.whitelist_mode ? 'ON — tout le monde bloqué sauf ✅' : 'OFF — seuls les 🚫 sont bloqués'}
      </span>
    </div>
  </div>
</div>

<div class="actions">
  <button class="btn del-all-btn" onclick="deleteAll()">🔴 Tout supprimer</button>
  <button class="btn del-sel-btn" onclick="deleteSelected()">🗑️ Supprimer sélection</button>
  <label style="background:#333;color:#d0d0e0;padding:6px 11px;cursor:pointer;font-size:12px;user-select:none;font-weight:bold;font-family:monospace">
    <input type="checkbox" id="toggleExtra" onchange="toggleExtras(this.checked)" style="margin-right:4px">🔍 Infos détaillées
  </label>
  <button class="btn" style="background:#444;color:#d0d0e0" onclick="location.reload()">🔄 Refresh</button>
</div>

<table><thead><tr>
  <th><input type="checkbox" id="selectAll" onchange="toggleAll(this)" class="cb-sel"></th>
  <th>Lettre</th><th style="text-align:left">IP</th><th style="text-align:left">Localisation</th>
  <th style="text-align:left">URL(s)</th><th style="text-align:left">Dernière co.</th>
  <th>Nav</th><th>VPN</th>
  <th class="extra">🔋</th><th class="extra">⚡</th><th class="extra">📱 Écran</th>
  <th class="extra">🌐 Lang</th><th class="extra">🕐 TZ</th><th class="extra">CPU</th>
  <th class="extra">RAM</th><th class="extra">📶</th><th class="extra">👆</th>
  <th class="extra">💻 OS</th><th class="extra">🎨</th><th class="extra">📦 Storage</th>
  <th class="extra">🛡️ AdBlock</th>
  <th style="text-align:left">Note</th>
  <th title="Bloquer">🚫</th><th title="Whitelist">✅</th><th title="Kick du chat">⚡</th>
</tr></thead><tbody>${rows}</tbody></table>

<div class="flash" id="flash"></div>
<script>
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function flash(msg,ok){var el=document.getElementById('flash');el.textContent=msg;el.className='flash '+(ok?'ok':'err');el.style.opacity='1';clearTimeout(window._ft);window._ft=setTimeout(()=>el.style.opacity='0',1800)}
function toggleAll(s){document.querySelectorAll('.line-cb').forEach(cb=>{cb.checked=s.checked;var m=cb.getAttribute('onchange')?.match(/selectGroup\\(this,'([^']+)'\\)/);if(m)selectGroup(cb,m[1])})}
function selectGroup(cb,key){document.querySelectorAll('.hidx-'+key).forEach(h=>h.disabled=!cb.checked)}
function toggleExtras(show){document.querySelectorAll('.extra').forEach(el=>el.style.display=show?'table-cell':'none')}

function toggleField(cb,ip,field){
  var tr=cb.closest('tr');
  if(cb.checked){var other=tr.querySelector(field==='blocked'?'.cb-white':'.cb-block');if(other&&other.checked){other.checked=false;send('/stats/api/toggle',{ip,field:field==='blocked'?'whitelist':'blocked',value:'false'});}}
  tr.className=tr.querySelector('.cb-block').checked?'blocked-row':tr.querySelector('.cb-white').checked?'whitelist-row':'';
  send('/stats/api/toggle',{ip,field,value:cb.checked?'true':'false'});
}
function kickIP(ip){if(!confirm('Kick '+ip+' du chat ?'))return;send('/stats/api/kick',{ip},d=>flash(d.ok?'⚡ Kické !':'⚠ Erreur',d.ok))}
function saveNote(inp){send('/stats/api/note',{lineIdx:inp.dataset.idx,note:inp.value},d=>flash(d.ok?'✓ Note sauvée':'⚠ Erreur',d.ok))}
function deleteAll(){if(!confirm('Supprimer TOUS les logs du tableau ?'))return;send('/stats/api/delete',{lines:'all'},()=>location.reload())}
function deleteSelected(){
  var idxs=[];
  document.querySelectorAll('input[type=hidden][disabled=false],.hidx-*:not([disabled])').forEach(h=>idxs.push(parseInt(h.value)));
  // collect enabled hidden inputs
  idxs=[];
  document.querySelectorAll('tr').forEach(tr=>{
    var cb=tr.querySelector('.line-cb');
    if(cb&&cb.checked){tr.querySelectorAll('input[type=hidden]').forEach(h=>idxs.push(parseInt(h.value)));}
  });
  if(!idxs.length){flash('Aucune sélection',false);return;}
  if(!confirm('Supprimer '+idxs.length+' entrées ?'))return;
  send('/stats/api/delete',{lines:idxs},()=>location.reload());
}
function saveRedirectUrl(){send('/stats/api/config',{redirect_url:document.getElementById('redirectInput').value},d=>flash(d.ok?'✓ URL sauvée':'⚠ Erreur',d.ok))}
function toggleWhitelistMode(val){
  var lbl=document.getElementById('wlLabel');
  lbl.textContent=val?'ON — tout le monde bloqué sauf ✅':'OFF — seuls les 🚫 sont bloqués';
  lbl.className='wl-label '+(val?'wl-on':'wl-off');
  send('/stats/api/config',{whitelist_mode:val?'true':'false'},d=>flash(d.ok?'✓ Mode changé':'⚠ Erreur',d.ok));
}
function send(url,data,cb){
  fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(r=>r.json()).then(d=>{flash(d.ok?'✓ OK':'⚠ Erreur',d.ok);if(cb)cb(d);}).catch(()=>flash('⚠ Réseau',false));
}
</script></body></html>`;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function batClass(v) { if (!v || v === 'N/A') return ''; return parseInt(v) <= 20 ? 'bat-low' : 'bat-ok'; }

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── ROOMS ─────────────────────────────────────────────────────────────────────
const rooms = {};

function generateRandomUsername() {
  const adjectives = ['Rouge', 'Noir', 'Blanc', 'Gris', 'Bleu', 'Vert'];
  const nouns = ['Fantome', 'Ombre', 'Echo', 'Visiteur', 'Voyageur'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999) + 1;
  return `${adj}${noun}${num}`;
}

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function normalizeName(n) {
  return n.toLowerCase()
    .replace(/[l|1!]/g, 'i').replace(/[0@]/g, 'o').replace(/[3]/g, 'e')
    .replace(/[5$]/g, 's').replace(/[4]/g, 'a').replace(/\s+/g, '');
}

function isNameTaken(room, socketId, name) {
  const norm = normalizeName(name);
  return Object.entries(room.users).some(([id, u]) => id !== socketId && normalizeName(u.username) === norm);
}

function getRoom(name) {
  if (!rooms[name]) {
    rooms[name] = {
      users: {},
      playlist: [],
      currentIndex: -1,
      playerState: { playing: false, currentTime: 0, updatedAt: Date.now() }
    };
  }
  return rooms[name];
}

function broadcastUserList(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  io.to(roomName).emit('userList',
    Object.entries(room.users).map(([id, u]) => ({
      id, username: u.username, videoOn: u.videoOn, micOn: u.micOn, isAdmin: u.isAdmin
    }))
  );
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  // Récupérer l'IP du visiteur
  const ip = (() => {
    const cf = socket.handshake.headers['cf-connecting-ip'];
    if (cf && isValidIP(cf)) return cf;
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (fwd) { const i = fwd.split(',')[0].trim(); if (isValidIP(i)) return i; }
    return socket.handshake.address || 'UNKNOWN';
  })();
  socket.clientIp = ip;

  // Vérifier blacklist
  if (isBlocked(ip)) {
    socket.emit('kicked');
    socket.disconnect(true);
    return;
  }

  // Logger la connexion
  (async () => {
    try {
      const letter = getLetterForIP(ip);
      const loc = await getLocation(ip);
      const vpnFlag = (await isVPN(ip)) ? '[VPN]' : '';
      const ua = socket.handshake.headers['user-agent'] || 'UNKNOWN';
      const browser = parseUA(ua);
      const date = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const room = socket.handshake.query?.room || 'default';
      const logLine = `[${date}] IP: ${ip} | ${letter} | ${loc.city}(${loc.country}) | ${vpnFlag} |  | ${browser} | /chat:${room}`;
      appendLog(logLine);
    } catch (e) { console.error('Log error:', e); }
  })();

  console.log('Client connected:', socket.id, ip);
  let currentRoom = null;

  socket.on('joinRoom', (roomName) => {
    try {
      currentRoom = roomName || 'default';
      socket.join(currentRoom);
      const room = getRoom(currentRoom);
      const username = generateRandomUsername();
      room.users[socket.id] = { username, videoOn: false, micOn: false, isAdmin: false };
      socket.emit('joinOk', { username, isAdmin: false });
      socket.emit('existingUsers',
        Object.entries(room.users).filter(([id]) => id !== socket.id).map(([id, u]) => ({ id, ...u }))
      );
      socket.emit('videoState', { playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState });
      socket.to(currentRoom).emit('userJoined', { id: socket.id, username, videoOn: false, micOn: false, isAdmin: false });
      io.to(currentRoom).emit('system', { text: username, event: 'joined', count: Object.keys(room.users).length });
      broadcastUserList(currentRoom);
    } catch (err) { console.error('joinRoom error:', err); socket.emit('joinError', 'Server error'); }
  });

  socket.on('webrtc-offer',   ({ to, offer })     => io.to(to).emit('webrtc-offer',  { from: socket.id, fromName: rooms[currentRoom]?.users[socket.id]?.username, offer }));
  socket.on('webrtc-answer',  ({ to, answer })    => io.to(to).emit('webrtc-answer', { from: socket.id, answer }));
  socket.on('webrtc-ice',     ({ to, candidate }) => io.to(to).emit('webrtc-ice',    { from: socket.id, candidate }));
  socket.on('webrtc-hangup',  ({ to })            => io.to(to).emit('webrtc-hangup', { from: socket.id }));

  socket.on('mediaState', ({ videoOn, micOn }) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room?.users[socket.id]) return;
      room.users[socket.id].videoOn = videoOn;
      room.users[socket.id].micOn = micOn;
      socket.to(currentRoom).emit('peerMediaState', { id: socket.id, videoOn, micOn });
      broadcastUserList(currentRoom);
    } catch (err) { console.error('mediaState error:', err); }
  });

  socket.on('message', (text) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      const user = room?.users[socket.id];
      if (!user) return;
      if (text.trim().startsWith('!ytb ')) {
        const videoUrl = text.trim().slice(5).trim();
        const videoId = extractYouTubeId(videoUrl);
        if (!videoId) { socket.emit('system', { text: '', event: 'ytbInvalid', count: Object.keys(room.users).length }); return; }
        if (room.playlist.length >= 5) { socket.emit('system', { text: '', event: 'ytbFull', count: Object.keys(room.users).length }); return; }
        room.playlist.push({ url: videoUrl, videoId, addedBy: user.username });
        if (room.currentIndex === -1) { room.currentIndex = 0; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; }
        io.to(currentRoom).emit('videoState', { playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState });
        io.to(currentRoom).emit('system', { text: user.username, event: 'ytbAdded', count: Object.keys(room.users).length, total: room.playlist.length });
        return;
      }
      io.to(currentRoom).emit('message', {
        username: user.username, text, id: socket.id,
        time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      });
    } catch (err) { console.error('message error:', err); }
  });

  socket.on('videoControl', ({ action, value }) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room?.users[socket.id]) return;
      const ps = room.playerState;
      if      (action === 'play')   room.playerState = { playing: true,  currentTime: value ?? ps.currentTime, updatedAt: Date.now() };
      else if (action === 'pause')  room.playerState = { playing: false, currentTime: value ?? ps.currentTime, updatedAt: Date.now() };
      else if (action === 'seek')   room.playerState = { ...ps, currentTime: value, updatedAt: Date.now() };
      else if (action === 'next')   { if (room.currentIndex < room.playlist.length - 1) { room.currentIndex++; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; } }
      else if (action === 'prev')   { if (room.currentIndex > 0) { room.currentIndex--; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; } }
      else if (action === 'select') { room.currentIndex = value; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; }
      else if (action === 'remove') {
        if (value >= 0 && value < room.playlist.length) {
          room.playlist.splice(value, 1);
          if (room.currentIndex >= room.playlist.length) room.currentIndex = room.playlist.length - 1;
          if (room.playlist.length === 0) { room.currentIndex = -1; room.playerState.playing = false; }
        }
      }
      io.to(currentRoom).emit('videoState', { playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState });
    } catch (err) { console.error('videoControl error:', err); }
  });

  socket.on('changeName', (newName) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room?.users[socket.id]) return;
      const trimmed = newName.trim();
      if (trimmed.length < 2 || trimmed.length > 20) { socket.emit('renameErr', '2 à 20 caractères.'); return; }
      if (isNameTaken(room, socket.id, trimmed)) { socket.emit('renameErr', 'Pseudo déjà utilisé (ou trop similaire).'); return; }
      const oldName = room.users[socket.id].username;
      room.users[socket.id].username = trimmed;
      socket.emit('renameOk', trimmed);
      io.to(currentRoom).emit('system', { text: `${oldName} → ${trimmed}`, event: 'renamed', count: Object.keys(room.users).length });
      broadcastUserList(currentRoom);
    } catch (err) { console.error('changeName error:', err); }
  });

  socket.on('kick', (targetId) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    const target = room?.users[targetId];
    if (!target) return;
    io.to(targetId).emit('kicked');
    io.sockets.sockets.get(targetId)?.disconnect(true);
    delete room.users[targetId];
    io.to(currentRoom).emit('system', { text: target.username, event: 'kicked', count: Object.keys(room.users).length });
    broadcastUserList(currentRoom);
  });

  socket.on('disconnect', () => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      const user = room?.users[socket.id];
      if (!user) return;
      delete room.users[socket.id];
      socket.to(currentRoom).emit('peerLeft', { id: socket.id });
      io.to(currentRoom).emit('system', { text: user.username, event: 'left', count: Object.keys(room.users).length });
      broadcastUserList(currentRoom);
    } catch (err) { console.error('disconnect error:', err); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
