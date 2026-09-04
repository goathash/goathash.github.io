/* pathfinding.js — snap-to-road + Dijkstra over polyline road geometry.
 *
 * Edges are polylines (edge.geometry = [{x,y}, ...]). snapToRoad projects a click onto
 * the nearest segment of the nearest edge (accelerated by a uniform-grid spatial index),
 * and route() inserts that point as a virtual node so paths start/end on the road.
 */
(function (WF) {
  "use strict";

  function MinHeap() { this.a = []; }
  MinHeap.prototype.push = function (node, prio) {
    const a = this.a; a.push({ node, prio });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].prio <= a[i].prio) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  };
  MinHeap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let s = i;
        if (l < a.length && a[l].prio < a[s].prio) s = l;
        if (r < a.length && a[r].prio < a[s].prio) s = r;
        if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top;
  };
  MinHeap.prototype.size = function () { return this.a.length; };

  function projectToSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return { t, x: a.x + abx * t, y: a.y + aby * t };
  }

  // Uniform-grid index of edges by the cells their geometry vertices fall in.
  const CELL = 200;
  function buildIndex(graph) {
    const idx = new Map();
    for (const e of graph.edges) {
      for (const pt of e.geometry) {
        const k = ((pt.x / CELL) | 0) + "," + ((pt.y / CELL) | 0);
        let s = idx.get(k); if (!s) idx.set(k, (s = new Set()));
        s.add(e);
      }
    }
    graph._index = idx;
  }

  function candidateEdges(graph, x, y) {
    if (!graph._index) buildIndex(graph);
    const idx = graph._index;
    const cx = (x / CELL) | 0, cy = (y / CELL) | 0;
    for (let ring = 1; ring <= 6; ring++) {
      const cand = new Set();
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          const s = idx.get((cx + dx) + "," + (cy + dy));
          if (s) for (const e of s) cand.add(e);
        }
      if (cand.size) return cand;
    }
    return graph.edges;
  }

  function snapToRoad(graph, x, y) {
    const p = { x, y };
    let best = null, bestD = Infinity;
    for (const e of candidateEdges(graph, x, y)) {
      const g = e.geometry, cum = WF.graph.edgeCum(e);
      for (let i = 1; i < g.length; i++) {
        const pr = projectToSegment(p, g[i - 1], g[i]);
        const d = (pr.x - x) ** 2 + (pr.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          const segLen = cum[i] - cum[i - 1];
          best = { edge: e, point: { x: pr.x, y: pr.y }, distToA: cum[i - 1] + segLen * pr.t, dist: Math.sqrt(d) };
        }
      }
    }
    if (best) { const cum = WF.graph.edgeCum(best.edge); best.distToB = cum[cum.length - 1] - best.distToA; }
    return best;
  }

  function partial(edge, length) {
    return { length, speedLimit: edge.speedLimit, congestion: edge.congestion, roadClass: edge.roadClass, virtual: true };
  }

  function route(graph, startSnap, endSnap, mode) {
    mode = mode || "time";
    if (!startSnap || !endSnap) return null;
    const START = "S", END = "E";
    const se = startSnap.edge, ee = endSnap.edge;

    const extra = new Map();
    const addExtra = (id, entry) => { let a = extra.get(id); if (!a) extra.set(id, (a = [])); a.push(entry); };

    // Leaving the start point: forward (toward b) always OK; backward (toward a) only two-way.
    const startEntries = [{ to: se.b, edge: partial(se, startSnap.distToB) }];
    if (!se.oneway) startEntries.push({ to: se.a, edge: partial(se, startSnap.distToA) });

    // Reaching the end point: come from a (forward) always; from b (backward) only two-way.
    addExtra(ee.a, { to: END, edge: partial(ee, endSnap.distToA) });
    if (!ee.oneway) addExtra(ee.b, { to: END, edge: partial(ee, endSnap.distToB) });

    // Same road: a direct hop is only legal in the travel direction.
    if (se === ee) {
      const delta = endSnap.distToA - startSnap.distToA;
      if (delta >= 0) startEntries.push({ to: END, edge: partial(se, delta) });
      else if (!se.oneway) startEntries.push({ to: END, edge: partial(se, -delta) });
    }

    const neighbors = (id) => {
      if (id === START) return startEntries;
      const base = graph.adjacency[id] || [];
      const ex = extra.get(id);
      return ex ? base.concat(ex) : base;
    };
    const N = graph.nodes;
    const signalWaitOf = (id) => (typeof id === "number" && N[id].hasSignal ? N[id].signalWait : 0);

    const dist = new Map([[START, 0]]);
    const prev = new Map();
    const settled = new Set();
    const heap = new MinHeap();
    heap.push(START, 0);

    while (heap.size()) {
      const { node: u } = heap.pop();
      if (settled.has(u)) continue;
      settled.add(u);
      if (u === END) break;
      const du = dist.get(u);
      for (const { to, edge } of neighbors(u)) {
        if (settled.has(to)) continue;
        let step;
        if (mode === "distance") step = edge.length;
        else { step = WF.graph.edgeTravelTime(edge); if (to !== END) step += signalWaitOf(to); }
        const nd = du + step;
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); prev.set(to, { from: u, edge }); heap.push(to, nd); }
      }
    }
    if (!prev.has(END)) return null;

    const ids = [END], edgesUsed = [];
    let cur = END;
    while (cur !== START) { const st = prev.get(cur); edgesUsed.push(st.edge); ids.push(st.from); cur = st.from; }
    ids.reverse(); edgesUsed.reverse();

    // Build a polyline that follows real road geometry for interior edges.
    const pts = [{ x: startSnap.point.x, y: startSnap.point.y }];
    for (let k = 1; k < ids.length; k++) {
      const prevId = ids[k - 1], curId = ids[k], e = edgesUsed[k - 1];
      if (curId === END) { pts.push({ x: endSnap.point.x, y: endSnap.point.y }); continue; }
      if (e && !e.virtual && typeof prevId === "number") {
        const g = e.geometry, seq = e.a === prevId ? g : g.slice().reverse();
        for (let j = 1; j < seq.length; j++) pts.push({ x: seq[j].x, y: seq[j].y });
      } else {
        const n = N[curId]; pts.push({ x: n.x, y: n.y });
      }
    }

    let distance = 0, time = 0, signals = 0;
    for (const e of edgesUsed) { distance += e.length; time += WF.graph.edgeTravelTime(e); }
    for (const id of ids) if (typeof id === "number" && N[id].hasSignal) { time += N[id].signalWait; signals++; }

    return { ids, points: pts, distance, time, signals, avgSpeed: time > 0 ? distance / time : 0, mode };
  }

  WF.pathfinding = { snapToRoad, route, projectToSegment, buildIndex };
})(window.WF = window.WF || {});
