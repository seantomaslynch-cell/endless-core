// ============================================================
// Endless Core - core game logic
// ============================================================

// ---------- Cross-platform bridge ----------
// This single game.js ships to two hosts: the web build (YouTube Playables,
// gated by window.ytgame.IN_PLAYABLES_ENV — see the SDK bootstrap section
// further down) and the Capacitor-wrapped iOS app. isNativeMobile is the one
// flag that tells the rest of the file which platform bridge is live; every
// SDK-facing function below branches on it (or on ytgame's own presence,
// which is simply absent/inert on iOS) rather than assuming either platform.
const isNativeMobile = typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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

function storageSet(key, value) {
  if (!storageAvailable) {
    memoryStorage[key] = value;
  } else {
    try {
      localStorage.setItem(key, value);
    } catch {
      storageAvailable = false;
      memoryStorage[key] = value;
    }
  }
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

// Separate from muteAudio()/unmuteAudio() above (which duck gain to 0 during
// a rewarded ad): this reflects the YouTube platform's own mute state via
// ytgame.system.isAudioEnabled()/onAudioEnabledChange. The spec requires
// zero sound nodes while platform-muted, not just silent output, so
// playSound() checks this and returns before creating any AudioNode at all.
let sdkAudioEnabled = true;

function applySdkAudioState(enabled) {
  sdkAudioEnabled = !!enabled;
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
    // short sine blip that rises in pitch — a bright "collected" chime
    osc.type = 'sine';
    duration = 0.12;
    peakGain = 0.25;
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(1300, now + duration * 0.8);
  } else if (type === 'hit') {
    // harsh square wave that drops in pitch — an unmistakable "ouch"
    osc.type = 'square';
    duration = 0.18;
    peakGain = 0.28;
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + duration);
  } else if (type === 'dig') {
    // very quiet, very short, low-frequency thump — subtle texture, not noise
    osc.type = 'sine';
    duration = 0.05;
    peakGain = 0.05;
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + duration);
  } else if (type === 'relic') {
    // high-pitched sine sweep — a bright, unmistakable "rare find" chime
    osc.type = 'sine';
    duration = 0.3;
    peakGain = 0.3;
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(2400, now + duration * 0.6);
  } else if (type === 'explosion') {
    // low harsh square rumble dropping fast — a heavy "boom" for Gas Pockets
    osc.type = 'square';
    duration = 0.35;
    peakGain = 0.35;
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + duration);
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
    // short bright crunch/zap — Overdrive smashing through a Stone/Gas block
    osc.type = 'square';
    duration = 0.09;
    peakGain = 0.22;
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + duration);
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
];
const RELIC_MIN_DEPTH = 1500; // meters
const RELIC_CHANCE = 0.003;   // <0.5%, ultra-rare
const CHEST_CHANCE = 0.012;   // rare, but findable
const GAS_CHANCE = 0.015;     // Dirt/Ice only — Magma is already punishing enough

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
// each template so the day's 3 contracts are always one-of-each-type.
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
  try {
    const saved = JSON.parse(storageGet('ec_dailyContracts') || 'null');
    if (saved && Array.isArray(saved.goals) && Date.now() - saved.generatedAt < CONTRACT_REFRESH_MS) {
      return saved;
    }
  } catch {
    // fall through to a fresh set
  }
  const fresh = { generatedAt: Date.now(), goals: generateDailyContracts() };
  storageSet('ec_dailyContracts', JSON.stringify(fresh));
  return fresh;
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

