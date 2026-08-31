// ============================================================
// Endless Core - core game logic
// ============================================================

// ---------- Cross-platform bridge ----------
// This single game.js ships to three hosts: the web build (distributed via
// the Playgama Bridge SDK, window.bridge — see the SDK bootstrap section
// further down) and the Capacitor-wrapped iOS and Android apps.
// isNativeMobile is the one flag that tells the rest of the file whether a
// native platform bridge is live at all (or on Bridge's own presence, which
// is simply absent/inert on native) rather than assuming any one platform;
// isAndroidNative further distinguishes Android from iOS for the handful of
// things that genuinely differ between them (AdMob ad unit IDs — the two
// are separate apps in the AdMob account with distinct IDs per ad format;
// Game Center has no Android equivalent wired up yet).
const isNativeMobile = typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const isAndroidNative = isNativeMobile && !!(window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android');

// Resolves once window.bridge.initialize() settles — every Bridge API call
// must wait on this (Playgama's own #1 required integration rule). null
// until initPlayablesSDK() runs; guarded everywhere it's read since several
// storageSet() calls happen before that (module-eval-time state loading).
let bridgeReadyPromise = null;

// ---------- Safe storage wrapper ----------
// localStorage can throw synchronously (SecurityError) rather than just
// being unavailable — this happens in a sandboxed iframe without
// allow-same-origin (a realistic embed scenario for a hosted/Playables-style
// platform), and in some strict browser privacy modes. An uncaught throw
// here would previously kill the entire script before anything rendered, so
// every persistence feature routes through storageGet/storageSet, which
// fall back to an in-memory store instead. The game stays fully playable —
// it just won't remember progress between sessions in that case.
const memoryStorage = {};
let storageAvailable = true;
try {
  const testKey = '__ec_storage_test__';
  localStorage.setItem(testKey, '1');
  localStorage.removeItem(testKey);
} catch {
  storageAvailable = false;
}

function storageGet(key) {
  if (!storageAvailable) return Object.prototype.hasOwnProperty.call(memoryStorage, key) ? memoryStorage[key] : null;
  try {
    return localStorage.getItem(key);
  } catch {
    storageAvailable = false;
    return Object.prototype.hasOwnProperty.call(memoryStorage, key) ? memoryStorage[key] : null;
  }
}

// Raw write with no platform-mirror side effect — exists only so
// sdkSaveIfAvailable() can stamp its own bookkeeping key (see
// ec_save_savedAt further down) without recursing into itself via
// storageSet's own sdkSaveIfAvailable() call below.
function storageSetRaw(key, value) {
  if (!storageAvailable) {
    memoryStorage[key] = value;
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    storageAvailable = false;
    memoryStorage[key] = value;
  }
}

function storageSet(key, value) {
  storageSetRaw(key, value);
  sdkSaveIfAvailable(); // mirror to the platform save, best-effort (defined further down)
}

// ---------- Canvas setup ----------
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const BLOCK = 40; // logical pixels per block (1 block = 1 "meter")
const LOGICAL_H = 640;

// COLS is derived from the device's actual viewport aspect at load time,
// not hardcoded — a fixed 9-column (9:16 portrait) canvas produced heavy
// black-bar letterboxing on anything wider (PC, landscape, a YouTube
// Playables frame is often wide). Solving COLS so LOGICAL_W/LOGICAL_H
// matches the real viewport aspect makes resizeCanvas()'s existing
// letterbox-fit below land on a near-exact match — filling the screen
// with zero (or negligible) bars on any device, portrait or landscape —
// without changing per-block gameplay balance (stone/gold density, near-miss
// margins, drill hitboxes, etc. are all defined relative to BLOCK, not COLS).
// Clamped to [9, 26] so extreme aspect ratios still play sensibly.
const MIN_COLS = 9;
const MAX_COLS = 26;
const initialAspect = window.innerWidth / window.innerHeight;
// A freshly-created WebView/tab can still report 0x0 before its first
// layout pass, making initialAspect (and everything derived from it) NaN —
// and since COLS is a one-time const, that would permanently break rendering
// for the rest of the session. Fall back to the original 9-column portrait
// count in that case rather than trusting an unfinished layout.
const computedCols = Math.round((initialAspect * LOGICAL_H) / BLOCK);
const COLS = clamp(Number.isFinite(computedCols) ? computedCols : MIN_COLS, MIN_COLS, MAX_COLS);
const LOGICAL_W = COLS * BLOCK;

// The canvas's actual pixel buffer was fixed at the logical game resolution
// (e.g. 360-1040 x 640) and then CSS-stretched to fill the real screen —
// on any Retina/high-DPI device (every current iPhone) that means the
// browser is upscaling a low-res buffer, which reads as soft/blurry
// ("doesn't look HD"). Rendering at devicePixelRatio instead — while every
// draw call still uses the same logical coordinates via ctx.scale below —
// fixes that without touching a single line of game/render logic. Capped
// at 3x: backing-buffer cost scales with DPR², and there's no visible
// sharpness gain past 3x on a canvas this size, just wasted fill-rate on
// displays that report a higher ratio than they have the GPU headroom for.
const DPR = Math.min(window.devicePixelRatio || 1, 3);
canvas.width = LOGICAL_W * DPR;
canvas.height = LOGICAL_H * DPR;
ctx.scale(DPR, DPR);

// The internal logical resolution (LOGICAL_W/H) is fixed once COLS is
// chosen above — the CSS display size always stretches to exactly fill the
// viewport, full-bleed, on every device. COLS quantizes to whole columns at
// a fixed 40px BLOCK, so LOGICAL_W/H can never match an arbitrary device's
// aspect ratio pixel-for-pixel; preserving that aspect ratio (the previous
// approach) meant a residual letterbox gap was mathematically unavoidable —
// small, but real, and visible on-device. Stretching instead guarantees
// zero black bars on any screen, at the cost of blocks rendering as very
// slightly non-square rectangles on devices whose aspect doesn't land
// exactly on a whole COLS value. Entity positions live entirely in the
// fixed logical space regardless, so nothing needs to be rescaled/clamped
// per-entity here. Wrapped in try/catch regardless (belt-and-suspenders
// safety for a handler that can fire before other module state settles).
let resizeCanvasRetries = 0;
function resizeCanvas() {
  try {
    // A freshly-loaded page can momentarily report 0x0 before its first
    // layout pass (the same race that made COLS need a NaN guard above) —
    // skip committing a broken size rather than leaving the canvas stuck
    // permanently invisible, since unlike COLS this isn't a one-time value:
    // there's no later 'resize' event to self-correct a viewport that never
    // actually changes size again after this bad initial read. Retries via
    // setTimeout, not requestAnimationFrame — rAF can be paused entirely
    // for a backgrounded/non-visible document (confirmed while testing: a
    // background tab never re-fired it, leaving the canvas stuck), whereas
    // a timer still eventually runs. Capped so a genuinely broken
    // environment can't retry forever.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > 0 && h > 0) {
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      resizeCanvasRetries = 0;
    } else if (resizeCanvasRetries < 30) {
      resizeCanvasRetries++;
      setTimeout(resizeCanvas, 50);
    }
  } catch (e) {
    // never let a resize/orientation event throw and break the page
  }
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', resizeCanvas);
resizeCanvas();

// ---------- Audio: procedural sound effects (Web Audio API, no files) ----------
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = AudioContextClass ? new AudioContextClass() : null;

// Every sound routes through this single master gain instead of straight to
// destination, so muteAudio()/unmuteAudio() (used while a rewarded ad plays)
// can duck ALL game audio with one node instead of tracking each oscillator.
const masterGain = audioCtx ? audioCtx.createGain() : null;
if (masterGain) {
  masterGain.gain.value = 1;
  masterGain.connect(audioCtx.destination);
}

function muteAudio() {
  if (masterGain) masterGain.gain.value = 0;
}

function unmuteAudio() {
  if (masterGain) masterGain.gain.value = 1;
}

// Player-preference mute (Settings screen), deliberately separate from
// muteAudio()/unmuteAudio() above (SDK pause / ad-watching) rather than a
// shared refactor — those two are already shipped and verified, and this
// is the one additional gate that needs to compose with them without
// risking a regression there. Restoring audio only when nothing else is
// currently suppressing it (isPaused / platform mute) avoids the one real
// edge case: unmuting mid-SDK-pause would otherwise fight handleSdkPause()'s
// own duck.
function applyAudioMutePreference() {
  if (!masterGain) return;
  if (state.audioMuted) {
    masterGain.gain.value = 0;
  } else if (!isPaused && sdkAudioEnabled) {
    masterGain.gain.value = 1;
  }
}

// Shared 1-second white-noise buffer, generated once and reused for every
// noise-based effect below — pure oscillators can't produce "crunch" or
// "rumble" no matter how they're pitched, which is why dig/hit/explosion
// previously sounded thin. A short filtered burst from real noise is what
// actually reads as impact/texture; layered under the existing tone rather
// than replacing it.
const noiseBuffer = audioCtx ? (function () {
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
})() : null;

function playNoiseBurst(now, duration, peakGain, filterFreq, filterType, filterQ) {
  if (!noiseBuffer || !sdkAudioEnabled) return;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  filter.Q.value = filterQ;
  const gain = audioCtx.createGain();
  src.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  src.start(now);
  src.stop(now + duration + 0.02);
}

// Separate from muteAudio()/unmuteAudio() above (which duck gain to 0 during
// a rewarded ad): this reflects the host platform's own mute state via
// bridge.platform.isAudioEnabled / AUDIO_STATE_CHANGED. The spec requires
// zero sound nodes while platform-muted, not just silent output, so
// playSound() checks this and returns before creating any AudioNode at all.
let sdkAudioEnabled = true;

function applySdkAudioState(enabled) {
  sdkAudioEnabled = !!enabled;
  // The ambient pad is continuous, not a one-shot like playSound() — it can
  // already be running when this fires mid-run, so unlike every other sound
  // it needs an explicit response here instead of just gating future
  // playSound() calls.
  if (sdkAudioEnabled && state.running) {
    ambientPadFadeIn(); // also creates the pad now if it never started (e.g. player began muted)
  } else if (!sdkAudioEnabled && ambientNodes) {
    ambientPadFadeOut();
  }
}

// Browsers start the context suspended until it's resumed inside a user
// gesture handler. Listening once for the very first pointer/key press
// (Start Drilling, a keyboard steer, etc.) covers the "resume after first
// gesture" requirement without wiring resume() into every button.
function unlockAudio() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}
if (audioCtx) {
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
}

// Chrome logs a console error (which fails the Playables compliance check)
// for navigator.vibrate() calls before any real user gesture — and unlike
// the AudioContext case above, that happens on the FIRST call, not just
// once early on: a cold-load toast (the login streak reward, which can fire
// before Start Drilling is ever tapped) hits this every time, not only on
// first launch. Tracked separately from audioCtx's own unlock above since
// this needs to gate vibrateHaptic() regardless of whether Web Audio exists.
let hasUserGestured = false;
window.addEventListener('pointerdown', () => { hasUserGestured = true; }, { once: true });
window.addEventListener('keydown', () => { hasUserGestured = true; }, { once: true });

// Synthesizes a short one-shot sound with an OscillatorNode + GainNode —
// no audio files. The gain envelope always ramps up from near-silence and
// back down to near-silence so starting/stopping the oscillator never pops.
function playSound(type) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  if (!sdkAudioEnabled) return; // platform-muted: create zero sound nodes

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(masterGain);

  const now = audioCtx.currentTime;
  let duration;
  let peakGain;

  if (type === 'coin') {
    // short sine blip that rises in pitch — a bright "collected" chime.
    // A second voice a fifth above (detuned slightly for width) turns the
    // single blip into an actual chime instead of a flat beep.
    osc.type = 'sine';
    duration = 0.12;
    peakGain = 0.22;
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(1300, now + duration * 0.8);

    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sine';
    osc2.connect(gain2);
    gain2.connect(masterGain);
    osc2.frequency.setValueAtTime(752, now); // ~perfect fifth above 500Hz
    osc2.frequency.exponentialRampToValueAtTime(1955, now + duration * 0.8);
    gain2.gain.setValueAtTime(0.0001, now);
    gain2.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc2.start(now);
    osc2.stop(now + duration + 0.02);
  } else if (type === 'hit') {
    // harsh square wave that drops in pitch, PLUS a low filtered noise
    // thump underneath — the noise layer is what actually reads as
    // physical impact; the oscillator alone was just a pitched beep.
    osc.type = 'square';
    duration = 0.18;
    peakGain = 0.22;
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + duration);
    playNoiseBurst(now, 0.15, 0.22, 700, 'lowpass', 1);
  } else if (type === 'dig') {
    // quiet low thump plus a very short high-passed noise tick — dirt
    // breaking should sound gritty, not like a pure tone.
    osc.type = 'sine';
    duration = 0.05;
    peakGain = 0.04;
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + duration);
    playNoiseBurst(now, 0.04, 0.06, 2800, 'bandpass', 1.4);
  } else if (type === 'relic') {
    // high-pitched sine sweep — a bright, unmistakable "rare find" chime
    osc.type = 'sine';
    duration = 0.3;
    peakGain = 0.3;
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(2400, now + duration * 0.6);
  } else if (type === 'explosion') {
    // low harsh square rumble dropping fast, layered under a real low-passed
    // noise blast — a pitched oscillator alone can't sound like an
    // explosion no matter how it's tuned; noise is what carries the "boom."
    osc.type = 'square';
    duration = 0.35;
    peakGain = 0.28;
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + duration);
    playNoiseBurst(now, 0.4, 0.32, 280, 'lowpass', 0.9);
  } else if (type === 'toast') {
    // tiny upward blip — a soft "ping" for contract-complete notifications
    osc.type = 'sine';
    duration = 0.1;
    peakGain = 0.18;
    osc.frequency.setValueAtTime(700, now);
    osc.frequency.exponentialRampToValueAtTime(1000, now + duration);
  } else if (type === 'overdrive') {
    // big rising sawtooth sweep — unmistakable "power up" for Overdrive trigger
    osc.type = 'sawtooth';
    duration = 0.5;
    peakGain = 0.3;
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + duration);
  } else if (type === 'pulverize') {
    // short bright crunch/zap plus a high-passed noise crackle — Overdrive
    // smashing through a Stone/Gas block
    osc.type = 'square';
    duration = 0.09;
    peakGain = 0.18;
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + duration);
    playNoiseBurst(now, 0.08, 0.16, 1900, 'highpass', 1);
  } else {
    return;
  }

  // exponentialRampToValueAtTime can't target 0, so use a near-zero floor —
  // this is what keeps the fade-out click/pop-free at start and end.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.start(now);
  osc.stop(now + duration + 0.02);
}

// ---------- Audio: ambient pad ----------
// A continuous low, filtered drone under an active run — the game was
// otherwise silent between one-shot blips, which is a big part of why it
// read as "empty" rather than atmospheric. Two detuned sawtooth oscillators
// through a lowpass filter (detune gives it width/movement instead of a
// static single tone), with a slow LFO breathing the filter cutoff so it's
// never perfectly static. Routes through masterGain like every other sound,
// so muteAudio()/unmuteAudio() (ad breaks) and the platform mute both
// silence it automatically with zero extra wiring.
let ambientNodes = null;
let lastAmbientBiomeName = null;

function ensureAmbientPad() {
  if (ambientNodes || !audioCtx) return;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(masterGain);

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;
  filter.Q.value = 0.6;
  filter.connect(gain);

  const osc1 = audioCtx.createOscillator();
  osc1.type = 'sawtooth';
  osc1.frequency.value = 55;
  osc1.connect(filter);

  const osc2 = audioCtx.createOscillator();
  osc2.type = 'sawtooth';
  osc2.frequency.value = 55.6; // slight detune — width, not a static tone
  osc2.connect(filter);

  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.08; // very slow breathing, ~12s cycle
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 150; // filter cutoff swings +-150Hz around its base
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);

  osc1.start();
  osc2.start();
  lfo.start();

  ambientNodes = { gain, filter, osc1, osc2 };
}

function ambientPadFadeIn() {
  // Same "zero sound nodes while platform-muted" requirement every other
  // sound respects (see playSound()'s sdkAudioEnabled check) — without this,
  // starting/resuming a run while already platform-muted would still spin
  // up 3 continuous OscillatorNodes, just silenced via gain instead of never
  // created at all.
  if (!audioCtx || !sdkAudioEnabled) return;
  ensureAmbientPad();
  const now = audioCtx.currentTime;
  ambientNodes.gain.gain.cancelScheduledValues(now);
  ambientNodes.gain.gain.setValueAtTime(ambientNodes.gain.gain.value, now);
  ambientNodes.gain.gain.linearRampToValueAtTime(0.05, now + 1.5);
  lastAmbientBiomeName = null; // force the next updateAmbientPad() to re-apply biome tone
}

function ambientPadFadeOut() {
  if (!audioCtx || !ambientNodes) return;
  const now = audioCtx.currentTime;
  ambientNodes.gain.gain.cancelScheduledValues(now);
  ambientNodes.gain.gain.setValueAtTime(ambientNodes.gain.gain.value, now);
  ambientNodes.gain.gain.linearRampToValueAtTime(0.0001, now + 0.8);
}

// Shifts the pad's tone per biome instead of leaving it static for an entire
// run: Dirt is neutral, Ice brighter/colder (higher filter cutoff, higher
// pitch), Magma lower and more rumbling (lower cutoff, lower pitch). Cheap
// to call often — only does real work when the biome actually changed.
function updateAmbientPad() {
  if (!ambientNodes || !audioCtx) return;
  const biome = getBiome(currentDepthMeters());
  if (biome.name === lastAmbientBiomeName) return;
  lastAmbientBiomeName = biome.name;

  let targetCutoff = 400;
  let targetPitch = 55;
  if (biome.name === 'Ice') { targetCutoff = 900; targetPitch = 65; }
  else if (biome.name === 'Magma') { targetCutoff = 220; targetPitch = 44; }

  const now = audioCtx.currentTime;
  ambientNodes.filter.frequency.setTargetAtTime(targetCutoff, now, 2.5);
  ambientNodes.osc1.frequency.setTargetAtTime(targetPitch, now, 3);
  ambientNodes.osc2.frequency.setTargetAtTime(targetPitch * 1.011, now, 3);
}

const DIG_SOUND_CHANCE = 0.2; // "occasionally", not on every single dirt block

// ---------- Lightweight 2D Perlin Noise (no external libs) ----------
const NoiseGen = (function () {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates shuffle with a fixed seed for deterministic terrain
  let seed = 1337;
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(t, a, b) { return a + t * (b - a); }
  function grad(hash, x, y) {
    const h = hash & 7;
    const gx = 1 + (h & 3); // 1..4
    const gxSigned = (h & 4) ? -gx : gx;
    const gy = 1 + ((h >> 1) & 3);
    const gySigned = (h & 2) ? -gy : gy;
    return gxSigned * x + gySigned * y;
  }

  function noise2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];

    const x1 = lerp(u, grad(aa, xf, yf), grad(ba, xf - 1, yf));
    const x2 = lerp(u, grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1));
    // raw output roughly in [-1, 1] -> normalize to [0, 1]
    return (lerp(v, x1, x2) + 1) / 2;
  }

  return { noise2D };
})();

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ---------- Block types ----------
const EMPTY = 0;
const DIRT = 1;
const STONE = 2;
const GOLD = 3;
const CHEST = 4;
const RELIC = 5;
const GAS = 6;
const DIAMOND = 7;

// ---------- Biomes (depth-based zones) ----------
// Row index === depth in meters (BLOCK = 40px = 1m), so a row's biome is
// just getBiome(rowIndex). Only DIRT/STONE recolor per zone — GOLD/CHEST/
// RELIC keep fixed colors so they always read as "special" at a glance.
const BIOMES = [
  {
    name: 'Dirt',
    minDepth: 0,
    dirtColor: '#6b4423',
    stoneColor: '#6e6e73',
    bgColor: '#1a1a2e',
    hudColor: '#ffffff',
    speedMultiplier: 1.0,
    fuelMultiplier: 1.0,
  },
  {
    name: 'Ice',
    minDepth: 1000,
    dirtColor: '#e3f2fd',
    stoneColor: '#37699e',
    bgColor: '#0d2436',
    hudColor: '#81d4fa',
    speedMultiplier: 1.2, // sliding — harder to control
    fuelMultiplier: 1.0,
  },
  {
    name: 'Magma',
    minDepth: 2500,
    dirtColor: '#7a2811',
    stoneColor: '#ff6f30',
    bgColor: '#2b0d05',
    hudColor: '#ff8a65',
    speedMultiplier: 1.0,
    fuelMultiplier: 1.5, // extreme heat drains fuel faster
  },
];

function getBiome(depthMeters) {
  let biome = BIOMES[0];
  for (const b of BIOMES) {
    if (depthMeters >= b.minDepth) biome = b;
  }
  return biome;
}

function currentDepthMeters() {
  return Math.max(0, Math.floor(drill.worldY / BLOCK));
}

// ---------- The Artifact Museum ----------
const RELIC_DEFS = [
  { id: 0, name: 'Ancient Drill Bit', color: '#ffd700' },
  { id: 1, name: 'Frozen Compass', color: '#4fc3f7' },
  { id: 2, name: 'Magma Core Shard', color: '#ff5722' },
  { id: 3, name: 'Fossilized Gear', color: '#8bc34a' },
  { id: 4, name: "Prospector's Locket", color: '#ce93d8' },
  { id: 5, name: 'Sunken Anchor', color: '#26a69a' },
  { id: 6, name: 'Meteor Fragment', color: '#7c4dff' },
  { id: 7, name: 'Crystal Skull', color: '#e0e0e0' },
  { id: 8, name: 'Golden Idol', color: '#ffb300' },
  { id: 9, name: 'Void Shard', color: '#4a148c' },
];
// 300m, not 1500m (the original value): passive fuel drain is a flat
// 1.6 HP/s with NO upgrade that reduces it outside Magma (Cooling only
// touches Magma's multiplier), and nothing upgrades vertical fall speed
// (Thruster is horizontal steering only) — so a single life tops out
// somewhere around 150-450m depending on Fuel Tank level and how much
// Stone/Gas damage gets taken along the way, even for a skilled, fully-
// upgraded run. 1500m was only reachable at all by chaining upwards of a
// dozen "Watch Ad to Revive" cycles in one sitting (revive has no per-run
// cap), which locks every Relic-gated class and achievement behind an ad
// marathon rather than a good run. 300m is past the early Diamond
// threshold (50m) and the "First Descent" achievement (100m) — a real
// milestone, not a freebie — while staying reachable in a single
// competent run so Relics (and Jackhammer/Plasma/Museum Curator behind
// them) are a grind, not a soft-lock.
const RELIC_MIN_DEPTH = 300; // meters
const RELIC_CHANCE = 0.003;   // <0.5%, ultra-rare — wrapped by relicChance() below so the Relic Scanner Base upgrade can scale it per level
function relicChance() {
  return RELIC_CHANCE * (1 + state.relicScannerUpgradeLevel * RELIC_CHANCE_BONUS_PER_LEVEL);
}
const CHEST_CHANCE = 0.012;   // rare, but findable
const GAS_CHANCE = 0.015;     // Dirt/Ice only — Magma is already punishing enough

// Diamonds: infinite/repeatable like Gold (no finite pool, unlike Relics),
// but far rarer — a wrapped getter (not a bare constant) so the Diamond
// Sieve Base upgrade can scale it per level. DIAMOND_MIN_DEPTH exists
// specifically so a fresh run can never find one in the opening seconds —
// confirmed from real play that one showed up 4 blocks from the very
// start, which reads as unearned/unrealistic for a "rare" pickup. Base
// fall speed is 140px/s = 3.5m/s (see drill.vy), so 50m is a ~14s floor.
const DIAMOND_MIN_DEPTH = 50; // meters
const DIAMOND_CHANCE_BASE = 0.0008;
function diamondChance() {
  return DIAMOND_CHANCE_BASE * (1 + state.diamondSieveUpgradeLevel * DIAMOND_SIEVE_CHANCE_BONUS_PER_LEVEL);
}

// First 100m (rows 0-99) never spawns Stone or Gas — a hazard-free onboarding
// stretch. The density ramp (stoneThreshold/goldChance) restarts its own
// "depth" counter from this point too (see generateRow), so difficulty still
// climbs on the same smooth eased curve as before — it just starts climbing
// at row 100 instead of row 0, rather than resuming already ~75% ramped-in
// and creating a cliff right at the safe-zone boundary.
const SAFE_ZONE_ROWS = 100;

