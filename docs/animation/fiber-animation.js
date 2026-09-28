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
const X0 = 64;
const X1 = W - 24;
const PW = X1 - X0;
const VIEW_SPAN_MM = 13;
const BASE_RATE = 1 / 150; // simulated ms per wall-clock ms at 1x
const T_START = 8;
const EXPECTED_PULSES = { tonic: 8, fast: 18, burst: 40 }; // docs/figures/fidelity-source.json

const THEMES = {
  dark: {
    bg: '#0d1117', ink: '#e6edf3', muted: '#8b949e', faint: '#30363d', rule: '#21262d',
    cath: [108, 160, 220], anod: [229, 83, 75], myelin: [110, 118, 129], contact: '#6e7681', playhead: '#c9d1d9',
    vm: [[-115, [74, 120, 181]], [-80, [33, 38, 45]], [-60, [80, 68, 62]], [-35, [160, 100, 58]],
      [-10, [217, 138, 52]], [10, [238, 190, 102]], [25, [246, 226, 170]]],
  },
  light: {
    bg: '#f5f1e9', ink: '#201d19', muted: '#6d665e', faint: '#d5cdbf', rule: '#e4ddd1',
    cath: [29, 111, 140], anod: [176, 48, 106], myelin: [150, 138, 122], contact: '#9a9083', playhead: '#1d6f8c',
    vm: [[-115, [70, 110, 180]], [-80, [232, 226, 215]], [-60, [214, 184, 162]], [-35, [194, 114, 84]],
      [-10, [166, 79, 53]], [10, [120, 40, 22]], [25, [66, 20, 10]]],
  },
};

const state = { mode: 'burst', t: T_START, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, speed: 1 };
let meta, N, zNodes, theme, lut, kymoImages = {}, vmData = {};

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
  lut = { rgb: [], css: [] };
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
  }
}

async function loadVm(key) {
  if (!vmData[key]) {
    const res = await fetch(new URL(meta.waveforms[key].file, DATA));
    vmData[key] = new Uint8Array(await res.arrayBuffer());
  }
  return vmData[key];
}

function buildKymo(key) {
  // Propagation map: position along the fibre against time. Each column keeps the peak voltage
  // in its time bin so brief action potentials stay visible after downsampling.
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
  // Each waveform gets a close-up of the fibre under the electrode, its propagation map and
  // a stimulus strip; all maps share the time axis at the bottom.
  const ks = keys();
  const mapH = ks.length > 1 ? 118 : 250;
  const lanes = [];
  let y = 0;
  for (const key of ks) {
    const lane = { key, top: y, fiberY: y + 80, mapY: y + 100, mapH };
    lane.stimY = lane.mapY + mapH + 14;
    lanes.push(lane);
    y = lane.stimY + 22;
  }
  return { H: y + 30, lanes, axisY: y + 6 };
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
  return ctx.measureText(str).width;
}

function drawHeading(lane) {
  const wf = meta.waveforms[lane.key];
  const right = wf.end_spikes_ms.right.length;
  const w = text(wf.label, X0, lane.top + 20, { size: 14, color: theme.ink, weight: 600 });
  text(`${right}/${EXPECTED_PULSES[lane.key]} pulses reach the fibre end`, X0 + w + 10, lane.top + 20, { size: 12 });
}

function drawFiber(lane, vals, t) {
  const { key, fiberY } = lane;
  const zc = meta.electrode.contacts_mm;
  const z0 = (zc[0] + zc[1]) / 2 - VIEW_SPAN_MM / 2;
  const ppm = PW / VIEW_SPAN_MM;
  const xz = (z) => X0 + (z - z0) * ppm;
  const S = stim(key, t);
  const sheathH = 12;
  const nodeW = 4;

  const visible = [];
  for (let i = 0; i < N; i++) { const x = xz(zNodes[i]); if (x > X0 - 40 && x < X1 + 40) visible.push(i); }

  ctx.save();
  ctx.beginPath();
  ctx.rect(X0, lane.top + 26, PW, fiberY - lane.top - 14);
  ctx.clip();

  // electrode contacts, 0.5 mm above the fibre (to scale), coloured while they pass current
  const hPx = (meta.electrode.height_um / 1000) * ppm;
  zc.forEach((z, k) => {
    const x = xz(z);
    const y = fiberY - hPx;
    const current = meta.electrode.contact_signs[k] * S; // negative = cathodic
    ctx.fillStyle = current === 0 ? theme.contact : rgba(current < 0 ? theme.cath : theme.anod, 1);
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
  });

  // axon core coloured by voltage, interpolated between nodes
  const xa = xz(zNodes[visible[0]]);
  const xb = xz(zNodes[visible[visible.length - 1]]);
  const core = ctx.createLinearGradient(xa, 0, xb, 0);
  for (const i of visible) core.addColorStop((xz(zNodes[i]) - xa) / (xb - xa), lut.css[Math.round(vals[i])]);
  ctx.fillStyle = core;
  ctx.fillRect(xa, fiberY - 1.5, xb - xa, 3);

  // myelin: flat, translucent internodes between the nodes of Ranvier
  ctx.fillStyle = rgba(theme.myelin, 0.28);
  for (let k = 0; k < visible.length - 1; k++) {
    const xl = xz(zNodes[visible[k]]) + nodeW / 2 + 2;
    const xr = xz(zNodes[visible[k + 1]]) - nodeW / 2 - 2;
    ctx.beginPath(); ctx.roundRect(xl, fiberY - sheathH / 2, xr - xl, sheathH, 2); ctx.fill();
  }

  // nodes of Ranvier coloured by voltage
  for (const i of visible) {
    ctx.fillStyle = lut.css[Math.round(vals[i])];
    ctx.fillRect(xz(zNodes[i]) - nodeW / 2, fiberY - 7, nodeW, 14);
  }
  ctx.restore();
}

