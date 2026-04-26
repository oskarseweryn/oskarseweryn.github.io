# snake-rl — Beat my agent

A tiny reinforcement-learning project, end-to-end:

1. Custom Snake environment in pure Python.
2. DQN agent (small MLP, ~18k params) trained from scratch.
3. Weights exported as a single JSON blob.
4. Pure-JS inference + canvas game in the browser — no ONNX runtime, no
   TensorFlow.js, no server. Whole page is static, hosted on GitHub Pages.

**Live demo:** [/projects/snake-rl/](https://oskarseweryn.github.io/projects/snake-rl/)

## Why this exists

This is a small but complete demonstration of the AI-first ML loop I run on
my desk: write the env, train the agent on the M3 Ultra, ship a reproducible
artifact that anyone can run in a browser. No cherry-picked numbers — every
score the agent posts on the page comes from the same weights file you can
download and re-evaluate yourself.

## Results (greedy policy, 50 episodes, fresh seeds)

```
mean   24.14
median 25
max    37
min    6
```

Smoothed score during training peaked around episode 3,400 at **18.1**, wall
clock **~3 minutes** on a Mac Studio M3 Ultra (CPU only — the model is too
small for the GPU to win).

## What's in this folder

```
snake-rl/
├── index.html          # the live demo page
├── snake.css           # page-specific styles
├── game.js             # JS engine + DQN inference + canvas renderer
├── weights.json        # best-by-smoothed-score checkpoint  (loaded by the page)
├── weights_final.json  # final-episode checkpoint
├── history.json        # per-episode score / reward / epsilon (drives the curves)
└── training/
    ├── snake_env.py    # 12×12 Snake env with the 11-feature observation
    └── train.py        # DQN training loop + JSON exporter
```

## State representation

Same 11 features in Python (training) and JS (inference):

| idx | meaning                                    |
|-----|--------------------------------------------|
| 0–2 | collision flags: front / right / left      |
| 3–6 | direction one-hot: up / right / down / left |
| 7–10 | food relative: left / right / up / down   |

Three actions, all relative to current heading: `straight`, `turn right`,
`turn left`.

## Reproducing

```bash
cd training
python3 train.py
# writes ../weights.json, ../weights_final.json, ../history.json
```

`train.py` is deterministic (`SEED=1337`). On an M3 Ultra it finishes in
~3 minutes. After it runs, refresh the page in your browser to pick up the
new weights and curves.

## Why JSON instead of ONNX

For a 3-layer MLP this size, the *entire* model is ~400 KB of plain JSON.
A JS forward pass takes microseconds, the page stays fully static, and the
weight file is human-readable — you can `cat` it and see the matrices. Once
the architecture grows past a couple of layers, swap it out for ONNX-Web or
WebGPU; for now the simple thing wins.

## Caveats / honest notes

- The agent isn't optimal. Snake at this grid size is solvable to a long-tail
  perfect score with longer training, MCTS, or a different observation space.
  18-25 average is solid for a small MLP and an evening's wall clock — and
  it's enough to put up a fair fight against a human.
- The 11-feature observation is local. The agent has no memory and doesn't
  see the full board, so it occasionally traps itself when the body
  surrounds the head — exactly the sort of failure you'd expect.
- No hyperparameter sweep. The numbers in `train.py` are first-shot defaults
  that worked; there's headroom.