function loadRelicsFound() {
  try {
    const saved = JSON.parse(storageGet('ec_relics') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

// ---------- Daily Contracts ----------
// One template per goal type; each refresh picks a random target/bonus from
// each template so the day's contracts are always one-of-each-type (one
// per entry in CONTRACT_TEMPLATES below).
// getProgress() reads live run state, so it always reflects "this run" even
// though the contract definitions persist across many runs in the same day.
const CONTRACT_TEMPLATES = [
  {
    id: 'gold',
    randomTarget: () => Math.round((30 + Math.random() * 120) / 10) * 10, // 30-150
    label: (target) => `Collect ${target} Gold in one run`,
    bonusRange: [20, 40],
    getProgress: () => state.gold,
  },
  {
    id: 'depth',
    randomTarget: () => Math.round((200 + Math.random() * 1800) / 50) * 50, // 200-2000m
    label: (target) => `Reach ${target}m depth`,
    bonusRange: [25, 50],
    getProgress: () => state.maxDepthReached,
  },
  {
    id: 'dirt',
    randomTarget: () => Math.round((30 + Math.random() * 120) / 10) * 10, // 30-150
    label: (target) => `Break ${target} Dirt blocks`,
    bonusRange: [15, 30],
    getProgress: () => state.dirtBroken,
  },
  {
    id: 'diamonds',
    // Diamonds are genuinely rare (DIAMOND_CHANCE_BASE = 0.0008/row, no
    // upgrade gets far past double that) — even a strong deep run often
    // finds 0-1. 1-3 keeps this a real ask without being unreachable.
    randomTarget: () => Math.round(1 + Math.random() * 2),
    label: (target) => `Collect ${target} 💎 Diamonds in one run`,
    bonusRange: [40, 70], // higher payout than the other goals — matches how much harder this one actually is
    getProgress: () => state.diamondsThisRun,
  },
];
const CONTRACT_REFRESH_MS = 24 * 60 * 60 * 1000; // rolling 24h window

function getContractTemplate(id) {
  return CONTRACT_TEMPLATES.find((t) => t.id === id);
}

function randomInRange([min, max]) {
  return Math.round(min + Math.random() * (max - min));
}

function generateDailyContracts() {
  return CONTRACT_TEMPLATES.map((template) => {
    const target = template.randomTarget();
    return {
      id: template.id,
      target,
      bonusGold: randomInRange(template.bonusRange),
      completedToday: false,
    };
  });
}

// Loads today's contracts from localStorage, generating (and persisting) a
// fresh set if none exist yet or the last set is more than 24h old.
function loadOrGenerateDailyContracts() {
  let result = null;
  try {
    const saved = JSON.parse(storageGet('ec_dailyContracts') || 'null');
    if (saved && Array.isArray(saved.goals) && Date.now() - saved.generatedAt < CONTRACT_REFRESH_MS) {
      result = saved;
    }
  } catch {
    // fall through to a fresh set
  }
  if (!result) {
    result = { generatedAt: Date.now(), goals: generateDailyContracts() };
    storageSet('ec_dailyContracts', JSON.stringify(result));
  }
  scheduleContractRefreshNotification(result.generatedAt); // fire-and-forget, native-only, never blocks init
  return result;
}

// ---------- Local notifications: a small, deliberately-bounded return system ----------
// Researched against real mobile-game guidance rather than guessed: lead
// with a concrete benefit ("Gold is waiting"), not a feature announcement
// ("New event!"), and cap total volume — sources converge on roughly 2-3
// re-engagement pushes per WEEK as the conservative, non-annoying ceiling,
// with lapsed/dormant players needing progressively less (every-other-day at
// most, dormant players ~1/week). This system can send at most 3
// notifications to a player who never returns, spread across 3 days, then
// nothing further until they come back — comfortably under that ceiling:
//   1. Daily Contracts refreshed (~24h out, tied to the actual refresh)
//   2. Idle Gold ready to collect (~6h after leaving)
//   3. One gentle "come back" nudge (~3 days after leaving)
// (2) and (3) are scheduled when the player actually leaves (handleSdkPause,
// the same "platform pause = player left" signal already used for the
// offline-mining clock) and CANCELED on return (handleSdkResume) so a quick
// back-and-forth never leaves a stale notification pending, and a player who
// keeps playing regularly never sees either one.
function getLocalNotificationsPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
}

// Shared by every scheduling call below — checks first so an already-granted
// or already-denied player is never re-prompted, requests only on the first
// real attempt, and a decline is respected rather than retried.
async function ensureNotificationPermission(plugin) {
  let perm = await plugin.checkPermissions();
  if (perm.display !== 'granted') {
    perm = await plugin.requestPermissions();
  }
  return perm.display === 'granted';
}

const CONTRACT_REFRESH_NOTIFICATION_ID = 1001;
const IDLE_GOLD_NOTIFICATION_ID = 1002;
const WINBACK_NOTIFICATION_ID = 1003;
const IDLE_GOLD_NOTIFICATION_DELAY_MS = 6 * 60 * 60 * 1000; // 6h — a worthwhile chunk of idle Gold (60 at the 10/hr rate) without being the same moment as the win-back nudge
const WINBACK_NOTIFICATION_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — one nudge, not a daily nag

// Re-scheduling with the SAME fixed id on every app open is deliberately
// idempotent: it always targets generatedAt + 24h for whatever contract set
// is currently active, and replaces rather than stacks, so opening the app
// 10 times in a day never produces 10 pending notifications.
async function scheduleContractRefreshNotification(generatedAt) {
  if (!isNativeMobile) return; // no local-notifications concept on web/Playables
  const plugin = getLocalNotificationsPlugin();
  if (!plugin) return;

  try {
    if (!(await ensureNotificationPermission(plugin))) return;
    await plugin.cancel({ notifications: [{ id: CONTRACT_REFRESH_NOTIFICATION_ID }] });
    await plugin.schedule({
      notifications: [{
        id: CONTRACT_REFRESH_NOTIFICATION_ID,
        title: 'New Daily Contracts!',
        body: 'Fresh contracts are ready — come earn some bonus Gold.',
        schedule: { at: new Date(generatedAt + CONTRACT_REFRESH_MS) },
        extra: { deepLink: 'contracts' },
      }],
    });
  } catch (e) {
    // best-effort only — a failed/declined notification never blocks gameplay
    console.log('LocalNotifications: contract refresh schedule failed', e);
  }
}

// Called from handleSdkPause() — the moment the player actually leaves.
async function scheduleReturnNotifications() {
  if (!isNativeMobile) return;
  const plugin = getLocalNotificationsPlugin();
  if (!plugin) return;

  try {
    if (!(await ensureNotificationPermission(plugin))) return;
    const now = Date.now();
    // A streak worth protecting is a sharper, more personal hook than the
    // generic message — "lead with a concrete benefit" — and costs nothing
    // extra to compute since state.loginStreak is already known synchronously
    // right here, at the moment the player is leaving.
    const winbackBody = state.loginStreak >= 2
      ? `Your ${state.loginStreak}-day streak is waiting — come back before it resets!`
      : 'Gold is waiting, your Season Pass is still climbing, and there are fresh contracts to complete.';
    await plugin.schedule({
      notifications: [
        {
          id: IDLE_GOLD_NOTIFICATION_ID,
          title: 'Your rig is still drilling!',
          body: "Gold has been piling up while you're away — come collect it.",
          schedule: { at: new Date(now + IDLE_GOLD_NOTIFICATION_DELAY_MS) },
          extra: { deepLink: 'welcome_back' },
        },
        {
          id: WINBACK_NOTIFICATION_ID,
          title: 'The mine misses you',
          body: winbackBody,
          schedule: { at: new Date(now + WINBACK_NOTIFICATION_DELAY_MS) },
          extra: { deepLink: 'pass' },
        },
      ],
    });
  } catch (e) {
    console.log('LocalNotifications: return-nudge schedule failed', e);
  }
}

// Called from handleSdkResume() — the player is back, so both "come back"
// notifications are moot until they leave again.
async function cancelReturnNotifications() {
  if (!isNativeMobile) return;
  const plugin = getLocalNotificationsPlugin();
  if (!plugin) return;
  try {
    await plugin.cancel({ notifications: [{ id: IDLE_GOLD_NOTIFICATION_ID }, { id: WINBACK_NOTIFICATION_ID }] });
  } catch (e) {
    // best-effort — a failed cancel just means a possibly-stale notification stays scheduled, never fatal
  }
}

// Routes a tapped notification straight to its payoff instead of just
// launching the app to whatever screen it always opens to — closes the loop
// between "notification promises a reward" and "player actually sees it"
// with one extra screen nav instead of several taps.
//
// 'welcome_back' needs no action: checkOfflineEarnings() already shows that
// overlay automatically on every cold load if idle Gold was earned, deep
// link or not. If it IS showing right now, skip opening Contracts/Pass on
// top of it — both are full-screen .overlay divs at the same z-index, and
// whichever opens second would visually bury the Collect button behind it.
// Missing one screen nav on that particular cold start is a fine trade for
// never risking a stuck, unreachable Welcome Back overlay.
function applyDeepLink(deepLink) {
  if (!deepLink) return;
  if (!welcomeBackScreen.classList.contains('hidden')) return;
  if (deepLink === 'contracts') openContractsScreen();
  else if (deepLink === 'pass') openPassScreen();
}

function saveDailyContracts() {
  storageSet('ec_dailyContracts', JSON.stringify(state.dailyContracts));
}

// ---------- Lightweight telemetry ----------
const ANALYTICS_HISTORY_LIMIT = 10;

const Analytics = {
  logRunEnd(causeOfDeath) {
    const record = {
      finalDepth: state.maxDepthReached,
      causeOfDeath, // 'Fuel Starvation' | 'Stone Collision' | 'Gas Explosion'
      runDurationSeconds: Math.round((performance.now() - state.startTime) / 100) / 10,
      totalGoldEarned: state.gold,
      timestamp: Date.now(),
    };

    console.log('Analytics: run ended', record);

    let history;
    try {
      history = JSON.parse(storageGet('ec_analytics') || '[]');
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
    history.push(record);
    while (history.length > ANALYTICS_HISTORY_LIMIT) history.shift();
    storageSet('ec_analytics', JSON.stringify(history));

    return record;
  },
};

// ---------- Drill Classes (Loadout) ----------
// Unlocked by owning enough Relics (state.relicsFound.length). damageMultiplier
// applies only to Stone/Gas hits (not fuel drain); verticalSpeedMultiplier
// scales fall speed in updateDrillFall(); steerSpeedMultiplier scales
// horizontal control in updateDrillSteer(). width/height become the drill's
// actual hitbox for the run, so "shape" is a real gameplay trait too.
const DRILL_CLASSES = {
  ROOKIE: {
    id: 'ROOKIE',
    name: 'Rookie',
    relicsRequired: 0,
    verticalSpeedMultiplier: 1.0,
    steerSpeedMultiplier: 1.0,
    damageMultiplier: 1.0,
    width: 32,
    height: 36,
    perks: ['Balanced in every way'],
    drawbacks: ['No special bonuses'],
  },
  JACKHAMMER: {
    id: 'JACKHAMMER',
    name: 'Jackhammer',
    relicsRequired: 2,
    verticalSpeedMultiplier: 0.8,
    steerSpeedMultiplier: 1.0,
    damageMultiplier: 0.5,
    width: 40,
    height: 32,
    perks: ['0.5x damage taken from Stone & Gas'],
    drawbacks: ['0.8x vertical (fall) speed'],
  },
  PLASMA: {
    id: 'PLASMA',
    name: 'Plasma',
    relicsRequired: 4,
    verticalSpeedMultiplier: 1.3,
    steerSpeedMultiplier: 1.5,
    damageMultiplier: 2.0,
    width: 22,
    height: 40,
    perks: ['1.3x vertical (fall) speed', '1.5x horizontal steering speed'],
    drawbacks: ['2.0x damage taken from Stone & Gas'],
  },
};
const CLASS_ORDER = ['ROOKIE', 'JACKHAMMER', 'PLASMA'];

function isClassUnlocked(classId) {
  return state.relicsFound.length >= DRILL_CLASSES[classId].relicsRequired;
}

function getActiveClass() {
  return DRILL_CLASSES[state.selectedClass] || DRILL_CLASSES.ROOKIE;
}

function selectClass(classId) {
  if (!DRILL_CLASSES[classId] || !isClassUnlocked(classId)) return;
  state.selectedClass = classId;
  storageSet('ec_selectedClass', classId);
  renderLoadoutScreen();
}

// Falls back to ROOKIE if nothing was saved, or if the saved class somehow
// requires more relics than are currently owned (defensive, shouldn't happen
// since relic count only ever grows).
function loadSelectedClass() {
  const saved = storageGet('ec_selectedClass');
  const relicsCount = loadRelicsFound().length;
  if (saved && DRILL_CLASSES[saved] && relicsCount >= DRILL_CLASSES[saved].relicsRequired) {
    return saved;
  }
  return 'ROOKIE';
}

// ---------- Terrain / world state ----------
const world = {
  rows: [],       // rows[rowIndex] = array of COLS block types
  lastSafeX: Math.floor(COLS / 2),
  nextRowToGenerate: 0,
};

const NOISE_SCALE_X = 0.35;
const NOISE_SCALE_Y = 0.12;
const DEPTH_FOR_MAX_STONE = 5000; // world pixels

function stoneThreshold(depthPixels) {
  const t = clamp(depthPixels / DEPTH_FOR_MAX_STONE, 0, 1);
  // Eased ramp (t^1.4) keeps density low for longer near the surface without
  // changing the eventual ceiling at DEPTH_FOR_MAX_STONE — a plain lerp here
  // made the first ~50m noticeably harder than intended (see playtest notes).
  const eased = Math.pow(t, 1.4);
  // depth 0 -> sparse stone (~7% density => high threshold)
  // depth 5000 -> dense stone (~60% density => low threshold)
  return lerp(0.93, 0.40, eased);
}

function goldChance(depthPixels) {
  const t = clamp(depthPixels / DEPTH_FOR_MAX_STONE, 0, 1);
  // depth 0 -> gold is common (~6% of non-stone cells)
  // depth 5000+ -> gold is scarce (~1.5% of non-stone cells)
  return lerp(0.06, 0.015, t);
}

function safeGoldChance(depthPixels) {
  const t = clamp(depthPixels / DEPTH_FOR_MAX_STONE, 0, 1);
  // the guaranteed-safe cell is gold less often as depth increases
  return lerp(0.08, 0.03, t);
}

// Scripted "moment" — a short, recognizable set-piece breaking up pure
// procedural repetition (the same idea behind Temple Run 2's zip lines/mine
// carts), implemented as safely as possible: a pure function of rowIndex,
// so every row's shaft-or-not status is deterministic and consistent with
// zero cross-row state to get wrong. Never inside the onboarding safe zone.
const GOLD_RUSH_SHAFT_INTERVAL_M = 500; // every 500m of depth
const GOLD_RUSH_SHAFT_LENGTH_M = 8;     // an 8-row burst

function isGoldRushShaftRow(rowIndex) {
  if (rowIndex < SAFE_ZONE_ROWS) return false;
  return (rowIndex % GOLD_RUSH_SHAFT_INTERVAL_M) < GOLD_RUSH_SHAFT_LENGTH_M;
}

// Toasts once on the false->true transition (entering a shaft), not every
// frame while inside one — the terrain itself already reads as the moment;
// this just makes sure the player consciously notices it, matching the
// weekend bonus's own "make it noticed, not just silently better" toast.
let wasInGoldRushShaft = false;

function updateGoldRushShaftIndicator() {
  const inShaft = isGoldRushShaftRow(Math.floor(drill.worldY / BLOCK));
  if (inShaft && !wasInGoldRushShaft) {
    queueToast('💰 Gold Rush Shaft!');
    vibrateHaptic(20);
  }
  wasInGoldRushShaft = inShaft;
}

function generateRow(rowIndex) {
  const inSafeZone = rowIndex < SAFE_ZONE_ROWS;
  const row = new Array(COLS);

  if (isGoldRushShaftRow(rowIndex)) {
    // Dense gold, zero stone/gas/hazards — every column is safe, so
    // world.lastSafeX simply stays wherever it already was and the normal
    // random-walk safe path resumes from there once the shaft ends.
    for (let x = 0; x < COLS; x++) {
      row[x] = Math.random() < 0.55 ? GOLD : DIRT;
    }
    world.rows[rowIndex] = row;
    return;
  }

  // Ramp restarts its own "depth" clock at the safe zone's edge, so the
  // eased density curve climbs from 0 again at row 100 instead of resuming
  // already ~75% ramped-in (which would read as a difficulty cliff right at
  // the boundary).
  const rampDepthPixels = Math.max(0, (rowIndex - SAFE_ZONE_ROWS) * BLOCK);
  const threshold = stoneThreshold(rampDepthPixels);
  const goldChanceHere = goldChance(rampDepthPixels);

  for (let x = 0; x < COLS; x++) {
    const n = NoiseGen.noise2D(x * NOISE_SCALE_X, rowIndex * NOISE_SCALE_Y);
    if (!inSafeZone && n > threshold) {
      row[x] = STONE;
    } else {
      row[x] = Math.random() < goldChanceHere ? GOLD : DIRT;
    }
  }

  // Guaranteed safe path: random walk relative to previous row's safe x
  const step = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
  const safeX = clamp(world.lastSafeX + step, 0, COLS - 1);
  row[safeX] = Math.random() < safeGoldChance(rampDepthPixels) ? GOLD : DIRT;
  world.lastSafeX = safeX;

  // Chest / Relic / Gas spawns — only ever replace plain DIRT so they never
  // swallow a Stone or Gold cell (or each other). Gas is a hazard and stays
  // out of the safe zone; Chest/Relic are benign, so they're allowed
  // anywhere their own gates permit.
  const rowBiomeForSpawns = getBiome(rowIndex);
  for (let x = 0; x < COLS; x++) {
    if (row[x] !== DIRT) continue;
    if (
      rowIndex >= RELIC_MIN_DEPTH &&
      state.relicsFound.length < RELIC_DEFS.length &&
      Math.random() < relicChance()
    ) {
      row[x] = RELIC;
    } else if (rowIndex >= DIAMOND_MIN_DEPTH && Math.random() < diamondChance()) {
      row[x] = DIAMOND;
    } else if (Math.random() < CHEST_CHANCE) {
      row[x] = CHEST;
    } else if (!inSafeZone && rowBiomeForSpawns.name !== 'Magma' && Math.random() < GAS_CHANCE) {
      row[x] = GAS;
    }
  }

  world.rows[rowIndex] = row;
}

function ensureRowsGenerated(uptoRowIndex) {
  while (world.nextRowToGenerate <= uptoRowIndex) {
    generateRow(world.nextRowToGenerate);
    world.nextRowToGenerate++;
  }
}

function getBlock(rowIndex, colIndex) {
  if (rowIndex < 0 || colIndex < 0 || colIndex >= COLS) return EMPTY;
  ensureRowsGenerated(rowIndex);
  return world.rows[rowIndex][colIndex];
}

function setBlock(rowIndex, colIndex, value) {
  if (rowIndex < 0 || colIndex < 0 || colIndex >= COLS) return;
  ensureRowsGenerated(rowIndex);
  world.rows[rowIndex][colIndex] = value;
}

// ---------- Drill (player) ----------
const drill = {
  worldX: LOGICAL_W / 2 - 16,
  worldY: -80, // start slightly above the terrain, free-falling in
  width: 32,
  height: 36,
  vy: 140,        // base fall speed, px/sec
  vx: 0,
  steerSpeed: 220, // px/sec horizontal steer speed
  health: 100,
  maxHealth: 100,
  fuelDrainRate: 1.6, // health per second, passive drain
  stoneDamage: 22,
  invulnTimer: 0,
};

// ---------- Game state ----------
const state = {
  running: false,
  gameOver: false,
  gold: 0,
  bankedGold: parseInt(storageGet('ec_bankedGold') || '0', 10),
  highScore: parseInt(storageGet('ec_highScore') || '0', 10),
  fuelUpgradeLevel: parseInt(storageGet('ec_fuelUpgradeLevel') || '0', 10),
  coolingUpgradeLevel: parseInt(storageGet('ec_coolingUpgradeLevel') || '0', 10),
  thrusterUpgradeLevel: parseInt(storageGet('ec_thrusterUpgradeLevel') || '0', 10),
  alloyUpgradeLevel: parseInt(storageGet('ec_alloyUpgradeLevel') || '0', 10),
  relicsFound: loadRelicsFound(), // array of collected RELIC_DEFS ids, persisted
  dailyContracts: loadOrGenerateDailyContracts(), // { generatedAt, goals: [...] }, persisted
  selectedClass: loadSelectedClass(), // 'ROOKIE' | 'JACKHAMMER' | 'PLASMA', persisted
  unlockedTrails: loadUnlockedTrails(), // array of owned TRAIL_DEFS ids, persisted
  selectedTrail: loadSelectedTrail(), // TRAIL_DEFS id, persisted
  passXp: parseInt(storageGet('ec_passXp') || '0', 10), // Season Pass XP earned this season, persisted
  passClaimedTiers: loadPassClaimedTiers(), // array of claimed Pass tier numbers, persisted
  passSeasonStart: loadOrInitPassSeasonStart(), // ms epoch, persisted
  passSeasonNumber: parseInt(storageGet('ec_passSeasonNumber') || '1', 10),
  loginStreak: parseInt(storageGet('ec_loginStreak') || '0', 10), // consecutive-day count, persisted
  lifetimeGoldEarned: parseInt(storageGet('ec_lifetimeGoldEarned') || '0', 10), // monotonically increasing — never decreases when gold is spent, unlike bankedGold; drives Achievements
  bestDepthEver: parseInt(storageGet('ec_bestDepthEver') || '0', 10), // separate from highScore, which is a composite depth+gold number
  contractsCompletedLifetime: parseInt(storageGet('ec_contractsCompletedLifetime') || '0', 10),
  gameCenterAchievementsReported: loadGameCenterAchievementsReported(), // array of ACHIEVEMENT_DEFS ids already reported to Game Center — reporting is one-way and idempotent on Apple's side, but this avoids a network call every time the list re-renders
  audioMuted: storageGet('ec_audioMuted') === 'true', // player preference, distinct from the platform mute/SDK mute channels
  hapticsDisabled: storageGet('ec_hapticsDisabled') === 'true',
  // Reserved for the future paid track — always false/empty until a real IAP
  // purchase flow exists to set them (see unlockPassPremium()). Persisted
  // now so the shape is already correct; nothing sets these yet.
  passPremiumUnlocked: storageGet('ec_passPremiumUnlocked') === 'true',
  passClaimedPremiumTiers: loadPassClaimedPremiumTiers(),
  // The Base's rare currency — diamonds bank into `diamonds` at endGame()
  // exactly like gold banks into bankedGold, so death never costs you any
  // (deliberately no extraction/loss mechanic in this pass).
  diamonds: parseInt(storageGet('ec_diamonds') || '0', 10),
  diamondsThisRun: 0,
  offlineRigUpgradeLevel: parseInt(storageGet('ec_offlineRigUpgradeLevel') || '0', 10),
  diamondSieveUpgradeLevel: parseInt(storageGet('ec_diamondSieveUpgradeLevel') || '0', 10),
  unlockedBaseSkins: loadUnlockedBaseSkins(), // array of owned BASE_SKIN_DEFS ids, persisted
  selectedBaseSkin: loadSelectedBaseSkin(), // BASE_SKIN_DEFS id, persisted
  hasSeenTutorial: storageGet('ec_hasSeenTutorial') === 'true',
  prestigeLevel: parseInt(storageGet('ec_prestigeLevel') || '0', 10),
  relicScannerUpgradeLevel: parseInt(storageGet('ec_relicScannerUpgradeLevel') || '0', 10),
  contractRunnerUpgradeLevel: parseInt(storageGet('ec_contractRunnerUpgradeLevel') || '0', 10),
  maxDepthReached: 0,
  startTime: 0,
  comboMultiplier: 1.0,
  magnetTimer: 0, // seconds remaining on the Chest's gold-magnet buff
  shieldTimer: 0, // seconds remaining on the Chest's shield buff
  scoreBoostTimer: 0, // seconds remaining on the Chest's 2x score buff
  dirtBroken: 0, // this run's count, feeds the "Break N Dirt blocks" contract
  pendingContractGold: 0, // bonus gold from contracts completed this run, banked at endGame()
  overdriveMeter: 0, // 0..OVERDRIVE_MAX, built from near-misses/gold
  overdriveActive: false,
  overdriveTimer: 0, // seconds remaining while Overdrive is active
};

// Score rewards depth traveled and gold collected; gold is weighted heavier
// since it requires deliberately steering off the fastest path.
function computeScore(depthMeters, gold) {
  return depthMeters + gold * 10;
}

function currentScore() {
  const base = computeScore(state.maxDepthReached, state.gold);
  return state.scoreBoostTimer > 0 ? Math.round(base * 2) : base;
}

// ---------- Weekend Gold Rush (live-ops, no backend needed) ----------
// A real, currently-active bonus rather than a speculative "event calendar"
// framework — there's no server to drive a real content calendar from (this
// whole game is client-only/localStorage), so building a generic scheduling
// system ahead of having anything to schedule would just be unused
// infrastructure. This is the same PATTERN top games use (a recurring
// bonus window players learn to expect) implemented as directly as
// possible: local device date, no server round-trip required.
const WEEKEND_GOLD_MULTIPLIER = 1.5;

function isWeekendGoldRushActive() {
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday, local device time
  return day === 0 || day === 6;
}

function applyWeekendGoldBonus(goldAmount) {
  return isWeekendGoldRushActive() ? Math.round(goldAmount * WEEKEND_GOLD_MULTIPLIER) : goldAmount;
}

// ---------- Upgrades: Expanded Tech Tree ----------
// Four independent paths, each 5 levels, each with its own gold-sink cost
// curve. generateUpgradeCosts mirrors the Fuel Tank's original hand-tuned
// curve (roughly 1.6-2x growth per step) as a reusable exponential formula
// so the three new paths cost-scale the same way without copy-pasting a
// literal array per path.
const BASE_MAX_HEALTH = 100;
const FUEL_UPGRADE_HEALTH_PER_LEVEL = 20;
const FUEL_UPGRADE_COSTS = [20, 40, 70, 110, 160]; // cost of each level, index = level - 1 (original, untouched)
const FUEL_UPGRADE_MAX_LEVEL = FUEL_UPGRADE_COSTS.length;

function generateUpgradeCosts(baseCost, growthFactor, levels) {
  const costs = [];
  let cost = baseCost;
  for (let i = 0; i < levels; i++) {
    costs.push(Math.round(cost));
    cost *= growthFactor;
  }
  return costs;
}

function getMaxHealth() {
  return BASE_MAX_HEALTH + state.fuelUpgradeLevel * FUEL_UPGRADE_HEALTH_PER_LEVEL;
}

function buyFuelUpgrade() {
  if (state.fuelUpgradeLevel >= FUEL_UPGRADE_MAX_LEVEL) return;
  const cost = FUEL_UPGRADE_COSTS[state.fuelUpgradeLevel];
  if (state.bankedGold < cost) return;

  state.bankedGold -= cost;
  state.fuelUpgradeLevel += 1;
  storageSet('ec_bankedGold', String(state.bankedGold));
  storageSet('ec_fuelUpgradeLevel', String(state.fuelUpgradeLevel));
}

// Cooling System — reduces the Magma biome's fuel-drain multiplier from
// 1.5x (stock) down to 1.1x at max level. Dirt/Ice are unaffected; they were
// never punishing enough to need it.
const COOLING_UPGRADE_COSTS = generateUpgradeCosts(25, 1.7, 5);
const COOLING_UPGRADE_MAX_LEVEL = COOLING_UPGRADE_COSTS.length;
const MAGMA_FUEL_MULTIPLIER_STOCK = 1.5;
const MAGMA_FUEL_MULTIPLIER_MAX = 1.1;

function getEffectiveFuelMultiplier(biome) {
  if (biome.name !== 'Magma') return biome.fuelMultiplier;
  const t = clamp(state.coolingUpgradeLevel / COOLING_UPGRADE_MAX_LEVEL, 0, 1);
  return lerp(MAGMA_FUEL_MULTIPLIER_STOCK, MAGMA_FUEL_MULTIPLIER_MAX, t);
}

function buyCoolingUpgrade() {
  if (state.coolingUpgradeLevel >= COOLING_UPGRADE_MAX_LEVEL) return;
  const cost = COOLING_UPGRADE_COSTS[state.coolingUpgradeLevel];
  if (state.bankedGold < cost) return;

  state.bankedGold -= cost;
  state.coolingUpgradeLevel += 1;
  storageSet('ec_bankedGold', String(state.bankedGold));
  storageSet('ec_coolingUpgradeLevel', String(state.coolingUpgradeLevel));
}

// Thruster Array — flat bonus added to the drill's baseline horizontal
// steer speed (still multiplied by biome/class modifiers same as before).
const THRUSTER_UPGRADE_COSTS = generateUpgradeCosts(20, 1.7, 5);
const THRUSTER_UPGRADE_MAX_LEVEL = THRUSTER_UPGRADE_COSTS.length;
const THRUSTER_SPEED_PER_LEVEL = 30; // px/sec added to the 220 base, per level

function getEffectiveSteerSpeed() {
  return drill.steerSpeed + state.thrusterUpgradeLevel * THRUSTER_SPEED_PER_LEVEL;
}

function buyThrusterUpgrade() {
  if (state.thrusterUpgradeLevel >= THRUSTER_UPGRADE_MAX_LEVEL) return;
  const cost = THRUSTER_UPGRADE_COSTS[state.thrusterUpgradeLevel];
  if (state.bankedGold < cost) return;

  state.bankedGold -= cost;
  state.thrusterUpgradeLevel += 1;
  storageSet('ec_bankedGold', String(state.bankedGold));
  storageSet('ec_thrusterUpgradeLevel', String(state.thrusterUpgradeLevel));
}

// Alloy Plating — flat damage reduction against Stone/Gas collisions (a
// reduction, never immunity: damage is floored at 1 regardless of level).
const ALLOY_UPGRADE_COSTS = generateUpgradeCosts(30, 1.7, 5);
const ALLOY_UPGRADE_MAX_LEVEL = ALLOY_UPGRADE_COSTS.length;
const ALLOY_DAMAGE_REDUCTION_PER_LEVEL = 3; // flat hp, per level

function getAlloyDamageReduction() {
  return state.alloyUpgradeLevel * ALLOY_DAMAGE_REDUCTION_PER_LEVEL;
}

function buyAlloyUpgrade() {
  if (state.alloyUpgradeLevel >= ALLOY_UPGRADE_MAX_LEVEL) return;
  const cost = ALLOY_UPGRADE_COSTS[state.alloyUpgradeLevel];
  if (state.bankedGold < cost) return;

  state.bankedGold -= cost;
  state.alloyUpgradeLevel += 1;
  storageSet('ec_bankedGold', String(state.bankedGold));
  storageSet('ec_alloyUpgradeLevel', String(state.alloyUpgradeLevel));
}

// ---------- The Base: Diamond-funded upgrades ----------
// Same generateUpgradeCosts()/renderUpgradeCard() pattern as the Tech Tree
// above, but spent with Diamonds (state.diamonds) instead of Gold, and each
// tied to an already-existing system rather than a new mechanic.
const OFFLINE_RIG_UPGRADE_COSTS = generateUpgradeCosts(3, 1.8, 5);
const OFFLINE_RIG_UPGRADE_MAX_LEVEL = OFFLINE_RIG_UPGRADE_COSTS.length;
const OFFLINE_GOLD_PER_HOUR_BONUS_PER_LEVEL = 4; // flat Gold/hr, per level, on top of OFFLINE_GOLD_PER_HOUR

function getOfflineGoldPerHour() {
  return OFFLINE_GOLD_PER_HOUR + state.offlineRigUpgradeLevel * OFFLINE_GOLD_PER_HOUR_BONUS_PER_LEVEL;
}

function buyOfflineRigUpgrade() {
  if (state.offlineRigUpgradeLevel >= OFFLINE_RIG_UPGRADE_MAX_LEVEL) return;
  const cost = OFFLINE_RIG_UPGRADE_COSTS[state.offlineRigUpgradeLevel];
  if (state.diamonds < cost) return;

  state.diamonds -= cost;
  state.offlineRigUpgradeLevel += 1;
  storageSet('ec_diamonds', String(state.diamonds));
  storageSet('ec_offlineRigUpgradeLevel', String(state.offlineRigUpgradeLevel));
}

const DIAMOND_SIEVE_UPGRADE_COSTS = generateUpgradeCosts(5, 1.9, 5);
const DIAMOND_SIEVE_UPGRADE_MAX_LEVEL = DIAMOND_SIEVE_UPGRADE_COSTS.length;
const DIAMOND_SIEVE_CHANCE_BONUS_PER_LEVEL = 0.25; // relative bonus to diamondChance(), per level

function buyDiamondSieveUpgrade() {
  if (state.diamondSieveUpgradeLevel >= DIAMOND_SIEVE_UPGRADE_MAX_LEVEL) return;
  const cost = DIAMOND_SIEVE_UPGRADE_COSTS[state.diamondSieveUpgradeLevel];
  if (state.diamonds < cost) return;

  state.diamonds -= cost;
  state.diamondSieveUpgradeLevel += 1;
  storageSet('ec_diamonds', String(state.diamonds));
  storageSet('ec_diamondSieveUpgradeLevel', String(state.diamondSieveUpgradeLevel));
}

const RELIC_SCANNER_UPGRADE_COSTS = generateUpgradeCosts(8, 1.8, 5);
const RELIC_SCANNER_UPGRADE_MAX_LEVEL = RELIC_SCANNER_UPGRADE_COSTS.length;
const RELIC_CHANCE_BONUS_PER_LEVEL = 0.25; // relative bonus to relicChance(), per level — same shape as Diamond Sieve

function buyRelicScannerUpgrade() {
  if (state.relicScannerUpgradeLevel >= RELIC_SCANNER_UPGRADE_MAX_LEVEL) return;
  const cost = RELIC_SCANNER_UPGRADE_COSTS[state.relicScannerUpgradeLevel];
  if (state.diamonds < cost) return;

  state.diamonds -= cost;
  state.relicScannerUpgradeLevel += 1;
  storageSet('ec_diamonds', String(state.diamonds));
  storageSet('ec_relicScannerUpgradeLevel', String(state.relicScannerUpgradeLevel));
}

const CONTRACT_RUNNER_UPGRADE_COSTS = generateUpgradeCosts(6, 1.8, 5);
const CONTRACT_RUNNER_UPGRADE_MAX_LEVEL = CONTRACT_RUNNER_UPGRADE_COSTS.length;

function getContractGoldMultiplier() {
  return 1 + state.contractRunnerUpgradeLevel * 0.15;
}

function buyContractRunnerUpgrade() {
  if (state.contractRunnerUpgradeLevel >= CONTRACT_RUNNER_UPGRADE_MAX_LEVEL) return;
  const cost = CONTRACT_RUNNER_UPGRADE_COSTS[state.contractRunnerUpgradeLevel];
  if (state.diamonds < cost) return;

  state.diamonds -= cost;
  state.contractRunnerUpgradeLevel += 1;
  storageSet('ec_diamonds', String(state.diamonds));
  storageSet('ec_contractRunnerUpgradeLevel', String(state.contractRunnerUpgradeLevel));
}

// ---------- Prestige ----------
// The actual fix for "maxes everything and feels done in a day" — the
// standard idle-game answer (Mr. Mine, Deep Town, etc.): once every
// grindable upgrade is maxed, reset the economy for a permanent bonus that
// keeps compounding. Collection/achievement progress (Relics, Trails, Base
// Skins, Season Pass, lifetime stats) is real effort a player already put
// in and is never touched — only the re-earnable Gold/Diamond economy
// resets, exactly like every reference prestige system.
function isPrestigeEligible() {
  return state.fuelUpgradeLevel >= FUEL_UPGRADE_MAX_LEVEL &&
    state.coolingUpgradeLevel >= COOLING_UPGRADE_MAX_LEVEL &&
    state.thrusterUpgradeLevel >= THRUSTER_UPGRADE_MAX_LEVEL &&
    state.alloyUpgradeLevel >= ALLOY_UPGRADE_MAX_LEVEL &&
    state.offlineRigUpgradeLevel >= OFFLINE_RIG_UPGRADE_MAX_LEVEL &&
    state.diamondSieveUpgradeLevel >= DIAMOND_SIEVE_UPGRADE_MAX_LEVEL &&
    state.relicScannerUpgradeLevel >= RELIC_SCANNER_UPGRADE_MAX_LEVEL &&
    state.contractRunnerUpgradeLevel >= CONTRACT_RUNNER_UPGRADE_MAX_LEVEL;
}

function doPrestige() {
  if (!isPrestigeEligible()) return;

  state.prestigeLevel += 1;
  storageSet('ec_prestigeLevel', String(state.prestigeLevel));

  state.bankedGold = 0;
  state.diamonds = 0;
  state.fuelUpgradeLevel = 0;
  state.coolingUpgradeLevel = 0;
  state.thrusterUpgradeLevel = 0;
  state.alloyUpgradeLevel = 0;
  state.offlineRigUpgradeLevel = 0;
  state.diamondSieveUpgradeLevel = 0;
  state.relicScannerUpgradeLevel = 0;
  state.contractRunnerUpgradeLevel = 0;
  [
    'ec_bankedGold', 'ec_diamonds', 'ec_fuelUpgradeLevel', 'ec_coolingUpgradeLevel',
    'ec_thrusterUpgradeLevel', 'ec_alloyUpgradeLevel', 'ec_offlineRigUpgradeLevel',
    'ec_diamondSieveUpgradeLevel', 'ec_relicScannerUpgradeLevel', 'ec_contractRunnerUpgradeLevel',
  ].forEach((k) => storageSet(k, '0'));

  queueToast('⭐ Prestige ' + state.prestigeLevel + '! +' + (state.prestigeLevel * 10) + '% Gold, permanently.');
}

// Diamond IAP packs — inert scaffold, same pattern as the Season Pass
// premium track (see unlockPassPremium()/claimPassPremiumTier() below):
// data model + a purchase-handler function exist, but nothing renders any
// purchase UI and nothing calls purchaseDiamondPack() yet. Ships as an
// empty array (not populated-but-null rows) since there's no non-IAP
// reason for a pack row to exist at all. Intended call site: a future
// StoreKit purchase-success handler, once real products exist in App
// Store Connect and there's real post-launch usage data to price against.
const DIAMOND_IAP_PACKS = [];

function purchaseDiamondPack(packId) {
  const pack = DIAMOND_IAP_PACKS.find((p) => p.id === packId);
  if (!pack) return;
  state.diamonds += pack.diamondAmount;
  storageSet('ec_diamonds', String(state.diamonds));
}

// Base Skins — purely cosmetic re-tints of the Base's hero scene, same
// unlock-then-select shape as TRAIL_DEFS below but Diamond-priced instead
// of Gold, and applied as a CSS filter (see #base-screen::before in
// style.css) rather than swapping art, so no extra images are needed —
// the 4 progression-tier scenes stay the source of truth, skins just tint
// whichever one is currently showing.
// sepia() first, then hue-rotate() — sepia collapses the source image into
// a narrow warm-brown tonal range, so the hue-rotate that follows produces
// one strong, uniform tint across the whole scene instead of each original
// hue drifting independently (a much more convincing "reskin," not just a
// slight shift). Plain hue-rotate alone was tried first and was barely
// perceptible against this scene's already-warm/amber palette.
const BASE_SKIN_DEFS = [
  { id: 'standard', name: 'Standard Camp', cost: 0, swatch: '#c9995c', filter: 'none' },
  { id: 'molten', name: 'Molten Camp', cost: 15, swatch: '#ff5a2e', filter: 'sepia(0.5) saturate(3.5) hue-rotate(-15deg) brightness(1.05)' },
  { id: 'frost', name: 'Frost Camp', cost: 15, swatch: '#5fd0ff', filter: 'sepia(0.45) saturate(3) hue-rotate(165deg) brightness(1.1)' },
  { id: 'verdant', name: 'Verdant Camp', cost: 20, swatch: '#4ee06a', filter: 'sepia(0.45) saturate(3.2) hue-rotate(65deg) brightness(1.05)' },
  { id: 'royal', name: 'Royal Camp', cost: 25, swatch: '#b866ff', filter: 'sepia(0.45) saturate(3.2) hue-rotate(235deg) brightness(1.1)' },
];

function loadUnlockedBaseSkins() {
  try {
    const saved = JSON.parse(storageGet('ec_unlockedBaseSkins') || '["standard"]');
    return Array.isArray(saved) && saved.includes('standard') ? saved : ['standard'];
  } catch {
    return ['standard'];
  }
}

function loadSelectedBaseSkin() {
  const saved = storageGet('ec_selectedBaseSkin');
  const owned = loadUnlockedBaseSkins();
  return saved && owned.includes(saved) ? saved : 'standard';
}

function isBaseSkinUnlocked(id) {
  return state.unlockedBaseSkins.includes(id);
}

function getBaseSkinFilter() {
  const skin = BASE_SKIN_DEFS.find((s) => s.id === state.selectedBaseSkin) || BASE_SKIN_DEFS[0];
  return skin.filter;
}

function buyOrSelectBaseSkin(id) {
  const skin = BASE_SKIN_DEFS.find((s) => s.id === id);
  if (!skin) return;

  if (isBaseSkinUnlocked(id)) {
    state.selectedBaseSkin = id;
    storageSet('ec_selectedBaseSkin', id);
  } else if (state.diamonds >= skin.cost) {
    state.diamonds -= skin.cost;
    state.unlockedBaseSkins.push(id);
    state.selectedBaseSkin = id;
    storageSet('ec_diamonds', String(state.diamonds));
    storageSet('ec_unlockedBaseSkins', JSON.stringify(state.unlockedBaseSkins));
    storageSet('ec_selectedBaseSkin', id);
  }
}

// ---------- Cosmetics: particle trails ----------
// TRAIL_DEFS.color() returns the color the drill's dirt-break dust emitter
// should use; 'standard' keeps the original per-biome behavior, the unlocks
// are fixed colors so they read as a deliberate cosmetic regardless of zone.
const TRAIL_DEFS = [
  { id: 'standard', name: 'Standard Dust', cost: 0, color: (biome) => biome.dirtColor },
  { id: 'neon', name: 'Neon Spark', cost: 150, color: () => '#ff2ee6' },
  { id: 'magma_ash', name: 'Magma Ash', cost: 300, color: () => '#ff6f30' },
  // Season Pass exclusives — unlocked by reaching a Pass tier, never
  // gold-purchasable (no `cost` field; buyOrSelectTrail()/renderTrailsScreen()
  // branch on `passTier` instead). The animated hue-cycle ones read as
  // visibly fancier than any flat-color trail, which is the point of an
  // "exclusive" reward — matches the ANIMATED, not just recolored.
  { id: 'pass_prismatic', name: 'Prismatic Shimmer', passTier: 5, color: () => `hsl(${Math.floor(performance.now() / 8) % 360}, 90%, 60%)` },
  { id: 'pass_golden', name: 'Golden Rush', passTier: 15, color: () => '#ffd700' },
  { id: 'pass_molten', name: 'Molten Core', passTier: 25, color: () => `hsl(${Math.floor(performance.now() / 15) % 45}, 100%, 55%)` },
];

function loadUnlockedTrails() {
  try {
    const saved = JSON.parse(storageGet('ec_unlockedTrails') || '["standard"]');
    return Array.isArray(saved) && saved.includes('standard') ? saved : ['standard'];
  } catch {
    return ['standard'];
  }
}

function loadSelectedTrail() {
  const saved = storageGet('ec_selectedTrail');
  const owned = loadUnlockedTrails();
  return saved && owned.includes(saved) ? saved : 'standard';
}

function isTrailUnlocked(id) {
  return state.unlockedTrails.includes(id);
}

function getTrailColor(biome) {
  const trail = TRAIL_DEFS.find((t) => t.id === state.selectedTrail) || TRAIL_DEFS[0];
  return trail.color(biome);
}

// Unlocks-then-selects in one action if not yet owned; just selects if
// already owned. No-ops silently if unaffordable (button is disabled anyway).
// Season Pass trails (passTier set, no cost) are never gold-purchasable here
// — they only ever become owned via claimPassTier().
function buyOrSelectTrail(id) {
  const trail = TRAIL_DEFS.find((t) => t.id === id);
  if (!trail || trail.passTier !== undefined) return;

  if (isTrailUnlocked(id)) {
    state.selectedTrail = id;
    storageSet('ec_selectedTrail', id);
  } else if (state.bankedGold >= trail.cost) {
    state.bankedGold -= trail.cost;
    state.unlockedTrails.push(id);
    state.selectedTrail = id;
    storageSet('ec_bankedGold', String(state.bankedGold));
    storageSet('ec_unlockedTrails', JSON.stringify(state.unlockedTrails));
    storageSet('ec_selectedTrail', id);
  }
}

// Selecting an already-owned Season Pass trail (claimed via the Pass screen)
// uses this instead — buyOrSelectTrail() deliberately refuses passTier trails
// so gold can never touch them.
function selectOwnedTrail(id) {
  if (!isTrailUnlocked(id)) return;
  state.selectedTrail = id;
  storageSet('ec_selectedTrail', id);
}

// ---------- Season Pass ----------
// Currently ships free-track only: play the game, earn Pass XP, climb tiers,
// claim Gold + exclusive Trails. No real money involved yet — but the data
// model, claim flow, and state below are already shaped for a second PAID
// track to slot in later (once the app is actually published and a real
// In-App Purchase product exists in App Store Connect), without reworking
// the free track:
//   - Every PASS_REWARDS entry carries a `premiumReward` field (null until
//     premium content is designed — intentionally not invented speculatively
//     here, see claimPassPremiumTier below).
//   - state.passPremiumUnlocked / passClaimedPremiumTiers are ready and
//     persisted, but nothing ever sets passPremiumUnlocked true yet — that's
//     unlockPassPremium()'s job, meant to be called from a future StoreKit
//     purchase-success handler, once one exists.
//   - Like real battle passes (Fortnite, Brawl Stars), a premium unlock is
//     scoped to ONE season, not permanent — checkPassSeasonExpiry() resets
//     it on rollover same as XP/claims.
// Entirely client-side/localStorage, same as every other persisted system
// here — there's no backend to run a real server-authoritative season on.
const PASS_TIER_COUNT = 25;
const PASS_SEASON_DURATION_MS = 45 * 24 * 60 * 60 * 1000; // 45 days — long enough to not pressure casual play, short enough to keep urgency (industry-standard range for casual mobile passes)
const PASS_XP_PER_METER_DEPTH = 0.1; // 1 XP per 10m reached, this run
const PASS_XP_PER_GOLD = 1;          // 1 XP per Gold collected, this run
const PASS_XP_PER_CONTRACT = 25;     // flat bonus per Daily Contract completed — ties the Pass to the existing daily-return loop

// Tier N costs more XP than tier N-1 (linear ramp: 150, 170, 190, ...) —
// mirrors the same generateUpgradeCosts-style ramp used by the Tech Tree,
// just inlined since this one isn't gold-cost-shaped.
const PASS_TIER_XP_REQUIRED = (() => {
  const costs = [];
  let cost = 150;
  for (let i = 0; i < PASS_TIER_COUNT; i++) {
    costs.push(Math.round(cost));
    cost += 20;
  }
  return costs;
})();

// Every tier grants Gold except the tiers where a TRAIL_DEFS entry declares
// that exact passTier — those grant the trail instead. Reading milestones
// off TRAIL_DEFS (rather than a second hardcoded tier->reward map) keeps the
// trail's unlock tier declared in exactly one place.
// `premiumReward` (same shape as the free reward: {type, amount/trailId,
// label}) is null on every tier for now — real premium content should be
// designed once there's an actual price point and IAP product to attach it
// to, not guessed at here. The field exists so claimPassPremiumTier() and
// the render logic below have something concrete to check for, so wiring
// real content later is a data change, not a logic change.
// skinByTier grants a Base Skin free at two mid-season milestones — real
// variety instead of every non-Trail tier being Gold, reusing the exact
// same unlockedBaseSkins-push mechanism BASE_SKIN_DEFS purchases already
// use (see claimPassTier() below), just triggered by Pass progress instead
// of Diamonds.
const PASS_REWARDS = (() => {
  const trailByTier = {};
  TRAIL_DEFS.forEach((t) => { if (t.passTier !== undefined) trailByTier[t.passTier] = t; });
  const skinByTier = { 10: 'verdant', 20: 'royal' };
  const rewards = [];
  for (let tier = 1; tier <= PASS_TIER_COUNT; tier++) {
    if (trailByTier[tier]) {
      rewards.push({ tier, type: 'trail', trailId: trailByTier[tier].id, label: trailByTier[tier].name, premiumReward: null });
    } else if (skinByTier[tier]) {
      const skin = BASE_SKIN_DEFS.find((s) => s.id === skinByTier[tier]);
      rewards.push({ tier, type: 'base_skin', skinId: skin.id, label: skin.name, premiumReward: null });
    } else if (tier % 3 === 0) {
      const amount = 4 + Math.floor(tier / 3);
      rewards.push({ tier, type: 'diamonds', amount, label: amount + ' 💎', premiumReward: null });
    } else {
      const amount = 30 + tier * 8;
      rewards.push({ tier, type: 'gold', amount, label: amount + ' Gold', premiumReward: null });
    }
  }
  return rewards;
})();

function loadGameCenterAchievementsReported() {
  try {
    const saved = JSON.parse(storageGet('ec_gameCenterAchievementsReported') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadPassClaimedTiers() {
  try {
    const saved = JSON.parse(storageGet('ec_passClaimedTiers') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadPassClaimedPremiumTiers() {
  try {
    const saved = JSON.parse(storageGet('ec_passClaimedPremiumTiers') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

// First-ever load starts the season clock now; every load after that just
// reads it back — until it's more than PASS_SEASON_DURATION_MS old, at which
// point progress resets for a new season (claimed cosmetic rewards are kept
// forever, same as every other unlock in the game; only XP/tier/claims are
// season-scoped).
function loadOrInitPassSeasonStart() {
  let start = parseInt(storageGet('ec_passSeasonStart') || '0', 10);
  if (!start) {
    start = Date.now();
    storageSet('ec_passSeasonStart', String(start));
  }
  return start;
}

function checkPassSeasonExpiry() {
  if (Date.now() - state.passSeasonStart < PASS_SEASON_DURATION_MS) return;
  state.passSeasonStart = Date.now();
  state.passXp = 0;
  state.passClaimedTiers = [];
  state.passSeasonNumber += 1;
  // A premium unlock (once purchasable) only ever covers the season it was
  // bought in — same convention every real battle pass uses — so it resets
  // here right alongside XP/claims, not separately.
  state.passPremiumUnlocked = false;
  state.passClaimedPremiumTiers = [];
  storageSet('ec_passSeasonStart', String(state.passSeasonStart));
  storageSet('ec_passXp', '0');
  storageSet('ec_passClaimedTiers', '[]');
  storageSet('ec_passSeasonNumber', String(state.passSeasonNumber));
  storageSet('ec_passPremiumUnlocked', 'false');
  storageSet('ec_passClaimedPremiumTiers', '[]');
}

// Highest tier fully funded by the given XP total (0 if not even tier 1 yet).
function getPassTierForXp(xp) {
  let cumulative = 0;
  let tier = 0;
  for (let i = 0; i < PASS_TIER_XP_REQUIRED.length; i++) {
    cumulative += PASS_TIER_XP_REQUIRED[i];
    if (xp >= cumulative) tier = i + 1;
    else break;
  }
  return tier;
}

// { tier, xpIntoTier, xpForTier } describing progress toward the NEXT tier,
// or null once every tier is maxed (progress bar shows full/complete instead).
function getPassProgress() {
  const tier = getPassTierForXp(state.passXp);
  if (tier >= PASS_TIER_COUNT) return null;
  let cumulative = 0;
  for (let i = 0; i < tier; i++) cumulative += PASS_TIER_XP_REQUIRED[i];
  return {
    tier,
    xpIntoTier: state.passXp - cumulative,
    xpForTier: PASS_TIER_XP_REQUIRED[tier],
  };
}

function awardPassXp(amount) {
  if (amount <= 0) return;
  state.passXp += Math.round(amount);
  storageSet('ec_passXp', String(state.passXp));
}

function claimPassTier(tier) {
  if (state.passClaimedTiers.includes(tier)) return;
  if (getPassTierForXp(state.passXp) < tier) return;

  const reward = PASS_REWARDS[tier - 1];
  if (reward.type === 'gold') {
    syncBankedGold(reward.amount);
  } else if (reward.type === 'trail' && !state.unlockedTrails.includes(reward.trailId)) {
    state.unlockedTrails.push(reward.trailId);
    storageSet('ec_unlockedTrails', JSON.stringify(state.unlockedTrails));
  } else if (reward.type === 'diamonds') {
    state.diamonds += reward.amount;
    storageSet('ec_diamonds', String(state.diamonds));
  } else if (reward.type === 'base_skin' && !state.unlockedBaseSkins.includes(reward.skinId)) {
    state.unlockedBaseSkins.push(reward.skinId);
    storageSet('ec_unlockedBaseSkins', JSON.stringify(state.unlockedBaseSkins));
  }
  state.passClaimedTiers.push(tier);
  storageSet('ec_passClaimedTiers', JSON.stringify(state.passClaimedTiers));
}

// Mirrors claimPassTier() for the premium track. Currently unreachable from
// any UI (no button calls it, no reward.premiumReward is ever non-null) —
// it exists so the claim FLOW is already correct and tested by the time
// there's real premium content and a purchase to gate it behind.
function claimPassPremiumTier(tier) {
  if (!state.passPremiumUnlocked) return;
  if (state.passClaimedPremiumTiers.includes(tier)) return;
  if (getPassTierForXp(state.passXp) < tier) return;

  const reward = PASS_REWARDS[tier - 1].premiumReward;
  if (!reward) return;
  if (reward.type === 'gold') {
    syncBankedGold(reward.amount);
  } else if (reward.type === 'trail' && !state.unlockedTrails.includes(reward.trailId)) {
    state.unlockedTrails.push(reward.trailId);
    storageSet('ec_unlockedTrails', JSON.stringify(state.unlockedTrails));
  }
  state.passClaimedPremiumTiers.push(tier);
  storageSet('ec_passClaimedPremiumTiers', JSON.stringify(state.passClaimedPremiumTiers));
}

// Intended call site: a future StoreKit purchase-success handler (Capacitor
// IAP plugin's `purchase` resolving successfully for the Season Pass
// product), once that product actually exists in App Store Connect. Not
// called from anywhere yet — deliberately not wired to any button so
// nothing purchasable is offered before there's a real payment behind it.
function unlockPassPremium() {
  state.passPremiumUnlocked = true;
  storageSet('ec_passPremiumUnlocked', 'true');
}

// Runs once at script load, after the Pass constants above and the `state`
// object (further up the file — safe because `state` itself is only *read*
// here, not depended on for anything except starting the season clock) both
// exist. Resets Pass progress if the 45-day season already ended while the
// player was away.
checkPassSeasonExpiry();

// ---------- Juice: particles ----------
const particles = [];

function spawnParticles(worldX, worldY, color, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 100;
    particles.push({
      worldX,
      worldY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40, // slight upward pop
      life: 0.3 + Math.random() * 0.3,
      maxLife: 0.6,
      size: 2 + Math.random() * 3,
      color,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.worldX += p.vx * dt;
    p.worldY += p.vy * dt;
    p.vy += 260 * dt; // gravity
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function renderParticles(cameraY) {
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.worldX, p.worldY - cameraY, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

// ---------- Juice: screen shake ----------
let shakeTimer = 0;
let shakeMagnitude = 0;

function triggerScreenShake(magnitude, duration) {
  // a bigger/longer shake always wins over a smaller one already in progress
  shakeMagnitude = Math.max(shakeMagnitude, magnitude);
  shakeTimer = Math.max(shakeTimer, duration);
}

function updateScreenShake(dt) {
  if (shakeTimer <= 0) return;
  shakeTimer -= dt;
  if (shakeTimer <= 0) {
    shakeTimer = 0;
    shakeMagnitude = 0;
  }
}

// ---------- Juice: near-miss combo ----------
const COMBO_INCREMENT = 0.1;
const COMBO_MAX = 3.0;
const NEAR_MISS_MARGIN = 5; // px

// Tracks which stone cells have already paid out a near-miss bonus, so
// grazing the same block doesn't rack up the multiplier every frame.
let awardedNearMissCells = new Set();

function updateNearMissCombo() {
  const left = drill.worldX - NEAR_MISS_MARGIN;
  const right = drill.worldX + drill.width + NEAR_MISS_MARGIN;
  const top = drill.worldY - NEAR_MISS_MARGIN;
  const bottom = drill.worldY + drill.height + NEAR_MISS_MARGIN;

  const colStart = Math.max(0, Math.floor(left / BLOCK));
  const colEnd = Math.min(COLS - 1, Math.floor((right - 0.01) / BLOCK));
  const rowStart = Math.floor(top / BLOCK);
  const rowEnd = Math.floor((bottom - 0.01) / BLOCK);

  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      // Stone actually collided with this frame is destroyed by
      // updateCollisions() before this runs, so anything still STONE here
      // was genuinely passed without hitting it.
      if (getBlock(r, c) !== STONE) continue;
      const key = r + '_' + c;
      if (awardedNearMissCells.has(key)) continue;
      awardedNearMissCells.add(key);
      state.comboMultiplier = clamp(state.comboMultiplier + COMBO_INCREMENT, 1.0, COMBO_MAX);
      addOverdriveMeter(OVERDRIVE_NEAR_MISS_GAIN);
    }
  }
}

// ---------- Core Overdrive (Fever Mode) ----------
// Meter fills from near-misses (+5, see updateNearMissCombo above) and Gold
// pickups (+2, see updateCollisions/updateMagnet below). At 100 it triggers
// a 5s window of 2x fall speed + full collision invincibility, then resets
// to 0 — the player has to earn it again from scratch.
const OVERDRIVE_MAX = 100;
const OVERDRIVE_NEAR_MISS_GAIN = 5;
const OVERDRIVE_GOLD_GAIN = 2;
const OVERDRIVE_DURATION = 5; // seconds
const OVERDRIVE_GOLD_PER_BLOCK = 2; // awarded per Stone/Gas pulverized while active

function addOverdriveMeter(amount) {
  if (state.overdriveActive) return; // already maxed out and running — nothing to accumulate
  state.overdriveMeter = clamp(state.overdriveMeter + amount, 0, OVERDRIVE_MAX);
  if (state.overdriveMeter >= OVERDRIVE_MAX) triggerOverdrive();
}

function triggerOverdrive() {
  state.overdriveActive = true;
  state.overdriveTimer = OVERDRIVE_DURATION;
  state.overdriveMeter = 0;
  triggerScreenShake(10, 0.25);
  vibrateHaptic(30);
  playSound('overdrive');
}

function updateOverdrive(dt) {
  if (!state.overdriveActive) return;
  state.overdriveTimer -= dt;
  if (state.overdriveTimer <= 0) {
    state.overdriveActive = false;
    state.overdriveTimer = 0;
  }
}

// ---------- Visual upgrade feedback ----------
// Rookie's look still progresses with the Fuel Tank upgrade level so power
// feels visible. Jackhammer/Plasma have their own fixed color identity (per
// the Drill Classes system below) — upgrade level only modulates their glow
// intensity, since their shape/hitbox already makes them read as distinct.
const DRILL_APPEARANCE = [
  { body: '#e0e0e0', nose: '#ff9800', border: '#333333', glow: null, glowBlur: 0, borderWidth: 2 },                     // level 0 - stock
  { body: '#cfd8dc', nose: '#ffa726', border: '#455a64', glow: 'rgba(255,167,38,0.35)', glowBlur: 14, borderWidth: 2 },  // level 1
  { body: '#b3e5fc', nose: '#29b6f6', border: '#01579b', glow: 'rgba(41,182,246,0.45)', glowBlur: 14, borderWidth: 2 },  // level 2
  { body: '#c8e6c9', nose: '#66bb6a', border: '#1b5e20', glow: 'rgba(102,187,106,0.5)', glowBlur: 14, borderWidth: 2 },  // level 3
  { body: '#ffe082', nose: '#ffca28', border: '#ff6f00', glow: 'rgba(255,202,40,0.55)', glowBlur: 14, borderWidth: 2 },  // level 4
  { body: '#ff8a80', nose: '#ff5252', border: '#b71c1c', glow: 'rgba(255,82,82,0.65)', glowBlur: 14, borderWidth: 2 },   // level 5 - max, molten
];

function getDrillAppearance() {
  // Overdrive fully overrides the drill's look for its 5s window — an
  // intense yellow/white glow that reads as "invincible" at a glance,
  // regardless of active Drill Class or upgrade tier.
  if (state.overdriveActive) {
    return {
      body: '#fffde7',
      nose: '#ffee58',
      border: '#ffd600',
      glow: 'rgba(255,255,255,0.95)',
      glowBlur: 30,
      borderWidth: 3,
    };
  }

  const classId = state.selectedClass;
  const glowProgress = clamp(state.fuelUpgradeLevel / FUEL_UPGRADE_MAX_LEVEL, 0, 1); // 0..1 across upgrade levels

  if (classId === 'JACKHAMMER') {
    // wide, red, industrial — heavier outline reads as "armored"
    return {
      body: '#c62828',
      nose: '#6d0f0f',
      border: '#3a0a0a',
      glow: state.fuelUpgradeLevel > 0 ? `rgba(198,40,40,${0.3 + glowProgress * 0.4})` : null,
      glowBlur: 10 + glowProgress * 10,
      borderWidth: 3,
    };
  }
  if (classId === 'PLASMA') {
    // slim, cyan, always glowing hard — the trait is inherent, not upgrade-gated
    return {
      body: '#4dd8ff',
      nose: '#00b8d4',
      border: '#0097a7',
      glow: `rgba(0,229,255,${0.55 + glowProgress * 0.35})`,
      glowBlur: 20 + glowProgress * 14,
      borderWidth: 1.5,
    };
  }

  // ROOKIE: the original tiered look, unchanged
  const idx = clamp(state.fuelUpgradeLevel, 0, DRILL_APPEARANCE.length - 1);
  return DRILL_APPEARANCE[idx];
}

// ---------- Haptics ----------
// The Web Vibration API is Android-only — iOS Safari/WKWebView has never
// implemented it — which means every vibrateHaptic() call in this file was
// a silent no-op on the one platform this game actually ships to natively.
// @capacitor/haptics wraps the real Taptic Engine (UIImpactFeedbackGenerator/
// UINotificationFeedbackGenerator) on native iOS; falls back to the Web
// Vibration API on web/Android so nothing regresses there. Every existing
// call site keeps its exact durationMs argument unchanged — only the
// dispatch here changed, mapping duration to the closest native feedback
// intensity instead of a literal millisecond count (which native haptics
// don't take anyway).
function getHapticsPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) || null;
}

function vibrateHaptic(durationMs = 10) {
  if (!hasUserGestured || state.hapticsDisabled) return;

  if (isNativeMobile) {
    const haptics = getHapticsPlugin();
    if (!haptics) return;
    try {
      if (durationMs <= 12) haptics.impact({ style: 'LIGHT' });
      else if (durationMs <= 22) haptics.impact({ style: 'MEDIUM' });
      else if (durationMs <= 32) haptics.notification({ type: 'SUCCESS' }); // Overdrive/relic — celebratory
      else haptics.notification({ type: 'ERROR' }); // Gas Pocket damage — the one "bad" event that vibrates
    } catch (e) {
      // best-effort — a failed haptic call never blocks gameplay
    }
    return;
  }

  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(durationMs);
  }
}

// Any button tap gets a light confirmation buzz — delegated so new buttons
// are covered automatically without wiring haptics into every handler.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) vibrateHaptic(10);
});

// ---------- SDK-driven platform pause ----------
// Distinct from the game's own round-lifecycle pausing (pauseGameLoop(), used
// for game-over / Chest overlays) — this fires from Bridge's
// PAUSE_STATE_CHANGED event at ANY point (start screen, mid-run, mid-overlay), so it has to work
// regardless of what else is happening. isPaused guards every input handler
// and the loop itself, backing up the CSS pointer-events lockout.
let isPaused = false;
let wasRunningBeforePause = false;

function handleSdkPause() {
  if (isPaused) return;
  isPaused = true;
  document.body.classList.add('paused');
  pauseOverlay.classList.remove('hidden');
  wasRunningBeforePause = state.running;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  muteAudio();
  storageSet('ec_lastPlayedTimestamp', String(Date.now())); // platform pause = player left; freshen the offline-mining clock
  scheduleReturnNotifications(); // fire-and-forget, native-only — see the Local notifications section above
}

function handleSdkResume() {
  if (!isPaused) return;
  isPaused = false;
  document.body.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  unmuteAudio();
  if (wasRunningBeforePause) {
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  cancelReturnNotifications(); // the player is back — both "come back" nudges are moot until they leave again
}

// ---------- Input handling ----------
const input = { left: false, right: false };

function setInputFromClientX(clientX, active) {
  const rect = canvas.getBoundingClientRect();
  const relX = clientX - rect.left;
  const half = rect.width / 2;
  if (!active) {
    input.left = false;
    input.right = false;
    return;
  }
  if (relX < half) {
    input.left = true;
    input.right = false;
  } else {
    input.right = true;
    input.left = false;
  }
}

let pointerActive = false;
canvas.addEventListener('pointerdown', (e) => {
  if (isPaused) return;
  pointerActive = true;
  setInputFromClientX(e.clientX, true);
  vibrateHaptic(10);
});
window.addEventListener('pointermove', (e) => {
  if (isPaused) return;
  if (pointerActive) setInputFromClientX(e.clientX, true);
});
window.addEventListener('pointerup', () => {
  if (isPaused) return;
  pointerActive = false;
  setInputFromClientX(0, false);
});
window.addEventListener('pointercancel', () => {
  if (isPaused) return;
  pointerActive = false;
  setInputFromClientX(0, false);
});

// Keyboard support (desktop convenience)
window.addEventListener('keydown', (e) => {
  if (isPaused) return;
  if (e.key === 'ArrowLeft' || e.key === 'a') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') input.right = true;
});
window.addEventListener('keyup', (e) => {
  if (isPaused) return;
  if (e.key === 'ArrowLeft' || e.key === 'a') input.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd') input.right = false;
});

// ---------- UI elements ----------
const depthDisplay = document.getElementById('depth-display');
const goldAmountTextEl = document.getElementById('gold-amount-text');
const diamondDisplay = document.getElementById('diamond-display');
const scoreDisplay = document.getElementById('score-display');
const comboDisplay = document.getElementById('combo-display');
const biomeDisplay = document.getElementById('biome-display');
const magnetDisplay = document.getElementById('magnet-display');
const shieldDisplay = document.getElementById('shield-display');
const scoreBoostDisplay = document.getElementById('score-boost-display');
const healthBarInner = document.getElementById('health-bar-inner');
const overdriveBarOuter = document.getElementById('overdrive-bar-outer');
const overdriveBarInner = document.getElementById('overdrive-bar-inner');
const overdriveFlashEl = document.getElementById('overdrive-flash');

const startScreen = document.getElementById('start-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const upgradesScreen = document.getElementById('upgrades-screen');
const chestScreen = document.getElementById('chest-screen');
const museumScreen = document.getElementById('museum-screen');
const contractsScreen = document.getElementById('contracts-screen');
const loadoutScreen = document.getElementById('loadout-screen');
const trailsScreen = document.getElementById('trails-screen');
const passScreen = document.getElementById('pass-screen');
const settingsScreen = document.getElementById('settings-screen');
const achievementsScreen = document.getElementById('achievements-screen');
const baseScreen = document.getElementById('base-screen');
const welcomeBackScreen = document.getElementById('welcome-back-screen');
const tutorialScreen = document.getElementById('tutorial-screen');
const toastEl = document.getElementById('toast');
const pauseOverlay = document.getElementById('pause-overlay');
const pauseBtn = document.getElementById('pause-btn');
const manualPauseScreen = document.getElementById('manual-pause-screen');

const finalDepthEl = document.getElementById('final-depth');
const finalGoldEl = document.getElementById('final-gold');
const finalScoreEl = document.getElementById('final-score');
const contractBonusEl = document.getElementById('final-contract-bonus');
const bankedGoldEl = document.getElementById('banked-gold');
const startHighscoreEl = document.getElementById('start-highscore');
const startGoldAmountEl = document.getElementById('start-gold-amount');
const startDiamondAmountEl = document.getElementById('start-diamond-amount');
const startStreakPillEl = document.getElementById('start-streak-pill');
const startStreakAmountEl = document.getElementById('start-streak-amount');
const passClaimBadgeEl = document.getElementById('pass-claim-badge');
const highscoreDisplayEl = document.getElementById('highscore-display');
const newHighscoreBadge = document.getElementById('new-highscore-badge');
const fuelUpgradeDescEl = document.getElementById('fuel-upgrade-desc');
const fuelUpgradeBtn = document.getElementById('fuel-upgrade-btn');
const coolingUpgradeDescEl = document.getElementById('cooling-upgrade-desc');
const coolingUpgradeBtn = document.getElementById('cooling-upgrade-btn');
const thrusterUpgradeDescEl = document.getElementById('thruster-upgrade-desc');
const thrusterUpgradeBtn = document.getElementById('thruster-upgrade-btn');
const alloyUpgradeDescEl = document.getElementById('alloy-upgrade-desc');
const alloyUpgradeBtn = document.getElementById('alloy-upgrade-btn');
const baseDiamondAmountEl = document.getElementById('base-diamond-amount');
const baseClaimBadgeEl = document.getElementById('base-claim-badge');
const startBaseBtn = document.getElementById('start-base-btn');
const startBaseProgressEl = document.getElementById('start-base-progress');
const offlineRigUpgradeDescEl = document.getElementById('offline-rig-upgrade-desc');
const offlineRigUpgradeBtn = document.getElementById('offline-rig-upgrade-btn');
const diamondSieveUpgradeDescEl = document.getElementById('diamond-sieve-upgrade-desc');
const diamondSieveUpgradeBtn = document.getElementById('diamond-sieve-upgrade-btn');
const relicScannerUpgradeDescEl = document.getElementById('relic-scanner-upgrade-desc');
const relicScannerUpgradeBtn = document.getElementById('relic-scanner-upgrade-btn');
const contractRunnerUpgradeDescEl = document.getElementById('contract-runner-upgrade-desc');
const contractRunnerUpgradeBtn = document.getElementById('contract-runner-upgrade-btn');
const prestigeLevelLabelEl = document.getElementById('prestige-level-label');
const prestigeDescEl = document.getElementById('prestige-desc');
const prestigeBtn = document.getElementById('prestige-btn');
const startLeaderboardBtn = document.getElementById('start-leaderboard-btn');
const baseWatchAdDiamondBtn = document.getElementById('base-watch-ad-diamond-btn');
const baseSkinListEl = document.getElementById('base-skin-list');
const trailListEl = document.getElementById('trail-list');
const trailsBankedGoldEl = document.getElementById('trails-banked-gold');
const welcomeBackGoldEl = document.getElementById('welcome-back-gold');
const welcomeBackDoubleBtn = document.getElementById('welcome-back-double-btn');
const reviveBtn = document.getElementById('revive-btn');
const doubleGoldBtn = document.getElementById('double-gold-btn');
const REVIVE_BTN_DEFAULT_TEXT = reviveBtn.textContent;
const DOUBLE_GOLD_BTN_DEFAULT_TEXT = doubleGoldBtn.textContent;
const WELCOME_BACK_DOUBLE_BTN_DEFAULT_TEXT = welcomeBackDoubleBtn.textContent;

document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('restart-btn').addEventListener('click', startGame);

// Wraps Bridge's event-based rewarded flow (showRewarded() triggers the ad;
// completion arrives later via a REWARDED_STATE_CHANGED event, not the call's
// own return value) into the same "resolve true/false once" shape every
// other showRewardedVideo() branch already returns, so callers don't need to
// know which SDK is behind it. Resolves false on any missing API, since
// callers already only grant a reward inside `if (watched) { ... }`.
function bridgeShowRewarded(placement) {
  return new Promise((resolve) => {
    const ads = window.bridge && window.bridge.advertisement;
    if (!(ads && ads.showRewarded)) { resolve(false); return; }
    let settled = false;
    const eventName = window.bridge.EVENT_NAME && window.bridge.EVENT_NAME.REWARDED_STATE_CHANGED;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (eventName && typeof ads.off === 'function') {
        try { ads.off(eventName, onState); } catch (e) {}
      }
      resolve(result);
    };
    const onState = (adState) => {
      if (adState === 'rewarded') finish(true);
      else if (adState === 'closed' || adState === 'failed') finish(false);
    };
    try {
      if (eventName && typeof ads.on === 'function') ads.on(eventName, onState);
      ads.showRewarded(placement);
    } catch (e) {
      finish(false);
    }
  });
}

// ---------- Rewarded video ads ----------
// Routes through the real Playgama Bridge SDK (bridge.advertisement,
// bridgeShowRewarded() above) when present — which the certification
// harness's mock always provides, so that path is what gets exercised during
// testing. The setTimeout-based branch only runs as a dev fallback when
// NEITHER Bridge nor a test mock is injected (e.g. opening index.html
// directly in a plain browser), so the ad flow stays testable outside any
// platform env. Player-initiated only (only ever called from a click
// handler); resolves false on any failure/throw — callers already only
// grant their reward inside `if (watched) { ... }`.
async function showRewardedVideo(rewardId) {
  muteAudio(); // duck game audio for the duration of the ad

  if (isNativeMobile) {
    const admob = getAdMobPlugin();
    if (!admob) { unmuteAudio(); return false; } // plugin not registered — fail closed, never throw
    try {
      await admob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_AD_UNIT_ID });
      const rewardItem = await admob.showRewardVideoAd();
      unmuteAudio();
      return !!rewardItem; // truthy reward item = actually watched through
    } catch (e) {
      unmuteAudio();
      return false; // load/show failure or dismissed early = no reward, not a crash
    }
  }

  if (window.bridge && bridgeReadyPromise) {
    // Required: never touch bridge.advertisement until initialize() has
    // actually resolved — reading it any earlier (even just this property
    // check) logs a real SDK warning, confirmed against the live CDN script.
    try { await bridgeReadyPromise; } catch (e) { /* fall through to dev fallback below */ }
    if (window.bridge.advertisement && window.bridge.advertisement.isRewardedSupported) {
      const result = await bridgeShowRewarded(rewardId);
      unmuteAudio();
      return result;
    }
  }

  return new Promise((resolve) => {
    const loadDelay = 800 + Math.random() * 1200; // fake network/ad-load latency
    setTimeout(() => {
      const watched = Math.random() < 0.75; // ~75% fill/completion rate for testing
      unmuteAudio(); // restore game audio whether the ad succeeded or failed
      resolve(watched);
    }, loadDelay);
  });
}

const REWARD_ID_REVIVE = 'endlesscore-revive';
const REWARD_ID_DOUBLE_GOLD = 'endlesscore-2xgold';
const REWARD_ID_BONUS_DIAMOND = 'endlesscore-bonusdiamond';

// Chest power-ups — previously Magnet was the only thing a Supply Cache
// could grant. Endless runners with real power-up variety (Subway Surfers'
// jetpack/magnet/multiplier roster) give players a different reason to open
// every cache instead of the same single choice every time. One is rolled
// randomly per Chest; each still follows the exact "watch ad to activate or
// skip" shape the original Magnet used.
const CHEST_POWERUPS = {
  MAGNET: {
    id: 'MAGNET',
    duration: 10,
    desc: 'Auto-collects nearby Gold for a while.',
    adBtnLabel: (d) => `🧲 Watch Ad to Activate Magnet (${d}s)`,
    rewardId: 'endlesscore-magnet',
  },
  SHIELD: {
    id: 'SHIELD',
    duration: 8,
    desc: 'Immune to Stone & Gas damage for a while.',
    adBtnLabel: (d) => `🛡️ Watch Ad to Activate Shield (${d}s)`,
    rewardId: 'endlesscore-shield',
  },
  SCORE_BOOST: {
    id: 'SCORE_BOOST',
    duration: 12,
    desc: '2x Score from Gold & Depth for a while.',
    adBtnLabel: (d) => `⭐ Watch Ad to Activate 2x Score (${d}s)`,
    rewardId: 'endlesscore-scoreboost',
  },
};
const CHEST_POWERUP_IDS = Object.keys(CHEST_POWERUPS);

// AdMob (native ads on iOS/Android, via @capacitor-community/admob). Real ad
// unit IDs from the account — these serve real ads and count toward real
// revenue/impressions, unlike Google's public demo IDs used during initial
// integration. iOS and Android are two separate apps in the same AdMob
// account, each with its own distinct App ID and per-format ad unit IDs —
// see also Info.plist's GADApplicationIdentifier for iOS and
// AndroidManifest.xml's matching meta-data tag for Android.
const ADMOB_INTERSTITIAL_AD_UNIT_ID = isAndroidNative
  ? 'ca-app-pub-5040304268747359/2613811734'
  : 'ca-app-pub-5040304268747359/3571606543';
const ADMOB_REWARDED_AD_UNIT_ID = isAndroidNative
  ? 'ca-app-pub-5040304268747359/6417325372'
  : 'ca-app-pub-5040304268747359/8664151129';
// Rewarded Interstitial ad unit exists in the AdMob account for iOS
// (ca-app-pub-5040304268747359/7351069456) but isn't wired up — nothing in
// the game currently uses that ad format (it auto-shows at a break without
// the player opting in first, unlike the plain Rewarded flow the "Watch Ad
// to ..." buttons use). Left here as a note in case that changes later.

function getAdMobPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) || null;
}

// Requests App Tracking Transparency permission (Apple requires this before
// an app may use the IDFA for ads — App Review checks for it) and GDPR/UK
// consent via Google's UMP flow (required for EEA/UK users). Both are
// best-effort: declining either just means less personalized ads, never a
// blocked game — matches this file's existing "SDK wiring must never break
// the game" philosophy throughout.
async function initAdMob() {
  const admob = getAdMobPlugin();
  if (!admob) return;
  try {
    await admob.initialize();

    // GDPR/UK consent (Google's own UMP flow) is a separate legal
    // requirement from Apple's ATT, not contingent on it — it governs ad
    // personalization/data-processing consent for EEA/UK users generally,
    // independent of whether they've granted IDFA tracking specifically.
    // Gating it behind ATT authorization (the previous code did) meant
    // the consent form silently never showed for the majority of users,
    // who decline the ATT prompt — a real compliance gap, not just a
    // missed personalization opportunity. Sequenced before the ATT
    // request too, matching Google's own reference UMP integration order.
    const consentInfo = await admob.requestConsentInfo();
    if (
      consentInfo.isConsentFormAvailable &&
      consentInfo.status === 'REQUIRED' // AdmobConsentStatus.REQUIRED — a plain string enum, safe to reference directly without importing it
    ) {
      await admob.showConsentForm();
    }

    const trackingInfo = await admob.trackingAuthorizationStatus();
    if (trackingInfo.status === 'notDetermined') {
      await admob.requestTrackingAuthorization();
    }
  } catch (e) {
    // AdMob init/consent wiring must never block the game from running
  }
}

// ---------- Game Center ----------
// Wraps a small custom native plugin (ios/App/App/GameCenterPlugin.swift),
// not an npm package — the only maintained community Capacitor plugin for
// Game Center peer-depends on Capacitor 5 (three majors behind this
// project's Capacitor 8), so a first-party GameKit wrapper written directly
// for this app was the lower-risk choice. See that file's own header
// comment for the full reasoning.
//
// GAME_CENTER_LEADERBOARD_ID is a placeholder — inert until the app owner
// (1) enables the Game Center capability for this App ID in the Apple
// Developer portal, (2) creates a leaderboard with this exact ID in App
// Store Connect (or updates this constant to match one already created),
// and (3) adds the Game Center entitlement, most safely via Xcode's own
// "+ Capability" button once step 1 is done. Every call here is best-effort
// and silently no-ops without any of that — never blocks gameplay.
const GAME_CENTER_LEADERBOARD_ID = 'endless_core_high_score';
let gameCenterAuthAttempted = false;
let gameCenterAuthenticated = false;

function getGameCenterPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GameCenter) || null;
}

async function authenticateGameCenter() {
  if (!isNativeMobile) return;
  const plugin = getGameCenterPlugin();
  if (!plugin) return;
  try {
    const result = await plugin.authenticate();
    gameCenterAuthenticated = !!result.authenticated;
    if (gameCenterAuthenticated) checkAndReportGameCenterAchievements(); // catches anything already earned before auth completed (e.g. a returning player who already cleared a threshold pre-Game-Center)
  } catch (e) {
    gameCenterAuthenticated = false;
  }
}

// showLeaderboard() on the native side (GameCenterPlugin.swift) already
// exists and presents Apple's own GKGameCenterViewController — this is the
// real, genuinely global (cross-device, via Apple ID) leaderboard the game
// already submits scores to at endGame(). On web, the same button falls
// through to Playgama's Bridge SaaS leaderboard (see the "Bridge
// leaderboard (web)" section below) — one button, platform picked
// automatically by isNativeMobile, same as every other cross-platform
// entry point in this file. Lazily authenticates first, since the menu's
// Leaderboard button can be tapped before any run has ever started (the
// only other authenticateGameCenter() call site is startGame()).
async function openLeaderboard() {
  if (isNativeMobile) {
    const plugin = getGameCenterPlugin();
    if (!plugin) return;
    if (!gameCenterAuthenticated) await authenticateGameCenter();
    if (!gameCenterAuthenticated) {
      queueToast('Game Center unavailable');
      return;
    }
    try {
      await plugin.showLeaderboard();
    } catch (e) {
      // best-effort — never blocks the menu
    }
    return;
  }

  if (!(window.bridge && bridgeReadyPromise)) { queueToast('Leaderboard unavailable'); return; }
  try {
    await bridgeReadyPromise;
    const lb = window.bridge.leaderboards;
    if (!lb) { queueToast('Leaderboard unavailable'); return; }
    if (lb.type === 'native_popup' && lb.showNativePopup) {
      await lb.showNativePopup(BRIDGE_LEADERBOARD_ID);
    } else if (lb.type === 'in_game' && lb.getEntries) {
      const entries = await lb.getEntries(BRIDGE_LEADERBOARD_ID);
      renderLeaderboardScreen(entries || []);
      openOverlay(leaderboardScreen);
    } else {
      queueToast('Leaderboard unavailable'); // 'not_available', or platform doesn't support either UI mode
    }
  } catch (e) {
    queueToast('Leaderboard unavailable');
  }
}

async function submitGameCenterScore(score) {
  if (!isNativeMobile || !gameCenterAuthenticated) return;
  const plugin = getGameCenterPlugin();
  if (!plugin) return;
  try {
    await plugin.submitScore({ leaderboardID: GAME_CENTER_LEADERBOARD_ID, score: Math.round(score) });
  } catch (e) {
    // best-effort — a failed submission never blocks gameplay
  }
}

async function submitGameCenterAchievement(achievementID) {
  if (!isNativeMobile || !gameCenterAuthenticated) return;
  const plugin = getGameCenterPlugin();
  if (!plugin) return;
  try {
    await plugin.reportAchievement({ achievementID, percentComplete: 100 });
  } catch (e) {
    // best-effort — a failed report never blocks gameplay
  }
}

// ---------- Bridge leaderboard (web) ----------
// Web equivalent of GAME_CENTER_LEADERBOARD_ID above — same naming, so the
// two are easy to tell apart at a glance. This is Playgama's SaaS
// leaderboard service (see playgama-bridge-config.json's "saas"/
// "leaderboards" blocks) — the actual public token and leaderboard-service
// enablement is configured there, not here.
const BRIDGE_LEADERBOARD_ID = 'endless_core_high_score';
const leaderboardScreen = document.getElementById('leaderboard-screen');
const leaderboardListEl = document.getElementById('leaderboard-list');

function submitBridgeLeaderboardScore(score) {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    if (window.bridge.leaderboards && window.bridge.leaderboards.setScore) {
      return window.bridge.leaderboards.setScore(BRIDGE_LEADERBOARD_ID, Math.round(score));
    }
  }).catch(() => {});
}

// Only reached when bridge.leaderboards.type === 'in_game' — that mode
// means the platform has no leaderboard UI of its own, so Bridge hands back
// raw entries (see getEntries() in openLeaderboard()) and this game has to
// render them itself, same responsibility as any other in-game overlay.
function renderLeaderboardScreen(entries) {
  if (!entries.length) {
    leaderboardListEl.innerHTML = '<div class="leaderboard-empty">No scores yet — be the first!</div>';
    return;
  }
  leaderboardListEl.innerHTML = entries.map((e) => `
    <div class="leaderboard-row">
      <div class="leaderboard-rank">#${e.rank}</div>
      ${e.photo ? `<img class="leaderboard-photo" src="${e.photo}" alt="" />` : '<div class="leaderboard-photo leaderboard-photo-placeholder"></div>'}
      <div class="leaderboard-name">${e.name || 'Player'}</div>
      <div class="leaderboard-score">${e.score}</div>
    </div>
  `).join('');
}

// ---------- App Store review prompt ----------
// SKStoreReviewController is rate-limited by Apple itself (roughly 3
// prompts per 365 days across ALL apps that ask) — no cooldown needed on
// our side for that. What IS worth gating ourselves: never ask on a brand
// new player's very first-ever run (they have no basis to judge the app
// yet), and only on a genuine new high score — one unambiguous "this just
// went well" beat, not a random interruption. @capacitor-community/in-app-
// review wraps requestReview(in:) directly; it may silently decline to
// show anything at all (Apple's own throttling), which is expected and
// fine, never treated as an error.
let reviewPromptedThisSession = false;

function getInAppReviewPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.InAppReview) || null;
}

