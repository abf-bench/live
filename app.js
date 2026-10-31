/* ABF live tracker: renders data/graph.json as a left-to-right money-flow graph.
   No build step. Depends on cytoscape, dagre and cytoscape-dagre loaded from index.html.

   URL parameters:
     ?embed=1          graph, title, disclaimer and stats only (clean frame for screenshots)
     ?step=N           open the replay at agent step N
     ?data=data/x.json load another export from the same site (e.g. data/mock.json)
     ?split=asset      draw one edge per asset instead of one per address pair
     ?debug=1          expose window.__abf for automated checks */
(function () {
  'use strict';

  // ---------- configuration ----------

  // Reports: GitHub issues on the public repo; FORM_URL adds a no-account option when set.
  var FORM_URL = '';
  var ISSUE_URL = 'https://github.com/abf-bench/live/issues/new';
  var SITE_URL = 'https://abf-bench.github.io/live/';
  var MAX_ISSUE_URL = 7000;

  var PARAMS = new URLSearchParams(window.location.search);
  var EMBED = PARAMS.get('embed') === '1';
  var SPLIT_ASSETS = PARAMS.get('split') === 'asset';
  var DATA_URL = safeDataPath(PARAMS.get('data')) || 'data/graph.json';
  var POLL_MS = 2 * 60 * 1000; // live updates: check for a new export every two minutes,
  var POLL_TRACING_MS = 60 * 1000; // and every minute while the agent is tracing
  function pollMs() { return LIVE.status && agentState().state === 'tracing' ? POLL_TRACING_MS : POLL_MS; }
  var PLAY_EVENT_MS = 1200;   // pause on a step that adds flows
  var PLAY_IDLE_MS = 140;     // pass quickly over steps that add nothing
  var MAX_LABEL_LINES = 4;
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Phones get a top-to-bottom flow; everything wider reads left to right.
  var NARROW = !EMBED && !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);

  var C = {
    bg: '#0d0e10', bg2: '#121316', ink: '#ece6da', ink2: '#c4beb2', muted: '#8b877e',
    edge: '#7a766e', edgeDashed: '#a8a397', signal: '#ff4d2e', amber: '#e8c25a'
  };

  var ROLES = {
    victim:   { name: 'Victim',          color: '#7ea6d8' },
    attacker: { name: 'Attacker',        color: '#ff4d2e' },
    pocket:   { name: 'Intermediate',    color: '#d98a5f' },
    stop:     { name: 'Stop',            color: '#a3a19a' },
    frozen:   { name: 'Frozen',          color: '#79d0e3' },
    resting:  { name: 'Dormant',         color: '#e8c25a' },
    open:     { name: 'Open lead',       color: '#ece6da' },
    unknown:  { name: 'Unclassified',    color: '#8b877e' }
  };
  var LEGEND_TEXT = { open: 'Open lead: I\'m still tracing here', resting: 'Dormant: nothing has left since the funds arrived',
    stop: 'Stop: a listed exchange, mixer or bridge' };
  var ROLE_ORDER = ['victim', 'attacker', 'pocket', 'stop', 'frozen', 'resting', 'open', 'unknown'];
  var TAG_FOR_ROLE = { frozen: 'Frozen', resting: 'Dormant', open: 'Open lead', stop: 'Stop' };

  // Chains: one hue each (kept apart from the role colours, which fill the nodes), and a short code.
  var CHAINS = {
    ethereum:  { code: 'ETH', name: 'Ethereum',   color: '#9d8cff' },
    bitcoin:   { code: 'BTC', name: 'Bitcoin',    color: '#f7931a' },
    tron:      { code: 'TRX', name: 'Tron',       color: '#ff6f91' },
    xrpl:      { code: 'XRP', name: 'XRP Ledger', color: '#3fa7d6' },
    solana:    { code: 'SOL', name: 'Solana',     color: '#14c38e' },
    near:      { code: 'NEAR', name: 'NEAR',      color: '#b8b8b8' },
    arbitrum:  { code: 'ARB', name: 'Arbitrum',   color: '#4ba3e3' },
    optimism:  { code: 'OP', name: 'Optimism',    color: '#ff5a5a' },
    base:      { code: 'BASE', name: 'Base',      color: '#4d7cff' },
    avalanche: { code: 'AVAX', name: 'Avalanche', color: '#e8605f' },
    polygon:   { code: 'POL', name: 'Polygon',    color: '#a07cf0' }
  };
  function chainInfo(c) { c = lc(c || 'ethereum'); return CHAINS[c] || { code: c.slice(0, 4).toUpperCase(), name: cap(c), color: '#8b877e' }; }
  function chainBadge(c) {
    var ch = chainInfo(c), w = 10 + ch.code.length * 6;
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='13'><rect x='0.5' y='0.5' width='" + (w - 1) +
      "' height='12' rx='3' fill='#0d0e10' stroke='" + ch.color + "'/><text x='" + (w / 2) + "' y='9.6' font-family='monospace' " +
      "font-size='8.5' text-anchor='middle' fill='" + ch.color + "'>" + ch.code + '</text></svg>';
    return { url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), w: w };
  }

  //: listed custody that is a bridge (coverage.py BRIDGE_CLASSES), and its colour in the coverage bar
  var BRIDGE_CLASSES = ['bridge_router', 'cross_chain_deposit_contract'];
  var BRIDGED_COLOR = '#8fb3a6';

  var EXPLORERS = {
    ethereum:  { name: 'Etherscan',          base: 'https://etherscan.io' },
    arbitrum:  { name: 'Arbiscan',           base: 'https://arbiscan.io' },
    optimism:  { name: 'Optimism Etherscan', base: 'https://optimistic.etherscan.io' },
    avalanche: { name: 'Snowtrace',          base: 'https://snowtrace.io' },
    base:      { name: 'Basescan',           base: 'https://basescan.org' },
    bsc:       { name: 'BscScan',            base: 'https://bscscan.com' },
    bitcoin:   { name: 'mempool.space',      base: 'https://mempool.space' }
  };
  var EXPLORER_HOSTS = /(^|\.)(etherscan\.io|arbiscan\.io|snowtrace\.io|basescan\.org|bscscan\.com|mempool\.space)$/;
  var EVIDENCE_NAMES = { transaction: 'Transaction', transaction_receipt: 'Event logs', transaction_trace: 'Internal calls' };

  // ---------- state ----------

  var S = {
    caseInfo: {},
    nodes: new Map(),      // id -> node
    edges: [],             // every exported edge, rejected ones included
    touched: new Set(),    // addresses that appear in any edge
    ops: new Map(),
    groups: [],            // non-rejected edges per (from, to, asset, tier)
    bundles: [],           // drawn edges: groups per (from, to, tier)
    bundleById: new Map(),
    total: 0,              // last agent step
    eventSteps: [],        // steps at which flows were recorded
    workspace: { note: null, leads: [], notes: [] },
    leadsByAddr: new Map(),
    comingSoon: [],
    pinned: new Set(),     // legend entries pinned by a click: their graph elements stay lit
    // the graph grouped into a band per chain (default) or drawn as one graph with a chain badge per node
    // one graph by default (the original view); grouping is a toggle until it is the default again
    groupChains: (function () { try { return localStorage.getItem('abf.groupChains2') === '1'; } catch (e) { return false; } })(),
    step: 0,
    view: null,
    cy: null,
    selected: null,        // { kind: 'node' | 'bundle', id }
    playing: false,
    playTimer: null,
    pulseTimer: null,
    userMoved: false
  };

  // A missing element (old cached markup, a renamed id) must not take the page down:
  // warn once and hand back a detached stand-in so reads and writes are harmless.
  var MISSING = {};
  var $ = function (id) {
    var e = document.getElementById(id);
    if (e) return e;
    if (!MISSING[id]) {
      MISSING[id] = document.createElement('div');
      MISSING[id].hidden = true;
      if (window.console) console.warn('Live tracker: #' + id + ' is missing from the page; that part is skipped.');
    }
    return MISSING[id];
  };
  function safe(name, fn) {
    try { return fn(); } catch (err) { if (window.console) console.warn('Live tracker: ' + name + ' failed; the rest of the page keeps working.', err); }
  }
  function on(node, type, fn, opts) { if (node && node.addEventListener) node.addEventListener(type, fn, opts); }
  if (EMBED) document.body.classList.add('embed');

  // ---------- helpers ----------

  function safeDataPath(p) {
    if (!p) return null;
    return /^[\w\-./]+\.json$/.test(p) && p.indexOf('..') === -1 && p.charAt(0) !== '/' && p.indexOf('//') === -1 ? p : null;
  }
  function safeUrl(u) {
    try { var x = new URL(u); return x.protocol === 'https:' && EXPLORER_HOSTS.test(x.hostname) ? x.href : null; } catch (e) { return null; }
  }
  // base58 Bitcoin addresses are case-sensitive and stay as they are; everything else is folded
  var BASE58_ADDR = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
  function lc(s) { return typeof s !== 'string' ? '' : (BASE58_ADDR.test(s.trim()) ? s.trim() : s.trim().toLowerCase()); }
  function str(s) { return typeof s === 'string' && s.trim() !== '' ? s.trim() : null; }
  function num(v) { return v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v; }
  function isAddr(s) { return /^0x[0-9a-f]{40}$/.test(s) || /^bc1[02-9ac-hj-np-z]{11,71}$/.test(s) || BASE58_ADDR.test(s); }
  function isHash(s) { return /^(0x)?[0-9a-fA-F]{64}$/.test(s); }
  function short(s) { return !s ? '' : (s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function trimZeros(s) { return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function prettyType(t) { return t ? String(t).replace(/[_-]+/g, ' ') : 'operation'; }

  // Compact amount for labels: 28,005.6 / 55.74M / 1.82B
  function fmt(x, frac) {
    if (frac === undefined) frac = 1;
    if (!Number.isFinite(x)) return '?';
    var a = Math.abs(x);
    if (a >= 1e9) return trimZeros((x / 1e9).toFixed(2)) + 'B';
    if (a >= 1e6) return trimZeros((x / 1e6).toFixed(2)) + 'M';
    if (a >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: frac });
    if (a >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (a === 0) return '0';
    return x.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  }
  // Exact decimal string with thousands separators
  function fmtExact(s) {
    if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) return String(s == null || s === '' ? '?' : s);
    var parts = s.split('.');
    var int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? int + '.' + parts[1] : int;
  }
  // ETH first, then larger totals first
  // Major assets first in a fixed order; the rest by amount. Token counts are not comparable across
  // assets (7.77 trillion PEPE would otherwise come before 1.88 billion USDT).
  var MAJOR_ASSETS = ['ETH', 'BTC', 'USDT', 'USDC', 'RLUSD', 'WBTC', 'WETH'];
  function assetOrder(a, b) {
    var ra = MAJOR_ASSETS.indexOf(String(a[0]).toUpperCase()), rb = MAJOR_ASSETS.indexOf(String(b[0]).toUpperCase());
    ra = ra === -1 ? MAJOR_ASSETS.length : ra;
    rb = rb === -1 ? MAJOR_ASSETS.length : rb;
    return ra - rb || b[1] - a[1];
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function parseTime(iso) { if (!iso) return null; var d = new Date(iso); return isNaN(d.getTime()) ? null : d; }
  function fmtTime(iso, withSeconds) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return iso ? String(iso) : '';
    var s = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    if (withSeconds) s += ':' + pad(d.getUTCSeconds());
    return s + ' UTC';
  }

  function hexToRgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(h); var v = m ? parseInt(m[1], 16) : 0x888888; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return '#' + x.map(function (v, i) { var c = Math.round(v * t + y[i] * (1 - t)).toString(16); return c.length < 2 ? '0' + c : c; }).join('');
  }

  // DOM builder. Strings become text nodes, so exported text never reaches innerHTML.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function explorerFor(chain) { return EXPLORERS[lc(chain || '')] || EXPLORERS.ethereum; }
  function extLink(href, text, cls) { return el('a', { class: 'ext' + (cls ? ' ' + cls : ''), href: href, target: '_blank', rel: 'noopener' }, text); }
  function addrLink(addr, chain, text) {
    return isAddr(addr) ? extLink(explorerFor(chain).base + '/address/' + addr, text || ('View on ' + explorerFor(chain).name)) : null;
  }
  function txLink(hash, chain) {
    if (!isHash(hash)) return el('span', null, hash || 'no hash');
    var a = extLink(explorerFor(chain).base + '/tx/' + hash, short(hash));
    a.setAttribute('title', hash);
    return a;
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, ms || 1600);
  }
  function copyText(text) {
    function fallback() {
      var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Address copied'); } catch (e) { toast('Copy failed'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast('Address copied'); }, fallback);
    else fallback();
  }
  function copyButton(text) { return el('button', { type: 'button', class: 'copy', title: 'Copy ' + text, onclick: function () { copyText(text); } }, 'Copy'); }
  function showMsg(text) { var m = $('graph-msg'); m.textContent = text || ''; m.hidden = !text; }

  // ---------- data ----------

  function normalize(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    S.caseInfo = data.case && typeof data.case === 'object' ? data.case : {};
    var defaultChain = lc(S.caseInfo.chain) || 'ethereum';

    S.nodes = new Map();
    (Array.isArray(data.nodes) ? data.nodes : []).forEach(function (n) {
      if (!n || !n.id) return;
      var id = lc(n.id);
      // Issuer freezes read on chain: [{asset, token, issuer, held, note}]; freezable: balances the
      // issuer has not frozen (balanceOf and the blacklist read on chain, dust left out by the exporter)
      function issuerList(list) {
        return (Array.isArray(list) ? list : []).filter(function (f) { return f && str(f.asset); }).map(function (f) {
          var held = parseFloat(f.held);
          return { asset: str(f.asset), token: lc(f.token), issuer: str(f.issuer), note: str(f.note), held: isFinite(held) ? held : null, takenBack: !!f.taken_back };
        });
      }
      // dormant: what the address still holds of the traced assets, unfrozen (balances read on chain,
      // bounded by what traced flows brought there; coverage.py)
      var dormant = (Array.isArray(n.dormant) ? n.dormant : []).map(function (d) {
        var x = parseFloat(d && d.amount);
        return { asset: str(d && d.asset), amount: isFinite(x) ? x : 0 };
      }).filter(function (d) { return d.asset && d.amount > 0; });
      S.nodes.set(id, { id: id, chain: lc(n.chain) || defaultChain, label: str(n.label), role: ROLES[n.role] ? n.role : 'unknown', note: str(n.note),
        frozen: issuerList(n.frozen), freezable: issuerList(n.freezable), dormant: dormant, stopClass: str(n.stop_class) });
    });
    S.coverage = data.coverage && typeof data.coverage === 'object' && Number(data.coverage.stolen_usd) > 0 ? data.coverage : null;

    S.ops = new Map();
    var opOfEdge = new Map();
    (Array.isArray(data.operations) ? data.operations : []).forEach(function (o, i) {
      if (!o) return;
      var evidence = [], seenUrl = new Set();
      (Array.isArray(o.evidence) ? o.evidence : []).forEach(function (ev) {
        var url = ev && safeUrl(ev.url);
        if (!url || seenUrl.has(url)) return;
        seenUrl.add(url);
        evidence.push({ kind: str(ev.kind), tx: lc(ev.tx), name: EVIDENCE_NAMES[ev.kind] || cap(prettyType(ev.kind || 'record')), url: url });
      });
      var op = {
        id: o.id != null ? String(o.id) : 'op-' + i,
        type: str(o.type), claim: str(o.claim), session: num(o.session), seq: num(o.seq), step: num(o.step),
        verdict: ['VALID', 'INVALID', 'UNDECIDED'].indexOf(o.verdict) !== -1 ? o.verdict : null,
        edge_ids: Array.isArray(o.edge_ids) ? o.edge_ids.map(String) : [],
        evidence: evidence,
        via: viaOf(o.via),
        reasons: reasonsOf(o.checker),
        withdrawn: num(o.withdrawn)   // a human review withdrew it after this step (export: withdrawn.json)
      };
      op.seedOp = op.id === 'theft' || (op.seq === null && op.step === null && op.session === 0);
      S.ops.set(op.id, op);
      op.edge_ids.forEach(function (eid) { if (!opOfEdge.has(eid)) opOfEdge.set(eid, op); });
    });

    var seen = new Set(), maxStep = 0;
    S.edges = [];
    S.touched = new Set();
    (Array.isArray(data.edges) ? data.edges : []).forEach(function (e, i) {
      if (!e) return;
      var from = lc(e.from), to = lc(e.to);
      if (!from || !to) return;
      var id = e.id != null ? String(e.id) : 'edge-' + i;
      while (seen.has(id)) id += '_';
      seen.add(id);
      var op = (e.operation_id != null && S.ops.get(String(e.operation_id))) || opOfEdge.get(id) || null;
      var listed = opOfEdge.get(id);
      var amountStr = e.amount == null ? '' : String(e.amount).trim();
      // The agent step at which this flow was recorded. Seed transfers (the case start) are step 0.
      var step = num(e.step);
      if (step === null && op) step = op.step;
      var seed = step === null && (num(e.session) === 0 || (op && op.seq === null && op.step === null && num(op.session) === 0));
      if (seed) step = 0;
      if (step !== null) maxStep = Math.max(maxStep, step);
      S.edges.push({
        // an exchange edge's amount is what came out, in the target asset: "0.202 ETH from WBTC"
        id: id, from: from, to: to,
        asset: (e.kind === 'exchange' && str(e.from_asset)) ? (str(e.asset) || '?') + ' from ' + str(e.from_asset) : (str(e.asset) || '?'),
        amountStr: amountStr, amount: amountStr === '' ? NaN : Number(amountStr),
        tx: str(e.tx), txUrl: safeUrl(e.tx_url), block: num(e.block), time: str(e.time_utc), op: op,
        step: step, seed: seed,
        srcPos: str(e.source_position), tgtPos: str(e.target_position),
        kind: str(e.kind), fromAsset: str(e.from_asset), toAsset: str(e.asset) || '?',
        swap: e.kind === 'exchange' && from === to,
        tier: e.tier === 'verified' ? 'verified' : 'unverified', // solid only when the export says so
        withdrawn: num(e.withdrawn) !== null ? num(e.withdrawn) : (op ? op.withdrawn : null),
        rejected: e.tier === 'rejected' || !!((op && op.verdict === 'INVALID') || (listed && listed.verdict === 'INVALID'))
      });
      S.touched.add(from);
      S.touched.add(to);
      [from, to].forEach(function (a) {
        if (!S.nodes.has(a)) S.nodes.set(a, { id: a, chain: defaultChain, label: null, role: 'unknown', note: null, frozen: [], freezable: [] });
      });
    });

    var ws = data.workspace && typeof data.workspace === 'object' ? data.workspace : null;
    // The replay covers every recorded step: flows, operations (rejected ones too) and the workspace count.
    S.ops.forEach(function (o) { if (o.step !== null) maxStep = Math.max(maxStep, o.step); });
    S.total = Math.max(maxStep, num(ws && ws.total_steps) || 0);
    // Flows with no step at all appear at the last step.
    S.edges.forEach(function (e) { if (e.step === null) e.step = S.total; });
    var ev = new Set();
    S.edges.forEach(function (e) { if (!e.rejected && !e.seed) ev.add(e.step); });
    S.eventSteps = Array.from(ev).sort(function (a, b) { return a - b; });

    // Groups per (from, to, asset, tier); bundles (drawn edges) per (from, to, tier).
    S.groups = [];
    S.bundles = [];
    S.bundleById = new Map();
    var gByKey = new Map(), bByKey = new Map();
    S.edges.forEach(function (e) {
      if (e.rejected) return;
      var gk = e.from + '|' + e.to + '|' + e.asset + '|' + e.tier;
      var g = gByKey.get(gk);
      if (!g) {
        g = { id: 'g:' + gk, from: e.from, to: e.to, asset: e.asset, tier: e.tier, edges: [] };
        gByKey.set(gk, g);
        S.groups.push(g);
        var bk = e.from + '|' + e.to + '|' + e.tier + (SPLIT_ASSETS ? '|' + e.asset : '');
        var b = bByKey.get(bk);
        if (!b) {
          // Stable ids keep the same drawn edge across live updates.
          b = { id: 'b:' + bk, from: e.from, to: e.to, tier: e.tier, groups: [] };
          bByKey.set(bk, b);
          S.bundles.push(b);
          S.bundleById.set(b.id, b);
        }
        b.groups.push(g);
        g.bundle = b;
      }
      g.edges.push(e);
    });
    S.groups.forEach(function (g) {
      g.edges.sort(function (a, b) { return a.step - b.step || (a.block || 0) - (b.block || 0); });
    });

    // Workspace: open leads and notes are the agent's internal state.
    var rawLeads = ws && Array.isArray(ws.open_leads)
      ? ws.open_leads.map(function (l) { return l && { key: str(l.key) || '', text: str(l.text) }; })
      : (Array.isArray(data.leads) ? data.leads : []).filter(function (l) { return l && l.status !== 'closed'; })
          .map(function (l) { return { key: String(l.account || ''), text: str(l.reason) }; });
    S.workspace = {
      note: ws ? str(ws.note) : null,
      notes: ws && Array.isArray(ws.notes) ? ws.notes.map(str).filter(Boolean) : [],
      leads: rawLeads.filter(function (l) { return l && (l.key || l.text); }).map(parseLead)
    };
    S.leadsByAddr = new Map();
    S.workspace.leads.forEach(function (l) {
      if (!l.addr) return;
      if (!S.leadsByAddr.has(l.addr)) S.leadsByAddr.set(l.addr, []);
      S.leadsByAddr.get(l.addr).push(l);
    });
    S.comingSoon = (Array.isArray(data.coming_soon) ? data.coming_soon : []).filter(function (c) { return c && str(c.chain); });
  }

  // The contract a flow went through: {contract, name, function, explorer}. Names come only from the export.
  function viaOf(v) {
    if (!v || typeof v !== 'object') return null;
    var c = lc(v.contract || '');
    var x = { contract: isAddr(c) ? c : null, name: str(v.name), fn: str(v['function']), explorer: safeUrl(v.explorer) };
    return x.contract || x.name ? x : null;
  }
  function viaText(v) { return v ? (v.name || (v.contract ? short(v.contract) : 'contract')) + (v.fn ? ' · ' + v.fn : '') : ''; }
  function viaLink(v, chain) {
    if (!v) return null;
    var href = v.explorer || (v.contract ? explorerFor(chain).base + '/address/' + v.contract : null);
    return href ? extLink(href, viaText(v)) : el('span', null, viaText(v));
  }

  // The checker's reasons arrive as strings or small objects; keep plain text only.
  function reasonsOf(list) {
    if (!Array.isArray(list)) return typeof list === 'string' && list.trim() ? [list.trim()] : [];
    return list.map(function (r) {
      if (typeof r === 'string') return r.trim();
      if (r && typeof r === 'object') return str(r.reason) || str(r.message) || str(r.detail) || str(r.text) ||
        Object.keys(r).map(function (k) { return typeof r[k] === 'string' || typeof r[k] === 'number' ? k + ': ' + r[k] : ''; }).filter(Boolean).join(', ');
      return '';
    }).filter(Boolean);
  }

  // Match a lead to its address: the full 0x address in the key or text whose start matches the key's 0x prefix.
  function parseLead(l) {
    var key = l.key, keyLc = key.toLowerCase();
    var prefixM = keyLc.match(/0x[0-9a-f]+/);
    var prefix = prefixM ? prefixM[0] : null;
    var full = (keyLc + ' ' + lc(l.text || '')).match(/0x[0-9a-f]{40}(?![0-9a-f])/g) || [];
    var addr = null;
    if (prefix) full.forEach(function (a) { if (!addr && a.indexOf(prefix) === 0) addr = a; });
    full.forEach(function (a) { if (!addr && S.nodes.has(a)) addr = a; });
    if (!addr && full.length) addr = full[0];
    // Keys and texts sometimes carry only a short prefix such as 0x5227; accept it when one address matches.
    if (!addr && prefix && prefix.length >= 6) {
      var hits = [];
      S.nodes.forEach(function (n, id) { if (id.indexOf(prefix) === 0) hits.push(id); });
      if (hits.length === 1) addr = hits[0];
    }
    var asset = null;
    if (prefixM) {
      var rest = key.slice(keyLc.indexOf(prefix) + prefix.length).split('_');
      rest.forEach(function (t) { if (!asset && /^[A-Z][A-Z0-9]{1,9}$/.test(t)) asset = t; });
    }
    return { key: key, text: l.text, addr: addr, asset: asset, items: [] };
  }

  // ---------- view as of an agent step ----------

  // A flow or operation a human review withdrew is gone from the step of the review on.
  function gone(x, N) { return x.withdrawn !== null && x.withdrawn !== undefined && N >= x.withdrawn; }

  function viewAt(N) {
    var groups = new Map(), bundles = new Map(), flows = 0, flowsNow = 0;
    S.groups.forEach(function (g) {
      var vis = g.edges.filter(function (e) { return e.step <= N && !gone(e, N); });
      if (!vis.length) return;
      vis.forEach(function (e) { if (!e.seed) { flows++; if (e.step === N) flowsNow++; } });
      var sum = vis.reduce(function (a, e) { return a + (Number.isFinite(e.amount) ? e.amount : 0); }, 0);
      var gv = { group: g, edges: vis, sum: sum, count: vis.length };
      groups.set(g.id, gv);
      var bv = bundles.get(g.bundle.id);
      if (!bv) { bv = { bundle: g.bundle, groups: [], count: 0 }; bundles.set(g.bundle.id, bv); }
      bv.groups.push(gv);
      bv.count += vis.length;
    });
    bundles.forEach(function (bv) { bv.groups.sort(function (a, b) { return assetOrder([a.group.asset, a.sum], [b.group.asset, b.sum]); }); });

    var nodes = new Set(), inflow = new Map(), outflow = new Map();
    function add(map, id, asset, v) { var m = map.get(id) || new Map(); m.set(asset, (m.get(asset) || 0) + v); map.set(id, m); }
    groups.forEach(function (gv) {
      nodes.add(gv.group.from); nodes.add(gv.group.to);
      if (gv.group.from === gv.group.to) return; // an exchange at one address moves nothing between addresses
      add(outflow, gv.group.from, gv.group.asset, gv.sum);
      add(inflow, gv.group.to, gv.group.asset, gv.sum);
    });
    // Victims always show. Nodes with no transfers at all show at the last step;
    // nodes reached only by rejected claims stay hidden.
    var last = N >= S.total;
    S.nodes.forEach(function (n) { if (n.role === 'victim' || (last && !S.touched.has(n.id))) nodes.add(n.id); });
    return { N: N, groups: groups, bundles: bundles, nodes: nodes, inflow: inflow, outflow: outflow, flows: flows, flowsNow: flowsNow };
  }

  // Before the last step, an attacker or intermediate address with nothing traced out of it yet was an open lead.
  function isFrontierAt(n, view) {
    return view.N < S.total && (n.role === 'pocket' || n.role === 'attacker') && !view.outflow.has(n.id);
  }
  function openLeadCount(id, view) { return view.N >= S.total ? (S.leadsByAddr.get(id) || []).length : 0; }
  function totals(map) { return map ? Array.from(map.entries()).sort(assetOrder) : []; }

  // ---------- node labels ----------

  var measureCtx = document.createElement('canvas').getContext('2d');
  var NODE_FONT_PX = 11;
  function textWidth(t) {
    measureCtx.font = '500 ' + NODE_FONT_PX + 'px "JetBrains Mono", ui-monospace, monospace';
    return measureCtx.measureText(t).width;
  }
  function wrap(text, max, maxLines) {
    var lines = [], cur = '';
    text.split(/\s+/).forEach(function (w) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    lines = lines.map(function (l) { return l.length > max ? l.slice(0, max - 1) + '…' : l; });
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s.,;:]*$/, '').slice(0, max - 1) + '…';
    }
    return lines;
  }
  //: chain badges on nodes in the one-graph view (off for now: that view stays the original one)
  var CHAIN_BADGES = false;
  function nodeClasses(n) { return 'r-' + n.role + ' ch-' + lc(n.chain || 'ethereum') + (CHAIN_BADGES && !S.groupChains ? ' badge' : ''); }
  function edgeClasses(b) {
    var a = S.nodes.get(b.from), z = S.nodes.get(b.to);
    var cross = a && z && lc(a.chain || 'ethereum') !== lc(z.chain || 'ethereum');
    return (b.tier === 'unverified' ? 'dashed' : '') + (cross ? ' cross' : '');
  }

  function nodeLines(n, view, role) {
    var lines = [];
    var leads = openLeadCount(n.id, view);
    var title = n.label || (role === 'open' && leads > 1 ? leads + ' open leads' : TAG_FOR_ROLE[role]) || null;
    if (title) lines = lines.concat(wrap(title, 26, 2));
    lines.push(short(n.id));
    if (role === 'stop' && n.note) lines = lines.concat(wrap(n.note, 24, 2));
    if (role === 'frozen' || role === 'resting') {
      var held = totals(view.inflow.get(n.id)).map(function (p) { return fmt(p[1]) + ' ' + p[0]; });
      if (held.length) lines.push(held.slice(0, 2).join(' + ') + (held.length > 2 ? ' +' + (held.length - 2) : ''));
    }
    var sw = swapsAt(n.id, view);
    if (sw.length) {
      lines.push(swapLine(sw[0]));
      if (sw.length > 1) lines.push('+' + plural(sw.length - 1, 'more swap'));
    }
    if (n.frozen && n.frozen.length) lines.push(n.frozen.map(function (f) { return f.asset + (f.takenBack ? ' taken back' : ' frozen'); }).join(', '));
    if (n.freezable && n.freezable.length) lines.push(n.freezable.map(function (f) { return f.asset; }).join(', ') + ' still freezable');
    // Labelled or non-open nodes say how many open leads the agent still holds on them.
    if (leads && (role !== 'open' || n.label)) lines.push(plural(leads, 'open lead'));
    return lines;
  }

  // Swaps at one address, grouped by asset pair: [{from, to, sum, count, edges}]
  function swapsAt(id, view) {
    var by = new Map();
    view.groups.forEach(function (gv) {
      if (gv.group.from !== id || gv.group.to !== id) return;
      gv.edges.forEach(function (e) {
        if (!e.swap) return;
        var key = (e.fromAsset || '?') + '>' + e.toAsset;
        var x = by.get(key) || { from: e.fromAsset || '?', to: e.toAsset, sum: 0, count: 0, edges: [] };
        x.sum += Number.isFinite(e.amount) ? e.amount : 0;
        x.count++;
        x.edges.push(e);
        by.set(key, x);
      });
    });
    return Array.from(by.values()).sort(function (a, b) { return b.count - a.count; });
  }
  function swapLine(x) {
    // Name the venue only when every swap in the group went through the same one.
    var v = x.edges[0].op && x.edges[0].op.via, same = v && x.edges.every(function (e) { return e.op && e.op.via && viaText(e.op.via) === viaText(v); });
    return 'Swapped ' + x.from + ' to ' + fmt(x.sum) + ' ' + x.to + (same ? ' via ' + (v.name || (v.contract ? short(v.contract) : 'contract')) : '') + ' (' + x.count + ' tx)';
  }
  function nodeData(n, view) {
    var frontier = isFrontierAt(n, view);
    var role = frontier ? 'open' : n.role;
    var lines = nodeLines(n, view, role);
    var w = 0;
    lines.forEach(function (l) { w = Math.max(w, textWidth(l)); });
    return {
      label: lines.join('\n'),
      frozenMark: n.frozen && n.frozen.length ? 1 : 0,
      freezableMark: n.freezable && n.freezable.length ? 1 : 0,
      w: Math.max(92, Math.ceil(w) + 26),
      h: Math.round(lines.length * NODE_FONT_PX * 1.4 + 16),
      color: ROLES[role].color,
      fill: role === 'open' ? C.bg2 : mix(ROLES[role].color, C.bg2, n.role === 'attacker' ? 0.2 : 0.13),
      frontier: frontier
    };
  }

  // ---------- edge labels ----------

  function groupLine(gv) { return fmt(gv.sum) + ' ' + gv.group.asset + (gv.count > 1 ? ' ×' + gv.count : ''); }
  function bundleData(bv) {
    var lines = bv.groups.map(groupLine);
    if (lines.length > MAX_LABEL_LINES) lines = lines.slice(0, MAX_LABEL_LINES - 1).concat('+' + (lines.length - MAX_LABEL_LINES + 1) + ' more assets');
    var ratio = 0;
    bv.groups.forEach(function (gv) {
      var max = S.maxByAsset.get(gv.group.asset) || gv.sum || 1;
      if (max > 0 && Number.isFinite(gv.sum)) ratio = Math.max(ratio, Math.min(1, gv.sum / max));
    });
    if (bv.bundle.from === bv.bundle.to) ratio = 0;
    return { label: lines.join('\n'), width: +(1.3 + 3.4 * Math.sqrt(ratio)).toFixed(2) };
  }

  // ---------- graph ----------

  var MONO = '"JetBrains Mono", ui-monospace, monospace';
  var cyStyle = [
    { selector: 'node', style: {
      'shape': 'round-rectangle', 'width': 'data(w)', 'height': 'data(h)',
      'background-color': 'data(fill)', 'border-width': 1.5, 'border-color': 'data(color)',
      'label': 'data(label)', 'text-wrap': 'wrap', 'text-max-width': '420px',
      'font-family': MONO, 'font-size': NODE_FONT_PX, 'font-weight': 500, 'line-height': 1.4,
      'color': C.ink, 'text-valign': 'center', 'text-halign': 'center',
      'underlay-color': 'data(color)', 'underlay-padding': 5, 'underlay-opacity': 0, 'underlay-shape': 'round-rectangle',
      'overlay-opacity': 0,
      'transition-property': 'opacity, underlay-opacity', 'transition-duration': 0.55
    } },
    { selector: 'node.r-attacker', style: { 'border-width': 2.5 } },
    { selector: 'node.r-victim', style: { 'border-width': 2 } },
    { selector: 'node.r-stop', style: { 'shape': 'cut-rectangle', 'color': C.ink2 } },
    { selector: 'node.r-frozen', style: { 'border-style': 'double', 'border-width': 5 } },
    { selector: 'node.r-resting', style: { 'border-width': 2.5 } },
    { selector: 'node.r-open, node.frontier', style: { 'border-style': 'dashed', 'border-width': 1.5, 'border-color': C.ink } },
    { selector: 'node.r-unknown', style: { 'border-style': 'dotted' } },
    { selector: 'node[frozenMark > 0]', style: { 'border-style': 'double', 'border-width': 5 } },
    { selector: 'node[freezableMark > 0]', style: { 'border-style': 'solid', 'border-width': 3, 'border-color': C.signal, 'underlay-color': C.signal, 'underlay-opacity': 0.18, 'underlay-padding': 6 } },
    { selector: 'node.pulse', style: { 'underlay-opacity': 0.13 } },
    { selector: 'node.dim, node.ldim', style: { 'underlay-opacity': 0 } },
    { selector: 'node.sel', style: { 'underlay-color': C.ink, 'underlay-opacity': 0.22, 'underlay-padding': 5 } },
    { selector: 'node.hover', style: { 'underlay-color': C.amber, 'underlay-opacity': 0.4, 'underlay-padding': 7, 'transition-duration': 0.15 } },

    { selector: 'edge', style: {
      'curve-style': 'bezier', 'control-point-step-size': 40,
      'width': 'data(width)', 'line-color': C.edge, 'target-arrow-color': C.edge,
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.85,
      'label': 'data(label)', 'text-wrap': 'wrap', 'text-max-width': '400px', 'line-height': 1.35,
      'font-family': MONO, 'font-size': 10.5, 'font-weight': 500, 'color': '#dcd5c8',
      'text-background-color': C.bg, 'text-background-opacity': 0.94, 'text-background-padding': 3,
      'text-background-shape': 'round-rectangle',
      'text-border-width': 1, 'text-border-color': '#2e2f35', 'text-border-opacity': 1,
      'overlay-padding': 7, 'overlay-opacity': 0,
      'transition-property': 'opacity, line-color, target-arrow-color', 'transition-duration': 0.55
    } },
    // Fan-in and fan-out edges carry their label near the spread-out end so labels don't pile up.
    { selector: 'edge.lbl-src', style: { 'label': '', 'source-label': 'data(label)', 'source-text-offset': 'data(off)' } },
    { selector: 'edge.lbl-tgt', style: { 'label': '', 'target-label': 'data(label)', 'target-text-offset': 'data(off)' } },
    // An exchange at one address draws as a loop above the node, sized to clear it.
    { selector: 'edge.loop', style: { 'loop-direction': '0deg', 'loop-sweep': '-50deg', 'control-point-step-size': 'data(loop)' } },
    { selector: 'edge.loop-down', style: { 'loop-direction': '180deg' } },
    { selector: 'edge.loop-right', style: { 'loop-direction': '90deg' } },
    { selector: 'edge.loop-left', style: { 'loop-direction': '-90deg' } },
    { selector: 'edge.dashed', style: {
      'line-style': 'dashed', 'line-dash-pattern': [6, 5], 'line-color': C.edgeDashed,
      'target-arrow-color': C.edgeDashed, 'target-arrow-fill': 'hollow', 'color': C.ink2
    } },
    { selector: 'edge.hl', style: { 'line-color': C.ink2, 'target-arrow-color': C.ink2, 'z-index': 5 } },
    { selector: 'edge.sel', style: { 'line-color': C.signal, 'target-arrow-color': C.signal, 'color': C.ink, 'text-border-color': C.signal, 'z-index': 10 } },
    { selector: 'edge.fresh', style: { 'line-color': C.amber, 'target-arrow-color': C.amber, 'z-index': 8 } },
    { selector: 'node.fresh', style: { 'underlay-color': C.amber, 'underlay-opacity': 0.45, 'underlay-padding': 8 } },
    { selector: '.dim', style: { 'opacity': 0.16 } },
    { selector: '.ldim', style: { 'opacity': 0.08 } },
    { selector: 'edge.cross', style: { 'line-color': '#d7c8ff', 'target-arrow-color': '#d7c8ff', 'width': 2.4, 'z-index': 6 } },
    { selector: 'node.lane', style: { 'shape': 'round-rectangle', 'width': 'data(w)', 'height': 'data(h)', 'label': '',
        'background-color': 'data(color)', 'background-opacity': 0.035, 'border-width': 1, 'border-color': 'data(color)',
        'border-opacity': 0.28, 'events': 'no', 'z-index-compare': 'manual', 'z-index': -20 } },
    { selector: 'node.lane.empty', style: { 'border-style': 'dashed', 'background-opacity': 0.015 } },
    { selector: 'node.lanelbl', style: { 'shape': 'rectangle', 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0,
        'label': 'data(label)', 'text-halign': 'right', 'text-valign': 'center', 'color': 'data(color)', 'font-family': MONO,
        'font-size': 11, 'text-wrap': 'none', 'events': 'no', 'z-index-compare': 'manual', 'z-index': -19 } },
    { selector: '.entering', style: { 'opacity': 0 } },
    { selector: '.gone', style: { 'display': 'none' } }
  ];
  // a chain badge above each node's top-right corner, shown when the graph is not grouped by chain
  Object.keys(CHAINS).forEach(function (c) {
    var b = chainBadge(c);
    cyStyle.push({ selector: 'node.badge.ch-' + c, style: { 'background-image': b.url, 'background-width': b.w + 'px',
      'background-height': '13px', 'background-position-x': '100%', 'background-position-y': '0%', 'background-offset-y': -15,
      'background-clip': 'none', 'bounds-expansion': 16, 'background-image-containment': 'over' } });
  });

  function buildGraph() {
    var latest = viewAt(S.total);
    S.maxByAsset = new Map();
    latest.groups.forEach(function (gv) {
      if (gv.group.from === gv.group.to) return;
      S.maxByAsset.set(gv.group.asset, Math.max(S.maxByAsset.get(gv.group.asset) || 0, gv.sum));
    });

    var els = [];
    S.nodes.forEach(function (n) {
      if (!latest.nodes.has(n.id)) return;
      els.push({ group: 'nodes', data: Object.assign({ id: n.id }, nodeData(n, latest)), classes: nodeClasses(n) });
    });
    latest.bundles.forEach(function (bv) {
      var b = bv.bundle;
      if (b.from === b.to) return; // swaps at one address are listed on the node instead
      var self = false;
      var loop = self ? Math.round(nodeData(S.nodes.get(b.from), latest).h / 2 + 46) : 40;
      els.push({ group: 'edges', data: Object.assign({ id: b.id, source: b.from, target: b.to, off: 90, loop: loop }, bundleData(bv)),
        classes: edgeClasses(b) + (self ? ' loop' : '') });
    });

    if (S.cy) S.cy.destroy();
    S.cy = cytoscape({
      container: $('cy'), elements: els, style: cyStyle,
      minZoom: 0.05, maxZoom: 2.5, boxSelectionEnabled: false, autounselectify: true
    });
    if (els.length) layoutGraph(false);
    bindGraphEvents();
  }

  // Decide where each edge label sits, using the final layout.
  function placeEdgeLabels() {
    var cy = S.cy;
    var indeg = new Map(), outdeg = new Map();
    cy.edges().forEach(function (e) {
      if (e.source().id() === e.target().id()) return;
      indeg.set(e.target().id(), (indeg.get(e.target().id()) || 0) + 1);
      outdeg.set(e.source().id(), (outdeg.get(e.source().id()) || 0) + 1);
    });
    cy.batch(function () {
      cy.edges().forEach(function (e) {
        var s = e.source(), t = e.target();
        e.removeClass('lbl-src lbl-tgt loop-down loop-right loop-left');
        if (s.id() === t.id()) { aimLoop(e, s, outdeg.get(s.id()) || 0); return; }
        var inT = indeg.get(t.id()) || 0, outS = outdeg.get(s.id()) || 0;
        var dx = t.position('x') - s.position('x'), dy = t.position('y') - s.position('y');
        var len = Math.sqrt(dx * dx + dy * dy) - (s.width() + t.width()) / 2;
        var lines = String(e.data('label')).split('\n');
        var halfW = Math.max.apply(null, lines.map(function (l) { return l.length; })) * 3.4 + 8;
        if (len < 2 * halfW + 40) return; // short edge: the middle is the only room
        if (inT >= 3 && inT >= outS) e.addClass('lbl-src');
        else if (outS >= 3) e.addClass('lbl-tgt');
        else return;
        e.data('off', Math.round(Math.min(Math.max(halfW + 16, len * 0.3), len / 2)));
      });
    });
  }

  // Point a same-address loop at the free side of its node: up, down, or right when nothing leaves it.
  function aimLoop(e, n, out) {
    var p = n.position(), hw = n.width() / 2, up = Infinity, down = Infinity;
    S.cy.nodes().not('.lane, .lanelbl').forEach(function (o) {
      if (o.same(n)) return;
      var q = o.position();
      if (Math.abs(q.x - p.x) > hw + o.width() / 2) return;
      var gap = Math.abs(q.y - p.y) - (n.height() + o.height()) / 2;
      if (q.y < p.y) up = Math.min(up, gap); else down = Math.min(down, gap);
    });
    var need = e.data('loop') + 24;
    if (up >= need) return;
    if (down >= need) { e.addClass('loop-down'); return; }
    // Boxed in above and below: use the gap beside the node, far enough out for the label.
    e.addClass(out ? 'loop-left' : 'loop-right');
    e.data('loop', Math.round(hw + 80));
  }

  function bindGraphEvents() {
    var cy = S.cy;
    cy.on('tap', 'node', function (evt) { stopPlay(); select({ kind: 'node', id: evt.target.id() }); });
    cy.on('tap', 'edge', function (evt) { stopPlay(); select({ kind: 'bundle', id: evt.target.id() }); });
    cy.on('tap', function (evt) { if (evt.target === cy) select(null); });
    cy.on('viewport resize', function () { positionBandLabels(); });
    cy.on('mouseover', 'node', function (evt) { $('cy').style.cursor = 'pointer'; markLeads(evt.target.id(), true); });
    cy.on('mouseout', 'node', function (evt) { $('cy').style.cursor = ''; markLeads(evt.target.id(), false); });
    cy.on('mouseover', 'edge', function () { $('cy').style.cursor = 'pointer'; });
    cy.on('mouseout', 'edge', function () { $('cy').style.cursor = ''; });
    ['wheel', 'mousedown', 'touchstart'].forEach(function (t) {
      $('cy').addEventListener(t, function () { S.userMoved = true; }, { passive: true });
    });
  }

  // Two-way hover link between graph nodes and the open-leads list.
  function markLeads(addr, on, reveal) {
    if (on && reveal && activeTab() !== 'mem') setTab('mem');
    var first = null;
    (S.leadsByAddr.get(addr) || []).forEach(function (l) { l.items.forEach(function (li) { li.classList.toggle('hl', on); if (!first) first = li; }); });
    if (on && first && activeTab() === 'mem' && (reveal || WIDE())) revealInWorkspace(first);
  }
  function WIDE() { return window.matchMedia('(min-width: 1000px)').matches; }
  // Scroll the workspace column (not the page) so an entry is visible.
  // Position of an element inside the scrolling workspace column.
  function offsetIn(box, li) { return box.scrollTop + li.getBoundingClientRect().top - box.getBoundingClientRect().top; }
  function revealInWorkspace(li) {
    var box = $('workspace');
    var top = offsetIn(box, li), bottom = top + li.offsetHeight;
    if (box.scrollHeight <= box.clientHeight + 2) { li.scrollIntoView({ block: 'nearest', behavior: REDUCED_MOTION ? 'auto' : 'smooth' }); return; }
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: Math.max(0, top - 60), behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    }
  }
  function markNode(addr, on) {
    if (!S.cy || !addr) return;
    var ele = S.cy.getElementById(addr);
    if (ele && ele.nonempty()) ele.toggleClass('hover', on);
  }

  function fitView(animate) {
    if (!S.cy) return;
    S.cy.resize();
    var eles = S.cy.elements().not('.gone');
    if (!eles.length) return;
    var pad = EMBED ? 24 : 36;
    S.userMoved = false;
    S.cy.stop();
    var vp = fitViewport(eles, pad);
    if (animate && !REDUCED_MOTION) S.cy.animate(vp, { duration: 600, easing: 'ease-in-out-cubic' });
    else S.cy.viewport(vp);
  }

  // The viewport fit() would give, except that a graph larger than the view at the minimum zoom
  // starts at its top-left (where the theft begins) instead of being cut on every side.
  function fitViewport(eles, pad) {
    var bb = eles.boundingBox(), w = S.cy.width(), h = S.cy.height();
    var z = Math.min((w - 2 * pad) / Math.max(bb.w, 1), (h - 2 * pad) / Math.max(bb.h, 1));
    z = Math.max(S.cy.minZoom(), Math.min(z, 1.35, S.cy.maxZoom()));
    var x = bb.w * z + 2 * pad > w ? pad - bb.x1 * z : (w - bb.w * z) / 2 - bb.x1 * z;
    var y = bb.h * z + 2 * pad > h ? pad - bb.y1 * z : (h - bb.h * z) / 2 - bb.y1 * z;
    return { zoom: z, pan: { x: x, y: y } };
  }

  // ---------- apply a step ----------

  function apply(step, opts) {
    opts = opts || {};
    S.step = Math.max(0, Math.min(S.total, step));
    var view = viewAt(S.step);
    S.view = view;
    var cy = S.cy, entering = [];

    function reveal(ele) {
      if (!ele.hasClass('gone')) return;
      ele.removeClass('gone');
      if (opts.animate && !REDUCED_MOTION) { ele.addClass('entering'); entering.push(ele); }
    }
    cy.batch(function () {
      cy.nodes().not('.lane, .lanelbl').forEach(function (ele) {
        var n = S.nodes.get(ele.id());
        if (view.nodes.has(n.id)) {
          var d = nodeData(n, view);
          ele.data(d);
          ele.toggleClass('frontier', d.frontier);
          reveal(ele);
        } else ele.addClass('gone').removeClass('entering hover');
      });
      cy.edges().forEach(function (ele) {
        var bv = view.bundles.get(ele.id());
        if (bv) { ele.data(bundleData(bv)); reveal(ele); }
        else ele.addClass('gone').removeClass('entering');
      });
    });
    if (entering.length) setTimeout(function () { entering.forEach(function (e) { e.removeClass('entering'); }); }, 40);

    if (S.selected) {
      var still = S.selected.kind === 'rejected' || (S.selected.kind === 'node' || S.selected.kind === 'swaps' ? view.nodes.has(S.selected.id) : view.bundles.has(S.selected.id));
      if (!still) S.selected = null;
    }
    safe('selection', applySelection);
    safe('legend pins', function () { legendPick(null); });
    safe('stats', function () { renderStats(view); });
    safe('replay label', function () { renderTimeline(view); });
    safe('detail panel', renderDetail);
    if (opts.fit !== false && (entering.length || !opts.animate)) fitView(!!opts.animate);
    showMsg(view.groups.size ? '' : 'No flows traced yet.');
    safe('timeline', function () { syncTrajectory(!!opts.animate); });
    safe('flows table', markFlowTable);
    return entering.length;
  }

  // ---------- selection ----------

  function select(sel) {
    S.selected = sel;
    applySelection();
    renderDetail();
    $('detail').scrollTop = 0;
    if (sel && window.matchMedia('(max-width: 999px)').matches && !EMBED) {
      $('detail').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function applySelection() {
    var cy = S.cy;
    if (!cy) return;
    cy.batch(function () {
      cy.elements().removeClass('dim sel hl');
      if (!S.selected || S.selected.kind === 'rejected') return;
      var ele = cy.getElementById(S.selected.id);
      if (!ele || ele.empty() || ele.hasClass('gone')) return;
      var keep;
      if (S.selected.kind === 'node' || S.selected.kind === 'swaps') {
        var edges = ele.connectedEdges().not('.gone');
        edges.addClass('hl');
        keep = ele.union(edges).union(edges.connectedNodes());
      } else keep = ele.union(ele.connectedNodes());
      ele.addClass('sel');
      cy.elements().not('.gone, .lane, .lanelbl').difference(keep).addClass('dim');
    });
  }

  function focusNode(id, scroll) {
    if (!id) return;
    if (!S.view.nodes.has(id)) {
      if (!viewAt(S.total).nodes.has(id)) return;
      stopPlay();
      apply(S.total, { fit: false });
    }
    if (scroll) {
      var r = $('cy').getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) $('graph-anchor').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    }
    select({ kind: 'node', id: id });
    var ele = S.cy.getElementById(id);
    if (ele && ele.nonempty()) {
      if (REDUCED_MOTION) S.cy.center(ele);
      else S.cy.animate({ center: { eles: ele } }, { duration: 400 });
    }
  }

  // ---------- header, stats, legend ----------

  function renderHeader() {
    var c = S.caseInfo;
    var title = str(c.title) || 'Live trace';
    var h1 = $('case-title');
    clear(h1);
    title.split(/(MOCK DATA)/i).forEach(function (part) {
      if (!part) return;
      h1.appendChild(/^MOCK DATA$/i.test(part) ? el('span', { class: 'mock' }, part) : document.createTextNode(part));
    });
    document.title = (/mock/i.test(title) ? 'MOCK DATA: ' : '') + 'ABF-Agent: tracing the Binance hack live';
    $('watermark').hidden = !/mock/i.test(title);
    $('chain-name').textContent = chainsText();
    $('intro').textContent = 'I follow the stolen funds on ' + chainsText() + ' one transaction at a time. Keep an eye on this page; it updates on its own.';

    var inc = $('incident');
    clear(inc);
    if (c.incident_utc) append(inc, ['Incident ', el('b', null, fmtTime(c.incident_utc))]);
    var upd = $('updated');
    clear(upd);
    var bits = [];
    if (c.updated_utc) bits.push('Last updated ', el('b', null, fmtTime(c.updated_utc)));
    if (c.head_block != null && c.head_block !== '') bits.push(bits.length ? ' · block ' : 'Block ', el('b', null, String(c.head_block)));
    append(upd, bits);
  }

  // Per asset, what traced flows left at addresses where the issuer froze that asset:
  // received minus sent, so funds that pass between two frozen addresses count once.
  // When the export carries the balance read on chain (held), that is the frozen amount: an exchange
  // edge is in the asset it delivered, so received minus sent overstates what stayed after a swap.
  function frozenTotals(view) {
    var m = new Map();
    view.nodes.forEach(function (id) {
      var n = S.nodes.get(id), inflow = view.inflow.get(id), outflow = view.outflow.get(id);
      if (n && (n.frozen || []).some(function (f) { return f.held !== null; })) {
        n.frozen.forEach(function (f) { if (f.held > 0) m.set(f.asset, (m.get(f.asset) || 0) + f.held); });
        return;
      }
      if (!n || !inflow) return;
      if (n.role === 'frozen') { inflow.forEach(function (v, a) { m.set(a, (m.get(a) || 0) + v); }); return; }
      (n.frozen || []).forEach(function (f) {
        var held = (inflow.get(f.asset) || 0) - ((outflow && outflow.get(f.asset)) || 0);
        if (held > 0) m.set(f.asset, (m.get(f.asset) || 0) + held);
      });
    });
    return m;
  }

  function freezableTotals(view) {
    var m = new Map();
    view.nodes.forEach(function (id) {
      var n = S.nodes.get(id);
      (n && n.freezable || []).forEach(function (f) { if (f.held > 0) m.set(f.asset, (m.get(f.asset) || 0) + f.held); });
    });
    return m;
  }

  function renderNotes() {
    var box = $('stat-notes');
    clear(box);
    var notes = Array.isArray(S.caseInfo.notes) ? S.caseInfo.notes.map(str).filter(Boolean) : [];
    notes.forEach(function (n) { box.appendChild(el('p', null, n)); });
    box.hidden = !notes.length;
  }

  // Where the stolen value is now (coverage.py): shares of the value taken, valued at the prices of
  // the theft; balances as of the last export.  Current figures only, so the replay leaves it alone.
  function usd(x) {
    var a = Math.abs(x);
    if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(x).toLocaleString('en-US');
  }
  // the chains the traced graph covers, in words ("Ethereum and Bitcoin")
  function chainsText() {
    var seen = [];
    S.nodes.forEach(function (n) { var c = cap(n.chain || 'ethereum'); if (seen.indexOf(c) === -1) seen.push(c); });
    seen.sort(function (a, b) { return a === 'Ethereum' ? -1 : b === 'Ethereum' ? 1 : a.localeCompare(b); });
    return seen.length > 1 ? seen.slice(0, -1).join(', ') + ' and ' + seen[seen.length - 1] : (seen[0] || 'Ethereum');
  }
  function renderCoverage() {
    var box = $('coverage');
    if (!box) return;
    clear(box);
    var c = S.coverage;
    box.hidden = !c;
    if (!c) return;
    var total = Number(c.stolen_usd);
    var view = viewAt(S.total);  // money figures are current; the replay moves the graph and the work line
    function roleSum(role, map) {
      var m = new Map();
      map.forEach(function (assets, id) {
        var n = S.nodes.get(id);
        if (!n || n.role !== role || !view.nodes.has(id)) return;
        assets.forEach(function (v, a) { m.set(a, (m.get(a) || 0) + v); });
      });
      return m;
    }
    // amounts by asset; "+N more" opens the whole list and "fewer" closes it (kept across live refreshes)
    S.covOpen = S.covOpen || new Set();
    function amounts(key, pairs, max, cls) {
      if (!pairs.length) return null;
      var open = S.covOpen.has(key);
      var shown = open ? pairs : pairs.slice(0, max), rest = pairs.length - shown.length;
      var line = el('div', { class: cls },
        shown.map(function (p) { return el('span', { class: 'amt' }, fmt(p[1], 2), el('span', { class: 'asset' }, p[0])); }),
        rest > 0 || open && pairs.length > max ? el('button', { type: 'button', class: 'cov-more', onclick: function (ev) {
          ev.stopPropagation();
          if (S.covOpen.has(key)) S.covOpen.delete(key); else S.covOpen.add(key);
          renderCoverage();
        } }, open ? 'fewer' : '+' + rest + ' more') : null);
      return line;
    }
    function assetLine(map, max, key) { return amounts(key, totals(map), max, 'cov-detail'); }
    function pct(v) { var x = 100 * v / total; return (x > 0 && x < 0.1 ? '<0.1' : x.toFixed(1)) + '%'; }
    // what entered listed custody, split by whether it is a bridge (the money continues on another chain)
    function stopSum(bridge) {
      var m = new Map();
      view.inflow.forEach(function (assets, id) {
        var n = S.nodes.get(id);
        if (!n || n.role !== 'stop' || !view.nodes.has(id) || BRIDGE_CLASSES.indexOf(n.stopClass) !== -1 !== bridge) return;
        assets.forEach(function (v, a) { m.set(a, (m.get(a) || 0) + v); });
      });
      return m;
    }
    var still = totals(freezableTotals(view));
    var parts = [
      { key: 'frozen', label: 'Frozen or taken back by issuers', v: Number(c.frozen_usd) || 0, color: ROLES.frozen.color,
        desc: 'Held at addresses the token\'s issuer has frozen, or taken back by the issuer',
        detail: [assetLine(frozenTotals(view), 2, 'frozen'),
          el('div', { class: 'cov-detail' + (still.length ? ' alert' : '') }, 'Still freezable: ',
            still.length ? still.map(function (p) { return el('b', null, fmt(p[1], 2) + ' ' + p[0] + ' '); }) : 'none')] },
      { key: 'dormant', label: 'Dormant', v: Number(c.dormant_usd) || 0, color: ROLES.resting.color,
        desc: 'Still at addresses I traced; nothing has left',
        detail: [assetLine(dormantTotals(view), 2, 'dormant')] },
      { key: 'bridged', label: 'Bridged out', v: Number(c.bridged_usd) || 0, color: BRIDGED_COLOR,
        desc: 'Sent through a bridge to another chain; I don\'t follow the other side yet',
        detail: [assetLine(stopSum(true), 2, 'bridged')] },
      { key: 'stop', label: 'Into a stop', v: Number(c.stop_usd) || 0, color: ROLES.stop.color,
        desc: 'An exchange, mixer or other service on the case\'s list, where on-chain tracing ends',
        detail: [assetLine(stopSum(false), 2, 'stop')] },
      { key: 'open', group: 'Not yet traced', label: 'Open leads', v: Number(c.unaccounted_usd) || 0, color: null,
        desc: 'Left an address I traced; the next hop is not recorded yet (what swaps lost or gained counts here too)',
        detail: [] },
      { key: 'untraced', group: 'Not yet traced', label: 'Untraced chains', v: Number(c.untraced_usd) || 0, color: null,
        desc: 'Theft on chains I don\'t read yet',
        detail: [el('div', { class: 'cov-detail' }, (c.untraced_chains || []).map(function (r) {
          return el('span', { class: 'amt' }, str(r.name) || cap(str(r.chain) || ''), el('span', { class: 'asset' }, usd(Number(r.usd) || 0)));
        }))] }
    ].filter(function (p) { return p.v > 0; });
    function fill(p, cls) {
      return el('span', { class: cls + ' cov-fill ' + p.key, 'data-key': p.key, style: p.color ? 'background:' + p.color : null });
    }
    append(box, [
      el('div', { class: 'cov-title' }, 'Where the ' + usd(total) + ' taken is now'),
      el('div', { class: 'cov-bar', role: 'img', 'aria-label': parts.map(function (p) { return p.label + ' ' + pct(p.v); }).join(', ') },
        parts.map(function (p) {
          var seg = fill(p, 'cov-seg');
          seg.style.width = (100 * p.v / total) + '%';
          seg.title = p.label + ': ' + usd(p.v) + ' (' + pct(p.v) + ')';
          return seg;
        })),
      el('div', { class: 'cov-cards' }, parts.map(function (p) {
        return el('div', { class: 'cov-card' + (p.group ? ' grouped' : ''), 'data-key': p.key, tabindex: '0' },
          p.group ? el('div', { class: 'cov-group' }, p.group) : null,
          el('div', { class: 'cov-head' }, fill(p, 'cov-sw'), el('span', { class: 'cov-label' }, p.label)),
          el('div', { class: 'cov-num' }, el('b', null, usd(p.v)), el('span', { class: 'cov-pct' }, pct(p.v))),
          p.desc ? el('div', { class: 'cov-desc' }, p.desc) : null,
          p.detail);
      })),
      el('p', { class: 'cov-note' }, 'Valued at prices at the time of the theft; balances read on chain' +
        (c.head_block ? ' around block ' + Number(c.head_block).toLocaleString('en-US') : '') + '.')
    ]);
    // hover (or tap) a card or a segment: that part lights up, the rest dims
    var pinned = null;
    function focus(key) {
      box.classList.toggle('focusing', !!key);
      Array.prototype.forEach.call(box.querySelectorAll('[data-key]'), function (e) {
        e.classList.toggle('on', !!key && e.getAttribute('data-key') === key);
      });
    }
    Array.prototype.forEach.call(box.querySelectorAll('.cov-seg, .cov-card'), function (e) {
      var key = e.getAttribute('data-key');
      e.addEventListener('mouseenter', function () { focus(key); });
      e.addEventListener('mouseleave', function () { focus(pinned); });
      e.addEventListener('focus', function () { focus(key); });
      e.addEventListener('blur', function () { focus(pinned); });
      e.addEventListener('click', function () { pinned = pinned === key ? null : key; focus(pinned); });
    });
  }


  // What was taken, by chain: a bar in the chains' hues and a chip per chain; click a chip for its assets.
  // Chains the trace does not read yet are drawn faded with a dashed outline, as in the coverage bar.
  function renderChainOverview() {
    var box = $('chain-overview');
    if (!box) return;
    clear(box);
    var rows = (S.coverage && S.coverage.by_chain) || [];
    box.hidden = !rows.length;
    if (!rows.length) return;
    var total = rows.reduce(function (t, r) { return t + (Number(r.usd) || 0); }, 0);
    function pct(v) { var x = 100 * v / total; return (x > 0 && x < 0.1 ? '<0.1' : x.toFixed(x < 10 ? 1 : 0)) + '%'; }
    function assetsText(r) { return (r.assets || []).slice(0, 4).map(function (a) { return fmt(a.amount, 2) + ' ' + a.symbol; }).join(', '); }
    var open = rows.filter(function (r) { return r.chain === S.coChain; })[0];
    append(box, [
      el('div', { class: 'co-title' }, 'Taken on ' + rows.length + ' chains', el('b', null, usd(total))),
      el('div', { class: 'co-bar' }, rows.map(function (r) {
        var ch = chainInfo(r.chain);
        return el('span', { class: 'co-seg' + (r.traced ? '' : ' untraced'), 'data-chain': r.chain,
          style: 'width:' + (100 * r.usd / total) + '%;background:' + ch.color,
          title: (str(r.name) || ch.name) + ': ' + usd(r.usd) + ' (' + pct(r.usd) + ')' + (r.traced ? '' : ', not traced yet') + '\n' + assetsText(r) });
      })),
      el('div', { class: 'co-chips' }, rows.map(function (r) {
        var ch = chainInfo(r.chain);
        return el('button', { type: 'button', class: 'co-chip' + (r.traced ? '' : ' untraced') + (r.chain === S.coChain ? ' on' : ''),
          'data-chain': r.chain, title: (str(r.name) || ch.name) + (r.traced ? '' : ' (not traced yet)'), style: 'color:' + ch.color,
          onclick: function () { S.coChain = S.coChain === r.chain ? null : r.chain; renderChainOverview(); } },
          ch.code, el('b', null, usd(r.usd)));
      })),
      open ? (function () {
        var key = 'chain:' + open.chain, all = S.covOpen && S.covOpen.has(key), list = open.assets || [];
        var shown = all ? list : list.slice(0, 5);
        return el('div', { class: 'co-detail' }, el('span', null, (str(open.name) || chainInfo(open.chain).name) + (open.traced ? ':' : ' (not traced yet):')),
          shown.map(function (a) { return el('span', { class: 'amt' }, fmt(a.amount, 2), el('span', { class: 'asset' }, a.symbol)); }),
          list.length > 5 ? el('button', { type: 'button', class: 'cov-more', onclick: function () {
            S.covOpen = S.covOpen || new Set();
            if (S.covOpen.has(key)) S.covOpen.delete(key); else S.covOpen.add(key);
            renderChainOverview();
          } }, all ? 'fewer' : '+' + (list.length - 5) + ' more') : null);
      })() : null
    ]);
    Array.prototype.forEach.call(box.querySelectorAll('[data-chain]'), function (e) {
      var c = e.getAttribute('data-chain');
      e.addEventListener('mouseenter', function () {
        box.classList.add('focusing');
        Array.prototype.forEach.call(box.querySelectorAll('.co-seg'), function (x) { x.classList.toggle('on', x.getAttribute('data-chain') === c); });
      });
      e.addEventListener('mouseleave', function () { box.classList.remove('focusing'); });
    });
  }

  function dormantTotals(view) {
    var m = new Map();
    view.nodes.forEach(function (id) {
      var n = S.nodes.get(id);
      (n && n.dormant || []).forEach(function (d) { m.set(d.asset, (m.get(d.asset) || 0) + d.amount); });
    });
    return m;
  }

  function renderStats(view) {
    var box = $('stats');
    clear(box);
    function byRole(role, map) {
      var m = new Map();
      map.forEach(function (assets, id) {
        var n = S.nodes.get(id);
        if (!n || n.role !== role || !view.nodes.has(id)) return;
        assets.forEach(function (v, a) { m.set(a, (m.get(a) || 0) + v); });
      });
      return m;
    }
    function amountCell(cls, label, color, map, maxItems) {
      var pairs = totals(map);
      var shown = pairs.length > maxItems ? pairs.slice(0, maxItems - 1) : pairs;
      var rest = pairs.length - shown.length;
      return el('div', { class: 'stat ' + cls, title: pairs.map(function (p) { return fmt(p[1], 2) + ' ' + p[0]; }).join('\n') || null },
        el('div', { class: 'stat-label' }, el('span', { class: 'swatch', style: 'color:' + color }), label),
        el('div', { class: 'stat-value' },
          pairs.length ? shown.map(function (p) { return el('span', { class: 'amt' }, fmt(p[1], 2), el('span', { class: 'asset' }, p[0])); }) : el('span', { class: 'none' }, 'None yet'),
          rest > 0 ? el('span', { class: 'more' }, '+' + rest + ' more') : null));
    }
    function countCell(label, value, onclick, title) {
      return el('div', { class: 'stat small' }, el('div', { class: 'stat-label' }, label),
        el('div', { class: 'stat-value' }, onclick ? el('button', { type: 'button', class: 'amt rej-btn', title: title || null, onclick: onclick }, String(value)) : el('span', null, String(value))));
    }
    // Frozen, and under it what the issuers could still freeze (none: everything held is frozen)
    function frozenCell(v) {
      var cell = amountCell('', 'Frozen', ROLES.frozen.color, frozenTotals(v), 3);
      var still = totals(freezableTotals(v));
      append(cell, el('div', { class: 'stat-sub' + (still.length ? ' alert' : '') }, 'Still freezable: ',
        still.length ? still.map(function (p) { return el('b', null, fmt(p[1], 2) + ' ' + p[0] + ' '); }) : 'none'));
      return cell;
    }
    var c = checkerCounts(view.N);
    var checkerCell = el('div', { class: 'stat checker' },
      el('div', { class: 'stat-label' }, el('span', { class: 'swatch', style: 'color:var(--ok)' }), 'Checked by the verifier'),
      el('div', { class: 'stat-value' },
        el('span', { class: 'amt' }, String(c.valid), el('span', { class: 'asset' }, 'valid')),
        el('button', { type: 'button', class: 'amt rej-btn' + (c.rejected ? ' has' : ''), title: 'Show the claims the checker rejected',
          onclick: function () { stopPlay(); select({ kind: 'rejected' }); } }, String(c.rejected), el('span', { class: 'asset' }, 'rejected')),
        el('span', { class: 'amt' }, String(c.unchecked), el('span', { class: 'asset' }, 'unchecked'))));
    append(box, [
      countCell('Flows traced', view.flows, function () { $('flows').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' }); }, 'Show the list of all flows'),
      checkerCell,
      countCell('Addresses', view.nodes.size),
      // the page header carries the cost against the budget; the embed (screenshots) has no header line
      !EMBED ? null : el('div', { class: 'stat small cost', title: T.costNote || null },
        el('div', { class: 'stat-label' }, 'Model cost'),
        el('div', { class: 'stat-value' }, T.cost !== null && T.cost !== undefined
          ? el('span', { class: 'amt' }, '$' + T.cost.toFixed(2), el('span', { class: 'asset' }, 'so far'))
          : el('span', { class: 'none' }, 'Not yet')))
    ]);
  }

  function renderLegend() {
    var box = $('legend');
    clear(box);
    var present = new Set();
    viewAt(S.total).nodes.forEach(function (id) { present.add(S.nodes.get(id).role); });
    if (S.eventSteps.length) present.add('open'); // the replay draws earlier frontiers as open leads
    ROLE_ORDER.forEach(function (r) {
      if (present.has(r)) box.appendChild(el('span', { class: 'item', 'data-pick': 'role:' + r }, el('span', { class: 'node-swatch ' + r, style: '--c:' + ROLES[r].color }), LEGEND_TEXT[r] || ROLES[r].name));
    });
    var anyFrozen = false;
    viewAt(S.total).nodes.forEach(function (id) { var n = S.nodes.get(id); if (n.frozen && n.frozen.length) anyFrozen = true; });
    if (anyFrozen && !present.has('frozen')) box.appendChild(el('span', { class: 'item', 'data-pick': 'frozen' }, el('span', { class: 'node-swatch frozen', style: '--c:' + C.ink2 }), 'Double border: an asset here is frozen or taken back by its issuer'));
    var anyFreezable = false;
    viewAt(S.total).nodes.forEach(function (id) { var n = S.nodes.get(id); if (n.freezable && n.freezable.length) anyFreezable = true; });
    if (anyFreezable) box.appendChild(el('span', { class: 'item', 'data-pick': 'freezable' }, el('span', { class: 'node-swatch', style: '--c:' + C.signal + ';border-color:' + C.signal }), 'Red border: stablecoins here its issuer could still freeze'));
    box.appendChild(el('span', { class: 'lines' },
      el('span', { class: 'item', 'data-pick': 'solid' }, el('span', { class: 'line-swatch' }), 'Checked by the verifier'),
      el('span', { class: 'item', 'data-pick': 'dashed' }, el('span', { class: 'line-swatch dashed' }), 'Agent claim the checker could not evaluate yet'),
      S.cy && S.cy.edges('.cross').length ? el('span', { class: 'item', 'data-pick': 'cross' }, el('span', { class: 'line-swatch cross' }), 'Crosses from one chain to another') : null));
    Array.prototype.forEach.call(box.querySelectorAll('[data-pick]'), function (item) {
      var pick = item.getAttribute('data-pick');
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.classList.toggle('pinned', S.pinned.has(pick));
      item.addEventListener('mouseenter', function () { legendPick(pick); });
      item.addEventListener('mouseleave', function () { legendPick(null); });
      function toggle() {
        if (S.pinned.has(pick)) S.pinned.delete(pick); else S.pinned.add(pick);
        item.classList.toggle('pinned', S.pinned.has(pick));
        legendPick(null);
      }
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    });
    legendPick(null);
  }

  // The graph elements legend entries stand for: the pinned ones (click) plus the one under the
  // pointer stay lit, the rest of the graph dims; nothing pinned or hovered, nothing dims
  function legendElements(pick) {
    var cy = S.cy;
    var info = function (n) { return S.nodes.get(n.id()) || {}; };
    return pick.indexOf('role:') === 0 ? cy.nodes('.r-' + pick.slice(5))
      : pick === 'frozen' ? cy.nodes().filter(function (n) { return (info(n).frozen || []).length > 0; })
      : pick === 'freezable' ? cy.nodes().filter(function (n) { return (info(n).freezable || []).length > 0; })
      : pick === 'solid' ? cy.edges().not('.dashed') : pick === 'cross' ? cy.edges('.cross') : cy.edges('.dashed');
  }
  function legendPick(hover) {
    var cy = S.cy;
    if (!cy) return;
    var picks = Array.from(S.pinned);
    if (hover && picks.indexOf(hover) === -1) picks.push(hover);
    Array.prototype.forEach.call($('legend').querySelectorAll('[data-pick]'), function (e) {
      e.classList.toggle('on', picks.indexOf(e.getAttribute('data-pick')) !== -1);
    });
    cy.elements().removeClass('ldim');
    if (!picks.length) return;
    var keep = cy.collection();
    picks.forEach(function (p) { keep = keep.union(legendElements(p)); });
    cy.elements().not('.gone, .lane, .lanelbl').difference(keep).addClass('ldim');
  }

  // ---------- replay ----------

  function buildTimelineControls() {
    var sl = $('slider');
    sl.min = '0';
    sl.max = String(S.total);
    sl.disabled = S.total < 1;
    $('btn-play').disabled = S.total < 1;
    var marks = $('marks');
    clear(marks);
    S.eventSteps.forEach(function (st) {
      var pct = S.total ? (st / S.total) * 100 : 100;
      marks.appendChild(el('span', { style: 'left:' + pct + '%', title: 'Step ' + st }));
    });
    $('tick-start').textContent = '0';
    $('tick-end').textContent = String(S.total);
  }

  function renderTimeline(view) {
    var sl = $('slider');
    sl.value = String(S.step);
    sl.style.setProperty('--fill', (S.total ? (S.step / S.total) * 100 : 100) + '%');
    sl.setAttribute('aria-valuetext', 'Step ' + S.step + ' of ' + S.total);
    Array.prototype.forEach.call($('marks').children, function (m, i) { m.classList.toggle('on', S.eventSteps[i] <= S.step); });
    var title = $('step-title');
    clear(title);
    append(title, [el('b', null, 'Step ' + S.step), ' of ' + S.total]);
    var spent = costAt(S.step);
    if (spent !== null) append(title, [el('span', { class: 'spent' }, ' · $' + spent.toFixed(2) + ' spent')]);
    var summary;
    if (S.step === 0) summary = 'Case start: the theft transfers the case was opened with.';
    else summary = plural(view.flows, 'flow') + ' recorded so far' + (view.flowsNow ? ', ' + view.flowsNow + ' at this step.' : '.');
    $('step-summary').textContent = summary;
  }

  function nextEventAfter(step) {
    for (var i = 0; i < S.eventSteps.length; i++) if (S.eventSteps[i] > step) return S.eventSteps[i];
    return null;
  }

  function startPlay() {
    if (S.total < 1) return;
    S.playing = true;
    $('btn-play').classList.add('playing');
    $('btn-play').setAttribute('aria-label', 'Pause replay');
    S.selected = null;
    T.pinK = null;
    if (S.step >= S.total) apply(0, { animate: true });
    var tick = function () {
      if (!S.playing) return;
      if (S.step >= S.total) { stopPlay(); return; }
      var added = apply(S.step + 1, { animate: true });
      // A full replay takes about half a minute however many steps the agent took.
      var idle = Math.max(25, Math.min(PLAY_IDLE_MS, 6000 / Math.max(1, S.total)));
      var pause = Math.max(450, Math.min(PLAY_EVENT_MS, 24000 / Math.max(1, S.eventSteps.length)));
      var wait = added ? pause : idle;
      // Linger briefly before a step that adds flows, so the change reads as one move.
      if (!added && nextEventAfter(S.step) === S.step + 1) wait = idle * 2;
      S.playTimer = setTimeout(tick, wait);
    };
    S.playTimer = setTimeout(tick, PLAY_EVENT_MS);
  }
  function stopPlay() {
    if (!S.playing) return;
    S.playing = false;
    clearTimeout(S.playTimer);
    $('btn-play').classList.remove('playing');
    $('btn-play').setAttribute('aria-label', 'Replay the agent step by step');
  }
  function startPulse() {
    if (REDUCED_MOTION || S.pulseTimer) return;
    var on = false;
    S.pulseTimer = setInterval(function () {
      if (!S.cy) return;
      on = !on;
      if (on) S.cy.nodes('.r-open, .frontier').not('.gone, .dim, .ldim').addClass('pulse');
      else S.cy.nodes('.pulse').removeClass('pulse');
    }, 1200);
  }

  // ---------- findings: rejected log and coming soon ----------

  function agentOps(N) {
    var ops = [];
    S.ops.forEach(function (o) { if (!o.seedOp && (o.step === null || o.step <= N) && !gone(o, N)) ops.push(o); });
    return ops;
  }
  function checkerCounts(N) {
    var c = { valid: 0, rejected: 0, unchecked: 0 };
    agentOps(N).forEach(function (o) {
      if (o.verdict === 'VALID') c.valid++;
      else if (o.verdict === 'INVALID') c.rejected++;
      else c.unchecked++;
    });
    return c;
  }

  // Checker reasons can be codes like "contradicted:exchange_not_delivery": show the words, keep the code.
  function reasonItem(r) {
    var m = /^([a-z_]+):([\w.:-]+)$/i.exec(r);
    if (!m) return el('li', null, r);
    return el('li', { title: r }, el('span', { class: 'reason-head' }, cap(m[1].replace(/_/g, ' '))), ': ' + m[2].replace(/[_:]/g, ' '), ' ', el('code', { class: 'reason-code' }, r));
  }

  // Rejected claims stay visible: the checker judged them and the graph leaves them out.
  function renderRejected(box) {
    var ops = agentOps(S.step).filter(function (o) { return o.verdict === 'INVALID'; });
    ops.sort(function (a, b) { return (a.step || 0) - (b.step || 0); });
    append(box, [
      el('div', { class: 'd-head' }, el('span', { class: 'badge bad' }, 'Checker'), el('span', { class: 'badge plain' }, plural(ops.length, 'claim'))),
      el('h3', { class: 'd-title' }, 'Rejected by the checker'),
      el('p', { class: 'hint' }, 'The checker found these claims invalid. Their transfers are left off the graph.')
    ]);
    if (!ops.length) { box.appendChild(el('p', { class: 'empty' }, 'No claims rejected so far.')); return; }
    ops.forEach(function (o) {
      var edges = S.edges.filter(function (e) { return e.op === o || o.edge_ids.indexOf(e.id) !== -1; });
      var chain = edges.length ? (S.nodes.get(edges[0].from) || {}).chain : null;
      var links = o.evidence.slice();
      if (!links.length) edges.forEach(function (e) {
        var u = e.txUrl || (isHash(e.tx) ? explorerFor(chain).base + '/tx/' + e.tx : null);
        if (u && !links.some(function (l) { return l.url === u; })) links.push({ name: 'Transaction', url: u });
      });
      var codeLike = function (t) { return /^[\w.-]+:[\w.:-]+$/.test(t); };
      box.appendChild(el('article', { class: 'chain rejected-op', 'data-op': o.id },
        el('div', { class: 'rej-head' }, el('span', { class: 'badge bad' }, 'Invalid'), el('span', { class: 'op-type' }, prettyType(o.type)), o.step !== null ? el('span', null, 'step ' + o.step) : null),
        o.claim && !codeLike(o.claim) && o.reasons.indexOf(o.claim) === -1 ? el('p', { class: 'rej-claim' }, o.claim) : null,
        edges.map(function (e) {
          return el('div', { class: 'rej-edge' }, e.swap ? short(e.from) + ' swapped ' + (e.fromAsset || '?') + ' to ' + fmt(e.amount) + ' ' + e.toAsset
            : short(e.from) + ' to ' + short(e.to) + ' · ' + fmt(e.amount) + ' ' + e.asset);
        }),
        el('span', { class: 'chain-label' }, 'Checker\u2019s reasons'),
        o.reasons.length ? el('ul', { class: 'reasons' }, o.reasons.map(reasonItem))
                         : el('p', { class: 'empty' }, 'No reason given.'),
        links.length ? el('div', { class: 'evidence' }, el('span', { class: 'chain-label' }, 'Evidence'),
          el('div', { class: 'ev-links' }, links.map(function (l) { return extLink(l.url, l.name, 'ev'); }))) : null,
        el('div', { class: 'card-foot' },
          o.step !== null ? el('button', { type: 'button', class: 'linkish', onclick: function () { showInTimeline(o.id, o.step); } }, 'Show in the agent timeline') : null,
          reportLink(function () { return rejectedTarget(o); }))));
    });
  }

  function renderComingSoon() {
    var list = $('soon-list');
    clear(list);
    $('soon').hidden = !S.comingSoon.length;
    S.comingSoon.forEach(function (c) {
      list.appendChild(el('li', { title: str(c.note) || null }, el('span', { class: 'soon-chain' }, str(c.chain)), str(c.note) ? el('span', { class: 'note' }, str(c.note)) : null));
    });
  }

  // ---------- agent workspace ----------

  function renderWorkspace() {
    var W = S.workspace;
    $('ws-steps').textContent = S.total ? plural(S.total, 'step') + ' taken' : '';
    $('ws-leads-count').textContent = String(W.leads.length);
    var list = $('ws-leads');
    clear(list);
    if (!W.leads.length) list.appendChild(el('li', { class: 'none' }, 'No open leads.'));
    var drawn = viewAt(S.total).nodes;
    W.leads.forEach(function (l) {
      var n = l.addr ? S.nodes.get(l.addr) : null;
      var inGraph = !!(l.addr && drawn.has(l.addr));
      var name = l.addr ? ((n && n.label ? n.label + ' ' : '') + short(l.addr)) : l.key;
      var li = el('li', {
        class: 'ws-lead' + (inGraph ? ' linked' : ''), tabindex: inGraph ? '0' : null, role: inGraph ? 'button' : null,
        title: inGraph ? 'Show this address in the graph' : null,
        onmouseenter: function () { markNode(l.addr, true); },
        onmouseleave: function () { markNode(l.addr, false); },
        onclick: function () { if (inGraph) focusNode(l.addr, true); },
        onkeydown: function (ev) { if (inGraph && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); focusNode(l.addr, true); } }
      },
        el('div', { class: 'ws-lead-top' }, el('span', { class: 'ws-addr' }, name), l.asset ? el('span', { class: 'ws-asset' }, l.asset) : null),
        l.text ? el('p', { class: 'ws-text' }, l.text) : null);
      l.items = [li];
      list.appendChild(li);
    });
    $('ws-notes-count').textContent = String(W.notes.length);
    var notes = $('ws-notes');
    clear(notes);
    if (!W.notes.length) notes.appendChild(el('li', { class: 'none' }, 'No notes.'));
    W.notes.forEach(function (t) { notes.appendChild(el('li', null, t)); });
    $('workspace').hidden = !(W.leads.length || W.notes.length || W.note);
  }

  // ---------- detail panel ----------

  function roleBadge(role) { var r = ROLES[role] || ROLES.unknown; return el('span', { class: 'badge', style: '--c:' + r.color }, r.name); }
  function totalsText(map) { var p = totals(map); return p.length ? p.map(function (x) { return fmt(x[1], 2) + ' ' + x[0]; }).join(', ') : null; }
  function stepText(e) { return e.seed ? 'case start' : 'step ' + e.step; }

  function renderDetail() {
    var box = $('detail');
    clear(box);
    box.classList.toggle('active', !!S.selected);
    if (!S.selected) { box.appendChild(el('p', { class: 'empty' }, 'Select a flow or an address to see the records behind it.')); return; }
    if (S.selected.kind === 'rejected') renderRejected(box);
    else if (S.selected.kind === 'swaps') renderSwaps(box, S.nodes.get(S.selected.id));
    else if (S.selected.kind === 'node') renderNodeDetail(box, S.nodes.get(S.selected.id));
    else renderBundleDetail(box, S.bundleById.get(S.selected.id));
  }

  function renderSwaps(box, n) {
    if (!n) return;
    var sw = swapsAt(n.id, S.view);
    var edges = [];
    sw.forEach(function (x) { edges = edges.concat(x.edges); });
    edges.sort(function (a, b) { return a.step - b.step || (a.block || 0) - (b.block || 0); });
    append(box, [
      el('div', { class: 'd-head' }, el('span', { class: 'badge plain' }, plural(edges.length, 'swap')),
        el('button', { type: 'button', class: 'linkish', onclick: function () { select({ kind: 'node', id: n.id }); } }, 'Back to the address')),
      el('h3', { class: 'd-title' }, 'Swaps at ' + (n.label || short(n.id))),
      sw.map(function (x) { return el('p', { class: 'hint' }, swapLine(x)); })
    ]);
    edges.forEach(function (e) { box.appendChild(evidenceCard(e, n.chain)); });
  }

  function renderNodeDetail(box, n) {
    if (!n) return;
    var view = S.view;
    var frontier = isFrontierAt(n, view);
    var leads = view.N >= S.total ? (S.leadsByAddr.get(n.id) || []) : [];

    append(box, [
      el('div', { class: 'd-head' }, roleBadge(n.role), frontier ? el('span', { class: 'badge plain' }, 'Open lead at step ' + view.N) : null),
      el('h3', { class: 'd-title' }, n.label || short(n.id)),
      el('div', { class: 'addr-row' }, el('span', { class: 'addr-full' }, n.id), copyButton(n.id)),
      el('div', { class: 'addr-tools' }, addrLink(n.id, n.chain), reportLink(function () { return addressTarget(n); })),
      n.note ? el('p', { class: 'd-note', style: '--c:' + ROLES[n.role].color }, n.note) : null,
      frontier ? el('p', { class: 'd-note' }, 'At step ' + view.N + ', where these funds went next was not traced yet.') : null,
      (n.freezable || []).map(function (f) {
        return el('div', { class: 'frozen-box freezable' },
          el('span', { class: 'badge frzable' }, f.asset + ' still freezable'),
          f.note ? el('p', null, f.note) : null,
          isAddr(f.token) ? el('div', null, addrLink(f.token, n.chain, (f.issuer ? f.issuer + ' ' : '') + f.asset + ' contract')) : null);
      }),
      (n.frozen || []).map(function (f) {
        return el('div', { class: 'frozen-box' },
          el('span', { class: 'badge frz' }, f.asset + (f.takenBack ? ' taken back' : ' frozen')),
          f.note ? el('p', null, f.note) : null,
          isAddr(f.token) ? el('div', null, addrLink(f.token, n.chain, (f.issuer ? f.issuer + ' ' : '') + f.asset + ' contract')) : null);
      })
    ]);

    var kv = el('dl', { class: 'kv' });
    var inT = totalsText(view.inflow.get(n.id)), outT = totalsText(view.outflow.get(n.id));
    if (inT) append(kv, [el('dt', null, 'Received'), el('dd', { class: 'mono' }, inT)]);
    if (outT) append(kv, [el('dt', null, 'Sent'), el('dd', { class: 'mono' }, outT)]);
    append(kv, [el('dt', null, 'Chain'), el('dd', null, cap(n.chain))]);
    if (leads.length) append(kv, [el('dt', null, 'Open leads'), el('dd', null,
      el('button', { type: 'button', class: 'linkish', onclick: function () {
        markLeads(n.id, true, true);
        setTimeout(function () { markLeads(n.id, false); }, 2400);
      } }, plural(leads.length, 'entry', 'entries') + ' in my workspace'))]);
    box.appendChild(kv);

    var sw = swapsAt(n.id, view);
    if (sw.length) {
      var swBox = el('div', { class: 'flows' }, el('h3', null, 'Swaps at this address (' + sw.reduce(function (a, x) { return a + x.count; }, 0) + ')'));
      var swUl = el('ul', { class: 'flow-list' });
      sw.forEach(function (x) {
        swUl.appendChild(el('li', null, el('button', { type: 'button', class: 'flow', onclick: function () { select({ kind: 'swaps', id: n.id }); } },
          el('span', { class: 'who' }, 'Swapped ' + x.from + ' to ' + x.to),
          el('span', { class: 'amt' }, fmt(x.sum) + ' ' + x.to),
          el('span', { class: 'sub' }, [plural(x.count, 'transaction'), 'show evidence'].join(' · ')))));
      });
      swBox.appendChild(swUl);
      box.appendChild(swBox);
    }

    var incoming = [], outgoing = [];
    view.groups.forEach(function (gv) {
      if (gv.group.from === n.id && gv.group.to === n.id) return;
      if (gv.group.to === n.id) incoming.push(gv);
      if (gv.group.from === n.id) outgoing.push(gv);
    });
    var flows = el('div', { class: 'flows' });
    [['Incoming', incoming, 'from'], ['Outgoing', outgoing, 'to']].forEach(function (spec) {
      var items = spec[1];
      if (!items.length) return;
      items.sort(function (a, b) { return assetOrder([a.group.asset, a.sum], [b.group.asset, b.sum]); });
      flows.appendChild(el('h3', null, spec[0] + ' (' + items.length + ')'));
      var ul = el('ul', { class: 'flow-list' });
      items.forEach(function (gv) {
        var other = S.nodes.get(gv.group[spec[2]]);
        var when = Array.from(new Set(gv.edges.map(stepText)));
        ul.appendChild(el('li', null, el('button', {
          type: 'button', class: 'flow' + (gv.group.tier === 'unverified' ? ' dashed' : ''),
          onclick: function () { select({ kind: 'bundle', id: gv.group.bundle.id }); }
        },
          el('span', { class: 'who' }, other.id === n.id ? el('span', { class: 'a' }, 'same address (exchange)') : (other.label ? [other.label + ' ', el('span', { class: 'a' }, short(other.id))] : el('span', { class: 'a' }, short(other.id)))),
          el('span', { class: 'amt' }, fmt(gv.sum) + ' ' + gv.group.asset),
          el('span', { class: 'sub' }, [plural(gv.count, 'transfer'), (gv.edges[0].seed ? 'known at ' : 'found at ') + when.join(', '), gv.group.tier === 'verified' ? 'checked' : 'not yet checked'].join(' · ')))));
      });
      flows.appendChild(ul);
    });
    box.appendChild(flows);
  }

  // One end of a flow: who, explorer link, copy, and the record the agent cites for it.
  function hop(label, n, record) {
    return el('div', { class: 'hop' },
      el('span', { class: 'hop-dot', style: '--c:' + ROLES[n.role].color }),
      el('div', { class: 'hop-body' },
        el('div', { class: 'hop-label' }, label),
        el('div', { class: 'hop-who' },
          el('button', { type: 'button', class: 'hop-name', title: n.id, onclick: function () { select({ kind: 'node', id: n.id }); } }, n.label || short(n.id)),
          n.label ? el('span', { class: 'hop-addr' }, short(n.id)) : null),
        el('div', { class: 'hop-tools' }, addrLink(n.id, n.chain, 'Etherscan'), copyButton(n.id)),
        record ? el('div', { class: 'hop-record' }, el('span', null, 'Record'), record) : null));
  }

  function evidenceCard(e, chain) {
    var from = S.nodes.get(e.from), to = S.nodes.get(e.to);
    var checked = e.tier === 'verified' && (!e.op || e.op.verdict === 'VALID' || e.op.verdict === null);
    // An operation can cover several transfers; keep the evidence that cites this transfer's transaction.
    var links = e.op ? e.op.evidence.filter(function (x) { return !x.tx || !e.tx || x.tx === lc(e.tx); }) : [];
    if (!links.length) {
      var u = e.txUrl || (isHash(e.tx) ? explorerFor(chain).base + '/tx/' + e.tx : null);
      if (u) links.push({ name: 'Transaction', url: u });
    }
    return el('article', { class: 'chain', 'data-edge': e.id },
      el('div', { class: 'chain-what' }, el('span', { class: 'chain-label' }, 'What moved'), el('span', { class: 'chain-amt' }, fmtExact(e.amountStr) + ' ' + e.asset)),
      el('div', { class: 'hops' }, hop('From', from, e.srcPos), hop('To', to, e.tgtPos)),
      el('dl', { class: 'kv' },
        el('dt', null, 'Operation'), el('dd', null, prettyType(e.op ? e.op.type : null)),
        e.op && e.op.via ? [el('dt', null, 'Via'), el('dd', { class: 'mono' }, viaLink(e.op.via, chain))] : null,
        el('dt', null, 'Recorded'), el('dd', null, e.seed ? 'Case start' : ['Step ' + e.step, e.op ? [' · ', el('button', { type: 'button', class: 'linkish', onclick: function () { showInTimeline(e.op.id, e.step); } }, 'Show in the agent timeline')] : null]),
        el('dt', null, 'Tx'), el('dd', { class: 'mono' }, txLink(e.tx, chain)),
        e.block !== null ? [el('dt', null, 'Block'), el('dd', { class: 'mono' }, String(e.block))] : null,
        e.time ? [el('dt', null, 'Time'), el('dd', { class: 'mono' }, fmtTime(e.time, true))] : null),
      el('p', { class: 'verdict ' + (checked ? 'ok' : 'wait') }, checked ? 'Checked: the cited records show this transfer' : 'Not yet checked'),
      links.length ? el('div', { class: 'evidence' }, el('span', { class: 'chain-label' }, 'Evidence'),
        el('div', { class: 'ev-links' }, links.map(function (l) { return extLink(l.url, l.name, 'ev'); }))) : null,
      el('div', { class: 'card-foot' }, reportLink(function () { return flowTarget(e); })));
  }

  function renderBundleDetail(box, b) {
    if (!b) return;
    var bv = S.view.bundles.get(b.id);
    if (!bv) return;
    var chain = S.nodes.get(b.from).chain;
    var single = bv.groups.length === 1;
    var edges = [];
    bv.groups.forEach(function (gv) { edges = edges.concat(gv.edges); });
    edges.sort(function (x, y) { return x.step - y.step || (x.block || 0) - (y.block || 0); });

    append(box, [
      el('div', { class: 'd-head' },
        el('span', { class: 'badge plain' }, edges.length > 1 ? edges.length + ' transfers' : 'Transfer'),
        b.tier === 'verified' ? el('span', { class: 'badge ok' }, 'Checked') : el('span', { class: 'badge wait' }, 'Not yet checked')),
      el('h3', { class: 'd-title' }, single ? fmt(bv.groups[0].sum, 2) + ' ' + bv.groups[0].group.asset : bv.groups.map(groupLine).join(', ')),
      b.tier === 'unverified' ? el('p', { class: 'd-note', style: '--c:' + C.amber }, 'Agent claim the checker could not evaluate yet.') : null
    ]);
    edges.forEach(function (e) { box.appendChild(evidenceCard(e, chain)); });
  }

  // ---------- how the agent worked: the trajectory timeline ----------
  // Renders a window of events at a time, so thousands of events stay cheap.
  // Result excerpts are built only when a visitor expands them.

  // The exporter writes <data>/trajectory/index.json plus chunks of about 300 events. The page
  // loads the index and the last chunk first and fetches earlier chunks only when needed
  // (scrolling up, replaying earlier, a deep link). A single trajectory.json still works.
  var DATA_DIR = DATA_URL.indexOf('/') !== -1 ? DATA_URL.slice(0, DATA_URL.lastIndexOf('/') + 1) : '';
  var DATA_NAME = DATA_URL.slice(DATA_DIR.length).replace(/\.json$/, '');
  var TRAJ_URL = safeDataPath(PARAMS.get('trajectory')) ||
    (DATA_NAME === 'graph' ? DATA_DIR + 'trajectory.json' : DATA_DIR + DATA_NAME + '.trajectory.json');
  var TRAJ_INDEX_URL = safeDataPath(PARAMS.get('tindex')) ||
    (DATA_NAME === 'graph' ? DATA_DIR + 'trajectory/index.json' : DATA_DIR + DATA_NAME + '.trajectory/index.json');
  var TRAJ_INDEX_DIR = TRAJ_INDEX_URL.slice(0, TRAJ_INDEX_URL.lastIndexOf('/') + 1);
  var TRAJ_WINDOW = 120;
  var T = {
    mode: null, meta: [], events: [], n: 0, loaded: false, failed: false, cost: null, costNote: null, totalSteps: 0,
    chunk: {}, pending: {}, start: 0, end: 0, nowIdx: -1, pinK: null, byKey: new Map(), itemOf: new Map(), seq: 0
  };
  var TOKEN_NAMES = {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH', '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI'
  };
  var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var ARG_ORDER = ['account', 'address', 'tx_hash', 'topics', 'direction', 'block_window', 'limit'];

  function fetchJson(url) {
    return fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function activeTab() { return $('tab-traj').getAttribute('aria-selected') === 'true' ? 'traj' : 'mem'; }
  function setTab(which) {
    ['traj', 'mem'].forEach(function (k) {
      var on = k === which;
      $('tab-' + k).setAttribute('aria-selected', on ? 'true' : 'false');
      $('tab-' + k).tabIndex = on ? 0 : -1;
      $('pane-' + k).hidden = !on;
    });
    if (which === 'traj') syncTrajectory(false);
  }

  function timelineUnavailable() {
    clear($('traj'));
    $('traj').appendChild(el('li', { class: 'traj-loading' }, 'My timeline isn\'t available yet. Everything I traced and my open leads still load.'));
    $('tab-traj').hidden = true;
    setTab('mem');
  }

  function loadTrajectory() {
    var useIndex = !PARAMS.get('trajectory') || !!PARAMS.get('tindex');
    (useIndex ? fetchJson(TRAJ_INDEX_URL).then(function (idx) {
      if (!applyIndex(idx)) throw new Error('no chunks');
      T.mode = 'chunks';
      return loadChunk(T.meta[T.meta.length - 1]);
    }) : Promise.reject(new Error('single file requested')))
      .catch(function () { return fetchJson(TRAJ_URL).then(initSingle); })
      .then(function () { T.loaded = true; afterTrajectoryChange(); handleEventLink(); })
      .catch(function (err) { if (window.console) console.warn('Live tracker: timeline not loaded', err); timelineUnavailable(); });
  }

  function rawHref(p) {
    if (typeof p !== 'string' || !/^[\w\-./]+$/.test(p) || p.indexOf('..') !== -1 || p.charAt(0) === '/') return null;
    return DATA_DIR + p;
  }
  function safeChunkFile(f) { return typeof f === 'string' && /^[\w\-./]+\.json$/.test(f) && f.indexOf('..') === -1 && f.charAt(0) !== '/' ? f : null; }

  // Index: {chunks: [{file, first_i, last_i, first_step, last_step, cost_usd}], total_steps, cost_usd, cost_note, raw_files, note}
  function applyIndex(idx) {
    // first_event / last_event / total_events are accepted as names for first_i / last_i / the event count.
    var chunks = (idx && Array.isArray(idx.chunks) ? idx.chunks : []).map(function (c) {
      var fi = c ? (num(c.first_i) !== null ? num(c.first_i) : num(c.first_event)) : null;
      var li = c ? (num(c.last_i) !== null ? num(c.last_i) : num(c.last_event)) : null;
      return c && safeChunkFile(c.file) && fi !== null && li !== null ? {
        file: c.file, first_i: fi, last_i: li,
        first_step: num(c.first_step) === null ? 0 : num(c.first_step), last_step: num(c.last_step) === null ? 0 : num(c.last_step), cost: num(c.cost_usd)
      } : null;
    }).filter(Boolean).sort(function (a, b) { return a.first_i - b.first_i; });
    if (!chunks.length) return false;
    T.meta = chunks;
    T.n = Math.max(chunks[chunks.length - 1].last_i + 1, num(idx.total_events) || 0);
    T.cost = num(idx.cost_usd);
    T.costNote = str(idx.cost_note);
    T.totalSteps = Math.max(num(idx.total_steps) || 0, chunks[chunks.length - 1].last_step);
    renderTrajMeta(idx);
    return true;
  }

  function initSingle(d) {
    var evs = Array.isArray(d && d.events) ? d.events.filter(function (e) { return e && typeof e === 'object' && e.kind; }) : [];
    evs.forEach(function (e, k) { if (num(e.i) === null) e.i = k; });
    T.mode = 'single';
    T.events = [];
    T.chunk = { '(single)': 'loaded' };
    addEvents(evs);
    var first = T.events.find(function (e) { return e; }), last = T.events[T.events.length - 1];
    T.meta = [{ file: '(single)', first_i: 0, last_i: Math.max(0, T.events.length - 1), first_step: first ? first._step : 0, last_step: last ? last._step : 0, cost: num(d && d.cost_usd) }];
    T.n = T.events.length;
    T.cost = num(d && d.cost_usd);
    T.costNote = str(d && d.cost_note);
    T.totalSteps = Math.max(num(d && d.total_steps) || 0, last ? last._step : 0);
    renderTrajMeta(d);
  }

  function loadChunk(m) {
    if (!m) return Promise.resolve();
    if (T.chunk[m.file] === 'loaded') return Promise.resolve();
    if (T.pending[m.file]) return T.pending[m.file];
    var p = fetchJson(TRAJ_INDEX_DIR + m.file).then(function (d) {
      addEvents(Array.isArray(d && d.events) ? d.events : []);
      T.chunk[m.file] = 'loaded';
    }).catch(function (err) {
      T.chunk[m.file] = 'failed';
      if (window.console) console.warn('Live tracker: could not load ' + m.file, err);
    }).then(function () { delete T.pending[m.file]; });
    T.pending[m.file] = p;
    return p;
  }
  function chunkForIndex(i) { for (var j = 0; j < T.meta.length; j++) if (i >= T.meta[j].first_i && i <= T.meta[j].last_i) return T.meta[j]; return null; }
  function chunkForStep(N) {
    var m = T.meta[0] || null;
    T.meta.forEach(function (c) { if (c.first_step <= N) m = c; });
    return m;
  }
  function chunkReady(m) { return !m || T.chunk[m.file] === 'loaded' || T.chunk[m.file] === 'failed'; }
  function chunksIn(a, b) { return T.meta.filter(function (m) { return m.last_i >= a && m.first_i < b; }); }
  function rangeReady(a, b) { return chunksIn(a, b).every(chunkReady); }
  function ensureRange(a, b) { return Promise.all(chunksIn(a, b).map(loadChunk)); }

  function addEvents(list) {
    list.forEach(function (e) {
      if (!e || typeof e !== 'object' || !e.kind || num(e.i) === null) return;
      e._order = num(e.i);
      e._k = e._order;
      e._step = num(e.step) === null ? 0 : num(e.step);
      e._costRaw = num(e.cost_usd);
      T.events[e._order] = e;
    });
    derive();
  }
  // Facts that depend on earlier events (lead state, cost carry, finding index) over what is loaded.
  function derive() {
    var leadOpen = new Set(), lastCost = null;
    T.byKey = new Map();
    for (var k = 0; k < T.events.length; k++) {
      var e = T.events[k];
      if (!e) continue;
      e._cost = e._costRaw === null ? lastCost : e._costRaw;
      lastCost = e._cost;
      if (e.kind === 'memory' && e.args && typeof e.args === 'object') {
        var a = e.args, key = str(a.key);
        if (a.section === 'findings' && key && !T.byKey.has(key)) T.byKey.set(key, k);
        if (a.section === 'leads' && key) {
          if (a.close && String(a.close) !== 'false') { e._lead = 'closed'; leadOpen.delete(key); }
          else { e._lead = leadOpen.has(key) ? 'updated' : 'opened'; leadOpen.add(key); }
        }
      }
    }
  }

  function renderTrajMeta(d) {
    var note = str(d && d.note);
    $('traj-note').textContent = note || '';
    $('traj-note').hidden = !note;
    var raw = $('traj-raw');
    clear(raw);
    var files = (Array.isArray(d && d.raw_files) ? d.raw_files : []).map(function (p) { return { p: p, href: rawHref(p) }; }).filter(function (f) { return f.href; });
    raw.hidden = !files.length;
    if (!files.length) return;
    var kinds = { transcript: [], evidence: [], other: [] };
    files.forEach(function (f) { (/transcript/i.test(f.p) ? kinds.transcript : /evidence/i.test(f.p) ? kinds.evidence : kinds.other).push(f); });
    var parts = [];
    [['transcript', 'model transcript'], ['evidence', 'evidence log'], ['other', 'file']].forEach(function (kv) {
      kinds[kv[0]].forEach(function (f, i) {
        var name = kv[1] + (kinds[kv[0]].length > 1 ? ' ' + (i + 1) : '');
        if (parts.length) parts.push(', ');
        parts.push(el('a', { href: f.href, download: f.p.split('/').pop(), title: f.p }, name));
      });
    });
    append(raw, ['Raw records: '].concat(parts));
  }

  // After any timeline load: cost labels, replay length, the window around the replay step.
  function afterTrajectoryChange() {
    renderCost();
    var lastEv = T.events[T.events.length - 1];
    var tTotal = Math.max(T.totalSteps || 0, lastEv ? lastEv._step : 0);
    if (tTotal > S.total) {
      var atEnd = S.step >= S.total;
      S.total = tTotal;
      buildTimelineControls();
      $('ws-steps').textContent = plural(S.total, 'step') + ' taken';
      apply(atEnd ? S.total : S.step, { fit: false });
    }
    if (!T.n) {
      clear($('traj'));
      $('traj').appendChild(el('li', { class: 'traj-loading' }, 'No recorded events yet.'));
      return;
    }
    T.rendered = false;
    syncTrajectory(false);
  }

  // Model spend after the last event at or before a step (cumulative, from the trajectory).
  function costAt(N) {
    if (!T.loaded || T.cost === null) return null;
    var k = lastEventAtOrBefore(N);
    var e = k >= 0 ? T.events[k] : null;
    return e && e._cost !== null && e._cost !== undefined ? e._cost : null;
  }

  function renderCost() {
    var b = $('ws-cost');
    if (T.cost === null) { b.hidden = true; }
    else {
      b.hidden = false;
      b.textContent = '$' + T.cost.toFixed(2) + ' model cost';
      b.title = T.costNote || '';
      $('ws-cost-note').textContent = T.costNote || '';
    }
    if (S.view) { renderTimeline(S.view); renderStats(S.view); }
  }

  // Index of the last event at or before step N; -1 while the chunk that holds it is still loading.
  function lastEventAtOrBefore(N) {
    var m = chunkForStep(N);
    if (!m) return 0;
    if (T.chunk[m.file] !== 'loaded') {
      if (T.chunk[m.file] !== 'failed') return -1;
      for (var j = Math.min(m.first_i, T.events.length) - 1; j >= 0; j--) if (T.events[j] && T.events[j]._step <= N) return j;
      return 0;
    }
    for (var k = Math.min(m.last_i, T.events.length - 1); k >= m.first_i; k--) { var e = T.events[k]; if (e && e._step <= N) return k; }
    return m.first_i;
  }

  function windowAround(center) {
    var start = Math.max(0, Math.min(center - Math.floor(TRAJ_WINDOW / 2), T.n - TRAJ_WINDOW));
    return [start, Math.min(T.n, start + TRAJ_WINDOW)];
  }

  function renderWindow(center) {
    var w = windowAround(center), start = w[0], end = w[1];
    // Never split a run of memory writes at the window start.
    while (start > 0 && T.events[start] && T.events[start].kind === 'memory' && T.events[start - 1] && T.events[start - 1].kind === 'memory') start--;
    if (T.rendered && start === T.start && end === T.end) return;
    T.start = start; T.end = end; T.rendered = true;
    T.itemOf = new Map();
    var list = $('traj');
    clear(list);
    var k = start, gap = false;
    while (k < end) {
      var e = T.events[k];
      if (!e) {
        if (!gap) list.appendChild(el('li', { class: 'traj-loading' }, 'Part of the timeline could not be loaded.'));
        gap = true;
        k++;
        continue;
      }
      gap = false;
      if (e.kind === 'memory') {
        var j = k;
        while (j < end && T.events[j] && T.events[j].kind === 'memory') j++;
        list.appendChild(memoryRow(T.events.slice(k, j)));
        k = j;
      } else {
        list.appendChild(eventItem(e));
        k++;
      }
    }
    $('traj-earlier').hidden = start === 0;
    $('traj-later').hidden = end >= T.n;
    if (end >= T.n) list.appendChild(el('li', { class: 'ev ev-tail', id: 'traj-tail' }));
    renderLiveTail();
    updateLatestButton();
  }

  // The last line of the timeline: the agent's state now, pulsing while it traces.
  function renderLiveTail() {
    var li = $('traj-tail');
    if (!li) return;
    var info = LIVE.status ? agentState() : null;
    clear(li);
    li.className = 'ev ev-tail' + (info ? ' st-' + info.state : '');
    append(li, [el('span', { class: 'live-dot' + (info ? ' st-' + info.state : ' st-stopped'), 'aria-hidden': 'true' }),
      el('span', { class: 'tail-text' }, info ? info.short : 'Latest'),
      el('span', { class: 'tail-step' }, '· latest step ' + S.total)]);
  }

  // "Jump to latest" shows while the reader is away from the newest event (replaying or scrolled up).
  function updateLatestButton() {
    var b = $('btn-latest');
    if (!b || !T.loaded) return;
    var box = $('workspace');
    var atEnd = S.step >= S.total && T.end >= T.n && (!WIDE() || box.scrollHeight - box.scrollTop - box.clientHeight < 160);
    b.hidden = atEnd;
  }
  function jumpToLatest() {
    stopPlay();
    T.pinK = null;
    if (S.step < S.total) apply(S.total, { fit: false });
    var w = windowAround(T.n - 1);
    ensureRange(w[0], w[1]).then(function () {
      renderWindow(T.n - 1);
      markNow();
      var tail = $('traj-tail'), box = $('workspace'), how = REDUCED_MOTION ? 'auto' : 'smooth';
      if (WIDE()) box.scrollTo({ top: box.scrollHeight, behavior: how });
      else if (tail) tail.scrollIntoView({ block: 'end', behavior: how });
      setTimeout(updateLatestButton, 600);
    });
  }

  function markNow() {
    var N = S.step;
    T.itemOf.forEach(function (li, k) {
      var e = T.events[k];
      if (!e || +li.dataset.k !== k) return; // a memory row is keyed by its first event
      li.classList.toggle('future', e._step > N);
    });
    $('traj').querySelectorAll('.ev.now').forEach(function (li) { li.classList.remove('now'); });
    var li = T.itemOf.get(T.nowIdx);
    if (li) li.classList.add('now');
  }

  function syncTrajectory(smooth) {
    if (!T.loaded || !T.n) return;
    var seq = ++T.seq;
    var pinned = T.pinK !== null && T.events[T.pinK] && T.events[T.pinK]._step === S.step;
    var idx = pinned ? T.pinK : lastEventAtOrBefore(S.step);
    if (idx === -1) { loadChunk(chunkForStep(S.step)).then(function () { if (seq === T.seq) syncTrajectory(false); }); return; }
    var w = windowAround(idx);
    if (!rangeReady(w[0], w[1])) { ensureRange(w[0], w[1]).then(function () { if (seq === T.seq) syncTrajectory(false); }); return; }
    T.nowIdx = idx;
    if (!T.rendered || idx < T.start || idx >= T.end) renderWindow(idx);
    markNow();
    if (activeTab() === 'traj' && WIDE()) scrollToEvent(idx, smooth);
    renderLiveTail();
    updateLatestButton();
  }

  // Move the window earlier or later, loading chunks first, keeping the reader's place.
  function shiftWindow(dir) {
    if (T.shifting) return;
    var target = dir < 0 ? Math.max(0, T.start - Math.floor(TRAJ_WINDOW / 2)) : Math.min(T.n - 1, T.end + Math.floor(TRAJ_WINDOW / 2) - 1);
    var w = windowAround(target);
    var box = $('workspace');
    var anchorK = dir < 0 ? T.start : T.end - 1, anchor = T.itemOf.get(anchorK);
    var before = anchor ? offsetIn(box, anchor) - box.scrollTop : 0;
    T.shifting = true;
    ensureRange(w[0], w[1]).then(function () {
      renderWindow(target);
      markNow();
      var again = T.itemOf.get(anchorK);
      if (again && WIDE()) box.scrollTop = offsetIn(box, again) - before;
    }).then(function () { T.shifting = false; }, function () { T.shifting = false; });
  }

  // Scroll the workspace column (never the page) so an event sits below the sticky header.
  function scrollToEvent(k, smooth) {
    var li = T.itemOf.get(k), box = $('workspace');
    if (!li || box.scrollHeight <= box.clientHeight + 2) return;
    var headEl = box.querySelector('.ws-head');
    var head = headEl ? headEl.offsetHeight : 0;
    var at = offsetIn(box, li);
    var top = at - head - 10;
    var bottomRoom = box.clientHeight - head;
    if (li.offsetHeight < bottomRoom * 0.6) top = at - head - Math.round(bottomRoom * 0.3);
    top = Math.max(0, top);
    var near = Math.abs(top - box.scrollTop) < 1200;
    box.scrollTo({ top: top, behavior: smooth && near && !REDUCED_MOTION ? 'smooth' : 'auto' });
  }

  function goToStep(step, k) {
    stopPlay();
    T.pinK = k === undefined ? null : k;
    apply(step, { animate: true });
  }

  // Show event k: load its chunk and window, scroll to it, flash it.
  function revealEvent(k, opId) {
    var w = windowAround(k);
    return ensureRange(w[0], w[1]).then(function () {
      if (!T.events[k]) return null;
      if (k < T.start || k >= T.end) renderWindow(k);
      markNow();
      var li = T.itemOf.get(k);
      if (!li) return null;
      if (WIDE()) scrollToEvent(k, false);
      else li.scrollIntoView({ block: 'center', behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
      flashEl(li);
      if (opId && li.openDetails) {
        li.openDetails();
        li.querySelectorAll('.mem-item').forEach(function (m) { m.classList.toggle('hit', m.dataset.key === opId); });
      }
      return li;
    });
  }

  // From a flow in the graph to the moment the agent recorded it.
  function showInTimeline(opId, step) {
    setTab('traj');
    if (!T.loaded) return;
    loadChunk(chunkForStep(step)).then(function () {
      var k = T.byKey.has(opId) ? T.byKey.get(opId) : lastEventAtOrBefore(step);
      if (k >= 0) revealEvent(k, opId);
    });
  }

  function selectOp(opId) {
    var edge = null;
    S.edges.forEach(function (e) { if (!edge && !e.rejected && e.op && e.op.id === opId) edge = e; });
    if (!edge) return;
    var b = null;
    S.bundles.forEach(function (bb) { if (!b && bb.groups.some(function (g) { return g.edges.indexOf(edge) !== -1; })) b = bb; });
    if (!b) return;
    if (edge.step > S.step) { stopPlay(); apply(edge.step, { animate: true }); }
    select({ kind: 'bundle', id: b.id });
  }

  // ----- event views -----

  function inline(text) {
    var out = [];
    String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).forEach(function (part) {
      if (!part) return;
      if (/^\*\*[^*]+\*\*$/.test(part)) out.push(el('strong', null, part.slice(2, -2)));
      else if (/^`[^`]+`$/.test(part)) out.push(el('code', null, part.slice(1, -1)));
      else out.push(part);
    });
    return out;
  }
  function markdownish(text) {
    return String(text).split(/\n{2,}/).map(function (p) { return el('p', null, inline(p.trim())); });
  }

  function clampable(li, body, long) {
    if (!long) return null;
    li.classList.add('clamped');
    return el('button', { type: 'button', class: 'more', onclick: function (ev) {
      ev.stopPropagation();
      var c = li.classList.toggle('clamped');
      ev.currentTarget.textContent = c ? 'Show more' : 'Show less';
    } }, 'Show more');
  }

  function eventItem(e) {
    var li;
    if (e.kind === 'thinking' || e.kind === 'message') li = thoughtItem(e);
    else if (e.kind === 'reset') li = el('li', { class: 'ev ev-reset' }, el('span', { title: str(e.text) || null }, (hhmm(e.utc) ? hhmm(e.utc) + ' · ' : '') + (str(e.text) || 'The agent restarted and continued from its working memory.')));
    else if (e.kind === 'system' || e.kind === 'task') li = promptItem(e);
    else if (e.kind === 'review') li = el('li', { class: 'ev ev-review' }, el('span', { class: 'review-name' }, 'Human review'), el('span', null, str(e.text)));
    else if (e.kind === 'deferred') li = deferredItem(e);
    else if (e.kind === 'recall') li = recallItem(e);
    else li = actionItem(e);
    li.dataset.k = String(e._k);
    T.itemOf.set(e._k, li);
    return li;
  }

  // A call the loop did not run because the turn's results hit the size limit: one muted line.
  function deferredItem(e) {
    var args = e.args && typeof e.args === 'object' ? e.args : {};
    var chain = lc(args.chain) || lc(S.caseInfo.chain) || 'ethereum';
    var bits = describeArgs(args, chain);
    return el('li', { class: 'ev ev-deferred', title: str(e.text) || null },
      el('span', { class: 'def-text' }, 'Not run: ', el('span', { class: 'def-tool' }, str(e.tool) || 'call'), bits.length ? [' · ', bits] : null));
  }

  // The agent re-read an earlier result that had been cleared from its context.
  function recallItem(e) {
    var id = e.args && e.args.id !== undefined ? e.args.id : null;
    var res = e.result && typeof e.result === 'object' ? e.result : null;
    var text = res && typeof res.text === 'string' && res.text ? res.text : null;
    var full = res ? num(res.chars) : null;
    var holder = el('div', { class: 'res', hidden: true });
    var btn = text ? el('button', { type: 'button', class: 'res-toggle', 'aria-expanded': 'false' }, 'Show result') : null;
    if (btn) btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = holder.hidden;
      if (open && !holder.firstChild) {
        holder.appendChild(el('pre', { class: 'res-text', tabindex: '0' }, text));
        if (full && full > text.length) holder.appendChild(el('p', { class: 'res-meta' }, 'First ' + text.length.toLocaleString('en-US') + ' of ' + full.toLocaleString('en-US') + ' characters. The full result is in the raw records.'));
      }
      holder.hidden = !open;
      btn.textContent = open ? 'Hide result' : 'Show result';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    return el('li', { class: 'ev ev-recall' },
      el('div', { class: 'mem-row' }, el('span', { class: 'chip recall' }, 're-read result' + (id !== null ? ' #' + id : '')), btn,
        reportLink(function () { return eventTarget(e); })),
      holder);
  }

  // The system prompt and the task repeat after every restart: one muted line each, full text on demand.
  function promptItem(e) {
    var text = typeof e.text === 'string' ? e.text : '';
    var holder = el('div', { class: 'res', hidden: true });
    var btn = el('button', { type: 'button', class: 'res-toggle', 'aria-expanded': 'false' }, 'Show');
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = holder.hidden;
      if (open && !holder.firstChild) holder.appendChild(el('pre', { class: 'res-text', tabindex: '0' }, text));
      holder.hidden = !open;
      btn.textContent = open ? 'Hide' : 'Show';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    return el('li', { class: 'ev ev-prompt ev-' + e.kind },
      el('div', { class: 'prompt-row' },
        el('span', { class: 'prompt-name' }, e.kind === 'system' ? 'System prompt' : 'Task'),
        text ? el('span', { class: 'res-size' }, text.length.toLocaleString('en-US') + ' characters') : null,
        text ? btn : null),
      holder);
  }

  function thoughtItem(e) {
    var text = str(e.text) || '';
    var label = e.label ? cap(String(e.label)) : (e.kind === 'message' ? 'Message' : 'Reasoning summary');
    var li = el('li', { class: 'ev ev-think' + (e.label ? ' ev-handoff' : '') + (e.kind === 'message' ? ' ev-msg' : '') });
    var body = el('blockquote', { class: 'think-body' }, markdownish(text));
    append(li, [el('div', { class: 'ev-meta' }, el('span', { class: 'ev-label' }, label), reportLink(function () { return eventTarget(e); })), body, clampable(li, body, text.length > 360 || text.split('\n').length > 8)]);
    return li;
  }

  function addrLinkShort(a, chain) {
    var n = S.nodes.get(a);
    var name = TOKEN_NAMES[a] || (n && n.label) || null;
    return el('a', { class: 'al', href: explorerFor(chain).base + '/address/' + a, target: '_blank', rel: 'noopener', title: a }, name ? name + ' ' + short(a) : short(a));
  }
  function txLinkShort(h, chain) {
    return el('a', { class: 'al', href: explorerFor(chain).base + '/tx/' + h, target: '_blank', rel: 'noopener', title: h }, 'tx ' + short(h));
  }
  function topicAddr(t) { return typeof t === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(t) ? '0x' + t.slice(-40).toLowerCase() : null; }

  function describeArgs(args, chain) {
    var parts = [];
    var keys = Object.keys(args).filter(function (k) { return k !== 'chain'; });
    keys.sort(function (a, b) {
      var ia = ARG_ORDER.indexOf(a), ib = ARG_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    keys.forEach(function (k) {
      var v = args[k];
      if (v === null || v === undefined || v === '') return;
      if (k === 'topics' && Array.isArray(v)) {
        if (lc(v[0]) === TRANSFER_TOPIC) {
          var p = ['Transfer events'];
          var f = topicAddr(v[1]), t = topicAddr(v[2]);
          if (f) p.push(' from ', addrLinkShort(f, chain));
          if (t) p.push(' to ', addrLinkShort(t, chain));
          parts.push(p);
        } else parts.push(plural(v.length, 'topic'));
        return;
      }
      if (Array.isArray(v) && v.length === 2 && /block/.test(k) && v.every(function (x) { return num(x) !== null; })) { parts.push('blocks ' + v[0] + '-' + v[1]); return; }
      if (typeof v === 'string' && isAddr(lc(v))) { parts.push(k === 'account' ? addrLinkShort(lc(v), chain) : [k === 'address' ? 'contract ' : k + ' ', addrLinkShort(lc(v), chain)]); return; }
      if (typeof v === 'string' && isHash(v)) { parts.push(txLinkShort(v, chain)); return; }
      if (k === 'direction') { parts.push(String(v)); return; }
      if (k === 'limit') { parts.push('first ' + v); return; }
      if (k === 'detail') { parts.push(String(v)); return; }
      var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(k.replace(/_/g, ' ') + ' ' + (s.length > 48 ? s.slice(0, 47) + '…' : s));
    });
    var out = [];
    parts.forEach(function (p, i) { if (i) out.push(' · '); out.push(p); });
    return out;
  }

  var REPORT_TITLES = { preview_submission: 'Previewed the report', submit: 'Submitted the report' };

  function actionItem(e) {
    var tool = str(e.tool) || prettyType(e.kind);
    var args = e.args && typeof e.args === 'object' ? e.args : {};
    var chain = lc(args.chain) || lc(S.caseInfo.chain) || 'ethereum';
    var isReport = e.kind === 'report';
    var res = e.result && typeof e.result === 'object' ? e.result : null;
    var resText = res && typeof res.text === 'string' && res.text ? res.text : null;
    var full = res ? num(res.chars) : null;
    var argLine = describeArgs(args, chain);
    var li = el('li', { class: 'ev ev-act' + (isReport ? ' ev-report' : '') + (e.kind === 'action' ? ' is-action' : ''),
      title: e.kind === 'action' ? 'Move the replay to step ' + e._step : null },
      el('div', { class: 'act-head' },
        el('span', { class: 'act-step' }, 'Step ' + e._step + (hhmm(e.utc) ? ' · ' + hhmm(e.utc) : '')),
        el('span', { class: 'act-tool' }, isReport ? (REPORT_TITLES[tool] || prettyType(tool)) : tool),
        reportLink(function () { return eventTarget(e); })),
      argLine.length ? el('div', { class: 'act-args' }, argLine) : null);
    if (resText) {
      var holder = el('div', { class: 'res', hidden: true });
      var btn = el('button', { type: 'button', class: 'res-toggle', 'aria-expanded': 'false' }, 'Show result');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var open = holder.hidden;
        if (open && !holder.firstChild) {
          holder.appendChild(el('pre', { class: 'res-text', tabindex: '0' }, resText));
          holder.appendChild(el('p', { class: 'res-meta' }, full && full > resText.length
            ? 'First ' + resText.length.toLocaleString('en-US') + ' of ' + full.toLocaleString('en-US') + ' characters. The full result is in the raw records.'
            : plural(resText.length, 'character') + '.'));
        }
        holder.hidden = !open;
        btn.textContent = open ? 'Hide result' : 'Show result';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      li.appendChild(el('div', { class: 'act-res' }, btn, full ? el('span', { class: 'res-size' }, full.toLocaleString('en-US') + ' characters') : null));
      li.appendChild(holder);
    }
    if (e.kind === 'action') li.addEventListener('click', function (ev) {
      if (ev.target.closest('a, button, pre')) return;
      goToStep(e._step, e._k);
    });
    return li;
  }

  function memoryRow(evs) {
    var c = { findings: [], opened: 0, updated: 0, notes: 0, reads: 0, closes: [] };
    evs.forEach(function (e) {
      var a = e.args && typeof e.args === 'object' ? e.args : {};
      if (e.tool === 'state_lookup') c.reads++;
      else if (a.section === 'findings') c.findings.push(str(a.key));
      else if (a.section === 'leads') {
        if (e._lead === 'closed') c.closes.push(str(a.reason) || 'no reason given');
        else if (e._lead === 'updated') c.updated++;
        else c.opened++;
      } else if (a.section === 'notes') c.notes++;
      else c.updated++;
    });
    var chips = [];
    function chip(text, cls, title) { chips.push(el('span', { class: 'chip' + (cls ? ' ' + cls : ''), title: title || null }, text)); }
    if (c.reads) chip('read memory');
    if (c.findings.length) chip(c.findings.length === 1 ? 'recorded a flow' : 'recorded ' + c.findings.length + ' flows', 'rec');
    if (c.opened) chip(c.opened === 1 ? 'opened lead' : 'opened ' + c.opened + ' leads', 'open');
    if (c.updated) chip(c.updated === 1 ? 'updated lead' : 'updated ' + c.updated + ' leads');
    c.closes.forEach(function (r) { chip('closed lead: ' + (r.length > 56 ? r.slice(0, 55) + '…' : r), 'closed', r); });
    if (c.notes) chip(c.notes === 1 ? 'wrote note' : 'wrote ' + c.notes + ' notes');

    var list = el('ul', { class: 'mem-list', hidden: true });
    var built = false;
    function build() {
      if (built) return;
      built = true;
      evs.forEach(function (e) {
        var a = e.args && typeof e.args === 'object' ? e.args : {};
        var key = str(a.key) || '';
        var what = e.tool === 'state_lookup' ? 'read' : (a.section === 'findings' ? 'flow' : a.section === 'leads' ? (e._lead === 'closed' ? 'closed lead' : 'lead') : (a.section || 'memory'));
        var text = str(a.reason) || (typeof a.value === 'string' ? a.value : (a.value ? JSON.stringify(a.value) : (a.query !== undefined ? 'query "' + a.query + '"' : '')));
        var item = el('li', { class: 'mem-item', 'data-key': key },
          el('span', { class: 'mem-what' }, what),
          a.section === 'findings' && key
            ? el('button', { type: 'button', class: 'linkish mem-key', title: 'Show this flow in the graph', onclick: function (ev) { ev.stopPropagation(); selectOp(key); } }, key)
            : (key ? el('span', { class: 'mem-key' }, key) : null),
          text ? el('span', { class: 'mem-text' }, text.length > 260 ? text.slice(0, 259) + '…' : text) : null);
        list.appendChild(item);
      });
    }
    var toggle = el('button', { type: 'button', class: 'more', 'aria-expanded': 'false', onclick: function (ev) {
      ev.stopPropagation();
      build();
      list.hidden = !list.hidden;
      ev.currentTarget.textContent = list.hidden ? 'Details' : 'Hide details';
      ev.currentTarget.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    } }, 'Details');
    var li = el('li', { class: 'ev ev-mem' }, el('div', { class: 'mem-row' }, el('span', { class: 'mem-label' }, 'Working memory'), chips, toggle,
      reportLink(function () { return eventTarget(evs[0], evs.length); })), list);
    li.dataset.k = String(evs[0]._k);
    evs.forEach(function (e) { T.itemOf.set(e._k, li); });
    // A jump from a flow opens the details so the recorded entry is visible.
    li.openDetails = function () { build(); list.hidden = false; toggle.textContent = 'Hide details'; toggle.setAttribute('aria-expanded', 'true'); };
    return li;
  }

  // ---------- all flows: one table of every recorded flow ----------

  var FT = { sort: 'desc', filter: 'all', rows: null };  // newest flows first

  function verdictOf(e) {
    if (e.rejected) return 'rejected';
    return e.tier === 'verified' && (!e.op || e.op.verdict === 'VALID' || e.op.verdict === null) ? 'checked' : 'unchecked';
  }
  var VERDICT_BADGE = { checked: ['ok', 'Checked'], unchecked: ['wait', 'Not yet checked'], rejected: ['bad', 'Rejected'] };

  function flowRows() {
    if (FT.rows) return FT.rows;
    var rows = [];
    S.edges.forEach(function (e) {
      if (e.rejected || gone(e, S.total)) return;
      rows.push({ step: e.step, seed: e.seed, type: e.op ? prettyType(e.op.type) : (e.kind || 'transfer'), from: e.from, to: e.to,
        swap: e.swap, amount: e.amount, asset: e.swap ? e.toAsset : e.asset, fromAsset: e.fromAsset, verdict: verdictOf(e), edge: e, block: e.block || 0 });
    });
    // Rejected claims stay in the list, with their transfers when the export carries them.
    var withEdges = new Set();
    S.edges.forEach(function (e) {
      if (!e.rejected || gone(e, S.total)) return;
      if (e.op) withEdges.add(e.op);
      rows.push({ step: e.step, type: e.op ? prettyType(e.op.type) : (e.kind || 'transfer'), from: e.from, to: e.to, swap: e.swap,
        amount: e.amount, asset: e.swap ? e.toAsset : e.asset, fromAsset: e.fromAsset, verdict: 'rejected', edge: e, op: e.op, block: e.block || 0 });
    });
    S.ops.forEach(function (o) {
      if (o.verdict !== 'INVALID' || o.seedOp || withEdges.has(o) || gone(o, S.total)) return;
      rows.push({ step: o.step === null ? S.total : o.step, type: prettyType(o.type), verdict: 'rejected', op: o, block: 0 });
    });
    FT.rows = rows;
    return rows;
  }

  function renderFlowTable() {
    var body = $('ft-body');
    if (!body) return;
    clear(body);
    var all = flowRows();
    var rows = all.filter(function (r) { return FT.filter === 'all' || r.verdict === FT.filter; });
    rows.sort(function (a, b) { return (FT.sort === 'asc' ? 1 : -1) * (a.step - b.step || a.block - b.block); });
    $('ft-count').textContent = rows.length === all.length ? String(all.length) : rows.length + ' of ' + all.length;
    $('ft-sort').setAttribute('aria-sort', FT.sort === 'asc' ? 'ascending' : 'descending');
    var dir = $('ft-sort').querySelector('.dir');
    if (dir) dir.textContent = FT.sort === 'asc' ? '↑' : '↓';
    if (!rows.length) { body.appendChild(el('tr', null, el('td', { colspan: '7', class: 'ft-empty' }, 'No flows match this filter.'))); return; }
    rows.forEach(function (r) {
      var badge = VERDICT_BADGE[r.verdict];
      var tr = el('tr', { class: 'ft-row' + (r.step > S.step ? ' future' : '') + (r.edge && LIVE.fresh.has(r.edge.id) ? ' fresh' : ''), 'data-step': String(r.step), tabindex: '0', role: 'button',
          title: r.op ? 'Show this rejected claim' : (r.swap ? 'Show this swap and its evidence' : 'Show this flow in the graph'),
          onclick: function () { openFlowRow(r); },
          onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFlowRow(r); } } },
        el('td', { class: 'ft-step' }, r.seed ? 'start' : String(r.step)),
        el('td', null, r.type),
        el('td', { class: 'ft-addr' }, r.from ? nameOf(r.from) : el('span', { class: 'ft-none' }, 'not exported')),
        el('td', { class: 'ft-addr' }, !r.to ? el('span', { class: 'ft-none' }, 'not exported') : (r.swap ? el('span', { class: 'ft-none' }, 'same address') : nameOf(r.to))),
        el('td', { class: 'ft-amt' }, r.edge ? fmt(r.amount) + ' ' + r.asset + (r.swap && r.fromAsset ? ' from ' + r.fromAsset : '') : ''),
        el('td', { class: 'ft-via' }, r.op && r.op.via ? viaText(r.op.via) : (r.edge && r.edge.op && r.edge.op.via ? viaText(r.edge.op.via) : '')),
        el('td', null, el('span', { class: 'badge ' + badge[0] }, badge[1])));
      body.appendChild(tr);
    });
  }

  function markFlowTable() {
    var body = $('ft-body');
    if (!body) return;
    // Rows recorded after the replay step are dimmed.
    Array.prototype.forEach.call(body.children, function (tr) { if (tr.dataset.step) tr.classList.toggle('future', +tr.dataset.step > S.step); });
  }

  function openFlowRow(r) {
    stopPlay();
    var anchor = $('graph-anchor').getBoundingClientRect();
    if (anchor.top < 0 || anchor.top > window.innerHeight * 0.5) $('graph-anchor').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    if (r.verdict === 'rejected' && r.op) { focusOp(r.op.id); return; }
    var e = r.edge;
    if (e.step > S.step) apply(Math.max(S.step, e.step), { fit: false });
    if (r.swap) {
      select({ kind: 'swaps', id: e.from });
      var ele = S.cy.getElementById(e.from);
      if (ele && ele.nonempty()) S.cy.center(ele);
      var c = $('detail').querySelector('[data-edge="' + cssEsc(e.id) + '"]');
      if (c) { $('detail').scrollTop = Math.max(0, c.offsetTop - 60); flashEl(c); }
      return;
    }
    focusOp(e.op ? e.op.id : null, e.id);
  }

  function wireFlowTable() {
    $('ft-sort').addEventListener('click', function () { FT.sort = FT.sort === 'asc' ? 'desc' : 'asc'; renderFlowTable(); });
    Array.prototype.forEach.call(document.querySelectorAll('#ft-filter button'), function (b) {
      b.addEventListener('click', function () {
        FT.filter = b.dataset.f;
        Array.prototype.forEach.call(document.querySelectorAll('#ft-filter button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        renderFlowTable();
      });
    });
  }

  // ---------- report a problem ----------
  // Anyone can flag a flow, an address, a timeline event or a rejected claim.
  // Submitting opens a prefilled GitHub issue; nothing is sent from this page.

  var REPORT_TYPES = ['Wrong flow', 'Wrong amount', 'Should stop here', 'Missed a flow', 'Other'];
  var R = { target: null, lastUrl: null };

  function reportLink(makeTarget) {
    return el('button', { type: 'button', class: 'report-link', onclick: function (ev) { ev.stopPropagation(); openReport(makeTarget()); } }, 'Report a problem');
  }

  function deepLink(params) {
    var q = new URLSearchParams();
    if (DATA_URL !== 'data/graph.json') q.set('data', DATA_URL);
    Object.keys(params).forEach(function (k) { if (params[k] !== null && params[k] !== undefined && params[k] !== '') q.set(k, String(params[k])); });
    var s = q.toString();
    return SITE_URL + (s ? '?' + s : '');
  }
  function mdCode(s) { return '`' + String(s).replace(/`/g, '\u2019') + '`'; }
  function mdAddr(a, chain) {
    var n = S.nodes.get(a);
    return isAddr(a) ? '[' + mdCode(a) + '](' + explorerFor(chain).base + '/address/' + a + ')' + (n && n.label ? ' ' + n.label : '') : mdCode(a);
  }
  function mdTx(h, chain) { return isHash(h) ? '[' + mdCode(h) + '](' + explorerFor(chain).base + '/tx/' + h + ')' : (h ? mdCode(h) : 'none'); }
  function nameOf(id) { var n = S.nodes.get(id); return n && n.label ? n.label + ' ' + short(id) : short(id); }
  function dataVersion() {
    var c = S.caseInfo;
    return [c.updated_utc ? 'updated ' + c.updated_utc : null, c.head_block != null ? 'block ' + c.head_block : null].filter(Boolean).join(', ') || 'unknown';
  }
  function opEdgeCount(op) { return S.edges.filter(function (e) { return e.op === op; }).length; }

  function flowTarget(e) {
    var chain = (S.nodes.get(e.from) || {}).chain;
    var checked = e.tier === 'verified' && (!e.op || e.op.verdict === 'VALID' || e.op.verdict === null);
    var params = { op: e.op ? e.op.id : null, edge: !e.op || opEdgeCount(e.op) > 1 ? e.id : null };
    var ctx = [['Flagged', 'a flow']];
    if (e.op) ctx.push(['Operation', mdCode(e.op.id) + ' (' + prettyType(e.op.type) + ')']);
    if (e.op && e.op.via) ctx.push(['Via', viaText(e.op.via) + (e.op.via.contract ? ' ' + mdAddr(e.op.via.contract, chain) : '')]);
    ctx.push(['Transfer', mdCode(e.id)], ['From', mdAddr(e.from, chain)], ['To', mdAddr(e.to, chain)],
      ['Amount', fmtExact(e.amountStr) + ' ' + e.asset], ['Transaction', mdTx(e.tx, chain)]);
    if (e.srcPos || e.tgtPos) ctx.push(['Records', 'from end: ' + (e.srcPos || 'none') + '; to end: ' + (e.tgtPos || 'none')]);
    ctx.push(['Recorded', e.seed ? 'case start' : 'agent step ' + e.step], ['Checker', checked ? 'checked' : 'not yet checked']);
    return {
      summary: fmt(e.amount) + ' ' + e.asset + ' from ' + nameOf(e.from) + ' to ' + nameOf(e.to),
      short: short(e.from) + ' to ' + short(e.to) + ' (' + e.asset + ')',
      type: 'Wrong flow', context: ctx, link: deepLink(params)
    };
  }

  function generalTarget() {
    return { summary: 'This page in general', short: 'general report', type: 'Other', context: [['Flagged', 'the page in general']], link: deepLink({}) };
  }

  function addressTarget(n) {
    var leads = (S.leadsByAddr.get(n.id) || []).length;
    var ctx = [['Flagged', 'an address'], ['Address', mdAddr(n.id, n.chain)], ['Role', ROLES[n.role].name]];
    if (leads) ctx.push(['Open leads', String(leads)]);
    return {
      summary: nameOf(n.id) + ' (' + ROLES[n.role].name.toLowerCase() + ')',
      short: short(n.id) + (n.label ? ' (' + n.label + ')' : ''),
      type: 'Other', context: ctx, link: deepLink({ addr: n.id })
    };
  }

  var EVENT_NAMES = { thinking: 'reasoning summary', memory: 'working memory', action: 'evidence action', message: 'message', report: 'report', system: 'system prompt', task: 'task', deferred: 'call not run', recall: 're-read result', review: 'human review' };
  function eventTarget(e, count) {
    var kind = EVENT_NAMES[e.kind] || prettyType(e.kind);
    var tool = str(e.tool);
    var ctx = [['Flagged', 'a timeline event'], ['Event', String(e._order) + (count > 1 ? ' (and ' + (count - 1) + ' more memory writes)' : '')],
      ['Agent step', String(e._step)], ['Kind', kind + (tool ? ', ' + mdCode(tool) : '')]];
    if (e.args && typeof e.args === 'object' && Object.keys(e.args).length) {
      var a = JSON.stringify(e.args);
      ctx.push(['Arguments', mdCode(a.length > 300 ? a.slice(0, 299) + '\u2026' : a)]);
    }
    return {
      summary: 'Timeline event ' + e._order + ', step ' + e._step + ' (' + kind + (tool ? ', ' + tool : '') + ')',
      short: 'timeline event ' + e._order + ' (step ' + e._step + (tool ? ', ' + tool : '') + ')',
      type: 'Other', context: ctx, link: deepLink({ event: e._order })
    };
  }

  function rejectedTarget(o) {
    var txs = [];
    o.evidence.forEach(function (x) { if (x.tx && txs.indexOf(x.tx) === -1) txs.push(x.tx); });
    var ctx = [['Flagged', 'a claim the checker rejected'], ['Operation', mdCode(o.id) + ' (' + prettyType(o.type) + ')']];
    if (o.step !== null) ctx.push(['Recorded', 'agent step ' + o.step]);
    ctx.push(['Checker reasons', o.reasons.length ? o.reasons.map(mdCode).join(', ') : 'none given']);
    var claimed = S.edges.filter(function (e) { return e.op === o; });
    claimed.slice(0, 6).forEach(function (e) {
      var chain = (S.nodes.get(e.from) || {}).chain;
      ctx.push(['Claimed transfer', e.swap
        ? mdAddr(e.from, chain) + ' swapped ' + (e.fromAsset || '?') + ' to ' + fmtExact(e.amountStr) + ' ' + e.toAsset
        : mdAddr(e.from, chain) + ' to ' + mdAddr(e.to, chain) + ', ' + fmtExact(e.amountStr) + ' ' + e.asset]);
    });
    if (claimed.length > 6) ctx.push(['More transfers', String(claimed.length - 6)]);
    txs.forEach(function (h) { ctx.push(['Transaction', mdTx(h, S.caseInfo.chain)]); });
    return {
      summary: 'Rejected ' + prettyType(o.type) + ' claim' + (o.step !== null ? ' at step ' + o.step : ''),
      short: 'rejected ' + prettyType(o.type) + (o.step !== null ? ' at step ' + o.step : '') + ' (' + o.id + ')',
      type: 'Other', context: ctx, link: deepLink({ op: o.id })
    };
  }

  function buildIssueUrl(t, f) {
    var title = '[report] ' + f.type + ': ' + t.short;
    function body(what, evidence, note) {
      var L = ['**Problem type:** ' + f.type, '', '**What is wrong**', '', what, ''];
      if (evidence) L.push('**Evidence**', '', evidence, '');
      var who = [f.name, f.contact].filter(Boolean).join(', ');
      if (who) L.push('**Reported by:** ' + who, '');
      if (note) L.push('_' + note + '_', '');
      L.push('---', '', '### Context', '');
      t.context.forEach(function (kv) { L.push('- ' + kv[0] + ': ' + kv[1]); });
      L.push('- Data version: ' + dataVersion(), '- Link: ' + t.link);
      return L.join('\n');
    }
    function urlFor(b) { return ISSUE_URL + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(b); }
    var what = f.what, evd = f.evidence, note = null;
    var url = urlFor(body(what, evd, note));
    // Keep the link under the limit by shortening the longest free-text field, with a note.
    for (var guard = 0; url.length > MAX_ISSUE_URL && guard < 60; guard++) {
      note = 'Shortened to fit the GitHub link. Add the rest as a comment.';
      var cut = Math.ceil((url.length - MAX_ISSUE_URL) / 3) + 16;
      if (what.length >= evd.length && what.length > 120) what = what.slice(0, Math.max(120, what.length - cut)) + '\u2026';
      else if (evd.length > 80) evd = evd.slice(0, Math.max(80, evd.length - cut)) + '\u2026';
      else break;
      url = urlFor(body(what, evd, note));
    }
    return url;
  }

  function openReport(t) {
    R.target = t;
    var dlg = $('report');
    $('report-target').textContent = t.summary;
    var sel = $('rp-type');
    if (!sel.options.length) REPORT_TYPES.forEach(function (x) { sel.appendChild(el('option', { value: x }, x)); });
    sel.value = t.type;
    $('rp-error').hidden = true;
    $('rp-what').removeAttribute('aria-invalid');
    if (FORM_URL) { $('rp-form-link').setAttribute('href', FORM_URL); $('rp-form').hidden = false; }
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
    $('rp-what').focus();
  }
  function closeReport() { var d = $('report'); if (d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); } }

  function submitReport(ev) {
    ev.preventDefault();
    var what = $('rp-what').value.trim();
    if (!what) {
      $('rp-error').hidden = false;
      $('rp-what').setAttribute('aria-invalid', 'true');
      $('rp-what').focus();
      return;
    }
    var url = buildIssueUrl(R.target, {
      type: $('rp-type').value, what: what,
      evidence: $('rp-evidence').value.trim(), name: $('rp-name').value.trim(), contact: $('rp-contact').value.trim()
    });
    R.lastUrl = url;
    window.open(url, '_blank', 'noopener');
    closeReport();
    $('rp-what').value = '';
    $('rp-evidence').value = '';
    toast('GitHub opened in a new tab');
  }

  function wireReport() {
    $('report-form').addEventListener('submit', submitReport);
    $('report-close').addEventListener('click', closeReport);
    $('report-cancel').addEventListener('click', closeReport);
    $('rp-what').addEventListener('input', function () { if (this.value.trim()) { $('rp-error').hidden = true; this.removeAttribute('aria-invalid'); } });
    // A click on the backdrop closes the dialog.
    $('report').addEventListener('click', function (ev) { if (ev.target === this) closeReport(); });
  }

  // ---------- deep links: ?op= ?edge= ?addr= ?event= ----------

  function flashEl(node) {
    if (!node) return;
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function focusOp(opId, edgeId) {
    var op = opId ? S.ops.get(opId) : null;
    if (op && op.verdict === 'INVALID') {
      if (op.step !== null && op.step > S.step) apply(S.total, { fit: false });
      select({ kind: 'rejected' });
      var card = $('detail').querySelector('[data-op="' + cssEsc(opId) + '"]');
      if (card) { card.scrollIntoView({ block: 'nearest' }); flashEl(card); }
      return true;
    }
    var edge = null;
    S.edges.forEach(function (e) {
      if (edge || e.rejected) return;
      if (edgeId ? e.id === edgeId : (op && e.op === op)) edge = e;
    });
    if (!edge) return false;
    if (edge.step > S.step) apply(Math.max(S.step, edge.step), { fit: false });
    var b = null;
    S.bundles.forEach(function (bb) { if (!b && bb.groups.some(function (g) { return g.edges.indexOf(edge) !== -1; })) b = bb; });
    if (!b) return false;
    select({ kind: 'bundle', id: b.id });
    var ele = S.cy.getElementById(b.id);
    if (ele && ele.nonempty()) S.cy.center(ele);
    var c = $('detail').querySelector('[data-edge="' + cssEsc(edge.id) + '"]');
    if (c) { $('detail').scrollTop = Math.max(0, c.offsetTop - 60); flashEl(c); }
    return true;
  }

  // Links from older reports can point at items a later export renamed or dropped.
  function notInData() { toast('That item is not in the current data. It may come from an earlier version.', 6000); }

  function handleDeepLinks() {
    var opId = PARAMS.get('op'), edgeId = PARAMS.get('edge'), addr = lc(PARAMS.get('addr') || '');
    if (opId || edgeId) { if (!focusOp(opId, edgeId)) notInData(); }
    else if (addr) { if (viewAt(S.total).nodes.has(addr)) focusNode(addr); else notInData(); }
  }

  function handleEventLink() {
    var want = num(PARAMS.get('event'));
    if (want === null || T.linkDone) return;
    T.linkDone = true;
    var m = chunkForIndex(want);
    if (!m) { notInData(); return; }
    setTab('traj');
    loadChunk(m).then(function () {
      var e = T.events[want];
      if (!e) { notInData(); return; }
      if (PARAMS.get('step') === null && !PARAMS.get('op') && !PARAMS.get('addr')) { T.pinK = want; apply(e._step, { fit: true }); }
      revealEvent(want);
    });
  }

  // ---------- live updates ----------
  // Every two minutes: fetch graph.json; when the export changed, fetch the timeline too and
  // apply both in place, keeping the visitor's selection, replay position and scroll.

  var LIVE = { lastCheck: 0, failed: false, busy: false, fresh: new Set(), freshTimer: null, status: null };

  function agoText(iso) {
    var d = parseTime(iso);
    if (!d) return null;
    var min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' h ago';
    return fmtTime(iso);
  }
  function renderLiveStatus() {
    var box = $('live-status');
    if (!box || EMBED) return;
    var ago = agoText(S.caseInfo.updated_utc);
    box.textContent = (ago ? 'Updated ' + ago + ' · ' : '') + (LIVE.failed ? 'could not check for updates, trying again' : pollMs() < POLL_MS ? 'checks every minute' : 'checks every ' + Math.round(POLL_MS / 60000) + ' min');
    box.hidden = false;
  }

  function poll(force) {
    if (LIVE.busy || (document.hidden && !force)) return Promise.resolve(false);
    LIVE.busy = true;
    LIVE.lastCheck = Date.now();
    loadStatus();
    return fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (g) {
        LIVE.failed = false;
        if (!g || !g.case || (g.case.updated_utc && g.case.updated_utc === S.caseInfo.updated_utc)) return false;
        var prev;
        try { prev = applyUpdate(g); } catch (err) {
          if (window.console) console.warn('Live tracker: could not apply the new data; keeping the current view.', err);
          LIVE.failed = true;
          return false;
        }
        return refreshTrajectory(prev).then(function () { return true; });
      })
      .catch(function () { LIVE.failed = true; return false; })
      .then(function (changed) { LIVE.busy = false; renderLiveStatus(); return changed; });
  }

  function runLayout(animate, done) { layoutGraph(animate, done); }

  var BAND = { pad: 30, gap: 90 };
  function isBridge(id) { var n = S.nodes.get(id); return !!n && n.role === 'stop' && BRIDGE_CLASSES.indexOf(n.stopClass) !== -1; }
  function grouping() { return S.groupChains && !NARROW; }
  function layoutGraph(animate, done) {
    var cy = S.cy;
    var real = cy ? cy.nodes().not('.lane, .lanelbl') : null;
    if (!real || !real.length) { if (cy) cy.remove('.lane, .lanelbl'); if (done) done(); return; }
    var before = {};
    real.forEach(function (n) { var p = n.position(); before[n.id()] = { x: p.x, y: p.y }; });
    cy.elements().not('.lane, .lanelbl').layout({
      name: typeof dagre !== 'undefined' ? 'dagre' : 'breadthfirst',
      rankDir: NARROW ? 'TB' : 'LR', nodeSep: NARROW ? 30 : 24, rankSep: NARROW ? 90 : 150, edgeSep: 14, ranker: 'network-simplex',
      directed: true, fit: false, animate: false
    }).run();
    var target = {};
    real.forEach(function (n) { var p = n.position(); target[n.id()] = { x: p.x, y: p.y }; });
    var bands = grouping() ? packBands(real, target) : [];
    cy.batch(function () {
      cy.remove('.lane, .lanelbl');
      bands.forEach(function (b) {
        cy.add({ group: 'nodes', classes: 'lane' + (b.empty ? ' empty' : ''), position: { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 },
          data: { id: 'lane:' + b.chain, w: b.x2 - b.x1, h: b.y2 - b.y1, color: b.color } });
      });
      real.forEach(function (n) {
        n.toggleClass('badge', CHAIN_BADGES && !grouping());
      });
    });
    S.bands = bands;
    var moved = animate && !REDUCED_MOTION;
    if (moved) {
      real.forEach(function (n) { var b = before[n.id()]; if (b && isFinite(b.x) && isFinite(b.y)) n.position(b); });
      real.forEach(function (n) { n.animate({ position: target[n.id()] }, { duration: 700, easing: 'ease-in-out-cubic' }); });
      setTimeout(function () { placeEdgeLabels(); positionBandLabels(); if (done) done(); }, 720);
    } else {
      real.forEach(function (n) { n.position(target[n.id()]); });
      placeEdgeLabels();
      positionBandLabels();
      if (done) done();
    }
  }
  // The chain names sit over the graph in HTML, so they stay readable at any zoom
  function positionBandLabels() {
    var box = $('lane-labels');
    if (!box) return;
    clear(box);
    if (!S.cy || !S.bands || !S.bands.length) return;
    var h = S.cy.height();
    S.bands.forEach(function (b) {
      var n = S.cy.getElementById('lane:' + b.chain);
      if (n.empty()) return;
      var r = n.renderedBoundingBox();
      if (r.y2 < 0 || r.y1 > h) return;
      box.appendChild(el('div', { class: 'lane-label',
        style: 'left:' + Math.max(6, r.x1) + 'px;top:' + Math.max(2, r.y1 - 19) + 'px;color:' + b.color }, b.label));
    });
  }
  // Grouped by chain: dagre's own layout is kept (each address where dagre put it); a chain whose block
  // overlaps the one above is moved down as a whole; each chain gets a faint region hugging its own
  // addresses, named above it; a bridge sits on its region's edge, toward the chain it leads to.
  function packBands(real, target) {
    var by = new Map();
    real.forEach(function (n) {
      var c = lc((S.nodes.get(n.id()) || {}).chain || 'ethereum');
      if (!by.has(c)) by.set(c, []);
      by.get(c).push(n);
    });
    if (by.size < 2) return [];
    function box(ns) {
      var b = { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity };
      ns.forEach(function (n) {
        if (isBridge(n.id())) return;
        var t = target[n.id()], w = n.width() / 2, h = n.height() / 2;
        b.x1 = Math.min(b.x1, t.x - w); b.x2 = Math.max(b.x2, t.x + w);
        b.y1 = Math.min(b.y1, t.y - h); b.y2 = Math.max(b.y2, t.y + h);
      });
      return b;
    }
    var chains = Array.from(by.keys());
    var mean = {};
    chains.forEach(function (c) { var b = box(by.get(c)); mean[c] = isFinite(b.y1) ? (b.y1 + b.y2) / 2 : 0; });
    chains.sort(function (a, b) { return mean[a] - mean[b]; });
    var bands = [], floor = -Infinity;
    chains.forEach(function (c) {
      var ns = by.get(c), b = box(ns);
      if (!isFinite(b.y1)) b = { x1: 0, x2: 0, y1: 0, y2: 0 };
      var dy = Math.max(0, floor + BAND.gap - (b.y1 - BAND.pad));
      if (dy) { ns.forEach(function (n) { target[n.id()].y += dy; }); b.y1 += dy; b.y2 += dy; }
      var ch = chainInfo(c);
      var band = { chain: c, color: ch.color, label: ch.name.toUpperCase() + ' · ' + plural(ns.length, 'address', 'addresses'),
        x1: b.x1 - BAND.pad, x2: b.x2 + BAND.pad, y1: b.y1 - BAND.pad, y2: b.y2 + BAND.pad };
      ns.forEach(function (n) {
        if (!isBridge(n.id())) return;
        var up = n.outgoers('node').some(function (m) {
          var mc = lc((S.nodes.get(m.id()) || {}).chain || 'ethereum');
          return chains.indexOf(mc) !== -1 && chains.indexOf(mc) < chains.indexOf(c);
        });
        target[n.id()].y = up ? band.y1 : band.y2;
        band.x1 = Math.min(band.x1, target[n.id()].x - n.width() / 2 - BAND.pad);
        band.x2 = Math.max(band.x2, target[n.id()].x + n.width() / 2 + BAND.pad);
      });
      bands.push(band);
      floor = band.y2 + (ns.some(function (n) { return isBridge(n.id()); }) ? 30 : 0);
    });
    return bands;
  }



  // Bring the drawn graph in line with the new data without rebuilding it.
  function updateGraph() {
    var cy = S.cy, latest = viewAt(S.total), added = [];
    S.maxByAsset = new Map();
    latest.groups.forEach(function (gv) {
      if (gv.group.from === gv.group.to) return;
      S.maxByAsset.set(gv.group.asset, Math.max(S.maxByAsset.get(gv.group.asset) || 0, gv.sum));
    });
    var wantB = new Map();
    latest.bundles.forEach(function (bv) { if (bv.bundle.from !== bv.bundle.to) wantB.set(bv.bundle.id, bv); });
    cy.batch(function () {
      cy.edges().forEach(function (e) { if (!wantB.has(e.id())) e.remove(); });
      cy.nodes().not('.lane, .lanelbl').forEach(function (n) { if (!latest.nodes.has(n.id())) n.remove(); });
      latest.nodes.forEach(function (id) {
        var n = S.nodes.get(id), d = nodeData(n, latest), ele = cy.getElementById(id);
        if (ele.empty()) { added.push(cy.add({ group: 'nodes', data: Object.assign({ id: id }, d), classes: nodeClasses(n) })); return; }
        ele.data(d);
        ROLE_ORDER.forEach(function (r) { if (r !== n.role) ele.removeClass('r-' + r); });
        ele.addClass('r-' + n.role);
      });
      wantB.forEach(function (bv, id) {
        var ele = cy.getElementById(id), d = bundleData(bv);
        if (ele.empty()) added.push(cy.add({ group: 'edges', data: Object.assign({ id: id, source: bv.bundle.from, target: bv.bundle.to, off: 90, loop: 40 }, d), classes: edgeClasses(bv.bundle) }));
        else ele.data(d);
      });
    });
    // New addresses start next to a neighbour already on screen, so the layout grows them out of the graph.
    added.forEach(function (ele) {
      if (!ele.isNode()) return;
      var nb = ele.neighborhood('node').filter(function (x) { return added.indexOf(x) === -1; });
      if (nb.nonempty()) ele.position({ x: nb[0].position('x') + 40, y: nb[0].position('y') });
    });
    return added;
  }

  function markFresh(edgeIds, addedNodes) {
    clearTimeout(LIVE.freshTimer);
    LIVE.fresh = new Set(edgeIds);
    var cy = S.cy;
    cy.batch(function () {
      cy.elements('.fresh').removeClass('fresh');
      S.bundles.forEach(function (b) {
        if (b.groups.some(function (g) { return g.edges.some(function (e) { return LIVE.fresh.has(e.id); }); })) {
          var ele = cy.getElementById(b.id);
          if (ele.nonempty()) ele.addClass('fresh');
        }
      });
      addedNodes.forEach(function (ele) { if (ele.isNode() && ele.inside()) ele.addClass('fresh'); });
    });
    LIVE.freshTimer = setTimeout(function () {
      LIVE.fresh = new Set();
      if (S.cy) S.cy.elements('.fresh').removeClass('fresh');
      Array.prototype.forEach.call(document.querySelectorAll('#ft-body tr.fresh'), function (tr) { tr.classList.remove('fresh'); });
    }, 10000);
  }

  // Timeline refresh: re-read the index, then only chunks that are new or changed
  // (the last one grows; earlier ones never change). A single file is re-read whole.
  function refreshTrajectory(prev) {
    if (!T.loaded) return Promise.resolve();
    var done = function () {
      afterTrajectoryChange();
      if (prev.follow && S.step < S.total) apply(S.total, { fit: false });
      if (!prev.follow || activeTab() !== 'traj') $('workspace').scrollTop = prev.ws;
    };
    var p;
    if (T.mode === 'single') {
      p = fetchJson(TRAJ_URL).then(initSingle);
    } else {
      var old = {};
      T.meta.forEach(function (m) { old[m.file] = m; });
      p = fetchJson(TRAJ_INDEX_URL).then(function (idx) {
        if (!applyIndex(idx)) return null;
        var loads = [];
        T.meta.forEach(function (m, j) {
          var o = old[m.file];
          var changed = !o || o.last_i !== m.last_i || o.last_step !== m.last_step || o.cost !== m.cost;
          var wanted = T.chunk[m.file] === 'loaded' || T.chunk[m.file] === 'failed' || j === T.meta.length - 1;
          if (changed && wanted) { delete T.chunk[m.file]; loads.push(loadChunk(m)); }
        });
        return Promise.all(loads);
      });
    }
    return p.then(done, function (err) { if (window.console) console.warn('Live tracker: timeline refresh failed', err); });
  }

  // New flows from a live update: one card each (newest first, up to NEWS_MAX), a click opens the flow;
  // the rest as one "+N more" card that goes to the flows table. Cards leave after NEWS_MS unless hovered.
  var NEWS_MAX = 3, NEWS_MS = 20000;
  function showNews(ids) {
    var box = $('news');
    if (!box || EMBED) return;
    var want = new Set(ids);
    var list = S.edges.filter(function (e) { return want.has(e.id); }).sort(function (a, b) { return b.step - a.step; });
    clear(box);
    function card(main, sub, kicker, open, label) {
      var c = el('div', { class: 'news-card' });
      var b = el('button', { type: 'button', class: 'news-open', 'aria-label': label },
        kicker ? el('span', { class: 'news-kicker' }, kicker) : null,
        el('span', { class: 'news-main' }, main),
        sub ? el('span', { class: 'news-sub' }, sub) : null);
      b.addEventListener('click', function () { open(); c.remove(); });
      var x = el('button', { type: 'button', class: 'news-x', 'aria-label': 'Dismiss' }, '\u00d7');
      x.addEventListener('click', function () { c.remove(); });
      append(c, [b, x]);
      var timer = null;
      function later() { timer = setTimeout(function () { c.remove(); }, NEWS_MS); }
      c.addEventListener('mouseenter', function () { clearTimeout(timer); });
      c.addEventListener('mouseleave', later);
      later();
      box.appendChild(c);
    }
    // flows between the same two addresses in the same asset make one card, with their total
    var groups = [], byKey = new Map();
    list.forEach(function (e) {
      var k = e.from + '|' + e.to + '|' + e.asset, g = byKey.get(k);
      if (!g) { g = { edges: [], sum: 0 }; byKey.set(k, g); groups.push(g); }
      g.edges.push(e);
      if (Number.isFinite(e.amount)) g.sum += e.amount;
    });
    groups.slice(0, NEWS_MAX).forEach(function (g) {
      var e = g.edges[0], n = g.edges.length;
      var main = fmt(g.sum) + ' ' + (e.swap ? e.toAsset : e.asset);
      var sub = e.swap ? (n > 1 ? plural(n, 'swap') + ' from ' : 'Swapped from ') + e.fromAsset + ' at ' + nameOf(e.from)
        : nameOf(e.from) + ' to ' + nameOf(e.to);
      var kicker = (n > 1 ? plural(n, 'new flow') : 'New flow') + ' · step ' + e.step + (hhmm(S.caseInfo.updated_utc) ? ' · ' + hhmm(S.caseInfo.updated_utc) : '');
      card(main, sub, kicker, function () { openFlowRow({ edge: e, swap: e.swap, verdict: verdictOf(e) }); }, kicker + ': ' + main + ', ' + sub);
    });
    var rest = groups.slice(NEWS_MAX).reduce(function (a, g) { return a + g.edges.length; }, 0);
    if (rest > 0) card('+' + plural(rest, 'more new flow'), null, null, function () {
      $('flows').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    }, '+' + plural(rest, 'more new flow') + ', in the flows table');
  }

  function applyUpdate(raw) {
    var prev = {
      follow: S.step >= S.total, step: S.step, selected: S.selected, tab: activeTab(),
      flowIds: new Set(S.edges.filter(function (e) { return !e.rejected; }).map(function (e) { return e.id; })),
      ws: $('workspace').scrollTop, detail: $('detail').scrollTop, ft: $('ft-scroll').scrollTop, winY: window.scrollY
    };
    normalize(raw);
    FT.rows = null;
    renderHeader();
    renderNotes();
    renderCoverage();
    renderChainOverview();
    renderComingSoon();
    renderLegend();
    renderWorkspace();
    buildTimelineControls();
    var added = updateGraph();
    var sel = prev.selected;
    if (sel && sel.kind === 'bundle' && !S.bundleById.has(sel.id)) sel = null;
    if (sel && (sel.kind === 'node' || sel.kind === 'swaps') && !S.nodes.has(sel.id)) sel = null;
    S.selected = sel;
    apply(prev.follow ? S.total : Math.min(prev.step, S.total), { fit: false });
    runLayout(added.length > 0, function () { if (!S.userMoved) fitView(true); });
    renderFlowTable();
    if (prev.tab !== activeTab() && !$('tab-' + prev.tab).hidden) setTab(prev.tab);
    // Put the visitor back where they were reading.
    $('detail').scrollTop = prev.detail;
    $('ft-scroll').scrollTop = prev.ft;
    if (!prev.follow || activeTab() !== 'traj') $('workspace').scrollTop = prev.ws;
    window.scrollTo(window.scrollX, prev.winY);
    var fresh = S.edges.filter(function (e) { return !e.rejected && !prev.flowIds.has(e.id); }).map(function (e) { return e.id; });
    markFresh(fresh, added);
    renderFlowTable();
    $('ft-scroll').scrollTop = prev.ft;
    if (fresh.length) showNews(fresh);
    return prev;
  }

  // Scheduler status: {state: tracing|waiting|paused_budget|stopped, since_utc, next_wave_utc, spent_usd, cap_usd, heartbeat_utc}
  var STATUS_URL = safeDataPath(PARAMS.get('status')) || (DATA_NAME === 'graph' ? DATA_DIR + 'status.json' : null);
  var STALE_MS = 45 * 60 * 1000;
  function loadStatus() {
    if (!STATUS_URL || EMBED && !PARAMS.get('status')) return Promise.resolve();
    return fetchJson(STATUS_URL).then(function (st) { LIVE.status = st && typeof st === 'object' ? st : null; }, function () { LIVE.status = null; })
      .then(function () { renderStatusBadge(); renderLiveStatus(); });
  }
  function hhmm(iso) { var d = parseTime(iso); return d ? pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC' : null; }
  // Model cost against the night's cap, from the scheduler's status file.
  function renderBudget(st) {
    var box = $('budget');
    if (!box) return;
    var spent = st && Number(st.spent_usd), cap = st && Number(st.cap_usd);
    if (!st || !isFinite(spent)) { box.hidden = true; return; }
    $('budget-spent').textContent = '$' + spent.toFixed(2);
    $('budget-cap').textContent = isFinite(cap) && cap > 0 ? '$' + Math.round(cap) : '';
    $('budget-fill').style.width = (isFinite(cap) && cap > 0 ? Math.min(100, 100 * spent / cap) : 0) + '%';
    box.hidden = false;
  }

  // The agent's state from the scheduler's status file; short is the end-of-timeline wording.
  function agentState() {
    var st = LIVE.status, hb = st && parseTime(st.heartbeat_utc);
    var state = !st || !hb || Date.now() - hb.getTime() > STALE_MS ? 'stopped' : String(st.state || 'stopped');
    // a round starts with the outflow check, a few minutes before the agent runs: past the announced time, it is tracing
    var next = state === 'waiting' ? parseTime(st.next_wave_utc) : null;
    if (next && next.getTime() <= Date.now()) state = 'tracing';
    if (state === 'tracing') return { state: state, text: 'I\'m tracing now', short: 'Tracing now' };
    if (state === 'waiting') {
      var t = next ? 'Next round around ' + hhmm(st.next_wave_utc) : 'Waiting for the next round';
      return { state: state, text: t, short: t };
    }
    if (state === 'paused_budget') return { state: state, text: 'Paused: I\'ve hit my token cap for now. Waiting for a human to wake up and top it up.', short: 'Paused at my token cap' };
    return { state: 'stopped', text: 'Not running right now', short: 'Not running right now' };
  }

  function renderStatusBadge() {
    renderLiveTail();
    var badge = $('agent-status'), dot = document.querySelector('.kicker .live-dot');
    var st = LIVE.status;
    renderBudget(st);
    if (!st) { badge.hidden = true; $('rounds-note').hidden = true; if (dot) dot.className = 'live-dot'; return; }
    var hb = parseTime(st.heartbeat_utc);
    var info = agentState(), state = info.state, text = info.text;
    badge.textContent = text;
    badge.className = 'agent-status st-' + state;
    badge.hidden = false;
    $('rounds-note').hidden = false;
    if (dot) dot.className = 'live-dot st-' + state;
  }

  // "What I found": a short hand-picked list (data/highlights.json) shown as a one-item ticker; a click
  // opens the item with its records. Hidden without the file.
  var HL = { items: [], i: 0, open: false, hover: false, timer: null };
  function renderHighlight() {
    var box = $('highlights-item');
    if (!box || !HL.items.length) return;
    var it = HL.items[HL.i];
    clear(box);
    box.classList.toggle('open', HL.open);
    var links = (Array.isArray(it.evidence) ? it.evidence : []).filter(function (e) { return e && /^https:\/\//.test(String(e.url)); });
    append(box, [
      el('button', { type: 'button', class: 'hl-text', 'aria-expanded': HL.open ? 'true' : 'false',
        title: HL.open ? 'Show less' : 'Show the records', onclick: function () { HL.open = !HL.open; renderHighlight(); } }, str(it.text)),
      HL.open && links.length ? el('p', { class: 'hl-ev' }, links.map(function (e, k) {
        return [k ? ' · ' : null, el('a', { href: String(e.url), target: '_blank', rel: 'noopener' }, str(e.label) || 'record')];
      })) : null
    ]);
    if ($('highlights-count')) $('highlights-count').textContent = HL.items.length > 1 ? (HL.i + 1) + '/' + HL.items.length : '';
    var note = $('highlights-note');
    if (note) note.hidden = !HL.open;
  }
  function stepHighlight(d) {
    if (!HL.items.length) return;
    HL.i = (HL.i + d + HL.items.length) % HL.items.length;
    HL.open = false;
    renderHighlight();
  }
  function loadHighlights() {
    fetchJson(DATA_DIR + 'highlights.json').then(function (d) {
      HL.items = d && Array.isArray(d.items) ? d.items.filter(function (it) { return it && str(it.text); }) : [];
      var box = $('highlights');
      if (!box || !HL.items.length) return;
      if ($('highlights-note')) $('highlights-note').textContent = str(d.note) || '';
      var multi = HL.items.length > 1;
      ['hl-prev', 'hl-next'].forEach(function (id, k) {
        var b = $(id);
        if (!b) return;
        b.hidden = !multi;
        b.onclick = function () { stepHighlight(k ? 1 : -1); };
      });
      box.onmouseenter = function () { HL.hover = true; };
      box.onmouseleave = function () { HL.hover = false; };
      renderHighlight();
      box.hidden = false;
      if (multi && !REDUCED_MOTION && !HL.timer) {
        HL.timer = setInterval(function () { if (!HL.hover && !HL.open && !document.hidden) stepHighlight(1); }, 9000);
      }
    }, function () { /* no list: nothing shown */ });
  }

  function startLive() {
    if (EMBED) return;
    renderLiveStatus();
    loadStatus();
    (function next() { setTimeout(function () { poll(false).then(next, next); }, pollMs()); })();
    setInterval(function () { renderLiveStatus(); renderStatusBadge(); }, 30000);
    // A tab that comes back after a while checks right away.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - LIVE.lastCheck > pollMs()) poll(true);
    });
  }

  // ---------- boot ----------

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = Promise.all([document.fonts.load('500 11px "JetBrains Mono"'), document.fonts.load('400 30px "Instrument Serif"')]).catch(function () {});
    return Promise.race([loads, new Promise(function (r) { setTimeout(r, 2500); })]);
  }

  function wireControls() {
    $('slider').addEventListener('input', function (ev) { stopPlay(); T.pinK = null; apply(+ev.target.value, { animate: true }); });
    $('tab-traj').addEventListener('click', function () { setTab('traj'); });
    $('tab-mem').addEventListener('click', function () { setTab('mem'); });
    on($('workspace').querySelector('.ws-tabs'), 'keydown', function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      var next = activeTab() === 'traj' ? 'mem' : 'traj';
      if ($('tab-' + next).hidden) return;
      setTab(next);
      $('tab-' + next).focus();
    });
    on($('tell-me'), 'click', function (ev) { ev.preventDefault(); openReport(generalTarget()); });
    on($('ws-to-flows'), 'click', function (ev) { ev.preventDefault(); $('flows').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' }); });
    on($('btn-earlier'), 'click', function () { shiftWindow(-1); });
    on($('btn-later'), 'click', function () { shiftWindow(1); });
    on($('btn-latest'), 'click', jumpToLatest);
    // Reaching the top or bottom of the timeline loads the neighbouring events.
    var ticking = false;
    on($('workspace'), 'scroll', function () {
      if (ticking || !T.loaded || activeTab() !== 'traj') return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var box = $('workspace');
        updateLatestButton();
        if (box.scrollTop < 140 && T.start > 0) shiftWindow(-1);
        else if (box.scrollHeight - box.scrollTop - box.clientHeight < 140 && T.end < T.n) shiftWindow(1);
      });
    }, { passive: true });
    $('btn-play').addEventListener('click', function () { if (S.playing) stopPlay(); else startPlay(); });
    $('btn-fit').addEventListener('click', function () { fitView(true); });
    // Find an address: any part of it, a label, or the short form "0x1b23…2362"; Enter goes to the node
    var find = $('find-node'), findList = $('find-list');
    function findMatches(text) {
      var q = text.trim().toLowerCase().replace(/\s+/g, ''), out = [];
      if (!q) return out;
      var parts = q.split(/…|\.\.\./);
      viewAt(S.total).nodes.forEach(function (id) {
        var n = S.nodes.get(id), s = id.toLowerCase(), label = (n && n.label || '').toLowerCase();
        var hit = parts.length === 2 ? s.indexOf(parts[0]) === 0 && (!parts[1] || s.slice(-parts[1].length) === parts[1])
          : s.indexOf(q) >= 0 || (label && label.indexOf(q) >= 0);
        if (hit) out.push(id);
      });
      out.sort(function (a, b) { return (b.toLowerCase() === q) - (a.toLowerCase() === q); });
      return out;
    }
    function findGo() {
      var m = findMatches(find.value);
      if (!m.length) { toast('No address in the graph matches "' + find.value.trim() + '".', 4000); return; }
      focusNode(m[0], true);
      // zoom in on it when the whole graph is fitted and the node is a dot
      var ele = S.cy.getElementById(m[0]), z = Math.max(S.cy.zoom(), 1);
      if (ele.nonempty()) {
        var p = ele.position();
        S.cy.stop();
        S.cy.animate({ zoom: z, pan: { x: S.cy.width() / 2 - p.x * z, y: S.cy.height() / 2 - p.y * z } },
          { duration: REDUCED_MOTION ? 0 : 400 });
      }
      if (m.length > 1) toast(m.length + ' addresses match; showing ' + short(m[0]) + '. Type more of it to pick another.', 5000);
    }
    find.addEventListener('focus', function () {
      var ids = Array.from(viewAt(S.total).nodes);
      if (findList.childElementCount === ids.length) return;
      findList.textContent = '';
      ids.forEach(function (id) {
        var n = S.nodes.get(id), o = el('option', { value: id });
        if (n && n.label) o.textContent = n.label;
        findList.appendChild(o);
      });
    });
    find.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); findGo(); } });
    find.addEventListener('input', function (ev) {
      // picking from the suggestions list
      if ((!ev.inputType || ev.inputType === 'insertReplacementText') && S.nodes.has(lc(find.value))) findGo();
    });
    function groupButton() {
      var b = $('btn-group'), on = S.groupChains;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('title', on ? 'Show as one graph' : 'Group by chain');
      b.setAttribute('aria-label', on ? 'Show as one graph' : 'Group by chain');
      b.classList.toggle('on', on);
      b.hidden = NARROW;
    }
    groupButton();
    $('btn-group').addEventListener('click', function () {
      S.groupChains = !S.groupChains;
      try { localStorage.setItem('abf.groupChains2', S.groupChains ? '1' : '0'); } catch (e) { /* private mode */ }
      groupButton();
      layoutGraph(true, function () { fitView(true); });
    });
    // Full screen: the graph and its legend fill the screen (browser Fullscreen API), refitted; Esc leaves
    var col = document.querySelector('.graph-col');
    var full = $('btn-full');
    if (col && (col.requestFullscreen || col.webkitRequestFullscreen)) {
      full.hidden = false;
      full.addEventListener('click', function () {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
          var c = S.caseInfo || {};
          $('graph-caption').textContent = 'ABF-Agent · live trace of the Binance hot-wallet hack · ' +
            (c.updated_utc ? 'as of ' + fmtTime(c.updated_utc) + ' · ' : '') + location.host + location.pathname;
          (col.requestFullscreen || col.webkitRequestFullscreen).call(col);
        }
      });
      ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
        document.addEventListener(ev, function () {
          var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
          full.setAttribute('title', on ? 'Leave full screen' : 'Full screen');
          full.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
          setTimeout(function () { if (S.cy) { S.cy.resize(); fitView(false); } }, 80);
        });
      });
    }
    $('ws-cost').addEventListener('click', function () { var n = $('ws-cost-note'); n.hidden = !n.hidden || !n.textContent; this.setAttribute('aria-expanded', n.hidden ? 'false' : 'true'); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('report').open) select(null); });
    // Refit when the graph area changes size, unless the visitor has panned or zoomed.
    var t;
    var onResize = function () {
      clearTimeout(t);
      t = setTimeout(function () { if (!S.cy) return; S.cy.resize(); if (!S.userMoved) fitView(false); }, 120);
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe($('cy'));
    else window.addEventListener('resize', onResize);
  }

  function fail(text) {
    showMsg(text);
    document.body.setAttribute('data-ready', 'error');
  }

  function boot() {
    $('raw-link').setAttribute('href', DATA_URL);
    $('raw-link').textContent = DATA_URL.split('/').pop();
    if (typeof cytoscape === 'undefined') { fail('The graph library did not load. Check your connection and reload the page.'); return; }
    Promise.all([
      fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fontsReady()
    ]).then(function (res) {
      normalize(res[0]);
      var want = num(PARAMS.get('step'));
      S.step = want !== null ? Math.max(0, Math.min(S.total, want)) : S.total;
      // Fill everything around the graph first so the canvas is measured at its final size.
      safe('header', renderHeader);
      safe('coming soon', renderComingSoon);
      safe('legend', renderLegend);
      safe('workspace', renderWorkspace);
      safe('replay controls', buildTimelineControls);
      S.view = viewAt(S.step);
      safe('stats', function () { renderStats(S.view); });
      safe('replay label', function () { renderTimeline(S.view); });
      buildGraph();
      safe('controls', wireControls);
      safe('report form', wireReport);
      safe('flows table', function () { wireFlowTable(); renderFlowTable(); });
      apply(S.step, { fit: true });
      requestAnimationFrame(function () { fitView(false); safe('deep link', handleDeepLinks); });
      startPulse();
      safe('notes', renderNotes);
      safe('coverage', renderCoverage);
      safe('chains', renderChainOverview);
      if (!EMBED) { startLive(); loadTrajectory(); loadHighlights(); }
      // A screenshot frame skips the timeline but still shows the model cost from the small index.
      else fetchJson(TRAJ_INDEX_URL).then(function (idx) {
        T.cost = num(idx && idx.cost_usd);
        T.costNote = str(idx && idx.cost_note);
        safe('stats', function () { renderStats(S.view); });
      }, function () { /* no index: the stat stays "Not yet" */ });
      if (PARAMS.get('debug') === '1') window.__abf = { state: S, select: select, apply: apply, focusNode: focusNode, viewAt: viewAt, markNode: markNode, markLeads: markLeads, traj: T, setTab: setTab, showInTimeline: showInTimeline, poll: poll, live: LIVE, report: R, openReport: openReport, flowTarget: flowTarget, buildIssueUrl: buildIssueUrl, showNews: showNews };
      document.body.setAttribute('data-ready', '1');
    }).catch(function (err) {
      fail('Could not load ' + DATA_URL + ' (' + (err && err.message ? err.message : 'unknown error') + ').');
    });
  }

  boot();
})();
