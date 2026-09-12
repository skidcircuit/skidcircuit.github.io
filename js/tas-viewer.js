import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { DeterministicPlaybackController, parseInputLines, normalizeStepInput, serializeSteps, keysToAxes } from './tas-core.js';

const FIXED_DT = 1 / 120;
const MAX_STEPS = 120 * 120;
const ENGINE_MULTS = [ 1, 1.025, 1.05, 1.075, 1.1 ];
const MODELS = [
  'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
  'vehicle-hatchback-green', 'vehicle-sedan-orange',
  'vehicle-car-police', 'vehicle-delivery-yellow', 'vehicle-flatbed-purple', 'vehicle-van-blue',
  'vehicle-ambulance-red', 'vehicle-firetruck-red', 'vehicle-taxi-yellow', 'vehicle-tractor-yellow', 'vehicle-trash-green',
  'track-straight', 'track-corner', 'track-bump', 'track-finish',
  'decoration-empty', 'decoration-forest', 'decoration-tents', 'empty-deco-grass',
  'building-small-a', 'building-small-b', 'building-small-c', 'building-small-d', 'building-garage'
];
const REQUIRED_VEHICLE_KEYS = [ 'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red', 'vehicle-hatchback-green', 'vehicle-sedan-orange', 'vehicle-car-police', 'vehicle-delivery-yellow', 'vehicle-flatbed-purple', 'vehicle-van-blue', 'vehicle-ambulance-red', 'vehicle-firetruck-red', 'vehicle-taxi-yellow', 'vehicle-tractor-yellow', 'vehicle-trash-green' ];
const CAR_STATS = {
  'vehicle-truck-yellow': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-truck-green': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-truck-purple': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-truck-red': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-hatchback-green': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-sedan-orange': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-car-police': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-delivery-yellow': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-flatbed-purple': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-van-blue': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-ambulance-red': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-firetruck-red': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-taxi-yellow': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-tractor-yellow': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-trash-green': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(200, 200);
const view = document.getElementById('view');
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xadb2ba);
scene.fog = new THREE.Fog(0xadb2ba, 30, 55);

const dirLight = new THREE.DirectionalLight(0xffffff, 5);
dirLight.position.set(11.4, 15, -5.3);
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0xc8d8e8, 0x7a8a5a, 1.5));

const lapHud = document.getElementById('lap');
const statusEl = document.getElementById('status');
const runErrorsEl = document.getElementById('run-errors');
const inputsEl = document.getElementById('inputs');
const carSelect = document.getElementById('car-select');
const trackUrlInput = document.getElementById('track-url');
const engineTierInput = document.getElementById('engine-tier');
const garageGripInput = document.getElementById('garage-grip');
const garageAccelInput = document.getElementById('garage-accel');
const garageDriveInput = document.getElementById('garage-drive');
const rng = seededRng(0x1234abcd);

let models = {};
let world;
let vehicle;
let cameraRig;
let trackGroup = null;
let currentCells = null;
let steps = [];
const playbackController = new DeterministicPlaybackController();
let simulationTime = 0;
let raceClockSeconds = 0;
let lapNumber = 1;
let lapStartSeconds = 0;
let lapSeconds = 0;
let lastLapSeconds = null;
let bestLapSeconds = null;
let hasPrevFinishSample = false;
let lastLocalX = 0;
let lastLocalZ = 0;
let hasLeftStartZone = false;
let checkpointStates = [];
let finishData = null;
let lapHistory = [];
let lastFrameNow = performance.now() / 1000;
let playbackAccumulator = 0;
let currentExtras = null;
let runtimeReady = false;
let physicsEnabled = true;
let runErrorLines = [];
let runProbe = { throttleFrames: 0, distance: 0, lastPos: new THREE.Vector3(), switchedToKinematic: false };
let allowAutoFallback = true;