async function maybeRequestReview(isFirstRunEver) {
  if (!isNativeMobile || isFirstRunEver || reviewPromptedThisSession) return;
  const plugin = getInAppReviewPlugin();
  if (!plugin) return;
  reviewPromptedThisSession = true; // set before the call — never ask twice in one session even if this attempt fails
  try {
    await plugin.requestReview();
  } catch (e) {
    // best-effort — Apple declining to show it is expected, not a failure
  }
}

// ---------- Share ----------
// @capacitor/share on native; falls back to the real Web Share API on web
// (iOS Safari has supported navigator.share for years, so this isn't a
// Playables-specific gap the way haptics was) — never a raw "copy link"
// fallback, since a share sheet that doesn't actually offer to share isn't
// worth building.
function getSharePlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) || null;
}

async function shareScore() {
  const score = currentScore();
  const shareText = `I just scored ${score} in Endless Core: Mining Rush! Depth: ${state.maxDepthReached}m, Gold: ${state.gold}. Can you beat me?`;
  const shareUrl = 'https://seantomaslynch-cell.github.io/endless-core/';

  try {
    if (isNativeMobile) {
      const share = getSharePlugin();
      if (!share) return;
      await share.share({ title: 'Endless Core: Mining Rush', text: shareText, url: shareUrl, dialogTitle: 'Share your run' });
    } else if (navigator.share) {
      await navigator.share({ title: 'Endless Core: Mining Rush', text: shareText, url: shareUrl });
    }
  } catch (e) {
    // user cancelling the share sheet throws too — never treated as an error
  }
}

