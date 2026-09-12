import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, triangleMesh, MotionType, castRay, createAnyCastRayCollector, createDefaultCastRaySettings, CastRayStatus, filter as ccLayerFilter } from 'crashcat';
import { Vehicle } from './Vehicle.js?v=1000223';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, decodeCellsAny, decodeV3Json, computeSpawnPosition, computeTrackBounds, computePoolPresetWaterCells, prerenderWaterRefraction, updateWaterQuality, setWaterUnderwaterCameraState, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js?v=1000222';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails, WaterSplashFX } from './Particles.js';
import { SkidMarks } from './SkidMarks.js';
import { GameAudio } from './Audio.js';
import { encodeGhostBinary, decodeGhostBinary, encodeGhostCode, decodeGhostCode } from './GhostCodec.js';
import { DeterministicPlaybackController } from './tas-core.js';
import { AdvancementEvents, AdvancementManager, ADVANCEMENTS } from './Advancements.js';
import { HudExtras } from './HudExtras.js';
import { createRuntime as _createModRuntime } from './mod-runtime.js?v=1000223';
import Peer from 'https://esm.sh/peerjs@1.5.5?bundle';
import { canJoinMap, createHostCode, readFirebaseConfig } from './FirebaseMultiplayer.js';
import { normalizeFirebaseVoteDoc, tallyFirebaseVotes, countFreshRoomPlayers } from './multiplayer-firebase-vote.js';
import {
	PUBLIC_SERVERS,
	findPublicServer,
	isPublicServerConfigured,
	fetchTrackList,
	fetchTrackBoardWithRetry,
	findTrackByPlayUrl,
	isRacingGameTrackUrl,
	mapSignatureFromPlayUrl,
	buildServerTrackRedirectUrl,
} from './PublicServers.js';
import { Storage } from './Storage.js';
import { VideoRecorder, UI_TOGGLE_GROUPS } from './VideoRecorder.js';
import GameSettings from './GameSettings.js';

document.title = 'Racing';

// Expose the shared custom-mod runtime on the global object BEFORE any mod is
// loaded. Compact generated mods (stored as a tiny `const SPEC = {...}; ...
// window.__RACING_MOD_RUNTIME__.createRuntime(id, SPEC)` data URL) read this at
// import time. Old inlined mods are unaffected (they ship their own copy).
// This must be synchronous and run before loadRuntimeMods() so the global is in
// place when the first mod module is imported.
window.__RACING_MOD_RUNTIME__ = Object.assign( window.__RACING_MOD_RUNTIME__ || {}, {
	createRuntime: _createModRuntime,
} );

setTimeout(() => {
	const status = document.getElementById('loading-status');
	if (status) status.textContent = 'MAINJS STARTED';
}, 0);


const MAX_PIXEL_RATIO = 1.5;
const GRAPHICS_QUALITY_KEY = 'racing-graphics-quality';
const GRAPHICS_QUALITY_PRESETS = {
	low: { label: 'Low', maxPixelRatio: 0.85, shadows: false, shadowMapSize: 1024, smokeParticles: 24, smokeEmissionStride: 3, weatherParticleScale: 0, bloomStrength: 0, bloomRadius: 0 },
	medium: { label: 'Medium', maxPixelRatio: 1.1, shadows: true, shadowMapSize: 2048, smokeParticles: 44, smokeEmissionStride: 2, weatherParticleScale: 0.55, bloomStrength: 0, bloomRadius: 0 },
	high: { label: 'High', maxPixelRatio: MAX_PIXEL_RATIO, shadows: true, shadowMapSize: 4096, smokeParticles: 64, smokeEmissionStride: 1, weatherParticleScale: 1, bloomStrength: 0, bloomRadius: 0 },
};

function isLikelyMobileDevice() {

	return Boolean( window.matchMedia?.( '(pointer: coarse)' )?.matches || window.innerWidth <= 760 || /Android|iPhone|iPad|iPod/i.test( navigator.userAgent ) );

}

function getDefaultGraphicsQuality() {

	if ( isLikelyMobileDevice() ) return ( Number( navigator.deviceMemory ) && navigator.deviceMemory <= 4 ) ? 'low' : 'medium';
	return 'high';

}

function normalizeGraphicsQuality( value ) {

	return GRAPHICS_QUALITY_PRESETS[ value ] ? value : getDefaultGraphicsQuality();

}

let graphicsQuality = normalizeGraphicsQuality( localStorage.getItem( GRAPHICS_QUALITY_KEY ) );

// Cached preset reference — updated whenever graphicsQuality changes. The render loop
// reads preset fields several times per frame; a cached lookup avoids repeated object
// property accesses and keeps the hot path allocation-free.
let cachedGraphicsPreset = GRAPHICS_QUALITY_PRESETS[ graphicsQuality ] || GRAPHICS_QUALITY_PRESETS[ getDefaultGraphicsQuality() ];

// Set the LOW-preset body class up front (applyGraphicsPresetToRenderer/
// applyGraphicsQuality keep it in sync on every later change).
document.body.classList.toggle( 'gfx-low', graphicsQuality === 'low' );

function getGraphicsPreset() {

	return cachedGraphicsPreset;

}

function getGraphicsParticleOptions() {

	const preset = getGraphicsPreset();
	return { maxParticles: preset.smokeParticles, emissionStride: preset.smokeEmissionStride };

}

const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, preserveDrawingBuffer: true, powerPreference: 'high-performance' } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, getGraphicsPreset().maxPixelRatio ) );
renderer.shadowMap.enabled = getGraphicsPreset().shadows;
renderer.shadowMap.autoUpdate = false; // needsUpdate=true each frame; refraction pass must not recompute shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

let bloomPass = null;
let bloomAttached = false;

function applyBloomPreset() {

	if ( ! bloomPass ) return;
	const preset = getGraphicsPreset();
	bloomPass.strength = preset.bloomStrength;
	bloomPass.radius = preset.bloomRadius;
	bloomPass.threshold = preset.bloomStrength > 0 ? 0.62 : 1.0;
	// A zero-strength bloom still runs its full multi-pass chain every
	// frame (a dozen-plus internal fullscreen renders — the most expensive
	// no-op in the pipeline). Detach the effect entirely when it adds
	// nothing; re-attach when a preset/custom setting wants it back.
	const wantsBloom = ( preset.bloomStrength || 0 ) > 0;
	if ( wantsBloom !== bloomAttached ) {

		bloomAttached = wantsBloom;
		renderer.setEffects( wantsBloom ? [ bloomPass ] : [] );

	}

}

async function loadBloomEffect() {

	try {

		const { UnrealBloomPass } = await import( 'three/addons/postprocessing/UnrealBloomPass.js' );
		bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
		// applyBloomPreset attaches the effect only when the active preset
		// actually wants bloom (built-in presets now default to strength 0).
		applyBloomPreset();

	} catch ( error ) {

		console.warn( 'Bloom effect unavailable; continuing without postprocessing.', error );

	}

}

loadBloomEffect();

document.body.appendChild( renderer.domElement );
const speedBlurVignette = document.getElementById( 'speed-blur-vignette' );
let localPlayerVehicle = null;
const remoteVisualHandlers = {
	withCosmetics: null,
	basic: null,
	getOrCreate: null,
	nameTag: null,
	remove: null,
};
const localMultiplayerStateHandlers = {
	getCarKey: null,
	buildCosmetics: null,
};
// Module-scope fallback for the car key:the <select id="car-select"> lives in the
// static HTML, so this works even before init() binds the handlers (pre-boot joins
// used to fall back to yellow)。 currentCarKey() (the init-scoped equivalent) reads
// the same element, so both return identical values once the scoped fn is in scope。
function getModuleCarKey() {
	const el = typeof document !== 'undefined' ? document.getElementById( 'car-select' ) : null;
	return el?.value || 'vehicle-truck-yellow';
}

// Public servers are currently BROKEN — UI is hidden but the whole
// implementation (join flow, handshake, map-sync, votes) is kept intact.
// Flip to true (and unhide #mp-public-row / #mp-pubtrack-row in
// index.html) to bring it back.
const PUBLIC_SERVERS_UI_ENABLED = false;

initMultiplayerPanel();

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const skyUniforms = {
	topColor: { value: new THREE.Color( '#6fb9ff' ) },
	midColor: { value: new THREE.Color( '#95ccff' ) },
	horizonColor: { value: new THREE.Color( '#ffe2aa' ) },
	groundColor: { value: new THREE.Color( '#bfd9f2' ) },
	time: { value: 0 },
	vibrance: { value: 0.15 },
};
const skyDome = new THREE.Mesh(
	new THREE.SphereGeometry( 50, 32, 24 ),
	new THREE.ShaderMaterial( {
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
		uniforms: skyUniforms,
		vertexShader: `varying vec3 vDir;
		void main() {
			vDir = normalize( position );
			vec4 wp = modelMatrix * vec4( position, 1.0 );
			gl_Position = projectionMatrix * viewMatrix * wp;
		}`,
		fragmentShader: `varying vec3 vDir;
		uniform vec3 topColor;
		uniform vec3 midColor;
		uniform vec3 horizonColor;
		uniform vec3 groundColor;
		uniform float time;
		uniform float vibrance;
		void main() {
			float h = clamp( vDir.y * 0.5 + 0.5, 0.0, 1.0 );
			float horizonBand = exp( -pow( abs( h - 0.48 ) * 7.0, 2.0 ) );
			float cloudWave = ( sin( vDir.x * 9.0 + time * 0.03 ) * sin( vDir.z * 7.0 - time * 0.02 ) );
			float cloudMask = smoothstep( 0.68, 0.86, cloudWave * 0.5 + 0.5 ) * 0.06;
			vec3 c = mix( groundColor, midColor, smoothstep( 0.03, 0.42, h ) );
			c = mix( c, topColor, smoothstep( 0.42, 0.95, h ) );
			c = mix( c, horizonColor, horizonBand * 0.92 );
			c += vec3( cloudMask ) * ( 0.24 + vibrance * 0.45 );
			c = mix( c, c * 1.15, vibrance * 0.5 );
			gl_FragColor = vec4( c, 1.0 );
		}`
	} )
);
skyDome.frustumCulled = false;
const skyGroup = new THREE.Group();
skyGroup.add( skyDome );
scene.add( skyGroup );

const dirLight = new THREE.DirectionalLight( 0xffffff, 5 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = getGraphicsPreset().shadows;
dirLight.shadow.mapSize.setScalar( getGraphicsPreset().shadowMapSize );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
dirLight.shadow.bias = -0.0004;
dirLight.shadow.normalBias = 0.04;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 1.5 );
scene.add( hemiLight );
const fillLight = new THREE.AmbientLight( 0x9cb8d9, 0.24 );
scene.add( fillLight );


function applyGraphicsPresetToRenderer() {

	const preset = getGraphicsPreset();
	// LOW = weak hardware: also kill the always-on HUD backdrop blurs (the
	// body.gfx-low rules in index.html). Small-widget blurs are cheap on
	// discrete GPUs but cost real frame time on integrated ones.
	document.body.classList.toggle( 'gfx-low', preset === GRAPHICS_QUALITY_PRESETS.low );
	const splitScreenPixelCap = new URLSearchParams( window.location.search ).get( 'multiplayer' ) === '1' ? 1 : preset.maxPixelRatio;
	renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, splitScreenPixelCap ) );
	renderer.shadowMap.enabled = preset.shadows;
	if ( renderer.shadowMap ) renderer.shadowMap.needsUpdate = true;
	dirLight.castShadow = preset.shadows;
	dirLight.shadow.mapSize.setScalar( preset.shadowMapSize );
	dirLight.shadow.needsUpdate = true;
	applyBloomPreset();

}

window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );
	applyGraphicsPresetToRenderer();

} );

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = ( url ) => appendLoadingConsole( `Fetching ${ url.split( '/' ).pop() }…` );
loadingManager.onProgress = ( url, loaded, total ) => appendLoadingConsole( `Loaded ${ url.split( '/' ).pop() } (${ loaded }/${ total })` );
loadingManager.onError = ( url ) => appendLoadingConsole( `Failed ${ url.split( '/' ).pop() }` );
const loader = new GLTFLoader( loadingManager );
const objLoader = new OBJLoader();
const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'vehicle-hatchback-green', 'vehicle-sedan-orange',
	'vehicle-car-police', 'vehicle-delivery-yellow', 'vehicle-flatbed-purple', 'vehicle-van-blue',
	'vehicle-ambulance-red', 'vehicle-firetruck-red', 'vehicle-taxi-yellow', 'vehicle-tractor-yellow', 'vehicle-trash-green',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'track-3-way', 'track-4-way',
	'elev-track-straight', 'elev-track-cross', 'elev-track-corner', 'elev-track-checkpoint', 'elev-track-slope',
	'elev-track-3-way', 'elev-track-4-way',
	'decoration-empty', 'decoration-forest', 'decoration-tents', 'empty-deco-grass',
	'building-garage', 'building-small-a', 'building-small-b', 'building-small-c', 'building-small-d',
	'garage',
];

const models = {};
const CAR_STATS = {
	'vehicle-truck-yellow': { name: 'Trail Pickup', bodyStyle: 'truck', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-green': { name: 'Utility Pickup', bodyStyle: 'truck', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-purple': { name: 'Cargo Van', bodyStyle: 'van', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-red': { name: 'Stakebed Truck', bodyStyle: 'truck', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-hatchback-green': { name: 'Hatchback', bodyStyle: 'hatchback', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-sedan-orange': { name: 'Sedan', bodyStyle: 'sedan', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-car-police': { name: 'Police Car', bodyStyle: 'car', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-delivery-yellow': { name: 'Delivery', bodyStyle: 'delivery', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-flatbed-purple': { name: 'Flatbed Truck', bodyStyle: 'flatbed', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-van-blue': { name: 'Panel Van', bodyStyle: 'van', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-ambulance-red': { name: 'Ambulance', bodyStyle: 'van', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-firetruck-red': { name: 'Fire Truck', bodyStyle: 'truck', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-taxi-yellow': { name: 'Taxi', bodyStyle: 'car', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-tractor-yellow': { name: 'Tractor', bodyStyle: 'tractor', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-trash-green': { name: 'Trash Truck', bodyStyle: 'truck', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
};
const CAR_SELECT_STYLES = {
	'vehicle-truck-yellow': { background: '#f2c94c', border: '#ffe082', color: '#1b1606' },
	'vehicle-truck-green': { background: '#2f9e44', border: '#69db7c', color: '#f0fff4' },
	'vehicle-truck-purple': { background: '#7b2cbf', border: '#c77dff', color: '#fff3ff' },
	'vehicle-truck-red': { background: '#c92a2a', border: '#ff8787', color: '#fff5f5' },
	'vehicle-hatchback-green': { background: '#0ca678', border: '#38d9a9', color: '#e6fcf5' },
	'vehicle-sedan-orange': { background: '#e8590c', border: '#ffa94d', color: '#fff4e6' },
	'vehicle-car-police': { background: '#1c7ed6', border: '#74c0fc', color: '#e7f5ff' },
	'vehicle-delivery-yellow': { background: '#f59f00', border: '#ffe066', color: '#fff9db' },
	'vehicle-flatbed-purple': { background: '#9c36b5', border: '#da77f2', color: '#f8f0fc' },
	'vehicle-van-blue': { background: '#1864ab', border: '#339af0', color: '#e8f3ff' },
	'vehicle-ambulance-red': { background: '#c92a2a', border: '#ffa8a8', color: '#fff5f5' },
	'vehicle-firetruck-red': { background: '#c92a2a', border: '#ff8787', color: '#fff5f5' },
	'vehicle-taxi-yellow': { background: '#f59f00', border: '#ffd43b', color: '#fff9db' },
	'vehicle-tractor-yellow': { background: '#e67700', border: '#ffb00f', color: '#fff7e6' },
	'vehicle-trash-green': { background: '#2f9e44', border: '#69db7c', color: '#f0fff4' },
};
const DEFAULT_ENGINE_MULT = 1.1;
const MAX_EFFECTIVE_TOP_SPEED = 1.8;
const BOOST_VELOCITY_DELTA = 8.2;
const BOOST_EFFECT_SECONDS = 1.0;
const BOOST_FORCE_SECONDS = 0.45;
const BOOST_ACCEL_PER_SECOND = 16.5;
const FX_SETTINGS_KEY = 'racing-fx-settings-v1';
const COUNTDOWN_SETTINGS_KEY = 'racing-countdown-enabled-v1';
const FPS_HUD_SETTINGS_KEY = 'racing-show-fps-v1';
// Default-car gameplay setting: '__last' (keep last used), '__random', or a CAR_STATS key.
const DEFAULT_CAR_KEY = 'racing-default-car-v1';
const COUNTDOWN_DURATION_SECONDS = 3;
const ZERO_DRIVE_INPUT = { x: 0, z: 0 };
const VEHICLE_SURFACE_RADIUS = 0.5;
const SURFACE_EFFECTS = {
	'surface-wood': { grip: 0.9, drag: 1.35, accel: 1.0, drive: 1.55 },
	'surface-ice': { grip: 0.4, drag: 0.58, accel: 0.45, drive: 0.8 },
	'surface-sand': { grip: 0.72, drag: 2.6, accel: 0.35, drive: 0.5 },
	'surface-custom-a': { grip: 1.2, drag: 1.0, accel: 1.05, drive: 1.15 },
	'surface-custom-b': { grip: 0.55, drag: 0.9, accel: 0.72, drive: 0.85 },
	'surface-custom-c': { grip: 0.95, drag: 1.7, accel: 1.25, drive: 1.3 },
};
const PAD_RESET_TYPE = 'pad-reset';
const VEHICLE_BASE_GRAVITY_FACTOR = 1.5;

// Seam bounce suppression — tracks sphere velocity between physics steps
// to detect and cancel the upward "pop" + speed loss that happens when the
// sphere catches on the edge between two adjacent surface colliders.
const _seamVel1 = [ 0, 0, 0 ];
const _seamVel2 = [ 0, 0, 0 ];
const seamSuppress = {
	vy1: 0,  vel1: _seamVel1,
	vy2: 0,  vel2: _seamVel2,
};

function suppressSeamBounce( world, veh, key, onSlope = false ) {
	if ( ! veh?.rigidBody?.motionProperties ) return false;
	const vel = veh.rigidBody.motionProperties.linearVelocity;
	const vy = vel[ 1 ];
	const prevVy = seamSuppress[ 'vy' + key ];
	const savedVel = seamSuppress[ 'vel' + key ];

	// Detect a seam bounce — thresholds lowered to catch tiny annoying bumps:
	// - vy > 0.15 (was 0.3) — catch smaller upward pops
	// - vyDelta > 0.2 (was 0.5) — catch smaller velocity spikes
	// - vy < 4.0 — still allows real jumps (ramps give 5+ m/s)
	// - prevVy > -0.5 — car was ON a surface, not falling from a jump
	// - prevVy < 1.0 — car wasn't already flying upward
	const vyDelta = vy - prevVy;
	const isSeamBounce = vy > 0.15 && vy < 4.0 && prevVy > - 0.5 && prevVy < 1.0 && vyDelta > 0.2;

	// On a slope the car legitimately gains upward velocity as it climbs, which
	// trips the seam-bounce thresholds and would freeze the car's velocity
	// (undoing the whole physics step) — the intermittent "can't grip / slides
	// around ignoring physics" glitch. Skip the restore while on a slope cell;
	// the slope is one continuous tilted collider with no internal seam to pop on.
	if ( isSeamBounce && ! onSlope && savedVel ) {
		// Restore the full velocity from before the physics step.
		// Undoes BOTH the upward bounce AND the forward speed loss.
		rigidBody.setLinearVelocity( world, veh.rigidBody, savedVel );
	}

	seamSuppress[ 'vy' + key ] = vy;
	const bucket = seamSuppress[ 'vel' + key ];
	if ( bucket ) { bucket[ 0 ] = vel[ 0 ]; bucket[ 1 ] = vel[ 1 ]; bucket[ 2 ] = vel[ 2 ]; }
	// Still report a "bounce" for crash-detection purposes only when we actually
	// suppressed one (restored velocity). On a slope we did not, so return false.
	return isSeamBounce && ! onSlope;
}
const PAD_EFFECTS = {
	'pad-low-gravity': { id: 'low-gravity', gravity: 0.45 },
	'pad-heavy-gravity': { id: 'heavy-gravity', gravity: 1.7 },
	'pad-high-grip': { id: 'high-grip', grip: 2.2, drag: 1.25 },
	'pad-high-speed': { id: 'high-speed', accel: 1.5, drive: 1.6, topSpeed: 1.25 },
	'pad-no-brakes': { id: 'no-brakes', disableBrakes: true },
	'pad-no-steering': { id: 'no-steering', disableSteering: true },
	'pad-no-acceleration': { id: 'no-acceleration', disableAcceleration: true, accel: 0.0, drive: 0.0, drag: 0.18, grip: 0.86 },
	'pad-slow-motion': { id: 'slow-motion', timeScale: 0.6 },
	'pad-fast-motion': { id: 'fast-motion', timeScale: 1.35 },
	'pad-drift': { id: 'drift', grip: 0.32, drag: 0.45, steering: 1.35 },
	'pad-size-small': { id: 'size-small', scale: 0.5 },
	'pad-size-normal': { id: 'size-normal', scale: 1.0 },
	'pad-size-mega': { id: 'size-mega', scale: 1.8 },
	'pad-trick-yaw-1': { id: 'trick-yaw-1', trick: { yaw: 1 } },
	'pad-trick-pitch-1': { id: 'trick-pitch-1', trick: { pitch: 1 } },
	'pad-trick-roll-1': { id: 'trick-roll-1', trick: { roll: 1 } },
	'pad-trick-yaw-pitch-1': { id: 'trick-yaw-pitch-1', trick: { yaw: 1, pitch: 1 } },
	'pad-trick-yaw-roll-1': { id: 'trick-yaw-roll-1', trick: { yaw: 1, roll: 1 } },
	'pad-trick-pitch-roll-1': { id: 'trick-pitch-roll-1', trick: { pitch: 1, roll: 1 } },
	'pad-trick-yaw-pitch-roll-1': { id: 'trick-yaw-pitch-roll-1', trick: { yaw: 1, pitch: 1, roll: 1 } },
	'pad-trick-yaw-roll-pitch': { id: 'trick-yaw-roll-pitch', trick: { yaw: 1, roll: 1, pitch: -1 } },
	'pad-trick-pitch-yaw-roll': { id: 'trick-pitch-yaw-roll', trick: { pitch: 1, yaw: -1, roll: 1 } },
};
const HACK_HITBOX_OPACITY = 0.5;
const HACK_WORLD_OPACITY = 0.9;
const SIZE_PAD_TYPES = new Set( [ 'pad-size-small', 'pad-size-normal', 'pad-size-mega' ] );
const CUSTOM_PAD_TYPES = [ 'pad-custom-a', 'pad-custom-b', 'pad-custom-c' ];
const BOUNCE_VERTICAL_DELTA = 7.2;
const KICK_LATERAL_DELTA = 7.4;
const MAGNET_FULL_STRENGTH_BLOCKS = 0.5;
const MAGNET_DEFAULT_MAX_DISTANCE_BLOCKS = 1.5;
const MAGNET_DEFAULT_FORCE_PER_SECOND = 26.0;
const MAGNET_MIN_MAX_DISTANCE_BLOCKS = 0.75;
const MAGNET_MAX_MAX_DISTANCE_BLOCKS = 2.5;
const MAGNET_MIN_FORCE_PER_SECOND = 8.0;
const MAGNET_MAX_FORCE_PER_SECOND = 64.0;
	const ARC_LINK_TRIGGER_RADIUS = CELL_RAW * GRID_SCALE * 0.32;
	const ARC_LINK_MIN_TIME = 0.45;
	const ARC_LINK_MAX_TIME = 1.6;
	const AIR_TRICK_DURATION_SECONDS = 0.62;
const WEATHER_PRESETS = {
	clear: { bg: 0xbfe0ff, fogNearMul: 3.2, fogFarMul: 6.4, sun: 5.0, hemi: 1.5, exposure: 1.0 },
	cloudy: { bg: 0xaab2ba, fogNearMul: 2.56, fogFarMul: 5.12, sun: 3.8, hemi: 1.3, exposure: 0.95 },
	sunset: { bg: 0xffb178, fogNearMul: 2.24, fogFarMul: 4.8, sun: 4.4, hemi: 1.2, exposure: 1.08 },
	night: { bg: 0x0a1730, fogNearMul: 1.92, fogFarMul: 4.0, sun: 1.7, hemi: 0.45, exposure: 0.7 },
	'night-constellations': { bg: 0x0a1730, fogNearMul: 1.92, fogFarMul: 4.0, sun: 1.7, hemi: 0.45, exposure: 0.7 },
	'dawn-mist': { bg: 0xb6c2cc, fogNearMul: 1.6, fogFarMul: 3.36, sun: 2.9, hemi: 1.1, exposure: 0.88 },
};

const WEATHER_SKY_GRADIENTS = {
	clear: { top: '#1c5fd6', mid: '#5cb2f2', horizon: '#ffe9c9', ground: '#dcecff' },
	cloudy: { top: '#5c6b7c', mid: '#8b96a3', horizon: '#c9cfd5', ground: '#aab2ba' },
	sunset: { top: '#2c1f52', mid: '#c4548f', horizon: '#ff8a4c', ground: '#ffd28a' },
	night: { top: '#01030b', mid: '#050d24', horizon: '#132244', ground: '#0a1730' },
	'night-constellations': { top: '#01030b', mid: '#050d24', horizon: '#132244', ground: '#0a1730' },
	'dawn-mist': { top: '#5f92d0', mid: '#9fc4eb', horizon: '#ffdcb0', ground: '#c5ddf4' },
};

// Per-preset low-poly cloud / star / moon decorations for the sky group.
// 'dawn-mist' intentionally has no entry — left exactly as it was.
const SKY_DECOR_PRESETS = {
	clear: { clouds: { count: 12, scale: [ 3.0, 5.0 ], elevationRange: [ 8, 24 ], color: 0xffffff, opacity: 0.92 }, stars: 0, moon: false },
	sunset: { clouds: { count: 10, scale: [ 3.2, 5.2 ], elevationRange: [ 6, 18 ], color: 0xffcfae, opacity: 0.93 }, stars: 0, moon: false },
	cloudy: { clouds: { count: 15, scale: [ 4.5, 7.0 ], elevationRange: [ 5, 18 ], color: 0x9aa3ad, opacity: 0.9 }, stars: 0, moon: false },
	night: { clouds: { count: 6, scale: [ 2.5, 4.0 ], elevationRange: [ 12, 28 ], color: 0x2b3a5c, opacity: 0.35 }, stars: 600, moon: true, constellations: true },
	'night-constellations': { clouds: { count: 6, scale: [ 2.5, 4.0 ], elevationRange: [ 12, 28 ], color: 0x2b3a5c, opacity: 0.35 }, stars: 600, moon: true, constellations: true },
};

const WEATHER_DEFAULT = 'clear';
const PRECIP_DEFAULT = 'none';
const INTENSITY_DEFAULT = 'medium';
const WIND_DEFAULT = 'none';
const LEADERBOARD_API_BASE = 'https://racing-leaderboard-api.ga1010.workers.dev/api/leaderboard';
const ACCOUNT_API_BASE = 'https://racing-account-api.ga1010.workers.dev/api/accounts';
const TRACK_SHARE_API_ROOT = 'https://racing-track-board-api.ga1010.workers.dev';
const TRACK_SHARE_API_PREFIXES = [ '/api', '' ];
const PLAYER_NAME_KEY = 'racing-player-name-v1';
const MAX_PLAYER_NAME_LENGTH = 24;
const ACCOUNT_SESSION_KEY = 'racing-account-session-v1';
const MAX_LEADERBOARD_ROWS = 15;
const MAX_LEADERBOARD_GHOST_SAMPLES = 2500;
const CAMPAIGN_STAGES = [
	{ type: 'lap-default', goal: 1, text: 'Complete 1 lap on default track' },
	{ type: 'play-share', goal: 1, text: 'Play 1 track from Track Share Board' },
	{ type: 'podium', goal: 1, text: 'Set 1 shared-track podium' },
	{ type: 'publish-track', goal: 1, text: 'Publish your first track' },
	{ type: 'editor-play', goal: 1, text: 'Open editor and launch Play/Quick Test' },
	{ type: 'set-record', goal: 1, text: 'Set your first #1 record' },
	{ type: 'install-mod', goal: 1, text: 'Install 1 mod pack' },
	{ type: 'customize-car', goal: 1, text: 'Customize your car once' },
	{ type: 'beat-authors', goal: 3, text: 'Beat 3 author times' },
	{ type: 'beat-records', goal: 3, text: 'Beat 3 existing records' },
	{ type: 'like-tracks', goal: 3, text: 'Like 3 tracks on the board' },
	{ type: 'play-share', goal: 3, text: 'Play 3 more shared tracks' },
	{ type: 'podium', goal: 3, text: 'Earn 3 podium finishes' },
	{ type: 'set-record', goal: 3, text: 'Set 3 records' },
	{ type: 'beat-authors', goal: 5, text: 'Beat 5 more author times' },
	{ type: 'like-tracks', goal: 6, text: 'Like 6 tracks total' },
	{ type: 'beat-records', goal: 6, text: 'Beat 6 records total' },
	{ type: 'set-record', goal: 5, text: 'Set 5 records total' },
	{ type: 'play-share', goal: 8, text: 'Play 8 shared tracks total' },
	{ type: 'podium', goal: 8, text: 'Reach 8 podiums total' },
	{ type: 'beat-authors', goal: 10, text: 'Beat 10 author times total' },
	{ type: 'endurance-laps', goal: 12, text: 'Complete 12 campaign laps' },
	{ type: 'mastery', goal: 1, text: 'Campaign mastery complete' },
];
const CAMPAIGN_STAGE_COUNT = CAMPAIGN_STAGES.length;
const PRECIP_TYPES = new Set( [ 'none', 'rain', 'snow' ] );
const INTENSITY_TYPES = new Set( [ 'low', 'medium', 'high' ] );
const WIND_TYPES = new Set( [ 'none', 'breezy', 'gusty' ] );
const FIREBASE_ROOM_TIMEOUT_MS = 2200;
const WEBRTC_SYNC_MS = 33;
const PEER_ROOM_PREFIX = 'RACE-ROOM-';
const PEER_PACKET_STATE = 'VEHICLE_STATE';
const PEER_PACKET_LEFT = 'PLAYER_LEFT';
// Public-server-only packets, distributed over the PeerJS mesh (WebRTC data
// channels; PeerJS uses the TURN server configured in `peerConfig`):
//   MAP_SYNC   — host→joiner on connect (and host→all on a map switch): carries
//                the host's current mapSignature so joiners redirect to the same
//                map everyone else is on.
//   VOTE_START — a player proposed a map switch; everyone shows the vote prompt.
//   VOTE       — a player's Yes/No vote for an active vote.
//   VOTE_RESULT— the initiator's authoritative result after 30s (passed? + the
//                target playUrl); if passed everyone redirects to the new map.
const PEER_PACKET_MAP_SYNC = 'PUBLIC_MAP_SYNC';
//   MAP_SYNC_REQ — joiner→host: asked on the joiner's data channel opening so
//                a lost/dropped initial MAP_SYNC gets re-sent instead of hanging.
const PEER_PACKET_MAP_SYNC_REQ = 'PUBLIC_MAP_SYNC_REQ';
const PEER_PACKET_VOTE_START = 'PUBLIC_VOTE_START';
const PEER_PACKET_VOTE = 'PUBLIC_VOTE';
const PEER_PACKET_VOTE_RESULT = 'PUBLIC_VOTE_RESULT';
const peerConfig = {
	config: {
		iceServers: [
			{ urls: 'stun:stun.l.google.com:19302' },
			{
				urls: [
					'turn:openrelay.metered.ca:80',
					'turn:openrelay.metered.ca:443',
					'turn:openrelay.metered.ca:443?transport=tcp',
				],
				username: 'openrelay',
				credential: 'openrelay',
			},
		],
	},
};
const LOADING_PROGRESS_BY_STAGE = {
	boot: 5,
	models: 28,
	track: 46,
	physics: 63,
	leaderboard: 82,
	ready: 100,
};

let loadingOverlayDismissed = false;
const loadingStartedAt = performance.now();

function appendLoadingConsole( message ) {

	const consoleEl = document.getElementById( 'loading-console' );
	if ( ! consoleEl ) return;
	const line = document.createElement( 'div' );
	line.textContent = `[${ ( ( performance.now() - loadingStartedAt ) / 1000 ).toFixed( 2 ) }s] ${ message }`;
	consoleEl.appendChild( line );
	while ( consoleEl.children.length > 18 ) consoleEl.removeChild( consoleEl.firstChild );
	consoleEl.scrollTop = consoleEl.scrollHeight;

}

function setLoadingStatus( message, stage = null ) {

	const statusEl = document.getElementById( 'loading-status' );
	const fillEl = document.getElementById( 'loading-progress-fill' );
	if ( statusEl ) statusEl.textContent = message || '';
	if ( fillEl && stage && Number.isFinite( LOADING_PROGRESS_BY_STAGE[ stage ] ) ) fillEl.style.width = `${ LOADING_PROGRESS_BY_STAGE[ stage ] }%`;
	if ( message ) appendLoadingConsole( message );

}

function hideLoadingOverlay() {

	if ( loadingOverlayDismissed ) return;
	const loadingScreen = document.getElementById( 'loading-screen' );
	if ( ! loadingScreen ) return;
	loadingScreen.classList.add( 'hidden' );
	loadingOverlayDismissed = true;

	// Ensure the landing page is visible on the root path after loading completes
	const landing = document.getElementById( 'home-landing' );
	if ( landing && !landing.classList.contains( 'visible' ) ) {
		const params = new URLSearchParams( location.search );
		const map = params.get( 'map' );
		const pack = params.get( 'pack' );
		const play = params.get( 'play' );
		const isIndexPath = /(?:^|\/)(?:index\.html)?$/.test( location.pathname );
		if ( isIndexPath && !map && !pack && play !== '1' ) {
			landing.classList.add( 'visible' );
		}
	}

}

function showLoadingError( error ) {

	const spinner = document.getElementById( 'loading-spinner' );
	const progress = document.getElementById( 'loading-progress' );
	const statusEl = document.getElementById( 'loading-status' );
	const errorEl = document.getElementById( 'loading-error' );
	const reloadBtn = document.getElementById( 'loading-reload-btn' );
	if ( spinner ) spinner.style.display = 'none';
	if ( progress ) progress.style.display = 'none';
	if ( statusEl ) statusEl.textContent = 'Loading failed.';
	if ( errorEl ) {
		errorEl.textContent = `Error: ${ error?.message || 'Unknown startup error.' }`;
		errorEl.style.display = 'block';
	}
	if ( reloadBtn ) {
		reloadBtn.style.display = 'inline-flex';
		reloadBtn.onclick = () => window.location.reload();
	}

}

function hasFirebaseMultiplayerConfig() {

	return Boolean( readFirebaseConfig() );

}

function getPeerRoomId( roomCode ) {

	return `${ PEER_ROOM_PREFIX }${ String( roomCode || '' ).trim().toUpperCase() }`;

}

function cleanupPeerConnection( peerId ) {

	logMpDebug( `[PeerJS] Connection closed/cleaned up: ${ peerId }` );
	const connection = multiplayerSessionState.connections.get( peerId );
	connection?.close?.();
	multiplayerSessionState.connections.delete( peerId );

	// If this was our still-connecting public-server joiner channel, forget it so
	// the recovery loop doesn't wait on a ghost reference (and its death can no
	// longer keep blocking a reclaim/rejoin).
	if ( publicServerState.connectingDataChannel && publicServerState.connectingDataChannel.peer === peerId ) {
		publicServerState.connectingDataChannel = null;
		clearPublicServerIceRetry();
	}
	if ( typeof removeRemotePlayerVisual === 'function' ) removeRemotePlayerVisual( peerId );
}


function closeMultiplayerPeer() {

	for ( const connection of multiplayerSessionState.connections.values() ) {

		try {

			connection.send?.( { type: PEER_PACKET_LEFT, playerId: multiplayerSessionState.clientId } );
			connection.close?.();

		} catch {}

	}
	multiplayerSessionState.connections.clear();
	multiplayerSessionState.peer?.destroy?.();
	multiplayerSessionState.peer = null;

	// Any public-server handshake we were keeping alive is gone with this peer.
	publicServerState.connectingDataChannel = null;
	clearPublicServerIceRetry();
}


function relayHostPacket( packet, sourcePeerId ) {

	if ( multiplayerSessionState.role !== 'host' ) return;
	for ( const [ peerId, connection ] of multiplayerSessionState.connections.entries() ) {

		if ( peerId === sourcePeerId || ! connection?.open ) continue;
		connection.send( packet );

	}

}

function resolveRemoteVisualState( playerId, carKey, cosmetics ) {

	if ( typeof ensureRemotePlayerVisualWithCosmetics === 'function' ) {

		return ensureRemotePlayerVisualWithCosmetics( playerId, carKey, cosmetics );

	}
	if ( remoteVisualHandlers.withCosmetics ) return remoteVisualHandlers.withCosmetics( playerId, carKey, cosmetics );
	if ( typeof ensureRemotePlayerVisual === 'function' ) return ensureRemotePlayerVisual( playerId, carKey, cosmetics );
	if ( remoteVisualHandlers.basic ) return remoteVisualHandlers.basic( playerId, carKey, cosmetics );
	if ( typeof getOrCreateRemotePlayerVisual === 'function' ) return getOrCreateRemotePlayerVisual( playerId, carKey, cosmetics );
	if ( remoteVisualHandlers.getOrCreate ) return remoteVisualHandlers.getOrCreate( playerId, carKey, cosmetics );

	logMpDebug( `[Visual Error] No remote visual initializer function found for ${ String( playerId || '' ).slice( 0, 8 ) }` );
	return null;

}

function applyRemoteNameTag( visualState, displayName ) {

	if ( typeof ensureRemoteNameTag === 'function' ) {

		ensureRemoteNameTag( visualState, displayName );
		return;

	}
	if ( remoteVisualHandlers.nameTag ) remoteVisualHandlers.nameTag( visualState, displayName );

}

function removeResolvedRemotePlayerVisual( playerId ) {

	if ( typeof removeRemotePlayerVisual === 'function' ) {

		removeRemotePlayerVisual( playerId );
		return;

	}
	if ( remoteVisualHandlers.remove ) remoteVisualHandlers.remove( playerId );

}

function handlePeerPacket( packet, sourcePeerId ) {

	try {

		if ( ! packet || typeof packet !== 'object' ) {

			logMpDebug( `[Recv Warn] Ignored invalid packet from ${ sourcePeerId || 'unknown peer' }` );
			return;

		}
		const playerId = String( packet.playerId || sourcePeerId || '' );
		if ( ! playerId ) {

			logMpDebug( `[Recv Warn] Ignored packet without playerId from ${ sourcePeerId || 'unknown peer' }` );
			return;

		}
		if ( playerId === multiplayerSessionState.clientId ) return;
		touchPublicServerPlayer( playerId );
		if ( packet.type === PEER_PACKET_LEFT ) {

			removeResolvedRemotePlayerVisual( playerId );
			forgetPublicServerPlayer( playerId );
			relayHostPacket( packet, sourcePeerId );
			return;

		}
		// Public-server map sync: the host tells us which map everyone is on.
		// If we're not on it, redirect to it (the redirect rejoins the server).
		if ( packet.type === PEER_PACKET_MAP_SYNC ) {

			onPublicServerMapSync( packet );
			// MAP_SYNC is host→joiner (and host→all on a switch); do not relay.
			return;

		}
		// Public-server map-vote packets. Each is collected locally and relayed
		// by the host so every peer sees it (not just directly-connected ones).
		if ( packet.type === PEER_PACKET_VOTE_START ) {

			onPublicServerVoteStart( packet );
			relayHostPacket( packet, sourcePeerId );
			return;

		}
		// A joiner whose initial MAP_SYNC never arrived asks the host to re-send it.
			// Only the host answers; joiner→host, do not relay. That doubles the
			// chance the redirect happens promptly instead of waiting for the next
			// maintenance tick / the host's next broadcast.

			if ( packet.type === PEER_PACKET_MAP_SYNC_REQ ) {

				if ( publicServerState.isHost && isPublicServerActive() ) {

					// Only answer the requesting peer, not broadcast — that would
					// spam every joiner with an otherwise-identical packet.
					const conn = multiplayerSessionState.connections.get( sourcePeerId );
					if ( conn?.open ) broadcastPublicServerMapSync( conn );

				}
				return;

			}
			if ( packet.type === PEER_PACKET_VOTE ) {

				onPublicServerVote( packet );
				relayHostPacket( packet, sourcePeerId );
				return;

			}
		if ( packet.type === PEER_PACKET_VOTE_RESULT ) {

			onPublicServerVoteResult( packet );
			relayHostPacket( packet, sourcePeerId );
			return;

		}
		if ( packet.type !== PEER_PACKET_STATE ) return;
		const visualState = resolveRemoteVisualState( playerId, packet.carKey, packet.cosmetics );
		if ( ! visualState ) return;
		const isFirstPacket = ! visualState.lastSeenAt;
		applyRemoteNameTag( visualState, packet.name || 'Player' );
		visualState.targetPos.set( Number( packet.x ) || 0, ( Number( packet.y ) || 0 ) - 0.1, Number( packet.z ) || 0 );
		visualState.targetRotY = THREE.MathUtils.degToRad( ( ( Number( packet.ry ) || 0 ) % 360 + 0 ) % 360 ) ;
		if ( isFirstPacket ) {

			visualState.mesh.position.copy( visualState.targetPos );
			visualState.mesh.rotation.y = visualState.targetRotY;
			logMpDebug( `[PeerJS] Spawned remote vehicle for ${ playerId } (${ visualState.carKey })` );

		}
		visualState.lastSeenAt = Date.now();
		relayHostPacket( packet, sourcePeerId );

	} catch ( err ) {

		logMpDebug( `[Recv Error] Failed to handle packet from ${ sourcePeerId || 'unknown peer' }: ${ err?.message || err }` );

	}

}

function registerPeerConnection( connection ) {

	if ( ! connection ) return;
	logMpDebug( `[PeerJS] Registered data connection with: ${ connection.peer }` );
	multiplayerSessionState.connections.set( connection.peer, connection );
	if ( connection.open ) {

		try {

			connection.send( buildLocalPeerStatePacket() );
			logMpDebug( `[PeerJS] Sent initial state packet to ${ connection.peer }` );
			// Host: tell the just-connected joiner which map everyone is on so they
			// redirect to it (the host owns the RACE-ROOM-<code> peer id). This is
			// what makes a public-server joiner "load the same map everyone else
			// is on". The joiner ignores it if already on that map.
			if ( isPublicServerActive() && publicServerState.isHost ) {

				broadcastPublicServerMapSync( connection );

			}

		} catch ( err ) {

			logMpDebug( `[Send Error] Failed initial state packet to ${ connection.peer }: ${ err?.message || err }` );

		}

	} else {

		logMpDebug( `[Send Warn] Registered data channel to ${ connection.peer } before open (state: ${ connection.readyState })` );

	}
	connection.on( 'data', ( packet ) => handlePeerPacket( packet, connection.peer ) );
	connection.on( 'close', () => cleanupPeerConnection( connection.peer ) );
	connection.on( 'error', ( error ) => {

		logMpDebug( `[PeerJS] Connection error with ${ connection.peer }: ${ error?.message || error }` );
		cleanupPeerConnection( connection.peer );

	} );

}

function startPeerMultiplayer( roomCode, role ) {

	closeMultiplayerPeer();
	logMpDebug( `[PeerJS] Initializing ${ role } peer for room: ${ roomCode }...` );
	const peerId = role === 'host' ? getPeerRoomId( roomCode ) : multiplayerSessionState.clientId;
	const peer = new Peer( peerId, peerConfig );
	multiplayerSessionState.peer = peer;
	peer.on( 'open', ( id ) => {

		logMpDebug( `[PeerJS] Peer opened with ID: ${ id }` );
		if ( role !== 'host' ) {

			const targetHostId = getPeerRoomId( roomCode );
			logMpDebug( `[PeerJS] Connecting guest to host ID: ${ targetHostId }` );
			const connection = peer.connect( targetHostId, { reliable: true } );
			// Public-server joiners: remember the live (possibly unopened) data
			// channel so the recovery loop can be patient + retry it quietly instead
			// of destroying it every 5s (which is what made a slow-but-fine
			// WebRTC handshake loop forever).
			if ( isPublicServerActive() && ! publicServerState.isHost ) {
				publicServerState.handshakeStartedAt = Date.now();
				publicServerState.connectingDataChannel = connection;
				startPublicServerIceRetry( connection );
			}
			connection.on( 'open', () => {

				logMpDebug( `[PeerJS] Data channel OPENED with host: ${ targetHostId }` );
				registerPeerConnection( connection );
				broadcastPeerState();
				if ( isPublicServerActive() && ! publicServerState.isHost ) {
					publicServerState.connectingDataChannel = null;
					clearPublicServerIceRetry();
				}
				// Public-server joiners: ask the host to re-send the map sync so we
				// redirect promptly even if their first MAP_SYNC got dropped.
				if ( isPublicServerActive() && ! publicServerState.isHost ) {

					try { connection.send( { type: PEER_PACKET_MAP_SYNC_REQ, playerId: multiplayerSessionState.clientId } ); } catch {}

				}

			} );
			connection.on( 'error', ( error ) => logMpDebug( `[PeerJS] Connection error: ${ error?.message || error }` ) );

		}

	} );
	peer.on( 'connection', ( connection ) => {

		logMpDebug( `[PeerJS] Host received connection request from: ${ connection.peer }` );
		connection.on( 'open', () => {

			logMpDebug( `[PeerJS] Data channel OPENED with guest: ${ connection.peer }` );
			registerPeerConnection( connection );
			broadcastPeerState();

		} );
		connection.on( 'error', ( error ) => logMpDebug( `[PeerJS] Connection error: ${ error?.message || error }` ) );

	} );
	peer.on( 'disconnected', () => logMpDebug( `[PeerJS] Peer disconnected: ${ peerId }` ) );
	peer.on( 'close', () => logMpDebug( `[PeerJS] Peer closed: ${ peerId }` ) );
	peer.on( 'error', ( error ) => {

		logMpDebug( `[PeerJS] Peer error: ${ error?.message || error }` );
		console.warn( 'PeerJS multiplayer error', error );
		updateMultiplayerStatus( `WebRTC issue for room ${ roomCode }; retry if peers do not appear.` );

	} );

}

function getLocalVehicleContainer() {

	if ( localPlayerVehicle?.container ) return localPlayerVehicle.container;
	if ( typeof vehicle !== 'undefined' && vehicle?.container ) return vehicle.container;
	if ( typeof playerVehicle !== 'undefined' && playerVehicle?.container ) return playerVehicle.container;
	if ( typeof currentVehicle !== 'undefined' && currentVehicle?.container ) return currentVehicle.container;
	if ( window.vehicle?.container ) return window.vehicle.container;
	if ( window.playerVehicle?.container ) return window.playerVehicle.container;
	if ( window.currentVehicle?.container ) return window.currentVehicle.container;
	return null;

}

const _mpHeadingForward = new THREE.Vector3();
const _mpHeadingUp = new THREE.Vector3( 0, 1, 0 );
function getMultiplayerHeadingDegrees( container ) {
	if ( ! container ) return 0;
	_mpHeadingForward.set( 0, 0, 1 ).applyQuaternion( container.quaternion );
	_mpHeadingForward.projectOnPlane( _mpHeadingUp ).normalize();
	if ( _mpHeadingForward.lengthSq() < 1e-6 ) return 0;
	const yaw = Math.atan2( _mpHeadingForward.x, _mpHeadingForward.z );
	return ( ( yaw * 180 / Math.PI ) % 360 + 0 ) % 360;
}

function formatPeerPacketNumber( value, precision ) {

	const numericValue = Number( value );
	return Number.isFinite( numericValue ) ? Number( numericValue.toFixed( precision ) ) : 0;

}

// Cosmetics (car paint mappings) barely ever change, but the garage walk that
// builds them used to run for every broadcast packet. Memoize per car key with
// a short refresh window so repainting still propagates within ~300ms.
let peerCosmeticsMemo = { carKey: '', at: 0, value: null };
function buildPeerCosmeticsSnapshot( packetCarKey ) {

	const now = Date.now();
	if ( peerCosmeticsMemo.carKey !== packetCarKey || now - peerCosmeticsMemo.at >= 300 ) {

		peerCosmeticsMemo = {
			carKey: packetCarKey,
			at: now,
			value: typeof localMultiplayerStateHandlers.buildCosmetics === 'function' ? localMultiplayerStateHandlers.buildCosmetics( packetCarKey ) : null,
		};

	}
	return peerCosmeticsMemo.value;

}

function buildRemotePlayerSnapshot() {
	const container	 = getLocalVehicleContainer();
	const pos	 = container?.position || { x:	 0,	 y:	 0,	 z:	 0 };
	const rawCarKey	 = typeof localMultiplayerStateHandlers.getCarKey === 'function' ? localMultiplayerStateHandlers.getCarKey() : 'vehicle-truck-yellow';
	const packetCarKey	 = typeof normalizeMultiplayerCarKey === 'function' ? normalizeMultiplayerCarKey( rawCarKey ) : rawCarKey;
	return {
		type: PEER_PACKET_STATE,
		playerId: multiplayerSessionState.clientId,
		x: formatPeerPacketNumber( pos.x,	 3 ),
		y: formatPeerPacketNumber( pos.y,	  3 ),
		z: formatPeerPacketNumber( pos.z,	 3 ),
		ry	: Number( getMultiplayerHeadingDegrees( container ).toFixed( 2 ) ),
		carKey: packetCarKey,
		cosmetics: buildPeerCosmeticsSnapshot( packetCarKey ),
		name: typeof getLocalMultiplayerDisplayName === 'function' ? getLocalMultiplayerDisplayName() : 'Player',
		updatedAt: Date.now(),
	};
}
function buildLocalPeerStatePacket() {

	const snap = buildRemotePlayerSnapshot();
	if ( ! snap ) return null;
	const { x, y, z, ry, carKey, cosmetics, name, updatedAt, type, playerId } = snap;
	return { x, y, z, ry, carKey, cosmetics, name, updatedAt, type, playerId };

}

function broadcastPeerState() {

		if ( ! multiplayerSessionState.roomCode || ! multiplayerSessionState.peer ) return;
		let hasOpenConnection = false;
		for ( const connection of multiplayerSessionState.connections.values() ) {

			if ( connection && connection.open ) { hasOpenConnection = true; break; }

		}
		if ( ! hasOpenConnection ) return;
		const snap = buildRemotePlayerSnapshot();
		if ( ! snap || ! snap.carKey ) return;

	try {

		// Full state every tick: receivers rely on cosmetics/name riding along so
		// resolveRemoteVisualState's signature match can no-op-reuse their visual.
		// (Cosmetics itself is memoized — see buildPeerCosmeticsSnapshot.)
		const packet = {
			type: PEER_PACKET_STATE,
			playerId: snap.playerId,
			x: snap.x,
			y: snap.y,
			z: snap.z,
			ry: snap.ry,
			carKey: snap.carKey,
			cosmetics: snap.cosmetics,
			name: snap.name,
			updatedAt: snap.updatedAt,
		};
		for ( const [ peerId, connection ] of multiplayerSessionState.connections.entries() ) {

			if ( connection && connection.open ) {

				connection.send( packet );

			} else if ( connection ) {

				logMpDebug( `[Send Warn] Data channel to ${ peerId } not open yet (state: ${ connection.readyState })` );

			}

		}

	} catch ( err ) {

		logMpDebug( `[Send Error] Failed to broadcast packet: ${ err?.message || err }` );

	}

}

// NOTE:the public-server poll kick + host-meta heartbeat live INSIDE init() (
// as a local closure named startPublicServerPolling), because the 220ms
// sync loop (syncMultiplayerTransforms) is init-local. A module-scope copy
// would ReferenceError on that name (TDZ/undefined), so joining a public server
// from module scope can never call it directly — the kick fires from joinPublicServer's
// own immediate Firebase PUT (the join payload itself is the poll's first write),
// then init()'s setInterval+startPublicServerPolling take over once boot completes.


function updateMultiplayerStatus( text ) {

	const statusEl = document.getElementById( 'mp-status' );
	if ( ! statusEl ) return;
	statusEl.textContent = text || '';

}

function logMpDebug( message ) {

	const text = String( message || '' );
	console.log( text );
	const overlay = document.getElementById( 'mp-debug-overlay' );
	if ( ! overlay ) return;
	const row = document.createElement( 'div' );
	row.textContent = `[${ new Date().toLocaleTimeString() }] ${ text }`;
	overlay.appendChild( row );
	while ( overlay.children.length > 300 ) overlay.removeChild( overlay.firstChild );
	overlay.scrollTop = overlay.scrollHeight;

}

const multiplayerSessionState = {
	role: 'none',
	roomCode: '',
	clientId: ( globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `p-${ Math.random().toString( 36 ).slice( 2, 10 ) }` ),
	peer: null,
	connections: new Map(),
};

const MULTIPLAYER_ROOM_ROTATE_MS = 120000;
const HOST_ROOM_META_SYNC_MS = 1500;
let lastHostRoomRotateAt = 0;
let lastHostRoomMetaSyncAt = 0;
let lastPublicServerRoomMetaSyncAt = 0;
let migrationSwitchInFlight = false;
// Public-server Firebase room: the host ALSO writes room.mapSignature on a
// periodic cadence (mirroring the private-room HOST_ROOM_META_SYNC_MS above) so a
// joiner whose 220ms poll lands BEFORE our next poll still sees the host map
// without depending on a single lucky PATCH. The 220ms poll itself owns the
// real-time position/cosmetics mirror (see syncMultiplayerTransforms)。

// --- Public servers state -------------------------------------------------
// A public server is a fixed PeerJS room (code, e.g. PUBSV1). Everyone who
// joins is connected over WebRTC (PeerJS uses the TURN server in `peerConfig`)
// and shares the host's current map:
//   • Host election is PeerJS-native: the first player to claim the
//     RACE-ROOM-<code> peer id becomes the host; joiners connect to it. If the
//     host disappears, a joiner detects the dead connection and reclaims the id
//     (self-healing).
//   • The host grants NO in-game privileges — it only relays peer packets (so
//     everyone sees everyone) and sends a MAP_SYNC packet so joiners redirect to
//     the map everyone else is on. It is hidden from the UI.
//   • There is NO round timer, NO deterministic track rotation, NO rankings, and
//     NO backend worker. The only network dependency is the read-only track
//     share board (GET /api/tracks), used by the map-vote to look up a pasted
//     track URL's name.
//   • Map switching is driven by a peer vote: a player pastes a track URL, the
//     board is searched for its name, everyone votes Yes/No, and after 30s a
//     >60% Yes majority switches the track (the initiator redirects first and
//     broadcasts a VOTE_RESULT so everyone else follows).
const publicServerState = {
	active: false,		// currently connected to a public server?
	serverId: '',		// 'server-1' | 'server-2' | 'server-3'
	isHost: false,		//are we the PeerJS host peer? (hidden; no privileges)
	claimedHost: false,	//have we successfully claimed host this session?
	peerMaintainTimer: null,	//loop (5s) that restarts a dead PeerJS peer + self-heals host
	joinerConnectWatch: null,	//one-shot timeout that proactively recovers a stuck joiner connect
	hostClaimInFlight: false,	//guard against concurrent host-claim attempts
	trackListCache: null,	//cached community-track list (for the vote lookup)
	trackListCacheAt: 0,	//local time the cache was fetched
	loadedMapSignature: '',	//mapSignature we redirected onto (anti-loop guard)
	// --- joiner handshake persistence (no-backend reliability) ---------
	// A joiner whose data channel to the host hasn't opened yet must NOT be
	// destroyed by the recovery loop — killing a live handshake every 5s is
	// what made a slow-but-fine WebRTC negotiation loop forever. Instead we keep
	// the connection object, track when it was born, and give it quiet retry
	// attempts (ICE restart + fresh datachannel) until it opens or truly dies.
	// `handshakeStartedAt` is the timestamp of the LAST brand-new connect attempt;
	// `connectingDataChannel` is the live (possibly unopened) Peer.DataConnection
	// so recovery code can inspect it instead of assuming "no connection = dead".
	handshakeStartedAt: 0,
	connectingDataChannel: null,	//live joiner datachannel (open or mid-handshake)
	iceRetryTimer: null,	//quiet ICE/(re)connect retry timer for ag slow handshake
	lastReclaimProbeAt: 0,		//throttle host-claim probes; last attempt (ms)
};

// sessionStorage key recording the mapSignature we already redirected onto. It
// survives the reload that follows a redirect so we can tell "I'm already on
// the host's map — don't redirect again" and avoid a redirect loop.
const PUBSRV_LOADED_MAP_KEY = 'pubsrv_loaded_map';

function getLoadedPublicServerMapFromStorage() {

	try { return String( sessionStorage.getItem( PUBSRV_LOADED_MAP_KEY ) || '' ); }
	catch { return ''; }

}

function setLoadedPublicServerMapInStorage( sig ) {

	try { sessionStorage.setItem( PUBSRV_LOADED_MAP_KEY, String( sig || '' ) ); }
	catch {}

}

function clearLoadedPublicServerMapFromStorage() {

	try { sessionStorage.removeItem( PUBSRV_LOADED_MAP_KEY ); }
	catch {}

}

// --- Public-server player count ---------------------------------------------
//
// There is no backend worker, so the "players in the server" count is derived
// from the PeerJS mesh itself: every peer we've heard a packet from (playerId
// in STATE / VOTE / etc.) counts, plus ourselves. Player ids age out after
// PLAYER_PRESENCE_MS of silence (dropped peers, crshed tabs) so the number
// trends toward the current population instead of ratcheting up forever. The
// count refreshes on each change and on the 5s maintenance tick.

const publicServerPlayers = new Map();   // playerId -> lastSeenAt (ms)
const PLAYER_PRESENCE_MS = 15000;

function touchPublicServerPlayer( playerId ) {

		const id = String( playerId || '' );
		if ( ! id || ! isPublicServerActive() ) return;
		publicServerPlayers.set( id, Date.now() );
		updatePublicServerPlayerCount();

}

function forgetPublicServerPlayer( playerId ) {

		if ( publicServerPlayers.delete( String( playerId || '' ) ) ) updatePublicServerPlayerCount();

}

// Drop players we haven't heard from in PLAYER_PRESENCE_MS. Called from the
// 5s maintenance tick and after every touch (cheap sweep).
function cullPublicServerPlayers() {

		if ( publicServerPlayers.size === 0 ) return;
		const now = Date.now();
		let changed = false;
		for ( const [ id, last ] of publicServerPlayers ) {

				if ( now - last > PLAYER_PRESENCE_MS ) {

						publicServerPlayers.delete( id );
						changed = true;

				}

		}
		if ( changed ) updatePublicServerPlayerCount();

}

function resetPublicServerPlayers() {

		publicServerPlayers.clear();
		updatePublicServerPlayerCount();

}

function updatePublicServerPlayerCount() {

		const el = document.getElementById( 'mp-player-count' );
		if ( ! el ) return;
		if ( ! isPublicServerActive() ) {

				el.style.display = 'none';
				return;

		}
		let n = publicServerPlayers.size;
		// Include ourselves.
		const ourId = multiplayerSessionState.clientId;
		if ( ourId && ! publicServerPlayers.has( ourId ) ) n += 1;
		el.textContent = `Players: ${ n }`;
		el.style.display = 'block';

}

function isPublicServerActive() {

	return Boolean( publicServerState.active && publicServerState.serverId );

}

function publicServerRoomCode() {

	const def = findPublicServer( publicServerState.serverId );
	return def ? def.code : '';

}

function publicServerName() {

	const def = findPublicServer( publicServerState.serverId );
	return def ? def.name : 'Public server';

}


function setMultiplayerLeaderboardVisible( visible ) {

	const container = document.getElementById( 'mp-lb' );
	if ( ! container ) return;
	container.style.display = visible ? 'block' : 'none';

}

function renderMultiplayerRoomLeaderboard( lapTimes ) {

	const listEl = document.getElementById( 'mp-lb-list' );
	if ( ! listEl ) return;
	const entries = lapTimes && typeof lapTimes === 'object' ? Object.entries( lapTimes ) : [];
	const rows = entries.map( ( [ id, row ] ) => {

		const time = Number( row?.time ?? row?.bestLap ?? row?.bestLapSeconds );
		const name = typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : `Player ${ String( id || '' ).slice( 0, 4 ).toUpperCase() }`;
		return { id, name, time };

	} ).filter( ( row ) => Number.isFinite( row.time ) );
	rows.sort( ( a, b ) => a.time - b.time );
	listEl.innerHTML = '';
	if ( rows.length === 0 ) {

		const li = document.createElement( 'li' );
		li.textContent = 'No room laps yet.';
		listEl.appendChild( li );
		return;

	}
	for ( const row of rows.slice( 0, 8 ) ) {

		const li = document.createElement( 'li' );
		li.textContent = `${ row.name } — ${ formatLapTime( row.time ) }`;
		listEl.appendChild( li );

	}

}

function getLocalMultiplayerDisplayName() {

	const storedName = sanitizePlayerName( localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	return storedName || `Player ${ multiplayerSessionState.clientId.slice( 0, 4 ).toUpperCase() }`;

}

function normalizeMultiplayerCarKey( value ) {

	const key = typeof value === 'string' ? value.trim() : '';
	if ( CAR_STATS[ key ] && models[ key ] ) return key;
	const lower = key.toLowerCase();
	const fallbackByName = {
		yellow: 'vehicle-truck-yellow',
		green: 'vehicle-truck-green',
		purple: 'vehicle-truck-purple',
		red: 'vehicle-truck-red',
		hatchback: 'vehicle-hatchback-green',
		sedan: 'vehicle-sedan-orange',
		police: 'vehicle-car-police',
		delivery: 'vehicle-delivery-yellow',
		flatbed: 'vehicle-flatbed-purple',
		blue: 'vehicle-van-blue',
		firetruck: 'vehicle-firetruck-red',
		'fire truck': 'vehicle-firetruck-red',
		trash: 'vehicle-trash-green',
		'trash truck': 'vehicle-trash-green',
		taxi: 'vehicle-taxi-yellow',
		ambulance: 'vehicle-ambulance-red',
		tractor: 'vehicle-tractor-yellow',
		'trail pickup': 'vehicle-truck-yellow',
		'utility pickup': 'vehicle-truck-green',
		'stakebed truck': 'vehicle-truck-red',
		'stake bed': 'vehicle-truck-red',
		'cargo van': 'vehicle-truck-purple',
		'panel van': 'vehicle-van-blue',
		'flatbed truck': 'vehicle-flatbed-purple',
	};
	return fallbackByName[ lower ] || 'vehicle-truck-yellow';

}

async function maybeSubmitOnlinePersonalBest( lapTimes ) {

	if ( ! lapTimes || typeof lapTimes !== 'object' ) return;
	const localName = sanitizePlayerName( playerNameInput?.value || localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	if ( ! localName ) return;
	const encodedClientId = encodeURIComponent( multiplayerSessionState.clientId );
	const localRow = lapTimes[ encodedClientId ] || lapTimes[ multiplayerSessionState.clientId ] || null;
	const ownTime = Number( localRow?.time ?? localRow?.bestLap ?? localRow?.bestLapSeconds );
	const matchingRows = Object.values( lapTimes ).filter( ( row ) => sanitizePlayerName( row?.name ) === localName );
	const bestByName = matchingRows.length > 0
		? Math.min( ...matchingRows.map( ( row ) => Number( row?.time ?? row?.bestLap ?? row?.bestLapSeconds ) ).filter( Number.isFinite ) )
		: Infinity;
	const bestOnlineTime = Number.isFinite( ownTime ) ? ownTime : bestByName;
	if ( ! Number.isFinite( bestOnlineTime ) ) return;
	if ( Number.isFinite( bestLapSeconds ) && bestOnlineTime >= bestLapSeconds - 1e-6 ) return;
	if ( Number.isFinite( lastSyncedOnlineBestLapSeconds ) && bestOnlineTime >= lastSyncedOnlineBestLapSeconds - 1e-6 ) return;
	bestLapSeconds = bestOnlineTime;
	shareImageDataUrl = createShareSnapshot( bestLapSeconds );
	updateLapHud();
	saveLapStats();
	if ( ! accountSession?.token ) {

		showTopMessage( 'Log in to submit your online PB to the global leaderboard.', true, 2600 );
		setModeMenuOpen( true );
		setModeTab( 'account' );

	}
	await submitLeaderboardTime( bestOnlineTime, localName );
	lastSyncedOnlineBestLapSeconds = bestOnlineTime;

}

async function publishMultiplayerBestLap( bestLap ) {

	if ( ! Number.isFinite( bestLap ) ) return;
	const displayName = getLocalMultiplayerDisplayName();

	// Public servers have no private-room lap-time store, so on a public server
	// this is a no-op (a world record still submits to the OFFICIAL leaderboard
	// via the isNewBest path in the lap-finish handler — submitLeaderboardTime is
	// independent of this). Normal host/join private rooms write to Firebase.
	const roomCode = multiplayerSessionState.roomCode;
	if ( ! roomCode || isPublicServerActive() ) return;
	try {

		await writeRoomSubkey( roomCode, `lapTimes/${ encodeURIComponent( multiplayerSessionState.clientId ) }`, {
		name: displayName,
		time: Number( bestLap ),
		bestLapSeconds: Number( bestLap ),
		updatedAt: Date.now(),
		} );

	} catch ( error ) {

		console.warn( 'Failed to publish multiplayer best lap', error );

	}

}

function getCurrentMapSignature() {

	const params = new URLSearchParams( window.location.search );
	return `${ params.get( 'map' ) || 'default' }|${ params.get( 'mods' ) || 'none' }`;

}

function parseMapSignature( mapSignature ) {

	const raw = String( mapSignature || '' );
	if ( ! raw ) return { map: 'default', mods: 'none' };
	const splitAt = raw.indexOf( '|' );
	if ( splitAt < 0 ) return { map: raw || 'default', mods: 'none' };
	return {
		map: raw.slice( 0, splitAt ) || 'default',
		mods: raw.slice( splitAt + 1 ) || 'none',
	};

}

function redirectToRoomMap( roomCode, mapSignature ) {

	const target = parseMapSignature( mapSignature );
	const params = new URLSearchParams( window.location.search );
	params.set( 'map', target.map );
	if ( target.mods === 'none' ) {

		params.delete( 'mods' );

	} else {

		params.set( 'mods', target.mods );

	}
	params.set( 'joinRoom', String( roomCode || '' ).trim().toUpperCase() );
	window.location.search = params.toString();

}


// --- Public server join / map-vote ---------------------------------------

// How long (ms) the vote stays open on the initiator's device before the
// result is tallied and broadcast. Everyone's prompt hides on the initiator's
// VOTE_RESULT packet (or a local fallback timeout if it never arrives).
const PUBLIC_SERVER_VOTE_DURATION_MS = 30000;
// A vote passes if strictly more than 60% of the cast votes are "yes" (and at
// least one vote was cast). Otherwise the track is not switched.
const PUBLIC_SERVER_VOTE_PASS_RATIO = 0.60;

function buildPublicServerButtons() {

	if ( ! PUBLIC_SERVERS_UI_ENABLED ) return;
	const container = document.getElementById( 'mp-public-buttons' );
	if ( ! container ) return;
	container.innerHTML = '';
	const configured = isPublicServerConfigured();
	for ( const server of PUBLIC_SERVERS ) {

		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.dataset.serverId = server.id;
		btn.textContent = `${ server.name }`;
		btn.title = `Join the ${ server.name } public server`;
		if ( ! configured ) {

			btn.disabled = true;
			btn.title = 'Public servers are not connected yet.';

		}
		btn.addEventListener( 'click', () => joinPublicServer( server.id ) );
		container.appendChild( btn );

	}
	if ( ! configured ) {

		const note = document.createElement( 'div' );
		note.style.cssText = 'font:600 10px/1.3 sans-serif;opacity:0.7;width:100%;';
		note.textContent = 'Public servers need the track share board + PeerJS signalling.';
		container.appendChild( note );

	}

	// Wire the Leave button (shown/hidden via updatePublicServerButtonStates).
	const leaveBtn = document.getElementById( 'mp-public-leave-btn' );
	if ( leaveBtn && ! leaveBtn.dataset.wired ) {

		leaveBtn.dataset.wired = '1';
		leaveBtn.addEventListener( 'click', () => {

			const name = publicServerName() || 'public server';
			leavePublicServer();
			updateMultiplayerStatus( `Left ${ name }.` );

		} );

	}

	// Wire the "Select track" propose-vote row (shown only while on a public
	// server, via updatePublicServerButtonStates).
	const proposeBtn = document.getElementById( 'mp-pubtrack-btn' );
	if ( proposeBtn && ! proposeBtn.dataset.wired ) {

		proposeBtn.dataset.wired = '1';
		proposeBtn.addEventListener( 'click', () => startPublicServerVoteFromInput() );

	}

	// Wire the vote-prompt Yes/No buttons (created once here; the prompt is
	// shown/hidden as votes start/end).
	const voteYesBtn = document.getElementById( 'mp-vote-yes' );
	const voteNoBtn = document.getElementById( 'mp-vote-no' );
	if ( voteYesBtn && ! voteYesBtn.dataset.wired ) {

		voteYesBtn.dataset.wired = '1';
		voteYesBtn.addEventListener( 'click', () => castPublicServerVote( 'yes' ) );

	}
	if ( voteNoBtn && ! voteNoBtn.dataset.wired ) {

		voteNoBtn.dataset.wired = '1';
		voteNoBtn.addEventListener( 'click', () => castPublicServerVote( 'no' ) );

	}

}

function updatePublicServerButtonStates() {

	if ( ! PUBLIC_SERVERS_UI_ENABLED ) return;
	const buttons = document.querySelectorAll( '#mp-public-buttons button[data-server-id]' );
	buttons.forEach( ( btn ) => {

		const id = btn.dataset.serverId;
		const isThis = isPublicServerActive() && publicServerState.serverId === id;
		btn.disabled = isPublicServerActive() && ! isThis;
		btn.textContent = isThis ? `✓ ${ findPublicServer( id )?.name || '' }` : `${ findPublicServer( id )?.name || '' }`;

	} );
	// Show the Leave button only while connected to a public server.
	const leaveBtn = document.getElementById( 'mp-public-leave-btn' );
	if ( leaveBtn ) leaveBtn.style.display = isPublicServerActive() ? 'block' : 'none';
	// Show the propose-vote row only while connected to a public server.
	const pubTrackRow = document.getElementById( 'mp-pubtrack-row' );
	if ( pubTrackRow ) pubTrackRow.style.display = isPublicServerActive() ? 'flex' : 'none';

}

async function joinPublicServer( serverId ) {

	const def = findPublicServer( serverId );
	if ( ! def ) return;

	// Leave any existing session (public or private) first.
	await leavePublicServer();
	if ( multiplayerSessionState.peer || multiplayerSessionState.roomCode ) {

		closeMultiplayerPeer();
		multiplayerSessionState.role = 'none';
		multiplayerSessionState.roomCode = '';

	}

	updateMultiplayerStatus( `Joining ${ def.name }…` );
	publicServerState.active = true;
	publicServerState.serverId = serverId;
	resetPublicServerPlayers();
	touchPublicServerPlayer( multiplayerSessionState.clientId );
	publicServerState.isHost = false;
	publicServerState.claimedHost = false;
	publicServerState.hostClaimInFlight = false;
	publicServerState.trackListCache = null;
	publicServerState.trackListCacheAt = 0;
	publicServerState.loadedMapSignature = getLoadedPublicServerMapFromStorage();
	publicServerState.handshakeStartedAt = 0;
	publicServerState.connectingDataChannel = null;
	publicServerState.lastReclaimProbeAt = 0;
	clearPublicServerIceRetry();
	resetPublicServerVoteState();
	updatePublicServerButtonStates();

	try {
const hasFirebase = hasFirebaseMultiplayerConfig();
		if ( hasFirebase ) {
			// We deliberately SKIP the PeerJS mesh:the mesh's host-claim race was the
			// death of half of joiners, and all of its payload modes (position/left/
			// map/vote) are covered by the Firebase room doc. The 220ms poll
			// (syncMultiplayerTransforms, ALWAYS armed) handles our position mirror,
			// remote visuals, live player count, host map following,the map vote doc,
			// and host metadata — once the roomCode is set below.

			// Deterministic host election over the Firebase room doc:the LOWEST clientId
			// among players currently in the room (plus us) is the host. No host-claim
			// race,no 4s timeout, no ghost host. Firebase is the single source of truth.
			const now = Date.now();
			const ourId = multiplayerSessionState.clientId;
			const localContainer = getLocalVehicleContainer();
			const localCarKey = normalizeMultiplayerCarKey( typeof localMultiplayerStateHandlers.getCarKey === 'function' ? localMultiplayerStateHandlers.getCarKey() : getModuleCarKey() );
			const localPayload = {
				x: Number( ( localContainer?.position.x ||0 ).toFixed( 3 ) ),
				y: Number( ( localContainer?.position.y ||0 ).toFixed( 3 ) ),
				z: Number( ( localContainer?.position.z ||0 ).toFixed( 3 ) ),
				ry: Number( getMultiplayerHeadingDegrees( localContainer ).toFixed( 2 ) ),
				carKey: localCarKey,
				cosmetics: typeof localMultiplayerStateHandlers.buildCosmetics === 'function' ? localMultiplayerStateHandlers.buildCosmetics( localCarKey ) : null,
				name: getLocalMultiplayerDisplayName(),
				mapSignature: getCurrentMapSignature(),
				updatedAt: now,
			};
			await writeRoomSubkey( def.code, `players/${ encodeURIComponent( ourId ) }`, localPayload );
			const room = await firebaseRoomsRequest( def.code,'GET' );
			const players = room?.players && typeof room.players === 'object' ? room.players : {};
			let lowestId = ourId;
			for ( const pid of Object.keys( players ) ) {
				if ( pid < lowestId ) lowestId = pid;
			}
			publicServerState.isHost = lowestId === ourId;
			if ( publicServerState.isHost ) {
				multiplayerSessionState.role = 'host';
				await firebaseRoomsRequest( def.code,'PATCH',{
					mapSignature: getCurrentMapSignature(),
					status: 'hosting',
					updatedAt: now,
				} );
				lastPublicServerRoomMetaSyncAt = now;
			} else {
				multiplayerSessionState.role = 'join';
				const hostSig = room?.mapSignature || getCurrentMapSignature();
				if ( ! canJoinMap( hostSig, getCurrentMapSignature() ) ) {
					updateMultiplayerStatus( `Switching to the host map for ${ def.name }...` );
					redirectPublicServerToMap( hostSig,'host' );
					await resetPublicServerState();
					return;
				}
			}
			const codeInput = document.getElementById( 'mp-code-input' );
			if ( codeInput ) codeInput.value = def.code;
			multiplayerSessionState.roomCode = def.code;
			setMultiplayerLeaderboardVisible( false );
			updateMultiplayerStatus( `In ${ def.name }. You'll load the map everyone is on.` );
			logMpDebug( `[PublicServer] Joined ${ def.name } (code ${ def.code }) as ${ publicServerState.isHost ? 'host' : 'joiner' }` );
		} else {
			// Reuse the existing PeerJS room mechanism with the fixed server code.

			// The host peer owns the RACE-ROOM-<code> id; joiners connect to it. Host
			// election is PeerJS-native (see startPublicServerPeer) — no worker..
			multiplayerSessionState.roomCode = def.code;
			const codeInput = document.getElementById( 'mp-code-input' );
			if ( codeInput ) codeInput.value = def.code;
			// Try to claim the host seat first; if the id is taken we fall back to
			// joiner. Either way we end up in the same PeerJS room。
			await startPublicServerPeer( def.code );
			// The private-room leaderboard is unused in public servers。
			setMultiplayerLeaderboardVisible( false );
			updateMultiplayerStatus( `In ${ def.name }. You'll load the the map everyone is on.` );
			logMpDebug( `[PublicServer] Joined ${ def.name } (code ${ def.code }) as ${ publicServerState.isHost ? 'host' : 'joiner' }` );
			// Maintenance loop: restart a dead PeerJS peer + self-heal host.. Runs every
			// 5s (was 10s) so a joiner whose connection never opened — e.g.. the host
			// peer id was briefly reserved on the PeerJS cloud by a player who then
			// left, leaving a "ghost" host — recovers (reclaims host or retries the
			// connect) within a few seconds instead of hanging for 10s.
			stopPublicServerMaintainLoop();
			publicServerState.peerMaintainTimer = setInterval( maintainPublicServerPeer, 5000 );
			// Proactive joiner connect-watch: if WE are a joiner and our first
			// connection to the host hasn't opened after a patient window (PeerJS cloud
			// signalling can be slow, or the host id was a ghost), don't wait for the
			// next 5s maintenance tick — run one immediate recovery pass (which,
			// thanks to findPublicServerLiveJoinerConnection, still never kills a
			// slow-but-live WebRTC handshake; it only acts when nothing is live)。
			schedulePublicServerJoinerConnectWatch();
		}
		// The 220 ms Firebase poll (syncMultiplayerTransforms, always armed)
		// now handles: our position mirror,the live player count,host map following,
		//the map vote doc,and host metadata. There is nothing left for WebRTC to do.
		} catch ( error ) {

		console.warn( 'Failed to join public server', error );
		updateMultiplayerStatus( `Could not join ${ def.name }: ${ error?.message || error }` );
		await resetPublicServerState();

	}

}

async function leavePublicServer() {

	if ( ! isPublicServerActive() ) return;
	stopPublicServerMaintainLoop();
	hidePublicServerVotePrompt();
	resetPublicServerVoteState();
	// Tell peers we left (PeerJS LEFT packet) + tear down the WebRTC mesh. There
	// is no backend membership to clear — leaving is purely a PeerJS action.
	if ( multiplayerSessionState.peer || multiplayerSessionState.roomCode ) {

		closeMultiplayerPeer();
		// On the Firebase path, clearing our players/<uid> entry keeps the room
		// roster fresh (the 220ms poll only hides stale MESH visuals, not the db)。
		if ( hasFirebaseMultiplayerConfig() && multiplayerSessionState.roomCode ) {


			const leavePatch = { };
			leavePatch.players = { };
			leavePatch.players[ String( multiplayerSessionState.clientId ).replace( /[.\/#\$\u005B\u005D\u0000-\u001F\u007F]/g, '_' ) ] = null;
			firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PATCH', leavePatch ).catch( ( ) => {} );

		}
		multiplayerSessionState.role = 'none';
		multiplayerSessionState.roomCode = '';
		const codeInput = document.getElementById( 'mp-code-input' );
		if ( codeInput ) codeInput.value = '';
		setMultiplayerLeaderboardVisible( false );

	}
	await resetPublicServerState();

}

async function resetPublicServerState() {

	stopPublicServerMaintainLoop();
	publicServerState.active = false;
	publicServerState.serverId = '';
	publicServerState.isHost = false;
	publicServerState.claimedHost = false;
	publicServerState.hostClaimInFlight = false;
	publicServerState.trackListCache = null;
	publicServerState.trackListCacheAt = 0;
	publicServerState.loadedMapSignature = '';
	publicServerState.handshakeStartedAt = 0;
	publicServerState.connectingDataChannel = null;
	publicServerState.lastReclaimProbeAt = 0;
	clearLoadedPublicServerMapFromStorage();
	resetPublicServerPlayers();
	updatePublicServerButtonStates();
}


function stopPublicServerMaintainLoop() {

	if ( publicServerState.peerMaintainTimer ) {

		clearInterval( publicServerState.peerMaintainTimer );
		publicServerState.peerMaintainTimer = null;

	}
	if ( publicServerState.joinerConnectWatch ) {

		clearTimeout( publicServerState.joinerConnectWatch );
		publicServerState.joinerConnectWatch = null;

	}
	clearPublicServerIceRetry();
}


// Proactive joiner connect-watch: after a patient window (~12s) of a still-
// connecting data channel, if we still have zero OPEN connections, only then
// consider recovery. The key fix: a WebRTC handshake that is merely SLOW (tens
// of seconds, e.g. strict NAT + TURN relay setup) must NEVER be destroyed by
// this watch —that is what made the original logs loop forever (kill a live
// handshake every 5s). Instead the quiet ICE retry (startPublicServerIceRetry)
// keeps poking the same live connection, and only a truly dead peer (no live
// connecting datachannel / peer destroyed/disconnected) triggers a reclaim/rejoin.
function schedulePublicServerJoinerConnectWatch() {

	if ( publicServerState.joinerConnectWatch ) clearTimeout( publicServerState.joinerConnectWatch );
	publicServerState.joinerConnectWatch = setTimeout( () => {

		publicServerState.joinerConnectWatch = null;
		if ( ! isPublicServerActive() || publicServerState.isHost ) return;
		if ( ! findPublicServerLiveJoinerConnection( ) ) {
			logMpDebug( '[PublicServer] Joiner has no connection after patient window — recovering' );
			maintainPublicServerPeer();
		}

	}, 12000 );
}

// A "live joiner channel" = a Peer.DataConnectionthat has either OPENED (it is
// in multiplayerSessionState.connections) or is STILL CONNECTING (we hold it in
// publicServerState.connectingDataChannel). If neither exists, the join is genuinely
// stalled/dead and recovery is OK to run.
function findPublicServerLiveJoinerConnection() {

	if ( publicServerState.isHost ) return true;
	if ( multiplayerSessionState.connections.size > 0 ) return true;
	const live = publicServerState.connectingDataChannel;
	return Boolean( live && ! live.closed && ! ( live.peerConnection && live.peerConnection.connectionState === 'failed' ) );
}

// Quiet ICE retry for ag slow public-server joiner handshake: every retry tick we
// ask PeerJS/WebRTC to restart ICE (new candidates, new relay attempts, no new
// backends). If the underlying RTCPeerConnection reports failed/gone we re-issue
// the retry only while our live channel object still exists — so we never destroy
// anything else (the recovery loop can still clean up ifthe peer truly died).
const PUBLIC_SERVER_ICE_RETRY_MS = 10000;
function startPublicServerIceRetry( connection ) {

	clearPublicServerIceRetry();
	if ( ! connection ) return;
	const tick = () => {
		if ( ! isPublicServerActive() || publicServerState.isHost ) return;
		if ( connection.closed || ( connection.peerConnection && connection.peerConnection.connectionState === 'failed' ) ) return;
		if ( ! publicServerState.connectingDataChannel || publicServerState.connectingDataChannel.peer !== connection.peer ) return;
		logMpDebug( '[PublicServer] Joiner data channel still connecting — restarting ICE' );
		if ( connection.open ) { clearPublicServerIceRetry(); return; }
		try { connection.peerConnection?.restartIce?.(); } catch {}
		publicServerState.iceRetryTimer = setTimeout( tick,PUBLIC_SERVER_ICE_RETRY_MS );
	};
	publicServerState.iceRetryTimer = setTimeout( tick,PUBLIC_SERVER_ICE_RETRY_MS );
}

function clearPublicServerIceRetry() {

	if ( publicServerState.iceRetryTimer ) {
		clearTimeout( publicServerState.iceRetryTimer );
		publicServerState.iceRetryTimer = null;
	}
}


// --- Map sync (host tells joiners which map everyone is on) ---------------
//
// When a joiner connects, the host sends a MAP_SYNC packet with its current
// mapSignature. The joiner redirects to it (rejoining the server) if it differs
// from the map they're on. The host also broadcasts MAP_SYNC after its own map
// changes (e.g. a winning vote) so everyone follows. There is no loop: after a
// redirect the page reloads on the host's map, so sig === current → no redirect.
// The sessionStorage flag is a belt-and-braces guard against re-redirecting.

function broadcastPublicServerMapSync( onlyConnection = null ) {

	if ( ! isPublicServerActive() || ! publicServerState.isHost ) return;
	if ( ! multiplayerSessionState.peer ) return;
	const packet = {
		type: PEER_PACKET_MAP_SYNC,
		playerId: multiplayerSessionState.clientId,
		mapSignature: getCurrentMapSignature(),
	};
	const targets = onlyConnection ? [ onlyConnection ] : [ ...multiplayerSessionState.connections.values() ];
	for ( const connection of targets ) {

		if ( connection && connection.open ) {

			try { connection.send( packet ); } catch {}

		}

	}

}

function onPublicServerMapSync( packet ) {

	if ( ! isPublicServerActive() ) return;
	const sig = String( packet?.mapSignature || '' );
	if ( ! sig ) return;
	redirectPublicServerToMap( sig, 'host' );

}

// Redirect THIS client to `sig` on the public server (rejoining via ?pubServer).
// Skipped if we're already on that map, or if we already redirected onto it
// (sessionStorage guard) — this is the anti-loop guarantee.
function redirectPublicServerToMap( sig, reason = 'host' ) {

	if ( ! isPublicServerActive() ) return;
	if ( ! sig ) return;
	if ( sig === getCurrentMapSignature() ) {

		publicServerState.loadedMapSignature = sig;
		setLoadedPublicServerMapInStorage( sig );
		return;

	}
	if ( publicServerState.loadedMapSignature === sig ) return;
	setLoadedPublicServerMapInStorage( sig );
	publicServerState.loadedMapSignature = sig;
	const playUrl = new URL( window.location.href );
	playUrl.searchParams.set( 'map', ( sig.split( '|' )[ 0 ] || 'default' ) );
	const mods = sig.split( '|' )[ 1 ] || 'none';
	if ( mods && mods !== 'none' ) playUrl.searchParams.set( 'mods', mods );
	const url = buildServerTrackRedirectUrl( playUrl.toString(), publicServerState.serverId );
	updateMultiplayerStatus( `Loading the ${ reason } map for ${ publicServerName() }…` );
	window.location.href = url;

}

// --- PeerJS-native host election + P2P mesh ------------------------------
//
// Host election without a backend: the first player to claim the
// RACE-ROOM-<code> peer id becomes the host; joiners connect to it. If the id
// is already taken (another player is host), PeerJS fires an 'unavailable-id'
// error → we become a joiner instead. If the host later disappears, joiners
// detect their dead connection to the host and reclaim the id (self-healing).
// The host grants NO in-game privileges — it only relays peer packets (so all
// peers see each other) and sends the MAP_SYNC packet.

// Try to claim the host peer id; if taken, fall back to joiner. Resolves once
// the peer is open (host) or once we've started connecting to the host (joiner).
function startPublicServerPeer( roomCode ) {

	return new Promise( ( resolve ) => {

		if ( ! isPublicServerActive() ) { resolve(); return; }
		const hostPeerId = getPeerRoomId( roomCode );
		closeMultiplayerPeer();
		logMpDebug( `[PublicServer] Trying to claim host peer id ${ hostPeerId }…` );
		const peer = new Peer( hostPeerId, peerConfig );
		multiplayerSessionState.peer = peer;
		let settled = false;
		const becomeHost = () => {

			if ( settled ) return;
			settled = true;
			publicServerState.isHost = true;
			publicServerState.claimedHost = true;
			multiplayerSessionState.role = 'host';
			applyPublicServerRoleToConnections( roomCode, 'host' );
			resolve();

		};
		const becomeJoiner = () => {

			if ( settled ) return;
			settled = true;
			// Re-create the peer with our own client id (the host-id claim failed).
			closeMultiplayerPeer();
			publicServerState.isHost = false;
			multiplayerSessionState.role = 'join';
			applyPublicServerRoleToConnections( roomCode, 'join' );
			resolve();

		};

		peer.on( 'open', ( id ) => {

			// We got the host id → we are the host.
			if ( id === hostPeerId ) {

				logMpDebug( `[PublicServer] Claimed host peer id ${ hostPeerId }` );
				becomeHost();
				return;

			}
			// PeerJS assigned us a different id (shouldn't happen when we request a
			// specific id, but handle it) → treat as joiner.
			becomeJoiner();

		} );
		peer.on( 'connection', ( connection ) => {

			// A joiner connected to us (host). Register + relay their packets, and
			// immediately tell them which map everyone is on (MAP_SYNC).
			logMpDebug( `[PublicServer] Host received connection from ${ connection.peer }` );
			connection.on( 'open', () => {

				registerPeerConnection( connection );
				broadcastPeerState();
				broadcastPublicServerMapSync( connection );

			} );
			connection.on( 'error', ( error ) => logMpDebug( `[PublicServer] Connection error: ${ error?.message || error }` ) );

		} );
		peer.on( 'error', ( error ) => {

			const type = error?.type || '';
			// 'unavailable-id' = someone else already owns RACE-ROOM-<code> → join.
			if ( type === 'unavailable-id' ) {

				logMpDebug( `[PublicServer] Host id taken — joining as guest` );
				becomeJoiner();
				return;

			}
			logMpDebug( `[PublicServer] Peer error: ${ type } ${ error?.message || '' }` );
			// For other errors, if we haven't settled yet, fall back to joiner so the
			// player still gets into the room (the maintenance loop will keep trying).
			if ( ! settled ) becomeJoiner();

		} );
		peer.on( 'disconnected', () => logMpDebug( `[PublicServer] Peer disconnected: ${ hostPeerId }` ) );
		peer.on( 'close', () => logMpDebug( `[PublicServer] Peer closed: ${ hostPeerId }` ) );

		// Safety: if neither 'open' nor 'unavailable-id' fires in 4s (PeerJS cloud
		// signalling can be slow), assume the host id is taken and become a joiner
		// (the joiner connect-watch + maintenance loop will recover if wrong).
		setTimeout( () => { if ( ! settled ) becomeJoiner(); }, 4000 );

	} );

}

// Apply the resolved role (host/joiner) by setting up the PeerJS connections.
// For a joiner this connects to the host peer id; for a host it just waits for
// incoming connections (already wired in startPublicServerPeer). Reuses the
// existing startPeerMultiplayer infra for the joiner path so packet handling is
// identical to private rooms.
function applyPublicServerRoleToConnections( roomCode, role ) {

	if ( role === 'host' ) {

		// Host already listens for incoming connections in startPublicServerPeer.
		// Nothing more to do — registerPeerConnection handles joiners as they arrive.
		return;

	}
	// Joiner: connect to the host peer id. Reuse startPeerMultiplayer's joiner
	// path so the data-channel + packet handling is identical to private rooms.
	startPeerMultiplayer( roomCode, 'join' );

}

// If a public-server joiner has a live connecting channel that has been stuck for
// a LONG time (well past the patient ICE-retry window), the channel is almost
// certainly wedged at the transport level (e.g. PeerJS cloud dropped the SDP/ICE
// midway). Give it ONE gentle fresh rejoin — note: ONLY after the channel really
// has had every chance (35s of quiet ICE restarts, not blink-and-die every 5s).
const PUBLIC_SERVER_STUCK_CHANNEL_MS = 35000;
// If our PeerJS peer died (PeerJS cloud signalling drops happen), restart it in
// the current role. For a joiner whose host disappeared, attempt to reclaim the
// host id (self-healing., debounced via hostClaimInFlight + lastReclaimProbeAt).
// A live still-connecting datachannel is NEVER destroyed:the watch + reclaim both
// consult findPublicServerLiveJoinerConnection() first so slow-but-fine WebRTC
// handshakes get all the time they need to finish (that was the original 5s-kill bug).
function maintainPublicServerPeer() {

	if ( ! isPublicServerActive() ) return;
	cullPublicServerPlayers();
	const roomCode = publicServerRoomCode();
	if ( ! roomCode ) return;
	const peer = multiplayerSessionState.peer;

	// Patient-but-guaranteed final recovery: if we are a joiner whose live
	// connecting channel never opened within a HUGE window, drop it ta ONE fresh
	// rejoin (which re-claims the host id if it's actually free, else reconnects).
	if ( peer && ! peer.destroyed && ! peer.disconnected && ! publicServerState.isHost ) {

		const liveConn = publicServerState.connectingDataChannel;
		if ( liveConn && ! liveConn.closed && ! multiplayerSessionState.connections.has( liveConn.peer ) && publicServerState.handshakeStartedAt > 0 ) {

			if ( ( Date.now() - publicServerState.handshakeStartedAt ) > PUBLIC_SERVER_STUCK_CHANNEL_MS ) {

				logMpDebug( '[PublicServer] Joiner channel stuck >35s — one fresh rejoin' );
				closeMultiplayerPeer();
				publicServerState.handshakeStartedAt = 0;
				publicServerState.connectingDataChannel = null;
				clearPublicServerIceRetry();
				applyPublicServerRoleToConnections( roomCode, 'join' );
				return;

			}

		}

	}


	// Peer still alive → nothing to do. But if we're a joiner whose connection to the
	// host has NOT opened yet AND no live connecting datachannel exists (the host
	// peer id was a ghost, or the host vanished before ICE finished), only then probe
	// to reclaim the host id. A live, still-connecting datachannel must be left
	// alone — destroying it every 5s is exactly what made the original slow
	// WebRTC handshakes loop forever.
	if ( peer && ! peer.destroyed && ! peer.disconnected ) {

		if ( ! publicServerState.isHost && publicServerState.hostClaimInFlight ) return;
		if ( ! publicServerState.isHost && ! findPublicServerLiveJoinerConnection( ) ) {

			// Debounce the reclaim probe to ~ once/20s so we don't hammer the
			// PeerJS cloud with rejected unavailable-id attempts every 5s.
			const now = Date.now();
			const lastProbe = publicServerState.lastReclaimProbeAt || 0;
			if ( now - lastProbe >= 20000 ) {
				publicServerState.lastReclaimProbeAt = now;
				maybeReclaimPublicServerHost( roomCode );
			}
		}
		return;
	}

	// Peer is gone/disconnected — restart in the current role.
	logMpDebug( `[PublicServer] Peer down, restarting as ${ publicServerState.isHost ? 'host' : 'joiner' }` );
	if ( publicServerState.isHost ) {

		// Re-claim the host id.
		startPublicServerPeer( roomCode ).catch( ( e ) => console.warn( 'public server host restart failed', e ) );

	} else {

		applyPublicServerRoleToConnections( roomCode, 'join' );
	}
}

// A joiner that lost its host connection tries to claim the RACE-ROOM-<code> id.
// If it succeeds it becomes the new host (self-healing); if the id is still
// taken (someone else became host first) it stays a joiner and reconnects.
function maybeReclaimPublicServerHost( roomCode ) {

	if ( publicServerState.hostClaimInFlight ) return;
	publicServerState.hostClaimInFlight = true;
	const hostPeerId = getPeerRoomId( roomCode );
	logMpDebug( `[PublicServer] Attempting to reclaim host id ${ hostPeerId }` );
	const probe = new Peer( hostPeerId, peerConfig );
	let resolved = false;
	const finish = ( becameHost ) => {

		if ( resolved ) return;
		resolved = true;
		publicServerState.hostClaimInFlight = false;
		if ( becameHost ) {

			logMpDebug( `[PublicServer] Reclaimed host id — becoming host` );
			// Swap our dead peer for the reclaimed host peer.
			closeMultiplayerPeer();
			multiplayerSessionState.peer = probe;
			publicServerState.isHost = true;
			publicServerState.claimedHost = true;
			multiplayerSessionState.role = 'host';
			probe.on( 'connection', ( connection ) => {

				connection.on( 'open', () => {

					registerPeerConnection( connection );
					broadcastPeerState();
					broadcastPublicServerMapSync( connection );

				} );
				connection.on( 'error', () => {} );

			} );

		} else {

				// Someone else is host — destroy the probe + reconnect as joiner. This
				// is SAFE — we are only here because maintainPublicServerPeer() probed us
				// when findPublicServerLiveJoinerConnection() was false, so there is NO live
				// handshake left for this to kill. The fresh join records a brand-new
				// handshakeStartedAt + connectingDataChannel (the patient-recovery path), so a
				// slow-but-fine WebRTC negotiation gets all the quiet ICE-retry time it needs.
				try { probe.destroy(); } catch {}
				applyPublicServerRoleToConnections( roomCode, 'join' );

		}
		}

	;
	probe.on( 'open', ( id ) => { if ( id === hostPeerId ) finish( true ); } );
	probe.on( 'error', ( error ) => {

		if ( error?.type === 'unavailable-id' ) finish( false );
		// Other errors: give up the claim, stay joiner.
		else finish( false );

	} );
	setTimeout( () => finish( false ), 4000 );

}

// --- Map vote ------------------------------------------------------------
//
// Active vote state. Only ONE vote is active at a time per server; a new
// VOTE_START while one is active is ignored (the initiator's vote wins). The
// initiator runs the authoritative 30s timer and broadcasts VOTE_RESULT.
// Non-initiators show the prompt on VOTE_START and hide on VOTE_RESULT (with a
// local fallback timeout in case the initiator's result never arrives).
const publicServerVoteState = {
	active: false,            // is a vote prompt currently shown?
	voteId: '',                // id of the active vote (initiatorId + startedAt)
	playUrl: '',               // proposed track playUrl
	trackName: '',             // proposed track display name
	initiatorId: '',           // who started the vote
	ourVote: '',               // 'yes' | 'no' | '' (our cast vote)
	votes: {},                 // { [playerId]: 'yes'|'no' } (peers' + our votes)
	isInitiator: false,        // are we running the 30s timer?
	endsAt: 0,                 // when the vote ends (ms); derived from startedAt + 30s
		// — identical for every player (startedAt is sent in VOTE_START), so the
		// countdown is consistent across clients.
	timer: null,               // initiator 30s end timer (or non-initiator fallback timer)
	fallbackTimer: null,       // non-initiator hide-on-timeout guard
	countdownTimer: null,      // 250ms interval that updates the live countdown text
};

function resetPublicServerVoteState() {

	if ( publicServerVoteState.timer ) { clearTimeout( publicServerVoteState.timer ); publicServerVoteState.timer = null; }
	if ( publicServerVoteState.fallbackTimer ) { clearTimeout( publicServerVoteState.fallbackTimer ); publicServerVoteState.fallbackTimer = null; }
	stopPublicServerVoteCountdown();
	publicServerVoteState.active = false;
	publicServerVoteState.voteId = '';
	publicServerVoteState.playUrl = '';
	publicServerVoteState.trackName = '';
	publicServerVoteState.initiatorId = '';
	publicServerVoteState.ourVote = '';
	publicServerVoteState.votes = {};
	publicServerVoteState.isInitiator = false;
	publicServerVoteState.endsAt = 0;

}

// Cached fetch of the community-track list (sorted by a stable key in
// PublicServers.fetchTrackList). Cached for 60s so repeated vote proposals don't
// hammer the board. Returns [] on failure.
async function getCachedPublicServerTrackList() {

	const now = Date.now();
	if ( publicServerState.trackListCache && ( now - publicServerState.trackListCacheAt ) < 60000 ) {

		return publicServerState.trackListCache;

	}
	const list = await fetchTrackList();
	publicServerState.trackListCache = list;
	publicServerState.trackListCacheAt = now;
	return list;

}

// Entry point from the "Select track" button: read the pasted URL, search the
// board for its name, then start the vote.
async function startPublicServerVoteFromInput() {

	if ( ! isPublicServerActive() ) return;
	if ( publicServerVoteState.active ) {

		updateMultiplayerStatus( 'A map vote is already in progress.' );
		return;

	}
	const input = document.getElementById( 'mp-pubtrack-input' );
	const rawUrl = String( input?.value || '' ).trim();
	if ( ! rawUrl ) {

		updateMultiplayerStatus( 'Paste a track share URL, then click Select track.' );
		return;

	}

	updateMultiplayerStatus( 'Looking up track on the share board…' );
	let playUrl = '';
	let trackName = '';
	try {

		const list = await getCachedPublicServerTrackList();
		const track = findTrackByPlayUrl( rawUrl, list );
		if ( track && track.playUrl ) {

			playUrl = track.playUrl;
			trackName = track.name;

		}

	} catch ( error ) {

		// Board unreachable — fall through to the custom-track path below if the
		// URL is still a playable racing-game URL, so a flaky board never blocks a
		// vote on a pasted track.
		console.warn( 'Public-server vote track lookup failed', error );

	}

	// Allow a pasted URL that isn't on the share board (a private/unlisted track)
	// as long as it's a playable racing-game URL (it carries a `map` param). The
	// vote proceeds with the name "Custom track". The redirect builder extracts
	// the map+mods from the pasted URL directly.
	if ( ! playUrl ) {

		if ( ! isRacingGameTrackUrl( rawUrl ) ) {

			updateMultiplayerStatus( 'Not a track URL. Paste a Racing-game track share URL (it must contain ?map=...).' );
			return;

		}
		playUrl = rawUrl;
		trackName = 'Custom track';

	}

	if ( input ) input.value = '';
	startPublicServerVote( playUrl, trackName );

}

// Initiate a vote: record it locally, write the vote doc to Firebase (when
// configured) so EVERY client (even ones whose PeerJS mesh never connected)
// sees the same vote via the 220ms poll, showthe prompt, and start the
// authoritative 30s timer on THIS (the initiator) device. Without Firebase
// we fall back to the PeerJS VOTE_START broadcast exactly as before.

function startPublicServerVote( playUrl, trackName ) {

	if ( ! isPublicServerActive() ) return;
	resetPublicServerVoteState();
	const startedAt = Date.now();
	const voteId = `${ multiplayerSessionState.clientId }-${ startedAt }`;
	publicServerVoteState.active = true;
	publicServerVoteState.voteId = voteId;
	publicServerVoteState.playUrl = String( playUrl || '' );
	publicServerVoteState.trackName = String( trackName || 'Shared track' );
	publicServerVoteState.initiatorId = multiplayerSessionState.clientId;
	publicServerVoteState.isInitiator = true;
	publicServerVoteState.endsAt = startedAt + PUBLIC_SERVER_VOTE_DURATION_MS;
	publicServerVoteState.votes = {};

	// Auto-vote yes for the initiator (counts toward the tally immediately)。
	publicServerVoteState.ourVote = 'yes';
	publicServerVoteState.votes[ multiplayerSessionState.clientId ] = 'yes';

	showPublicServerVotePrompt();
	updatePublicServerVoteCounts();
	startPublicServerVoteCountdown();

	if ( hasFirebaseMultiplayerConfig() && multiplayerSessionState.roomCode ) {

		// One-writer-per-subpath:the initiator writes the vote root; each voter
		// writes only vote/votes/<own>. Firebase RTDB merges them without clobber.


		const voteDoc = {
		        voteId,
		        playUrl: publicServerVoteState.playUrl,
		        trackName: publicServerVoteState.trackName,
		        initiatorId: multiplayerSessionState.clientId,
		        startedAt,
		        polledAt: Date.now(),
		        initiatorVote: 'yes',
		};
		firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PUT', voteDoc, 'vote' ).then( ( ) => {
		        // Bootstrap our auto-yes into the per-voter collection. The live RTDB .validate
		        // rejects a vote root doc that carries a `votes` child (any value), so we omit
		        // it above and seed our own vote via the per-voter subpath;the 220ms poll
		        // merges each writer's vote back into the doc for every client.
		        return firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PUT', 'yes', `vote/votes/${ encodeURIComponent( multiplayerSessionState.clientId ) }` );
		} ).catch( ( error ) => console.warn( 'Public-server vote write failed', error ) );
		logMpDebug( `[PublicServer] Started map vote ${ voteId } for "${ trackName }" (Firebase)` );

	} else {

		const packet = {
			type: PEER_PACKET_VOTE_START,
			playerId: multiplayerSessionState.clientId,
			voteId,
			playUrl: publicServerVoteState.playUrl,
			trackName: publicServerVoteState.trackName,
			initiatorId: multiplayerSessionState.clientId,
			startedAt,
			// The initiator auto-votes yes. Carrying it in VOTE_START (rather than a
			// separate VOTE packet) guarantees every peer seeds the initiator's vote
			// immediatelyand consistently, so the live Yes count matches on every
			// screen — otherwise peers never saw the initiator's auto-yes and the
			// initiator saw one more vote than everyone else。
			initiatorVote: 'yes',
		};
		sendPublicServerPacket( packet );
		logMpDebug( `[PublicServer] Started map vote ${ voteId } for "${ trackName }"` );

	}

	// The initiator's device counts the 30s and tallies the result. With Firebase
	// the tally is written to vote/result and every client (including those with a
	// dead PeerJS mesh) adopts it via the poll.

	publicServerVoteState.timer = setTimeout( () => endPublicServerVote( true ), PUBLIC_SERVER_VOTE_DURATION_MS );

}


// Received a VOTE_START from a peer: show the prompt + start a fallback timeout
// (in case the initiator's VOTE_RESULT never arrives we still hide eventually).
function onPublicServerVoteStart( packet ) {

	if ( hasFirebaseMultiplayerConfig() ) return;
	if ( ! isPublicServerActive() ) return;
	const pid = String( packet?.initiatorId || packet?.playerId || '' );
	if ( ! pid ) return;
	// Ignore a new vote while one is already active (the existing one wins).
	if ( publicServerVoteState.active ) return;
	const voteId = String( packet?.voteId || '' );
	if ( ! voteId ) return;
	const startedAt = Number( packet?.startedAt ) || Date.now();
	publicServerVoteState.active = true;
	publicServerVoteState.voteId = voteId;
	publicServerVoteState.playUrl = String( packet?.playUrl || '' );
	publicServerVoteState.trackName = String( packet?.trackName || 'Shared track' );
	publicServerVoteState.initiatorId = pid;
	publicServerVoteState.isInitiator = false;
	publicServerVoteState.endsAt = startedAt + PUBLIC_SERVER_VOTE_DURATION_MS;
	publicServerVoteState.ourVote = '';
	publicServerVoteState.votes = {};
	// Seed the initiator's own auto-yes vote (carried in VOTE_START) so the live
	// Yes count on peers matches the initiator's from the first frame.
	if ( packet?.initiatorVote === 'yes' || packet?.initiatorVote === 'no' ) {

		publicServerVoteState.votes[ pid ] = packet.initiatorVote;

	} else {

		publicServerVoteState.votes[ pid ] = 'yes';

	}
	showPublicServerVotePrompt();
	updatePublicServerVoteCounts();
	startPublicServerVoteCountdown();
	// Fallback: if the initiator's VOTE_RESULT never arrives, hide the prompt a
	// little after the vote would have ended (+5s slack for relay delay).
	const remaining = Math.max( 0, publicServerVoteState.endsAt - Date.now() ) + 5000;
	publicServerVoteState.fallbackTimer = setTimeout( () => {

		if ( publicServerVoteState.active && ! publicServerVoteState.isInitiator ) hidePublicServerVotePrompt();

	}, remaining + 1000 );
	logMpDebug( `[PublicServer] Vote ${ voteId } started by ${ pid } for "${ publicServerVoteState.trackName }"` );

}

// Cast our vote (Yes/No) for the active vote. With Firebase, write it to
// vote/votes/<uid> (one-writer-per-subpath) so the poll merges it for every
// client. Without Firebase, broadcast it to peers as before.so

function castPublicServerVote( choice ) {

	if ( ! isPublicServerActive() || ! publicServerVoteState.active ) return;
	const vote = choice === 'yes' ? 'yes' : 'no';
	if ( publicServerVoteState.ourVote === vote ) return;
	publicServerVoteState.ourVote = vote;
	publicServerVoteState.votes[ multiplayerSessionState.clientId ] = vote;
	updatePublicServerVoteCounts();

	if ( hasFirebaseMultiplayerConfig() && multiplayerSessionState.roomCode && publicServerVoteState.voteId ) {

		firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PUT', vote, `vote/votes/${ encodeURIComponent( multiplayerSessionState.clientId ) }` ).catch( ( error ) => console.warn( 'Public-server vote write failed', error ) );

	} else {

		const packet = {
			type: PEER_PACKET_VOTE,
			playerId: multiplayerSessionState.clientId,
			voteId: publicServerVoteState.voteId,
			vote,
		};
		sendPublicServerPacket( packet );

	}

}


// Received a peer's vote: record it and refresh the counts. When Firebase is
// configured the poll owns the vote state, so a stale PeerJS VOTE packet (from
// the pre-poll broadcast or a slow relay) must NOT clobber the doc — ignore it.

function onPublicServerVote( packet ) {

	if ( hasFirebaseMultiplayerConfig() ) return;
	if ( ! isPublicServerActive() || ! publicServerVoteState.active ) return;
	if ( String( packet?.voteId || '' ) !== publicServerVoteState.voteId ) return;
	const pid = String( packet?.playerId || '' );
	if ( ! pid ) return;
	const vote = packet?.vote === 'yes' ? 'yes' : 'no';
	publicServerVoteState.votes[ pid ] = vote;
	updatePublicServerVoteCounts();

}


// The initiator's 30s elapsed: tally the votes, and if >60% yes (with ≥1 vote),
// write the authoritative result to Firebase vote/result (when configured) so
// EVERY client (even ones whose PeerJS mesh never connected) adopts the SAME
// outcome via the poll. Without Firebase, broadcast the VOTE_RESULT to peers as
// before. Either way, if it passed, switch the track on THIS client first, then
// peers follow (via the poll result or the relayed packet)。 The result carries the
// AUTHORITATIVE final tally (yes/no/total) so everyone acts on the initiator's,
// not their own local tally. Hides the prompt locally regardless of the outcome.

function endPublicServerVote( asInitiator ) {

	if ( ! publicServerVoteState.active ) return;
	if ( publicServerVoteState.timer ) { clearTimeout( publicServerVoteState.timer ); publicServerVoteState.timer = null; }
	const tally = tallyPublicServerVotes();
	const passed = tally.total > 0 && ( tally.yes / tally.total ) > PUBLIC_SERVER_VOTE_PASS_RATIO;
	const result = {
		passed: Boolean( passed ),
		playUrl: publicServerVoteState.playUrl,
		trackName: publicServerVoteState.trackName,
		yes: tally.yes,
		no: tally.no,
		total: tally.total,
	};

	if ( hasFirebaseMultiplayerConfig() && multiplayerSessionState.roomCode && publicServerVoteState.voteId ) {

		firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PUT', result, 'vote/result' ).catch( ( error ) => console.warn( 'Public-server vote result write failed', error ) );
		logMpDebug( `[PublicServer] Map vote ${ publicServerVoteState.voteId } resolved (Firebase): ${ tally.yes }/${ tally.no } ${ passed ? 'PASS' : 'fail' }` );

	} else if ( asInitiator ) {

		const packet = {
			type: PEER_PACKET_VOTE_RESULT,
			playerId: multiplayerSessionState.clientId,
			voteId: publicServerVoteState.voteId,
			passed: Boolean( passed ),
			playUrl: publicServerVoteState.playUrl,
			trackName: publicServerVoteState.trackName,
			yes: tally.yes,
			no: tally.no,
			total: tally.total,
		};
		sendPublicServerPacket( packet );

	}

	if ( passed && publicServerVoteState.playUrl ) {

		// Switch on the initiator's device first (it just wrote/broadcast the result);
		// the redirect rejoins the server on the new map.
		const name = publicServerVoteState.trackName || 'the voted track';
		updateMultiplayerStatus( `Vote passed — switching to ${ name }…` );
		redirectPublicServerToTrack( publicServerVoteState.playUrl, 'voted' );

	} else {

		updateMultiplayerStatus( 'Map vote did not pass.' );

	}
	hidePublicServerVotePrompt();
	resetPublicServerVoteState();

}


// Received the initiator's VOTE_RESULT: if it passed, redirect to the track.
// The packet carries the authoritative final tally — sync our display to it so
// every peer shows the SAME final Yes/No numbers (our locally-collected votes
// may differ slightly due to relay timing; the initiator's tally is the source
// of truth for the outcome). When Firebase is configured the poll owns the result
// path, so a stale relayed VOTE_RESULT must NOT clobber — ignore it.

function onPublicServerVoteResult( packet ) {

	if ( hasFirebaseMultiplayerConfig() ) return;
	if ( ! isPublicServerActive() ) return;
	if ( ! publicServerVoteState.active ) return;
	if ( String( packet?.voteId || '' ) !== publicServerVoteState.voteId ) return;
	// Only the initiator sends the result; ignore our own (it looped back).
	if ( String( packet?.playerId || '' ) === multiplayerSessionState.clientId ) return;
	// Adopt the initiator's authoritative final tally for the display.

	const finalYes = Math.max( 0, Number( packet?.yes ) || 0 );
	const finalNo = Math.max( 0, Number( packet?.no ) || 0 );
	const yesEl = document.getElementById( 'mp-vote-yes-count' );
	const noEl = document.getElementById( 'mp-vote-no-count' );
	if ( yesEl ) yesEl.textContent = String( finalYes );
	if ( noEl ) noEl.textContent = String( finalNo );
		const passed = Boolean( packet?.passed );
		if ( passed && packet?.playUrl ) {

			const name = String( packet?.trackName || 'the voted track' );
			updateMultiplayerStatus( `Vote passed — switching to ${ name }…` );
			redirectPublicServerToTrack( String( packet.playUrl ), 'voted' );

		} else {

			updateMultiplayerStatus( 'Map vote did not pass.' );

		}
		hidePublicServerVotePrompt();
		resetPublicServerVoteState();

}


// Poll-drive the Firebase-backed map vote from the freshly-fetched room doc. Called
// from the 220ms syncMultiplayerTransforms poll. Adopts the doc's votes for live
// counts, and when the initiator has written vote/result, acts on it (hides the
// prompt, resets local state, and redirects if passed). When Firebase is not
// configured this is never called (the PeerJS broadcast path owns the vote)。

async function pollPublicServerVoteFromFirebase( room ) {

	if ( ! hasFirebaseMultiplayerConfig() || ! isPublicServerActive() ) return;
	if ( ! publicServerVoteState.active && ! publicServerVoteState.voteId ) return;
	const doc = room && typeof room === 'object' ? room.vote : null;
	const normalized = normalizeFirebaseVoteDoc( doc, PUBLIC_SERVER_VOTE_DURATION_MS );
	if ( ! normalized ) return;
	if ( publicServerVoteState.active && normalized.voteId !== publicServerVoteState.voteId ) return;
	// If we haven't started a local vote yet but a doc exists (e.g. we joined
	// mid-vote), bootstrap the prompt from the doc so late joiners still see it。

	if ( ! publicServerVoteState.active ) {

		publicServerVoteState.active = true;
		publicServerVoteState.voteId = normalized.voteId;
		publicServerVoteState.playUrl = normalized.playUrl;
		publicServerVoteState.trackName = normalized.trackName;
		publicServerVoteState.initiatorId = normalized.initiatorId;
		publicServerVoteState.endsAt = normalized.endsAt;
		publicServerVoteState.isInitiator = normalized.initiatorId === multiplayerSessionState.clientId;
		publicServerVoteState.ourVote = String( normalized.votes[ multiplayerSessionState.clientId ] || '' );
		showPublicServerVotePrompt();
		startPublicServerVoteCountdown();

	} else if ( normalized.result ) {

		// The initiator already resolved the vote. Adopt its authoritative tally aznd act.
		const tally = tallyFirebaseVotes( normalized.votes, PUBLIC_SERVER_VOTE_PASS_RATIO );
		const finalYes = normalized.result.yes;
		const finalNo = normalized.result.no;
		const yesEl = document.getElementById( 'mp-vote-yes-count' );
		const noEl = document.getElementById( 'mp-vote-no-count' );
		if ( yesEl ) yesEl.textContent = String( finalYes );
		if ( noEl ) noEl.textContent = String( finalNo );
		hidePublicServerVotePrompt();
		resetPublicServerVoteState();
		if ( normalized.result.passed && normalized.result.playUrl ) {

			const name = String( normalized.result.trackName || 'the voted track' );
			updateMultiplayerStatus( `Vote passed — switching to ${ name }…` );
			redirectPublicServerToTrack( normalized.result.playUrl, 'voted' );

		} else {

			updateMultiplayerStatus( 'Map vote did not pass.' );

		}
		return;

	}

	// Merge the doc's votes into the local mirror (they're the source of truth).
	const ourVoteInDoc = String( normalized.votes[ multiplayerSessionState.clientId ] || '' );
	if ( ourVoteInDoc ) publicServerVoteState.ourVote = ourVoteInDoc;

	publicServerVoteState.votes = normalized.votes;

	updatePublicServerVoteCounts();

}

// Tally the votes recorded so far. (Pure local mirror;the Firebase poll adopts
// normalizations + authoritative pass decision from the doc, but the local mirror
// keeps the live countdown numbers fresh between polls。)

function tallyPublicServerVotes() {

	let yes = 0, no = 0;
	for ( const v of Object.values( publicServerVoteState.votes ) ) {

		if ( v === 'yes' ) yes ++; else if ( v === 'no' ) no ++;

	}
	return { yes, no, total: yes + no };

}


// Redirect THIS client to a track board playUrl on the public server. The
// redirect URL keeps the pubServer param so we rejoin the same server on the
// new map (see buildServerTrackRedirectUrl). Records the target mapSignature as
// "loaded" so a subsequent MAP_SYNC from the host (now also on the new map)
// doesn't re-redirect.
function redirectPublicServerToTrack( playUrl, reason = 'voted' ) {

	if ( ! isPublicServerActive() || ! playUrl ) return;
	const sig = mapSignatureFromPlayUrl( playUrl );
	if ( sig === getCurrentMapSignature() ) return;
	setLoadedPublicServerMapInStorage( sig );
	publicServerState.loadedMapSignature = sig;
	const url = buildServerTrackRedirectUrl( playUrl, publicServerState.serverId );
	updateMultiplayerStatus( `Loading ${ reason } map for ${ publicServerName() }…` );
	window.location.href = url;

}

// Send a public-server packet to all peers (and have the host relay it so
// indirectly-connected peers also receive it).
function sendPublicServerPacket( packet ) {

	if ( ! isPublicServerActive() ) return;
	if ( ! multiplayerSessionState.peer || multiplayerSessionState.connections.size === 0 ) return;
	for ( const connection of multiplayerSessionState.connections.values() ) {

		if ( connection && connection.open ) {

			try { connection.send( packet ); } catch {}

		}

	}

}

// --- Vote prompt DOM -----------------------------------------------------

function showPublicServerVotePrompt() {

	const el = document.getElementById( 'mp-vote-prompt' );
	if ( ! el ) return;
	const nameEl = document.getElementById( 'mp-vote-track-name' );
	if ( nameEl ) nameEl.textContent = publicServerVoteState.trackName || 'Shared track';
	const yesBtn = document.getElementById( 'mp-vote-yes' );
	const noBtn = document.getElementById( 'mp-vote-no' );
	if ( yesBtn ) yesBtn.disabled = false;
	if ( noBtn ) noBtn.disabled = false;
	el.classList.add( 'visible' );

}

function hidePublicServerVotePrompt() {

	const el = document.getElementById( 'mp-vote-prompt' );
	if ( el ) el.classList.remove( 'visible' );

}

function updatePublicServerVoteCounts() {

	const yesEl = document.getElementById( 'mp-vote-yes-count' );
	const noEl = document.getElementById( 'mp-vote-no-count' );
	const tally = tallyPublicServerVotes();
	if ( yesEl ) yesEl.textContent = String( tally.yes );
	if ( noEl ) noEl.textContent = String( tally.no );
	// Disable the button matching our cast vote so we can't vote twice.
	const ourVote = publicServerVoteState.ourVote;
	const yesBtn = document.getElementById( 'mp-vote-yes' );
	const noBtn = document.getElementById( 'mp-vote-no' );
	if ( yesBtn ) yesBtn.disabled = Boolean( ourVote && ourVote !== 'no' );
	if ( noBtn ) noBtn.disabled = Boolean( ourVote && ourVote !== 'yes' );

}

// --- Live countdown -----------------------------------------------------
//
// `endsAt` is derived from the initiator's `startedAt` (+30s), which is sent
// in VOTE_START, so every client computes the SAME end time — the countdown is
// consistent across peers regardless of network latency. A 250ms interval
// re-renders the remaining seconds; it self-stops at 0 and is cleared on reset.
function startPublicServerVoteCountdown() {

	stopPublicServerVoteCountdown();
	renderPublicServerVoteCountdown();
	publicServerVoteState.countdownTimer = setInterval( renderPublicServerVoteCountdown, 250 );

}

function stopPublicServerVoteCountdown() {

	if ( publicServerVoteState.countdownTimer ) {

		clearInterval( publicServerVoteState.countdownTimer );
		publicServerVoteState.countdownTimer = null;

	}

}

function renderPublicServerVoteCountdown() {

	const el = document.getElementById( 'mp-vote-timer' );
	if ( ! el || ! publicServerVoteState.active ) return;
	const remainingMs = Math.max( 0, publicServerVoteState.endsAt - Date.now() );
	const secs = Math.ceil( remainingMs / 1000 );
	el.textContent = `${ secs }s`;
	el.classList.toggle( 'urgent', secs <= 5 );

}

function getFirebaseRoomsBaseUrl() {

	const config = readFirebaseConfig();
	if ( ! config?.databaseURL ) return '';
	return `${ config.databaseURL.replace( /\/+$/, '' ) }/racing-rooms`;

}

// The room-root RTDB rule (.validate) requires the trio {code, mapSignature,
// updatedAt} to exist on ANY created room, OR a `status === 'joined'` value..
// A players-only/lapTimes-only first write (which creates the room doc) would fail
// validation -> room-http-401. Merge the seed fields into every room-root PATCH
// so the first subkey write boots a valid room; later writes pass via the trio.

function firebaseRoomSeedFields() {

        const now = Date.now();
        return {
                code: multiplayerSessionState.roomCode || getCurrentMapSignature(),
                mapSignature: getCurrentMapSignature(),
                updatedAt: now,
                status: 'joined',
        };

}


// Writes a single player/lap-time record by PATCHing AT THE ROOM ROOT
// (`players/<id>` / `lapTimes/<id>` as the patch's field), never at the subpath
// directly: RTDB rule setups sometimes allow room-level read/write but lock unknown
// subpaths (`/racing-rooms/<code>/players/<id>` -> 401 while `/racing-rooms/<code>.json`
// PATCH with the same nested payload -> 200);the room-root PATCH still replaces just
// our subkey, never the whole room. The seed fields ride along so a NEW room
// (e.g. a public server with no pre-seeded doc) passes the .validate trio..
async function writeRoomSubkey( roomCode, subKey, payload ) {

        const raw = String( subKey || '' ).trim();
        const parts = raw.split( '/' ).filter( Boolean );
        const field = parts[ 0 ]; // 'players' or 'lapTimes' (the only collections this codebase writes)
        const innerRaw = parts.slice( 1 ).join( '/' ) || 'root';
        if ( ! field || raw.length === 0 ) throw new Error( 'room-subkey-invalid' );
        // Sanitize the dynamic key the way Firebase REST forbids in path segments -
        // dots, hashes, dollars, brackets, control chars - since this key becomes a
        // literal child name in the PATCH body (not a URL path segment).
        const innerKey = String( innerRaw ).replace( /[.\/#\$\u005B\u005D\u0000-\u001F\u007F]/g, '_' ) || 'root';
        const patch = { ...firebaseRoomSeedFields() };
        patch[ field ] = { };
        patch[ field ][ innerKey ] = payload;
        await firebaseRoomsRequest( roomCode, 'PATCH', patch );

}

async function firebaseRoomsRequest( roomCode, method = 'GET', payload = undefined, subPath = '' ) {

	const baseUrl = getFirebaseRoomsBaseUrl();
	if ( ! baseUrl ) throw new Error( 'missing-db-url' );
	const safeCode = String( roomCode || '' ).trim().toUpperCase();
	const normalizedSubPath = subPath ? `/${ subPath.replace( /^\/+/, '' ) }` : '';
	const cacheBust = method === 'GET' ? `${ normalizedSubPath ? '&' : '?' }_=${ Date.now() }` : '';
	const url = `${ baseUrl }/${ encodeURIComponent( safeCode ) }${ normalizedSubPath }.json${ cacheBust }`;
	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), FIREBASE_ROOM_TIMEOUT_MS );
	let response;
	try {

		response = await fetch( url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: payload === undefined ? undefined : JSON.stringify( payload ),
			cache: 'no-store',
			signal: controller.signal,
		} );

	} catch ( error ) {

		if ( error?.name === 'AbortError' ) throw new Error( 'room-timeout' );
		throw error;

	} finally {

		clearTimeout( timeoutId );

	}
	if ( ! response.ok ) {

		let detail = '';
		try {

			detail = await response.text();

		} catch {

			detail = '';

		}
		throw new Error( `room-http-${ response.status }${ detail ? `:${ detail }` : '' }` );

	}
	return response.json();

}

function isFirebasePermissionError( error ) {

	const msg = String( error?.message || '' ).toLowerCase();
	return msg.includes( 'room-http-401' ) || msg.includes( 'room-http-403' ) || msg.includes( 'permission denied' );

}

function initMultiplayerPanel() {

	const hostBtn = document.getElementById( 'mp-host-btn' );
	const joinBtn = document.getElementById( 'mp-join-btn' );
	const copyBtn = document.getElementById( 'mp-copy-btn' );
	const debugToggleBtn = document.getElementById( 'mp-debug-toggle-btn' );
	const codeInput = document.getElementById( 'mp-code-input' );
	if ( ! hostBtn || ! joinBtn || ! copyBtn || ! codeInput ) return;

	const configReady = hasFirebaseMultiplayerConfig();

	// Public servers are wired up regardless of Firebase config: they only need
	// PeerJS's default cloud signalling (WebRTC, via the TURN server in
	// peerConfig) and the read-only track share board — no Firebase, no servers
	// worker.
	buildPublicServerButtons();

	// Auto-join a public server on boot via ?pubServer=<id>. Used after a
	// map-switch redirect so players rejoin the same server on the new map.
	const pubServerParam = PUBLIC_SERVERS_UI_ENABLED
		? String( new URLSearchParams( window.location.search ).get( 'pubServer' ) || '' ).trim().toLowerCase()
		: '';
	if ( pubServerParam && findPublicServer( pubServerParam ) ) {

		const params = new URLSearchParams( window.location.search );
		params.delete( 'pubServer' );
		const nextQuery = params.toString();
		history.replaceState( null, '', `${ window.location.pathname }${ nextQuery ? `?${ nextQuery }` : '' }${ window.location.hash }` );
		// Wait briefly for the boot sequence, then join (tolerant of late load).
		setTimeout( () => joinPublicServer( pubServerParam ), 350 );

	}

	if ( ! configReady ) {

		hostBtn.disabled = true;
		joinBtn.disabled = true;
		copyBtn.disabled = true;
		updateMultiplayerStatus( 'Private rooms need Firebase room metadata. Public servers (above) still work.' );
		setMultiplayerLeaderboardVisible( false );
		return;

	}

	hostBtn.addEventListener( 'click', async () => {

		await leavePublicServer();
		const code = createHostCode();
		codeInput.value = code;
		updateMultiplayerStatus( `Creating room ${ code }...` );
		hostBtn.disabled = true;
		joinBtn.disabled = true;
		copyBtn.disabled = true;
		const now = Date.now();
		multiplayerSessionState.role = 'host';
		multiplayerSessionState.roomCode = code;
		startPeerMultiplayer( code, 'host' );
		const roomPayload = {
			code,
			hostId: multiplayerSessionState.clientId,
			mapSignature: getCurrentMapSignature(),
			createdAt: now,
			updatedAt: now,
		};
		try {

			await firebaseRoomsRequest( code, 'PUT', roomPayload );
			const verify = await firebaseRoomsRequest( code, 'GET' );
			if ( ! verify || verify.code !== code ) {

				codeInput.value = '';
				updateMultiplayerStatus( 'Room was not saved. Check Firebase databaseURL and RTDB rules for /racing-rooms.' );
				return;

			}
			updateMultiplayerStatus( `Hosting room ${ code }. Share this code with your friend.` );
			lastHostRoomRotateAt = Date.now();
			lastHostRoomMetaSyncAt = 0;
			setMultiplayerLeaderboardVisible( true );

		} catch ( error ) {

			console.warn( 'Failed to create multiplayer room', error );
			codeInput.value = '';
			if ( isFirebasePermissionError( error ) ) {

				updateMultiplayerStatus( 'Firebase denied write access. Publish RTDB rules for /racing-rooms first.' );
			} else {

				updateMultiplayerStatus( 'Failed to create room. Check Firebase Realtime Database rules and databaseURL.' );

			}
			closeMultiplayerPeer();
			multiplayerSessionState.role = 'none';
			multiplayerSessionState.roomCode = '';
			setMultiplayerLeaderboardVisible( false );
		} finally {

			hostBtn.disabled = false;
			joinBtn.disabled = false;
			copyBtn.disabled = false;

		}

	} );

	joinBtn.addEventListener( 'click', async () => {

		await leavePublicServer();
		const code = codeInput.value.trim().toUpperCase();
		if ( ! /^[A-Z0-9]{6}$/.test( code ) ) {

			updateMultiplayerStatus( 'Enter a valid 6-character room code first.' );
			return;

		}

		updateMultiplayerStatus( `Trying to join room ${ code }...` );
		try {

			const room = await firebaseRoomsRequest( code, 'GET' );
			if ( ! room || typeof room !== 'object' ) {

				updateMultiplayerStatus( `Room ${ code } not found. Ask host to click Host first.` );
				return;

			}

			const joinMap = getCurrentMapSignature();
			if ( ! canJoinMap( room.mapSignature, joinMap ) ) {

				updateMultiplayerStatus( `Switching to host map for room ${ code }...` );
				redirectToRoomMap( code, room.mapSignature );
				return;

			}

			await firebaseRoomsRequest( code, 'PATCH', {
				updatedAt: Date.now(),
				lastJoinAt: Date.now(),
				status: 'joined',
			} );
			updateMultiplayerStatus( `Joined room ${ code }.` );
			multiplayerSessionState.role = 'join';
			multiplayerSessionState.roomCode = code;
			startPeerMultiplayer( code, 'join' );
			setMultiplayerLeaderboardVisible( true );

		} catch ( error ) {

			console.warn( 'Failed to join multiplayer room', error );
			if ( isFirebasePermissionError( error ) ) {

				updateMultiplayerStatus( 'Firebase denied read access. Publish RTDB rules for /racing-rooms first.' );
				multiplayerSessionState.role = 'none';
				multiplayerSessionState.roomCode = '';
				setMultiplayerLeaderboardVisible( false );
				return;

			}
			updateMultiplayerStatus( 'Join failed. Verify databaseURL/rules and that host room code is active.' );
			multiplayerSessionState.role = 'none';
			multiplayerSessionState.roomCode = '';
			setMultiplayerLeaderboardVisible( false );

		}

	} );

	copyBtn.addEventListener( 'click', async () => {

		const code = codeInput.value.trim().toUpperCase();
		if ( ! code ) {

			updateMultiplayerStatus( 'Generate or enter a room code before copying.' );
			return;

		}

		try {

			await navigator.clipboard.writeText( code );
			updateMultiplayerStatus( `Copied code ${ code } to clipboard.` );

		} catch {

			updateMultiplayerStatus( `Copy failed. Room code: ${ code }` );

		}

	} );

	debugToggleBtn?.addEventListener( 'click', () => {

		const overlay = document.getElementById( 'mp-debug-overlay' );
		if ( ! overlay ) return;
		overlay.style.display = overlay.style.display === 'block' ? 'none' : 'block';
		if ( overlay.style.display === 'block' ) logMpDebug( '[PeerJS] Debug console opened.' );

	} );

	const joinRoomParam = String( new URLSearchParams( window.location.search ).get( 'joinRoom' ) || '' ).trim().toUpperCase();
	if ( /^[A-Z0-9]{6}$/.test( joinRoomParam ) ) {

		codeInput.value = joinRoomParam;
		const params = new URLSearchParams( window.location.search );
		params.delete( 'joinRoom' );
		const nextQuery = params.toString();
		history.replaceState( null, '', `${ window.location.pathname }${ nextQuery ? `?${ nextQuery }` : '' }${ window.location.hash }` );
		setTimeout( () => joinBtn.click(), 0 );

	}

}

async function hostRotateRoomCode( currentRoomCode, mapSignature ) {

	if ( ! currentRoomCode || multiplayerSessionState.role !== 'host' || migrationSwitchInFlight ) return currentRoomCode;
	// Never rotate the room code on a public server — the fixed code (e.g.
	// PUBSV1) is how everyone finds the same PeerJS room. Map changes on a
	// public server are driven by the vote feature, not room-code rotation.
	if ( isPublicServerActive() ) return currentRoomCode;
	const nextCode = createHostCode();
	if ( nextCode === currentRoomCode ) return currentRoomCode;
	migrationSwitchInFlight = true;
	try {

		const now = Date.now();
		const nextRoomPayload = {
			code: nextCode,
			mapSignature,
			createdAt: now,
			updatedAt: now,
			status: 'hosting',
		};
		await firebaseRoomsRequest( nextCode, 'PUT', nextRoomPayload );
		await firebaseRoomsRequest( currentRoomCode, 'PATCH', {
			updatedAt: now,
			migration: {
				toCode: nextCode,
				switchedAt: now,
				mapSignature,
			},
			status: 'migrating',
		} );
		multiplayerSessionState.roomCode = nextCode;
		const codeInput = document.getElementById( 'mp-code-input' );
		if ( codeInput ) codeInput.value = nextCode;
		updateMultiplayerStatus( `Switched to fresh room ${ nextCode } to keep sync smooth.` );
		lastHostRoomRotateAt = now;
		return nextCode;

	} catch ( error ) {

		console.warn( 'Failed to rotate multiplayer room code', error );
		return currentRoomCode;

	} finally {

		migrationSwitchInFlight = false;

	}

}

function getMigrationTargetCode( room ) {

	const migration = room?.migration;
	if ( ! migration || typeof migration !== 'object' ) return '';
	const toCode = String( migration.toCode || '' ).trim().toUpperCase();
	if ( ! /^[A-Z0-9]{6}$/.test( toCode ) ) return '';
	return toCode;

}


function normalizeWeatherPreset( preset ) {

	return WEATHER_PRESETS[ preset ] ? preset : WEATHER_DEFAULT;

}

function normalizeWeatherDetails( value ) {

	const next = value || {};
	return {
		preset: normalizeWeatherPreset( next.preset ),
		precipitation: PRECIP_TYPES.has( next.precipitation ) ? next.precipitation : PRECIP_DEFAULT,
		intensity: INTENSITY_TYPES.has( next.intensity ) ? next.intensity : INTENSITY_DEFAULT,
		lightning: Boolean( next.lightning ),
		wind: WIND_TYPES.has( next.wind ) ? next.wind : WIND_DEFAULT,
	};

}



function makeSkyGradientTexture( preset = WEATHER_DEFAULT ) {

	const gradient = WEATHER_SKY_GRADIENTS[ preset ] || WEATHER_SKY_GRADIENTS[ WEATHER_DEFAULT ];
	const canvas = document.createElement( 'canvas' );
	canvas.width = 32;
	canvas.height = 512;
	const ctx = canvas.getContext( '2d' );
	if ( ! ctx ) return null;
	const g = ctx.createLinearGradient( 0, 0, 0, canvas.height );
	g.addColorStop( 0.0, gradient.top );
	g.addColorStop( 0.45, gradient.mid );
	g.addColorStop( 0.78, gradient.horizon );
	g.addColorStop( 1.0, gradient.ground );
	ctx.fillStyle = g;
	ctx.fillRect( 0, 0, canvas.width, canvas.height );
	const tex = new THREE.CanvasTexture( canvas );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;

}


function applySkyPalette( preset = WEATHER_DEFAULT ) {

	const palette = WEATHER_SKY_GRADIENTS[ preset ] || WEATHER_SKY_GRADIENTS[ WEATHER_DEFAULT ];
	skyUniforms.topColor.value.set( palette.top );
	skyUniforms.midColor.value.set( palette.mid );
	skyUniforms.horizonColor.value.set( palette.horizon );
	skyUniforms.groundColor.value.set( palette.ground );

}

// ─── Sky decorations: low-poly clouds, stars, moon (follows the vehicle so ───
// ─── they always stay within the camera's far plane, like a real skybox)  ───
let skyDecorState = { cloudGroup: null, starPoints: null, constellationLines: null, moonGroup: null };

function clearSkyDecorations() {

	if ( skyDecorState.cloudGroup ) {

		skyGroup.remove( skyDecorState.cloudGroup );
		skyDecorState.cloudGroup.traverse( ( obj ) => {

			if ( obj.geometry ) obj.geometry.dispose();
			if ( obj.material ) obj.material.dispose();

		} );

	}
	if ( skyDecorState.starPoints ) {

		skyGroup.remove( skyDecorState.starPoints );
		skyDecorState.starPoints.geometry?.dispose();
		skyDecorState.starPoints.material?.dispose();

	}
	if ( skyDecorState.constellationLines ) {

		skyGroup.remove( skyDecorState.constellationLines );
		skyDecorState.constellationLines.geometry?.dispose();
		skyDecorState.constellationLines.material?.dispose();

	}
	if ( skyDecorState.moonGroup ) {

		skyGroup.remove( skyDecorState.moonGroup );
		skyDecorState.moonGroup.traverse( ( obj ) => {

			if ( obj.geometry ) obj.geometry.dispose();
			if ( obj.material ) obj.material.dispose();

		} );

	}
	skyDecorState = { cloudGroup: null, starPoints: null, constellationLines: null, moonGroup: null };

}

function makeLowPolyCloud( scale, color, opacity ) {

	const cloud = new THREE.Group();
	const puffCount = 5 + Math.floor( Math.random() * 4 );
	for ( let i = 0; i < puffCount; i ++ ) {

		const r = 0.4 + Math.random() * 0.55;
		const geo = new THREE.IcosahedronGeometry( r, 1 );
		const mat = new THREE.MeshBasicMaterial( { color, flatShading: true, transparent: opacity < 1, opacity, fog: false } );
		mat.userData.baseOpacity = opacity;
		const mesh = new THREE.Mesh( geo, mat );
		mesh.position.set(
			( Math.random() - 0.5 ) * 3.2,
			( Math.random() - 0.5 ) * 0.5,
			( Math.random() - 0.5 ) * 2.0
		);
		mesh.scale.set( 1.5 + Math.random() * 0.7, 0.6 + Math.random() * 0.25, 1.1 + Math.random() * 0.3 );
		mesh.rotation.set( Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.2 );
		cloud.add( mesh );

	}
	cloud.scale.setScalar( scale );
	return cloud;

}

function buildSkyDecorations( preset ) {

	clearSkyDecorations();
	const config = SKY_DECOR_PRESETS[ preset ];
	if ( ! config ) return; // dawn-mist stays exactly as-is

	const qualityScale = Math.max( 0.4, Math.min( 1, getGraphicsPreset().smokeParticles / 64 ) );

	if ( config.clouds ) {

		const cloudGroup = new THREE.Group();
		const count = Math.max( 3, Math.round( config.clouds.count * qualityScale ) );
		for ( let i = 0; i < count; i ++ ) {

			const angle = ( i / count ) * Math.PI * 2 + Math.random() * 0.6;
			const radius = THREE.MathUtils.randFloat( 32, 38 );
			const elevationDeg = THREE.MathUtils.randFloat( config.clouds.elevationRange[ 0 ], config.clouds.elevationRange[ 1 ] );
			const elevation = elevationDeg * ( Math.PI / 180 );
			const horizontalR = radius * Math.cos( elevation );
			const height = radius * Math.sin( elevation ) + 1.5;
			const scale = THREE.MathUtils.randFloat( config.clouds.scale[ 0 ], config.clouds.scale[ 1 ] );
			const cloud = makeLowPolyCloud( scale, config.clouds.color, config.clouds.opacity );
			cloud.position.set( Math.cos( angle ) * horizontalR, height, Math.sin( angle ) * horizontalR );
			cloud.lookAt( 0, height, 0 );
			cloudGroup.add( cloud );

		}
		skyGroup.add( cloudGroup );
		skyDecorState.cloudGroup = cloudGroup;

	}

	if ( config.stars > 0 ) {

		const starCount = Math.max( 80, Math.round( config.stars * qualityScale ) );
		const positions = new Float32Array( starCount * 3 );
		for ( let i = 0; i < starCount; i ++ ) {

			const theta = Math.random() * Math.PI * 2;
			const phi = Math.random() * Math.PI * 0.52;
			const radius = 36;
			const idx = i * 3;
			positions[ idx ] = Math.sin( phi ) * Math.cos( theta ) * radius;
			positions[ idx + 1 ] = Math.cos( phi ) * radius * 0.85 + 2;
			positions[ idx + 2 ] = Math.sin( phi ) * Math.sin( theta ) * radius;

		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		const material = new THREE.PointsMaterial( { color: 0xffffff, size: 0.28, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false } );
		const starPoints = new THREE.Points( geometry, material );
		starPoints.frustumCulled = false;
		skyGroup.add( starPoints );
		skyDecorState.starPoints = starPoints;

		if ( config.constellations ) {

			const lineCount = Math.min( 104, Math.max( 28, Math.floor( starCount * 1.15 / 8 ) ) );
			let linePositions = new Float32Array( lineCount * 6 );
			const linkCounts = new Uint8Array( starCount );
			const links = [];
			const linkedStars = [];
			const cross = ( ax, az, bx, bz, cx, cz ) => ( bx - ax ) * ( cz - az ) - ( bz - az ) * ( cx - ax );
			const segmentsIntersect = ( first, second, third, fourth ) => {

				const firstSide = cross( first.x, first.z, second.x, second.z, third.x, third.z );
				const secondSide = cross( first.x, first.z, second.x, second.z, fourth.x, fourth.z );
				const thirdSide = cross( third.x, third.z, fourth.x, fourth.z, first.x, first.z );
				const fourthSide = cross( third.x, third.z, fourth.x, fourth.z, second.x, second.z );
				return ( firstSide > 0 ) !== ( secondSide > 0 ) && ( thirdSide > 0 ) !== ( fourthSide > 0 );

			};
			let accepted = 0;
			for ( let attempt = 0; attempt < lineCount * 8 && accepted < lineCount; attempt ++ ) {

				let first = Math.floor( Math.random() * starCount );
				if ( linkedStars.length > 0 && Math.random() < 0.72 ) {

					const linkedStart = Math.floor( Math.random() * linkedStars.length );
					first = linkedStars[ linkedStart ];

				}
				if ( linkCounts[ first ] >= 5 ) continue;
				const nearby = [];
				const firstOffset = first * 3;
				for ( let candidate = 0; candidate < starCount; candidate ++ ) {

					if ( candidate === first ) continue;
					const candidateOffset = candidate * 3;
					const dx = positions[ candidateOffset ] - positions[ firstOffset ];
					const dy = positions[ candidateOffset + 1 ] - positions[ firstOffset + 1 ];
					const dz = positions[ candidateOffset + 2 ] - positions[ firstOffset + 2 ];
					nearby.push( { index: candidate, distance: dx * dx + dy * dy + dz * dz } );

				}
				nearby.sort( ( a, b ) => a.distance - b.distance );
				const nearbyCount = Math.min( 8, nearby.length );
				let second = -1;
				for ( let candidateTry = 0; candidateTry < nearbyCount; candidateTry ++ ) {

					const candidate = nearby[ ( candidateTry + Math.floor( Math.random() * nearbyCount ) ) % nearbyCount ].index;
					if ( linkCounts[ candidate ] >= 5 ) continue;
					if ( links.some( ( link ) => ( link.first === first && link.second === candidate ) || ( link.first === candidate && link.second === first ) ) ) continue;
					const firstPoint = { x: positions[ first * 3 ], z: positions[ first * 3 + 2 ] };
					const secondPoint = { x: positions[ candidate * 3 ], z: positions[ candidate * 3 + 2 ] };
					const crossesExisting = links.some( ( link ) => {
						if ( link.first === first || link.first === candidate || link.second === first || link.second === candidate ) return false;
						return segmentsIntersect( firstPoint, secondPoint, link.firstPoint, link.secondPoint );
					} );
					if ( crossesExisting ) continue;
					second = candidate;
					links.push( { first, second, firstPoint, secondPoint } );
					linkCounts[ first ]++;
					linkCounts[ second ]++;
					linkedStars.push( first, second );
					break;

				}
				if ( second < 0 ) continue;
				linePositions.set( positions.subarray( first * 3, first * 3 + 3 ), accepted * 6 );
				linePositions.set( positions.subarray( second * 3, second * 3 + 3 ), accepted * 6 + 3 );
				accepted++;

			}
			linePositions = linePositions.slice( 0, accepted * 6 );
			const lineGeometry = new THREE.BufferGeometry();
			lineGeometry.setAttribute( 'position', new THREE.BufferAttribute( linePositions, 3 ) );
			const lineMaterial = new THREE.LineBasicMaterial( { color: 0x7898c7, transparent: true, opacity: 0.34, depthWrite: false, depthTest: true, fog: false } );
			const constellationLines = new THREE.LineSegments( lineGeometry, lineMaterial );
			constellationLines.frustumCulled = false;
			skyGroup.add( constellationLines );
			skyDecorState.constellationLines = constellationLines;

		}

	}

	if ( config.moon ) {

		const moonGroup = new THREE.Group();
		const moon = new THREE.Mesh(
			new THREE.IcosahedronGeometry( 2.2, 1 ),
			new THREE.MeshBasicMaterial( { color: 0xf3f1e0, fog: false } )
		);
		moonGroup.add( moon );
		const glow = new THREE.Mesh(
			new THREE.IcosahedronGeometry( 3.4, 1 ),
			new THREE.MeshBasicMaterial( { color: 0xf3f1e0, transparent: true, opacity: 0.16, depthWrite: false, fog: false } )
		);
		moonGroup.add( glow );
		const moonDir = new THREE.Vector3( -0.55, 0.62, -0.56 ).normalize().multiplyScalar( 32 );
		moonGroup.position.copy( moonDir );
		skyGroup.add( moonGroup );
		skyDecorState.moonGroup = moonGroup;

	}

}

function createMovingObstacleState( scene, extras ) {
	const entries = Array.isArray( extras?.movingObstacles ) ? extras.movingObstacles : [];
	const state = { items: [], startTime: 0 };
	for ( const entry of entries ) {
		const [ gxRaw, gzRaw, typeRaw, orientRaw, speedRaw ] = Array.isArray( entry ) ? entry : [];
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const type = String( typeRaw || '' );
		const orient = Number( orientRaw ) || 0;
		const base = new THREE.Vector3( ( gx + 0.5 ) * CELL_RAW * GRID_SCALE, -0.5 + ( CELL_RAW * GRID_SCALE * 0.08 ), ( gz + 0.5 ) * CELL_RAW * GRID_SCALE );
		const obstacle = { type, orient, speed: THREE.MathUtils.clamp( Number( speedRaw ) || 1, 0.25, 3 ), base, mesh: new THREE.Group(), colliders: [] };
		if ( type === 'moving-slide-block' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 2.1, 1.2, 1.5 ), new THREE.MeshStandardMaterial( { color: 0x8ca0b8 } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.05, 0.6, 0.75 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-spin-wall' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 3.8, 0.8, 0.55 ), new THREE.MeshStandardMaterial( { color: 0xb4b8bf } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.9, 0.4, 0.275 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-custom' ) {
			const cfg = entry?.[5] && typeof entry[5] === 'object' ? entry[5] : {};
			obstacle.custom = cfg;
			const count = Math.max( 1, Math.min( 8, Math.round( Number( cfg.count ) || 1 ) ) );
			for ( let i = 0; i < count; i ++ ) {
				const sx = Number( cfg.sx ) || 2, sy = Number( cfg.sy ) || 0.8, sz = Number( cfg.sz ) || 0.8;
				const shape = String( cfg.shape || 'square' );
				const geom = shape === 'pole' ? new THREE.CylinderGeometry( sx * 0.18, sx * 0.18, sy, 12 ) : new THREE.BoxGeometry( sx, sy, sz );
				const mesh = new THREE.Mesh( geom, new THREE.MeshStandardMaterial( { color: cfg.color || '#ff8844' } ) );
				obstacle.mesh.add( mesh );
				obstacle.colliders.push( { half: new THREE.Vector3( shape === 'pole' ? sx * 0.18 : sx * 0.5, sy * 0.5, shape === 'pole' ? sx * 0.18 : sz * 0.5 ), offset: new THREE.Vector3(), shape } );
			}
		} else if ( type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < 3; i ++ ) {
				const pole = new THREE.Mesh( new THREE.CylinderGeometry( 0.23, 0.23, 1.0, 12 ), new THREE.MeshStandardMaterial( { color: 0x979ea8 } ) );
				obstacle.mesh.add( pole );
				obstacle.colliders.push( { half: new THREE.Vector3( 0.23, 0.5, 0.23 ), offset: new THREE.Vector3() } );
			}
		} else continue;
		obstacle.mesh.position.copy( base );
		scene.add( obstacle.mesh );
		state.items.push( obstacle );
	}
	return state;
}

function resetMovingObstacles( state, now = 0 ) {
	if ( ! state ) return;
	state.startTime = now;
}

function updateMovingObstacles( state, now, vehicleList ) {
	if ( ! state ) return;
	const t = now - ( state.startTime || 0 );
	for ( const obstacle of state.items ) {
		const p = obstacle.base.clone();
		obstacle.mesh.rotation.set( 0, 0, 0 );
		if ( obstacle.type === 'moving-slide-block' ) p.x += Math.sin( t * 1.35 * obstacle.speed ) * 1.7;
		if ( obstacle.type === 'moving-spin-wall' ) obstacle.mesh.rotation.y = t * 0.9 * obstacle.speed;
		if ( obstacle.type === 'moving-custom' ) {
			const cfg = obstacle.custom || {};
			const orbitR = Number( cfg.orbit ) || 0;
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = ( t * ( Number( cfg.rot ) || 1 ) * obstacle.speed ) + i * ( Math.PI * 2 / obstacle.mesh.children.length );
				const ox = Math.cos( a ) * orbitR, oz = Math.sin( a ) * orbitR;
				obstacle.mesh.children[i].position.set( ox, 0, oz );
				obstacle.mesh.children[i].rotation.y = a;
				obstacle.colliders[i].offset.set( ox, 0, oz );
			}
		} else if ( obstacle.type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = t * 1.35 * obstacle.speed + i * ( Math.PI * 2 / 3 );
				obstacle.mesh.children[ i ].position.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
				obstacle.colliders[ i ].offset.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
			}
		}
		obstacle.mesh.position.copy( p );
		for ( const vehicle of vehicleList ) {
			if ( ! vehicle?.rigidBody ) continue;
			const r = 0.5;
			for ( const collider of obstacle.colliders ) {
				const quat = obstacle.mesh.quaternion;
				const world = collider.offset.clone().applyQuaternion( quat ).add( obstacle.mesh.position );
				const local = vehicle.spherePos.clone().sub( world ).applyQuaternion( quat.clone().invert() );
				const clampedLocal = new THREE.Vector3(
					THREE.MathUtils.clamp( local.x, -collider.half.x, collider.half.x ),
					THREE.MathUtils.clamp( local.y, -collider.half.y, collider.half.y ),
					THREE.MathUtils.clamp( local.z, -collider.half.z, collider.half.z )
				);
				const closest = clampedLocal.clone().applyQuaternion( quat ).add( world );
				const delta = vehicle.spherePos.clone().sub( closest );
				const distSq = delta.lengthSq();
				if ( distSq >= r * r || distSq < 1e-8 ) continue;
				const dist = Math.sqrt( distSq );
				const n = delta.multiplyScalar( 1 / dist );
				const push = ( r - dist ) + 1e-3;
				vehicle.spherePos.addScaledVector( n, push );
				rigidBody.setPosition( vehicle.physicsWorld, vehicle.rigidBody, [ vehicle.spherePos.x, vehicle.spherePos.y, vehicle.spherePos.z ], false );
				const vx = vehicle.sphereVel.x, vy = vehicle.sphereVel.y, vz = vehicle.sphereVel.z;
				const dot = vx * n.x + vy * n.y + vz * n.z;
				if ( dot < 0 ) rigidBody.setLinearVelocity( vehicle.physicsWorld, vehicle.rigidBody, [ vx - dot * n.x, vy - dot * n.y, vz - dot * n.z ] );
			}
		}
	}
}

function extrasFromParsed( parsed ) {

	if ( ! parsed || typeof parsed !== 'object' ) return null;
	return {
				bumps: Array.isArray( parsed.b ) ? parsed.b : [],
				poles: Array.isArray( parsed.p ) ? parsed.p : [],
				cubes: Array.isArray( parsed.k ) ? parsed.k : [],
				walls: Array.isArray( parsed.l ) ? parsed.l : [],
				boosts: Array.isArray( parsed.s ) ? parsed.s : [],
				elevated: Array.isArray( parsed.e ) ? parsed.e : [],
			jumps: Array.isArray( parsed.j ) ? parsed.j : [],
			decorations: Array.isArray( parsed.d ) ? parsed.d : [],
			magnets: Array.isArray( parsed.m ) ? parsed.m : [],
			arcLinks: Array.isArray( parsed.a ) ? parsed.a : [],
			surfaces: Array.isArray( parsed.u ) ? parsed.u : [],
			customSurfaces: parsed?.c && typeof parsed.c === 'object' ? parsed.c : {},
			customPads: parsed?.y && typeof parsed.y === 'object' ? parsed.y : {},
			customAssets: parsed?.x && typeof parsed.x === 'object' ? parsed.x : {},
			movingObstacles: Array.isArray( parsed.o ) ? parsed.o : [],
			worldPreset: parsed.t === 'pool-filled' ? 'pool-filled' : 'normal',
			water: Array.isArray( parsed.q ) ? parsed.q : [],
			poolSlopes: Array.isArray( parsed.z ) ? parsed.z : [],
			customPool: parsed?.r && typeof parsed.r === 'object' ? parsed.r : {},
			weather: normalizeWeatherDetails( parsed?.w ),
		};

}

function decodeExtrasParam( str ) {

	if ( ! str ) return null;

	try {

		const json = decodeURIComponent( escape( atob( str.replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) );
		return extrasFromParsed( JSON.parse( json ) );

	} catch ( e ) {

		console.warn( 'Invalid mods parameter, ignoring extras' );
		return null;

	}

}

// v3-aware mods decoder: accepts compressed 'v3.' payloads and every older format.
async function decodeExtrasParamAny( str ) {

	const s = String( str || '' );
	if ( s.startsWith( 'v3.' ) ) {

		try {

			return extrasFromParsed( await decodeV3Json( s ) );

		} catch ( e ) {

			console.warn( 'Invalid v3 mods parameter, ignoring extras' );
			return null;

		}

	}
	return decodeExtrasParam( s );

}

async function resolvePackedTrackParams( params ) {

	const localPackId = String( params.get( 'localPack' ) || '' ).trim();
	if ( localPackId ) {

		try {

			const raw = localStorage.getItem( `racing-local-pack:${ localPackId }` );
			if ( raw ) {

				const parsed = JSON.parse( raw );
				return {
					mapParam: typeof parsed?.map === 'string' ? parsed.map : '',
					extrasParam: typeof parsed?.mods === 'string' ? parsed.mods : '',
				};

			}

		} catch ( error ) {

			console.warn( 'Failed to load local packed track payload', error );

		}

	}

	const sharedPackId = String( params.get( 'sharedPack' ) || '' ).trim();
	if ( sharedPackId ) {

		const resolvedShared = await resolveTrackBoardSharedPack( sharedPackId );
		if ( resolvedShared ) return resolvedShared;

	}

	const packId = String( params.get( 'pack' ) || '' ).trim();
	if ( ! packId ) return { mapParam: params.get( 'map' ), extrasParam: params.get( 'mods' ) };
	try {

		let payload = null;
		let lastError = null;
		for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

			const endpoint = `${ TRACK_SHARE_API_ROOT }${ prefix }/packs/${ encodeURIComponent( packId ) }`;
			try {

				// Retry so a transient Cloudflare 503 doesn't fail a packed-track load.
				const parsed = await fetchTrackBoardWithRetry( endpoint );
				if ( ! parsed?.ok ) {

					lastError = new Error( `pack-invalid-response@${ endpoint }` );
					continue;

				}
				payload = parsed;
				break;

			} catch ( error ) {

				lastError = error;

			}

		}
		if ( ! payload?.ok ) throw ( lastError || new Error( 'pack-fetch-failed' ) );
		return {
			mapParam: typeof payload.map === 'string' ? payload.map : '',
			extrasParam: typeof payload.mods === 'string' ? payload.mods : '',
		};

	} catch ( error ) {

		console.warn( 'Failed to load packed track payload', error );
		return { mapParam: params.get( 'map' ), extrasParam: params.get( 'mods' ) };

	}

}

function decodeBase64UrlJsonLoose( value ) {

	const normalized = String( value || '' ).replace( /-/g, '+' ).replace( /_/g, '/' );
	const padded = normalized + '='.repeat( ( 4 - normalized.length % 4 ) % 4 );
	return JSON.parse( atob( padded ) );

}

async function fetchTrackBoardEntries() {

	// Route through the shared retry helper (PublicServers.fetchTrackBoardWithRetry)
	// so a transient Cloudflare 503 ("error code: 1102") doesn't leave this
	// non-multiplayer path (shared-track title resolution, board lookup) empty.
	// Both prefixes are tried; the first one that returns a usable payload wins.
	for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

		try {

			const data = await fetchTrackBoardWithRetry( `${ TRACK_SHARE_API_ROOT }${ prefix }/tracks` );
			return Array.isArray( data?.entries ) ? data.entries : [];

		} catch ( error ) {

			console.warn( 'Failed to fetch track share board entries', error );

		}

	}
	return [];

}

function normalizeTrackPayloadValue( value ) {

	return String( value || '' ).trim();

}

function extractTrackPayloadFromPlayUrl( playUrl ) {

	try {

		const parsed = new URL( playUrl, window.location.href );
		return {
			map: normalizeTrackPayloadValue( parsed.searchParams.get( 'map' ) ),
			mods: normalizeTrackPayloadValue( parsed.searchParams.get( 'mods' ) ),
			pack: normalizeTrackPayloadValue( parsed.searchParams.get( 'pack' ) ),
			localPack: normalizeTrackPayloadValue( parsed.searchParams.get( 'localPack' ) ),
			sharedPack: normalizeTrackPayloadValue( parsed.searchParams.get( 'sharedPack' ) ),
		};

	} catch ( error ) {

		return { map: '', mods: '', pack: '', localPack: '', sharedPack: '' };

	}

}

function trackBoardEntryMatchesCurrentPayload( entry, searchParams, mapParam, extrasParam ) {

	if ( ! entry?.playUrl ) return false;
	const current = {
		map: normalizeTrackPayloadValue( mapParam || searchParams.get( 'map' ) ),
		mods: normalizeTrackPayloadValue( extrasParam || searchParams.get( 'mods' ) ),
		pack: normalizeTrackPayloadValue( searchParams.get( 'pack' ) ),
		localPack: normalizeTrackPayloadValue( searchParams.get( 'localPack' ) ),
		sharedPack: normalizeTrackPayloadValue( searchParams.get( 'sharedPack' ) ),
	};
	const entryPayload = extractTrackPayloadFromPlayUrl( entry.playUrl );
	if ( current.sharedPack && String( entry.id ) === current.sharedPack ) return true;
	if ( current.pack && entryPayload.pack === current.pack ) return true;
	if ( current.localPack && entryPayload.localPack === current.localPack ) return true;
	if ( current.sharedPack && entryPayload.sharedPack === current.sharedPack ) return true;
	return Boolean( current.map ) && entryPayload.map === current.map && entryPayload.mods === current.mods;

}

async function updateDocumentTitleFromTrackBoard( searchParams, mapParam, extrasParam ) {

	const hasPayload = Boolean(
		searchParams.get( 'map' ) ||
		searchParams.get( 'mods' ) ||
		searchParams.get( 'pack' ) ||
		searchParams.get( 'localPack' ) ||
		searchParams.get( 'sharedPack' ) ||
		mapParam ||
		extrasParam
	);
	if ( ! hasPayload ) return;
	try {

		const entries = await fetchTrackBoardEntries();
		const match = entries.find( ( entry ) => trackBoardEntryMatchesCurrentPayload( entry, searchParams, mapParam, extrasParam ) );
		const trackName = String( match?.name || '' ).trim();
if ( trackName ) {
    // document.title = trackName;
}
	} catch ( error ) {

		console.warn( 'Failed to update document title from track share board', error );

	}

}

async function resolveTrackBoardSharedPack( sharedPackId ) {

	if ( ! sharedPackId ) return null;
	try {

		const entries = await fetchTrackBoardEntries();
		const match = entries.find( ( entry ) => String( entry?.id ) === sharedPackId );
		if ( ! match?.playUrl ) return null;
		const parsed = new URL( match.playUrl, window.location.href );
		const hash = new URLSearchParams( parsed.hash.replace( /^#/, '' ) );
		const ghostBlob = hash.get( 'ghost' );
		if ( ! ghostBlob ) return null;
		const decoded = decodeBase64UrlJsonLoose( ghostBlob );
		const pack = decoded?.pack && typeof decoded.pack === 'object' ? decoded.pack : {};
		if ( typeof pack.map !== 'string' ) return null;
		return { mapParam: pack.map, extrasParam: typeof pack.mods === 'string' ? pack.mods : '' };

	} catch ( error ) {

		console.warn( 'Failed to resolve sharedPack from track board', error );
		return null;

	}

}

function sanitizePlayerName( value ) {

	const stripped = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return stripped.slice( 0, MAX_PLAYER_NAME_LENGTH );

}

function getTrackLabel( mapParamValue ) {

	if ( mapParamValue ) return `Custom ${ mapParamValue.slice( 0, 10 ) }`;
	return 'Default Track';

}

function getTrackId( mapParamValue, extrasParamValue ) {

	const params = new URLSearchParams();
	if ( mapParamValue ) params.set( 'map', mapParamValue );
	if ( extrasParamValue ) params.set( 'mods', extrasParamValue );
	const normalizedPath = normalizeTrackPath( window.location.pathname );
	const rawUrl = `${ normalizedPath }${ params.toString() ? `?${ params.toString() }` : '' }`;
	// Only the DEFAULT track (no map, no mods) rides the v5 seed — its
	// leaderboard was intentionally reset. Every other track keeps the v4
	// seed so its existing leaderboard id (and records) are untouched.
	const trackIdSeedVersion = ( mapParamValue || extrasParamValue ) ? 'v4' : 'v5';
	return `trk-${ hashTrackSeed( `${ trackIdSeedVersion }-url|${ rawUrl }` ) }`;

}

function getLegacyTrackIds( mapParamValue, extrasParamValue ) {

	return [];

}

function normalizeTrackPath( pathValue ) {

	const raw = String( pathValue || '/' );
	if ( raw === '/index.html' ) return '/';
	if ( raw.endsWith( '/index.html' ) ) return `${ raw.slice( 0, -11 ) }/`;
	return raw;

}

function encodeBase64Url( value ) {

	return btoa( value ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

}

function hashTrackSeed( value ) {

	const hashA = fnv64Hex( value, 0xcbf29ce484222325n, 0x100000001b3n );
	const hashB = fnv64Hex( value, 0x84222325cbf29cen, 0x100000001c3n );
	return `${ hashA }${ hashB }`;

}

function fnv64Hex( value, start, prime ) {

	let hash = start;

	for ( let i = 0; i < value.length; i ++ ) {

		hash ^= BigInt( value.charCodeAt( i ) );
		hash = ( hash * prime ) & 0xffffffffffffffffn;

	}

	return hash.toString( 16 ).padStart( 16, '0' );

}


function readInstalledRuntimeMods() {

	try {

		const parsed = JSON.parse( localStorage.getItem( 'racing-installed-mods-v1' ) || '[]' );
		const list = Array.isArray( parsed ) ? parsed : [];
		return list;

	} catch {

		return [];

	}

}

// Seed the default Freecam mod into a FRESH install exactly once, so a brand-new
// player still gets freecam without it being force-re-injected on every read
// (which previously made Freecam impossible to remove and made the Mod Manager
// always claim a mod was installed even after the user removed everything).
function ensureDefaultFreecamSeeded() {

	try {

		if ( localStorage.getItem( 'racing-installed-mods-v1' ) === null ) {
			localStorage.setItem( 'racing-installed-mods-v1', JSON.stringify( [
				{ id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' },
			] ) );
		}

	} catch { /* ignore */ }

}

function normalizeModEntryPath( entryPath ) {

	if ( ! entryPath || typeof entryPath !== 'string' ) return null;
	// Compressed custom-mod source (written by custom-mods.js / mods-manager.js
	// to save localStorage). Decode the LZW-compressed JS and rebuild the
	// importable `data:` URL at load time. Legacy `data:text/javascript;base64,...`
	// entries and file paths keep working unchanged.
	if ( entryPath.indexOf( 'zjs:' ) === 0 ) {
		try {
			const code = Storage.decompressString( entryPath.slice( 4 ) );
			const bytes = new TextEncoder().encode( String( code || '' ) );
			let bin = '';
			bytes.forEach( ( b ) => { bin += String.fromCharCode( b ); } );
			return `data:text/javascript;base64,${ btoa( bin ) }`;
		} catch ( e ) {
			return null;
		}
	}
	if ( entryPath.startsWith( 'data:text/javascript' ) ) return entryPath;
	if ( entryPath.startsWith( './' ) ) return `../${ entryPath.slice( 2 ) }`;
	if ( entryPath.startsWith( '/' ) ) return entryPath;
	return `../${ entryPath }`;

}


function toRuntimeMod( loadedModule, modId ) {

	const runtime = loadedModule?.default || loadedModule?.TAS_MOD || loadedModule?.mod || null;
	if ( runtime && typeof runtime.init === 'function' ) return runtime;
	if ( typeof loadedModule?.applyCustomMod === 'function' ) {

		let disposer = null;
		return {
			id: modId || 'custom',
			init( context ) {

				disposer = loadedModule.applyCustomMod( {
					game: context,
					bus: context?.world,
				} );

			},
			dispose() {

				if ( typeof disposer === 'function' ) disposer();
				disposer = null;
			}
		};

	}
	return null;

}

async function loadRuntimeMods() {

	const installed = readInstalledRuntimeMods();

	if ( installed.length === 0 ) return [];
	const runtimes = [];
	for ( const mod of installed ) {

		const entryPath = normalizeModEntryPath( mod?.entry );
		if ( ! entryPath ) continue;
		try {

			const loaded = await import( entryPath );
			const runtime = toRuntimeMod( loaded, mod?.id );
			if ( runtime ) runtimes.push( runtime );

		} catch ( error ) {

			console.warn( `Failed to load mod runtime: ${ mod?.id || 'unknown' }`, error );

		}

	}
	return runtimes;

}

function getRequiredModelNames( customCells, extras, carKeys ) {

	const required = new Set( carKeys );
	required.add( 'garage' );
	for ( const [ , , key ] of ( customCells || TRACK_CELLS ) ) {
		required.add( key === 'track-checkpoint' || key === 'track-start' || key === 'track-start-finish' ? 'track-finish' : key );
	}
	if ( extras?.worldPreset !== 'pool-filled' ) {
		required.add( 'decoration-empty' );
		required.add( 'decoration-forest' );
		// Flat grass used to replace auto-forest trees that sit under (off-grid) roads.
		required.add( 'empty-deco-grass' );
		// Default tracks include hand-authored tent decoration cells, so load that model too.
		if ( ! customCells ) required.add( 'decoration-tents' );
	}
	if ( Array.isArray( extras?.bumps ) && extras.bumps.length ) required.add( 'track-bump' );
	if ( Array.isArray( extras?.decorations ) ) {
		for ( const deco of extras.decorations ) if ( typeof deco?.[ 2 ] === 'string' ) required.add( deco[ 2 ] );
	}
	if ( Array.isArray( extras?.elevated ) ) {
		for ( const entry of extras.elevated ) {
			const et = entry?.[ 2 ];
			if ( et === 'elevated-straight' ) required.add( 'elev-track-straight' );
			else if ( et === 'elevated-cross' ) required.add( 'elev-track-cross' );
			else if ( et === 'slope-up' || et === 'slope-down' ) required.add( 'elev-track-slope' );
			else if ( et === 'elevated-corner' ) required.add( 'elev-track-corner' );
			else if ( et === 'elevated-checkpoint' ) required.add( 'elev-track-checkpoint' );
			else if ( et === 'elevated-3-way' ) required.add( 'elev-track-3-way' );
			else if ( et === 'elevated-4-way' ) required.add( 'elev-track-4-way' );
			else required.add( 'track-straight' );
		}
	}
	// Pool slopes reuse the elev-track-slope GLB, so ensure it's loaded.
	if ( Array.isArray( extras?.poolSlopes ) && extras.poolSlopes.length ) required.add( 'elev-track-slope' );
	return modelNames.filter( ( name ) => required.has( name ) );

}

async function loadModels( requiredNames = modelNames ) {

	const promises = requiredNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						// The garage is a walk-in scene, so render both sides of every
						// surface while the other models keep their normal front faces.
						if ( name === 'garage' ) child.material.side = THREE.DoubleSide;
						else if ( ! name.startsWith( 'elev-track-' ) ) child.material.side = THREE.FrontSide;

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				// Building models are authored tiny (~1 cell). Scale them up 10x
				// so they read as proper buildings. Hitbox colliders are derived
				// from this same 10x scale.
				if ( name.startsWith( 'building-' ) ) {

					gltf.scene.scale.setScalar( 10 );

				}

				models[ name ] = gltf.scene;
				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );
	appendLoadingConsole( `Ready with ${ requiredNames.length } optimized models.` );

}

function normalizeImportedObjectToCell( root ) {

	const box = new THREE.Box3().setFromObject( root );
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	box.getSize( size );
	box.getCenter( center );
	const maxDim = Math.max( size.x, size.z, 1e-4 );
	const scale = CELL_RAW / maxDim;
	root.position.sub( center );
	root.position.y -= box.min.y - center.y;
	root.scale.multiplyScalar( scale );
	root.updateMatrixWorld( true );

}

async function loadCustomTrackAssets( extras ) {

	const entries = Object.entries( extras?.customAssets || {} ).slice( 0, 32 );
	for ( const [ id, asset ] of entries ) {

		if ( ! asset?.dataUrl ) continue;
		const modelKey = `custom:${ id }`;
		try {

			let scene = null;
			if ( asset.format === 'obj' ) {

				const text = await ( await fetch( asset.dataUrl ) ).text();
				scene = objLoader.parse( text );

			} else {

				scene = await new Promise( ( resolve, reject ) => loader.load( asset.dataUrl, ( gltf ) => resolve( gltf.scene ), undefined, reject ) );

			}
			if ( ! scene ) continue;
			normalizeImportedObjectToCell( scene );
			scene.traverse( ( child ) => {

				if ( child.isMesh ) child.material.side = THREE.FrontSide;

			} );
			models[ modelKey ] = scene;

		} catch ( error ) {

			console.warn( 'Failed to load custom track asset', id, error );

		}

	}

}

async function loadGarageCollisionAsset() {

	try {
		const text = await ( await fetch( 'models/garage.obj' ) ).text();
		return objLoader.parse( text );
	} catch ( error ) {
		console.warn( 'Failed to load garage collision OBJ', error );
		return null;
	}

}

function getGarageCollisionBoxes( root, scale, zOffset ) {

	if ( ! root ) return [];
	const boxes = [];
	root.updateMatrixWorld( true );
	root.traverse( ( child ) => {

		if ( ! child.isMesh || ! child.geometry?.attributes?.position ) return;
		const positions = child.geometry.attributes.position;
		const unique = new Map();
		for ( let i = 0; i < positions.count; i ++ ) {

			const point = new THREE.Vector3().fromBufferAttribute( positions, i ).applyMatrix4( child.matrixWorld );
			point.multiplyScalar( scale );
			point.z += zOffset;
			const key = `${ point.x.toFixed( 5 ) },${ point.y.toFixed( 5 ) },${ point.z.toFixed( 5 ) }`;
			unique.set( key, point );

		}
		const points = [ ... unique.values() ];
		if ( points.length < 8 ) return;
		const center = points.reduce( ( sum, point ) => sum.add( point ), new THREE.Vector3() ).multiplyScalar( 1 / points.length );
		const origin = points[ 0 ];
		const candidates = points.slice( 1 ).map( ( point ) => point.clone().sub( origin ) ).sort( ( a, b ) => a.lengthSq() - b.lengthSq() );
		let axes = null;
		for ( let i = 0; i < candidates.length && ! axes; i ++ ) {
			for ( let j = i + 1; j < candidates.length && ! axes; j ++ ) {
				for ( let k = j + 1; k < candidates.length; k ++ ) {

					const lengths = [ candidates[ i ].length(), candidates[ j ].length(), candidates[ k ].length() ];
					if ( lengths.some( ( length ) => length < 1e-4 ) ) continue;
					const normalized = candidates.slice( i, i + 1 ).concat( candidates.slice( j, j + 1 ), candidates.slice( k, k + 1 ) ).map( ( axis ) => axis.clone().normalize() );
					const orthogonal = Math.abs( normalized[ 0 ].dot( normalized[ 1 ] ) ) < 0.01
						&& Math.abs( normalized[ 0 ].dot( normalized[ 2 ] ) ) < 0.01
						&& Math.abs( normalized[ 1 ].dot( normalized[ 2 ] ) ) < 0.01;
					if ( orthogonal ) { axes = normalized.map( ( axis, index ) => axis.multiplyScalar( lengths[ index ] * 0.5 ) ); break; }

				}
			}
		}
		if ( ! axes ) return;
		const xAxis = axes[ 0 ].clone().normalize();
		const yAxis = axes[ 1 ].clone().normalize();
		const zAxis = new THREE.Vector3().crossVectors( xAxis, yAxis ).normalize();
		if ( zAxis.dot( axes[ 2 ] ) < 0 ) zAxis.negate();
		const basis = new THREE.Matrix4().makeBasis( xAxis, yAxis, zAxis );
		const worldYHalfExtent = Math.abs( axes[ 0 ].y ) + Math.abs( axes[ 1 ].y ) + Math.abs( axes[ 2 ].y );
		const worldXHalfExtent = ( Math.max( ... points.map( ( point ) => point.x ) ) - Math.min( ... points.map( ( point ) => point.x ) ) ) * 0.5;
		const worldZHalfExtent = ( Math.max( ... points.map( ( point ) => point.z ) ) - Math.min( ... points.map( ( point ) => point.z ) ) ) * 0.5;
		const footprintArea = worldXHalfExtent * worldZHalfExtent * 4;
		boxes.push( { center: [ center.x, center.y, center.z ], halfExtents: [ axes[ 0 ].length(), axes[ 1 ].length(), axes[ 2 ].length() ], worldXHalfExtent, worldYHalfExtent, worldZHalfExtent, footprintArea, quaternion: new THREE.Quaternion().setFromRotationMatrix( basis ) } );

	} );
	return boxes;

}

function getGarageTriangleMeshData( root, scale, zOffset ) {

	const positions = [];
	const indices = [];
	if ( ! root ) return { positions, indices };
	root.updateMatrixWorld( true );
	root.traverse( ( child ) => {

		if ( ! child.isMesh || ! child.geometry?.attributes?.position ) return;
		const attribute = child.geometry.attributes.position;
		const offset = positions.length / 3;
		for ( let i = 0; i < attribute.count; i ++ ) {

			const point = new THREE.Vector3().fromBufferAttribute( attribute, i ).applyMatrix4( child.matrixWorld );
			positions.push( point.x * scale, point.y * scale, point.z * scale + zOffset );

		}
		if ( child.geometry.index ) {

			const index = child.geometry.index;
			for ( let i = 0; i < index.count; i ++ ) indices.push( offset + index.getX( i ) );

		} else {

			for ( let i = 0; i < attribute.count; i ++ ) indices.push( offset + i );

		}

	} );
	return { positions, indices };

}

function addGarageCollisionBoxes( world, root, scale, zOffset ) {

	const boxes = getGarageCollisionBoxes( root, scale, zOffset );
	const meshData = getGarageTriangleMeshData( root, scale, zOffset );
	let floorTop = 0;
	let floorArea = 0;
	for ( const entry of boxes ) {

		if ( entry.footprintArea > floorArea ) {

			floorArea = entry.footprintArea;
			floorTop = entry.center[ 1 ] + entry.worldYHalfExtent;

		}

	}
	if ( meshData.positions.length >= 9 && meshData.indices.length >= 3 ) {

		rigidBody.create( world, {
			shape: triangleMesh.create( meshData ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, 0, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

	}
	return { count: boxes.length, floorTop };

}

// --- Sandboxed Custom-Mod UI + Storage helpers (module scope) ---
// These give mods a safe, isolated way to build their own interface and persist
// data without ever touching the game's real DOM or localStorage keys directly.

const MOD_UI_LAYER_ID = 'custom-mod-ui-layer';
const MOD_STORAGE_PREFIX = 'racing-mod-store:';
const MOD_STORAGE_MAX_BYTES = 256 * 1024; // 256 KB cap per mod

function ensureModUiLayer() {
	let layer = document.getElementById( MOD_UI_LAYER_ID );
	if ( ! layer ) {
		layer = document.createElement( 'div' );
		layer.id = MOD_UI_LAYER_ID;
		// A high, but below-modal, z-index stacking context. pointer-events:none on
		// the layer itself so it never blocks the game; created elements opt back in.
		layer.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
		document.body.appendChild( layer );
	}
	return layer;
}

// Escape any user-provided text before it becomes element content.
function escapeModText( value ) {
	return String( value ?? '' ).replace( /[&<>"']/g, ( ch ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } )[ ch ] );
}

// Clamp a CSS length to a sane pixel range to avoid layout blow-ups.
function clampPx( value, fallback ) {
	const n = parseFloat( value );
	return Number.isFinite( n ) ? `${ Math.max( -2000, Math.min( 4000, n ) ) }px` : fallback;
}

function applyModElementStyle( el, styleObj ) {
	if ( ! el || ! styleObj || typeof styleObj !== 'object' ) return;
	for ( const [ prop, val ] of Object.entries( styleObj ) ) {
		// Restrict to a safe allow-list of CSS properties; ignore anything else so
		// mods can't smuggle in url()/expression()/javascript: via arbitrary CSS.
		const p = String( prop );
		const v = String( val );
		if ( ! /^[a-z-]+$/.test( p ) ) continue;
		if ( /url\(|expression|javascript:|@import|behavior:/i.test( v ) ) continue;
		try { el.style[ p ] = v; } catch { /* ignore unsupported property */ }
	}
}

function createModUiLayer() {
	const layer = ensureModUiLayer();
	const owned = new Set();
	// Track listeners so ui.clear() can fully detach them.
	const listeners = [];

	function track( el ) { owned.add( el ); return el; }
	function on( el, type, handler ) {
		el.addEventListener( type, handler );
		listeners.push( { el, type, handler } );
	}

	const api = {
		// Create an element inside the sandbox layer. tag is restricted to safe tags.
		create( tag = 'div', opts = {} ) {
			const allowed = [ 'div', 'span', 'button', 'label', 'p', 'h1', 'h2', 'h3', 'input', 'select', 'option', 'canvas', 'img', 'progress', 'meter' ];
			const t = allowed.includes( tag ) ? tag : 'div';
			const el = document.createElement( t );
			if ( opts.id ) el.id = `mod-el-${ escapeModText( opts.id ) }`;
			if ( opts.text != null ) el.textContent = String( opts.text );
			if ( opts.html != null ) el.textContent = String( opts.html ); // always escaped; no raw innerHTML
			if ( opts.className ) el.className = String( opts.className ).slice( 0, 80 );
			if ( opts.style ) applyModElementStyle( el, opts.style );
			if ( opts.attrs && typeof opts.attrs === 'object' ) {
				for ( const [ k, v ] of Object.entries( opts.attrs ) ) {
					if ( ! /^[a-zA-Z-]+$/.test( k ) ) continue;
					try { el.setAttribute( k, String( v ).slice( 0, 200 ) ); } catch { /* ignore */ }
				}
			}
			// Created elements opt back into pointer events; the layer stays pass-through.
			el.style.pointerEvents = 'auto';
			layer.appendChild( el );
			return track( el );
		},
		// Convenience: create a panel (positioned div) with a title.
		panel( opts = {} ) {
			const el = api.create( 'div', { className: 'mod-panel', style: { position: 'absolute', padding: '10px', background: 'rgba(15,20,30,0.8)', color: '#fff', borderRadius: '8px', fontFamily: 'system-ui,sans-serif', fontSize: '14px', border: '1px solid rgba(255,255,255,0.18)', ...( opts.style || {} ) } } );
			if ( opts.title ) { const h = api.create( 'div', { text: opts.title, style: { fontWeight: '700', marginBottom: '6px' } } ); el.appendChild( h ); }
			if ( opts.x != null ) el.style.left = clampPx( opts.x, '12px' );
			if ( opts.y != null ) el.style.top = clampPx( opts.y, '12px' );
			return el;
		},
		// Convenience: create a button that calls a callback when clicked.
		button( label, onClick, opts = {} ) {
			const el = api.create( 'button', { text: label, style: { padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(60,120,200,0.7)', color: '#fff', cursor: 'pointer', fontFamily: 'system-ui,sans-serif', ...( opts.style || {} ) } } );
			if ( typeof onClick === 'function' ) on( el, 'click', () => { try { onClick(); } catch ( e ) { console.warn( 'mod button handler error', e ); } } );
			return el;
		},
		// Convenience: create a labeled slider that reports its value via callback.
		slider( label, min, max, value, onInput, opts = {} ) {
			const wrap = api.create( 'div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...( opts.style || {} ) } } );
			const lab = api.create( 'label', { text: `${ label }: ${ value }` } );
			const input = api.create( 'input', { attrs: { type: 'range' } } );
			input.min = String( Number( min ) || 0 );
			input.max = String( Number( max ) || 100 );
			input.value = String( Number( value ) || 0 );
			if ( opts.step ) input.step = String( Number( opts.step ) || 1 );
			if ( typeof onInput === 'function' ) on( input, 'input', () => { try { lab.textContent = `${ label }: ${ input.value }`; onInput( Number( input.value ) ); } catch ( e ) { console.warn( 'mod slider handler error', e ); } } );
			wrap.appendChild( lab );
			wrap.appendChild( input );
			return wrap;
		},
		// Convenience: create a text label you can update later.
		label( text, opts = {} ) {
			return api.create( 'div', { text, style: { color: '#fff', fontFamily: 'system-ui,sans-serif', fontSize: '14px', ...( opts.style || {} ) } } );
		},
		// Append one created element inside another created element.
		append( parent, child ) {
			if ( parent && child && owned.has( parent ) && owned.has( child ) ) parent.appendChild( child );
			return parent;
		},
		// Remove a single created element.
		remove( el ) {
			if ( el && owned.has( el ) ) { el.remove(); owned.delete( el ); }
		},
		// Update text of a created element safely.
		setText( el, text ) {
			if ( el && owned.has( el ) ) el.textContent = String( text ?? '' );
		},
		// Update styles of a created element safely.
		setStyle( el, styleObj ) {
			if ( el && owned.has( el ) ) applyModElementStyle( el, styleObj );
		},
		// Listen to a safe event on a created element.
		on( el, type, handler ) {
			const safe = [ 'click', 'input', 'change', 'mousedown', 'mouseup', 'mouseenter', 'mouseleave' ];
			if ( el && owned.has( el ) && safe.includes( type ) && typeof handler === 'function' ) on( el, type, handler );
		},
		// Tear down EVERYTHING this mod created. Call from dispose().
		clear() {
			for ( const { el, type, handler } of listeners ) { try { el.removeEventListener( type, handler ); } catch { /* ignore */ } }
			listeners.length = 0;
			for ( const el of owned ) { try { el.remove(); } catch { /* ignore */ } }
			owned.clear();
		},
	};
	return api;
}

function createModStorage( namespace ) {
	const prefix = `${ MOD_STORAGE_PREFIX }${ namespace }:`;
	function rawKey( key ) { return prefix + String( key || '' ).slice( 0, 64 ); }
	function totalBytes() {
		let bytes = 0;
		for ( let i = 0; i < localStorage.length; i ++ ) {
			const k = localStorage.key( i );
			if ( k && k.startsWith( prefix ) ) bytes += ( localStorage.getItem( k ) || '' ).length;
		}
		return bytes;
	}
	return {
		get( key, fallback = null ) {
			try {
				const raw = localStorage.getItem( rawKey( key ) );
				return raw == null ? fallback : JSON.parse( raw );
			} catch { return fallback; }
		},
		set( key, value ) {
			try {
				const raw = JSON.stringify( value );
				// Enforce per-mod size cap; refuse writes that would blow the budget.
				if ( totalBytes() + raw.length > MOD_STORAGE_MAX_BYTES ) return false;
				localStorage.setItem( rawKey( key ), raw );
				return true;
			} catch { return false; }
		},
		remove( key ) { try { localStorage.removeItem( rawKey( key ) ); } catch { /* ignore */ } },
		clear() {
			const keys = [];
			for ( let i = 0; i < localStorage.length; i ++ ) { const k = localStorage.key( i ); if ( k && k.startsWith( prefix ) ) keys.push( k ); }
			for ( const k of keys ) { try { localStorage.removeItem( k ); } catch { /* ignore */ } }
		},
		count() {
			let n = 0;
			for ( let i = 0; i < localStorage.length; i ++ ) { const k = localStorage.key( i ); if ( k && k.startsWith( prefix ) ) n ++; }
			return n;
		},
	};
}

async function init() {

	setLoadingStatus( 'Booting game systems…', 'boot' );

	appendLoadingConsole( 'Before registerAll' );

	registerAll();

	appendLoadingConsole( 'After registerAll' );

	setLoadingStatus( 'Resolving track data…', 'track' );

	appendLoadingConsole( 'Before loadRuntimeMods' );

	ensureDefaultFreecamSeeded();
	const runtimeModsPromise = loadRuntimeMods();

	appendLoadingConsole( 'After loadRuntimeMods' );

	appendLoadingConsole( 'Before URLSearchParams' );

	const searchParams = new URLSearchParams( window.location.search );

	appendLoadingConsole( 'After URLSearchParams' );

	appendLoadingConsole( 'Before resolvePackedTrackParams' );

	const { mapParam, extrasParam } = await resolvePackedTrackParams( searchParams );
	window.__resolvedTrackParams = { map: mapParam || '', mods: extrasParam || '' };

	appendLoadingConsole( 'After resolvePackedTrackParams' );

	updateDocumentTitleFromTrackBoard( searchParams, mapParam, extrasParam );

	const isSplitScreen = new URLSearchParams( window.location.search ).get( 'multiplayer' ) === '1';
	const editorQuickTestEnabled = searchParams.get( 'editorQuickTest' ) === '1';
	const replayViewerMode = searchParams.get( 'replayViewer' ) === '1';
	const editorReturnParam = String( searchParams.get( 'editorReturn' ) || '' );
	const editorGhostMapHash = String( searchParams.get( 'editorGhostMap' ) || '' );
	const QUICK_TEST_GHOST_KEY = 'racing-editor-quicktest-ghost-v1';
	const QUICK_TEST_GHOST_MAP_KEY = 'racing-editor-quicktest-map-v1';
	const ghostEnabled = ! isSplitScreen;
	// Runtime flag for whether the personal-best (best-lap) ghost is shown.
	// Defaults true; applyLiveGameSettings() updates it from GameSettings.gameplay.showBestGhost.
	let showBestGhost = true;

	if ( replayViewerMode ) document.body.classList.add( 'replay-viewer-mode' );
	if ( isSplitScreen ) renderer.setPixelRatio( 1 );

	let customCells = null;
	let spawn = null;

	const extras = await decodeExtrasParamAny( extrasParam );
	const carKeys = Object.keys( CAR_STATS );
	const deterministicCarSeed = hashTrackSeed( `${ mapParam || 'default' }|${ extrasParam || 'none' }` );

	const pickRandomCarKey = () => {

		const slice = deterministicCarSeed.slice( 0, 8 );
		const index = Number.parseInt( slice, 16 ) % carKeys.length;
		return carKeys[ index ];

	};

	if ( mapParam ) {

		try {

			customCells = await decodeCellsAny( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}
	if ( extras?.worldPreset === 'pool-filled' ) {
		const generatedWater = computePoolPresetWaterCells( customCells || TRACK_CELLS, extras );
		const explicitWater = Array.isArray( extras.water ) ? extras.water : [];
		const waterByKey = new Map( [ ...generatedWater, ...explicitWater ].map( ( cell ) => [ `${ cell[ 0 ] },${ cell[ 1 ] }`, cell ] ) );
		extras.water = [ ...waterByKey.values() ];
	}
	const requiredModelNames = getRequiredModelNames( customCells, extras, carKeys );
	setLoadingStatus( `Loading ${ requiredModelNames.length } needed models…`, 'models' );
	const garageCollisionPromise = loadGarageCollisionAsset();
	await Promise.all( [ loadModels( requiredModelNames ), loadCustomTrackAssets( extras ) ] );
	const garageCollisionAsset = await garageCollisionPromise;
	const garageBounds = new THREE.Box3().setFromObject( models.garage );
	const garageSize = garageBounds.getSize( new THREE.Vector3() );
	const garageSceneScale = 80 / Math.max( garageSize.x, garageSize.y, garageSize.z, 0.001 );
	const garageSceneZOffset = - 2.2;
	setLoadingStatus( 'Loading track and mods…', 'track' );
	const runtimeMods = await runtimeModsPromise;
	// Surface installed runtime mods in the boot console so players can confirm their
	// custom mod actually loaded (a mod that says "installed" but never runs is the most
	// common confusion — this line makes the load step visible and debuggable).
	const loadedRuntimeModIds = runtimeMods.map( ( m ) => m?.id || 'unknown' );
	appendLoadingConsole( `Runtime mods loaded: ${ loadedRuntimeModIds.length ? loadedRuntimeModIds.join( ', ' ) : 'none' }` );
	const testSpawnRaw = String( searchParams.get( 'testSpawn' ) || '' ).trim();
	if ( testSpawnRaw ) {

		const [ gxRaw, gzRaw, orientRaw ] = testSpawnRaw.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		const orient = Number( orientRaw );
		if ( Number.isFinite( gx ) && Number.isFinite( gz ) ) {

			const x = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
			const z = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;
			const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			spawn = { position: [ x, 0.5, z ], angle };

		}

	}

	// Compute track bounds and size physics/shadows to fit
	const bounds = computeTrackBounds( customCells );
	const hw = bounds.halfWidth;
	const hd = bounds.halfDepth;
	const groundSize = Math.max( hw, hd ) * 2 + 20;
	const weatherSettings = normalizeWeatherDetails( extras?.weather );
	const weatherConfig = WEATHER_PRESETS[ weatherSettings.preset ];

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	applySkyPalette( weatherSettings.preset );
	buildSkyDecorations( weatherSettings.preset );
	scene.background = new THREE.Color( weatherConfig.bg );
	const gameplayFog = new THREE.Fog( weatherConfig.bg, groundSize * weatherConfig.fogNearMul, groundSize * weatherConfig.fogFarMul );
	scene.fog = gameplayFog;
	dirLight.intensity = weatherConfig.sun;
	hemiLight.intensity = weatherConfig.hemi;
	renderer.toneMappingExposure = weatherConfig.exposure;
	fillLight.intensity = weatherConfig.hemi * 0.16;
	const baseWeatherLight = {
		sun: weatherConfig.sun,
		hemi: weatherConfig.hemi,
		exposure: weatherConfig.exposure,
	};

	buildTrack( scene, models, customCells, extras );
	const movingObstacleState = createMovingObstacleState( scene, extras );


	const worldSettings = createWorldSettings();
	setLoadingStatus( 'Setting up physics world…', 'physics' );
	worldSettings.gravity = [ 0, - 9.81, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;
	const garageWorldSettings = createWorldSettings();
	garageWorldSettings.gravity = [ 0, - 9.81, 0 ];
	const garageBplMoving = addBroadphaseLayer( garageWorldSettings );
	const garageBplStatic = addBroadphaseLayer( garageWorldSettings );
	const garageOlMoving = addObjectLayer( garageWorldSettings, garageBplMoving );
	const garageOlStatic = addObjectLayer( garageWorldSettings, garageBplStatic );
	enableCollision( garageWorldSettings, garageOlMoving, garageOlStatic );
	enableCollision( garageWorldSettings, garageOlMoving, garageOlMoving );
	const garageWorld = createWorld( garageWorldSettings );
	garageWorld._OL_MOVING = garageOlMoving;
	garageWorld._OL_STATIC = garageOlStatic;
	let garageCollisionAdded = false;
	let garageFloorTop = 0;
	let garageVehicleBody = null;
	let garageVehicle = null;

	const hitboxDebugGroup = new THREE.Group();
	hitboxDebugGroup.visible = false;
	hitboxDebugGroup.userData.isHackHitboxDebug = true;
	scene.add( hitboxDebugGroup );
	const resettableObstacleBodies = buildWallColliders( world, hitboxDebugGroup, customCells, extras ) || [];

	const roadHalf = groundSize / 2;
	const waterCells = Array.isArray( extras?.water ) ? extras.water : [];
	const waterCellSet = new Set( waterCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
	const cellWorld = CELL_RAW * GRID_SCALE;
	const customPoolSettings = extras?.customPool && typeof extras.customPool === 'object' ? extras.customPool : {};
	// The editor's "Custom Pool" checkmark gates the whole custom pool, not
	// just its colors — with the checkbox off, physics fall back to the
	// classic defaults even if the payload still carries old tuned values.
	const customPoolOn = customPoolSettings.colorsOn === true;
	const WATER_BUOYANCY = THREE.MathUtils.clamp( Number( customPoolOn ? customPoolSettings.buoyancy : 0 ) || 0.28, 0.05, 3 );
	const WATER_GRAVITY_SCALE = Math.min( WATER_BUOYANCY, 1 );
	const WATER_VELOCITY_DRAG = THREE.MathUtils.clamp( Number( customPoolOn ? customPoolSettings.drag : 0 ) || 1.8, 0.1, 6 );
	// Barely-there water control: ~2 m/s^2 of paddle thrust and ~0.55 rad/s of
	// water steering while buoyant. Deliberately tiny.
	const WATER_CONTROL_ACCEL = 2.0;
	const WATER_CONTROL_STEER = 0.55;
	const _waterControlFwd = new THREE.Vector3();
	function isCameraTargetInWater( position ) {

		if ( waterCellSet.size === 0 || ! position ) return false;
		const gx = Math.floor( position.x / cellWorld );
		const gz = Math.floor( position.z / cellWorld );
		return waterCellSet.has( `${ gx },${ gz }` ) && position.y < 0;

	}
	function createWaterCameraState() {

		return { underwater: false, exitTimer: 0 };

	}
	function updateWaterCameraState( state, position, deltaSeconds, onEnter = null ) {

		if ( ! state || ! position ) return false;
		const gx = Math.floor( position.x / cellWorld );
		const gz = Math.floor( position.z / cellWorld );
		const inWaterCell = waterCellSet.has( `${ gx },${ gz }` );
		const safeDelta = Math.max( 0, deltaSeconds );
		if ( ! state.underwater ) {

			if ( inWaterCell && position.y < 0.25 ) {

				state.underwater = true;
				state.exitTimer = 0;
				if ( onEnter ) onEnter( position );

			}
			return state.underwater;

		}
		const clearlyOutOfWater = ! inWaterCell || position.y > 1.1;
		state.exitTimer = clearlyOutOfWater ? state.exitTimer + safeDelta : 0;
		// Quick exit window so surfacing snaps back to normal framing fast.
		if ( state.exitTimer >= 0.16 ) {

			state.underwater = false;
			state.exitTimer = 0;

		}
		return state.underwater;

	}
	const waterCameraState1 = createWaterCameraState();
	const waterCameraState2 = createWaterCameraState();
	// Camera-underwater detection (separate from the car state above): drives
	// the underwater fog, the screen overlay, and the pool-floor caustics.
	const cameraWaterState = createWaterCameraState();
	const underwaterFog = new THREE.Fog( 0x0e3f55, 0.9, Math.max( 8, cellWorld * 1.35 ) );
	let underwaterOverlayEl = null;
	let lastCameraUnderwater = false;
	function updateCameraUnderwater( activeCamera, deltaSeconds ) {

		const underwater = waterCells.length > 0 && activeCamera
			? updateWaterCameraState( cameraWaterState, activeCamera.position, deltaSeconds )
			: false;
		if ( underwater !== lastCameraUnderwater ) {

			lastCameraUnderwater = underwater;
			underwaterOverlayEl ??= document.getElementById( 'underwater-overlay' );
			underwaterOverlayEl?.classList.toggle( 'active', underwater );
			setWaterUnderwaterCameraState( underwater );

		}
		return underwater;

	}

	// --- Bubbles: a few rare air bubbles trail off the car while it is
	// submerged. Pooled sprites, near-zero cost when nobody is in a pool.
	class CarBubblesFX {

		constructor( targetScene ) {

			this.group = new THREE.Group();
			this.group.frustumCulled = false;
			targetScene.add( this.group );
			this.pool = [];
			this.spawnTimer = 0;
			const textureSize = 32;
			const canvas = document.createElement( 'canvas' );
			canvas.width = textureSize;
			canvas.height = textureSize;
			const ctx = canvas.getContext( '2d' );
			const grad = ctx.createRadialGradient( textureSize * 0.38, textureSize * 0.34, 1, textureSize * 0.5, textureSize * 0.5, textureSize * 0.48 );
			grad.addColorStop( 0, 'rgba(235,250,255,0.95)' );
			grad.addColorStop( 0.65, 'rgba(180,225,255,0.35)' );
			grad.addColorStop( 1, 'rgba(160,210,255,0)' );
			ctx.fillStyle = grad;
			ctx.fillRect( 0, 0, textureSize, textureSize );
			this.texture = new THREE.CanvasTexture( canvas );
			this.material = new THREE.SpriteMaterial( { map: this.texture, transparent: true, depthWrite: false, opacity: 0.85 } );

		}
		spawn( x, y, z ) {

			let sprite = this.pool.find( ( s ) => ! s.visible );
			if ( ! sprite ) {

				if ( this.group.children.length >= 16 ) return;
				sprite = new THREE.Sprite( this.material );
				sprite.visible = false;
				this.group.add( sprite );
				this.pool.push( sprite );

			}
			const scale = 0.05 + Math.random() * 0.11;
			sprite.position.set( x + ( Math.random() - 0.5 ) * 0.5, y, z + ( Math.random() - 0.5 ) * 0.5 );
			sprite.scale.setScalar( scale );
			sprite.userData.riseSpeed = 0.55 + Math.random() * 0.7;
			sprite.userData.wobblePhase = Math.random() * Math.PI * 2;
			sprite.userData.maxAge = 2.4 + Math.random() * 1.2;
			sprite.userData.age = 0;
			sprite.visible = true;

		}
		update( deltaSeconds, targetVehicle, submerged ) {

			const safeDelta = Math.max( 0, deltaSeconds );
			for ( const sprite of this.pool ) {

				if ( ! sprite.visible ) continue;
				sprite.userData.age += safeDelta;
				sprite.position.y += sprite.userData.riseSpeed * safeDelta;
				sprite.position.x += Math.sin( sprite.userData.age * 5 + sprite.userData.wobblePhase ) * 0.14 * safeDelta;
				sprite.position.z += Math.cos( sprite.userData.age * 4.3 + sprite.userData.wobblePhase ) * 0.14 * safeDelta;
				if ( sprite.userData.age > sprite.userData.maxAge || sprite.position.y >= WATER_SURFACE_Y - 0.02 ) sprite.visible = false;

			}
			if ( ! submerged ) {

				this.spawnTimer = Math.max( this.spawnTimer, 0.4 );
				return;

			}
			this.spawnTimer -= safeDelta;
			if ( this.spawnTimer <= 0 ) {

				this.spawnTimer = 0.5 + Math.random() * 1.6; // rare: a few bubbles every so often
				this.spawn( targetVehicle.spherePos.x, targetVehicle.spherePos.y - 0.1, targetVehicle.spherePos.z );

			}

		}

	}
	let carBubblesFx = null;
	let carBubblesFx2 = null;

	function applyWaterPhysicsDamping( targetVehicle, deltaSeconds ) {

		if ( ! isCameraTargetInWater( targetVehicle?.spherePos ) || ! targetVehicle?.rigidBody?.motionProperties ) return false;
		const safeDelta = Math.max( 0, deltaSeconds );
		const dragFactor = Math.exp( - WATER_VELOCITY_DRAG * safeDelta );
		const velocity = targetVehicle.rigidBody.motionProperties.linearVelocity || [ 0, 0, 0 ];
		const upwardFloatVelocity = Math.max( 0, WATER_BUOYANCY - 1 ) * 12 * safeDelta;
		const verticalVelocity = THREE.MathUtils.clamp( ( velocity[ 1 ] * Math.sqrt( dragFactor ) ) + upwardFloatVelocity, -18, 8 );
		let vx = velocity[ 0 ] * dragFactor;
		let vz = velocity[ 2 ] * dragFactor;
		// Slight water control (JUST BARELY): a gentle nudge along the car's
		// facing when throttling, and a whisper of steering — enough to point
		// the car while it floats, nowhere near water-top racing speed.
		const inputZ = Number( targetVehicle.inputZ ) || 0;
		const inputX = Number( targetVehicle.inputX ) || 0;
		if ( inputZ || inputX ) {

			const fwd = _waterControlFwd.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
			fwd.y = 0;
			if ( fwd.lengthSq() > 1e-6 ) {

				fwd.normalize();
				const thrust = inputZ * WATER_CONTROL_ACCEL * safeDelta;
				vx += fwd.x * thrust;
				vz += fwd.z * thrust;
				if ( inputX ) {

					const steer = Math.sign( inputX ) * WATER_CONTROL_STEER * safeDelta;
					const cos = Math.cos( steer );
					const sin = Math.sin( steer );
					const nx = vx * cos - vz * sin;
					const nz = vx * sin + vz * cos;
					vx = nx;
					vz = nz;

				}

			}

		}
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vx,
			verticalVelocity,
			vz,
		], false );
		targetVehicle.linearSpeed *= dragFactor;
		return true;

	}
	// Splash when a car breaks the water surface — scaled by how hard it went in.
	const WATER_SURFACE_Y = 0.12;
	let waterSplashFx = null;
	function triggerWaterSplash( targetVehicle, position ) {

		if ( ! position ) return;
		const velocity = targetVehicle?.rigidBody?.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		const dive = Math.abs( Math.min( velocity[ 1 ], 0 ) );
		const speed = Math.hypot( velocity[ 0 ], velocity[ 1 ], velocity[ 2 ] );
		// gentle wading in barely plops; a hard dive makes a real splash
		const intensity = THREE.MathUtils.clamp( dive / 10 + speed / 60, 0.1, 1 );
		if ( intensity < 0.22 ) return;
		waterSplashFx ??= new WaterSplashFX( scene );
		waterSplashFx.burst( position.x, WATER_SURFACE_Y, position.z, intensity );
		window.__gameAudio?.playSplash?.( intensity );

	}

	function createGroundSurfaceCollider( halfExtents, position ) {

		// Make ground colliders thick so edges are buried deep below the surface.
		// Thin colliders (0.01 half-height) let the sphere catch on the top edge;
		// thick colliders (0.5 half-height) bury that edge well below where the
		// sphere contacts, eliminating the seam-bounce problem.
		const GROUND_HALF_H = 0.5;
		const topY = position[ 1 ] + halfExtents[ 1 ];
		const thickPosition = [ position[ 0 ], topY - GROUND_HALF_H, position[ 2 ] ];
		const thickHalfExtents = [ halfExtents[ 0 ], GROUND_HALF_H, halfExtents[ 2 ] ];

		rigidBody.create( world, {
			shape: box.create( { halfExtents: thickHalfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: OL_STATIC,
			position: thickPosition,
			friction: 5.0,
			restitution: 0.0,
		} );

	}
	if ( waterCells.length > 0 ) {

		const waterSet = waterCellSet;
		const minGx = Math.floor( ( bounds.centerX - roadHalf ) / cellWorld ) - 1;
		const maxGx = Math.ceil( ( bounds.centerX + roadHalf ) / cellWorld ) + 1;
		const minGz = Math.floor( ( bounds.centerZ - roadHalf ) / cellWorld ) - 1;
		const maxGz = Math.ceil( ( bounds.centerZ + roadHalf ) / cellWorld ) + 1;
		const activeGroundRuns = new Map();
		function flushGroundRun( runStart, runEnd, startGz, endGz ) {

			const runCellsX = runEnd - runStart + 1;
			const runCellsZ = endGz - startGz + 1;
			createGroundSurfaceCollider(
				[ cellWorld * runCellsX * 0.5, 0.01, cellWorld * runCellsZ * 0.5 ],
				[ ( runStart + runCellsX * 0.5 ) * cellWorld, - 0.125, ( startGz + runCellsZ * 0.5 ) * cellWorld ]
			);

		}

		for ( let gz = minGz; gz <= maxGz; gz ++ ) {

			const currentRowRuns = new Set();
			let runStart = null;
			for ( let gx = minGx; gx <= maxGx + 1; gx ++ ) {

				const isSolidGround = gx <= maxGx && ! waterSet.has( `${ gx },${ gz }` );
				if ( isSolidGround && runStart === null ) runStart = gx;
				if ( ( ! isSolidGround || gx > maxGx ) && runStart !== null ) {

					const runEnd = gx - 1;
					const runKey = `${ runStart },${ runEnd }`;
					currentRowRuns.add( runKey );
					if ( activeGroundRuns.has( runKey ) ) activeGroundRuns.get( runKey ).endGz = gz;
					else activeGroundRuns.set( runKey, { runStart, runEnd, startGz: gz, endGz: gz } );
					runStart = null;

				}

			}

			for ( const [ runKey, run ] of [ ...activeGroundRuns.entries() ] ) {

				if ( currentRowRuns.has( runKey ) ) continue;
				flushGroundRun( run.runStart, run.runEnd, run.startGz, run.endGz );
				activeGroundRuns.delete( runKey );

			}

		}
		for ( const run of activeGroundRuns.values() ) flushGroundRun( run.runStart, run.runEnd, run.startGz, run.endGz );

	} else {

		createGroundSurfaceCollider( [ roadHalf, 0.01, roadHalf ], [ bounds.centerX, - 0.125, bounds.centerZ ] );

	}

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );
	const carHitboxMaterial = new THREE.MeshBasicMaterial( {
		color: 0x0b2f75,
		transparent: true,
		opacity: HACK_HITBOX_OPACITY,
		depthWrite: false,
	} );
	const carHitboxMesh = new THREE.Mesh( new THREE.SphereGeometry( VEHICLE_SURFACE_RADIUS, 20, 14 ), carHitboxMaterial );
	carHitboxMesh.userData.isHackHitboxDebug = true;
	carHitboxMesh.visible = false;
	scene.add( carHitboxMesh );
	const originalHackTransparencyByMaterial = new Map();
	let hackVisualsApplied = false;

	const player1CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-yellow';
	const player2CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-red';
	const vehicle = new Vehicle();
	localPlayerVehicle = vehicle;
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	// ── HUD Extras: speedometer, minimap, shortcuts overlay ──
	let hudExtras = null;
	vehicle.setSpawn( spawn ? spawn.position : [ 3.5, 0.5, 5 ], spawn ? spawn.angle : 0 );
	// Full respawn (lap state, obstacles, camera) when falling out of the world
	vehicle.onOutOfBounds = respawnVehicle;
	vehicle.setPerformance( CAR_STATS[ player1CarKey ].perf );

	if ( spawn ) {

		const [ sx, sy, sz ] = spawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = spawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ player1CarKey ] );
	scene.add( vehicleGroup );
	let vehicle2 = null;
	let sphereBody2 = null;
	if ( isSplitScreen ) {

		const spawnPos2 = spawn ? [ ...spawn.position ] : [ 3.5, 0.5, 5 ];
		const spawnAngle = spawn ? spawn.angle : 0;
		spawnPos2[ 0 ] += Math.cos( spawnAngle ) * 1.3;
		spawnPos2[ 2 ] += - Math.sin( spawnAngle ) * 1.3;
		sphereBody2 = createSphereBody( world, spawnPos2 );
		vehicle2 = new Vehicle();
		vehicle2.rigidBody = sphereBody2;
		vehicle2.physicsWorld = world;
		vehicle2.setSpawn( spawnPos2, spawnAngle );
		vehicle2.onOutOfBounds = respawnVehicle2;
		vehicle2.setPerformance( CAR_STATS[ player2CarKey ].perf );
		const vehicleGroup2 = vehicle2.init( models[ player2CarKey ] );
		scene.add( vehicleGroup2 );

	}
	const remotePlayerVisuals = new Map();
	const REMOTE_PLAYER_STALE_MS = 10000;
	const REMOTE_SYNC_MS = 220;

	function createRemoteNameTag( displayName ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = 256;
		canvas.height = 64;
		const ctx = canvas.getContext( '2d' );
		if ( ! ctx ) return null;
		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
		ctx.fillRect( 12, 8, 232, 48 );
		ctx.fillStyle = '#ffffff';
		ctx.font = '700 22px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText( ( displayName || 'Player' ).slice( 0, 20 ), 128, 32 );
		const texture = new THREE.CanvasTexture( canvas );
		texture.needsUpdate = true;
		const material = new THREE.SpriteMaterial( { map: texture, transparent: true, depthWrite: false } );
		const sprite = new THREE.Sprite( material );
		sprite.scale.set( 2.4, 0.6, 1 );
		sprite.position.set( 0, 2.38, 0 );
		return sprite;

	}

	function ensureRemotePlayerVisual( playerId, carKey ) {

		return ensureRemotePlayerVisualWithCosmetics( playerId, carKey, null );

	}

	function cosmeticsSignature( cosmetics ) {

		const normalized = normalizeGhostCosmeticsPayload( cosmetics );
		return normalized ? JSON.stringify( normalized ) : '';

	}

	function ensureRemotePlayerVisualWithCosmetics( playerId, carKey, cosmetics ) {

		const modelKey = normalizeMultiplayerCarKey( carKey );
		const signature = cosmeticsSignature( cosmetics );
		const existing = remotePlayerVisuals.get( playerId );
		if ( existing && ( existing.currentCarKey || existing.carKey ) === modelKey && existing.cosmeticsSignature === signature ) return existing;
		const previousState = existing ? {
			displayName: existing.displayName || 'Player',
			targetPos: existing.targetPos?.clone?.() || existing.mesh?.position?.clone?.(),
			targetRotY: Number.isFinite( existing.targetRotY ) ? existing.targetRotY : existing.mesh?.rotation?.y || 0,
			lastSeenAt: existing.lastSeenAt || 0,
		} : null;
		if ( existing ) removeRemotePlayerVisual( playerId );
		const model = models[ modelKey ] || models[ 'vehicle-truck-yellow' ];
		const mesh = createGhostVisualModel( model, 0.42, cosmetics, false ) || new THREE.Mesh(
			new THREE.BoxGeometry( 0.95, 0.5, 1.7 ),
			new THREE.MeshStandardMaterial( { color: 0x53d4ff, transparent: true, opacity: 0.38, depthWrite: false } ),
		);
		mesh.traverse?.( ( obj ) => {

			if ( ! obj?.isMesh ) return;
			if ( Array.isArray( obj.material ) ) {

				for ( const mat of obj.material ) {

					if ( ! mat ) continue;
					mat.transparent = false;
					mat.opacity = 1.0;
					mat.depthWrite = true;

				}

			} else if ( obj.material ) {

				obj.material.transparent = false;
				obj.material.opacity = 1.0;
				obj.material.depthWrite = true;

			}
			obj.castShadow = true;
			obj.receiveShadow = true;

		} );
		if ( previousState?.targetPos ) mesh.position.copy( previousState.targetPos );
		mesh.rotation.y = previousState?.targetRotY || mesh.rotation.y;
		scene.add( mesh );
		const state = {
			mesh,
			carKey: modelKey,
			currentCarKey: modelKey,
			cosmeticsSignature: signature,
			displayName: previousState?.displayName || 'Player',
			nameTag: null,
			targetPos: previousState?.targetPos || mesh.position.clone(),
			targetRotY: previousState?.targetRotY || mesh.rotation.y,
			lastSeenAt: previousState?.lastSeenAt || 0,
		};
		remotePlayerVisuals.set( playerId, state );
		return state;

	}

	function ensureRemoteNameTag( state, displayName ) {

		const safeName = sanitizePlayerName( displayName ) || 'Player';
		if ( state.displayName === safeName && state.nameTag ) return;
		if ( state.nameTag ) {

			state.mesh.remove( state.nameTag );
			state.nameTag.material?.map?.dispose?.();
			state.nameTag.material?.dispose?.();

		}
		state.displayName = safeName;
		state.nameTag = createRemoteNameTag( safeName );
		if ( state.nameTag ) state.mesh.add( state.nameTag );

	}

	function removeRemotePlayerVisual( playerId ) {

		const state = remotePlayerVisuals.get( playerId );
		if ( ! state ) return;
		const mesh = state.mesh;
		if ( state.nameTag ) {

			mesh.remove( state.nameTag );
			state.nameTag.material?.map?.dispose?.();
			state.nameTag.material?.dispose?.();

		}
		scene.remove( mesh );
		mesh.traverse?.( ( obj ) => {

			if ( obj?.isMesh ) {

				obj.geometry?.dispose?.();
				if ( Array.isArray( obj.material ) ) obj.material.forEach( ( mat ) => mat?.dispose?.() );
				else obj.material?.dispose?.();

			}

		} );
		remotePlayerVisuals.delete( playerId );

	}

	remoteVisualHandlers.withCosmetics = ensureRemotePlayerVisualWithCosmetics;
	remoteVisualHandlers.basic = ensureRemotePlayerVisual;
	remoteVisualHandlers.getOrCreate = ensureRemotePlayerVisualWithCosmetics;
	remoteVisualHandlers.nameTag = ensureRemoteNameTag;
	remoteVisualHandlers.remove = removeRemotePlayerVisual;

	function updateRemotePlayerVisualsFrame( dt ) {

		const alpha = THREE.MathUtils.clamp( dt * 12, 0, 1 );
		const now = Date.now();
		for ( const [ playerId, state ] of [ ...remotePlayerVisuals.entries() ] ) {

			if ( state.lastSeenAt && now - state.lastSeenAt > REMOTE_PLAYER_STALE_MS ) {

				removeRemotePlayerVisual( playerId );
				continue;

			}
			state.mesh.position.lerp( state.targetPos, alpha );
			state.mesh.rotation.y = lerpAngle( state.mesh.rotation.y, state.targetRotY, alpha );

		}

	}

	let multiplayerSyncInFlight = false;
	async function syncMultiplayerTransforms( options = {} ) {

	// HTTPS/Firebase polling is THE transport floor: it ALWAYS runs (whether or not
	// not WebRTC works) so every room/device that can load the page gets continuous
	// position sync + host-map following, with zero NAT/STUN/TURN dependencies.


		const roomCode = multiplayerSessionState.roomCode;
		if ( ! roomCode || ! hasFirebaseMultiplayerConfig() ) return;
		if ( multiplayerSyncInFlight ) return;
		const force = Boolean( options?.force );
		const now = Date.now();
		const mapSignature = getCurrentMapSignature();
		const snap = buildRemotePlayerSnapshot();
		const localPayload = snap ? {
			type: PEER_PACKET_STATE,
			playerId: multiplayerSessionState.clientId,
			x: snap.x,
			y: snap.y,
			z: snap.z,
			ry: snap.ry,
			carKey: snap.carKey,
			cosmetics: snap.cosmetics,
			name: snap.name,
			mapSignature,
			updatedAt: now,
		} : {
			x: Number( vehicle.container.position.x.toFixed( 3 ) ),
			y: Number( vehicle.container.position.y.toFixed( 3 ) ),
			z: Number( vehicle.container.position.z.toFixed( 3 ) ),
			ry: Number( getMultiplayerHeadingDegrees( vehicle.container ).toFixed( 2 ) ),
			carKey: normalizeMultiplayerCarKey( currentCarKey() ),
			cosmetics: buildGhostCosmeticsSnapshot( currentCarKey() ),
			name: getLocalMultiplayerDisplayName(),
			mapSignature,
			updatedAt: now,
		};

		try {

			multiplayerSyncInFlight = true;
			await writeRoomSubkey( roomCode, `players/${ encodeURIComponent( multiplayerSessionState.clientId ) }`, localPayload );
			const room = await firebaseRoomsRequest( roomCode, 'GET' );
			if ( multiplayerSessionState.role === 'host' ) {

				const shouldSyncRoomMeta = room?.mapSignature !== mapSignature || now - lastHostRoomMetaSyncAt >= HOST_ROOM_META_SYNC_MS;
				if ( shouldSyncRoomMeta ) {

					await firebaseRoomsRequest( roomCode, 'PATCH', {
						mapSignature,
						updatedAt: now,
						status: 'hosting',
					} );
					lastHostRoomMetaSyncAt = now;
					room.mapSignature = mapSignature;

				}

			}
			if ( room?.mapSignature && ! canJoinMap( room.mapSignature, mapSignature ) ) {

				updateMultiplayerStatus( `Switching to host map for room ${ roomCode }...` );
				redirectToRoomMap( roomCode, room.mapSignature );
				return;

			}
			const migrationTarget = getMigrationTargetCode( room );
			if ( migrationTarget && migrationTarget !== roomCode ) {

				const targetRoom = await firebaseRoomsRequest( migrationTarget, 'GET' );
				if ( targetRoom?.mapSignature && ! canJoinMap( targetRoom.mapSignature, mapSignature ) ) {

					updateMultiplayerStatus( `Host switched to ${ migrationTarget }. Loading host map...` );
					redirectToRoomMap( migrationTarget, targetRoom.mapSignature );
					return;

				}
				multiplayerSessionState.roomCode = migrationTarget;
				const codeInput = document.getElementById( 'mp-code-input' );
				if ( codeInput ) codeInput.value = migrationTarget;
				updateMultiplayerStatus( `Host switched room to ${ migrationTarget }. Following without reload...` );
				return;

			}
			if ( multiplayerSessionState.role === 'host' && now - lastHostRoomRotateAt >= MULTIPLAYER_ROOM_ROTATE_MS ) {

				const rotatedCode = await hostRotateRoomCode( roomCode, mapSignature );
				if ( rotatedCode !== roomCode ) return;

			}
			const players = room?.players && typeof room.players === 'object' ? room.players : {};
			renderMultiplayerRoomLeaderboard( room?.lapTimes );
			maybeSubmitOnlinePersonalBest( room?.lapTimes );
				pollPublicServerVoteFromFirebase( room ).catch( ( ) => { } );
			const seen = new Set();
			for ( const [ playerId, playerState ] of Object.entries( players ) ) {

				if ( playerId === multiplayerSessionState.clientId ) continue;
				if ( ! canJoinMap( playerState?.mapSignature, mapSignature ) ) continue;
				const updatedAt = Number( playerState?.updatedAt ) || 0;
				if ( ! force && now - updatedAt > REMOTE_PLAYER_STALE_MS ) continue;
				const visualState = ensureRemotePlayerVisualWithCosmetics( playerId, playerState?.carKey, playerState?.cosmetics );
				ensureRemoteNameTag( visualState, playerState?.name || room?.lapTimes?.[ playerId ]?.name || 'Player' );
				visualState.targetPos.set( Number( playerState?.x ) || 0, ( Number( playerState?.y ) || 0 ) - 0.1, Number( playerState?.z ) || 0 );
				visualState.targetRotY = THREE.MathUtils.degToRad( ( ( Number( playerState?.ry ) || 0 ) % 360 + 0 ) % 360 ) ;
				visualState.lastSeenAt = now;
				seen.add( playerId );

			}

			for ( const existingId of [ ...remotePlayerVisuals.keys() ] ) {

				if ( seen.has( existingId ) ) continue;
				const existing = remotePlayerVisuals.get( existingId );
				if ( existing && now - ( Number( existing.lastSeenAt ) || 0 ) <= REMOTE_PLAYER_STALE_MS ) continue;
				removeRemotePlayerVisual( existingId );

			}

		} catch ( error ) {

			console.warn( 'Multiplayer transform sync failed', error );

		} finally {

			multiplayerSyncInFlight = false;

		}

	}
		async function startPublicServerPolling() {
			if ( ! multiplayerSessionState.roomCode || ! hasFirebaseMultiplayerConfig() ) return;
			if ( ! publicServerState.serverId ) return;
			// Do NOT wait for the find flaky poll tick to race: poll synchronously now。
			// `force` clears + re-mirrors every remote player, so late joiners or map
			// votes don't depend on the 220ms interval or a single racing GET。
			multiplayerSyncInFlight	 = false;
			await syncMultiplayerTransforms( { force: true } );
			lastPublicServerRoomMetaSyncAt	 = Date.now();
			// Host meta heartbeat: write room.mapSignature on a 1.5s cadence (same
			// cadence as the private-room HOST_ROOM_META_SYNC_MS) instead of only in the
			// 220ms poll syncing when `now - lastHostRoomMetaSyncAt` happens to pass。 A
			// fresh host can stamp the room map immediately after its join PATCH，and the
			// cadence doesn't depend on the game init() snapshot timing。
			if ( ! publicServerState.isHost ) return;
			if ( Date.now() - lastPublicServerRoomMetaSyncAt < HOST_ROOM_META_SYNC_MS ) return;
			try {
			await firebaseRoomsRequest( multiplayerSessionState.roomCode, 'PATCH',{
			mapSignature: getCurrentMapSignature(),
			status: 'hosting',
			updatedAt: Date.now(),
			} );
			lastPublicServerRoomMetaSyncAt	 = Date.now();
			} catch ( error ) {
			console.warn( 'Public-server room meta sync failed', error );
			lastPublicServerRoomMetaSyncAt	 = 0;
			}
		}


	setInterval( syncMultiplayerTransforms, REMOTE_SYNC_MS );
	if ( hasFirebaseMultiplayerConfig() && publicServerState.serverId ) {
		startPublicServerPolling();
	}
	setInterval( broadcastPeerState, WEBRTC_SYNC_MS );
	window.addEventListener( 'beforeunload', () => {

		// On a public server leaving is purely a PeerJS action (the LEFT packet +
		// peer destroy below handle it; if we were host a surviving joiner's
		// maintenance loop reclaims the host id). On a private room we also clear our
		// Firebase presence. The roomCode check skips the no-op when not in a room.
		if ( ! multiplayerSessionState.roomCode ) return;
		for ( const connection of multiplayerSessionState.connections.values() ) {

			try { connection.send?.( { type: PEER_PACKET_LEFT, playerId: multiplayerSessionState.clientId } ); } catch {}

		}
		if ( ! hasFirebaseMultiplayerConfig() ) return;
		// On a public server the DELETE also clears our players/<uid> so the room
		// roster stays fresh; on a private room we clear presence as before。
		const roomCode = multiplayerSessionState.roomCode;
		const leavePatch = { };
		leavePatch.players = { };
		leavePatch.players[ String( multiplayerSessionState.clientId ).replace( /[.\/#\$\u005B\u005D\u0000-\u001F\u007F]/g, '_' ) ] = null;
		firebaseRoomsRequest( roomCode, 'PATCH', leavePatch ).catch( ( ) => {} );

	} );
	let ghostModel = null;
	const bestLapGhostSamples = [];
	let currentLapGhostSamples = [];
	let bestGhostDuration = 0;
	const ghostPlaybackCursor = { _cursor: 1 };
	let bestGhostCarKey = 'vehicle-truck-yellow';
	let bestGhostCosmetics = null;
	let ghostRecordFrame = 0;
	const _ghostForward = new THREE.Vector3();
	const _ghostUp = new THREE.Vector3( 0, 1, 0 );
	const selectedLeaderboardGhosts = new Set();
	const leaderboardGhostPlayers = new Map();
	const recentGhostHistory = [];
	const recentGhostPlayers = [];
	let bestGhostCheckpointTimes = [];

	let ghostSpreadLine = null;
	const _ghostSpreadSampleVec = new THREE.Vector3();

	function sampleGhostPositionAtTime( samples, duration, t, out = _ghostSpreadSampleVec ) {

		if ( ! Array.isArray( samples ) || samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return null;
		const wrapped = ( ( t % duration ) + duration ) % duration;
		let nextIndex = samples.findIndex( ( sample ) => sample.t >= wrapped );
		if ( nextIndex <= 0 ) nextIndex = 1;
		const sampleA = samples[ nextIndex - 1 ];
		const sampleB = samples[ nextIndex ];
		const span = Math.max( 1e-4, sampleB.t - sampleA.t );
		const alpha = THREE.MathUtils.clamp( ( wrapped - sampleA.t ) / span, 0, 1 );
		out.set(
			THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
			THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
			THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
		);
		return out;

	}

	// Find the first sample whose t >= wrapped using a per-state cached cursor.
	// Samples are sorted ascending by t and playback time is monotonic (mod duration),
	// so the cursor advances forward each frame instead of scanning the whole array
	// (O(n) -> O(1) amortised). On wrap (wrapped resets to a small value) it falls back
	// to a single scan from the start, keeping behaviour identical to findIndex().
	function findGhostSampleIndex( samples, wrapped, state ) {

		const len = samples.length;
		let nextIndex = ( state && Number.isFinite( state._cursor ) ) ? state._cursor : 1;
		if ( nextIndex < 1 || nextIndex >= len ) nextIndex = 1;
		if ( samples[ nextIndex - 1 ].t > wrapped ) {

			// Wrapped past the end: locate the first sample at/after the small wrapped t.
			nextIndex = 1;
			while ( nextIndex < len && samples[ nextIndex ].t < wrapped ) nextIndex ++;

		} else {

			while ( nextIndex < len && samples[ nextIndex ].t < wrapped ) nextIndex ++;

		}
		if ( nextIndex <= 0 ) nextIndex = 1;
		if ( nextIndex >= len ) nextIndex = len - 1;
		if ( state ) state._cursor = nextIndex;
		return nextIndex;

	}

	function rebuildGhostSpreadLine() {

		if ( ghostSpreadLine ) {

			scene.remove( ghostSpreadLine );
			ghostSpreadLine.geometry?.dispose?.();
			ghostSpreadLine.material?.dispose?.();
			ghostSpreadLine = null;

		}
		// Average multi-ghost path visualization intentionally disabled.

	}

	function normalizeGhostCosmeticsPayload( payload ) {

		const sourceMappings = Array.isArray( payload?.mappings ) ? payload.mappings : [];
		const mappings = [];
		for ( const entry of sourceMappings.slice( 0, 48 ) ) {

			const sourceHex = typeof entry?.sourceHex === 'string' ? entry.sourceHex.trim().toLowerCase() : '';
			const targetHex = typeof entry?.targetHex === 'string' ? entry.targetHex.trim().toLowerCase() : '';
			if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) || ! /^#[0-9a-fA-F]{6}$/.test( targetHex ) ) continue;
			mappings.push( {
				sourceHex,
				targetHex,
				tolerance: THREE.MathUtils.clamp( Number( entry?.tolerance ) || 40, 8, 180 ),
				finish: entry?.finish === 'shiny' ? 'shiny' : 'matte',
			} );

		}
		if ( mappings.length === 0 ) return null;
		return { mappings };

	}

	function buildGhostCosmeticsSnapshot( carKey ) {

		const carData = getGarageCosmeticCar( carKey );
		const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
		const resolved = [];
		for ( const mapping of mappings.slice( 0, 48 ) ) {

			const sourceHex = typeof mapping?.sourceHex === 'string' ? mapping.sourceHex : '';
			const targetPaint = getPaintColorById( mapping?.targetColorId );
			if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) || ! targetPaint?.hex || ! garageCosmetics?.unlockedPaints?.[ mapping?.targetColorId ] ) continue;
			resolved.push( {
				sourceHex,
				targetHex: targetPaint.hex,
				tolerance: THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 ),
				finish: targetPaint.finish === 'shiny' ? 'shiny' : 'matte',
			} );

		}
		return resolved.length > 0 ? { mappings: resolved } : null;

	}

	localMultiplayerStateHandlers.getCarKey = currentCarKey;
	localMultiplayerStateHandlers.buildCosmetics = buildGhostCosmeticsSnapshot;

	function buildResolvedMappingsFromGhostCosmetics( cosmetics ) {

		const normalized = normalizeGhostCosmeticsPayload( cosmetics );
		if ( ! normalized ) return [];
		const resolved = [];
		for ( const mapping of normalized.mappings ) {

			const source = hexToRgbBytes( mapping.sourceHex );
			const target = hexToRgbBytes( mapping.targetHex );
			if ( ! source || ! target ) continue;
			const tolerance = THREE.MathUtils.clamp( Number( mapping.tolerance ) || 40, 8, 180 );
			resolved.push( {
				source,
				target,
				finish: mapping.finish === 'shiny' ? 'shiny' : 'matte',
				toleranceSq: tolerance * tolerance,
			} );

		}
		return resolved;

	}

	function createGhostVisualModel( model, opacity = 0.35, cosmetics = null, requireGhostEnabled = true ) {

		if ( ( requireGhostEnabled && ! ghostEnabled ) || ! model ) return null;
		const cloned = model.clone();
		const resolvedMappings = buildResolvedMappingsFromGhostCosmetics( cosmetics );
		cloned.traverse( ( child ) => {

			if ( ! child.isMesh || ! child.material ) return;
			const incomingMaterials = Array.isArray( child.material ) ? child.material : [ child.material ];
			const builtMaterials = incomingMaterials.map( ( baseMaterial ) => {

				let material = baseMaterial.clone();
				if ( resolvedMappings.length > 0 && material.color ) {

					const baseRgb = hexToRgbBytes( `#${ baseMaterial.color.getHexString() }` );
					const mappedSolid = baseRgb ? pickMappedColor( baseRgb, resolvedMappings ) : null;
					if ( mappedSolid ) material.color.setRGB( mappedSolid.r / 255, mappedSolid.g / 255, mappedSolid.b / 255 );
					if ( mappedSolid?.finish === 'shiny' ) applyShinyFinish( material, mappedSolid );

				}
				if ( resolvedMappings.length > 0 && material.map ) {

					const remapped = recolorTexture( material.map, resolvedMappings );
					material.map = remapped.texture;
					if ( remapped.hasShiny ) applyShinyFinish( material );

				}
				material.transparent = opacity < 1;
				material.opacity = opacity;
				material.depthWrite = opacity >= 1;
				material.needsUpdate = true;
				return material;

			} );
			child.material = Array.isArray( child.material ) ? builtMaterials : builtMaterials[ 0 ];
			child.castShadow = false;
			child.receiveShadow = false;

		} );
		return cloned;

	}

	function createGhostModel( model, cosmetics = null ) {

		if ( ! ghostEnabled ) return;
		if ( ghostModel ) scene.remove( ghostModel );
		ghostModel = null;
		if ( ! model ) return;

		ghostModel = createGhostVisualModel( model, replayViewerMode ? 1 : 0.35, cosmetics );
		if ( ! ghostModel ) return;
		scene.add( ghostModel );

	}

	function resetCurrentLapGhost() {

		if ( ! ghostEnabled ) return;
		currentLapGhostSamples = [];
		ghostRecordFrame = 0;

	}

	function recordGhostSample( lapElapsed, force = false ) {

		if ( ! ghostEnabled ) return;
		ghostRecordFrame ++;
		if ( ! force && ghostRecordFrame % 3 !== 0 ) return;

		_ghostForward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
		_ghostForward.projectOnPlane( _ghostUp ).normalize();
		const yaw = Math.atan2( _ghostForward.x, _ghostForward.z );
		const euler = new THREE.Euler().setFromQuaternion( vehicle.container.quaternion, 'YXZ' );

		currentLapGhostSamples.push( {
			t: lapElapsed,
			x: vehicle.container.position.x,
			y: vehicle.container.position.y,
			z: vehicle.container.position.z,
			yaw,
			pitch: euler.x,
			roll: euler.z,
		} );

	}

	function lerpAngle( a, b, t ) {

		let delta = b - a;
		while ( delta > Math.PI ) delta -= Math.PI * 2;
		while ( delta < - Math.PI ) delta += Math.PI * 2;
		return a + delta * t;

	}

	function updateGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled ) return;
		if ( ! showBestGhost ) { if ( ghostModel ) ghostModel.visible = false; return; }
		if ( ! ghostModel ) return;
		if ( bestLapGhostSamples.length < 2 || bestGhostDuration <= 0 ) {

			ghostModel.visible = false;
			return;

		}

		ghostModel.visible = true;
		const t = ( ( lapElapsed % bestGhostDuration ) + bestGhostDuration ) % bestGhostDuration;

		let nextIndex = findGhostSampleIndex( bestLapGhostSamples, t, ghostPlaybackCursor );

		const sampleA = bestLapGhostSamples[ nextIndex - 1 ];
		const sampleB = bestLapGhostSamples[ nextIndex ];
		const span = Math.max( 1e-4, sampleB.t - sampleA.t );
		const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );

		ghostModel.position.set(
			THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
			THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
			THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
		);
		const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
		const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
		const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
		ghostModel.rotation.x = lerpAngle( ghostModel.rotation.x, targetPitch, 0.18 );
		ghostModel.rotation.y = lerpAngle( ghostModel.rotation.y, targetYaw, 0.18 );
		ghostModel.rotation.z = lerpAngle( ghostModel.rotation.z, targetRoll, 0.18 );
		if ( replayViewerMode && ! freecamState.active ) {
			cam.targetPosition.copy( ghostModel.position );
			// Recorded ghost y is the car-model base (container.y ≈ -0.1, below
			// the road surface — correct for the visual model). Casting the
			// hitbox clip probe from that origin lands INSIDE the static ground
			// collider, so every cast "hits" and the camera gets pinned ~2.5
			// units behind the car at bumper height for the whole replay.
			// Replays are cinematic: keep the normal chase framing (pre-clip-fix
			// behavior) and skip the probe for this update only.
			const savedClipProbe = cam.clipProbe;
			cam.clipProbe = null;
			cam.update( 1 / 60, ghostModel.position, ghostModel.quaternion );
			cam.clipProbe = savedClipProbe;
		}

	}

	function extractNormalizedGhostPayload( payload ) {

		// Accepts v1 payload objects, { g2 } wrappers, and bare g2 binary
		// strings (js/GhostCodec.js) — legacy payloads keep working.
		let source = payload;
		if ( source && typeof source === 'object' && typeof source.g2 === 'string' ) source = decodeGhostBinary( source.g2 );
		else if ( typeof source === 'string' ) source = decodeGhostBinary( source );
		if ( ! source || typeof source !== 'object' ) return null;
		const samples = Array.isArray( source.samples ) ? source.samples : [];
		const duration = Number( source.duration );
		if ( samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return null;
		const normalizedSamples = [];
		for ( const sample of samples ) {

			if ( ! Number.isFinite( sample?.t ) || ! Number.isFinite( sample?.x ) || ! Number.isFinite( sample?.y ) || ! Number.isFinite( sample?.z ) || ! Number.isFinite( sample?.yaw ) ) continue;
			normalizedSamples.push( {
				t: sample.t,
				x: sample.x,
				y: sample.y,
				z: sample.z,
				yaw: sample.yaw,
				pitch: Number.isFinite( sample?.pitch ) ? sample.pitch : 0,
				roll: Number.isFinite( sample?.roll ) ? sample.roll : 0,
			} );

		}
		if ( normalizedSamples.length < 2 ) return null;
		return {
			samples: normalizedSamples,
			duration,
			car: source.car,
			bestLapSeconds: source.bestLapSeconds,
			cosmetics: normalizeGhostCosmeticsPayload( source.cosmetics ),
		};

	}

	function removeLeaderboardGhost( playerName ) {

		const existing = leaderboardGhostPlayers.get( playerName );
		if ( existing?.model ) scene.remove( existing.model );
		leaderboardGhostPlayers.delete( playerName );
		rebuildGhostSpreadLine();

	}

	function computeCheckpointCrossTimes( samples ) {

		if ( ! Array.isArray( samples ) || samples.length < 2 || checkpointStates.length === 0 ) return [];
		const times = new Array( checkpointStates.length ).fill( null );
		const state = checkpointStates.map( () => ( { x: 0, z: 0, hasPrev: false } ) );
		for ( const sample of samples ) {

			for ( let i = 0; i < checkpointStates.length; i ++ ) {

				if ( times[ i ] !== null ) continue;
				const cp = checkpointStates[ i ];
				const localX = ( ( sample.x - cp.centerX ) * cp.cosA ) + ( ( sample.z - cp.centerZ ) * cp.sinA );
				const localZ = ( - ( sample.x - cp.centerX ) * cp.sinA ) + ( ( sample.z - cp.centerZ ) * cp.cosA );
				const prev = state[ i ];
				if ( prev.hasPrev ) {

					const crossedPlane = ( prev.z < 0 && localZ > 0 ) || ( prev.z > 0 && localZ < 0 );
					if ( crossedPlane ) {

						const t = prev.z / ( prev.z - localZ );
						const xCross = THREE.MathUtils.lerp( prev.x, localX, t );
						if ( t >= 0 && t <= 1 && Math.abs( xCross ) <= cp.halfExtent ) times[ i ] = Number( sample.t );

					}

				}
				prev.x = localX;
				prev.z = localZ;
				prev.hasPrev = true;

			}

		}
		return times;

	}

	function rebuildRecentGhostVisuals() {

		while ( recentGhostPlayers.length > 0 ) {

			const state = recentGhostPlayers.pop();
			if ( state?.model ) scene.remove( state.model );

		}
		if ( ! ghostEnabled || ! fxSettings.recentGhostsEnabled ) return;
		const targetCount = Math.max( 1, Math.min( recentGhostHistory.length, fxSettings.recentGhostCount ) );
		for ( const entry of recentGhostHistory.slice( 0, targetCount ) ) {

			const model = createGhostVisualModel( models[ entry.car || 'vehicle-truck-yellow' ] || models[ 'vehicle-truck-yellow' ], 0.22, entry.cosmetics || null );
			if ( ! model ) continue;
			scene.add( model );
			recentGhostPlayers.push( { ...entry, model } );

		}

	}

	function enableLeaderboardGhost( playerName, payload ) {

		if ( ! ghostEnabled ) return false;
		const normalized = extractNormalizedGhostPayload( payload );
		if ( ! normalized ) return false;
		const modelKey = normalized.car && models[ normalized.car ] ? normalized.car : 'vehicle-truck-yellow';
		const ghostCosmetics = normalized.car === modelKey ? normalized.cosmetics : null;
		const model = createGhostVisualModel( models[ modelKey ], 0.27, ghostCosmetics );
		if ( ! model ) return false;
		removeLeaderboardGhost( playerName );
		scene.add( model );
		leaderboardGhostPlayers.set( playerName, {
			model,
			samples: normalized.samples,
			duration: normalized.duration,
			checkpointTimes: computeCheckpointCrossTimes( normalized.samples ),
		} );
		rebuildGhostSpreadLine();
		return true;

	}

	function updateSelectedLeaderboardGhosts( rows ) {

		const byName = new Map();
		for ( const entry of rows ) {

			const name = sanitizePlayerName( entry?.name ) || 'Anonymous';
			byName.set( name, entry );

		}
		for ( const selectedName of [ ...selectedLeaderboardGhosts ] ) {

			const entry = byName.get( selectedName );
			if ( ! entry?.ghost ) {

				selectedLeaderboardGhosts.delete( selectedName );
				removeLeaderboardGhost( selectedName );
				continue;

			}
			if ( leaderboardGhostPlayers.has( selectedName ) ) continue;
			if ( ! enableLeaderboardGhost( selectedName, entry.ghost ) ) {

				selectedLeaderboardGhosts.delete( selectedName );
				removeLeaderboardGhost( selectedName );

			}

		}

	}

	function updateLeaderboardGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled || leaderboardGhostPlayers.size === 0 ) return;
		for ( const state of leaderboardGhostPlayers.values() ) {

			if ( ! state?.model || ! Array.isArray( state.samples ) || state.samples.length < 2 || ! Number.isFinite( state.duration ) || state.duration <= 0 ) {

				if ( state?.model ) state.model.visible = false;
				continue;

			}
			state.model.visible = true;
			const t = ( ( lapElapsed % state.duration ) + state.duration ) % state.duration;
			let nextIndex = findGhostSampleIndex( state.samples, t, state );
			const sampleA = state.samples[ nextIndex - 1 ];
			const sampleB = state.samples[ nextIndex ];
			const span = Math.max( 1e-4, sampleB.t - sampleA.t );
			const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );
			state.model.position.set(
				THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
				THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
				THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
			);
			const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
			const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
			const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
			state.model.rotation.x = lerpAngle( state.model.rotation.x, targetPitch, 0.18 );
			state.model.rotation.y = lerpAngle( state.model.rotation.y, targetYaw, 0.18 );
			state.model.rotation.z = lerpAngle( state.model.rotation.z, targetRoll, 0.18 );

		}

	}

	function updateRecentGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled || recentGhostPlayers.length === 0 || ! fxSettings.recentGhostsEnabled ) return;
		for ( const state of recentGhostPlayers ) {

			if ( ! state?.model || ! Array.isArray( state.samples ) || state.samples.length < 2 || ! Number.isFinite( state.duration ) || state.duration <= 0 ) {

				if ( state?.model ) state.model.visible = false;
				continue;

			}
			state.model.visible = true;
			const t = ( ( lapElapsed % state.duration ) + state.duration ) % state.duration;
			let nextIndex = findGhostSampleIndex( state.samples, t, state );
			const sampleA = state.samples[ nextIndex - 1 ];
			const sampleB = state.samples[ nextIndex ];
			const span = Math.max( 1e-4, sampleB.t - sampleA.t );
			const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );
			state.model.position.set(
				THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
				THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
				THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
			);
			const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
			const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
			const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
			state.model.rotation.x = lerpAngle( state.model.rotation.x, targetPitch, 0.18 );
			state.model.rotation.y = lerpAngle( state.model.rotation.y, targetYaw, 0.18 );
			state.model.rotation.z = lerpAngle( state.model.rotation.z, targetRoll, 0.18 );

		}

	}

	if ( ghostEnabled ) createGhostModel( models[ 'vehicle-truck-yellow' ] );
	if ( replayViewerMode ) vehicle.container.visible = false;

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	cam.targetPosition.copy( vehicle.spherePos );

	// ── HUD Extras: speedometer, minimap, shortcuts overlay ──
	hudExtras = new HudExtras( {
		vehicle, cells: customCells || TRACK_CELLS, camera: cam.camera
	} );
	const cam2 = isSplitScreen ? new Camera() : null;

	// Chase-cam hitbox clipping: a REAL physics raycast (crashcat castRay) from
	// the car toward the camera each frame. Static hitboxes only — walls,
	// buildings, track pieces; never the car itself or other dynamic bodies.
	// If the segment is blocked, the camera pulls in front of the hitbox
	// instead of clipping inside it. Chase cam only; the fixed overview cam
	// keeps its framing untouched.
	const camRayCollector = createAnyCastRayCollector();
	const camRaySettings = createDefaultCastRaySettings();
	const camRayFilter = ccLayerFilter.forWorld( world );
	camRayFilter.bodyFilter = ( body ) => body && body.motionType === MotionType.STATIC;
	const CAM_CLIP_MARGIN = 0.4; // hover distance off hitbox surfaces
	const CAM_CLIP_MIN = 1.4;     // never closer to the car than this
	const camRayOrigin = [ 0, 0, 0 ];
	const camRayDir = [ 0, 0, 0 ];
	const camClipProbe = ( origin, dir, length ) => {

		camRayOrigin[ 0 ] = origin.x;
		camRayOrigin[ 1 ] = origin.y;
		camRayOrigin[ 2 ] = origin.z;
		camRayDir[ 0 ] = dir.x;
		camRayDir[ 1 ] = dir.y;
		camRayDir[ 2 ] = dir.z;
		// AnyCastRayCollector.addMiss() is a no-op — stale hits linger, so reset() before every cast.
		camRayCollector.reset();
		castRay( world, camRayCollector, camRaySettings, camRayOrigin, camRayDir, length, camRayFilter );
		if ( camRayCollector.hit.status !== CastRayStatus.COLLIDING ) return length;
		// First hit along the car→camera segment: park the camera just short of it.
		let freeLen = camRayCollector.hit.fraction * length - CAM_CLIP_MARGIN;
		freeLen = Math.max( freeLen, Math.min( CAM_CLIP_MIN, length ) );
		return Math.min( freeLen, length );

	};
	cam.clipProbe = camClipProbe;
	if ( cam2 ) cam2.clipProbe = camClipProbe;

	// Reused each frame for cam.update() dynamics to avoid allocating an options
	// object on every camera update (up to 4 calls/frame). cam.update only reads the
	// fields, it never retains the reference.
	const _camDynamics1 = { speedRatio: 0, driftIntensity: 0, underwaterCamera: false, waterSurfaceY: 0.12 };
	const _camDynamics2 = { speedRatio: 0, driftIntensity: 0, underwaterCamera: false, waterSurfaceY: 0.12 };

	if ( cam2 && vehicle2 ) {

		cam2.targetPosition.copy( vehicle2.spherePos );
		cam2.toggleMode();

	}

	const controls = isSplitScreen
		? new Controls( { leftKeys: [ 'KeyA' ], rightKeys: [ 'KeyD' ], forwardKeys: [ 'KeyW' ], backKeys: [ 'KeyS' ], enableGamepad: false, enableTouch: false } )
		: new Controls();
	const controls2 = isSplitScreen
		? new Controls( { leftKeys: [ 'ArrowLeft' ], rightKeys: [ 'ArrowRight' ], forwardKeys: [ 'ArrowUp' ], backKeys: [ 'ArrowDown' ], enableGamepad: false, enableTouch: false } )
		: null;

	let customModGravityScale = 1;
	let customModTimeScale = 1;
	let customModShakeUntil = 0;
	let customModShakeIntensity = 0;
	let crashShakeTime = 0;
	let crashShakeStrength = 0;
	let customModParticleBurstSeconds = 0;
	let customModForceBrakeUntil = 0;
	let customModForceThrottleUntil = 0;
	let customModNoSteerUntil = 0;
	let customModFogStrength = 1;
	// Default to null so that, with NO custom mod installed, drift particles fall back to
	// the normal grey DEFAULT_PARTICLE_COLOR in Particles.js (this.customColor || default).
	// Previously this defaulted to a red THREE.Color, so drift particles were always red
	// even with zero mods installed. Only a mod calling api.setParticleColor() sets this.
	let customModParticleColor = null;
	let customModFlashColor = new THREE.Color( 0xffffff );
	let customModFlashUntil = 0;
	let customModFlashOverlay = null;
	let customModSnowIntensity = 0;
	let customModRainIntensity = 0;
	const runtimeModContext = {
		vehicle,
		world,
		scene,
		controls,
		renderer,
		camera: cam,
		playbackController: new DeterministicPlaybackController(),
		resetPlayerVehicle: () => vehicle.resetToSpawn(),
		getState: () => ( {
			coins,
			lapNumber,
			lapTime: raceClockSeconds - lapStartSeconds,
			raceTime: raceClockSeconds,
			bestLapSeconds,
			lastLapSeconds,
			stuntPoints,
			stuntCombo,
			driftIntensity: vehicle?.driftIntensity || 0,
			// PHYSICAL speed (world u/s — the same base the HUD speedometer reads),
			// not the drive model's internal wheel-speed scalar (which topped out
			// at ~1.8 and made every speed input meaningless to players).
			linearSpeed: ( () => { const lv = vehicle?.rigidBody?.motionProperties?.linearVelocity; return lv ? Math.hypot( lv[ 0 ], lv[ 1 ], lv[ 2 ] ) : Math.abs( Number( vehicle?.linearSpeed ) || 0 ); } )(),
			angularSpeed: Number( vehicle?.angularSpeed ) || 0,
			gameMode,
			isSplitScreen,
			paused,
			fps: rollingFps || 0,
			x: Number( vehicle?.spherePos?.x ) || 0,
			y: Number( vehicle?.spherePos?.y ) || 0,
			z: Number( vehicle?.spherePos?.z ) || 0,
			topSpeed: Number( vehicle?.topSpeed ) || 1,
			accelRate: Number( vehicle?.accelRate ) || 6,
			driveForce: Number( vehicle?.driveForce ) || 100,
			gripMultiplier: Number( vehicle?.gripMultiplier ) || 1,
			dragMultiplier: Number( vehicle?.dragMultiplier ) || 1,
			accelMultiplier: Number( vehicle?.accelMultiplier ) || 1,
			driveMultiplier: Number( vehicle?.driveMultiplier ) || 1,
			heading: ( ( Number( vehicle?.container?.rotation?.y ) || 0 ) * 180 / Math.PI ) % 360,
			velocityX: Number( vehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 0 ] ) || 0,
			velocityY: Number( vehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] ) || 0,
			velocityZ: Number( vehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 2 ] ) || 0,
			timeScale: Number( customModTimeScale ) || 1,
			gravity: Number( customModGravityScale ) * 9.81,
		} ),
		api: {
			showMessage: ( message, event = {} ) => window.setTimeout( () => showTopMessage( String( message || '' ), false, event?.durationMs || 1600 ), 0 ),
			setSpeed: ( speed ) => {
				const value = Number( speed );
				if ( ! Number.isFinite( value ) || ! vehicle?.rigidBody ) return;
				const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 );
				if ( forward.lengthSq() < 1e-6 ) return;
				forward.normalize();
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ forward.x * value, current[ 1 ], forward.z * value ] );
			},
			boost: ( amount = 1 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const value = Number.isFinite( Number( amount ) ) ? Number( amount ) : 1;
				const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 );
				if ( forward.lengthSq() < 1e-6 ) return;
				forward.normalize();
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ current[ 0 ] + forward.x * value, current[ 1 ], current[ 2 ] + forward.z * value ] );
				customModParticleBurstSeconds = Math.max( customModParticleBurstSeconds, Math.max( 0.25, Math.min( 2.5, Math.abs( value ) * 0.08 ) ) );
			},
			setGravity: ( gravity ) => {
				const g = Number( gravity );
				customModGravityScale = Number.isFinite( g ) && g > 0 ? THREE.MathUtils.clamp( g / 9.81, 0.05, 5 ) : 1;
			},
			spawnParticle: () => { customModParticleBurstSeconds = Math.max( customModParticleBurstSeconds, 0.45 ); },
			jump: ( power = 6 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ current[ 0 ], Math.max( current[ 1 ], 0 ) + ( Number( power ) || 6 ), current[ 2 ] ] );
			},
			resetCar: () => vehicle.resetToSpawn(),
			setTimeScale: ( scale = 1 ) => { customModTimeScale = THREE.MathUtils.clamp( Number( scale ) || 1, 0.1, 4 ); },
			setAccelMultiplier: ( value = 1 ) => { vehicle.__modAccel = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); vehicle.accelMultiplier = ( vehicle.accelMultiplier || 1 ) * vehicle.__modAccel; },
			setDriveMultiplier: ( value = 1 ) => { vehicle.__modDrive = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); vehicle.driveMultiplier = Math.min( 4, ( vehicle.driveMultiplier || 1 ) * vehicle.__modDrive ); },
			setGripMultiplier: ( value = 1 ) => { vehicle.__modGrip = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); vehicle.gripMultiplier = ( vehicle.gripMultiplier || 1 ) * vehicle.__modGrip; },
			forceBrake: ( secs = 0.4 ) => { customModForceBrakeUntil = Math.max( customModForceBrakeUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.4, 0.05, 8 ) ); },
			forceThrottle: ( secs = 0.4 ) => { customModForceThrottleUntil = Math.max( customModForceThrottleUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.4, 0.05, 8 ) ); },
			disableSteering: ( secs = 0.5 ) => { customModNoSteerUntil = Math.max( customModNoSteerUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.5, 0.05, 8 ) ); },
			setFogStrength: ( value = 1 ) => { customModFogStrength = THREE.MathUtils.clamp( Number( value ) || 1, 0, 2 ); },
			// Boot-safe: mods run onStart before the garage/economy HUD exists —
			// the coin state must still update (and must never kill the rest of
			// a mod's onStart when the HUD write isn't ready yet).
			addCoins: ( amount = 0 ) => {
				if ( isSplitScreen ) return;
				coins = Math.max( 0, Math.floor( coins + ( Number( amount ) || 0 ) ) );
				try { saveEconomy(); updateEconomyHud(); } catch { /* HUD not ready (mod onStart at boot) */ }
			},
			cameraShake: ( intensity = 1 ) => {
				customModShakeIntensity = Math.max( customModShakeIntensity, Math.max( 0, Number( intensity ) || 0 ) );
				customModShakeUntil = Math.max( customModShakeUntil, raceClockSeconds + 0.45 );
			},
			// --- Extended custom-mod API (added for expanded Custom Mods Lab) ---
			// All numeric inputs are clamped to safe, non-exploitable ranges.
			// Mod-set multipliers (__modX) are folded into the per-frame recompute in
			// applySurfaceGrip/applyVehicleScaleFromPad — writing the derived field
			// directly (vehicle.topSpeed etc.) was stomped back within one frame,
			// which made these blocks literal no-ops.
			setTopSpeed: ( value = 1 ) => { vehicle.__modSpeed = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 5 ); vehicle.topSpeed = ( Number.isFinite( vehicle.baseTopSpeed ) ? vehicle.baseTopSpeed : vehicle.topSpeed ) * vehicle.__modSpeed; },
			setAccelRate: ( value = 6 ) => { vehicle.accelRate = THREE.MathUtils.clamp( Number( value ) || 6, 0.5, 30 ); },
			setBrakeRate: ( value = 8 ) => { vehicle.brakeRate = THREE.MathUtils.clamp( Number( value ) || 8, 1, 40 ); },
			setDriveForce: ( value = 100 ) => { vehicle.driveForce = THREE.MathUtils.clamp( Number( value ) || 100, 10, 400 ); },
			setDragMultiplier: ( value = 1 ) => { vehicle.__modDrag = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 5 ); vehicle.dragMultiplier = ( vehicle.dragMultiplier || 1 ) * vehicle.__modDrag; },
			setReverseAccelRate: ( value = 2 ) => { vehicle.reverseAccelRate = THREE.MathUtils.clamp( Number( value ) || 2, 0.5, 20 ); },
			setVehicleScale: ( value = 1 ) => {
				const s = THREE.MathUtils.clamp( Number( value ) || 1, 0.25, 3 );
				if ( ! vehicle ) return;
				vehicle.__modScale = s;
				if ( vehicle.container ) vehicle.container.scale.setScalar( s );
			},
			setVehicleVisible: ( value = 1 ) => { if ( vehicle?.container ) vehicle.container.visible = Boolean( value ); },
			setEngineVolume: ( value = 1 ) => {
				if ( ! window.__gameAudio ) return;
				window.__gameAudio.settings.sfxVolume = THREE.MathUtils.clamp( Number( value ) || 1, 0, 1 );
			},
			setMusicVolume: ( value = 1 ) => {
				if ( ! window.__gameAudio ) return;
				window.__gameAudio.settings.musicVolume = THREE.MathUtils.clamp( Number( value ) || 1, 0, 1 );
			},
			playImpactSound: ( velocity = 3 ) => { window.__gameAudio?.playImpact?.( THREE.MathUtils.clamp( Number( velocity ) || 3, 0, 10 ) ); },
			setBackgroundColor: ( hex = '#bfe0ff' ) => {
				try { scene.background = new THREE.Color( String( hex ) || '#bfe0ff' ); } catch { /* ignore invalid color */ }
			},
			setFogColor: ( hex = '#bfe0ff' ) => {
				try { if ( scene.fog ) scene.fog.color = new THREE.Color( String( hex ) || '#bfe0ff' ); } catch { /* ignore invalid color */ }
			},
			setFogDensity: ( value = 1 ) => { customModFogStrength = THREE.MathUtils.clamp( Number( value ) || 1, 0, 2 ); },
			setSkyColor: ( hex = '#1c5fd6' ) => {
				try { skyUniforms.topColor.value.set( String( hex ) || '#1c5fd6' ); } catch { /* ignore invalid color */ }
			},
			setHorizonColor: ( hex = '#ffe2aa' ) => {
				try { skyUniforms.horizonColor.value.set( String( hex ) || '#ffe2aa' ); } catch { /* ignore invalid color */ }
			},
			setSunIntensity: ( value = 5 ) => { dirLight.intensity = THREE.MathUtils.clamp( Number( value ) || 5, 0, 10 ); },
			setHemiIntensity: ( value = 1.5 ) => { hemiLight.intensity = THREE.MathUtils.clamp( Number( value ) || 1.5, 0, 5 ); },
			setExposure: ( value = 1 ) => { renderer.toneMappingExposure = THREE.MathUtils.clamp( Number( value ) || 1, 0.2, 3 ); },
			setCameraFov: ( value = 42 ) => {
				if ( ! cam?.camera ) return;
				cam.camera.fov = THREE.MathUtils.clamp( Number( value ) || 42, 20, 110 );
				cam.camera.updateProjectionMatrix();
			},
			setCameraMode: ( mode = 'chase' ) => { if ( cam && ( mode === 'chase' || mode === 'overview' ) ) { cam.mode = mode; cam.hasChaseYaw = false; } },
			setParticleColor: ( hex = '#ff4b1f' ) => {
				try { customModParticleColor = new THREE.Color( String( hex ) || '#ff4b1f' ); } catch { /* ignore invalid color */ }
			},
			spawnParticleBurst: ( secs = 0.45 ) => { customModParticleBurstSeconds = Math.max( customModParticleBurstSeconds, THREE.MathUtils.clamp( Number( secs ) || 0.45, 0.1, 4 ) ); },
			// Sustained car spin: the drive model owns the car's yaw
			// (container.rotateY(angularSpeed * dt) every frame), so a one-shot
			// angular-velocity or rotation write was gone within a frame. The
			// rate persists in __modSpin and Vehicle.update applies it alongside
			// steering — set 0 to stop spinning.
			setVehicleSpin: ( rad = 0 ) => {
				if ( ! vehicle ) return;
				vehicle.__modSpin = THREE.MathUtils.clamp( Number( rad ) || 0, -Math.PI * 4, Math.PI * 4 );
				if ( vehicle.container ) vehicle.container.rotateY( vehicle.__modSpin * 0.05 );
			},
			applyImpulse: ( x = 0, y = 0, z = 0 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const cx = THREE.MathUtils.clamp( Number( x ) || 0, -20, 20 );
				const cy = THREE.MathUtils.clamp( Number( y ) || 0, -20, 20 );
				const cz = THREE.MathUtils.clamp( Number( z ) || 0, -20, 20 );
				const cur = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ cur[ 0 ] + cx, cur[ 1 ] + cy, cur[ 2 ] + cz ] );
			},
			setAngularImpulse: ( x = 0, y = 0, z = 0 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const cx = THREE.MathUtils.clamp( Number( x ) || 0, -10, 10 );
				const cy = THREE.MathUtils.clamp( Number( y ) || 0, -10, 10 );
				const cz = THREE.MathUtils.clamp( Number( z ) || 0, -10, 10 );
				const cur = vehicle.rigidBody.motionProperties?.angularVelocity || [ 0, 0, 0 ];
				rigidBody.setAngularVelocity( world, vehicle.rigidBody, [ cur[ 0 ] + cx, cur[ 1 ] + cy, cur[ 2 ] + cz ] );
			},
			teleport: ( x = 0, y = 1, z = 0 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const cx = THREE.MathUtils.clamp( Number( x ) || 0, -200, 200 );
				const cy = THREE.MathUtils.clamp( Number( y ) || 1, 0, 100 );
				const cz = THREE.MathUtils.clamp( Number( z ) || 0, -200, 200 );
				rigidBody.setPosition( world, vehicle.rigidBody, [ cx, cy, cz ], false );
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
				rigidBody.setAngularVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
			},
			setHudText: ( text = '' ) => {
				if ( topMessage ) {
					topMessage.textContent = String( text || '' ).slice( 0, 120 );
					topMessage.classList.add( 'show' );
					topMessage.classList.remove( 'error' );
				}
			},
			setEffectMessage: ( text = '' ) => {
				if ( effectMessage ) {
					effectMessage.textContent = String( text || '' ).slice( 0, 120 );
					effectMessage.classList.add( 'show' );
					window.clearTimeout( effectMessageTimeout );
					effectMessageTimeout = window.setTimeout( () => { if ( effectMessage ) effectMessage.classList.remove( 'show' ); }, 2000 );
				}
			},
			// Works in ANY game mode — the in-game addStuntPoints is
			// stunt-mode-only, which made this block a silent no-op in
			// normal races.
			addStuntPoints: ( amount = 0, reason = '' ) => {
				try {
					const amt = THREE.MathUtils.clamp( Number( amount ) || 0, 0, 1000 );
					if ( amt > 0 ) {
						stuntPoints += amt;
						if ( stuntPoints > bestStuntPoints ) {
							bestStuntPoints = stuntPoints;
							try { saveStuntStats(); } catch { /* not ready at boot */ }
							try { updateGarageUi(); } catch { /* not ready at boot */ }
						}
					}
				} catch { /* state not ready (mod onStart at boot) */ }
			},
			setFpsCounter: ( visible = 1 ) => { if ( fpsHud ) fpsHud.style.display = Boolean( visible ) ? 'block' : 'none'; },
			setSkyVibrance: ( value = 0.2 ) => { skyUniforms.vibrance.value = THREE.MathUtils.clamp( Number( value ) || 0, 0, 1 ); },
			setRendererPixelRatio: ( value = 1 ) => { renderer.setPixelRatio( THREE.MathUtils.clamp( Number( value ) || 1, 0.25, 2 ) ); },
			setShadowEnabled: ( value = 1 ) => { renderer.shadowMap.enabled = Boolean( value ); renderer.shadowMap.needsUpdate = true; },
			flashScreen: ( hex = '#ffffff' ) => {
				try { customModFlashColor = new THREE.Color( String( hex ) || '#ffffff' ); customModFlashUntil = raceClockSeconds + 0.3; } catch { /* ignore */ }
			},
			setDriftIntensity: ( value = 0 ) => { vehicle.__modDrift = THREE.MathUtils.clamp( Number( value ) || 0, 0, 2 ); },
			setSkyPalette: ( preset = 'clear' ) => {
				const p = WEATHER_PRESETS[ preset ] ? preset : 'clear';
				applySkyPalette( p );
				buildSkyDecorations( p );
			},
			getModelNames: () => Object.keys( CAR_STATS ),
			setVehicleModel: ( key = 'vehicle-truck-yellow' ) => {
				if ( ! CAR_STATS[ key ] || ! models[ key ] ) return;
				vehicle.setModel( models[ key ] );
				applyVehiclePerformance();
			},
			// --- Extended custom-mod API (added for the expanded block set) ---
			// All numeric inputs are clamped to safe, non-exploitable ranges.
			setCameraDistance: ( value = 8 ) => { if ( cam ) { cam.userDistance = THREE.MathUtils.clamp( Number( value ) || 8, 2, 30 ); } },
			setCameraHeight: ( value = 3 ) => { if ( cam ) { cam.userHeight = THREE.MathUtils.clamp( Number( value ) || 3, 0, 20 ); } },
			setCameraLag: ( value = 1 ) => { if ( cam ) { cam.userLagScale = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 1 ); } },
			setCameraPitch: ( value = 0 ) => { if ( cam ) { cam.userPitch = THREE.MathUtils.clamp( Number( value ) || 0, -45, 45 ) * Math.PI / 180; } },
			setSunPosition: ( value = 45 ) => { if ( dirLight ) { const a = THREE.MathUtils.clamp( Number( value ) || 45, 0, 360 ) * Math.PI / 180; const r = dirLight.position.length() || 60; dirLight.position.set( Math.cos( a ) * r, Math.sin( a ) * r + 10, Math.sin( a ) * r ); } },
			setSnowIntensity: ( value = 0 ) => {
				const v = THREE.MathUtils.clamp( Number( value ) || 0, 0, 1 );
				try {
					weatherSettings.precipitation = v > 0 ? 'snow' : 'none';
					weatherSettings.intensity = v < 0.34 ? 'low' : ( v < 0.67 ? 'medium' : 'high' );
					clearWeatherFx(); setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
				} catch { customModSnowIntensity = v; }
			},
			setRainIntensity: ( value = 0 ) => {
				const v = THREE.MathUtils.clamp( Number( value ) || 0, 0, 1 );
				try {
					weatherSettings.precipitation = v > 0 ? 'rain' : 'none';
					weatherSettings.intensity = v < 0.34 ? 'low' : ( v < 0.67 ? 'medium' : 'high' );
					clearWeatherFx(); setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
				} catch { customModRainIntensity = v; }
			},
			playCue: ( name = 'click' ) => {
				const a = window.__gameAudio;
				if ( ! a || typeof a.playImpact !== 'function' ) return;
				// Map every cue to the existing impact sound pool with a cue-specific
				// velocity so each option produces a distinct, audible sound.
				const vel = { boost: 6, checkpoint: 4, crash: 7, lap: 3, coin: 1.5, click: 0.8 }[ name ] || 3;
				try { a.playImpact( vel ); } catch { /* ignore */ }
			},
			respawn: () => { try { respawnVehicle(); } catch { /* ignore */ } },
			setPaused: ( next = true ) => { try { setPaused( !! next ); } catch { /* ignore */ } },
		},
		// --- Sandboxed UI builder: lets mods create their own buttons, panels,
		// labels, sliders, etc. inside an isolated overlay, without ever being
		// able to touch the game's own DOM. Everything created here is tracked
		// so ui.clear() (call from dispose()) tears it down cleanly. ---
		ui: createModUiLayer(),
		// --- Namespaced, size-capped persistent storage for mod data. Keys are
		// automatically prefixed with the mod id and values are JSON-serialised. ---
		storage: createModStorage( 'mod' ),
	};
	for ( const runtime of runtimeMods ) {

		try {

			// Give each mod its own sandboxed UI layer + storage namespace so one
			// mod's ui.clear()/storage.clear() can never affect another mod.
			const modId = String( runtime?.id || 'mod' ).replace( /[^a-z0-9_-]/gi, '-' ).slice( 0, 40 ) || 'mod';
			const scopedContext = Object.create( runtimeModContext );
			scopedContext.ui = createModUiLayer();
			scopedContext.storage = createModStorage( modId );
			runtime._modId = modId;
			runtime._scopedContext = scopedContext;
			// Defer init until the synchronous boot has finished: this loop ran
			// before game state (coins etc.) was declared, so any onStart action
			// touching it died on a TDZ ReferenceError and killed the rest of
			// the mod's startup (e.g. add_coins as the FIRST action = whole
			// onStart dead). A microtask fires right after init() completes —
			// still before the first rendered frame.
			queueMicrotask( () => {
				try {
					runtime.init( scopedContext );
				} catch ( error ) {
					console.warn( `Mod init failed: ${ modId }`, error );
				}
			} );
			// Make the mod's activation unmistakable: custom-* mods (Blockly custom mods)
			// announce themselves so the player knows the installed mod is live and will
			// affect gameplay (and that leaderboard is disabled while it runs).
			if ( modId.startsWith( 'custom-' ) ) {
				appendLoadingConsole( `Custom mod active: ${ modId }` );
				window.setTimeout( () => showTopMessage( `Custom mod active: ${ modId }. Leaderboard is disabled while it runs.`, false, 3200 ), 600 );
			}

		} catch ( error ) {

			console.warn( `Mod init failed: ${ runtime?.id || 'unknown' }`, error );

		}

	}
	window.addEventListener( 'beforeunload', () => {

		for ( const runtime of runtimeMods ) {

			if ( typeof runtime?.dispose === 'function' ) {
				try {

					runtime.dispose();

				} catch ( error ) {

					console.warn( `Mod dispose failed: ${ runtime?.id || 'unknown' }`, error );

				}
			}
			// Safety net: always tear down any UI the mod created, even if its
			// dispose() forgot to call ui.clear().
			try { runtime?._scopedContext?.ui?.clear?.(); } catch { /* ignore */ }

		}

	} );

	function dispatchRuntimeModEvent( hookName, payload = {} ) {
		for ( const runtime of runtimeMods ) {
			if ( typeof runtime?.[ hookName ] !== 'function' ) continue;
			try {
				runtime[ hookName ]( { ...payload, vehicle, world, controls, now: raceClockSeconds } );
			} catch ( error ) {
				console.warn( `Mod ${ hookName } failed: ${ runtime?.id || 'unknown' }`, error );
			}
		}
	}

	const particles = new SmokeTrails( scene, getGraphicsParticleOptions() );
	const particles2 = isSplitScreen ? new SmokeTrails( scene, getGraphicsParticleOptions() ) : null;
	// Drift skid marks from both rear tires — one shared ring-buffer pool.
	// Grounded check = a REAL physics raycast through crashcat (castRay) against
	// the static track colliders only — no height detection, so airborne cars
	// (jumps, trick pads, flying off slopes) never lay marks.
	const skidRayCollector = createAnyCastRayCollector();
	const skidRaySettings = createDefaultCastRaySettings();
	const skidRayFilter = ccLayerFilter.forWorld( world );
	skidRayFilter.bodyFilter = ( body ) => body && body.motionType === MotionType.STATIC;
	const SKID_RAY_LIFT = 0.05;   // cast from just above the tire contact patch
	const SKID_RAY_REACH = 0.4;   // ground must be within this of the patch
	const skidRayOrigin = [ 0, 0, 0 ];
	const skidRayDown = [ 0, - 1, 0 ];
	const skidGroundRaycast = ( vehicle, contactPoint ) => {

		skidRayOrigin[ 0 ] = contactPoint.x;
		skidRayOrigin[ 1 ] = contactPoint.y + SKID_RAY_LIFT;
		skidRayOrigin[ 2 ] = contactPoint.z;
		// AnyCastRayCollector.addMiss() is a no-op — stale hits linger, so reset() before every cast.
		skidRayCollector.reset();
		castRay( world, skidRayCollector, skidRaySettings, skidRayOrigin, skidRayDown, SKID_RAY_LIFT + SKID_RAY_REACH, skidRayFilter );
		return skidRayCollector.hit.status === CastRayStatus.COLLIDING;

	};
	const skidMarks = new SkidMarks( scene, {
		enabled: ( getGraphicsPreset().smokeParticles ?? 64 ) > 0,
		groundTest: skidGroundRaycast,
	} );
	const lapHud = document.getElementById( 'lap-hud' );
	const lapHud2 = document.getElementById( 'lap-hud-2' );
	const countdownHud = document.getElementById( 'countdown-hud' );
	const fpsHud = document.getElementById( 'fps-hud' );
	const pausePanel = document.getElementById( 'pause-panel' );
	const respawnBtn = document.getElementById( 'respawnBtn' );
	const modeMenuBtn = document.getElementById( 'mode-menu-btn' );
	const topMessage = document.getElementById( 'top-message' );
	const effectMessage = document.getElementById( 'effect-message' );
	let effectMessageTimeout = null;
	const carSelect = document.getElementById( 'car-select' );
	const defaultCarSelect = document.getElementById( 'default-car-select' );
	const coinsLabel = document.getElementById( 'coins-label' );
	const accountCoinsValue = document.getElementById( 'account-coins-value' );
	const shareTimeBtn = document.getElementById( 'share-time-btn' );
	const exportGhostBtn = document.getElementById( 'export-ghost-btn' );
	const importGhostBtn = document.getElementById( 'import-ghost-btn' );
	const hacksToggleLink = document.getElementById( 'hacks-toggle' );
	const hacksPanel = document.getElementById( 'hacks-panel' );
	const hackEnableInput = document.getElementById( 'hack-enable' );
	const hackInfiniteCoinsInput = document.getElementById( 'hack-infinite-coins' );
	const hackBoostAnywhereInput = document.getElementById( 'hack-boost-anywhere' );
	const hackNoLimitsInput = document.getElementById( 'hack-no-limits' );
	const hackAlwaysNitroInput = document.getElementById( 'hack-always-nitro' );
	const hackSuperJumpInput = document.getElementById( 'hack-super-jump' );
	const hackTeleportInput = document.getElementById( 'hack-teleport' );
	const hackLowFrictionInput = document.getElementById( 'hack-low-friction' );
	const hackInstantStopInput = document.getElementById( 'hack-instant-stop' );
	const hackCheckpointBypassInput = document.getElementById( 'hack-checkpoint-bypass' );
	const hackShowHitboxesInput = document.getElementById( 'hack-show-hitboxes' );
	const hackTimescaleInput = document.getElementById( 'hack-timescale' );
	const hackGravityInput = document.getElementById( 'hack-gravity' );
	const hackRoadGripInput = document.getElementById( 'hack-road-grip' );
	const hackResetBtn = document.getElementById( 'hack-reset-btn' );
	const economyHud = document.getElementById( 'economy-hud' );
	const boostUi = document.getElementById( 'boost-ui' );
	const boostFill = document.getElementById( 'boost-fill' );
	const boostActivateBtn = document.getElementById( 'boost-activate-btn' );
	const arcLinkUi = document.getElementById( 'arc-link-ui' );
	const modeMenu = document.getElementById( 'mode-menu' );
	const modeError = document.getElementById( 'mode-error' );
	const playerNameInput = document.getElementById( 'player-name-input' );
	const leaderboardList = document.getElementById( 'leaderboard-list' );
	const leaderboardEmpty = document.getElementById( 'leaderboard-empty' );
	const leaderboardTrackLabel = document.getElementById( 'leaderboard-track-label' );
	let leaderboardPercentileLabel = document.getElementById( 'leaderboard-percentile-label' );
	const leaderboardRefreshBtn = document.getElementById( 'leaderboard-refresh-btn' );
	const leaderboardPanel = document.getElementById( 'leaderboard-panel' );
	const leaderboardToggleBtn = document.getElementById( 'leaderboard-toggle-btn' );
	const pauseToggleBtn = document.getElementById( 'pause-toggle-btn' );
	if ( leaderboardPanel && ! leaderboardPercentileLabel ) {

		leaderboardPercentileLabel = document.createElement( 'div' );
		leaderboardPercentileLabel.id = 'leaderboard-percentile-label';
		leaderboardPercentileLabel.style.fontSize = '12px';
		leaderboardPercentileLabel.style.color = '#bde6ff';
		leaderboardPercentileLabel.style.marginBottom = '8px';
		leaderboardPanel.insertBefore( leaderboardPercentileLabel, leaderboardEmpty || leaderboardList || null );

	}
	const fxSettings = {
		recentGhostsEnabled: false,
		recentGhostPathEnabled: false,
		recentGhostCount: 3,
	};
	try {

		const parsed = JSON.parse( localStorage.getItem( FX_SETTINGS_KEY ) || '{}' );
		if ( typeof parsed?.recentGhostsEnabled === 'boolean' ) fxSettings.recentGhostsEnabled = parsed.recentGhostsEnabled;
		if ( Number.isFinite( Number( parsed?.recentGhostCount ) ) ) fxSettings.recentGhostCount = THREE.MathUtils.clamp( Math.round( Number( parsed.recentGhostCount ) ), 1, 20 );

	} catch {}

	const fxPanel = document.createElement( 'section' );
	fxPanel.id = 'gameplay-ghost-settings';
	fxPanel.style.marginTop = '10px';
	fxPanel.style.padding = '10px';
	fxPanel.style.border = '1px solid rgba(255,255,255,0.14)';
	fxPanel.style.borderRadius = '10px';
	fxPanel.style.background = 'rgba(255,255,255,0.06)';
	fxPanel.innerHTML = `<h4 style="margin:0 0 8px;font:800 12px/1.2 sans-serif;color:#bde6ff;">Ghosts</h4>
	<label style="display:block;margin-bottom:6px;"><input id="fx-recent-ghosts" type="checkbox" ${ fxSettings.recentGhostsEnabled ? 'checked' : '' }> Show recent ghosts</label>
	<label style="display:block;margin-top:4px;">Recent ghost count <input id="fx-recent-ghost-count" type="number" min="1" max="20" step="1" value="${ fxSettings.recentGhostCount }" style="width:100%;margin-top:3px;background:#0f1520;color:#e9f5ff;border:1px solid rgba(255,255,255,0.25);border-radius:6px;padding:4px 6px;"></label>`;
	const gameplayPanel = document.getElementById( 'mode-panel-gameplay' );
	const graphicsSection = document.getElementById( 'graphics-section' );
	if ( gameplayPanel ) gameplayPanel.insertBefore( fxPanel, graphicsSection || null );
	const fxRecentGhostsInput = fxPanel.querySelector( '#fx-recent-ghosts' );
	const fxRecentGhostCountSelect = fxPanel.querySelector( '#fx-recent-ghost-count' );
	if ( fxRecentGhostCountSelect ) fxRecentGhostCountSelect.value = String( fxSettings.recentGhostCount );
	const saveFxSettings = () => {
		localStorage.setItem( FX_SETTINGS_KEY, JSON.stringify( fxSettings ) );
		try { GameSettings.patchSettings( { gameplay: {
			recentGhostsEnabled: fxSettings.recentGhostsEnabled,
			recentGhostCount: fxSettings.recentGhostCount,
		} } ); } catch ( e ) {}
	};
	fxRecentGhostsInput?.addEventListener( 'change', () => {

		fxSettings.recentGhostsEnabled = Boolean( fxRecentGhostsInput.checked );
		saveFxSettings();
		rebuildRecentGhostVisuals();
		rebuildGhostSpreadLine();

	} );
	fxRecentGhostCountSelect?.addEventListener( 'change', () => {

		const value = Number( fxRecentGhostCountSelect.value );
		if ( Number.isFinite( value ) ) fxSettings.recentGhostCount = THREE.MathUtils.clamp( Math.round( value ), 1, 20 );
		fxRecentGhostCountSelect.value = String( fxSettings.recentGhostCount );
		saveFxSettings();
		rebuildRecentGhostVisuals();
		rebuildGhostSpreadLine();

	} );
	const namePopup = document.getElementById( 'name-popup' );
	const namePopupInput = document.getElementById( 'name-popup-input' );
	const namePopupSave = document.getElementById( 'name-popup-save' );
	const namePopupSkip = document.getElementById( 'name-popup-skip' );
	const raceModeBtn = document.getElementById( 'mode-race-btn' );
	const advModeBtn = document.getElementById( 'mode-advancements-btn' );
	const advOverlay = document.getElementById( 'adv-overlay' );
	const advClose = document.getElementById( 'adv-close' );
	const advCanvas = document.getElementById( 'adv-canvas' );
	const advGraph = document.getElementById( 'adv-graph' );
	const advToast = document.getElementById( 'adv-toast' );
	const stuntModeBtn = document.getElementById( 'mode-stunt-btn' );
	const campaignModeBtn = document.getElementById( 'mode-campaign-btn' );
	const campaignInfoBtn = document.getElementById( 'campaign-info-btn' );
	const fpsToggle = document.getElementById( 'fps-toggle' );
	const graphicsQualityButtons = Array.from( document.querySelectorAll( '[data-graphics-quality]' ) );
	const graphicsQualityLabel = document.getElementById( 'graphics-quality-label' );
	const modeTabGameplayBtn = document.getElementById( 'mode-tab-gameplay' );
	const modeTabGarageBtn = document.getElementById( 'mode-tab-garage' );
	const modeTabAccountBtn = document.getElementById( 'mode-tab-account' );
	const modeTabNavBtn = document.getElementById( 'mode-tab-nav' );
	const modePanelGameplay = document.getElementById( 'mode-panel-gameplay' );
	const modePanelGarage = document.getElementById( 'mode-panel-garage' );
	const modePanelAccount = document.getElementById( 'mode-panel-account' );
	const modePanelNav = document.getElementById( 'mode-panel-nav' );
	const campaignProgressLabel = document.getElementById( 'campaign-progress' );
	const stuntPointsHud = document.getElementById( 'stunt-points' );
	const garageVehicleCards = document.getElementById( 'garage-vehicle-cards' );
	const garageCarSelect = document.getElementById( 'garage-car-select' );
	const garageGripSlider = document.getElementById( 'garage-grip' );
	const garageAccelSlider = document.getElementById( 'garage-accel' );
	const garageDriveSlider = document.getElementById( 'garage-drive' );
	const garageGripValue = document.getElementById( 'garage-grip-value' );
	const garageAccelValue = document.getElementById( 'garage-accel-value' );
	const garageDriveValue = document.getElementById( 'garage-drive-value' );
	const garageGripStatus = document.getElementById( 'garage-grip-status' );
	const garageAccelStatus = document.getElementById( 'garage-accel-status' );
	const garageDriveStatus = document.getElementById( 'garage-drive-status' );
	const garageGripUnlockBtn = document.getElementById( 'garage-grip-unlock' );
	const garageAccelUnlockBtn = document.getElementById( 'garage-accel-unlock' );
	const garageDriveUnlockBtn = document.getElementById( 'garage-drive-unlock' );
	const garageViewerCanvas = document.getElementById( 'garage-viewer' );
	const garageViewerHint = document.getElementById( 'garage-viewer-hint' );
	const garageDriveBtn = document.getElementById( 'garage-drive-btn' );
	const garageTargetColorInput = document.getElementById( 'garage-target-color' );
	const garageApplyPaintBtn = document.getElementById( 'garage-apply-paint-btn' );
	const garageClearSelectionBtn = document.getElementById( 'garage-clear-selection-btn' );
	const garageRepaintToleranceInput = document.getElementById( 'garage-repaint-tolerance' );
	const garageRepaintToleranceValue = document.getElementById( 'garage-repaint-tolerance-value' );
	const garageSelectionChip = document.getElementById( 'garage-selection-chip' );
	const garageMappingStatus = document.getElementById( 'garage-mapping-status' );
	const garageMappingsList = document.getElementById( 'garage-mappings-list' );
	const profileExportBtn = document.getElementById( 'profile-export-btn' );
	const profileImportBtn = document.getElementById( 'profile-import-btn' );
	const accountUsernameInput = document.getElementById( 'account-username-input' );
	const accountPasswordInput = document.getElementById( 'account-password-input' );
	const accountSignupBtn = document.getElementById( 'account-signup-btn' );
	const accountLoginBtn = document.getElementById( 'account-login-btn' );
	const accountCloudSaveBtn = document.getElementById( 'account-cloud-save-btn' );
	const accountCloudLoadBtn = document.getElementById( 'account-cloud-load-btn' );
	const accountExportBtn = document.getElementById( 'account-export-btn' );
	const accountImportBtn = document.getElementById( 'account-import-btn' );
	const accountStatus = document.getElementById( 'account-status' );
	let gameMode = 'race';
	let stuntPoints = 0;
	let bestStuntPoints = 0;
	let stuntReasonText = '--';
	let stuntReasonTimer = 0;
	let stuntCombo = 1;
	let stuntComboTimer = 0;
	let stuntAirTime = 0;
	let modeMenuOpen = false;
	let modeTab = 'gameplay';
	// Cached landing-page element read once and reused in the per-frame music update
	// to avoid a getElementById lookup every animation frame.
	let homeLandingEl = document.getElementById( 'home-landing' );
	let topMessageTimer = 0;
	let pendingLeaderboardRecord = null;
	let leaderboardVisible = true;
	let uiHidden = false;
	let accountSession = null;

	const advancementEvents = new AdvancementEvents();
	const accountDirtyRef = { value: false };
	const advancementState = (() => {
		try { return JSON.parse( localStorage.getItem('racing-advancements-v1') || '{}' ) || {}; }
		catch { return {}; }
	})();
	const advManager = new AdvancementManager( advancementEvents, {
		state: advancementState,
		accountDirtyRef,
		onUnlock: (adv) => {
			if ( ! adv ) return;
			// Achievement notifications are hidden for now, but progress still saves.
			renderAdvGraph();
		}
	});
	function saveAdvancementsNow(){ localStorage.setItem('racing-advancements-v1', JSON.stringify(advancementState)); accountDirtyRef.value = false; }
	setTimeout(() => setInterval(() => { if (accountDirtyRef.value) saveAdvancementsNow(); }, 300000), 30000);
	window.addEventListener('beforeunload', () => { if (accountDirtyRef.value) saveAdvancementsNow(); });
	function renderAdvGraph(){
		if(!advCanvas) return;
		const catY = { beginner:120, competition:340, community:560, modding:780, secret:1000 };
		const positions = {};
		advCanvas.innerHTML='';
		ADVANCEMENTS.forEach((a,i)=>{ const x=120 + (i%5)*390; const y=catY[a.category] || 120; positions[a.id]={x,y}; const node=document.createElement('div'); const unlocked=Boolean(advancementState[a.id]?.unlocked); node.style.cssText=`position:absolute;left:${x}px;top:${y}px;width:260px;padding:10px;border-radius:10px;background:${unlocked?'rgba(40,120,80,.85)':'rgba(20,30,45,.85)'};border:1px solid rgba(150,210,255,.45);color:#dff4ff;font:600 12px sans-serif;box-shadow:${unlocked?'0 0 18px rgba(80,255,180,.35)':'0 0 8px rgba(90,150,220,.2)'};`; node.textContent=(a.hidden && !unlocked)?'Hidden Advancement':`${a.title} — ${a.description}`; advCanvas.appendChild(node); });
		for (const a of ADVANCEMENTS){
			if(!a.prerequisite||!positions[a.id]||!positions[a.prerequisite]) continue;
			const p=positions[a.prerequisite], n=positions[a.id];
			const line=document.createElement('div');
			const x1=p.x+260, y1=p.y+24, x2=n.x, y2=n.y+24, dx=x2-x1, dy=y2-y1;
			const len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI;
			line.style.cssText=`position:absolute;left:${x1}px;top:${y1}px;width:${len}px;height:2px;background:linear-gradient(90deg, rgba(110,200,255,.8), rgba(70,145,240,.35));transform-origin:0 0;transform:rotate(${ang}deg);opacity:.85;`;
			advCanvas.appendChild(line);
		}
	}
	renderAdvGraph();
	let advPan = { x: 0, y: 0, scale: 1, down: false, sx: 0, sy: 0 };
	const applyAdvTransform = () => { if (!advCanvas) return; advCanvas.style.transform = `translate(${advPan.x}px, ${advPan.y}px) scale(${advPan.scale})`; if (advGraph) advGraph.style.backgroundPosition = `${advPan.x*0.35}px ${advPan.y*0.35}px`; };
	advGraph?.addEventListener('mousedown',(e)=>{advPan.down=true;advPan.sx=e.clientX;advPan.sy=e.clientY;});
	window.addEventListener('mouseup',()=>advPan.down=false);
	window.addEventListener('mousemove',(e)=>{ if(!advPan.down||!advCanvas) return; advPan.x += (e.clientX-advPan.sx); advPan.y += (e.clientY-advPan.sy); advPan.sx=e.clientX; advPan.sy=e.clientY; applyAdvTransform(); });
	advGraph?.addEventListener('wheel',(e)=>{ e.preventDefault(); advPan.scale = THREE.MathUtils.clamp(advPan.scale + (e.deltaY>0?-0.06:0.06), 0.45, 1.5); applyAdvTransform(); }, { passive:false });
	advGraph?.addEventListener('keydown',(e)=>{ const step= e.shiftKey ? 60 : 28; if(e.key==='ArrowLeft') advPan.x+=step; if(e.key==='ArrowRight') advPan.x-=step; if(e.key==='ArrowUp') advPan.y+=step; if(e.key==='ArrowDown') advPan.y-=step; if(e.key==='-') advPan.scale=THREE.MathUtils.clamp(advPan.scale-0.05,0.45,1.5); if(e.key==='='||e.key==='+') advPan.scale=THREE.MathUtils.clamp(advPan.scale+0.05,0.45,1.5); applyAdvTransform(); });
	advGraph?.addEventListener('scroll',(e)=>{ if(!advCanvas) return; advPan.x -= e.deltaX||0; advPan.y -= e.deltaY||0; applyAdvTransform(); }, { passive:true });
	advModeBtn?.addEventListener('click',()=>{ if(advOverlay) advOverlay.style.display='block'; setTimeout(()=>advGraph?.focus(),20); });
	advClose?.addEventListener('click',()=>{ if(advOverlay) advOverlay.style.display='none'; });

	let campaignState = null;
	let campaignTargetAuthorSeconds = null;
	let campaignTrackName = '';
	let currentTrackLeaderboardRows = [];
	const GARAGE_PACKS = {
		grip: { cost: 250, label: 'Handling Pack' },
		accel: { cost: 325, label: 'Power Pack' },
		drive: { cost: 400, label: 'Traction Pack' },
	};
	const garageStoreKey = 'racing-garage-mods-v1';
	const campaignStoreKey = 'racing-campaign-v1';
	const GARAGE_FIXED_MULTIPLIER = 1.15;
	let garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
	let garageUnlocked = { grip: true, accel: true, drive: true };
	const GARAGE_REPAINT_COST = 300;
	const GARAGE_COLOR_PICK_TOLERANCE = 34;
	const GARAGE_COLOR_UNLOCK_COST = 90;
	const GARAGE_SHINY_UNLOCK_COST = 1000;
	const GARAGE_STANDARD_PALETTE = buildGaragePaintPalette();
	const GARAGE_SHINY_PALETTE = buildGarageShinyPalette();
	const GARAGE_PAINT_PALETTE = [ ...GARAGE_STANDARD_PALETTE, ...GARAGE_SHINY_PALETTE ];
	const SHINY_MATERIAL_TUNING = {
		metalness: 0.9,
		roughness: 0.04,
		envMapIntensity: 4.0,
		brightnessBoost: 1.45,
		emissiveBoost: 0.22,
		clearcoat: 1.0,
		clearcoatRoughness: 0.05,
		specularIntensity: 1.0,
		phongShininess: 220,
	};
	const GARAGE_DEFAULT_PAINT_UNLOCKS = new Set( [ GARAGE_STANDARD_PALETTE[ 0 ]?.id, GARAGE_STANDARD_PALETTE[ 1 ]?.id, GARAGE_STANDARD_PALETTE[ 11 ]?.id ].filter( Boolean ) );
	let selectedPaintColorId = GARAGE_PAINT_PALETTE[ 0 ]?.id || '';
	let selectedGarageSourceHex = '';
	let hoveredGarageSourceHex = '';
	let garageViewer = null;
	let garageDriveActive = false;
	let garageCosmetics = normalizeGarageCosmetics( null );
	const recolorTextureSourceCache = new WeakMap();
	const garageTexturePaletteCache = new WeakMap();
	// Paint Shop selection state (3D click-to-fill: click a color on the car to select its region)
	let garageSelectionMask = null; // Uint8Array(length) over the active texture's pixels, 1 = selected
	let garageSelectionTexture = null; // THREE.Texture currently being edited
	let garageSelectionSource = null; // { width, height, data } from getTextureSourcePixels
	// Garage vehicle-card mini 3D previews (spinning painted clones).
	let garageCardCanvasByKey = {}; // carKey -> <canvas>
	let garageCardPreviews = new Map(); // carKey -> { scene, camera, carRoot, yaw, ctx2d }
	let garageCardPreviewsRaf = 0; // rAF id of the shared animation loop (0 when idle)
	let garageCardSharedRenderer = null; // ONE WebGLRenderer shared by all card previews (avoids 10 simultaneous WebGL contexts, which caused context loss on paint-apply)
	if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
	if ( isSplitScreen ) {

		if ( economyHud ) economyHud.style.display = 'none';
		if ( carSelect ) carSelect.style.display = 'none';
		if ( exportGhostBtn ) exportGhostBtn.style.display = 'none';
		if ( importGhostBtn ) importGhostBtn.style.display = 'none';
	}
	const economyStoreKey = 'racing-economy-v1';
	let coins = 0;
	let shareImageDataUrl = '';
	const HACKS_STORE_KEY = 'racing-hacks-v1';
	const installedMods = (() => {

		try {

			const parsed = JSON.parse( localStorage.getItem( 'racing-installed-mods-v1' ) || '[]' );
			const list = Array.isArray( parsed ) ? parsed : [];
			return list;

		} catch {

			return [];

		}

	})();
	const hacksInstalled = installedMods.some( ( mod ) => mod?.id === 'hacks' );
	const arcadeBoostInstalled = installedMods.some( ( mod ) => mod?.id === 'arcade-boost' );
	const nonFreecamModsInstalled = installedMods.some( ( mod ) => mod?.id && mod.id !== 'freecam' && mod.id !== 'video-recorder' );
	const checkpointRespawnInstalled = installedMods.some( ( mod ) => mod?.id === 'checkpoint-respawn' );
	const practiceStartInstalled = installedMods.some( ( mod ) => mod?.id === 'practice-start' );
	const stuntModeModInstalled = installedMods.some( ( mod ) => mod?.id === 'stunt-mode' );
	const freecamInstalled = installedMods.some( ( mod ) => mod?.id === 'freecam' );
	const videoRecorderInstalled = installedMods.some( ( mod ) => mod?.id === 'video-recorder' );
	if ( stuntModeBtn ) {

		stuntModeBtn.disabled = ! stuntModeModInstalled;
		stuntModeBtn.title = stuntModeModInstalled
			? 'Experimental stunt mode enabled via mod.'
			: 'Stunt mode is under construction (install the Stunt Mode mod to try it).';
		if ( stuntModeModInstalled ) stuntModeBtn.textContent = '🚧 Stunt Mode (Experimental)';

	}
	const hacksState = {
		enabled: false,
		infiniteCoins: false,
		boostAnywhere: false,
		noLimits: false,
		alwaysNitro: false,
		superJump: false,
		teleportForward: false,
		lowFriction: false,
		instantStop: false,
		checkpointBypass: false,
		showHitboxes: false,
		timeScale: 1,
		gravity: 1,
		roadGrip: 1,
	};
	let hackTeleportLatch = false;
	let boostMeter = 0;
	let boostPressedLatch = false;
	const BOOST_METER_MAX = 100;
	let savedCheckpointState = null;
	let savedPracticeState = null;
	const freecamState = {
		active: false,
		yaw: 0,
		pitch: 0,
		moveSpeed: 11,
		sprintMultiplier: 2.25,
		mouseSensitivity: 0.0022,
	};
	const freecamForward = new THREE.Vector3();
	const freecamRight = new THREE.Vector3();
	const freecamMove = new THREE.Vector3();

	function getEngineMult() {

		return DEFAULT_ENGINE_MULT;

	}

	function currentCarKey() {

		return carSelect?.value || 'vehicle-truck-yellow';

	}

	function updateCarSelectColor() {

		// Keep the car select styled like the rest of the UI (no per-car color splash).
		if ( carSelect ) {

			carSelect.style.backgroundColor = '';
			carSelect.style.borderColor = '';
			carSelect.style.color = '';

		}

	}

	function applyVehiclePerformance() {

		if ( isSplitScreen ) {

			vehicle.setPerformance( CAR_STATS[ player1CarKey ].perf );
			return;

		}
		const carKey = currentCarKey();
		const stats = CAR_STATS[ carKey ];
		if ( ! stats ) return;
		const mult = getEngineMult();
			const perf = {
				...stats.perf,
				topSpeed: Math.min( hacksState.enabled && hacksState.noLimits ? 99 : MAX_EFFECTIVE_TOP_SPEED, stats.perf.topSpeed * mult * ( hacksState.enabled && hacksState.noLimits ? 2.5 : 1 ) ),
				driveForce: stats.perf.driveForce * mult * ( hacksState.enabled && hacksState.noLimits ? 2.5 : 1 ),
			};
		vehicle.setPerformance( perf );

	}

	function updateModeHudVisibility() {

		const inStunt = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( stuntPointsHud ) stuntPointsHud.style.display = inStunt ? 'block' : 'none';
		if ( lapHud ) lapHud.style.display = 'block';
		if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
		const hudGridEl = document.getElementById( 'hud-grid' );
		if ( hudGridEl ) hudGridEl.style.display = 'flex';
		if ( economyHud && ! isSplitScreen ) economyHud.style.display = 'block';
		if ( exportGhostBtn ) exportGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';
			if ( importGhostBtn ) importGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';
			if ( hacksToggleLink ) hacksToggleLink.style.display = 'none';
			const navHacksBtn = document.getElementById( 'nav-hacks' );
			if ( navHacksBtn ) navHacksBtn.style.display = hacksInstalled && ! isSplitScreen ? '' : 'none';
			if ( hacksPanel ) hacksPanel.style.display = 'none';
			updateArcadeBoostUi();

	}

	function saveHacksState() {

		localStorage.setItem( HACKS_STORE_KEY, JSON.stringify( hacksState ) );

	}

	function setHackMeshTransparencyEnabled( enabled ) {

		if ( enabled ) {

			scene.traverse( ( node ) => {

				if ( ! node?.isMesh || node?.userData?.isHackHitboxDebug ) return;
				const materials = Array.isArray( node.material ) ? node.material : [ node.material ];
				for ( const material of materials ) {

					if ( ! material ) continue;
					if ( ! originalHackTransparencyByMaterial.has( material ) ) {

						originalHackTransparencyByMaterial.set( material, {
							transparent: material.transparent,
							opacity: material.opacity,
							depthWrite: material.depthWrite,
						} );

					}
					material.transparent = true;
					material.opacity = Math.min( Number.isFinite( material.opacity ) ? material.opacity : 1, HACK_WORLD_OPACITY );
					material.depthWrite = true;
					material.needsUpdate = true;

				}

			} );
			return;

		}
		for ( const [ material, original ] of originalHackTransparencyByMaterial.entries() ) {

			material.transparent = original.transparent;
			material.opacity = original.opacity;
			material.depthWrite = original.depthWrite;
			material.needsUpdate = true;

		}
		originalHackTransparencyByMaterial.clear();

	}

	function applyHitboxHackVisuals( force = false ) {

		const shouldShow = Boolean( hacksInstalled && hacksState.enabled && hacksState.showHitboxes );
		if ( ! force && shouldShow === hackVisualsApplied ) return;
		hackVisualsApplied = shouldShow;
		hitboxDebugGroup.visible = shouldShow;
		carHitboxMesh.visible = shouldShow;
		setHackMeshTransparencyEnabled( shouldShow );

	}

	function applyHacksUi() {

		if ( ! hacksInstalled ) {

			hacksState.enabled = false;
			hacksState.showHitboxes = false;
			if ( hacksPanel ) hacksPanel.style.display = 'none';
			applyHitboxHackVisuals( true );
			return;

		}
		if ( hackEnableInput ) hackEnableInput.checked = hacksState.enabled;
		if ( hackInfiniteCoinsInput ) hackInfiniteCoinsInput.checked = hacksState.infiniteCoins;
		if ( hackBoostAnywhereInput ) hackBoostAnywhereInput.checked = hacksState.boostAnywhere;
		if ( hackNoLimitsInput ) hackNoLimitsInput.checked = hacksState.noLimits;
		if ( hackAlwaysNitroInput ) hackAlwaysNitroInput.checked = hacksState.alwaysNitro;
		if ( hackSuperJumpInput ) hackSuperJumpInput.checked = hacksState.superJump;
		if ( hackTeleportInput ) hackTeleportInput.checked = hacksState.teleportForward;
		if ( hackLowFrictionInput ) hackLowFrictionInput.checked = hacksState.lowFriction;
		if ( hackInstantStopInput ) hackInstantStopInput.checked = hacksState.instantStop;
		if ( hackCheckpointBypassInput ) hackCheckpointBypassInput.checked = hacksState.checkpointBypass;
		if ( hackShowHitboxesInput ) hackShowHitboxesInput.checked = hacksState.showHitboxes;
		if ( hackTimescaleInput ) hackTimescaleInput.value = String( hacksState.timeScale );
		if ( hackGravityInput ) hackGravityInput.value = String( hacksState.gravity );
		if ( hackRoadGripInput ) hackRoadGripInput.value = String( hacksState.roadGrip );
		applyHitboxHackVisuals();

	}

	function loadHacksState() {

		if ( ! hacksInstalled ) return;
		try {

			const parsed = JSON.parse( localStorage.getItem( HACKS_STORE_KEY ) || '{}' );
			hacksState.enabled = Boolean( parsed.enabled );
			hacksState.infiniteCoins = Boolean( parsed.infiniteCoins );
			hacksState.boostAnywhere = Boolean( parsed.boostAnywhere );
			hacksState.noLimits = Boolean( parsed.noLimits );
			hacksState.alwaysNitro = Boolean( parsed.alwaysNitro );
			hacksState.superJump = Boolean( parsed.superJump );
			hacksState.teleportForward = Boolean( parsed.teleportForward );
			hacksState.lowFriction = Boolean( parsed.lowFriction );
			hacksState.instantStop = Boolean( parsed.instantStop );
			hacksState.checkpointBypass = Boolean( parsed.checkpointBypass );
			hacksState.showHitboxes = Boolean( parsed.showHitboxes );
			hacksState.timeScale = THREE.MathUtils.clamp( Number( parsed.timeScale ) || 1, 0.15, 1 );
			hacksState.gravity = THREE.MathUtils.clamp( Number( parsed.gravity ) || 1, 0.1, 2 );
			hacksState.roadGrip = THREE.MathUtils.clamp( Number( parsed.roadGrip ) || 1, 0.5, 3 );

		} catch {}
		applyHacksUi();

	}

	function resetHacksState() {

		hacksState.enabled = false;
		hacksState.infiniteCoins = false;
		hacksState.boostAnywhere = false;
		hacksState.noLimits = false;
		hacksState.alwaysNitro = false;
		hacksState.superJump = false;
		hacksState.teleportForward = false;
		hacksState.lowFriction = false;
		hacksState.instantStop = false;
		hacksState.checkpointBypass = false;
		hacksState.showHitboxes = false;
		hacksState.timeScale = 1;
		hacksState.gravity = 1;
		hacksState.roadGrip = 1;
		saveHacksState();
		applyHacksUi();
		applyVehiclePerformance();
		showTopMessage( 'Hacks reset to default values.', false, 1300 );

	}

	function showModeError( message ) {

		if ( modeError ) modeError.textContent = message || '';
		if ( message ) window.alert( message );

	}

	function showTopMessage( message, isError = false, durationMs = 1800 ) {

		if ( ! topMessage ) return;
		topMessage.textContent = String( message || '' ).trim();
		topMessage.classList.toggle( 'error', Boolean( isError ) );
		topMessage.classList.toggle( 'show', Boolean( topMessage.textContent ) );
		window.clearTimeout( topMessageTimer );
		if ( ! topMessage.textContent ) return;
		topMessageTimer = window.setTimeout( () => {

			if ( ! topMessage ) return;
			topMessage.classList.remove( 'show' );
			topMessage.textContent = '';

		}, Math.max( 300, Number( durationMs ) || 1800 ) );

	}

	function updateStuntPointsHud() {

		if ( ! stuntPointsHud ) return;
		const visible = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( ! visible ) return;
		stuntPointsHud.innerHTML = `Points: ${ Math.floor( stuntPoints ) }<small class="best-points">Best: ${ Math.floor( bestStuntPoints ) }</small><small>Combo: x${ stuntCombo.toFixed( 2 ) }</small><small>Bonus: ${ stuntReasonText }</small>`;

	}

	function saveStuntStats() {

		localStorage.setItem( stuntStoreKey, JSON.stringify( { bestStuntPoints } ) );

	}

	function loadStuntStats() {

		try {

			const raw = localStorage.getItem( stuntStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			bestStuntPoints = Number.isFinite( parsed.bestStuntPoints ) ? Math.max( 0, parsed.bestStuntPoints ) : 0;

		} catch ( e ) {

			console.warn( 'Failed to load stunt stats', e );

		}

	}

	function addStuntPoints( amount, reason, reasonDuration = 0.9 ) {

		if ( gameMode !== 'stunt' || ! Number.isFinite( amount ) || amount <= 0 ) return;
		const scaledAmount = amount * stuntCombo;
		stuntPoints += scaledAmount;
		if ( stuntPoints > bestStuntPoints ) {

			bestStuntPoints = stuntPoints;
			saveStuntStats();
			updateGarageUi();

		}
		if ( reason ) {

			stuntReasonText = reason;
			stuntReasonTimer = reasonDuration;

		}

	}

	function resetStuntChain() {

		stuntCombo = 1;
		stuntComboTimer = 0;
		stuntAirTime = 0;

	}

	function setGameMode( mode ) {

		if ( mode !== 'race' && mode !== 'stunt' && mode !== 'campaign' ) return;
		if ( mode === 'stunt' && ! stuntModeModInstalled ) {

			showModeError( 'Stunt Mode is under construction right now.' );
			return;

		}
		if ( ( mode === 'stunt' || mode === 'campaign' ) && isSplitScreen ) {

			showModeError( `${ mode === 'campaign' ? 'Campaign' : 'Stunt Mode' } is disabled in local multiplayer (2P).` );
			return;

		}
		if ( gameMode === mode ) return;
		showModeError( '' );
		gameMode = mode;
		if ( mode === 'stunt' ) {

			stuntPoints = 0;
			stuntReasonText = '--';
			stuntReasonTimer = 0;
			resetStuntChain();
			updateStuntPointsHud();

		} else {

			resetLapState( true );
			resetLapState2( true );

		}
		updateModeHudVisibility();

	}

	function setFreecamActive( active ) {

		if ( ! freecamInstalled ) return;
		const next = Boolean( active );
		if ( next === freecamState.active ) return;
		if ( next && isSplitScreen ) {

			showTopMessage( 'Freecam is unavailable in 2P split screen.', true, 1700 );
			return;

		}
		freecamState.active = next;
		if ( next ) {

			setModeMenuOpen( false );
			cam.camera.getWorldDirection( freecamForward );
			const xzLen = Math.hypot( freecamForward.x, freecamForward.z );
			freecamState.yaw = Math.atan2( freecamForward.x, freecamForward.z );
			freecamState.pitch = Math.atan2( freecamForward.y, Math.max( xzLen, 1e-4 ) );
			renderer.domElement.requestPointerLock?.();
			showTopMessage( 'Freecam enabled (WASD + mouse to move cam • Arrows to drive • F to exit).', false, 2000 );

		} else {

			if ( document.pointerLockElement === renderer.domElement ) document.exitPointerLock?.();
			showTopMessage( 'Freecam disabled.', false, 900 );

		}

	}

	function updateFreecam( dt ) {

		if ( ! freecamState.active ) return;
		const keys = controls?.keys || {};
		freecamState.pitch = THREE.MathUtils.clamp( freecamState.pitch, - Math.PI * 0.49, Math.PI * 0.49 );
		const cosPitch = Math.cos( freecamState.pitch );
		freecamForward.set(
			Math.sin( freecamState.yaw ) * cosPitch,
			Math.sin( freecamState.pitch ),
			Math.cos( freecamState.yaw ) * cosPitch
		).normalize();
		freecamRight.set( Math.cos( freecamState.yaw ), 0, - Math.sin( freecamState.yaw ) ).normalize();
		freecamMove.set( 0, 0, 0 );
		// WASD moves the freecam; arrow keys are reserved for driving the car while in freecam.
		if ( keys.KeyW ) freecamMove.add( freecamForward );
		if ( keys.KeyS ) freecamMove.sub( freecamForward );
		if ( keys.KeyD ) freecamMove.sub( freecamRight );
		if ( keys.KeyA ) freecamMove.add( freecamRight );
		if ( keys.Space ) freecamMove.y += 1;
		if ( keys.ControlLeft || keys.ControlRight ) freecamMove.y -= 1;
		// Shift sprints the freecam (declared before, never wired — now it is).
		const sprinting = keys.ShiftLeft || keys.ShiftRight;
		if ( freecamMove.lengthSq() > 1e-6 ) {

			cam.camera.position.addScaledVector( freecamMove.normalize(), freecamState.moveSpeed * ( sprinting ? freecamState.sprintMultiplier : 1 ) * dt );

		}
		cam.lookTarget.copy( cam.camera.position ).add( freecamForward );
		cam.camera.lookAt( cam.lookTarget );

	}

	// Clouds fade out while the Freecam mod is active so puffs never block a
	// flying camera, and fade back in when freecam is disabled.
	let cloudFreecamFade = 1; // 1 = visible, 0 = fully faded

	function updateCloudFreecamFade( dt ) {

		if ( ! skyDecorState.cloudGroup ) return;
		const target = freecamState.active ? 0 : 1;
		if ( ! freecamState.active && Math.abs( target - cloudFreecamFade ) < 1e-3 ) return; // settled and restored
		cloudFreecamFade = target; // instant: never blocks the view, even for a frame
		skyDecorState.cloudGroup.traverse( ( obj ) => {

			const mat = obj.material;
			if ( ! mat ) return;
			if ( mat.userData.baseOpacity === undefined ) mat.userData.baseOpacity = mat.opacity;
			mat.opacity = mat.userData.baseOpacity * cloudFreecamFade;
			mat.transparent = true;

		} );

	}

	function readFreecamCarInput() {

		// While freecam is active, arrow keys drive the car and WASD moves the camera.
		const keys = controls?.keys || {};
		let x = 0, z = 0;
		if ( keys.ArrowLeft ) x -= 1;
		if ( keys.ArrowRight ) x += 1;
		if ( keys.ArrowUp ) z += 1;
		if ( keys.ArrowDown ) z -= 1;
		return { x, z };

	}

	function setModeMenuOpen( open ) {

		modeMenuOpen = open;
		if ( ! open && garageDriveActive ) setGarageDriveActive( false );
		if ( modeMenu ) modeMenu.style.display = open ? 'block' : 'none';
		document.body.classList.toggle( 'mode-menu-open', modeMenuOpen );
		// Spin the garage card previews only while the garage panel is actually visible. While open
		// the 10 card renderers + main game + garage viewer coexist (~12 WebGL contexts), so on close
		// we fully DISPOSE the card renderers (not just stop the rAF) to drop back to ~2 contexts and
		// avoid GPU-memory pressure that can lose the main game's context. They're recreated lazily
		// (ensureGarageCardPreviews) on the next garage open.
		if ( open && modeTab === 'garage' ) activateGarageCardPreviews();
		else disposeGarageCardPreviews();

	}

	function buildGaragePaintPalette() {

		const colors = [];
		for ( let row = 0; row < 7; row ++ ) {

			for ( let col = 0; col < 11; col ++ ) {

				const hue = Math.round( ( col / 11 ) * 360 ) % 360;
				const sat = THREE.MathUtils.lerp( 0.34, 1.0, row / 6 );
				const light = THREE.MathUtils.lerp( 0.84, 0.38, row / 6 );
				const color = new THREE.Color().setHSL( hue / 360, sat, light );
				colors.push( {
					id: `p-${ row }-${ col }`,
					hex: `#${ color.getHexString() }`,
					row,
					col,
					unlockCost: GARAGE_COLOR_UNLOCK_COST,
					finish: 'matte',
				} );

			}

		}
		return colors;

	}

	function buildGarageShinyPalette() {

		const colors = [];
		const metallicHues = [ '#d7dde8', '#cfd9df', '#f9d27d', '#f7f7f7', '#b7e3ff', '#f2b6ff', '#9cf7d2', '#ffb58d', '#ffe8a6', '#bcbcff', '#ff6a45' ];
		for ( let i = 0; i < metallicHues.length; i ++ ) {

			colors.push( {
				id: `s-${ i }`,
				hex: metallicHues[ i ],
				row: 0,
				col: i,
				unlockCost: GARAGE_SHINY_UNLOCK_COST,
				finish: 'shiny',
			} );

		}
		return colors;

	}

	function normalizeGarageCosmetics( value ) {

		const next = value && typeof value === 'object' ? value : {};
		const unlockedPaints = {};
		for ( const entry of GARAGE_PAINT_PALETTE ) {

			const unlocked = Boolean( next?.unlockedPaints?.[ entry.id ] ) || GARAGE_DEFAULT_PAINT_UNLOCKS.has( entry.id );
			if ( unlocked ) unlockedPaints[ entry.id ] = true;

		}
		if ( next?.unlockedPaints && typeof next.unlockedPaints === 'object' ) {

			for ( const paintId of Object.keys( next.unlockedPaints ) ) {

				if ( /^custom-[0-9a-fA-F]{6}$/.test( paintId ) ) unlockedPaints[ paintId.toLowerCase() ] = true;

			}

		}

		const cars = {};
		if ( next?.cars && typeof next.cars === 'object' ) {

			for ( const [ carKey, carData ] of Object.entries( next.cars ) ) {

				if ( ! CAR_STATS[ carKey ] ) continue;
				const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
				cars[ carKey ] = {
					mappings: mappings.slice( 0, 48 ).map( ( mapping ) => ( {
						sourceHex: typeof mapping?.sourceHex === 'string' ? mapping.sourceHex : '#ff0000',
						targetColorId: typeof mapping?.targetColorId === 'string' ? mapping.targetColorId : '',
						tolerance: THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 ),
						mask: typeof mapping?.mask === 'string' ? mapping.mask : '',
						maskW: THREE.MathUtils.clamp( Number( mapping?.maskW ) || 0, 0, 4096 ),
						maskH: THREE.MathUtils.clamp( Number( mapping?.maskH ) || 0, 0, 4096 ),
					} ) ).filter( ( mapping ) => /^#[0-9a-fA-F]{6}$/.test( mapping.sourceHex ) && unlockedPaints[ mapping.targetColorId ] ),
				};

			}

		}

		return { unlockedPaints, cars };

	}

	function getGarageCosmeticCar( carKey ) {

		if ( ! garageCosmetics.cars[ carKey ] ) garageCosmetics.cars[ carKey ] = { mappings: [] };
		return garageCosmetics.cars[ carKey ];

	}

	function getSelectedGarageCarKey() {

		const candidate = garageCarSelect?.value;
		return CAR_STATS[ candidate ] ? candidate : currentCarKey();

	}

	function clampGarageValue( value, fallback = 1.0 ) {

		const parsed = Number( value );
		if ( ! Number.isFinite( parsed ) ) return fallback;
		return THREE.MathUtils.clamp( parsed, 0.85, 1.15 );

	}

	function setModeTab( tabName ) {

		const tab = tabName === 'garage' || tabName === 'account' || tabName === 'nav' ? tabName : 'gameplay';
		modeTab = tab;
		modeTabGameplayBtn?.classList.toggle( 'active', tab === 'gameplay' );
		modeTabGarageBtn?.classList.toggle( 'active', tab === 'garage' );
		modeTabAccountBtn?.classList.toggle( 'active', tab === 'account' );
		modeTabNavBtn?.classList.toggle( 'active', tab === 'nav' );
		modePanelGameplay?.classList.toggle( 'active', tab === 'gameplay' );
		modePanelGarage?.classList.toggle( 'active', tab === 'garage' );
		modePanelAccount?.classList.toggle( 'active', tab === 'account' );
		modePanelNav?.classList.toggle( 'active', tab === 'nav' );
		modeMenu?.classList.toggle( 'garage-fullscreen', tab === 'garage' );
		if ( tab === 'garage' ) {

			ensureGarageSelectionSource();
			if ( ! garageViewer ) initGarageViewer();
			refreshGarageViewer();

		}
		// Only keep the garage card preview renderers alive while the garage tab is open & menu
		if ( tab !== 'garage' && garageDriveActive ) setGarageDriveActive( false );
		if ( modeMenuOpen && tab === 'garage' ) activateGarageCardPreviews();
		else disposeGarageCardPreviews();

	}

	function updateGraphicsQualityUi() {

		const preset = getGraphicsPreset();
		for ( const button of graphicsQualityButtons ) {

			const selected = button.dataset.graphicsQuality === graphicsQuality;
			button.classList.toggle( 'active', selected );
			button.setAttribute( 'aria-pressed', String( selected ) );

		}
		if ( graphicsQualityLabel ) graphicsQualityLabel.textContent = `${ preset.label } performance mode`;

	}

	function applyGraphicsQuality( nextQuality, save = false ) {

		graphicsQuality = normalizeGraphicsQuality( nextQuality );
		cachedGraphicsPreset = GRAPHICS_QUALITY_PRESETS[ graphicsQuality ] || GRAPHICS_QUALITY_PRESETS[ getDefaultGraphicsQuality() ];
		document.body.classList.toggle( 'gfx-low', graphicsQuality === 'low' );
		if ( save ) {
			localStorage.setItem( GRAPHICS_QUALITY_KEY, graphicsQuality );
			// Keep the unified GameSettings slice in sync so a cloud save
			// reflects the in-game choice. Selecting a preset resets advanced
			// overrides to "auto" (null) and clears any custom state.
			try {
				GameSettings.patchSettings( { graphics: {
					preset: graphicsQuality, basePreset: graphicsQuality,
					maxPixelRatio: null, shadows: null, shadowMapSize: null,
					bloomStrength: null, bloomRadius: null, smokeParticles: null,
				} } );
			} catch ( e ) {}
		}
		applyGraphicsPresetToRenderer();
		particles.setQuality( getGraphicsParticleOptions() );
		particles2?.setQuality( getGraphicsParticleOptions() );
		skidMarks.setQuality( { maxSegments: ( getGraphicsPreset().smokeParticles ?? 64 ) > 0 ? undefined : 0 } );
		setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
		updateGraphicsQualityUi();

	}

	// Apply the unified GameSettings slice live. Used both at boot (to honour
	// settings made on settings.html) and on demand via window.__gameSettingsApplyLive
	// so the settings page can push changes into a running game in another tab.
	// Graphics: overlays advanced overrides + reduce-motion onto the active preset.
	// Audio / camera / fps apply immediately. Gameplay items that need a reload
	// (countdown, recent-ghost rebuild) persist for the next race.
	function applyLiveGameSettings( settings ) {

		if ( ! settings ) return;
		const gp = settings.gameplay || {};

		// Each subsystem is applied in its own try/catch so that a failure in one
		// (e.g. the renderer not being ready during an early boot call) cannot
		// silently skip the others. Without this, an exception thrown by the
		// graphics section would abort the function before the camera / FPS / ghost
		// sections ran, and the outer try/catch at the call site would swallow it —
		// leaving those settings unapplied with no visible error. That is the exact
		// "setting doesn't take effect after reload" symptom this guards against.
		try { applyGraphicsSettings( settings.graphics || {} ); } catch ( e ) { console.warn( 'GameSettings graphics apply failed', e ); }
		try { applyAudioSettings( settings.audio || {} ); } catch ( e ) { console.warn( 'GameSettings audio apply failed', e ); }
		try { applyCameraSettings( gp ); } catch ( e ) { console.warn( 'GameSettings camera apply failed', e ); }
		try { applyFpsSettings( gp ); } catch ( e ) { console.warn( 'GameSettings fps apply failed', e ); }
		try { applyGhostSettings( gp ); } catch ( e ) { console.warn( 'GameSettings ghost apply failed', e ); }

	}

	function applyGraphicsSettings( g ) {
		// For 'custom' preset the base is basePreset (low/medium/high); otherwise the preset itself.
		const presetKey = ( g.preset === 'custom' ? g.basePreset : g.preset ) || getDefaultGraphicsQuality();
		const base = GRAPHICS_QUALITY_PRESETS[ presetKey ] || GRAPHICS_QUALITY_PRESETS[ getDefaultGraphicsQuality() ];
		const effective = Object.assign( {}, base );
		if ( g.maxPixelRatio != null ) effective.maxPixelRatio = g.maxPixelRatio;
		if ( g.shadows != null ) effective.shadows = g.shadows;
		if ( g.shadowMapSize != null ) effective.shadowMapSize = g.shadowMapSize;
		if ( g.smokeParticles != null ) effective.smokeParticles = g.smokeParticles;
		if ( g.bloomStrength != null ) effective.bloomStrength = g.bloomStrength;
		if ( g.bloomRadius != null ) effective.bloomRadius = g.bloomRadius;
		if ( g.reduceMotion ) { effective.bloomStrength = 0; effective.bloomRadius = 0; effective.weatherParticleScale = 0; }
		graphicsQuality = normalizeGraphicsQuality( presetKey );
		cachedGraphicsPreset = effective;
		applyGraphicsPresetToRenderer();
		particles.setQuality( getGraphicsParticleOptions() );
		particles2?.setQuality( getGraphicsParticleOptions() );
		skidMarks.setQuality( { maxSegments: ( getGraphicsPreset().smokeParticles ?? 64 ) > 0 ? undefined : 0 } );
		setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
		updateGraphicsQualityUi();
	}

	function applyAudioSettings( a ) {
		const aud = window.__gameAudio;
		if ( ! aud ) return;
		if ( a.sfxVolume != null ) aud.setSfxVolume?.( a.sfxVolume );
		if ( a.musicVolume != null ) aud.setMusicVolume?.( a.musicVolume );
		if ( a.musicMode != null ) aud.setMusicMode?.( a.musicMode );
	}

	function applyCameraSettings( gp ) {
		// Apply to BOTH cameras so split-screen P2 honours the same camera prefs
		// as P1 (previously only `cam` was updated, so cam2 ignored settings).
		for ( const c of [ cam, cam2 ] ) {
			if ( ! c ) continue;
			if ( gp.cameraDistance != null ) c.userDistance = gp.cameraDistance;
			if ( gp.cameraHeight != null ) c.userHeight = gp.cameraHeight;
			if ( gp.cameraLag != null ) c.userLagScale = gp.cameraLag;
		}
	}

	function applyFpsSettings( gp ) {
		fpsHudVisible = Boolean( gp.showFps );
		try { localStorage.setItem( FPS_HUD_SETTINGS_KEY, fpsHudVisible ? '1' : '0' ); } catch ( e ) {}
		updateFpsHudVisibility();
	}

	function applyGhostSettings( gp ) {
		showBestGhost = gp.showBestGhost != null ? Boolean( gp.showBestGhost ) : true;
		if ( ! showBestGhost && ghostModel ) ghostModel.visible = false;
	}

	function getGarageUnlocks() {

		return { ...garageUnlocked };

	}

	// Paint masks (per-pixel selection RLE) are the only heavy part of garage
	// storage. Returns the cosmetics as-is when under budget, or a copy with
	// the OLDEST masks stripped until it fits — keeps localStorage and the
	// cloud profile small no matter how much someone paints.
	function compactGarageCosmetics( cosmetics, budget = 200000 ) {

		if ( ! cosmetics ) return cosmetics;
		let maskTotal = 0;
		for ( const car of Object.values( cosmetics.cars || {} ) ) {
			for ( const mapping of car.mappings || [] ) {
				if ( mapping?.mask ) maskTotal += String( mapping.mask ).length;
			}
		}
		if ( maskTotal <= budget ) return cosmetics;
		const clone = JSON.parse( JSON.stringify( cosmetics ) );
		let over = maskTotal - budget;
		for ( const car of Object.values( clone.cars || {} ) ) {
			for ( const mapping of car.mappings || [] ) {
				if ( over <= 0 ) return clone;
				if ( mapping?.mask ) {
					over -= String( mapping.mask ).length;
					mapping.mask = '';
					mapping.maskW = 0;
					mapping.maskH = 0;
				}
			}
		}
		return clone;

	}

	function saveGarageMods() {

		localStorage.setItem( garageStoreKey, JSON.stringify( { mods: garageMods, unlocked: garageUnlocked, cosmetics: compactGarageCosmetics( garageCosmetics ) } ) );

	}

	function loadGarageMods() {

		try {

			const raw = localStorage.getItem( garageStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
			garageUnlocked = { grip: true, accel: true, drive: true };
			garageCosmetics = normalizeGarageCosmetics( parsed?.cosmetics );

		} catch ( e ) {

			console.warn( 'Failed to load garage mods', e );

		}

	}

	function updateGarageUi() {

		const unlocks = getGarageUnlocks();
		if ( isSplitScreen ) {

			if ( garageGripSlider ) garageGripSlider.disabled = true;
			if ( garageAccelSlider ) garageAccelSlider.disabled = true;
			if ( garageDriveSlider ) garageDriveSlider.disabled = true;
			if ( garageGripUnlockBtn ) garageGripUnlockBtn.disabled = true;
			if ( garageAccelUnlockBtn ) garageAccelUnlockBtn.disabled = true;
			if ( garageDriveUnlockBtn ) garageDriveUnlockBtn.disabled = true;
			if ( garageGripStatus ) garageGripStatus.textContent = 'Unavailable in 2P mode';
			if ( garageAccelStatus ) garageAccelStatus.textContent = 'Unavailable in 2P mode';
			if ( garageDriveStatus ) garageDriveStatus.textContent = 'Unavailable in 2P mode';
			return;

		}
		if ( garageGripSlider ) {

			garageGripSlider.disabled = ! unlocks.grip;
			garageGripSlider.value = String( garageMods.grip );

		}
		if ( garageAccelSlider ) {

			garageAccelSlider.disabled = ! unlocks.accel;
			garageAccelSlider.value = String( garageMods.accel );

		}
		if ( garageDriveSlider ) {

			garageDriveSlider.disabled = ! unlocks.drive;
			garageDriveSlider.value = String( garageMods.drive );

		}
		if ( garageGripValue ) garageGripValue.textContent = `x${ garageMods.grip.toFixed( 2 ) }`;
		if ( garageAccelValue ) garageAccelValue.textContent = `x${ garageMods.accel.toFixed( 2 ) }`;
		if ( garageDriveValue ) garageDriveValue.textContent = `x${ garageMods.drive.toFixed( 2 ) }`;
		if ( garageGripUnlockBtn ) {

			garageGripUnlockBtn.disabled = unlocks.grip || coins < GARAGE_PACKS.grip.cost;
			garageGripUnlockBtn.textContent = unlocks.grip ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.grip.cost })`;

		}
		if ( garageAccelUnlockBtn ) {

			garageAccelUnlockBtn.disabled = unlocks.accel || coins < GARAGE_PACKS.accel.cost;
			garageAccelUnlockBtn.textContent = unlocks.accel ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.accel.cost })`;

		}
		if ( garageDriveUnlockBtn ) {

			garageDriveUnlockBtn.disabled = unlocks.drive || coins < GARAGE_PACKS.drive.cost;
			garageDriveUnlockBtn.textContent = unlocks.drive ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.drive.cost })`;

		}
		if ( garageGripStatus ) garageGripStatus.textContent = unlocks.grip ? 'Pack active' : 'Buy to activate slider';
		if ( garageAccelStatus ) garageAccelStatus.textContent = unlocks.accel ? 'Pack active' : 'Buy to activate slider';
		if ( garageDriveStatus ) garageDriveStatus.textContent = unlocks.drive ? 'Pack active' : 'Buy to activate slider';
		if ( garageCarSelect ) garageCarSelect.value = getSelectedGarageCarKey();
		renderGarageVehicleCards();
		ensureGarageSelectionSource();
		updateGaragePaintControls();
		updateGarageMappingsUi();
		refreshGarageViewer();

	}

	function getPaintColorById( colorId ) {

		const found = GARAGE_PAINT_PALETTE.find( ( color ) => color.id === colorId );
		if ( found ) return found;
		if ( /^custom-[0-9a-fA-F]{6}$/.test( String( colorId || '' ) ) ) {

			return { id: String( colorId ).toLowerCase(), hex: `#${ String( colorId ).slice( 7 ).toLowerCase() }`, unlockCost: 0, finish: 'matte' };

		}
		return null;

	}

	function setGarageMappingStatus( message, isError = false ) {

		if ( ! garageMappingStatus ) return;
		garageMappingStatus.textContent = message || '';
		garageMappingStatus.style.color = isError ? '#ff9ea2' : '#b9d0ea';

	}

	function getGarageRepaintTolerance() {

		return THREE.MathUtils.clamp( Number( garageRepaintToleranceInput?.value ) || GARAGE_COLOR_PICK_TOLERANCE, 4, 180 );

	}

	function countSelectionPixels() {

		if ( ! garageSelectionMask ) return 0;
		let n = 0;
		for ( let i = 0; i < garageSelectionMask.length; i ++ ) if ( garageSelectionMask[ i ] ) n ++;
		return n;

	}

	function updateGaragePaintControls() {

		const selectedCount = countSelectionPixels();
		const hasSelection = selectedCount > 0;
		if ( garageApplyPaintBtn ) {

			garageApplyPaintBtn.disabled = ! hasSelection || coins < GARAGE_REPAINT_COST;
			garageApplyPaintBtn.textContent = hasSelection ? `Apply paint (${ GARAGE_REPAINT_COST } coins)` : 'Select an area first';

		}
		if ( garageClearSelectionBtn ) garageClearSelectionBtn.disabled = ! hasSelection;
		if ( garageRepaintToleranceValue ) garageRepaintToleranceValue.textContent = String( Math.round( getGarageRepaintTolerance() ) );
		if ( garageSelectionChip ) {

			garageSelectionChip.innerHTML = hasSelection
				? `${ selectedCount.toLocaleString() } pixels selected — shown in your new color on the car. Pick a color and Apply paint.`
				: 'No area selected yet. Click a color on the car to choose what to repaint.';

		}

	}

	function garageRedmeanDistanceSq( r1, g1, b1, r2, g2, b2 ) {

		const rmean = ( r1 + r2 ) / 2;
		const dr = r1 - r2;
		const dg = g1 - g2;
		const db = b1 - b2;
		const rr = ( 2 + rmean / 256 ) * dr * dr;
		const gg = 4 * dg * dg;
		const bb = ( 2 + ( 255 - rmean ) / 256 ) * db * db;
		return rr + gg + bb;

	}

	function getGarageTexturePalette( texture ) {

		if ( ! texture ) return [];
		if ( garageTexturePaletteCache.has( texture ) ) return garageTexturePaletteCache.get( texture );
		const source = getTextureSourcePixels( texture );
		if ( ! source ) return [];
		const counts = new Map();
		for ( let i = 0; i < source.data.length; i += 4 ) {

			if ( source.data[ i + 3 ] < 16 ) continue;
			const key = `${ source.data[ i ] },${ source.data[ i + 1 ] },${ source.data[ i + 2 ] }`;
			counts.set( key, ( counts.get( key ) || 0 ) + 1 );

		}
		const palette = [ ...counts.entries() ].map( ( [ key, count ] ) => {

			const [ r, g, b ] = key.split( ',' ).map( Number );
			return { r, g, b, hex: `#${ [ r, g, b ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`, count };

		} ).sort( ( a, b ) => b.count - a.count );
		garageTexturePaletteCache.set( texture, palette );
		return palette;

	}

	function getGarageActiveTexture() {

		const carKey = getSelectedGarageCarKey();
		const model = models[ carKey ];
		if ( ! model ) return null;
		let found = null;
		model.traverse( ( child ) => {

			if ( found || ! child.isMesh || ! child.material ) return;
			const materials = Array.isArray( child.material ) ? child.material : [ child.material ];
			for ( const mat of materials ) {

				if ( mat.map ) { found = mat.map; return; }

			}

		} );
		return found;

	}

	// Bind (or re-bind) the selected car's colormap pixels to the selection state.
	function ensureGarageSelectionSource() {

		const texture = getGarageActiveTexture();
		if ( texture === garageSelectionTexture && garageSelectionSource ) return;
		garageSelectionTexture = texture;
		garageSelectionSource = texture ? getTextureSourcePixels( texture ) : null;
		garageSelectionMask = null;
		selectedGarageSourceHex = '';
		hoveredGarageSourceHex = '';
		updateGaragePaintControls();

	}

	function clearGarageSelection() {

		if ( ! garageSelectionMask ) return;
		garageSelectionMask = null;
		selectedGarageSourceHex = '';
		hoveredGarageSourceHex = '';
		refreshGarageViewer();
		updateGaragePaintControls();
		setGarageMappingStatus( 'Selection cleared. Click a color on the car to pick a new area.' );

	}

	// Flood-fill (magic wand) from a seed pixel. Returns the number of pixels added.
	function garageFloodFill( x, y, tolerance ) {

		if ( ! garageSelectionSource ) return 0;
		const src = garageSelectionSource;
		const w = src.width, h = src.height;
		const data = src.data;
		garageSelectionMask = new Uint8Array( w * h );
		const mask = garageSelectionMask;
		const tolSq = tolerance * tolerance;
		const seed = ( y * w + x ) * 4;
		const sr = data[ seed ], sg = data[ seed + 1 ], sb = data[ seed + 2 ];
		const visited = new Uint8Array( w * h );
		const stack = [ x, y ];
		let added = 0;
		while ( stack.length ) {

			const cy = stack.pop();
			const cx = stack.pop();
			const idx = cy * w + cx;
			if ( visited[ idx ] ) continue;
			visited[ idx ] = 1;
			const p = idx * 4;
			if ( data[ p + 3 ] < 16 ) continue;
			const dist = garageRedmeanDistanceSq( sr, sg, sb, data[ p ], data[ p + 1 ], data[ p + 2 ] );
			if ( dist > tolSq ) continue;
			mask[ idx ] = 1;
			added ++;
			if ( cx > 0 && ! visited[ idx - 1 ] ) stack.push( cx - 1, cy );
			if ( cx < w - 1 && ! visited[ idx + 1 ] ) stack.push( cx + 1, cy );
			if ( cy > 0 && ! visited[ idx - w ] ) stack.push( cx, cy - 1 );
			if ( cy < h - 1 && ! visited[ idx + w ] ) stack.push( cx, cy + 1 );

		}
		return added;

	}

	// Sample the most common non-transparent color in a small radius around a UV on the texture.
	function sampleTextureHexAtUv( texture, uv ) {

		const source = texture ? getTextureSourcePixels( texture ) : garageSelectionSource;
		if ( ! source || ! uv ) return '';
		const flipY = texture ? texture.flipY : true;
		const u = uv.x, v = flipY ? ( 1 - uv.y ) : uv.y;
		const centerX = THREE.MathUtils.clamp( Math.floor( u * source.width ), 0, source.width - 1 );
		const centerY = THREE.MathUtils.clamp( Math.floor( v * source.height ), 0, source.height - 1 );
		const counts = new Map();
		const radius = 3;
		for ( let py = centerY - radius; py <= centerY + radius; py ++ ) {

			if ( py < 0 || py >= source.height ) continue;
			for ( let px = centerX - radius; px <= centerX + radius; px ++ ) {

				if ( px < 0 || px >= source.width ) continue;
				const i = ( py * source.width + px ) * 4;
				if ( source.data[ i + 3 ] < 16 ) continue;
				const key = `${ source.data[ i ] },${ source.data[ i + 1 ] },${ source.data[ i + 2 ] }`;
				counts.set( key, ( counts.get( key ) || 0 ) + 1 );

			}

		}
		let bestKey = '', bestCount = 0;
		for ( const [ key, count ] of counts ) if ( count > bestCount ) { bestKey = key; bestCount = count; }
		if ( ! bestKey ) return '';
		const [ r, g, b ] = bestKey.split( ',' ).map( Number );
		return `#${ [ r, g, b ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;

	}

	// Convert a pixel coordinate on the texture to its hex color.
	function garagePixelHex( x, y ) {

		if ( ! garageSelectionSource ) return '';
		const src = garageSelectionSource;
		const i = ( y * src.width + x ) * 4;
		if ( src.data[ i + 3 ] < 16 ) return '';
		const r = src.data[ i ], g = src.data[ i + 1 ], b = src.data[ i + 2 ];
		return `#${ [ r, g, b ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;

	}

	function describeGarageSelection() {

		if ( ! garageSelectionMask || ! garageSelectionSource ) return null;
		const src = garageSelectionSource;
		const data = src.data;
		const mask = garageSelectionMask;
		let n = 0, maxD = 0;
		const acc = new Map();
		for ( let i = 0, p = 0; i < mask.length; i ++, p += 4 ) {

			if ( ! mask[ i ] ) continue;
			const r = data[ p ], g = data[ p + 1 ], b = data[ p + 2 ];
			n ++;
			const key = ( r << 16 ) | ( g << 8 ) | b;
			acc.set( key, ( acc.get( key ) || 0 ) + 1 );

		}
		if ( n === 0 ) return null;
		let bestKey = -1, bestCount = 0;
		for ( const [ key, count ] of acc ) if ( count > bestCount ) { bestKey = key; bestCount = count; }
		const reprR = ( bestKey >> 16 ) & 255;
		const reprG = ( bestKey >> 8 ) & 255;
		const reprB = bestKey & 255;
		for ( let i = 0, p = 0; i < mask.length; i ++, p += 4 ) {

			if ( ! mask[ i ] ) continue;
			const d = garageRedmeanDistanceSq( reprR, reprG, reprB, data[ p ], data[ p + 1 ], data[ p + 2 ] );
			if ( d > maxD ) maxD = d;

		}
		const hex = `#${ [ reprR, reprG, reprB ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;
		const tol = THREE.MathUtils.clamp( Math.ceil( Math.sqrt( maxD ) ) + 8, 8, 180 );
		return { hex: hex.toLowerCase(), tolerance: tol, count: n };

	}

	function encodeSelectionMaskRle( mask ) {

		if ( ! mask ) return '';
		const runs = [];
		let i = 0;
		const len = mask.length;
		while ( i < len ) {

			if ( mask[ i ] ) {

				let j = i;
				while ( j < len && mask[ j ] ) j ++;
				runs.push( i, j - i );
				i = j;

			} else i ++;

		}
		if ( runs.length === 0 ) return '';
		const bytes = new Uint8Array( runs.length * 4 );
		for ( let k = 0; k < runs.length; k ++ ) {

			const v = runs[ k ];
			bytes[ k * 4 ] = v & 255;
			bytes[ k * 4 + 1 ] = ( v >> 8 ) & 255;
			bytes[ k * 4 + 2 ] = ( v >> 16 ) & 255;
			bytes[ k * 4 + 3 ] = ( v >> 24 ) & 255;

		}
		let bin = '';
		for ( let k = 0; k < bytes.length; k ++ ) bin += String.fromCharCode( bytes[ k ] );
		return btoa( bin );

	}

	function decodeSelectionMaskRle( rle, total ) {

		if ( ! rle || ! total ) return null;
		try {

			const bin = atob( rle );
			const mask = new Uint8Array( total );
			for ( let k = 0; k + 8 <= bin.length; k += 8 ) {

				const start = bin.charCodeAt( k ) | ( bin.charCodeAt( k + 1 ) << 8 ) | ( bin.charCodeAt( k + 2 ) << 16 ) | ( bin.charCodeAt( k + 3 ) << 24 );
				const length = bin.charCodeAt( k + 4 ) | ( bin.charCodeAt( k + 5 ) << 8 ) | ( bin.charCodeAt( k + 6 ) << 16 ) | ( bin.charCodeAt( k + 7 ) << 24 );
				if ( length <= 0 ) continue;
				const end = Math.min( total, start + length );
				for ( let p = start; p < end; p ++ ) mask[ p ] = 1;

			}
			return mask;

		} catch ( e ) {

			return null;

		}

	}

	function getGarageViewerHit( event ) {

		if ( ! garageViewer?.raycaster || ! garageViewer?.carRoot ) return null;
		const rect = garageViewerCanvas.getBoundingClientRect();
		garageViewer.pointer.set( ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1, - ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1 );
		garageViewer.raycaster.setFromCamera( garageViewer.pointer, garageViewer.camera );
		return garageViewer.raycaster.intersectObjects( garageViewer.carRoot.children, true ).find( ( item ) => item.object?.isMesh ) || null;

	}

	// Click on the 3D car: raycast, sample the UV's color, flood-fill that connected region.
	function garageSelectFromViewerClick( event ) {

		ensureGarageSelectionSource();
		if ( ! garageSelectionSource || ! garageSelectionTexture ) return;
		const hit = getGarageViewerHit( event );
		// Clicking empty space (missing the car) clears the current selection.
		if ( ! hit || ! hit.uv ) {

			if ( garageSelectionMask ) {

				garageSelectionMask = null;
				selectedGarageSourceHex = '';
				hoveredGarageSourceHex = '';
				refreshGarageViewer();
				updateGaragePaintControls();
				setGarageMappingStatus( 'Selection cleared. Click a color on the car to pick a new area.' );

			}
			return;

		}
		const texture = garageSelectionTexture;
		const flipY = texture.flipY;
		const u = hit.uv.x, v = flipY ? ( 1 - hit.uv.y ) : hit.uv.y;
		const w = garageSelectionSource.width, h = garageSelectionSource.height;
		const seedX = THREE.MathUtils.clamp( Math.floor( u * w ), 0, w - 1 );
		const seedY = THREE.MathUtils.clamp( Math.floor( v * h ), 0, h - 1 );
		const seedHex = garagePixelHex( seedX, seedY );
		if ( ! seedHex ) { setGarageMappingStatus( 'That spot has no color to select. Try a solid painted area.', true ); return; }
		const tol = getGarageRepaintTolerance();
		const added = garageFloodFill( seedX, seedY, tol );
		if ( added === 0 ) { setGarageMappingStatus( 'Could not select that area. Try raising the Color match slider.', true ); return; }
		selectedGarageSourceHex = seedHex.toLowerCase();
		refreshGarageViewer();
		updateGaragePaintControls();
		setGarageMappingStatus( `Selected ${ added.toLocaleString() } pixels (${ seedHex }). Pick a new color and Apply paint.` );

	}

	function refreshGarageViewer() {

		if ( ! garageViewer?.carRoot ) return;
		disposeGarageCloneMaterials( garageViewer.carRoot );
		garageViewer.carRoot.clear();
		const carKey = getSelectedGarageCarKey();
		const source = models[ carKey ];
		if ( ! source ) return;
		const clone = source.clone( true );
		clone.rotation.y = Math.PI;
		clone.traverse( ( child ) => {

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;

			}

		} );
		garageViewer.carRoot.add( clone );
		applyCarCustomizationToObject( clone, carKey, '', true, '', getGarageRepaintTolerance(), garageSelectionMask, garageTargetColorInput?.value || '' );

	}

	// Free the GPU resources of a thrown-away garage preview clone. applyCarCustomizationToObject
	// stashes the freshly-built materials (with CanvasTexture maps recolored per paint mapping) on
	// mesh.userData.customMaterial. carRoot.clear() only unlinks the children — it does NOT dispose
	// those materials/textures, so every refresh leaked one CanvasTexture + material per mesh.
	// Under a painting session that GPU-memory pressure trips WebGL context loss on the main game
	// renderer (the whole 3D canvas goes black while the HTML UI stays). Disposing here stops the leak.
	// Base materials / the original GLB texture are shared + cached, so they are left alone.
	function disposeGarageCloneMaterials( root ) {

		if ( ! root ) return;
		root.traverse( ( child ) => {

			if ( ! child.isMesh ) return;
			const custom = child.userData?.customMaterial;
			if ( ! custom ) return;
			const bases = child.userData?.baseMaterial;
			const list = Array.isArray( custom ) ? custom : [ custom ];
			for ( let i = 0; i < list.length; i ++ ) {

				const material = list[ i ];
				const baseMap = Array.isArray( bases ) ? bases[ i ]?.map : bases?.map;
				if ( material?.map && material.map !== baseMap ) material.map.dispose();
				material?.dispose?.();

			}
			child.userData.customMaterial = null;

		} );

	}

	function initGarageViewer() {

		if ( garageViewer || ! garageViewerCanvas ) return;
		const renderer = new THREE.WebGLRenderer( { canvas: garageViewerCanvas, antialias: true, alpha: true } );
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.5 ) );
		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera( 34, 1, 0.1, 100 );
		// Frame the car properly: closer in AND pitched down at it. The old
		// (0, 1.25, 5.2) rig never lookAt-ed the car, so it sat as a tiny
		// sliver at the very bottom of the frame and clicks could not select.
		camera.position.set( 0, 1.35, 3.9 );
		camera.lookAt( 0, 0.45, 0 );
		scene.background = new THREE.Color( 0x87ceeb );
		scene.add( new THREE.AmbientLight( 0xffffff, 3.0 ) );
		const displayRoot = new THREE.Group();
		const garageRoot = new THREE.Group();
		const garageSource = models.garage;
		if ( garageSource ) {

			const garage = garageSource.clone( true );
			// The uploaded garage contains generous surrounding space. Keep the
			// scene large enough that the visible city reads behind the car.
			const garageScale = garageSceneScale;
			garage.scale.setScalar( garageScale );
			// The GLB origin is the car parking point. Preserve it instead of
			// recentering the mesh by its bounds, so the car shares the authored
			// garage coordinate system and sits naturally on the garage floor.
			garage.position.set( 0, 0, garageSceneZOffset );
			garage.traverse( ( child ) => {

				if ( ! child.isMesh ) return;
				const materials = Array.isArray( child.material ) ? child.material : [ child.material ];
				materials.forEach( ( material ) => { material.side = THREE.DoubleSide; } );
				child.castShadow = true;
				child.receiveShadow = true;

			} );
			garageRoot.add( garage );

		}
		const garageCollisionVisual = garageCollisionAsset?.clone( true );
		if ( garageCollisionVisual ) {

			garageCollisionVisual.visible = false;
			garageCollisionVisual.scale.setScalar( garageSceneScale );
			garageCollisionVisual.position.set( 0, 0, garageSceneZOffset );
			garageCollisionVisual.traverse( ( child ) => {

				if ( ! child.isMesh ) return;
				child.material = new THREE.MeshBasicMaterial( { color: 0xff4b38, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide } );
				child.renderOrder = 2;

			} );
			garageRoot.add( garageCollisionVisual );

		}
		garageRoot.renderOrder = - 1;
		displayRoot.add( garageRoot );
		const carRoot = new THREE.Group();
		carRoot.rotation.y = Math.PI / 4;
		displayRoot.add( carRoot );
		const garageKeyLight = new THREE.DirectionalLight( 0xffffff, 2.4 );
		garageKeyLight.position.set( - 4, 7, 5 );
		garageKeyLight.target.position.set( 0, 0, 0 );
		garageKeyLight.castShadow = true;
		garageKeyLight.shadow.mapSize.set( 1024, 1024 );
		garageKeyLight.shadow.camera.near = 0.1;
		garageKeyLight.shadow.camera.far = 30;
		garageKeyLight.shadow.camera.left = - 10;
		garageKeyLight.shadow.camera.right = 10;
		garageKeyLight.shadow.camera.top = 10;
		garageKeyLight.shadow.camera.bottom = - 10;
		scene.add( garageKeyLight, garageKeyLight.target );
		scene.add( displayRoot );
		garageViewer = { renderer, scene, camera, displayRoot, garageRoot, carRoot, yaw: 0, pitch: 0.23, zoom: 1, drive: false, dragging: false, moved: false, sx: 0, sy: 0, pinchDistance: 0, pointers: new Map(), raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2() };
		const resize = () => {

			const rect = garageViewerCanvas.getBoundingClientRect();
			const w = Math.max( 1, Math.floor( rect.width ) );
			const h = Math.max( 1, Math.floor( rect.height ) );
			renderer.setSize( w, h, false );
			camera.aspect = w / h;
			camera.updateProjectionMatrix();

		};
		const animate = () => {

			if ( garageViewer ) {

				resize();
				const orbitRadius = 3.9 / garageViewer.zoom;
				if ( garageViewer.drive ) {

					displayRoot.rotation.y = 0;
					const target = garageVehicle?.spherePos || vehicle.spherePos;
					const chaseOffset = new THREE.Vector3( 0, 2.3, - 6.6 ).applyQuaternion( garageVehicle?.container?.quaternion || vehicle.container.quaternion );
					const chaseLook = new THREE.Vector3( 0, 0.9, 4.8 ).applyQuaternion( garageVehicle?.container?.quaternion || vehicle.container.quaternion );
					camera.position.lerp( new THREE.Vector3( target.x + chaseOffset.x, target.y + chaseOffset.y, target.z + chaseOffset.z ), 0.12 );
					camera.lookAt( target.x + chaseLook.x, target.y + chaseLook.y, target.z + chaseLook.z );

				} else {

					displayRoot.rotation.y = garageViewer.yaw;
					carRoot.rotation.y = Math.PI / 4;
					camera.position.y = 0.45 + Math.sin( garageViewer.pitch ) * orbitRadius;
					camera.position.z = Math.cos( garageViewer.pitch ) * orbitRadius;
					camera.lookAt( 0, 0.45, 0 );

				}
				renderer.shadowMap.needsUpdate = true;
				renderer.render( scene, camera );
				requestAnimationFrame( animate );

			}

		};
		// Drag to rotate; a click (no significant drag) selects the color under the cursor.
		garageViewerCanvas.addEventListener( 'wheel', ( event ) => {

			event.preventDefault();
			garageViewer.zoom = THREE.MathUtils.clamp( garageViewer.zoom * Math.exp( - event.deltaY * 0.001 ), 0.3, 2.2 );

		}, { passive: false } );
		garageViewerCanvas.addEventListener( 'pointerdown', ( event ) => {

			garageViewer.pointers.set( event.pointerId, { x: event.clientX, y: event.clientY } );
			if ( garageViewer.pointers.size === 2 ) {

				const points = [ ... garageViewer.pointers.values() ];
				garageViewer.pinchDistance = Math.hypot( points[ 0 ].x - points[ 1 ].x, points[ 0 ].y - points[ 1 ].y );
				garageViewer.dragging = false;

			} else {

				garageViewer.dragging = true;
				garageViewer.moved = false;
				garageViewer.sx = event.clientX;
				garageViewer.sy = event.clientY;
				garageViewerCanvas.classList.add( 'dragging' );

			}
			garageViewerCanvas.setPointerCapture?.( event.pointerId );

		} );
		garageViewerCanvas.addEventListener( 'pointermove', ( event ) => {

			if ( garageViewer.pointers.has( event.pointerId ) ) garageViewer.pointers.set( event.pointerId, { x: event.clientX, y: event.clientY } );
			if ( garageViewer.pointers.size >= 2 ) {

				const points = [ ... garageViewer.pointers.values() ];
				const distance = Math.hypot( points[ 0 ].x - points[ 1 ].x, points[ 0 ].y - points[ 1 ].y );
				if ( garageViewer.pinchDistance > 0 ) garageViewer.zoom = THREE.MathUtils.clamp( garageViewer.zoom * ( distance / garageViewer.pinchDistance ), 0.3, 2.2 );
				garageViewer.pinchDistance = distance;
				garageViewer.moved = true;
				return;

			}
			if ( ! garageViewer.dragging ) return;
			const dx = event.clientX - garageViewer.sx;
			const dy = event.clientY - garageViewer.sy;
			if ( Math.abs( dx ) + Math.abs( dy ) > 4 ) garageViewer.moved = true;
			garageViewer.yaw += dx * 0.01;
			// Dragging upward lowers the camera; never allow it below the car.
			garageViewer.pitch = THREE.MathUtils.clamp( garageViewer.pitch + dy * 0.008, 0, 0.95 );
			garageViewer.sx = event.clientX;
			garageViewer.sy = event.clientY;

		} );
		const endPointer = ( event ) => {

			garageViewer.pointers.delete( event.pointerId );
			if ( garageViewer.pointers.size > 0 ) return;
			garageViewer.dragging = false;
			garageViewerCanvas.classList.remove( 'dragging' );
			if ( ! garageViewer.moved && ! garageViewer.drive ) garageSelectFromViewerClick( event );

		};
		garageViewerCanvas.addEventListener( 'pointerup', endPointer );
		garageViewerCanvas.addEventListener( 'pointercancel', endPointer );
		refreshGarageViewer();
		animate();

	}

	function setGarageDriveActive( active ) {

		if ( active === garageDriveActive ) return;
		if ( active ) {

			if ( ! garageViewer ) initGarageViewer();
			if ( ! garageViewer ) return;
			if ( ! garageCollisionAdded ) {

				const collisionData = addGarageCollisionBoxes( garageWorld, garageCollisionAsset, garageSceneScale, garageSceneZOffset );
				garageFloorTop = collisionData.floorTop;
				garageCollisionAdded = true;
				appendLoadingConsole( `Garage collision boxes loaded: ${ collisionData.count } (scale ${ garageSceneScale.toFixed( 3 )}, floor top ${ garageFloorTop.toFixed( 3 )})` );

			}
			const garageSpawn = [ 0, garageFloorTop + 0.55, 0 ];
			if ( ! garageVehicleBody ) garageVehicleBody = createSphereBody( garageWorld, garageSpawn );
			const garageCarKey = getSelectedGarageCarKey();
			if ( ! garageVehicle ) {

				garageVehicle = new Vehicle();
				garageVehicle.rigidBody = garageVehicleBody;
				garageVehicle.physicsWorld = garageWorld;
				garageVehicle.setPerformance( CAR_STATS[ garageCarKey ].perf );
				garageVehicle.init( models[ garageCarKey ] );
				applyCarCustomizationToObject( garageVehicle.container, garageCarKey );

			} else if ( models[ garageCarKey ] ) garageVehicle.setModel( models[ garageCarKey ] );
			garageVehicle.setPerformance( CAR_STATS[ garageCarKey ].perf );
			applyCarCustomizationToObject( garageVehicle.container, garageCarKey );
			garageVehicle.rigidBody = garageVehicleBody;
			garageVehicle.physicsWorld = garageWorld;
			rigidBody.setLinearVelocity( world, sphereBody, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( world, sphereBody, [ 0, 0, 0 ] );
			garageDriveActive = true;
			garageViewer.drive = true;
			garageViewer.carRoot.visible = false;
			disposeGarageCloneMaterials( garageViewer.carRoot );
			garageViewer.carRoot.clear();
			garageViewer.displayRoot.add( garageVehicle.container );
			garageVehicle.setSpawn( garageSpawn, 0 );
			garageVehicle.resetToSpawn();
			garageDriveBtn.textContent = 'Exit garage drive';
			garageDriveBtn.classList.add( 'active' );
			garageViewerHint.textContent = 'WASD or controller to drive • drag to orbit camera • scroll or pinch to zoom';

		} else {

			garageDriveActive = false;
			if ( garageViewer ) {

				garageViewer.drive = false;
				garageViewer.carRoot.visible = true;
				if ( garageVehicle?.container?.parent ) garageVehicle.container.parent.remove( garageVehicle.container );

			}
			garageVehicle?.resetToSpawn();
			refreshGarageViewer();
			garageDriveBtn.textContent = 'Test drive garage';
			garageDriveBtn.classList.remove( 'active' );
			garageViewerHint.textContent = 'Click a color to select it • drag to rotate • scroll or pinch to zoom';

		}

	}

	function renderGarageVehicleCards() {

		if ( ! garageVehicleCards ) return;
		const selectedKey = getSelectedGarageCarKey();
		garageVehicleCards.innerHTML = '';
		garageCardCanvasByKey = {};
		disposeGarageCardPreviews(); // old canvases are gone → drop their renderers, rebind to fresh ones
		for ( const carKey of modelNames.filter( ( key ) => CAR_STATS[ key ] ) ) {

			const stats = CAR_STATS[ carKey ];
			const style = CAR_SELECT_STYLES[ carKey ] || {};
			const mappings = getGarageCosmeticCar( carKey ).mappings.length;
			const button = document.createElement( 'button' );
			button.type = 'button';
			button.className = `garage-vehicle-card${ carKey === selectedKey ? ' active' : '' }`;
			button.dataset.carKey = carKey;
			button.style.setProperty( '--garage-accent', style.border || '#9ed8ff' );
			// No per-card spinning 3D previews anymore — with many painted cars
			// the shared preview renderer repaint (clone + full texture recolor
			// per car, per frame) tanked the whole page. The big garage viewer
			// is the one true preview now.
			button.innerHTML = `
				<h5>${ stats.name }</h5>
				<div class="garage-vehicle-meta">
					<span>Paint maps: ${ mappings }</span>
				</div>`;
			button.addEventListener( 'click', ( event ) => { event.preventDefault(); event.stopPropagation(); selectGarageCar( carKey ); } );
			garageVehicleCards.appendChild( button );

		}
		updateGarageCardActiveState();
		if ( modeMenuOpen && modeTab === 'garage' ) activateGarageCardPreviews();

	}

	// Toggle the .active outline on the cards without rebuilding them (a rebuild would dispose
	// every preview renderer and blank the cars). Called from selectGarageCar on every card click.
	function updateGarageCardActiveState() {

		const selectedKey = getSelectedGarageCarKey();
		garageVehicleCards?.querySelectorAll( '.garage-vehicle-card' ).forEach( ( card ) => {

			card.classList.toggle( 'active', card.dataset.carKey === selectedKey );

		} );

	}

	// Build/refresh the mini 3D previews for the current card canvases and start the shared
	// spin loop. Called when the garage tab becomes visible. (No-op if models aren't loaded yet.)
	function activateGarageCardPreviews() {

		ensureGarageCardPreviews();
		refreshGarageCardPreviewsPaint();
		startGarageCardPreviews();

	}

	// --- Garage vehicle-card mini 3D previews -------------------------------------
	// All card previews share a SINGLE lightweight WebGLRenderer (rendered to an offscreen canvas,
	// then blitted onto each card's 2D canvas). Previously each card had its own WebGLRenderer → 10
	// simultaneous contexts (12 with the main game + paint viewer), which tripped WebGL context loss
	// on the main renderer whenever the player applied paint (the whole 3D canvas went black). One
	// shared context eliminates that. The cards still spin. Renderers are created lazily on first
	// garage open (not at boot) and disposed when the garage closes.
	function ensureGarageCardPreviews() {

		if ( ! garageCardSharedRenderer ) {

			const off = document.createElement( 'canvas' );
			off.width = 128; off.height = 96;
			garageCardSharedRenderer = new THREE.WebGLRenderer( { canvas: off, antialias: true, alpha: true, preserveDrawingBuffer: true } );
			garageCardSharedRenderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.25 ) );

		}
		for ( const carKey of Object.keys( garageCardCanvasByKey ) ) {

			if ( garageCardPreviews.has( carKey ) ) continue;
			if ( ! models[ carKey ] ) continue;
			const canvas = garageCardCanvasByKey[ carKey ];
			if ( ! canvas ) continue;
			const ctx2d = canvas.getContext( '2d' );
			const scene = new THREE.Scene();
			scene.add( new THREE.AmbientLight( 0xffffff, 3.0 ) );
			const dir = new THREE.DirectionalLight( 0xffffff, 1.2 );
			dir.position.set( 2, 3, 2 );
			scene.add( dir );
			const camera = new THREE.PerspectiveCamera( 34, 1, 0.1, 100 );
			camera.position.set( 0, 0.85, 3.5 ); // closer than the paint viewer (z 5.2) → "more zoomed in"
			camera.lookAt( 0, 0.1, 0 );
			const carRoot = new THREE.Group();
			scene.add( carRoot );
			garageCardPreviews.set( carKey, { scene, camera, carRoot, yaw: 0, ctx2d } );
			refreshGarageCardPreviewPaint( carKey );
			resizeGarageCardPreview( carKey );

		}

	}

	function resizeGarageCardPreview( carKey ) {

		const p = garageCardPreviews.get( carKey );
		if ( ! p ) return;
		const canvas = garageCardCanvasByKey[ carKey ];
		if ( ! canvas ) return;
		const rect = canvas.getBoundingClientRect();
		const w = Math.max( 1, Math.floor( rect.width ) );
		const h = Math.max( 1, Math.floor( rect.height ) );
		if ( canvas.width !== w || canvas.height !== h ) {

			canvas.width = w;
			canvas.height = h;

		}
		p.camera.aspect = w / h;
		p.camera.updateProjectionMatrix();

	}

	function refreshGarageCardPreviewPaint( carKey ) {

		const p = garageCardPreviews.get( carKey );
		if ( ! p || ! models[ carKey ] ) return;
		disposeGarageCloneMaterials( p.carRoot );
		p.carRoot.clear();
		const clone = models[ carKey ].clone( true );
		clone.rotation.y = Math.PI;
		p.carRoot.add( clone );
		applyCarCustomizationToObject( clone, carKey, '', true, '', getGarageRepaintTolerance(), null, '' );

	}

	function refreshGarageCardPreviewsPaint() {

		for ( const carKey of garageCardPreviews.keys() ) refreshGarageCardPreviewPaint( carKey );

	}

	function updateGarageCardMeta( carKey ) {

		// Cards no longer hold preview canvases — find them by data-car-key so the
		// "Paint maps: N" count updates immediately after every paint/remove.
		const card = garageVehicleCards?.querySelector( `.garage-vehicle-card[data-car-key="${ carKey }"]` );
		const meta = card?.querySelector( '.garage-vehicle-meta > span:last-child' );
		if ( meta ) meta.textContent = `Paint maps: ${ getGarageCosmeticCar( carKey ).mappings.length }`;

	}

	function startGarageCardPreviews() {

		if ( garageCardPreviewsRaf ) return;
		if ( garageCardPreviews.size === 0 || ! garageCardSharedRenderer ) return;
		const loop = () => {

			garageCardPreviewsRaf = 0;
			const r = garageCardSharedRenderer;
			const src = r.domElement;
			for ( const [ carKey, p ] of garageCardPreviews ) {

				const canvas = garageCardCanvasByKey[ carKey ];
				if ( ! canvas?.isConnected ) continue;
				resizeGarageCardPreview( carKey );
				p.yaw += 0.012; // slow spin
				p.carRoot.rotation.y = p.yaw;
				r.setSize( canvas.width, canvas.height, false );
				r.render( p.scene, p.camera );
				if ( p.ctx2d ) {
					// Clear the previous frame before blitting, otherwise the spinning car
					// leaves a smeared collage of every prior frame stacked on top.
					p.ctx2d.clearRect( 0, 0, canvas.width, canvas.height );
					p.ctx2d.drawImage( src, 0, 0, canvas.width, canvas.height );
				}

			}
			if ( garageCardPreviews.size ) garageCardPreviewsRaf = requestAnimationFrame( loop );

		};
		garageCardPreviewsRaf = requestAnimationFrame( loop );

	}

	function stopGarageCardPreviews() {

		if ( garageCardPreviewsRaf ) { cancelAnimationFrame( garageCardPreviewsRaf ); garageCardPreviewsRaf = 0; }

	}

	function disposeGarageCardPreviews() {

		stopGarageCardPreviews();
		for ( const p of garageCardPreviews.values() ) {

			disposeGarageCloneMaterials( p.carRoot );
			p.carRoot.clear();

		}
		garageCardPreviews.clear();
		if ( garageCardSharedRenderer ) {

			garageCardSharedRenderer.dispose();
			garageCardSharedRenderer = null;

		}

	}

	function selectGarageCar( selectedKey ) {

		if ( ! CAR_STATS[ selectedKey ] ) return;
		if ( garageCarSelect ) garageCarSelect.value = selectedKey;
		if ( carSelect ) carSelect.value = selectedKey;
		updateCarSelectColor();
		if ( models[ selectedKey ] ) {

			vehicle.setModel( models[ selectedKey ] );
			applyCarCustomization( vehicle );
			applyHitboxHackVisuals( true );

		}
		updateGarageMappingsUi();
		ensureGarageSelectionSource();
		refreshGarageViewer();
		updateGarageCardActiveState();
		if ( garageDriveActive && garageVehicle && models[ selectedKey ] ) {

			garageVehicle.setModel( models[ selectedKey ] );
			garageVehicle.setPerformance( CAR_STATS[ selectedKey ].perf );
			applyCarCustomizationToObject( garageVehicle.container, selectedKey );

		}
		setGarageMappingStatus( `Now editing mappings for ${ CAR_STATS[ selectedKey ]?.name || 'selected car' }.` );
		applyVehiclePerformance();
		saveGarageMods();

	}

	function updateGarageMappingsUi() {

		if ( ! garageMappingsList ) return;
		const carKey = getSelectedGarageCarKey();
		const mappings = getGarageCosmeticCar( carKey ).mappings;
		garageMappingsList.innerHTML = '';
		if ( mappings.length === 0 ) {

			const empty = document.createElement( 'li' );
			empty.textContent = 'No mappings yet for this car.';
			garageMappingsList.appendChild( empty );
			return;

		}
		mappings.forEach( ( mapping, index ) => {

			const destination = getPaintColorById( mapping.targetColorId );
			const regionLabel = mapping.mask ? ' • region' : '';
			const item = document.createElement( 'li' );
			const swatch = document.createElement( 'span' );
			swatch.className = 'garage-mapping-swatch';
			swatch.style.setProperty( '--src', mapping.sourceHex );
			swatch.style.setProperty( '--dst', destination?.hex || '#444' );
			swatch.title = `${ mapping.sourceHex } → ${ destination?.hex || '(locked)' }`;
			const label = document.createElement( 'span' );
			label.innerHTML = `<strong>${ mapping.sourceHex }</strong> → <strong>${ destination?.hex || '(locked)' }</strong>${ regionLabel } <em>(tol ${ Math.round( mapping.tolerance ) })</em>`;
			const removeBtn = document.createElement( 'button' );
			removeBtn.type = 'button';
			removeBtn.textContent = 'Remove';
			removeBtn.style.marginLeft = '6px';
			removeBtn.addEventListener( 'click', ( event ) => {

				event.preventDefault();
				event.stopPropagation();
				mappings.splice( index, 1 );
				saveGarageMods();
				updateGarageMappingsUi();
				applyCarCustomization( vehicle );
				refreshGarageViewer();
				refreshGarageCardPreviewPaint( carKey );
				updateGarageCardMeta( carKey );
				broadcastPeerState();

			} );
			item.appendChild( swatch );
			item.appendChild( label );
			item.appendChild( removeBtn );
			garageMappingsList.appendChild( item );

		} );

	}

	function hexToRgbBytes( hex ) {

		const clean = String( hex || '' ).trim().replace( '#', '' );
		if ( ! /^[0-9a-fA-F]{6}$/.test( clean ) ) return null;
		return {
			r: Number.parseInt( clean.slice( 0, 2 ), 16 ),
			g: Number.parseInt( clean.slice( 2, 4 ), 16 ),
			b: Number.parseInt( clean.slice( 4, 6 ), 16 ),
		};

	}

	function buildResolvedMappings( mappings ) {

		const resolved = [];
		for ( const mapping of mappings ) {

			const source = hexToRgbBytes( mapping?.sourceHex );
			const targetPaint = getPaintColorById( mapping?.targetColorId );
			const target = hexToRgbBytes( targetPaint?.hex );
			if ( ! source || ! target || ! garageCosmetics.unlockedPaints[ mapping?.targetColorId ] ) continue;
			const tolerance = THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 );
			resolved.push( {
				source,
				target,
				finish: targetPaint.finish || 'matte',
				toleranceSq: tolerance * tolerance,
				mask: null,
				maskW: Number( mapping?.maskW ) || 0,
				maskH: Number( mapping?.maskH ) || 0,
				maskRle: typeof mapping?.mask === 'string' ? mapping.mask : '',
			} );

		}
		return resolved;

	}

	// Lazily decode a mapping's RLE mask against the given texture pixel count (cached on the mapping).
	function getResolvedMappingMask( mapping, total ) {

		if ( ! mapping || ! total ) return null;
		// Direct in-memory mask (used by the live preview mapping).
		if ( mapping.mask && mapping.mask.length === total ) return mapping.mask;
		if ( ! mapping.maskRle ) return null;
		if ( mapping.maskW * mapping.maskH !== total ) return null;
		if ( mapping._mask && mapping._mask.length === total ) return mapping._mask;
		const decoded = decodeSelectionMaskRle( mapping.maskRle, total );
		mapping._mask = decoded;
		return decoded;

	}

	function pickMappedColor( rgb, resolvedMappings ) {

		let best = null;
		let bestDistSq = Number.POSITIVE_INFINITY;
		for ( const mapping of resolvedMappings ) {

			const dr = rgb.r - mapping.source.r;
			const dg = rgb.g - mapping.source.g;
			const db = rgb.b - mapping.source.b;
			const distSq = dr * dr + dg * dg + db * db;
			if ( distSq <= mapping.toleranceSq && distSq < bestDistSq ) {

				best = { ...mapping.target, finish: mapping.finish };
				bestDistSq = distSq;

			}

		}
		return best;

	}

	function getTextureSourcePixels( texture ) {

		if ( ! texture?.image ) return null;
		if ( recolorTextureSourceCache.has( texture ) ) return recolorTextureSourceCache.get( texture );

		const image = texture.image;
		const width = image.width || image.videoWidth;
		const height = image.height || image.videoHeight;
		if ( ! width || ! height ) return null;

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, width, height );
		const source = ctx.getImageData( 0, 0, width, height );
		const cached = { width, height, data: new Uint8ClampedArray( source.data ) };
		recolorTextureSourceCache.set( texture, cached );
		return cached;

	}

	function recolorTexture( texture, resolvedMappings ) {

		if ( resolvedMappings.length === 0 || ! texture ) return { texture, hasShiny: false };
		const source = getTextureSourcePixels( texture );
		if ( ! source ) return { texture, hasShiny: false };

		const canvas = document.createElement( 'canvas' );
		canvas.width = source.width;
		canvas.height = source.height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return { texture, hasShiny: false };

		const output = new Uint8ClampedArray( source.data );
		let hasShiny = false;
		const total = source.width * source.height;
		// Pre-decode any masks so the hot loop stays cheap.
		const masks = resolvedMappings.map( ( m ) => getResolvedMappingMask( m, total ) );
		// Masked mappings are region-accurate: they must ONLY paint inside their
		// mask. Letting them also color-match globally doubled the effective
		// tolerance (selected region + a whole-car wash of the same paint).
		// Legacy / ghost mappings without masks keep the global color match.
		const globalMappings = resolvedMappings.filter( ( m, idx ) => ! masks[ idx ] );
		for ( let i = 0, p = 0; i < output.length; i += 4, p ++ ) {

			let mapped = null;
			// Prefer an exact region mask if present (region-accurate repaint).
			for ( let m = 0; m < masks.length; m ++ ) {

				if ( masks[ m ] && masks[ m ][ p ] ) { mapped = { ...resolvedMappings[ m ].target, finish: resolvedMappings[ m ].finish }; break; }

			}
			// Fall back to global color-distance match (legacy / no mask / ghosts).
			if ( ! mapped ) {

				mapped = pickMappedColor( {
					r: output[ i ],
					g: output[ i + 1 ],
					b: output[ i + 2 ],
				}, globalMappings );

			}
			if ( mapped ) {

				output[ i ] = mapped.r;
				output[ i + 1 ] = mapped.g;
				output[ i + 2 ] = mapped.b;
				if ( mapped.finish === 'shiny' ) hasShiny = true;

			}

		}

		const imageData = new ImageData( output, source.width, source.height );
		ctx.putImageData( imageData, 0, 0 );
		const nextTexture = new THREE.CanvasTexture( canvas );
		nextTexture.colorSpace = texture.colorSpace;
		nextTexture.flipY = texture.flipY;
		nextTexture.wrapS = texture.wrapS;
		nextTexture.wrapT = texture.wrapT;
		nextTexture.repeat.copy( texture.repeat );
		nextTexture.offset.copy( texture.offset );
		nextTexture.rotation = texture.rotation;
		nextTexture.center.copy( texture.center );
		nextTexture.minFilter = texture.minFilter;
		nextTexture.magFilter = texture.magFilter;
		nextTexture.generateMipmaps = texture.generateMipmaps;
		nextTexture.anisotropy = texture.anisotropy;
		nextTexture.needsUpdate = true;
		return { texture: nextTexture, hasShiny };

	}

	function applyShinyFinish( material, mappedColor = null ) {

		if ( typeof material.metalness === 'number' ) material.metalness = SHINY_MATERIAL_TUNING.metalness;
		if ( typeof material.roughness === 'number' ) material.roughness = SHINY_MATERIAL_TUNING.roughness;
		if ( typeof material.envMapIntensity === 'number' ) material.envMapIntensity = SHINY_MATERIAL_TUNING.envMapIntensity;
		if ( typeof material.clearcoat === 'number' ) material.clearcoat = SHINY_MATERIAL_TUNING.clearcoat;
		if ( typeof material.clearcoatRoughness === 'number' ) material.clearcoatRoughness = SHINY_MATERIAL_TUNING.clearcoatRoughness;
		if ( typeof material.specularIntensity === 'number' ) material.specularIntensity = SHINY_MATERIAL_TUNING.specularIntensity;
		if ( typeof material.shininess === 'number' ) material.shininess = SHINY_MATERIAL_TUNING.phongShininess;
		if ( material.specular && typeof material.specular.setScalar === 'function' ) material.specular.setScalar( 1.0 );
		if ( material.color ) material.color.multiplyScalar( SHINY_MATERIAL_TUNING.brightnessBoost );
		if ( material.emissive ) {

			if ( mappedColor ) material.emissive.setRGB( mappedColor.r / 255, mappedColor.g / 255, mappedColor.b / 255 );
			else material.emissive.copy( material.color );
			material.emissive.multiplyScalar( SHINY_MATERIAL_TUNING.emissiveBoost );

		}

	}

	function colorDistanceSqHex( aHex, bHex ) {

		const a = hexToRgbBytes( aHex );
		const b = hexToRgbBytes( bHex );
		if ( ! a || ! b ) return Number.POSITIVE_INFINITY;
		return ( a.r - b.r ) ** 2 + ( a.g - b.g ) ** 2 + ( a.b - b.b ) ** 2;

	}

	function createHighlightedTexture( texture, selectedHex, hoverHex = '', tolerance = GARAGE_COLOR_PICK_TOLERANCE ) {

		const hasSelected = /^#[0-9a-fA-F]{6}$/.test( selectedHex || '' );
		const hasHover = /^#[0-9a-fA-F]{6}$/.test( hoverHex || '' );
		if ( ! texture || ( ! hasSelected && ! hasHover ) ) return null;
		const source = getTextureSourcePixels( texture );
		const selected = hasSelected ? hexToRgbBytes( selectedHex ) : null;
		const hover = hasHover ? hexToRgbBytes( hoverHex ) : null;
		if ( ! source || ( hasSelected && ! selected ) || ( hasHover && ! hover ) ) return null;
		const toleranceSq = tolerance * tolerance;
		const output = new Uint8ClampedArray( source.data );
		let matched = false;
		for ( let i = 0; i < output.length; i += 4 ) {

			let color = null;
			if ( selected ) {

				const dr = source.data[ i ] - selected.r;
				const dg = source.data[ i + 1 ] - selected.g;
				const db = source.data[ i + 2 ] - selected.b;
				if ( dr * dr + dg * dg + db * db <= toleranceSq ) color = { r: 80, g: 255, b: 120 };

			}
			if ( ! color && hover ) {

				const dr = source.data[ i ] - hover.r;
				const dg = source.data[ i + 1 ] - hover.g;
				const db = source.data[ i + 2 ] - hover.b;
				if ( dr * dr + dg * dg + db * db <= toleranceSq ) color = { r: 255, g: 230, b: 60 };

			}
			if ( color ) {

				output[ i ] = Math.min( 255, Math.round( output[ i ] * 0.35 + color.r * 0.65 ) );
				output[ i + 1 ] = Math.min( 255, Math.round( output[ i + 1 ] * 0.35 + color.g * 0.65 ) );
				output[ i + 2 ] = Math.min( 255, Math.round( output[ i + 2 ] * 0.35 + color.b * 0.65 ) );
				matched = true;

			}

		}
		if ( ! matched ) return null;
		const canvas = document.createElement( 'canvas' );
		canvas.width = source.width;
		canvas.height = source.height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.putImageData( new ImageData( output, source.width, source.height ), 0, 0 );
		const nextTexture = new THREE.CanvasTexture( canvas );
		nextTexture.colorSpace = texture.colorSpace;
		nextTexture.flipY = texture.flipY;
		nextTexture.wrapS = texture.wrapS;
		nextTexture.wrapT = texture.wrapT;
		nextTexture.repeat.copy( texture.repeat );
		nextTexture.offset.copy( texture.offset );
		nextTexture.rotation = texture.rotation;
		nextTexture.center.copy( texture.center );
		nextTexture.minFilter = texture.minFilter;
		nextTexture.magFilter = texture.magFilter;
		nextTexture.generateMipmaps = texture.generateMipmaps;
		nextTexture.anisotropy = texture.anisotropy;
		nextTexture.needsUpdate = true;
		return nextTexture;

	}


	function applyCarCustomizationToObject( root, carKey, highlightHex = '', previewUnlit = false, hoverHex = '', highlightTolerance = GARAGE_COLOR_PICK_TOLERANCE, previewMask = null, previewTargetHex = '' ) {

		if ( ! root ) return;
		const carData = getGarageCosmeticCar( carKey );
		const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
		const resolvedMappings = buildResolvedMappings( mappings );
		// For the live preview, fold the in-progress selection mask into a transient mapping so the
		// 3D clone shows exactly what will be repainted, before anything is committed.
		const previewTargetRgb = /^#[0-9a-fA-F]{6}$/.test( previewTargetHex ) ? hexToRgbBytes( previewTargetHex ) : null;
		const effectiveMappings = ( previewMask && previewTargetRgb ) ? [ ...resolvedMappings, { source: { r: 0, g: 0, b: 0 }, target: previewTargetRgb, finish: 'matte', toleranceSq: 0, mask: previewMask, maskW: 0, maskH: 0, maskRle: '' } ] : resolvedMappings;
		root.traverse( ( child ) => {

			if ( ! child.isMesh || ! child.material ) return;
			const incomingMaterials = Array.isArray( child.material ) ? child.material : [ child.material ];
			if ( ! child.userData.baseMaterial ) child.userData.baseMaterial = incomingMaterials.map( ( material ) => material.clone() );

			if ( Array.isArray( child.userData.customMaterial ) ) {

				child.userData.customMaterial.forEach( ( material, index ) => {

					if ( material?.map && material.map !== child.userData.baseMaterial?.[ index ]?.map ) material.map.dispose();
					material?.dispose?.();

				} );
				child.userData.customMaterial = null;

			}

			const builtMaterials = child.userData.baseMaterial.map( ( baseMaterial ) => {

				let material = baseMaterial.clone();
				if ( material.color ) {

					const baseRgb = hexToRgbBytes( `#${ baseMaterial.color.getHexString() }` );
					const mappedSolid = baseRgb ? pickMappedColor( baseRgb, resolvedMappings ) : null;
					if ( mappedSolid ) material.color.setRGB( mappedSolid.r / 255, mappedSolid.g / 255, mappedSolid.b / 255 );
					const baseHex = `#${ baseMaterial.color.getHexString() }`;
					const selectedSolid = /^#[0-9a-fA-F]{6}$/.test( highlightHex || '' ) && colorDistanceSqHex( baseHex, highlightHex ) <= highlightTolerance * highlightTolerance;
					const hoverSolid = ! selectedSolid && /^#[0-9a-fA-F]{6}$/.test( hoverHex || '' ) && colorDistanceSqHex( baseHex, hoverHex ) <= highlightTolerance * highlightTolerance;
					if ( selectedSolid || hoverSolid ) {

						if ( previewUnlit ) material.color.set( selectedSolid ? 0x50ff78 : 0xffe63c );
						else {

							if ( material.emissive ) material.emissive.set( selectedSolid ? 0x50ff78 : 0xffe63c );
							if ( typeof material.emissiveIntensity === 'number' ) material.emissiveIntensity = Math.max( material.emissiveIntensity || 0, 0.75 );

						}

					}
					if ( mappedSolid?.finish === 'shiny' ) {

						applyShinyFinish( material, mappedSolid );

					}

				}
				if ( material.map ) {

					const remapped = recolorTexture( material.map, effectiveMappings );
					material.map = createHighlightedTexture( baseMaterial.map, highlightHex, hoverHex, highlightTolerance ) || remapped.texture;
					if ( remapped.hasShiny ) {

						applyShinyFinish( material );

					}

				}
				if ( previewUnlit ) {

					const unlit = new THREE.MeshBasicMaterial( {
						color: material.color ? material.color.clone() : new THREE.Color( 0xffffff ),
						map: material.map || null,
						transparent: Boolean( material.transparent ),
						opacity: Number.isFinite( material.opacity ) ? material.opacity : 1,
						alphaTest: Number.isFinite( material.alphaTest ) ? material.alphaTest : 0,
						side: material.side,
					} );
					material.dispose?.();
					material = unlit;

				}
				material.needsUpdate = true;
				return material;

			} );
			child.userData.customMaterial = builtMaterials;
			child.material = Array.isArray( child.material ) ? builtMaterials : builtMaterials[ 0 ];

		} );

	}

	function applyCarCustomization( targetVehicle ) {

		if ( ! targetVehicle?.container ) return;
		applyCarCustomizationToObject( targetVehicle.container, currentCarKey() );

	}

	function campaignStageConfig( stage = 1 ) {

		const normalizedStage = Math.max( 1, Math.min( CAMPAIGN_STAGE_COUNT, Number( stage ) || 1 ) );
		return CAMPAIGN_STAGES[ normalizedStage - 1 ];

	}

	function saveCampaignState() {

		if ( ! campaignState ) return;
		localStorage.setItem( campaignStoreKey, JSON.stringify( campaignState ) );

	}

	function loadCampaignState() {

		try {

			const raw = localStorage.getItem( campaignStoreKey );
			const parsed = raw ? JSON.parse( raw ) : {};
			const urlStage = Number( new URLSearchParams( window.location.search ).get( 'campaignStage' ) );
			const baseStage = Number.isFinite( urlStage ) && urlStage > 0 ? urlStage : Number( parsed?.stage ) || 1;
			const stage = Math.max( 1, Math.min( CAMPAIGN_STAGE_COUNT, baseStage ) );
			const config = campaignStageConfig( stage );
			campaignState = {
				stage,
				stageType: config.type,
				goal: Number.isFinite( parsed?.goal ) ? parsed.goal : config.goal,
				progress: Number.isFinite( parsed?.progress ) ? Math.max( 0, parsed.progress ) : 0,
				completedRoadmaps: Number.isFinite( parsed?.completedRoadmaps ) ? Math.max( 0, parsed.completedRoadmaps ) : 0,
			};

		} catch ( e ) {

			const config = campaignStageConfig( 1 );
			campaignState = { stage: 1, stageType: config.type, goal: config.goal, progress: 0, completedRoadmaps: 0 };

		}

	}

	function updateCampaignUi() {

		if ( ! campaignProgressLabel || ! campaignState ) return;
		syncCampaignCountersFromStorage();
		const config = campaignStageConfig( campaignState.stage );
		const status = `${ campaignState.progress }/${ campaignState.goal }`;
		const target = campaignState.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds )
			? ` • Target ${( campaignTargetAuthorSeconds ).toFixed( 2 )}s${ campaignTrackName ? ` (${ campaignTrackName })` : '' }`
			: '';
		campaignProgressLabel.textContent = `Campaign Stage ${ campaignState.stage}: ${ config.text } • ${ status }${ target }`;

	}

	function incrementCampaignProgress( stageType, amount = 1 ) {
	if ( ! campaignState || campaignState.stageType !== stageType ) return;
	campaignState.progress = Math.min( campaignState.goal, campaignState.progress + Math.max( 1, amount ) );
	saveCampaignState();
	if ( campaignState.progress >= campaignState.goal ) completeCampaignStage();
	updateCampaignUi();
}


	function syncCampaignCountersFromStorage() {
		const likes = Number( localStorage.getItem( 'racing-campaign-counter:like-tracks' ) || 0 );
		const published = Number( localStorage.getItem( 'racing-campaign-counter:publish-track' ) || 0 );
		const sharedOpens = Number( localStorage.getItem( 'racing-campaign-counter:play-share-open' ) || 0 );
		const editorPlayed = localStorage.getItem( 'racing-campaign-editor-played' ) === '1' ? 1 : 0;
		const modsInstalled = Number( localStorage.getItem( 'racing-mod-install-count' ) || 0 );
		if ( campaignState?.stageType === 'like-tracks' && likes > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, likes );
		if ( campaignState?.stageType === 'publish-track' && published > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, published );
		if ( campaignState?.stageType === 'install-mod' && modsInstalled > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, modsInstalled );
		if ( campaignState?.stageType === 'play-share' && sharedOpens > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, sharedOpens );
		if ( campaignState?.stageType === 'editor-play' && editorPlayed > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, editorPlayed );
	}
function completeCampaignStage() {

		if ( ! campaignState ) return;
		campaignState.stage ++;
		const next = campaignStageConfig( campaignState.stage );
		campaignState.stageType = next.type;
		campaignState.goal = next.goal;
		campaignState.progress = 0;
		if ( campaignState.stage > CAMPAIGN_STAGE_COUNT ) {

			campaignState.completedRoadmaps ++;
			campaignState.stage = 1;
			const loop = campaignStageConfig( 1 );
			campaignState.stageType = loop.type;
			campaignState.goal = loop.goal;

		}
		saveCampaignState();
		updateCampaignUi();

	}

	async function fetchCampaignTracks() {

	try {

			for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

				const data = await fetchTrackBoardWithRetry( `${ TRACK_SHARE_API_ROOT }${ prefix }/tracks` );
				return Array.isArray( data?.entries ) ? data.entries.filter( ( entry ) => Number.isFinite( Number( entry?.bestLapSeconds ) ) && typeof entry?.playUrl === 'string' ) : [];

			}
			return [];

		} catch ( e ) {

			return [];

		}

	}

	function buildCampaignUrl( baseUrl, entry ) {

		const url = new URL( baseUrl, window.location.href );
		url.searchParams.set( 'campaign', '1' );
		url.searchParams.set( 'campaignGoal', 'beat-authors' );
		url.searchParams.set( 'campaignAuthor', String( Number( entry.bestLapSeconds ) ) );
		url.searchParams.set( 'campaignTrackName', String( entry.name || 'Shared Track' ) );
		return url.toString();

	}

	async function startCampaignChallenge() {

		if ( ! campaignState ) return;
		const config = campaignStageConfig( campaignState.stage );
		campaignState.stageType = config.type;
		if ( config.type === 'beat-authors' ) {

			const pool = await fetchCampaignTracks();
			if ( pool.length === 0 ) {

				showModeError( 'Campaign requires shared tracks from /api/tracks.' );
				return;

			}
			const pick = pool[ Math.floor( Math.random() * pool.length ) ];
			if ( ! pick?.playUrl ) return;
			window.location.href = buildCampaignUrl( pick.playUrl, pick );
			return;

		}
		campaignTargetAuthorSeconds = null;
		campaignTrackName = 'Current track';
		updateCampaignUi();

	}

	function saveEconomy() {

		localStorage.setItem( economyStoreKey, JSON.stringify( { coins } ) );

	}

	function loadEconomy() {

		try {

			const raw = localStorage.getItem( economyStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			coins = Number.isFinite( parsed.coins ) ? parsed.coins : 0;

		} catch ( e ) {

			console.warn( 'Failed to load economy', e );

		}

	}

	function saveRecentGhostHistory() {

		try {

			// Compact "g2" entries — raw sample arrays could blow past the
			// localStorage quota on Chromebooks; the codec cuts ~89%.
			const compact = [];
			for ( const entry of recentGhostHistory.slice( 0, 12 ) ) {

				const g2 = encodeGhostBinary( entry );
				if ( g2 ) compact.push( { g2 } );

			}
			localStorage.setItem( recentGhostStoreKey, JSON.stringify( compact ) );

		} catch ( e ) {

			console.warn( 'Failed to save recent ghosts', e );

		}

	}

	function loadRecentGhostHistory() {

		try {

			const raw = localStorage.getItem( recentGhostStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			if ( ! Array.isArray( parsed ) ) return;
			recentGhostHistory.length = 0;
			for ( const entry of parsed.slice( 0, 12 ) ) {

				const normalized = extractNormalizedGhostPayload( entry );
				if ( ! normalized ) continue;
				recentGhostHistory.push( {
					samples: normalized.samples,
					duration: normalized.duration,
					car: normalized.car || 'vehicle-truck-yellow',
					cosmetics: normalized.cosmetics || null,
					checkpointTimes: computeCheckpointCrossTimes( normalized.samples ),
				} );

			}

		} catch ( e ) {

			console.warn( 'Failed to load recent ghosts', e );

		}

	}

	function updateEconomyHud() {

		if ( coinsLabel ) coinsLabel.textContent = `🪙 ${ Math.floor( coins ).toLocaleString() }`;
		if ( accountCoinsValue ) accountCoinsValue.textContent = Math.floor( coins ).toLocaleString();
		updateGarageUi();

	}

	function rewardCoinsForLap( lapSecondsCompleted ) {

		if ( isSplitScreen ) return;
		const reward = Math.max( 20, Math.min( 50, Math.round( 50 - lapSecondsCompleted * 0.75 ) ) );
		coins += reward;
		saveEconomy();
		updateEconomyHud();

	}

	carSelect?.querySelectorAll( 'option' ).forEach( ( option ) => {

		const stats = CAR_STATS[ option.value ];
		if ( ! stats ) return;
		option.textContent = `${ stats.name }`;

	} );


	function pickRandomOwnedCarKey() {
		const available = Object.keys( CAR_STATS ).filter( ( key ) => models[ key ] );
		if ( available.length === 0 ) return currentCarKey();
		return available[ Math.floor( Math.random() * available.length ) ];
	}

	function randomizeLapCarIfSinglePlayer() {
		if ( isSplitScreen || ! carSelect ) return;
		const nextKey = pickRandomOwnedCarKey();
		if ( ! nextKey || ! CAR_STATS[ nextKey ] ) return;
		carSelect.value = nextKey;
		updateCarSelectColor();
		if ( models[ nextKey ] ) vehicle.setModel( models[ nextKey ] );
		applyCarCustomization( vehicle );
		applyVehiclePerformance();
	}
	const audio = new GameAudio();
	audio.init( cam.camera );
	window.__gameAudio = audio;

	// Apply the unified settings (graphics preset + advanced overrides, audio
	// volumes, camera params, FPS HUD) so changes made on settings.html take
	// effect. Expose the live-apply entry point so the settings page can push
	// updates into this running game from another tab.
	try { applyLiveGameSettings( GameSettings.getSettings() ); } catch ( e ) { console.warn( 'GameSettings live-apply failed', e ); }
	window.__gameSettingsApplyLive = function () { applyLiveGameSettings( GameSettings.getSettings() ); };
	// Cross-tab: react to settings saved from another tab/page.
	window.addEventListener( 'storage', ( e ) => {
		if ( e.key === GameSettings.UNIFIED_KEY ) {
			GameSettings.refresh();
			try { applyLiveGameSettings( GameSettings.getSettings() ); } catch ( err ) {}
		}
	} );

	const _forward = new THREE.Vector3();
	const _up = new THREE.Vector3( 0, 1, 0 );
	const _boostForward = new THREE.Vector3();
	const _magnetDelta = new THREE.Vector3();
	const _magnetDir = new THREE.Vector3();

	// Crash detection moved to post-physics step (see after updateWorld).
	// The contact listener used to fire crash sound + camera shake on EVERY
	// ground contact because it measured forward SPEED (always high when driving)
	// not actual impact. Now we only crash-detect when the car loses significant
	// speed in a physics step — which only real collisions cause.
	let pendingContactBodies = false;
	const contactListener = {
		onContactAdded( bodyA, bodyB ) {
			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;
			pendingContactBodies = true;
		}
	};

	function detectCrashFromSpeedLoss( veh, speedBefore, speedAfter, isSeamBounce ) {
		if ( ! veh ) return;
		// Skip if this was a seam bounce — not a real crash
		if ( isSeamBounce ) { pendingContactBodies = false; return; }
		// Only crash if significant speed loss AND a new contact happened
		const speedLoss = speedBefore - speedAfter;
		if ( speedLoss < 1.5 || ! pendingContactBodies ) { pendingContactBodies = false; return; }
		pendingContactBodies = false;

		_forward.set( 0, 0, 1 ).applyQuaternion( veh.container.quaternion );
		_forward.y = 0;
		_forward.normalize();

		const impactVelocity = Math.min( speedLoss * 2.5, Math.abs( veh.modelVelocity.dot( _forward ) ) );
		advancementEvents.emit('crash_happened', { impactVelocity });
		crashShakeStrength = Math.max( crashShakeStrength, THREE.MathUtils.clamp( ( impactVelocity - 1.1 ) * 0.12, 0, 0.16 ) );
		crashShakeTime = Math.max( crashShakeTime, THREE.MathUtils.clamp( impactVelocity * 0.03, 0.05, 0.18 ) );
		audio.playImpact( impactVelocity );
		dispatchRuntimeModEvent( 'onCrash', { type: 'crash', impactVelocity } );
	}

	const timer = new THREE.Timer();
	let lastFrameNowMs = performance.now();
	let raceClockSeconds = 0;
	let paused = false;
	let currentLapInvalidatedByPause = false;
	let countdownActive = false;
	let countdownEndsAt = 0;
	let countdownEnabled = (() => {
		const stored = localStorage.getItem( COUNTDOWN_SETTINGS_KEY );
		if ( stored !== null ) return stored === '1';
		// Default: ON for mobile (pointer: coarse or body.mobile), OFF for desktop
		const isMobile = document.body.classList.contains( 'mobile' ) || Boolean( window.matchMedia?.( '(pointer: coarse)' )?.matches );
		return isMobile;
	})();
	let fpsHudVisible = localStorage.getItem( FPS_HUD_SETTINGS_KEY ) === '1';
	let rollingFps = 0;
	let fpsHudAccumulator = 0;
	const activeCells = customCells || TRACK_CELLS;
	const hasSeparateStartCell = activeCells.some( ( c ) => c[ 2 ] === 'track-start' );
	const hasSeparateFinishCell = activeCells.some( ( c ) => c[ 2 ] === 'track-finish' );
	const shouldAutoRespawnAfterLap = hasSeparateStartCell && hasSeparateFinishCell;
	const startCell = activeCells.find( ( c ) => c[ 2 ] === 'track-start' ) || activeCells.find( ( c ) => c[ 2 ] === 'track-start-finish' ) || null;
	const finishCell = activeCells.find( ( c ) => c[ 2 ] === 'track-finish' ) || activeCells.find( ( c ) => c[ 2 ] === 'track-start-finish' ) || activeCells[ 0 ];
	const elevatedCheckpointCells = Array.isArray( extras?.elevated )
		? extras.elevated
			.filter( ( c ) => Array.isArray( c ) && c[ 2 ] === 'elevated-checkpoint' )
			.map( ( [ gx, gz, , orient = 0 ] ) => [ gx, gz, 'track-checkpoint', orient ] )
		: [];
	const checkpointCells = [ ...activeCells.filter( ( c ) => c[ 2 ] === 'track-checkpoint' ), ...elevatedCheckpointCells ];
	const slopeElevatedCells = Array.isArray( extras?.elevated )
		? extras.elevated.filter( ( c ) => Array.isArray( c ) && ( c[ 2 ] === 'slope-up' || c[ 2 ] === 'slope-down' ) )
		: [];
	const lapStoreKey = `racing-lap-stats:${ mapParam || 'default' }`;
	const stuntStoreKey = `racing-stunt-stats:${ mapParam || 'default' }`;
	const currentTrackUrl = `${ window.location.origin }${ window.location.pathname }${ window.location.search }`;
	const leaderboardTrackId = getTrackId( mapParam, extrasParam );
	const recentGhostStoreKey = `racing-recent-ghosts:${ leaderboardTrackId }`;
	const leaderboardLegacyTrackIds = getLegacyTrackIds( mapParam, extrasParam );
	const leaderboardTrackName = getTrackLabel( mapParam );
	const leaderboardTrackApiUrl = `${ LEADERBOARD_API_BASE }?trackId=${ encodeURIComponent( leaderboardTrackId ) }`;

	const competitionParamEnabled = new URLSearchParams( window.location.search ).get( 'competition' ) === '1';
	const competitionReturnParam = new URLSearchParams( window.location.search ).get( 'competitionReturn' ) || '';
	const competitionTierParam = Number( new URLSearchParams( window.location.search ).get( 'competitionTier' ) );
	const competitionSeedParam = String( new URLSearchParams( window.location.search ).get( 'competitionSeed' ) || '' );
	const campaignParamEnabled = new URLSearchParams( window.location.search ).get( 'campaign' ) === '1';
	const campaignAuthorParam = Number( new URLSearchParams( window.location.search ).get( 'campaignAuthor' ) );
	const campaignGoalParam = new URLSearchParams( window.location.search ).get( 'campaignGoal' ) || '';
	campaignTrackName = new URLSearchParams( window.location.search ).get( 'campaignTrackName' ) || '';
	if ( campaignParamEnabled && campaignGoalParam === 'beat-authors' && Number.isFinite( campaignAuthorParam ) ) {

		campaignTargetAuthorSeconds = campaignAuthorParam;

	}

	function encodeBase64UrlJson( value ) {

		return btoa( unescape( encodeURIComponent( JSON.stringify( value ) ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

	}

	function decodeBase64UrlJson( value ) {

		const normalized = value.replace( /-/g, '+' ).replace( /_/g, '/' );
		const padLen = ( 4 - normalized.length % 4 ) % 4;
		const padded = normalized + '='.repeat( padLen );
		return JSON.parse( decodeURIComponent( escape( atob( padded ) ) ) );

	}

	function getCurrentProfileSnapshot() {

		// The in-game graphics/audio/FPS controls write DIRECTLY to the legacy
		// localStorage keys, bypassing GameSettings. Sync those live values back
		// into the unified settings before snapshotting so the cloud save (and
		// the settings page) always reflect what the player actually has right now.
		GameSettings.syncFromLegacy();
		return {
			v: 2,
			playerName: sanitizePlayerName( playerNameInput?.value || '' ),
			economy: { coins },
			garage: { mods: garageMods, unlocked: garageUnlocked, cosmetics: compactGarageCosmetics( garageCosmetics ) },
			campaign: campaignState,
			carKey: currentCarKey(),
			defaultCar: localStorage.getItem( DEFAULT_CAR_KEY ) || '__last',
			hud: window.__hudGrid ? window.__hudGrid.getLayoutSnapshot() : undefined,
			settings: GameSettings.getSettings(),
		};

	}

	function setAccountStatus( message, isError = false ) {

		if ( ! accountStatus ) return;
		accountStatus.textContent = message || '';
		accountStatus.style.color = isError ? '#ff9ea2' : '#bde6ff';

	}

	function updateAccountUi() {

		if ( accountUsernameInput && accountSession?.username ) accountUsernameInput.value = accountSession.username;
		setAccountStatus( accountSession?.token ? `Signed in as ${ accountSession.username }` : 'Not signed in' );
		if ( accountCloudSaveBtn ) accountCloudSaveBtn.disabled = ! accountSession?.token;
		if ( accountCloudLoadBtn ) accountCloudLoadBtn.disabled = ! accountSession?.token;

	}

	async function accountApiRequest( path, options = {} ) {

		const response = await fetch( `${ ACCOUNT_API_BASE }${ path }`, {
			headers: { 'Content-Type': 'application/json', ...( options.headers || {} ) },
			...options,
		} );
		const payload = await response.json().catch( () => ( {} ) );
		if ( ! response.ok || payload?.ok === false ) {

			throw new Error( payload?.error || `Account API HTTP ${ response.status }` );

		}
		return payload;

	}

	function createProfileExportCode() {

		return encodeBase64UrlJson( getCurrentProfileSnapshot() );

	}

	function applyImportedProfile( code ) {

		const parsed = decodeBase64UrlJson( code );
		if ( ! parsed || typeof parsed !== 'object' ) return false;
		if ( parsed?.playerName && playerNameInput ) {

			const importedName = sanitizePlayerName( parsed.playerName );
			playerNameInput.value = importedName;
			if ( namePopupInput ) namePopupInput.value = importedName;
			localStorage.setItem( PLAYER_NAME_KEY, importedName );

		}
		const nextCoins = Number( parsed?.economy?.coins );
		coins = Number.isFinite( nextCoins ) ? Math.max( 0, Math.floor( nextCoins ) ) : coins;
		garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
		garageUnlocked = { grip: true, accel: true, drive: true };
		garageCosmetics = normalizeGarageCosmetics( parsed?.garage?.cosmetics );
		if ( parsed?.campaign && typeof parsed.campaign === 'object' ) {

			const stage = Math.max( 1, Number( parsed.campaign.stage ) || 1 );
			const stageCfg = campaignStageConfig( stage );
			campaignState = {
				stage,
				stageType: stageCfg.type,
				goal: Number.isFinite( parsed.campaign.goal ) ? parsed.campaign.goal : stageCfg.goal,
				progress: Number.isFinite( parsed.campaign.progress ) ? Math.max( 0, parsed.campaign.progress ) : 0,
				completedRoadmaps: Number.isFinite( parsed.campaign.completedRoadmaps ) ? Math.max( 0, parsed.campaign.completedRoadmaps ) : 0,
			};

		}
		if ( typeof parsed?.carKey === 'string' && carSelect && CAR_STATS[ parsed.carKey ] ) {

			carSelect.value = parsed.carKey;
			updateCarSelectColor();
			if ( garageCarSelect ) garageCarSelect.value = parsed.carKey;
			if ( models[ parsed.carKey ] ) {

				vehicle.setModel( models[ parsed.carKey ] );
				applyCarCustomization( vehicle );

			}

		}
		// Default-car setting applies LAST so a specific default always wins
		// over the profile's last-used carKey. A LOCAL pick beats the cloud
		// copy — the cloud value only lands on machines with no local
		// preference yet (otherwise a stale cloud profile would resurrect a
		// setting the user changed on this machine).
		{

			const localDefault = localStorage.getItem( DEFAULT_CAR_KEY );
			const cloudDefault = typeof parsed?.defaultCar === 'string' ? parsed.defaultCar : null;
			const nextDefault = localDefault || cloudDefault || '__last';
			localStorage.setItem( DEFAULT_CAR_KEY, nextDefault );
			const defaultSelect = document.getElementById( 'default-car-select' );
			if ( defaultSelect ) defaultSelect.value = nextDefault;
			if ( nextDefault !== '__last' ) applyDefaultCar( nextDefault );

		}
		saveEconomy();
		saveGarageMods();
		saveCampaignState();
		applyVehiclePerformance();
		updateEconomyHud();
		updateGarageUi();
		applyCarCustomization( vehicle );
		updateCampaignUi();
		if ( parsed?.hud && window.__hudGrid ) window.__hudGrid.applyLayoutSnapshot( parsed.hud );
		if ( parsed?.settings ) {
			GameSettings.saveSettings( parsed.settings );
			applyLiveGameSettings( GameSettings.getSettings() );
		}
		return true;

	}

	function createAccountExportCode() {

		return encodeBase64UrlJson( {
			v: 1,
			session: accountSession ? { username: accountSession.username, token: accountSession.token } : null,
			profile: getCurrentProfileSnapshot(),
		} );

	}

	function applyImportedAccountCode( code ) {

		const parsed = decodeBase64UrlJson( code );
		if ( ! parsed || typeof parsed !== 'object' ) return false;
		if ( parsed?.profile ) {

			applyImportedProfile( encodeBase64UrlJson( parsed.profile ) );

		}
		if ( parsed?.session?.token && parsed?.session?.username ) {

			accountSession = {
				username: String( parsed.session.username ),
				token: String( parsed.session.token ),
			};
			localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );

		}
		updateAccountUi();
		return true;

	}

	function makeGateData( cell ) {

		if ( ! cell ) return null;

		const [ gx, gz, , orient ] = cell;
		const centerX = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
		const centerZ = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;
		const halfExtent = ( CELL_RAW * GRID_SCALE ) * 0.5;
		const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
		const cosA = Math.cos( angle );
		const sinA = Math.sin( angle );
		return { centerX, centerZ, halfExtent, angle, cosA, sinA };

	}

	const finishData = makeGateData( finishCell );
	const startGateData = makeGateData( startCell || finishCell );
	const checkpointStates = checkpointCells.map( ( cell ) => ( {
		...makeGateData( cell ),
		lastLocalX: 0,
		lastLocalZ: 0,
		hasPrevSample: false,
		passedThisLap: false,
	} ) );

	let lapNumber = 1;
	let lapStartSeconds = 0;
	let lapSeconds = 0;
	let lastLapSeconds = null;
	let bestLapSeconds = null;
	let checkpointDeltaText = '';
	let lastSyncedOnlineBestLapSeconds = null;
	// Pending auto-respawn as a GAME-CLOCK timestamp (not a real-time setTimeout):
	// at 20 FPS a 500ms real timer fires at a random point in a long frame —
	// or never fires at all if the lap bookkeeping threw before arming it.
	// The frame loop fires it the moment the game clock passes the timestamp.
	let autoRespawnAtSeconds = null;
	let hasPrevFinishSample = false;
	let lastLocalX = 0;
	let lastLocalZ = 0;
	let hasLeftStartZone = false;
	let boostActiveUntil = 0;
	let boostContactCell = null;
	let arcLinkState = { contactKey: null, lockUntilExit: false };
	const specialSurfaceContactState = new Map();
	const boostCells = Array.isArray( extras?.boosts ) ? extras.boosts : [];
	const surfaceCells = Array.isArray( extras?.surfaces ) ? extras.surfaces : [];
	const customSurfaceConfigs = extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {};
	const customPadConfigs = extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {};
	const surfaceCellMap = new Map();
	for ( const [ gx, gz, type ] of surfaceCells ) {

		const key = `${ gx },${ gz }`;
		const list = surfaceCellMap.get( key ) || [];
		list.push( type );
		surfaceCellMap.set( key, list );

	}
	const surfaceHalfExtent = CELL_RAW * GRID_SCALE * 0.39;
	const cellWorldSize = CELL_RAW * GRID_SCALE;
	const cellHalfExtent = cellWorldSize * 0.5;
	const slopeCellMap = new Map();
	const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };
	for ( const [ gx, gz, rawType, rawOrient = 0 ] of slopeElevatedCells ) {

		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) continue;
		let type = rawType;
		let orient = rawOrient;
		if ( type === 'slope-down' ) {

			type = 'slope-up';
			orient = ORIENT_180[ orient ] ?? orient;

		}
		// OFF-GRID support: a piece at fractional coords (editor free placement)
		// spans two cells per axis. Register every cell it touches, not just its
		// raw key — a fractional key like "12.5,3.7" can never match the integer
		// cell lookups used at runtime.
		const cellKeys = ( v ) => Number.isInteger( Number( v ) )
			? [ Number( v ) ]
			: [ Math.floor( Number( v ) ), Math.floor( Number( v ) ) + 1 ];
		for ( const cgx of cellKeys( gx ) ) {
			for ( const cgz of cellKeys( gz ) ) {
				slopeCellMap.set( `${ cgx },${ cgz }`, { gx, gz, type, orient } );
			}
		}

	}
	// Pool slopes are real tilted colliders too (they are NOT in extras.elevated),
	// so register their cells as well.
	if ( Array.isArray( extras?.poolSlopes ) ) {
		for ( const entry of extras.poolSlopes ) {
			const gx = Number( entry?.[ 0 ] ), gz = Number( entry?.[ 1 ] );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const cellKeys = ( v ) => Number.isInteger( v ) ? [ v ] : [ Math.floor( v ), Math.floor( v ) + 1 ];
			for ( const cgx of cellKeys( gx ) ) {
				for ( const cgz of cellKeys( gz ) ) {
					if ( ! slopeCellMap.has( `${ cgx },${ cgz }` ) ) {
						slopeCellMap.set( `${ cgx },${ cgz }`, { gx, gz, type: 'pool-slope', orient: entry?.[ 2 ] ?? 0 } );
					}
				}
			}
		}
	}
	// True when the vehicle is on a genuinely sloped surface. Two signals, OR'd:
	//  1. The grid map (slope pieces incl. off-grid fractional spans + pool slopes)
	//  2. The vehicle's MEASURED ground tilt from the raycast slope detection —
	//     physical truth, catches any angled collider regardless of registration.
	// Used to bypass seam-bounce suppression on slopes: uphill driving
	// legitimately gains upward velocity, and the restore would otherwise freeze
	// the car (the "no gravity / can't move / slides on the hitbox" glitch that
	// hit off-grid slope blocks whose registry key never matched).
	const SEAM_BYPASS_TILT = 0.1; // rad ≈ 5.7° — below real slopes (≈26°), above noise/bevels (≈2°)
	function isVehicleOnSlopeCell( targetVehicle ) {

		if ( ! targetVehicle?.spherePos ) return false;
		if ( ( targetVehicle.lastGroundTilt || 0 ) > SEAM_BYPASS_TILT ) return true;
		if ( slopeCellMap.size === 0 ) return false;
		const gx = Math.floor( targetVehicle.spherePos.x / cellWorldSize );
		const gz = Math.floor( targetVehicle.spherePos.z / cellWorldSize );
		return slopeCellMap.has( `${ gx },${ gz }` );

	}
	const legacyBoostHalfExtent = CELL_RAW * GRID_SCALE * 0.5;
	const surfaceEntries = surfaceCells.map( ( [ gx, gz, type ] ) => ( {
		gx, gz, type,
		centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
		centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
	} ) );
	const padEntries = surfaceEntries.filter( ( entry ) => entry.type === PAD_RESET_TYPE || PAD_EFFECTS[ entry.type ] || CUSTOM_PAD_TYPES.includes( entry.type ) );
	// Cell-keyed lookups (gx,gz -> entry) so the per-frame surface/pad/boost contact
	// scans are O(1) over a 3x3 neighbourhood instead of scanning the full surface list.
	// Any surface the vehicle can overlap (halfExtent + vehicle radius < one cell) lies
	// within the 3x3 block around its current cell, so this is behaviour-identical to
	// the previous full-array scan.
	const surfaceEntryByCell = new Map();
	const padEntryByCell = new Map();
	const boostSurfaceEntryByCell = new Map();
	const CELL_UNIT = CELL_RAW * GRID_SCALE;
	for ( const entry of surfaceEntries ) {

		const key = entry.gx + ',' + entry.gz;
		surfaceEntryByCell.set( key, entry );
		if ( entry.type === PAD_RESET_TYPE || PAD_EFFECTS[ entry.type ] || CUSTOM_PAD_TYPES.includes( entry.type ) ) padEntryByCell.set( key, entry );
		if ( entry.type === 'surface-boost' ) boostSurfaceEntryByCell.set( key, entry );

	}

	const legacyBoostEntries = boostCells.map( ( [ gx, gz ] ) => ( {
		gx, gz,
		centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
		centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
	} ) );
	const legacyBoostEntryByCell = new Map( legacyBoostEntries.map( ( entry ) => [ entry.gx + ',' + entry.gz, entry ] ) );
	const magnetCells = Array.isArray( extras?.magnets ) ? extras.magnets : [];
	const arcLinkCells = Array.isArray( extras?.arcLinks ) ? extras.arcLinks : [];
	const magnetFullStrengthDistance = CELL_RAW * GRID_SCALE * MAGNET_FULL_STRENGTH_BLOCKS;
	const magnetEntries = magnetCells
		.map( ( [ gxRaw, gzRaw, yGridRaw, variant, forceRaw, rangeRaw ] ) => {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return null;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const kindRaw = String( variant );
			const kind = kindRaw === 'red' ? 'red' : ( kindRaw === 'grapple' ? 'grapple' : 'blue' );
			const forcePerSecond = THREE.MathUtils.clamp( Number( forceRaw ) || MAGNET_DEFAULT_FORCE_PER_SECOND, MAGNET_MIN_FORCE_PER_SECOND, MAGNET_MAX_FORCE_PER_SECOND );
			const maxDistanceBlocks = THREE.MathUtils.clamp( Number( rangeRaw ) || MAGNET_DEFAULT_MAX_DISTANCE_BLOCKS, MAGNET_MIN_MAX_DISTANCE_BLOCKS, MAGNET_MAX_MAX_DISTANCE_BLOCKS );
			const maxDistance = CELL_RAW * GRID_SCALE * maxDistanceBlocks;
			return {
				gx, gz, yGrid, kind, forcePerSecond, maxDistance,
				centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
				centerY: ( CELL_RAW * GRID_SCALE * 0.08 ) - 0.06 + yGrid * CELL_RAW * GRID_SCALE,
				centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
			};

		} )
		.filter( Boolean );

	const grappleEntries = magnetEntries.filter( ( entry ) => entry.kind === 'grapple' );
	const grappleState = {
		active: false,
		anchor: null,
		ropeLength: 0,
		line: null,
	};
	const arcLinkEntries = arcLinkCells
		.map( ( [ gxRaw, gzRaw, yGridRaw, variantRaw, idRaw ] ) => {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return null;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const variant = String( variantRaw );
			const color = variant === 'portal-purple' || variant === 'purple'
				? 'portal-purple'
				: ( variant === 'portal-yellow' || variant === 'yellow'
					? 'portal-yellow'
					: ( variant === 'orange' ? 'orange' : 'green' ) );
			const linkId = THREE.MathUtils.clamp( Math.round( Number( idRaw ) || 1 ), 1, 999 );
			return {
				gx, gz, yGrid, color, linkId,
				centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
				centerY: ( CELL_RAW * GRID_SCALE * 0.08 ) - 0.06 + yGrid * CELL_RAW * GRID_SCALE,
				centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
			};

		} )
		.filter( Boolean );
	const arcEntriesById = new Map();
	for ( const entry of arcLinkEntries ) {

		const bucket = arcEntriesById.get( entry.linkId ) || [];
		bucket.push( entry );
		arcEntriesById.set( entry.linkId, bucket );

	}
	if ( arcLinkEntries.length > 0 ) setArcLinkHud( `Arc Link: ready (${ arcEntriesById.size } id${ arcEntriesById.size === 1 ? '' : 's' })` );
	else setArcLinkHud( null );
	let activeSurfaceType = null;
	let activeSurfaceType2 = null;
	let lastSurfaceNotifyType = null;
	let lastSurfaceNotifyType2 = null;
	let lapNumber2 = 1;
	let lapStartSeconds2 = 0;
	let lapSeconds2 = 0;
	let lastLapSeconds2 = null;
	let bestLapSeconds2 = null;
	let autoRespawnAtSeconds2 = null;
	let hasPrevFinishSample2 = false;
	let lastLocalX2 = 0;
	let lastLocalZ2 = 0;
	let hasLeftStartZone2 = false;
	let boostActiveUntil2 = 0;
	let boostContactCell2 = null;
	let arcLinkState2 = { contactKey: null, lockUntilExit: false };
	let lastBoostNotifyKey = null;
	let lastBoostNotifyKey2 = null;
	const specialSurfaceContactState2 = new Map();
	let activePadEffect = null;
	let activePadEffect2 = null;
	let activePadTimeScale = 1;
	let activePadTimeScale2 = 1;
	let padContactKey = null;
	let padContactKey2 = null;
	const airTrickState = { active: false, progress: 0, lastSmoothT: 0, pitchTotal: 0, yawTotal: 0, rollTotal: 0, baseYaw: 0, recovering: false, recoveryT: 0, recoveryDuration: 0.42, recoveryStartQuat: new THREE.Quaternion(), recoveryTargetQuat: new THREE.Quaternion() };
	const airTrickState2 = { active: false, progress: 0, lastSmoothT: 0, pitchTotal: 0, yawTotal: 0, rollTotal: 0, baseYaw: 0, recovering: false, recoveryT: 0, recoveryDuration: 0.42, recoveryStartQuat: new THREE.Quaternion(), recoveryTargetQuat: new THREE.Quaternion() };
	const camYawLockQuat = new THREE.Quaternion();
	const camYawLockQuat2 = new THREE.Quaternion();
	const camYawLockEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
	const camYawLockEuler2 = new THREE.Euler( 0, 0, 0, 'YXZ' );
	let camYawLockActive = false;
	let camYawLockActive2 = false;
	let camYawLockValue = 0;
	let camYawLockValue2 = 0;
	const checkpointStates2 = checkpointCells.map( ( cell ) => ( {
		...makeGateData( cell ),
		lastLocalX: 0,
		lastLocalZ: 0,
		hasPrevSample: false,
		passedThisLap: false,
	} ) );
	const INTENSITY_SCALE = { low: 0.6, medium: 1.0, high: 1.45 };
	const WEATHER_FX_DENSITY_MULTIPLIER = 3;
	const WIND_SPEED = { none: 0, breezy: 2.0, gusty: 4.5 };
	let weatherFx = null;
	let lightningCooldown = THREE.MathUtils.randFloat( 2.2, 6.2 );
	let lightningFlashTime = 0;
	let lightningFlashDuration = 0.12;
	let lightningFlashStrength = 0;

	function clearWeatherFx() {

		if ( ! weatherFx ) return;
		if ( weatherFx.points ) scene.remove( weatherFx.points );
		weatherFx = null;

	}

	function setupWeatherFx( centerX = 0, centerZ = 0 ) {

		clearWeatherFx();
		const precip = weatherSettings.precipitation;
		if ( precip === 'none' ) return;
		const particleScale = getGraphicsPreset().weatherParticleScale;
		if ( particleScale <= 0 ) return;
		const count = Math.round( ( precip === 'rain' ? 940 : 380 ) * WEATHER_FX_DENSITY_MULTIPLIER * ( INTENSITY_SCALE[ weatherSettings.intensity ] || 1 ) * particleScale );
		const positions = new Float32Array( count * 3 );
		const speeds = new Float32Array( count );
		const spread = 65;
		for ( let i = 0; i < count; i ++ ) {

			const index = i * 3;
			positions[ index ] = centerX + THREE.MathUtils.randFloatSpread( spread );
			positions[ index + 1 ] = THREE.MathUtils.randFloat( 3, 30 );
			positions[ index + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( spread );
			speeds[ i ] = precip === 'rain'
				? THREE.MathUtils.randFloat( 18, 32 )
				: THREE.MathUtils.randFloat( 2.2, 5.1 );

		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		const material = new THREE.PointsMaterial( {
			color: precip === 'rain' ? 0x77b8ff : 0xffffff,
			size: precip === 'rain' ? 0.06 : 0.13,
			transparent: true,
			opacity: precip === 'rain' ? 0.5 : 0.75,
			depthWrite: false,
		} );
		weatherFx = {
			kind: precip,
			points: new THREE.Points( geometry, material ),
			positions,
			speeds,
			count,
		};
		scene.add( weatherFx.points );

	}

	function updateWeatherFx( dt, now = timer.getElapsed() ) {

		const wind = WIND_SPEED[ weatherSettings.wind ] || 0;
		const centerX = vehicle.spherePos.x;
		const centerZ = vehicle.spherePos.z;
		if ( weatherFx?.positions ) {

			const positions = weatherFx.positions;
			const sway = weatherFx.kind === 'snow' ? 0.6 : 0.15;
			for ( let i = 0; i < weatherFx.count; i ++ ) {

				const p = i * 3;
				const fallSpeed = weatherFx.speeds[ i ];
				positions[ p + 1 ] -= fallSpeed * dt;
				positions[ p ] += ( wind + Math.sin( now * 0.8 + i ) * sway ) * dt;
				if ( positions[ p + 1 ] < 0.2 ) {

					positions[ p ] = centerX + THREE.MathUtils.randFloatSpread( 65 );
					positions[ p + 1 ] = THREE.MathUtils.randFloat( 16, 34 );
					positions[ p + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( 65 );

				} else if ( Math.abs( positions[ p ] - centerX ) > 55 || Math.abs( positions[ p + 2 ] - centerZ ) > 55 ) {

					positions[ p ] = centerX + THREE.MathUtils.randFloatSpread( 52 );
					positions[ p + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( 52 );

				}

			}
			weatherFx.points.geometry.attributes.position.needsUpdate = true;

		}

		if ( weatherSettings.lightning && cachedGraphicsPreset.weatherParticleScale > 0 ) {

			if ( lightningFlashTime > 0 ) {

				lightningFlashTime = Math.max( 0, lightningFlashTime - dt );
				const pulse = lightningFlashTime / Math.max( 1e-4, lightningFlashDuration );
				dirLight.intensity = baseWeatherLight.sun + lightningFlashStrength * pulse;
				hemiLight.intensity = baseWeatherLight.hemi + lightningFlashStrength * 0.22 * pulse;
				renderer.toneMappingExposure = baseWeatherLight.exposure + lightningFlashStrength * 0.08 * pulse;

			} else {

				lightningCooldown -= dt;
				dirLight.intensity = baseWeatherLight.sun;
				hemiLight.intensity = baseWeatherLight.hemi;
				renderer.toneMappingExposure = baseWeatherLight.exposure;
				if ( lightningCooldown <= 0 ) {

					lightningFlashDuration = THREE.MathUtils.randFloat( 0.07, 0.2 );
					lightningFlashTime = lightningFlashDuration;
					lightningFlashStrength = THREE.MathUtils.randFloat( 3.6, 7.2 );
					lightningCooldown = THREE.MathUtils.randFloat( 2.6, 8.5 );

				}

			}

		} else {

			dirLight.intensity = baseWeatherLight.sun;
			hemiLight.intensity = baseWeatherLight.hemi;
			renderer.toneMappingExposure = baseWeatherLight.exposure;

		}

	}

	setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
	updateGraphicsQualityUi();

	function overlapsSurfaceEntry( targetVehicle, entry, halfExtent = surfaceHalfExtent ) {

		const dx = Math.abs( targetVehicle.spherePos.x - entry.centerX );
		const dz = Math.abs( targetVehicle.spherePos.z - entry.centerZ );
		return dx <= halfExtent + VEHICLE_SURFACE_RADIUS && dz <= halfExtent + VEHICLE_SURFACE_RADIUS;

	}

	// --- Dynamic slope detection: REAL raycast ground sampling --------------
	// Replaces the legacy grid-cell slope lookup (applySlopeConformVisual):
	// four downward physics rays at the chassis frame sample the actual
	// hitbox surface every frame, so the car conforms to ANY angled collider —
	// slope pieces, pool slopes, banks, custom geometry — at its TRUE angle,
	// not a hardcoded 26.57° constant. Ray pairs (front/back, left/right) are
	// only trusted when both hits land on the SAME collider body, so a sample
	// point that slips inside a wall while hugging it can never fake a slope.
	const slopeRayCollector = createAnyCastRayCollector();
	const slopeRaySettings = createDefaultCastRaySettings();
	const slopeRayFilter = ccLayerFilter.forWorld( world );
	slopeRayFilter.bodyFilter = ( body ) => body && body.motionType === MotionType.STATIC;
	const SLOPE_RAY_REACH = 1.6;              // max ground depth below chassis center
	const SLOPE_SAMPLE_HALF_LENGTH = 1.1;     // front/back sample offsets
	const SLOPE_SAMPLE_HALF_WIDTH = 0.65;      // left/right sample offsets
	const _slopeFwd = new THREE.Vector3();
	const _slopeSide = new THREE.Vector3();
	const _slopeRayOrigin = [ 0, 0, 0 ];
	const _slopeRayDown = [ 0, - 1, 0 ];
	function sampleGroundDepth( x, y, z ) {

		_slopeRayOrigin[ 0 ] = x;
		_slopeRayOrigin[ 1 ] = y;
		_slopeRayOrigin[ 2 ] = z;
		// AnyCastRayCollector.addMiss() is a no-op — stale hits linger, so reset() before every cast.
		slopeRayCollector.reset();
		castRay( world, slopeRayCollector, slopeRaySettings, _slopeRayOrigin, _slopeRayDown, SLOPE_RAY_REACH, slopeRayFilter );
		if ( slopeRayCollector.hit.status !== CastRayStatus.COLLIDING ) return null;
		return { depth: slopeRayCollector.hit.fraction * SLOPE_RAY_REACH, bodyId: slopeRayCollector.hit.bodyIdB };

	}

	function applyRaycastSlopeVisual( targetVehicle ) {

		if ( ! targetVehicle?.container ) return;
		_slopeFwd.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_slopeFwd.y = 0;
		if ( _slopeFwd.lengthSq() < 1e-6 ) _slopeFwd.set( 0, 0, 1 );
		_slopeFwd.normalize();
		_slopeSide.set( 1, 0, 0 ).applyQuaternion( targetVehicle.container.quaternion );
		_slopeSide.y = 0;
		if ( _slopeSide.lengthSq() < 1e-6 ) _slopeSide.set( 1, 0, 0 );
		_slopeSide.normalize();
		const px = targetVehicle.spherePos.x;
		const py = targetVehicle.spherePos.y;
		const pz = targetVehicle.spherePos.z;
		const L = SLOPE_SAMPLE_HALF_LENGTH;
		const W = SLOPE_SAMPLE_HALF_WIDTH;
		const forward = sampleGroundDepth( px + _slopeFwd.x * L, py, pz + _slopeFwd.z * L );
		const backward = sampleGroundDepth( px - _slopeFwd.x * L, py, pz - _slopeFwd.z * L );
		const right = sampleGroundDepth( px + _slopeSide.x * W, py, pz + _slopeSide.z * W );
		const left = sampleGroundDepth( px - _slopeSide.x * W, py, pz - _slopeSide.z * W );
		// Pair consistency: only use a pair whose two hits agree on the body.
		const samples = {
			forward: forward && backward && forward.bodyId === backward.bodyId ? forward.depth : null,
			backward: forward && backward && forward.bodyId === backward.bodyId ? backward.depth : null,
			left: left && right && left.bodyId === right.bodyId ? left.depth : null,
			right: left && right && left.bodyId === right.bodyId ? right.depth : null,
		};
		const tilt = Vehicle.computeSlopeTiltFromSamples( samples, L, W );
		targetVehicle.setSlopeVisualTilt( tilt.pitch, tilt.roll );
		// Physical slope signal for the seam-bounce guard (isVehicleOnSlopeCell):
		// the measured surface angle, 0 while airborne. Survives across frames.
		targetVehicle.lastGroundTilt = Math.hypot( tilt.pitch, tilt.roll );

	}

	function overlapsPadEntry( targetVehicle, entry ) {

		const dx = targetVehicle.spherePos.x - entry.centerX;
		const dz = targetVehicle.spherePos.z - entry.centerZ;
		const padRadius = surfaceHalfExtent;
		const radius = padRadius + VEHICLE_SURFACE_RADIUS;
		return dx * dx + dz * dz <= radius * radius;

	}

	// Collect surface entries overlapping a vehicle's 3x3 cell neighbourhood into the
	// provided bucket. Returns false if none found, else true (bucket filled).
	function collectNearbyEntries( targetVehicle, byCellMap, bucket ) {

		const cx = Math.floor( targetVehicle.spherePos.x / CELL_UNIT );
		const cz = Math.floor( targetVehicle.spherePos.z / CELL_UNIT );
		bucket.length = 0;
		for ( let dz = - 1; dz <= 1; dz ++ ) {
			for ( let dx = - 1; dx <= 1; dx ++ ) {
				const entry = byCellMap.get( ( cx + dx ) + ',' + ( cz + dz ) );
				if ( entry ) bucket.push( entry );
			}
		}
		return bucket.length > 0;

	}

	const _surfaceNeighbourhood = [];
	function findActiveSurfaceTypeFor( targetVehicle ) {

		if ( ! collectNearbyEntries( targetVehicle, surfaceEntryByCell, _surfaceNeighbourhood ) ) return null;
		for ( let i = _surfaceNeighbourhood.length - 1; i >= 0; i -- ) {

			if ( overlapsSurfaceEntry( targetVehicle, _surfaceNeighbourhood[ i ] ) ) return _surfaceNeighbourhood[ i ].type;

		}

		return null;

	}

	const _boostSurfaceNeighbourhood = [];
	function findBoostSurfaceContactKeyFor( targetVehicle ) {

		if ( ! collectNearbyEntries( targetVehicle, boostSurfaceEntryByCell, _boostSurfaceNeighbourhood ) ) return null;
		for ( let i = _boostSurfaceNeighbourhood.length - 1; i >= 0; i -- ) {

			const entry = _boostSurfaceNeighbourhood[ i ];
			if ( overlapsSurfaceEntry( targetVehicle, entry ) ) return `surface:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	function findSurfaceContactKeyForType( targetVehicle, surfaceType ) {

		if ( ! collectNearbyEntries( targetVehicle, surfaceEntryByCell, _surfaceNeighbourhood ) ) return null;
		for ( let i = _surfaceNeighbourhood.length - 1; i >= 0; i -- ) {

			const entry = _surfaceNeighbourhood[ i ];
			if ( entry.type === surfaceType && overlapsSurfaceEntry( targetVehicle, entry ) ) return `surface:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	const _legacyBoostNeighbourhood = [];
	function findLegacyBoostContactKeyFor( targetVehicle ) {

		if ( ! collectNearbyEntries( targetVehicle, legacyBoostEntryByCell, _legacyBoostNeighbourhood ) ) return null;
		for ( let i = _legacyBoostNeighbourhood.length - 1; i >= 0; i -- ) {

			const entry = _legacyBoostNeighbourhood[ i ];
			if ( overlapsSurfaceEntry( targetVehicle, entry, legacyBoostHalfExtent ) ) return `boost:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	const _padNeighbourhood = [];
	function findPadContactFor( targetVehicle ) {

		if ( ! collectNearbyEntries( targetVehicle, padEntryByCell, _padNeighbourhood ) ) return null;
		for ( let i = _padNeighbourhood.length - 1; i >= 0; i -- ) {

			const entry = _padNeighbourhood[ i ];
			if ( overlapsPadEntry( targetVehicle, entry ) ) {

				return {
					key: `pad:${ entry.gx },${ entry.gz },${ entry.type }`,
					type: entry.type,
				};

			}

		}
		return null;

	}

	function getPadLabel( padType ) {

		switch ( padType ) {

			case PAD_RESET_TYPE: return 'Pad Reset';
			case 'pad-low-gravity': return 'Low Gravity';
			case 'pad-heavy-gravity': return 'Heavy Gravity';
			case 'pad-high-grip': return 'High Grip';
			case 'pad-high-speed': return 'High Speed';
			case 'pad-no-brakes': return 'No Brakes';
			case 'pad-no-steering': return 'No Steering';
			case 'pad-no-acceleration': return 'No Acceleration';
			case 'pad-slow-motion': return 'Slow Motion';
			case 'pad-fast-motion': return 'Fast Motion';
			case 'pad-drift': return 'Drift Mode';
			case 'pad-size-small': return 'Mini Pad';
			case 'pad-size-normal': return 'Normal Pad';
			case 'pad-size-mega': return 'Mega Pad';
			case 'pad-trick-yaw-1': return 'Yaw Flip ×1';
			case 'pad-trick-pitch-1': return 'Pitch Flip ×1';
			case 'pad-trick-roll-1': return 'Roll Flip ×1';
			case 'pad-trick-yaw-pitch-1': return 'Yaw+Pitch ×1';
			case 'pad-trick-yaw-roll-1': return 'Yaw+Roll ×1';
			case 'pad-trick-pitch-roll-1': return 'Pitch+Roll ×1';
			case 'pad-trick-yaw-pitch-roll-1': return 'Yaw+Pitch+Roll ×1';
			case 'pad-trick-yaw-roll-pitch': return 'Yaw+Roll+Pitch';
			case 'pad-trick-pitch-yaw-roll': return 'Pitch+Yaw+Roll';
			case 'pad-custom-a': return 'Custom Pad A';
			case 'pad-custom-b': return 'Custom Pad B';
			case 'pad-custom-c': return 'Custom Pad C';
			default: return 'Pad';

		}

	}

	function showEffectPopup( text ) {

		if ( ! effectMessage ) {

			showTopMessage( text, false, 1000 );
			return;

		}
		effectMessage.textContent = String( text || '' ).trim();
		effectMessage.classList.add( 'show' );
		if ( effectMessageTimeout ) clearTimeout( effectMessageTimeout );
		effectMessageTimeout = setTimeout( () => {

			effectMessage.classList.remove( 'show' );

		}, 1000 );

	}

	function getCustomPadEffect( padType ) {

		const conf = customPadConfigs?.[ padType ];
		if ( ! conf ) return null;
		return {
			id: padType,
			gravity: Number.isFinite( Number( conf.gravity ) ) ? THREE.MathUtils.clamp( Number( conf.gravity ), 0.15, 3 ) : undefined,
			grip: Number.isFinite( Number( conf.grip ) ) ? THREE.MathUtils.clamp( Number( conf.grip ), 0.05, 5 ) : undefined,
			drag: Number.isFinite( Number( conf.drag ) ) ? THREE.MathUtils.clamp( Number( conf.drag ), 0.05, 5 ) : undefined,
			accel: Number.isFinite( Number( conf.accel ) ) ? THREE.MathUtils.clamp( Number( conf.accel ), 0, 5 ) : undefined,
			drive: Number.isFinite( Number( conf.drive ) ) ? THREE.MathUtils.clamp( Number( conf.drive ), 0, 5 ) : undefined,
			topSpeed: Number.isFinite( Number( conf.topSpeed ) ) ? THREE.MathUtils.clamp( Number( conf.topSpeed ), 0, 3 ) : undefined,
			steering: Number.isFinite( Number( conf.steering ) ) ? THREE.MathUtils.clamp( Number( conf.steering ), 0, 3 ) : undefined,
			timeScale: Number.isFinite( Number( conf.timeScale ) ) ? THREE.MathUtils.clamp( Number( conf.timeScale ), 0.15, 3 ) : undefined,
			disableBrakes: Boolean( conf.disableBrakes ),
			disableSteering: Boolean( conf.disableSteering ),
			disableAcceleration: Boolean( conf.disableAcceleration ),
		};

	}

	function getPadEffectForType( padType ) {

		return getCustomPadEffect( padType ) || PAD_EFFECTS[ padType ] || null;

	}

	function combinePadEffects( current, incoming ) {

		if ( ! current ) return incoming ? { ...incoming } : null;
		if ( ! incoming ) return { ...current };
		const combined = { ...current, ...incoming };
		const multiplicativeKeys = [ 'gravity', 'grip', 'drag', 'accel', 'drive', 'topSpeed', 'steering', 'timeScale', 'scale' ];
		for ( const key of multiplicativeKeys ) {

			const a = Number( current[ key ] );
			const b = Number( incoming[ key ] );
			if ( Number.isFinite( a ) && Number.isFinite( b ) ) combined[ key ] = a * b;
			else if ( Number.isFinite( b ) ) combined[ key ] = b;
			else if ( Number.isFinite( a ) ) combined[ key ] = a;

		}
		combined.disableBrakes = Boolean( current.disableBrakes || incoming.disableBrakes );
		combined.disableSteering = Boolean( current.disableSteering || incoming.disableSteering );
		combined.disableAcceleration = Boolean( current.disableAcceleration || incoming.disableAcceleration );
		if ( incoming.trick ) combined.trick = incoming.trick;
		return combined;

	}


	function applySizePadEffect( current, incoming ) {

		const base = current ? { ...current } : {};
		delete base.scale;
		delete base.__sizePadType;
		const next = incoming ? { ...base, ...incoming } : base;
		next.__sizePadType = incoming?.id || null;
		return Object.keys( next ).length ? next : null;

	}

	function applyPadContact( targetVehicle, lastContactKey, setEffect, getCurrentEffect = null ) {

		const contact = findPadContactFor( targetVehicle );
		if ( ! contact ) return null;
		if ( contact.key === lastContactKey ) return lastContactKey;
		if ( contact.type === PAD_RESET_TYPE ) {

			setEffect( null );
			showEffectPopup( 'Effect applied: Reset to default' );
			return contact.key;

		}
		const effect = getPadEffectForType( contact.type );
		const previous = getCurrentEffect ? ( getCurrentEffect() || null ) : null;
		if ( SIZE_PAD_TYPES.has( contact.type ) ) setEffect( applySizePadEffect( previous, effect ) );
		else setEffect( combinePadEffects( previous, effect ) );
		showEffectPopup( `Effect applied: ${ getPadLabel( contact.type ) }` );
		return contact.key;

	}


	function applyVehicleScaleFromPad( targetVehicle, effect, targetHitboxMesh = null ) {

		if ( ! targetVehicle?.container ) return;
		// No pad effect active: settle at the mod-set scale (default 1) instead of
		// hard-resetting to 1, which stomped the custom-mod "set car scale" block.
		const modBase = THREE.MathUtils.clamp( targetVehicle.__modScale ?? 1, 0.25, 3 );
		const nextScale = Number.isFinite( effect?.scale ) ? THREE.MathUtils.clamp( effect.scale, 0.35, 2.5 ) : modBase;
		const prevScale = Number.isFinite( targetVehicle.__padScale ) ? targetVehicle.__padScale : 1;
		targetVehicle.container.scale.setScalar( nextScale );
		targetVehicle.__padScale = nextScale;
		if ( targetHitboxMesh ) targetHitboxMesh.scale.setScalar( nextScale );
		if ( nextScale > prevScale && nextScale > 1.01 && targetVehicle?.spherePos && targetVehicle?.rigidBody ) {

			const lift = 0.24 * ( nextScale - prevScale );
			targetVehicle.spherePos.y += lift;
			rigidBody.setPosition( targetVehicle.physicsWorld, targetVehicle.rigidBody, targetVehicle.spherePos.toArray(), false );

		}

	}

	function applyPadInputModifiers( baseInput, effect ) {

		if ( ! baseInput ) return baseInput;
		const input = { ...baseInput };
		if ( effect?.disableSteering ) input.x = 0;
		if ( effect?.disableBrakes && input.z < 0 ) input.z = 0;
		if ( effect?.disableAcceleration && input.z > 0 ) input.z = 0;
		if ( Number.isFinite( effect?.steering ) ) input.x *= effect.steering;
		return input;

	}

	function updateAirTrickStateFor( targetVehicle, activePadEffect, state, dt, onTrickFinished = null ) {

		if ( ! targetVehicle || ! state ) return;
		const trick = activePadEffect?.trick || null;
		const hasTrickPayload = Boolean( trick );
		const verticalVel = targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] || 0;
		const airborne = ! isVehicleTouchingGroundBelow( targetVehicle ) || Math.abs( verticalVel ) > 0.25;
		const canRun = state.active ? hasTrickPayload : ( hasTrickPayload && airborne );
		if ( ! canRun ) {

			const interrupted = state.active && state.progress > 0 && state.progress < 1;
			if ( interrupted ) {

				state.recovering = true;
				state.recoveryT = 0;
				state.recoveryStartQuat.copy( targetVehicle.container.quaternion );
				const euler = new THREE.Euler().setFromQuaternion( targetVehicle.container.quaternion, 'YXZ' );
				euler.x = 0;
				euler.z = 0;
				state.recoveryTargetQuat.setFromEuler( euler );

			}
			state.active = false;
			state.progress = 0;
			state.lastSmoothT = 0;
			if ( interrupted && onTrickFinished ) onTrickFinished();
			if ( state.recovering ) {

				state.recoveryT = Math.min( 1, state.recoveryT + dt / state.recoveryDuration );
				const t = state.recoveryT * state.recoveryT * ( 3 - 2 * state.recoveryT );
				targetVehicle.container.quaternion.copy( state.recoveryStartQuat ).slerp( state.recoveryTargetQuat, t );
				targetVehicle.container.updateMatrixWorld( true );
				if ( state.recoveryT >= 1 ) state.recovering = false;

			}
			return;

		}

		if ( ! state.active ) {
			state.active = true;
			state.recovering = false;
			state.recoveryT = 0;
			state.progress = 0;
			state.lastSmoothT = 0;
			const phase = trick || {};
			const qEuler = new THREE.Euler().setFromQuaternion( targetVehicle.container.quaternion, 'YXZ' );
			state.baseYaw = qEuler.y;
			state.pitchTotal = ( Number( phase.pitch ) || 0 ) * Math.PI * 2;
			state.yawTotal = ( Number( phase.yaw ) || 0 ) * Math.PI * 2;
			state.rollTotal = ( Number( phase.roll ) || 0 ) * Math.PI * 2;
		}

		const baseDuration = AIR_TRICK_DURATION_SECONDS;
		state.progress = Math.min( 1, state.progress + ( dt / baseDuration ) );
		const deltaT = Math.max( 0, state.progress - state.lastSmoothT );
		state.lastSmoothT = state.progress;
		if ( deltaT > 0 ) {

			const deltaEuler = new THREE.Euler(
				state.pitchTotal * deltaT,
				state.yawTotal * deltaT,
				state.rollTotal * deltaT,
				'YXZ'
			);
			const dq = new THREE.Quaternion().setFromEuler( deltaEuler );
			targetVehicle.container.quaternion.multiply( dq ).normalize();

		}
		targetVehicle.container.updateMatrixWorld( true );
			if ( state.progress >= 1 ) {

				state.active = false;
				state.progress = 0;
				state.lastSmoothT = 0;
				state.recovering = true;
				state.recoveryT = 0;
				state.recoveryStartQuat.copy( targetVehicle.container.quaternion );
				const euler = new THREE.Euler( 0, state.baseYaw, 0, 'YXZ' );
				state.recoveryTargetQuat.setFromEuler( euler );
				if ( onTrickFinished ) onTrickFinished();

			}

	}

	function isVehicleAirborne( targetVehicle ) {

		if ( ! targetVehicle ) return false;
		const verticalVel = targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] || 0;
		return targetVehicle.spherePos.y > 0.62 || Math.abs( verticalVel ) > 0.35;

	}

	function getCustomSurfaceEffect( surfaceType ) {

		const conf = customSurfaceConfigs?.[ surfaceType ];
		if ( ! conf ) return null;
		const grip = THREE.MathUtils.clamp( Number( conf.grip ) || 1, 0.2, 2.5 );
		const speed = THREE.MathUtils.clamp( Number( conf.speed ) || 1, 0.2, 2.5 );
		return {
			grip,
			drag: THREE.MathUtils.clamp( 1.2 / speed, 0.4, 3.4 ),
			accel: speed,
			drive: speed,
		};

	}

	function getSurfaceEffect( surfaceType ) {

		return getCustomSurfaceEffect( surfaceType ) || SURFACE_EFFECTS[ surfaceType || null ] || null;

	}

	function applySurfaceGrip( targetVehicle, surfaceType, padEffect = null ) {

		const effect = getSurfaceEffect( surfaceType );
		const gripPack = GARAGE_FIXED_MULTIPLIER;
		const accelPack = GARAGE_FIXED_MULTIPLIER;
		const drivePack = GARAGE_FIXED_MULTIPLIER;
		const padGrip = Number.isFinite( padEffect?.grip ) ? padEffect.grip : 1.0;
		const padDrag = Number.isFinite( padEffect?.drag ) ? padEffect.drag : 1.0;
		const padAccel = Number.isFinite( padEffect?.accel ) ? padEffect.accel : 1.0;
		const padDrive = Number.isFinite( padEffect?.drive ) ? padEffect.drive : 1.0;
		targetVehicle.gripMultiplier = ( effect ? effect.grip : 1.0 ) * gripPack * padGrip * ( targetVehicle.__modGrip ?? 1 );
		if ( hacksInstalled && hacksState.enabled ) targetVehicle.gripMultiplier *= hacksState.roadGrip;
		targetVehicle.dragMultiplier = ( effect ? effect.drag : 1.0 ) * padDrag * ( targetVehicle.__modDrag ?? 1 );
		if ( hacksInstalled && hacksState.enabled && hacksState.lowFriction ) targetVehicle.dragMultiplier *= 0.35;
		const speedCapScale = Number.isFinite( padEffect?.topSpeed ) ? padEffect.topSpeed : 1.0;
		// Pad effects raise the car's actual top speed (stacked pads used to only
		// fold their topSpeed factor into accel/drive, so MAX_EFFECTIVE_TOP_SPEED
		// (1.8 = 64 mph) stayed a hard wall no matter how many pads you stacked).
		// Recomputed from the stored base every frame — idempotent, self-reverting.
		// PAD_SPEED_FACTOR_CAP: without it, 20 stacked pads = 86x top speed and the
		// drive injection below scales with linearSpeed, so the ball would be spun
		// at billions of rad/s (quaternion death). 10x (= ~640 mph) is the sane ceiling.
		// PAD_DRIVE_CAP: drive force x driveMultiplier injects ball spin; spin beyond
		// ~1x rolling speed is pure wheelspin/tumble — the car "freaks out" and
		// friction can't convert the slip into forward speed (this is why stacked
		// pads used to glitch the body without making it any faster). 4x keeps the
		// boost drama without the blender.
		const PAD_SPEED_FACTOR_CAP = 10;
		const PAD_DRIVE_CAP = 4;
		if ( ! Number.isFinite( targetVehicle.baseTopSpeed ) ) targetVehicle.baseTopSpeed = targetVehicle.topSpeed;
		targetVehicle.topSpeed = targetVehicle.baseTopSpeed * Math.min( PAD_SPEED_FACTOR_CAP, speedCapScale ) * ( targetVehicle.__modSpeed ?? 1 );
		targetVehicle.accelMultiplier = ( effect ? effect.accel : 1.0 ) * accelPack * padAccel * ( targetVehicle.__modAccel ?? 1 );
		targetVehicle.driveMultiplier = Math.min( PAD_DRIVE_CAP, ( effect ? effect.drive : 1.0 ) * drivePack * padDrive * ( targetVehicle.__modDrive ?? 1 ) );

	}

	function getFastestVisibleGhostCheckpointTime( checkpointIndex ) {

		let best = Number.isFinite( bestGhostCheckpointTimes?.[ checkpointIndex ] ) ? bestGhostCheckpointTimes[ checkpointIndex ] : Infinity;
		for ( const state of leaderboardGhostPlayers.values() ) {

			const time = Number( state?.checkpointTimes?.[ checkpointIndex ] );
			if ( Number.isFinite( time ) ) best = Math.min( best, time );

		}
		for ( const state of recentGhostPlayers ) {

			const time = Number( state?.checkpointTimes?.[ checkpointIndex ] );
			if ( Number.isFinite( time ) ) best = Math.min( best, time );

		}
		return Number.isFinite( best ) ? best : null;

	}

	function formatDeltaSigned( deltaSeconds ) {

		if ( ! Number.isFinite( deltaSeconds ) ) return '';
		const sign = deltaSeconds >= 0 ? '+' : '-';
		const abs = Math.abs( deltaSeconds );
		const minutes = Math.floor( abs / 60 );
		const seconds = Math.floor( abs % 60 );
		const millis = Math.floor( ( abs % 1 ) * 1000 );
		return `${ sign }${ String( minutes ).padStart( 2, '0' ) }.${ String( seconds ).padStart( 2, '0' ) }.${ String( millis ).padStart( 3, '0' ) }`;

	}

	function formatLapTime( totalSeconds ) {

		if ( totalSeconds === null || ! Number.isFinite( totalSeconds ) ) return '--:--.---';

		const minutes = Math.floor( totalSeconds / 60 );
		const seconds = Math.floor( totalSeconds % 60 );
		const millis = Math.floor( ( totalSeconds % 1 ) * 1000 );
		return `${ String( minutes ).padStart( 2, '0' ) }:${ String( seconds ).padStart( 2, '0' ) }.${ String( millis ).padStart( 3, '0' ) }`;

	}

	function formatShareSeconds( totalSeconds ) {

		if ( ! Number.isFinite( totalSeconds ) ) return '--.--';
		return totalSeconds.toFixed( 2 );

	}

	function createTimeCardImage( bestSeconds ) {

		const width = 1280;
		const height = 720;
		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext( '2d' );
		if ( ! ctx ) return '';

		const bg = ctx.createLinearGradient( 0, 0, width, height );
		bg.addColorStop( 0, '#29323c' );
		bg.addColorStop( 1, '#0f2027' );
		ctx.fillStyle = bg;
		ctx.fillRect( 0, 0, width, height );

		ctx.fillStyle = 'rgba(255,255,255,0.12)';
		ctx.fillRect( width * 0.1, height * 0.22, width * 0.8, height * 0.56 );

		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = '700 66px sans-serif';
		ctx.fillText( 'Beat my time!', width / 2, height * 0.4 );
		ctx.font = '700 94px sans-serif';
		ctx.fillText( `${ formatShareSeconds( bestSeconds ) }s`, width / 2, height * 0.56 );
		ctx.font = '500 38px sans-serif';
		ctx.fillText( 'Racing Game • Best Lap', width / 2, height * 0.7 );

		return canvas.toDataURL( 'image/png' );

	}

	function createShareSnapshot( bestSeconds ) {

		try {

			renderer.shadowMap.needsUpdate = true;
			prerenderWaterRefraction( renderer, scene, cam.camera );
			renderer.render( scene, cam.camera );
			const source = renderer.domElement;
			if ( ! source || source.width === 0 || source.height === 0 ) return '';

			const output = document.createElement( 'canvas' );
			output.width = source.width;
			output.height = source.height;
			const ctx = output.getContext( '2d' );
			if ( ! ctx ) return '';

			ctx.drawImage( source, 0, 0 );
			const bannerWidth = output.width * 0.72;
			const bannerHeight = output.height * 0.14;
			const bannerX = ( output.width - bannerWidth ) / 2;
			const bannerY = output.height - bannerHeight - output.height * 0.05;

			ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
			ctx.fillRect( bannerX, bannerY, bannerWidth, bannerHeight );

			const message = `Beat my time! My best time: ${ formatShareSeconds( bestSeconds ) }s`;
			const fontSize = Math.max( 20, Math.round( output.height * 0.04 ) );
			ctx.fillStyle = 'rgba(20, 20, 20, 0.92)';
			ctx.font = `700 ${ fontSize }px sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText( message, output.width / 2, bannerY + bannerHeight / 2 );

			return output.toDataURL( 'image/png' );

		} catch ( e ) {

			console.warn( 'Failed to create share snapshot', e );
			return createTimeCardImage( bestSeconds );

		}

	}

	function openShareTab() {

		if ( ! Number.isFinite( bestLapSeconds ) ) return;
		const ghostCode = createGhostExportCode();
		let playTrackUrl = '';
		if ( ghostCode ) {

			try {

				const parsed = decodeGhostCode( ghostCode );
				if ( parsed ) {

					const ghostBlob = encodeGhostBinary( parsed.ghost ) || encodeBase64UrlJson( parsed.ghost );
					const separator = parsed.url.includes( '#' ) ? '&' : '#';
					playTrackUrl = `${ parsed.url }${ separator }ghost=${ ghostBlob }`;

				}

			} catch ( e ) {

				console.warn( 'Failed to build track ghost URL from export code', e );

			}

		}
		const sharePayload = encodeBase64UrlJson( {
			v: 1,
			bestLapSeconds,
			ghostCode,
			playTrackUrl,
		} );
		const sharePageUrl = `share.html#data=${ sharePayload }`;
		const tab = window.open( sharePageUrl, '_blank' );
		if ( ! tab ) return;

	}

	function openReplayWatcherForGhost( ghostPayload ) {

		if ( ! ghostPayload || ! Array.isArray( ghostPayload.samples ) || ghostPayload.samples.length < 2 ) {

			showTopMessage( 'This ghost payload is invalid for replay viewing.', true, 2000 );
			return;

		}
		const replayCode = encodeGhostCode( currentTrackUrl, ghostPayload );
		if ( replayCode ) window.open( `replay.html#code=${ replayCode }`, '_blank' );

	}

	function updateGhostShareButtons() {

		if ( ! exportGhostBtn ) return;
		if ( ! ghostEnabled ) {

			exportGhostBtn.disabled = true;
			exportGhostBtn.title = 'Ghosts are disabled in local multiplayer';
			return;

		}
		const hasGhost = bestLapGhostSamples.length >= 2 && Number.isFinite( bestLapSeconds );
		exportGhostBtn.disabled = false;
		exportGhostBtn.title = hasGhost ? 'Export current best ghost' : 'Finish a clean lap first to generate an exportable ghost';

	}

	function createGhostExportCode() {

		if ( ! ghostEnabled ) return '';
		if ( bestLapGhostSamples.length < 2 || ! Number.isFinite( bestLapSeconds ) ) return '';
		// Compact v2 code (js/GhostCodec.js): ~89% smaller than the old JSON
		// payload — a 60s lap drops from ~230 KB to ~25 KB of pasteable text.
		return encodeGhostCode( currentTrackUrl, {
			car: bestGhostCarKey,
			cosmetics: bestGhostCosmetics,
			bestLapSeconds,
			duration: bestGhostDuration,
			samples: bestLapGhostSamples,
		} ) || '';

	}

	function createLeaderboardGhostPayload() {

		if ( ! ghostEnabled ) return null;
		if ( bestLapGhostSamples.length < 2 || ! Number.isFinite( bestGhostDuration ) || bestGhostDuration <= 0 ) return null;
		return {
			car: bestGhostCarKey,
			cosmetics: bestGhostCosmetics,
			bestLapSeconds: Number.isFinite( bestLapSeconds ) ? bestLapSeconds : undefined,
			duration: bestGhostDuration,
			samples: bestLapGhostSamples.slice( 0, MAX_LEADERBOARD_GHOST_SAMPLES ),
		};

	}

	function applyImportedGhostPayload( payload, options = {} ) {

		if ( ! ghostEnabled ) return false;
		const normalized = extractNormalizedGhostPayload( payload );
		if ( ! normalized ) return false;
		bestLapGhostSamples.length = 0;
		for ( const sample of normalized.samples ) bestLapGhostSamples.push( sample );
		if ( bestLapGhostSamples.length < 2 ) return false;
		bestGhostDuration = normalized.duration;
		bestGhostCosmetics = normalized.cosmetics;
		bestGhostCheckpointTimes = computeCheckpointCrossTimes( normalized.samples );
		if ( options.applyBestLapSeconds !== false && Number.isFinite( normalized.bestLapSeconds ) ) bestLapSeconds = normalized.bestLapSeconds;
		if ( normalized.car && models[ normalized.car ] ) {

			bestGhostCarKey = normalized.car;
			createGhostModel( models[ normalized.car ], bestGhostCosmetics );

		}
			updateGhostShareButtons();
		return true;

	}

	function importGhostIntoNewTab() {

		if ( ! ghostEnabled ) return;
		const code = window.prompt( 'Paste ghost code:' );
		if ( ! code ) return;
		const parsed = decodeGhostCode( code.trim() );
		if ( ! parsed ) {

			window.alert( 'Invalid ghost code.' );
			return;

		}
		const url = typeof parsed.url === 'string' ? parsed.url : '';
		const applied = applyImportedGhostPayload( parsed.ghost );
		if ( applied ) {

			showTopMessage( 'Ghost imported for current track.', false, 1700 );
			return;

		}
		if ( url ) {

			const ghostBlob = encodeGhostBinary( parsed.ghost ) || encodeBase64UrlJson( parsed.ghost );
			const separator = url.includes( '#' ) ? '&' : '#';
			window.open( `${ url }${ separator }ghost=${ ghostBlob }`, '_blank' );
			return;

		}
		window.alert( 'Ghost code could not be applied to this track.' );

	}

	function openGhostCodeTab( code ) {

		const tab = window.open( 'about:blank', '_blank' );
		if ( ! tab ) return;
		tab.document.open();
		tab.document.write( `<!doctype html><html><head><title>Ghost code</title><style>body{margin:0;padding:16px;background:#101218;color:#e8eef8;font:14px/1.4 monospace;}h1{font:600 16px sans-serif;margin:0 0 10px;}textarea{width:100%;height:70vh;background:#0b0d12;color:#dff4ff;border:1px solid #2a3240;border-radius:8px;padding:10px;box-sizing:border-box;}</style></head><body><h1>Raw ghost code</h1><textarea readonly>${ code }</textarea></body></html>` );
		tab.document.close();

	}

	function updateLapHud() {

		const totalCheckpoints = checkpointStates.length;
		const passedCheckpoints = checkpointStates.reduce( ( count, checkpoint ) => count + ( checkpoint.passedThisLap ? 1 : 0 ), 0 );
		const controlsHints = [];
		if ( checkpointRespawnInstalled ) controlsHints.push( 'Checkpoint respawn: T' );
		if ( practiceStartInstalled ) controlsHints.push( 'Save/Load practice: Y / Shift+Y' );
		if ( freecamInstalled ) controlsHints.push( 'Freecam: F (WASD=cam, Arrows=drive)' );

		// mirror into the customizable HUD grid (the old overlay is gone)
		if ( window.__hudGrid ) {
			window.__hudGrid.setState( {
				lapNumber,
				lapTime: formatLapTime( lapSeconds ),
				lastLap: formatLapTime( lastLapSeconds ),
				bestLap: formatLapTime( bestLapSeconds ),
				checkpoints: totalCheckpoints > 0 ? `${ passedCheckpoints } / ${ totalCheckpoints }` : '—',
				controls: controlsHints.join( ' • ' ),
			} );
			window.__hudGrid.update();
		}

	}

	function updateLapHud2() {

		if ( ! isSplitScreen ) return;

		if ( window.__hudGrid ) {
			window.__hudGrid.setState( {
				p2Lap: `Lap ${ lapNumber2 }`,
				p2Time: formatLapTime( lapSeconds2 ),
			} );
			window.__hudGrid.update();
		}

	}

	function renderLeaderboardRows( rows ) {

		if ( ! leaderboardList || ! leaderboardEmpty ) return;
		const entries = Array.isArray( rows ) ? rows : [];
		leaderboardList.innerHTML = '';
		if ( entries.length === 0 ) {

			leaderboardList.hidden = true;
			leaderboardEmpty.hidden = false;
			leaderboardEmpty.textContent = 'No records yet. Finish a lap to post one.';
			if ( leaderboardPercentileLabel ) leaderboardPercentileLabel.textContent = '';
			return;

		}
		leaderboardEmpty.hidden = true;
		leaderboardList.hidden = false;
		updateSelectedLeaderboardGhosts( entries );
		for ( const [ index, entry ] of entries.slice( 0, MAX_LEADERBOARD_ROWS ).entries() ) {

			const row = document.createElement( 'li' );
			const safeName = sanitizePlayerName( entry?.name ) || 'Anonymous';
			const timeText = formatLapTime( Number( entry?.timeSeconds ) );
			const hasGhost = Boolean( entry?.ghost );
			row.classList.toggle( 'has-ghost', hasGhost );
			const checked = hasGhost && selectedLeaderboardGhosts.has( safeName );
			row.innerHTML = `<span class=\"lb-rank\">#${ index + 1 }</span> <span class=\"lb-name\">${ safeName }</span> — <span class=\"lb-time\">${ timeText }</span>${ hasGhost ? '<label class=\"lb-ghost-toggle\"><input type=\"checkbox\" class=\"lb-ghost-check\" data-player-name=\"' + safeName.replace( /\"/g, '&quot;' ) + '\" ' + ( checked ? 'checked' : '' ) + '> show ghost</label><button type=\"button\" class=\"lb-replay-btn\">watch replay</button>' : '' }`;
			if ( hasGhost ) {

				const checkbox = row.querySelector( '.lb-ghost-check' );
				const replayBtn = row.querySelector( '.lb-replay-btn' );
				checkbox?.addEventListener( 'change', () => {

					if ( checkbox.checked ) {

						if ( ! enableLeaderboardGhost( safeName, entry.ghost ) ) {

							checkbox.checked = false;
							showTopMessage( `${ safeName } has an invalid cloud ghost entry.`, true, 1900 );
							return;

						}
						selectedLeaderboardGhosts.add( safeName );
						showTopMessage( `Enabled ${ safeName } ghost.`, false, 1500 );
					} else {

						selectedLeaderboardGhosts.delete( safeName );
						removeLeaderboardGhost( safeName );
						showTopMessage( `Disabled ${ safeName } ghost.`, false, 1500 );

					}

				} );
				replayBtn?.addEventListener( 'click', ( event ) => {

					event.stopPropagation();
					openReplayWatcherForGhost( entry.ghost );

				} );

			} else {

				row.addEventListener( 'click', () => showTopMessage( `${ safeName }'s record was set before cloud ghosts existed.`, true, 1900 ) );

			}
			leaderboardList.appendChild( row );

		}

	}

	function updateLeaderboardPercentile( rows ) {

		if ( ! leaderboardPercentileLabel ) return;
		const entries = Array.isArray( rows ) ? rows : [];
		if ( entries.length === 0 ) {

			leaderboardPercentileLabel.textContent = '';
			return;

		}
		const localName = sanitizePlayerName( playerNameInput?.value || localStorage.getItem( PLAYER_NAME_KEY ) || '' ).toLowerCase();
		let myRank = -1;
		if ( localName ) myRank = entries.findIndex( ( row ) => sanitizePlayerName( row?.name ).toLowerCase() === localName );
		if ( myRank < 0 && Number.isFinite( bestLapSeconds ) ) {

			myRank = entries.findIndex( ( row ) => Number( row?.timeSeconds ) >= bestLapSeconds - 1e-6 );

		}
		if ( myRank < 0 ) {

			leaderboardPercentileLabel.textContent = `Entries: ${ entries.length }`;
			return;

		}
		const rank = myRank + 1;
		const percentile = Math.max( 0, 100 * ( 1 - ( rank - 1 ) / Math.max( 1, entries.length ) ) );
		leaderboardPercentileLabel.textContent = `Your percentile: top ${ percentile.toFixed( 1 ) }% (#${ rank }/${ entries.length })`;

	}

	async function fetchTrackLeaderboard() {

		if ( leaderboardTrackLabel ) leaderboardTrackLabel.textContent = `Track: ${ leaderboardTrackName }`;
		if ( ! leaderboardEmpty || ! leaderboardList ) return;
		leaderboardEmpty.hidden = false;
		leaderboardList.hidden = true;
		leaderboardEmpty.textContent = 'Loading leaderboard…';
		setLoadingStatus( 'Fetching leaderboard…', 'leaderboard' );
		try {

			const trackIdsToRead = [ leaderboardTrackId, ...leaderboardLegacyTrackIds ];
			const payloads = await Promise.all( trackIdsToRead.map( async ( trackId ) => {

				const response = await fetch( `${ LEADERBOARD_API_BASE }?trackId=${ encodeURIComponent( trackId ) }` );
				if ( ! response.ok ) throw new Error( `Leaderboard HTTP ${ response.status }` );
				return response.json();

			} ) );
			const merged = dedupeAndSortLeaderboardEntries( payloads.flatMap( ( parsed ) => Array.isArray( parsed?.entries ) ? parsed.entries : [] ) );
		currentTrackLeaderboardRows = merged;
			renderLeaderboardRows( merged );
			updateLeaderboardPercentile( merged );
			setLoadingStatus( 'Ready to race!', 'ready' );

		} catch ( e ) {

			console.warn( 'Failed to fetch leaderboard', e );
			leaderboardList.hidden = true;
			leaderboardEmpty.hidden = false;
			leaderboardEmpty.textContent = 'Leaderboard unavailable (check Cloudflare setup).';
			currentTrackLeaderboardRows = [];
			if ( leaderboardPercentileLabel ) leaderboardPercentileLabel.textContent = '';

		}

	}

	function dedupeAndSortLeaderboardEntries( entries ) {

		const bestByName = new Map();
		for ( const entry of entries ) {

			const key = sanitizePlayerName( entry?.name ).toLowerCase();
			if ( ! key ) continue;
			const timeSeconds = Number( entry?.timeSeconds );
			if ( ! Number.isFinite( timeSeconds ) ) continue;
			const normalized = {
				name: sanitizePlayerName( entry.name ) || 'Anonymous',
				timeSeconds: Math.round( timeSeconds * 1000 ) / 1000,
				ghost: entry?.ghost || null,
				createdAt: Number.isFinite( Number( entry?.createdAt ) ) ? Number( entry.createdAt ) : Date.now(),
			};
			const existing = bestByName.get( key );
			if ( ! existing || normalized.timeSeconds < existing.timeSeconds || ( normalized.timeSeconds === existing.timeSeconds && normalized.createdAt < existing.createdAt ) ) {

				bestByName.set( key, normalized );

			}

		}

		return [ ...bestByName.values() ].sort( ( a, b ) => {

			if ( a.timeSeconds !== b.timeSeconds ) return a.timeSeconds - b.timeSeconds;
			return a.createdAt - b.createdAt;

		} );

	}

	function closeNamePopup() {

		if ( ! namePopup ) return;
		namePopup.style.display = 'none';

	}

	function setLeaderboardVisible( visible ) {

		leaderboardVisible = Boolean( visible );
		if ( leaderboardPanel ) leaderboardPanel.classList.toggle( 'hidden', ! leaderboardVisible );
		if ( leaderboardToggleBtn ) leaderboardToggleBtn.textContent = leaderboardVisible ? 'Hide Leaderboard' : 'Show Leaderboard';

	}

	function openNamePopup( pendingTime ) {

		pendingLeaderboardRecord = pendingTime;
		if ( ! namePopup || ! namePopupInput ) return;
		namePopup.style.display = 'flex';
		namePopupInput.value = sanitizePlayerName( playerNameInput?.value );
		namePopupInput.focus();
		namePopupInput.select();

	}

	async function submitLeaderboardTime( lapTimeSeconds, forcedName = '' ) {

		if ( currentLapInvalidatedByPause ) {

			showTopMessage( 'Leaderboard submission skipped: paused runs are invalid.', true, 2400 );
			return false;

		}

		if ( nonFreecamModsInstalled ) {

			const anyCustomModInstalled = installedMods.some( ( mod ) => typeof mod?.id === 'string' && mod.id.startsWith( 'custom-' ) );
			showTopMessage( anyCustomModInstalled
				? 'Leaderboard is disabled while a custom mod is installed. Remove it in the Mod Manager to upload times.'
				: 'Leaderboard submission is disabled when gameplay mods are installed.', true, 2600 );
			return false;

		}

		const chosenName = sanitizePlayerName( forcedName || playerNameInput?.value );
		if ( ! chosenName ) {

			openNamePopup( lapTimeSeconds );
			return false;

		}
		localStorage.setItem( PLAYER_NAME_KEY, chosenName );
		if ( playerNameInput ) playerNameInput.value = chosenName;
		const submittedGhost = createLeaderboardGhostPayload();
		const submittedRoundedTime = Math.round( Number( lapTimeSeconds ) * 1000 ) / 1000;
		try {

			const trackIdsToWrite = [ leaderboardTrackId, ...leaderboardLegacyTrackIds ];
			const response = await fetch( LEADERBOARD_API_BASE, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					trackId: trackIdsToWrite[ 0 ],
					trackName: leaderboardTrackName,
					name: chosenName,
					timeSeconds: lapTimeSeconds,
					ghost: submittedGhost,
				} ),
			} );
			if ( ! response.ok ) throw new Error( `Leaderboard POST ${ response.status }` );
			let responsePayload = null;
			try {

				responsePayload = await response.json();

			} catch ( e ) {

				console.warn( 'Leaderboard POST response was not JSON', e );

			}
			if ( submittedGhost ) {

				const responseEntries = Array.isArray( responsePayload?.entries ) ? responsePayload.entries : [];
				const matchingEntry = responseEntries.find( ( entry ) => {

					if ( sanitizePlayerName( entry?.name ) !== chosenName ) return false;
					const entryTime = Math.round( Number( entry?.timeSeconds ) * 1000 ) / 1000;
					return Number.isFinite( entryTime ) && entryTime === submittedRoundedTime;

				} );
				if ( matchingEntry && ! matchingEntry.ghost ) {

					showTopMessage( 'Ghost save was ignored by Cloudflare API. Please redeploy the leaderboard worker update.', true, 2600 );

				}

			}
			await Promise.all( trackIdsToWrite.slice( 1 ).map( ( legacyId ) => fetch( LEADERBOARD_API_BASE, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					trackId: legacyId,
					trackName: leaderboardTrackName,
					name: chosenName,
					timeSeconds: lapTimeSeconds,
					ghost: submittedGhost,
				} ),
			} ).catch( () => null ) ) );
			await fetchTrackLeaderboard();
			return true;

		} catch ( e ) {

			console.warn( 'Failed to submit leaderboard time', e );
			return false;

		}

	}

	async function signupAccount() {

		const username = String( accountUsernameInput?.value || '' ).trim();
		const password = String( accountPasswordInput?.value || '' );
		const payload = await accountApiRequest( '/signup', {
			method: 'POST',
			body: JSON.stringify( { username, password, profile: getCurrentProfileSnapshot() } ),
		} );
		accountSession = { username: payload.username, token: payload.token };
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		setAccountStatus( `Signed up and logged in as ${ payload.username }.` );

	}

	async function loginAccount() {

		const username = String( accountUsernameInput?.value || '' ).trim();
		const password = String( accountPasswordInput?.value || '' );
		const payload = await accountApiRequest( '/login', {
			method: 'POST',
			body: JSON.stringify( { username, password } ),
		} );
		accountSession = { username: payload.username, token: payload.token };
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		try {

			await cloudLoadProfile();
			setAccountStatus( `Logged in as ${ payload.username } and loaded cloud profile.` );

		} catch ( loadError ) {

			console.warn( 'Auto cloud profile load after login failed', loadError );
			setAccountStatus( `Logged in as ${ payload.username } (auto-load failed, use "Load profile from cloud").`, true );

		}

	}

	async function cloudSaveProfile() {

		if ( ! accountSession?.token ) throw new Error( 'Log in first.' );
		await accountApiRequest( '/profile', {
			method: 'POST',
			body: JSON.stringify( { token: accountSession.token, profile: getCurrentProfileSnapshot() } ),
		} );
		setAccountStatus( 'Cloud profile saved.' );

	}

	// Auto-save: every 5 minutes the profile syncs to the accounts backend so a
	// crash / closed tab never loses more than ~5 minutes of progress. A top
	// notification (same channel as lap deltas / leaderboard notices) confirms
	// each save; failures stay quiet in the console.
	setInterval( async () => {

		if ( ! accountSession?.token ) return;
		try {

			await cloudSaveProfile();
			showTopMessage( 'Profile auto-saved to the cloud', false, 1800 );

		} catch ( err ) {

			console.warn( 'Profile auto-save failed', err );

		}

	}, 300000 );

	// Debounced profile cloud sync for small setting changes (default car, etc.).
	let profileCloudSyncTimer = null;
	function syncProfileToCloudDebounced() {

		if ( ! accountSession?.token ) return;
		if ( profileCloudSyncTimer ) clearTimeout( profileCloudSyncTimer );
		profileCloudSyncTimer = setTimeout( async () => {

			profileCloudSyncTimer = null;
			try {

				await accountApiRequest( '/profile', {
					method: 'POST',
					body: JSON.stringify( { token: accountSession.token, profile: getCurrentProfileSnapshot() } ),
				} );

			} catch ( err ) {

				console.warn( 'Profile cloud sync failed', err );

			}

		}, 1500 );

	}

	// Debounced HUD layout -> cloud sync. Triggered by js/HudGrid.js whenever the
	// player adds/removes/reorders a widget (saveHudLayout -> onHudLayoutChange).
	// No-op when not signed in; the layout still persists to localStorage.
	let hudCloudSyncTimer = null;
	async function syncHudLayoutToCloud() {

		if ( ! accountSession?.token ) return;
		if ( hudCloudSyncTimer ) clearTimeout( hudCloudSyncTimer );
		hudCloudSyncTimer = setTimeout( async () => {
			hudCloudSyncTimer = null;
			try {
				await accountApiRequest( '/profile', {
					method: 'POST',
					body: JSON.stringify( { token: accountSession.token, profile: getCurrentProfileSnapshot() } ),
				} );
			} catch ( err ) {
				console.warn( 'HUD cloud sync failed', err );
			}
		}, 1500 );

	}

	if ( window.__hudGrid?.setOnLayoutChange ) window.__hudGrid.setOnLayoutChange( syncHudLayoutToCloud );

	async function cloudLoadProfile() {

		if ( ! accountSession?.token ) throw new Error( 'Log in first.' );
		const payload = await accountApiRequest( `/profile?token=${ encodeURIComponent( accountSession.token ) }` );
		if ( payload?.profile ) applyImportedProfile( encodeBase64UrlJson( payload.profile ) );
		if ( payload?.username ) accountSession.username = payload.username;
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		setAccountStatus( 'Cloud profile loaded.' );

	}

	function saveLapStats() {

		if ( ! ghostEnabled ) {

				localStorage.setItem( lapStoreKey, JSON.stringify( {
					lapNumber,
					lastLapSeconds,
					bestLapSeconds,
					bestGhostG2: '',
				} ) );
			return;

		}
			// Compact "g2" binary ghost (js/GhostCodec.js) — the old raw JSON
			// sample array was by far the biggest localStorage consumer.
			const bestGhostG2 = encodeGhostBinary( {
				car: bestGhostCarKey,
				cosmetics: bestGhostCosmetics,
				bestLapSeconds,
				duration: bestGhostDuration,
				samples: bestLapGhostSamples,
			} ) || '';
			localStorage.setItem( lapStoreKey, JSON.stringify( {
				lapNumber,
				lastLapSeconds,
				bestLapSeconds,
				bestGhostG2,
			} ) );

	}

	function loadLapStats() {

		try {

			const raw = localStorage.getItem( lapStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			lapNumber = Math.max( 1, parsed.lapNumber || 1 );
			lastLapSeconds = Number.isFinite( parsed.lastLapSeconds ) ? parsed.lastLapSeconds : null;
			bestLapSeconds = Number.isFinite( parsed.bestLapSeconds ) ? parsed.bestLapSeconds : null;
			bestGhostDuration = Number.isFinite( parsed.bestGhostDuration ) ? parsed.bestGhostDuration : 0;
				bestGhostCarKey = typeof parsed.bestGhostCarKey === 'string' ? parsed.bestGhostCarKey : 'vehicle-truck-yellow';
				bestGhostCosmetics = normalizeGhostCosmeticsPayload( parsed.bestGhostCosmetics );
				bestLapGhostSamples.length = 0;
				ghostPlaybackCursor._cursor = 1;
				const compactGhost = typeof parsed.bestGhostG2 === 'string' ? decodeGhostBinary( parsed.bestGhostG2 ) : null;
				if ( compactGhost ) {

					for ( const sample of compactGhost.samples ) bestLapGhostSamples.push( sample );
					if ( compactGhost.car ) bestGhostCarKey = compactGhost.car;
					bestGhostCosmetics = normalizeGhostCosmeticsPayload( compactGhost.cosmetics );
					if ( Number.isFinite( compactGhost.bestLapSeconds ) ) bestLapSeconds = compactGhost.bestLapSeconds;
					if ( Number.isFinite( compactGhost.duration ) ) bestGhostDuration = compactGhost.duration;

				} else if ( Array.isArray( parsed.bestLapGhostSamples ) ) {

					for ( const sample of parsed.bestLapGhostSamples ) {

						if ( ! Number.isFinite( sample?.t ) || ! Number.isFinite( sample?.x ) || ! Number.isFinite( sample?.y ) || ! Number.isFinite( sample?.z ) || ! Number.isFinite( sample?.yaw ) ) continue;
						bestLapGhostSamples.push( {
							t: sample.t,
							x: sample.x,
							y: sample.y,
							z: sample.z,
							yaw: sample.yaw,
						} );

					}

				}

			if ( bestLapGhostSamples.length < 2 ) bestGhostDuration = 0;
			if ( ghostEnabled && bestLapGhostSamples.length >= 2 && models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ], bestGhostCosmetics );

		} catch ( e ) {

			console.warn( 'Failed to load lap stats', e );

		}

	}

	function updateFpsHudVisibility() {

		if ( fpsToggle ) fpsToggle.checked = fpsHudVisible;
		if ( fpsHud ) {

			fpsHud.classList.toggle( 'visible', fpsHudVisible );
			fpsHud.setAttribute( 'aria-hidden', fpsHudVisible ? 'false' : 'true' );

		}

	}

	function updateFpsHud( realFrameSeconds ) {

		// Rolling FPS tracks every frame even when the HUD is hidden — the
		// water-quality governor (updateWaterQuality) reads this signal.
		const instantFps = realFrameSeconds > 0 ? 1 / realFrameSeconds : 0;
		if ( Number.isFinite( instantFps ) && instantFps > 0 ) {

			rollingFps = rollingFps > 0 ? THREE.MathUtils.lerp( rollingFps, instantFps, 0.08 ) : instantFps;

		}
		if ( ! fpsHudVisible || ! fpsHud ) return;
		fpsHudAccumulator += realFrameSeconds;
		if ( fpsHudAccumulator < 0.18 ) return;
		fpsHudAccumulator = 0;
		fpsHud.textContent = `FPS: ${ Math.round( rollingFps ) }`;

		// feed fps into the customizable HUD grid
		if ( window.__hudGrid ) {
			let spd = 0;
			if ( vehicle?.rigidBody?.motionProperties ) {
				const v = vehicle.rigidBody.motionProperties.linearVelocity;
				spd = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 2 ] * v[ 2 ] );
			}
			let px = 0, py = 0, pz = 0;
			if ( vehicle?.container?.position ) {
				px = vehicle.container.position.x;
				py = vehicle.container.position.y;
				pz = vehicle.container.position.z;
			}
			window.__hudGrid.setState( {
				speed: String( Math.round( spd * 3.6 ) ),
				fps: String( Math.round( rollingFps ) ),
				posX: px.toFixed( 1 ),
				posY: py.toFixed( 1 ),
				posZ: pz.toFixed( 1 ),
				coins: Math.floor( coins ).toLocaleString(),
				name: sanitizePlayerName( playerNameInput?.value || localStorage.getItem( PLAYER_NAME_KEY ) || '' ),
				boost: arcadeBoostInstalled ? `${ Math.round( THREE.MathUtils.clamp( boostMeter / BOOST_METER_MAX, 0, 1 ) * 100 ) }%` : 'off',
				stuntPoints: Math.floor( stuntPoints ).toLocaleString(),
				stuntCombo: stuntCombo.toFixed( 2 ),
				stuntBest: Math.floor( bestStuntPoints ).toLocaleString(),
			} );
		}

	}

	function canPauseGameplay() {

		return ! isSplitScreen && ! multiplayerSessionState.roomCode && ! replayViewerMode;

	}

	function setUiHidden( hidden ) {

		uiHidden = Boolean( hidden );
		document.body.classList.toggle( 'ui-hidden', uiHidden );

	}

	function updatePauseUi() {

		const canPause = canPauseGameplay();
		if ( pausePanel ) {

			pausePanel.classList.toggle( 'visible', paused );
			pausePanel.setAttribute( 'aria-hidden', paused ? 'false' : 'true' );

		}
		if ( pauseToggleBtn ) {

			pauseToggleBtn.disabled = ! canPause;
			pauseToggleBtn.textContent = paused ? 'Resume' : 'Pause';
			pauseToggleBtn.title = canPause ? 'Pause or resume the race' : 'Pause is disabled in multiplayer.';

		}

	}

	function setPaused( next ) {

		const nextPaused = Boolean( next );
		if ( nextPaused && ! canPauseGameplay() ) return;
		if ( paused === nextPaused ) return;
		paused = nextPaused;
		if ( paused ) {

			currentLapInvalidatedByPause = true;
			showTopMessage( 'Paused run marked invalid for leaderboard submission.', true, 1800 );

		}
		updatePauseUi();
		updateLapHud();

	}

	function togglePaused() {

		setPaused( ! paused );

	}

	function updateCountdownHud( now = raceClockSeconds ) {

		if ( ! countdownHud ) return;
		if ( ! countdownActive ) {

			countdownHud.classList.remove( 'visible' );
			countdownHud.textContent = '';
			return;

		}
		const remaining = Math.max( 0, countdownEndsAt - now );
		countdownHud.textContent = remaining > 0.35 ? String( Math.ceil( remaining ) ) : 'GO!';
		countdownHud.classList.add( 'visible' );

	}

	function finishCountdown( now = raceClockSeconds ) {

		if ( ! countdownActive ) return;
		countdownActive = false;
		countdownEndsAt = 0;
		lapStartSeconds = now;
		lapSeconds = 0;
		if ( vehicle2 ) {

			lapStartSeconds2 = now;
			lapSeconds2 = 0;

		}
		resetCurrentLapGhost();
		recordGhostSample( 0, true );
		updateCountdownHud( now );
		updateLapHud();
		updateLapHud2();

	}

	function startCountdown( now = raceClockSeconds ) {

		if ( ! countdownEnabled ) {

			countdownActive = false;
			countdownEndsAt = 0;
			updateCountdownHud( now );
			return;

		}
		countdownActive = true;
		countdownEndsAt = now + COUNTDOWN_DURATION_SECONDS;
		lapSeconds = 0;
		if ( vehicle2 ) lapSeconds2 = 0;
		updateCountdownHud( now );
		updateLapHud();
		updateLapHud2();

	}

	function updateCountdownState( now = raceClockSeconds ) {

		if ( ! countdownActive ) return;
		if ( now >= countdownEndsAt ) finishCountdown( now );
		else updateCountdownHud( now );

	}

	function resetLapState( keepRecords = false ) {

		if ( ! keepRecords ) {

			lapNumber = 1;
			lastLapSeconds = null;
			bestLapSeconds = null;

		}

		lapStartSeconds = raceClockSeconds;
		lapSeconds = 0;
		// Restart snaps the car back to the start — break any in-progress skid
		// trails so no line is drawn across the map to the spawn block.
		skidMarks?.breakVehicleTrail( vehicle );
		skidMarks?.breakVehicleTrail( vehicle2 );
		currentLapInvalidatedByPause = false;
		boostActiveUntil = 0;
		vehicle.setWheelieActive?.( false );
		boostContactCell = null;
		arcLinkState = { contactKey: null, lockUntilExit: false };
		activePadEffect = null;
		activePadTimeScale = 1;
		padContactKey = null;
		airTrickState.active = false;
		airTrickState.recovering = false;
		camYawLockActive = false;
		specialSurfaceContactState.clear();
		resetCurrentLapGhost();
		recordGhostSample( 0, true );
		updateGhostPlayback( 0 );
		updateLeaderboardGhostPlayback( 0 );
		updateRecentGhostPlayback( 0 );
		hasLeftStartZone = false;
		hasPrevFinishSample = false;
		lastLocalX = 0;
		lastLocalZ = 0;
		for ( let checkpointIndex = 0; checkpointIndex < checkpointStates.length; checkpointIndex ++ ) {

			const checkpoint = checkpointStates[ checkpointIndex ];

			checkpoint.lastLocalX = 0;
			checkpoint.lastLocalZ = 0;
			checkpoint.hasPrevSample = false;
			checkpoint.passedThisLap = false;

		}
		updateLapHud();

	}

	function resetLapState2( keepRecords = false ) {

		if ( ! isSplitScreen ) return;
		if ( ! keepRecords ) {

			lapNumber2 = 1;
			lastLapSeconds2 = null;
			bestLapSeconds2 = null;

		}
		lapStartSeconds2 = raceClockSeconds;
		lapSeconds2 = 0;
		boostActiveUntil2 = 0;
                vehicle2.setWheelieActive?.( false );
		boostContactCell2 = null;
		arcLinkState2 = { contactKey: null, lockUntilExit: false };
		activePadEffect2 = null;
		activePadTimeScale2 = 1;
		padContactKey2 = null;
		airTrickState2.active = false;
		airTrickState2.recovering = false;
		camYawLockActive2 = false;
		specialSurfaceContactState2.clear();
		hasLeftStartZone2 = false;
		hasPrevFinishSample2 = false;
		lastLocalX2 = 0;
		lastLocalZ2 = 0;
		for ( const checkpoint of checkpointStates2 ) {

			checkpoint.lastLocalX = 0;
			checkpoint.lastLocalZ = 0;
			checkpoint.hasPrevSample = false;
			checkpoint.passedThisLap = false;

		}
		updateLapHud2();

	}

	function respawnVehicle() {

		autoRespawnAtSeconds = null;
		vehicle.resetToSpawn();
		resetMovingObstacles( movingObstacleState, raceClockSeconds );
		cam.targetPosition.copy( vehicle.spherePos );
		cam.camera.position.addVectors( cam.targetPosition, cam.offset );
		resetPhysicsObstacles();

		resetLapState( true );

	}

	function respawnVehicle2() {

		if ( ! vehicle2 || ! cam2 ) return;
		autoRespawnAtSeconds2 = null;
		vehicle2.resetToSpawn();
		cam2.targetPosition.copy( vehicle2.spherePos );
		cam2.camera.position.addVectors( cam2.targetPosition, cam2.offset );
		resetPhysicsObstacles();
		resetLapState2( true );

	}

	function saveCheckpointState( checkpoint = null ) {

		if ( ! finishData ) return;
		savedCheckpointState = {
			position: vehicle.spherePos.toArray(),
			checkpointAngle: Number.isFinite( checkpoint?.angle ) ? checkpoint.angle : vehicle.container.rotation.y,
		};

	}

	function respawnToLastCheckpoint() {

		if ( ! savedCheckpointState ) {

			showTopMessage( 'No checkpoint captured yet.', true, 1400 );
			return;

		}
		rigidBody.setPosition( world, vehicle.rigidBody, savedCheckpointState.position, false );
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
		rigidBody.setAngularVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
		vehicle.spherePos.fromArray( savedCheckpointState.position );
		vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
		vehicle.container.rotation.y = savedCheckpointState.checkpointAngle || 0;
		vehicle.linearSpeed = 0;
		vehicle.angularSpeed = 0;
		vehicle.acceleration = 0;
		vehicle.sphereVel.set( 0, 0, 0 );
		vehicle.modelVelocity.set( 0, 0, 0 );
		cam.targetPosition.copy( vehicle.spherePos );
		resetPhysicsObstacles();

	}

	function resetPhysicsObstacles() {

		for ( const entry of resettableObstacleBodies ) {

			const body = entry?.body;
			const position = entry?.position;
			if ( ! body || ! Array.isArray( position ) ) continue;
			rigidBody.setPosition( world, body, position, false );
			rigidBody.setLinearVelocity( world, body, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( world, body, [ 0, 0, 0 ] );

		}

	}

	function scheduleAutoRespawnVehicle() {

		autoRespawnAtSeconds = raceClockSeconds + 0.5;

	}

	function scheduleAutoRespawnVehicle2() {

		autoRespawnAtSeconds2 = raceClockSeconds + 0.5;

	}

	function savePracticeState() {

		if ( ! practiceStartInstalled || ! vehicle?.rigidBody?.motionProperties ) return;
		savedPracticeState = {
			position: vehicle.spherePos.toArray(),
			rotationY: vehicle.container.rotation.y,
			linearVelocity: [ ...vehicle.rigidBody.motionProperties.linearVelocity ],
			angularVelocity: [ ...vehicle.rigidBody.motionProperties.angularVelocity ],
		};
		showTopMessage( 'Practice state saved (Y).', false, 1200 );

	}

	function restorePracticeState() {

		if ( ! savedPracticeState ) {

			showTopMessage( 'No practice state saved yet.', true, 1300 );
			return;

		}
		rigidBody.setPosition( world, vehicle.rigidBody, savedPracticeState.position, false );
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, savedPracticeState.linearVelocity, false );
		rigidBody.setAngularVelocity( world, vehicle.rigidBody, savedPracticeState.angularVelocity, false );
		vehicle.spherePos.fromArray( savedPracticeState.position );
		vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
		vehicle.container.rotation.y = savedPracticeState.rotationY || 0;
		cam.targetPosition.copy( vehicle.spherePos );
		showTopMessage( 'Returned to saved practice state.', false, 1200 );

	}

	function updateArcadeBoostUi() {

		if ( ! boostUi || ! boostFill ) return;
		boostUi.style.display = arcadeBoostInstalled && ! isSplitScreen ? 'block' : 'none';
		const pct = THREE.MathUtils.clamp( boostMeter / BOOST_METER_MAX, 0, 1 );
		boostFill.style.width = `${ ( pct * 100 ).toFixed( 1 ) }%`;
		if ( boostActivateBtn ) boostActivateBtn.disabled = pct < 0.25;

	}

	function tryActivateArcadeBoost() {

		if ( ! arcadeBoostInstalled || boostMeter < 25 ) return false;
		boostMeter = Math.max( 0, boostMeter - 25 );
		applyBoostFor( vehicle, ( value ) => {

			boostActiveUntil = value;

		}, particles );
		updateArcadeBoostUi();
		return true;

	}

	function applyBoostFor( targetVehicle, setBoostActiveUntil, targetParticles = null, now = timer.getElapsed() ) {

		if ( ! targetVehicle?.rigidBody ) return;
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_VELOCITY_DELTA,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_VELOCITY_DELTA,
		] );
		setBoostActiveUntil( now + BOOST_FORCE_SECONDS );
		targetParticles?.triggerBoostFx( Math.max( BOOST_EFFECT_SECONDS, BOOST_FORCE_SECONDS ) );
                targetVehicle.setWheelieActive?.( true );

	}

	function updateActiveBoost( targetVehicle, boostActiveUntil, dt, now = timer.getElapsed() ) {

		if ( ! targetVehicle?.rigidBody ) return;
		if ( now >= boostActiveUntil ) {
                targetVehicle.setWheelieActive?.( false );
                return;
            }
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_ACCEL_PER_SECOND * dt,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_ACCEL_PER_SECOND * dt,
		] );

	}

	function applySurfaceBounceFor( targetVehicle ) {

		if ( ! isVehicleOnGround( targetVehicle ) ) return false;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vel[ 0 ], Math.max( vel[ 1 ], 0 ) + BOUNCE_VERTICAL_DELTA, vel[ 2 ] ] );
		return true;

	}

	function applySurfaceKickFor( targetVehicle, direction ) {

		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const forwardLenSq = _boostForward.lengthSq();
		if ( forwardLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( forwardLenSq ) );
		const lateralX = - _boostForward.z * direction;
		const lateralZ = _boostForward.x * direction;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + lateralX * KICK_LATERAL_DELTA,
			vel[ 1 ],
			vel[ 2 ] + lateralZ * KICK_LATERAL_DELTA,
		] );
		return true;

	}

	function applyCustomSurfaceForceFor( targetVehicle, surfaceType ) {

		const conf = customSurfaceConfigs?.[ surfaceType ];
		if ( ! conf ) return false;
		if ( conf.noAir && ! isVehicleOnGround( targetVehicle ) ) return false;
		const amount = Math.max( 0, Number( conf.forceAmount ) || 0 );
		if ( amount <= 0 ) return false;
		const force = conf.force || {};
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		if ( _boostForward.lengthSq() < 1e-6 ) _boostForward.set( 0, 0, 1 );
		_boostForward.normalize();
		const sideX = - _boostForward.z;
		const sideZ = _boostForward.x;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		const nextVel = [ vel[ 0 ], vel[ 1 ], vel[ 2 ] ];
		if ( force.forward ) {

			nextVel[ 0 ] += _boostForward.x * amount;
			nextVel[ 2 ] += _boostForward.z * amount;

		}
		if ( force.backward ) {

			nextVel[ 0 ] -= _boostForward.x * amount;
			nextVel[ 2 ] -= _boostForward.z * amount;

		}
		if ( force.left ) {

			nextVel[ 0 ] -= sideX * amount;
			nextVel[ 2 ] -= sideZ * amount;

		}
		if ( force.right ) {

			nextVel[ 0 ] += sideX * amount;
			nextVel[ 2 ] += sideZ * amount;

		}
		if ( force.up ) nextVel[ 1 ] += amount;
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, nextVel );
		return true;

	}

	function applyMagnetForceFor( targetVehicle, dt ) {

		if ( ! targetVehicle?.rigidBody || magnetEntries.length === 0 ) return;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		let nextVelX = vel[ 0 ];
		let nextVelY = vel[ 1 ];
		let nextVelZ = vel[ 2 ];
		let changed = false;
		for ( const magnet of magnetEntries ) {

			_magnetDelta.set( magnet.centerX - targetVehicle.spherePos.x, magnet.centerY - targetVehicle.spherePos.y, magnet.centerZ - targetVehicle.spherePos.z );
			const distance = _magnetDelta.length();
			if ( distance <= 1e-4 || distance > magnet.maxDistance ) continue;
			_magnetDir.copy( _magnetDelta ).multiplyScalar( 1 / distance );
			if ( magnet.kind === 'red' ) _magnetDir.multiplyScalar( - 1 );
			let strengthScale = 0;
			if ( distance <= magnetFullStrengthDistance ) strengthScale = 1;
			else {

				const t = THREE.MathUtils.clamp(
					( distance - magnetFullStrengthDistance ) / Math.max( 1e-6, magnet.maxDistance - magnetFullStrengthDistance ),
					0,
					1
				);
				// Curved falloff: stays stronger for longer, then fades to zero at max range.
				strengthScale = Math.pow( 1 - t, 1.6 );

			}
			const impulse = magnet.forcePerSecond * strengthScale * dt;
			nextVelX += _magnetDir.x * impulse;
			nextVelY += _magnetDir.y * impulse;
			nextVelZ += _magnetDir.z * impulse;
			changed = true;

		}
		if ( changed ) rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ nextVelX, nextVelY, nextVelZ ] );

	}


	function applyGrappleSwingFor( targetVehicle, controlKeys = {}, dt = 0 ) {

		if ( ! targetVehicle?.rigidBody ) return;
		if ( ! grappleState.line ) {

			const geo = new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3(), new THREE.Vector3() ] );
			grappleState.line = new THREE.Line( geo, new THREE.LineBasicMaterial( { color: 0xd7b6ff, transparent: true, opacity: 0.9 } ) );
			scene.add( grappleState.line );

		}
		const wantsGrapple = Boolean( controlKeys?.Space );
		if ( ! wantsGrapple ) {

			grappleState.active = false;
			grappleState.anchor = null;
			grappleState.line.visible = false;
			return;

		}
		if ( ! grappleState.active ) {

			let best = null;
			let bestDist = Infinity;
			for ( const entry of grappleEntries ) {

				const dx = entry.centerX - targetVehicle.spherePos.x;
				const dy = entry.centerY - targetVehicle.spherePos.y;
				const dz = entry.centerZ - targetVehicle.spherePos.z;
				const dist = Math.hypot( dx, dy, dz );
				if ( dist < bestDist && dist <= entry.maxDistance ) {

					best = entry;
					bestDist = dist;

				}

			}
			if ( best ) {

				grappleState.active = true;
				grappleState.anchor = best;
				grappleState.ropeLength = Math.max( 1.6, bestDist * 0.95 );

			}

		}
		if ( ! grappleState.active || ! grappleState.anchor ) {

			grappleState.line.visible = false;
			return;

		}
		const anchor = grappleState.anchor;
		const dx = anchor.centerX - targetVehicle.spherePos.x;
		const dy = anchor.centerY - targetVehicle.spherePos.y;
		const dz = anchor.centerZ - targetVehicle.spherePos.z;
		const distance = Math.hypot( dx, dy, dz );
		if ( distance > anchor.maxDistance * 1.35 ) {

			grappleState.active = false;
			grappleState.anchor = null;
			grappleState.line.visible = false;
			return;

		}
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		const dirX = dx / Math.max( 1e-5, distance );
		const dirY = dy / Math.max( 1e-5, distance );
		const dirZ = dz / Math.max( 1e-5, distance );
		if ( distance > grappleState.ropeLength ) {

			const pull = ( distance - grappleState.ropeLength ) * ( 7.5 + Math.min( 8, distance ) ) * dt;
			vel[ 0 ] += dirX * pull;
			vel[ 1 ] += dirY * pull;
			vel[ 2 ] += dirZ * pull;

		}
		targetVehicle.rigidBody.motionProperties.linearVelocity = vel;
		grappleState.line.visible = true;
		grappleState.line.geometry.setFromPoints( [
			new THREE.Vector3( targetVehicle.spherePos.x, targetVehicle.spherePos.y + 0.3, targetVehicle.spherePos.z ),
			new THREE.Vector3( anchor.centerX, anchor.centerY, anchor.centerZ ),
		] );

	}

	function setArcLinkHud( text ) {

		if ( ! arcLinkUi ) return;
		if ( ! text ) {

			arcLinkUi.style.display = 'none';
			return;

		}
		arcLinkUi.style.display = 'block';
		arcLinkUi.textContent = text;

	}

	function applyArcLinkFor( targetVehicle, state ) {

		const currentState = state && typeof state === 'object'
			? state
			: { contactKey: null, lockUntilExit: false };
		if ( ! targetVehicle?.rigidBody || arcLinkEntries.length === 0 ) return currentState;
		let nextContactKey = null;
		let triggeredEntry = null;
		for ( const entry of arcLinkEntries ) {

			if ( entry.color !== 'orange' && entry.color !== 'portal-purple' ) continue;

			const dx = entry.centerX - targetVehicle.spherePos.x;
			const dy = entry.centerY - targetVehicle.spherePos.y;
			const dz = entry.centerZ - targetVehicle.spherePos.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			if ( distSq > ARC_LINK_TRIGGER_RADIUS * ARC_LINK_TRIGGER_RADIUS ) continue;
			nextContactKey = `arc:${ entry.linkId }:${ entry.color }:${ entry.gx },${ entry.gz }`;
			triggeredEntry = entry;
			break;

		}
		if ( ! nextContactKey ) return { contactKey: null, lockUntilExit: false };
		if ( currentState.lockUntilExit ) return { contactKey: nextContactKey, lockUntilExit: true };
		if ( currentState.contactKey === nextContactKey ) return { contactKey: nextContactKey, lockUntilExit: false };
		const pairCandidates = ( arcEntriesById.get( triggeredEntry.linkId ) || [] )
			.filter( ( candidate ) => candidate !== triggeredEntry );
		const pair = triggeredEntry.color === 'portal-purple'
			? pairCandidates.find( ( candidate ) => candidate.color === 'portal-yellow' )
			: pairCandidates.find( ( candidate ) => candidate.color === 'green' );
		if ( ! pair ) {

			const missingLabel = triggeredEntry.color === 'portal-purple' ? 'yellow portal endpoint' : 'green endpoint';
			setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: missing ${ missingLabel }` );
			return { contactKey: nextContactKey, lockUntilExit: false };

		}
		if ( triggeredEntry.color === 'portal-purple' ) {

			const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
			rigidBody.setPosition( world, targetVehicle.rigidBody, [ pair.centerX, pair.centerY, pair.centerZ ], false );
			rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vel[ 0 ], vel[ 1 ], vel[ 2 ] ] );
			targetVehicle.spherePos.set( pair.centerX, pair.centerY, pair.centerZ );
			targetVehicle.container.position.set( targetVehicle.spherePos.x, targetVehicle.spherePos.y - 0.5, targetVehicle.spherePos.z );
			setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: purple portal → ${ pair.color } endpoint (velocity kept)` );
				hasPrevFinishSample = false;
				lastLocalX = 0;
				lastLocalZ = 0;
				hasPrevFinishSample2 = false;
				lastLocalX2 = 0;
				lastLocalZ2 = 0;
			return { contactKey: nextContactKey, lockUntilExit: true };

		}
				hasPrevFinishSample = false;
				lastLocalX = 0;
				lastLocalZ = 0;
				hasPrevFinishSample2 = false;
				lastLocalX2 = 0;
				lastLocalZ2 =  0;
		const tx = pair.centerX - targetVehicle.spherePos.x;
		const ty = pair.centerY - targetVehicle.spherePos.y;
		const tz = pair.centerZ - targetVehicle.spherePos.z;
		const horizontal = Math.hypot( tx, tz );
		const travelTime = THREE.MathUtils.clamp( horizontal / 12, ARC_LINK_MIN_TIME, ARC_LINK_MAX_TIME );
		const gravityFactor = Number( targetVehicle?.rigidBody?.motionProperties?.gravityFactor ) || VEHICLE_BASE_GRAVITY_FACTOR;
		const gravity = 9.81 * gravityFactor;
		const vx = tx / travelTime;
		const vz = tz / travelTime;
		const vy = ( ty + 0.5 * gravity * travelTime * travelTime ) / travelTime;
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vx, vy, vz ] );
		setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: orange launch → green endpoint` );
		return { contactKey: nextContactKey, lockUntilExit: true };

	}

	// Contact-based ground detection. The legacy check hard-coded the FLAT
	// ground height (posY <= 0.62), so on elevated blocks (deck ~+3.75 world
	// units) the car read as permanently airborne — bounce pads and force-up
	// custom surfaces sat on elevated pieces triggered but never launched the
	// car, and trick pads could fire while simply driving. Now the ONLY ground
	// truth is physics: a short downward ray from the sphere center reports a
	// static hitbox directly below the car, at ANY height — flat road, elevated
	// deck, slope, custom geometry, all identical.
	// Depth 0.62 = resting on flat ground (sphere center -> collider surface);
	// the 0.95 budget covers slope contact geometry (the center-to-surface
	// distance grows with the surface angle, ~0.88 on a 45° face).
	const GROUND_TOUCH_DEPTH = 0.95;
	function isVehicleTouchingGroundBelow( targetVehicle ) {

		if ( ! targetVehicle?.spherePos ) return false;
		const probe = sampleGroundDepth( targetVehicle.spherePos.x, targetVehicle.spherePos.y, targetVehicle.spherePos.z );
		return Boolean( probe && probe.depth <= GROUND_TOUCH_DEPTH );

	}

	function isVehicleOnGround( targetVehicle ) {

		// Touching a hitbox below + not bouncing off it (the vertical-speed
		// gate keeps launch pads from re-triggering on the way up).
		if ( ! isVehicleTouchingGroundBelow( targetVehicle ) ) return false;
		const verticalSpeed = Math.abs( targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] ?? 999 );
		return verticalSpeed <= 1.1;

	}

	function isVehicleAirborne( targetVehicle ) {

		if ( ! targetVehicle ) return false;
		const verticalVel = targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] || 0;
		return ! isVehicleTouchingGroundBelow( targetVehicle ) || Math.abs( verticalVel ) > 0.35;

	}

	const SPECIAL_SURFACE_HANDLERS = {
		'surface-bounce': ( targetVehicle ) => applySurfaceBounceFor( targetVehicle ),
		'surface-kick-l': ( targetVehicle ) => applySurfaceKickFor( targetVehicle, - 1 ),
		'surface-kick-r': ( targetVehicle ) => applySurfaceKickFor( targetVehicle, 1 ),
	};

	// Built once: SPECIAL_SURFACE_HANDLERS and customSurfaceConfigs are both set at
	// load time, so the list of surface types to scan each frame is constant. Caching it
	// avoids Object.keys()/filter()/spread allocations every frame per vehicle.
	const SPECIAL_SURFACE_TYPES = [
		...Object.keys( SPECIAL_SURFACE_HANDLERS ),
		...Object.keys( customSurfaceConfigs || {} ).filter( ( key ) => key.startsWith( 'surface-custom-' ) ),
	];

	function applySpecialSurfacesFor( targetVehicle, contactState ) {

		for ( const surfaceType of SPECIAL_SURFACE_TYPES ) {

			const currentKey = findSurfaceContactKeyForType( targetVehicle, surfaceType );
			const previousKey = contactState.get( surfaceType ) || null;
			if ( currentKey ) {

				if ( previousKey !== currentKey ) {

					const triggered = SPECIAL_SURFACE_HANDLERS[ surfaceType ]
						? SPECIAL_SURFACE_HANDLERS[ surfaceType ]( targetVehicle )
						: applyCustomSurfaceForceFor( targetVehicle, surfaceType );
					const oncePerContact = Boolean( customSurfaceConfigs?.[ surfaceType ]?.oncePerContact );
					if ( triggered ) {

						// Once-per-contact surfaces consume their trigger on an
						// ACTUAL hit only. A declined pass (car airborne over the
						// cell, e.g. a spawn drop or a fly-over) must NOT burn the
						// once-per-contact slot — the surface stays armed and fires
						// the moment the car is touching a hitbox below it on that
						// cell. (It used to mark itself consumed while airborne,
						// leaving noAir force pads permanently dead.)
						if ( oncePerContact || SPECIAL_SURFACE_HANDLERS[ surfaceType ] ) contactState.set( surfaceType, currentKey );
						else contactState.delete( surfaceType );

					} else {

						contactState.delete( surfaceType );

					}

				}

			} else {

				contactState.delete( surfaceType );

			}

		}

	}

	respawnBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		respawnVehicle();
		advancementEvents.emit('player_respawned', { source: 'respawn_button' });
		dispatchRuntimeModEvent( 'onRespawn', { type: 'respawn', source: 'respawn_button' } );

	} );
	modeMenuBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		e.stopPropagation();
		setModeMenuOpen( ! modeMenuOpen );

	} );
	document.addEventListener( 'click', ( e ) => {

		if ( ! modeMenuOpen || ! modeMenu ) return;
		const target = e.target;
		if ( modeMenu.contains( target ) || modeMenuBtn?.contains( target ) || target?.closest?.( '[data-mobile-click="mode-menu-btn"]' ) ) return;
		setModeMenuOpen( false );

	} );
	pauseToggleBtn?.addEventListener( 'click', () => togglePaused() );
	hacksToggleLink?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		if ( ! hacksInstalled ) {

			window.alert( 'Install the Hacks mod from Mod Manager first.' );
			return;

		}
		if ( ! hacksPanel ) return;
		hacksPanel.style.display = hacksPanel.style.display === 'block' ? 'none' : 'block';

	} );

	function bindHackControl( node, applyFn ) {

		if ( ! node ) return;
		node.addEventListener( 'input', () => {

			applyFn();
			saveHacksState();
			applyHitboxHackVisuals();
			applyVehiclePerformance();
			updateEconomyHud();

		} );
		node.addEventListener( 'change', () => {

			applyFn();
			saveHacksState();
			applyHitboxHackVisuals();
			applyVehiclePerformance();
			updateEconomyHud();

		} );

	}

	bindHackControl( hackEnableInput, () => hacksState.enabled = Boolean( hackEnableInput?.checked ) );
	bindHackControl( hackInfiniteCoinsInput, () => hacksState.infiniteCoins = Boolean( hackInfiniteCoinsInput?.checked ) );
	bindHackControl( hackBoostAnywhereInput, () => hacksState.boostAnywhere = Boolean( hackBoostAnywhereInput?.checked ) );
	bindHackControl( hackNoLimitsInput, () => hacksState.noLimits = Boolean( hackNoLimitsInput?.checked ) );
	bindHackControl( hackAlwaysNitroInput, () => hacksState.alwaysNitro = Boolean( hackAlwaysNitroInput?.checked ) );
	bindHackControl( hackSuperJumpInput, () => hacksState.superJump = Boolean( hackSuperJumpInput?.checked ) );
	bindHackControl( hackTeleportInput, () => hacksState.teleportForward = Boolean( hackTeleportInput?.checked ) );
	bindHackControl( hackLowFrictionInput, () => hacksState.lowFriction = Boolean( hackLowFrictionInput?.checked ) );
	bindHackControl( hackInstantStopInput, () => hacksState.instantStop = Boolean( hackInstantStopInput?.checked ) );
	bindHackControl( hackCheckpointBypassInput, () => hacksState.checkpointBypass = Boolean( hackCheckpointBypassInput?.checked ) );
	bindHackControl( hackShowHitboxesInput, () => hacksState.showHitboxes = Boolean( hackShowHitboxesInput?.checked ) );
	bindHackControl( hackTimescaleInput, () => hacksState.timeScale = THREE.MathUtils.clamp( Number( hackTimescaleInput?.value ) || 1, 0.15, 1 ) );
	bindHackControl( hackGravityInput, () => hacksState.gravity = THREE.MathUtils.clamp( Number( hackGravityInput?.value ) || 1, 0.1, 2 ) );
	bindHackControl( hackRoadGripInput, () => hacksState.roadGrip = THREE.MathUtils.clamp( Number( hackRoadGripInput?.value ) || 1, 0.5, 3 ) );
	hackResetBtn?.addEventListener( 'click', () => resetHacksState() );
	boostActivateBtn?.addEventListener( 'click', () => tryActivateArcadeBoost() );

	// ---- Video Recorder (official mod) -------------------------------------
	// Only the recorder UI is gated on `videoRecorderInstalled`; the recorder
	// engine itself (js/VideoRecorder.js) needs the renderer canvas + AudioContext
	// so it's wired here directly rather than run through the sandboxed mod runtime.
	const vrBtn = document.getElementById( 'video-recorder-btn' );
	const vrPanel = document.getElementById( 'video-recorder-panel' );
	const vrStatus = document.getElementById( 'vr-status' );
	const vrStartBtn = document.getElementById( 'vr-start-btn' );
	const vrStopBtn = document.getElementById( 'vr-stop-btn' );
	const vrCloseBtn = document.getElementById( 'vr-close-btn' );
	const vrFpsSel = document.getElementById( 'vr-fps' );
	const vrQualitySel = document.getElementById( 'vr-quality' );
	const vrFormatSel = document.getElementById( 'vr-format' );
	const vrPrefixInput = document.getElementById( 'vr-prefix' );
	const vrAudioInput = document.getElementById( 'vr-audio' );
	const vrHideUiInput = document.getElementById( 'vr-hide-ui' );
	const vrHideGroupsEl = document.getElementById( 'vr-hide-groups' );
	const vrDebugEl = document.getElementById( 'vr-debug' );
	const vrCopyDebugBtn = document.getElementById( 'vr-copy-debug-btn' );
	const vrClearDebugBtn = document.getElementById( 'vr-clear-debug-btn' );
	const vrDownloadBtn = document.getElementById( 'vr-download-btn' );

	let videoRecorder = null;
	if ( videoRecorderInstalled ) {
		videoRecorder = new VideoRecorder( {
			canvas: renderer.domElement,
			getAudioContext: () => window.__gameAudio?.listener?.context || null,
			getMusicElement: () => window.__gameAudio?.musicElement || null,
			getMessage: ( text, live ) => {
				if ( vrStatus ) { vrStatus.textContent = String( text || '' ); vrStatus.classList.toggle( 'live', Boolean( live ) ); }
				// finalize() updates status after the async onstop fires; refresh
				// button states so the Download button appears once a recording is ready.
				if ( ! live ) vrRefreshButtonState?.();
			},
			onDebug: ( line ) => {
				if ( ! vrDebugEl ) return;
				vrDebugEl.textContent += ( vrDebugEl.textContent ? '\n' : '' ) + line;
				vrDebugEl.scrollTop = vrDebugEl.scrollHeight;
			},
		} );
		if ( vrBtn ) vrBtn.style.display = 'block'; // CSS default is display:none; '' would revert to hidden
		// Build the "UI to hide" checkboxes from the shared group list.
		if ( vrHideGroupsEl ) {
			vrHideGroupsEl.innerHTML = '';
			for ( const group of UI_TOGGLE_GROUPS ) {
				const lab = document.createElement( 'label' );
				const cb = document.createElement( 'input' );
				cb.type = 'checkbox';
				cb.value = group.key;
				cb.checked = Boolean( videoRecorder.settings.hideGroups[ group.key ] );
				lab.appendChild( cb );
				lab.appendChild( document.createTextNode( group.label ) );
				vrHideGroupsEl.appendChild( lab );
			}
		}
		// Populate controls from persisted settings.
		if ( vrFpsSel ) vrFpsSel.value = String( videoRecorder.settings.fps );
		if ( vrQualitySel ) vrQualitySel.value = String( videoRecorder.settings.bitrate );
		if ( vrFormatSel ) vrFormatSel.value = String( videoRecorder.settings.mimeType );
		if ( vrPrefixInput ) vrPrefixInput.value = String( videoRecorder.settings.filenamePrefix || '' );
		if ( vrAudioInput ) vrAudioInput.checked = Boolean( videoRecorder.settings.captureAudio );
		if ( vrHideUiInput ) vrHideUiInput.checked = Boolean( videoRecorder.settings.hideUiWhileRecording );
	}

	function vrSyncSettings() {
		if ( ! videoRecorder ) return;
		const hideGroups = {};
		vrHideGroupsEl?.querySelectorAll( 'input[type="checkbox"]' ).forEach( ( cb ) => {
			hideGroups[ cb.value ] = cb.checked;
		} );
		videoRecorder.updateSettings( {
			fps: Number( vrFpsSel?.value ) || 60,
			bitrate: Number( vrQualitySel?.value ) || 12_000_000,
			mimeType: vrFormatSel?.value || 'auto',
			filenamePrefix: ( vrPrefixInput?.value || 'racing-gameplay' ).trim() || 'racing-gameplay',
			captureAudio: Boolean( vrAudioInput?.checked ),
			hideUiWhileRecording: Boolean( vrHideUiInput?.checked ),
			hideGroups,
		} );
	}
	[ vrFpsSel, vrQualitySel, vrFormatSel, vrPrefixInput, vrAudioInput, vrHideUiInput ].forEach( ( el ) => {
		el?.addEventListener( 'change', vrSyncSettings );
		el?.addEventListener( 'input', vrSyncSettings );
	} );
	vrHideGroupsEl?.addEventListener( 'change', vrSyncSettings );

	function vrRefreshButtonState() {
		if ( ! videoRecorder || ! vrBtn ) return;
		const rec = videoRecorder.isRecording();
		vrBtn.classList.toggle( 'recording', rec );
		vrBtn.textContent = rec ? '⏹ Recording…' : '⏺ Recorder';
		// Use explicit display values: these buttons have CSS display:none
		// defaults, so setting '' would revert them to hidden.
		if ( vrStartBtn ) vrStartBtn.style.display = rec ? 'none' : 'block';
		if ( vrStopBtn ) vrStopBtn.style.display = rec ? 'block' : 'none';
		// Show the Download button only when a finished recording is available.
		if ( vrDownloadBtn ) vrDownloadBtn.style.display = ( ! rec && videoRecorder.lastBlob ) ? 'block' : 'none';
	}
	vrBtn?.addEventListener( 'click', () => {
		if ( ! videoRecorder ) return;
		if ( ! vrPanel ) return;
		vrPanel.style.display = vrPanel.style.display === 'block' ? 'none' : 'block';
		vrRefreshButtonState();
	} );
	vrCloseBtn?.addEventListener( 'click', () => { if ( vrPanel ) vrPanel.style.display = 'none'; } );
	vrCopyDebugBtn?.addEventListener( 'click', () => {
		const text = videoRecorder ? videoRecorder.getDebugLog() : ( vrDebugEl?.textContent || '' );
		try {
			if ( navigator.clipboard?.writeText ) navigator.clipboard.writeText( text ).then( () => showTopMessage( 'Debug log copied to clipboard', false, 1500 ) );
			else { const ta = document.createElement( 'textarea' ); ta.value = text; document.body.appendChild( ta ); ta.select(); document.execCommand( 'copy' ); ta.remove(); showTopMessage( 'Debug log copied', false, 1500 ); }
		} catch { showTopMessage( 'Could not copy debug log', true, 1500 ); }
	} );
	vrClearDebugBtn?.addEventListener( 'click', () => {
		if ( videoRecorder ) videoRecorder._debugLines = [];
		if ( vrDebugEl ) vrDebugEl.textContent = '';
	} );
	vrDownloadBtn?.addEventListener( 'click', () => {
		if ( ! videoRecorder ) return;
		const ok = videoRecorder.downloadLast();
		showTopMessage( ok ? 'Recording download started' : 'No recording to download yet', ! ok, 1800 );
	} );
	vrStartBtn?.addEventListener( 'click', async () => {
		if ( ! videoRecorder ) return;
		vrSyncSettings();
		if ( vrDebugEl ) vrDebugEl.textContent = ''; // fresh log per recording
		showTopMessage( 'Pick this tab in the share prompt to capture the game + UI', false, 4000 );
		const ok = await videoRecorder.start();
		vrRefreshButtonState();
		if ( ok ) {
			if ( vrPanel ) vrPanel.style.display = 'none'; // hide panel so it isn't in the video
			showTopMessage( videoRecorder.captureMode === 'display'
				? '⏺ Recording (tab + UI). Alt+R / Stop to finish'
				: '⏺ Recording (canvas only — UI hidden). Alt+R to stop', false, 2600 );
		} else {
			showTopMessage( 'Recording failed to start — see panel', true, 3000 );
			// Reopen the panel so the user can read the debug log on failure.
			if ( vrPanel ) vrPanel.style.display = 'block';
		}
	} );
	vrStopBtn?.addEventListener( 'click', () => {
		if ( ! videoRecorder ) return;
		videoRecorder.stop();
		vrRefreshButtonState();
		showTopMessage( '⏹ Stopping… preparing video (see panel)', false, 2200 );
		// Reopen the panel so the debug log + Download button are visible.
		if ( vrPanel ) vrPanel.style.display = 'block';
	} );
	// Keyboard shortcut for the recorder is registered in the main keydown
	// handler (below) so it shares the same "don't fire while typing in an
	// input" guard as the other game shortcuts.
	// Stop recording if the page is about to unload so the file is finalized.
	window.addEventListener( 'beforeunload', () => { videoRecorder?.stop(); } );
	// End Video Recorder -----------------------------------------------------

	carSelect?.addEventListener( 'change', () => {

		const selectedKey = carSelect.value;
		updateCarSelectColor();
		if ( garageCarSelect ) garageCarSelect.value = selectedKey;
		if ( models[ selectedKey ] ) {

			vehicle.setModel( models[ selectedKey ] );
			applyCarCustomization( vehicle );
			applyHitboxHackVisuals( true );

		}
		updateGarageMappingsUi();
		renderGarageVehicleCards();
		setGarageMappingStatus( `Now editing mappings for ${ CAR_STATS[ selectedKey ]?.name || 'selected car' }.` );
		applyVehiclePerformance();
		broadcastPeerState();

	} );

	garageCarSelect?.addEventListener( 'change', () => {

		selectGarageCar( garageCarSelect.value );

	} );

	function onGarageSliderChange( key, value ) {

		const unlocks = getGarageUnlocks();
		if ( ! unlocks[ key ] ) return;
		garageMods[ key ] = clampGarageValue( value, 1.0 );
		saveGarageMods();
		updateGarageUi();

	}

	function unlockGaragePack( key ) {

		const pack = GARAGE_PACKS[ key ];
		if ( ! pack || garageUnlocked[ key ] ) return;
		if ( coins < pack.cost ) {

			window.alert( `Not enough coins for ${ pack.label }. Need ${ pack.cost }.` );
			return;

		}
		coins -= pack.cost;
		garageUnlocked[ key ] = true;
		saveEconomy();
		saveGarageMods();
		updateEconomyHud();
		updateGarageUi();

	}

	garageGripSlider?.addEventListener( 'input', () => onGarageSliderChange( 'grip', garageGripSlider.value ) );
	garageAccelSlider?.addEventListener( 'input', () => onGarageSliderChange( 'accel', garageAccelSlider.value ) );
	garageDriveSlider?.addEventListener( 'input', () => onGarageSliderChange( 'drive', garageDriveSlider.value ) );
	garageGripUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'grip' ) );
	garageAccelUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'accel' ) );
	garageDriveUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'drive' ) );
	garageDriveBtn?.addEventListener( 'click', () => setGarageDriveActive( ! garageDriveActive ) );
	window.addEventListener( 'keydown', ( event ) => {

		if ( ! modeMenuOpen || modeTab !== 'garage' ) return;
		if ( [ 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End' ].includes( event.code ) ) event.preventDefault();
		if ( ! garageDriveActive && [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].includes( event.code ) ) setGarageDriveActive( true );

	} );
	modeTabGameplayBtn?.addEventListener( 'click', () => setModeTab( 'gameplay' ) );
	modeTabGarageBtn?.addEventListener( 'click', () => setModeTab( 'garage' ) );
	modeTabAccountBtn?.addEventListener( 'click', () => setModeTab( 'account' ) );
	modeTabNavBtn?.addEventListener( 'click', () => setModeTab( 'nav' ) );
	for ( const button of graphicsQualityButtons ) {

		button.addEventListener( 'click', () => applyGraphicsQuality( button.dataset.graphicsQuality, true ) );

	}
	updateFpsHudVisibility();

	fpsToggle?.addEventListener( 'change', () => {

		fpsHudVisible = Boolean( fpsToggle.checked );
		localStorage.setItem( FPS_HUD_SETTINGS_KEY, fpsHudVisible ? '1' : '0' );
		try { GameSettings.patchSettings( { gameplay: { showFps: fpsHudVisible } } ); } catch ( e ) {}
		if ( fpsHudVisible ) {

			rollingFps = 0;
			fpsHudAccumulator = 0;

		}
		updateFpsHudVisibility();

	} );

	// ── Default car setting (Gameplay panel) ─────────────────────────────
	// '__last' keeps the current behavior (remember the car you drove last),
	// '__random' rolls a new car every race start, anything else is a CAR_STATS key.
	function applyDefaultCar( value ) {

		if ( ! value || value === '__last' ) return;
		if ( value === '__random' ) {

			randomizeLapCarIfSinglePlayer();
			return;

		}
		if ( ! CAR_STATS[ value ] ) return;
		if ( carSelect ) carSelect.value = value;
		updateCarSelectColor();
		if ( models[ value ] ) vehicle.setModel( models[ value ] );
		applyCarCustomization( vehicle );
		applyVehiclePerformance();

	}

	if ( defaultCarSelect ) {

		const options = [ '<option value="__last">Last used car (default)</option>', '<option value="__random">Random</option>' ];
		for ( const [ key, stats ] of Object.entries( CAR_STATS ) ) options.push( `<option value="${ key }">${ stats.name }</option>` );
		defaultCarSelect.innerHTML = options.join( '' );
		defaultCarSelect.value = localStorage.getItem( DEFAULT_CAR_KEY ) || '__last';

		defaultCarSelect.addEventListener( 'change', () => {

			const value = defaultCarSelect.value || '__last';
			localStorage.setItem( DEFAULT_CAR_KEY, value );
			applyDefaultCar( value );
			showTopMessage( value === '__random' ? 'Default car: random' : ( CAR_STATS[ value ] ? `Default car: ${ CAR_STATS[ value ].name }` : 'Default car: last used' ), false, 1800 );
			syncProfileToCloudDebounced();

		} );

	}

	garageTargetColorInput?.addEventListener( 'input', () => { updateGaragePaintControls(); refreshGarageViewer(); } );
	garageRepaintToleranceInput?.addEventListener( 'input', () => { updateGaragePaintControls(); } );
	garageClearSelectionBtn?.addEventListener( 'click', clearGarageSelection );
	garageApplyPaintBtn?.addEventListener( 'click', () => {

		const carKey = getSelectedGarageCarKey();
		const targetHex = String( garageTargetColorInput?.value || '#00aaff' ).toLowerCase();
		if ( ! /^#[0-9a-fA-F]{6}$/.test( targetHex ) ) return;
		const desc = describeGarageSelection();
		if ( ! desc || desc.count === 0 ) {

			setGarageMappingStatus( 'Select an area first by clicking a color on the car.', true );
			return;

		}
		if ( coins < GARAGE_REPAINT_COST ) {

			setGarageMappingStatus( `Need ${ GARAGE_REPAINT_COST } coins to repaint.`, true );
			return;

		}
		const sourceHex = desc.hex;
		const tolerance = desc.tolerance;
		const customPaintId = `custom-${ targetHex.slice( 1 ) }`;
		if ( ! GARAGE_PAINT_PALETTE.some( ( paint ) => paint.id === customPaintId ) ) {

			GARAGE_PAINT_PALETTE.push( { id: customPaintId, hex: targetHex, unlockCost: 0, finish: 'matte' } );

		}
		garageCosmetics.unlockedPaints[ customPaintId ] = true;
		const carData = getGarageCosmeticCar( carKey );
		// Encode the selected region as a compact RLE mask (local-only; not sent to ghosts/multiplayer).
		const maskRle = encodeSelectionMaskRle( garageSelectionMask );
		const mw = garageSelectionSource ? garageSelectionSource.width : 0;
		const mh = garageSelectionSource ? garageSelectionSource.height : 0;
		// Only fold into an existing mapping when the CLICKED SOURCE COLOR matches it
			// (previously "mapping.mask ||" matched any masked mapping first, so every
			// new masked repaint silently overwrote an older masked region).
			const existing = carData.mappings.find( ( mapping ) => colorDistanceSqHex( mapping.sourceHex, sourceHex ) <= tolerance * tolerance );
		if ( existing ) {

			existing.sourceHex = sourceHex;
			existing.targetColorId = customPaintId;
			existing.tolerance = tolerance;
			existing.mask = maskRle;
			existing.maskW = mw;
			existing.maskH = mh;

		} else {

			carData.mappings.push( { sourceHex, targetColorId: customPaintId, tolerance, mask: maskRle, maskW: mw, maskH: mh } );

		}
		if ( carData.mappings.length > 48 ) carData.mappings.shift();
		coins -= GARAGE_REPAINT_COST;
		saveEconomy();
		saveGarageMods();
		updateEconomyHud();
		selectedGarageSourceHex = '';
		hoveredGarageSourceHex = '';
		garageSelectionMask = null;
		applyCarCustomization( vehicle );
		if ( garageDriveActive && garageVehicle ) applyCarCustomizationToObject( garageVehicle.container, carKey );
		refreshGarageViewer();
		refreshGarageCardPreviewPaint( carKey );
		// List + card counts refresh LAST, after every state mutation, so the
		// new paint map is always visible right away (no card round-trip needed).
		updateGarageMappingsUi();
		updateGaragePaintControls();
		updateGarageCardMeta( carKey );
		broadcastPeerState();
		setGarageMappingStatus( `Painted ${ desc.count.toLocaleString() } pixels ${ targetHex } for ${ GARAGE_REPAINT_COST } coins.` );
		if ( gameMode === 'campaign' ) incrementCampaignProgress( 'customize-car' );

	} );


	exportGhostBtn?.addEventListener( 'click', async () => {

		const code = createGhostExportCode();
		if ( ! code ) {

			window.alert( 'No ghost data yet. Finish a lap first, then export.' );
			return;

		}
		openGhostCodeTab( code );

	} );

	importGhostBtn?.addEventListener( 'click', () => {

		importGhostIntoNewTab();

	} );
	raceModeBtn?.addEventListener( 'click', () => {

		setGameMode( 'race' );
		setModeMenuOpen( false );

	} );
	stuntModeBtn?.addEventListener( 'click', () => {

		setGameMode( 'stunt' );
		setModeMenuOpen( false );

	} );
	campaignModeBtn?.addEventListener( 'click', async () => {

		setGameMode( 'campaign' );
		setModeMenuOpen( false );
		await startCampaignChallenge();

	} );
	campaignInfoBtn?.addEventListener( 'click', () => {
		window.location.href = 'campaign.html';
	} );
	accountSignupBtn?.addEventListener( 'click', async () => {

		try {

			await signupAccount();

		} catch ( e ) {

			setAccountStatus( e.message || 'Sign up failed.', true );

		}

	} );
	accountLoginBtn?.addEventListener( 'click', async () => {

		try {

			await loginAccount();

		} catch ( e ) {

			setAccountStatus( e.message || 'Login failed.', true );

		}

	} );
	accountCloudSaveBtn?.addEventListener( 'click', async () => {

		try {

			await cloudSaveProfile();

		} catch ( e ) {

			setAccountStatus( e.message || 'Cloud save failed.', true );

		}

	} );
	accountCloudLoadBtn?.addEventListener( 'click', async () => {

		try {

			await cloudLoadProfile();

		} catch ( e ) {

			setAccountStatus( e.message || 'Cloud load failed.', true );

		}

	} );

	const storedPlayerName = sanitizePlayerName( localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	if ( playerNameInput ) playerNameInput.value = storedPlayerName;
	if ( namePopupInput ) namePopupInput.value = storedPlayerName;
	try {

		const rawSession = localStorage.getItem( ACCOUNT_SESSION_KEY );
		if ( rawSession ) {

			const parsedSession = JSON.parse( rawSession );
			if ( parsedSession?.token && parsedSession?.username ) {

				accountSession = {
					username: String( parsedSession.username ),
					token: String( parsedSession.token ),
				};

			}

		}

	} catch ( e ) {

		accountSession = null;

	}
	updateAccountUi();
	leaderboardToggleBtn?.addEventListener( 'click', () => {

		setLeaderboardVisible( ! leaderboardVisible );

	} );
	setLeaderboardVisible( true );
	playerNameInput?.addEventListener( 'change', () => {

		const sanitized = sanitizePlayerName( playerNameInput.value );
		playerNameInput.value = sanitized;
		localStorage.setItem( PLAYER_NAME_KEY, sanitized );

	} );
	namePopupSave?.addEventListener( 'click', async () => {

		const sanitized = sanitizePlayerName( namePopupInput?.value );
		if ( ! sanitized ) {

			window.alert( 'Please enter a name before submitting.' );
			return;

		}
		if ( playerNameInput ) playerNameInput.value = sanitized;
		localStorage.setItem( PLAYER_NAME_KEY, sanitized );
		const pendingTime = pendingLeaderboardRecord;
		closeNamePopup();
		pendingLeaderboardRecord = null;
		if ( Number.isFinite( pendingTime ) ) await submitLeaderboardTime( pendingTime, sanitized );

	} );
	namePopupSkip?.addEventListener( 'click', () => {

		pendingLeaderboardRecord = null;
		closeNamePopup();

	} );
	leaderboardRefreshBtn?.addEventListener( 'click', () => {
		fetchTrackLeaderboard();
	} );
	namePopup?.addEventListener( 'click', ( event ) => {

		if ( event.target === namePopup ) closeNamePopup();

	} );

	loadEconomy();
	loadRecentGhostHistory();
	loadHacksState();
	loadStuntStats();
	loadGarageMods();
	loadCampaignState();
	const garageParamEnabled = new URLSearchParams( window.location.search ).get( 'garage' ) === '1';
	setModeTab( garageParamEnabled ? 'garage' : 'gameplay' );
	initGarageViewer();
	if ( garageParamEnabled ) { setModeMenuOpen( true ); ensureGarageSelectionSource(); }
	if ( garageCarSelect ) garageCarSelect.value = currentCarKey();
	updateCarSelectColor();
	updateGarageUi();
	applyCarCustomization( vehicle );
	applyVehiclePerformance();
	updateEconomyHud();
	updateCampaignUi();
	loadLapStats();
	updateGhostShareButtons();
	updateModeHudVisibility();
	updatePauseUi();
	fetchTrackLeaderboard();
	setInterval( () => {

		if ( leaderboardVisible ) fetchTrackLeaderboard();

	}, 480000 );
	if ( campaignParamEnabled ) setGameMode( 'campaign' );
	// Default-car setting wins at boot: unset or '__random' rolls a fresh car
	// (the old boot behavior), a specific car locks it in, '__last' keeps
	// whatever the profile / page loaded.
	applyDefaultCar( localStorage.getItem( DEFAULT_CAR_KEY ) || '__random' );
	resetLapState( true );
	resetLapState2( true );
	startCountdown();

	const hashParams = new URLSearchParams( window.location.hash.startsWith( '#' ) ? window.location.hash.slice( 1 ) : window.location.hash );
	const importedGhost = hashParams.get( 'ghost' );
	if ( importedGhost ) {

		try {

			const payload = decodeGhostBinary( importedGhost ) || decodeBase64UrlJson( importedGhost );
			if ( applyImportedGhostPayload( payload ) ) {

				updateLapHud();

			}

		} catch ( e ) {

			console.warn( 'Failed to import ghost from URL hash', e );

		}

	}

	window.addEventListener( 'mousemove', ( e ) => {

		if ( ! freecamInstalled || ! freecamState.active ) return;
		const hasPointerLock = document.pointerLockElement === renderer.domElement;
		if ( ! hasPointerLock ) return;
		freecamState.yaw -= e.movementX * freecamState.mouseSensitivity;
		freecamState.pitch -= e.movementY * freecamState.mouseSensitivity;
		freecamState.pitch = THREE.MathUtils.clamp( freecamState.pitch, - Math.PI * 0.49, Math.PI * 0.49 );

	} );

	window.addEventListener( 'keydown', ( e ) => {

			const target = e.target;
			const isTypingTarget = target && (
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable
			);
			if ( isTypingTarget ) return;

			if ( ( e.code === 'Escape' || e.code === 'KeyP' ) && canPauseGameplay() ) {

				togglePaused();
				return;

			}

				if ( e.code === 'KeyE' ) {

					if ( hacksPanel?.style?.display === 'block' ) {

						hacksPanel.style.display = 'none';
						return;

					}

					setModeMenuOpen( ! modeMenuOpen );
					return;

			}

			if ( e.code === 'KeyH' ) {

				setUiHidden( ! uiHidden );
				return;

			}

			if ( e.code === 'Slash' && e.shiftKey ) {

				hudExtras?.toggleShortcuts();
				return;

			}

			if ( e.code === 'Escape' && hudExtras?.shortcutsOpen ) {

				hudExtras.toggleShortcuts( false );
				return;

			}

			if ( e.code === 'KeyC' ) {

				cam.toggleMode();
				return;

			}

			// Video Recorder toggle (only when the mod is installed). Alt+R keeps
			// it clear of the plain R = respawn shortcut and the browser reload.
			if ( videoRecorderInstalled && e.altKey && e.code === 'KeyR' ) {

				e.preventDefault();
				if ( videoRecorder.isRecording() ) {
					videoRecorder.stop();
					showTopMessage( '⏹ Stopping… preparing video (see panel)', false, 2200 );
				} else {
					vrSyncSettings(); // apply current checkbox/setting state before recording
					if ( vrDebugEl ) vrDebugEl.textContent = '';
					showTopMessage( 'Pick this tab in the share prompt to capture the game + UI', false, 4000 );
					void videoRecorder.start().then( ( ok ) => {
						showTopMessage( ok ? '⏺ Recording started (Alt+R to stop)' : 'Recording failed to start', ! ok, 2200 );
					} );
				}
				vrRefreshButtonState();
				return;

			}

			if ( freecamInstalled && e.code === 'KeyF' ) {

				setFreecamActive( ! freecamState.active );
				return;

			}

				if ( e.code === 'KeyR' ) {

				respawnVehicle();
				return;

			}

			if ( e.code === 'KeyP' ) {

				respawnVehicle2();
				return;

			}

			if ( checkpointRespawnInstalled && e.code === 'KeyT' ) {

				respawnToLastCheckpoint();
				return;

			}

			if ( practiceStartInstalled && e.code === 'KeyY' ) {

				if ( e.shiftKey ) restorePracticeState();
				else savePracticeState();
				return;

			}

		} );

	let hudUpdateAccumulator = 0;

	// Shadow depth pass at up to ~110 Hz: per-frame at <=60 FPS (unchanged
	// behavior), every 2nd/3rd frame at high refresh rates. The sun and all
	// scenery are static, and the fastest mover — the car — still gets its
	// shadow refreshed >100 times a second, more often than the old every-
	// frame-at-60-FPS behavior. Mode changes that relocate the camera/car
	// set shadowMap.needsUpdate themselves and bypass this gate.
	const SHADOW_REFRESH_MIN_MS = 9;
	let _shadowRefreshLastMs = -9999;
	function refreshShadowsIfNeeded() {

		const nowMs = performance.now();
		if ( nowMs - _shadowRefreshLastMs < SHADOW_REFRESH_MIN_MS ) return;
		_shadowRefreshLastMs = nowMs;
		renderer.shadowMap.needsUpdate = true;

	}

	function renderFrame() {

		if ( isSplitScreen && cam2 ) {

			const width = window.innerWidth;
			const height = window.innerHeight;
			const halfH = Math.floor( height / 2 );

			refreshShadowsIfNeeded();
			prerenderWaterRefraction( renderer, scene, cam.camera, 0, { x: 0, y: halfH, w: width, h: height - halfH } );
			renderer.setScissorTest( true );
			cam.camera.aspect = width / Math.max( 1, halfH );
			cam.camera.updateProjectionMatrix();
			renderer.setViewport( 0, halfH, width, height - halfH );
			renderer.setScissor( 0, halfH, width, height - halfH );
			renderer.render( scene, cam.camera );

			cam2.camera.aspect = width / Math.max( 1, halfH );
			cam2.camera.updateProjectionMatrix();
			renderer.setViewport( 0, 0, width, halfH );
			renderer.setScissor( 0, 0, width, halfH );
			prerenderWaterRefraction( renderer, scene, cam2.camera, 1, { x: 0, y: 0, w: width, h: halfH } );
			renderer.render( scene, cam2.camera );
			renderer.setScissorTest( false );

		} else {

			refreshShadowsIfNeeded();
			prerenderWaterRefraction( renderer, scene, cam.camera );
			renderer.render( scene, cam.camera );

		}
		hideLoadingOverlay();

	}

	// Reused temporaries for the per-frame speed-blur vignette projection so the
	// hot loop stays allocation-free.
	const _vignetteProjected = new THREE.Vector3();
	let _cssEffectAccumulator = 0;
	let _lastVignetteOpacity = '';
	let _lastVignetteX = '';
	let _lastVignetteY = '';

	let settingsAppliedThisBoot = false;
	function animate() {

		requestAnimationFrame( animate );

			// Safety net: re-apply persisted settings on the first render frame. The
			// boot call (applyLiveGameSettings at init) runs before the first frame,
			// but if any subsystem threw there the per-section guards let the others
			// through — this re-apply on the first live frame catches anything that
			// was skipped because an engine dependency wasn't ready at boot time.
			if ( ! settingsAppliedThisBoot ) {
				settingsAppliedThisBoot = true;
				try { applyLiveGameSettings( GameSettings.getSettings() ); } catch ( e ) {}
			}

			timer.update();
			const nowMs = performance.now();
			const realFrameSeconds = Math.max( 1 / 1000, ( nowMs - lastFrameNowMs ) / 1000 );
			lastFrameNowMs = nowMs;
			const frameSeconds = timer.getDelta();
			updateFpsHud( realFrameSeconds );
			const dtBase = Math.min( frameSeconds, 1 / 15 );
			if ( paused ) {

				audio.updateMusic( realFrameSeconds, false );
				if ( freecamState.active ) updateFreecam( realFrameSeconds );
				updateCloudFreecamFade( realFrameSeconds );
				renderFrame();
				return;

			}
			const hacksActive = hacksInstalled && hacksState.enabled;
			const hackTimeScale = hacksActive ? hacksState.timeScale : 1;
			const padScale1 = Number( activePadTimeScale ) || 1;
			const padScale2 = Number( activePadTimeScale2 ) || 1;
			const padTimeScale = ( padScale1 < 1 || padScale2 < 1 )
				? Math.min( padScale1, padScale2 )
				: Math.max( padScale1, padScale2 );
			const dt = dtBase * hackTimeScale * padTimeScale * customModTimeScale;
			raceClockSeconds += dt;
			const now = raceClockSeconds;

			updateWaterQuality( rollingFps );
			updateCountdownState( now );
			// Fire due auto-respawns on the game clock — deterministic even at
			// 20 FPS, where real-time timers fire arbitrarily late or never.
			if ( autoRespawnAtSeconds !== null && now >= autoRespawnAtSeconds ) {

				autoRespawnAtSeconds = null;
				respawnVehicle();

			}
			if ( autoRespawnAtSeconds2 !== null && vehicle2 && now >= autoRespawnAtSeconds2 ) {

				autoRespawnAtSeconds2 = null;
				respawnVehicle2();

			}
			const controlsBlocked = ( modeMenuOpen && ! garageDriveActive ) || replayViewerMode || countdownActive;
			let baseInput;
			if ( controlsBlocked ) baseInput = ZERO_DRIVE_INPUT;
			else if ( freecamState.active ) baseInput = readFreecamCarInput();
			else baseInput = controls.update();
			let input = baseInput;
			for ( const runtime of runtimeMods ) {

				if ( typeof runtime?.applyFrame !== 'function' ) continue;
				try {

					const result = runtime.applyFrame( { dt, input, controls, vehicle, world, now } );
					if ( result?.input ) input = result.input;

				} catch ( error ) {

					console.warn( `Mod applyFrame failed: ${ runtime?.id || 'unknown' }`, error );

				}

			}
			if ( countdownActive ) input = ZERO_DRIVE_INPUT;
			const input2 = controls2 ? ( modeMenuOpen || replayViewerMode || countdownActive ? ZERO_DRIVE_INPUT : controls2.update() ) : null;
			let padAdjustedInput = applyPadInputModifiers( input, activePadEffect );
			if ( customModNoSteerUntil > now ) padAdjustedInput = { ...padAdjustedInput, x: 0 };
			if ( customModForceBrakeUntil > now ) padAdjustedInput = { ...padAdjustedInput, z: - 1 };
			if ( customModForceThrottleUntil > now ) padAdjustedInput = { ...padAdjustedInput, z: 1 };
			const padAdjustedInput2 = input2 ? applyPadInputModifiers( input2, activePadEffect2 ) : null;
			if ( hacksActive && hacksState.infiniteCoins ) coins = Math.max( coins, 9999999 );
			if ( arcadeBoostInstalled ) {

				boostMeter = Math.min( BOOST_METER_MAX, boostMeter + dt * ( 7 + Math.abs( vehicle.linearSpeed ) * 14 ) );
				const boostKeyPressed = Boolean( controls?.keys?.KeyX );
				if ( boostKeyPressed && ! boostPressedLatch ) tryActivateArcadeBoost();
				boostPressedLatch = boostKeyPressed;
				updateArcadeBoostUi();

			} else boostPressedLatch = false;

		// Save velocity + horizontal speed before physics step
		let speed1Before = 0, speed2Before = 0;
		if ( vehicle?.rigidBody?.motionProperties ) {
			const v = vehicle.rigidBody.motionProperties.linearVelocity;
			seamSuppress.vy1 = v[ 1 ];
			_seamVel1[ 0 ] = v[ 0 ]; _seamVel1[ 1 ] = v[ 1 ]; _seamVel1[ 2 ] = v[ 2 ];
			speed1Before = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 2 ] * v[ 2 ] );
		}
		if ( vehicle2?.rigidBody?.motionProperties ) {
			const v2 = vehicle2.rigidBody.motionProperties.linearVelocity;
			seamSuppress.vy2 = v2[ 1 ];
			_seamVel2[ 0 ] = v2[ 0 ]; _seamVel2[ 1 ] = v2[ 1 ]; _seamVel2[ 2 ] = v2[ 2 ];
			speed2Before = Math.sqrt( v2[ 0 ] * v2[ 0 ] + v2[ 2 ] * v2[ 2 ] );
		}

		updateWorld( world, contactListener, dt );
		if ( garageDriveActive ) updateWorld( garageWorld, contactListener, dt );

		// Suppress seam bounces and detect real crashes based on speed loss.
		// Skip seam suppression while the car is on a slope cell: uphill driving
		// legitimately produces upward velocity that would otherwise trip the
		// seam-bounce detector and freeze the car (the grip-loss glitch).
		const onSlope1 = isVehicleOnSlopeCell( vehicle );
		const seam1 = garageDriveActive ? false : suppressSeamBounce( world, vehicle, '1', onSlope1 );
		const seam2 = vehicle2 ? suppressSeamBounce( world, vehicle2, '2', isVehicleOnSlopeCell( vehicle2 ) ) : false;

		if ( ! garageDriveActive && vehicle?.rigidBody?.motionProperties ) {
			const v = vehicle.rigidBody.motionProperties.linearVelocity;
			const speed1After = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 2 ] * v[ 2 ] );
			detectCrashFromSpeedLoss( vehicle, speed1Before, speed1After, seam1 );
		}
		if ( vehicle2?.rigidBody?.motionProperties ) {
			const v2 = vehicle2.rigidBody.motionProperties.linearVelocity;
			const speed2After = Math.sqrt( v2[ 0 ] * v2[ 0 ] + v2[ 2 ] * v2[ 2 ] );
			detectCrashFromSpeedLoss( vehicle2, speed2Before, speed2After, seam2 );
		}

			const wasDrifting = vehicle.driftIntensity > 0.25;
			vehicle.update( dt, garageDriveActive ? ZERO_DRIVE_INPUT : padAdjustedInput );
			if ( garageDriveActive && garageVehicle ) garageVehicle.update( dt, padAdjustedInput );
			const isDrifting = vehicle.driftIntensity > 0.25;
			if (!wasDrifting && isDrifting) advancementEvents.emit('drift_started', {});
			if (wasDrifting && !isDrifting) advancementEvents.emit('drift_ended', {});
			const speedDisplay = Math.abs(vehicle.linearSpeed) * 150;
			if (speedDisplay > (window.__advTopSpeed || 0)) { window.__advTopSpeed = speedDisplay; advancementEvents.emit('top_speed_updated', { speed: speedDisplay }); }
			if ( vehicle2 && padAdjustedInput2 ) vehicle2.update( dt, padAdjustedInput2 );
			applyRaycastSlopeVisual( vehicle );
			if ( vehicle2 ) applyRaycastSlopeVisual( vehicle2 );
			if ( carHitboxMesh.visible ) carHitboxMesh.position.set( vehicle.spherePos.x, vehicle.spherePos.y, vehicle.spherePos.z );
			if ( ! garageDriveActive ) applyMagnetForceFor( vehicle, dt );
			if ( vehicle2 ) applyMagnetForceFor( vehicle2, dt );
			applyGrappleSwingFor( vehicle, controls?.keys, dt );
			arcLinkState = applyArcLinkFor( vehicle, arcLinkState );
			if ( vehicle2 ) arcLinkState2 = applyArcLinkFor( vehicle2, arcLinkState2 );
			updateRemotePlayerVisualsFrame( dt );
			const gravityScale1 = Number.isFinite( activePadEffect?.gravity ) ? activePadEffect.gravity : 1.0;
			const gravityScale2 = Number.isFinite( activePadEffect2?.gravity ) ? activePadEffect2.gravity : 1.0;
			if ( vehicle?.rigidBody?.motionProperties ) {

				const waterScale = isCameraTargetInWater( vehicle.spherePos ) ? WATER_GRAVITY_SCALE : 1.0;
				// Near-ground gravity boost: 1.4x gravity when |Y velocity| < 1.5
				// (car is on/near a surface). Only applies near ground, NOT in air.
				const sphereVy1 = vehicle.rigidBody.motionProperties.linearVelocity[ 1 ];
				const nearGroundBoost1 = Math.abs( sphereVy1 ) < 1.5 ? 1.4 : 1.0;
				vehicle.rigidBody.motionProperties.gravityFactor = VEHICLE_BASE_GRAVITY_FACTOR * nearGroundBoost1 * gravityScale1 * customModGravityScale * ( hacksActive ? hacksState.gravity : 1.0 ) * waterScale;
				applyWaterPhysicsDamping( vehicle, dt );

			}
			if ( vehicle2?.rigidBody?.motionProperties ) {

				const waterScale2 = isCameraTargetInWater( vehicle2.spherePos ) ? WATER_GRAVITY_SCALE : 1.0;
				const sphereVy2 = vehicle2.rigidBody.motionProperties.linearVelocity[ 1 ];
				const nearGroundBoost2 = Math.abs( sphereVy2 ) < 1.5 ? 1.4 : 1.0;
				vehicle2.rigidBody.motionProperties.gravityFactor = VEHICLE_BASE_GRAVITY_FACTOR * nearGroundBoost2 * gravityScale2 * ( hacksActive ? hacksState.gravity : 1.0 ) * waterScale2;
				applyWaterPhysicsDamping( vehicle2, dt );

			}
			if ( hacksActive ) {

				if ( hacksState.boostAnywhere && controls?.keys?.KeyB && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					const boostDir = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
					vel[ 0 ] += boostDir.x * 0.85;
					vel[ 2 ] += boostDir.z * 0.85;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}

				if ( hacksState.alwaysNitro && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					const boostDir = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
					vel[ 0 ] += boostDir.x * 0.22;
					vel[ 2 ] += boostDir.z * 0.22;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.superJump && controls?.keys?.KeyJ && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					vel[ 1 ] = Math.max( vel[ 1 ], 4.2 );
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.instantStop && controls?.keys?.KeyV && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					vel[ 0 ] = 0;
					vel[ 2 ] = 0;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.teleportForward && vehicle?.rigidBody?.motionProperties ) {

					const trigger = Boolean( controls?.keys?.KeyG );
					if ( trigger && ! hackTeleportLatch ) {

						const fwd = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
						vehicle.spherePos.addScaledVector( fwd, 6.5 );
						rigidBody.setPosition( world, vehicle.rigidBody, vehicle.spherePos.toArray(), false );

					}
					hackTeleportLatch = trigger;

				}

			} else hackTeleportLatch = false;
			padContactKey = applyPadContact( vehicle, padContactKey, ( effect ) => {

				activePadEffect = effect;
				activePadTimeScale = Number.isFinite( effect?.timeScale ) ? effect.timeScale : 1;

			}, () => activePadEffect ) || null;
			activeSurfaceType = findActiveSurfaceTypeFor( vehicle );
			updateAirTrickStateFor( vehicle, activePadEffect, airTrickState, dt, () => {

				if ( ! activePadEffect?.trick ) return;
				const { trick, ...rest } = activePadEffect;
				activePadEffect = Object.keys( rest ).length ? rest : null;

			} );
			applySurfaceGrip( vehicle, activeSurfaceType, activePadEffect );
			applyVehicleScaleFromPad( vehicle, activePadEffect, carHitboxMesh );
			if ( activeSurfaceType && activeSurfaceType !== lastSurfaceNotifyType && ! activeSurfaceType.startsWith( 'pad-' ) ) showEffectPopup( `Effect applied: ${ activeSurfaceType.replace( /^surface-/, '' ).replace( /-/g, ' ' ) }` );
			lastSurfaceNotifyType = activeSurfaceType;
			if ( hacksActive && hacksState.checkpointBypass ) {

				for ( const checkpoint of checkpointStates ) checkpoint.passedThisLap = true;

			}
		if ( vehicle2 ) {

			padContactKey2 = applyPadContact( vehicle2, padContactKey2, ( effect ) => {

				activePadEffect2 = effect;
				activePadTimeScale2 = Number.isFinite( effect?.timeScale ) ? effect.timeScale : 1;

			}, () => activePadEffect2 ) || null;
			activeSurfaceType2 = findActiveSurfaceTypeFor( vehicle2 );
				updateAirTrickStateFor( vehicle2, activePadEffect2, airTrickState2, dt, () => {

					if ( ! activePadEffect2?.trick ) return;
					const { trick, ...rest } = activePadEffect2;
					activePadEffect2 = Object.keys( rest ).length ? rest : null;

				} );
			applySurfaceGrip( vehicle2, activeSurfaceType2, activePadEffect2 );
			applyVehicleScaleFromPad( vehicle2, activePadEffect2 );
			if ( activeSurfaceType2 && activeSurfaceType2 !== lastSurfaceNotifyType2 && ! activeSurfaceType2.startsWith( 'pad-' ) ) showEffectPopup( `Effect applied: ${ activeSurfaceType2.replace( /^surface-/, '' ).replace( /-/g, ' ' ) }` );
			lastSurfaceNotifyType2 = activeSurfaceType2;

		}
		updateActiveBoost( vehicle, boostActiveUntil, dt, now );
		if ( vehicle2 ) updateActiveBoost( vehicle2, boostActiveUntil2, dt, now );
		const activeBoostContactKey = findLegacyBoostContactKeyFor( vehicle ) || findBoostSurfaceContactKeyFor( vehicle );
		if ( activeBoostContactKey ) {

			if ( boostContactCell !== activeBoostContactKey ) {

				applyBoostFor( vehicle, ( value ) => {

					boostActiveUntil = value;

				}, particles, now );
				boostContactCell = activeBoostContactKey;
				if ( activeBoostContactKey !== lastBoostNotifyKey ) showEffectPopup( 'Effect applied: Boost' );
				lastBoostNotifyKey = activeBoostContactKey;

			}

		} else {

			boostContactCell = null;
			lastBoostNotifyKey = null;

		}

		applySpecialSurfacesFor( vehicle, specialSurfaceContactState );

		if ( vehicle2 ) {

			const activeBoostContactKey2 = findLegacyBoostContactKeyFor( vehicle2 ) || findBoostSurfaceContactKeyFor( vehicle2 );
			if ( activeBoostContactKey2 ) {

				if ( boostContactCell2 !== activeBoostContactKey2 ) {

					applyBoostFor( vehicle2, ( value ) => {

						boostActiveUntil2 = value;

					}, particles2, now );
					boostContactCell2 = activeBoostContactKey2;
					if ( activeBoostContactKey2 !== lastBoostNotifyKey2 ) showEffectPopup( 'Effect applied: Boost' );
					lastBoostNotifyKey2 = activeBoostContactKey2;

				}

			} else {

				boostContactCell2 = null;
				lastBoostNotifyKey2 = null;

			}

			applySpecialSurfacesFor( vehicle2, specialSurfaceContactState2 );

		}

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			// Height-tracking: keep the sun a constant +15 above the sphere so the
			// light vector is identical on elevated decks (+3.75) and in pool bowls
			// (-2.5) — a fixed Y rotated the vector as the car climbed/descended,
			// stretching shadows and drifting their intensity. The offset matches
			// the historical ground-level light (0 + 15 = 15).
			vehicle.spherePos.y + 15,
			vehicle.spherePos.z - 5.3
		);

		const cameraUnderwater = updateCameraUnderwater( cam.camera, dt );
		if ( freecamState.active ) scene.fog = null;
		else if ( cameraUnderwater ) scene.fog = underwaterFog;
		else if ( scene.fog !== gameplayFog ) scene.fog = gameplayFog;
		updateCloudFreecamFade( dt );
		if ( freecamState.active ) updateFreecam( dt );
		else if ( ! replayViewerMode ) {

			const shouldLockYaw = airTrickState.active && isVehicleAirborne( vehicle );
			if ( shouldLockYaw ) {

				if ( ! camYawLockActive ) {

					camYawLockEuler.setFromQuaternion( vehicle.container.quaternion, 'YXZ' );
					camYawLockValue = camYawLockEuler.y;
					camYawLockActive = true;

				}
				camYawLockQuat.setFromEuler( camYawLockEuler.set( 0, camYawLockValue, 0, 'YXZ' ) );
				_camDynamics1.speedRatio = Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ); _camDynamics1.driftIntensity = vehicle.driftIntensity; _camDynamics1.underwaterCamera = updateWaterCameraState( waterCameraState1, vehicle.spherePos, dt, ( pos ) => triggerWaterSplash( vehicle, pos ) );
				cam.update( dt, vehicle.spherePos, camYawLockQuat, _camDynamics1 );

			} else {

				camYawLockActive = false;
				_camDynamics1.speedRatio = Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ); _camDynamics1.driftIntensity = vehicle.driftIntensity; _camDynamics1.underwaterCamera = updateWaterCameraState( waterCameraState1, vehicle.spherePos, dt, ( pos ) => triggerWaterSplash( vehicle, pos ) );
				cam.update( dt, vehicle.spherePos, vehicle.container.quaternion, _camDynamics1 );

			}

		}
		if ( waterCells.length > 0 ) {

			if ( vehicle && isCameraTargetInWater( vehicle.spherePos ) ) {

				carBubblesFx ??= new CarBubblesFX( scene );
				carBubblesFx.update( dt, vehicle, true );

			} else carBubblesFx?.update( dt, vehicle, false );
			if ( vehicle2 && isCameraTargetInWater( vehicle2.spherePos ) ) {

				carBubblesFx2 ??= new CarBubblesFX( scene );
				carBubblesFx2.update( dt, vehicle2, true );

			} else carBubblesFx2?.update( dt, vehicle2, false );

		}
		if ( cam2 && vehicle2 ) {

			const shouldLockYaw2 = airTrickState2.active && isVehicleAirborne( vehicle2 );
			if ( shouldLockYaw2 ) {

				if ( ! camYawLockActive2 ) {

					camYawLockEuler2.setFromQuaternion( vehicle2.container.quaternion, 'YXZ' );
					camYawLockValue2 = camYawLockEuler2.y;
					camYawLockActive2 = true;

				}
				camYawLockQuat2.setFromEuler( camYawLockEuler2.set( 0, camYawLockValue2, 0, 'YXZ' ) );
				_camDynamics2.speedRatio = Math.abs( vehicle2.linearSpeed ) / Math.max( 0.01, vehicle2.topSpeed ); _camDynamics2.driftIntensity = vehicle2.driftIntensity; _camDynamics2.underwaterCamera = updateWaterCameraState( waterCameraState2, vehicle2.spherePos, dt, ( pos ) => triggerWaterSplash( vehicle2, pos ) );
				cam2.update( dt, vehicle2.spherePos, camYawLockQuat2, _camDynamics2 );

			} else {

				camYawLockActive2 = false;
				_camDynamics2.speedRatio = Math.abs( vehicle2.linearSpeed ) / Math.max( 0.01, vehicle2.topSpeed ); _camDynamics2.driftIntensity = vehicle2.driftIntensity; _camDynamics2.underwaterCamera = updateWaterCameraState( waterCameraState2, vehicle2.spherePos, dt, ( pos ) => triggerWaterSplash( vehicle2, pos ) );
				cam2.update( dt, vehicle2.spherePos, vehicle2.container.quaternion, _camDynamics2 );

			}

		}
		if ( customModParticleBurstSeconds > 0 ) {
			if ( particles && customModParticleColor ) particles.customColor = customModParticleColor;
			if ( particles2 && customModParticleColor ) particles2.customColor = customModParticleColor;
			particles?.triggerBoostFx?.( customModParticleBurstSeconds );
			customModParticleBurstSeconds = 0;
		} else if ( customModParticleColor ) {
			// Only override the default grey drift particles when a mod has actually
			// set a custom particle color; otherwise leave particles.customColor at
			// its default null so Particles.js uses DEFAULT_PARTICLE_COLOR.
			if ( particles ) particles.customColor = customModParticleColor;
			if ( particles2 ) particles2.customColor = customModParticleColor;
		} else {
			if ( particles ) particles.customColor = null;
			if ( particles2 ) particles2.customColor = null;
		}
		particles.update( dt, vehicle );
		waterSplashFx?.update( dt );
		particles2?.update( dt, vehicle2 );
		skidMarks.update( dt, vehicle );
		skidMarks.update( dt, vehicle2 );
		if ( ! homeLandingEl ) homeLandingEl = document.getElementById( 'home-landing' );
		audio.updateMusic( dt, ! homeLandingEl?.classList.contains( 'visible' ) && ! modeMenuOpen && ! replayViewerMode );
		audio.update( dt, vehicle.linearSpeed, padAdjustedInput.z, vehicle.driftIntensity );
		const speedRatioFx = THREE.MathUtils.clamp( Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ), 0, 1.8 );
		const driftFx = THREE.MathUtils.clamp( vehicle.driftIntensity, 0, 1 );
		if ( bloomPass ) {
			bloomPass.strength = cachedGraphicsPreset.bloomStrength + ( speedRatioFx * 0.01 ) + ( driftFx * 0.005 );
			bloomPass.radius = cachedGraphicsPreset.bloomRadius + ( speedRatioFx * 0.01 );
		}
		renderer.toneMappingExposure = THREE.MathUtils.lerp( renderer.toneMappingExposure, baseWeatherLight.exposure + ( speedRatioFx * 0.045 ), Math.min( 1, dt * 2.8 ) );
		if ( scene.fog ) {
			const nearBase = groundSize * weatherConfig.fogNearMul;
			const farBase = groundSize * weatherConfig.fogFarMul;
			scene.fog.near = THREE.MathUtils.lerp( scene.fog.near, nearBase * customModFogStrength * ( 1 - speedRatioFx * 0.08 ), Math.min( 1, dt * 3 ) );
			scene.fog.far = THREE.MathUtils.lerp( scene.fog.far, farBase * customModFogStrength * ( 1 + speedRatioFx * 0.06 ), Math.min( 1, dt * 3 ) );
		}
		const motionBlurPx = cachedGraphicsPreset.label === 'High'
			? Math.max( 0, ( speedRatioFx - 0.8 ) * 1.05 )
			: Math.max( 0, ( speedRatioFx - 0.96 ) * 0.7 );
		// The speed-driven saturation/contrast + vignette effects ramp smoothly with
		// velocity, so refreshing them ~12x/sec is visually identical to every-frame
		// but skips per-frame style invalidation and string formatting on the hot path.
		_cssEffectAccumulator += dt;
		const refreshCssEffects = _cssEffectAccumulator >= 0.08;
		if ( refreshCssEffects ) _cssEffectAccumulator = 0;
		// NOTE: the old saturate()/contrast() CSS filter on renderer.domElement
		// was removed — a style.filter on the WebGL canvas permanently kicks it
		// off Chrome's direct-presentation fast path and forces a fullscreen
		// compositor filter pass EVERY frame (even in menus), one of the biggest
		// hidden lag sources on integrated GPUs. The saturation ramp (1.08→1.14)
		// was imperceptible; the speed feel still comes from the exposure ramp
		// (toneMappingExposure, in-shader) and the vignette below.
		if ( speedBlurVignette ) {
			const projected = _vignetteProjected.copy( vehicle.spherePos ).project( cam.camera );
			const px = ( projected.x * 0.5 + 0.5 ) * 100;
			const py = ( - projected.y * 0.5 + 0.5 ) * 100;
			if ( refreshCssEffects ) {
				const xPct = `${ THREE.MathUtils.clamp( px, 8, 92 ).toFixed( 2 ) }%`;
				const yPct = `${ THREE.MathUtils.clamp( py, 12, 88 ).toFixed( 2 ) }%`;
				if ( xPct !== _lastVignetteX ) {

					speedBlurVignette.style.setProperty( '--car-x', xPct );
					_lastVignetteX = xPct;

				}
				if ( yPct !== _lastVignetteY ) {

					speedBlurVignette.style.setProperty( '--car-y', yPct );
					_lastVignetteY = yPct;

				}
				const opacity = motionBlurPx > 0.02 ? '1' : '0';
				if ( opacity !== _lastVignetteOpacity ) {

					speedBlurVignette.style.opacity = opacity;
					_lastVignetteOpacity = opacity;

				}
				// NOTE: the live backdrop-filter blur is gone — a fullscreen
				// backdrop-filter is the single most expensive compositor effect in
				// Chrome (fullscreen backdrop readback + blur passes every frame) and
				// at its 0.65px ceiling it was imperceptible. The element now stays a
				// pure radial-gradient vignette that tracks the car: one cheap paint.
			}
		}
		skyUniforms.time.value = now;
		skyUniforms.vibrance.value = THREE.MathUtils.lerp( skyUniforms.vibrance.value, 0.2 + ( speedRatioFx * 0.18 ) + ( driftFx * 0.1 ), Math.min( 1, dt * 2.4 ) );
		// Follow the CAMERA, not the car — in freecam it used to slide with the
		// vehicle while the camera stood still, which reads very wrong. Keeping y=0
		// so the horizon line never shifts; x/z track whatever view is active.
		skyGroup.position.set( cam.camera.position.x, 0, cam.camera.position.z );
		if ( skyDecorState.starPoints ) {
			skyDecorState.starPoints.material.opacity = 0.75 + Math.sin( now * 1.3 ) * 0.12 + Math.sin( now * 2.7 + 1.3 ) * 0.08;
		}
		updateWeatherFx( dt, now );
		crashShakeTime = Math.max( 0, crashShakeTime - dt );
		if ( crashShakeTime > 0 && crashShakeStrength > 0 ) {
			const impactEnvelope = crashShakeTime / 0.18;
			const impulse = crashShakeStrength * impactEnvelope;
			cam.camera.position.x += ( Math.random() - 0.5 ) * impulse;
			cam.camera.position.y += ( Math.random() - 0.5 ) * impulse * 0.7;
			cam.camera.rotation.z += ( Math.random() - 0.5 ) * impulse * 0.08;
			crashShakeStrength = Math.max( 0, crashShakeStrength - dt * 0.6 );
		}
		if ( customModShakeUntil > now && customModShakeIntensity > 0 ) {
			const shake = Math.min( 0.28, customModShakeIntensity * 0.025 );
			cam.camera.position.x += ( Math.random() - 0.5 ) * shake;
			cam.camera.position.y += ( Math.random() - 0.5 ) * shake;
		}
		if ( customModShakeUntil <= now ) customModShakeIntensity = 0;
		if ( customModFlashUntil > now ) {
			if ( ! customModFlashOverlay ) {
				customModFlashOverlay = document.createElement( 'div' );
				customModFlashOverlay.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none;opacity:0;transition:opacity 80ms linear;';
				document.body.appendChild( customModFlashOverlay );
			}
			const remaining = Math.max( 0, customModFlashUntil - now );
			customModFlashOverlay.style.background = `#${ customModFlashColor.getHexString() }`;
			customModFlashOverlay.style.opacity = String( Math.min( 0.6, remaining * 2 ) );
		} else if ( customModFlashOverlay && customModFlashOverlay.style.opacity !== '0' ) {
			customModFlashOverlay.style.opacity = '0';
		}

		for ( let checkpointIndex = 0; checkpointIndex < checkpointStates.length; checkpointIndex ++ ) {

			const checkpoint = checkpointStates[ checkpointIndex ];

			const localX = ( ( vehicle.spherePos.x - checkpoint.centerX ) * checkpoint.cosA ) + ( ( vehicle.spherePos.z - checkpoint.centerZ ) * checkpoint.sinA );
			const localZ = ( - ( vehicle.spherePos.x - checkpoint.centerX ) * checkpoint.sinA ) + ( ( vehicle.spherePos.z - checkpoint.centerZ ) * checkpoint.cosA );

			let crossedCheckpoint = false;
			if ( checkpoint.hasPrevSample ) {

				// Zero-inclusive plane test (a car landing exactly on the gate plane was
				// invisible to the strict-inequality version) + forward-only direction,
				// so backing across a gate can never count.
				const z0 = checkpoint.lastLocalZ;
				const z1 = localZ;
				const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );

				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( checkpoint.lastLocalX, localX, t );
					crossedCheckpoint = t >= 0 && t <= 1 && Math.abs( xCross ) <= checkpoint.halfExtent;

				}

			}

			if ( crossedCheckpoint && ! checkpoint.passedThisLap ) {

				checkpoint.passedThisLap = true;
				activePadEffect = null;
				activePadTimeScale = 1;
				padContactKey = null;
				if ( checkpointRespawnInstalled ) saveCheckpointState( checkpoint );
				dispatchRuntimeModEvent( 'onCheckpoint', { type: 'checkpoint', checkpointIndex, checkpointNumber: checkpointIndex + 1, lapTime: now - lapStartSeconds } );
				const ghostTime = getFastestVisibleGhostCheckpointTime( checkpointIndex );
				if ( Number.isFinite( ghostTime ) ) {

					const currentSplit = now - lapStartSeconds;
					checkpointDeltaText = formatDeltaSigned( currentSplit - ghostTime );
					showTopMessage( `CP ${ checkpointIndex + 1}: ${ checkpointDeltaText }`, checkpointDeltaText.startsWith( '+' ), 1200 );

				}

			}
			checkpoint.lastLocalX = localX;
			checkpoint.lastLocalZ = localZ;
			checkpoint.hasPrevSample = true;

		}

		if ( vehicle2 ) {

			for ( const checkpoint of checkpointStates2 ) {

				const localX = ( ( vehicle2.spherePos.x - checkpoint.centerX ) * checkpoint.cosA ) + ( ( vehicle2.spherePos.z - checkpoint.centerZ ) * checkpoint.sinA );
				const localZ = ( - ( vehicle2.spherePos.x - checkpoint.centerX ) * checkpoint.sinA ) + ( ( vehicle2.spherePos.z - checkpoint.centerZ ) * checkpoint.cosA );

				let crossedCheckpoint = false;
				if ( checkpoint.hasPrevSample ) {

					const z0 = checkpoint.lastLocalZ;
					const z1 = localZ;
					const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );

					if ( crossedPlane ) {

						const t = z0 / ( z0 - z1 );
						const xCross = THREE.MathUtils.lerp( checkpoint.lastLocalX, localX, t );
						crossedCheckpoint = t >= 0 && t <= 1 && Math.abs( xCross ) <= checkpoint.halfExtent;

					}

				}

				if ( crossedCheckpoint ) {

					checkpoint.passedThisLap = true;
					activePadEffect2 = null;
					activePadTimeScale2 = 1;
					padContactKey2 = null;
					if ( checkpointRespawnInstalled ) saveCheckpointState( checkpoint );

				}
				checkpoint.lastLocalX = localX;
				checkpoint.lastLocalZ = localZ;
				checkpoint.hasPrevSample = true;

			}

		}

		if ( finishData ) {

			const localX = ( ( vehicle.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const startLocalX = ( ( vehicle.spherePos.x - startGateData.centerX ) * startGateData.cosA ) + ( ( vehicle.spherePos.z - startGateData.centerZ ) * startGateData.sinA );
			const startLocalZ = ( - ( vehicle.spherePos.x - startGateData.centerX ) * startGateData.sinA ) + ( ( vehicle.spherePos.z - startGateData.centerZ ) * startGateData.cosA );
			const inStartCell = Math.abs( startLocalX ) < startGateData.halfExtent && Math.abs( startLocalZ ) < startGateData.halfExtent;
			const inFinishCell = Math.abs( localX ) < finishData.halfExtent && Math.abs( localZ ) < finishData.halfExtent;

			if ( ! hasLeftStartZone && ! inStartCell ) {

				hasLeftStartZone = true;

			}

			let crossedFinish = false;

			if ( hasPrevFinishSample ) {

				const z0 = lastLocalZ;
				const z1 = localZ;
				const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );

				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( lastLocalX, localX, t );
					crossedFinish = t >= 0 && t <= 1 && Math.abs( xCross ) <= finishData.halfExtent;

				}

			}

			const allCheckpointsPassed = checkpointStates.every( ( checkpoint ) => checkpoint.passedThisLap );
			if ( hasLeftStartZone && allCheckpointsPassed && crossedFinish ) {

					// Schedule the respawn BEFORE the share-snapshot / leaderboard
					// bookkeeping below — on a laggy frame any of that can throw,
					// and a throw must never eat the respawn.
					if ( shouldAutoRespawnAfterLap ) scheduleAutoRespawnVehicle();
					const completedLap = now - lapStartSeconds;
					// Gameplay mods (any non-freecam installed mod, including every custom-*
					// Blockly mod) change physics/handling, so a lap driven under one can never
					// be a fair leaderboard entry. Treat it as invalid: do NOT update the local
					// PB, ghost, or input recording, and skip multiplayer publish + leaderboard
					// upload. The mod still receives onLapFinish so it can react; the lap is
					// never recorded as a record.
					const moddedRun = nonFreecamModsInstalled;
					const lapInvalid = currentLapInvalidatedByPause || moddedRun;
					const previousBestLap = bestLapSeconds;
					const isNewBest = ! lapInvalid && ( bestLapSeconds === null || completedLap < bestLapSeconds );
					lastLapSeconds = completedLap;
					if ( ! lapInvalid ) {

						bestLapSeconds = bestLapSeconds === null ? completedLap : Math.min( bestLapSeconds, completedLap );
						// On a public server publishMultiplayerBestLap is a no-op (there's
						// no private-room lap store); a world record still submits to the
						// OFFICIAL leaderboard via the isNewBest submitLeaderboardTime path
						// below. Private rooms publish to their Firebase lap store on a new
						// session best.
						if ( isNewBest ) {

							publishMultiplayerBestLap( bestLapSeconds );

						}
						shareImageDataUrl = createShareSnapshot( bestLapSeconds );

					} else if ( moddedRun ) {

						showTopMessage( 'Mod active \u2014 lap not counted for the leaderboard. Remove the mod in the Mod Manager to record times.', true, 2600 );

					} else {

						showTopMessage( 'Lap completed, but paused runs are leaderboard invalid.', true, 2400 );

					}
				if ( isNewBest && currentLapGhostSamples.length > 1 ) {

					bestLapGhostSamples.length = 0;
					ghostPlaybackCursor._cursor = 1;
					const t0 = currentLapGhostSamples[ 0 ].t;
					for ( const sample of currentLapGhostSamples ) bestLapGhostSamples.push( { ...sample, t: sample.t - t0 } );
					bestGhostDuration = Math.max( 1e-4, completedLap - t0 );
					bestGhostCarKey = currentCarKey();
					bestGhostCosmetics = buildGhostCosmeticsSnapshot( bestGhostCarKey );
					bestGhostCheckpointTimes = computeCheckpointCrossTimes( bestLapGhostSamples );
					if ( models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ], bestGhostCosmetics );
					updateGhostShareButtons();

				}
				dispatchRuntimeModEvent( 'onLapFinish', { type: 'lapFinish', lapTime: completedLap, bestLapSeconds, lapNumber, isNewBest, lapInvalid } );
				if ( currentLapGhostSamples.length > 1 ) {

					const t0 = currentLapGhostSamples[ 0 ].t;
					const normalized = currentLapGhostSamples.map( ( sample ) => ( { ...sample, t: sample.t - t0 } ) );
					const runDuration = Math.max( 1e-4, completedLap - t0 );
					recentGhostHistory.unshift( {
						samples: normalized,
						duration: runDuration,
						car: currentCarKey(),
						cosmetics: buildGhostCosmeticsSnapshot( currentCarKey() ),
						checkpointTimes: computeCheckpointCrossTimes( normalized ),
					} );
					if ( recentGhostHistory.length > 12 ) recentGhostHistory.length = 12;
					saveRecentGhostHistory();
					rebuildRecentGhostVisuals();
					rebuildGhostSpreadLine();

				}
				// Submit to the OFFICIAL leaderboard on any new personal best. This is
				// what lets a world record set on a public server land on the real
				// leaderboard (a WR is always a new local best, so it submits here).
				// Slower laps that don't beat the PB are NOT submitted (the worker keeps
				// the min anyway, but there's no point POSTing them).
				if ( isNewBest && ! isSplitScreen ) submitLeaderboardTime( completedLap );
				if ( ! lapInvalid && editorQuickTestEnabled && editorReturnParam && ! isSplitScreen && currentLapGhostSamples.length > 1 ) {

					try {

						const t0 = currentLapGhostSamples[ 0 ].t;
						const normalizedSamples = currentLapGhostSamples.map( ( sample ) => ( {
							x: sample.x,
							z: sample.z,
							t: sample.t - t0,
						} ) );
						localStorage.setItem( QUICK_TEST_GHOST_KEY, JSON.stringify( {
							samples: normalizedSamples,
							duration: completedLap,
							at: Date.now(),
						} ) );
						localStorage.setItem( QUICK_TEST_GHOST_MAP_KEY, editorGhostMapHash );

					} catch ( error ) {

						console.warn( 'Failed to persist quick-test ghost', error );

					}
					window.location.href = editorReturnParam;
					return;

				}
						lapNumber ++;
					resetMovingObstacles( movingObstacleState, now );
						lapStartSeconds = now;
						currentLapInvalidatedByPause = false;
						checkpointDeltaText = '';
						resetCurrentLapGhost();
						recordGhostSample( 0, true );
					updateGhostPlayback( 0 );
					updateLeaderboardGhostPlayback( 0 );
					updateRecentGhostPlayback( 0 );
				hasLeftStartZone = false;
				hasPrevFinishSample = false;
				lastLocalX = 0;
				lastLocalZ = 0;
				for ( const checkpoint of checkpointStates ) {

					checkpoint.passedThisLap = false;

				}
				resetPhysicsObstacles();
				startCountdown();
					saveLapStats();
					rewardCoinsForLap( completedLap );
					if ( ! lapInvalid && competitionParamEnabled && competitionReturnParam && ! isSplitScreen ) {
						const competitionResultUrl = new URL( competitionReturnParam, window.location.href );
						competitionResultUrl.searchParams.set( 'competitionResult', '1' );
						competitionResultUrl.searchParams.set( 'time', String( Number( completedLap ) ) );
						if ( Number.isFinite( competitionTierParam ) ) competitionResultUrl.searchParams.set( 'tier', String( competitionTierParam ) );
						if ( competitionSeedParam ) competitionResultUrl.searchParams.set( 'seed', competitionSeedParam );
						window.location.href = competitionResultUrl.toString();
						return;
					}
						if ( gameMode === 'stunt' ) {

						let lapBonus = Math.max( 0, Math.round( ( 65 - completedLap ) * 2 ) );
						if ( isNewBest ) lapBonus += 70;
						else if ( Number.isFinite( previousBestLap ) && completedLap <= previousBestLap * 1.03 ) lapBonus += 30;
						const lapTotalWithBonus = stuntPoints + lapBonus;
							if ( lapTotalWithBonus > bestStuntPoints ) {

								bestStuntPoints = lapTotalWithBonus;
								saveStuntStats();
								updateGarageUi();

							}
						stuntPoints = 0;
						stuntReasonText = '--';
						stuntReasonTimer = 0;
						resetStuntChain();
						if ( lapBonus > 0 ) {

							stuntReasonText = `Fast lap +${ lapBonus}`;
							stuntReasonTimer = 1.6;

						}
							updateStuntPointsHud();

						}
						if ( gameMode === 'campaign' ) {

							if ( campaignState?.stageType === 'lap-default' && !mapParam ) incrementCampaignProgress( 'lap-default' );
							if ( campaignState?.stageType === 'play-share' && mapParam ) incrementCampaignProgress( 'play-share' );
							if ( campaignState?.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds ) && completedLap <= campaignTargetAuthorSeconds ) incrementCampaignProgress( 'beat-authors' );
							if ( campaignState?.stageType === 'beat-records' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length > 0 && completedLap <= Number( currentTrackLeaderboardRows[ 0 ]?.timeSeconds ) ) incrementCampaignProgress( 'beat-records' );
							if ( campaignState?.stageType === 'set-record' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length > 0 && completedLap <= Number( currentTrackLeaderboardRows[ 0 ]?.timeSeconds ) ) incrementCampaignProgress( 'set-record' );
							if ( campaignState?.stageType === 'podium' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length >= 3 && completedLap <= Number( currentTrackLeaderboardRows[ 2 ]?.timeSeconds ) ) incrementCampaignProgress( 'podium' );
							if ( campaignState?.stageType === 'endurance-laps' ) incrementCampaignProgress( 'endurance-laps' );
							if ( campaignState?.stageType === 'mastery' ) incrementCampaignProgress( 'mastery' );

						}

				}

			if ( ! inFinishCell ) {
				lastLocalX = localX;
				lastLocalZ = localZ;
				hasPrevFinishSample = true;
			}

		}

		if ( finishData && vehicle2 ) {

			const localX = ( ( vehicle2.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle2.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const startLocalX = ( ( vehicle2.spherePos.x - startGateData.centerX ) * startGateData.cosA ) + ( ( vehicle2.spherePos.z - startGateData.centerZ ) * startGateData.sinA );
			const startLocalZ = ( - ( vehicle2.spherePos.x - startGateData.centerX ) * startGateData.sinA ) + ( ( vehicle2.spherePos.z - startGateData.centerZ ) * startGateData.cosA );
			const inStartCell = Math.abs( startLocalX ) < startGateData.halfExtent && Math.abs( startLocalZ ) < startGateData.halfExtent;
			const inFinishCell = Math.abs( localX ) < finishData.halfExtent && Math.abs( localZ ) < finishData.halfExtent;

			if ( ! hasLeftStartZone2 && ! inStartCell ) hasLeftStartZone2 = true;

			let crossedFinish = false;
			if ( hasPrevFinishSample2 ) {

				const z0 = lastLocalZ2;
				const z1 = localZ;
				const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );
				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( lastLocalX2, localX, t );
					crossedFinish = t >= 0 && t <= 1 && Math.abs( xCross ) <= finishData.halfExtent;

				}

			}

			const allCheckpointsPassed2 = checkpointStates2.every( ( checkpoint ) => checkpoint.passedThisLap );
			if ( hasLeftStartZone2 && allCheckpointsPassed2 && crossedFinish ) {

				if ( shouldAutoRespawnAfterLap ) scheduleAutoRespawnVehicle2();
				const completedLap2 = now - lapStartSeconds2;
				lastLapSeconds2 = completedLap2;
				bestLapSeconds2 = bestLapSeconds2 === null ? completedLap2 : Math.min( bestLapSeconds2, completedLap2 );
				lapNumber2 ++;
				lapStartSeconds2 = now;
				hasLeftStartZone2 = false;
				hasPrevFinishSample2 = false;
				lastLocalX2 = 0;
				lastLocalZ2 = 0;
				for ( const checkpoint of checkpointStates2 ) checkpoint.passedThisLap = false;
				resetPhysicsObstacles();

			}

			if ( ! inFinishCell ) {
				lastLocalX2 = localX;
				lastLocalZ2 = localZ;
				hasPrevFinishSample2 = true;
			}

		}

		lapSeconds = countdownActive ? 0 : now - lapStartSeconds;
		if ( vehicle2 ) lapSeconds2 = countdownActive ? 0 : now - lapStartSeconds2;
		updateMovingObstacles( movingObstacleState, now, [ vehicle, vehicle2 ] );
		recordGhostSample( lapSeconds );
		updateGhostPlayback( lapSeconds );
		updateLeaderboardGhostPlayback( lapSeconds );
		updateRecentGhostPlayback( lapSeconds );
		const stuntScoringActive = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( stuntScoringActive ) {

			const speedRatio = vehicle.topSpeed > 0 ? Math.abs( vehicle.linearSpeed ) / vehicle.topSpeed : 0;
			const overspeed = speedRatio > 1.0;
			const hasBoostSource = activeSurfaceType === 'surface-wood' || activeSurfaceType === 'surface-boost' || now < boostActiveUntil;
			const isAirborne = vehicle.spherePos.y > 0.78 || Math.abs( vehicle.sphereVel.y ) > 1.1;
			const hardTurn = Math.abs( input.x ) > 0.35 && speedRatio > 0.6;
			const drifting = vehicle.driftIntensity > 0.45;
			const activeTrick = drifting || ( overspeed && hasBoostSource ) || isAirborne || hardTurn;
			if ( drifting ) addStuntPoints( ( vehicle.driftIntensity - 0.45 ) * 46 * dt, 'Drift' );
			if ( overspeed && hasBoostSource ) addStuntPoints( 38 * dt, 'Speed burst' );
			if ( hardTurn ) addStuntPoints( 18 * dt, 'Corner carve' );
			if ( isAirborne ) {

				stuntAirTime += dt;
				addStuntPoints( 40 * dt, vehicle.spherePos.y > 1.35 ? 'Big jump' : 'Air' );

			} else if ( stuntAirTime > 0.2 ) {

				const landingBonus = 14 + Math.min( 80, stuntAirTime * 55 );
				addStuntPoints( landingBonus, 'Landing');
				stuntAirTime = 0;

			} else {

				stuntAirTime = 0;

			}

			if ( activeTrick ) {

				stuntComboTimer = Math.min( 2.4, stuntComboTimer + dt * 1.2 );
				stuntCombo = Math.min( 3.0, stuntCombo + dt * 0.35 );

			} else {

				stuntComboTimer = Math.max( 0, stuntComboTimer - dt );
				if ( stuntComboTimer === 0 ) stuntCombo = Math.max( 1, stuntCombo - dt * 0.8 );

			}

		}
		if ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' && stuntPoints >= campaignState.goal ) {

			campaignState.progress = campaignState.goal;
			saveCampaignState();
			completeCampaignStage();
			updateCampaignUi();
			stuntPoints = 0;
			stuntReasonText = '--';
			stuntReasonTimer = 0;
			resetStuntChain();

		}
		if ( stuntReasonTimer > 0 ) {

			stuntReasonTimer = Math.max( 0, stuntReasonTimer - dt );
			if ( stuntReasonTimer === 0 ) stuntReasonText = '--';

		}
		hudUpdateAccumulator += dt;
		if ( hudUpdateAccumulator >= 0.08 ) {

			hudUpdateAccumulator = 0;
			updateLapHud();
			updateLapHud2();
			updateStuntPointsHud();
			hudExtras?.update();
			hudExtras?.setVisible( gameMode === 'race' || gameMode === 'stunt' );

		}


		renderFrame();

		// Video Recorder: push the freshly rendered canvas frame into the
		// recording stream each render (manual frame mode). No-op when not
		// recording or in auto-capture mode.
		if ( videoRecorderInstalled && videoRecorder?.isRecording() ) videoRecorder.captureFrame();

	}

	rebuildRecentGhostVisuals();
	animate();

}

init().then( () => {

	setLoadingStatus( 'Ready to race!', 'ready' );
	window.__racingGameBooting = false;
	hideLoadingOverlay();

} ).catch( ( error ) => {

	console.error( 'Failed to initialize game', error );
	showLoadingError( error );

} );