function seededRng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000); }
function encodeCode(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

function buildWorld() {
  const settings = createWorldSettings();
  const BPL_MOVING = addBroadphaseLayer(settings);
  const BPL_STATIC = addBroadphaseLayer(settings);
  const OL_MOVING = addObjectLayer(settings, BPL_MOVING);
  const OL_STATIC = addObjectLayer(settings, BPL_STATIC);
  enableCollision(settings, OL_MOVING, OL_STATIC);
  enableCollision(settings, OL_MOVING, OL_MOVING);
  const nextWorld = createWorld(settings);
  nextWorld._OL_MOVING = OL_MOVING;
  nextWorld._OL_STATIC = OL_STATIC;
  return nextWorld;
}

function formatLapTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--.---';
  const mins = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ms = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function makeGateData(cell) {
  if (!cell) return null;
  const [gx, gz, , orient] = cell;
  const centerX = (gx + 0.5) * CELL_RAW * GRID_SCALE;
  const centerZ = (gz + 0.5) * CELL_RAW * GRID_SCALE;
  const halfExtent = (CELL_RAW * GRID_SCALE) * 0.5;
  const angle = THREE.MathUtils.degToRad(ORIENT_DEG[orient] || 0);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return { centerX, centerZ, halfExtent, cosA, sinA };
}

function parseExtrasFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const target = new URL(rawUrl, window.location.href);
    const modsParam = target.searchParams.get('mods');
    if (!modsParam) return null;
    const json = decodeURIComponent(escape(atob(modsParam.replace(/-/g, '+').replace(/_/g, '/'))));
    const parsed = JSON.parse(json);
    return {
      bumps: Array.isArray(parsed.b) ? parsed.b : [],
      boosts: Array.isArray(parsed.s) ? parsed.s : [],
      jumps: Array.isArray(parsed.j) ? parsed.j : [],
      decorations: Array.isArray(parsed.d) ? parsed.d : [],
      surfaces: Array.isArray(parsed.u) ? parsed.u : [],
      customSurfaces: parsed?.c && typeof parsed.c === 'object' ? parsed.c : {},
      customPads: parsed?.y && typeof parsed.y === 'object' ? parsed.y : {},
    };
  } catch {
    return 'parse-error';
  }
}

function normalizeTrackExtras(extras) {
  return {
    bumps: Array.isArray(extras?.bumps) ? extras.bumps : [],
    boosts: Array.isArray(extras?.boosts) ? extras.boosts : [],
    jumps: Array.isArray(extras?.jumps) ? extras.jumps : [],
    decorations: Array.isArray(extras?.decorations) ? extras.decorations : [],
    surfaces: Array.isArray(extras?.surfaces) ? extras.surfaces : [],
    customSurfaces: extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {},
    customPads: extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {},
  };
}

function updateCarConfig() {
  if (!vehicle) return;
  const carKey = carSelect.value;
  const tier = Math.max(0, Math.min(ENGINE_MULTS.length - 1, Number(engineTierInput.value || 0)));
  const mult = ENGINE_MULTS[tier];
  if (models[carKey]) vehicle.setModel(models[carKey]);
  const stats = CAR_STATS[carKey] || CAR_STATS['vehicle-truck-yellow'];
  vehicle.setPerformance({
    topSpeed: stats.topSpeed * mult,
    accelRate: stats.accelRate * mult,
    driveForce: stats.driveForce * mult,
  });
  vehicle.gripMultiplier = Number(garageGripInput.value || 1);
  vehicle.accelMultiplier = Number(garageAccelInput.value || 1);
  vehicle.driveMultiplier = Number(garageDriveInput.value || 1);
}

function resetRun(clearErrors = true) {
  playbackController.resetFrame();
  simulationTime = 0;
  raceClockSeconds = 0;
  lapNumber = 1;
  lapStartSeconds = 0;
  lapSeconds = 0;
  lastLapSeconds = null;
  bestLapSeconds = null;
  hasPrevFinishSample = false;
  lastLocalX = 0;
  lastLocalZ = 0;
  hasLeftStartZone = false;
  lapHistory = [];
  for (const checkpoint of checkpointStates) {
    checkpoint.lastLocalX = 0;
    checkpoint.lastLocalZ = 0;
    checkpoint.hasPrevSample = false;
    checkpoint.passedThisLap = false;
  }
  vehicle?.resetToSpawn();
  if (vehicle?.spherePos) runProbe.lastPos.copy(vehicle.spherePos);
  runProbe.throttleFrames = 0;
  runProbe.distance = 0;
  runProbe.switchedToKinematic = false;
  if (clearErrors) setRunErrors([]);
  lapHud.textContent = `Lap ${lapNumber} • ${formatLapTime(0)} • Last --:--.--- • Best --:--.---`;
}