// Named (not an anonymous click closure) so it's directly callable by a test
// harness. Grants the revive ONLY when the ad resolves truthy.
async function watchAdRevive() {
  if (reviveBtn.disabled) return;
  reviveBtn.disabled = true;
  reviveBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo(REWARD_ID_REVIVE);

  if (watched) {
    console.log('AD: Revive ad watched — restoring 50% health');
    drill.health = drill.maxHealth * 0.5;
    state.gameOver = false;
    state.running = true;
    drill.invulnTimer = 1.5;
    gameoverScreen.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    reviveBtn.textContent = REVIVE_BTN_DEFAULT_TEXT;
    reviveBtn.disabled = false;
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(loop);
    ambientPadFadeIn();
  } else {
    console.log('AD: Revive ad failed to load / was not completed');
    reviveBtn.textContent = 'Ad Unavailable — Try Again';
    setTimeout(() => {
      reviveBtn.textContent = REVIVE_BTN_DEFAULT_TEXT;
      reviveBtn.disabled = false;
    }, 1500);
  }
}
reviveBtn.addEventListener('click', watchAdRevive);

// Named for the same reason as watchAdRevive(); grants the reward only on a
// truthy resolve.
async function watchAdDoubleGold() {
  if (doubleGoldBtn.disabled) return;
  doubleGoldBtn.disabled = true;
  doubleGoldBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo(REWARD_ID_DOUBLE_GOLD);

  if (watched) {
    console.log('AD: 2x Gold ad watched — doubling gold');
    state.gold *= 2;
    finalGoldEl.textContent = state.gold;
    syncBankedGold(state.gold - state.gold / 2); // add the bonus half to bank
    updateHighScore();
    doubleGoldBtn.textContent = 'Gold Doubled!';
    // stays disabled for the rest of this game-over screen — one double per run
  } else {
    console.log('AD: 2x Gold ad failed to load / was not completed');
    doubleGoldBtn.textContent = 'Ad Unavailable — Try Again';
    setTimeout(() => {
      doubleGoldBtn.textContent = DOUBLE_GOLD_BTN_DEFAULT_TEXT;
      doubleGoldBtn.disabled = false;
    }, 1500);
  }
}
doubleGoldBtn.addEventListener('click', watchAdDoubleGold);
document.getElementById('share-score-btn').addEventListener('click', shareScore);

