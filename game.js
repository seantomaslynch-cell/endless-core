// ============================================================
// Endless Core - core game logic
// ============================================================

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
const COLS = clamp(Math.round((initialAspect * LOGICAL_H) / BLOCK), MIN_COLS, MAX_COLS);
const LOGICAL_W = COLS * BLOCK;

canvas.width = LOGICAL_W;
canvas.height = LOGICAL_H;

// The internal logical resolution (LOGICAL_W/H) is fixed once COLS is chosen
// above — only the CSS display size is rescaled to fit, letterboxed to
// preserve that aspect ratio (which now already matches the device closely,
// so visible bars are minimal-to-none in practice). Entity positions live
// entirely in that fixed logical space, so they can never end up off-screen
// on rotation/resize; there's no per-entity rescale or clamp step to do.
// Wrapped in try/catch regardless (belt-and-suspenders safety for a handler
// that can fire before other module state settles).
function resizeCanvas() {
  try {
    const aspect = LOGICAL_W / LOGICAL_H;
    let w = window.innerWidth;
    let h = window.innerHeight;
    if (w / h > aspect) {
      h = h;
      w = h * aspect;
    } else {
      w = w;
      h = w / aspect;
    }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
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
const TOMBSTONE = 7; // Fallen Miners — decorative, no collision damage, triggers a toast by depth

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
const TOMBSTONE_CHANCE = 0.008; // Fallen Miners — Dirt/Ice only, purely cosmetic/social

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
  tombstoneRows: [], // ascending queue of row indices holding a Tombstone, consumed by updateTombstones()
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

  // Chest / Relic / Gas / Tombstone spawns — only ever replace plain DIRT so
  // they never swallow a Stone or Gold cell (or each other). Gas is a hazard
  // and stays out of the safe zone; Chest/Relic/Tombstone are all benign, so
  // they're allowed anywhere their own gates permit.
  const rowBiomeForSpawns = getBiome(rowIndex);
  let tombstoneAddedThisRow = false;
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
    } else if (rowBiomeForSpawns.name !== 'Magma' && Math.random() < TOMBSTONE_CHANCE) {
      row[x] = TOMBSTONE;
      tombstoneAddedThisRow = true;
    }
  }
  if (tombstoneAddedThisRow) world.tombstoneRows.push(rowIndex);

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
function buyOrSelectTrail(id) {
  const trail = TRAIL_DEFS.find((t) => t.id === id);
  if (!trail) return;

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
const welcomeBackScreen = document.getElementById('welcome-back-screen');
const toastEl = document.getElementById('toast');
const pauseOverlay = document.getElementById('pause-overlay');

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

document.getElementById('upgrades-btn').addEventListener('click', openUpgradesScreen);
document.getElementById('start-upgrades-btn').addEventListener('click', openUpgradesScreen);

document.getElementById('close-upgrades-btn').addEventListener('click', () => {
  upgradesScreen.classList.add('hidden');
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
  upgradesScreen.classList.remove('hidden');
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

// ---------- The Artifact Museum overlay ----------
const museumCountEl = document.getElementById('museum-count');
const relicGridEl = document.getElementById('relic-grid');

document.getElementById('museum-btn').addEventListener('click', openMuseumScreen);
document.getElementById('start-museum-btn').addEventListener('click', openMuseumScreen);
document.getElementById('close-museum-btn').addEventListener('click', () => {
  museumScreen.classList.add('hidden');
});

function openMuseumScreen() {
  renderMuseum();
  museumScreen.classList.remove('hidden');
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
  contractsScreen.classList.add('hidden');
});

function openContractsScreen() {
  renderContracts();
  contractsScreen.classList.remove('hidden');
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
  loadoutScreen.classList.add('hidden');
});

function openLoadoutScreen() {
  renderLoadoutScreen();
  loadoutScreen.classList.remove('hidden');
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
  trailsScreen.classList.add('hidden');
});