function switchToKinematicFallback(reason) {
  if (!physicsEnabled || runProbe.switchedToKinematic) return;
  runProbe.switchedToKinematic = true;
  physicsEnabled = false;
  if (vehicle) {
    vehicle.rigidBody = null;
    vehicle.physicsWorld = null;
    runProbe.lastPos.copy(vehicle.spherePos);
  }
  pushRunError(`Physics fallback activated: ${reason}`);
  statusEl.textContent = 'Physics backend stalled; switched to kinematic playback fallback.';
}

function stepSimulation(input) {
  const axes = keysToAxes( input?.keys );
  raceClockSeconds += FIXED_DT;
  lapSeconds = Math.max(0, raceClockSeconds - lapStartSeconds);
  if (physicsEnabled && world) updateWorld(world, null, FIXED_DT);
  vehicle.update(FIXED_DT, axes);
  if ( ! physicsEnabled ) {
    const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
    vehicle.spherePos.addScaledVector( forward, vehicle.linearSpeed * 8.5 * FIXED_DT );
    vehicle.spherePos.y = 0.5;
    vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
  }
  cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);
  simulationTime += FIXED_DT;
  runProbe.distance += vehicle.spherePos.distanceTo(runProbe.lastPos);
  runProbe.lastPos.copy(vehicle.spherePos);
  if (input?.keys?.up || input?.keys?.down) runProbe.throttleFrames += 1;
  if (allowAutoFallback && physicsEnabled && !runProbe.switchedToKinematic && runProbe.throttleFrames > 80 && runProbe.distance < 0.12) {
    switchToKinematicFallback('car remained stationary with throttle input');
  }
  if (finishData) {
    for (const checkpoint of checkpointStates) {
      const localX = (((vehicle.spherePos.x - checkpoint.centerX) * checkpoint.cosA) + ((vehicle.spherePos.z - checkpoint.centerZ) * checkpoint.sinA));
      const localZ = ((-(vehicle.spherePos.x - checkpoint.centerX) * checkpoint.sinA) + ((vehicle.spherePos.z - checkpoint.centerZ) * checkpoint.cosA));
      let crossedCheckpoint = false;
      if (checkpoint.hasPrevSample) {
        const z0 = checkpoint.lastLocalZ;
        const z1 = localZ;
        const crossedPlane = (z0 < 0 && z1 > 0) || (z0 > 0 && z1 < 0);
        if (crossedPlane) {
          const t = z0 / (z0 - z1);
          const xCross = THREE.MathUtils.lerp(checkpoint.lastLocalX, localX, t);
          crossedCheckpoint = t >= 0 && t <= 1 && Math.abs(xCross) <= checkpoint.halfExtent;
        }
      }
      if (crossedCheckpoint) checkpoint.passedThisLap = true;
      checkpoint.lastLocalX = localX;
      checkpoint.lastLocalZ = localZ;
      checkpoint.hasPrevSample = true;
    }

    const localX = (((vehicle.spherePos.x - finishData.centerX) * finishData.cosA) + ((vehicle.spherePos.z - finishData.centerZ) * finishData.sinA));
    const localZ = ((-(vehicle.spherePos.x - finishData.centerX) * finishData.sinA) + ((vehicle.spherePos.z - finishData.centerZ) * finishData.cosA));
    const inFinishCell = Math.abs(localX) < finishData.halfExtent && Math.abs(localZ) < finishData.halfExtent;
    if (!hasLeftStartZone && !inFinishCell) hasLeftStartZone = true;

    let crossedFinish = false;
    if (hasPrevFinishSample) {
      const z0 = lastLocalZ;
      const z1 = localZ;
      const crossedPlane = (z0 < 0 && z1 > 0) || (z0 > 0 && z1 < 0);
      if (crossedPlane) {
        const t = z0 / (z0 - z1);
        const xCross = THREE.MathUtils.lerp(lastLocalX, localX, t);
        crossedFinish = t >= 0 && t <= 1 && Math.abs(xCross) <= finishData.halfExtent;
      }
    }

    const allCheckpointsPassed = checkpointStates.every((checkpoint) => checkpoint.passedThisLap);
    if (hasLeftStartZone && allCheckpointsPassed && crossedFinish) {
      const completedLap = raceClockSeconds - lapStartSeconds;
      lastLapSeconds = completedLap;
      bestLapSeconds = bestLapSeconds === null ? completedLap : Math.min(bestLapSeconds, completedLap);
      lapHistory.push(completedLap);
      lapNumber += 1;
      lapStartSeconds = raceClockSeconds;
      hasLeftStartZone = false;
      for (const checkpoint of checkpointStates) checkpoint.passedThisLap = false;
    }

    lastLocalX = localX;
    lastLocalZ = localZ;
    hasPrevFinishSample = true;
  }

  lapHud.textContent = `Lap ${lapNumber} • ${formatLapTime(lapSeconds)} • Last ${formatLapTime(lastLapSeconds)} • Best ${formatLapTime(bestLapSeconds)}`;
}