// ---------- Shared overlay open/close ----------
// Upgrades/Museum/Contracts/Loadout/Trails are all reachable from either
// the Start Screen or the Game Over screen. Without this, opening one from
// Game Over left gameoverScreen visible underneath (it has no owning
// "close" of its own to fall back on), so both rendered at once through
// each other's translucent background — exactly the double-exposed text
// bug reported from a real device. openOverlay() remembers whichever base
// screen (Start or Game Over) was actually showing and closeOverlay()
// restores it, instead of every overlay guessing/hardcoding one.
let overlayReturnScreen = null;

function openOverlay(screenEl) {
  hideMenuBanner(); // sub-menu screens scroll internally — not a confirmed-safe placement, see showMenuBanner's comment
  if (!startScreen.classList.contains('hidden')) overlayReturnScreen = startScreen;
  else if (!gameoverScreen.classList.contains('hidden')) overlayReturnScreen = gameoverScreen;
  upgradesScreen.classList.add('hidden');
  museumScreen.classList.add('hidden');
  contractsScreen.classList.add('hidden');
  loadoutScreen.classList.add('hidden');
  trailsScreen.classList.add('hidden');
  passScreen.classList.add('hidden');
  settingsScreen.classList.add('hidden');
  achievementsScreen.classList.add('hidden');
  baseScreen.classList.add('hidden');
  leaderboardScreen.classList.add('hidden');
  startScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  screenEl.classList.remove('hidden');
}

function closeOverlay(screenEl) {
  screenEl.classList.add('hidden');
  if (overlayReturnScreen) overlayReturnScreen.classList.remove('hidden');
  overlayReturnScreen = null;
  updateStartScreenHud(); // covers every path back to the start screen in one place
  showMenuBanner(); // returning to Start or Game Over — both confirmed-safe placements
}

// Refreshes the main menu's persistent Gold/streak readout and the Season
// Pass "something's claimable" badge — cheap enough to call on every return
// to the start screen rather than tracking exactly what might have changed.
function updateStartScreenHud() {
  startGoldAmountEl.textContent = state.bankedGold;
  startDiamondAmountEl.textContent = state.diamonds;

  if (state.loginStreak >= 2) {
    startStreakPillEl.classList.remove('hidden');
    startStreakAmountEl.textContent = state.loginStreak;
  } else {
    startStreakPillEl.classList.add('hidden');
  }

  const currentTier = getPassTierForXp(state.passXp);
  const hasClaimable = PASS_REWARDS.some((r) => r.tier <= currentTier && !state.passClaimedTiers.includes(r.tier));
  passClaimBadgeEl.classList.toggle('hidden', !hasClaimable);

  const baseHasClaimable =
    (state.offlineRigUpgradeLevel < OFFLINE_RIG_UPGRADE_MAX_LEVEL && state.diamonds >= OFFLINE_RIG_UPGRADE_COSTS[state.offlineRigUpgradeLevel]) ||
    (state.diamondSieveUpgradeLevel < DIAMOND_SIEVE_UPGRADE_MAX_LEVEL && state.diamonds >= DIAMOND_SIEVE_UPGRADE_COSTS[state.diamondSieveUpgradeLevel]) ||
    (state.relicScannerUpgradeLevel < RELIC_SCANNER_UPGRADE_MAX_LEVEL && state.diamonds >= RELIC_SCANNER_UPGRADE_COSTS[state.relicScannerUpgradeLevel]) ||
    (state.contractRunnerUpgradeLevel < CONTRACT_RUNNER_UPGRADE_MAX_LEVEL && state.diamonds >= CONTRACT_RUNNER_UPGRADE_COSTS[state.contractRunnerUpgradeLevel]) ||
    isPrestigeEligible();
  baseClaimBadgeEl.classList.toggle('hidden', !baseHasClaimable);

  // Deliberately no scene-photo background here (tried it, reverted) — a
  // dark scrim over the low tiers' mostly-empty/dark scenes read as a
  // broken/disabled button rather than "part of the same bronze button
  // family" as its neighbors. The Base screen itself is where the scene
  // payoff belongs; this button just needs to look pressable and show
  // progress via text.
  const baseCombinedLevel = state.offlineRigUpgradeLevel + state.diamondSieveUpgradeLevel +
    state.relicScannerUpgradeLevel + state.contractRunnerUpgradeLevel;
  const BASE_COMBINED_LEVEL_MAX = OFFLINE_RIG_UPGRADE_MAX_LEVEL + DIAMOND_SIEVE_UPGRADE_MAX_LEVEL +
    RELIC_SCANNER_UPGRADE_MAX_LEVEL + CONTRACT_RUNNER_UPGRADE_MAX_LEVEL;
  startBaseProgressEl.textContent = 'Lv ' + baseCombinedLevel + '/' + BASE_COMBINED_LEVEL_MAX;
}

// ---------- Settings overlay ----------
const settingsSoundToggle = document.getElementById('settings-sound-toggle');
const settingsHapticsToggle = document.getElementById('settings-haptics-toggle');

document.getElementById('settings-btn').addEventListener('click', openSettingsScreen);
document.getElementById('close-settings-btn').addEventListener('click', () => {
  closeOverlay(settingsScreen);
});

function openSettingsScreen() {
  renderSettingsScreen();
  openOverlay(settingsScreen);
}

function renderSettingsScreen() {
  settingsSoundToggle.textContent = state.audioMuted ? 'Off' : 'On';
  settingsSoundToggle.classList.toggle('is-off', state.audioMuted);
  settingsHapticsToggle.textContent = state.hapticsDisabled ? 'Off' : 'On';
  settingsHapticsToggle.classList.toggle('is-off', state.hapticsDisabled);
}

settingsSoundToggle.addEventListener('click', () => {
  state.audioMuted = !state.audioMuted;
  storageSet('ec_audioMuted', String(state.audioMuted));
  applyAudioMutePreference();
  renderSettingsScreen();
});

settingsHapticsToggle.addEventListener('click', () => {
  state.hapticsDisabled = !state.hapticsDisabled;
  storageSet('ec_hapticsDisabled', String(state.hapticsDisabled));
  renderSettingsScreen();
});

// ---------- Achievements overlay ----------
// Lifetime completionist goals, deliberately separate from Game Center
// (which may not even be enabled yet, and is gated on the app owner's own
// App Store Connect setup) — this always has something to show regardless
// of that status. No Gold/reward attached to any of these on purpose, to
// keep this pass scoped to "give players something to track," not a second
// reward-economy surface layered on top of Season Pass + Contracts.
// Each `id` here doubles as the Game Center Achievement ID — create matching
// IDs (exact string match, e.g. "depth_100") in App Store Connect → this app
// → Features → Game Center → Achievements for these to actually appear
// there. Until an ID exists on Apple's side, reporting it is a harmless
// silent no-op (see submitGameCenterAchievement).
const ACHIEVEMENT_DEFS = [
  { id: 'depth_100', icon: '🥉', name: 'First Descent', desc: 'Reach 100m depth', check: () => state.bestDepthEver >= 100 },
  { id: 'depth_1000', icon: '⛏️', name: 'Going Deep', desc: 'Reach 1000m depth', check: () => state.bestDepthEver >= 1000 },
  { id: 'depth_3000', icon: '🏔️', name: 'Core Breaker', desc: 'Reach 3000m depth', check: () => state.bestDepthEver >= 3000 },
  { id: 'gold_1000', icon: '💰', name: 'Gold Collector', desc: 'Earn 1,000 lifetime Gold', check: () => state.lifetimeGoldEarned >= 1000 },
  { id: 'gold_10000', icon: '💎', name: 'Gold Baron', desc: 'Earn 10,000 lifetime Gold', check: () => state.lifetimeGoldEarned >= 10000 },
  { id: 'relics_all', icon: '🏺', name: 'Museum Curator', desc: `Collect all ${RELIC_DEFS.length} Relics`, check: () => state.relicsFound.length >= RELIC_DEFS.length },
  { id: 'contracts_20', icon: '📋', name: 'Contractor', desc: 'Complete 20 Daily Contracts', check: () => state.contractsCompletedLifetime >= 20 },
  { id: 'streak_7', icon: '🔥', name: 'Dedicated', desc: 'Reach a 7-day login streak', check: () => state.loginStreak >= 7 },
  {
    id: 'base_maxed', icon: '🏰', name: 'Master Builder', desc: 'Max all 4 Base upgrades',
    check: () => state.offlineRigUpgradeLevel >= OFFLINE_RIG_UPGRADE_MAX_LEVEL &&
      state.diamondSieveUpgradeLevel >= DIAMOND_SIEVE_UPGRADE_MAX_LEVEL &&
      state.relicScannerUpgradeLevel >= RELIC_SCANNER_UPGRADE_MAX_LEVEL &&
      state.contractRunnerUpgradeLevel >= CONTRACT_RUNNER_UPGRADE_MAX_LEVEL,
  },
  { id: 'base_skins_all', icon: '🎨', name: 'Interior Decorator', desc: 'Unlock every Camp Skin', check: () => state.unlockedBaseSkins.length >= BASE_SKIN_DEFS.length },
];

// Reports any newly-true achievement to Game Center exactly once (tracked via
// state.gameCenterAchievementsReported, persisted) — safe to call as often as
// needed, e.g. every time a run ends.
function checkAndReportGameCenterAchievements() {
  if (!isNativeMobile || !gameCenterAuthenticated) return;
  ACHIEVEMENT_DEFS.forEach((a) => {
    if (state.gameCenterAchievementsReported.includes(a.id)) return;
    if (!a.check()) return;
    state.gameCenterAchievementsReported.push(a.id);
    storageSet('ec_gameCenterAchievementsReported', JSON.stringify(state.gameCenterAchievementsReported));
    submitGameCenterAchievement(a.id);
  });
}

const achievementsCountEl = document.getElementById('achievements-count');
const achievementListEl = document.getElementById('achievement-list');

// Opened FROM Museum (nested), not from the start screen directly — the
// generic openOverlay()/closeOverlay() pair only knows how to return to
// start-screen or gameover-screen, so this uses its own direct show/hide
// instead of fighting that mechanism for a case it wasn't built for.
function openAchievementsScreen() {
  renderAchievementsScreen();
  museumScreen.classList.add('hidden');
  achievementsScreen.classList.remove('hidden');
}

function renderAchievementsScreen() {
  const unlockedCount = ACHIEVEMENT_DEFS.filter((a) => a.check()).length;
  achievementsCountEl.textContent = unlockedCount + ' / ' + ACHIEVEMENT_DEFS.length + ' Unlocked';

  achievementListEl.innerHTML = ACHIEVEMENT_DEFS.map((a) => {
    const done = a.check();
    return `
      <div class="achievement-item ${done ? 'unlocked' : 'locked'}">
        <div class="achievement-icon">${done ? a.icon : '🔒'}</div>
        <div class="achievement-text">
          <div class="achievement-name">${a.name}</div>
          <div class="achievement-desc">${a.desc}</div>
        </div>
        ${done ? '<div class="achievement-check">✓</div>' : ''}
      </div>
    `;
  }).join('');
}

document.getElementById('open-achievements-btn').addEventListener('click', openAchievementsScreen);
document.getElementById('close-achievements-btn').addEventListener('click', () => {
  achievementsScreen.classList.add('hidden');
  museumScreen.classList.remove('hidden');
});

document.getElementById('upgrades-btn').addEventListener('click', openUpgradesScreen);
document.getElementById('start-upgrades-btn').addEventListener('click', openUpgradesScreen);

document.getElementById('close-upgrades-btn').addEventListener('click', () => {
  closeOverlay(upgradesScreen);
});

document.getElementById('fuel-upgrade-btn').addEventListener('click', () => {
  buyFuelUpgrade();
  renderUpgradesScreen();
});
document.getElementById('cooling-upgrade-btn').addEventListener('click', () => {
  buyCoolingUpgrade();
  renderUpgradesScreen();
});
document.getElementById('thruster-upgrade-btn').addEventListener('click', () => {
  buyThrusterUpgrade();
  renderUpgradesScreen();
});
document.getElementById('alloy-upgrade-btn').addEventListener('click', () => {
  buyAlloyUpgrade();
  renderUpgradesScreen();
});

function openUpgradesScreen() {
  renderUpgradesScreen();
  openOverlay(upgradesScreen);
}

// Shared renderer for all four Tech Tree cards — same "Level X/MAX — desc
// (next: desc)" / "MAX LEVEL" pattern the original Fuel Tank card used.
function renderUpgradeCard(descEl, btnEl, level, maxLevel, costs, currentLabel, nextLabel) {
  if (level >= maxLevel) {
    descEl.textContent = `Level ${level}/${maxLevel} — ${currentLabel}`;
    btnEl.textContent = 'MAX LEVEL';
    btnEl.disabled = true;
  } else {
    const cost = costs[level];
    descEl.textContent = `Level ${level}/${maxLevel} — ${currentLabel} (next: ${nextLabel})`;
    btnEl.textContent = 'Upgrade — ' + cost + ' Gold';
    btnEl.disabled = state.bankedGold < cost;
  }
}

function renderUpgradesScreen() {
  bankedGoldEl.textContent = state.bankedGold;

  const maxHealthNow = getMaxHealth();
  renderUpgradeCard(
    fuelUpgradeDescEl, fuelUpgradeBtn,
    state.fuelUpgradeLevel, FUEL_UPGRADE_MAX_LEVEL, FUEL_UPGRADE_COSTS,
    'Max Health ' + maxHealthNow, 'Max Health ' + (maxHealthNow + FUEL_UPGRADE_HEALTH_PER_LEVEL)
  );

  const magmaBiome = BIOMES.find((b) => b.name === 'Magma');
  const coolingNow = getEffectiveFuelMultiplier(magmaBiome).toFixed(2);
  const coolingNext = lerp(
    MAGMA_FUEL_MULTIPLIER_STOCK, MAGMA_FUEL_MULTIPLIER_MAX,
    clamp((state.coolingUpgradeLevel + 1) / COOLING_UPGRADE_MAX_LEVEL, 0, 1)
  ).toFixed(2);
  renderUpgradeCard(
    coolingUpgradeDescEl, coolingUpgradeBtn,
    state.coolingUpgradeLevel, COOLING_UPGRADE_MAX_LEVEL, COOLING_UPGRADE_COSTS,
    'Magma Fuel Drain ' + coolingNow + 'x', 'Magma Fuel Drain ' + coolingNext + 'x'
  );

  const steerNow = getEffectiveSteerSpeed();
  const steerNext = drill.steerSpeed + (state.thrusterUpgradeLevel + 1) * THRUSTER_SPEED_PER_LEVEL;
  renderUpgradeCard(
    thrusterUpgradeDescEl, thrusterUpgradeBtn,
    state.thrusterUpgradeLevel, THRUSTER_UPGRADE_MAX_LEVEL, THRUSTER_UPGRADE_COSTS,
    'Steer Speed ' + steerNow, 'Steer Speed ' + steerNext
  );

  const alloyNow = getAlloyDamageReduction();
  const alloyNext = (state.alloyUpgradeLevel + 1) * ALLOY_DAMAGE_REDUCTION_PER_LEVEL;
  renderUpgradeCard(
    alloyUpgradeDescEl, alloyUpgradeBtn,
    state.alloyUpgradeLevel, ALLOY_UPGRADE_MAX_LEVEL, ALLOY_UPGRADE_COSTS,
    '-' + alloyNow + ' Dmg Reduction', '-' + alloyNext + ' Dmg Reduction'
  );
}

// ---------- The Base overlay ----------
document.getElementById('start-base-btn').addEventListener('click', openBaseScreen);
document.getElementById('close-base-btn').addEventListener('click', () => {
  closeOverlay(baseScreen);
});
document.getElementById('base-descend-btn').addEventListener('click', startGame);
document.getElementById('offline-rig-upgrade-btn').addEventListener('click', () => {
  buyOfflineRigUpgrade();
  renderBaseScreen();
});
document.getElementById('diamond-sieve-upgrade-btn').addEventListener('click', () => {
  buyDiamondSieveUpgrade();
  renderBaseScreen();
});
document.getElementById('relic-scanner-upgrade-btn').addEventListener('click', () => {
  buyRelicScannerUpgrade();
  renderBaseScreen();
});
document.getElementById('contract-runner-upgrade-btn').addEventListener('click', () => {
  buyContractRunnerUpgrade();
  renderBaseScreen();
});
prestigeBtn.addEventListener('click', () => {
  if (!isPrestigeEligible()) return;
  if (!window.confirm('Reset Gold, Diamonds, and every Tech Tree/Base upgrade for a permanent +10% Gold bonus?')) return;
  doPrestige();
  renderBaseScreen();
  updateStartScreenHud();
});
startLeaderboardBtn.addEventListener('click', openLeaderboard);
document.getElementById('close-leaderboard-btn').addEventListener('click', () => {
  closeOverlay(leaderboardScreen);
});
baseWatchAdDiamondBtn.addEventListener('click', watchAdBonusDiamond);

function openBaseScreen() {
  renderBaseScreen();
  openOverlay(baseScreen);
}

// Same "Level X/MAX — desc (next: desc)" / "MAX LEVEL" shape as
// renderUpgradeCard() above, but Diamond-priced rather than Gold-priced —
// kept as its own small function instead of parameterizing the Tech Tree's
// version, since that version is called from four already-working upgrade
// cards this isn't worth risking a change to right before submission.
function renderBaseUpgradeCard(descEl, btnEl, level, maxLevel, costs, currentLabel, nextLabel) {
  if (level >= maxLevel) {
    descEl.textContent = `Level ${level}/${maxLevel} — ${currentLabel}`;
    btnEl.textContent = 'MAX LEVEL';
    btnEl.disabled = true;
  } else {
    const cost = costs[level];
    descEl.textContent = `Level ${level}/${maxLevel} — ${currentLabel} (next: ${nextLabel})`;
    btnEl.textContent = 'Upgrade — ' + cost + ' 💎';
    btnEl.disabled = state.diamonds < cost;
  }
}

// The Base's hero art has 4 tiers (base-scene-tier0..3.jpg) so upgrading
// visibly changes the scene, not just numbers on cards — combined level
// across both upgrades (0-10 total) buckets into 4 tiers.
function getBaseSceneTier() {
  // Thresholds scaled up from the original 2-upgrade/10-max version (now 4
  // upgrades / 20 max) by the same ~30%/70% breakpoints, so the visual
  // pacing across the 4 scene tiers stays proportionally the same as before
  // Relic Scanner/Contract Runner existed.
  const combined = state.offlineRigUpgradeLevel + state.diamondSieveUpgradeLevel +
    state.relicScannerUpgradeLevel + state.contractRunnerUpgradeLevel;
  if (combined <= 0) return 0;
  if (combined <= 6) return 1;
  if (combined <= 14) return 2;
  return 3;
}

// Seeded from the real tier at load time (not null/0), so opening the Base
// screen fresh — including right after a previous session's upgrade — never
// fires a false "leveled up" toast; only an actual tier increase during
// this session does. renderBaseScreen() re-checks this after every buy.
let lastSeenBaseTier = getBaseSceneTier();

function renderBaseScreen() {
  baseDiamondAmountEl.textContent = state.diamonds;

  // Set as custom properties, not a direct style.backgroundImage, because
  // the scene lives on #base-screen::before (see style.css) rather than on
  // #base-screen itself — a Base Skin's filter needs to tint only the
  // background art, not the real child elements (upgrade card text, gold
  // icons, etc.) sitting on top of it, and CSS filter always applies to an
  // element's whole rendered subtree, so it has to live on an isolated
  // pseudo-element layer instead.
  const currentTier = getBaseSceneTier();
  baseScreen.style.setProperty(
    '--base-scene-bg',
    'linear-gradient(180deg, rgba(8, 6, 16, 0.25) 0%, rgba(8, 6, 16, 0.55) 55%, rgba(5, 4, 10, 0.94) 100%), ' +
    'url("base-scene-tier' + currentTier + '.jpg")'
  );
  baseScreen.style.setProperty('--base-skin-filter', getBaseSkinFilter());

  if (currentTier > lastSeenBaseTier) {
    queueToast('🏰 Your Base looks better!');
  }
  lastSeenBaseTier = currentTier;

  renderBaseSkinsList();

  const offlineRateNow = getOfflineGoldPerHour();
  renderBaseUpgradeCard(
    offlineRigUpgradeDescEl, offlineRigUpgradeBtn,
    state.offlineRigUpgradeLevel, OFFLINE_RIG_UPGRADE_MAX_LEVEL, OFFLINE_RIG_UPGRADE_COSTS,
    'Offline Gold Rate ' + offlineRateNow + '/hr', 'Offline Gold Rate ' + (offlineRateNow + OFFLINE_GOLD_PER_HOUR_BONUS_PER_LEVEL) + '/hr'
  );

  const sieveNow = (1 + state.diamondSieveUpgradeLevel * DIAMOND_SIEVE_CHANCE_BONUS_PER_LEVEL).toFixed(2);
  const sieveNext = (1 + (state.diamondSieveUpgradeLevel + 1) * DIAMOND_SIEVE_CHANCE_BONUS_PER_LEVEL).toFixed(2);
  renderBaseUpgradeCard(
    diamondSieveUpgradeDescEl, diamondSieveUpgradeBtn,
    state.diamondSieveUpgradeLevel, DIAMOND_SIEVE_UPGRADE_MAX_LEVEL, DIAMOND_SIEVE_UPGRADE_COSTS,
    'Diamond Find Rate ' + sieveNow + 'x', 'Diamond Find Rate ' + sieveNext + 'x'
  );

  const scannerNow = (1 + state.relicScannerUpgradeLevel * RELIC_CHANCE_BONUS_PER_LEVEL).toFixed(2);
  const scannerNext = (1 + (state.relicScannerUpgradeLevel + 1) * RELIC_CHANCE_BONUS_PER_LEVEL).toFixed(2);
  renderBaseUpgradeCard(
    relicScannerUpgradeDescEl, relicScannerUpgradeBtn,
    state.relicScannerUpgradeLevel, RELIC_SCANNER_UPGRADE_MAX_LEVEL, RELIC_SCANNER_UPGRADE_COSTS,
    'Relic Find Rate ' + scannerNow + 'x', 'Relic Find Rate ' + scannerNext + 'x'
  );

  const runnerNow = getContractGoldMultiplier().toFixed(2);
  const runnerNext = (1 + (state.contractRunnerUpgradeLevel + 1) * 0.15).toFixed(2);
  renderBaseUpgradeCard(
    contractRunnerUpgradeDescEl, contractRunnerUpgradeBtn,
    state.contractRunnerUpgradeLevel, CONTRACT_RUNNER_UPGRADE_MAX_LEVEL, CONTRACT_RUNNER_UPGRADE_COSTS,
    'Contract Gold ' + runnerNow + 'x', 'Contract Gold ' + runnerNext + 'x'
  );

  prestigeLevelLabelEl.textContent = 'Prestige Level ' + state.prestigeLevel;
  prestigeDescEl.textContent = '+' + (state.prestigeLevel * 10) + '% Gold, permanently';
  if (isPrestigeEligible()) {
    prestigeBtn.textContent = 'Prestige Now';
    prestigeBtn.disabled = false;
  } else {
    prestigeBtn.textContent = 'Max everything first';
    prestigeBtn.disabled = true;
  }
}

