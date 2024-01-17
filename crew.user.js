// ==UserScript==
// @name        Captain and Crew (Holiday Hack Challenge 2023)
// @namespace   https://files.noodlebox.moe/
// @version     1.4
// @description Various features and QoL fixes for the sailing mode of Holiday Hack Challenge 2023.
// @author      noodlebox
// @match       https://2023.holidayhackchallenge.com/sea/*
// @run-at      document-idle
// @grant       none
// ==/UserScript==

/* jshint browser:true, esversion:11, undef:true, unused:true */
/* globals Entities, playerData, Keys, socket */
/* exported crew */

const crew = (function () {
  const ts = performance.now.bind(performance);

  // Physics parameters
  // Size of world in units
  const WORLD_SIZE = 2000; // ImageAssets.bump.width
  // Size of server tick in ms
  const TICKSIZE = 33;
  // Speed limit on either axis in units/tick
  const MAX_SPEED = 0.65;
  // Minimum measurable speed in units/tick (values below this round to zero)
  const MIN_SPEED = 0.001;
  // Acceleration for movement keys in units/tick/tick
  const ACCEL = 0.025;
  // Velocity factor per tick when no movement keys are active on an axis
  const DRAG_IDLE = 0.02;
  // Velocity factor per tick when anchor is active
  const DRAG_ANCHOR = 0.20;

  /*
  // Ensures that the position of `p` is within [0, WORLD_SIZE).
  const canonicalize = p => {
    p.x = mod(p.x, WORLD_SIZE);
    p.y = mod(p.y, WORLD_SIZE);
    return p;
  };
  */

  // Ensures that the position of `p` is within [0, WORLD_SIZE), or within
  // WORLD_SIZE/2 units of `ref` if given.
  const canonicalize = (p, ref={ x: WORLD_SIZE/2, y: WORLD_SIZE/2 }) => {
    while (p.x - ref.x >= WORLD_SIZE/2) {
      p.x -= WORLD_SIZE;
    }
    while (p.x - ref.x < -WORLD_SIZE/2) {
      p.x += WORLD_SIZE;
    }

    while (p.y - ref.y >= WORLD_SIZE/2) {
      p.y -= WORLD_SIZE;
    }
    while (p.y - ref.y < -WORLD_SIZE/2) {
      p.y += WORLD_SIZE;
    }
    return p;
  };

  // Returns an equivalent position near (within WORLD_SIZE/2 units of) `ref`.
  // This may return a non-canonical position (in a "parallel universe") for
  // ease of use relative to `ref`, such as in path-finding or rendering.
  // If `ref` is not given, returns canonicalized position.
  const near = ({ x, y, vx, vy }, ref) => canonicalize({ x, y, vx, vy }, ref);

  const norm = v => {
    // Normalize to top speed
    const { x, y } = v;
    if (Math.abs(x) > Math.abs(y)) {
      return {
        x: MAX_SPEED * Math.sign(x),
        y: Math.abs(y/x) * MAX_SPEED * Math.sign(y),
      };
    } else if (y === 0) {
      return { x:0, y:0 };
    } else {
      return {
        x: Math.abs(x/y) * MAX_SPEED * Math.sign(x),
        y: MAX_SPEED * Math.sign(y),
      };
    }
  };

  // Modulo (remainder with same sign as b)
  const mod = (a, b) => (((a % b) + b) % b);

  // Clamp n within the range of [lower, upper]
  const clamp = (n, lower, upper) => Math.min(Math.max(lower, n), upper);

  // Given two point-like objects, a and b, the distance between them.
  // NOTE: Thrust axes are independent, so we use Chebyshev distance.
  const dist = (a, b) => {
    b = near(b, a);
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  };

  // Estimates latency using AHOY! actions
  const matey = (function() {
    let _active = false;

    const ahoyBtn = document.querySelector('button.sayAhoy');
    let lastPong = null;
    let lastPing = null;
    let lastLatency = null;

    // Configuration params

    // Sample rate (server-limited to around 3s, but don't be obnoxious)
    // Min age avoids hitting the rate limit with player-initiated ahoys
    const MIN_AGE = 3500;
    // Max age automatically sends ahoys when stale
    let MAX_AGE = null;
    let pingTimer = null;

    // Max time to wait for a reply
    // Replies could take longer, but often signal more sporadic issues
    const MAX_DELAY = 500;

    const ping = () => {
      const now = ts();
      if (lastPing && now - lastPing < MIN_AGE) { return; }
      socket.send(`ahoy!`);
      lastPing = now;
    };

    // Confirm that an ahoy was ours and update lastLatency based on the delay.
    const pong = event => {
      // Have we ahoy'd recently?
      if (!lastPing || lastPong && lastPong > lastPing) { return; }
      const now = ts();
      const delay = now - lastPing;
      if (delay > MAX_DELAY) { return; }

      const messageType = event.data.substr(0, 2);
      if (messageType !== 'a:') { return; }

      // Could this have been our ahoy?
      // r := radius of max distance from ahoy emitter
      // NOTE: the ahoy position should match our own most recent position
      // snapshot from the server. Which makes sense: both are based on the
      // world state at the same server time. Allow for up to a tick of
      // wiggle room in case an ahoy is ever sent before a position update.
      const { x, y } = JSON.parse(event.data.substr(2));
      const me = Entities[playerData.uid];
      const r = MAX_SPEED * 1.001;
      if (Math.abs(me.x - x) > r || Math.abs(me.y - y) > r) { return; }

      // Update lastLatency
      // NOTE: would be nice to smooth this (with EMA), but samples will be so
      // infrequent as to make any useful time constant produce an alpha value
      // of effectively 1.
      lastLatency = delay;
      lastPong = now;
    };

    return {
      get active() { return _active; },

      get latency() { return lastLatency; },

      get interval() { return MAX_AGE; },
      set interval(interval) {
        if (!_active) { return; }
        MAX_AGE = interval;
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (!interval) { return; }
        pingTimer = setInterval(ping, interval);
        const now = ts();
        if (!lastPing || now - lastPing > interval) {
          ping();
        }
      },

      start() {
        if (_active) { return; }

        socket.addEventListener('message', pong);

        const clickAhoy = () => { lastPing = ts(); };

        ahoyBtn.addEventListener('click', clickAhoy);

        _active = true;

        // stop() removes listeners and undoes patches when called
        const stop = () => {
          this.interval = null;
          this.stop = () => {};
          _active = false;
          ahoyBtn.removeEventListener('click', clickAhoy);
          socket.removeEventListener('message', pong);
          lastPong = null;
          lastPing = null;
          lastLatency = null;
        };

        this.stop = stop;
      },

      stop() {},
    };
  })();

  // Provides predictions by replaying recorded input over snapshots
  const soothsayer = (function () {

    let _active = false;

    const _inputs = [];

    const _density = (function () {
      /* globals ImageAssets, OffscreenCanvas */
      const ctx = new OffscreenCanvas(WORLD_SIZE, WORLD_SIZE).getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(ImageAssets.blocks, 0, 0);
      const data = ctx.getImageData(0, 0, WORLD_SIZE, WORLD_SIZE).data;
      const alpha = new Uint8ClampedArray(data.length/4);
      for (let i=0; i<alpha.length; i++) {
        alpha[i] = data[i*4+3];
      }
      return ({x, y}) => alpha[Math.floor(x)+Math.floor(y)*WORLD_SIZE]/255;
      //return ({x, y}) => data[(Math.floor(x)+Math.floor(y)*WORLD_SIZE)*4+3]/255;
    })();

    return {
      get active() { return _active; },

      clear() { _inputs.splice(0); },

      // Trims input log to remove inputs before cutoff
      trim(cutoff) {
        // Need to keep last input before cutoff
        while (_inputs.length > 1 && _inputs[1][0] < cutoff) {
          _inputs.shift();
        }
      },

      // Returns a list of merged tick-by-tick inputs
      // We want the last input seen before each server tick
      *merge(cutoff, ticks=0) {
        this.trim(cutoff - 5*TICKSIZE);

        let i = 0;
        let input = 0;
        while (ticks > 0) {
          cutoff += TICKSIZE;
          while (i < _inputs.length && _inputs[i][0] <= cutoff) {
            input = _inputs[i][1];
            i++;
          }
          yield input;
          ticks--;
        }
      },

      // Apply inputs to a snapshot
      predict(snapshot, latency=0, ticks=0) {
        if (!_active || ticks === 0) { return snapshot; }
        const { x, y, vx, vy, when } = snapshot;
        const predicted = { x: +x, y: +y, vx: +vx, vy: +vy, when };
        for (const input of this.merge(when-latency, ticks)) {
          // Round any velocity below threshold to zero
          if (Math.abs(predicted.vx) < MIN_SPEED) {
            predicted.vx = 0;
          }
          if (Math.abs(predicted.vy) < MIN_SPEED) {
            predicted.vy = 0;
          }

          // Integrate velocity
          const next = canonicalize({
            x: predicted.x + predicted.vx,
            y: predicted.y + predicted.vy,
          });

          const d = _density(next);
          if (d >= 0.9) {
            // If we would end up inside solid terrain, stop
            predicted.vx = 0;
            predicted.vy = 0;
            continue;
          }

          predicted.x = next.x;
          predicted.y = next.y;

          // Integrate acceleration
          if (input & Keys.ANCHOR) {
            // Anchor overrides all input except for drag
            predicted.vx *= 1 - DRAG_ANCHOR;
            predicted.vy *= 1 - DRAG_ANCHOR;
            if ((input & (Keys.LEFT | Keys.RIGHT)) === 0) {
              // Also idle on x-axis, apply linear drag
              predicted.vx *= 1 - DRAG_IDLE;
            }
            if ((input & (Keys.UP | Keys.DOWN)) === 0) {
              // Also idle on y-axis, apply linear drag
              predicted.vy *= 1 - DRAG_IDLE;
            }

          } else {
            // VX
            switch (input & (Keys.LEFT | Keys.RIGHT)) {
              case Keys.LEFT|Keys.RIGHT:
                // Both directions => zero drag on x-axis
                break;
              case Keys.LEFT:
                predicted.vx -= ACCEL;
                break;
              case Keys.RIGHT:
                predicted.vx += ACCEL;
                break;
              case 0:
                // Idle on x-axis, apply linear drag
                predicted.vx *= 1 - DRAG_IDLE;
                break;
            }

            // VY
            switch (input & (Keys.UP | Keys.DOWN)) {
              case Keys.UP|Keys.DOWN:
                // Both directions => zero drag on y-axis
                break;
              case Keys.UP:
                predicted.vy -= ACCEL;
                break;
              case Keys.DOWN:
                predicted.vy += ACCEL;
                break;
              case 0:
                // Idle on y-axis, apply linear drag
                predicted.vy *= 1 - DRAG_IDLE;
                break;
            }
          }

          // Clamp velocity based on density
          const s = MAX_SPEED*(1-d);
          predicted.vx = clamp(predicted.vx, -s, s);
          predicted.vy = clamp(predicted.vy, -s, s);
        }

        return canonicalize(predicted);
      },

      start() {
        if (_active) { return; }

        // Monkey patch socket.send to capture input
        const _send = socket.send;
        socket.send = m => {
          // Call original
          _send.bind(socket)(m);

          // Record input
          if (m.substr(0, 3) !== 'ks:') { return; }
          const now = ts();
          _inputs.push([now, +m.substr(3)]);
        };

        _active = true;

        // stop() removes listeners and undoes patches when called
        const stop = () => {
          this.stop = () => {};
          _active = false;
          socket.send = _send;
          this.clear();
        };

        this.stop = stop;
      },

      stop() {},
    };
  })();

  // Provides movement guidance to follow a sequence of waypoints
  // Call update({x,y,vx,vy}) to provide current location and velocity
  const navigator = (function () {
    let _active = false;

    // Previous snapshots for movement smoothing
    let s0, s1;

    return {
      get active() { return _active; },

      pause: false,

      get input() { return keyState; },
      set input(state) {
        if (!_active) { return; }
        /* globals keyState */
        if (state !== keyState) {
          keyState = state; // jshint ignore:line
          socket.send(`ks:${keyState}`);
        }
      },

      smoothPlayerMotion() {
        const me = Entities[(playerData ?? {}).uid];
        if (!me) { return; }

        const now = ts();
        if (!s0 || +me.x !== s0.x || +me.y !== s0.y || +me.vx !== s0.vx || +me.vy !== s0.vy) {
          s1 = s0;
          s0 = {
            x: +me.x,
            y: +me.y,
            vx: +me.vx,
            vy: +me.vy,
            when: now,
          };
          if (s1?.when > now - 10*TICKSIZE) {
            s0.when = Math.max(Math.min(s1.when + TICKSIZE, now), now - 2*TICKSIZE);
          }
        }

        let p0 = s0, p1 = s1;
        let a = (now - p0.when)/TICKSIZE;
        const latency = matey.latency ?? 0;
        const ticks = Math.round(latency / TICKSIZE) + Math.floor(a) + 1;
        if (p1 && a < 1) {
          p1 = soothsayer.predict(p1, latency, ticks);
        } else {
          // Either no previous snapshot or latest is already old
          p1 = soothsayer.predict(p0, latency, ticks-1);
          a %= 1;
        }
        p0 = near(soothsayer.predict(p0, latency, ticks), p1);

        // Blend with previous snapshot
        me.corrected = canonicalize({
          x: a*p0.x + (1-a)*p1.x,
          y: a*p0.y + (1-a)*p1.y,
          vx: a*p0.vx + (1-a)*p1.vx,
          vy: a*p0.vy + (1-a)*p1.vy,
          when: now,
        });
      },

      handleUpdate(event) {
        const playerId = (playerData ?? {}).uid;
        const me = Entities[playerId];
        if (!me) { return; }

        // Hacky way to determine if this is the last part of a server tick update
        if (!event.data.startsWith(`e:{"${playerId}":{"vx":`)) { return; }
        const { vx, vy } = JSON.parse(event.data.slice(2))[playerId];
        // Apply the update, in case the base implementation hasn't already
        me.vx = +vx;
        me.vy = +vy;

        // Generate "corrected" position for player
        this.smoothPlayerMotion();
      },

      start() {
        if (_active) { return; }

        const handleUpdate = this.handleUpdate.bind(this);

        socket.addEventListener('message', handleUpdate);

        _active = true;

        // stop() removes listeners and undoes patches when called
        const stop = () => {
          this.stop = () => {};
          _active = false;
          socket.removeEventListener('message', handleUpdate);
        };

        this.stop = stop;
      },

      stop() {},
    };
  })();

  // Handles the UI and high level ship control
  //
  // There are multiple UI "modes":
  //   Standard: the default UI and ship controls (with QoL improvements)
  //     Replace "Set Bearing" with automatic pathfinder (TODO)
  //   Auto-Race: automated waypoint-following, show active path (WIP)
  //   Path Editor: Detach camera from ship, view and edit saved paths (WIP)
  //     WASD/Arrows/MiddleClick pan camera
  //
  // UI Improvements:
  //   Client-side prediction and interpolation
  //   Mouse wheel zoom
  //   Minimap shows outline of screen
  //   Mouse click sailing replaced with Sail To on click (TODO)
  //   Show split times during races (TODO)
  const captain = (function () {
    /* globals handleKey, handleCanvasCursor, handleMouseToggle, BuoyRenderBuffer, ImageAssets */
    let _active = false;

    const portLabel = document.querySelector('.port-label');
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');

    const renderers = {
      base: null,
      pre: [],
      replace: [],
      post: [],
    };

    const addRenderer = ({ post, pre, replace }) => {
      if (post) { renderers.post.push(post); }
      if (pre) { renderers.pre.unshift(pre); }
      if (replace) { renderers.replace.unshift(replace); }
    };

    const removeRenderer = ({ post, pre, replace }) => {
      while (post && post !== renderers.post.pop()) {}
      while (pre && pre !== renderers.pre.shift()) {}
      while (replace && replace !== renderers.replace.shift()) {}
    };

    // Event handlers and renderers to attach/detach when switching modes.
    const modes = {
      // Unmodded UI
      'stock': {
        handlers: [
          // [ target, type, listener ]
          [ document, 'keydown', handleKey ],
          [ document, 'keyup', handleKey ],
          [ canvas, 'mousemove', handleCanvasCursor ],
          [ canvas, 'mousedown', handleMouseToggle ],
          [ canvas, 'mouseup', handleMouseToggle ],
        ],
      },
    };

    // A key from `modes` for the current UI mode
    let _mode = 'stock';

    const ui = {
      get active() { return _active; },

      set mode(m) {
        if (!modes[m]) { return; }

        // Unbind old mode
        modes[_mode].renderers?.toReversed().forEach(removeRenderer);
        modes[_mode].handlers?.toReversed().forEach(h=>removeEventListener.call(...h));
        modes[_mode].stop?.();

        // Bind new mode
        _mode = m;
        modes[_mode].start?.();
        modes[_mode].handlers?.forEach(h=>addEventListener.call(...h));
        modes[_mode].renderers?.forEach(addRenderer);
      },

      get mode() { return _mode; },

      get modes() { return modes.keys(); },

      start() {
        if (_active) { return; }

        const raf = requestAnimationFrame;
        const noop = () => {};

        // New render loop
        let _requestAnimationFrame = noop;
        const renderFrame = () => {
          const base = renderers.replace[0] ?? renderers.base;
          renderers.pre.forEach(r=>r());
          base();
          renderers.post.forEach(r=>r());
          _requestAnimationFrame(renderFrame);
        };

        // Lay a trap for the original render loop
        requestAnimationFrame = f => { // jshint ignore:line
          renderers.base = f;
          requestAnimationFrame = noop; // jshint ignore:line
          _requestAnimationFrame = raf;
          // Start new render loop
          renderFrame();
        };

        this.mode = 'standard';

        _active = true;

        const stop = () => {
          this.stop = () => {};
          _active = false;
          this.mode = 'stock';

          // Lay a trap for the new render loop
          _requestAnimationFrame = () => {
            _requestAnimationFrame = noop;
            requestAnimationFrame = raf; // jshint ignore:line
            // Start original render loop
            renderers.base();
          };
        };

        this.stop = stop;

        return stop;
      },

      stop() {},
    };

    let lastMode = 'standard';
    const handleToggleEditor = event => {
      if (event.key !== 'Tab') { return; }
      event.preventDefault();

      if (ui.mode !== 'editor') {
        lastMode = ui.mode;
        ui.mode = 'editor';
        return;
      }
      ui.mode = lastMode;
    };

    // Renderers

    let Clock = ts()/1000;
    const WORLD_SCALE = 15;
    const CANVAS_GUTTER = BuoyRenderBuffer;

    const camera = {
      // Actual
      cx: null,
      cy: null,
      cz: 0,

      // Target
      tx: null,
      ty: null,
      tz: 0,

      get x() { return this.cx ?? this.tx; },
      get y() { return this.cy ?? this.ty; },
      get z() { return this.cz ?? this.tz; },

      // Wrap x and y within [0, WORLD_SIZE)
      set x(value) { this.tx = mod(value, WORLD_SIZE); },
      set y(value) { this.ty = mod(value, WORLD_SIZE); },
      // Clamp z within reasonable range (2x zoom to 1/4x zoom)
      set z(value) { this.tz = clamp(value, -1000, 2000); },

      pan(dx, dy) {
        this.x = this.tx + dx;
        this.y = this.ty + dy;
      },

      zoom(dz) {
        this.z = this.tz + dz;
      },

      get zoomFactor() {
        //return Math.exp(-this.z*Math.LN2/1000)*WORLD_SCALE;
        return 2**(-this.z/1000) * WORLD_SCALE;
      },

      get valid() {
        const { tx, ty, tz } = this;
        // All values must not be nullish or NaN
        return !(!tx && tx !== 0 || !ty && ty !== 0 || !tz && tz !== 0);
      },

      // Time constant for smoothing
      tmax: 1.0,

      get t() {
        return this.tmax*Math.max(0, (this.z+500)/2500);
      },

      update(dt) {
        if (!this.valid) { return; }

        const a = 1 - Math.exp(-dt/this.t);

        const { x:tx, y:ty } = near({ x: this.tx, y: this.ty }, this);
        const { tz, x:cx, y:cy, z:cz } = this;

        ({ x:this.cx, y:this.cy, z:this.cz } = canonicalize({
          x: a*tx + (1-a)*cx,
          y: a*ty + (1-a)*cy,
          z: a*tz + (1-a)*cz,
        }));
        this._boundsDirty = true;
      },

      follow(item) {
        this.x = item.x;
        this.y = item.y;
      },

      // Apply camera transform
      transform(context) {
        context ??= ctx; // jshint ignore:line

        if (!this.valid) { return; }

        const { width, height } = context.canvas;
        const { x, y, zoomFactor } = this;

        context.resetTransform();
        context.translate(width/2, height/2);
        context.scale(zoomFactor, zoomFactor);
        context.translate(-x, -y);
      },

      wp2cp(p) {
        if (!this.valid) { return p; }

        const { width, height } = ctx.canvas;
        const { x, y, zoomFactor } = this;
        return {
          x: width/2 + (+p.x - x)*zoomFactor,
          y: height/2  + (+p.y - y)*zoomFactor,
        };
      },

      cp2wp(p) {
        if (!this.valid) { return p; }

        const { width, height } = ctx.canvas;
        const { x, y, zoomFactor } = this;
        return {
          x: (+p.x - width/2)/zoomFactor + x,
          y: (+p.y - height/2)/zoomFactor + y,
        };
      },

      _bounds: [],
      _boundsDirty: true,
      get bounds() {
        if (!this._boundsDirty) { return this._bounds; }

        const { width, height } = ctx.canvas;
        const p0 = this.cp2wp({x: 0-CANVAS_GUTTER, y: 0-CANVAS_GUTTER});
        const p1 = this.cp2wp({x: width+CANVAS_GUTTER, y: height+CANVAS_GUTTER});
        const b = [{
          x0: p0.x,
          y0: p0.y,
          x1: p1.x,
          y1: p1.y,
          xo: 0,
          yo: 0,
        }];

        if (b[0].x0 < 0) {
          b.push({
            x0: b[0].x0+WORLD_SIZE,
            y0: b[0].y0,
            x1: WORLD_SIZE,
            y1: b[0].y1,
            xo: -WORLD_SIZE,
            yo: 0,
          });
          b[0].x0 = 0;
        }
        if (b[0].x1 > WORLD_SIZE) {
          b.push({
            x0: 0,
            y0: b[0].y0,
            x1: b[0].x1-WORLD_SIZE,
            y1: b[0].y1,
            xo: WORLD_SIZE,
            yo: 0,
          });
          b[0].x1 = WORLD_SIZE;
        }

        const nx = b.length;
        if (b[0].y0 < 0) {
          for (let i=0; i<nx; i++) {
            b.push({
              x0: b[i].x0,
              y0: b[i].y0+WORLD_SIZE,
              x1: b[i].x1,
              y1: WORLD_SIZE,
              xo: b[i].xo,
              yo: -WORLD_SIZE,
            });
            b[i].y0 = 0;
          }
        }
        if (b[0].y1 > WORLD_SIZE) {
          for (let i=0; i<nx; i++) {
            b.push({
              x0: b[i].x0,
              y0: 0,
              x1: b[i].x1,
              y1: b[i].y1-WORLD_SIZE,
              xo: b[i].xo,
              yo: WORLD_SIZE,
            });
            b[i].y1 = WORLD_SIZE;
          }
        }

        this._bounds = b;
        this._boundsDirty = false;
        return b;
      },

      inFrame(p) {
        if (!this.valid) { return []; }
        p = near(p);

        return this.bounds.filter(
          ({x0, y0, x1, y1})=>(p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
        ).map(
          ({xo, yo})=>({x: xo, y: yo})
        );
      },

      panSpeed: 20,
      zoomSpeed: 1,
      speedFactor: 4,

      handleKey(event) {
        const { panSpeed, speedFactor, zoomFactor } = this;
        const ps = panSpeed * (event.shiftKey ? speedFactor : 1) / zoomFactor;
        switch (event.code) {
          case 'ArrowDown':
          case 'KeyS':
            this.pan(0, ps);
            break;
          case 'ArrowLeft':
          case 'KeyA':
            this.pan(-ps, 0);
            break;
          case 'ArrowRight':
          case 'KeyD':
            this.pan(ps, 0);
            break;
          case 'ArrowUp':
          case 'KeyW':
            this.pan(0, -ps);
            break;
          case 'Home':
            const me = Entities[(playerData ?? {}).uid];
            if (me) {
              this.x = me.x;
              this.y = me.y;
              this.z = 0;
            }
            break;
        }
      },

      handleWheel(event) {
        event.preventDefault();

        const zs = this.zoomSpeed * (event.shiftKey ? this.speedFactor : 1);
        this.zoom(zs*event.deltaY);
      },
    };

    /* Adapted from: https://github.com/dy/bitmap-sdf */
    const calcSDF = (function () {
      const INF = 1e20;

      function calcSDF(src, options) {
        if (!options) options = {};

        let cutoff = options.cutoff ?? 0.25;
        let radius = options.radius ?? 8;
        let channel = options.channel ?? 0;
        let w, h, size, data, intData, stride, ctx, canvas, imgData, i, l;

        // handle image container
        if (ArrayBuffer.isView(src) || Array.isArray(src)) {
          if (!options.width || !options.height) {
            throw Error('For raw data width and height should be provided by options');
          }
          ({ width:w, height:h } = options);
          data = src;

          stride = options.stride ?? Math.floor(src.length / w / h);
        }
        else {
          if (src instanceof HTMLCanvasElement) {
            canvas = src;
            ctx = canvas.getContext('2d');
            ({ width:w, height:h } = canvas);
            imgData = ctx.getImageData(0, 0, w, h);
            data = imgData.data;
            stride = 4;
          }
          else if (src instanceof CanvasRenderingContext2D) {
            canvas = src.canvas;
            ctx = src;
            ({ width:w, height:h } = canvas);
            imgData = ctx.getImageData(0, 0, w, h);
            data = imgData.data;
            stride = 4;
          }
          /* globals ImageData */
          else if (src instanceof ImageData) {
            imgData = src;
            ({ width:w, height:h } = src);
            data = imgData.data;
            stride = 4;
          }
        }

        size = Math.max(w, h);

        //convert int data to floats
        if ((data instanceof Uint8ClampedArray) || (data instanceof Uint8Array)) {
          intData = data;
          data = Array(w*h);

          for (i = 0, l = Math.floor(intData.length / stride); i < l; i++) {
            data[i] = intData[i*stride + channel] / 255;
          }
        }
        else if (stride !== 1) {
          throw Error('Raw data can have only 1 value per pixel');
        }

        // temporary arrays for the distance transform
        const gridOuter = Array(w * h);
        const gridInner = Array(w * h);
        const f = Array(size);
        const d = Array(size);
        const z = Array(size + 1);
        const v = Array(size);

        for (i = 0, l = w * h; i < l; i++) {
          const a = data[i];
          gridOuter[i] = a === 1 ? 0 : a === 0 ? INF : Math.pow(Math.max(0, 0.5 - a), 2);
          gridInner[i] = a === 1 ? INF : a === 0 ? 0 : Math.pow(Math.max(0, a - 0.5), 2);
        }

        edt(gridOuter, w, h, f, d, v, z);
        edt(gridInner, w, h, f, d, v, z);

        const dist = new Uint8Array(w * h);

        for (i = 0, l = w*h; i < l; i++) {
          dist[i] = 255 * clamp(1 - ((gridOuter[i] - gridInner[i])/radius + cutoff), 0, 1);
        }

        return dist;
      }

      // 2D Euclidean distance transform by Felzenszwalb & Huttenlocher https://cs.brown.edu/~pff/dt/
      function edt(data, width, height, f, d, v, z) {
        for (let x = 0; x < width; x++) {
          for (let y = 0; y < height; y++) {
            f[y] = data[y * width + x];
          }
          edt1d(f, d, v, z, height);
          for (let y = 0; y < height; y++) {
            data[y * width + x] = d[y];
          }
        }
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            f[x] = data[y * width + x];
          }
          edt1d(f, d, v, z, width);
          for (let x = 0; x < width; x++) {
            data[y * width + x] = Math.sqrt(d[x]);
          }
        }
      }

      // 1D squared distance transform
      function edt1d(f, d, v, z, n) {
        v[0] = 0;
        z[0] = -INF;
        z[1] = +INF;

        for (let q = 1, k = 0; q < n; q++) {
          let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          }
          k++;
          v[k] = q;
          z[k] = s;
          z[k + 1] = +INF;
        }

        for (let q = 0, k = 0; q < n; q++) {
          while (z[k + 1] < q) k++;
          d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
      }

      return calcSDF;
    })();

    const background = (function () {
      const canvas = document.createElement('canvas');
      document.body.insertBefore(canvas, document.querySelector('canvas'));
      const gl = canvas.getContext('webgl');

      // Black
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Vertex shader program
      const vsSource = `
      attribute vec2 aPosCoord;

      void main(void) {
        gl_Position = vec4(aPosCoord.xy, 0.0, 1.0);
      }
      `;

      // Fragment shader program
      const fsSource = `
      precision mediump float;

      uniform vec3 uCamera;
      uniform vec2 uCanvasSize;
      uniform sampler2D uSampler;

      vec3 land(vec2 p, float a) {
        const vec3 c0 = vec3(0.329, 0.329, 0.282);
        const vec3 c1 = vec3(0.780, 0.761, 0.663);
        return mix(c0, c1, clamp(a, 0.0, 1.0));
      }

      vec3 sea(vec2 p, float a) {
        const vec3 c0 = vec3(0.353, 0.612, 0.863);
        const vec3 c1 = vec3(0.043, 0.322, 0.537);
        const vec3 c2 = vec3(0.012, 0.086, 0.141);
        float rMax = length(uCanvasSize.xy)*0.5;
        float r = 2.0*length(p-0.5*uCanvasSize)/rMax + 0.25*a;
        if (r < 1.0) {
          return mix(c0, c1, r);
        } else {
          return mix(c1, c2, r-1.0);
        }
      }

      void main(void) {
        vec2 texCoord = mod((uCamera.xy + (gl_FragCoord.xy - 0.5*uCanvasSize)/uCamera.z)/2000.0, 1.0);
        float a = texture2D(uSampler, texCoord).a;
        vec3 sea = sea(gl_FragCoord.xy, smoothstep(0.35, 0.7, a));
        vec3 land = land(gl_FragCoord.xy, smoothstep(0.7, 0.85, a));
        const float w = 0.01;
        gl_FragColor = vec4(mix(sea, land, smoothstep(0.7-w, 0.7+w, a)), 1.0);
      }
      `;

      // Set up shaders
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSource);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSource);
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(`Link failed: ${gl.getProgramInfoLog(prog)}`); // jshint ignore:line
        console.error(`vs info-log: ${gl.getShaderInfoLog(vs)}`); // jshint ignore:line
        console.error(`fs info-log: ${gl.getShaderInfoLog(fs)}`); // jshint ignore:line
      }

      // Collect all the info needed to use the shader program.
      // Look up which attributes our shader program is using
      // for aVertexPosition, aVertexColor and also
      // look up uniform locations.
      const programInfo = {
        program: prog,
        attribLocations: {
          posCoord: gl.getAttribLocation(prog, "aPosCoord"),
        },
        uniformLocations: {
          camera: gl.getUniformLocation(prog, "uCamera"),
          canvasSize: gl.getUniformLocation(prog, "uCanvasSize"),
          sampler: gl.getUniformLocation(prog, "uSampler"),
        },
      };

      // Set up buffer
      const posCoords = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posCoords);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1,
          -1, 1,
          1, -1,
          1, 1,
        ]),
        gl.STATIC_DRAW,
      );

      // Set up texture
      const tex = gl.createTexture();
      {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.ALPHA,
          1, 1, 0,
          gl.ALPHA, gl.UNSIGNED_BYTE,
          new Uint8Array([0.0]),
        );
        const img = new Image();
        img.onload = () => {
          const ctx = new OffscreenCanvas(WORLD_SIZE, WORLD_SIZE).getContext('2d');
          ctx.drawImage(img, 0, 0);
          const data = calcSDF(
            ctx.getImageData(0, 0, WORLD_SIZE, WORLD_SIZE), {
              channel: 3,
              cutoff: 0.25,
              radius: 8,
            },
          );

          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.ALPHA,
            WORLD_SIZE, WORLD_SIZE, 0,
            gl.ALPHA, gl.UNSIGNED_BYTE,
            data,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        };
        img.src = 'https://2023.holidayhackchallenge.com/sea/assets/island_detail.png';
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      return {
        handleResize() {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          gl.viewport(0, 0, canvas.width, canvas.height);
        },

        render() {
          gl.clearColor(0.0, 0.0, 1.0, 1.0);
          gl.clearDepth(1.0);
          gl.enable(gl.DEPTH_TEST);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

          // Set program
          gl.useProgram(programInfo.program);

          // Set buffers
          gl.bindBuffer(gl.ARRAY_BUFFER, posCoords);
          gl.vertexAttribPointer(programInfo.attribLocations.worldCoord, 2, gl.FLOAT, false, 0, 0);
          gl.enableVertexAttribArray(programInfo.attribLocations.worldCoord);

          // Set uniforms
          {
            const { x, y, zoomFactor:z } = camera;
            gl.uniform3f(programInfo.uniformLocations.camera, x, WORLD_SIZE-y, z);
            gl.uniform2f(programInfo.uniformLocations.canvasSize, canvas.width, canvas.height);
          }

          // Set texture
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(programInfo.uniformLocations.sampler, 0);

          // Draw
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        },
      };
    })();

    const getShipAngle = e => {
      return Math.sin(e.clockOffset + 3*Clock) * 2*Math.PI/180;
    };

    const drawWaveClip = ctx => {
      const SQUIGGLES = 6;
      const MASK_WIDTH = 120;
      const SEGMENT_LENGTH = MASK_WIDTH / SQUIGGLES;
      const WAVE_AMPLITUDE = 5;
      const BASELINE = 3;

      ctx.beginPath();
      ctx.moveTo(-MASK_WIDTH/2, BASELINE);
      for (let i = 0; i <= SQUIGGLES; i += 1) {
        const x = -MASK_WIDTH/2 + (i * SEGMENT_LENGTH) + (15*Clock)%SEGMENT_LENGTH;
        ctx.bezierCurveTo(
          x - SEGMENT_LENGTH * 0.66, BASELINE - WAVE_AMPLITUDE,
          x - SEGMENT_LENGTH * 0.33, BASELINE + WAVE_AMPLITUDE,
          x, BASELINE,
        );
      }
      ctx.lineTo( MASK_WIDTH/2, BASELINE);
      ctx.lineTo( MASK_WIDTH/2, BASELINE-100);
      ctx.lineTo(-MASK_WIDTH/2, BASELINE-100);
      ctx.closePath();
      ctx.clip();
    };

    const drawAhoy = (ctx, e) => {
      const perc = 1 - (e.age / 2000);
      ctx.fillStyle = `rgba(5, 35, 57, ${perc})`;
      ctx.textAlign = 'center';
      ctx.font = 'bold 14px Roboto';
      ctx.lineWidth = 1;

      ctx.fillText('AHOY!', 0, -(120 + 0.01*(e.age - 2000)));
    };

    const drawBuoy = (ctx, e) => {
      drawWaveClip(ctx);

      ctx.rotate(getShipAngle(e));
      ctx.scale(e.o, 1);
      ctx.drawImage(ImageAssets[e.image], -e.offset.x, -e.offset.y);
    };

    /* globals OffscreenCanvas */
    const shipCanvas = new OffscreenCanvas(81, 77);
    const shipCtx = shipCanvas.getContext('2d');
    shipCtx.imageSmoothingEnabled = false;
    const shipCache = {};

    const drawShipCached = (ctx, e, id) => {
      if (!shipCache[id]) {
        shipCache[id] = 'rendering';
        drawShipBase(shipCtx, e).then(image => {
          shipCache[id] = image;
        });
      }
      if (shipCache[id] === 'rendering') { return; }
      ctx.drawImage(shipCache[id], 0, 0);
    };

    const drawShipBase = (ctx, e) => {
      const imgs = [
        ImageAssets.ship,
        ImageAssets[`lo_${e.config.colors[0]}`],
        ImageAssets[`mid_${e.config.colors[1]}`],
        ImageAssets[`top_${e.config.colors[2]}`],
      ];

      for (let lei = 1; lei <= 6; lei += 1) {
        if (!e.config.progress[lei - 1]) { continue; }
        imgs.push(ImageAssets[`lei${lei}`]);
      }

      return Promise.all(imgs.map(img => {
        if (img.complete) { return img; }
        return new Promise((resolve, reject) => {
          if (img.complete) { resolve(img); return; }
          img.onload = () => resolve(img);
          img.onerror = () => reject;
        });
      }))
        .then(imgs => {
          ctx.clearRect(0, 0, 81, 77);
          for (const img of imgs) {
            ctx.drawImage(img, 0, 0);
          }
          return ctx.canvas.transferToImageBitmap();
        });
    };

    const drawShip = (ctx, e, id) => {
      drawWaveClip(ctx);

      ctx.save();
      ctx.rotate(getShipAngle(e));
      ctx.scale(e.o, 1);
      ctx.translate(-52, -70);

      drawShipCached(ctx, e, id);

      if (e.fishing) {
        ctx.drawImage(e.onTheLine ? ImageAssets.roddown : ImageAssets.rod, 0, 0);
        ctx.drawImage(ImageAssets.bobber, 2, e.onTheLine ? 72 : 68);
      }

      ctx.restore();

      // Draw username
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.font = '16px Roboto';
      ctx.lineWidth = 1;

      ctx.fillText(e.username, 0, -80);
    };

    // Draw a bezier spline of this path
    const drawPath = (ctx, wps, offset, start, n=3) => {
      ctx.save();
      ctx.lineWidth = 0.5;
      ctx.setLineDash([1, 2]);
      ctx.lineDashOffset = (MAX_SPEED*1000/TICKSIZE)*Clock % 3;

      camera.inFrame(start).forEach(({x, y}) => {
        ctx.save();
        ctx.translate(x, y);
        let x0, x1, x2, v0, v1;
        x1 = near(start);
        x2 = near(wps[offset], x1);

        v1 = norm({
          x: x1.vx ?? 0,
          y: x1.vy ?? 0,
        });

        for (let i = 0; i < n && i+offset < wps.length; i++) {
          x0 = x1;
          x1 = x2;
          x2 = near(wps[i+offset+1] ?? { x: 2*x1.x-x0.x, y: 2*x1.y-x0.y }, x1);
          v0 = v1;

          const v1a = norm({
            x: x2.x - x1.x,
            y: x2.y - x1.y,
          });
          const v1b = norm({
            x: x1.x - x0.x,
            y: x1.y - x0.y,
          });
          v1 = norm({
            x: x1.vx ?? (v1a.x + v1b.x),
            y: x1.vy ?? (v1a.y + v1b.y),
          });

          const t = dist(x0, x1)/MAX_SPEED;
          const p = [
            x0.x, x0.y,
            x0.x+v0.x*t/3, x0.y+v0.y*t/3,
            x1.x-v1.x*t/3, x1.y-v1.y*t/3,
            x1.x, x1.y,
          ];

          ctx.strokeStyle = `rgb(0, 255, 0, ${0.5*(n-i)/n})`;
          ctx.beginPath();
          // Draw from end so that dashed line does not "slide" forward
          ctx.moveTo(p[6], p[7]);
          ctx.bezierCurveTo(p[4], p[5], p[2], p[3], p[0], p[1]);
          ctx.stroke();
        }
        ctx.restore();
      });

      ctx.restore();
    };

    const followPlayer = () => {
      const me = Entities[(playerData ?? {}).uid];
      if (!me) { return; }
      camera.follow(me.corrected ?? me);
    };

    const renderScene = () => {
      /* globals isMaidenVoyage */
      const dt = ts()/1000 - Clock;
      Clock += dt;

      const playerId = (playerData ?? {}).uid;
      const me = Entities[playerId];
      if (!me) { return; }
      const showOthers = !isMaidenVoyage && me.showOthers;

      if (me.port) {
        if (!portLabel.classList.contains('visible')) {
          portLabel.classList.add('visible');
          portLabel.querySelector('p').innerText = me.port.island;
          portLabel.querySelector('h3').innerText = me.port.name;
        }
        const portPoint = camera.wp2cp(me.port);
        portLabel.style.transform = `translate3d(${portPoint.x - 150}px, ${portPoint.y - 100}px, 0px)`;
      } else {
        if (portLabel.classList.contains('visible')) {
          portLabel.classList.remove('visible');
        }
      }

      // Update camera and apply transform
      camera.update(dt);
      background.render();

      ctx.save();
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      camera.transform();

      // Draw entities
      Object.entries(Entities).map(
        ([ id, e ]) => [ id, e, near(e.corrected ?? e, camera) ]
      ).sort(
        (a, b) => (a[2].y-b[2].y)
      ).forEach(([itemId, item, pos]) => {
        /* globals renderTerrainLayer */
        if (itemId.substr(0, 2) === 't:') {
          renderTerrainLayer(parseInt(itemId.substr(2), 10));
          return;
        }

        if (item.dob && item.lifespan) {
          item.age = Date.now() - item.dob;
          if (item.age > item.lifespan) {
            delete Entities[itemId];
            return;
          }
        }

        pos = canonicalize(pos);
        const { x:ix, y:iy } = pos;
        camera.inFrame(pos).forEach(({x, y}) => {
          ctx.save();
          ctx.translate(ix+x, iy+y);
          ctx.scale(1/WORLD_SCALE, 1/WORLD_SCALE);

          if (showOthers && item.type === 'ahoy') {
            drawAhoy(ctx, item);
          } else if (item.type === 'buoy') {
            drawBuoy(ctx, item);
          } else if (showOthers || `${itemId}` === `${playerId}`) {
            drawShip(ctx, item, itemId);
          }

          ctx.restore();
        });
      });

      /* globals PORTS, HOTSPOTS */
      // Draw port hotspots
      if (!me.race && PORTS) {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 255, 0, .08)';
        ctx.strokeStyle = 'rgba(0, 255, 0, .2)';
        Object.values(PORTS).forEach(item => {
          const { x:ix, y:iy } = item;
          camera.inFrame(item).forEach(({x, y}) => {
            ctx.save();
            ctx.translate(ix+x, iy+y);

            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, 2*Math.PI);
            ctx.stroke();
            ctx.fill();
            ctx.restore();
          });
        });
        ctx.restore();
      }

      // Draw race hotspots
      if (!me.race && !me.hostspotLatch && HOTSPOTS) {
        ctx.save();
        ctx.strokeStyle = '#ffffff7f';
        ctx.lineWidth = 0.25;

        HOTSPOTS.forEach(item => {
          const { x:ix, y:iy } = item;
          camera.inFrame(item).forEach(({x, y}) => {
            ctx.save();
            ctx.translate(ix+x, iy+y);

            ctx.beginPath();
            ctx.roundRect(-4, -4, 8, 8, 2);
            ctx.stroke();

            ctx.scale(1/WORLD_SCALE, 1/WORLD_SCALE);
            const { width:w, height:h } = ImageAssets.startflag;
            ctx.drawImage(ImageAssets.startflag, -w/2, -h/2);
            ctx.restore();
          });
        });
        ctx.restore();
      }

      // Draw race overlay
      if (me.race) {
        const wps = me.race.waypoints;

        // Draw path

        drawPath(ctx, wps, me.raceIndex, me.corrected ?? me);

        // Draw next waypoint

        ctx.save();
        ctx.fillStyle = '#00ff007f';
        ctx.strokeStyle = '#ffffff7f';
        ctx.lineWidth = 0.25;

        const wp = wps[me.raceIndex];
        if (wp) {
          const { x, y } = near(wp);
          ctx.translate(x, y);
          camera.inFrame(wp).forEach(({x, y}) => {
            ctx.save();
            ctx.translate(x, y);

            ctx.beginPath();
            ctx.roundRect(-4, -4, 8, 8, 2);
            ctx.stroke();

            if (me.raceIndex === wps.length-1) {
              ctx.scale(1/WORLD_SCALE, 1/WORLD_SCALE);
              const { width:w, height:h } = ImageAssets.finishflag;
              ctx.drawImage(ImageAssets.finishflag, -w/2, -h/2);
            } else {
              ctx.beginPath();
              ctx.arc(0, 0, 4/3, 0, 2*Math.PI);
              ctx.stroke();
              ctx.fill();
            }
            ctx.restore();
          });
        }
        ctx.restore();
      }

      ctx.restore();
      return;
    };

    const renderMiniMap = () => {
      /* globals PORTS, HOTSPOTS */
      const me = Entities[(playerData ?? {}).uid];
      if (!me) { return; }

      ctx.save();
      ctx.resetTransform();
      ctx.translate(0, canvas.height - ImageAssets.minimap.height);
      ctx.drawImage(ImageAssets.minimap, 0, 0);
      const minimapScale = ImageAssets.minimap.width / WORLD_SIZE;
      ctx.scale(minimapScale, minimapScale);

      ctx.fillStyle = 'rgba(255, 0, 0, 1)';
      Object.values(PORTS).forEach(item => {
        ctx.beginPath();
        ctx.arc(item.x, item.y, 20, 0, 2*Math.PI);
        ctx.fill();
      });

      (HOTSPOTS || []).forEach(item => {
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.scale(0.25/minimapScale, 0.25/minimapScale);
        const { width:w, height:h } = ImageAssets.startflag;
        ctx.drawImage(ImageAssets.startflag, -w/2, -h/2);
        ctx.restore();
      });

      if (me) {
        ctx.save();
        const pos = me.corrected ?? me;
        ctx.translate(pos.x, pos.y);
        ctx.scale(1/minimapScale, 1/minimapScale);
        const { width:w, height:h } = ImageAssets.miniboat;
        ctx.drawImage(ImageAssets.miniboat, -w/2, -h/2);
        ctx.restore();

        ctx.lineWidth = 10;
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        ctx.fillStyle = 'rgba(255, 255, 0, 0.25)';
        ctx.beginPath();
        camera.bounds.forEach(({x0, y0, x1, y1}) => {
          ctx.rect(x0, y0, x1-x0, y1-y0);
        });
        ctx.stroke();
        ctx.fill();
      }


      ctx.restore();
    };

    let startMatey;
    // Standard modded UI
    modes.standard = {
      handlers: [
        // [ target, type, listener ]
        [ canvas, 'keydown', handleToggleEditor ],
        [ canvas, 'wheel', camera.handleWheel.bind(camera), { passive: false } ],
        [ document, 'keydown', handleKey ],
        [ document, 'keyup', handleKey ],
        [ window, 'resize', background.handleResize.bind(background) ],
      ],
      renderers: [
        { pre: followPlayer, replace: renderScene, post: renderMiniMap },
        { pre: navigator.smoothPlayerMotion.bind(navigator) },
      ],
      start() {
        background.handleResize();
        matey.start();
        startMatey = setTimeout(() => {
          matey.interval = 300000;
        }, 10000);
        soothsayer.start();
        navigator.start();
      },
      stop() {
        navigator.stop();
        soothsayer.stop();
        clearTimeout(startMatey);
        matey.stop();
      },
    };

    const editor = (function () {
      const activePath = [], selectedIndex = [];

      const context = {
        get selected() {
          return selectedIndex.map(i=>activePath[i]);
        },

        get active() {
          return activePath[selectedIndex[0]];
        },

        handleKey(event) {
          switch (event.code) {
          }
        },

        render() {
          // Render editor overlay
          // Draw path curves
          // Draw waypoints
        },
      };

      return context;
    })();

    // Path editor
    modes.editor = {
      handlers: [
        // [ target, type, listener ]
        [ canvas, 'keydown', handleToggleEditor ],
        [ canvas, 'wheel', camera.handleWheel.bind(camera), { passive: false } ],
        [ document, 'keydown', camera.handleKey.bind(camera) ],
        [ document, 'keydown', editor.handleKey.bind(editor) ],
        [ window, 'resize', background.handleResize.bind(background) ],
      ],
      renderers: [
        { replace: renderScene, post: renderMiniMap },
        { post: editor.render.bind(editor) },
        { pre: navigator.smoothPlayerMotion.bind(navigator) },
      ],
      start() {
        background.handleResize();
        camera.tmax *= 0.2;
      },
      stop() {
        camera.tmax *= 5.0;
      },
    };

    ui.camera = camera;
    ui.shipCache = shipCache;
    return ui;
  })();
  return { matey, soothsayer, navigator, captain };
})();

crew.captain.start();

/* globals unsafeWindow */
if (unsafeWindow) {
  unsafeWindow.crew = crew;
}