function evaluate(inputSteps) {
  const prevAllowFallback = allowAutoFallback;
  allowAutoFallback = false;
  resetRun(false);
  for (let i = 0; i < Math.min(MAX_STEPS, inputSteps.length); i++) {
    stepSimulation(inputSteps[i]);
    if (lapHistory.length > 0) {
      allowAutoFallback = prevAllowFallback;
      return lapHistory[0];
    }
  }
  allowAutoFallback = prevAllowFallback;
  return 999999;
}

function parseTrackCellsFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const target = new URL(rawUrl, window.location.href);
    const mapParam = target.searchParams.get('map');
    return mapParam ? decodeCells(mapParam) : null;
  } catch {
    return null;
  }
}

function rebuildTrack() {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup = null;
  }
  try {
    world = buildWorld();
    physicsEnabled = true;
  } catch (error) {
    physicsEnabled = false;
    world = null;
    console.warn('TAS physics init failed; using kinematic fallback.', error);
  }
  const trackUrl = trackUrlInput.value.trim();
  const nextCells = parseTrackCellsFromUrl(trackUrl);
  const parsedExtras = parseExtrasFromUrl(trackUrl);
  const extrasParseFailed = parsedExtras === 'parse-error';
  const nextExtras = normalizeTrackExtras(extrasParseFailed ? null : parsedExtras);
  currentCells = nextCells;
  currentExtras = nextExtras;
  trackGroup = buildTrack(scene, models, nextCells, nextExtras);
  if ( physicsEnabled && world ) buildWallColliders(world, null, nextCells, nextExtras);
  if (extrasParseFailed) {
    pushRunError('Extras parse failed; TAS used default collider data.');
    statusEl.textContent = 'Warning: extras parse failed; TAS used default collider data.';
  }

  const spawn = computeSpawnPosition(currentCells);
  const hasValidSpawnPosition = Array.isArray(spawn?.position) && spawn.position.length === 3
    && spawn.position.every((v) => Number.isFinite(v));
  const spawnData = hasValidSpawnPosition
    ? { position: spawn.position, angle: Number.isFinite(spawn?.angle) ? spawn.angle : 0 }
    : null;
  const bounds = computeTrackBounds(currentCells);
  const groundSize = Math.max(bounds.halfWidth, bounds.halfDepth) * 2 + 20;
  if ( physicsEnabled && world ) {
    rigidBody.create(world, {
      shape: box.create({ halfExtents: [groundSize / 2, 0.5, groundSize / 2] }),
      motionType: MotionType.STATIC,
      objectLayer: world._OL_STATIC,
      position: [bounds.centerX, -0.5, bounds.centerZ]
    });
  }

  if (vehicle?.container) scene.remove(vehicle.container);
  vehicle = new Vehicle();
  if ( physicsEnabled && world ) {
    vehicle.physicsWorld = world;
    vehicle.rigidBody = createSphereBody(world, spawnData?.position || null);
  }
  vehicle.setSpawn(spawnData?.position || [3.5, 0.5, 5], spawnData?.angle || 0);
  const [sx, sy, sz] = spawnData?.position || [3.5, 0.5, 5];
  vehicle.spherePos.set(sx, sy, sz);
  vehicle.container.position.set(sx, sy - 0.5, sz);
  vehicle.container.rotation.y = spawnData?.angle || 0;
  vehicle.prevModelPos.copy(vehicle.container.position);
  scene.add(vehicle.init(models[carSelect.value] || models['vehicle-truck-yellow']));
  updateCarConfig();
  const activeCells = currentCells || TRACK_CELLS;
  // No finish piece: prefer the start cell over an arbitrary first cell.
  const finishCell = activeCells.find((c) => c[2] === 'track-finish') || activeCells.find((c) => c[2] === 'track-start-finish') || activeCells.find((c) => c[2] === 'track-start') || activeCells[0];
  const elevatedCheckpointCells = Array.isArray(currentExtras?.elevated)
    ? currentExtras.elevated
      .filter((c) => Array.isArray(c) && c[2] === 'elevated-checkpoint')
      .map(([gx, gz, , orient = 0]) => [gx, gz, 'track-checkpoint', orient])
    : [];
  const checkpointCells = [...activeCells.filter((c) => c[2] === 'track-checkpoint'), ...elevatedCheckpointCells];
  finishData = makeGateData(finishCell);
  checkpointStates = checkpointCells.map((cell) => ({
    ...makeGateData(cell),
    lastLocalX: 0,
    lastLocalZ: 0,
    hasPrevSample: false,
    passedThisLap: false,
  }));
  resetRun();
}

