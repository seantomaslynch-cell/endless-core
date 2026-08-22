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
  if (!storageAvailable) { memoryStorage[key] = value; return; }
  try {
    localStorage.setItem(key, value);
  } catch {
    storageAvailable = false;
    memoryStorage[key] = value;
  }
}

// ---------- Canvas setup ----------
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const COLS = 9;
const BLOCK = 40; // logical pixels per block (1 block = 1 "meter")
const LOGICAL_W = COLS * BLOCK; // 360
const LOGICAL_H = 640;

canvas.width = LOGICAL_W;
canvas.height = LOGICAL_H;

function resizeCanvas() {
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
}
window.addEventListener('resize', resizeCanvas);
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
  const depthPixels = rowIndex * BLOCK;
  const threshold = stoneThreshold(depthPixels);
  const goldChanceHere = goldChance(depthPixels);
  const row = new Array(COLS);

  for (let x = 0; x < COLS; x++) {
    const n = NoiseGen.noise2D(x * NOISE_SCALE_X, rowIndex * NOISE_SCALE_Y);
    if (n > threshold) {
      row[x] = STONE;
    } else {
      row[x] = Math.random() < goldChanceHere ? GOLD : DIRT;
    }
  }

  // Guaranteed safe path: random walk relative to previous row's safe x
  const step = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
  const safeX = clamp(world.lastSafeX + step, 0, COLS - 1);
  row[safeX] = Math.random() < safeGoldChance(depthPixels) ? GOLD : DIRT;
  world.lastSafeX = safeX;

  // Chest / Relic / Gas spawns — only ever replace plain DIRT so they never
  // swallow a Stone or Gold cell (or each other).
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
    } else if (rowBiomeForSpawns.name !== 'Magma' && Math.random() < GAS_CHANCE) {
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
  relicsFound: loadRelicsFound(), // array of collected RELIC_DEFS ids, persisted
  dailyContracts: loadOrGenerateDailyContracts(), // { generatedAt, goals: [...] }, persisted
  selectedClass: loadSelectedClass(), // 'ROOKIE' | 'JACKHAMMER' | 'PLASMA', persisted
  maxDepthReached: 0,
  startTime: 0,
  comboMultiplier: 1.0,
  magnetTimer: 0, // seconds remaining on the Chest's gold-magnet buff
  dirtBroken: 0, // this run's count, feeds the "Break N Dirt blocks" contract
  pendingContractGold: 0, // bonus gold from contracts completed this run, banked at endGame()
};

// Score rewards depth traveled and gold collected; gold is weighted heavier
// since it requires deliberately steering off the fastest path.
function computeScore(depthMeters, gold) {
  return depthMeters + gold * 10;
}

function currentScore() {
  return computeScore(state.maxDepthReached, state.gold);
}

// ---------- Upgrades ----------
const BASE_MAX_HEALTH = 100;
const FUEL_UPGRADE_HEALTH_PER_LEVEL = 20;
const FUEL_UPGRADE_COSTS = [20, 40, 70, 110, 160]; // cost of each level, index = level - 1
const FUEL_UPGRADE_MAX_LEVEL = FUEL_UPGRADE_COSTS.length;

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
    }
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
  pointerActive = true;
  setInputFromClientX(e.clientX, true);
  vibrateHaptic(10);
});
window.addEventListener('pointermove', (e) => {
  if (pointerActive) setInputFromClientX(e.clientX, true);
});
window.addEventListener('pointerup', () => {
  pointerActive = false;
  setInputFromClientX(0, false);
});
window.addEventListener('pointercancel', () => {
  pointerActive = false;
  setInputFromClientX(0, false);
});

