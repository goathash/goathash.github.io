/* traffic.js — moving-car simulation with one-ways, car-following and working signals.
 *
 * Each car drives along an edge (following its polyline) in a legal direction, keeps a
 * gap behind the car ahead, and stops at a red/yellow light near the intersection.
 * Because cars queue, red signals build a visible line of stopped cars that releases
 * when the light turns green.
 */
(function (WF) {
  "use strict";

  const GAP = 14;    // meters to keep behind the car ahead
  const STOP = 7;    // meters before the intersection to stop at a red light

  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function TrafficSim(graph, opts) {
    opts = opts || {};
    this.graph = graph;
    this.cars = [];
    const count = opts.count != null ? opts.count : Math.min(320, Math.round(graph.edges.length * 0.05) + 140);
    this._rng = mulberry((graph.seed || 7) ^ 0x9e3779b9);
    // Only spawn on edges that have at least one legal exit, so cars don't dead-lock.
    this._spawnable = graph.edges.filter((e) => graph.adjacency[e.b].length > 0 || (!e.oneway && graph.adjacency[e.a].length > 0));
    const weighted = [];
    for (const e of this._spawnable) { const w = 1 + Math.round(e.congestion * 4); for (let i = 0; i < w; i++) weighted.push(e); }
    this._weighted = weighted;
    for (let i = 0; i < count && weighted.length; i++) this.cars.push(this._spawn());
  }

  TrafficSim.prototype._spawn = function () {
    const w = this._weighted;
    const e = w[(this._rng() * w.length) | 0];
    // Direction: one-way -> a->b; two-way -> random, but prefer a legal exit.
    let from, to;
    if (e.oneway) { from = e.a; to = e.b; }
    else if (this._rng() < 0.5) { from = e.a; to = e.b; }
    else { from = e.b; to = e.a; }
    return { edge: e, from, to, s: this._rng() * 0.8, jitter: (this._rng() - 0.5) * 0.4 };
  };

  TrafficSim.prototype.update = function (dt, tSec) {
    const g = this.graph;
    dt = Math.min(dt, 0.1);

    // Group cars by (edge, travel direction) and sort along the direction of travel.
    const groups = new Map();
    for (const car of this.cars) {
      const total = car.edge.length || 1;
      const forward = car.edge.a === car.from;
      car._d = (forward ? car.s : 1 - car.s) * total; // distance from `from` toward `to`
      const key = car.edge.id + ":" + car.from;
      let arr = groups.get(key); if (!arr) groups.set(key, (arr = []));
      arr.push(car);
    }

    for (const arr of groups.values()) {
      arr.sort((p, q) => p._d - q._d);
      const e = arr[0].edge;
      for (let i = 0; i < arr.length; i++) {
        const car = arr[i];
        const toNode = g.nodes[car.to];
        let limit = e.length; // how far along the edge this car may reach this tick
        if (toNode.hasSignal) {
          const st = WF.graph.signalState(toNode, tSec);
          if (st === "red" || st === "yellow") limit = Math.min(limit, e.length - STOP);
        }
        if (i < arr.length - 1) limit = Math.min(limit, arr[i + 1]._d - GAP); // car ahead
        const speed = WF.graph.effectiveSpeed(e);
        let newD = Math.min(car._d + speed * dt, limit);
        if (newD < car._d) newD = car._d; // never reverse
        car._newD = newD;
      }
    }

    for (const car of this.cars) {
      let e = car.edge;
      let newD = car._newD != null ? car._newD : car._d;
      if (newD >= e.length - 0.01) {
        // Reached the intersection: turn onto a legal outgoing road (or respawn if none).
        const leftover = newD - e.length;
        const nexts = g.adjacency[car.to];
        if (!nexts || nexts.length === 0) { Object.assign(car, this._spawn()); continue; }
        const back = car.from;
        const forward = nexts.filter((n) => n.to !== back);
        const choices = forward.length ? forward : nexts;
        const nx = choices[(this._rng() * choices.length) | 0];
        car.from = car.to; car.to = nx.to; car.edge = nx.edge; e = car.edge;
        car.s = Math.min(0.99, leftover / (e.length || 1));
      } else {
        const forward = e.a === car.from;
        const frac = newD / (e.length || 1);
        car.s = forward ? frac : 1 - frac;
      }
      car._newD = undefined; car._d = undefined;
    }
  };

  // Positions for drawing: {x, y, tx, ty (travel tangent), speedFrac}.
  TrafficSim.prototype.positions = function () {
    const out = [];
    for (const car of this.cars) {
      const e = car.edge, total = e.length || 1;
      const forward = e.a === car.from;
      const d = forward ? car.s * total : (1 - car.s) * total;
      const pa = WF.graph.pointAlongEdge(e, d);
      let tx = pa.tx, ty = pa.ty; if (!forward) { tx = -tx; ty = -ty; }
      const off = car.jitter * 7;
      out.push({
        x: pa.x + -ty * off, y: pa.y + tx * off, tx, ty,
        speedFrac: WF.graph.effectiveSpeed(e) / (WF.graph.freeSpeed(e) || 1),
      });
    }
    return out;
  };

  WF.traffic = { TrafficSim };
})(window.WF = window.WF || {});
