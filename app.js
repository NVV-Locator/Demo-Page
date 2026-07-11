const MAX_SHOW = 4;
const HALLUC_THRESH = 8;
const IOU_OK = 0.5;

const MODEL_ORDER = [
  ["nv_locator", "NV-Locator (21g)"],
  ["gemini-2.5-pro", "Gemini-2.5-Pro"],
  ["qwen3-omni", "Qwen3-Omni"],
  ["step-audio", "Step-Audio"],
  ["moss-audio", "Moss-Audio"],
];

let samples = [];
let idx = 0;
let audioBuf = null;
let duration = 0;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const fmt = (t) => (t ?? 0).toFixed(3);
const pct = (t) => (duration ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0);
const audioEl = () => document.getElementById("audio");

function highlightAsr(text, cat) {
  if (!text) return "";
  let r = esc(text);
  if (cat) {
    const safe = esc(cat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    r = r.replace(new RegExp(`\\[${safe}\\]`, "g"), `<span class="hl">[${esc(cat)}]</span>`);
  }
  return r;
}

function gtEvents(s) {
  return s.gt_all?.length ? s.gt_all : s.gt || [];
}

function targetGt(s) {
  return s.gt?.[0] || gtEvents(s).find((e) => e.event_type === s.category);
}

function tIoU(ps, pe, gs, ge) {
  const inter = Math.max(0, Math.min(pe, ge) - Math.max(ps, gs));
  const union = Math.max(0.001, pe - ps) + Math.max(0.001, ge - gs) - inter;
  return union > 0 ? inter / union : 0;
}

function bestGtMatch(e, gtList) {
  let best = { iou: 0, gt: null };
  for (const g of gtList) {
    if (g.event_type !== e.event_type) continue;
    const iou = tIoU(e.start_time, e.end_time, g.start_time, g.end_time);
    if (iou > best.iou) best = { iou, gt: g };
  }
  return best;
}

function evalEvent(e, target, gtEv, gtAll) {
  if (e.event_type === target) {
    if (!gtEv) return { cls: "bad", reason: "Wrong type" };
    const iou = tIoU(e.start_time, e.end_time, gtEv.start_time, gtEv.end_time);
    if (iou >= IOU_OK) {
      return { cls: "ok", reason: `✓ IoU ${(iou * 100).toFixed(1)}%` };
    }
    if (iou > 0) {
      return { cls: "warn", reason: `Boundary drift, IoU ${(iou * 100).toFixed(1)}%` };
    }
    return { cls: "bad", reason: "No temporal overlap" };
  }

  const other = bestGtMatch(e, gtAll);
  if (other.gt) {
    if (other.iou >= IOU_OK) {
      return { cls: "ok", reason: `✓ IoU ${(other.iou * 100).toFixed(1)}%` };
    }
    if (other.iou > 0) {
      return {
        cls: "warn",
        reason: `Other event, boundary drift, IoU ${(other.iou * 100).toFixed(1)}%`,
      };
    }
    return { cls: "bad", reason: "Other event, no overlap" };
  }
  return { cls: "bad", reason: "Wrong type" };
}

function renderPredRows(events, target, gtEv, gtAll, { isGt = false } = {}) {
  if (!events?.length) {
    return {
      target: '<div class="ev-pair"><div class="reason na">No prediction</div></div>',
      pred: '<div class="ev-pair"><div class="ev na">No prediction</div></div>',
    };
  }

  const n = events.length;
  const severe = n >= HALLUC_THRESH;
  const show = severe ? events.slice(0, MAX_SHOW) : events;

  const targetHtml = [];
  const predHtml = [];

  if (isGt) {
    show.forEach((e) => {
      targetHtml.push(`<div class="ev-pair"><div class="reason gt-dash">—</div></div>`);
      predHtml.push(
        `<div class="ev-pair"><div class="ev gt-black">${esc(e.event_type)} [${fmt(e.start_time)} – ${fmt(e.end_time)}]</div></div>`
      );
    });
  } else {
    show.forEach((e) => {
      const { cls, reason } = evalEvent(e, target, gtEv, gtAll);
      targetHtml.push(`<div class="ev-pair"><div class="reason ${cls}">${esc(reason)}</div></div>`);
      predHtml.push(
        `<div class="ev-pair"><div class="ev ${cls}">${esc(e.event_type)} [${fmt(e.start_time)} – ${fmt(e.end_time)}]</div></div>`
      );
    });
  }

  if (severe) {
    targetHtml.push(
      `<div class="ev-pair"><div class="reason halluc">… (severe hallucination, ${n} events)</div></div>`
    );
    predHtml.push(
      `<div class="ev-pair"><div class="ev halluc">… (severe hallucination, ${n} events)</div></div>`
    );
  } else if (n > MAX_SHOW) {
    targetHtml.push(
      `<div class="ev-pair"><div class="reason halluc">… (+${n - MAX_SHOW} more)</div></div>`
    );
    predHtml.push(
      `<div class="ev-pair"><div class="ev halluc">… (+${n - MAX_SHOW} more)</div></div>`
    );
  }

  return { target: targetHtml.join(""), pred: predHtml.join("") };
}

function drawWaveform() {
  const canvas = document.getElementById("waveCanvas");
  if (!canvas || !audioBuf) return;
  const w = canvas.parentElement.clientWidth || 800;
  canvas.width = w * 2;
  canvas.height = 110 * 2;
  canvas.style.width = w + "px";
  canvas.style.height = "110px";
  const ctx = canvas.getContext("2d");
  const data = audioBuf.getChannelData(0);
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#0f1419";
  ctx.fillRect(0, 0, W, H);
  const step = Math.max(1, Math.ceil(data.length / W));
  ctx.beginPath();
  ctx.strokeStyle = "#6eb5ff";
  ctx.lineWidth = 1.2;
  for (let x = 0; x < W; x++) {
    let mn = 1,
      mx = -1;
    const start = Math.floor((x / W) * data.length);
    for (let j = 0; j < step; j++) {
      const v = data[start + j];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ctx.moveTo(x, ((1 - mx) / 2) * H);
    ctx.lineTo(x, ((1 - mn) / 2) * H);
  }
  ctx.stroke();
}

function renderGtOverlay(s) {
  const lane = document.getElementById("gtLane");
  const markers = document.getElementById("gtMarkers");
  if (!lane || !markers) return;
  lane.innerHTML = "";
  markers.innerHTML = "";

  gtEvents(s).forEach((e) => {
    const band = document.createElement("div");
    band.className = "gt-band";
    const mid = (e.start_time + e.end_time) / 2;
    band.style.left = pct(mid) + "%";
    band.textContent = e.event_type;
    band.title = `${e.event_type} [${fmt(e.start_time)} – ${fmt(e.end_time)}]`;
    lane.appendChild(band);

    [e.start_time, e.end_time].forEach((t, i) => {
      const line = document.createElement("div");
      const isEnd = i === 1;
      line.className = "gt-marker" + (isEnd ? " end" : " start");
      let pos = pct(t);
      // Prevent 2px-wide marker from being clipped by overflow:hidden at container edges
      if (!isEnd && pos <= 0.2) {
        line.style.left = "1px";
      } else if (isEnd && pos >= 99.5) {
        line.style.left = "calc(100% - 1px)";
      } else {
        line.style.left = pos + "%";
      }
      line.title = `${e.event_type} ${isEnd ? "end" : "start"} ${fmt(t)}s`;
      markers.appendChild(line);
    });
  });

  requestAnimationFrame(clampGtBands);
}

function clampGtBands() {
  const lane = document.getElementById("gtLane");
  if (!lane) return;
  const laneW = lane.clientWidth;
  if (!laneW) return;
  const pad = 4;
  lane.querySelectorAll(".gt-band").forEach((band) => {
    const bandW = band.offsetWidth;
    const half = bandW / 2;
    let centerPx = (parseFloat(band.style.left) / 100) * laneW;
    centerPx = Math.max(half + pad, Math.min(laneW - half - pad, centerPx));
    band.style.left = (centerPx / laneW) * 100 + "%";
  });
}

function updatePlayhead() {
  const a = audioEl();
  if (!a) return;
  const el = document.getElementById("playhead");
  const tEl = document.getElementById("timeNow");
  const endEl = document.getElementById("timeEnd");
  if (el) el.style.left = pct(a.currentTime) + "%";
  const dur = a.duration || duration;
  if (tEl) tEl.textContent = `${fmt(a.currentTime)} s / ${fmt(dur)} s`;
  if (endEl && dur) endEl.textContent = `${fmt(dur)} s`;
}

function seekFromClick(e) {
  const wrap = e.currentTarget;
  const rect = wrap.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * duration;
  const a = audioEl();
  if (a) a.currentTime = t;
}

function sampleAudioFile(s) {
  return s.audio_file || (s.audio_path ? s.audio_path.split("/").pop() : "");
}

async function loadAudio(audioFile) {
  if (!audioFile) {
    console.warn("missing audio_file");
    return;
  }
  audioBuf = null;
  duration = 0;
  const a = audioEl();
  if (!a) return;
  const url = "audio/" + encodeURIComponent(audioFile);
  a.src = url;
  a.load();
  a.ontimeupdate = updatePlayhead;
  a.onseeked = updatePlayhead;

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`audio ${r.status}`);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioBuf = await ctx.decodeAudioData(await r.arrayBuffer());
    duration = audioBuf.duration;
    drawWaveform();
    renderGtOverlay(samples[idx]);
    updatePlayhead();
    a.onloadedmetadata = () => {
      duration = a.duration || duration;
      drawWaveform();
      updatePlayhead();
    };
  } catch (err) {
    console.warn("decode:", err);
  }
}