// Same map-to-innerHTML-then-rewire shape as renderTrailsScreen(), reusing
// its .trail-card/.trail-swatch/.trail-name/.trail-select-btn CSS directly
// (those classes are generic swatch-card styling, nothing trail-specific
// baked in) rather than duplicating a near-identical stylesheet block.
function renderBaseSkinsList() {
  baseSkinListEl.innerHTML = BASE_SKIN_DEFS.map((skin) => {
    const unlocked = isBaseSkinUnlocked(skin.id);
    const isSelected = state.selectedBaseSkin === skin.id;

    let actionHtml;
    if (isSelected) {
      actionHtml = `<button class="trail-select-btn" disabled>Selected</button>`;
    } else if (unlocked) {
      actionHtml = `<button class="trail-select-btn" data-skin-id="${skin.id}" data-owned="1">Select</button>`;
    } else {
      actionHtml = `<button class="trail-select-btn" data-skin-id="${skin.id}" ${state.diamonds < skin.cost ? 'disabled' : ''}>Unlock — ${skin.cost} 💎</button>`;
    }

    return `
      <div class="trail-card ${isSelected ? 'active' : ''}">
        <div class="trail-swatch" style="background:${skin.swatch}; color:${skin.swatch};"></div>
        <div class="trail-name">${skin.name}</div>
        ${actionHtml}
      </div>
    `;
  }).join('');

  baseSkinListEl.querySelectorAll('.trail-select-btn[data-skin-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      buyOrSelectBaseSkin(btn.dataset.skinId);
      renderBaseScreen();
    });
  });
}

async function watchAdBonusDiamond() {
  if (baseWatchAdDiamondBtn.disabled) return;
  baseWatchAdDiamondBtn.disabled = true;
  baseWatchAdDiamondBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo(REWARD_ID_BONUS_DIAMOND);

  if (watched) {
    state.diamonds += 1;
    storageSet('ec_diamonds', String(state.diamonds));
    renderBaseScreen();
    baseWatchAdDiamondBtn.textContent = '📺 Watch Ad for a Bonus Diamond';
    baseWatchAdDiamondBtn.disabled = false; // unlike a per-run ad (Double Gold), Base is a persistent hub with no natural reset point — re-enable immediately so it stays usable
  } else {
    baseWatchAdDiamondBtn.textContent = 'Ad Unavailable — Try Again';
    setTimeout(() => {
      baseWatchAdDiamondBtn.textContent = '📺 Watch Ad for a Bonus Diamond';
      baseWatchAdDiamondBtn.disabled = false;
    }, 1500);
  }
}

// ---------- Chest overlay ----------
const chestAdBtn = document.getElementById('chest-ad-btn');
const chestSkipBtn = document.getElementById('chest-skip-btn');
const chestPowerupDescEl = document.getElementById('chest-powerup-desc');

let currentChestPowerupId = 'MAGNET';
let currentChestAdBtnLabel = '';

// Named for the same reason as watchAdRevive(); grants the rolled power-up
// only on a truthy resolve.
async function watchAdChestPowerup() {
  if (chestAdBtn.disabled) return;
  chestAdBtn.disabled = true;
  chestSkipBtn.disabled = true;
  chestAdBtn.textContent = 'Loading Ad...';

  const powerup = CHEST_POWERUPS[currentChestPowerupId];
  const watched = await showRewardedVideo(powerup.rewardId);

  chestAdBtn.disabled = false;
  chestSkipBtn.disabled = false;

  if (watched) {
    console.log('AD: ' + powerup.id + ' ad watched — activating for ' + powerup.duration + 's');
    if (powerup.id === 'MAGNET') state.magnetTimer = powerup.duration;
    else if (powerup.id === 'SHIELD') state.shieldTimer = powerup.duration;
    else if (powerup.id === 'SCORE_BOOST') state.scoreBoostTimer = powerup.duration;
    chestAdBtn.textContent = currentChestAdBtnLabel;
    resumeAfterChest();
  } else {
    console.log('AD: ' + powerup.id + ' ad failed to load / was not completed');
    chestAdBtn.textContent = 'Ad Unavailable — Try Again';
    chestAdBtn.disabled = true;
    chestSkipBtn.disabled = true;
    setTimeout(() => {
      chestAdBtn.textContent = currentChestAdBtnLabel;
      chestAdBtn.disabled = false;
      chestSkipBtn.disabled = false;
    }, 1500);
  }
}
chestAdBtn.addEventListener('click', watchAdChestPowerup);

chestSkipBtn.addEventListener('click', () => {
  if (chestSkipBtn.disabled) return;
  resumeAfterChest();
});

// ---------- Manual pause (player-initiated) ----------
// Distinct from handleSdkPause()/#pause-overlay (platform-driven, no button
// of its own — see the SDK bootstrap section). This one has a Resume button,
// so it deliberately does NOT use body.paused (that CSS rule disables every
// button while set, which is exactly right for a platform pause locking out
// the whole page, but would also disable this overlay's own Resume button).
// pauseGameLoop()/state.running are shared with the Chest overlay's pause,
// which already proved this exact "manual pause the loop, resume with a
// button" pattern works safely alongside a real SDK pause: if one fires
// while manually paused, wasRunningBeforePause correctly reads false (the
// loop was already stopped), so SDK resume clears its own lockout without
// incorrectly restarting gameplay out from under the still-open Resume
// button.
pauseBtn.addEventListener('click', () => {
  if (!state.running) return;
  pauseGameLoop();
  manualPauseScreen.classList.remove('hidden');
});

document.getElementById('manual-pause-resume-btn').addEventListener('click', () => {
  manualPauseScreen.classList.add('hidden');
  state.running = true;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(loop);
  ambientPadFadeIn();
});

// Reachable from the pause screen (mid-run) or the Game Over screen — both
// were previously dead ends with no way back to the title screen short of
// force-quitting the app, reported from a real device. pauseGameLoop() is
// safe to call even if the loop is already stopped (Game Over already did).
function goToMainMenu() {
  pauseGameLoop();
  manualPauseScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  chestScreen.classList.add('hidden');
  upgradesScreen.classList.add('hidden');
  museumScreen.classList.add('hidden');
  contractsScreen.classList.add('hidden');
  loadoutScreen.classList.add('hidden');
  trailsScreen.classList.add('hidden');
  passScreen.classList.add('hidden');
  settingsScreen.classList.add('hidden');
  achievementsScreen.classList.add('hidden');
  baseScreen.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  startHighscoreEl.textContent = 'High Score: ' + state.highScore;
  startScreen.classList.remove('hidden');
  updateStartScreenHud();
}
document.getElementById('manual-pause-menu-btn').addEventListener('click', goToMainMenu);
document.getElementById('gameover-menu-btn').addEventListener('click', goToMainMenu);

// ---------- The Artifact Museum overlay ----------
const museumCountEl = document.getElementById('museum-count');
const relicGridEl = document.getElementById('relic-grid');

document.getElementById('museum-btn').addEventListener('click', openMuseumScreen);
document.getElementById('start-museum-btn').addEventListener('click', openMuseumScreen);
document.getElementById('close-museum-btn').addEventListener('click', () => {
  closeOverlay(museumScreen);
});

function openMuseumScreen() {
  renderMuseum();
  openOverlay(museumScreen);
}

function renderMuseum() {
  museumCountEl.textContent = state.relicsFound.length + ' / ' + RELIC_DEFS.length + ' Relics Collected';

  relicGridEl.innerHTML = RELIC_DEFS.map((relic) => {
    const found = state.relicsFound.includes(relic.id);
    const color = found ? relic.color : '#3a3a42';
    const label = found ? relic.name : '???';
    return `
      <div class="relic-slot ${found ? 'found' : 'locked'}">
        <div class="relic-icon" style="background:${color};"></div>
        <div class="relic-name">${label}</div>
      </div>
    `;
  }).join('');
}

// ---------- Daily Contracts overlay ----------
const contractListEl = document.getElementById('contract-list');

document.getElementById('start-contracts-btn').addEventListener('click', openContractsScreen);
document.getElementById('close-contracts-btn').addEventListener('click', () => {
  closeOverlay(contractsScreen);
});

function openContractsScreen() {
  renderContracts();
  openOverlay(contractsScreen);
}

function renderContracts() {
  contractListEl.innerHTML = state.dailyContracts.goals.map((goal) => {
    const template = getContractTemplate(goal.id);
    return `
      <div class="contract-item ${goal.completedToday ? 'completed' : ''}">
        <div class="contract-desc">${template.label(goal.target)}</div>
        <div class="contract-bonus">+${goal.bonusGold} Gold${goal.completedToday ? ' — Completed Today' : ''}</div>
      </div>
    `;
  }).join('');
}

// ---------- Loadout overlay ----------
const classListEl = document.getElementById('class-list');

document.getElementById('start-loadout-btn').addEventListener('click', openLoadoutScreen);
document.getElementById('close-loadout-btn').addEventListener('click', () => {
  closeOverlay(loadoutScreen);
});

function openLoadoutScreen() {
  renderLoadoutScreen();
  openOverlay(loadoutScreen);
}

function renderLoadoutScreen() {
  classListEl.innerHTML = CLASS_ORDER.map((id) => {
    const cls = DRILL_CLASSES[id];
    const unlocked = isClassUnlocked(id);
    const isSelected = state.selectedClass === id;

    const perksHtml = cls.perks.map((p) => `<div class="class-perk">✓ ${p}</div>`).join('');
    const drawbacksHtml = cls.drawbacks.map((d) => `<div class="class-drawback">✕ ${d}</div>`).join('');

    let actionHtml;
    if (!unlocked) {
      actionHtml = `<div class="class-locked">Requires ${cls.relicsRequired} Relics</div>`;
    } else if (isSelected) {
      actionHtml = `<button class="class-select-btn" disabled>Selected</button>`;
    } else {
      actionHtml = `<button class="class-select-btn" data-class-id="${id}">Select</button>`;
    }

    return `
      <div class="class-card ${unlocked ? 'unlocked' : 'locked'} ${isSelected ? 'active' : ''}">
        <div class="class-name">${cls.name}</div>
        ${perksHtml}
        ${drawbacksHtml}
        ${actionHtml}
      </div>
    `;
  }).join('');

  // re-wire select buttons since innerHTML was just replaced
  classListEl.querySelectorAll('.class-select-btn[data-class-id]').forEach((btn) => {
    btn.addEventListener('click', () => selectClass(btn.dataset.classId));
  });
}

// ---------- Trails overlay (cosmetics) ----------
document.getElementById('start-trails-btn').addEventListener('click', openTrailsScreen);
document.getElementById('close-trails-btn').addEventListener('click', () => {
  closeOverlay(trailsScreen);
});

function openTrailsScreen() {
  renderTrailsScreen();
  openOverlay(trailsScreen);
}

function renderTrailsScreen() {
  trailsBankedGoldEl.textContent = state.bankedGold;

  trailListEl.innerHTML = TRAIL_DEFS.map((trail) => {
    const unlocked = isTrailUnlocked(trail.id);
    const isSelected = state.selectedTrail === trail.id;
    const swatchColor = trail.id === 'standard' ? '#6b4423' : trail.color();

    let actionHtml;
    if (isSelected) {
      actionHtml = `<button class="trail-select-btn" disabled>Selected</button>`;
    } else if (unlocked) {
      actionHtml = `<button class="trail-select-btn" data-trail-id="${trail.id}" data-owned="1">Select</button>`;
    } else if (trail.passTier !== undefined) {
      actionHtml = `<button class="trail-select-btn pass-locked" disabled>Season Pass — Tier ${trail.passTier}</button>`;
    } else {
      actionHtml = `<button class="trail-select-btn" data-trail-id="${trail.id}">Unlock — ${trail.cost} Gold</button>`;
    }

    return `
      <div class="trail-card ${isSelected ? 'active' : ''} ${trail.passTier !== undefined ? 'pass-exclusive' : ''}">
        <div class="trail-swatch" style="background:${swatchColor};"></div>
        <div class="trail-name">${trail.name}${trail.passTier !== undefined ? ' <span class="pass-badge">PASS</span>' : ''}</div>
        ${actionHtml}
      </div>
    `;
  }).join('');

  // re-wire select/unlock buttons since innerHTML was just replaced
  trailListEl.querySelectorAll('.trail-select-btn[data-trail-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.owned) selectOwnedTrail(btn.dataset.trailId);
      else buyOrSelectTrail(btn.dataset.trailId);
      renderTrailsScreen();
    });
  });
}

// ---------- Season Pass overlay ----------
const passSeasonInfoEl = document.getElementById('pass-season-info');
const passProgressSummaryEl = document.getElementById('pass-progress-summary');
const passProgressBarInner = document.getElementById('pass-progress-bar-inner');
const passProgressLabelEl = document.getElementById('pass-progress-label');
const passTierListEl = document.getElementById('pass-tier-list');

document.getElementById('start-pass-btn').addEventListener('click', openPassScreen);
document.getElementById('close-pass-btn').addEventListener('click', () => {
  closeOverlay(passScreen);
});

function openPassScreen() {
  checkPassSeasonExpiry();
  renderPassScreen();
  openOverlay(passScreen);
}

