import * as THREE from 'three';
import { rigidBody } from 'crashcat';

const _tmpVec = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _newZ = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3( 0, 1, 0 );

const SPEED_SCALE = 12.5;
const LINEAR_DAMP = 0.1;

function lerpAngle( a, b, t ) {

	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < -Math.PI ) diff += Math.PI * 2;
	return a + diff * t;

}

export class Vehicle {

	constructor() {

		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;

		this.spherePos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.sphereVel = new THREE.Vector3();
		this.wheelieNode = null;
		this.wheelieAmount = 0;
		this.wheelieActive = false;


		this.rigidBody = null;
		this.physicsWorld = null;

		this.modelVelocity = new THREE.Vector3();
		this.prevModelPos = new THREE.Vector3( 3.5, 0, 5 );

		this.container = new THREE.Group();
		this.bodyNode = null;
		this.modelRoot = null;
		this.wheels = [];
		this.wheelFL = null;
		this.wheelFR = null;
		this.wheelBL = null;
		this.wheelBR = null;

		this.inputX = 0;
		this.inputZ = 0;

		this.driftIntensity = 0;
		this.spawnPosition = new THREE.Vector3( 3.5, 0.5, 5 );
		this.spawnAngle = 0;
		this.topSpeed = 1.0;
		this.baseTopSpeed = 1.0;
		this.accelRate = 6.0;
		this.reverseAccelRate = 2.0;
		this.brakeRate = 8.0;
		this.driveForce = 100.0;
		this.gripMultiplier = 1.0;
		this.dragMultiplier = 1.0;
		this.accelMultiplier = 1.0;
		this.driveMultiplier = 1.0;
		this.slopeTiltPitch = 0;
		this.slopeTiltRoll = 0;

	}

	setPerformance( perf ) {

		if ( ! perf ) return;
		this.topSpeed = perf.topSpeed ?? this.topSpeed;
		this.baseTopSpeed = this.topSpeed;
		this.accelRate = perf.accelRate ?? this.accelRate;
		this.reverseAccelRate = perf.reverseAccelRate ?? this.reverseAccelRate;
		this.brakeRate = perf.brakeRate ?? this.brakeRate;
		this.driveForce = perf.driveForce ?? this.driveForce;

	}

	setSpawn( position, angle = 0 ) {

		this.spawnPosition.fromArray( position );
		this.spawnAngle = angle;

	}

	resetToSpawn() {

		if ( this.rigidBody ) {

			rigidBody.setPosition( this.physicsWorld, this.rigidBody, this.spawnPosition.toArray(), false );
			rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );

		}

