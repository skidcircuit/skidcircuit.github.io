// Shared runtime for custom Blockly mods.
//
// Every generated custom mod used to inline this entire resolveValue/runActions
// interpreter (~38 KB) into its stored module, so each tiny mod wrote ~90 KB to
// localStorage (template + base64 data URL) and blew the per-origin quota with
// "Not enough browser storage for this mod" - even for one-block mods. Instead,
// this module is loaded once by main.js and exposed on window.__RACING_MOD_RUNTIME__;
// generated mods then store only `const SPEC = {...}` + a one-line call to
// createRuntime(id, SPEC), shrinking stored size from ~90 KB to ~1-2 KB.
//
// The resolveValue/runActions bodies below are intentionally identical to the
// code that renderActionsRuntimeCode() in js/custom-mods.js emits, so old
// (inlined) persisted mods and new (compact) persisted mods behave the same.

export function resolveValue( value, ctx, event ) {
  event = event || {};
  if ( value && typeof value === 'object' ) {
    const k = value.kind;
    if ( k === 'runtime' ) {
      const s = ( ctx && typeof ctx.getState === 'function' ) ? ctx.getState() : {};
      switch ( value.name ) {
        case 'speed': return Math.abs( Number( s.linearSpeed ) || 0 );
        case 'lapTime': return Number( s.lapTime ?? event.lapTime ?? 0 ) || 0;
        case 'raceTime': return Number( s.raceTime ?? 0 ) || 0;
        case 'checkpointNumber': return Number( event.checkpointNumber ?? s.checkpointNumber ?? 0 ) || 0;
        case 'crashForce': return Number( event.impactVelocity ?? 0 ) || 0;
        case 'random': return Math.random();
        case 'coins': return Number( s.coins ?? 0 ) || 0;
        case 'lapNumber': return Number( s.lapNumber ?? event.lapNumber ?? 0 ) || 0;
        case 'bestLap': return Number( s.bestLapSeconds ?? 0 ) || 0;
        case 'lastLap': return Number( s.lastLapSeconds ?? 0 ) || 0;
        case 'stuntPoints': return Number( s.stuntPoints ?? 0 ) || 0;
        case 'stuntCombo': return Number( s.stuntCombo ?? 0 ) || 0;
        case 'drift': return Number( s.driftIntensity ?? 0 ) || 0;
        case 'angularSpeed': return Number( s.angularSpeed ?? 0 ) || 0;
        case 'topSpeed': return Number( s.topSpeed ?? 0 ) || 0;
        case 'accelRate': return Number( s.accelRate ?? 0 ) || 0;
        case 'driveForce': return Number( s.driveForce ?? 0 ) || 0;
        case 'gripMult': return Number( s.gripMultiplier ?? 0 ) || 0;
        case 'posX': return Number( s.x ?? 0 ) || 0;
        case 'posY': return Number( s.y ?? 0 ) || 0;
        case 'posZ': return Number( s.z ?? 0 ) || 0;
        case 'gameMode': return String( s.gameMode ?? 'race' );
        case 'isAirborne': return Boolean( event.airborne ?? false );
        case 'isDrifting': return Boolean( s.driftIntensity && s.driftIntensity > 0.6 );
        case 'isPaused': return Boolean( s.paused );
        case 'fps': return Number( s.fps ?? 0 ) || 0;
        case 'dt': return Number( event.dt ?? 0 ) || 0;
        case 'speedKmh': return Math.abs( Number( s.linearSpeed ) || 0 ) * 4.805; // u/s -> km/h, matches the HUD speedometer (mph factor 2.985)
        case 'speedMph': return Math.abs( Number( s.linearSpeed ) || 0 ) * 2.985; // matches the HUD speedometer exactly
        case 'heading': return ( ( Number( s.heading ) || 0 ) );
        case 'velocityX': return Number( s.velocityX ?? 0 ) || 0;
        case 'velocityY': return Number( s.velocityY ?? 0 ) || 0;
        case 'velocityZ': return Number( s.velocityZ ?? 0 ) || 0;
        case 'isSplitScreen': return Boolean( s.isSplitScreen ?? false );
        case 'dragMult': return Number( s.dragMultiplier ?? 0 ) || 0;
        case 'accelMult': return Number( s.accelMultiplier ?? 0 ) || 0;
        case 'driveMult': return Number( s.driveMultiplier ?? 0 ) || 0;
        case 'timeScale': return Number( s.timeScale ?? 1 ) || 1;
        case 'gravity': return Number( s.gravity ?? 9.81 ) || 9.81;
      }
    }
    if ( k === 'var' ) return Number( ctx.state.vars[ value.name ] ) || 0;
    if ( k === 'textvar' ) return String( ctx.state.textvars[ value.name ] ?? '' );
    if ( k === 'const' ) return value.value;
    if ( k === 'element_text' ) { const el = ctx.state.elements && ctx.state.elements[ value.name ]; return el ? String( el.textContent ?? '' ) : ''; }
    if ( k === 'storage_get' ) { const store = ctx.storage; if ( ! store ) return resolveValue( value.fallback, ctx, event ); const key = String( resolveValue( value.key, ctx, event ) ?? '' ); const v = store.get( key ); return v == null ? resolveValue( value.fallback, ctx, event ) : v; }
    if ( k === 'storage_has' ) { const store = ctx.storage; if ( ! store ) return false; const key = String( resolveValue( value.key, ctx, event ) ?? '' ); return store.get( key ) != null; }
    if ( k === 'text_length' ) { const t = String( resolveValue( value.value, ctx, event ) ?? '' ); return t.length; }
    if ( k === 'text_contains' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const sub = String( resolveValue( value.sub, ctx, event ) ?? '' ); return t.includes( sub ); }
    if ( k === 'text_case' ) { const t = String( resolveValue( value.value, ctx, event ) ?? '' ); return value.upper ? t.toUpperCase() : t.toLowerCase(); }
    if ( k === 'math' ) {
      const a = Number( resolveValue( value.a, ctx, event ) ) || 0;
      const b = Number( resolveValue( value.b, ctx, event ) ) || 0;
      if ( value.op === 'ADD' ) return a + b;
      if ( value.op === 'MINUS' ) return a - b;
      if ( value.op === 'MULTIPLY' ) return a * b;
      if ( value.op === 'DIVIDE' ) return b === 0 ? 0 : a / b;
      if ( value.op === 'MODULO' ) return b === 0 ? 0 : a % b;
      if ( value.op === 'POWER' ) return Math.pow( a, b );
    }
    if ( k === 'math_single' ) {
      const n = Number( resolveValue( value.num, ctx, event ) ) || 0;
      if ( value.op === 'ABS' ) return Math.abs( n );
      if ( value.op === 'NEG' ) return -n;
      if ( value.op === 'ROUND' ) return Math.round( n );
      if ( value.op === 'FLOOR' ) return Math.floor( n );
      if ( value.op === 'CEIL' ) return Math.ceil( n );
      if ( value.op === 'SQRT' ) return n < 0 ? 0 : Math.sqrt( n );
      if ( value.op === 'SIN' ) return Math.sin( n );
      if ( value.op === 'COS' ) return Math.cos( n );
      if ( value.op === 'TAN' ) return Math.tan( n );
    }
    if ( k === 'clamp' ) { const val = Number( resolveValue( value.value, ctx, event ) ) || 0; const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || 0; return Math.max( mn, Math.min( mx, val ) ); }
    if ( k === 'minmax' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; return value.op === 'MIN' ? Math.min( a, b ) : Math.max( a, b ); }
    if ( k === 'deg2rad' ) return ( Number( resolveValue( value.value, ctx, event ) ) || 0 ) * Math.PI / 180;
    if ( k === 'rad2deg' ) return ( Number( resolveValue( value.value, ctx, event ) ) || 0 ) * 180 / Math.PI;
    if ( k === 'join' ) return String( resolveValue( value.a, ctx, event ) ?? '' ) + String( resolveValue( value.b, ctx, event ) ?? '' );
    if ( k === 'tostring' ) return String( resolveValue( value.value, ctx, event ) ?? '' );
    if ( k === 'roundstr' ) { const val = Number( resolveValue( value.value, ctx, event ) ) || 0; const p = Math.max( 0, Math.min( 10, Number( value.places ) || 0 ) ); return val.toFixed( p ); }
    if ( k === 'compare' ) { const a = resolveValue( value.a, ctx, event ); const b = resolveValue( value.b, ctx, event ); if ( value.op === 'EQ' ) return a === b; if ( value.op === 'NEQ' ) return a !== b; if ( value.op === 'LT' ) return a < b; if ( value.op === 'LTE' ) return a <= b; if ( value.op === 'GT' ) return a > b; if ( value.op === 'GTE' ) return a >= b; }
    if ( k === 'boolop' ) { const a = Boolean( resolveValue( value.a, ctx, event ) ); const b = Boolean( resolveValue( value.b, ctx, event ) ); return value.op === 'AND' ? ( a && b ) : ( a || b ); }
    if ( k === 'not' ) return ! resolveValue( value.value, ctx, event );
    if ( k === 'keydown' ) { return Boolean( ctx && ctx.controls && ctx.controls.keys && ctx.controls.keys[ value.key ] ); }
    // ---- EXTENDED VALUE KINDS ----
    if ( k === 'round_int' ) return Math.round( Number( resolveValue( value.num, ctx, event ) ) || 0 );
    if ( k === 'randint' ) { const mn = Math.ceil( Number( resolveValue( value.min, ctx, event ) ) || 0 ); const mx = Math.floor( Number( resolveValue( value.max, ctx, event ) ) || 0 ); if ( mx < mn ) return mn; return Math.floor( Math.random() * ( mx - mn + 1 ) ) + mn; }
    if ( k === 'randrange' ) { const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || mn; return Math.random() * ( mx - mn ) + mn; }
    if ( k === 'lerp' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; const t = Math.max( 0, Math.min( 1, Number( resolveValue( value.t, ctx, event ) ) || 0 ) ); return a + ( b - a ) * t; }
    if ( k === 'map_range' ) { const v = Number( resolveValue( value.value, ctx, event ) ) || 0; const inMin = Number( resolveValue( value.inMin, ctx, event ) ) || 0; const inMax = Number( resolveValue( value.inMax, ctx, event ) ) || 1; const outMin = Number( resolveValue( value.outMin, ctx, event ) ) || 0; const outMax = Number( resolveValue( value.outMax, ctx, event ) ) || 1; if ( inMax === inMin ) return outMin; const t = ( v - inMin ) / ( inMax - inMin ); return outMin + ( outMax - outMin ) * t; }
    if ( k === 'math_adv' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; switch ( value.op ) { case 'SIGN': return Math.sign( n ); case 'LOG': return n > 0 ? Math.log( n ) : 0; case 'LOG10': return n > 0 ? Math.log10( n ) : 0; case 'EXP': return Math.exp( n ); case 'TRUNC': return Math.trunc( n ); case 'ASIN': return Math.asin( Math.max( -1, Math.min( 1, n ) ) ); case 'ACOS': return Math.acos( Math.max( -1, Math.min( 1, n ) ) ); case 'ATAN': return Math.atan( n ); case 'TANH': return Math.tanh( n ); case 'SINH': return Math.sinh( n ); case 'COSH': return Math.cosh( n ); case 'RECIP': return n === 0 ? 0 : 1 / n; case 'DEG': return n * Math.PI / 180; case 'RAD': return n * 180 / Math.PI; } return 0; }
    if ( k === 'math_pair' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; switch ( value.op ) { case 'ATAN2': return Math.atan2( a, b ); case 'DIST': return Math.sqrt( a * a + b * b ); case 'HYPOT': return Math.hypot( a, b ); case 'GCD': { let x = Math.abs( Math.trunc( a ) ), y = Math.abs( Math.trunc( b ) ); while ( y ) { [ x, y ] = [ y, x % y ]; } return x || 0; } case 'QUOT': return b === 0 ? 0 : Math.trunc( a / b ); case 'REM': return b === 0 ? 0 : a % b; case 'PCT': return b === 0 ? 0 : ( a / b ) * 100; } return 0; }
    if ( k === 'math_const' ) { return { E: Math.E, TAU: Math.PI * 2, PHI: 1.6180339887, SQRT2: Math.SQRT2 }[ value.name ] || 0; }
    if ( k === 'divisible' ) { const b = Number( resolveValue( value.b, ctx, event ) ) || 0; return b !== 0 && ( Number( resolveValue( value.a, ctx, event ) ) || 0 ) % b === 0; }
    if ( k === 'between' ) { const v = Number( resolveValue( value.value, ctx, event ) ) || 0; const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || 0; return v >= Math.min( mn, mx ) && v <= Math.max( mn, mx ); }
    if ( k === 'xor' ) return Boolean( resolveValue( value.a, ctx, event ) ) !== Boolean( resolveValue( value.b, ctx, event ) );
    if ( k === 'is_even' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; return Math.abs( Math.trunc( n ) ) % 2 === 0; }
    if ( k === 'is_positive' ) return Number( resolveValue( value.num, ctx, event ) ) > 0;
    if ( k === 'is_integer' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; return Number.isFinite( n ) && Math.trunc( n ) === n; }
    if ( k === 'is_zero' ) return ( Number( resolveValue( value.num, ctx, event ) ) || 0 ) === 0;
    if ( k === 'text_op' ) { const a = String( resolveValue( value.a, ctx, event ) ?? '' ); const b = String( resolveValue( value.b, ctx, event ) ?? '' ); if ( value.op === 'EQIC' ) return a.toLowerCase() === b.toLowerCase(); if ( value.op === 'STARTS' ) return a.startsWith( b ); if ( value.op === 'ENDS' ) return a.endsWith( b ); return false; }
    if ( k === 'is_empty' ) { const v = resolveValue( value.value, ctx, event ); if ( Array.isArray( v ) ) return v.length === 0; return String( v ?? '' ).length === 0; }
    if ( k === 'text_sub' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const st = Math.max( 0, Math.floor( Number( resolveValue( value.start, ctx, event ) ) || 0 ) ); const en = Math.max( st, Math.floor( Number( resolveValue( value.end, ctx, event ) ) || t.length ) ); return t.slice( st, en ); }
    if ( k === 'text_charat' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); let i = Math.floor( Number( resolveValue( value.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = t.length + i; return t.charAt( Math.max( 0, Math.min( t.length - 1, i ) ) ); }
    if ( k === 'text_indexof' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); return t.indexOf( String( resolveValue( value.sub, ctx, event ) ?? '' ) ); }
    if ( k === 'text_replace' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const f = String( resolveValue( value.from, ctx, event ) ?? '' ); const o = String( resolveValue( value.to, ctx, event ) ?? '' ); if ( ! f ) return t; return value.all ? t.split( f ).join( o ) : t.replace( f, o ); }
    if ( k === 'text_repeat' ) { const n = Math.max( 0, Math.min( 500, Math.floor( Number( resolveValue( value.times, ctx, event ) ) || 0 ) ) ); return String( resolveValue( value.text, ctx, event ) ?? '' ).repeat( n ); }
    if ( k === 'text_trim' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).trim();
    if ( k === 'text_pad' ) { let t = String( resolveValue( value.text, ctx, event ) ?? '' ); const len = Math.max( 0, Math.min( 500, Math.floor( Number( resolveValue( value.length, ctx, event ) ) || 0 ) ) ); let ch = String( resolveValue( value.char, ctx, event ) ?? ' ' ).slice( 0, 1 ) || ' '; while ( t.length < len ) t = ( value.op === 'PADL' ? ch + t : t + ch ); return t; }
    if ( k === 'text_reverse' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).split( '' ).reverse().join( '' );
    if ( k === 'text_count' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const s = String( resolveValue( value.sub, ctx, event ) ?? '' ); if ( ! s ) return 0; let n = 0, i = 0; while ( ( i = t.indexOf( s, i ) ) !== -1 ) { n ++; i += s.length; } return n; }
    if ( k === 'text_tonum' ) { const n = parseFloat( String( resolveValue( value.text, ctx, event ) ?? '' ) ); return Number.isFinite( n ) ? n : 0; }
    if ( k === 'text_split' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const sep = String( resolveValue( value.sep, ctx, event ) ?? '' ); return sep ? t.split( sep ) : t.split( '' ); }
    if ( k === 'text_first' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).charAt( 0 );
    if ( k === 'text_last' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); return t.charAt( Math.max( 0, t.length - 1 ) ); }
    if ( k === 'text_slice' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const st = Math.max( 0, Math.floor( Number( resolveValue( value.start, ctx, event ) ) || 0 ) ); const ln = Math.max( 0, Math.floor( Number( resolveValue( value.length, ctx, event ) ) || 0 ) ); return t.slice( st, st + ln ); }
    if ( k === 'text_charcode' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).charCodeAt( 0 ) || 0;
    if ( k === 'text_fromcode' ) { const c = Math.floor( Number( resolveValue( value.num, ctx, event ) ) || 0 ); return String.fromCharCode( Math.max( 0, Math.min( 0x10ffff, c ) ) ); }
    if ( k === 'list' ) { return ( value.items || [] ).map( ( it ) => resolveValue( it, ctx, event ) ); }
    if ( k === 'list_var' ) { const arr = ctx.state.vars[ value.name ]; return Array.isArray( arr ) ? arr.slice() : []; }
    if ( k === 'list_length' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.length : 0; }
    if ( k === 'list_get' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) ) return null; let i = Math.floor( Number( resolveValue( value.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = a.length + i; return a[ Math.max( 0, Math.min( a.length - 1, i ) ) ]; }
    if ( k === 'list_contains' ) { const a = resolveValue( value.list, ctx, event ); const val = resolveValue( value.value, ctx, event ); return Array.isArray( a ) && a.includes( val ); }
    if ( k === 'list_indexof' ) { const a = resolveValue( value.list, ctx, event ); const val = resolveValue( value.value, ctx, event ); return Array.isArray( a ) ? a.indexOf( val ) : -1; }
    if ( k === 'list_reverse' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.slice().reverse() : []; }
    if ( k === 'list_sort' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) ) return []; const n = a.slice().sort( ( x, y ) => ( Number( x ) || 0 ) - ( Number( y ) || 0 ) ); return value.op === 'DESC' ? n.reverse() : n; }
    if ( k === 'list_sum' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.reduce( ( s, x ) => s + ( Number( x ) || 0 ), 0 ) : 0; }
    if ( k === 'list_maxmin' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) || ! a.length ) return 0; const nums = a.map( ( x ) => Number( x ) || 0 ); return value.op === 'MAX' ? Math.max( ...nums ) : Math.min( ...nums ); }
    if ( k === 'list_avg' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a.reduce( ( s, x ) => s + ( Number( x ) || 0 ), 0 ) / a.length : 0; }
    if ( k === 'list_join' ) { const a = resolveValue( value.list, ctx, event ); const sep = String( resolveValue( value.sep, ctx, event ) ?? '' ); return Array.isArray( a ) ? a.join( sep ) : ''; }
    if ( k === 'list_first' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a[ 0 ] : null; }
    if ( k === 'list_last' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a[ a.length - 1 ] : null; }
    if ( k === 'storage_count' ) { const store = ctx.storage; if ( ! store || typeof store.count !== 'function' ) return 0; try { return store.count(); } catch { return 0; } }
  }
  return value;
}
export function runActions( actions, ctx, event ) {
  event = event || {};
  const api = ( ctx && ctx.api ) || {};
  if ( ! ctx.state ) ctx.state = { vars: {}, textvars: {}, timers: [], waits: [], elements: {} };
  for ( const action of actions || [] ) {
    if ( ! action || ! action.type ) continue;
    const value = resolveValue( action.value, ctx, event );
    switch ( action.type ) {
      case 'set_speed': if ( typeof api.setSpeed === 'function' ) api.setSpeed( Number( value ) || 0, event ); break;
      case 'boost': if ( typeof api.boost === 'function' ) api.boost( Number( value ) || 0, event ); break;
      case 'set_top_speed': if ( typeof api.setTopSpeed === 'function' ) api.setTopSpeed( Number( value ) || 1 ); break;
      case 'set_accel_rate': if ( typeof api.setAccelRate === 'function' ) api.setAccelRate( Number( value ) || 6 ); break;
      case 'set_brake_rate': if ( typeof api.setBrakeRate === 'function' ) api.setBrakeRate( Number( value ) || 8 ); break;
      case 'set_drive_force': if ( typeof api.setDriveForce === 'function' ) api.setDriveForce( Number( value ) || 100 ); break;
      case 'set_drag': if ( typeof api.setDragMultiplier === 'function' ) api.setDragMultiplier( Number( value ) || 1 ); break;
      case 'set_reverse_accel': if ( typeof api.setReverseAccelRate === 'function' ) api.setReverseAccelRate( Number( value ) || 2 ); break;
      case 'set_gravity': if ( typeof api.setGravity === 'function' ) api.setGravity( Number( value ) || 9.81, event ); break;
      case 'set_time_scale': if ( typeof api.setTimeScale === 'function' ) api.setTimeScale( Number( value ) || 1, event ); break;
      case 'set_accel_mult': if ( typeof api.setAccelMultiplier === 'function' ) api.setAccelMultiplier( Number( value ) || 1, event ); break;
      case 'set_drive_mult': if ( typeof api.setDriveMultiplier === 'function' ) api.setDriveMultiplier( Number( value ) || 1, event ); break;
      case 'set_grip_mult': if ( typeof api.setGripMultiplier === 'function' ) api.setGripMultiplier( Number( value ) || 1, event ); break;
      case 'force_brake': if ( typeof api.forceBrake === 'function' ) api.forceBrake( Number( value ) || 0.4, event ); break;
      case 'force_throttle': if ( typeof api.forceThrottle === 'function' ) api.forceThrottle( Number( value ) || 0.4, event ); break;
      case 'disable_steering': if ( typeof api.disableSteering === 'function' ) api.disableSteering( Number( value ) || 0.5, event ); break;
      case 'jump': if ( typeof api.jump === 'function' ) api.jump( Number( value ) || 6, event ); break;
      case 'reset_car': if ( typeof api.resetCar === 'function' ) api.resetCar( event ); break;
      case 'teleport': if ( typeof api.teleport === 'function' ) api.teleport( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 1, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'impulse': if ( typeof api.applyImpulse === 'function' ) api.applyImpulse( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 0, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'angular': if ( typeof api.setAngularImpulse === 'function' ) api.setAngularImpulse( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 0, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'set_spin': if ( typeof api.setVehicleSpin === 'function' ) api.setVehicleSpin( Number( value ) || 0 ); break;
      case 'set_scale': if ( typeof api.setVehicleScale === 'function' ) api.setVehicleScale( Number( value ) || 1 ); break;
      case 'set_visible': if ( typeof api.setVehicleVisible === 'function' ) api.setVehicleVisible( Number( value ) || 0 ); break;
      case 'set_drift': if ( typeof api.setDriftIntensity === 'function' ) api.setDriftIntensity( Number( value ) || 0 ); break;
      case 'set_model': if ( typeof api.setVehicleModel === 'function' ) api.setVehicleModel( String( value ) ); break;
      case 'camera_shake': if ( typeof api.cameraShake === 'function' ) api.cameraShake( Number( value ) || 1, event ); break;
      case 'set_fov': if ( typeof api.setCameraFov === 'function' ) api.setCameraFov( Number( value ) || 42 ); break;
      case 'set_camera_mode': if ( typeof api.setCameraMode === 'function' ) api.setCameraMode( String( value ) ); break;
      case 'show_message': if ( typeof api.showMessage === 'function' ) api.showMessage( String( value ?? '' ), { durationMs: Number( resolveValue( action.duration, ctx, event ) ) || 1600 } ); break;
      case 'spawn_particle': if ( typeof api.spawnParticle === 'function' ) api.spawnParticle( event ); break;
      case 'spawn_particle_burst': if ( typeof api.spawnParticleBurst === 'function' ) api.spawnParticleBurst( Number( value ) || 0.45 ); break;
      case 'set_fog_strength': if ( typeof api.setFogStrength === 'function' ) api.setFogStrength( Number( value ) || 1, event ); break;
      case 'set_fog_density': if ( typeof api.setFogDensity === 'function' ) api.setFogDensity( Number( value ) || 1 ); break;
      case 'set_fog_color': if ( typeof api.setFogColor === 'function' ) api.setFogColor( String( value ) ); break;
      case 'set_bg_color': if ( typeof api.setBackgroundColor === 'function' ) api.setBackgroundColor( String( value ) ); break;
      case 'set_sky_color': if ( typeof api.setSkyColor === 'function' ) api.setSkyColor( String( value ) ); break;
      case 'set_horizon_color': if ( typeof api.setHorizonColor === 'function' ) api.setHorizonColor( String( value ) ); break;
      case 'set_particle_color': if ( typeof api.setParticleColor === 'function' ) api.setParticleColor( String( value ) ); break;
      case 'flash_screen': if ( typeof api.flashScreen === 'function' ) api.flashScreen( String( value ) ); break;
      case 'set_sky_vibrance': if ( typeof api.setSkyVibrance === 'function' ) api.setSkyVibrance( Number( value ) || 0 ); break;
      case 'set_sky_palette': if ( typeof api.setSkyPalette === 'function' ) api.setSkyPalette( String( value ) ); break;
      case 'set_sun': if ( typeof api.setSunIntensity === 'function' ) api.setSunIntensity( Number( value ) || 5 ); break;
      case 'set_hemi': if ( typeof api.setHemiIntensity === 'function' ) api.setHemiIntensity( Number( value ) || 1.5 ); break;
      case 'set_exposure': if ( typeof api.setExposure === 'function' ) api.setExposure( Number( value ) || 1 ); break;
      case 'set_engine_vol': if ( typeof api.setEngineVolume === 'function' ) api.setEngineVolume( Number( value ) || 1 ); break;
      case 'set_music_vol': if ( typeof api.setMusicVolume === 'function' ) api.setMusicVolume( Number( value ) || 1 ); break;
      case 'play_impact': if ( typeof api.playImpactSound === 'function' ) api.playImpactSound( Number( value ) || 3 ); break;
      case 'set_hud_text': if ( typeof api.setHudText === 'function' ) api.setHudText( String( value ?? '' ) ); break;
      case 'set_effect_msg': if ( typeof api.setEffectMessage === 'function' ) api.setEffectMessage( String( value ?? '' ) ); break;
      case 'set_fps': if ( typeof api.setFpsCounter === 'function' ) api.setFpsCounter( Number( value ) || 0 ); break;
      case 'add_stunt': if ( typeof api.addStuntPoints === 'function' ) api.addStuntPoints( Number( value ) || 0, String( resolveValue( action.reason, ctx, event ) ?? '' ) ); break;
      case 'add_coins': if ( typeof api.addCoins === 'function' ) api.addCoins( Number( value ) || 0 ); break;
      case 'set_pixel_ratio': if ( typeof api.setRendererPixelRatio === 'function' ) api.setRendererPixelRatio( Number( value ) || 1 ); break;
      case 'set_shadows': if ( typeof api.setShadowEnabled === 'function' ) api.setShadowEnabled( Number( value ) || 0 ); break;
      case 'start_timer': ctx.state.timers.push( { remaining: Math.max( 0, Number( value ) || 0 ), id: action.id || 'timer1' } ); break;
      case 'wait': ctx.state.waits.push( { remaining: Math.max( 0, Number( value ) || 0 ), paused: true, actions: null } ); break;
      case 'random_delay': { const mn = Number( resolveValue( action.min, ctx, event ) ) || 0; const mx = Number( resolveValue( action.max, ctx, event ) ) || mn; ctx.state.waits.push( { remaining: Math.random() * Math.abs( mx - mn ) + Math.min( mn, mx ), paused: true, actions: null } ); break; }
      case 'repeat': { const times = Math.max( 0, Math.min( 100, Math.floor( Number( resolveValue( action.times, ctx, event ) ) || 0 ) ) ); for ( let i = 0; i < times; i++ ) runActions( action.body || [], ctx, event ); break; }
      case 'loop_forever': { for ( let i = 0; i < 60; i++ ) runActions( action.body || [], ctx, event ); break; }
      case 'var_set': ctx.state.vars[ action.name ] = Number( value ) || 0; break;
      case 'var_add': ctx.state.vars[ action.name ] = ( Number( ctx.state.vars[ action.name ] ) || 0 ) + ( Number( value ) || 0 ); break;
      case 'textvar_set': ctx.state.textvars[ action.name ] = String( value ?? '' ); break;
      case 'if': if ( resolveValue( action.cond, ctx, event ) ) runActions( action.body || [], ctx, event ); break;
      case 'ifelse': if ( resolveValue( action.cond, ctx, event ) ) runActions( action.body || [], ctx, event ); else runActions( action.elseBody || [], ctx, event ); break;
      // UI builder
      case 'ui_panel': { const ui = ctx.ui; if ( ui ) { const p = ui.panel( { title: String( resolveValue( action.title, ctx, event ) ?? '' ), x: Number( resolveValue( action.x, ctx, event ) ) || 12, y: Number( resolveValue( action.y, ctx, event ) ) || 12 } ); ctx.state.elements[ action.name ] = p; } break; }
      case 'ui_button': { const ui = ctx.ui; if ( ui ) { const el = ui.button( String( resolveValue( action.label, ctx, event ) ?? 'Button' ), () => runActions( action.body || [], ctx, { type: 'click' } ) ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_label': { const ui = ctx.ui; if ( ui ) ctx.state.elements[ action.name ] = ui.label( String( resolveValue( action.text, ctx, event ) ?? '' ) ); break; }
      case 'ui_slider': { const ui = ctx.ui; if ( ui ) { const el = ui.slider( String( resolveValue( action.label, ctx, event ) ?? '' ), Number( resolveValue( action.min, ctx, event ) ) || 0, Number( resolveValue( action.max, ctx, event ) ) || 100, Number( resolveValue( action.value, ctx, event ) ) || 0, ( val ) => { ctx.state.vars[ action.name ] = Number( val ) || 0; runActions( action.body || [], ctx, { type: 'slider', value: Number( val ) || 0 } ); } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_set_text': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) ctx.ui.setText( el, String( resolveValue( action.text, ctx, event ) ?? '' ) ); break; }
      case 'ui_set_style': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) { const prop = String( resolveValue( action.prop, ctx, event ) ?? '' ); const val = String( resolveValue( action.value, ctx, event ) ?? '' ); ctx.ui.setStyle( el, { [ prop ]: val } ); } break; }
      case 'ui_append': { const parent = ctx.state.elements && ctx.state.elements[ action.parent ]; const child = ctx.state.elements && ctx.state.elements[ action.child ]; if ( parent && child && ctx.ui ) ctx.ui.append( parent, child ); break; }
      case 'ui_remove': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) { ctx.ui.remove( el ); delete ctx.state.elements[ action.name ]; } break; }
      case 'ui_clear': { if ( ctx.ui ) ctx.ui.clear(); ctx.state.elements = {}; break; }
      case 'ui_show': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.style.display = ''; break; }
      case 'ui_hide': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.style.display = 'none'; break; }
      // Storage
      case 'storage_set': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); store.set( key, resolveValue( action.value, ctx, event ) ); } break; }
      case 'storage_remove': { const store = ctx.storage; if ( store ) store.remove( String( resolveValue( action.key, ctx, event ) ?? '' ) ); break; }
      case 'storage_clear': { const store = ctx.storage; if ( store ) store.clear(); break; }
      // Game control
      case 'respawn': { const api = ctx.api; if ( api && typeof api.respawn === 'function' ) api.respawn(); break; }
      case 'pause': { const api = ctx.api; if ( api && typeof api.setPaused === 'function' ) api.setPaused( true ); break; }
      case 'resume': { const api = ctx.api; if ( api && typeof api.setPaused === 'function' ) api.setPaused( false ); break; }
      // ---- EXTENDED ACTIONS ----
      case 'var_multiply': ctx.state.vars[ action.name ] = ( Number( ctx.state.vars[ action.name ] ) || 0 ) * ( Number( value ) || 1 ); break;
      case 'var_divide': { const d = Number( value ) || 0; ctx.state.vars[ action.name ] = d === 0 ? 0 : ( Number( ctx.state.vars[ action.name ] ) || 0 ) / d; break; }
      case 'var_clamp': { const cur = Number( ctx.state.vars[ action.name ] ) || 0; const mn = Number( resolveValue( action.min, ctx, event ) ) || 0; const mx = Number( resolveValue( action.max, ctx, event ) ) || 0; ctx.state.vars[ action.name ] = Math.max( Math.min( mn, mx ), Math.min( Math.max( mn, mx ), cur ) ); break; }
      case 'textvar_append': ctx.state.textvars[ action.name ] = String( ctx.state.textvars[ action.name ] ?? '' ) + String( value ?? '' ); break;
      case 'list_set': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); let arr = ctx.state.vars[ key ]; if ( ! Array.isArray( arr ) ) { arr = []; ctx.state.vars[ key ] = arr; } let i = Math.floor( Number( resolveValue( action.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = 0; if ( i > arr.length ) i = arr.length; arr[ i ] = resolveValue( action.value, ctx, event ); break; }
      case 'list_add': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); if ( ! Array.isArray( ctx.state.vars[ key ] ) ) ctx.state.vars[ key ] = []; ctx.state.vars[ key ].push( resolveValue( action.value, ctx, event ) ); break; }
      case 'list_remove': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); if ( Array.isArray( ctx.state.vars[ key ] ) ) { let i = Math.floor( Number( resolveValue( action.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = 0; if ( i < ctx.state.vars[ key ].length ) ctx.state.vars[ key ].splice( i, 1 ); } break; }
      case 'list_clear': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); ctx.state.vars[ key ] = []; break; }
      case 'ui_heading': { const ui = ctx.ui; if ( ui ) { const el = ui.create( action.tag, { text: String( resolveValue( action.text, ctx, event ) ?? '' ), style: { color: '#fff', fontWeight: '700', margin: '4px 0' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_progress': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'progress', { attrs: { max: String( Math.max( 1, Number( resolveValue( action.max, ctx, event ) ) || 100 ) ), value: String( Math.max( 0, Number( resolveValue( action.value, ctx, event ) ) || 0 ) ) }, style: { width: '100%' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_checkbox': { const ui = ctx.ui; if ( ui ) { const wrap = ui.create( 'div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } } ); const el = ui.create( 'input', { attrs: { type: 'checkbox' } } ); el.checked = Boolean( ctx.state.vars[ action.varName ] ); const lab = ui.create( 'label', { text: String( resolveValue( action.label, ctx, event ) ?? '' ) } ); if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'change', () => { ctx.state.vars[ action.varName ] = el.checked ? 1 : 0; runActions( action.body || [], ctx, { type: 'change', value: el.checked ? 1 : 0 } ); } ); ui.append( wrap, el ); ui.append( wrap, lab ); ctx.state.elements[ action.name ] = wrap; } break; }
      case 'ui_dropdown': { const ui = ctx.ui; if ( ui ) { const sel = ui.create( 'select', {} ); const opts = Array.isArray( action.options ) ? action.options : []; for ( const o of opts.slice( 0, 24 ) ) { const opt = ui.create( 'option', { text: String( o ) } ); ui.append( sel, opt ); } if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( sel, 'change', () => { ctx.state.vars[ action.varName ] = sel.value; runActions( action.body || [], ctx, { type: 'change', value: sel.value } ); } ); ctx.state.elements[ action.name ] = sel; } break; }
      case 'ui_text_input': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'input', { attrs: { type: 'text' } } ); if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'input', () => { ctx.state.textvars[ action.varName ] = el.value; runActions( action.body || [], ctx, { type: 'input', value: el.value } ); } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_divider': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'div', { style: { borderTop: '1px solid rgba(255,255,255,0.25)', margin: '6px 0' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_set_position': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) { el.style.position = 'absolute'; el.style.left = ( Math.max( -50, Math.min( 95, Number( resolveValue( action.x, ctx, event ) ) || 0 ) ) ) + 'px'; el.style.top = ( Math.max( -50, Math.min( 95, Number( resolveValue( action.y, ctx, event ) ) || 0 ) ) ) + 'px'; } break; }
      case 'ui_set_size': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) { el.style.width = ( Math.max( 8, Math.min( 800, Number( resolveValue( action.w, ctx, event ) ) || 100 ) ) ) + 'px'; el.style.height = ( Math.max( 8, Math.min( 600, Number( resolveValue( action.h, ctx, event ) ) || 40 ) ) ) + 'px'; } break; }
      case 'ui_set_enabled': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.disabled = action.state !== '1'; break; }
      case 'ui_on_click': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'click', () => runActions( action.body || [], ctx, { type: 'click' } ) ); break; }
      case 'storage_increment': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); const cur = Number( store.get( key ) ) || 0; store.set( key, cur + ( Number( resolveValue( action.by, ctx, event ) ) || 1 ) ); } break; }
      case 'storage_list_add': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); let arr = store.get( key ); if ( ! Array.isArray( arr ) ) arr = []; arr.push( resolveValue( action.value, ctx, event ) ); store.set( key, arr ); } break; }
      case 'set_camera_distance': if ( typeof api.setCameraDistance === 'function' ) api.setCameraDistance( Math.max( 2, Math.min( 30, Number( value ) || 8 ) ) ); break;
      case 'set_camera_height': if ( typeof api.setCameraHeight === 'function' ) api.setCameraHeight( Math.max( 0, Math.min( 20, Number( value ) || 3 ) ) ); break;
      case 'set_camera_lag': if ( typeof api.setCameraLag === 'function' ) api.setCameraLag( Math.max( 0, Math.min( 1, Number( value ) || 1 ) ) ); break;
      case 'set_camera_pitch': if ( typeof api.setCameraPitch === 'function' ) api.setCameraPitch( Math.max( -45, Math.min( 45, Number( value ) || 0 ) ) ); break;
      case 'set_sun_position': if ( typeof api.setSunPosition === 'function' ) api.setSunPosition( Math.max( 0, Math.min( 360, Number( value ) || 45 ) ) ); break;
      case 'set_snow': if ( typeof api.setSnowIntensity === 'function' ) api.setSnowIntensity( Math.max( 0, Math.min( 1, Number( value ) || 0 ) ) ); break;
      case 'set_rain': if ( typeof api.setRainIntensity === 'function' ) api.setRainIntensity( Math.max( 0, Math.min( 1, Number( value ) || 0 ) ) ); break;
      case 'play_cue': if ( typeof api.playCue === 'function' ) api.playCue( String( value ) ); break;
    }
  }
}