function generateRow(rowIndex) {
  const inSafeZone = rowIndex < SAFE_ZONE_ROWS;
  // Ramp restarts its own "depth" clock at the safe zone's edge, so the
  // eased density curve climbs from 0 again at row 100 instead of resuming
  // already ~75% ramped-in (which would read as a difficulty cliff right at
  // the boundary).
  const rampDepthPixels = Math.max(0, (rowIndex - SAFE_ZONE_ROWS) * BLOCK);
  const threshold = stoneThreshold(rampDepthPixels);
  const goldChanceHere = goldChance(rampDepthPixels);
  const row = new Array(COLS);

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
      Math.random() < RELIC_CHANCE
    ) {
      row[x] = RELIC;
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
  // Reserved for the future paid track — always false/empty until a real IAP
  // purchase flow exists to set them (see unlockPassPremium()). Persisted
  // now so the shape is already correct; nothing sets these yet.
  passPremiumUnlocked: storageGet('ec_passPremiumUnlocked') === 'true',
  passClaimedPremiumTiers: loadPassClaimedPremiumTiers(),
  maxDepthReached: 0,
  startTime: 0,
  comboMultiplier: 1.0,
  magnetTimer: 0, // seconds remaining on the Chest's gold-magnet buff
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
  return computeScore(state.maxDepthReached, state.gold);
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
const PASS_REWARDS = (() => {
  const trailByTier = {};
  TRAIL_DEFS.forEach((t) => { if (t.passTier !== undefined) trailByTier[t.passTier] = t; });
  const rewards = [];
  for (let tier = 1; tier <= PASS_TIER_COUNT; tier++) {
    if (trailByTier[tier]) {
      rewards.push({ tier, type: 'trail', trailId: trailByTier[tier].id, label: trailByTier[tier].name, premiumReward: null });
    } else {
      const amount = 30 + tier * 8;
      rewards.push({ tier, type: 'gold', amount, label: amount + ' Gold', premiumReward: null });
    }
  }
  return rewards;
})();

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
    state.bankedGold += reward.amount;
    storageSet('ec_bankedGold', String(state.bankedGold));
  } else if (reward.type === 'trail' && !state.unlockedTrails.includes(reward.trailId)) {
    state.unlockedTrails.push(reward.trailId);
    storageSet('ec_unlockedTrails', JSON.stringify(state.unlockedTrails));
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
    state.bankedGold += reward.amount;
    storageSet('ec_bankedGold', String(state.bankedGold));
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
// Vibration API is Android-only (iOS Safari has never implemented it); the
// feature check makes this a silent no-op everywhere else.
function vibrateHaptic(durationMs = 10) {
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
// for game-over / Chest overlays) — this fires from ytgame.system.onPause at
// ANY point (start screen, mid-run, mid-overlay), so it has to work
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
const goldDisplay = document.getElementById('gold-display');
const scoreDisplay = document.getElementById('score-display');
const comboDisplay = document.getElementById('combo-display');
const biomeDisplay = document.getElementById('biome-display');
const magnetDisplay = document.getElementById('magnet-display');
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
const welcomeBackScreen = document.getElementById('welcome-back-screen');
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
const trailListEl = document.getElementById('trail-list');
const trailsBankedGoldEl = document.getElementById('trails-banked-gold');
const welcomeBackGoldEl = document.getElementById('welcome-back-gold');
const reviveBtn = document.getElementById('revive-btn');
const doubleGoldBtn = document.getElementById('double-gold-btn');
const REVIVE_BTN_DEFAULT_TEXT = reviveBtn.textContent;
const DOUBLE_GOLD_BTN_DEFAULT_TEXT = doubleGoldBtn.textContent;

document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('restart-btn').addEventListener('click', startGame);

// ---------- Rewarded video ads ----------
// Calls the real YouTube Playables SDK (ytgame.ads.requestRewardedAd) when
// present — which the certification harness's mock always provides, so that
// path is what gets exercised during testing. The setTimeout-based branch
// only runs as a dev fallback when NEITHER the real SDK nor a test mock is
// injected (e.g. opening index.html directly in a plain browser), so the ad
// flow stays testable outside the Playables env. Player-initiated only (only
// ever called from a click handler); resolves false on any failure/throw —
// callers already only grant their reward inside `if (watched) { ... }`.
function showRewardedVideo(rewardId) {
  muteAudio(); // duck game audio for the duration of the ad

  if (isNativeMobile) {
    const admob = getAdMobPlugin();
    if (!admob) { unmuteAudio(); return Promise.resolve(false); } // plugin not registered — fail closed, never throw
    return admob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_AD_UNIT_ID })
      .then(() => admob.showRewardVideoAd())
      .then((rewardItem) => { unmuteAudio(); return !!rewardItem; }) // truthy reward item = actually watched through
      .catch(() => { unmuteAudio(); return false; }); // load/show failure or dismissed early = no reward, not a crash
  }

  if (window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.ads && window.ytgame.ads.requestRewardedAd) {
    return Promise.resolve(window.ytgame.ads.requestRewardedAd(rewardId))
      .then((result) => { unmuteAudio(); return !!result; })
      .catch(() => { unmuteAudio(); return false; }); // throw = graceful no-reward, not a crash
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
const REWARD_ID_MAGNET = 'endlesscore-magnet';

// AdMob (native ads on iOS, via @capacitor-community/admob). Real ad unit
// IDs from the account — these serve real ads and count toward real
// revenue/impressions, unlike Google's public demo IDs used during initial
// integration. See also Info.plist's GADApplicationIdentifier.
const ADMOB_INTERSTITIAL_AD_UNIT_ID = 'ca-app-pub-5040304268747359/3571606543';
const ADMOB_REWARDED_AD_UNIT_ID = 'ca-app-pub-5040304268747359/8664151129';
// Rewarded Interstitial ad unit exists in the AdMob account
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

    const [trackingInfo, consentInfo] = await Promise.all([
      admob.trackingAuthorizationStatus(),
      admob.requestConsentInfo(),
    ]);

    if (trackingInfo.status === 'notDetermined') {
      await admob.requestTrackingAuthorization();
    }

    const authorizationStatus = await admob.trackingAuthorizationStatus();
    if (
      authorizationStatus.status === 'authorized' &&
      consentInfo.isConsentFormAvailable &&
      consentInfo.status === 'REQUIRED' // AdmobConsentStatus.REQUIRED — a plain string enum, safe to reference directly without importing it
    ) {
      await admob.showConsentForm();
    }
  } catch (e) {
    // AdMob init/consent wiring must never block the game from running
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
  if (!startScreen.classList.contains('hidden')) overlayReturnScreen = startScreen;
  else if (!gameoverScreen.classList.contains('hidden')) overlayReturnScreen = gameoverScreen;
  upgradesScreen.classList.add('hidden');
  museumScreen.classList.add('hidden');
  contractsScreen.classList.add('hidden');
  loadoutScreen.classList.add('hidden');
  trailsScreen.classList.add('hidden');
  passScreen.classList.add('hidden');
  startScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  screenEl.classList.remove('hidden');
}

function closeOverlay(screenEl) {
  screenEl.classList.add('hidden');
  if (overlayReturnScreen) overlayReturnScreen.classList.remove('hidden');
  overlayReturnScreen = null;
}

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

// ---------- Chest overlay ----------
const chestAdBtn = document.getElementById('chest-ad-btn');
const chestSkipBtn = document.getElementById('chest-skip-btn');
const CHEST_AD_BTN_DEFAULT_TEXT = chestAdBtn.textContent;

// Named for the same reason as watchAdRevive(); grants the magnet buff only
// on a truthy resolve.
async function watchAdMagnet() {
  if (chestAdBtn.disabled) return;
  chestAdBtn.disabled = true;
  chestSkipBtn.disabled = true;
  chestAdBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo(REWARD_ID_MAGNET);

  chestAdBtn.disabled = false;
  chestSkipBtn.disabled = false;

  if (watched) {
    console.log('AD: Magnet ad watched — activating 10s gold magnet');
    state.magnetTimer = MAGNET_DURATION;
    chestAdBtn.textContent = CHEST_AD_BTN_DEFAULT_TEXT;
    resumeAfterChest();
  } else {
    console.log('AD: Magnet ad failed to load / was not completed');
    chestAdBtn.textContent = 'Ad Unavailable — Try Again';
    chestAdBtn.disabled = true;
    chestSkipBtn.disabled = true;
    setTimeout(() => {
      chestAdBtn.textContent = CHEST_AD_BTN_DEFAULT_TEXT;
      chestAdBtn.disabled = false;
      chestSkipBtn.disabled = false;
    }, 1500);
  }
}
chestAdBtn.addEventListener('click', watchAdMagnet);

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
  pauseBtn.classList.add('hidden');
  startHighscoreEl.textContent = 'High Score: ' + state.highScore;
  startScreen.classList.remove('hidden');
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
    const swatch = reward.type === 'trail'
      ? (TRAIL_DEFS.find((t) => t.id === reward.trailId).color(BIOMES[0]))
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

function syncBankedGold(extra) {
  state.bankedGold += Math.floor(extra);
  storageSet('ec_bankedGold', String(state.bankedGold));
}

// Persists a new high score if the current run beat it. Returns true if a record was set.
function updateHighScore() {
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
  if (!(window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.ads && window.ytgame.ads.requestInterstitialAd)) {
    return; // no SDK present (local/dev testing) — nothing to show
  }
  try {
    await window.ytgame.ads.requestInterstitialAd();
  } catch (e) {
    // interstitial failures are never fatal — gameplay continues regardless
  }
}

function tickInterstitialTimer() {
  if (!interstitialArmed && firstInterstitialShown && Date.now() - lastInterstitialTime >= INTERSTITIAL_INTERVAL_MS) {
    interstitialArmed = true; // will fire at the next natural break (game over)
  }
}

// ---------- Game flow ----------
function startGame() {
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
  state.maxDepthReached = 0;
  state.startTime = performance.now();
  state.comboMultiplier = 1.0;
  state.magnetTimer = 0;
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

  startScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  upgradesScreen.classList.add('hidden');
  chestScreen.classList.add('hidden');
  museumScreen.classList.add('hidden');
  contractsScreen.classList.add('hidden');
  loadoutScreen.classList.add('hidden');
  trailsScreen.classList.add('hidden');
  passScreen.classList.add('hidden');
  manualPauseScreen.classList.add('hidden');
  newHighscoreBadge.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  startHighscoreEl.textContent = 'High Score: ' + state.highScore;

  if (!firstInterstitialShown) {
    firstInterstitialShown = true;
    showInterstitialAd(); // fire-and-forget — never blocks the run from starting
  }

  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(loop);
}

function endGame(causeOfDeath) {
  pauseGameLoop();
  state.gameOver = true;
  pauseBtn.classList.add('hidden');
  manualPauseScreen.classList.add('hidden');

  syncBankedGold(state.gold);
  if (state.pendingContractGold > 0) {
    syncBankedGold(state.pendingContractGold);
  }
  awardPassXp(state.maxDepthReached * PASS_XP_PER_METER_DEPTH + state.gold * PASS_XP_PER_GOLD);

  Analytics.logRunEnd(causeOfDeath || 'Fuel Starvation');
  sdkSendScore(currentScore());

  if (interstitialArmed) {
    showInterstitialAd(); // the natural break the ~90s timer was waiting for
  }

  finalDepthEl.textContent = state.maxDepthReached + 'm';
  finalGoldEl.textContent = state.gold;
  contractBonusEl.textContent =
    state.pendingContractGold > 0 ? '+' + state.pendingContractGold + ' Gold from Daily Contracts' : '';
  highscoreDisplayEl.textContent = 'High Score: ' + state.highScore;
  newHighscoreBadge.classList.add('hidden');
  updateHighScore();

  reviveBtn.textContent = REVIVE_BTN_DEFAULT_TEXT;
  reviveBtn.disabled = false;
  doubleGoldBtn.textContent = DOUBLE_GOLD_BTN_DEFAULT_TEXT;
  doubleGoldBtn.disabled = false;

  gameoverScreen.classList.remove('hidden');
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
      const goldGain = Math.max(1, Math.round(1 * state.comboMultiplier));
      state.gold += goldGain;
      addOverdriveMeter(OVERDRIVE_GOLD_GAIN);
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 10);
      triggerScreenShake(3, 0.08);
      playSound('coin');
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
  pauseGameLoop();
  chestScreen.classList.remove('hidden');
}