function openTrailsScreen() {
  renderTrailsScreen();
  trailsScreen.classList.remove('hidden');
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
      actionHtml = `<button class="trail-select-btn" data-trail-id="${trail.id}">Select</button>`;
    } else {
      actionHtml = `<button class="trail-select-btn" data-trail-id="${trail.id}">Unlock — ${trail.cost} Gold</button>`;
    }

    return `
      <div class="trail-card ${isSelected ? 'active' : ''}">
        <div class="trail-swatch" style="background:${swatchColor};"></div>
        <div class="trail-name">${trail.name}</div>
        ${actionHtml}
      </div>
    `;
  }).join('');

  // re-wire select/unlock buttons since innerHTML was just replaced
  trailListEl.querySelectorAll('.trail-select-btn[data-trail-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      buyOrSelectTrail(btn.dataset.trailId);
      renderTrailsScreen();
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
  world.tombstoneRows = [];

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
  newHighscoreBadge.classList.add('hidden');
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

  syncBankedGold(state.gold);
  if (state.pendingContractGold > 0) {
    syncBankedGold(state.pendingContractGold);
  }

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
    } else if (block === TOMBSTONE) {
      // purely decorative — no damage, no reward; the row-crossing toast
      // (updateTombstones) is the real interaction, this is just tidy-up
      setBlock(row, col, EMPTY);
      spawnParticles(cellCenterX, cellCenterY, '#9e9e9e', 4);
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

function updateTombstones() {
  const depthNow = currentDepthMeters();
  while (world.tombstoneRows.length > 0 && world.tombstoneRows[0] <= depthNow) {
    world.tombstoneRows.shift();
    const guestId = Math.floor(Math.random() * 9999);
    queueToast('Guest' + guestId + ' died here!');
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
  updateTombstones();
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
    queueToast('Contract Complete! ' + template.label(goal.target) + ' (+' + goal.bonusGold + ' Gold)');
  }
}

// ---------- Render ----------
// DIRT/STONE take their color from the row's biome; GOLD stays fixed so it
// always reads as a pickup regardless of zone. CHEST/RELIC are drawn with
// their own dedicated routines below instead of a flat fill.
function blockColor(type, biome) {
  switch (type) {
    case DIRT: return biome.dirtColor;
    case STONE: return biome.stoneColor;
    case GOLD: return '#ffd700';
    default: return null;
  }
}

function drawChestBlock(screenX, screenY) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(screenX, screenY, BLOCK, BLOCK);
  ctx.clip();
  ctx.fillStyle = '#6a1b9a';
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);
  ctx.strokeStyle = '#ffd700';
  ctx.lineWidth = 6;
  for (let i = -BLOCK; i < BLOCK * 2; i += 14) {
    ctx.beginPath();
    ctx.moveTo(screenX + i, screenY);
    ctx.lineTo(screenX + i + BLOCK, screenY + BLOCK);
    ctx.stroke();
  }
  ctx.restore();
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

// Fallen Miners — a small gray cross/marker. Purely decorative; the real
// interaction (the toast) fires by depth in updateTombstones(), not contact.
function drawTombstoneBlock(screenX, screenY) {
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(screenX, screenY, BLOCK, BLOCK);

  const cx = screenX + BLOCK / 2;
  const cy = screenY + BLOCK / 2;
  ctx.strokeStyle = '#c9c9c9';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy - BLOCK * 0.28);
  ctx.lineTo(cx, cy + BLOCK * 0.28);
  ctx.moveTo(cx - BLOCK * 0.2, cy - BLOCK * 0.08);
  ctx.lineTo(cx + BLOCK * 0.2, cy - BLOCK * 0.08);
  ctx.stroke();

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

  // sky/background — tinted to the drill's current biome, visible in tunnels
  const currentBiome = getBiome(currentDepthMeters());
  ctx.fillStyle = currentBiome.bgColor;
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
      if (type === TOMBSTONE) {
        drawTombstoneBlock(screenX, screenY);
        continue;
      }

      const color = blockColor(type, rowBiome);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(screenX, screenY, BLOCK, BLOCK);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(screenX + 0.5, screenY + 0.5, BLOCK - 1, BLOCK - 1);

      if (type === GOLD) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.arc(screenX + BLOCK / 2, screenY + BLOCK / 2, 6, 0, Math.PI * 2);
        ctx.fill();
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

  if (!flashing && appearance.glow) {
    ctx.shadowColor = appearance.glow;
    ctx.shadowBlur = appearance.glowBlur;
  }

  ctx.fillStyle = flashing ? '#ff5252' : appearance.body;
  ctx.fillRect(drillScreenX, drillScreenY, drill.width, drill.height);
  // drill nose (triangle pointing down)
  ctx.fillStyle = flashing ? '#ff8a80' : appearance.nose;
  ctx.beginPath();
  ctx.moveTo(drillScreenX, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width, drillScreenY + drill.height);
  ctx.lineTo(drillScreenX + drill.width / 2, drillScreenY + drill.height + 14);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0; // keep the glow off the crisp outline
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

// ---------- YouTube Playables SDK bootstrap ----------
// Every hook here is wrapped so an SDK failure/absence can never break the
// game — this file also has to run standalone (no ytgame) for local dev and
// the browser-based verification workflow.
function initPlayablesSDK() {
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
