/* fetch-map.js — pull a real road network from OpenStreetMap (Overpass) and turn it
 * into Wayfarer's graph format. Run:  node scripts/fetch-map.js
 *
 * Output: data/pune.json  (nodes, edges-with-geometry, water, parks, labels).
 * Traffic congestion is SIMULATED (no free live-traffic source); signal LOCATIONS
 * are real (OSM highway=traffic_signals). Roads are treated as bidirectional in v1.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CENTER = [18.5018, 73.8115];        // Kothrud / Karve Nagar, Pune
const RADIUS = 5000;                       // meters
const CITY = "Kothrud / Karve Nagar, Pune";
const OUT = path.join(__dirname, "..", "data", "pune.json");

const HW = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";
const HWSET = new Set(HW.replace(/[\^$()]/g, "").split("|"));

const query = `
[out:json][timeout:180];
(
  way["highway"~"${HW}"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["natural"="water"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["waterway"="riverbank"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["leisure"="park"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["landuse"~"^(grass|forest|recreation_ground|meadow|village_green)$"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["natural"="wood"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  node["highway"="traffic_signals"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  node["place"~"^(suburb|neighbourhood|quarter|village|town|locality)$"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
  way["place"~"^(suburb|neighbourhood|quarter|village|town|locality)$"](around:${RADIUS},${CENTER[0]},${CENTER[1]});
);
out body;
>;
out skel qt;
`;

const r1 = (v) => Math.round(v * 10) / 10;
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function classify(hw) {
  if (/^(motorway|trunk|primary)/.test(hw)) return "avenue";
  if (/^(secondary|tertiary)/.test(hw)) return "arterial";
  return "street";
}
function speedOf(tags, cls) {
  const m = tags.maxspeed && String(tags.maxspeed).match(/\d+/);
  if (m) { let v = +m[0]; if (/mph/i.test(tags.maxspeed)) v = Math.round(v * 1.609); return v; }
  return cls === "avenue" ? 60 : cls === "arterial" ? 45 : 30;
}

async function main() {
  console.log(`Fetching OSM data for ${CITY} (r=${RADIUS}m)...`);
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "Wayfarer/1.0 (map routing side-project)",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  const data = await res.json();
  console.log(`  ${data.elements.length} raw elements`);

  const coord = new Map(), tags = new Map();
  for (const el of data.elements) {
    if (el.type === "node") { coord.set(el.id, [el.lat, el.lon]); if (el.tags) tags.set(el.id, el.tags); }
  }
  const [lat0, lon0] = CENTER;
  const mLat = 111320, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const proj = (lat, lon) => [(lon - lon0) * mLon, (lat0 - lat) * mLat]; // origin at center, north up
  const inRange = (osmId) => { const c = coord.get(osmId); if (!c) return false; const [x, y] = proj(c[0], c[1]); return Math.hypot(x, y) <= RADIUS; };
  const xyInRange = (x, y) => Math.hypot(x, y) <= RADIUS;

  const hwWays = data.elements.filter((e) => e.type === "way" && e.tags && e.tags.highway && HWSET.has(e.tags.highway));
  const signalSet = new Set();
  for (const [id, t] of tags) if (t.highway === "traffic_signals") signalSet.add(id);

  const use = new Map();
  for (const w of hwWays) for (const nid of w.nodes) use.set(nid, (use.get(nid) || 0) + 1);

  const rng = lcg(12345);
  const idMap = new Map();
  let nodes = [];
  const vId = (osmId) => {
    if (idMap.has(osmId)) return idMap.get(osmId);
    const [la, lo] = coord.get(osmId);
    const [x, y] = proj(la, lo);
    const nd = { id: nodes.length, x, y, hasSignal: signalSet.has(osmId), signalWait: 0, signal: null };
    if (nd.hasSignal) {
      nd.signalWait = Math.round(12 + rng() * 33);
      nd.signal = { period: r1(55 + rng() * 35), greenFrac: r1(0.45 + rng() * 0.15), phase: r1(rng() * 90) };
    }
    idMap.set(osmId, nd.id);
    nodes.push(nd);
    return nd.id;
  };
  const isVertex = (w, i, nid) => i === 0 || i === w.nodes.length - 1 || use.get(nid) > 1 || signalSet.has(nid);

  const edges = [];
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const roadNames = new Map(); // name -> representative [x,y] (pre-shift)
  let onewayCount = 0;
  for (const w of hwWays) {
    const cls = classify(w.tags.highway), spd = speedOf(w.tags, cls);
    if (w.tags.name && !roadNames.has(w.tags.name)) {
      const midN = w.nodes[(w.nodes.length / 2) | 0];
      if (inRange(midN)) { const [la, lo] = coord.get(midN); roadNames.set(w.tags.name, proj(la, lo)); }
    }
    // Direction: 0 = two-way, 1 = along the way (a->b), -1 = against it.
    const ow = String(w.tags.oneway || "").toLowerCase();
    const round = w.tags.junction === "roundabout" || w.tags.junction === "circular";
    let dir = 0;
    if (round || ow === "yes" || ow === "true" || ow === "1") dir = 1;
    else if (ow === "-1" || ow === "reverse") dir = -1;
    let startIdx = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const nid = w.nodes[i];
      if (!isVertex(w, i, nid)) continue;
      const seg = w.nodes.slice(startIdx, i + 1).filter((n) => coord.has(n));
      startIdx = i;
      if (seg.length < 2) continue;
      if (!inRange(seg[0]) || !inRange(seg[seg.length - 1])) continue; // clip to radius
      let geom = seg.map((n) => { const [la, lo] = coord.get(n); const [x, y] = proj(la, lo); return [x, y]; });
      let len = 0; for (let k = 1; k < geom.length; k++) len += dist(geom[k - 1], geom[k]);
      let a = vId(seg[0]), b = vId(seg[seg.length - 1]);
      if (a === b || len < 1) continue;
      let oneway = dir !== 0;
      if (dir === -1) { geom.reverse(); const t = a; a = b; b = t; } // normalize so oneway means a->b
      if (oneway) onewayCount++;
      edges.push({ a, b, geometry: geom, length: len, roadClass: cls, speedLimit: spd, oneway });
    }
  }

  // Drop isolated nodes (kept none of their edges) and remap ids to be contiguous.
  const usedIds = new Set();
  for (const e of edges) { usedIds.add(e.a); usedIds.add(e.b); }
  const remap = new Map();
  const compact = [];
  for (const n of nodes) {
    if (!usedIds.has(n.id)) continue;
    remap.set(n.id, compact.length); n.id = compact.length; compact.push(n);
  }
  for (const e of edges) { e.a = remap.get(e.a); e.b = remap.get(e.b); }
  nodes = compact;

  // Simulated congestion: heavier on big roads and nearer the center.
  const crng = lcg(6789);
  for (const e of edges) {
    const mid = e.geometry[(e.geometry.length / 2) | 0];
    const d = Math.min(Math.hypot(mid[0], mid[1]) / RADIUS, 1);
    const base = e.roadClass === "avenue" ? 0.4 : e.roadClass === "arterial" ? 0.32 : 0.24;
    let c = base + (1 - d) * 0.22 + (crng() - 0.5) * 0.3;
    e.baseCongestion = e.congestion = Math.max(0, Math.min(0.88, r1(c) === 0 ? c : c));
  }

  // Water / green polygons (closed ways only).
  const water = [], parks = [], labels = [];
  const closedPoly = (w) => {
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) return null;
    const poly = w.nodes.map((n) => coord.get(n)).filter(Boolean).map(([la, lo]) => proj(la, lo));
    return poly.length >= 4 ? poly : null;
  };
  const centroid = (p) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  for (const w of data.elements) {
    if (w.type !== "way" || !w.tags) continue;
    const t = w.tags;
    if (t.natural === "water" || t.waterway === "riverbank") {
      const p = closedPoly(w); if (!p) continue;
      const [cx, cy] = centroid(p); if (!xyInRange(cx, cy)) continue;
      water.push({ polygon: p });
    } else if (t.leisure === "park" || /^(grass|forest|recreation_ground|meadow|village_green)$/.test(t.landuse || "") || t.natural === "wood") {
      const p = closedPoly(w); if (!p) continue;
      const [cx, cy] = centroid(p); if (!xyInRange(cx, cy)) continue;
      parks.push({ polygon: p, name: t.name || "", cx, cy });
      if (t.name && t.leisure === "park") labels.push({ x: cx, y: cy, text: t.name, kind: "park", angle: 0 });
    }
  }
  const labelSeen = new Set();
  for (const [id, t] of tags) {
    if (t.place && t.name && coord.has(id)) {
      const [la, lo] = coord.get(id); const [x, y] = proj(la, lo);
      if (!xyInRange(x, y)) continue;
      if (labelSeen.has(t.name)) continue; labelSeen.add(t.name);
      labels.push({ x, y, text: t.name, kind: "district", angle: 0 });
    }
  }
  // Place areas (ways) — many Indian localities (e.g. Kothrud) are mapped as areas, not points.
  for (const w of data.elements) {
    if (w.type !== "way" || !w.tags || !w.tags.place || !w.tags.name) continue;
    if (labelSeen.has(w.tags.name)) continue;
    const pts = w.nodes.map((n) => coord.get(n)).filter(Boolean);
    if (pts.length < 2) continue;
    const clat = pts.reduce((s, c) => s + c[0], 0) / pts.length;
    const clon = pts.reduce((s, c) => s + c[1], 0) / pts.length;
    const [x, y] = proj(clat, clon);
    if (!xyInRange(x, y)) continue;
    labelSeen.add(w.tags.name);
    labels.push({ x, y, text: w.tags.name, kind: "district", angle: 0 });
  }

  // Shift everything so min corner is (0,0); compute size/bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const n of nodes) scan(n.x, n.y);
  for (const e of edges) for (const g of e.geometry) scan(g[0], g[1]);
  for (const w of water) for (const g of w.polygon) scan(g[0], g[1]);
  for (const p of parks) for (const g of p.polygon) scan(g[0], g[1]);
  const shift = (x, y) => [r1(x - minX), r1(y - minY)];
  for (const n of nodes) { const [x, y] = shift(n.x, n.y); n.x = x; n.y = y; }
  for (const e of edges) e.geometry = e.geometry.map((g) => shift(g[0], g[1]));
  for (const w of water) w.polygon = w.polygon.map((g) => shift(g[0], g[1]));
  for (const p of parks) { p.polygon = p.polygon.map((g) => shift(g[0], g[1])); const [cx, cy] = shift(p.cx, p.cy); p.cx = cx; p.cy = cy; }
  for (const l of labels) { const [x, y] = shift(l.x, l.y); l.x = x; l.y = y; }
  for (const [k, v] of roadNames) roadNames.set(k, shift(v[0], v[1]));
  for (const e of edges) e.length = r1(e.length);

  // Searchable places: localities + parks (from labels) + named roads.
  const searchPlaces = [];
  const seenS = new Set();
  const addS = (name, x, y) => { if (!name) return; const k = name.toLowerCase(); if (seenS.has(k)) return; seenS.add(k); searchPlaces.push({ name, x, y }); };
  for (const l of labels) addS(l.text, l.x, l.y);
  for (const [name, pt] of roadNames) addS(name, pt[0], pt[1]);

  const width = r1(maxX - minX), height = r1(maxY - minY);
  const out = {
    meta: { city: CITY, center: CENTER, radius: RADIUS, generated: new Date().toISOString() },
    size: Math.max(width, height),
    bounds: { minX: 0, minY: 0, maxX: width, maxY: height },
    nodes, edges, water, parks, labels, search: searchPlaces,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
  console.log(`Done: ${nodes.length} nodes, ${edges.length} edges, ${water.length} water, ${parks.length} parks, ${labels.length} labels, ${searchPlaces.length} searchable places`);
  console.log(`  signals: ${nodes.filter((n) => n.hasSignal).length},  one-way roads: ${onewayCount},  area: ${(width / 1000).toFixed(2)}x${(height / 1000).toFixed(2)} km,  file: ${mb} MB`);
  console.log(`  -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