function resumeAfterChest() {
  chestScreen.classList.add('hidden');
  state.running = true;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(loop);
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
      const goldGain = Math.max(1, Math.round(1 * state.comboMultiplier));
      state.gold += goldGain;
      addOverdriveMeter(OVERDRIVE_GOLD_GAIN);
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 6);
      playSound('coin');
    }
  }
}

// Awards one not-yet-owned relic (spawn logic already stops once all 5 are
// found, so this always has a candidate when called).
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
  updateOverdrive(dt);
  updateContractProgress();
  updateHealth(dt);
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
    state.pendingContractGold += goal.bonusGold;
    awardPassXp(PASS_XP_PER_CONTRACT);
    queueToast('Contract Complete! ' + template.label(goal.target) + ' (+' + goal.bonusGold + ' Gold)');
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

  const grad = tctx.createLinearGradient(0, 0, BLOCK, BLOCK);
  grad.addColorStop(0, 'rgba(255,255,255,0.12)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, BLOCK, BLOCK);

  // Deterministic per-seed noise speckle (stable across regenerations —
  // same seed always draws the same texture, so it's safe to cache).
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const speckleCount = 6 + Math.floor(rand() * 5);
  for (let i = 0; i < speckleCount; i++) {
    const x = rand() * BLOCK;
    const y = rand() * BLOCK;
    const rad = 1 + rand() * 1.8;
    tctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
    tctx.beginPath();
    tctx.arc(x, y, rad, 0, Math.PI * 2);
    tctx.fill();
  }

  // Stone gets a jagged crack line for a genuine rock feel — dirt doesn't
  // (a straight crack reads as rock, not soil). Same cached-once cost as
  // everything else here.
  if (isStone) {
    tctx.strokeStyle = 'rgba(0,0,0,0.30)';
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

  // chunky bevel — light top/left edge, dark bottom/right edge. Slightly
  // stronger contrast than the first pass for a more visibly "chunky 3D
  // block" read rather than a subtle hint of one.
  tctx.strokeStyle = 'rgba(255,255,255,0.26)';
  tctx.lineWidth = 2;
  tctx.beginPath();
  tctx.moveTo(1, BLOCK - 1);
  tctx.lineTo(1, 1);
  tctx.lineTo(BLOCK - 1, 1);
  tctx.stroke();

  tctx.strokeStyle = 'rgba(0,0,0,0.32)';
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

  const grad = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, BLOCK * 0.65);
  grad.addColorStop(0, '#fff9c4');
  grad.addColorStop(0.45, '#ffd700');
  grad.addColorStop(1, '#b8860b');
  ctx.fillStyle = grad;
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

  if (flashing) {
    ctx.fillStyle = '#ff5252';
  } else {
    const bodyGrad = ctx.createLinearGradient(drillScreenX, drillScreenY, drillScreenX + drill.width, drillScreenY + drill.height);
    bodyGrad.addColorStop(0, shadeColor(appearance.body, 0.35));
    bodyGrad.addColorStop(1, appearance.body);
    ctx.fillStyle = bodyGrad;
  }
  ctx.fillRect(drillScreenX, drillScreenY, drill.width, drill.height);

  // Mechanical segment rings — matches the app icon's own ringed-drill-body
  // design. Purely cosmetic detail; only one drill exists at a time, so
  // there's no per-block-style performance concern about adding it.
  if (!flashing) {
    const ringCount = 3;
    ctx.strokeStyle = shadeColor(appearance.body, -0.45);
    ctx.lineWidth = 1.5;
    for (let i = 1; i < ringCount; i++) {
      const ringY = drillScreenY + (drill.height / ringCount) * i;
      ctx.beginPath();
      ctx.moveTo(drillScreenX + 2, ringY);
      ctx.lineTo(drillScreenX + drill.width - 2, ringY);
      ctx.stroke();
    }
  }

  // drill nose (triangle pointing down) — gradient instead of flat, echoing
  // the body's lit-from-one-side treatment
  if (flashing) {
    ctx.fillStyle = '#ff8a80';
  } else {
    const noseGrad = ctx.createLinearGradient(
      drillScreenX, drillScreenY + drill.height,
      drillScreenX + drill.width, drillScreenY + drill.height + 14
    );
    noseGrad.addColorStop(0, shadeColor(appearance.nose, 0.4));
    noseGrad.addColorStop(1, shadeColor(appearance.nose, -0.2));
    ctx.fillStyle = noseGrad;
  }
  ctx.beginPath();
  ctx.moveTo(drillScreenX, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width / 2, drillScreenY + drill.height + 14);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = flashing ? '#333' : appearance.border;
  ctx.lineWidth = appearance.borderWidth;
  ctx.strokeRect(drillScreenX, drillScreenY, drill.width, drill.height);

  ctx.restore();

  // HUD updates
  depthDisplay.textContent = 'Depth: ' + state.maxDepthReached + 'm';
  goldDisplay.textContent = 'Gold: ' + state.gold;
  scoreDisplay.textContent = 'Score: ' + currentScore();
  comboDisplay.textContent = 'Combo: x' + state.comboMultiplier.toFixed(1);
  biomeDisplay.textContent = 'Zone: ' + currentBiome.name;
  biomeDisplay.style.color = currentBiome.hudColor;
  if (state.magnetTimer > 0) {
    magnetDisplay.classList.remove('hidden');
    magnetDisplay.textContent = '🧲 Magnet: ' + state.magnetTimer.toFixed(1) + 's';
  } else {
    magnetDisplay.classList.add('hidden');
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
}

// ---------- Platform lifecycle bootstrap (Playables SDK / Capacitor) ----------
// Every hook here is wrapped so an SDK failure/absence can never break the
// game — this file also has to run standalone (no ytgame, no Capacitor) for
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
    initAdMob(); // fire-and-forget — handles its own errors, never blocks the game from running
    return;
  }

  if (!(window.ytgame && window.ytgame.IN_PLAYABLES_ENV)) return;
  try {
    const sys = window.ytgame.system;
    if (sys) {
      if (sys.isAudioEnabled) applySdkAudioState(sys.isAudioEnabled());
      if (sys.onAudioEnabledChange) sys.onAudioEnabledChange((enabled) => applySdkAudioState(enabled));
      if (sys.onPause) sys.onPause(handleSdkPause);
      if (sys.onResume) sys.onResume(handleSdkResume);
    }
  } catch (e) {
    // SDK wiring must never block the game from running
  }
}