function animate() {
  requestAnimationFrame(animate);
  if ( ! runtimeReady ) {
    if (cameraRig?.camera) renderer.render(scene, cameraRig.camera);
    return;
  }
  const now = performance.now() / 1000;
  const dt = Math.min(0.25, Math.max(0, now - lastFrameNow));
  lastFrameNow = now;
  playbackAccumulator += dt;

  while (playbackAccumulator >= FIXED_DT && vehicle) {
    const inputStep = playbackController.nextStep();
    stepSimulation(inputStep || { keys: { up: false, down: false, left: false, right: false } });
    playbackAccumulator -= FIXED_DT;
  }
  renderer.render(scene, cameraRig.camera);
}

async function initScene() {
  statusEl.textContent = 'Loading TAS scene...';
  registerAll();
  cameraRig = new Camera();
  cameraRig.mode = 'overview';

  const loader = new GLTFLoader();
  const loadOneModel = (name) => new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timeout = window.setTimeout(() => {
      console.warn(`Timed out loading model: ${name}`);
      done({ name, ok: false, reason: 'timeout' });
    }, 12000);
    loader.load(`models/${name}.glb`, (gltf) => {
      window.clearTimeout(timeout);
      if (name.startsWith('vehicle-')) gltf.scene.scale.setScalar(0.5);
      if (name.startsWith('building-')) gltf.scene.scale.setScalar(10);
      models[name] = gltf.scene;
      done({ name, ok: true });
    }, undefined, (error) => {
      window.clearTimeout(timeout);
      console.warn(`Failed loading model: ${name}`, error);
      done({ name, ok: false, reason: 'error' });
    });
  });
  const loadResults = await Promise.all(MODELS.map((name) => loadOneModel(name)));
  const loadedVehicles = REQUIRED_VEHICLE_KEYS.filter((key) => Boolean(models[key]));
  if (loadedVehicles.length === 0) {
    const failed = loadResults.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ');
    throw new Error(`Could not load any vehicle models. Failed: ${failed || 'unknown'}`);
  }
  const activeVehicle = models[carSelect.value] ? carSelect.value : loadedVehicles[0];
  if (carSelect.value !== activeVehicle) carSelect.value = activeVehicle;

  rebuildTrack();
  steps = parseInputLines(inputsEl.value);
  playbackController.loadSteps(steps);
  playbackController.start();
  runtimeReady = true;
  const failedCount = loadResults.filter((entry) => !entry.ok).length;
  statusEl.textContent = failedCount > 0
    ? `Loaded TAS with ${failedCount} missing model(s). Running ${steps.length} input frames.`
    : `Loaded ${steps.length} deterministic input frames.`;
  resize();
}

