import * as THREE from 'three';

export const ORIENT_DEG = { 0: 0, 10: 180, 16: 90, 22: 270 };

export const CELL_RAW = 9.99;
export const GRID_SCALE = 0.75;

const _dummy = new THREE.Object3D();
const JUMP_RAMP_ANGLE = THREE.MathUtils.degToRad( 30 );
const JUMP_RAMP_SIZE = CELL_RAW * 0.36;
const JUMP_RAMP_DEPTH = CELL_RAW * 0.18;
const JUMP_RAMP_Y = 0.24;
const VISUAL_HEIGHT_OFFSET = 0.012;
const DECORATION_HEIGHT_OFFSET = VISUAL_HEIGHT_OFFSET * 0.5;
const NO_DECO_BUFFER_CELLS = 1;
const POLE_RADIUS = CELL_RAW * 0.08;
const POLE_HEIGHT = CELL_RAW * 0.13;
const MAGNET_HALF_SIZE = CELL_RAW * 0.08;
const MAGNET_BASE_Y = ( CELL_RAW * 0.08 ) - 0.06;
const ELEVATED_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_COLOR = 0x0d0d0d;
const SLOPE_ANGLE = Math.atan2( ELEVATED_HEIGHT, CELL_RAW );
const SUPPORT_SINK = 0.03;
const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };

const WATER_DEPTH = CELL_RAW * 0.34;
const WATER_WALL_HEIGHT = CELL_RAW * 0.38;

// ---------------------------------------------------------------------------
// Pool visuals — 100% procedural (no external texture CDNs).
// Pool block tiles are canvas-generated ceramic tiles; the water is a
// custom shader port of the classic "tinted clear water" technique:
// fbm waves with small chop, screen-space refraction (real scene wobble), a caustic web,
// fresnel sky reflection, and a sun glint.
const WATER_SHADER_TILE_COLS = 8; // ceramic tiles per grid cell (shader + textures stay in sync)

let poolWallTexture = null;
let poolFloorTexture = null;
function createPoolTileCanvas( cols, rows ) {

	// Deterministic PRNG so every player sees the same pool.
	let seed = 1337 ^ ( cols * 7919 ) ^ ( rows * 104729 );
	const rand = () => {

		seed = ( seed * 1664525 + 1013904223 ) >>> 0;
		return seed / 4294967296;

	};
	const tileW = 64;
	const canvas = document.createElement( 'canvas' );
	canvas.width = cols * tileW;
	canvas.height = rows * tileW;
	const ctx = canvas.getContext( '2d' );
	// grout base
	ctx.fillStyle = '#2f5a72';
	ctx.fillRect( 0, 0, canvas.width, canvas.height );
	for ( let ty = 0; ty < rows; ty ++ ) {
		for ( let tx = 0; tx < cols; tx ++ ) {

			const x = tx * tileW, y = ty * tileW;
			const r = rand();
			const accent = r > 0.9;
			const light = 58 + rand() * 12;
			const hue = accent ? 208 : 200 + rand() * 8;
			const sat = accent ? 62 : 48 + rand() * 10;
			ctx.fillStyle = `hsl( ${ hue }, ${ sat }%, ${ light }% )`;
			ctx.fillRect( x + 3, y + 3, tileW - 6, tileW - 6 );
			// bevel: lighter top-left edge, darker bottom-right
			ctx.fillStyle = 'rgba( 255, 255, 255, 0.16 )';
			ctx.fillRect( x + 3, y + 3, tileW - 6, 2 );
			ctx.fillStyle = 'rgba( 10, 30, 50, 0.18 )';
			ctx.fillRect( x + 3, y + tileW - 5, tileW - 6, 2 );
			// speckle
			for ( let k = 0; k < 6; k ++ ) {

				ctx.fillStyle = `rgba( 255, 255, 255, ${ 0.03 + rand() * 0.05 } )`;
				ctx.fillRect( x + 4 + rand() * ( tileW - 8 ), y + 4 + rand() * ( tileW - 8 ), 2, 2 );

			}

		}
	}
	return canvas;

}
function getPoolTextures() {

	if ( poolWallTexture && poolFloorTexture ) return { poolWallTexture, poolFloorTexture };
	const toTexture = ( canvas ) => {

		const tex = new THREE.CanvasTexture( canvas );
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		return tex;

	};
	poolFloorTexture = toTexture( createPoolTileCanvas( WATER_SHADER_TILE_COLS, WATER_SHADER_TILE_COLS ) );
	poolWallTexture = toTexture( createPoolTileCanvas( WATER_SHADER_TILE_COLS, 3 ) );
	return { poolWallTexture, poolFloorTexture };

}

// ---------------------------------------------------------------------------
// Screen-space refraction: before the main render, the scene is rendered
// WITHOUT the water planes into a half-res per-camera render target; the
// water shader then samples that texture with an animated wobble — so the
// car, the pool tiles, everything under water wiggles like real light
// bending through the surface.
const WATER_PLANES = [];
const _waterDbSize = new THREE.Vector2();
const _waterPrevViewport = new THREE.Vector4();
const _waterPrevScissor = new THREE.Vector4();
const waterRefrRTs = new Map();

// Frame-budget governor. The refraction pass re-renders the whole scene,
// which is exactly what pools steal from the frame rate. Three gates:
//  1. FRUSTUM: if no water plane is in the camera's view, skip the pass
//     entirely (off-screen pools cost nothing).
//  2. CADENCE (stationary camera): as FPS dips, re-render the RT every
//     2nd/3rd/4th call instead of every frame. The wobble animates per-frame
//     IN-SHADER (time uniform), so a 2-3 frame old refraction sample is
//     imperceptible — but the frame gets a whole scene-render cheaper.
//  3. MOTION STALENESS (moving camera): reuse a sample up to
//     WATER_REFR_STALE_MS old while the camera stays inside the motion
//     budget — at 200 FPS this turns the per-frame full-scene render into
//     a ~30 Hz background refresh instead of a 200 Hz one.
const waterLastRefrFrameByCam = new Map();
const _waterFrustum = new THREE.Frustum();
const _waterProjScreen = new THREE.Matrix4();
let waterRefrFrameCounter = 0;
// Per-camera pose at the last refraction pass — used to decide when a fresh
// pass is actually needed (see the motion-staleness gate below).
const waterLastCamStateByCam = new Map();
let waterRefrCadence = 1;
// Motion-staleness budget: while the camera is moving, a refraction sample up
// to WATER_REFR_STALE_MS old is imperceptible behind the per-frame animated
// wobble (~2 frames at 60 FPS). At high refresh rates this cuts the pass to a
// fraction of frames instead of every single one — at 200 FPS the pool costs
// ~1/6th of a full scene render per frame. Reuse is only allowed while the
// camera has moved less than WATER_REFR_STALE_MOVE / turned WATER_REFR_STALE_ANGLE
// since the sample — a big jump (respawn, camera cut) always forces a fresh pass.
const WATER_REFR_STALE_MS = 32;
const WATER_REFR_STALE_MOVE_SQ = 1.75 * 1.75;
const WATER_REFR_STALE_ANGLE = 0.05;

// Camera-underwater state shared by every pool material. When the camera is
// below the surface, the pool floors get their animated caustic overlay and
// the water surface renders its shimmering underside.
const WATER_UNDERWATER = { camera: false, gain: 0 };
export function setWaterUnderwaterCameraState( active ) {

	WATER_UNDERWATER.camera = !! active;

}

export function updateWaterQuality( rollingFps ) {

	if ( ! Number.isFinite( rollingFps ) || rollingFps <= 0 ) {

		waterRefrCadence = 1; // no signal yet — assume healthy
		return;

	}
	waterRefrCadence = rollingFps >= 45 ? 1 : rollingFps >= 28 ? 2 : rollingFps >= 18 ? 3 : 4;

}

function isWaterVisibleToCamera( camera ) {

	if ( WATER_PLANES.length === 0 ) return false;
	camera.updateMatrixWorld();
	camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
	_waterProjScreen.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
	_waterFrustum.setFromProjectionMatrix( _waterProjScreen );
	for ( const plane of WATER_PLANES ) {

		// World-space spheres are cached once per plane (planes never move);
		// no per-frame allocation here.
		const sphere = plane.userData.waterWorldSphere;
		if ( ! sphere ) return true; // not cached — be safe, render the pass
		if ( _waterFrustum.intersectsSphere( sphere ) ) return true;

	}
	return false;

}

// viewportRect (canvas px, bottom-left origin) mirrors split-screen scissor
// rects so each camera's water samples ITS OWN view.
export function prerenderWaterRefraction( renderer, scene, camera, camIndex = 0, viewportRect = null ) {

	if ( WATER_PLANES.length === 0 ) return;
	if ( ! isWaterVisibleToCamera( camera ) ) return;
	waterRefrFrameCounter ++;
	const waterLastFrame = waterLastRefrFrameByCam.get( camIndex );
	// When does the pool actually need a fresh scene render?
	//  - UNDERWATER camera: always — the shimmering underside is the screen
	//    content, any staleness is visible.
	//  - STATIONARY camera: the LOW-fps cadence governor (updateWaterQuality)
	//    applies — the RT content only changes via the in-shader wobble anyway.
	//  - MOVING camera: motion-staleness gate — a sample up to
	//    WATER_REFR_STALE_MS old (≈2 frames at 60 FPS) is imperceptible behind
	//    the animated wobble, so at high refresh rates the pass runs on only a
	//    fraction of frames (at 200 FPS: ~1/6th of a scene render per frame).
	//    Reuse requires the camera to have moved/turned less than the budget
	//    since the sample — big jumps (respawn, camera cut) force a fresh pass.
	const waterCamState = waterLastCamStateByCam.get( camIndex );
	const markFreshPass = () => {

		if ( waterCamState ) {

			waterCamState.pos.copy( camera.position );
			waterCamState.quat.copy( camera.quaternion );
			waterCamState.t = performance.now();

		} else {

			waterLastCamStateByCam.set( camIndex, { pos: camera.position.clone(), quat: camera.quaternion.clone(), t: performance.now() } );

		}
		waterLastRefrFrameByCam.set( camIndex, waterRefrFrameCounter );

	};
	if ( ! WATER_UNDERWATER.camera ) {

		let skipPass = false;
		if ( waterCamState ) {

			const movedSq = waterCamState.pos.distanceToSquared( camera.position );
			const angle = waterCamState.quat.angleTo( camera.quaternion );
			if ( movedSq < 0.0025 && angle < 0.01 ) {

				// Parked camera — LOW-fps cadence governor.
				skipPass = waterLastFrame !== undefined && waterRefrFrameCounter - waterLastFrame < waterRefrCadence;

			} else if ( waterLastFrame !== undefined
				&& ( performance.now() - waterCamState.t ) < WATER_REFR_STALE_MS
				&& movedSq < WATER_REFR_STALE_MOVE_SQ
				&& angle < WATER_REFR_STALE_ANGLE ) {

				// Moving camera — sample still inside the staleness budget.
				skipPass = true;

			}

		}
		if ( skipPass ) return;

	}
	markFreshPass();
	const db = renderer.getDrawingBufferSize( _waterDbSize );
	const w = Math.max( 2, Math.floor( db.x / 2 ) );
	const h = Math.max( 2, Math.floor( db.y / 2 ) );
	let rt = waterRefrRTs.get( camIndex );
	if ( ! rt || rt.width !== w || rt.height !== h ) {

		if ( rt ) rt.dispose();
		rt = new THREE.WebGLRenderTarget( w, h );
		waterRefrRTs.set( camIndex, rt );

	}
	const prevViewport = renderer.getViewport( _waterPrevViewport );
	const prevScissor = renderer.getScissor( _waterPrevScissor );
	const prevScissorTest = renderer.getScissorTest();
	for ( const plane of WATER_PLANES ) plane.visible = false;
	renderer.setRenderTarget( rt );
	// IMPORTANT: use the render target's own viewport/scissor (raw
	// framebuffer pixels), NOT renderer.setViewport/setScissor — those are
	// logical units that three.js MULTIPLIES BY the renderer's pixel ratio.
	// On the LOW preset (pixelRatio 0.85) that multiplication shrinks the
	// viewport to 85% of the RT, leaving the top/right of the refraction
	// texture unwritten: water outside a bottom-left square sampled stale
	// data ("trash") while the square itself showed the whole frustum
	// squeezed into 85% ("zoomed out"). At ratios >= 1 the multiplied
	// viewport overflows and GL clamps it to full — which is why medium and
	// high never showed it. rt.viewport is applied verbatim by
	// setRenderTarget, so this is exact at every ratio.
	if ( viewportRect ) {

		rt.scissorTest = true;
		rt.scissor.set( viewportRect.x / 2, viewportRect.y / 2, viewportRect.w / 2, viewportRect.h / 2 );
		rt.viewport.set( viewportRect.x / 2, viewportRect.y / 2, viewportRect.w / 2, viewportRect.h / 2 );

	} else {

		rt.scissorTest = false;
		rt.viewport.set( 0, 0, w, h );

	}
	renderer.render( scene, camera );
	renderer.setRenderTarget( null );
	// Restore the RT to full-frame defaults so later binds (share snapshot,
	// the other split-screen camera) always start from the full texture.
	rt.scissorTest = false;
	rt.viewport.set( 0, 0, w, h );
	renderer.setViewport( prevViewport );
	renderer.setScissor( prevScissor );
	renderer.setScissorTest( prevScissorTest );
	for ( const plane of WATER_PLANES ) {

		plane.visible = true;
		plane.material.uniforms.tDiffuse.value = rt.texture;

	}

}

