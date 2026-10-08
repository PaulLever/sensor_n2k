'use strict';

/*
 * shared-ui.js — common styling + top nav for the sensor_n2k web app
 * suite (portal, config, alarms, bus monitor, bilge, network, updates).
 * Plain CSS/template
 * strings, no build step or framework, matching how every other page in
 * this project is written (a single Node http server serving a hand-written
 * HTML string) — this just factors the parts that would otherwise drift
 * out of sync across four separately-edited files into one place.
 *
 * Usage in a server file:
 *   const { SHARED_STYLE, navHtml } = require('./shared-ui');
 *   ...
 *   const WEBAPP_HTML = `<!DOCTYPE html>...${SHARED_STYLE}...${navHtml('alarms')}...`;
 */

/* Ports are fixed/well-known across this project (see each service's own
 * file header) — not worth over-engineering into config for a small
 * LAN-only suite.
 *
 * NOTE: portal-server.js keeps its own hand-maintained copy of this list
 * (with extra `desc` strings for the home-page tiles) — add new services
 * to BOTH. Awkward, but it's the existing convention here. */
const APPS = [
  { id: 'portal', label: 'Home', port: 80, path: '/' },
  { id: 'config', label: 'Configuration', port: 3001, path: '/' },
  { id: 'alarms', label: 'Alarms', port: 3002, path: '/' },
  { id: 'busmon', label: 'Bus Monitor', port: 3003, path: '/' },
  { id: 'bilge', label: 'Bilge Pumps', port: 3004, path: '/' },
  { id: 'netconfig', label: 'Network', port: 3005, path: '/' },
  { id: 'ota', label: 'Updates', port: 3006, path: '/' },
  { id: 'signalk', label: 'Signal K', port: 3000, path: '/' },
];

/* Dark mode matters more than usual here — this runs on a boat, and a
 * lot of night helm displays are kept dark/red-shifted on purpose. Both
 * palettes are real, not just a `prefers-color-scheme` afterthought. */
