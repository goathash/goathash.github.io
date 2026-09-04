/* render.js — Google-Maps-style canvas renderer.
 *
 * The static map (land, water, parks, blocks, roads, labels) is drawn once to an
 * offscreen canvas and cached. Each animation frame blits that cache, then draws the
 * moving layers (cars, signal lights, routes, markers) on top — so animation stays cheap.
 */
(function (WF) {
  "use strict";

  const C = {
    land: "#e8e6e0",
    block: "#fbfaf7",
    blockEdge: "#e6e2d8",
    water: "#a7d3f0",
    waterEdge: "#8fc3e8",
    park: "#c3e6a3",
    parkEdge: "#b2da8e",
    parkLabel: "#4d7a33",
    roadCasing: "#d0cabd",
    streetFill: "#ffffff",
    avenueFill: "#fde9a8",
    avenueCasing: "#f0cf78",
    districtLabel: "#8b8b8b",
    streetLabel: "#6f6f6f",
    waterLabel: "#5a94c0",
    fast: "#1a73e8",   // Google route blue
    short: "#7c4dff",  // alternate (violet)
    start: "#34a853",  // Google green
    end: "#ea4335",    // Google red
    sigRed: "#ea4335", sigYellow: "#fbbc04", sigGreen: "#34a853",
    hover: "#1a73e8",
  };
  const ROAD_W = { street: 3, arterial: 4.5, avenue: 6.5 };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(c1, c2, t) { return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))]; }
  const G = { low: [80, 200, 120], mid: [235, 190, 70], high: [225, 80, 70] };
  function congestionColor(c) {
    const rgb = c < 0.5 ? mix(G.low, G.mid, c / 0.5) : mix(G.mid, G.high, (c - 0.5) / 0.5);
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.off = document.createElement("canvas");
    this.offCtx = this.off.getContext("2d");
    this.graph = null;
    this.view = { scale: 1, offsetX: 0, offsetY: 0, dpr: 1 };
    this.fit = null;         // the "fit whole map" transform (min zoom)
    this.staticView = null;  // transform the offscreen cache was last rendered at
    this._staticTimer = null;
    this.targetScale = 1;    // zoom eases toward this
    this._focus = null;      // device-px point the zoom is anchored to (cursor)
    this.trafficOverlay = false;
  }

  Renderer.prototype.setGraph = function (graph) { this.graph = graph; this.resize(); };

  Renderer.prototype.resize = function () {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = this.off.width = Math.round(rect.width * dpr);
    this.canvas.height = this.off.height = Math.round(rect.height * dpr);
    if (!this.graph) return;
    const pad = 26 * dpr;
    const w = this.canvas.width - pad * 2, h = this.canvas.height - pad * 2;
    const b = this.graph.bounds;
    const worldW = b.maxX - b.minX, worldH = b.maxY - b.minY;
    const scale = Math.min(w / worldW, h / worldH);
    this.fit = {
      scale,
      offsetX: pad + (w - worldW * scale) / 2 - b.minX * scale,
      offsetY: pad + (h - worldH * scale) / 2 - b.minY * scale,
    };
    this.view = { dpr, scale: this.fit.scale, offsetX: this.fit.offsetX, offsetY: this.fit.offsetY }; // reset zoom on resize
    this.targetScale = this.fit.scale; this._focus = null;
    this.renderStatic();
  };

  // --- Pan / zoom (view is the current world->screen transform in device px).
  // Wheel only nudges a target; tickView() eases the view toward it each frame.
  Renderer.prototype.zoomAt = function (cx, cy, factor) {
    const fit = this.fit || this.view;
    this._focus = { cx, cy };
    this.targetScale = Math.max(fit.scale, Math.min(fit.scale * 12, this.targetScale * factor));
  };
  // Apply a new scale while keeping the focus device-point fixed on screen.
  Renderer.prototype._applyScale = function (s1) {
    const v = this.view, f = this._focus;
    const wx = (f.cx - v.offsetX) / v.scale, wy = (f.cy - v.offsetY) / v.scale;
    v.offsetX = f.cx - wx * s1; v.offsetY = f.cy - wy * s1; v.scale = s1;
  };
  // Called every animation frame to smoothly approach targetScale.
  Renderer.prototype.tickView = function (dt) {
    if (this._focus == null) return;
    const v = this.view, diff = this.targetScale - v.scale;
    if (Math.abs(diff) < v.scale * 0.002) {
      if (v.scale !== this.targetScale) { this._applyScale(this.targetScale); this._scheduleStatic(); }
      this._focus = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 16); // framerate-independent easing
    this._applyScale(v.scale + diff * k);
    this._scheduleStatic();
  };
  Renderer.prototype.panBy = function (dx, dy) {
    this.view.offsetX += dx; this.view.offsetY += dy;
    this.targetScale = this.view.scale; this._focus = null; // stop any zoom ease
    this._scheduleStatic();
  };
  Renderer.prototype.resetView = function () {
    const f = this.fit; if (!f) return;
    this.view.scale = f.scale; this.view.offsetX = f.offsetX; this.view.offsetY = f.offsetY;
    this.targetScale = f.scale; this._focus = null;
    this.renderStatic();
  };
  Renderer.prototype.zoomFactor = function () { return this.fit ? this.view.scale / this.fit.scale : 1; };
  // Pan so a world point sits at the canvas center (keeps current zoom).
  Renderer.prototype.centerOn = function (wx, wy) {
    const v = this.view;
    v.offsetX = this.canvas.width / 2 - wx * v.scale;
    v.offsetY = this.canvas.height / 2 - wy * v.scale;
    this._scheduleStatic();
  };
  Renderer.prototype._scheduleStatic = function () {
    clearTimeout(this._staticTimer);
    this._staticTimer = setTimeout(() => this.renderStatic(), 130);
  };

  Renderer.prototype.w2s = function (x, y) {
    return [x * this.view.scale + this.view.offsetX, y * this.view.scale + this.view.offsetY];
  };
  Renderer.prototype.s2w = function (sx, sy) {
    const d = this.view.dpr;
    return [(sx * d - this.view.offsetX) / this.view.scale, (sy * d - this.view.offsetY) / this.view.scale];
  };

  Renderer.prototype._poly = function (ctx, polygon) {
    ctx.beginPath();
    polygon.forEach((p, i) => { const [x, y] = this.w2s(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  };

  // Draw the static map into the offscreen cache.
  Renderer.prototype.renderStatic = function () {
    const ctx = this.offCtx, g = this.graph, dpr = this.view.dpr;
    if (!g) return;
    ctx.fillStyle = C.land;
    ctx.fillRect(0, 0, this.off.width, this.off.height);

    // Building blocks (dummy map only; real map has none)
    for (const bl of (g.blocks || [])) {
      this._poly(ctx, bl.polygon);
      ctx.fillStyle = C.block; ctx.fill();
      ctx.lineWidth = 1 * dpr; ctx.strokeStyle = C.blockEdge; ctx.stroke();
    }
    // Water
    for (const w of g.water) {
      this._poly(ctx, w.polygon);
      ctx.fillStyle = C.water; ctx.fill();
      ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = C.waterEdge; ctx.stroke();
    }
    // Parks
    for (const p of g.parks) {
      this._poly(ctx, p.polygon);
      ctx.fillStyle = C.park; ctx.fill();
      ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = C.parkEdge; ctx.stroke();
    }

    // Roads: casing pass, then fill pass, for seamless intersections.
    // Roads widen as you zoom in (like a real map), capped so they don't dominate.
    const zf = Math.max(1, Math.min(4, this.zoomFactor()));
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const stroke = (e) => {
      const g0 = e.geometry;
      ctx.beginPath();
      for (let i = 0; i < g0.length; i++) { const [x, y] = this.w2s(g0[i].x, g0[i].y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    };
    for (const e of g.edges) {
      ctx.lineWidth = (ROAD_W[e.roadClass] + 2) * dpr * zf;
      ctx.strokeStyle = e.roadClass === "avenue" ? C.avenueCasing : C.roadCasing;
      stroke(e);
    }
    for (const e of g.edges) {
      ctx.lineWidth = ROAD_W[e.roadClass] * dpr * zf;
      ctx.strokeStyle = this.trafficOverlay ? congestionColor(e.congestion)
        : (e.roadClass === "avenue" ? C.avenueFill : C.streetFill);
      stroke(e);
    }

    // Labels
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const l of g.labels) {
      const [x, y] = this.w2s(l.x, l.y);
      ctx.save(); ctx.translate(x, y); if (l.angle) ctx.rotate((l.angle * Math.PI) / 180);
      if (l.kind === "district") { ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`; ctx.fillStyle = C.districtLabel; }
      else if (l.kind === "street") { ctx.font = `${10.5 * dpr}px system-ui, sans-serif`; ctx.fillStyle = C.streetLabel; }
      else if (l.kind === "park") { ctx.font = `italic 600 ${11 * dpr}px system-ui, sans-serif`; ctx.fillStyle = C.parkLabel; }
      else { ctx.font = `italic ${11 * dpr}px system-ui, sans-serif`; ctx.fillStyle = C.waterLabel; }
      // faint halo for legibility
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.strokeText(l.text, 0, 0);
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }

    this.staticView = { scale: this.view.scale, offsetX: this.view.offsetX, offsetY: this.view.offsetY };
  };

  Renderer.prototype.setTrafficOverlay = function (on) { this.trafficOverlay = on; this.renderStatic(); };

  // Draw one animated frame.
  Renderer.prototype.drawFrame = function (tSec, opts) {
    opts = opts || {};
    const ctx = this.ctx, g = this.graph, dpr = this.view.dpr;
    if (!g) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Blit the cached static map. If the view moved since it was cached (mid gesture),
    // transform the bitmap to match — cheap and smooth; a crisp re-render follows on settle.
    const sv = this.staticView, v = this.view;
    if (sv) {
      const k = v.scale / sv.scale;
      ctx.save();
      ctx.setTransform(k, 0, 0, k, v.offsetX - sv.offsetX * k, v.offsetY - sv.offsetY * k);
      ctx.drawImage(this.off, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(this.off, 0, 0);
    }

    // Cars: oriented vehicle marks, colored by speed.
    if (opts.cars) {
      const L = 5.5 * dpr, W = 3.2 * dpr;
      for (const car of opts.cars) {
        const [x, y] = this.w2s(car.x, car.y);
        const rgb = car.speedFrac > 0.6 ? mix(G.mid, G.low, (car.speedFrac - 0.6) / 0.4)
          : mix(G.high, G.mid, car.speedFrac / 0.6);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(car.ty || 0, car.tx || 1));
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(-L / 2, -W / 2, L, W);
        ctx.lineWidth = 0.6 * dpr; ctx.strokeStyle = "rgba(0,0,0,0.4)";
        ctx.strokeRect(-L / 2, -W / 2, L, W);
        ctx.restore();
      }
    }

    // Routes (shortest under fastest)
    if (opts.shortRoute) this._route(opts.shortRoute, C.short, 5);
    if (opts.fastRoute) this._route(opts.fastRoute, C.fast, 5.5);

    // Animated traffic signals (drawn over cars so the light stays visible above a queue)
    if (opts.showSignals) {
      for (const n of g.nodes) {
        if (!n.hasSignal) continue;
        const st = WF.graph.signalState(n, tSec);
        const [x, y] = this.w2s(n.x, n.y);
        ctx.beginPath(); ctx.arc(x, y, 3.4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = st === "green" ? C.sigGreen : st === "yellow" ? C.sigYellow : C.sigRed;
        ctx.fill();
        ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      }
    }

    // Hover snap dot
    if (opts.hover) {
      const [x, y] = this.w2s(opts.hover.x, opts.hover.y);
      ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = C.hover; ctx.lineWidth = 2 * dpr; ctx.stroke();
    }

    // Markers
    if (opts.start) this._marker(opts.start, C.start, "A");
    if (opts.end) this._marker(opts.end, C.end, "B");
  };

  Renderer.prototype._route = function (route, color, width) {
    const ctx = this.ctx, dpr = this.view.dpr;
    if (!route || route.points.length < 2) return;
    ctx.beginPath();
    route.points.forEach((p, i) => { const [x, y] = this.w2s(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // white halo under the route so it reads over any background
    ctx.lineWidth = (width + 3) * dpr; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.stroke();
    ctx.lineWidth = width * dpr; ctx.strokeStyle = color; ctx.stroke();
  };

  Renderer.prototype._marker = function (pt, color, label) {
    const ctx = this.ctx, dpr = this.view.dpr;
    const [x, y] = this.w2s(pt.x, pt.y);
    ctx.beginPath(); ctx.arc(x, y, 8 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `700 ${9 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  };

  WF.render = { Renderer, congestionColor };
})(window.WF = window.WF || {});