function renderPassScreen() {
  const daysLeft = Math.max(0, Math.ceil((PASS_SEASON_DURATION_MS - (Date.now() - state.passSeasonStart)) / (24 * 60 * 60 * 1000)));
  passSeasonInfoEl.textContent = `Season ${state.passSeasonNumber} · Free Track · Ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

  const currentTier = getPassTierForXp(state.passXp);
  passProgressSummaryEl.textContent = `Tier ${currentTier} / ${PASS_TIER_COUNT}`;

  const progress = getPassProgress();
  if (progress) {
    passProgressBarInner.style.width = Math.round((progress.xpIntoTier / progress.xpForTier) * 100) + '%';
    passProgressLabelEl.textContent = `${progress.xpIntoTier} / ${progress.xpForTier} XP to Tier ${progress.tier + 1}`;
  } else {
    passProgressBarInner.style.width = '100%';
    passProgressLabelEl.textContent = 'All tiers reached!';
  }

  passTierListEl.innerHTML = PASS_REWARDS.map((reward) => {
    const claimed = state.passClaimedTiers.includes(reward.tier);
    const reached = currentTier >= reward.tier;
    const swatch = reward.type === 'trail' ? TRAIL_DEFS.find((t) => t.id === reward.trailId).color(BIOMES[0])
      : reward.type === 'base_skin' ? BASE_SKIN_DEFS.find((s) => s.id === reward.skinId).swatch
      : reward.type === 'diamonds' ? '#4fd8ff'
      : '#ffd700';

    let actionHtml;
    if (claimed) {
      actionHtml = `<div class="pass-tier-claimed">✓ Claimed</div>`;
    } else if (reached) {
      actionHtml = `<button class="pass-claim-btn" data-tier="${reward.tier}">Claim</button>`;
    } else {
      actionHtml = `<div class="pass-tier-locked">Tier ${reward.tier}</div>`;
    }

    // Inert today (reward.premiumReward is null on every tier — see
    // PASS_REWARDS) but the render logic is already correct for whenever a
    // future premium track has real content: a second row appears
    // automatically the moment a tier gets a non-null premiumReward, no
    // changes needed here.
    let premiumHtml = '';
    if (reward.premiumReward) {
      const premiumClaimed = state.passClaimedPremiumTiers.includes(reward.tier);
      let premiumActionHtml;
      if (!state.passPremiumUnlocked) {
        premiumActionHtml = `<div class="pass-tier-locked">Premium</div>`;
      } else if (premiumClaimed) {
        premiumActionHtml = `<div class="pass-tier-claimed">✓ Claimed</div>`;
      } else if (reached) {
        premiumActionHtml = `<button class="pass-claim-btn pass-claim-btn-premium" data-premium-tier="${reward.tier}">Claim</button>`;
      } else {
        premiumActionHtml = `<div class="pass-tier-locked">Tier ${reward.tier}</div>`;
      }
      premiumHtml = `
        <div class="pass-tier-row pass-tier-row-premium ${premiumClaimed ? 'claimed' : ''}">
          <div class="pass-tier-icon" style="background:${reward.premiumReward.type === 'trail' ? (TRAIL_DEFS.find((t) => t.id === reward.premiumReward.trailId).color(BIOMES[0])) : '#ffd700'};"></div>
          <div class="pass-tier-reward-label">${reward.premiumReward.label}</div>
          ${premiumActionHtml}
        </div>
      `;
    }

    return `
      <div class="pass-tier-row ${claimed ? 'claimed' : reached ? 'claimable' : 'locked'}">
        <div class="pass-tier-icon" style="background:${swatch};"></div>
        <div class="pass-tier-reward-label">${reward.label}</div>
        ${actionHtml}
      </div>
      ${premiumHtml}
    `;
  }).join('');

  passTierListEl.querySelectorAll('.pass-claim-btn[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      claimPassTier(parseInt(btn.dataset.tier, 10));
      renderPassScreen();
    });
  });
  passTierListEl.querySelectorAll('.pass-claim-btn-premium[data-premium-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      claimPassPremiumTier(parseInt(btn.dataset.premiumTier, 10));
      renderPassScreen();
    });
  });
}

// ---------- Toast notifications ----------
// A small queue so multiple contracts completing in the same frame don't
// clobber each other — each message gets its full slide-in/hold/slide-out.
const TOAST_VISIBLE_MS = 2500;
const TOAST_TRANSITION_MS = 400;
let toastQueue = [];
let toastActive = false;

function queueToast(message) {
  toastQueue.push(message);
  if (!toastActive) showNextToast();
}

function showNextToast() {
  if (toastQueue.length === 0) {
    toastActive = false;
    return;
  }
  toastActive = true;
  const message = toastQueue.shift();
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  playSound('toast');
  vibrateHaptic(15);
  // remove 'hidden' first so display:block applies before the slide-in transition starts
  requestAnimationFrame(() => toastEl.classList.add('show'));

  setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => {
      toastEl.classList.add('hidden');
      showNextToast();
    }, TOAST_TRANSITION_MS);
  }, TOAST_VISIBLE_MS);
}

// Prestige's permanent +10%/level Gold bonus is applied here — the single
// choke point every Gold gain in the game already flows through (run-end
// banking, Contract bonuses, Pass claims, Welcome Back), so this is the one
// place a global multiplier needs to exist rather than scattering it across
// every call site.
function getPrestigeGoldMultiplier() {
  return 1 + state.prestigeLevel * 0.10;
}

function syncBankedGold(extra) {
  const amount = Math.floor(extra * getPrestigeGoldMultiplier());
  state.bankedGold += amount;
  storageSet('ec_bankedGold', String(state.bankedGold));
  if (amount > 0) {
    state.lifetimeGoldEarned += amount;
    storageSet('ec_lifetimeGoldEarned', String(state.lifetimeGoldEarned));
  }
}

// Persists a new high score if the current run beat it. Returns true if a record was set.
function updateHighScore() {
  if (state.maxDepthReached > state.bestDepthEver) {
    state.bestDepthEver = state.maxDepthReached;
    storageSet('ec_bestDepthEver', String(state.bestDepthEver));
  }

  const score = currentScore();
  finalScoreEl.textContent = 'Score: ' + score;
  if (score > state.highScore) {
    state.highScore = score;
    storageSet('ec_highScore', String(state.highScore));
    highscoreDisplayEl.textContent = 'High Score: ' + state.highScore;
    newHighscoreBadge.classList.remove('hidden');
    return true;
  }
  return false;
}

// ---------- Interstitial ads (SDK) ----------
// One fires at the very first game start of the session. After that, a ~90s
// timer arms in the background (tickInterstitialTimer, polled once per frame)
// but the ad itself only ever fires at a natural break — game over — never
// mid-run, even if the timer elapses while a run is still in progress.
const INTERSTITIAL_INTERVAL_MS = 90000;
let firstInterstitialShown = false;
let lastInterstitialTime = 0;
let interstitialArmed = false;

async function showInterstitialAd() {
  lastInterstitialTime = Date.now();
  interstitialArmed = false;
  if (isNativeMobile) {
    const admob = getAdMobPlugin();
    if (!admob) return; // plugin not registered — never fatal, gameplay continues regardless
    try {
      await admob.prepareInterstitial({ adId: ADMOB_INTERSTITIAL_AD_UNIT_ID });
      await admob.showInterstitial();
    } catch (e) {
      // interstitial failures are never fatal — gameplay continues regardless
    }
    return;
  }
  if (!(window.bridge && bridgeReadyPromise)) return; // no SDK present — nothing to show
  // Required: never touch bridge.advertisement until initialize() has
  // actually resolved — reading it any earlier logs a real SDK warning,
  // confirmed against the live CDN script.
  try {
    await bridgeReadyPromise;
    if (!(window.bridge.advertisement && window.bridge.advertisement.showInterstitial && window.bridge.advertisement.isInterstitialSupported)) {
      return; // platform doesn't support this format — nothing to show
    }
    window.bridge.advertisement.showInterstitial();
  } catch (e) {
    // interstitial failures are never fatal — gameplay continues regardless
  }
}

// ---------- Advanced Banners (SDK) ----------
// Web-only, non-blocking passive ads placed in genuinely empty screen space
// — never during gameplay. Deliberately scoped to just the Start Screen and
// Game Over screen, NOT the Base/Museum/Upgrades/etc. sub-menus: those
// overlays scroll internally (measured up to ~1770px of content in an
// 812px viewport for the Base screen), so a viewport-fixed bottom banner
// could end up sitting on top of whatever real button happens to be
// scrolled into that strip — the Start and Game Over screens are the only
// two confirmed to fit entirely within one viewport with a genuinely empty
// ~70-90px gap below their lowest button, at every screen size tested.
// isNativeMobile is never checked here — Advanced Banners is a Bridge-only,
// web-only feature (AdMob has no equivalent), so this is simply a no-op
// inside the native apps regardless.
const BANNER_PLACEMENT = 'menu_idle';

function showMenuBanner() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    if (window.bridge.advertisement && window.bridge.advertisement.isAdvancedBannersSupported) {
      window.bridge.advertisement.showAdvancedBanners(BANNER_PLACEMENT);
    }
  }).catch(() => {});
}

function hideMenuBanner() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    if (window.bridge.advertisement && window.bridge.advertisement.hideAdvancedBanners) {
      window.bridge.advertisement.hideAdvancedBanners();
    }
  }).catch(() => {});
}

function tickInterstitialTimer() {
  if (!interstitialArmed && firstInterstitialShown && Date.now() - lastInterstitialTime >= INTERSTITIAL_INTERVAL_MS) {
    interstitialArmed = true; // will fire at the next natural break (game over)
  }
}

// ---------- Game flow ----------
function startGame() {
  hideMenuBanner(); // leaving a safe menu screen for active gameplay
  world.rows = [];
  world.lastSafeX = Math.floor(COLS / 2);
  world.nextRowToGenerate = 0;

  // Class hitbox is locked in for the run, so switching loadouts mid-run
  // (not currently possible — Loadout only opens from the start menu) can
  // never resize the drill out from under an in-progress fall.
  const activeClass = getActiveClass();
  drill.width = activeClass.width;
  drill.height = activeClass.height;

  drill.worldX = LOGICAL_W / 2 - drill.width / 2;
  drill.worldY = -80;
  drill.vx = 0;
  drill.maxHealth = getMaxHealth();
  drill.health = drill.maxHealth;
  drill.invulnTimer = 0;

  state.running = true;
  state.gameOver = false;
  state.gold = 0;
  state.diamondsThisRun = 0;
  state.maxDepthReached = 0;
  state.startTime = performance.now();
  state.comboMultiplier = 1.0;
  state.magnetTimer = 0;
  state.shieldTimer = 0;
  state.scoreBoostTimer = 0;
  state.dirtBroken = 0;
  state.pendingContractGold = 0;
  state.overdriveMeter = 0;
  state.overdriveActive = false;
  state.overdriveTimer = 0;
  lastDamageCause = null;

  particles.length = 0;
  shakeTimer = 0;
  shakeMagnitude = 0;
  awardedNearMissCells = new Set();
  wasInGoldRushShaft = false;

  startScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  upgradesScreen.classList.add('hidden');
  chestScreen.classList.add('hidden');
  museumScreen.classList.add('hidden');
  contractsScreen.classList.add('hidden');
  loadoutScreen.classList.add('hidden');
  trailsScreen.classList.add('hidden');
  passScreen.classList.add('hidden');
  settingsScreen.classList.add('hidden');
  achievementsScreen.classList.add('hidden');
  baseScreen.classList.add('hidden');
  manualPauseScreen.classList.add('hidden');
  newHighscoreBadge.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  startHighscoreEl.textContent = 'High Score: ' + state.highScore;

  if (!firstInterstitialShown) {
    firstInterstitialShown = true;
    showInterstitialAd(); // fire-and-forget — never blocks the run from starting
  }
  if (!gameCenterAuthAttempted) {
    gameCenterAuthAttempted = true;
    authenticateGameCenter(); // fire-and-forget — never blocks the run from starting
  }

  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(loop);
  ambientPadFadeIn();

  if (isWeekendGoldRushActive() && !weekendBonusToastShown) {
    weekendBonusToastShown = true; // once per session — a live-ops bonus should be noticed, not nagged about on every restart
    queueToast('🎉 Weekend Gold Rush! 1.5x Gold all weekend');
  }
}
let weekendBonusToastShown = false;

function endGame(causeOfDeath) {
  pauseGameLoop();
  state.gameOver = true;
  pauseBtn.classList.add('hidden');
  manualPauseScreen.classList.add('hidden');

  syncBankedGold(state.gold);
  if (state.pendingContractGold > 0) {
    syncBankedGold(state.pendingContractGold);
  }
  state.diamonds += state.diamondsThisRun;
  storageSet('ec_diamonds', String(state.diamonds));
  awardPassXp(state.maxDepthReached * PASS_XP_PER_METER_DEPTH + state.gold * PASS_XP_PER_GOLD);

  Analytics.logRunEnd(causeOfDeath || 'Fuel Starvation');
  sdkSendScore(currentScore());
  submitGameCenterScore(currentScore());
  submitBridgeLeaderboardScore(currentScore());
  checkAndReportGameCenterAchievements();

  if (interstitialArmed) {
    showInterstitialAd(); // the natural break the ~90s timer was waiting for
  }

  finalDepthEl.textContent = state.maxDepthReached + 'm';
  finalGoldEl.textContent = state.gold;
  contractBonusEl.textContent =
    state.pendingContractGold > 0 ? '+' + state.pendingContractGold + ' Gold from Daily Contracts' : '';
  highscoreDisplayEl.textContent = 'High Score: ' + state.highScore;
  newHighscoreBadge.classList.add('hidden');
  const hadPriorHighScore = state.highScore > 0;
  if (updateHighScore()) {
    maybeRequestReview(!hadPriorHighScore); // a genuine "this went well" beat — the right moment to ask, not a random one
  }

  reviveBtn.textContent = REVIVE_BTN_DEFAULT_TEXT;
  reviveBtn.disabled = false;
  doubleGoldBtn.textContent = DOUBLE_GOLD_BTN_DEFAULT_TEXT;
  doubleGoldBtn.disabled = false;

  gameoverScreen.classList.remove('hidden');
  showMenuBanner(); // confirmed-safe: fits in one viewport, ~70px genuinely empty below the lowest button
}

// ---------- Update ----------
function updateDrillSteer(dt) {
  const biome = getBiome(currentDepthMeters());
  const activeClass = getActiveClass();
  const steerSpeed = getEffectiveSteerSpeed() * biome.speedMultiplier * activeClass.steerSpeedMultiplier; // Ice = sliding, Plasma = extra agile, Thruster Array = flat bonus

  if (input.left && !input.right) drill.vx = -steerSpeed;
  else if (input.right && !input.left) drill.vx = steerSpeed;
  else drill.vx = 0;

  drill.worldX += drill.vx * dt;
  drill.worldX = clamp(drill.worldX, 0, LOGICAL_W - drill.width);
}

function cellsOverlappingDrill() {
  const left = drill.worldX;
  const right = drill.worldX + drill.width;
  const top = drill.worldY;
  const bottom = drill.worldY + drill.height;

  const colStart = Math.max(0, Math.floor(left / BLOCK));
  const colEnd = Math.min(COLS - 1, Math.floor((right - 0.01) / BLOCK));
  const rowStart = Math.floor(top / BLOCK);
  const rowEnd = Math.floor((bottom - 0.01) / BLOCK);

  const cells = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      cells.push({ row: r, col: c });
    }
  }
  return cells;
}

// Records what most recently dealt damage, so a death this same frame can be
// attributed correctly in Analytics. Reset every call so an old hit from many
// seconds ago never gets blamed for a death that was really Fuel Starvation.
let lastDamageCause = null;

function updateCollisions(dt) {
  if (drill.invulnTimer > 0) drill.invulnTimer -= dt;
  lastDamageCause = null;

  const cells = cellsOverlappingDrill();
  for (const { row, col } of cells) {
    const block = getBlock(row, col);
    const cellCenterX = col * BLOCK + BLOCK / 2;
    const cellCenterY = row * BLOCK + BLOCK / 2;
    const biome = getBiome(row); // row index === depth in meters

    if (block === DIRT) {
      setBlock(row, col, EMPTY);
      state.dirtBroken += 1;
      spawnParticles(cellCenterX, cellCenterY, getTrailColor(biome), 5);
      triggerScreenShake(2, 0.06);
      if (Math.random() < DIG_SOUND_CHANCE) playSound('dig');
    } else if (block === GOLD) {
      setBlock(row, col, EMPTY);
      // near-miss combo multiplier scales gold payout, min 1 per block
      const goldGain = applyWeekendGoldBonus(Math.max(1, Math.round(1 * state.comboMultiplier)));
      state.gold += goldGain;
      addOverdriveMeter(OVERDRIVE_GOLD_GAIN);
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 10);
      triggerScreenShake(3, 0.08);
      playSound('coin');
    } else if (block === DIAMOND) {
      setBlock(row, col, EMPTY);
      state.diamondsThisRun += 1;
      spawnParticles(cellCenterX, cellCenterY, '#4fd8ff', 12);
      triggerScreenShake(3, 0.08);
      playSound('relic');
      queueToast('💎 Diamond!');
    } else if (block === STONE) {
      setBlock(row, col, EMPTY);
      if (state.overdriveActive) {
        // Overdrive pulverizes it instead of taking a hit — bigger burst, no damage, bonus gold
        state.gold += OVERDRIVE_GOLD_PER_BLOCK;
        spawnParticles(cellCenterX, cellCenterY, biome.stoneColor, 14);
        spawnParticles(cellCenterX, cellCenterY, '#ffffff', 8);
        triggerScreenShake(4, 0.1);
        playSound('pulverize');
      } else {
        spawnParticles(cellCenterX, cellCenterY, biome.stoneColor, 8);
        triggerScreenShake(9, 0.2); // violent shake
        state.comboMultiplier = 1.0; // getting hit wipes the near-miss streak
        if (drill.invulnTimer <= 0) {
          const dmg = Math.max(1, drill.stoneDamage * getActiveClass().damageMultiplier - getAlloyDamageReduction());
          drill.health -= dmg;
          drill.invulnTimer = 0.35;
          lastDamageCause = 'Stone Collision';
          playSound('hit');
        }
      }
    } else if (block === CHEST) {
      setBlock(row, col, EMPTY);
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 12);
      spawnParticles(cellCenterX, cellCenterY, '#ab47bc', 10);
      triggerScreenShake(4, 0.1);
      vibrateHaptic(20);
      openChestOverlay();
    } else if (block === RELIC) {
      setBlock(row, col, EMPTY);
      collectRelic(cellCenterX, cellCenterY);
    } else if (block === GAS) {
      if (state.overdriveActive) {
        // Overdrive pulverizes it instead of taking a hit — no damage, bonus gold
        state.gold += OVERDRIVE_GOLD_PER_BLOCK;
        explodeGasPocket(row, col);
        spawnParticles(cellCenterX, cellCenterY, '#ffffff', 10);
        playSound('pulverize');
      } else {
        state.comboMultiplier = 1.0; // getting hit wipes the near-miss streak
        explodeGasPocket(row, col);
        if (drill.invulnTimer <= 0) {
          const dmg = Math.max(1, drill.stoneDamage * 2 * getActiveClass().damageMultiplier - getAlloyDamageReduction()); // Gas Pockets hit twice as hard as Stone
          drill.health -= dmg;
          drill.invulnTimer = 0.35;
          lastDamageCause = 'Gas Explosion';
          playSound('explosion');
          vibrateHaptic(40);
        }
      }
    }
  }
}

// Destroys every block in the 3x3 area centered on the Gas Pocket (the pocket
// itself included) and throws a massive green/orange burst with the biggest
// screen shake in the game.
function explodeGasPocket(centerRow, centerCol) {
  for (let r = centerRow - 1; r <= centerRow + 1; r++) {
    for (let c = centerCol - 1; c <= centerCol + 1; c++) {
      setBlock(r, c, EMPTY);
    }
  }
  const cx = centerCol * BLOCK + BLOCK / 2;
  const cy = centerRow * BLOCK + BLOCK / 2;
  spawnParticles(cx, cy, '#66bb6a', 22);
  spawnParticles(cx, cy, '#ff9800', 22);
  triggerScreenShake(16, 0.35); // the biggest shake in the game
}

// Chest blocks pause the run for a mid-run "supply cache" choice: watch an
// ad for a timed gold magnet, or skip and keep going immediately.
function openChestOverlay() {
  currentChestPowerupId = CHEST_POWERUP_IDS[Math.floor(Math.random() * CHEST_POWERUP_IDS.length)];
  const powerup = CHEST_POWERUPS[currentChestPowerupId];
  currentChestAdBtnLabel = powerup.adBtnLabel(powerup.duration);
  chestAdBtn.textContent = currentChestAdBtnLabel;
  chestPowerupDescEl.textContent = powerup.desc;

  pauseGameLoop();
  chestScreen.classList.remove('hidden');
}

function resumeAfterChest() {
  chestScreen.classList.add('hidden');
  state.running = true;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(loop);
  ambientPadFadeIn();
}

const MAGNET_DURATION = 10; // seconds
const MAGNET_RADIUS_BLOCKS = 3;

// Auto-collects any Gold within MAGNET_RADIUS_BLOCKS of the drill while the
// buff is active. Gold is embedded in the terrain grid rather than a free
// entity, so "pulling" it to the drill is expressed as an instant vacuum
// pickup (with a burst of particles/sound) rather than animating the block.
function updateMagnet(dt) {
  if (state.magnetTimer <= 0) return;
  state.magnetTimer = Math.max(0, state.magnetTimer - dt);

  const drillCenterX = drill.worldX + drill.width / 2;
  const drillCenterY = drill.worldY + drill.height / 2;
  const colCenter = Math.floor(drillCenterX / BLOCK);
  const rowCenter = Math.floor(drillCenterY / BLOCK);
  const radiusPx = MAGNET_RADIUS_BLOCKS * BLOCK;

  for (let r = rowCenter - MAGNET_RADIUS_BLOCKS; r <= rowCenter + MAGNET_RADIUS_BLOCKS; r++) {
    for (let c = colCenter - MAGNET_RADIUS_BLOCKS; c <= colCenter + MAGNET_RADIUS_BLOCKS; c++) {
      if (getBlock(r, c) !== GOLD) continue;
      const cellCenterX = c * BLOCK + BLOCK / 2;
      const cellCenterY = r * BLOCK + BLOCK / 2;
      if (Math.hypot(cellCenterX - drillCenterX, cellCenterY - drillCenterY) > radiusPx) continue;

      setBlock(r, c, EMPTY);
      const goldGain = applyWeekendGoldBonus(Math.max(1, Math.round(1 * state.comboMultiplier)));
      state.gold += goldGain;
      addOverdriveMeter(OVERDRIVE_GOLD_GAIN);
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 6);
      playSound('coin');
    }
  }
}

// Keeps drill.invulnTimer topped up for the buff's duration rather than
// tracking a separate "is shielded" damage check — the Stone/Gas hit
// handlers already gate all damage behind `drill.invulnTimer <= 0`, so this
// reuses that exact path (and its existing white-flash visual) for free
// instead of adding a second parallel invincibility system.
function updateShield(dt) {
  if (state.shieldTimer <= 0) return;
  state.shieldTimer = Math.max(0, state.shieldTimer - dt);
  drill.invulnTimer = Math.max(drill.invulnTimer, 0.1);
}

// No per-frame work needed beyond the countdown — currentScore() checks
// this timer directly rather than this function pushing a value anywhere.
function updateScoreBoost(dt) {
  if (state.scoreBoostTimer <= 0) return;
  state.scoreBoostTimer = Math.max(0, state.scoreBoostTimer - dt);
}

// Awards one not-yet-owned relic (spawn logic already stops once all
// RELIC_DEFS.length are found, so this always has a candidate when called).
function collectRelic(worldX, worldY) {
  const uncollectedIds = RELIC_DEFS.map((r) => r.id).filter((id) => !state.relicsFound.includes(id));
  if (uncollectedIds.length === 0) return;

  const newId = uncollectedIds[Math.floor(Math.random() * uncollectedIds.length)];
  state.relicsFound.push(newId);
  storageSet('ec_relics', JSON.stringify(state.relicsFound));

  const relicColor = RELIC_DEFS[newId].color;
  spawnParticles(worldX, worldY, relicColor, 16);
  spawnParticles(worldX, worldY, '#ffffff', 16);
  triggerScreenShake(6, 0.15);
  playSound('relic');
  vibrateHaptic(30);
  queueToast('🏺 Relic Found! Check the Museum.'); // previously zero textual explanation of what was just picked up — particles/shake/sound only
}

function updateDrillFall(dt) {
  // gentle difficulty ramp: fall speed increases slowly with depth
  const depthPixels = Math.max(0, drill.worldY);
  const biomeSpeedMultiplier = 1 + clamp(depthPixels / DEPTH_FOR_MAX_STONE, 0, 1) * 0.6;
  const classSpeedMultiplier = getActiveClass().verticalSpeedMultiplier; // Jackhammer = slower, Plasma = faster
  const overdriveSpeedMultiplier = state.overdriveActive ? 2 : 1;
  drill.worldY += drill.vy * biomeSpeedMultiplier * classSpeedMultiplier * overdriveSpeedMultiplier * dt;

  const depthMeters = Math.max(0, Math.floor(drill.worldY / BLOCK));
  if (depthMeters > state.maxDepthReached) state.maxDepthReached = depthMeters;
}

function updateHealth(dt) {
  const biome = getBiome(currentDepthMeters());
  drill.health -= drill.fuelDrainRate * getEffectiveFuelMultiplier(biome) * dt; // Magma = 1.5x drain, 1.1x at max Cooling
  drill.health = clamp(drill.health, 0, drill.maxHealth);
  if (drill.health <= 0) {
    endGame(lastDamageCause || 'Fuel Starvation');
  }
}

function update(dt) {
  tickInterstitialTimer(); // wall-clock based; keeps ticking regardless of run state
  updateParticles(dt);
  updateScreenShake(dt);

  if (!state.running) return;
  updateDrillSteer(dt);
  updateDrillFall(dt);
  updateCollisions(dt);
  if (!state.running) return; // a Chest hit inside updateCollisions pauses instantly
  updateNearMissCombo();
  updateMagnet(dt);
  updateShield(dt);
  updateScoreBoost(dt);
  updateGoldRushShaftIndicator();
  updateOverdrive(dt);
  updateContractProgress();
  updateHealth(dt);
  updateAmbientPad(); // no-ops unless the current biome actually changed
}

// Checks each of today's not-yet-completed contracts against this run's live
// progress. First time a target is met: mark it done for today, persist,
// toast it, and queue its bonus gold to be banked when the run ends.
function updateContractProgress() {
  for (const goal of state.dailyContracts.goals) {
    if (goal.completedToday) continue;
    const template = getContractTemplate(goal.id);
    if (template.getProgress() < goal.target) continue;

    goal.completedToday = true;
    saveDailyContracts();
    const boostedGold = Math.round(goal.bonusGold * getContractGoldMultiplier());
    state.pendingContractGold += boostedGold;
    awardPassXp(PASS_XP_PER_CONTRACT);
    state.contractsCompletedLifetime += 1;
    storageSet('ec_contractsCompletedLifetime', String(state.contractsCompletedLifetime));
    queueToast('Contract Complete! ' + template.label(goal.target) + ' (+' + boostedGold + ' Gold)');
  }
}

// ---------- Render ----------
function shadeColor(hex, amount) {
  // amount: -1..1, negative = darker, positive = lighter
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const adj = (c) => Math.max(0, Math.min(255, Math.round(amount > 0 ? c + (255 - c) * amount : c + c * amount)));
  return `rgb(${adj(r)}, ${adj(g)}, ${adj(b)})`;
}

// DIRT/STONE textures are pre-rendered once per (block type, biome, variant)
// into a small offscreen canvas — gradient, chunky bevel, and a sprinkle of
// noise speckle baked in — then reused every frame via a single drawImage()
// per cell, the same per-frame cost as the old flat fillRect had. Two
// variants per combination, picked per-cell by a cheap deterministic hash
// of its row/col, break up what would otherwise be an obviously-repeating
// tile pattern without any extra runtime cost.
const TILE_VARIANTS_PER_TYPE = 3;
const tileTextureCache = {};

function createTileTexture(baseColorHex, seed, isStone) {
  // Generated at DPR resolution, not a flat BLOCKxBLOCK — the main canvas
  // now renders at devicePixelRatio (see the HD rendering fix), so a
  // texture baked at a fixed 40x40 would itself get upscaled and look
  // blurry when drawn into that higher-res canvas, undermining the exact
  // sharpness the DPR fix was for. All the drawing code below still just
  // uses BLOCK-sized logical coordinates — tctx.scale(DPR, DPR) handles the
  // upscaling the same way the main canvas's own scale() does.
  const tex = document.createElement('canvas');
  tex.width = BLOCK * DPR;
  tex.height = BLOCK * DPR;
  const tctx = tex.getContext('2d');
  tctx.scale(DPR, DPR);

  tctx.fillStyle = baseColorHex;
  tctx.fillRect(0, 0, BLOCK, BLOCK);

  // Soft directional sheen (lit top-left, shadowed bottom-right) — a smooth
  // gradient reads as polished/realistic, not flat-shaded like a texture
  // swatch.
  const grad = tctx.createLinearGradient(0, 0, BLOCK, BLOCK);
  grad.addColorStop(0, 'rgba(255,255,255,0.16)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.20)');
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, BLOCK, BLOCK);

  // Soft ambient-occlusion vignette toward the edges — gentle radial
  // darkening reads as roundness/depth, the "premium mobile game" way to
  // suggest a 3D block without a hard-edged bevel line doing all the work.
  const vign = tctx.createRadialGradient(BLOCK / 2, BLOCK / 2, BLOCK * 0.25, BLOCK / 2, BLOCK / 2, BLOCK * 0.72);
  vign.addColorStop(0, 'rgba(0,0,0,0)');
  vign.addColorStop(1, 'rgba(0,0,0,0.16)');
  tctx.fillStyle = vign;
  tctx.fillRect(0, 0, BLOCK, BLOCK);

  // Deterministic per-seed soft speckle — organic mineral/soil grain, not
  // a repeating grid (stable across regenerations, same seed -> same
  // texture, so caching it is safe).
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const speckleCount = 7 + Math.floor(rand() * 5);
  for (let i = 0; i < speckleCount; i++) {
    const x = rand() * BLOCK;
    const y = rand() * BLOCK;
    const rad = 1 + rand() * 2;
    tctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.11)' : 'rgba(0,0,0,0.15)';
    tctx.beginPath();
    tctx.arc(x, y, rad, 0, Math.PI * 2);
    tctx.fill();
  }

  // Stone gets a jagged crack line for a genuine rock feel — dirt doesn't
  // (a straight crack reads as rock, not soil).
  if (isStone) {
    tctx.strokeStyle = 'rgba(0,0,0,0.26)';
    tctx.lineWidth = 1;
    tctx.beginPath();
    let cx = 6 + rand() * (BLOCK - 12);
    let cy = 4 + rand() * 8;
    tctx.moveTo(cx, cy);
    const segments = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < segments; i++) {
      cx += (rand() - 0.3) * 10;
      cy += BLOCK / (segments + 1);
      tctx.lineTo(cx, cy);
    }
    tctx.stroke();
  }

  // Soft edge highlight/shadow — thin, low-opacity, reads as a gently
  // rounded edge (paired with the AO vignette above) rather than a hard
  // blocky bevel border.
  tctx.strokeStyle = 'rgba(255,255,255,0.14)';
  tctx.lineWidth = 1.5;
  tctx.beginPath();
  tctx.moveTo(1, BLOCK - 1);
  tctx.lineTo(1, 1);
  tctx.lineTo(BLOCK - 1, 1);
  tctx.stroke();

  tctx.strokeStyle = 'rgba(0,0,0,0.20)';
  tctx.beginPath();
  tctx.moveTo(BLOCK - 1, 1);
  tctx.lineTo(BLOCK - 1, BLOCK - 1);
  tctx.lineTo(1, BLOCK - 1);
  tctx.stroke();

  tctx.strokeStyle = 'rgba(0,0,0,0.3)';
  tctx.lineWidth = 1;
  tctx.strokeRect(0.5, 0.5, BLOCK - 1, BLOCK - 1);

  return tex;
}

function getTileTexture(type, biome, variantIndex) {
  const baseColor = type === DIRT ? biome.dirtColor : biome.stoneColor;
  const key = type + '_' + biome.name + '_' + variantIndex;
  if (!tileTextureCache[key]) {
    const seed = (type === DIRT ? 1000 : 2000) + biome.name.length * 97 + variantIndex * 613;
    tileTextureCache[key] = createTileTexture(baseColor, seed, type === STONE);
  }
  return tileTextureCache[key];
}

// Gold stays a live per-cell draw (not pre-rendered) since it's rare enough
// that the extra per-cell gradient cost is negligible, and the pulsing
// shine needs performance.now() at draw time anyway.
function drawGoldBlock(screenX, screenY, nowMs) {
  const cx = screenX + BLOCK / 2;
  const cy = screenY + BLOCK / 2;
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 300);

  ctx.save();
  ctx.globalAlpha = 0.25 + pulse * 0.15;
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, BLOCK * 0.72);
  glow.addColorStop(0, 'rgba(255,215,0,0.55)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);
  ctx.restore();

  const grad = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, BLOCK * 0.65);
  grad.addColorStop(0, '#fff9c4');
  grad.addColorStop(0.45, '#ffd700');
  grad.addColorStop(1, '#b8860b');
  ctx.fillStyle = grad;
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  // Soft edge vignette for roundness, matching the terrain tiles' AO
  const vign = ctx.createRadialGradient(cx, cy, BLOCK * 0.2, cx, cy, BLOCK * 0.7);
  vign.addColorStop(0, 'rgba(0,0,0,0)');
  vign.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = vign;
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);

  // Primary shine (pulses) plus a small fixed secondary glint — one moving
  // highlight alone reads as flat plastic; two fixed points of light (one
  // animated, one static) is what actually sells "polished metal."
  ctx.fillStyle = `rgba(255,255,255,${0.5 + pulse * 0.3})`;
  ctx.beginPath();
  ctx.arc(cx - 5, cy - 5, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(cx + 7, cy + 6, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

// Faceted crystal, not a recolored gold orb — angular kite-cut silhouette
// (pointed top/bottom, wide middle) with distinctly shaded left/right/top
// facets reads as an actual cut gemstone, and gives Diamond a shape players
// can tell apart from Gold at a glance, not just a color. DIAMOND previously
// had no draw case at all in the render loop (spawn and collision logic
// existed, but nothing ever rendered it — it was invisible in actual
// gameplay), discovered while making this pass.
function drawDiamondBlock(screenX, screenY, nowMs) {
  const cx = screenX + BLOCK / 2;
  const cy = screenY + BLOCK / 2;
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 260);

  ctx.save();
  ctx.globalAlpha = 0.3 + pulse * 0.2;
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, BLOCK * 0.75);
  glow.addColorStop(0, 'rgba(79,216,255,0.6)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);
  ctx.restore();

  const top = { x: cx, y: cy - BLOCK * 0.34 };
  const midL = { x: cx - BLOCK * 0.32, y: cy - BLOCK * 0.04 };
  const midR = { x: cx + BLOCK * 0.32, y: cy - BLOCK * 0.04 };
  const bottom = { x: cx, y: cy + BLOCK * 0.36 };

  // Left facet — lit
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(midL.x, midL.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.closePath();
  ctx.fillStyle = '#b3f0ff';
  ctx.fill();

  // Right facet — shadowed
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(midR.x, midR.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.closePath();
  ctx.fillStyle = '#00b8d4';
  ctx.fill();

  // Top table facet — brightest
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(midL.x, midL.y);
  ctx.lineTo(midR.x, midR.y);
  ctx.closePath();
  ctx.fillStyle = '#e0fbff';
  ctx.fill();

  ctx.strokeStyle = 'rgba(0,50,70,0.55)';
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(midL.x, midL.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.lineTo(midR.x, midR.y);
  ctx.closePath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.stroke();

  ctx.fillStyle = `rgba(255,255,255,${0.6 + pulse * 0.35})`;
  ctx.beginPath();
  ctx.arc(cx - BLOCK * 0.08, cy - BLOCK * 0.14, 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);
}

// Reads as an actual supply crate, not a decorative stripe pattern — the
// old version (purple fill + diagonal gold stripes) had no crate
// iconography at all and, worse, shared its purple backdrop with the RELIC
// block right below, so the two "special, non-diggable" blocks looked like
// variants of the same thing instead of two different rewards. Wood crate
// + gold latch + a gold pulsing glow (same "come get me" language the gold
// ore already uses) makes it unambiguous at a glance: reinforced supply
// container, worth hitting.
function drawChestBlock(screenX, screenY) {
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
  const cx = screenX + BLOCK / 2;
  const cy = screenY + BLOCK / 2;

  ctx.fillStyle = '#241708';
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  // Inviting glow behind the crate, pulsing like gold ore does — the same
  // visual cue for "this one's good, go get it."
  ctx.save();
  ctx.globalAlpha = 0.25 + pulse * 0.25;
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, BLOCK * 0.62);
  glow.addColorStop(0, '#ffe082');
  glow.addColorStop(1, 'rgba(255, 224, 130, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);
  ctx.restore();

  const bodyX = screenX + BLOCK * 0.10;
  const bodyW = BLOCK * 0.80;
  const bodyTop = screenY + BLOCK * 0.40;
  const bodyH = BLOCK * 0.50;
  const lidTop = screenY + BLOCK * 0.20;
  const lidH = bodyTop - lidTop;

  // Body (darker wood)
  const bodyGrad = ctx.createLinearGradient(bodyX, bodyTop, bodyX, bodyTop + bodyH);
  bodyGrad.addColorStop(0, '#7a4f28');
  bodyGrad.addColorStop(1, '#4a2e16');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(bodyX, bodyTop, bodyW, bodyH);

  // Lid (lighter wood, distinct band on top of the body)
  const lidGrad = ctx.createLinearGradient(bodyX, lidTop, bodyX, lidTop + lidH);
  lidGrad.addColorStop(0, '#c9903f');
  lidGrad.addColorStop(1, '#9c6a2e');
  ctx.fillStyle = lidGrad;
  ctx.fillRect(bodyX, lidTop, bodyW, lidH);

  // Reinforcing metal bands (vertical), crossing lid + body as one crate
  ctx.strokeStyle = 'rgba(40, 40, 40, 0.85)';
  ctx.lineWidth = 3;
  [bodyX + bodyW * 0.22, bodyX + bodyW * 0.78].forEach((bandX) => {
    ctx.beginPath();
    ctx.moveTo(bandX, lidTop);
    ctx.lineTo(bandX, bodyTop + bodyH);
    ctx.stroke();
  });

  // Gold latch at the lid/body seam — the one bright focal point
  ctx.fillStyle = `rgba(255, 215, 0, ${0.85 + pulse * 0.15})`;
  ctx.beginPath();
  ctx.arc(cx, bodyTop, BLOCK * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7a4f00';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Crate outline + tile border
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bodyX, lidTop, bodyW, bodyH + lidH);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);
}

function drawRelicBlock(screenX, screenY) {
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
  ctx.save();
  ctx.fillStyle = '#2a0845';
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  ctx.shadowColor = `rgba(255, 215, 255, ${0.4 + pulse * 0.5})`;
  ctx.shadowBlur = 12;
  ctx.fillStyle = `hsl(${280 + pulse * 40}, 90%, ${55 + pulse * 20}%)`;
  const cx = screenX + BLOCK / 2;
  const cy = screenY + BLOCK / 2;
  const s = BLOCK * 0.28;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);
}

function drawGasBlock(screenX, screenY) {
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
  ctx.fillStyle = '#2e5c34';
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  // a few drifting "bubbles" read as unstable gas rather than solid ground
  ctx.fillStyle = `rgba(129, 199, 132, ${0.5 + pulse * 0.4})`;
  const bubbles = [
    [0.3, 0.35, 5], [0.65, 0.55, 6], [0.45, 0.75, 4],
  ];
  for (const [bx, by, br] of bubbles) {
    ctx.beginPath();
    ctx.arc(screenX + BLOCK * bx, screenY + BLOCK * by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);
}

function render() {
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  ctx.save();
  if (shakeTimer > 0) {
    const dx = (Math.random() * 2 - 1) * shakeMagnitude;
    const dy = (Math.random() * 2 - 1) * shakeMagnitude;
    ctx.translate(dx, dy);
  }

  // sky/background — tinted to the drill's current biome, visible in tunnels.
  // A subtle radial vignette instead of a flat fill — one gradient per
  // frame, cheap, but reads much less flat than a single solid color.
  const currentBiome = getBiome(currentDepthMeters());
  const bgGrad = ctx.createRadialGradient(
    LOGICAL_W / 2, LOGICAL_H * 0.3, 0,
    LOGICAL_W / 2, LOGICAL_H * 0.3, LOGICAL_H
  );
  bgGrad.addColorStop(0, shadeColor(currentBiome.bgColor, 0.15));
  bgGrad.addColorStop(1, shadeColor(currentBiome.bgColor, -0.2));
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // camera: keep drill at ~35% down the screen
  const cameraY = drill.worldY - LOGICAL_H * 0.35;

  const firstVisibleRow = Math.floor(cameraY / BLOCK) - 1;
  const lastVisibleRow = Math.ceil((cameraY + LOGICAL_H) / BLOCK) + 1;
  ensureRowsGenerated(Math.max(0, lastVisibleRow));

  for (let r = Math.max(0, firstVisibleRow); r <= lastVisibleRow; r++) {
    const rowData = world.rows[r];
    if (!rowData) continue;
    const screenY = r * BLOCK - cameraY;
    const rowBiome = getBiome(r); // row index === depth in meters
    for (let c = 0; c < COLS; c++) {
      const type = rowData[c];
      if (type === EMPTY) continue;
      const screenX = c * BLOCK;

      if (type === CHEST) {
        drawChestBlock(screenX, screenY);
        continue;
      }
      if (type === RELIC) {
        drawRelicBlock(screenX, screenY);
        continue;
      }
      if (type === GAS) {
        drawGasBlock(screenX, screenY);
        continue;
      }
      if (type === GOLD) {
        drawGoldBlock(screenX, screenY, performance.now());
        continue;
      }
      if (type === DIAMOND) {
        drawDiamondBlock(screenX, screenY, performance.now());
        continue;
      }
      if (type === DIRT || type === STONE) {
        const variantIndex = (r * 31 + c * 17) % TILE_VARIANTS_PER_TYPE;
        // Explicit destination size (not the 2-arg natural-size form) is
        // required now that the source texture is baked at DPR resolution
        // but needs to occupy exactly one BLOCK-sized logical cell here —
        // otherwise it would draw DPR times too large.
        ctx.drawImage(getTileTexture(type, rowBiome, variantIndex), screenX, screenY, BLOCK, BLOCK);
      }
    }
  }

  // particles render behind the drill, above the terrain
  renderParticles(cameraY);

  // draw drill — shape/hitbox and color come from the active Drill Class,
  // glow intensity from the Fuel Tank upgrade level
  const drillScreenX = drill.worldX;
  const drillScreenY = drill.worldY - cameraY;
  const flashing = !state.overdriveActive && drill.invulnTimer > 0 && Math.floor(performance.now() / 80) % 2 === 0;
  const appearance = getDrillAppearance();

  // Manual layered-alpha glow instead of ctx.shadowBlur — shadowBlur is a
  // well-documented severe performance cost on mobile Safari/WKWebView, and
  // this runs on the drill EVERY frame (not occasionally), which is the
  // most likely real cause behind "touch and drag feels delayed" reported
  // from an actual iPhone: the whole render loop dropping frames under
  // shadow-compositing cost, not touch input itself arriving late. A couple
  // of oversized, low-alpha flat rects behind the drill approximate the
  // same soft glow at a fraction of the GPU cost.
  if (!flashing && appearance.glow) {
    const pad = appearance.glowBlur * 0.6;
    ctx.save();
    ctx.fillStyle = appearance.glow;
    ctx.globalAlpha = 0.30;
    ctx.fillRect(drillScreenX - pad, drillScreenY - pad, drill.width + pad * 2, drill.height + pad * 2);
    ctx.globalAlpha = 0.15;
    ctx.fillRect(drillScreenX - pad * 2, drillScreenY - pad * 2, drill.width + pad * 4, drill.height + pad * 4);
    ctx.restore();
  }

  const bodyColor = flashing ? '#ff5252' : appearance.body;
  const noseColor = flashing ? '#ff8a80' : appearance.nose;

  // Body: individually-shaded segments (each its own light-upper-left-to-
  // dark-lower-right gradient), not one flat rect with thin ring lines —
  // matches the app icon's actual stacked-beveled-cylinder look. No
  // ctx.roundRect() for the segment corners — unsupported on iOS 15 WebKit
  // (this app's IPHONEOS_DEPLOYMENT_TARGET), so plain fillRect segments
  // deliver the shading improvement without that compatibility risk.
  const segCount = 4;
  const segHeight = drill.height / segCount;
  for (let i = 0; i < segCount; i++) {
    const segY = drillScreenY + i * segHeight;
    const segGrad = ctx.createLinearGradient(drillScreenX, segY, drillScreenX + drill.width, segY + segHeight);
    segGrad.addColorStop(0, shadeColor(bodyColor, 0.5));
    segGrad.addColorStop(0.5, bodyColor);
    segGrad.addColorStop(1, shadeColor(bodyColor, -0.35));
    ctx.fillStyle = segGrad;
    ctx.fillRect(drillScreenX, segY, drill.width, segHeight);
  }
  if (!flashing) {
    ctx.strokeStyle = shadeColor(bodyColor, -0.55);
    ctx.lineWidth = 1.25;
    for (let i = 1; i < segCount; i++) {
      const grooveY = drillScreenY + i * segHeight;
      ctx.beginPath();
      ctx.moveTo(drillScreenX + 1, grooveY);
      ctx.lineTo(drillScreenX + drill.width - 1, grooveY);
      ctx.stroke();
    }
  }

  // drill nose (triangle pointing down) — brighter/more saturated than the
  // body, echoing the icon's glowing amber tip
  const noseGrad = ctx.createLinearGradient(
    drillScreenX, drillScreenY + drill.height,
    drillScreenX + drill.width, drillScreenY + drill.height + 14
  );
  noseGrad.addColorStop(0, shadeColor(noseColor, 0.55));
  noseGrad.addColorStop(0.5, noseColor);
  noseGrad.addColorStop(1, shadeColor(noseColor, -0.15));
  ctx.fillStyle = noseGrad;
  ctx.beginPath();
  ctx.moveTo(drillScreenX, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width / 2, drillScreenY + drill.height + 14);
  ctx.closePath();
  ctx.fill();

  // Bold outline around the whole silhouette (body + nose), near-black
  // regardless of body hue — the single most identifying trait of the app
  // icon's art style, missing entirely from the old thin per-class-colored
  // stroke (appearance.border, e.g. Plasma's teal — nowhere near as bold).
  ctx.strokeStyle = flashing ? '#4a0000' : 'rgba(12, 9, 7, 0.85)';
  ctx.lineWidth = Math.max(2.5, appearance.borderWidth * 1.4);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(drillScreenX, drillScreenY);
  ctx.lineTo(drillScreenX + drill.width, drillScreenY);
  ctx.lineTo(drillScreenX + drill.width, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width / 2, drillScreenY + drill.height + 14);
  ctx.lineTo(drillScreenX, drillScreenY + drill.height);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();

  // HUD updates — icons instead of spelled-out labels, and the combo badge
  // only shows once it's actually above baseline (x1.0 on every frame of
  // every run was pure noise, never conveying anything).
  depthDisplay.textContent = '⛏️ ' + state.maxDepthReached + 'm';
  goldAmountTextEl.textContent = state.gold;
  diamondDisplay.textContent = '💎 ' + state.diamondsThisRun;
  scoreDisplay.textContent = '⭐ ' + currentScore();
  comboDisplay.textContent = 'x' + state.comboMultiplier.toFixed(1);
  comboDisplay.classList.toggle('hidden', state.comboMultiplier <= 1.0);
  biomeDisplay.textContent = currentBiome.name;
  biomeDisplay.style.color = currentBiome.hudColor;
  if (state.magnetTimer > 0) {
    magnetDisplay.classList.remove('hidden');
    magnetDisplay.textContent = '🧲 Magnet: ' + state.magnetTimer.toFixed(1) + 's';
  } else {
    magnetDisplay.classList.add('hidden');
  }
  if (state.shieldTimer > 0) {
    shieldDisplay.classList.remove('hidden');
    shieldDisplay.textContent = '🛡️ Shield: ' + state.shieldTimer.toFixed(1) + 's';
  } else {
    shieldDisplay.classList.add('hidden');
  }
  if (state.scoreBoostTimer > 0) {
    scoreBoostDisplay.classList.remove('hidden');
    scoreBoostDisplay.textContent = '⭐ 2x Score: ' + state.scoreBoostTimer.toFixed(1) + 's';
  } else {
    scoreBoostDisplay.classList.add('hidden');
  }
  const healthPct = clamp(drill.health / drill.maxHealth, 0, 1) * 100;
  healthBarInner.style.width = healthPct + '%';
  if (healthPct > 50) {
    healthBarInner.style.background = 'linear-gradient(90deg, #4caf50, #8bc34a)';
  } else if (healthPct > 20) {
    healthBarInner.style.background = 'linear-gradient(90deg, #ff9800, #ffc107)';
  } else {
    healthBarInner.style.background = 'linear-gradient(90deg, #e53935, #ff5252)';
  }

  overdriveBarInner.style.width = (state.overdriveActive ? 100 : state.overdriveMeter) + '%';
  overdriveBarOuter.classList.toggle('active', state.overdriveActive);
  overdriveFlashEl.classList.toggle('active', state.overdriveActive);
}

// ---------- Main loop ----------
let lastFrameTime = performance.now();
let rafId = null;

function loop(now) {
  if (isPaused) return; // defense-in-depth — handleSdkPause() already cancels rafId

  const dt = Math.min(0.05, (now - lastFrameTime) / 1000); // clamp dt to avoid big jumps
  lastFrameTime = now;

  update(dt);
  render();

  if (state.running) {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = null;
  }
}

// Stops the loop immediately (e.g. a Chest hit) rather than waiting for the
// in-flight frame to naturally decide not to reschedule itself.
function pauseGameLoop() {
  state.running = false;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  ambientPadFadeOut(); // single choke point for manual pause, Chest hit, AND Game Over
}

// ---------- Platform lifecycle bootstrap (Playgama Bridge SDK / Capacitor) ----------
// Every hook here is wrapped so an SDK failure/absence can never break the
// game — this file also has to run standalone (no Bridge, no Capacitor) for
// local dev and the browser-based verification workflow.
function initPlayablesSDK() {
  if (isNativeMobile) {
    // iOS: no yt.game.onPause/onResume — Capacitor's App plugin is the
    // native equivalent. isActive:false covers both backgrounding and the
    // app being interrupted (e.g. a phone call), same "player left" moment
    // handleSdkPause()/handleSdkResume() already exist to handle.
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) handleSdkResume();
          else handleSdkPause();
        });
      }
    } catch (e) {
      // App plugin wiring must never block the game from running
    }
    try {
      const notifPlugin = getLocalNotificationsPlugin();
      if (notifPlugin) {
        // Fires both when a notification is tapped while the app is already
        // running AND when tapping it is what launched the app in the first
        // place (Capacitor replays the "launch notification" to a listener
        // registered here, even though the tap happened before this line
        // ran) — one listener correctly covers both cases.
        notifPlugin.addListener('localNotificationActionPerformed', (action) => {
          const deepLink = action && action.notification && action.notification.extra && action.notification.extra.deepLink;
          applyDeepLink(deepLink);
        });
      }
    } catch (e) {
      // notification tap wiring must never block the game from running
    }
    initAdMob(); // fire-and-forget — handles its own errors, never blocks the game from running
    return;
  }

  if (!(window.bridge && window.bridge.initialize)) return; // Bridge script didn't load — game already works fully offline/local
  bridgeReadyPromise = window.bridge.initialize();
  bridgeReadyPromise.then(() => {
    try {
      // Required step: read platform.language once after init. This game
      // has no localization system (English-only), so there's nothing to
      // switch — read-and-ignore is the honest, compliant thing to do here
      // rather than pretending to act on a language we don't support.
      void window.bridge.platform.language;

      const platform = window.bridge.platform;
      const EVENT = window.bridge.EVENT_NAME;
      if (platform) {
        // Required step: apply the CURRENT audio state on start — the event
        // below only fires on subsequent changes, not the initial value.
        if (typeof platform.isAudioEnabled !== 'undefined') applySdkAudioState(platform.isAudioEnabled);
        if (EVENT && typeof platform.on === 'function') {
          if (EVENT.AUDIO_STATE_CHANGED) platform.on(EVENT.AUDIO_STATE_CHANGED, (enabled) => applySdkAudioState(enabled));
          if (EVENT.PAUSE_STATE_CHANGED) platform.on(EVENT.PAUSE_STATE_CHANGED, (paused) => { if (paused) handleSdkPause(); else handleSdkResume(); });
        }
      }
    } catch (e) {
      // SDK wiring must never block the game from running
    }
    notifyGameReady();       // required: only after Bridge is actually initialized
    sdkLoadAndMergeIfAvailable();
    showMenuBanner();        // Start Screen is the default visible screen at this point
  }).catch(() => {
    // initialize() rejected — game already works fully offline/local, nothing else to do
  });
}

function notifyGameReady() {
  try {
    if (window.bridge && window.bridge.platform && window.bridge.platform.sendMessage) {
      window.bridge.platform.sendMessage('game_ready');
    }
  } catch (e) {}
}

// Bridge has no direct score-submission call (Leaderboards is a separate,
// unconfigured optional module) — this now reports the recommended
// level_failed lifecycle message at the same hook (a run ending in
// destruction maps to "the player lost the level" in Bridge's model).
function sdkSendScore() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    if (window.bridge.platform && window.bridge.platform.sendMessage) {
      window.bridge.platform.sendMessage('level_failed');
    }
  }).catch(() => {});
}

// Mirrors the same fields already covered by storageGet/storageSet into the
// platform's own save slot via bridge.storage — the actual persistence
// channel Playgama's Storage requirement calls for (localStorage is still
// used underneath, but only as this mirror's local half, synced through
// bridge.storage on every meaningful change, never bypassing it — see
// sdkLoadAndMergeIfAvailable() below for why a plain "always trust
// whichever wrote most recently" isn't quite that simple).
//
// savedAt is stamped synchronously via storageSetRaw (not storageSet, which
// would recurse right back into this function) the INSTANT this fires, not
// when the async bridge.storage.set() below actually completes — so it
// stays accurate even if that write never finishes (tab closes, network
// drops). This is the timestamp sdkLoadAndMergeIfAvailable() compares
// against on the next boot to decide whether Bridge's copy is actually
// newer than this device's, instead of blindly trusting either side.
function sdkSaveIfAvailable() {
  // bridgeReadyPromise null = init hasn't started yet (this can fire during
  // module-eval-time state loading, before initPlayablesSDK() has even run)
  // — skip for now, the next storageSet() call will catch it. Required:
  // window.bridge.storage itself is never read until INSIDE the .then()
  // below — touching it any earlier (even just this presence check) logs a
  // real SDK warning, confirmed against the live CDN script.
  if (!(window.bridge && bridgeReadyPromise)) return;
  const savedAt = Date.now();
  storageSetRaw('ec_save_savedAt', String(savedAt));
  bridgeReadyPromise.then(() => {
    if (!window.bridge.storage) return;
    return window.bridge.storage.set(['ec_save'], [JSON.stringify({
      savedAt,
      bankedGold: state.bankedGold,
      highScore: state.highScore,
      diamonds: state.diamonds,
      fuelUpgradeLevel: state.fuelUpgradeLevel,
      coolingUpgradeLevel: state.coolingUpgradeLevel,
      thrusterUpgradeLevel: state.thrusterUpgradeLevel,
      alloyUpgradeLevel: state.alloyUpgradeLevel,
      offlineRigUpgradeLevel: state.offlineRigUpgradeLevel,
      diamondSieveUpgradeLevel: state.diamondSieveUpgradeLevel,
      relicScannerUpgradeLevel: state.relicScannerUpgradeLevel,
      contractRunnerUpgradeLevel: state.contractRunnerUpgradeLevel,
      prestigeLevel: state.prestigeLevel,
      passXp: state.passXp,
      passSeasonNumber: state.passSeasonNumber,
      loginStreak: state.loginStreak,
      lifetimeGoldEarned: state.lifetimeGoldEarned,
      bestDepthEver: state.bestDepthEver,
      contractsCompletedLifetime: state.contractsCompletedLifetime,
      relicsFound: state.relicsFound,
      selectedClass: state.selectedClass,
      unlockedTrails: state.unlockedTrails,
      selectedTrail: state.selectedTrail,
      unlockedBaseSkins: state.unlockedBaseSkins,
      selectedBaseSkin: state.selectedBaseSkin,
    })]);
  }).catch(() => {});
}

// Restores from the platform's own save slot on boot — Playgama's Storage
// requirement calls for Bridge to be the actual sync mechanism (including
// onto a device that already has SOME, possibly older, local progress —
// not just a brand-new empty one), so this always checks in, not just when
// local storage is empty.
//
// What it must NOT do is blindly overwrite fresher local progress with a
// stale Bridge snapshot: localStorage is written synchronously the instant
// something changes, while sdkSaveIfAvailable()'s mirror write is
// asynchronous and can still be in flight if the tab closes/reloads
// shortly after an action — confirmed directly, a stale bridge snapshot
// once overwrote a value that had just been set moments earlier. Resolved
// with an actual timestamp comparison (savedAt, stamped synchronously by
// sdkSaveIfAvailable — see its own comment) instead of a blunt "local
// always wins" or "bridge always wins" rule: whichever copy is genuinely
// newer wins, which is what both the compliance requirement and the bug
// fix actually need.
async function sdkLoadAndMergeIfAvailable() {
  if (!(window.bridge && window.bridge.storage && bridgeReadyPromise)) return;
  try {
    await bridgeReadyPromise;
    const result = await window.bridge.storage.get(['ec_save']);
    const raw = result && result[0];
    if (!raw) return;
    // Confirmed against the real Bridge SDK: storage.get() can hand back an
    // already-parsed object for a value that was storage.set() as a JSON
    // string, not the raw string itself — parse only if it's actually still
    // a string, otherwise use the object as-is.
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const localSavedAt = parseInt(storageGet('ec_save_savedAt') || '0', 10);
    if (typeof data.savedAt === 'number' && data.savedAt <= localSavedAt) return; // local is already at least as fresh — nothing to pull in
    // Bridge's copy just won — apply it to BOTH state (so this session
    // reflects it immediately) AND the individual localStorage keys (via
    // storageSetRaw, not storageSet — this must not kick off yet another
    // mirror-save cycle back to bridge.storage for data bridge itself just
    // supplied). Skipping the localStorage half was a real bug: without it,
    // a plain reload right after a legitimate cross-device sync — with no
    // new local changes in between — would revert straight back to this
    // device's stale local values, because module-eval-time hydration
    // reads those individual keys directly, never this merged blob.
    const setNum = (field, key) => { if (typeof data[field] === 'number') { state[field] = data[field]; storageSetRaw(key, String(data[field])); } };
    const setArr = (field, key, mustInclude) => { if (Array.isArray(data[field]) && (!mustInclude || data[field].includes(mustInclude))) { state[field] = data[field]; storageSetRaw(key, JSON.stringify(data[field])); } };

    setNum('bankedGold', 'ec_bankedGold');
    setNum('highScore', 'ec_highScore');
    setNum('diamonds', 'ec_diamonds');
    setNum('fuelUpgradeLevel', 'ec_fuelUpgradeLevel');
    setNum('coolingUpgradeLevel', 'ec_coolingUpgradeLevel');
    setNum('thrusterUpgradeLevel', 'ec_thrusterUpgradeLevel');
    setNum('alloyUpgradeLevel', 'ec_alloyUpgradeLevel');
    setNum('offlineRigUpgradeLevel', 'ec_offlineRigUpgradeLevel');
    setNum('diamondSieveUpgradeLevel', 'ec_diamondSieveUpgradeLevel');
    setNum('relicScannerUpgradeLevel', 'ec_relicScannerUpgradeLevel');
    setNum('contractRunnerUpgradeLevel', 'ec_contractRunnerUpgradeLevel');
    setNum('prestigeLevel', 'ec_prestigeLevel');
    setNum('passXp', 'ec_passXp');
    setNum('passSeasonNumber', 'ec_passSeasonNumber');
    setNum('loginStreak', 'ec_loginStreak');
    setNum('lifetimeGoldEarned', 'ec_lifetimeGoldEarned');
    setNum('bestDepthEver', 'ec_bestDepthEver');
    setNum('contractsCompletedLifetime', 'ec_contractsCompletedLifetime');
    setArr('relicsFound', 'ec_relics');
    if (typeof data.selectedClass === 'string' && DRILL_CLASSES[data.selectedClass]) {
      state.selectedClass = data.selectedClass;
      storageSetRaw('ec_selectedClass', data.selectedClass);
    }
    setArr('unlockedTrails', 'ec_unlockedTrails', 'standard');
    if (typeof data.selectedTrail === 'string' && state.unlockedTrails.includes(data.selectedTrail)) {
      state.selectedTrail = data.selectedTrail;
      storageSetRaw('ec_selectedTrail', data.selectedTrail);
    }
    setArr('unlockedBaseSkins', 'ec_unlockedBaseSkins', 'standard');
    if (typeof data.selectedBaseSkin === 'string' && state.unlockedBaseSkins.includes(data.selectedBaseSkin)) {
      state.selectedBaseSkin = data.selectedBaseSkin;
      storageSetRaw('ec_selectedBaseSkin', data.selectedBaseSkin);
    }
    // Record Bridge's timestamp locally too, so a reload with no new
    // changes in between doesn't needlessly re-pull and re-apply the same
    // snapshot again.
    storageSetRaw('ec_save_savedAt', String(data.savedAt || Date.now()));
    startHighscoreEl.textContent = 'High Score: ' + state.highScore; // reflect a late-arriving platform save
  } catch (e) {
    // keep whatever local storage / defaults already loaded
  }
}

// ---------- Offline / idle mining ----------
// Awards gold for time elapsed since the last visit (capped at 24h), shown
// via a Welcome Back overlay the player must dismiss before Start is
// reachable (it's a full-screen .overlay stacked over start-screen — same
// "nothing behind it is clickable" technique already used by Upgrades/
// Museum/Contracts/Loadout, not the body.paused SDK-pause lockout, which is
// reserved for genuine platform pause so its own button-disable rule never
// has to be carved out for anything else — see the game-plan note on this).
const OFFLINE_GOLD_PER_HOUR = 10;
const OFFLINE_CAP_MS = 24 * 60 * 60 * 1000;
const OFFLINE_HEARTBEAT_MS = 15000;
const REWARD_ID_WELCOME_BACK_DOUBLE = 'endlesscore-welcomeback-2x';

// Held rather than banked immediately, so the rewarded-ad double-up below
// has something to double before it's committed to bankedGold — same
// "decide before it's final" shape as the Game Over screen's 2x Gold button.
let pendingOfflineGold = 0;

function checkOfflineEarnings() {
  const lastPlayedRaw = storageGet('ec_lastPlayedTimestamp');
  const now = Date.now();
  storageSet('ec_lastPlayedTimestamp', String(now)); // stamp immediately so a refresh can't double-count this window

  if (!lastPlayedRaw) return; // first-ever visit — nothing to award, nothing to show
  const lastPlayed = parseInt(lastPlayedRaw, 10);
  if (!Number.isFinite(lastPlayed) || lastPlayed <= 0) return;

  const elapsedMs = clamp(now - lastPlayed, 0, OFFLINE_CAP_MS);
  const earnedGold = Math.floor((elapsedMs / (60 * 60 * 1000)) * getOfflineGoldPerHour());
  if (earnedGold <= 0) return;

  pendingOfflineGold = earnedGold;
  welcomeBackGoldEl.textContent = earnedGold;
  welcomeBackDoubleBtn.textContent = WELCOME_BACK_DOUBLE_BTN_DEFAULT_TEXT;
  welcomeBackDoubleBtn.disabled = false;
  welcomeBackScreen.classList.remove('hidden');
}

document.getElementById('welcome-back-btn').addEventListener('click', () => {
  syncBankedGold(pendingOfflineGold);
  pendingOfflineGold = 0;
  welcomeBackScreen.classList.add('hidden');
  updateStartScreenHud(); // the Gold pill needs to reflect what was just collected
});

// Shown once ever, stacked over the Start Screen — mutually exclusive with
// Welcome Back in practice, since a brand new player has no offline time to
// have earned anything from yet.
function maybeShowTutorial() {
  if (state.hasSeenTutorial) return;
  tutorialScreen.classList.remove('hidden');
}

document.getElementById('tutorial-close-btn').addEventListener('click', () => {
  state.hasSeenTutorial = true;
  storageSet('ec_hasSeenTutorial', 'true');
  tutorialScreen.classList.add('hidden');
});

// Mirrors watchAdDoubleGold() (Game Over screen) exactly — same one-shot,
// stays-disabled-after-success shape, reusing the already-integrated AdMob
// rewarded flow rather than adding any new ad surface.
async function watchAdWelcomeBackDouble() {
  if (welcomeBackDoubleBtn.disabled) return;
  welcomeBackDoubleBtn.disabled = true;
  welcomeBackDoubleBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo(REWARD_ID_WELCOME_BACK_DOUBLE);

  if (watched) {
    console.log('AD: Welcome Back 2x ad watched — doubling pending offline Gold');
    pendingOfflineGold *= 2;
    welcomeBackGoldEl.textContent = pendingOfflineGold;
    welcomeBackDoubleBtn.textContent = 'Gold Doubled!';
    // stays disabled — one double per Welcome Back, same rule as Game Over's 2x Gold
  } else {
    console.log('AD: Welcome Back 2x ad failed to load / was not completed');
    welcomeBackDoubleBtn.textContent = 'Ad Unavailable — Try Again';
    setTimeout(() => {
      welcomeBackDoubleBtn.textContent = WELCOME_BACK_DOUBLE_BTN_DEFAULT_TEXT;
      welcomeBackDoubleBtn.disabled = false;
    }, 1500);
  }
}
welcomeBackDoubleBtn.addEventListener('click', watchAdWelcomeBackDouble);

// ---------- Login streak ----------
// Consecutive-day bonus — a proven, simple retention mechanic distinct from
// the Season Pass (long-horizon, requires actual play) and offline earnings
// (rewards absence, not return): this specifically rewards SHOWING UP. Gold
// scales per day up to a cap (so the economy doesn't inflate forever) but
// the visible streak count keeps climbing uncapped, since the number itself
// — not just the Gold — is the motivating part ("Day 15!" feels different
// from "Day 7 again"). Announced via the existing toast system rather than
// a new overlay; non-blocking, doesn't compete with the Welcome Back screen
// when both trigger on the same cold load.
const LOGIN_STREAK_GOLD_BASE = 10;
const LOGIN_STREAK_GOLD_STEP = 8;
const LOGIN_STREAK_MAX_REWARD_DAY = 7;

function todayDateString(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loginStreakRewardForDay(day) {
  const cappedDay = Math.min(day, LOGIN_STREAK_MAX_REWARD_DAY);
  return LOGIN_STREAK_GOLD_BASE + (cappedDay - 1) * LOGIN_STREAK_GOLD_STEP;
}

function checkLoginStreak() {
  const today = todayDateString();
  const lastLoginDate = storageGet('ec_lastLoginDate');
  if (lastLoginDate === today) return; // already counted today — a page refresh must never double-award

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday = lastLoginDate === todayDateString(yesterday);

  const streak = lastLoginDate ? (wasYesterday ? state.loginStreak + 1 : 1) : 1;
  state.loginStreak = streak;
  storageSet('ec_lastLoginDate', today);
  storageSet('ec_loginStreak', String(streak));

  const reward = loginStreakRewardForDay(streak);
  syncBankedGold(reward);
  queueToast(`🔥 Day ${streak} Streak! +${reward} Gold`);
}

// Keeps the "last played" timestamp fresh while the tab is open/backgrounded,
// so the next visit's offline window is measured from the real last moment
// played, not just from page load. Deliberately not the raw browser page
// visibility API — the Playables spec forbids reading that directly, since
// the platform's own pause/resume hook (see handleSdkPause below) is the
// sanctioned signal for "player left".
setInterval(() => storageSet('ec_lastPlayedTimestamp', String(Date.now())), OFFLINE_HEARTBEAT_MS);
window.addEventListener('beforeunload', () => storageSet('ec_lastPlayedTimestamp', String(Date.now())));

// Starts the async Bridge init (or native AdMob/App-plugin wiring) as early
// as possible. Everything below is still synchronous and local-storage-first
// — the game is fully playable immediately and never waits on this; Bridge's
// own required game_ready message and save/load merge fire later, from
// inside initPlayablesSDK()'s bridge.initialize().then() callback, once
// Bridge is actually ready to accept API calls (never before, per Playgama's
// #1 required integration rule).
initPlayablesSDK();

// Initial idle render (so canvas isn't blank behind the start screen)
startHighscoreEl.textContent = 'High Score: ' + state.highScore;
ensureRowsGenerated(20);
render();

checkOfflineEarnings();
maybeShowTutorial();
checkLoginStreak();
updateStartScreenHud();
applyAudioMutePreference(); // apply a persisted mute preference immediately, before the player ever opens Settings