// Keyboard support (desktop convenience)
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') input.right = true;
});
window.addEventListener('keyup', (e) => {
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

const startScreen = document.getElementById('start-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const upgradesScreen = document.getElementById('upgrades-screen');
const chestScreen = document.getElementById('chest-screen');
const museumScreen = document.getElementById('museum-screen');
const contractsScreen = document.getElementById('contracts-screen');
const loadoutScreen = document.getElementById('loadout-screen');
const toastEl = document.getElementById('toast');

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
const reviveBtn = document.getElementById('revive-btn');
const doubleGoldBtn = document.getElementById('double-gold-btn');
const REVIVE_BTN_DEFAULT_TEXT = reviveBtn.textContent;
const DOUBLE_GOLD_BTN_DEFAULT_TEXT = doubleGoldBtn.textContent;

document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('restart-btn').addEventListener('click', startGame);

// ---------- Rewarded video ads ----------
// STILL A MOCK — swap the Promise body below for the real Mediacube SDK call
// once its script tag + API docs are provided (need: the CDN <script> URL,
// the function that requests a rewarded ad, and its success/fail callback
// names). Keep the same Promise<boolean> contract (resolve(true) = ad
// watched fully, resolve(false) = skipped/closed early/no fill) and keep the
// muteAudio()/unmuteAudio() calls in the same places, so the three callers
// (revive, 2x gold, chest magnet) don't need to change — they already only
// grant their reward inside `if (watched) { ... }`, after this resolves.
//
// Expected shape of the real integration:
//   function showRewardedVideo() {
//     muteAudio();
//     return new Promise((resolve) => {
//       MediacubeSDK.showRewardedAd({           // <-- replace with real call
//         onComplete: () => { unmuteAudio(); resolve(true); },
//         onFail:     () => { unmuteAudio(); resolve(false); },
//         onClose:    () => { unmuteAudio(); resolve(false); }, // closed early = no reward
//       });
//     });
//   }
function showRewardedVideo() {
  muteAudio(); // duck game audio for the duration of the ad
  return new Promise((resolve) => {
    const loadDelay = 800 + Math.random() * 1200; // fake network/ad-load latency
    setTimeout(() => {
      const watched = Math.random() < 0.75; // ~75% fill/completion rate for testing
      unmuteAudio(); // restore game audio whether the ad succeeded or failed
      resolve(watched);
    }, loadDelay);
  });
}

reviveBtn.addEventListener('click', async () => {
  if (reviveBtn.disabled) return;
  reviveBtn.disabled = true;
  reviveBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo();

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
});

doubleGoldBtn.addEventListener('click', async () => {
  if (doubleGoldBtn.disabled) return;
  doubleGoldBtn.disabled = true;
  doubleGoldBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo();

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
});

document.getElementById('upgrades-btn').addEventListener('click', openUpgradesScreen);
document.getElementById('start-upgrades-btn').addEventListener('click', openUpgradesScreen);

document.getElementById('close-upgrades-btn').addEventListener('click', () => {
  upgradesScreen.classList.add('hidden');
});

document.getElementById('fuel-upgrade-btn').addEventListener('click', () => {
  buyFuelUpgrade();
  renderUpgradesScreen();
});

function openUpgradesScreen() {
  renderUpgradesScreen();
  upgradesScreen.classList.remove('hidden');
}

function renderUpgradesScreen() {
  bankedGoldEl.textContent = state.bankedGold;

  const level = state.fuelUpgradeLevel;
  const maxHealthNow = getMaxHealth();

  if (level >= FUEL_UPGRADE_MAX_LEVEL) {
    fuelUpgradeDescEl.textContent = `Level ${level}/${FUEL_UPGRADE_MAX_LEVEL} — Max Health ${maxHealthNow}`;
    fuelUpgradeBtn.textContent = 'MAX LEVEL';
    fuelUpgradeBtn.disabled = true;
  } else {
    const cost = FUEL_UPGRADE_COSTS[level];
    const nextMaxHealth = maxHealthNow + FUEL_UPGRADE_HEALTH_PER_LEVEL;
    fuelUpgradeDescEl.textContent = `Level ${level}/${FUEL_UPGRADE_MAX_LEVEL} — Max Health ${maxHealthNow} (next: ${nextMaxHealth})`;
    fuelUpgradeBtn.textContent = 'Upgrade — ' + cost + ' Gold';
    fuelUpgradeBtn.disabled = state.bankedGold < cost;
  }
}

// ---------- Chest overlay ----------
const chestAdBtn = document.getElementById('chest-ad-btn');
const chestSkipBtn = document.getElementById('chest-skip-btn');
const CHEST_AD_BTN_DEFAULT_TEXT = chestAdBtn.textContent;

chestAdBtn.addEventListener('click', async () => {
  if (chestAdBtn.disabled) return;
  chestAdBtn.disabled = true;
  chestSkipBtn.disabled = true;
  chestAdBtn.textContent = 'Loading Ad...';

  const watched = await showRewardedVideo();

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
});

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
  newHighscoreBadge.classList.add('hidden');
  startHighscoreEl.textContent = 'High Score: ' + state.highScore;

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
  const steerSpeed = drill.steerSpeed * biome.speedMultiplier * activeClass.steerSpeedMultiplier; // Ice = sliding, Plasma = extra agile

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
      spawnParticles(cellCenterX, cellCenterY, biome.dirtColor, 5);
      triggerScreenShake(2, 0.06);
      if (Math.random() < DIG_SOUND_CHANCE) playSound('dig');
    } else if (block === GOLD) {
      setBlock(row, col, EMPTY);
      // near-miss combo multiplier scales gold payout, min 1 per block
      const goldGain = Math.max(1, Math.round(1 * state.comboMultiplier));
      state.gold += goldGain;
      spawnParticles(cellCenterX, cellCenterY, '#ffd700', 10);
      triggerScreenShake(3, 0.08);
      playSound('coin');
    } else if (block === STONE) {
      setBlock(row, col, EMPTY);
      spawnParticles(cellCenterX, cellCenterY, biome.stoneColor, 8);
      triggerScreenShake(9, 0.2); // violent shake
      state.comboMultiplier = 1.0; // getting hit wipes the near-miss streak
      if (drill.invulnTimer <= 0) {
        drill.health -= drill.stoneDamage * getActiveClass().damageMultiplier;
        drill.invulnTimer = 0.35;
        lastDamageCause = 'Stone Collision';
        playSound('hit');
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
      state.comboMultiplier = 1.0; // getting hit wipes the near-miss streak
      explodeGasPocket(row, col);
      if (drill.invulnTimer <= 0) {
        drill.health -= drill.stoneDamage * 2 * getActiveClass().damageMultiplier; // Gas Pockets hit twice as hard as Stone
        drill.invulnTimer = 0.35;
        lastDamageCause = 'Gas Explosion';
        playSound('explosion');
        vibrateHaptic(40);
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
  drill.worldY += drill.vy * biomeSpeedMultiplier * classSpeedMultiplier * dt;

  const depthMeters = Math.max(0, Math.floor(drill.worldY / BLOCK));
  if (depthMeters > state.maxDepthReached) state.maxDepthReached = depthMeters;
}

function updateHealth(dt) {
  const biome = getBiome(currentDepthMeters());
  drill.health -= drill.fuelDrainRate * biome.fuelMultiplier * dt; // Magma = 1.5x drain
  drill.health = clamp(drill.health, 0, drill.maxHealth);
  if (drill.health <= 0) {
    endGame(lastDamageCause || 'Fuel Starvation');
  }
}

function update(dt) {
  updateParticles(dt);
  updateScreenShake(dt);

  if (!state.running) return;
  updateDrillSteer(dt);
  updateDrillFall(dt);
  updateCollisions(dt);
  if (!state.running) return; // a Chest hit inside updateCollisions pauses instantly
  updateNearMissCombo();
  updateMagnet(dt);
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
  const flashing = drill.invulnTimer > 0 && Math.floor(performance.now() / 80) % 2 === 0;
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
}

// ---------- Main loop ----------
let lastFrameTime = performance.now();
let rafId = null;

function loop(now) {
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

// Initial idle render (so canvas isn't blank behind the start screen)
startHighscoreEl.textContent = 'High Score: ' + state.highScore;
ensureRowsGenerated(20);
render();
