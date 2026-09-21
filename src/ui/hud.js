// src/ui/hud.js
// Diegetic sci-fi fighter HUD overlay (DOM + CSS only; no three.js, no external assets).
//
// HARD PERFORMANCE RULES honoured here:
//  - Every element is created once at construction (plus one <style> tag).
//  - update() performs ZERO element creation, ZERO innerHTML, ZERO layout reads
//    (no offsetWidth / getBoundingClientRect / clientHeight).
//  - Per frame we only write: style.transform, style.opacity, style.width-free
//    bars (scaleX), and textContent on a fixed set of cached text nodes.
//  - Radar blips come from pre-allocated SVG circle pools (cap 128 total).
//  - resize(w, h) repositions using cached numbers only.
//
// The module touches no DOM at import time; all DOM access happens inside
// createHud(), so importing this file in plain Node is safe.

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RAD2DEG = 180 / Math.PI;
const FOV = (65 * Math.PI) / 180; // assumed HUD focal geometry (vertical)

// Radar geometry (fixed internal px space; positioned by CSS).
const RADAR_SIZE = 190;
const RADAR_R = 82;
const ENEMY_POOL = 96;
const ROCK_POOL = 30; // 96 + 30 + 1 target ring + 1 player marker <= 128 cap
const WARN_POOL = 4;
const DMG_POOL = 6;
const LEAD_MARGIN = 70; // keep the lead indicator inside a safe box around center

// Damage arc: 38-degree arc at radius 62, base pointing screen-right (+x).
// cos(19deg)=0.94552 sin(19deg)=0.32557  ->  62*0.94552=58.62  62*0.32557=20.19
const ARC_D = 'M 58.62 -20.19 A 62 62 0 0 1 58.62 20.19';