function notifyFirstFrameReady() {
  try {
    if (window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.game && window.ytgame.game.firstFrameReady) {
      window.ytgame.game.firstFrameReady();
    }
  } catch (e) {}
}

function notifyGameReady() {
  try {
    if (window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.game && window.ytgame.game.gameReady) {
      window.ytgame.game.gameReady();
    }
  } catch (e) {}
}

function sdkSendScore(value) {
  try {
    if (window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.engagement && window.ytgame.engagement.sendScore) {
      window.ytgame.engagement.sendScore({ value });
    }
  } catch (e) {}
}

// Mirrors the same fields already covered by storageGet/storageSet into the
// platform's own save slot, best-effort. localStorage/memory stays the
// primary synchronous source (state is built from it at module-eval time,
// before any async SDK call could resolve) — this is a secondary copy so
// progress can follow the player across devices where the platform supports
// it, not a replacement for the safe-storage fallback built above.
function sdkSaveIfAvailable() {
  try {
    if (window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.game && window.ytgame.game.saveData) {
      window.ytgame.game.saveData(JSON.stringify({
        bankedGold: state.bankedGold,
        highScore: state.highScore,
        fuelUpgradeLevel: state.fuelUpgradeLevel,
        coolingUpgradeLevel: state.coolingUpgradeLevel,
        thrusterUpgradeLevel: state.thrusterUpgradeLevel,
        alloyUpgradeLevel: state.alloyUpgradeLevel,
        relicsFound: state.relicsFound,
        selectedClass: state.selectedClass,
        unlockedTrails: state.unlockedTrails,
        selectedTrail: state.selectedTrail,
      }));
    }
  } catch (e) {}
}

