// Animated membrane voltage along the MRG fibre, drawn from the re-run EMBC 2025 simulations.
// Data: data/meta.json plus one uint8 voltage file per waveform (time-major, n_t x n_nodes).

const DATA = new URL('./data/', import.meta.url);
const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
const CAPTURE = params.has('capture');
if (CAPTURE) document.body.classList.add('capture');

const canvas = document.getElementById('fiber');
const ctx = canvas.getContext('2d');
const W = 1200;
const X0 = 78;
const X1 = W - 28;
const PW = X1 - X0;
const VIEW_SPAN_MM = 13;
const BASE_RATE = 1 / 150; // simulated ms per wall-clock ms at 1x
const T_START = 8;
const EXPECTED_PULSES = { tonic: 8, fast: 18, burst: 40 }; // docs/figures/fidelity-source.json

const THEMES = {
  dark: {
    bg: '#0d1117', ink: '#e6edf3', muted: '#8b949e', faint: '#30363d', rule: '#21262d',
    cath: [108, 160, 220], anod: [229, 83, 75], myelin: [160, 168, 180], glow: 'lighter', playhead: '#c9d1d9',
    vm: [[-115, [74, 120, 181]], [-80, [48, 54, 61]], [-60, [92, 78, 70]], [-35, [168, 104, 58]],
      [-10, [217, 138, 52]], [10, [238, 190, 102]], [25, [246, 226, 170]]],
  },
  light: {
    bg: '#f5f1e9', ink: '#201d19', muted: '#6d665e', faint: '#d5cdbf', rule: '#e4ddd1',
    cath: [29, 111, 140], anod: [176, 48, 106], myelin: [120, 104, 88], glow: 'source-over', playhead: '#1d6f8c',
    vm: [[-115, [70, 110, 180]], [-80, [212, 203, 188]], [-60, [206, 172, 150]], [-35, [194, 114, 84]],
      [-10, [166, 79, 53]], [10, [120, 40, 22]], [25, [66, 20, 10]]],
  },
};

const state = { mode: 'burst', t: T_START, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, speed: 1 };
let meta, N, zNodes, theme, lut, kymoImages = {}, vmData = {}, profile;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function themeName() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function buildLut() {
  const [lo, hi] = meta.vm_range_mV;
  const stops = theme.vm;
  lut = { rgb: [], css: [], act: new Float32Array(256), hyp: new Float32Array(256) };
  for (let q = 0; q < 256; q++) {
    const v = lo + (q / 255) * (hi - lo);
    let c = stops[stops.length - 1][1];
    if (v <= stops[0][0]) c = stops[0][1];
    for (let s = 0; s < stops.length - 1; s++) {
      const [va, ca] = stops[s];
      const [vb, cb] = stops[s + 1];
      if (v >= va && v <= vb) {
        const f = (v - va) / (vb - va);
        c = ca.map((x, k) => Math.round(x + (cb[k] - x) * f));
        break;
      }
    }
    lut.rgb.push(c);
    lut.css.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    lut.act[q] = clamp((v + 75) / 95, 0, 1);
    lut.hyp[q] = clamp((-82 - v) / 30, 0, 1);
  }
}

function buildProfile() {
  // Activating function (second spatial difference of the extracellular potential) for a unit
  // scaled stimulus S = +1: contact currents are sign * S, point sources 0.5 mm above the fibre.
  const h = meta.electrode.height_um / 1000;
  const ve = zNodes.map((z) => meta.electrode.contacts_mm.reduce(
    (sum, zc, k) => sum + meta.electrode.contact_signs[k] / Math.hypot(z - zc, h), 0));
  const f = ve.map((v, i) => (i === 0 || i === N - 1 ? 0 : ve[i - 1] - 2 * v + ve[i + 1]));
  const m = Math.max(...f.map(Math.abs));
  profile = f.map((v) => v / m);
}