const CSS = `
.sh-hud{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:10;
 font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
 color:var(--txt);
 --acc:#7fe7ff;--acc-soft:rgba(127,231,255,.55);--acc-faint:rgba(127,231,255,.18);
 --warn:#ff5a3c;--hot:#ff3b30;--hostile:#ff4d4d;--rock:#8b959e;--txt:#d8f4ff;
 transition:color .25s linear}
.sh-hud[data-theme="alert"]{--acc:#ffb03a;--acc-soft:rgba(255,176,58,.6);--acc-faint:rgba(255,176,58,.2);--txt:#ffe6c8}
.sh-hud *{margin:0;padding:0;box-sizing:border-box}
.sh-vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 55%,rgba(2,6,10,.5) 100%)}
.sh-corner{position:absolute;width:26px;height:26px;border:2px solid var(--acc-soft);opacity:.8}
.sh-corner.tl{left:14px;top:14px;border-right:none;border-bottom:none}
.sh-corner.tr{right:14px;top:14px;border-left:none;border-bottom:none}
.sh-corner.bl{left:14px;bottom:14px;border-right:none;border-top:none}
.sh-corner.br{right:14px;bottom:14px;border-left:none;border-top:none}
.sh-svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.sh-reticle{filter:drop-shadow(0 0 3px var(--acc-soft))}
.sh-ret{fill:none;stroke:var(--acc);stroke-width:1.4;opacity:.9}
.sh-ret-dot{fill:var(--acc)}
.sh-brk{fill:none;stroke:var(--acc);stroke-width:1.6;opacity:.7}
.sh-lead{opacity:0;transform-origin:0 0;will-change:transform}
.sh-lead-halo{fill:none;stroke:var(--acc);stroke-width:4;opacity:.22}
.sh-lead-ring{fill:none;stroke:var(--acc);stroke-width:1.6}
.sh-lead-tick{stroke:var(--acc);stroke-width:1.6}
.sh-lead-dot{fill:var(--acc)}
.sh-dmg{fill:none;stroke:var(--warn);stroke-width:4;stroke-linecap:round;opacity:0;transform-origin:0 0;will-change:transform}
.sh-col{position:absolute;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:16px;width:158px}
.sh-left{left:24px}
.sh-right{right:24px;align-items:flex-end}
.sh-row{display:flex;flex-direction:column;gap:4px}
.sh-right .sh-row{align-items:flex-end}
.sh-lblrow{display:flex;gap:10px;align-items:baseline}
.sh-lbl{font-size:10px;letter-spacing:.22em;color:var(--acc-soft)}
.sh-pct{font-size:10px;letter-spacing:.08em;color:var(--txt);opacity:.75}
.sh-readout{display:flex;gap:6px;align-items:baseline}
.sh-big{font-size:24px;line-height:1;letter-spacing:.04em;text-shadow:0 0 10px var(--acc-soft)}
.sh-unit{font-size:10px;letter-spacing:.16em;color:var(--acc-soft)}
.sh-bar{position:relative;width:158px;height:9px;border:1px solid var(--acc-soft);background:rgba(4,12,18,.5)}
.sh-bar-fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform:scaleX(0);transform-origin:left center;background:linear-gradient(90deg,var(--acc-faint),var(--acc));box-shadow:0 0 8px var(--acc-soft)}
.sh-heatbar.sh-over{border-color:var(--hot)}
.sh-heatbar.sh-over .sh-bar-fill{background:linear-gradient(90deg,#ff9a3c,var(--hot));animation:sh-pulse .45s ease-in-out infinite}
@keyframes sh-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.sh-bl{position:absolute;left:24px;bottom:20px;display:flex;gap:28px;align-items:flex-end}
.sh-stat{display:flex;flex-direction:column;gap:3px}
.sh-perf{position:absolute;right:24px;bottom:20px;display:flex;gap:16px;font-size:10px;letter-spacing:.12em;color:var(--acc-soft);opacity:.7}
.sh-perf .sh-pv{color:var(--txt);font-weight:600}
.sh-radar{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:190px;height:190px}
.sh-rsvg{width:190px;height:190px;display:block}
.sh-r-frame{fill:rgba(4,12,18,.35);stroke:var(--acc-soft);stroke-width:1.2}
.sh-r-line{fill:none;stroke:var(--acc-faint);stroke-width:1}
.sh-r-tick{stroke:var(--acc-soft);stroke-width:1}
.sh-r-player{fill:var(--acc)}
.sh-blip{opacity:0;transform-origin:0 0;will-change:transform}
.sh-blip-e{fill:var(--hostile)}
.sh-blip-a{fill:var(--rock)}
.sh-r-tgt{opacity:0;transform-origin:0 0;will-change:transform}
.sh-r-tgt-ring{fill:none;stroke:var(--acc);stroke-width:1.4}
.sh-r-tgt-dot{fill:var(--acc)}
.sh-warns{position:absolute;left:50%;top:calc(50% - 150px);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px}
.sh-chip{opacity:0;border:1px solid var(--warn);color:var(--warn);background:rgba(30,4,2,.35);padding:3px 14px;font-size:11px;letter-spacing:.24em;white-space:nowrap}
.sh-chip.sh-on{animation:sh-blink .8s ease-in-out infinite}
@keyframes sh-blink{0%,100%{opacity:1}50%{opacity:.15}}
.sh-tinfo{position:absolute;left:50%;top:calc(50% + 64px);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:5px;opacity:0;width:230px}
.sh-tinfo-row{display:flex;gap:14px;font-size:11px;letter-spacing:.16em;color:var(--acc)}
.sh-tbar{width:180px;height:5px}
.sh-tbar .sh-bar-fill{box-shadow:none}
`;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function fmtK(v) {
  v = v || 0;
  const a = v < 0 ? -v : v;
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

function fmtSpeed(v) {
  v = v || 0;
  const a = v < 0 ? -v : v;
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'k';
  return String(Math.round(v));
}

function fmtDist(v) {
  v = v || 0;
  const a = v < 0 ? -v : v;
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'Mm';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'km';
  return Math.round(v) + 'm';
}

// Scratch for worldDirToScreen — never allocate per call.
const _pv = { x: 0, y: 0, depth: 0 };

/**
 * Project a world-space direction into HUD screen space.
 * Camera-independent approximation: assumes the camera faces the player's -Z
 * with +Y up. If `q` (camera/player world quaternion, body->world) is supplied
 * we rotate the vector into camera space with the conjugate first; otherwise we
 * degrade gracefully to the identity assumption.
 * Result written into a shared scratch: { x: screen-right, y: screen-down, depth: forward }.
 */
function worldDirToScreen(dx, dy, dz, q) {
  let vx = dx, vy = dy, vz = dz;
  if (q) {
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    vx = vx + qw * tx + (qy * tz - qz * ty);
    vy = vy + qw * ty + (qz * tx - qx * tz);
    vz = vz + qw * tz + (qx * ty - qy * tx);
  }
  _pv.x = vx;
  _pv.y = -vy; // world up -> screen down-positive
  _pv.depth = -vz; // player faces -Z -> forward is positive depth
  return _pv;
}

// ---------------------------------------------------------------------------
// createHud
// ---------------------------------------------------------------------------

export function createHud(rootEl) {
  const doc =
    (rootEl && rootEl.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);
  if (!doc || !rootEl) {
    throw new TypeError('createHud: rootEl (with an ownerDocument) is required');
  }

  // ---- build-time element helpers ----
  const mk = (tag, cls, parent) => {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute('class', cls);
    if (parent) parent.appendChild(e);
    return e;
  };
  const mkS = (tag, cls, parent) => {
    const e = doc.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute('class', cls);
    if (parent) parent.appendChild(e);
    return e;
  };

  // ---- single scoped <style> injection ----
  const styleEl = doc.createElement('style');
  styleEl.setAttribute('data-sh', 'hud');
  styleEl.textContent = CSS;
  rootEl.appendChild(styleEl);

  const hud = mk('div', 'sh-hud', rootEl);
  hud.setAttribute('data-theme', 'player');

  // Glass vignette + corner frame (static).
  mk('div', 'sh-vig', hud);
  mk('div', 'sh-corner tl', hud);
  mk('div', 'sh-corner tr', hud);
  mk('div', 'sh-corner bl', hud);
  mk('div', 'sh-corner br', hud);

  // ---- center overlay SVG (reticle / lead / damage arcs) ----
  const csvg = mkS('svg', 'sh-svg', hud);
  const cgrp = mkS('g', null, csvg); // translated to screen center on resize

  const reticleG = mkS('g', 'sh-reticle', cgrp);
  const retRing = mkS('circle', 'sh-ret', reticleG);
  retRing.setAttribute('r', '40');
  const retDot = mkS('circle', 'sh-ret-dot', reticleG);
  retDot.setAttribute('r', '2.5');
  // N/E/S/W boresight ticks
  const tickDefs = [
    [0, -28, 0, -40], [0, 28, 0, 40], [-28, 0, -40, 0], [28, 0, 40, 0],
  ];
  for (let i = 0; i < tickDefs.length; i++) {
    const t = tickDefs[i];
    const ln = mkS('line', 'sh-ret', reticleG);
    ln.setAttribute('x1', String(t[0]));
    ln.setAttribute('y1', String(t[1]));
    ln.setAttribute('x2', String(t[2]));
    ln.setAttribute('y2', String(t[3]));
  }
  // corner brackets around the reticle
  const brkDefs = [
    'M -58 -44 L -58 -58 L -44 -58',
    'M 44 -58 L 58 -58 L 58 -44',
    'M 58 44 L 58 58 L 44 58',
    'M -44 58 L -58 58 L -58 44',
  ];
  for (let i = 0; i < brkDefs.length; i++) {
    const p = mkS('path', 'sh-brk', reticleG);
    p.setAttribute('d', brkDefs[i]);
  }

  // Lead indicator (moves; fake glow via a wide translucent halo, no filters).
  const leadG = mkS('g', 'sh-lead', cgrp);
  const leadHalo = mkS('circle', 'sh-lead-halo', leadG);
  leadHalo.setAttribute('r', '15');
  const leadRing = mkS('circle', 'sh-lead-ring', leadG);
  leadRing.setAttribute('r', '15');
  const leadDot = mkS('circle', 'sh-lead-dot', leadG);
  leadDot.setAttribute('r', '2');
  const leadTicks = [
    [0, -15, 0, -22], [0, 15, 0, 22], [-15, 0, -22, 0], [15, 0, 22, 0],
  ];
  for (let i = 0; i < leadTicks.length; i++) {
    const t = leadTicks[i];
    const ln = mkS('line', 'sh-lead-tick', leadG);
    ln.setAttribute('x1', String(t[0]));
    ln.setAttribute('y1', String(t[1]));
    ln.setAttribute('x2', String(t[2]));
    ln.setAttribute('y2', String(t[3]));
  }

  // Damage direction arcs (pool; rotated around the reticle center).
  const arcs = new Array(DMG_POOL);
  for (let i = 0; i < DMG_POOL; i++) {
    const p = mkS('path', 'sh-dmg', cgrp);
    p.setAttribute('d', ARC_D);
    arcs[i] = p;
  }

  // ---- target info (below reticle) ----
  const tinfo = mk('div', 'sh-tinfo', hud);
  const tinfoRow = mk('div', 'sh-tinfo-row', tinfo);
  const tName = mk('span', 'sh-tname', tinfoRow);
  const tDist = mk('span', 'sh-tdist', tinfoRow);
  const tBar = mk('div', 'sh-bar sh-tbar', tinfo);
  const tFill = mk('div', 'sh-bar-fill', tBar);

  // ---- left column: THR / SPD / ALT ----
  const left = mk('div', 'sh-col sh-left', hud);
  const thrRow = mk('div', 'sh-row', left);
  mk('span', 'sh-lbl', thrRow).textContent = 'THR';
  const thrBar = mk('div', 'sh-bar', thrRow);
  const thrFill = mk('div', 'sh-bar-fill', thrBar);
  const spdRow = mk('div', 'sh-row', left);
  mk('span', 'sh-lbl', spdRow).textContent = 'SPD';
  const spdOut = mk('div', 'sh-readout', spdRow);
  const spdVal = mk('span', 'sh-big', spdOut);
  mk('span', 'sh-unit', spdOut).textContent = 'M/S';
  const altRow = mk('div', 'sh-row', left);
  mk('span', 'sh-lbl', altRow).textContent = 'ALT';
  const altOut = mk('div', 'sh-readout', altRow);
  const altVal = mk('span', 'sh-big', altOut);
  mk('span', 'sh-unit', altOut).textContent = 'M';

  // ---- right column: HULL / SHLD / WPN HEAT ----
  const right = mk('div', 'sh-col sh-right', hud);
  const mkGauge = (label, extraCls) => {
    const row = mk('div', 'sh-row', right);
    const lr = mk('div', 'sh-lblrow', row);
    mk('span', 'sh-lbl', lr).textContent = label;
    const pct = mk('span', 'sh-pct', lr);
    const bar = mk('div', extraCls ? 'sh-bar ' + extraCls : 'sh-bar', row);
    const fill = mk('div', 'sh-bar-fill', bar);
    return { bar, fill, pct };
  };
  const hull = mkGauge('HULL');
  const shld = mkGauge('SHLD');
  const heat = mkGauge('WPN HEAT', 'sh-heatbar');

  // ---- bottom-left: SCORE / COMBO / WAVE ----
  const bl = mk('div', 'sh-bl', hud);
  const scoreStat = mk('div', 'sh-stat', bl);
  mk('span', 'sh-lbl', scoreStat).textContent = 'SCORE';
  const scoreVal = mk('span', 'sh-big', scoreStat);
  const comboStat = mk('div', 'sh-stat', bl);
  mk('span', 'sh-lbl', comboStat).textContent = 'COMBO';
  const comboVal = mk('span', 'sh-big', comboStat);
  const waveStat = mk('div', 'sh-stat', bl);
  mk('span', 'sh-lbl', waveStat).textContent = 'WAVE';
  const waveVal = mk('span', 'sh-big', waveStat);

  // ---- bottom-right: perf readout (small, dim) ----
  const perf = mk('div', 'sh-perf', hud);
  const mkPerf = (label) => {
    const s = mk('span', 'sh-p', perf);
    s.appendChild(doc.createTextNode(label + ' '));
    const v = mk('span', 'sh-pv', s);
    return v;
  };
  const fpsVal = mkPerf('FPS');
  const dcVal = mkPerf('DC');
  const triVal = mkPerf('TRI');

  // ---- center-bottom: radar (SVG sphere-ish projection) ----
  const radarWrap = mk('div', 'sh-radar', hud);
  const rsvg = mkS('svg', 'sh-rsvg', radarWrap);
  rsvg.setAttribute('viewBox', '0 0 ' + RADAR_SIZE + ' ' + RADAR_SIZE);
  const rg = mkS('g', null, rsvg);
  rg.setAttribute(
    'transform',
    'translate(' + RADAR_SIZE / 2 + ',' + RADAR_SIZE / 2 + ')'
  );
  const rFrame = mkS('circle', 'sh-r-frame', rg);
  rFrame.setAttribute('r', '88');
  // sphere-ish graticule: equator + two meridians + cross ticks
  const rEq = mkS('ellipse', 'sh-r-line', rg);
  rEq.setAttribute('rx', '82');
  rEq.setAttribute('ry', '26');
  const rM1 = mkS('ellipse', 'sh-r-line', rg);
  rM1.setAttribute('rx', '30');
  rM1.setAttribute('ry', '82');
  const rM2 = mkS('ellipse', 'sh-r-line', rg);
  rM2.setAttribute('rx', '60');
  rM2.setAttribute('ry', '82');
  const rTickDefs = [
    [0, -92, 0, -84], [0, 84, 0, 92], [-92, 0, -84, 0], [84, 0, 92, 0],
  ];
  for (let i = 0; i < rTickDefs.length; i++) {
    const t = rTickDefs[i];
    const ln = mkS('line', 'sh-r-tick', rg);
    ln.setAttribute('x1', String(t[0]));
    ln.setAttribute('y1', String(t[1]));
    ln.setAttribute('x2', String(t[2]));
    ln.setAttribute('y2', String(t[3]));
  }
  const rPlayer = mkS('path', 'sh-r-player', rg);
  rPlayer.setAttribute('d', 'M 0 -6 L 4 4 L -4 4 Z');

  const eBlips = new Array(ENEMY_POOL);
  for (let i = 0; i < ENEMY_POOL; i++) {
    const c = mkS('circle', 'sh-blip sh-blip-e', rg);
    c.setAttribute('r', '3');
    eBlips[i] = c;
  }
  const aBlips = new Array(ROCK_POOL);
  for (let i = 0; i < ROCK_POOL; i++) {
    const c = mkS('circle', 'sh-blip sh-blip-a', rg);
    c.setAttribute('r', '2.2');
    aBlips[i] = c;
  }
  const tgtG = mkS('g', 'sh-r-tgt', rg);
  const tgtRing = mkS('circle', 'sh-r-tgt-ring', tgtG);
  tgtRing.setAttribute('r', '7');
  const tgtDot = mkS('circle', 'sh-r-tgt-dot', tgtG);
  tgtDot.setAttribute('r', '2');

  // ---- warnings (blinking chips near the reticle) ----
  const warnsBox = mk('div', 'sh-warns', hud);
  const chips = new Array(WARN_POOL);
  for (let i = 0; i < WARN_POOL; i++) {
    chips[i] = mk('div', 'sh-chip', warnsBox);
  }

  // ---- cached state ----
  let W = 1280;
  let H = 720;
  let focal = (H * 0.5) / Math.tan(FOV * 0.5);
  let themeCur = 'player';
  let overOn = false;
  let disposed = false;
  const chipOn = new Array(WARN_POOL).fill(false);
  const last = Object.create(null);

  function setText(node, key, v) {
    if (last[key] !== v) {
      last[key] = v;
      node.textContent = v;
    }
  }

  // ------------------------------------------------------------------
  // update — per-frame. Writes ONLY transform/opacity + cached textContent.
  // ------------------------------------------------------------------
  function update(snap, dt) {
    if (disposed || !snap) return;

    const maxHp = snap.maxHealth > 0 ? snap.maxHealth : 1;
    const hp = clamp01((snap.health || 0) / maxHp);
    const maxSh = snap.maxShield > 0 ? snap.maxShield : 1;
    const sh = clamp01((snap.shield || 0) / maxSh);
    const heatV = clamp01(snap.heat || 0);
    const warns = snap.warnings;
    const nWarn = warns ? warns.length : 0;

    // theme: alert when hull low or warnings present
    const theme = hp < 0.35 || nWarn > 0 ? 'alert' : 'player';
    if (theme !== themeCur) {
      themeCur = theme;
      hud.setAttribute('data-theme', theme);
    }

    // bars (scaleX only)
    thrFill.style.transform = 'scaleX(' + clamp01(snap.throttle || 0) + ')';
    hull.fill.style.transform = 'scaleX(' + hp + ')';
    shld.fill.style.transform = 'scaleX(' + sh + ')';
    heat.fill.style.transform = 'scaleX(' + heatV + ')';
    setText(hull.pct, 'hp', Math.round(hp * 100) + '%');
    setText(shld.pct, 'sh', Math.round(sh * 100) + '%');
    setText(heat.pct, 'ht', Math.round(heatV * 100) + '%');

    const ov = !!snap.overheat;
    if (ov !== overOn) {
      overOn = ov;
      heat.bar.classList.toggle('sh-over', ov);
    }

    // numeric readouts
    setText(spdVal, 'spd', fmtSpeed(snap.speed));
    setText(altVal, 'alt', fmtDist(snap.altitude));
    setText(scoreVal, 'sc', String(Math.round(snap.score || 0)));
    setText(comboVal, 'cb', 'x' + (snap.combo > 0 ? (snap.combo | 0) : 0));
    setText(waveVal, 'wv', String(snap.wave | 0));
    setText(fpsVal, 'fps', String(Math.round(snap.fps || 0)));
    setText(dcVal, 'dc', String(snap.drawCalls | 0));
    setText(triVal, 'tri', fmtK(snap.triangles));

    // lead indicator + target info
    const t = snap.target;
    if (t && t.lead) {
      const p = worldDirToScreen(t.lead.x, t.lead.y, t.lead.z, snap.camQuat);
      let sx, sy;
      if (p.depth > 0.08) {
        sx = (focal * p.x) / p.depth;
        sy = (focal * p.y) / p.depth;
      } else {
        // target behind/at camera: shove to the edge along its lateral direction
        let vx = p.x, vy = p.y;
        if (vx === 0 && vy === 0) vy = 1;
        const k = 4000 / Math.sqrt(vx * vx + vy * vy);
        sx = vx * k;
        sy = vy * k;
      }
      const mx = W * 0.5 - LEAD_MARGIN;
      const my = H * 0.5 - LEAD_MARGIN;
      if (sx > mx) sx = mx;
      else if (sx < -mx) sx = -mx;
      if (sy > my) sy = my;
      else if (sy < -my) sy = -my;
      leadG.style.transform =
        'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
      leadG.style.opacity = '1';
      setText(tName, 'tn', t.name != null ? String(t.name) : '--');
      setText(tDist, 'td', fmtDist(t.dist));
      tFill.style.transform = 'scaleX(' + clamp01(t.health) + ')';
      tinfo.style.opacity = '1';
    } else {
      if (leadG.style.opacity !== '0') leadG.style.opacity = '0';
      if (tinfo.style.opacity !== '0') tinfo.style.opacity = '0';
    }

    // radar blips: groups of 4 (x, y, z, kind).
    // kind: 0 player (static marker), 1 enemy (red), 2 asteroid (grey), 3 target (ringed)
    const rd = snap.radar;
    let ne = 0, na = 0, tgtSeen = false;
    if (rd && rd.length) {
      const rr = snap.radarRange > 0 ? snap.radarRange : 1;
      const s = RADAR_R / rr;
      const n = rd.length - 3;
      for (let i = 0; i < n; i += 4) {
        const kind = rd[i + 3] | 0;
        if (kind === 0) continue;
        let px = rd[i] * s;
        // pseudo-3D: forward (-z) maps up, world +y adds lift -> sphere-ish
        let py = rd[i + 2] * s * 0.78 - rd[i + 1] * s * 0.5;
        const m = Math.sqrt(px * px + py * py);
        if (m > RADAR_R) {
          const c = RADAR_R / m;
          px *= c;
          py *= c;
        }
        const tr =
          'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px)';
        if (kind === 3) {
          tgtG.style.transform = tr;
          tgtG.style.opacity = '1';
          tgtSeen = true;
        } else if (kind === 1 && ne < ENEMY_POOL) {
          const b = eBlips[ne++];
          b.style.transform = tr;
          b.style.opacity = '1';
        } else if (kind === 2 && na < ROCK_POOL) {
          const b = aBlips[na++];
          b.style.transform = tr;
          b.style.opacity = '1';
        }
      }
    }
    for (let i = ne; i < ENEMY_POOL; i++) {
      if (eBlips[i].style.opacity !== '0') eBlips[i].style.opacity = '0';
    }
    for (let i = na; i < ROCK_POOL; i++) {
      if (aBlips[i].style.opacity !== '0') aBlips[i].style.opacity = '0';
    }
    if (!tgtSeen && tgtG.style.opacity !== '0') tgtG.style.opacity = '0';

    // warnings
    for (let i = 0; i < WARN_POOL; i++) {
      const c = chips[i];
      if (i < nWarn) {
        setText(c, 'w' + i, String(warns[i]));
        if (!chipOn[i]) {
          chipOn[i] = true;
          c.classList.add('sh-on');
        }
      } else if (chipOn[i]) {
        chipOn[i] = false;
        c.classList.remove('sh-on');
      }
    }

    // damage direction arcs around the reticle
    const dd = snap.damageDirs;
    let nd = 0;
    if (dd && dd.length) {
      const n = dd.length - 2;
      for (let i = 0; i < n && nd < DMG_POOL; i += 3, nd++) {
        const p = worldDirToScreen(dd[i], dd[i + 1], dd[i + 2], snap.camQuat);
        const vx = p.x, vy = p.y;
        let ang;
        if (Math.abs(vx) + Math.abs(vy) < 0.15) {
          // normal mostly along the view axis: ahead -> top, behind -> bottom
          ang = p.depth > 0 ? -90 : 90;
        } else {
          ang = Math.atan2(vy, vx) * RAD2DEG;
        }
        const a = arcs[nd];
        a.style.transform = 'rotate(' + ang.toFixed(1) + 'deg)';
        a.style.opacity = (1 - nd * 0.12).toFixed(2);
      }
    }
    for (let i = nd; i < DMG_POOL; i++) {
      if (arcs[i].style.opacity !== '0') arcs[i].style.opacity = '0';
    }
  }

  // ------------------------------------------------------------------
  // resize — cached numbers only; one group transform write.
  // ------------------------------------------------------------------
  function resize(w, h) {
    W = w > 0 ? w : 1;
    H = h > 0 ? h : 1;
    focal = (H * 0.5) / Math.tan(FOV * 0.5);
    cgrp.setAttribute(
      'transform',
      'translate(' + (W * 0.5) + ',' + (H * 0.5) + ')'
    );
  }

  // Initial sizing from the window when available, else a sane default.
  const win = typeof window !== 'undefined' ? window : null;
  resize(
    win && win.innerWidth > 0 ? win.innerWidth : 1280,
    win && win.innerHeight > 0 ? win.innerHeight : 720
  );

  // ------------------------------------------------------------------
  // dispose — remove injected nodes.
  // ------------------------------------------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    else if (styleEl.remove) styleEl.remove();
    if (hud.parentNode) hud.parentNode.removeChild(hud);
    else if (hud.remove) hud.remove();
  }

  return { update, resize, dispose };
}
