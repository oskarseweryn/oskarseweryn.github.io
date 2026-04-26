/* Snake — pure JS engine + DQN inference.
 * The 11-feature observation must match snake_env.py exactly, otherwise the
 * exported network's argmax becomes meaningless. Keep these in lock-step. */

(() => {
  'use strict';

  // ------------------------------------------------------------- constants
  const GRID = 12;
  const DIRS = [
    { x: 0, y: -1 }, // 0 up
    { x: 1, y: 0 },  // 1 right
    { x: 0, y: 1 },  // 2 down
    { x: -1, y: 0 }, // 3 left
  ];
  const turnRight = (d) => (d + 1) % 4;
  const turnLeft  = (d) => (d + 3) % 4;

  const STORAGE_KEY = 'snake-rl::v1';

  // ------------------------------------------------------------- game core
  class Game {
    constructor(seed) {
      this.rng = mulberry32(seed >>> 0);
      this.reset();
    }

    reset() {
      const cx = (GRID / 2) | 0;
      const cy = (GRID / 2) | 0;
      this.snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
      this.dir = 1;
      this.alive = true;
      this.score = 0;
      this.steps = 0;
      this.stepsSinceFood = 0;
      this.lastEat = -10;
      this._spawnFood();
    }

    _spawnFood() {
      // Resample uniformly in free cells.
      const taken = new Set(this.snake.map((s) => s.x * GRID + s.y));
      const free = [];
      for (let x = 0; x < GRID; x++) {
        for (let y = 0; y < GRID; y++) {
          const k = x * GRID + y;
          if (!taken.has(k)) free.push({ x, y });
        }
      }
      if (!free.length) {
        this.food = { x: -1, y: -1 };
        return;
      }
      const i = Math.floor(this.rng() * free.length);
      this.food = free[i];
    }

    /** action: 0=straight, 1=right, 2=left (relative to current heading) */
    step(action) {
      if (!this.alive) return { reward: 0, done: true, ate: false };
      if (action === 1) this.dir = turnRight(this.dir);
      else if (action === 2) this.dir = turnLeft(this.dir);

      const d = DIRS[this.dir];
      const head = this.snake[0];
      const nh = { x: head.x + d.x, y: head.y + d.y };

      this.steps++;
      this.stepsSinceFood++;

      // wall
      if (nh.x < 0 || nh.x >= GRID || nh.y < 0 || nh.y >= GRID) {
        this.alive = false;
        return { reward: -1, done: true, ate: false, reason: 'wall' };
      }
      // self (excluding the tail tip which is about to move out)
      const body = this.snake;
      for (let i = 0; i < body.length - 1; i++) {
        if (body[i].x === nh.x && body[i].y === nh.y) {
          this.alive = false;
          return { reward: -1, done: true, ate: false, reason: 'self' };
        }
      }

      this.snake.unshift(nh);
      const ate = nh.x === this.food.x && nh.y === this.food.y;
      if (ate) {
        this.score++;
        this.stepsSinceFood = 0;
        this.lastEat = this.steps;
        this._spawnFood();
        return { reward: 1, done: false, ate: true };
      }
      this.snake.pop();
      // safety: stall guard mirroring training env
      if (this.stepsSinceFood > 100 * this.snake.length) {
        this.alive = false;
        return { reward: -1, done: true, ate: false, reason: 'stall' };
      }
      return { reward: -0.001, done: false, ate: false };
    }

    /** 11-feature observation, byte-for-byte compatible with snake_env.py. */
    obs() {
      const head = this.snake[0];
      const d = this.dir;
      const f = DIRS[d];
      const r = DIRS[turnRight(d)];
      const l = DIRS[turnLeft(d)];

      const collide = (delta) => {
        const x = head.x + delta.x;
        const y = head.y + delta.y;
        if (x < 0 || x >= GRID || y < 0 || y >= GRID) return 1;
        const body = this.snake;
        for (let i = 0; i < body.length - 1; i++) {
          if (body[i].x === x && body[i].y === y) return 1;
        }
        return 0;
      };

      const fx = this.food.x, fy = this.food.y;
      const hx = head.x, hy = head.y;

      return [
        collide(f),
        collide(r),
        collide(l),
        d === 0 ? 1 : 0,
        d === 1 ? 1 : 0,
        d === 2 ? 1 : 0,
        d === 3 ? 1 : 0,
        fx < hx ? 1 : 0,
        fx > hx ? 1 : 0,
        fy < hy ? 1 : 0,
        fy > hy ? 1 : 0,
      ];
    }
  }

  // ------------------------------------------------------------- inference
  class Policy {
    constructor(net) {
      // net.layers: [{type:'linear', activation, W:[out][in], b:[out]}, ...]
      this.layers = net.layers;
      this.nIn = net.obs_dim;
      this.nOut = net.n_actions;
    }
    forward(x) {
      let h = x;
      for (const layer of this.layers) {
        const W = layer.W, b = layer.b;
        const out = new Float32Array(W.length);
        for (let i = 0; i < W.length; i++) {
          let s = b[i];
          const Wi = W[i];
          for (let j = 0; j < Wi.length; j++) s += Wi[j] * h[j];
          out[i] = layer.activation === 'relu' ? (s > 0 ? s : 0) : s;
        }
        h = out;
      }
      return h;
    }
    act(obs) {
      const q = this.forward(obs);
      let best = 0, bv = q[0];
      for (let i = 1; i < q.length; i++) {
        if (q[i] > bv) { bv = q[i]; best = i; }
      }
      return { action: best, q: Array.from(q) };
    }
  }

  // ------------------------------------------------------------- renderer
  function makeRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    const COLORS = {
      bg:        '#0a0c11',
      gridLine:  'rgba(255,255,255,0.025)',
      bodyHuman: '#74f0c0',
      headHuman: '#aaffd9',
      bodyAgent: '#8fb9ff',
      headAgent: '#bcd4ff',
      food:      '#ff6f91',
      label:     '#9aa3b2',
    };

    function clear() {
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function drawBoard(game, box, label, color) {
      const { x: x0, y: y0, w, h } = box;
      // Leave 6px on each side for the framed border so it never clips.
      const cell = Math.floor(Math.min(w - 12, h - 12) / GRID);
      const bw = cell * GRID;
      const bh = cell * GRID;
      const ox = x0 + ((w - bw) >> 1);
      const oy = y0 + ((h - bh) >> 1);

      const accent = color === 'agent' ? COLORS.bodyAgent : COLORS.bodyHuman;
      const fx0 = ox - 6, fy0 = oy - 6, fw = bw + 12, fh = bh + 12;

      // frame: darker fill + 1px tinted outline matching the player colour
      ctx.fillStyle = '#0d1018';
      ctx.fillRect(fx0, fy0, fw, fh);
      ctx.strokeStyle = color === 'agent'
        ? 'rgba(143, 185, 255, 0.45)'
        : 'rgba(116, 240, 192, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fx0 + 0.5, fy0 + 0.5, fw - 1, fh - 1);

      // grid lines (subtle)
      ctx.strokeStyle = COLORS.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= GRID; i++) {
        ctx.moveTo(ox + i * cell + 0.5, oy);
        ctx.lineTo(ox + i * cell + 0.5, oy + bh);
        ctx.moveTo(ox, oy + i * cell + 0.5);
        ctx.lineTo(ox + bw, oy + i * cell + 0.5);
      }
      ctx.stroke();

      // food
      if (game.food.x >= 0) {
        const ffx = ox + game.food.x * cell;
        const ffy = oy + game.food.y * cell;
        ctx.fillStyle = COLORS.food;
        ctx.beginPath();
        ctx.arc(ffx + cell / 2, ffy + cell / 2, cell * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }

      // body
      const bodyCol = color === 'agent' ? COLORS.bodyAgent : COLORS.bodyHuman;
      const headCol = color === 'agent' ? COLORS.headAgent : COLORS.headHuman;
      for (let i = game.snake.length - 1; i >= 0; i--) {
        const s = game.snake[i];
        const px = ox + s.x * cell;
        const py = oy + s.y * cell;
        ctx.fillStyle = i === 0 ? headCol : bodyCol;
        const pad = i === 0 ? 1 : 2;
        roundRect(ctx, px + pad, py + pad, cell - pad * 2, cell - pad * 2, 3);
        ctx.fill();
      }

      // label — bold, color-coded, sits above its frame
      if (label) {
        ctx.font = '700 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const ly = fy0 - 6;
        const labelW = ctx.measureText(label).width;
        ctx.fillStyle = accent;
        ctx.fillText(label, fx0, ly);
        if (typeof game.score === 'number') {
          ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          ctx.fillStyle = COLORS.label;
          ctx.fillText(`· ${game.score}`, fx0 + labelW + 8, ly);
        }
      }

      // game-over haze
      if (!game.alive) {
        ctx.fillStyle = 'rgba(8,10,15,0.55)';
        ctx.fillRect(fx0, fy0, fw, fh);
      }
    }

    function drawDivider(cx, y0, h) {
      // Faint dashed vertical line plus a "VS" pill at the midpoint.
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, y0 + 12);
      ctx.lineTo(cx + 0.5, y0 + h - 12);
      ctx.stroke();
      ctx.setLineDash([]);

      const pillW = 28, pillH = 18;
      const pillX = cx - (pillW >> 1);
      const pillY = y0 + ((h - pillH) >> 1);
      ctx.fillStyle = '#11141b';
      roundRect(ctx, pillX, pillY, pillW, pillH, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      roundRect(ctx, pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1, 9);
      ctx.stroke();
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VS', cx, pillY + (pillH >> 1) + 1);
      ctx.restore();
    }

    return { clear, drawBoard, drawDivider };
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 || h < 2) { ctx.fillRect(x, y, w, h); return; }
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  // ------------------------------------------------------------- helpers
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function loadBests() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { human: 0, agent: 0 };
      const o = JSON.parse(raw);
      return { human: o.human | 0, agent: o.agent | 0 };
    } catch { return { human: 0, agent: 0 }; }
  }
  function saveBests(b) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch {}
  }

  /** Map an absolute heading + arrow direction to a relative action.
   *  The agent and engine speak relative actions (straight/right/left). */
  function arrowToRelative(currentDir, requestedDir) {
    if (requestedDir === currentDir) return 0;
    if (requestedDir === turnRight(currentDir)) return 1;
    if (requestedDir === turnLeft(currentDir)) return 2;
    return -1; // 180° flip is illegal — ignore
  }

  // ------------------------------------------------------------- app state
  const $ = (sel) => document.querySelector(sel);

  const state = {
    mode: 'agent',          // 'human' | 'agent' | 'versus' — start with the agent so visitors see it first
    paused: false,
    armed: true,            // in human/versus this flips to false until first arrow press
    gameH: null,            // human game (used in human + versus)
    gameA: null,            // agent game (used in agent + versus)
    pendingDir: null,       // queued absolute heading from keyboard
    bests: loadBests(),
    fps: 11,
    accum: 0,
    last: 0,
    rafId: 0,
    policy: null,
    weightsMeta: null,
    historyDrawn: false,
  };

  // ------------------------------------------------------------- bootstrap
  async function boot() {
    const canvas = $('#board');
    const renderer = makeRenderer(canvas);

    state.gameH = new Game(Date.now() & 0xffffffff);
    state.gameA = new Game((Date.now() ^ 0xa5a5a5a5) >>> 0);

    $('#best-human').textContent = state.bests.human;
    $('#best-agent').textContent = state.bests.agent;
    $('#speed').addEventListener('input', (e) => {
      state.fps = +e.target.value;
      $('#speed-val').textContent = `${state.fps} fps`;
    });
    $('#speed-val').textContent = `${state.fps} fps`;

    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    $('#btn-restart').addEventListener('click', restart);
    $('#btn-pause').addEventListener('click', togglePause);
    $('#overlay-restart').addEventListener('click', restart);

    window.addEventListener('keydown', onKey);

    // Sync the live state.mode with whatever the markup defaults to, then
    // re-apply it so the UI side-effects (overlay, hint copy, button state)
    // run exactly once during boot.
    const initialMode = state.mode;
    state.mode = '__none__';
    setMode(initialMode);

    // Load policy. We try the latest-best file first; fall back to the
    // final-snapshot file if that's all that's been written so far.
    state.policy = await loadPolicy();
    updateAgentStatus();
    loadHistory();

    state.last = performance.now();
    state.rafId = requestAnimationFrame(tick);
    render(renderer);
  }

  async function loadPolicy() {
    const candidates = ['weights.json', 'weights_final.json'];
    for (const path of candidates) {
      try {
        const r = await fetch(path, { cache: 'no-store' });
        if (!r.ok) continue;
        const net = await r.json();
        if (!net.layers) continue;
        state.weightsMeta = net.meta || {};
        return new Policy(net);
      } catch { /* keep trying */ }
    }
    return null;
  }

  function updateAgentStatus() {
    const el = $('#agent-status');
    if (!el) return;
    if (!state.policy) {
      el.textContent = 'still training';
      el.className = 'status status-progress';
      // try again in 5s — useful when training is producing weights live
      setTimeout(async () => {
        const p = await loadPolicy();
        if (p) { state.policy = p; updateAgentStatus(); loadHistory(); }
      }, 5000);
      return;
    }
    const m = state.weightsMeta || {};
    el.textContent = m.smoothed_score !== undefined
      ? `≈ ${(+m.smoothed_score).toFixed(1)} avg`
      : 'ready';
    el.className = 'status status-live';
  }

  // ------------------------------------------------------------- input
  function onKey(e) {
    const k = e.key.toLowerCase();
    if (k === ' ') {
      e.preventDefault();
      if (!state.gameH.alive && (state.mode === 'human' || state.mode === 'versus')) {
        restart();
      } else {
        togglePause();
      }
      return;
    }
    if (state.mode === 'agent') return;

    let want = -1;
    if (k === 'arrowup' || k === 'w')    want = 0;
    if (k === 'arrowright' || k === 'd') want = 1;
    if (k === 'arrowdown' || k === 's')  want = 2;
    if (k === 'arrowleft' || k === 'a')  want = 3;
    if (want === -1) return;
    e.preventDefault();
    state.pendingDir = want;
    // First arrow press un-pauses the world in human/versus mode.
    if (!state.armed) {
      state.armed = true;
      $('#game-overlay').hidden = true;
    }
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    state.gameH.reset();
    state.gameA.reset();
    state.pendingDir = null;
    state.paused = false;
    $('#btn-pause').textContent = 'Pause';
    updateScores();
    const hint = $('#snake-hint');
    if (hint) {
      if (mode === 'agent') {
        hint.innerHTML = 'Agent in control. Use the speed slider, or hit <kbd>Space</kbd> to pause.';
      } else if (mode === 'versus') {
        hint.innerHTML = 'You (left) vs agent (right). Arrow keys or <kbd>WASD</kbd>. Press any arrow to start.';
      } else {
        hint.innerHTML = 'Arrow keys or <kbd>WASD</kbd>. <kbd>Space</kbd> to pause / restart on game over.';
      }
    }
    armOrPrompt();
  }

  function restart() {
    state.gameH.reset();
    state.gameA.reset();
    state.pendingDir = null;
    state.paused = false;
    $('#btn-pause').textContent = 'Pause';
    updateScores();
    armOrPrompt();
  }

  /** In human/versus mode, freeze the world and show a "press an arrow" prompt;
   *  in agent mode, run immediately and clear any leftover overlay. */
  function armOrPrompt() {
    const overlay = $('#game-overlay');
    if (state.mode === 'agent') {
      state.armed = true;
      overlay.hidden = true;
      return;
    }
    state.armed = false;
    $('#overlay-title').textContent = state.mode === 'versus'
      ? 'Ready to race the agent?'
      : 'Ready when you are.';
    $('#overlay-body').innerHTML =
      'Press an <kbd>arrow key</kbd> or <kbd>WASD</kbd> to start.';
    overlay.hidden = false;
  }

  function togglePause() {
    state.paused = !state.paused;
    $('#btn-pause').textContent = state.paused ? 'Resume' : 'Pause';
  }

  // ------------------------------------------------------------- loop
  function tick(t) {
    const dt = (t - state.last) / 1000;
    state.last = t;
    if (!state.paused && state.armed) {
      state.accum += dt;
      const stepDur = 1 / state.fps;
      while (state.accum > stepDur) {
        state.accum -= stepDur;
        advance();
      }
    } else {
      // Avoid a sudden burst of catch-up steps after the player un-pauses.
      state.accum = 0;
    }
    const canvas = $('#board');
    if (canvas) {
      const renderer = makeRenderer(canvas);
      render(renderer);
    }
    state.rafId = requestAnimationFrame(tick);
  }

  function advance() {
    const showHuman = state.mode === 'human' || state.mode === 'versus';
    const showAgent = state.mode === 'agent' || state.mode === 'versus';

    if (showHuman && state.gameH.alive) {
      let action = 0;
      if (state.pendingDir !== null) {
        const a = arrowToRelative(state.gameH.dir, state.pendingDir);
        if (a >= 0) action = a;
        // 180° flip ignored (action stays 0 = straight)
        state.pendingDir = null;
      }
      const r = state.gameH.step(action);
      if (r.done) onGameOver('human');
    }

    if (showAgent && state.gameA.alive) {
      let action = 0;
      if (state.policy) {
        action = state.policy.act(state.gameA.obs()).action;
      } else {
        action = pickHeuristicAction(state.gameA);
      }
      const r = state.gameA.step(action);
      if (r.done) onGameOver('agent');
    }

    updateScores();
  }

  /** Used as a fallback while the trained weights are loading. */
  function pickHeuristicAction(g) {
    // Pick the safest of (straight, right, left) prioritising food direction.
    const obs = g.obs();
    const safeF = obs[0] === 0;
    const safeR = obs[1] === 0;
    const safeL = obs[2] === 0;
    // food-relative
    const foodLeft = obs[7], foodRight = obs[8], foodUp = obs[9], foodDown = obs[10];
    const d = g.dir;
    // wantsRight if food is in the direction obtained by turning right from current
    const wantsR = (
      (d === 0 && foodRight) || (d === 1 && foodDown) ||
      (d === 2 && foodLeft) || (d === 3 && foodUp)
    );
    const wantsL = (
      (d === 0 && foodLeft) || (d === 1 && foodUp) ||
      (d === 2 && foodRight) || (d === 3 && foodDown)
    );
    if (safeF && !wantsR && !wantsL) return 0;
    if (wantsR && safeR) return 1;
    if (wantsL && safeL) return 2;
    if (safeF) return 0;
    if (safeR) return 1;
    if (safeL) return 2;
    return 0;
  }

  function onGameOver(who) {
    const overlay = $('#game-overlay');
    if (state.mode === 'versus') {
      const hDead = !state.gameH.alive;
      const aDead = !state.gameA.alive;
      if (hDead && aDead) {
        const hs = state.gameH.score, as = state.gameA.score;
        const title = hs > as ? 'You win this round.' : as > hs ? 'Agent wins.' : 'Tie.';
        $('#overlay-title').textContent = title;
        $('#overlay-body').innerHTML =
          `You ${hs} &nbsp;·&nbsp; Agent ${as}. Press <kbd>Space</kbd> or tap restart.`;
        overlay.hidden = false;
        commitBests();
      }
    } else if (state.mode === 'human') {
      $('#overlay-title').textContent = 'Game over';
      $('#overlay-body').innerHTML = `You scored ${state.gameH.score}. <kbd>Space</kbd> to restart.`;
      overlay.hidden = false;
      commitBests();
    } else {
      // agent-only — auto restart on a tiny delay so it loops nicely
      setTimeout(() => {
        if (state.mode === 'agent') {
          commitBests();
          state.gameA.reset();
          updateScores();
        }
      }, 600);
    }
  }

  function commitBests() {
    let changed = false;
    if (state.gameH.score > state.bests.human) {
      state.bests.human = state.gameH.score; changed = true;
    }
    if (state.gameA.score > state.bests.agent) {
      state.bests.agent = state.gameA.score; changed = true;
    }
    if (changed) {
      saveBests(state.bests);
      $('#best-human').textContent = state.bests.human;
      $('#best-agent').textContent = state.bests.agent;
    }
  }

  function updateScores() {
    $('#score-human').textContent = state.gameH.score;
    $('#score-agent').textContent = state.gameA.score;
  }

  // ------------------------------------------------------------- render
  function render(renderer) {
    renderer.clear();
    const W = 540, H = 540;
    if (state.mode === 'human') {
      renderer.drawBoard(state.gameH, { x: 0, y: 28, w: W, h: H - 28 }, 'YOU', 'human');
    } else if (state.mode === 'agent') {
      renderer.drawBoard(state.gameA, { x: 0, y: 28, w: W, h: H - 28 }, 'AGENT', 'agent');
    } else {
      // Reserve a clear gap so the two boards never visually fuse together.
      const gap = 36;
      const half = ((W - gap) / 2) | 0;
      renderer.drawBoard(state.gameH, { x: 0,            y: 28, w: half, h: H - 28 }, 'YOU',   'human');
      renderer.drawBoard(state.gameA, { x: half + gap,   y: 28, w: half, h: H - 28 }, 'AGENT', 'agent');
      renderer.drawDivider(half + (gap >> 1), 28, H - 28);
    }
  }

  // ------------------------------------------------------------- curves
  async function loadHistory() {
    try {
      const r = await fetch('history.json', { cache: 'no-store' });
      if (!r.ok) return;
      const h = await r.json();
      drawCurves(h);
      state.historyDrawn = true;
    } catch {}
  }

  function drawCurves(h) {
    drawCurve($('#curve-score'), h.episode, h.score, h.smoothed_score, '#74f0c0', 'score');
    drawCurve($('#curve-reward'), h.episode, h.reward, h.smoothed_reward, '#8fb9ff', 'reward');
    const last = h.episode.length;
    if (last > 0) {
      $('#curve-score-meta').textContent =
        `${last} eps · best avg ${Math.max(...h.smoothed_score).toFixed(2)}`;
      $('#curve-reward-meta').textContent =
        `${last} eps · best avg ${Math.max(...h.smoothed_reward).toFixed(2)}`;
    }
  }

  function drawCurve(canvas, xs, raw, smoothed, accent, label) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!xs || xs.length === 0) return;

    const padL = 36, padR = 14, padT = 14, padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const xMin = xs[0], xMax = xs[xs.length - 1];
    const yMin = Math.min(...raw, ...smoothed);
    const yMax = Math.max(...raw, ...smoothed);
    const yPad = (yMax - yMin) * 0.08 || 1;
    const lo = yMin - yPad, hi = yMax + yPad;

    const sx = (x) => padL + ((x - xMin) / Math.max(1, xMax - xMin)) * innerW;
    const sy = (y) => padT + (1 - (y - lo) / Math.max(1e-9, hi - lo)) * innerH;

    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const yy = padT + (innerH * i) / 4;
      ctx.moveTo(padL, yy + 0.5);
      ctx.lineTo(W - padR, yy + 0.5);
    }
    ctx.stroke();

    ctx.fillStyle = '#6b7488';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * (1 - i / 4);
      const yy = padT + (innerH * i) / 4;
      ctx.fillText(v.toFixed(1), padL - 6, yy);
    }

    // raw — translucent
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i < xs.length; i++) {
      const X = sx(xs[i]), Y = sy(raw[i]);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.stroke();

    // smoothed — accent
    ctx.beginPath();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    for (let i = 0; i < xs.length; i++) {
      const X = sx(xs[i]), Y = sy(smoothed[i]);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.stroke();

    // x label
    ctx.fillStyle = '#6b7488';
    ctx.textAlign = 'left';
    ctx.fillText(`ep 1`, padL, H - 8);
    ctx.textAlign = 'right';
    ctx.fillText(`ep ${xMax}`, W - padR, H - 8);
  }

  // boot once DOM is ready (defer attribute already ensures parsed DOM)
  boot();
})();