function renderSample(i) {
  idx = i;
  const s = samples[i];
  const target = s.category;
  const gtEv = targetGt(s);
  const gt = gtEvents(s);

  const gtRows = renderPredRows(gt, target, gtEv, gt, { isGt: true });
  const modelRows = MODEL_ORDER.map(([key, name]) => {
    const data = key === "nv_locator" ? s.nv_locator : s.models[key];
    const evs = data?.events || [];
    const rows = renderPredRows(evs, target, gtEv, gt);
    const cls = key === "nv_locator" ? "nv-row" : "";
    return `<tr class="${cls}">
      <td><b>${esc(name)}</b></td>
      <td class="col-pred">${rows.pred}</td>
      <td class="col-target">${rows.target}</td>
    </tr>`;
  }).join("");

  document.getElementById("main").innerHTML = `
    <div class="card">
      <h2>${esc(target)}</h2>
      <div class="asr">${highlightAsr(s.asr, target)}</div>
    </div>

    <div class="card wave-panel">
      <h2>Waveform &amp; Ground Truth</h2>
      <div class="wave-legend">
        <span><i class="legend-dot" style="background:var(--gt)"></i>GT</span>
        <span><i class="legend-dot" style="background:var(--playhead)"></i>Playhead</span>
      </div>
      <div class="wave-stack" id="waveStack">
        <div class="gt-lane" id="gtLane"></div>
        <div class="wave-wrap" id="waveWrap">
          <canvas class="wave-canvas" id="waveCanvas"></canvas>
          <div class="gt-markers" id="gtMarkers"></div>
          <div class="playhead" id="playhead"></div>
        </div>
      </div>
      <div class="time-ruler">
        <span>0.0 s</span>
        <span id="timeEnd">${fmt(duration || 0)} s</span>
      </div>
      <div class="time-now" id="timeNow">0.000 s / 0.000 s</div>
      <audio id="audio" controls preload="auto"></audio>
    </div>

    <div class="card">
      <h2>Model Comparison</h2>
      <table class="cmp-table">
        <thead>
          <tr><th>System</th><th>Predicted Events</th><th>Assessment</th></tr>
        </thead>
        <tbody>
          <tr class="gt-row">
            <td><b>Ground Truth</b></td>
            <td class="col-pred">${gtRows.pred}</td>
            <td class="col-target">${gtRows.target}</td>
          </tr>
          ${modelRows}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById("waveWrap").onclick = seekFromClick;
  document.querySelectorAll(".nav-item").forEach((el, j) => {
    el.classList.toggle("active", j === i);
  });

  loadAudio(sampleAudioFile(s));
}

function buildNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = samples
    .map(
      (s, i) =>
        `<button class="nav-item" data-i="${i}">${esc(s.category)}</button>`
    )
    .join("");
  nav.onclick = (e) => {
    const btn = e.target.closest(".nav-item");
    if (btn) renderSample(+btn.dataset.i);
  };
}

async function init() {
  // Load samples from static JSONL (GitHub Pages compatible — no server needed)
  const r = await fetch("data/samples.jsonl");
  const text = await r.text();
  samples = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  if (!samples.length) {
    document.getElementById("main").innerHTML = "<p class='loading'>No samples.</p>";
    return;
  }
  buildNav();
  renderSample(0);

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" && idx > 0) renderSample(idx - 1);
    if (e.key === "ArrowRight" && idx < samples.length - 1) renderSample(idx + 1);
  });

  window.addEventListener("resize", () => {
    if (audioBuf) drawWaveform();
    clampGtBands();
  });
}

init();
