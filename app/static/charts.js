// Leichtgewichtige Canvas-Liniendiagramme (ohne externe Bibliotheken).
// new LineChart(container, { series: [{key, label, color, fill}], max, min, format, legend, stacked })
// chart.setData(timestamps[], { key: values[] })

const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paletteColor(i) {
  return cssVar(PALETTE[i % PALETTE.length]);
}

function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

class LineChart {
  constructor(el, opts = {}) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opts = Object.assign({ format: v => v.toFixed(1), min: 0, max: null, legend: true, grid: true, mini: false }, opts);
    this.series = (opts.series || []).map((s, i) => Object.assign({ color: null, fill: false, hidden: false }, s, { idx: i }));
    this.ts = [];
    this.data = {};
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.el.appendChild(this.tip);
    if (this.opts.legend && !this.opts.mini) {
      this.legendEl = document.createElement('div');
      this.legendEl.className = 'legend';
      this.el.after(this.legendEl);
      this.renderLegend();
    }
    this.hoverX = null;
    this.canvas.addEventListener('mousemove', e => { this.hoverX = e.offsetX; this.draw(); });
    this.canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.tip.style.display = 'none'; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setSeries(series) {
    const hidden = new Set(this.series.filter(s => s.hidden).map(s => s.key));
    this.series = series.map((s, i) => Object.assign({ color: null, fill: false }, s, { idx: i, hidden: hidden.has(s.key) }));
    this.renderLegend();
  }

  renderLegend() {
    if (!this.legendEl) return;
    this.legendEl.innerHTML = '';
    this.series.forEach(s => {
      const sp = document.createElement('span');
      sp.className = s.hidden ? 'off' : '';
      sp.innerHTML = `<i style="background:${this.color(s)}"></i>${s.label}`;
      sp.onclick = () => { s.hidden = !s.hidden; this.renderLegend(); this.draw(); };
      this.legendEl.appendChild(sp);
    });
  }

  color(s) {
    if (!s.color) return paletteColor(s.idx);
    return s.color.startsWith('--') ? cssVar(s.color) : s.color;
  }

  setData(ts, data) {
    this.ts = ts;
    this.data = data;
    this.draw();
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mini = this.opts.mini;
    let padL = 0;
    const padR = mini ? 0 : 8, padT = mini ? 2 : 8, padB = mini ? 2 : 20;
    const ts = this.ts;
    const visible = this.series.filter(s => !s.hidden);
    if (!ts.length) {
      if (!mini) {
        ctx.fillStyle = cssVar('--muted');
        ctx.font = '12px system-ui';
        ctx.fillText('Noch keine Daten', 12, h / 2);
      }
      return;
    }
    const t0 = ts[0], t1 = ts[ts.length - 1] === t0 ? t0 + 1 : ts[ts.length - 1];

    // Stapelung vorbereiten
    let values = {};
    if (this.opts.stacked) {
      const acc = new Array(ts.length).fill(0);
      visible.forEach(s => {
        const src = this.data[s.key] || [];
        values[s.key] = src.map((v, i) => (acc[i] += (v || 0)));
      });
    } else {
      visible.forEach(s => { values[s.key] = this.data[s.key] || []; });
    }

    let ymax = this.opts.max;
    if (ymax == null) {
      let m = 0;
      visible.forEach(s => (values[s.key] || []).forEach(v => { if (v != null && v > m) m = v; }));
      ymax = niceMax(m * 1.05);
    }
    const ymin = this.opts.min ?? 0;
    // linken Rand an die breiteste Achsenbeschriftung anpassen
    if (!mini) {
      ctx.font = '11px system-ui';
      let lw = 0;
      for (let i = 0; i <= 4; i++) lw = Math.max(lw, ctx.measureText(this.opts.format(ymin + (ymax - ymin) * i / 4)).width);
      padL = Math.ceil(lw) + 12;
    }
    const pw = w - padL - padR, ph = h - padT - padB;
    const X = t => padL + ((t - t0) / (t1 - t0)) * pw;
    const Y = v => padT + ph - ((v - ymin) / (ymax - ymin || 1)) * ph;

    // Raster & Achsen
    if (!mini && this.opts.grid) {
      ctx.strokeStyle = cssVar('--border');
      ctx.fillStyle = cssVar('--muted');
      ctx.lineWidth = 1;
      ctx.font = '11px system-ui';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = ymin + (ymax - ymin) * i / 4;
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillText(this.opts.format(v), padL - 6, y);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const span = t1 - t0;
      const ticks = Math.max(2, Math.min(8, Math.floor(pw / 90)));
      for (let i = 0; i <= ticks; i++) {
        const t = t0 + span * i / ticks;
        ctx.fillText(fmtAxisTime(t, span), Math.min(Math.max(X(t), padL + 20), w - padR - 20), h - padB + 5);
      }
    }

    // Linien (bei Stapelung von oben nach unten zeichnen, damit Flächen sichtbar bleiben)
    const order = this.opts.stacked ? [...visible].reverse() : visible;
    order.forEach(s => {
      const vals = values[s.key] || [];
      const col = this.color(s);
      ctx.strokeStyle = col;
      ctx.lineWidth = mini ? 1.5 : 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false, firstX = null, lastX = null;
      for (let i = 0; i < ts.length; i++) {
        const v = vals[i];
        if (v == null) { started = false; continue; }
        const x = X(ts[i]), y = Y(Math.min(v, ymax));
        if (!started) { ctx.moveTo(x, y); started = true; if (firstX == null) firstX = x; } else ctx.lineTo(x, y);
        lastX = x;
      }
      ctx.stroke();
      if ((s.fill || this.opts.stacked || mini) && firstX != null) {
        ctx.lineTo(lastX, Y(ymin));
        ctx.lineTo(firstX, Y(ymin));
        ctx.closePath();
        ctx.fillStyle = col + (this.opts.stacked ? '55' : '22');
        ctx.fill();
      }
    });

    // Hover
    if (this.hoverX != null && !mini && this.hoverX >= padL) {
      const tHover = t0 + ((this.hoverX - padL) / pw) * (t1 - t0);
      let best = 0, bd = Infinity;
      for (let i = 0; i < ts.length; i++) { const d = Math.abs(ts[i] - tHover); if (d < bd) { bd = d; best = i; } }
      const x = X(ts[best]);
      ctx.strokeStyle = cssVar('--muted');
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.setLineDash([]);
      let html = `<div class="muted">${new Date(ts[best] * 1000).toLocaleString('de-AT')}</div>`;
      visible.forEach(s => {
        const v = (this.data[s.key] || [])[best];
        html += `<div class="row"><span class="sw" style="background:${this.color(s)}"></span>${s.label}: <b>${v == null ? '–' : this.opts.format(v)}</b></div>`;
      });
      this.tip.innerHTML = html;
      this.tip.style.display = 'block';
      const tw = this.tip.offsetWidth;
      this.tip.style.left = (x + 12 + tw > w ? x - tw - 12 : x + 12) + 'px';
      this.tip.style.top = '6px';
    }
  }
}

function fmtAxisTime(t, span) {
  const d = new Date(t * 1000);
  if (span > 2 * 86400) return d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  if (span > 600) return d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
