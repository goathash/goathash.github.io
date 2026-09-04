/* app.js — UI wiring: load the real Pune map, snap-to-road A/B, route, animate. */
(function (WF) {
  "use strict";

  const DATA_URL = "data/pune.json";
  const state = {
    graph: null, raw: null, renderer: null, sim: null, search: [],
    startSnap: null, endSnap: null, hoverSnap: null,
    fastRoute: null, shortRoute: null,
    trafficOverlay: false, showSignals: true, showCars: true,
    animate: true, compareShortest: true, liveReroute: true,
    lastT: 0, clock: 0, reAccum: 0, overlayAccum: 0,
  };
  const $ = (id) => document.getElementById(id);

  const fmtTime = (s) => { const m = Math.floor(s / 60), sec = Math.round(s % 60); return m > 0 ? `${m} min ${sec}s` : `${sec}s`; };
  const fmtKm = (m) => (m / 1000).toFixed(2) + " km";
  const fmtKmh = (ms) => Math.round(ms / WF.graph.KMH_TO_MS) + " km/h";

  function applyGraph() {
    state.graph = WF.graph.loadCity(state.raw);
    state.startSnap = state.endSnap = state.fastRoute = state.shortRoute = null;
    state.renderer.trafficOverlay = state.trafficOverlay;
    state.renderer.setGraph(state.graph);
    state.sim = new WF.traffic.TrafficSim(state.graph);
    state.search = buildSearchIndex(state.graph);
    $("from-input").value = ""; $("to-input").value = "";
    const m = state.graph.meta || {};
    const sig = state.graph.nodes.filter((n) => n.hasSignal).length;
    $("mapmeta").innerHTML = `<b>${m.city || "Map"}</b><br>${state.graph.edges.length.toLocaleString()} roads &middot; ${sig} signals &middot; ${((m.radius || 0) / 1000)} km radius`;
    updateInfo();
  }

  // --- Place search over the real OSM labels ---------------------------------
  function buildSearchIndex(graph) {
    const seen = new Set(), idx = [];
    const add = (name, x, y) => { if (!name) return; const k = name.toLowerCase(); if (seen.has(k)) return; seen.add(k); idx.push({ name, x, y }); };
    if (graph.searchPlaces) for (const p of graph.searchPlaces) add(p.name, p.x, p.y);
    else { for (const l of graph.labels) add(l.text, l.x, l.y); for (const p of graph.parks) add(p.name, p.cx, p.cy); }
    idx.sort((a, b) => a.name.localeCompare(b.name));
    return idx;
  }
  function searchLookup(q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return [];
    const starts = [], contains = [];
    for (const e of state.search) {
      const n = e.name.toLowerCase();
      if (n.startsWith(q)) starts.push(e);
      else if (n.includes(q)) contains.push(e);
    }
    return starts.concat(contains).slice(0, 8);
  }
  function nearestName(x, y) {
    let best = null, bd = Infinity;
    for (const e of state.search) { const d = (e.x - x) ** 2 + (e.y - y) ** 2; if (d < bd) { bd = d; best = e; } }
    return best && Math.sqrt(bd) < 500 ? best.name : "Dropped pin";
  }
  function renderSuggest(list, results, onPick) {
    list.innerHTML = "";
    for (const r of results) {
      const li = document.createElement("li");
      li.textContent = r.name;
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); onPick(r); });
      list.appendChild(li);
    }
    list.hidden = results.length === 0;
  }
  function setEndpoint(which, x, y) {
    const snap = WF.pathfinding.snapToRoad(state.graph, x, y);
    if (which === "start") state.startSnap = snap; else state.endSnap = snap;
    state.renderer.centerOn(x, y);
    recompute();
  }
  function wireField(inputId, listId, which) {
    const input = $(inputId), list = $(listId);
    const show = () => renderSuggest(list, searchLookup(input.value), (r) => { input.value = r.name; list.hidden = true; setEndpoint(which, r.x, r.y); });
    input.addEventListener("input", show);
    input.addEventListener("focus", () => { if (input.value) show(); });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 160));
  }

  async function loadMap() {
    $("info").innerHTML = `<p class="hint">Loading real map data…</p>`;
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.raw = await res.json();
      applyGraph();
    } catch (err) {
      $("info").innerHTML = `<p class="hint">Could not load <code>${DATA_URL}</code>. Run <code>node scripts/fetch-map.js</code> first.<br>${err.message}</p>`;
    }
  }

  function recompute() {
    state.fastRoute = state.shortRoute = null;
    if (state.startSnap && state.endSnap) {
      state.fastRoute = WF.pathfinding.route(state.graph, state.startSnap, state.endSnap, "time");
      if (state.compareShortest)
        state.shortRoute = WF.pathfinding.route(state.graph, state.startSnap, state.endSnap, "distance");
    }
    updateInfo();
  }

  function updateInfo() {
    const box = $("info");
    if (!state.startSnap || !state.endSnap) {
      box.innerHTML = `<p class="hint">Click the map to drop <b>A</b> (start), then <b>B</b> (destination). Clicks snap to the nearest road.</p>`;
      return;
    }
    const f = state.fastRoute;
    if (!f) { box.innerHTML = `<p class="hint">No route found (the two points may be on disconnected roads). Try nearby spots.</p>`; return; }
    let html = `
      <div class="stat"><span class="dot fast"></span>Fastest route</div>
      <table>
        <tr><td>ETA</td><td><b>${fmtTime(f.time)}</b></td></tr>
        <tr><td>Distance</td><td>${fmtKm(f.distance)}</td></tr>
        <tr><td>Avg speed</td><td>${fmtKmh(f.avgSpeed)}</td></tr>
        <tr><td>Signals</td><td>${f.signals}</td></tr>
      </table>`;
    const s = state.shortRoute;
    if (s) {
      const same = JSON.stringify(s.points) === JSON.stringify(f.points);
      html += `
        <div class="stat"><span class="dot short"></span>Shortest route</div>
        <table>
          <tr><td>Distance</td><td><b>${fmtKm(s.distance)}</b></td></tr>
          <tr><td>ETA</td><td>${fmtTime(s.time)}</td></tr>
        </table>`;
      html += same
        ? `<p class="hint">Both routes match here. Try "Randomize traffic".</p>`
        : `<p class="hint ok">Fastest saves <b>${fmtTime(Math.max(0, s.time - f.time))}</b> vs shortest, at ${fmtKm(Math.abs(f.distance - s.distance))} ${f.distance >= s.distance ? "extra" : "less"} distance.</p>`;
    }
    box.innerHTML = html;
  }

  function frame(ts) {
    if (!state.graph || !state.sim) { requestAnimationFrame(frame); return; }
    if (!state.lastT) state.lastT = ts;
    const dt = (ts - state.lastT) / 1000;
    state.lastT = ts;
    state.renderer.tickView(dt); // smooth zoom easing (runs even when traffic is paused)
    if (state.animate) {
      state.clock += dt;
      state.sim.update(dt, state.clock);
      WF.graph.evolveTraffic(state.graph, dt); // traffic drifts so routes have something to react to
      // Keep the heat overlay in step with drifting traffic (throttled; it lives in the static cache).
      if (state.trafficOverlay) { state.overlayAccum += dt; if (state.overlayAccum > 1.2) { state.overlayAccum = 0; state.renderer.renderStatic(); } }
      // Live re-route: recompute the active route as conditions change.
      if (state.liveReroute && state.startSnap && state.endSnap) {
        state.reAccum += dt;
        if (state.reAccum > 1.0) { state.reAccum = 0; recompute(); }
      }
    }
    state.renderer.drawFrame(state.clock, {
      cars: state.showCars ? state.sim.positions() : null,
      showSignals: state.showSignals,
      start: state.startSnap ? state.startSnap.point : null,
      end: state.endSnap ? state.endSnap.point : null,
      hover: state.hoverSnap ? state.hoverSnap.point : null,
      fastRoute: state.fastRoute,
      shortRoute: state.compareShortest ? state.shortRoute : null,
    });
    requestAnimationFrame(frame);
  }

  function pointFromEvent(evt) {
    const rect = state.renderer.canvas.getBoundingClientRect();
    return state.renderer.s2w(evt.clientX - rect.left, evt.clientY - rect.top);
  }

  function init() {
    state.renderer = new WF.render.Renderer($("map"));
    const canvas = state.renderer.canvas;

    // Drag to pan, wheel to zoom, a click (no drag) drops A/B.
    let down = false, dragged = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
    canvas.addEventListener("mousedown", (e) => {
      if (!state.graph) return;
      down = true; dragged = false;
      lastX = downX = e.clientX; lastY = downY = e.clientY;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!state.graph) return;
      if (down) {
        const dpr = state.renderer.view.dpr;
        state.renderer.panBy((e.clientX - lastX) * dpr, (e.clientY - lastY) * dpr);
        lastX = e.clientX; lastY = e.clientY;
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) dragged = true;
      } else {
        const rect = canvas.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) { state.hoverSnap = null; return; }
        const [wx, wy] = state.renderer.s2w(e.clientX - rect.left, e.clientY - rect.top);
        state.hoverSnap = WF.pathfinding.snapToRoad(state.graph, wx, wy);
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (!down) return;
      down = false; canvas.style.cursor = "grab";
      if (dragged) return;
      const rect = canvas.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      const [wx, wy] = state.renderer.s2w(e.clientX - rect.left, e.clientY - rect.top);
      const snap = WF.pathfinding.snapToRoad(state.graph, wx, wy);
      if (!state.startSnap || (state.startSnap && state.endSnap)) {
        state.startSnap = snap; state.endSnap = null;
        $("from-input").value = nearestName(wx, wy); $("to-input").value = "";
      } else {
        state.endSnap = snap;
        $("to-input").value = nearestName(wx, wy);
      }
      recompute();
    });
    canvas.addEventListener("wheel", (e) => {
      if (!state.graph) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dpr = state.renderer.view.dpr;
      state.renderer.zoomAt((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    canvas.addEventListener("dblclick", () => state.renderer.resetView());
    canvas.style.cursor = "grab";

    $("btn-reset").addEventListener("click", () => { if (state.raw) applyGraph(); });
    $("btn-resetview").addEventListener("click", () => state.renderer.resetView());
    $("btn-traffic").addEventListener("click", () => { WF.graph.randomizeTraffic(state.graph); state.renderer.renderStatic(); recompute(); });
    $("btn-clear").addEventListener("click", () => { state.startSnap = state.endSnap = null; $("from-input").value = ""; $("to-input").value = ""; recompute(); });

    $("chk-overlay").addEventListener("change", (e) => { state.trafficOverlay = e.target.checked; state.renderer.setTrafficOverlay(state.trafficOverlay); });
    $("chk-signals").addEventListener("change", (e) => { state.showSignals = e.target.checked; });
    $("chk-cars").addEventListener("change", (e) => { state.showCars = e.target.checked; });
    $("chk-animate").addEventListener("change", (e) => { state.animate = e.target.checked; });
    $("chk-compare").addEventListener("change", (e) => { state.compareShortest = e.target.checked; recompute(); });
    $("chk-reroute").addEventListener("change", (e) => { state.liveReroute = e.target.checked; });

    wireField("from-input", "from-list", "start");
    wireField("to-input", "to-list", "end");

    window.addEventListener("resize", () => state.renderer.resize());

    loadMap();
    requestAnimationFrame(frame);
  }

  window.addEventListener("DOMContentLoaded", init);
})(window.WF = window.WF || {});