const SHARED_STYLE = `<style>
:root {
  --bg: #f4f6f8;
  --surface: #ffffff;
  --surface-2: #eef1f4;
  --text: #1a2530;
  --text-dim: #5b6b7a;
  --border: #dde3e8;
  --accent: #0d7d8c;
  --accent-hover: #0a6673;
  --accent-text: #ffffff;
  --danger: #c0392b;
  --danger-bg: #fdecea;
  --warn: #b7791f;
  --warn-bg: #fef6e7;
  --ok: #1a7f5a;
  --ok-bg: #e8f7f0;
  --shadow: 0 1px 2px rgba(16, 24, 32, 0.06), 0 2px 8px rgba(16, 24, 32, 0.06);
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12181d;
    --surface: #1a2229;
    --surface-2: #212b33;
    --text: #e7edf2;
    --text-dim: #93a2ae;
    --border: #2b3742;
    --accent: #2bb8c4;
    --accent-hover: #4fcbd6;
    --accent-text: #06272a;
    --danger: #ff6b5e;
    --danger-bg: #3a1c1a;
    --warn: #e0b559;
    --warn-bg: #3a2f14;
    --ok: #4fd8a0;
    --ok-bg: #123526;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  margin: 0;
  padding: 0 0 3em;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 0 1.25em; }
h1 { font-size: 1.5em; font-weight: 650; margin: 0.6em 0 0.2em; letter-spacing: -0.01em; }
h2 { font-size: 1.15em; font-weight: 600; margin: 1.4em 0 0.6em; padding-bottom: 0.35em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1em; font-weight: 600; margin: 1em 0 0.4em; }
p.sub { color: var(--text-dim); margin: 0 0 1em; font-size: 0.95em; }

nav.topnav {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
}
nav.topnav .wrap { display: flex; align-items: center; gap: 0.25em; padding-top: 0.6em; padding-bottom: 0.6em; flex-wrap: wrap; }
nav.topnav .brand { font-weight: 700; margin-right: 0.75em; color: var(--text); white-space: nowrap; }
nav.topnav .brand .dot { color: var(--accent); }
nav.topnav a.navlink {
  padding: 0.4em 0.8em;
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 0.92em;
  font-weight: 500;
}
nav.topnav a.navlink:hover { background: var(--surface-2); text-decoration: none; color: var(--text); }
nav.topnav a.navlink.active { background: var(--accent); color: var(--accent-text); }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1.1em 1.25em;
  margin-bottom: 1.1em;
}

table { border-collapse: collapse; width: 100%; margin-bottom: 1em; font-size: 0.92em; }
th, td { border-bottom: 1px solid var(--border); padding: 0.55em 0.7em; text-align: left; }
th { color: var(--text-dim); font-weight: 600; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.03em; }
tr:last-child td { border-bottom: none; }
tr.dev, tr.clickable { cursor: pointer; }
tr.dev:hover, tr.clickable:hover { background: var(--surface-2); }

button, .btn {
  font-family: inherit;
  font-size: 0.92em;
  font-weight: 600;
  padding: 0.5em 1em;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
button:hover, .btn:hover { background: var(--surface-2); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
button.danger:hover { filter: brightness(1.08); }
button.danger:disabled { background: var(--surface-2); border-color: var(--border); color: var(--text-dim); }

input, select {
  font-family: inherit;
  font-size: 0.95em;
  padding: 0.45em 0.6em;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
input:disabled, select:disabled { background: var(--surface-2); color: var(--text-dim); border-color: var(--border); cursor: not-allowed; opacity: 0.7; }
label { display: inline-block; margin: 0.3em 0.6em 0.3em 0; font-size: 0.92em; color: var(--text-dim); }
label input, label select { display: block; margin-top: 0.2em; color: var(--text); }
fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.9em 1.1em; margin: 1em 0; }
legend { padding: 0 0.4em; font-weight: 600; color: var(--text-dim); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; }

.pill { display: inline-block; padding: 0.15em 0.65em; border-radius: 999px; font-size: 0.8em; font-weight: 600; }
.pill.ok { background: var(--ok-bg); color: var(--ok); }
.pill.warn { background: var(--warn-bg); color: var(--warn); }
.pill.danger { background: var(--danger-bg); color: var(--danger); }
.pill.neutral { background: var(--surface-2); color: var(--text-dim); }

.stat-row { display: flex; gap: 0.8em; flex-wrap: wrap; margin-bottom: 1em; }
.stat { background: var(--surface-2); border-radius: 8px; padding: 0.6em 1em; font-size: 0.92em; }
.stat b { color: var(--text); }

.tabs { display: flex; gap: 0.4em; margin-bottom: 1em; border-bottom: 1px solid var(--border); }
.tabs button { border: none; border-radius: 8px 8px 0 0; background: none; box-shadow: none; padding: 0.6em 1.1em; color: var(--text-dim); }
.tabs button.active { background: var(--surface); color: var(--accent); border: 1px solid var(--border); border-bottom-color: var(--surface); margin-bottom: -1px; }
.tab { display: none; }
.tab.active { display: block; }

#popup {
  display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: var(--danger); color: #fff; padding: 1em 1.25em;
  text-align: center; font-size: 1.05em; box-shadow: var(--shadow);
}
#popup button { margin-left: 1em; background: rgba(255,255,255,0.18); border-color: rgba(255,255,255,0.4); color: #fff; }
#popup button:hover { background: rgba(255,255,255,0.3); }
</style>`;

function navHtml(active) {
  /* data-port only, href filled in client-side from location.hostname
   * (see script below) — keeps this working whether the page was
   * reached via unoq.local, a raw IP, or anything else, without any
   * server-side host guessing.
   *
   * Signal K opens in a new tab, deliberately unlike the other three
   * (which share this same nav bar, so returning "home" from any of them
   * is always one click). Signal K is a third-party app we don't control
   * and don't want to patch — its own internal SPA navigation pushes many
   * browser-history entries, so the back button doesn't return here in
   * one press either. A new tab sidesteps that entirely (and survives
   * Signal K updates, unlike patching its UI) — going home is just
   * switching tabs instead of unwinding its history. */
  const links = APPS.map(a =>
    `<a class="navlink${a.id === active ? ' active' : ''}" data-port="${a.port}" href="#"${a.id === 'signalk' ? ' target="_blank" rel="noopener"' : ''}>${a.label}</a>`
  ).join('\n');
  return `<nav class="topnav"><div class="wrap">
<span class="brand">UNO<span class="dot">Q</span> N2K</span>
${links}
</div></nav>
<script>
document.querySelectorAll('nav.topnav a.navlink[data-port]').forEach(function(a) {
  a.href = '//' + location.hostname + ':' + a.dataset.port + '/';
});
</script>`;
}

module.exports = { SHARED_STYLE, navHtml, APPS };