		this.spherePos.copy( this.spawnPosition );
		this.sphereVel.set( 0, 0, 0 );
		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;
		this.modelVelocity.set( 0, 0, 0 );
		this.container.position.set( this.spherePos.x, this.spherePos.y - 0.5, this.spherePos.z );
		this.container.rotation.set( 0, this.spawnAngle, 0 );
		this.container.quaternion.setFromEuler( this.container.rotation );
		this.prevModelPos.copy( this.container.position );

	}

	attachModel( model ) {

		this.wheels = [];
		this.wheelFL = null;
		this.wheelFR = null;
		this.wheelBL = null;
		this.wheelBR = null;
		this.bodyNode = null;
		this.modelRoot = null;

		for ( let i = this.container.children.length - 1; i >= 0; i -- ) {

			this.container.remove( this.container.children[ i ] );

		}

		const vehicleModel = model.clone();
		this.modelRoot = vehicleModel;

		this.container.add( vehicleModel );

		// Find body and wheel nodes
		vehicleModel.traverse( ( child ) => {

			const name = child.name.toLowerCase();

			if ( name === 'body' ) {

				child.rotation.order = 'YXZ';
				this.bodyNode = child;

			} else if ( name.includes( 'wheel' ) ) {

				child.rotation.order = 'YXZ';
				this.wheels.push( child );

				if ( name.includes( 'front' ) && name.includes( 'left' ) ) this.wheelFL = child;
				if ( name.includes( 'front' ) && name.includes( 'right' ) ) this.wheelFR = child;
				if ( name.includes( 'back' ) && name.includes( 'left' ) ) this.wheelBL = child;
				if ( name.includes( 'back' ) && name.includes( 'right' ) ) this.wheelBR = child;

			}

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;
				const mat = child.material;
				if ( mat && mat.isMeshStandardMaterial ) {
					mat.metalness = Math.max( mat.metalness ?? 0.08, 0.12 );
					mat.roughness = Math.min( mat.roughness ?? 0.7, 0.56 );
					mat.envMapIntensity = Math.max( mat.envMapIntensity ?? 1, 1.12 );
				}

			}

		} );
		// Wheelie pivot: the rear axle, so boosts pitch the car up about its back wheels.
		if ( this.wheelBL && this.wheelBR ) {
			const rearZ = ( this.wheelBL.position.z + this.wheelBR.position.z ) / 2;
			const pivot = new THREE.Group();
			pivot.position.set( 0, 0, rearZ );
			this.modelRoot.position.z += - rearZ;
			this.wheelieNode = pivot;
			pivot.add( this.modelRoot );
			this.container.add( pivot );
		}


	}

		setWheelieActive( active ) {
			this.wheelieActive = Boolean( active );
		}

		updateWheelie( dt ) {
			if ( ! this.modelRoot || ! this.wheelieNode ) return;
			const target = this.wheelieActive ? 1 : 0;
			const rate = target > this.wheelieAmount ? 6.5 : 3.5;
			this.wheelieAmount += ( target - this.wheelieAmount ) * Math.min( 1, dt * rate );
			const angle = this.wheelieAmount * 0.55;
			this.wheelieNode.rotation.x = -angle;
		}


	init( model ) {

		this.attachModel( model );
		return this.container;

	}

	setModel( model ) {

		this.attachModel( model );

		return this.container;

	}

	update( dt, controlsInput ) {

		this.inputX = controlsInput.x;
		this.inputZ = controlsInput.z;

		let direction = Math.sign( this.linearSpeed );
		if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

		const steeringGrip = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ), 0.2, 1.0 ) * this.gripMultiplier;

		const targetAngular = - this.inputX * steeringGrip * 4 * direction;
		this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, dt * 4 );

		this.container.rotateY( this.angularSpeed * dt );

		// Custom-mod "spin car": sustained yaw rate alongside steering.
		if ( Number.isFinite( this.__modSpin ) ) this.container.rotateY( this.__modSpin * dt );

		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );

		if ( _tmpVec.y > 0.5 ) {

			const targetQuat = this.alignWithY( this.container.quaternion, _up );
			this.container.quaternion.slerp( targetQuat, 0.2 );

		}

		const targetSpeed = this.inputZ * this.topSpeed;

		// Lerp factors are clamped to 1: stacked pad effects multiply
		// accelMultiplier (4x pad-high-speed is ~14x), and lerp(a, b, t)
		// EXTRAPOLATES for t > 1 — so dt * rate * multiplier > 2 amplified
		// |linearSpeed - target| by (t-1) every frame instead of shrinking
		// it. Stacked high-speed pads made the speed model oscillate
		// exponentially (measured: 1.2 -> 14,000,000 in ~3s) and crash the
		// tab. Clamped, stacks still mean much faster acceleration toward
		// the pad-boosted top speed — just never overshoot.
		if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) {

			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0.0, Math.min( 1, dt * this.brakeRate * this.accelMultiplier ) );

		} else if ( targetSpeed < 0 ) {

			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed / 2, Math.min( 1, dt * this.reverseAccelRate * this.accelMultiplier ) );

		} else {

			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed, Math.min( 1, dt * this.accelRate * this.accelMultiplier ) );

		}

		this.linearSpeed *= Math.max( 0, 1 - LINEAR_DAMP * this.dragMultiplier * dt );

		if ( this.rigidBody ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const drive = this.linearSpeed * this.driveForce * this.driveMultiplier * dt;

			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [
				angvel[ 0 ] + _right.x * drive,
				angvel[ 1 ],
				angvel[ 2 ] + _right.z * drive
			] );

			const pos = this.rigidBody.position;
			this.spherePos.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );

			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[ 0 ], vel[ 1 ], vel[ 2 ] );

		}

		this.acceleration = THREE.MathUtils.lerp(
			this.acceleration,
			this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ),
			dt
		);

		if ( this.spherePos.y < - 10 ) {

			// Host (main.js) wires onOutOfBounds to its full respawn (lap state,
			// obstacles, camera). Without the callback (editor test drive) fall
			// back to a plain physics-only reset.
			if ( this.onOutOfBounds ) this.onOutOfBounds();
			else this.resetToSpawn();

		}

		this.container.position.set(
			this.spherePos.x,
			this.spherePos.y - 0.5,
			this.spherePos.z
		);

		if ( dt > 0 ) {

			this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt );
			this.prevModelPos.copy( this.container.position );

		}

		this.updateBody( dt );
		this.updateWheels( dt );
		this.updateWheelie( dt );
		this.applySlopeVisualTilt( dt );

		_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
		_forward.y = 0;
		_forward.normalize();
		_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
		_right.y = 0;
		_right.normalize();

		const forwardVelocity = Math.abs( this.modelVelocity.dot( _forward ) );
		const lateralVelocity = Math.abs( this.modelVelocity.dot( _right ) );
		const speedForSlip = Math.max( forwardVelocity, Math.abs( this.linearSpeed ) * SPEED_SCALE, 0.01 );
		const lateralSlip = lateralVelocity / Math.max( speedForSlip, 0.01 );
		const steeringLoad = Math.abs( this.inputX ) * THREE.MathUtils.clamp( forwardVelocity / Math.max( 0.01, this.topSpeed * SPEED_SCALE ), 0, 1.4 );
		const throttleLoad = Math.abs( this.inputZ ) > 0.45 ? 0.12 : 0;
		const bodyRollSlip = this.bodyNode ? Math.max( 0, Math.abs( this.bodyNode.rotation.z ) - 0.08 ) * 1.4 : 0;
		const targetDriftIntensity = Math.max( 0, lateralSlip * 1.35 + steeringLoad * 0.28 + throttleLoad + bodyRollSlip - 0.28 );
		// Custom-mod "set drift" persists: mods store __modDrift and it overrides
		// the computed target so the value isn't lerped away next frame.
		const driftTarget = Number.isFinite( this.__modDrift ) ? this.__modDrift : targetDriftIntensity;
		this.driftIntensity = THREE.MathUtils.lerp( this.driftIntensity, driftTarget, Math.min( 1, dt * 8 ) );

	}

	/**
	 * Dynamic slope detection (pure math, node-testable).
	 *
	 * Given the four downward-ray ground samples taken at the chassis frame —
	 * depths below the chassis center where each ray hit (all rays share the
	 * same origin height), or null when that ray missed / was rejected —
	 * reconstruct the ground normal in car space and decompose it into
	 * pitch/roll that map DIRECTLY onto modelRoot.rotation.x/z.
	 *
	 * Physical convention (locked by test-slope-tilt.mjs, and confirmed by
	 * live testing — the legacy grid-cell detection was inverted, which is
	 * why its convention is NOT replicated here):
	 *   climbing (surface rises along the car's forward axis) → nose UP
	 *   surface rising toward the car's right → right side UP
	 */
	static computeSlopeTiltFromSamples( samples, halfLength = 1.1, halfWidth = 0.65, maxTilt = 1.0 ) {

		const num = ( v ) => Number.isFinite( v ) ? v : null;
		const forward = num( samples?.forward );
		const backward = num( samples?.backward );
		const left = num( samples?.left );
		const right = num( samples?.right );

		// Surface rise-over-run along the car's forward axis (from depth deltas).
		let nx = 0, nz = 0;
		if ( forward != null && backward != null ) {

			nz = - ( backward - forward ) / ( 2 * halfLength );

		}

		if ( left != null && right != null ) {

			nx = ( right - left ) / ( 2 * halfWidth );

		}

		if ( nx === 0 && nz === 0 ) return { pitch: 0, roll: 0 };

		const inv = 1 / Math.hypot( nx, 1, nz );
		const ny = inv;
		return {
			pitch: THREE.MathUtils.clamp( Math.atan2( nz * inv, ny ), - maxTilt, maxTilt ),
			roll: THREE.MathUtils.clamp( Math.atan2( - nx * inv, ny ), - maxTilt, maxTilt ),
		};

	}

	setSlopeVisualTilt( pitch = 0, roll = 0 ) {

		this.slopeTiltPitch = Number.isFinite( pitch ) ? pitch : 0;
		this.slopeTiltRoll = Number.isFinite( roll ) ? roll : 0;

	}

	applySlopeVisualTilt( dt ) {

		if ( ! this.modelRoot ) return;
		const blend = 1 - Math.exp( - dt * 10 );
		this.modelRoot.rotation.x = THREE.MathUtils.lerp( this.modelRoot.rotation.x, this.slopeTiltPitch, blend );
		this.modelRoot.rotation.z = THREE.MathUtils.lerp( this.modelRoot.rotation.z, this.slopeTiltRoll, blend );

	}

	alignWithY( quaternion, newY ) {

		_zAxis.set( 0, 0, 1 ).applyQuaternion( quaternion );
		const xAxis = _tmpVec.crossVectors( _zAxis, newY ).negate().normalize();
		_newZ.crossVectors( xAxis, newY ).normalize();

		_mat4.makeBasis( xAxis, newY, _newZ );
		return _quat.setFromRotationMatrix( _mat4 );

	}

	updateBody( dt ) {

		if ( ! this.bodyNode ) return;

		// The lean targets below are speed-proportional and were tuned for the
		// normal ~1.8 top speed (pitch target ~= ls|ls|/24 rad, roll ~= |ls|/5).
		// Stacked speed pads now drive linearSpeed to 10x+ (#438/#439), which
		// scaled those targets into full backflips (5.4 rad at a 10-pad stack)
		// and upside-down rolls while steering. Clamp the TARGETS to their
		// intended physical lean: normal driving is unchanged, absurd speed
		// saturates at max lean instead of flipping the body over.
		const MAX_BODY_PITCH = 0.35;
		const MAX_BODY_ROLL = 0.38;

		this.bodyNode.rotation.x = lerpAngle(
			this.bodyNode.rotation.x,
			THREE.MathUtils.clamp( -( this.linearSpeed - this.acceleration ) / 6, -MAX_BODY_PITCH, MAX_BODY_PITCH ),
			dt * 10
		);

		this.bodyNode.rotation.z = lerpAngle(
			this.bodyNode.rotation.z,
			THREE.MathUtils.clamp( -( this.inputX / 5 ) * this.linearSpeed, -MAX_BODY_ROLL, MAX_BODY_ROLL ),
			dt * 5
		);

		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, 0.2, dt * 5 );

	}

	updateWheels( dt ) {

		for ( const wheel of this.wheels ) {

			// Modulo keeps per-frame spin under one revolution — at pad-stack
			// speeds `acceleration` exceeds 2*PI per frame and the raw sum
			// strobes/aliases instead of reading as fast spin.
			wheel.rotation.x = ( wheel.rotation.x + this.acceleration ) % ( Math.PI * 2 );

		}

		if ( this.wheelFL ) {

			this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, -this.inputX / 1.5, dt * 10 );

		}

		if ( this.wheelFR ) {

			this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, -this.inputX / 1.5, dt * 10 );

		}

	}

}
