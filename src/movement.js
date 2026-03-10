'use strict';

/**
 * HumanMovement
 * Simulates realistic human-like movement patterns:
 *  - Random walk with smooth direction changes
 *  - Occasional pausing (idle)
 *  - Head look-around (yaw/pitch drift)
 *  - Slight position jitter (simulating walking animation)
 *  - Periodic crouching/uncrouching
 */
class HumanMovement {
  constructor(bot) {
    this.bot = bot;
    this.x = 0;
    this.y = 64;
    this.z = 0;
    this.yaw = Math.random() * 360;
    this.pitch = 0;
    this.onGround = true;
    this.initialized = false;

    // Movement state
    this._state = 'idle'; // idle | walking | turning | looking
    this._stateTimer = 0;
    this._targetYaw = this.yaw;
    this._walkDir = 0; // radians
    this._speed = 0.1; // blocks per tick at normal walk

    // Timers
    this._tickInterval = null;
    this._TICK_MS = 1000 / 20; // 50ms = 1 MC tick
  }

  setSpawn(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.initialized = true;
    this.bot.log(`[Movement] Spawn set to (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
  }

  start() {
    if (this._tickInterval) return;
    this._decideNextAction();
    this._tickInterval = setInterval(() => this._tick(), this._TICK_MS);
    this.bot.log('[Movement] Human movement engine started');
  }

  stop() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  _rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  _randInt(min, max) {
    return Math.floor(this._rand(min, max + 1));
  }

  // Pick a new behaviour state and duration
  _decideNextAction() {
    const roll = Math.random();

    if (roll < 0.30) {
      // Idle - just stand and look around
      this._state = 'idle';
      this._stateTimer = this._randInt(40, 200); // 2–10 seconds
    } else if (roll < 0.65) {
      // Walk in a direction for a bit
      this._state = 'walking';
      this._walkDir = this._rand(0, Math.PI * 2);
      this._stateTimer = this._randInt(20, 80); // 1–4 seconds
      this._speed = this._rand(0.08, 0.15);
      this._targetYaw = (this._walkDir * 180 / Math.PI + 180) % 360;
    } else if (roll < 0.85) {
      // Turn and look around
      this._state = 'turning';
      this._targetYaw = this._rand(0, 360);
      this._stateTimer = this._randInt(10, 30);
    } else {
      // Look up/down slightly
      this._state = 'looking';
      this._stateTimer = this._randInt(20, 60);
    }
  }

  _smoothYaw(current, target, speed) {
    let diff = target - current;
    // Wrap to -180..180
    while (diff > 180)  diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) < speed) return target;
    return current + Math.sign(diff) * speed;
  }

  _tick() {
    if (!this.initialized) return;

    this._stateTimer--;
    if (this._stateTimer <= 0) this._decideNextAction();

    switch (this._state) {
      case 'idle':
        // Slight head drift
        this.yaw   += this._rand(-0.3, 0.3);
        this.pitch  = Math.max(-20, Math.min(20, this.pitch + this._rand(-0.2, 0.2)));
        break;

      case 'walking': {
        // Smooth turn toward walk direction
        this.yaw = this._smoothYaw(this.yaw, this._targetYaw, 3.5);
        // Move forward
        this.x += Math.sin(this._walkDir) * this._speed * this._rand(0.85, 1.15);
        this.z += Math.cos(this._walkDir) * this._speed * this._rand(0.85, 1.15);
        // Slight pitch bob while walking
        this.pitch = Math.sin(Date.now() / 300) * 4;
        break;
      }

      case 'turning':
        this.yaw = this._smoothYaw(this.yaw, this._targetYaw, this._rand(1.5, 4));
        this.pitch += this._rand(-0.5, 0.5);
        this.pitch = Math.max(-30, Math.min(30, this.pitch));
        break;

      case 'looking':
        this.pitch = this._smoothYaw(this.pitch, this._rand(-25, 25), 2);
        this.yaw  += this._rand(-0.8, 0.8);
        break;
    }

    // Clamp pitch to valid MC range
    this.pitch = Math.max(-90, Math.min(90, this.pitch));
    this.yaw = ((this.yaw % 360) + 360) % 360;

    // Send position every tick (with ground flag)
    this.bot.sendPosition(this.x, this.y, this.z, this.yaw, this.pitch, this.onGround);
  }
}

module.exports = HumanMovement;