// Best-effort async patch-in of the platform save over whatever
// localStorage/memory already loaded synchronously. Known trade-off: the
// very first frame can briefly show local data before this resolves and
// patches the platform's copy in — acceptable since local storage already
// mirrors the same values (see sdkSaveIfAvailable), so the two rarely
// disagree in practice.
async function sdkLoadAndMergeIfAvailable() {
  if (!(window.ytgame && window.ytgame.IN_PLAYABLES_ENV && window.ytgame.game && window.ytgame.game.loadData)) return;
  try {
    const raw = await window.ytgame.game.loadData();
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.bankedGold === 'number') state.bankedGold = data.bankedGold;
    if (typeof data.highScore === 'number') state.highScore = data.highScore;
    if (typeof data.fuelUpgradeLevel === 'number') state.fuelUpgradeLevel = data.fuelUpgradeLevel;
    if (typeof data.coolingUpgradeLevel === 'number') state.coolingUpgradeLevel = data.coolingUpgradeLevel;
    if (typeof data.thrusterUpgradeLevel === 'number') state.thrusterUpgradeLevel = data.thrusterUpgradeLevel;
    if (typeof data.alloyUpgradeLevel === 'number') state.alloyUpgradeLevel = data.alloyUpgradeLevel;
    if (Array.isArray(data.relicsFound)) state.relicsFound = data.relicsFound;
    if (typeof data.selectedClass === 'string' && DRILL_CLASSES[data.selectedClass]) state.selectedClass = data.selectedClass;
    if (Array.isArray(data.unlockedTrails) && data.unlockedTrails.includes('standard')) state.unlockedTrails = data.unlockedTrails;
    if (typeof data.selectedTrail === 'string' && state.unlockedTrails.includes(data.selectedTrail)) state.selectedTrail = data.selectedTrail;
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

function checkOfflineEarnings() {
  const lastPlayedRaw = storageGet('ec_lastPlayedTimestamp');
  const now = Date.now();
  storageSet('ec_lastPlayedTimestamp', String(now)); // stamp immediately so a refresh can't double-count this window

  if (!lastPlayedRaw) return; // first-ever visit — nothing to award, nothing to show
  const lastPlayed = parseInt(lastPlayedRaw, 10);
  if (!Number.isFinite(lastPlayed) || lastPlayed <= 0) return;

  const elapsedMs = clamp(now - lastPlayed, 0, OFFLINE_CAP_MS);
  const earnedGold = Math.floor((elapsedMs / (60 * 60 * 1000)) * OFFLINE_GOLD_PER_HOUR);
  if (earnedGold <= 0) return;

  syncBankedGold(earnedGold);
  bankedGoldEl.textContent = state.bankedGold;
  welcomeBackGoldEl.textContent = earnedGold;
  welcomeBackScreen.classList.remove('hidden');
}

document.getElementById('welcome-back-btn').addEventListener('click', () => {
  welcomeBackScreen.classList.add('hidden');
});

// Keeps the "last played" timestamp fresh while the tab is open/backgrounded,
// so the next visit's offline window is measured from the real last moment
// played, not just from page load. Deliberately not the raw browser page
// visibility API — the Playables spec forbids reading that directly, since
// the platform's own pause/resume hook (see handleSdkPause below) is the
// sanctioned signal for "player left".
setInterval(() => storageSet('ec_lastPlayedTimestamp', String(Date.now())), OFFLINE_HEARTBEAT_MS);
window.addEventListener('beforeunload', () => storageSet('ec_lastPlayedTimestamp', String(Date.now())));

// Initial idle render (so canvas isn't blank behind the start screen)
startHighscoreEl.textContent = 'High Score: ' + state.highScore;
ensureRowsGenerated(20);
render();

checkOfflineEarnings();

initPlayablesSDK();
notifyFirstFrameReady(); // first frame (the start screen) is on screen as of the render() above
notifyGameReady();       // fully interactive immediately after — no separate loading phase in this game
sdkLoadAndMergeIfAvailable();
