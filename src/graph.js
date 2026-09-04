/* graph.js — dummy city map generation + graph model
 * Produces a Google-Maps-style world: a road network plus land features
 * (water, parks, building blocks, labels). World units are METERS.
 */
(function (WF) {
  "use strict";

  // Deterministic RNG (mulberry32) so a seed always rebuilds the same city.
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const KMH_TO_MS = 1000 / 3600;

  function effectiveSpeed(edge) {
    const free = edge.speedLimit * KMH_TO_MS;
    return Math.max(free * (1 - 0.7 * edge.congestion), 5 * KMH_TO_MS);
  }
  function freeSpeed(edge) { return edge.speedLimit * KMH_TO_MS; }
  function edgeTravelTime(edge) { return edge.length / effectiveSpeed(edge); }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Animated signal phase -> "green" | "yellow" | "red" | "none"
  function signalState(node, t) {
    if (!node.hasSignal || !node.signal) return "none";
    const { period, greenFrac, phase } = node.signal;
    const local = (((t + phase) % period) + period) % period;
    const green = period * greenFrac;
    if (local < green) return "green";
    if (local < green + 3) return "yellow";
    return "red";
  }

  // Offset a polyline to both sides to make a filled band polygon (used for rivers).
  function bandPolygon(centerline, width) {
    const half = width / 2;
    const left = [], right = [];
    for (let i = 0; i < centerline.length; i++) {
      const prev = centerline[Math.max(0, i - 1)];
      const next = centerline[Math.min(centerline.length - 1, i + 1)];
      let dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy, ny = dx; // perpendicular
      const c = centerline[i];
      left.push({ x: c.x + nx * half, y: c.y + ny * half });
      right.push({ x: c.x - nx * half, y: c.y - ny * half });
    }
    return left.concat(right.reverse());
  }

  const NAMES = {
    district: ["Old Town", "Riverside", "Market Ward", "North End", "Garden District",
               "Millbrook", "Kingsway", "Elmgrove", "Southgate", "Harbor", "Bishopsgate"],
    street: ["Main St", "King Ave", "River Rd", "Park Ave", "Market St",
             "Station Rd", "High St", "Elm Ave", "West Blvd", "Harbor Way", "Grand Ave"],
    park: ["Central Park", "Riverside Park", "Greenwood", "Memorial Gardens", "Kings Park"],
    river: ["Kanda River", "Blue River", "Old Canal", "Meridian River"],
  };

  function generateCity(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : (Math.random() * 1e9) | 0;
    const size = opts.size || 5000;
    const cols = opts.cols || 13;
    const rows = opts.rows || 13;
    const missingRoadChance = opts.missingRoadChance != null ? opts.missingRoadChance : 0.12;
    const avenueEvery = opts.avenueEvery || 3;
    const rng = makeRng(seed);
    const pick = (arr) => arr[(rng() * arr.length) | 0];

    const margin = size * 0.05;
    const usable = size - margin * 2;
    const spacingX = usable / (cols - 1);
    const spacingY = usable / (rows - 1);
    const jitter = Math.min(spacingX, spacingY) * 0.16;
    const isAvenue = (i) => i % avenueEvery === 0;

    // --- Nodes
    const nodes = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        nodes.push({
          id: r * cols + c, r, c,
          x: margin + c * spacingX + (rng() - 0.5) * 2 * jitter,
          y: margin + r * spacingY + (rng() - 0.5) * 2 * jitter,
          onAvenue: isAvenue(r) || isAvenue(c),
          hasSignal: false, signalWait: 0, signal: null,
        });
      }
    }
    const nodeAt = (c, r) => nodes[r * cols + c];
    const center = { x: size / 2, y: size / 2 };

    // --- River: wavy vertical band on the right, plus building blocks & parks.
    const riverX = size * (0.74 + rng() * 0.1);
    const riverCenter = [];
    const seg = 14;
    for (let i = 0; i <= seg; i++) {
      riverCenter.push({
        x: riverX + Math.sin(i * 0.7 + seed) * size * 0.03,
        y: (size * i) / seg,
      });
    }
    const water = [{ polygon: bandPolygon(riverCenter, size * 0.05) }];

    // --- Candidate edges (grid: right + down neighbours)
    const candidates = [];
    const addCandidate = (n1, n2) => {
      const bothAve = n1.onAvenue && n2.onAvenue;
      const eitherAve = n1.onAvenue || n2.onAvenue;
      const mid = { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 };
      const distToCenter = distance(mid, center) / (size / 2);
      let congestion = 0.15 + rng() * 0.35 + (1 - Math.min(distToCenter, 1)) * 0.3;
      if (eitherAve) congestion += 0.15;
      congestion = Math.max(0, Math.min(0.9, congestion));
      candidates.push({
        id: candidates.length, a: n1.id, b: n2.id, length: distance(n1, n2),
        geometry: [{ x: n1.x, y: n1.y }, { x: n2.x, y: n2.y }],
        roadClass: bothAve ? "avenue" : eitherAve ? "arterial" : "street",
        speedLimit: bothAve ? 60 : eitherAve ? 45 : 35,
        baseCongestion: congestion, congestion,
      });
    };
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1) addCandidate(nodeAt(c, r), nodeAt(c + 1, r));
        if (r < rows - 1) addCandidate(nodeAt(c, r), nodeAt(c, r + 1));
      }

    // Randomly drop side streets, but never if it disconnects the map.
    const edges = candidates.filter((e) => {
      if (e.roadClass === "avenue") return true;
      if (rng() >= missingRoadChance) return true;
      return !removalDisconnects(nodes, candidates, e);
    });

    const adjacency = buildAdjacency(nodes, edges);

    // --- Traffic signals on busy intersections (average wait + animated cycle).
    for (const node of nodes) {
      const degree = adjacency[node.id].length;
      if (degree >= 3 && (node.onAvenue || rng() < 0.12)) {
        node.hasSignal = true;
        node.signalWait = Math.round(12 + rng() * 33);
        node.signal = { period: 55 + rng() * 35, greenFrac: 0.45 + rng() * 0.15, phase: rng() * 90 };
      }
    }

    // --- Building blocks: each grid cell, inset so roads show through the gaps.
    const blocks = [];
    const inset = 0.11;
    for (let r = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) {
        const corners = [nodeAt(c, r), nodeAt(c + 1, r), nodeAt(c + 1, r + 1), nodeAt(c, r + 1)];
        const cx = corners.reduce((s, n) => s + n.x, 0) / 4;
        const cy = corners.reduce((s, n) => s + n.y, 0) / 4;
        blocks.push({
          polygon: corners.map((n) => ({ x: n.x + (cx - n.x) * inset, y: n.y + (cy - n.y) * inset })),
        });
      }

    // --- Parks: a couple of superblocks turned green (kept off the river).
    const parks = [];
    const makePark = (c0, r0, dc, dr, name) => {
      c0 = Math.max(0, Math.min(cols - 1 - dc, c0));
      r0 = Math.max(0, Math.min(rows - 1 - dr, r0));
      const poly = [nodeAt(c0, r0), nodeAt(c0 + dc, r0), nodeAt(c0 + dc, r0 + dr), nodeAt(c0, r0 + dr)]
        .map((n) => ({ x: n.x, y: n.y }));
      const gx = poly.reduce((s, p) => s + p.x, 0) / 4;
      const gy = poly.reduce((s, p) => s + p.y, 0) / 4;
      parks.push({ polygon: poly, name, cx: gx, cy: gy });
    };
    makePark(1, 1 + ((rng() * 2) | 0), 2, 2, pick(NAMES.park));
    makePark(2 + ((rng() * 3) | 0), rows - 4, 2, 2, pick(NAMES.park));

    // --- Labels: districts, a few street names, parks, river.
    const labels = [];
    const nearAnyLabel = (x, y, min) => labels.some((l) => Math.hypot(l.x - x, l.y - y) < min);
    const inAnyPark = (x, y) => parks.some((p) => Math.hypot(p.cx - x, p.cy - y) < size * 0.16);
    const usedDistrict = new Set();
    let tries = 0;
    while (usedDistrict.size < 5 && tries++ < 40) {
      const c = 1 + ((rng() * (cols - 2)) | 0);
      const r = 1 + ((rng() * (rows - 2)) | 0);
      const n = nodeAt(c, r);
      if (n.x > riverX - size * 0.05) continue;          // off the water
      if (inAnyPark(n.x, n.y)) continue;                 // off the parks
      if (nearAnyLabel(n.x, n.y, size * 0.14)) continue; // not on top of another label
      let name = pick(NAMES.district);
      if (usedDistrict.has(name)) continue;
      usedDistrict.add(name);
      labels.push({ x: n.x, y: n.y, text: name, kind: "district", angle: 0 });
    }
    // Street names along a couple of avenues.
    const aveRows = []; for (let r = 0; r < rows; r++) if (isAvenue(r)) aveRows.push(r);
    const aveCols = []; for (let c = 0; c < cols; c++) if (isAvenue(c)) aveCols.push(c);
    const usedStreet = new Set();
    const streetName = () => { let s; do { s = pick(NAMES.street); } while (usedStreet.has(s) && usedStreet.size < NAMES.street.length); usedStreet.add(s); return s; };
    if (aveRows.length) { const r = aveRows[(aveRows.length / 2) | 0]; const n = nodeAt((cols / 2) | 0, r); labels.push({ x: n.x, y: n.y, text: streetName(), kind: "street", angle: 0 }); }
    if (aveCols.length) { const c = aveCols[(aveCols.length / 2) | 0]; const n = nodeAt(c, (rows / 2) | 0); labels.push({ x: n.x, y: n.y, text: streetName(), kind: "street", angle: -90 }); }
    for (const p of parks) labels.push({ x: p.cx, y: p.cy, text: p.name, kind: "park", angle: 0 });
    labels.push({ x: riverX + size * 0.01, y: size * 0.62, text: pick(NAMES.river), kind: "water", angle: -78 });

    return {
      seed, size, cols, rows, nodes, edges, adjacency,
      water, parks, blocks, labels,
      bounds: { minX: 0, minY: 0, maxX: size, maxY: size },
    };
  }

  function removalDisconnects(nodes, candidates, omit) {
    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of candidates) {
      if (e === omit) continue;
      adj.get(e.a).push(e.b); adj.get(e.b).push(e.a);
    }
    const seen = new Set([nodes[0].id]);
    const stack = [nodes[0].id];
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
    return seen.size !== nodes.length;
  }

  function buildAdjacency(nodes, edges) {
    const adjacency = {};
    for (const n of nodes) adjacency[n.id] = [];
    for (const e of edges) {
      adjacency[e.a].push({ to: e.b, edge: e });
      adjacency[e.b].push({ to: e.a, edge: e });
    }
    return adjacency;
  }

  function randomizeTraffic(graph, seed) {
    const rng = makeRng(seed != null ? seed : (Math.random() * 1e9) | 0);
    for (const e of graph.edges) {
      e.congestion = Math.max(0, Math.min(0.95, e.baseCongestion + (rng() - 0.5) * 0.5));
    }
    return graph;
  }

  // Continuously drift each road's congestion (mean-reverting random walk toward its
  // base level). Called each animation frame so jams form and clear over time — which
  // is what makes live re-routing meaningful.
  function evolveTraffic(graph, dt) {
    const revert = 0.12, vol = 0.5, sq = Math.sqrt(Math.min(dt, 0.1));
    for (const e of graph.edges) {
      const c = e.congestion + (e.baseCongestion - e.congestion) * revert * dt + (Math.random() - 0.5) * vol * sq;
      e.congestion = c < 0 ? 0 : c > 0.95 ? 0.95 : c;
    }
  }

  // --- Geometry helpers (edges are polylines: geometry = [{x,y}, ...]).
  function edgeCum(edge) {
    if (edge._cum) return edge._cum;
    const g = edge.geometry, cum = [0];
    for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + Math.hypot(g[i].x - g[i - 1].x, g[i].y - g[i - 1].y));
    edge._cum = cum;
    return cum;
  }
  // Point + unit tangent at a distance along an edge's geometry.
  function pointAlongEdge(edge, dist) {
    const g = edge.geometry, cum = edgeCum(edge);
    const total = cum[cum.length - 1] || 1;
    dist = Math.max(0, Math.min(dist, total));
    let i = 1;
    while (i < cum.length && cum[i] < dist) i++;
    const i0 = i - 1, i1 = Math.min(i, g.length - 1);
    const segLen = (cum[i1] - cum[i0]) || 1;
    const f = (dist - cum[i0]) / segLen;
    let tx = g[i1].x - g[i0].x, ty = g[i1].y - g[i0].y;
    const tl = Math.hypot(tx, ty) || 1;
    return { x: g[i0].x + tx * f, y: g[i0].y + ty * f, tx: tx / tl, ty: ty / tl };
  }

  // Load a pre-built real-city graph (from scripts/fetch-map.js output).
  function loadCity(json) {
    const nodes = json.nodes.map((n) => ({
      id: n.id, x: n.x, y: n.y,
      hasSignal: !!n.hasSignal, signalWait: n.signalWait || 0, signal: n.signal || null,
    }));
    const edges = json.edges.map((e, i) => ({
      id: i, a: e.a, b: e.b,
      geometry: e.geometry.map((p) => ({ x: p[0], y: p[1] })),
      length: e.length,
      roadClass: e.roadClass, speedLimit: e.speedLimit, oneway: !!e.oneway,
      baseCongestion: e.baseCongestion, congestion: e.congestion,
    }));
    const water = (json.water || []).map((w) => ({ polygon: w.polygon.map((p) => ({ x: p[0], y: p[1] })) }));
    const parks = (json.parks || []).map((p) => ({ polygon: p.polygon.map((q) => ({ x: q[0], y: q[1] })), name: p.name, cx: p.cx, cy: p.cy }));
    const labels = (json.labels || []).slice();

    // Directed adjacency: a->b always, b->a only when the road is two-way.
    const adjacency = {};
    for (const n of nodes) adjacency[n.id] = [];
    for (const e of edges) {
      adjacency[e.a].push({ to: e.b, edge: e });
      if (!e.oneway) adjacency[e.b].push({ to: e.a, edge: e });
    }

    return {
      meta: json.meta, size: json.size, nodes, edges, adjacency,
      water, parks, blocks: [], labels, bounds: json.bounds,
      searchPlaces: json.search || null,
    };
  }

  WF.graph = {
    generateCity, loadCity, randomizeTraffic, evolveTraffic, signalState,
    effectiveSpeed, freeSpeed, edgeTravelTime, distance, KMH_TO_MS,
    edgeCum, pointAlongEdge,
  };
})(window.WF = window.WF || {});