function resize() {
  const sidebar = document.getElementById('side');
  const width = Math.max(240, window.innerWidth - sidebar.offsetWidth);
  const height = window.innerHeight;
  renderer.setSize(width, height);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  if (cameraRig?.camera) {
    cameraRig.camera.aspect = width / height;
    cameraRig.camera.updateProjectionMatrix();
  }
}

document.getElementById('new-btn')?.addEventListener('click', () => {
  steps = [];
  playbackController.loadSteps([]);
  playbackController.stop();
  inputsEl.value = '';
  resetRun();
  statusEl.textContent = 'Created new TAS.';
});

document.getElementById('run-btn')?.addEventListener('click', () => {
  try {
    steps = parseInputLines(inputsEl.value);
    playbackController.loadSteps(steps);
    playbackController.start();
    resetRun();
    lastFrameNow = performance.now() / 1000;
    playbackAccumulator = 0;
    statusEl.textContent = steps.length > 0
      ? `Running ${steps.length} deterministic input frames.`
      : 'No TAS steps parsed. Use "ArrowUp+ArrowLeft,30" or JSON step arrays.';
  } catch (error) {
    pushRunError(`Run parse failed: ${error?.message || String(error)}`);
    statusEl.textContent = 'Could not run TAS due to parsing error.';
  }
});

document.getElementById('load-track-btn')?.addEventListener('click', () => {
  rebuildTrack();
  statusEl.textContent = 'Loaded track data from URL (or default track).';
});

for (const el of [carSelect, engineTierInput, garageGripInput, garageAccelInput, garageDriveInput]) {
  el?.addEventListener('input', () => {
    updateCarConfig();
    statusEl.textContent = 'TAS car/performance config updated.';
  });
}

document.getElementById('export-btn')?.addEventListener('click', async () => {
  const code = encodeCode({
    steps: parseInputLines(inputsEl.value),
    trackUrl: trackUrlInput.value.trim(),
    car: carSelect.value,
    engineTier: Number(engineTierInput.value || 0),
    garageGrip: Number(garageGripInput.value || 1),
    garageAccel: Number(garageAccelInput.value || 1),
    garageDrive: Number(garageDriveInput.value || 1),
  });
  try {
    await navigator.clipboard.writeText(code);
    statusEl.textContent = 'Ghost code copied to clipboard.';
  } catch {
    statusEl.textContent = 'Could not copy; code is still valid.';
  }
});

document.getElementById('bf-btn')?.addEventListener('click', () => {
  let working = parseInputLines(inputsEl.value);
  const count = Math.max(1, Math.floor(Number(document.getElementById('bf-count').value || 1)));
  const reps = Math.max(1, Math.floor(Number(document.getElementById('bf-reps').value || 1)));
  let best = evaluate(working);
  for (let i = 0; i < reps; i++) {
    const maxIndex = Math.max(0, Math.min(working.length - 1, count - 1));
    if (maxIndex <= 0) break;
    const idx = Math.floor(rng() * (maxIndex + 1));
    const old = working[idx] || { keys: { up: false, down: false, left: false, right: false } };
    working[idx] = {
      keys: {
        up: rng() > 0.5,
        down: rng() > 0.85,
        left: rng() > 0.5,
        right: rng() > 0.5,
      }
    };
    const next = evaluate(working);
    if (next < best) best = next;
    else working[idx] = old;
  }
  steps = working;
  playbackController.loadSteps(working);
  playbackController.start();
  inputsEl.value = serializeSteps(working);
  resetRun();
  statusEl.textContent = `Brute force done. Best time: ${best.toFixed(3)}s`;
});

window.addEventListener('resize', resize);
resize();
animate();

initScene().catch((error) => {
  statusEl.textContent = error.message;
  console.error(error);
});