export function createRuntime( id, SPEC ) {
  SPEC = SPEC || {};
  return {
    id,
    init( context ) {
      this.ctx = context;
      this.state = { vars: {}, textvars: {}, timers: [], waits: [], elements: {} };
      this.ctx.state = this.state;
      this.keyLatch = Object.create( null );
      this.wasAirborne = false;
      this.wasDrifting = false;
      runActions( SPEC.onStart, this.ctx, { type: 'start' } );
    },
    applyFrame( { controls, vehicle, world, dt, now } ) {
      const ctx = this.ctx || { vehicle, world, controls };
      ctx.state = this.state;
      const st = ( typeof ctx.getState === 'function' ) ? ctx.getState() : {};
      const ev = { type: 'tick', dt, now, airborne: Boolean( st.airborne ), lapTime: st.lapTime, raceTime: st.raceTime };
      runActions( SPEC.onTick, ctx, ev );
      for ( const [ key, actions ] of Object.entries( SPEC.onKey || {} ) ) { const down = Boolean( controls && controls.keys && controls.keys[ key ] ); if ( down && ! this.keyLatch[ key ] ) runActions( actions, ctx, { type: 'key', key, dt, now } ); this.keyLatch[ key ] = down; }
      for ( const [ key, actions ] of Object.entries( SPEC.onKeyHold || {} ) ) { if ( controls && controls.keys && controls.keys[ key ] ) runActions( actions, ctx, { type: 'keyhold', key, dt, now } ); }
      for ( const [ key, actions ] of Object.entries( SPEC.onKeyRelease || {} ) ) { const down = Boolean( controls && controls.keys && controls.keys[ key ] ); if ( ! down && this.keyLatch[ key ] ) runActions( actions, ctx, { type: 'keyrelease', key, dt, now } ); this.keyLatch[ key ] = down; }
      const speed = Math.abs( Number( st.linearSpeed ) || 0 );
      for ( const t of ( SPEC.onSpeedThreshold || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed > th ) runActions( t.body, ctx, { type: 'speed_threshold', speed, threshold: th, dt, now } ); }
      for ( const t of ( SPEC.onLowSpeed || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed < th ) runActions( t.body, ctx, { type: 'low_speed', speed, threshold: th, dt, now } ); }
      for ( const t of ( SPEC.onHighSpeed || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed > th ) runActions( t.body, ctx, { type: 'high_speed', speed, threshold: th, dt, now } ); }
      for ( const t of ( SPEC.onLowSpeedHeld || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed < th ) runActions( t.body, ctx, { type: 'low_speed_held', speed, threshold: th, dt, now } ); }
      const airborne = Boolean( ev.airborne ); if ( airborne && ! this.wasAirborne ) runActions( SPEC.onAir, ctx, { type: 'air', dt, now } ); if ( ! airborne && this.wasAirborne ) runActions( SPEC.onGround, ctx, { type: 'ground', dt, now } ); this.wasAirborne = airborne;
      const drifting = Boolean( st.driftIntensity && st.driftIntensity > 0.6 ); if ( drifting && ! this.wasDrifting ) runActions( SPEC.onDrift, ctx, { type: 'drift', dt, now } ); this.wasDrifting = drifting;
      if ( Array.isArray( this.state.timers ) ) { for ( const t of this.state.timers ) t.remaining -= dt; const done = this.state.timers.filter( ( t ) => t.remaining <= 0 ); this.state.timers = this.state.timers.filter( ( t ) => t.remaining > 0 ); for ( const t of done ) runActions( ( SPEC.onTimerDone && SPEC.onTimerDone[ t.id ] ) || [], ctx, { type: 'timer_done', id: t.id, now } ); }
      return null;
    },
    onCheckpoint( event ) { runActions( SPEC.onCheckpoint, this.ctx, { type: 'checkpoint', ...( event || {} ) } ); },
    onCrash( event ) { runActions( SPEC.onCrash, this.ctx, { type: 'crash', ...( event || {} ) } ); },
    onRespawn( event ) { runActions( SPEC.onRespawn, this.ctx, { type: 'respawn', ...( event || {} ) } ); },
    onLapFinish( event ) { runActions( SPEC.onLapFinish, this.ctx, { type: 'lapFinish', ...( event || {} ) } ); },
    dispose() { try { this.ctx?.ui?.clear?.(); } catch {} this.ctx = null; this.state = null; this.keyLatch = Object.create( null ); },
  };
}
