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

  var PARAMS = new URLSearchParams(window.location.search);
  var EMBED = PARAMS.get('embed') === '1';
  var SPLIT_ASSETS = PARAMS.get('split') === 'asset';
  var DATA_URL = safeDataPath(PARAMS.get('data')) || 'data/graph.json';
  var POLL_MS = 3 * 60 * 1000;
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
    stop:     { name: 'Tracing stopped', color: '#a3a19a' },
    frozen:   { name: 'Frozen',          color: '#79d0e3' },
    resting:  { name: 'Not moved yet',   color: '#e8c25a' },
    open:     { name: 'Open lead',       color: '#ece6da' },
    unknown:  { name: 'Unclassified',    color: '#8b877e' }
  };
  var LEGEND_TEXT = { open: 'Open lead: funds arrived; where they went next is not traced yet' };
  var ROLE_ORDER = ['victim', 'attacker', 'pocket', 'stop', 'frozen', 'resting', 'open', 'unknown'];
  var TAG_FOR_ROLE = { frozen: 'Frozen', resting: 'Not moved yet', open: 'Open lead', stop: 'Tracing stopped' };

  var EXPLORERS = {
    ethereum:  { name: 'Etherscan',          base: 'https://etherscan.io' },
    arbitrum:  { name: 'Arbiscan',           base: 'https://arbiscan.io' },
    optimism:  { name: 'Optimism Etherscan', base: 'https://optimistic.etherscan.io' },
    avalanche: { name: 'Snowtrace',          base: 'https://snowtrace.io' },
    base:      { name: 'Basescan',           base: 'https://basescan.org' },
    bsc:       { name: 'BscScan',            base: 'https://bscscan.com' }
  };
  var EXPLORER_HOSTS = /(^|\.)(etherscan\.io|arbiscan\.io|snowtrace\.io|basescan\.org|bscscan\.com)$/;
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
    step: 0,
    view: null,
    cy: null,
    selected: null,        // { kind: 'node' | 'bundle', id }
    playing: false,
    playTimer: null,
    pulseTimer: null,
    userMoved: false
  };

  var $ = function (id) { return document.getElementById(id); };
  if (EMBED) document.body.classList.add('embed');

  // ---------- helpers ----------

  function safeDataPath(p) {
    if (!p) return null;
    return /^[\w\-./]+\.json$/.test(p) && p.indexOf('..') === -1 && p.charAt(0) !== '/' && p.indexOf('//') === -1 ? p : null;
  }
  function safeUrl(u) {
    try { var x = new URL(u); return x.protocol === 'https:' && EXPLORER_HOSTS.test(x.hostname) ? x.href : null; } catch (e) { return null; }
  }
  function lc(s) { return typeof s === 'string' ? s.trim().toLowerCase() : ''; }
  function str(s) { return typeof s === 'string' && s.trim() !== '' ? s.trim() : null; }
  function num(v) { return v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v; }
  function isAddr(s) { return /^0x[0-9a-f]{40}$/.test(s); }
  function isHash(s) { return /^0x[0-9a-fA-F]{64}$/.test(s); }
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
  function assetOrder(a, b) {
    var ea = /^w?eth$/i.test(a[0]) ? 0 : 1, eb = /^w?eth$/i.test(b[0]) ? 0 : 1;
    return ea - eb || b[1] - a[1];
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
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

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 1600);
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
      S.nodes.set(id, { id: id, chain: lc(n.chain) || defaultChain, label: str(n.label), role: ROLES[n.role] ? n.role : 'unknown', note: str(n.note) });
    });

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
        evidence: evidence
      };
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
        tier: e.tier === 'verified' ? 'verified' : 'unverified', // solid only when the export says so
        rejected: !!((op && op.verdict === 'INVALID') || (listed && listed.verdict === 'INVALID'))
      });
      S.touched.add(from);
      S.touched.add(to);
      [from, to].forEach(function (a) {
        if (!S.nodes.has(a)) S.nodes.set(a, { id: a, chain: defaultChain, label: null, role: 'unknown', note: null });
      });
    });

    var ws = data.workspace && typeof data.workspace === 'object' ? data.workspace : null;
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
        g = { id: 'g' + S.groups.length, from: e.from, to: e.to, asset: e.asset, tier: e.tier, edges: [] };
        gByKey.set(gk, g);
        S.groups.push(g);
        var bk = e.from + '|' + e.to + '|' + e.tier + (SPLIT_ASSETS ? '|' + e.asset : '');
        var b = bByKey.get(bk);
        if (!b) {
          b = { id: 'b' + S.bundles.length, from: e.from, to: e.to, tier: e.tier, groups: [] };
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

  function viewAt(N) {
    var groups = new Map(), bundles = new Map(), flows = 0, flowsNow = 0;
    S.groups.forEach(function (g) {
      var vis = g.edges.filter(function (e) { return e.step <= N; });
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
    // Labelled or non-open nodes say how many open leads the agent still holds on them.
    if (leads && (role !== 'open' || n.label)) lines.push(plural(leads, 'open lead'));
    return lines;
  }
  function nodeData(n, view) {
    var frontier = isFrontierAt(n, view);
    var role = frontier ? 'open' : n.role;
    var lines = nodeLines(n, view, role);
    var w = 0;
    lines.forEach(function (l) { w = Math.max(w, textWidth(l)); });
    return {
      label: lines.join('\n'),
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
    { selector: 'node.pulse', style: { 'underlay-opacity': 0.13 } },
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
      'transition-property': 'opacity', 'transition-duration': 0.55
    } },
    // Fan-in and fan-out edges carry their label near the spread-out end so labels don't pile up.
    { selector: 'edge.lbl-src', style: { 'label': '', 'source-label': 'data(label)', 'source-text-offset': 'data(off)' } },
    { selector: 'edge.lbl-tgt', style: { 'label': '', 'target-label': 'data(label)', 'target-text-offset': 'data(off)' } },
    // An exchange at one address draws as a loop above the node, sized to clear it.
    { selector: 'edge.loop', style: { 'loop-direction': '0deg', 'loop-sweep': '-50deg', 'control-point-step-size': 'data(loop)' } },
    { selector: 'edge.dashed', style: {
      'line-style': 'dashed', 'line-dash-pattern': [6, 5], 'line-color': C.edgeDashed,
      'target-arrow-color': C.edgeDashed, 'target-arrow-fill': 'hollow', 'color': C.ink2
    } },
    { selector: 'edge.hl', style: { 'line-color': C.ink2, 'target-arrow-color': C.ink2, 'z-index': 5 } },
    { selector: 'edge.sel', style: { 'line-color': C.signal, 'target-arrow-color': C.signal, 'color': C.ink, 'text-border-color': C.signal, 'z-index': 10 } },
    { selector: '.dim', style: { 'opacity': 0.16 } },
    { selector: '.entering', style: { 'opacity': 0 } },
    { selector: '.gone', style: { 'display': 'none' } }
  ];

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
      els.push({ group: 'nodes', data: Object.assign({ id: n.id }, nodeData(n, latest)), classes: 'r-' + n.role });
    });
    latest.bundles.forEach(function (bv) {
      var b = bv.bundle;
      var self = b.from === b.to;
      var loop = self ? Math.round(nodeData(S.nodes.get(b.from), latest).h / 2 + 46) : 40;
      els.push({ group: 'edges', data: Object.assign({ id: b.id, source: b.from, target: b.to, off: 90, loop: loop }, bundleData(bv)),
        classes: (b.tier === 'unverified' ? 'dashed' : '') + (self ? ' loop' : '') });
    });

    if (S.cy) S.cy.destroy();
    S.cy = cytoscape({
      container: $('cy'), elements: els, style: cyStyle,
      minZoom: 0.12, maxZoom: 2.5, boxSelectionEnabled: false, autounselectify: true
    });
    if (els.length) {
      S.cy.layout({
        name: typeof dagre !== 'undefined' ? 'dagre' : 'breadthfirst',
        rankDir: NARROW ? 'TB' : 'LR', nodeSep: NARROW ? 30 : 24, rankSep: NARROW ? 90 : 150, edgeSep: 14, ranker: 'network-simplex',
        directed: true, fit: false, animate: false
      }).run();
      placeEdgeLabels();
    }
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
        e.removeClass('lbl-src lbl-tgt');
        if (s.id() === t.id()) return;
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

  function bindGraphEvents() {
    var cy = S.cy;
    cy.on('tap', 'node', function (evt) { stopPlay(); select({ kind: 'node', id: evt.target.id() }); });
    cy.on('tap', 'edge', function (evt) { stopPlay(); select({ kind: 'bundle', id: evt.target.id() }); });
    cy.on('tap', function (evt) { if (evt.target === cy) select(null); });
    cy.on('mouseover', 'node', function (evt) { $('cy').style.cursor = 'pointer'; markLeads(evt.target.id(), true); });
    cy.on('mouseout', 'node', function (evt) { $('cy').style.cursor = ''; markLeads(evt.target.id(), false); });
    cy.on('mouseover', 'edge', function () { $('cy').style.cursor = 'pointer'; });
    cy.on('mouseout', 'edge', function () { $('cy').style.cursor = ''; });
    ['wheel', 'mousedown', 'touchstart'].forEach(function (t) {
      $('cy').addEventListener(t, function () { S.userMoved = true; }, { passive: true });
    });
  }

  // Two-way hover link between graph nodes and the open-leads list.
  function markLeads(addr, on) {
    (S.leadsByAddr.get(addr) || []).forEach(function (l) { l.items.forEach(function (li) { li.classList.toggle('hl', on); }); });
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
    if (animate && !REDUCED_MOTION) {
      S.cy.animate({ fit: { eles: eles, padding: pad } }, { duration: 600, easing: 'ease-in-out-cubic' });
    } else {
      S.cy.fit(eles, pad);
      if (S.cy.zoom() > 1.35) { S.cy.zoom(1.35); S.cy.center(eles); }
    }
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
      cy.nodes().forEach(function (ele) {
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
      var still = S.selected.kind === 'node' ? view.nodes.has(S.selected.id) : view.bundles.has(S.selected.id);
      if (!still) S.selected = null;
    }
    applySelection();
    renderStats(view);
    renderTimeline(view);
    renderDetail();
    if (opts.fit !== false && (entering.length || !opts.animate)) fitView(!!opts.animate);
    showMsg(view.groups.size ? '' : 'No flows traced yet.');
    return entering.length;
  }

  // ---------- selection ----------

  function select(sel) {
    S.selected = sel;
    applySelection();
    renderDetail();
    if (sel && window.matchMedia('(max-width: 999px)').matches && !EMBED) {
      $('detail').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function applySelection() {
    var cy = S.cy;
    if (!cy) return;
    cy.batch(function () {
      cy.elements().removeClass('dim sel hl');
      if (!S.selected) return;
      var ele = cy.getElementById(S.selected.id);
      if (!ele || ele.empty() || ele.hasClass('gone')) return;
      var keep;
      if (S.selected.kind === 'node') {
        var edges = ele.connectedEdges().not('.gone');
        edges.addClass('hl');
        keep = ele.union(edges).union(edges.connectedNodes());
      } else keep = ele.union(ele.connectedNodes());
      ele.addClass('sel');
      cy.elements().not('.gone').difference(keep).addClass('dim');
    });
  }

  function focusNode(id, scroll) {
    if (!id) return;
    if (!S.view.nodes.has(id)) {
      if (!viewAt(S.total).nodes.has(id)) return;
      stopPlay();
      apply(S.total, { fit: false });
    }
    if (scroll) $('graph-anchor').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
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
    document.title = title + ' | Live trace';
    $('watermark').hidden = !/mock/i.test(title);
    $('chain-name').textContent = cap(lc(c.chain) || 'ethereum');

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
    function countCell(label, value) {
      return el('div', { class: 'stat small' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, el('span', null, String(value))));
    }
    append(box, [
      amountCell('wide', 'Taken from victims', ROLES.victim.color, byRole('victim', view.outflow), 4),
      amountCell('', 'Not moved yet', ROLES.resting.color, byRole('resting', view.inflow), 2),
      amountCell('', 'Frozen', ROLES.frozen.color, byRole('frozen', view.inflow), 2),
      amountCell('', 'Tracing stopped', ROLES.stop.color, byRole('stop', view.inflow), 2),
      countCell('Flows traced', view.flows),
      countCell('Addresses', view.nodes.size)
    ]);
  }

  function renderLegend() {
    var box = $('legend');
    clear(box);
    var present = new Set();
    viewAt(S.total).nodes.forEach(function (id) { present.add(S.nodes.get(id).role); });
    if (S.eventSteps.length) present.add('open'); // the replay draws earlier frontiers as open leads
    ROLE_ORDER.forEach(function (r) {
      if (present.has(r)) box.appendChild(el('span', { class: 'item' }, el('span', { class: 'node-swatch ' + r, style: '--c:' + ROLES[r].color }), LEGEND_TEXT[r] || ROLES[r].name));
    });
    box.appendChild(el('span', { class: 'lines' },
      el('span', { class: 'item' }, el('span', { class: 'line-swatch' }), 'Checked by the verifier'),
      el('span', { class: 'item' }, el('span', { class: 'line-swatch dashed' }), 'Agent claim the checker could not evaluate yet')));
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
    if (S.step >= S.total) apply(0, { animate: true });
    var tick = function () {
      if (!S.playing) return;
      if (S.step >= S.total) { stopPlay(); return; }
      var added = apply(S.step + 1, { animate: true });
      var wait = added ? PLAY_EVENT_MS : PLAY_IDLE_MS;
      // Linger briefly before a step that adds flows, so the change reads as one move.
      if (!added && nextEventAfter(S.step) === S.step + 1) wait = PLAY_IDLE_MS * 2;
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
      if (on) S.cy.nodes('.r-open, .frontier').not('.gone').addClass('pulse');
      else S.cy.nodes('.pulse').removeClass('pulse');
    }, 1200);
  }

  // ---------- findings: rejected log and coming soon ----------

  function renderRejected() {
    var list = $('rejected');
    clear(list);
    var ops = [];
    S.ops.forEach(function (o) { if (o.verdict === 'INVALID') ops.push(o); });
    $('rejected-count').textContent = String(ops.length);
    if (!ops.length) { list.appendChild(el('li', null, el('span', { class: 'empty' }, 'None so far.'))); return; }
    ops.sort(function (a, b) { return (a.step || 0) - (b.step || 0); });
    ops.forEach(function (o) {
      var edges = S.edges.filter(function (e) { return e.op === o || o.edge_ids.indexOf(e.id) !== -1; });
      list.appendChild(el('li', null,
        el('div', { class: 'rej-head' }, el('span', { class: 'badge bad' }, 'Invalid'), prettyType(o.type), o.step !== null ? '· step ' + o.step : null),
        o.claim ? el('p', { class: 'rej-claim' }, o.claim) : null,
        edges.map(function (e) {
          return el('div', { class: 'rej-edge' },
            short(e.from) + ' to ' + short(e.to) + ' · ' + fmt(e.amount) + ' ' + e.asset + ' · ',
            txLink(e.tx, (S.nodes.get(e.from) || {}).chain));
        })));
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
    $('ws-note').textContent = W.note || 'The agent’s own working state. Internal and unchecked; the findings above are what it reports.';
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
    if (S.selected.kind === 'node') renderNodeDetail(box, S.nodes.get(S.selected.id));
    else renderBundleDetail(box, S.bundleById.get(S.selected.id));
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
      addrLink(n.id, n.chain),
      n.note ? el('p', { class: 'd-note', style: '--c:' + ROLES[n.role].color }, n.note) : null,
      frontier ? el('p', { class: 'd-note' }, 'At step ' + view.N + ', where these funds went next was not traced yet.') : null
    ]);

    var kv = el('dl', { class: 'kv' });
    var inT = totalsText(view.inflow.get(n.id)), outT = totalsText(view.outflow.get(n.id));
    if (inT) append(kv, [el('dt', null, 'Received'), el('dd', { class: 'mono' }, inT)]);
    if (outT) append(kv, [el('dt', null, 'Sent'), el('dd', { class: 'mono' }, outT)]);
    append(kv, [el('dt', null, 'Chain'), el('dd', null, cap(n.chain))]);
    if (leads.length) append(kv, [el('dt', null, 'Open leads'), el('dd', null,
      el('button', { type: 'button', class: 'linkish', onclick: function () {
        $('workspace').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
        markLeads(n.id, true);
        setTimeout(function () { markLeads(n.id, false); }, 2400);
      } }, plural(leads.length, 'entry', 'entries') + ' in the agent workspace'))]);
    box.appendChild(kv);

    var incoming = [], outgoing = [];
    view.groups.forEach(function (gv) {
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
    return el('article', { class: 'chain' },
      el('div', { class: 'chain-what' }, el('span', { class: 'chain-label' }, 'What moved'), el('span', { class: 'chain-amt' }, fmtExact(e.amountStr) + ' ' + e.asset)),
      el('div', { class: 'hops' }, hop('From', from, e.srcPos), hop('To', to, e.tgtPos)),
      el('dl', { class: 'kv' },
        el('dt', null, 'Operation'), el('dd', null, prettyType(e.op ? e.op.type : null)),
        el('dt', null, 'Recorded'), el('dd', null, e.seed ? 'Case start' : 'Step ' + e.step),
        el('dt', null, 'Tx'), el('dd', { class: 'mono' }, txLink(e.tx, chain)),
        e.block !== null ? [el('dt', null, 'Block'), el('dd', { class: 'mono' }, String(e.block))] : null,
        e.time ? [el('dt', null, 'Time'), el('dd', { class: 'mono' }, fmtTime(e.time, true))] : null),
      el('p', { class: 'verdict ' + (checked ? 'ok' : 'wait') }, checked ? 'Checked: the cited records show this transfer' : 'Not yet checked'),
      links.length ? el('div', { class: 'evidence' }, el('span', { class: 'chain-label' }, 'Evidence'),
        el('div', { class: 'ev-links' }, links.map(function (l) { return extLink(l.url, l.name, 'ev'); }))) : null);
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

  // ---------- new exports ----------

  function poll() {
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.case && d.case.updated_utc && d.case.updated_utc !== S.caseInfo.updated_utc) $('btn-new').hidden = false;
      })
      .catch(function () { /* offline; try again next round */ });
  }

  // ---------- boot ----------

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = Promise.all([document.fonts.load('500 11px "JetBrains Mono"'), document.fonts.load('400 30px "Instrument Serif"')]).catch(function () {});
    return Promise.race([loads, new Promise(function (r) { setTimeout(r, 2500); })]);
  }

  function wireControls() {
    $('slider').addEventListener('input', function (ev) { stopPlay(); apply(+ev.target.value, { animate: true }); });
    $('btn-play').addEventListener('click', function () { if (S.playing) stopPlay(); else startPlay(); });
    $('btn-fit').addEventListener('click', function () { fitView(true); });
    $('btn-new').addEventListener('click', function () { window.location.reload(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') select(null); });
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
    $('case-title').textContent = 'Live trace';
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
      renderHeader();
      renderComingSoon();
      renderRejected();
      renderLegend();
      renderWorkspace();
      buildTimelineControls();
      S.view = viewAt(S.step);
      renderStats(S.view);
      renderTimeline(S.view);
      buildGraph();
      wireControls();
      apply(S.step, { fit: true });
      requestAnimationFrame(function () { fitView(false); });
      startPulse();
      if (!EMBED) setInterval(poll, POLL_MS);
      if (PARAMS.get('debug') === '1') window.__abf = { state: S, select: select, apply: apply, focusNode: focusNode, viewAt: viewAt, markNode: markNode, markLeads: markLeads };
      document.body.setAttribute('data-ready', '1');
    }).catch(function (err) {
      fail('Could not load ' + DATA_URL + ' (' + (err && err.message ? err.message : 'unknown error') + ').');
    });
  }

  boot();
})();