function drawMap(lane) {
  const img = kymoImages[lane.key];
  if (!img) return;
  const { mapY: y, mapH: h } = lane;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, X0, y, PW, h);
  const L = meta.model.length_mm;
  const yz = (z) => y + h - (z / L) * h;
  text('100 mm', X0 - 6, y + 9, { size: 10, align: 'right' });
  text('0', X0 - 6, y + h, { size: 10, align: 'right' });
  ctx.fillStyle = theme.muted;
  meta.electrode.contacts_mm.forEach((z) => {
    ctx.beginPath(); ctx.moveTo(X0 - 2, yz(z)); ctx.lineTo(X0 - 7, yz(z) - 3); ctx.lineTo(X0 - 7, yz(z) + 3); ctx.fill();
  });
}

function drawStim(lane, t) {
  const wf = meta.waveforms[lane.key];
  const y = lane.stimY;
  const hS = 5;
  ctx.strokeStyle = theme.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke();
  for (const [t0, t1, v] of wf.segments) {
    const xa = xOfT(t0);
    const w = Math.max(1.2, xOfT(t1) - xa);
    ctx.fillStyle = t0 <= t ? rgba(v > 0 ? theme.anod : theme.cath, 0.9) : theme.faint;
    ctx.fillRect(xa, v > 0 ? y - hS : y, w, hS);
  }
  text('stimulus', X0 - 6, y + 4, { size: 10, align: 'right' });
}

function drawAxis(y) {
  const ts = tStop();
  ctx.strokeStyle = theme.rule; ctx.lineWidth = 1;
  for (let t = 0; t <= ts; t += 25) {
    const x = xOfT(t);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 4); ctx.stroke();
    text(t + 25 > ts ? `${t} ms` : `${t}`, x, y + 16, { size: 10, align: 'center' });
  }
}

function render(t) {
  const lay = layout();
  const dpr = CAPTURE ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(W * dpr);
  const ch = Math.round(lay.H * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  ctx.setTransform(cw / W, 0, 0, ch / lay.H, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, lay.H);
  const vals = new Float32Array(N);
  const xp = xOfT(t);
  for (const lane of lay.lanes) {
    drawHeading(lane);
    drawFiber(lane, frame(lane.key, t, vals), t);
    drawMap(lane);
    drawStim(lane, t);
    ctx.strokeStyle = theme.playhead; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xp, lane.mapY - 3); ctx.lineTo(xp, lane.stimY + 8); ctx.stroke();
  }
  drawAxis(lay.axisY);
  text(`${t.toFixed(1)} ms`, X1, 20, { size: 12, align: 'right', mono: true });
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
    return `<div><b>${wf.label}</b> <span>· ${wf.detail} · threshold ${(Math.abs(wf.threshold_mA) * 1000).toFixed(1)} µA, stimulus ${(Math.abs(wf.amplitude_mA) * 1000).toFixed(1)} µA · spikes at the right end ${r}/${exp}, left end ${l}/${exp}</span></div>`;
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
    const lay = layout();
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * lay.H;
    const onMap = lay.lanes.some((l) => y >= l.mapY - 4 && y <= l.stimY + 10) || y >= lay.axisY - 4;
    if (onMap && x >= X0 && x <= X1) { state.t = tOfX(x); render(state.t); return true; }
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