function normalizePoolVisuals( extras = null ) {

	const cfg = extras?.customPool && typeof extras.customPool === 'object' ? extras.customPool : {};
	const isHex = ( value ) => /^#[0-9a-f]{6}$/i.test( String( value || '' ) );
	// Custom colors only apply when the track's editor checkbox opted in
	// (colorsOn). Without it the pool uses the classic blue — even if the
	// payload carries old color values — so the toggle is OFF by default.
	const colorsOn = cfg.colorsOn === true;
	return {
		// Bluer than the old default — the shader body adds a further cool tint.
		waterColor: colorsOn && isHex( cfg.waterColor ) ? cfg.waterColor : '#1180e6',
		edgeColor: colorsOn && isHex( cfg.edgeColor ) ? cfg.edgeColor : '#5cc7ff',
		// Opaque by default (refraction is drawn in-shader like the reference
		// demo); only tracks that explicitly ask get the see-through alpha.
		transparent: cfg.transparent === true,
		isCustom: colorsOn,
	};

}

function createRepositoryWaterMaterial( visuals = normalizePoolVisuals() ) {

	return new THREE.ShaderMaterial( {
		uniforms: {
			time: { value: 0 },
			// 3x the original 0.05 (was briefly 0.17/3.4x — the tallest random crests
			// clipped through the grass surface, so this backs off to 3x).
			waveHeight: { value: CELL_RAW * 0.15 },
			floorY: { value: - WATER_DEPTH },
			tDiffuse: { value: null },
			// Distance fade bands (camera -> fragment), fixed world-space
			// distances scaled to cell size — NOT tied to scene.fog.far (fog
			// here reaches groundSize*6.4, so fog-coupled bands only kicked in
			// when free-flying far out; in normal play pools never faded).
			// Roughly: full detail within ~5 cells, fully flat blue by ~12 cells.
			waveFadeStart: { value: CELL_RAW * 7 },
			waveFadeEnd: { value: CELL_RAW * 12 },
			causticFadeStart: { value: CELL_RAW * 5 },
			causticFadeEnd: { value: CELL_RAW * 9 },
			lightDir: { value: new THREE.Vector3( 0.577, 0.577, 0.577 ).normalize() },
			// Custom pools: push the picked hue hard (saturate x1.5, clamp
			// lightness into a readable band) and nearly skip the deep-navy
			// drown so a red pool reads RED. Default pools keep the old look.
			deepColor: { value: ( () => {

				const c = new THREE.Color( visuals.waterColor );
				if ( visuals.isCustom ) {

					const hsl = { h: 0, s: 0, l: 0 };
					c.getHSL( hsl );
					c.setHSL( hsl.h, Math.min( 1, hsl.s * 1.5 ), THREE.MathUtils.clamp( hsl.l, 0.34, 0.62 ) );

				}
				return c.lerp( new THREE.Color( 0x041f3d ), visuals.isCustom ? 0.12 : 0.6 );

			} )() },
			// Neutral tint for custom pools (no blue shift); classic cool tint otherwise.
			uTint: { value: new THREE.Vector3( visuals.isCustom ? 1 : 0.86, visuals.isCustom ? 1 : 0.94, visuals.isCustom ? 1 : 1.08 ) },
			skyTop: { value: new THREE.Color( 0x6db3e8 ) },
			skyHorizon: { value: new THREE.Color( 0xdff3ff ) },

		},
		// Waves: fbm-animated height field with finite-difference world
		// normals (the demo's technique), evaluated in world space so all
		// pool planes share one continuous ocean feel.
		vertexShader: `
			uniform float time;
			uniform float waveHeight;
			uniform float waveFadeStart;
			uniform float waveFadeEnd;
			uniform float causticFadeStart;
			uniform float causticFadeEnd;
			varying vec3 vWorldPos;
			varying vec3 vWorldNormal;
			varying float vWaveH;
			varying float vWaveDistFade;
			varying float vCausticDistFade;
			// Clip-space position: lets the fragment shader derive its own
			// screen-space UV (clip.xy/clip.w * 0.5 + 0.5) with NO dependency
			// on an externally-tracked "resolution" uniform. The old scheme
			// (gl_FragCoord / resolution) breaks the instant that uniform
			// drifts from the true drawing-buffer size for even one frame
			// (pixel-ratio change, a quality-preset switch, the pool leaving
			// frustum during the switch so the cadence-gated refresh never
			// runs) — exactly the failure mode reported on the LOW preset,
			// which is the only preset with pixelRatio < 1. NDC needs no such
			// uniform and can't desync from what was actually rasterized.
			varying vec4 vClip;

			// Sin-free hash (iq): the old fract(sin(dot)*43758) hash loses precision
			// on large coords and printed a repeating CROSS/X lattice artifact
			// across the water. This one stays clean at any distance.
			float hash( vec2 p ) {
				p = 50.0 * fract( p * 0.3183099 + vec2( 0.71, 0.113 ) );
				return fract( p.x * p.y * ( p.x + p.y ) );
			}
			float noise( vec2 p ) {
				vec2 i = floor( p ), f = fract( p );
				f = f * f * ( 3.0 - 2.0 * f );
				return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
					mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
			}
			float fbm( vec2 p, float t ) {
				float v = 0.0, a = 0.5;
				mat2 rot = mat2( 0.8, 0.6, -0.6, 0.8 );
				for ( int i = 0; i < 3; i ++ ) {
					v += a * noise( p + vec2( t * 0.2, - t * 0.1 ) );
					p = rot * p * 2.0 + vec2( 100.0 );
					a *= 0.5;
				}
				return v;
			}
			float getWave( vec2 wp, float t ) {
				// Rolling swell...
				float h = sin( wp.x * 1.35 + t ) * 0.055 + cos( wp.y * 1.15 - t * 0.8 ) * 0.045;
				h += fbm( wp * 3.2, t ) * 0.07;
				// ...with choppy ripples riding on top (the "watery" detail)
				h += sin( wp.x * 3.4 - t * 1.4 ) * 0.03 + sin( ( wp.x + wp.y ) * 5.3 + t * 1.9 ) * 0.02;
				return h;
			}
			void main() {
				float t = time * 1.2;
				vec4 world = modelMatrix * vec4( position, 1.0 );
				// Camera-distance fades: past the fade bands the surface
				// settles into a flat blue plane — no waves, no caustics.
				float camDist = distance( world.xyz, cameraPosition );
				vWaveDistFade = 1.0 - smoothstep( waveFadeStart, waveFadeEnd, camDist );
				vCausticDistFade = 1.0 - smoothstep( causticFadeStart, causticFadeEnd, camDist );
				vec2 wp = world.xz;
				float d = 0.12;
				float hC = getWave( wp, t );
				float hX1 = getWave( wp - vec2( d, 0.0 ), t );
				float hX2 = getWave( wp + vec2( d, 0.0 ), t );
				float hZ1 = getWave( wp - vec2( 0.0, d ), t );
				float hZ2 = getWave( wp + vec2( 0.0, d ), t );
				world.y += hC * waveHeight * vWaveDistFade;
				vWaveH = hC * vWaveDistFade;
				vWorldPos = world.xyz;
				vWorldNormal = normalize( vec3( ( hX1 - hX2 ) * vWaveDistFade, 2.0 * d, ( hZ1 - hZ2 ) * vWaveDistFade ) );
				gl_Position = projectionMatrix * viewMatrix * world;
				vClip = gl_Position;
			}
		`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform float time;
			uniform float floorY;
			uniform vec3 lightDir;
			uniform vec3 deepColor;
			uniform vec3 uTint;
			uniform vec3 skyTop;
			uniform vec3 skyHorizon;
			varying vec3 vWorldPos;
			varying vec3 vWorldNormal;
			varying float vWaveH;
			varying float vWaveDistFade;
			varying float vCausticDistFade;
			varying vec4 vClip;

			// Sin-free hash (iq): the old fract(sin(dot)*43758) hash loses precision
			// on large coords and printed a repeating CROSS/X lattice artifact
			// across the water. This one stays clean at any distance.
			float hash( vec2 p ) {
				p = 50.0 * fract( p * 0.3183099 + vec2( 0.71, 0.113 ) );
				return fract( p.x * p.y * ( p.x + p.y ) );
			}
			float noise( vec2 p ) {
				vec2 i = floor( p ), f = fract( p );
				f = f * f * ( 3.0 - 2.0 * f );
				return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
					mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
			}
			void main() {
				vec3 n = normalize( vWorldNormal );
				vec3 viewDir = normalize( cameraPosition - vWorldPos );
				vec3 rDir = reflect( - viewDir, n );
				vec3 refrDir = refract( - viewDir, n, 1.0 / 1.333 );
				if ( abs( refrDir.y ) < 1e-4 ) refrDir.y = - 1e-4;

				float fresnel = 0.03 + 0.24 * pow( 1.0 - max( dot( n, viewDir ), 0.0 ), 5.0 );
				// Procedural sky (no skybox asset needed)
				float skyMix = clamp( rDir.y * 0.5 + 0.5, 0.0, 1.0 );
				vec3 skyColor = mix( skyHorizon, skyTop, skyMix ) * 0.35;

				// Refracted ray: how far it travels to the pool floor — used
				// both for the depth tint and to project the caustic web onto
				// where the ray lands.
				float dFloor = max( ( floorY - vWorldPos.y ) / refrDir.y, 0.0 );
				vec3 fPos = vWorldPos + refrDir * dFloor;

				// Screen-space refraction: sample the REAL rendered scene (the
				// car, the actual pool tiles — no fake drawn floor) through an
				// animated wobble: light bending and shivering through water.
				// NDC -> [0,1] UV. No "resolution" uniform involved — this can
				// never desync from the actual rasterized frame (see the
				// vClip comment in the vertex shader above).
				vec2 screenUV = ( vClip.xy / vClip.w ) * 0.5 + 0.5;
				float wt = time * 1.6;
				vec2 wobble = vec2(
					noise( vWorldPos.xz * 2.1 + vec2( wt, wt * 0.7 ) ) - 0.5,
					noise( vWorldPos.zx * 2.3 - vec2( wt * 0.8, wt ) ) - 0.5
				);
				vec2 refrUV = clamp( screenUV + wobble * 0.035, vec2( 0.002 ), vec2( 0.998 ) );
				// Seen from BELOW the surface (camera underwater), the plane
				// renders as a shimmering water ceiling instead of the
				// above-water refraction sample.
				if ( ! gl_FrontFacing ) {

					vec3 under = texture2D( tDiffuse, clamp( screenUV + wobble * 0.02, vec2( 0.002 ), vec2( 0.998 ) ) ).rgb;
					under *= vec3( 0.45, 0.72, 0.86 );
					float shimmer = 0.5 + 0.5 * sin( ( vWorldPos.x + vWorldPos.z ) * 1.7 + time * 2.6 + noise( vWorldPos.xz * 2.6 + vec2( time * 0.9, - time * 0.7 ) ) * 7.0 );
					under += vec3( 0.22, 0.36, 0.42 ) * shimmer * vWaveDistFade;
					gl_FragColor = vec4( under, 1.0 );
					return;

				}
				vec3 refrColor = texture2D( tDiffuse, refrUV ).rgb;

				// Depth tint along the refracted ray
				float depthT = clamp( dFloor / ( ${ CELL_RAW } * 0.6 ), 0.0, 1.0 );
				refrColor = mix( refrColor, deepColor, depthT * 0.4 );

				// Caustic web projected onto where the refracted ray lands —
				// since the sample IS the real scene, the light pattern lands
				// on the actual pool floor AND any car under the surface.
				vec2 cUV = fPos.xz * 1.8 + n.xz * 0.35;
				float ct = time * 2.0;
				// Two noise fields on ROTATED, differently-scaled domains —
				// aligned lattices are what drew the cross/X pattern.
				mat2 rotC = mat2( 0.84, 0.54, -0.54, 0.84 );
				float n1 = noise( rotC * cUV * 1.15 + vec2( ct * 0.3, ct * 0.1 ) );
				float n2 = noise( rotC * cUV * 1.62 + vec2( 37.2, - 11.7 ) - vec2( ct * 0.2, - ct * 0.2 ) );
				float web = abs( n1 - n2 );
				// Caustics fade out with distance instead of popping off
				float caustic = pow( max( 0.0, 1.0 - web ), 30.0 ) * 0.6 * vCausticDistFade;
				refrColor += vec3( caustic * vec3( 0.65, 0.8, 0.9 ) );

				// The bluer body tint requested (custom pools stay neutral so the
				// picked color is not shifted back toward blue)
				refrColor *= uTint;

				vec3 final = mix( refrColor, skyColor, fresnel );
				final += vec3( pow( max( dot( rDir, lightDir ), 0.0 ), 450.0 ) * 0.3 );

				// Surface texture: foam caps the tallest crests, tiny sun
				// glints shimmer across the ripples
				float foam = smoothstep( 0.13, 0.2, vWaveH );
				final = mix( final, vec3( 0.85, 0.95, 1.0 ), foam * 0.4 );
				// Shimmer fades with the waves — far water is a calm blue plane
				float glint = pow( max( 0.0, noise( vWorldPos.xz * 6.5 + vec2( time * 0.7, - time * 0.4 ) ) - 0.62 ), 3.0 );
				final += glint * 0.5 * vWaveDistFade * vec3( 0.9, 0.97, 1.0 );
				gl_FragColor = vec4( final, 1.0 );
			}
		`,
		// Opaque on purpose: the refraction sample already shows everything
		// under the surface. Alpha-blending the raw scene back in (the old
		// "transparent" mode) put an un-wiggled ghost of the pool/car on top.
		transparent: false,
		depthWrite: true,
		side: THREE.DoubleSide,
	} );

}

// Animated caustic overlay projected onto each pool floor. Gain is 0 while
// the camera is above water (the classic look already carries caustics through
// the surface refraction) and eases to full ONLY when the camera is underwater.
function createPoolFloorCausticsMaterial() {

	return new THREE.ShaderMaterial( {
		uniforms: {
			time: { value: 0 },
			gain: { value: 0 },
			shade: { value: 1 },
			lightDir: { value: new THREE.Vector3( 0.577, 0.577, 0.577 ).normalize() },
		},
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexShader: `
			varying vec2 vLocal;
			void main() {
				vLocal = position.xy;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}
		`,
		fragmentShader: `
			uniform float time;
			uniform float gain;
			uniform float shade;
			varying vec2 vLocal;
			// Sin-free hash (iq): the old fract(sin(dot)*43758) hash loses precision
			// on large coords and printed a repeating CROSS/X lattice artifact
			// across the water. This one stays clean at any distance.
			float hash( vec2 p ) {
				p = 50.0 * fract( p * 0.3183099 + vec2( 0.71, 0.113 ) );
				return fract( p.x * p.y * ( p.x + p.y ) );
			}
			float noise( vec2 p ) {
				vec2 i = floor( p ), f = fract( p );
				f = f * f * ( 3.0 - 2.0 * f );
				return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
					mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
			}
			void main() {
				if ( gain <= 0.001 ) discard;
				float ct = time * 1.9;
				// Rotated + differently-scaled domains so the two integer
				// lattices never align (aligned ones drew the cross/X pattern).
				mat2 rotC = mat2( 0.84, 0.54, -0.54, 0.84 );
				vec2 cUV = rotC * vLocal * 1.85;
				float n1 = noise( cUV * 1.15 + vec2( ct * 0.32, ct * 0.11 ) );
				float n2 = noise( cUV * 1.62 + vec2( 37.2, - 11.7 ) - vec2( ct * 0.21, - ct * 0.24 ) );
				float web = abs( n1 - n2 );
				// Caustics are LIGHT — the shade uniform (N·L toward the sun)
				// fades them out on surfaces that sit in shadow.
				float caustic = pow( max( 0.0, 1.0 - web ), 22.0 ) * shade;
				gl_FragColor = vec4( vec3( 0.62, 0.82, 0.95 ) * caustic * gain * 0.85, caustic * gain );
			}
		`,
	} );

}

// Caustic film for the INNER pool walls: vertical bands that fade out at the
// water line (nothing above the surface) and dim with depth. `shade` is the
// N·L term toward the sun — walls facing away from the light sit in shade and
// get no caustics, matching the floor overlay's behavior.
function createPoolWallCausticsMaterial() {

	return new THREE.ShaderMaterial( {
		uniforms: {
			time: { value: 0 },
			gain: { value: 0 },
			shade: { value: 1 },
			centerY: { value: 0 },
			waterY: { value: 0.12 },
		},
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexShader: `
			varying vec2 vLocal;
			void main() {
				vLocal = position.xy;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}
		`,
		fragmentShader: `
			uniform float time;
			uniform float gain;
			uniform float shade;
			uniform float centerY;
			uniform float waterY;
			varying vec2 vLocal;
			float hash( vec2 p ) {
				p = 50.0 * fract( p * 0.3183099 + vec2( 0.71, 0.113 ) );
				return fract( p.x * p.y * ( p.x + p.y ) );
			}
			float noise( vec2 p ) {
				vec2 i = floor( p ), f = fract( p );
				f = f * f * ( 3.0 - 2.0 * f );
				return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
					mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
			}
			void main() {
				if ( gain <= 0.001 ) discard;
				float ct = time * 1.9;
				mat2 rotC = mat2( 0.84, 0.54, - 0.54, 0.84 );
				vec2 cUV = rotC * vec2( vLocal.x * 1.45, vLocal.y * 1.1 );
				float n1 = noise( cUV * 1.15 + vec2( ct * 0.32, ct * 0.11 ) );
				float n2 = noise( cUV * 1.62 + vec2( 37.2, - 11.7 ) - vec2( ct * 0.21, - ct * 0.24 ) );
				float web = abs( n1 - n2 );
				float caustic = pow( max( 0.0, 1.0 - web ), 22.0 );
				// Fade to nothing AT the water line (dry wall stays clean) and
				// dim a little with depth, like real light attenuation.
				float worldY = centerY + vLocal.y;
				float surfaceFade = smoothstep( 0.0, 0.07, waterY - worldY );
				float depthFade = clamp( 0.45 + ( waterY - worldY ) * 0.9, 0.35, 1.0 );
				caustic *= surfaceFade * depthFade * shade;
				gl_FragColor = vec4( vec3( 0.62, 0.82, 0.95 ) * caustic * gain * 0.8, caustic * gain );
			}
		`,
	} );

}

// Shared per-frame animation for every caustic overlay (floor + walls): tick
// the clock and ease the gain toward the underwater camera state. 6/s easing
// makes the water↔normal transition feel instant.
function attachCausticAnimator( mesh ) {

	let last = 0;
	mesh.onBeforeRender = () => {

		const now = performance.now() * 0.001;
		const u = mesh.material.uniforms;
		u.time.value = now;
		const targetGain = WATER_UNDERWATER.camera ? 1 : 0;
		const step = Math.min( 1, Math.max( 0, now - last ) * 6.0 );
		last = now;
		u.gain.value = THREE.MathUtils.lerp( u.gain.value, targetGain, step );

	};

}

// Sun direction matches main.js's shadow-casting directional light
// (11.4, 15, -5.3) so caustic shading agrees with the scene's shadows.
const CAUSTIC_SUN_DIR = new THREE.Vector3( 11.4, 15, - 5.3 ).normalize();
const _upShadeNormal = new THREE.Vector3( 0, 1, 0 );
function computeCausticShade( normal ) {

	return THREE.MathUtils.smoothstep( THREE.MathUtils.clamp( normal.dot( CAUSTIC_SUN_DIR ), - 1, 1 ), - 0.05, 0.45 );

}

const ELEVATED_TYPES = new Set( [ 'elevated-straight', 'elevated-cross', 'elevated-corner', 'elevated-checkpoint', 'slope-up', 'slope-down', 'elevated-3-way', 'elevated-4-way' ] );

function normalizeElevatedEntry( elevatedType, orient = 0 ) {

	if ( elevatedType === 'slope-down' ) return { type: 'slope-up', orient: ORIENT_180[ orient ] ?? orient };
	return { type: elevatedType, orient };

}

function getOverlayHeightOffset( elevatedEntry ) {

	if ( ! elevatedEntry ) return 0;
	return elevatedEntry.type === 'slope-up' ? ELEVATED_HEIGHT * 0.5 : ELEVATED_HEIGHT;

}

function getSurfaceVisual( surfaceType, customSurfaces = null, customPads = null ) {

	switch ( surfaceType ) {

		case 'surface-ice': return { color: 0x7ad8ff, emissive: 0x1f6f8a, metalness: 0.2, roughness: 0.15 };
		case 'surface-boost': return { color: 0xff4b4b, emissive: 0xc1121f, metalness: 0.0, roughness: 0.9 };
		case 'surface-sand': return { color: 0xd7b46a, emissive: 0x6f4f22, metalness: 0.0, roughness: 1.0 };
		case 'surface-bounce': return { color: 0xbaff7a, emissive: 0x2f8f2f, metalness: 0.0, roughness: 0.75 };
		case 'surface-kick-l': return { color: 0xc683ff, emissive: 0x54208f, metalness: 0.0, roughness: 0.8 };
		case 'surface-kick-r': return { color: 0xff83d0, emissive: 0x8f2054, metalness: 0.0, roughness: 0.8 };
		case 'pad-reset': return { color: 0xffffff, emissive: 0x557c92, metalness: 0.1, roughness: 0.35 };
		case 'pad-low-gravity': return { color: 0x9bc2ff, emissive: 0x2e4f9f, metalness: 0.05, roughness: 0.55 };
		case 'pad-heavy-gravity': return { color: 0x4a5f85, emissive: 0x111b36, metalness: 0.05, roughness: 0.8 };
		case 'pad-high-grip': return { color: 0x5cff9a, emissive: 0x0d6a39, metalness: 0.02, roughness: 0.95 };
		case 'pad-high-speed': return { color: 0xffbc4f, emissive: 0x8a4e06, metalness: 0.0, roughness: 0.8 };
		case 'pad-no-brakes': return { color: 0xff6f6f, emissive: 0x7d1a1a, metalness: 0.0, roughness: 0.82 };
		case 'pad-no-steering': return { color: 0xff7ed8, emissive: 0x7a1f65, metalness: 0.02, roughness: 0.78 };
		case 'pad-no-acceleration': return { color: 0x85ffd8, emissive: 0x156e58, metalness: 0.0, roughness: 0.72 };
		case 'pad-slow-motion': return { color: 0x6ab5ff, emissive: 0x104f88, metalness: 0.05, roughness: 0.68 };
		case 'pad-fast-motion': return { color: 0xff9f3c, emissive: 0x8a2f00, metalness: 0.02, roughness: 0.7 };
		case 'pad-drift': return { color: 0xd6ff6a, emissive: 0x5c7a0f, metalness: 0.03, roughness: 0.8 };
		case 'pad-size-small': return { color: 0x58dcff, emissive: 0x156b8f, metalness: 0.04, roughness: 0.72 };
		case 'pad-size-normal': return { color: 0xffffff, emissive: 0x4f5f7a, metalness: 0.06, roughness: 0.7 };
		case 'pad-size-mega': return { color: 0xff8c5a, emissive: 0x7a2f12, metalness: 0.02, roughness: 0.78 };
		case 'pad-trick-yaw-1':
		case 'pad-trick-pitch-1':
		case 'pad-trick-roll-1':
		case 'pad-trick-yaw-pitch-1':
		case 'pad-trick-yaw-roll-1':
		case 'pad-trick-pitch-roll-1':
		case 'pad-trick-yaw-pitch-roll-1':
		case 'pad-trick-yaw-roll-pitch':
		case 'pad-trick-pitch-yaw-roll':
			return { color: 0x9c7dff, emissive: 0x311c72, metalness: 0.06, roughness: 0.62 };
		case 'pad-custom-a':
		case 'pad-custom-b':
		case 'pad-custom-c': {
			const colorHex = customPads?.[ surfaceType ]?.color || '#88c4ff';
			const color = new THREE.Color( colorHex );
			return { color: color.getHex(), emissive: color.clone().multiplyScalar( 0.45 ).getHex(), metalness: 0.04, roughness: 0.72 };
		}
		case 'surface-custom-a':
		case 'surface-custom-b':
		case 'surface-custom-c': {
			const colorHex = customSurfaces?.[ surfaceType ]?.color || '#9c7bff';
			const color = new THREE.Color( colorHex );
			return { color: color.getHex(), emissive: color.clone().multiplyScalar( 0.45 ).getHex(), metalness: 0.02, roughness: 0.72 };
		}
		default: return { color: 0xb88657, emissive: 0x4a2b12, metalness: 0.0, roughness: 0.9 };

	}

}

function cloneElevatedPiece( models, type, orient, gx, gz ) {

	if ( type === 'slope-down' ) {

		type = 'slope-up';
		orient = ORIENT_180[ orient ] ?? orient;

	}

	let modelKey = null;
	if ( type === 'elevated-straight' ) modelKey = 'elev-track-straight';
	else if ( type === 'elevated-cross' ) modelKey = 'elev-track-cross';
	else if ( type === 'elevated-corner' ) modelKey = 'elev-track-corner';
	else if ( type === 'elevated-checkpoint' ) modelKey = 'elev-track-checkpoint';
	else if ( type === 'slope-up' || type === 'slope-down' ) modelKey = 'elev-track-slope';
	else if ( type === 'elevated-3-way' ) modelKey = 'elev-track-3-way';
	else if ( type === 'elevated-4-way' ) modelKey = 'elev-track-4-way';
	if ( ! modelKey || ! models[ modelKey ] ) return null;

	const piece = models[ modelKey ].clone();
	// Slope model is pre-sloped at the correct size — place at ground level, no scaling
	const yAdjust = ( type === 'slope-up' || type === 'slope-down' ) ? - ELEVATED_HEIGHT : 0;
	piece.position.set(
		( gx + 0.5 ) * CELL_RAW,
		0.5 + VISUAL_HEIGHT_OFFSET + ELEVATED_HEIGHT + yAdjust,
		( gz + 0.5 ) * CELL_RAW
	);
	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );

	return piece;

}

function createSlopeSupportGeometry( slopeType ) {

	const geometry = new THREE.BoxGeometry( CELL_RAW, SUPPORT_HEIGHT, CELL_RAW );
	const position = geometry.attributes.position;
	const halfHeight = SUPPORT_HEIGHT * 0.5;
	const isSlopeUp = slopeType === 'slope-up';
	for ( let i = 0; i < position.count; i ++ ) {

		const y = position.getY( i );
		if ( y < halfHeight - 1e-5 ) continue;
		const z = position.getZ( i );
		const nearIsLow = isSlopeUp;
		const isNearEdge = z >= 0;
		const topY = ( nearIsLow ? ( isNearEdge ? 0 : SUPPORT_HEIGHT ) : ( isNearEdge ? SUPPORT_HEIGHT : 0 ) ) - halfHeight;
		position.setY( i, topY );

	}
	position.needsUpdate = true;
	geometry.computeVertexNormals();
	return geometry;

}

function createElevatedSupport( gx, gz, orient = 0, elevatedType = 'elevated-straight' ) {

	if ( elevatedType === 'slope-down' ) {

		elevatedType = 'slope-up';
		orient = ORIENT_180[ orient ] ?? orient;

	}

	const geometry = elevatedType === 'slope-up' || elevatedType === 'slope-down'
		? createSlopeSupportGeometry( elevatedType )
		: new THREE.BoxGeometry( CELL_RAW, SUPPORT_HEIGHT, CELL_RAW );

	const support = new THREE.Mesh(
		geometry,
		new THREE.MeshStandardMaterial( { color: SUPPORT_COLOR, roughness: 0.95, metalness: 0.0 } )
	);
	support.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + VISUAL_HEIGHT_OFFSET + ( SUPPORT_HEIGHT * 0.5 ) - SUPPORT_SINK, ( gz + 0.5 ) * CELL_RAW );
	support.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
	support.castShadow = true;
	support.receiveShadow = true;
	return support;

}

export const TRACK_CELLS = [
	[ -3, -3, 'track-corner',   16 ],
	[ -2, -3, 'track-checkpoint', 22 ],
	[ -1, -3, 'track-straight', 22 ],
	[  0, -3, 'track-corner',    0 ],
	[ -3, -2, 'track-straight',  0 ],
	[  0, -2, 'track-straight',  0 ],
	[ -3, -1, 'track-corner',   10 ],
	[ -2, -1, 'track-corner',    0 ],
	[  0, -1, 'track-straight',  0 ],
	[ -2,  0, 'track-checkpoint', 10 ],
	[  0,  0, 'track-finish',    0 ],
	[ -2,  1, 'track-straight', 10 ],
	[  0,  1, 'track-straight',  0 ],
	[ -2,  2, 'track-corner',   10 ],
	[ -1,  2, 'track-straight', 16 ],
	[  0,  2, 'track-corner',   22 ],
];

const DECO_CELLS = [
	[ -4, -2, 'decoration-tents', 10 ],
	[ -1, -4, 'decoration-tents', 22 ],
	[ -1,  1, 'decoration-tents', 22 ],
	[ -8, -9, 'decoration-forest', 0 ], [ -7, -9, 'decoration-forest', 0 ],
	[ -6, -9, 'decoration-forest', 0 ], [ -5, -9, 'decoration-forest', 0 ],
	[ -4, -9, 'decoration-forest', 0 ], [ -3, -9, 'decoration-forest', 0 ],
	[ -2, -9, 'decoration-forest', 0 ], [ -1, -9, 'decoration-forest', 0 ],
	[  0, -9, 'decoration-forest', 0 ], [  1, -9, 'decoration-forest', 0 ],
	[  2, -9, 'decoration-forest', 0 ],
	[ -8, -8, 'decoration-forest', 0 ], [ -7, -8, 'decoration-forest', 0 ],
	[ -6, -8, 'decoration-forest', 0 ], [ -5, -8, 'decoration-forest', 0 ],
	[ -4, -8, 'decoration-forest', 0 ], [ -3, -8, 'decoration-forest', 0 ],
	[ -2, -8, 'decoration-forest', 0 ], [ -1, -8, 'decoration-forest', 0 ],
	[  0, -8, 'decoration-forest', 0 ], [  1, -8, 'decoration-forest', 0 ],
	[  2, -8, 'decoration-forest', 0 ],
	[ -8, -7, 'decoration-forest', 0 ], [ -7, -7, 'decoration-forest', 0 ],
	[ -6, -7, 'decoration-forest', 0 ], [ -5, -7, 'decoration-forest', 0 ],
	[ -4, -7, 'decoration-forest', 0 ], [ -3, -7, 'decoration-forest', 0 ],
	[ -2, -7, 'decoration-forest', 0 ], [ -1, -7, 'decoration-forest', 0 ],
	[  0, -7, 'decoration-forest', 0 ], [  1, -7, 'decoration-forest', 0 ],
	[  2, -7, 'decoration-forest', 0 ],
	[ -8, -6, 'decoration-forest', 0 ], [ -7, -6, 'decoration-forest', 0 ],
	[ -6, -6, 'decoration-forest', 0 ], [ -5, -6, 'decoration-forest', 0 ],
	[ -4, -6, 'decoration-forest', 0 ], [ -3, -6, 'decoration-empty', 0 ],
	[ -2, -6, 'decoration-empty', 0 ],  [ -1, -6, 'decoration-empty', 0 ],
	[  0, -6, 'decoration-empty', 0 ],  [  1, -6, 'decoration-forest', 0 ],
	[  2, -6, 'decoration-forest', 0 ],
	[ -8, -5, 'decoration-forest', 0 ], [ -7, -5, 'decoration-forest', 0 ],
	[ -6, -5, 'decoration-forest', 0 ], [ -5, -5, 'decoration-forest', 0 ],
	[ -4, -5, 'decoration-empty', 0 ],  [ -3, -5, 'decoration-empty', 0 ],
	[ -2, -5, 'decoration-empty', 0 ],  [ -1, -5, 'decoration-empty', 0 ],
	[  0, -5, 'decoration-empty', 0 ],  [  1, -5, 'decoration-forest', 0 ],
	[  2, -5, 'decoration-forest', 0 ],
	[ -8, -4, 'decoration-forest', 0 ], [ -7, -4, 'decoration-forest', 0 ],
	[ -6, -4, 'decoration-forest', 0 ], [ -5, -4, 'decoration-forest', 0 ],
	[ -4, -4, 'decoration-empty', 0 ],
	[  1, -4, 'decoration-forest', 0 ],
	[  2, -4, 'decoration-forest', 0 ],
	[ -8, -3, 'decoration-forest', 0 ], [ -7, -3, 'decoration-forest', 0 ],
	[ -6, -3, 'decoration-forest', 0 ], [ -5, -3, 'decoration-forest', 0 ],
	[ -4, -3, 'decoration-empty', 0 ],
	[  1, -3, 'decoration-forest', 0 ],
	[  2, -3, 'decoration-forest', 0 ],
	[ -8, -2, 'decoration-forest', 0 ], [ -7, -2, 'decoration-forest', 0 ],
	[ -6, -2, 'decoration-forest', 0 ], [ -5, -2, 'decoration-forest', 0 ],
	[  1, -2, 'decoration-forest', 0 ],
	[  2, -2, 'decoration-forest', 0 ],
	[ -8, -1, 'decoration-forest', 0 ], [ -7, -1, 'decoration-forest', 0 ],
	[ -6, -1, 'decoration-forest', 0 ], [ -5, -1, 'decoration-forest', 0 ],
	[ -4, -1, 'decoration-empty', 0 ],  [ -1, -1, 'decoration-empty', 0 ],
	[  1, -1, 'decoration-forest', 0 ],
	[  2, -1, 'decoration-forest', 0 ],
	[ -8,  0, 'decoration-forest', 0 ], [ -7,  0, 'decoration-forest', 0 ],
	[ -6,  0, 'decoration-forest', 0 ], [ -5,  0, 'decoration-forest', 0 ],
	[ -4,  0, 'decoration-empty', 0 ],  [ -3,  0, 'decoration-empty', 0 ],
	[ -1,  0, 'decoration-empty', 0 ],
	[  1,  0, 'decoration-forest', 0 ],
	[  2,  0, 'decoration-forest', 0 ],
	[ -8,  1, 'decoration-forest', 0 ], [ -7,  1, 'decoration-forest', 0 ],
	[ -6,  1, 'decoration-forest', 0 ], [ -5,  1, 'decoration-forest', 0 ],
	[ -4,  1, 'decoration-empty', 0 ],  [ -3,  1, 'decoration-empty', 0 ],
	[  1,  1, 'decoration-forest', 0 ],
	[  2,  1, 'decoration-forest', 0 ],
	[ -8,  2, 'decoration-forest', 0 ], [ -7,  2, 'decoration-forest', 0 ],
	[ -6,  2, 'decoration-forest', 0 ], [ -5,  2, 'decoration-forest', 0 ],
	[ -4,  2, 'decoration-empty', 0 ],  [ -3,  2, 'decoration-empty', 0 ],
	[  1,  2, 'decoration-forest', 0 ],
	[  2,  2, 'decoration-forest', 0 ],
	[ -8,  3, 'decoration-forest', 0 ], [ -7,  3, 'decoration-forest', 0 ],
	[ -6,  3, 'decoration-forest', 0 ], [ -5,  3, 'decoration-forest', 0 ],
	[ -4,  3, 'decoration-forest', 0 ], [ -3,  3, 'decoration-forest', 0 ],
	[ -2,  3, 'decoration-forest', 0 ], [ -1,  3, 'decoration-forest', 0 ],
	[  0,  3, 'decoration-forest', 0 ], [  1,  3, 'decoration-forest', 0 ],
	[  2,  3, 'decoration-forest', 0 ],
	[ -8,  4, 'decoration-forest', 0 ], [ -7,  4, 'decoration-forest', 0 ],
	[ -6,  4, 'decoration-forest', 0 ], [ -5,  4, 'decoration-forest', 0 ],
	[ -4,  4, 'decoration-forest', 0 ], [ -3,  4, 'decoration-forest', 0 ],
	[ -2,  4, 'decoration-forest', 0 ], [ -1,  4, 'decoration-forest', 0 ],
	[  0,  4, 'decoration-forest', 0 ], [  1,  4, 'decoration-forest', 0 ],
	[  2,  4, 'decoration-forest', 0 ],
];

const NPC_TRUCKS = [
	[ 'vehicle-truck-green',  -3.51, -0.01,  12.70,  98.0 ],
	[ 'vehicle-truck-purple', -23.78, -0.14, -13.56,   0.0 ],
	[ 'vehicle-truck-red',    -1.36, -0.15, -23.80, 155.9 ],
];


export function computePoolPresetWaterCells( cells = TRACK_CELLS, extras = null ) {

	const roadCells = [];
	const occupied = new Set();
	const addOccupied = ( gx, gz ) => {
		if ( Number.isFinite( Number( gx ) ) && Number.isFinite( Number( gz ) ) ) occupied.add( `${ Number( gx ) },${ Number( gz ) }` );
	};
	const addRoad = ( gx, gz ) => {
		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) return;
		const nx = Number( gx );
		const nz = Number( gz );
		roadCells.push( [ nx, nz ] );
		addOccupied( nx, nz );
	};

	for ( const [ gx, gz ] of ( Array.isArray( cells ) && cells.length ? cells : TRACK_CELLS ) ) addRoad( gx, gz );
	const blockerLists = [ extras?.bumps, extras?.poles, extras?.cubes, extras?.walls, extras?.jumps, extras?.movingObstacles, extras?.elevated, extras?.surfaces, extras?.decorations, extras?.magnets, extras?.arcLinks ];
	for ( const list of blockerLists ) {
		if ( ! Array.isArray( list ) ) continue;
		for ( const entry of list ) {
			if ( ! Array.isArray( entry ) ) continue;
			addOccupied( entry[ 0 ], entry[ 1 ] );
			roadCells.push( [ Number( entry[ 0 ] ), Number( entry[ 1 ] ) ] );
		}
	}

	if ( roadCells.length === 0 ) addRoad( 0, 0 );
	let minGx = Infinity, maxGx = - Infinity, minGz = Infinity, maxGz = - Infinity;
	for ( const [ gx, gz ] of roadCells ) {
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		minGx = Math.min( minGx, gx );
		maxGx = Math.max( maxGx, gx );
		minGz = Math.min( minGz, gz );
		maxGz = Math.max( maxGz, gz );
	}
	const pad = 12;
	const water = [];
	for ( let gx = minGx - pad; gx <= maxGx + pad; gx ++ ) {
		for ( let gz = minGz - pad; gz <= maxGz + pad; gz ++ ) {
			if ( ! occupied.has( `${ gx },${ gz }` ) ) water.push( [ gx, gz ] );
		}
	}
	return water;

}

export function buildTrack( scene, models, customCells, extras = null ) {

	const trackGroup = new THREE.Group();
	trackGroup.position.y = -0.5;

	const trackPieceGroup = new THREE.Group();
	const decoGroup = new THREE.Group();

	const cells = customCells || TRACK_CELLS;
	const waterCellsForDeco = extras && Array.isArray( extras.water ) ? extras.water : [];

	for ( const [ gx, gz, key, orient ] of cells ) {

		const piece = placePiece( models, key, gx, gz, orient );
		if ( piece ) trackPieceGroup.add( piece );

	}

	if ( extras ) {

		const bumpCells = Array.isArray( extras.bumps ) ? extras.bumps : [];
		const boostCells = Array.isArray( extras.boosts ) ? extras.boosts : [];
		const jumpCells = Array.isArray( extras.jumps ) ? extras.jumps : [];
		const cubeCells = Array.isArray( extras.cubes ) ? extras.cubes : [];
		const wallCells = Array.isArray( extras.walls ) ? extras.walls : [];
		const poleCells = Array.isArray( extras.poles ) ? extras.poles : [];
		const elevatedCells = Array.isArray( extras.elevated ) ? extras.elevated : [];
		const decorations = Array.isArray( extras.decorations ) ? extras.decorations : [];
		const surfaces = Array.isArray( extras.surfaces ) ? extras.surfaces : [];
		const magnets = Array.isArray( extras.magnets ) ? extras.magnets : [];
		const arcLinks = Array.isArray( extras.arcLinks ) ? extras.arcLinks : [];
		const waterCells = Array.isArray( extras.water ) ? extras.water : [];
		const poolSlopeCells = Array.isArray( extras.poolSlopes ) ? extras.poolSlopes : [];
		const customSurfaces = extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {};
		const customPads = extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {};
		const poolVisuals = normalizePoolVisuals( extras );
		// Rebuilt from scratch every track build — drop planes from the previous track.
		WATER_PLANES.length = 0;
		const elevatedMap = new Map();
		for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedCells ) {

			if ( ! ELEVATED_TYPES.has( elevatedType ) ) continue;
			elevatedMap.set( `${ gx },${ gz }`, normalizeElevatedEntry( elevatedType, orient ) );

		}
		// Cells covered by a slope block (slope-up / slope-down). Trees must
		// not spawn under a slope, so both auto-forest and hand-placed
		// decorations skip these cells.
		const slopeCells = new Set();
		for ( const [ gx, gz, elevatedType ] of elevatedCells ) {

			if ( elevatedType === 'slope-up' || elevatedType === 'slope-down' ) {

				slopeCells.add( `${ Number( gx ) },${ Number( gz ) }` );

			}

		}

		const waterSet = new Set( waterCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
		const isWaterCell = ( gx, gz ) => waterSet.has( `${ gx },${ gz }` );
		// Build a quick lookup of pool slope orientation per cell for edge removal.
		const poolSlopeOrientByCell = new Map();
		for ( const [ gx, gz, orient = 0 ] of poolSlopeCells ) {

			poolSlopeOrientByCell.set( `${ Number( gx ) },${ Number( gz ) }`, orient || 0 );

		}
		if ( waterCells.length > 0 ) {

			let minWaterGx = Infinity, maxWaterGx = - Infinity, minWaterGz = Infinity, maxWaterGz = - Infinity;
			for ( const [ gx, gz ] of waterCells ) {

				minWaterGx = Math.min( minWaterGx, gx );
				maxWaterGx = Math.max( maxWaterGx, gx + 1 );
				minWaterGz = Math.min( minWaterGz, gz );
				maxWaterGz = Math.max( maxWaterGz, gz + 1 );

			}
			const waterWidth = Math.max( CELL_RAW, ( maxWaterGx - minWaterGx + 2 ) * CELL_RAW );
			const waterDepth = Math.max( CELL_RAW, ( maxWaterGz - minWaterGz + 2 ) * CELL_RAW );
			// Subdivided so the vertex-stage wave height field has geometry to bend.
			const waterSeg = THREE.MathUtils.clamp( Math.round( Math.max( waterWidth, waterDepth ) / CELL_RAW ) * 32, 32, 128 );
			const waterPlane = new THREE.Mesh(
				new THREE.PlaneGeometry( waterWidth, waterDepth, waterSeg, waterSeg ),
				createRepositoryWaterMaterial( poolVisuals )
			);
			waterPlane.rotation.x = - Math.PI / 2;
			waterPlane.position.set( ( ( minWaterGx + maxWaterGx ) * 0.5 ) * CELL_RAW, 0.12, ( ( minWaterGz + maxWaterGz ) * 0.5 ) * CELL_RAW );
			waterPlane.userData.waterSurface = true;
			WATER_PLANES.push( waterPlane );
			// Cache the world-space bounding sphere once — the frustum gate
			// tests it every frame, and pool planes never move after this.
			waterPlane.updateMatrixWorld();
			waterPlane.geometry.computeBoundingSphere();
			waterPlane.userData.waterWorldSphere = waterPlane.geometry.boundingSphere.clone().applyMatrix4( waterPlane.matrixWorld );
			waterPlane.onBeforeRender = () => {

				waterPlane.material.uniforms.time.value = performance.now() * 0.001;

			};
			trackPieceGroup.add( waterPlane );

		}
		for ( const [ gx, gz ] of waterCells ) {

			const pool = new THREE.Group();
			pool.position.set( ( gx + 0.5 ) * CELL_RAW, 0, ( gz + 0.5 ) * CELL_RAW );
			const { poolWallTexture, poolFloorTexture } = getPoolTextures();
			const floor = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW, CELL_RAW * 0.04, CELL_RAW ),
				new THREE.MeshStandardMaterial( { map: poolFloorTexture, roughness: 0.82, metalness: 0.0 } )
			);
			floor.position.y = - WATER_DEPTH;
			floor.receiveShadow = true;
			pool.add( floor );
			// Caustic light layer just above the floor tile — visible only
			// while the camera is underwater (see createPoolFloorCausticsMaterial).
			const causticOverlay = new THREE.Mesh(
				new THREE.PlaneGeometry( CELL_RAW, CELL_RAW ),
				createPoolFloorCausticsMaterial()
			);
			causticOverlay.rotation.x = - Math.PI / 2;
			causticOverlay.position.y = - WATER_DEPTH + CELL_RAW * 0.028;
			// Floor faces up, so its caustic shade is the sun's own up-term —
			// any surface the sun can't reach stays dark (shared with walls).
			causticOverlay.material.uniforms.shade.value = computeCausticShade( _upShadeNormal );
			attachCausticAnimator( causticOverlay );
			pool.add( causticOverlay );
			// If this pool tile has a pool slope, omit the wall + edge lip on the
			// exit side (where the ramp's high end meets ground level).
			const slopeOrient = poolSlopeOrientByCell.get( `${ gx },${ gz }` );
			let exitSide = null;
			if ( slopeOrient !== undefined ) {
				const rad = THREE.MathUtils.degToRad( ORIENT_DEG[ slopeOrient ] ?? 0 );
				// High end is opposite the low end (+z at orient 0).
				exitSide = `${ - Math.round( Math.sin( rad ) ) },${ - Math.round( Math.cos( rad ) ) }`;
			}
			const sides = [
				{ dx: 0, dz: - 1, x: 0, z: - CELL_RAW * 0.5, ry: 0 },
				{ dx: 1, dz: 0, x: CELL_RAW * 0.5, z: 0, ry: Math.PI / 2 },
				{ dx: 0, dz: 1, x: 0, z: CELL_RAW * 0.5, ry: 0 },
				{ dx: - 1, dz: 0, x: - CELL_RAW * 0.5, z: 0, ry: Math.PI / 2 },
			];
			for ( const side of sides ) {
				if ( isWaterCell( gx + side.dx, gz + side.dz ) ) continue;
				if ( exitSide === `${ side.dx },${ side.dz }` ) continue;
				const wall = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, WATER_WALL_HEIGHT, CELL_RAW * 0.08 ), new THREE.MeshStandardMaterial( { map: poolWallTexture, roughness: 0.7, metalness: 0.0 } ) );
				wall.position.set( side.x, 0.5 - WATER_WALL_HEIGHT * 0.5, side.z );
				wall.rotation.y = side.ry;
				wall.castShadow = true;
				wall.receiveShadow = true;
				pool.add( wall );
				// Caustic light film on the wall's INNER face — same animated
				// pattern as the floor, shaded by how directly the wall faces
				// the sun (walls in shade get none).
				const wallCaustic = new THREE.Mesh(
					new THREE.PlaneGeometry( CELL_RAW, WATER_WALL_HEIGHT * 0.94 ),
					createPoolWallCausticsMaterial()
				);
				const inward = new THREE.Vector3( - side.dx, 0, - side.dz );
				wallCaustic.position.set(
					side.x + inward.x * CELL_RAW * 0.052,
					wall.position.y,
					side.z + inward.z * CELL_RAW * 0.052
				);
				wallCaustic.lookAt( wallCaustic.position.clone().add( inward ) );
				wallCaustic.material.uniforms.shade.value = computeCausticShade( inward );
				wallCaustic.material.uniforms.centerY.value = wall.position.y;
				wallCaustic.material.uniforms.waterY.value = 0.12;
				attachCausticAnimator( wallCaustic );
				pool.add( wallCaustic );
				const edge = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, CELL_RAW * 0.035, CELL_RAW * 0.09 ), new THREE.MeshStandardMaterial( { color: poolVisuals.edgeColor, emissive: poolVisuals.edgeColor, emissiveIntensity: poolVisuals.isCustom ? 0.55 : 0.3, roughness: 0.22, metalness: 0.12 } ) );
				edge.position.set( side.x, 0.515, side.z );
				edge.rotation.y = side.ry;
				pool.add( edge );
			}
			trackPieceGroup.add( pool );

		}

		// Pool slope: the normal elev-track-slope GLB placed at ground/block
		// level facing the slope's orient (no 180 flip, no elevation offset).
		for ( const [ gxRaw, gzRaw, orient = 0 ] of poolSlopeCells ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const slopeSrc = models[ 'elev-track-slope' ];
			if ( ! slopeSrc ) continue;
			const slope = slopeSrc.clone();
			slope.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + VISUAL_HEIGHT_OFFSET - 5, ( gz + 0.5 ) * CELL_RAW );
			slope.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			slope.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = true; c.receiveShadow = true; } } );
			trackPieceGroup.add( slope );

		}

		for ( const [ gx, gz ] of bumpCells ) {

			const piece = placePiece( models, 'track-bump', gx, gz, 0 );
			if ( piece ) {

				const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
				piece.position.y += yOffset;
				trackPieceGroup.add( piece );

			}

		}

		for ( const [ gx, gz ] of poleCells ) {

			const pole = new THREE.Mesh(
				new THREE.CylinderGeometry( POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 16 ),
				new THREE.MeshStandardMaterial( { color: 0x8c8f96, roughness: 0.65, metalness: 0.15 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			pole.position.set( ( gx + 0.5 ) * CELL_RAW, ( POLE_HEIGHT * 0.5 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			pole.castShadow = true;
			pole.receiveShadow = true;
			trackPieceGroup.add( pole );

		}

		for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedCells ) {

			if ( ! ELEVATED_TYPES.has( elevatedType ) ) continue;
			const piece = cloneElevatedPiece( models, elevatedType, orient, gx, gz );
			if ( piece ) trackPieceGroup.add( piece );
			// Black support box removed — elevated models have built-in supports

		}

		for ( const [ gx, gz ] of cubeCells ) {

			const cube = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.16, CELL_RAW * 0.16, CELL_RAW * 0.16 ),
				new THREE.MeshStandardMaterial( { color: 0x9da5b1, roughness: 0.65, metalness: 0.08 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			cube.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.08 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			cube.castShadow = true;
			cube.receiveShadow = true;
			trackPieceGroup.add( cube );

		}

		for ( const [ gxRaw, gzRaw, yGridRaw, variant ] of magnets ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const magnetKind = String( variant );
			const isRed = magnetKind === 'red';
			const isGrapple = magnetKind === 'grapple';
			const magnet = new THREE.Mesh(
				isGrapple
					? new THREE.SphereGeometry( MAGNET_HALF_SIZE * 0.95, 14, 10 )
					: new THREE.BoxGeometry( MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2 ),
				new THREE.MeshStandardMaterial( {
					color: isGrapple ? 0xb48cff : ( isRed ? 0xff5d5d : 0x4f96ff ),
					emissive: isGrapple ? 0x8a5cff : ( isRed ? 0x7a1111 : 0x1b45a9 ),
					emissiveIntensity: 0.24,
					roughness: 0.5,
					metalness: 0.28,
				} )
			);
			magnet.position.set( ( gx + 0.5 ) * CELL_RAW, MAGNET_BASE_Y + yGrid * CELL_RAW, ( gz + 0.5 ) * CELL_RAW );
			magnet.castShadow = true;
			magnet.receiveShadow = true;
			trackPieceGroup.add( magnet );

		}

		for ( const [ gxRaw, gzRaw, yGridRaw, variant ] of arcLinks ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const arcVariant = String( variant );
			const colors = arcVariant === 'orange'
				? { color: 0xffae52, emissive: 0x8c4b00 }
				: ( arcVariant === 'portal-purple' || arcVariant === 'purple'
					? { color: 0xb468ff, emissive: 0x4a1677 }
					: ( arcVariant === 'portal-yellow' || arcVariant === 'yellow'
						? { color: 0xffef4a, emissive: 0x8f7b00 }
						: { color: 0x6dff6d, emissive: 0x1f6d1f } ) );
			const arcNode = new THREE.Mesh(
				new THREE.BoxGeometry( MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2 ),
				new THREE.MeshStandardMaterial( {
					color: colors.color,
					emissive: colors.emissive,
					emissiveIntensity: 0.24,
					roughness: 0.5,
					metalness: 0.28,
				} )
			);
			arcNode.position.set( ( gx + 0.5 ) * CELL_RAW, MAGNET_BASE_Y + yGrid * CELL_RAW, ( gz + 0.5 ) * CELL_RAW );
			arcNode.castShadow = true;
			arcNode.receiveShadow = true;
			trackPieceGroup.add( arcNode );

		}

		for ( const [ gx, gz, orient = 0 ] of wallCells ) {

			const wall = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.62, CELL_RAW * 0.15, CELL_RAW * 0.08 ),
				new THREE.MeshStandardMaterial( { color: 0x868a90, roughness: 0.75, metalness: 0.05 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			wall.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.075 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			wall.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			wall.castShadow = true;
			wall.receiveShadow = true;
			trackPieceGroup.add( wall );

		}

		for ( const [ gx, gz ] of boostCells ) {

			const piece = placePiece( models, 'track-bump', gx, gz, 0 );
			if ( piece ) {

				piece.traverse( ( c ) => {

					if ( c.isMesh ) {

						c.material = c.material.clone();
						c.material.color = new THREE.Color( 0xff8a00 );
						c.material.emissive = new THREE.Color( 0xff4d00 );
						c.material.emissiveIntensity = 0.6;

					}

				} );
				const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
				piece.position.y += yOffset;
				trackPieceGroup.add( piece );

			}

		}

		for ( const [ gx, gz, orient = 0 ] of jumpCells ) {

			const jump = new THREE.Mesh(
				new THREE.BoxGeometry( JUMP_RAMP_SIZE, JUMP_RAMP_DEPTH, JUMP_RAMP_SIZE ),
				new THREE.MeshStandardMaterial( {
					color: 0x7f6a58,
					roughness: 0.85,
					metalness: 0.02,
				} )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			jump.position.set( ( gx + 0.5 ) * CELL_RAW, JUMP_RAMP_Y + VISUAL_HEIGHT_OFFSET + yOffset, ( gz + 0.5 ) * CELL_RAW );
			jump.rotation.order = 'YXZ';
			jump.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			jump.rotation.x = - JUMP_RAMP_ANGLE;
			jump.castShadow = true;
			jump.receiveShadow = true;
			trackPieceGroup.add( jump );

		}

		for ( const [ gx, gz, key, orient ] of decorations ) {

			if ( waterSet.has( `${ gx },${ gz }` ) ) continue;
			// Don't place a decoration tree under a slope block.
			if ( slopeCells.has( `${ Number( gx ) },${ Number( gz ) }` ) ) continue;
			const piece = placePiece( models, key, gx, gz, orient || 0 );
			if ( piece ) decoGroup.add( piece );

		}

		for ( const [ gx, gz, surfaceType ] of surfaces ) {

			const visual = getSurfaceVisual( surfaceType, customSurfaces, customPads );
			const isPad = String( surfaceType || '' ).startsWith( 'pad-' );
			const geometry = isPad
				? new THREE.CircleGeometry( CELL_RAW * 0.39, 24 )
				: new THREE.PlaneGeometry( CELL_RAW * 0.78, CELL_RAW * 0.78 );
			const material = new THREE.MeshStandardMaterial( {
				color: visual.color,
				emissive: visual.emissive,
				emissiveIntensity: 0.2,
				transparent: true,
				opacity: 0.58,
				metalness: visual.metalness,
				roughness: visual.roughness
			} );
			const elevatedEntry = elevatedMap.get( `${ gx },${ gz }` );
			const addPatch = ( overlayOffset ) => {

				const patch = new THREE.Mesh( geometry, material );
				patch.rotation.x = - Math.PI / 2;
				patch.position.set( ( gx + 0.5 ) * CELL_RAW, 0.505 + VISUAL_HEIGHT_OFFSET + overlayOffset, ( gz + 0.5 ) * CELL_RAW );
				// Slope tilt: surfaces and pads placed on a slope block lie flush with
				// the ramp. The tilt comes from the cell's own elevated entry, so
				// off-grid (fractional) placements work exactly like on-grid ones.
				// The ramp rises toward local -Z, so the plane tilts toward local +Z
				// (downhill) by atan(height / cell).
				if ( elevatedEntry && elevatedEntry.type === 'slope-up' ) {
					patch.rotation.order = 'YXZ';
					patch.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ elevatedEntry.orient ] ?? 0 );
					patch.rotation.x = - Math.PI / 2 + Math.atan2( ELEVATED_HEIGHT, CELL_RAW );
				}
				patch.receiveShadow = true;
				trackPieceGroup.add( patch );
				return patch;

			};
			// Top patch: unchanged normal placement for the block it was
			// painted on.
			addPatch( getOverlayHeightOffset( elevatedEntry ) );
			// Cross blocks: the underpass road below the bridge is a real
			// driving surface, so a pad/surface on the cell also renders a
			// second patch on the bottom road, at the normal ground patch
			// height (no lift). Visual only — the pad/surface effect stays
			// cell-wide either way (driving under the bridge still triggers
			// it, an accepted game feature), so gameplay logic is untouched.
			if ( elevatedEntry && elevatedEntry.type === 'elevated-cross' ) addPatch( 0 );

		}

	}

	if ( ! customCells ) {

		// Place hand-authored decorations for the default track
		for ( const [ gx, gz, key, orient ] of DECO_CELLS ) {

			const piece = placePiece( models, key, gx, gz, orient );
			if ( piece ) decoGroup.add( piece );

		}

	}

	{

		// Auto-generate decorations to fill any gaps
		const occupied = new Set();
		const treeBlocked = new Set();
		let minX = Infinity, maxX = - Infinity;
		let minZ = Infinity, maxZ = - Infinity;

		// Helper: mark every integer grid cell whose footprint overlaps a
		// (possibly off-grid) cell's footprint as tree-blocked, and expand
		// the coverage bounds so ground fills all gaps.
		//
		// A cell at (gx, gz) covers (gx, gz) to (gx+1, gz+1).
		// Integer cell (cx, cz) covers (cx, cz) to (cx+1, cz+1).
		// The two footprints overlap (with non-zero area) when:
		//   gx < cx+1  AND  cx < gx+1   →   floor(gx) <= cx <= ceil(gx)
		//
		// For on-grid cells (integer gx): floor(gx) == ceil(gx), so exactly
		// one cell matches (itself) — same as before.
		// For off-grid cells (fractional gx): the piece straddles a grid seam,
		// so BOTH neighbouring integer cells overlap it and must be cleared of
		// trees. (The old center-based math missed the far-side cell, leaving
		// trees poking through off-grid roads.)
		function blockCellForTrees( gx, gz, markOccupied ) {
			gx = Number( gx );
			gz = Number( gz );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return;

			minX = Math.min( minX, gx );
			maxX = Math.max( maxX, gx );
			minZ = Math.min( minZ, gz );
			maxZ = Math.max( maxZ, gz );

			if ( markOccupied ) occupied.add( gx + ',' + gz );

			const minBlockX = Math.floor( gx );
			const maxBlockX = Math.ceil( gx );
			const minBlockZ = Math.floor( gz );
			const maxBlockZ = Math.ceil( gz );
			for ( let bx = minBlockX; bx <= maxBlockX; bx ++ ) {
				for ( let bz = minBlockZ; bz <= maxBlockZ; bz ++ ) {
					treeBlocked.add( bx + ',' + bz );
				}
			}
		}

		// Track cells + water cells: occupied (skip ground) + tree-blocked
		for ( const [ gx, gz ] of [ ...cells, ...waterCellsForDeco ] ) {
			blockCellForTrees( gx, gz, true );
		}

		// Solid extras that should erase trees beneath them (but NOT ramps,
		// bumps, or other see-through elements per user spec). Tree-blocked
		// only — ground still placed underneath to avoid visual holes.
		if ( extras ) {
			// Elevated pieces (including slope-up / slope-down, the "slope"
			// block) block trees beneath them, same as normal solid blocks.
			if ( Array.isArray( extras.elevated ) ) {
				for ( const entry of extras.elevated ) {
					if ( ! Array.isArray( entry ) ) continue;
					blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// Walls, cubes, moving obstacles: solid → erase trees.
			// Surfaces, water: replace ground → erase trees.
			const solidLists = [
				extras.walls, extras.cubes, extras.surfaces,
				extras.movingObstacles, extras.water, extras.customPool,
			];
			for ( const list of solidLists ) {
				if ( ! Array.isArray( list ) ) continue;
				for ( const entry of list ) {
					if ( ! Array.isArray( entry ) ) continue;
					blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// Buildings are solid too — they erase trees beneath them using the exact same
			// off-grid-aware footprint math as the blocks above. (Other decorations — tents, trees,
			// bushes — stay see-through.)
			if ( Array.isArray( extras.decorations ) ) {
				for ( const entry of extras.decorations ) {
					if ( ! Array.isArray( entry ) ) continue;
					const decoKey = String( entry[ 2 ] || '' );
					if ( decoKey.startsWith( 'building-' ) ) blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// NOT included (trees can go through these):
			//   bumps, boosts, jumps, poles, magnets, arcLinks, decorations
		}

		// Also mark existing decoration cells as occupied
		if ( ! customCells ) {

			for ( const [ gx, gz ] of DECO_CELLS ) {

				occupied.add( gx + ',' + gz );
				minX = Math.min( minX, gx );
				maxX = Math.max( maxX, gx );
				minZ = Math.min( minZ, gz );
				maxZ = Math.max( maxZ, gz );

			}

		}

		const pad = 3;
		const emptyPositions = [];
		const grassPositions = [];   // cells cleared of trees by a road/wall/etc. footprint
		const forestPositions = [];

		// Simple hash for deterministic pseudo-random placement
		function hash( gx, gz ) {

			let h = gx * 374761393 + gz * 668265263;
			h = ( h ^ ( h >> 13 ) ) * 1274126177;
			return ( h ^ ( h >> 16 ) ) >>> 0;

		}

		const startX = Math.floor( minX - pad );
		const endX = Math.ceil( maxX + pad );
		const startZ = Math.floor( minZ - pad );
		const endZ = Math.ceil( maxZ + pad );

		for ( let gz = startZ; gz <= endZ; gz ++ ) {

			for ( let gx = startX; gx <= endX; gx ++ ) {

				if ( occupied.has( gx + ',' + gz ) ) continue;

				const distX = gx < minX ? minX - gx : gx > maxX ? gx - maxX : 0;
				const distZ = gz < minZ ? minZ - gz : gz > maxZ ? gz - maxZ : 0;
				const dist = Math.max( distX, distZ );

				const x = ( gx + 0.5 ) * CELL_RAW;
				const z = ( gz + 0.5 ) * CELL_RAW;

				if ( treeBlocked.has( gx + ',' + gz ) ) {

					grassPositions.push( x, z );
					continue;

				}

				if ( dist <= NO_DECO_BUFFER_CELLS + 1 ) {

					emptyPositions.push( x, z );

				} else {

					forestPositions.push( x, z );

				}

			}

		}

		function createInstances( src, positions, randomY ) {

			if ( positions.length === 0 || ! src ) return;

			const count = positions.length / 2;

			src.traverse( ( child ) => {

				if ( ! child.isMesh ) return;

				const inst = new THREE.InstancedMesh( child.geometry, child.material, count );
				inst.castShadow = true;
				inst.receiveShadow = true;

				for ( let i = 0; i < count; i ++ ) {

					_dummy.position.set( positions[ i * 2 ], 0.5, positions[ i * 2 + 1 ] );
					// Per-instance Y rotation for 3D trees/bushes (decoration-forest +
					// decoration-empty) breaks up the repetitive grid pattern. Limited to
					// 90° intervals (0, 90, 180, 270) so nothing looks oddly tilted.
					// Stable hash of cell coords → same angle every reload (no reshuffle).
					// Flat grass quads (empty-deco-grass) keep rotation 0.
					if ( randomY ) {
						const px = positions[ i * 2 ];
						const pz = positions[ i * 2 + 1 ];
						const frac = Math.sin( px * 12.9898 + pz * 78.233 ) * 43758.5453 % 1;
						const idx = Math.floor( Math.abs( frac ) * 4 ) % 4;
						_dummy.rotation.y = idx * ( Math.PI / 2 );
					} else {
						_dummy.rotation.y = 0;
					}
					_dummy.updateMatrix();
					inst.setMatrixAt( i, _dummy.matrix );

				}

				decoGroup.add( inst );

			} );

		}

		createInstances( models[ 'decoration-empty' ], emptyPositions, true );
		createInstances( models[ 'empty-deco-grass' ], grassPositions );
		createInstances( models[ 'decoration-forest' ], forestPositions, true );

	}

	trackGroup.add( trackPieceGroup );
	trackGroup.add( decoGroup );

	trackGroup.scale.setScalar( 0.75 );
	scene.add( trackGroup );

	trackGroup.updateMatrixWorld( true );

	trackGroup.traverse( ( child ) => {

		if ( child.isMesh ) {

			child.castShadow = true;
			child.receiveShadow = true;

		}

	} );

	if ( ! customCells ) {

		for ( const [ key, x, y, z, rotDeg ] of NPC_TRUCKS ) {

			const src = models[ key ];
			if ( ! src ) continue;

			const npc = src.clone();
			npc.position.set( x, y, z );
			npc.rotation.y = THREE.MathUtils.degToRad( rotDeg + 180 );
			npc.traverse( ( c ) => {

				if ( c.isMesh ) {

					c.castShadow = true;
					c.receiveShadow = true;

				}

			} );
			trackGroup.add( npc );

		}

	}

	return trackGroup;

}

export function placePiece( models, key, gx, gz, orient ) {

	const modelKey = key === 'track-checkpoint' || key === 'track-start' || key === 'track-start-finish' ? 'track-finish' : key;
	const src = models[ modelKey ];
	if ( ! src ) return null;

	const piece = src.clone();
	const yOffset = ( String( key || '' ).startsWith( 'decoration-' ) || String( key || '' ).startsWith( 'building-' ) ) ? DECORATION_HEIGHT_OFFSET : VISUAL_HEIGHT_OFFSET;
	piece.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + yOffset, ( gz + 0.5 ) * CELL_RAW );

	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );
        // Start/finish blocks no longer tinted (checkpoint textures read cleanly).

	return piece;

}

// ─── Track Codec ──────────────────────────────────────────

const TYPE_NAMES = [ 'track-straight', 'track-corner', 'track-checkpoint', 'track-finish' ];
const TYPE_INDEX = {};
for ( let i = 0; i < TYPE_NAMES.length; i ++ ) TYPE_INDEX[ TYPE_NAMES[ i ] ] = i;

const ORIENT_TO_GODOT = [ 0, 16, 10, 22 ];
const GODOT_TO_ORIENT = { 0: 0, 16: 1, 10: 2, 22: 3 };

export { TYPE_NAMES };

// v3 JSON payloads substitute well-known cell type names with 1-char tokens
// (e.g. 'track-checkpoint' -> 'e'). Unknown names pass through untouched, so
// the transform is lossless for every track that can be encoded today.
const V3_NAME_TOKENS = {

	'track-straight': 'a',
	'track-corner': 'b',
	'track-3-way': 'c',
	'track-4-way': 'd',
	'track-checkpoint': 'e',
	'track-bump': 'f',
	'track-finish': 'g',
	'track-start': 'h',
	'track-start-finish': 'i',
	'track-cross': 'j',
	'elevated-straight': 'k',
	'elevated-corner': 'l',
	'elevated-cross': 'm',
	'elevated-checkpoint': 'n',
	'elevated-3-way': 'o',
	'elevated-4-way': 'p',
	'slope-up': 'q',
	'slope-down': 'r',

};

const V3_TOKEN_NAMES = {};
for ( const [ name, token ] of Object.entries( V3_NAME_TOKENS ) ) V3_TOKEN_NAMES[ token ] = name;

// Extended compact codec (v3 fmt 0): every known piece type fits in
// 3 bytes/cell — [ gx+128, gz+128, (typeIdx << 2) | orientIdx ].
// This list is append-only: never reorder or remove entries.
const V3_EXTENDED_TYPES = Object.keys( V3_NAME_TOKENS );
const V3_EXTENDED_INDEX = {};
for ( let i = 0; i < V3_EXTENDED_TYPES.length; i ++ ) V3_EXTENDED_INDEX[ V3_EXTENDED_TYPES[ i ] ] = i;

export function encodeCells( cells ) {

	const supportsCompactCodec = cells.every( ( cell ) => {

		const [ gx, gz, name ] = cell;
		const normalizedName = name === 'track-bump' ? 'track-checkpoint' : name;
		return Number.isInteger( gx )
			&& Number.isInteger( gz )
			&& gx >= - 128 && gx <= 127
			&& gz >= - 128 && gz <= 127
			&& TYPE_INDEX[ normalizedName ] !== undefined;

	} );

	if ( supportsCompactCodec ) {

		const bytes = new Uint8Array( cells.length * 3 );

		for ( let i = 0; i < cells.length; i ++ ) {

			const [ gx, gz, name, godotOrient ] = cells[ i ];
			const normalizedName = name === 'track-bump' ? 'track-checkpoint' : name;
			const ti = TYPE_INDEX[ normalizedName ] ?? 0;
			const oi = GODOT_TO_ORIENT[ godotOrient ] ?? 0;

			bytes[ i * 3 ] = gx + 128;
			bytes[ i * 3 + 1 ] = gz + 128;
			bytes[ i * 3 + 2 ] = ( ti << 2 ) | oi;

		}

		return bytesToBase64url( bytes );

	}

	const payload = JSON.stringify( { v: 2, cells } );
	const encoded = btoa( unescape( encodeURIComponent( payload ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );
	return `v2.${ encoded }`;

}

export function decodeCells( str ) {

	if ( str.startsWith( 'v2.' ) ) {

		const raw = str.slice( 3 ).replace( /-/g, '+' ).replace( /_/g, '/' );
		const padded = raw + '==='.slice( ( raw.length + 3 ) % 4 );
		const payload = decodeURIComponent( escape( atob( padded ) ) );
		const parsed = JSON.parse( payload );
		const entries = Array.isArray( parsed?.cells ) ? parsed.cells : [];
		return entries
			.filter( ( cell ) => Array.isArray( cell ) && cell.length >= 4 )
			.map( ( [ gx, gz, name, orient ] ) => [ Number( gx ), Number( gz ), name, orient ] );

	}

	const bytes = base64urlToBytes( str );
	const cells = [];

	for ( let i = 0; i + 2 < bytes.length; i += 3 ) {

		const gx = bytes[ i ] - 128;
		const gz = bytes[ i + 1 ] - 128;
		const packed = bytes[ i + 2 ];
		const ti = ( packed >> 2 ) & 0x03;
		const oi = packed & 0x03;

		cells.push( [ gx, gz, TYPE_NAMES[ ti ], ORIENT_TO_GODOT[ oi ] ] );

	}

	return cells;

}

// ─── v3 URL codec: deflate-compressed payloads for much shorter share URLs ───
// v3 wraps the existing v2 outputs: 0 = compact 3-byte cells, 1 = JSON v2.
// decodeCellsAny() reads v3, v2 and the compact codec; decodeCells() is
// unchanged so every existing sync call site keeps working.

function v3CodecSupported() {

	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

}

async function deflateBytes( bytes ) {

	const stream = new Blob( [ bytes ] ).stream().pipeThrough( new CompressionStream( 'deflate-raw' ) );
	return new Uint8Array( await new Response( stream ).arrayBuffer() );

}

async function inflateBytes( bytes ) {

	const stream = new Blob( [ bytes ] ).stream().pipeThrough( new DecompressionStream( 'deflate-raw' ) );
	return new Uint8Array( await new Response( stream ).arrayBuffer() );

}

// Compress an arbitrary JSON-serializable value into a 'v3.' string.
// Returns null when the browser can't compress (caller keeps the v2 form).
export async function encodeV3Json( value ) {

	if ( ! v3CodecSupported() ) return null;
	const payload = new TextEncoder().encode( JSON.stringify( value ) );
	return `v3.${ bytesToBase64url( await deflateBytes( payload ) ) }`;

}

// Inverse of encodeV3Json: parses a 'v3.' string back into a value.
export async function decodeV3Json( str ) {

	const bytes = base64urlToBytes( String( str ).slice( 3 ) );
	const inflated = await inflateBytes( bytes );
	return JSON.parse( new TextDecoder().decode( inflated ) );

}

// Shortest available cells encoding. Returns a 'v3.' string (or the v2
// string unchanged when the browser lacks compression support).
export async function encodeCellsV3( cells ) {

	const v2 = encodeCells( cells );
	if ( ! v3CodecSupported() ) return v2;
	let fmt;
	let payload;
	const orientIdx = ( o ) => ( o === 0 ? 0 : ( o === 16 ? 1 : ( o === 10 ? 2 : ( o === 22 ? 3 : -1 ) ) ) );
	const fitsExtended = cells.every( ( cell ) => {

		if ( ! Array.isArray( cell ) || cell.length < 4 ) return false;
		const [ gx, gz, name, orient ] = cell;
		return Number.isInteger( gx ) && Number.isInteger( gz )
			&& gx >= -127 && gx <= 127 && gz >= -127 && gz <= 127
			&& V3_EXTENDED_INDEX[ name ] !== undefined
			&& orientIdx( orient ) >= 0;

	} );
	if ( fitsExtended ) {

		// Extended compact: all known types, 3 bytes per cell.
		fmt = 0;
		payload = new Uint8Array( cells.length * 3 );
		for ( let i = 0; i < cells.length; i ++ ) {

			const [ gx, gz, name, orient ] = cells[ i ];
			const packed = ( V3_EXTENDED_INDEX[ name ] << 2 ) | orientIdx( orient );
			payload[ i * 3 ] = gx + 128;
			payload[ i * 3 + 1 ] = gz + 128;
			payload[ i * 3 + 2 ] = packed;

		}

	} else {

		// JSON fallback for anything the compact tables don't know.
		fmt = 1;
		const tokenized = cells.map( ( cell ) => {

			if ( ! Array.isArray( cell ) || cell.length < 4 ) return cell;
			return [ cell[ 0 ], cell[ 1 ], V3_NAME_TOKENS[ cell[ 2 ] ] ?? cell[ 2 ], cell[ 3 ] ];

		} );
		payload = new TextEncoder().encode( JSON.stringify( { v: 2, cells: tokenized } ) );

	}
	const framed = new Uint8Array( 1 + payload.length );
	framed[ 0 ] = fmt;
	framed.set( payload, 1 );
	return `v3.${ bytesToBase64url( await deflateBytes( framed ) ) }`;

}

// Async cells decoder accepting v3, v2 JSON and the compact codec.
export async function decodeCellsAny( str ) {

	const s = String( str || '' );
	if ( s.startsWith( 'v3.' ) ) {

		const inflated = await inflateBytes( base64urlToBytes( s.slice( 3 ) ) );
		if ( ! inflated.length ) throw new Error( 'Empty v3 payload' );
		if ( inflated[ 0 ] === 0 ) {

			const body = inflated.subarray( 1 );
			const out = [];
			for ( let i = 0; i + 2 < body.length; i += 3 ) {

				const ti = ( body[ i + 2 ] >> 2 ) & 0x3f;
				const oi = body[ i + 2 ] & 0x03;
				if ( ti >= V3_EXTENDED_TYPES.length ) continue;
				out.push( [ body[ i ] - 128, body[ i + 1 ] - 128, V3_EXTENDED_TYPES[ ti ], ORIENT_TO_GODOT[ oi ] ] );

			}
			return out;

		}
		const parsed = JSON.parse( new TextDecoder().decode( inflated.subarray( 1 ) ) );
		const entries = Array.isArray( parsed?.cells ) ? parsed.cells : [];
		return entries
			.filter( ( cell ) => Array.isArray( cell ) && cell.length >= 4 )
			.map( ( [ gx, gz, name, orient ] ) => [ Number( gx ), Number( gz ), V3_TOKEN_NAMES[ name ] ?? name, orient ] );

	}
	return decodeCells( s );

}

export function computeSpawnPosition( cells ) {

	// Null/undefined cells (e.g. TAS viewer booted with no track URL) used to
	// throw before every caller could guard. Empty arrays already fall through
	// to this same default, so behavior is unchanged for them.
	if ( ! Array.isArray( cells ) || cells.length === 0 ) return { position: [ 3.5, 0.5, 5 ], angle: 0 };

	let cell = cells[ 0 ];

	for ( const c of cells ) {

		if ( c[ 2 ] === 'track-start' ) {

			cell = c;
			break;

		}

	}

	if ( cell?.[ 2 ] !== 'track-start' ) {

		for ( const c of cells ) {

			if ( c[ 2 ] === 'track-start-finish' ) {

				cell = c;
				break;

			}

		}

	}

	if ( cell?.[ 2 ] !== 'track-start' && cell?.[ 2 ] !== 'track-start-finish' ) {

		for ( const c of cells ) {

			if ( c[ 2 ] === 'track-finish' ) {

				cell = c;
				break;

			}

		}

	}

	if ( ! cell ) return { position: [ 3.5, 0.5, 5 ], angle: 0 };

	const gx = cell[ 0 ];
	const gz = cell[ 1 ];
	const x = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
	const z = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;

	const orient = cell[ 3 ];
	const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );

	return { position: [ x, 0.5, z ], angle };

}

export function computeTrackBounds( cells ) {

	if ( ! cells || cells.length === 0 ) return { centerX: 0, centerZ: 0, halfWidth: 30, halfDepth: 30 };

	let minX = Infinity, maxX = - Infinity;
	let minZ = Infinity, maxZ = - Infinity;

	for ( const [ gx, gz ] of cells ) {

		minX = Math.min( minX, gx );
		maxX = Math.max( maxX, gx );
		minZ = Math.min( minZ, gz );
		maxZ = Math.max( maxZ, gz );

	}

	const S = CELL_RAW * GRID_SCALE;
	const centerX = ( minX + maxX + 1 ) / 2 * S;
	const centerZ = ( minZ + maxZ + 1 ) / 2 * S;
	const halfWidth = ( maxX - minX + 1 ) / 2 * S + S;
	const halfDepth = ( maxZ - minZ + 1 ) / 2 * S + S;

	return { centerX, centerZ, halfWidth, halfDepth };

}

function bytesToBase64url( bytes ) {

	let binary = '';
	for ( let i = 0; i < bytes.length; i ++ ) binary += String.fromCharCode( bytes[ i ] );

	return btoa( binary ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

}

function base64urlToBytes( str ) {

	const base64 = str.replace( /-/g, '+' ).replace( /_/g, '/' );
	const binary = atob( base64 );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );

	return bytes;

}


