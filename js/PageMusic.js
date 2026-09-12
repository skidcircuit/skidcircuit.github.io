const MENU_MUSIC_SOURCES = [ 'audio/menu.mp3', 'audio/music.mp3' ];
const MENU_MUSIC_VOLUME = 0.416;
const AUDIO_CACHE_NAME = 'racing-game-audio-v1';

const pathName = window.location.pathname.split( '/' ).pop() || 'index.html';
const params = new URLSearchParams( window.location.search );
const IS_ACTIVE_RACING_INDEX = pathName === 'index.html' && ( params.get( 'play' ) === '1' || params.has( 'map' ) || params.has( 'pack' ) || params.has( 'localPack' ) );

let menuMusic = null;
let unlocked = false;
let primed = false;
let sourceIndex = 0;
let wantToPlay = false;   // set when play is requested but audio isn't ready yet
let sourceReady = false;  // set when the current source can play

function currentSource() {
	return MENU_MUSIC_SOURCES[ Math.min( sourceIndex, MENU_MUSIC_SOURCES.length - 1 ) ];
}

function addPreloadHint( src = currentSource() ) {
	if ( document.querySelector( `link[rel="preload"][href="${ src }"]` ) ) return;
	const link = document.createElement( 'link' );
	link.rel = 'preload';
	link.as = 'audio';
	link.href = src;
	document.head.appendChild( link );
}

async function getCachedAudioUrl( src ) {
	if ( ! ( 'caches' in window ) ) return src;
	try {
		const cache = await caches.open( AUDIO_CACHE_NAME );
		const cached = await cache.match( src );
		if ( cached ) {
			const blob = await cached.blob();
			return URL.createObjectURL( blob );
		}
		const response = await fetch( src );
		if ( response.ok ) {
			await cache.put( src, response.clone() );
			const blob = await response.blob();
			return URL.createObjectURL( blob );
		}
	} catch ( e ) {
		console.warn( 'Audio cache miss for', src, e );
	}
	return src;
}

function ensureMenuMusic() {
	if ( menuMusic ) return menuMusic;
	menuMusic = new Audio();
	menuMusic.loop = true;
	menuMusic.preload = 'auto';
	menuMusic.volume = MENU_MUSIC_VOLUME;
	menuMusic.muted = true;  // start muted — browsers allow muted autoplay

	// When the audio can play, kick off muted playback immediately (autoplay-friendly)
	menuMusic.addEventListener( 'canplay', () => {
		sourceReady = true;
		if ( ! IS_ACTIVE_RACING_INDEX && ! document.hidden ) {
			// Start playing muted — will be unmuted on first user interaction
			menuMusic.play().catch( () => {} );
		}
		if ( wantToPlay && unlocked ) {
			menuMusic.muted = false;
			wantToPlay = false;
		}
	} );

	// Handle errors — try the next source
	menuMusic.addEventListener( 'error', tryNextSource );
	return menuMusic;
}

// Guards against a stale async source swap: two overlapping setSource()
// calls (e.g. error fallback firing while the first cache/fetch is still in
// flight) used to let the SLOWER response win and silently replace the
// working source with a dead one — menu music then stayed silent even though
// every load looked healthy. Only the most recent request may apply its URL.
let sourceRequestId = 0;
function setSource( src ) {
	sourceReady = false;
	const request = ++ sourceRequestId;
	const audio = ensureMenuMusic();
	getCachedAudioUrl( src ).then( url => {
		if ( ! audio || request !== sourceRequestId ) return;
		audio.pause();
		audio.setAttribute( 'src', url );
		audio.load();
		// canplay event will fire after the browser buffers enough.
		// If it's already cached it may fire almost instantly.
	} );
}

function tryNextSource() {
	if ( sourceIndex >= MENU_MUSIC_SOURCES.length - 1 ) {
		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SOURCES.join( ' or ' ) }.` );
		return;
	}
	sourceIndex++;
	addPreloadHint( currentSource() );
	setSource( currentSource() );
}

function primeMenuMusic() {
	if ( IS_ACTIVE_RACING_INDEX || primed ) return;
	primed = true;
	addPreloadHint( currentSource() );
	ensureMenuMusic();
	setSource( currentSource() );
}

function stopMenuMusic() {
	wantToPlay = false;
	if ( menuMusic ) menuMusic.pause();
}

function playMenuMusic() {
	if ( IS_ACTIVE_RACING_INDEX || document.hidden ) return;
	const audio = ensureMenuMusic();
	if ( sourceReady ) {
		audio.play().catch( () => {} );
		if ( unlocked ) audio.muted = false;
	} else {
		wantToPlay = true;
	}
}

function unlockMenuMusic() {
	if ( unlocked ) {
		// Already unlocked — if music should be playing but isn't, retry
		if ( menuMusic && menuMusic.paused && ! IS_ACTIVE_RACING_INDEX && ! document.hidden ) {
			playMenuMusic();
		}
		return;
	}
	unlocked = true;
	primeMenuMusic();
	// If already playing muted, just unmute — zero delay
	if ( menuMusic && ! menuMusic.paused ) {
		menuMusic.muted = false;
	} else {
		playMenuMusic();
		if ( menuMusic ) menuMusic.muted = false;
	}
}

// Kick off preloading immediately
primeMenuMusic();

// Browsers block autoplay until user interaction — unlock on first gesture
window.addEventListener( 'pointerdown', unlockMenuMusic, { capture: true } );
window.addEventListener( 'mousedown', unlockMenuMusic, { capture: true } );
window.addEventListener( 'keydown', unlockMenuMusic, { capture: true } );
window.addEventListener( 'touchstart', unlockMenuMusic, { capture: true } );

// Stop when leaving, resume when returning
window.addEventListener( 'pagehide', stopMenuMusic );
window.addEventListener( 'beforeunload', stopMenuMusic );
document.addEventListener( 'visibilitychange', () => {
	if ( document.hidden ) stopMenuMusic();
	else if ( unlocked ) playMenuMusic();
} );
