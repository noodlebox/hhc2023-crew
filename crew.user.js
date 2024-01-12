// ==UserScript==
// @name        Captain and Crew (Holiday Hack Challenge 2023)
// @namespace   https://files.noodlebox.moe/
// @version     1.1
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
    while (p.x - ref.x > WORLD_SIZE/2) {
      p.x -= WORLD_SIZE;
    }
    while (p.x - ref.x < -WORLD_SIZE/2) {
      p.x += WORLD_SIZE;
    }

    while (p.y - ref.y > WORLD_SIZE/2) {
      p.y -= WORLD_SIZE;
    }
    while (p.x - ref.x < -WORLD_SIZE/2) {
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
          predicted.x += predicted.vx;
          predicted.y += predicted.vy;

          // Integrate acceleration
          if (input & Keys.ANCHOR) {
            // Anchor overrides all input for large linear drag
            predicted.vx *= 1 - DRAG_ANCHOR;
            predicted.vy *= 1 - DRAG_ANCHOR;
          } else {
            // VX
            switch (input & (Keys.LEFT | Keys.RIGHT)) {
              case Keys.LEFT|Keys.RIGHT:
                // Both directions => zero drag on x-axis
                break;
              case Keys.LEFT:
                predicted.vx -= ACCEL;
                if (predicted.vx < -MAX_SPEED) {
                  predicted.vx = -MAX_SPEED;
                }
                break;
              case Keys.RIGHT:
                predicted.vx += ACCEL;
                if (predicted.vx > MAX_SPEED) {
                  predicted.vx = MAX_SPEED;
                }
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
                if (predicted.vy < -MAX_SPEED) {
                  predicted.vy = -MAX_SPEED;
                }
                break;
              case Keys.DOWN:
                predicted.vy += ACCEL;
                if (predicted.vy > MAX_SPEED) {
                  predicted.vy = MAX_SPEED;
                }
                break;
              case 0:
                // Idle on y-axis, apply linear drag
                predicted.vy *= 1 - DRAG_IDLE;
                break;
            }
          }
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
    /* globals handleKey, handleCanvasCursor, handleMouseToggle, BuoyRenderBuffer, ImageAssets, img */
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

    const insideBounds = (bOut, bIn, g=0) => {
      if (!bOut) { return false; }
      if (!bIn) { return true; }
      return bIn.every(b1 =>
        bOut.some(b0 =>
          (b1.x0+g >= b0.x0 && b1.y0+g >= b0.y0 && b1.x1-g <= b0.x1 && b1.y1-g <= b0.y1)
        )
      );
    };

    const landCache = (function () {
      let _gutter = CANVAS_GUTTER;
      const _canvas = new OffscreenCanvas( // jshint ignore:line
        window.innerWidth + 2*_gutter,
        window.innerHeight + 2*_gutter,
      );

      const _ctx = _canvas.getContext('2d');

      let _bounds, _camera, _image;
      let _nextImage = new Promise(r=>r());
      let _rendering = false;

      let _complete = true;
      let _images = Promise.all([]);

      const redraw = () => {
        _rendering = true;
        _nextImage = _images.then(imgs => {
          const ctx = _ctx;
          ctx.resetTransform();
          ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
          camera.transform(ctx);
          const bounds = camera.bounds;
          bounds.forEach(({xo:x,yo:y}) => {
            for (const img of imgs) {
              ctx.drawImage(img, 0, 0, img.width, img.height, x, y, WORLD_SIZE, WORLD_SIZE);
            }
          });
          _bounds = bounds;
          _camera = { x: camera.x, y: camera.y, zf: camera.zoomFactor };

          return ctx.canvas.transferToImageBitmap();
        });
        _nextImage.then(image => {
          if (_image) { _image.close(); }
          _image = image;
          _rendering = false;
        });
        return _nextImage;
      };

      return {
        get width() { return _image?.width ?? _canvas.width; },
        get height() { return _image?.height ?? _canvas.height; },
        get camera() { return _camera; },
        get rendering() { return _rendering; },
        get complete() { return _complete; },

        get gutter() { return _gutter; },
        set gutter(g) {
          _nextImage.then(() => {
            _gutter = g;
            this.handleResize();
          });
        },

        get images() { return _images; },
        set images(imgs) {
          _complete = false;
          _nextImage.then(() => {
            _images = Promise.all(imgs.map(img => {
              if (img.complete) { return img; }
              return new Promise(resolve => {
                if (img.complete) { resolve(img); return; }
                img.onload = () => resolve(img);
                img.onerror = () => resolve(img);
              });
            }));

            _images.then(() => {
              _complete = true;
            });
          });
        },

        handleResize() {
          _canvas.width = window.innerWidth + 2*_gutter;
          _canvas.height = window.innerHeight + 2*_gutter;
        },

        get image() {
          if (!_rendering) {
            // Trigger a redraw if needed
            const { bounds, zoomFactor:zf } = camera;
            if (!_image || zf > _camera.zf*2 || !insideBounds(_bounds, bounds, _gutter/zf)) {
              redraw();
            }
          }
          // Just return what we have now, even if it may be stale or not yet ready
          return _image;
        },

        get imageAsync() {
          if (!_rendering) {
            // Trigger a redraw if needed
            const { bounds, zoomFactor:zf } = camera;
            if (!_image || zf > _camera.zf*2 || !insideBounds(_bounds, bounds, _gutter/zf)) {
              return redraw();
            }
          }
          return _nextImage;
        },
      };
    })();

    landCache.gutter = CANVAS_GUTTER;

    landCache.images = [
      ImageAssets.shadow,
      ImageAssets.detail,
      img,
    ];

    const drawLand = ctx => {
      const image = landCache.image;
      if (!image) { return; }
      const { x, y, zf } = landCache.camera;
      const { width:w, height:h } = image;

      ctx.save();
      camera.transform(ctx);
      ctx.translate(x, y);
      camera.inFrame(landCache.camera).forEach(({x, y}) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1/zf, 1/zf);
        ctx.drawImage(image, -w/2, -h/2);
        ctx.restore();
      });
      ctx.restore();
    };

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

    const shipCanvas = new OffscreenCanvas(81, 77); // jshint ignore:line
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
      /* globals bgGradient, isMaidenVoyage */
      const dt = ts()/1000 - Clock;
      Clock += dt;

      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

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
      drawLand(ctx);

      ctx.save();
      camera.transform();

      const depthMap = [
        ...Object.keys(Entities).map(id => ([ (Entities[id].corrected ?? Entities[id]).y, id ])),
      ];

      depthMap.sort(([a], [b]) => a > b ? 1 : -1);

      // Draw entities
      depthMap.forEach(([y, itemId]) => {
        /* globals renderTerrainLayer */
        if (itemId.substr(0, 2) === 't:') {
          renderTerrainLayer(parseInt(itemId.substr(2), 10));
          return;
        }

        const item = Entities[itemId];

        if (item.dob && item.lifespan) {
          item.age = Date.now() - item.dob;
          if (item.age > item.lifespan) {
            delete Entities[itemId];
            return;
          }
        }

        const pos = item.corrected ?? item;
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
        [ window, 'resize', landCache.handleResize.bind(landCache) ],
      ],
      renderers: [
        { pre: followPlayer, replace: renderScene, post: renderMiniMap },
        { pre: navigator.smoothPlayerMotion.bind(navigator) },
      ],
      start() {
        landCache.handleResize();
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
        [ window, 'resize', landCache.handleResize.bind(landCache) ],
      ],
      renderers: [
        { replace: renderScene, post: renderMiniMap },
        { post: editor.render.bind(editor) },
        { pre: navigator.smoothPlayerMotion.bind(navigator) },
      ],
      start() {
        landCache.handleResize();
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