async function loadVm(key) {
  if (!vmData[key]) {
    const res = await fetch(new URL(meta.waveforms[key].file, DATA));
    vmData[key] = new Uint8Array(await res.arrayBuffer());
  }
  return vmData[key];
}

function buildKymo(key) {
  // One column per display pixel; each column keeps the peak voltage in its time bin so brief
  // action potentials stay visible after downsampling.
  const wf = meta.waveforms[key];
  const cols = Math.min(wf.n_t, PW * 2);
  const img = new ImageData(cols, N);
  const vm = vmData[key];
  for (let c = 0; c < cols; c++) {
    const t0 = Math.floor((c * wf.n_t) / cols);
    const t1 = Math.max(t0 + 1, Math.floor(((c + 1) * wf.n_t) / cols));
    for (let i = 0; i < N; i++) {
      let q = 0;
      for (let ti = t0; ti < t1; ti++) q = Math.max(q, vm[ti * N + i]);
      const col = lut.rgb[q];
      const p = ((N - 1 - i) * cols + c) * 4;
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = cols; off.height = N;
  off.getContext('2d').putImageData(img, 0, 0);
  kymoImages[key] = off;
}

function frame(key, t, out) {
  const wf = meta.waveforms[key];
  const vm = vmData[key];
  const f = clamp(t / wf.dt_ms, 0, wf.n_t - 1.001);
  const i0 = Math.floor(f);
  const a = f - i0;
  const r0 = i0 * N;
  const r1 = r0 + N;
  for (let i = 0; i < N; i++) out[i] = vm[r0 + i] + (vm[r1 + i] - vm[r0 + i]) * a;
  return out;
}

function stim(key, t) {
  for (const [t0, t1, v] of meta.waveforms[key].segments) {
    if (t >= t0 && t < t1) return v;
    if (t0 > t) break;
  }
  return 0;
}

// ---------- layout ----------
function keys() { return state.mode === 'compare' ? ['tonic', 'burst'] : [state.mode]; }

function layout() {
  if (state.mode === 'compare') {
    return {
      H: 640,
      lanes: [{ key: 'tonic', top: 6, fiberY: 150, miniY: 206 }, { key: 'burst', top: 226, fiberY: 370, miniY: 426 }],
      kymo: null,
      traces: [{ key: 'tonic', y: 474 }, { key: 'burst', y: 548 }],
      axisY: 622,
    };
  }
  return {
    H: 640,
    lanes: [{ key: state.mode, top: 6, fiberY: 158, miniY: 250 }],
    kymo: { y: 290, h: 214 },
    traces: [{ key: state.mode, y: 540 }],
    axisY: 626,
  };
}

const tStop = () => meta.waveforms[keys()[0]].t_stop_ms;
const xOfT = (t) => X0 + (t / tStop()) * PW;
const tOfX = (x) => clamp(((x - X0) / PW) * tStop(), 0, tStop());

// ---------- drawing ----------
function text(str, x, y, { size = 12, color = theme.muted, align = 'left', weight = 400, mono = false } = {}) {
  ctx.font = `${weight} ${size}px ${mono ? 'ui-monospace, "Cascadia Mono", Consolas, monospace' : 'system-ui, "Segoe UI", Roboto, sans-serif'}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
}

function drawLane(lane, vals, t, isCompare) {
  const { key, fiberY } = lane;
  const wf = meta.waveforms[key];
  const zc = meta.electrode.contacts_mm;
  const zMid = (zc[0] + zc[1]) / 2;
  const z0 = zMid - VIEW_SPAN_MM / 2;
  const ppm = PW / VIEW_SPAN_MM;
  const xz = (z) => X0 + (z - z0) * ppm;
  const S = stim(key, t);
  const myelinH = 22;
  const gap = 5;

  // lane heading
  const right = wf.end_spikes_ms.right.length;
  const exp = EXPECTED_PULSES[key];
  text(isCompare ? `${wf.label}` : 'Close-up: the 13 mm of fibre under the electrode', X0, lane.top + 16,
    { size: isCompare ? 15 : 13, color: theme.ink, weight: 600 });
  if (isCompare) {
    text(`${wf.detail}  ·  ${right} of ${exp} pulses reach the fibre end (${Math.round((100 * right) / exp)}%)`,
      X0 + (key === 'tonic' ? 58 : 56), lane.top + 16, { size: 13 });
  }

  const visible = [];
  for (let i = 0; i < N; i++) { const x = xz(zNodes[i]); if (x > X0 - 60 && x < X1 + 60) visible.push(i); }

  ctx.save();
  ctx.beginPath();
  ctx.rect(X0 - 2, lane.top + 24, PW + 4, fiberY - lane.top + 40);
  ctx.clip();

  // electrode leads, halos and contacts
  const hPx = (meta.electrode.height_um / 1000) * ppm;
  zc.forEach((z, k) => {
    const x = xz(z);
    const y = fiberY - hPx;
    const current = meta.electrode.contact_signs[k] * S; // negative = cathodic
    ctx.strokeStyle = theme.faint; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, lane.top + 28); ctx.lineTo(x, y - 9); ctx.stroke();
    if (current !== 0) {
      const c = current < 0 ? theme.cath : theme.anod;
      const g = ctx.createRadialGradient(x, y, 2, x, y, 95);
      g.addColorStop(0, rgba(c, theme.glow === 'lighter' ? 0.22 : 0.18));
      g.addColorStop(1, rgba(c, 0));
      ctx.globalCompositeOperation = theme.glow;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 95, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    const disc = ctx.createLinearGradient(x, y - 8, x, y + 8);
    disc.addColorStop(0, '#c6ced8'); disc.addColorStop(1, '#6d7684');
    ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    if (current !== 0) {
      const c = current < 0 ? theme.cath : theme.anod;
      ctx.strokeStyle = rgba(c, 1); ctx.lineWidth = 2.5; ctx.stroke();
      text(current < 0 ? '−' : '+', x, y + 4.5, { size: 13, color: '#0b0e13', align: 'center', weight: 700 });
      if (!isCompare) text(current < 0 ? 'cathode' : 'anode', x + 14, y - 10, { size: 11, color: rgba(c, 1) });
    }
  });

  // activating function bars
  if (S !== 0) {
    for (const i of visible) {
      const f = S * profile[i];
      if (Math.abs(f) < 0.03) continue;
      const x = xz(zNodes[i]);
      const len = 30 * Math.min(1, Math.abs(f));
      ctx.fillStyle = rgba(f > 0 ? theme.cath : theme.anod, 0.85);
      if (f > 0) ctx.fillRect(x - 1.5, fiberY - myelinH / 2 - 5 - len, 3, len);
      else ctx.fillRect(x - 1.5, fiberY + myelinH / 2 + 5, 3, len);
    }
  }

  // axon core coloured by voltage (interpolated between nodes)
  const xa = xz(zNodes[visible[0]]);
  const xb = xz(zNodes[visible[visible.length - 1]]);
  const core = ctx.createLinearGradient(xa, 0, xb, 0);
  for (const i of visible) core.addColorStop((xz(zNodes[i]) - xa) / (xb - xa), lut.css[Math.round(vals[i])]);
  ctx.fillStyle = core;
  ctx.fillRect(xa, fiberY - 2.5, xb - xa, 5);

  // myelin sheaths
  const my = theme.myelin;
  const sheath = ctx.createLinearGradient(0, fiberY - myelinH / 2, 0, fiberY + myelinH / 2);
  sheath.addColorStop(0, rgba(my, theme.glow === 'lighter' ? 0.34 : 0.30));
  sheath.addColorStop(0.45, rgba(my, 0.08));
  sheath.addColorStop(1, rgba(my, theme.glow === 'lighter' ? 0.22 : 0.18));
  const paranode = ((3 + 22.249) / meta.model.internode_um) * (meta.model.internode_um / 1000) * ppm;
  for (let k = 0; k < visible.length - 1; k++) {
    const i = visible[k];
    const xl = xz(zNodes[i]) + gap / 2 + 0.5;
    const xr = xz(zNodes[i + 1]) - gap / 2 - 0.5;
    ctx.beginPath(); ctx.roundRect(xl, fiberY - myelinH / 2, xr - xl, myelinH, myelinH / 2);
    ctx.fillStyle = sheath; ctx.fill();
    ctx.strokeStyle = rgba(my, 0.38); ctx.lineWidth = 1; ctx.stroke();
    const act = (lut.act[Math.round(vals[i])] + lut.act[Math.round(vals[i + 1])]) / 2;
    if (act > 0.02) {
      ctx.globalCompositeOperation = theme.glow;
      ctx.fillStyle = rgba(lut.rgb[Math.round(Math.max(vals[i], vals[i + 1]))], 0.3 * act);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = rgba(my, 0.22);
    ctx.beginPath();
    ctx.moveTo(xl + paranode, fiberY - myelinH / 2 + 2); ctx.lineTo(xl + paranode, fiberY + myelinH / 2 - 2);
    ctx.moveTo(xr - paranode, fiberY - myelinH / 2 + 2); ctx.lineTo(xr - paranode, fiberY + myelinH / 2 - 2);
    ctx.moveTo(xl + myelinH / 2, fiberY - myelinH / 2 + 4); ctx.lineTo(xr - myelinH / 2, fiberY - myelinH / 2 + 4);
    ctx.stroke();
  }

  // nodes of Ranvier with voltage glow
  for (const i of visible) {
    const q = Math.round(vals[i]);
    const x = xz(zNodes[i]);
    const a = lut.act[q];
    if (a > 0.03) {
      const r = 7 + 30 * a;
      const g = ctx.createRadialGradient(x, fiberY, 1, x, fiberY, r);
      g.addColorStop(0, rgba(lut.rgb[q], theme.glow === 'lighter' ? 0.55 * a : 0.4 * a));
      g.addColorStop(1, rgba(lut.rgb[q], 0));
      ctx.globalCompositeOperation = theme.glow;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, fiberY, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = lut.css[q];
    ctx.fillRect(x - gap / 2, fiberY - 5, gap, 10);
  }
  ctx.restore();

  // soft edge fades
  for (const [xe, dir] of [[X0 - 2, 1], [X1 + 2, -1]]) {
    const g = ctx.createLinearGradient(xe, 0, xe + dir * 46, 0);
    g.addColorStop(0, theme.bg); g.addColorStop(1, `${theme.bg}00`);
    ctx.fillStyle = g;
    ctx.fillRect(dir > 0 ? xe : xe - 46, lane.top + 24, 46, fiberY - lane.top + 40);
  }

  // annotations (single view)
  if (!isCompare) {
    const yb = fiberY + 44;
    ctx.strokeStyle = theme.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X0 + 30, yb); ctx.lineTo(X0 + 30 + ppm, yb); ctx.stroke();
    text('1 mm', X0 + 30 + ppm / 2, yb + 14, { size: 11, align: 'center' });
    const iN = visible.find((i) => xz(zNodes[i]) > X1 - 190);
    if (iN !== undefined) {
      const xn = xz(zNodes[iN]);
      ctx.beginPath(); ctx.moveTo(xn, fiberY + 7); ctx.lineTo(xn + 14, yb - 4); ctx.stroke();
      text('node of Ranvier', xn + 17, yb, { size: 11 });
      const xm = (xz(zNodes[iN - 2]) + xz(zNodes[iN - 1])) / 2;
      ctx.beginPath(); ctx.moveTo(xm, fiberY + myelinH / 2); ctx.lineTo(xm - 12, yb - 4); ctx.stroke();
      text('myelin (MYSA · FLUT · STIN)', xm - 15, yb, { size: 11, align: 'right' });
    }
    const x1c = xz(zc[0]);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x1c - 26, fiberY - hPx); ctx.lineTo(x1c - 26, fiberY - myelinH / 2); ctx.stroke();
    ctx.setLineDash([]);
    text('0.5 mm', x1c - 32, fiberY - hPx / 2 - 6, { size: 11, align: 'right' });
  }

  drawMinimap(lane, vals, t, z0, isCompare);
}

function drawMinimap(lane, vals, t, zView0, isCompare) {
  const L = meta.model.length_mm;
  const y = lane.miniY;
  const xm = (z) => X0 + (z / L) * PW;
  ctx.strokeStyle = theme.faint; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke();
  ctx.strokeStyle = rgba(theme.myelin, 0.5); ctx.lineWidth = 1;
  ctx.strokeRect(xm(zView0), y - 8, xm(zView0 + VIEW_SPAN_MM) - xm(zView0), 16);
  meta.electrode.contacts_mm.forEach((z) => {
    ctx.fillStyle = theme.muted;
    ctx.beginPath(); ctx.moveTo(xm(z) - 3.5, y - 14); ctx.lineTo(xm(z) + 3.5, y - 14); ctx.lineTo(xm(z), y - 9); ctx.fill();
  });
  for (let i = 0; i < N; i++) {
    const q = Math.round(vals[i]);
    const a = lut.act[q];
    const x = xm(zNodes[i]);
    if (a > 0.05) {
      ctx.globalCompositeOperation = theme.glow;
      ctx.fillStyle = rgba(lut.rgb[q], theme.glow === 'lighter' ? 0.5 * a : 0.35 * a);
      ctx.beginPath(); ctx.arc(x, y, 3 + 9 * a, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = lut.css[q];
    ctx.fillRect(x - 1.2, y - 3, 2.4, 6);
  }
  // spikes leaving either end of the fibre
  const ends = meta.waveforms[lane.key].end_spikes_ms;
  [['left', X0], ['right', X1]].forEach(([side, x]) => {
    const recent = ends[side].some((s) => t >= s && t - s < 0.8);
    if (recent) {
      const g = ctx.createRadialGradient(x, y, 1, x, y, 22);
      g.addColorStop(0, rgba(lut.rgb[240], 0.9)); g.addColorStop(1, rgba(lut.rgb[240], 0));
      ctx.globalCompositeOperation = theme.glow;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  });
  text('0 mm', X0, y + 22, { size: 11 });
  text(`whole fibre, ${Math.round(L)} mm`, (X0 + X1) / 2, y + 22, { size: 11, align: 'center' });
  text(`${Math.round(L)} mm`, X1, y + 22, { size: 11, align: 'right' });
  if (!isCompare) text('electrode', xm(meta.electrode.contacts_mm[1]) + 10, y - 12, { size: 11 });
}

function drawKymo(k, key, t) {
  const img = kymoImages[key];
  if (!img) return;
  const xp = xOfT(t);
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = theme.glow === 'lighter' ? 0.16 : 0.25;
  ctx.drawImage(img, X0, k.y, PW, k.h);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.beginPath(); ctx.rect(X0, k.y, xp - X0, k.h); ctx.clip();
  ctx.drawImage(img, X0, k.y, PW, k.h);
  ctx.restore();
  ctx.strokeStyle = theme.rule; ctx.lineWidth = 1; ctx.strokeRect(X0 + 0.5, k.y + 0.5, PW - 1, k.h - 1);
  const L = meta.model.length_mm;
  const yz = (z) => k.y + k.h - (z / L) * k.h;
  [0, 25, 50, 75, 100].forEach((z) => text(`${z}`, X0 - 8, yz(z) + 4, { size: 11, align: 'right' }));
  meta.electrode.contacts_mm.forEach((z) => {
    ctx.fillStyle = theme.muted;
    ctx.beginPath(); ctx.moveTo(X0 - 3, yz(z)); ctx.lineTo(X0 - 9, yz(z) - 3.5); ctx.lineTo(X0 - 9, yz(z) + 3.5); ctx.fill();
  });
  ctx.save();
  ctx.translate(22, k.y + k.h / 2); ctx.rotate(-Math.PI / 2);
  text('position (mm)', 0, 0, { size: 11, align: 'center' });
  ctx.restore();
  text('voltage along the whole fibre over time', X0 + 8, k.y + 16, { size: 11, color: theme.ink });
}

function drawTrace(tr, t, isCompare) {
  const wf = meta.waveforms[tr.key];
  const y = tr.y;
  const hS = isCompare ? 13 : 17;
  const xp = xOfT(t);
  ctx.strokeStyle = theme.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke();
  for (const [t0, t1, v] of wf.segments) {
    const xa = xOfT(t0);
    const w = Math.max(1.4, xOfT(t1) - xa);
    const past = t0 <= t;
    ctx.fillStyle = past ? rgba(v > 0 ? theme.anod : theme.cath, 0.95) : theme.faint;
    ctx.fillRect(xa, v > 0 ? y - hS : y, w, hS);
  }
  const amp = Math.abs(wf.amplitude_mA) * 1000;
  text(isCompare ? wf.label.toLowerCase() : 'stimulus', X0 - 8, y - 2, { size: 11, align: 'right', color: theme.ink });
  text(`${amp.toFixed(0)} µA`, X0 - 8, y + 12, { size: 10, align: 'right', mono: true });
  // spikes leaving each end of the fibre
  ['left', 'right'].forEach((side, r) => {
    const yr = y + (isCompare ? 22 : 30) + r * 13;
    const spikes = wf.end_spikes_ms[side];
    let seen = 0;
    for (const s of spikes) {
      const x = xOfT(s);
      const past = s <= t;
      if (past) seen++;
      const fresh = past && t - s < 1.2;
      ctx.fillStyle = past ? (fresh ? lut.css[250] : lut.css[215]) : theme.faint;
      ctx.fillRect(x - (fresh ? 1.5 : 1), yr - 5, fresh ? 3 : 2, 10);
    }
    text(`${side} end`, X0 - 8, yr + 4, { size: 10, align: 'right' });
    text(`${seen}`, X1 + 4, yr + 4, { size: 10, mono: true, color: theme.ink });
  });
  ctx.strokeStyle = theme.playhead; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(xp, y - hS - 4); ctx.lineTo(xp, y + (isCompare ? 42 : 52)); ctx.stroke();
}

function drawAxis(y) {
  const ts = tStop();
  ctx.strokeStyle = theme.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X0, y - 12); ctx.lineTo(X1, y - 12); ctx.stroke();
  for (let t = 0; t <= ts; t += 25) {
    const x = xOfT(t);
    ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 8); ctx.stroke();
    const last = t + 25 > ts;
    text(last ? `${t} ms` : `${t}`, x, y + 3, { size: 11, align: 'center' });
  }
}

function render(t) {
  const lay = layout();
  const dpr = CAPTURE ? 1 : Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== W * dpr || canvas.height !== lay.H * dpr) {
    canvas.width = W * dpr; canvas.height = lay.H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, lay.H);
  const isCompare = state.mode === 'compare';
  const vals = new Float32Array(N);
  for (const lane of lay.lanes) drawLane(lane, frame(lane.key, t, vals), t, isCompare);
  if (lay.kymo) {
    drawKymo(lay.kymo, lay.lanes[0].key, t);
    const xp = xOfT(t);
    ctx.strokeStyle = theme.playhead; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xp, lay.kymo.y); ctx.lineTo(xp, lay.kymo.y + lay.kymo.h); ctx.stroke();
  }
  for (const tr of lay.traces) drawTrace(tr, t, isCompare);
  drawAxis(lay.axisY);
  text(`t = ${t.toFixed(2)} ms`, X1, 20, { size: 13, align: 'right', mono: true, color: theme.ink });
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = `t = ${t.toFixed(1)} ms`;
}

function updateStats() {
  const el = document.getElementById('stats');
  if (!el) return;
  el.innerHTML = keys().map((key) => {
    const wf = meta.waveforms[key];
    const exp = EXPECTED_PULSES[key];
    const r = wf.end_spikes_ms.right.length;
    const l = wf.end_spikes_ms.left.length;
    return `<div><b>${wf.label}</b> <span>· threshold ${(Math.abs(wf.threshold_mA) * 1000).toFixed(1)} µA · stimulus ${(Math.abs(wf.amplitude_mA) * 1000).toFixed(1)} µA (1.5×) · ${exp} pulses · spikes reaching the right end ${r} (${Math.round((100 * r) / exp)}%), left end ${l}</span></div>`;
  }).join('');
}

// ---------- playback & controls ----------
let last = null;
let renderFailed = false;
function tick(now) {
  try {
    if (last !== null && state.playing) {
      // Cap the step so returning to a background tab continues where it paused instead of jumping.
      state.t += Math.min(now - last, 100) * BASE_RATE * state.speed;
      if (state.t > tStop()) state.t = T_START;
    }
    last = now;
    render(state.t);
  } catch (err) {
    if (!renderFailed) console.error(err);
    renderFailed = true;
  } finally {
    requestAnimationFrame(tick);
  }
}

let modeRequest = 0;
async function setMode(mode) {
  // Load the data first and switch afterwards, so the playback loop never draws a waveform
  // whose voltage file is still downloading. Only the latest request is applied.
  const request = ++modeRequest;
  const wanted = mode === 'compare' ? ['tonic', 'burst'] : [mode];
  for (const key of wanted) {
    await loadVm(key);
    if (request !== modeRequest) return;
    if (!kymoImages[key]) buildKymo(key);
  }
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  updateStats();
  render(state.t);
}

function setPlaying(p) {
  state.playing = p;
  const b = document.getElementById('play');
  if (b) { b.textContent = p ? 'Pause' : 'Play'; b.setAttribute('aria-pressed', String(p)); }
}

function wireControls() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    state.speed = Number(b.dataset.speed);
    document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  }));
  document.getElementById('play')?.addEventListener('click', () => setPlaying(!state.playing));
  document.getElementById('restart')?.addEventListener('click', () => { state.t = T_START; });
  let dragging = false;
  const seek = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * layout().H;
    const lay = layout();
    const top = lay.kymo ? lay.kymo.y : lay.traces[0].y - 20;
    if (y >= top && x >= X0 && x <= X1) { state.t = tOfX(x); render(state.t); return true; }
    return false;
  };
  canvas.addEventListener('pointerdown', (e) => { dragging = seek(e); if (dragging) canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); setPlaying(!state.playing); }
    if (e.key === 'ArrowRight') { state.t = Math.min(tStop(), state.t + 0.5); render(state.t); }
    if (e.key === 'ArrowLeft') { state.t = Math.max(0, state.t - 0.5); render(state.t); }
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    theme = THEMES[themeName()]; buildLut();
    kymoImages = {};
    for (const key of Object.keys(vmData)) buildKymo(key);
    render(state.t);
  });
}

async function init() {
  meta = await (await fetch(new URL('meta.json', DATA))).json();
  N = meta.node_z_mm.length;
  zNodes = meta.node_z_mm;
  theme = THEMES[themeName()];
  buildLut();
  buildProfile();
  const requested = params.get('mode');
  if (requested && (requested in meta.waveforms || requested === 'compare')) state.mode = requested;
  if (params.get('t')) state.t = Number(params.get('t'));
  await setMode(state.mode);
  if (!CAPTURE) {
    wireControls();
    setPlaying(state.playing);
    requestAnimationFrame(tick);
  }
}

const ready = init();
window.fiberAnim = { ready, render: (t) => { state.t = t; render(t); }, setMode, canvas, get meta() { return meta; } };
