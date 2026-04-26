"""
Tiny DQN for Snake. Designed to converge to a respectable policy in ~10-15 min
on a Mac Studio M3 Ultra (CPU is plenty — model has ~10k params).

Outputs:
    weights.json   — full agent (architecture + parameters) for browser inference
    history.json   — episode metrics for the live training-curve panel
"""

from __future__ import annotations

import json
import math
import os
import random
import time
from collections import deque
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from snake_env import SnakeEnv, OBS_DIM, N_ACTIONS, GRID

# Determinism (training run is reproducible).
SEED = 1337
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)


# --------------------------------------------------------------------- model
class QNet(nn.Module):
    def __init__(self, in_dim: int = OBS_DIM, hidden: int = 128, out_dim: int = N_ACTIONS) -> None:
        super().__init__()
        self.fc1 = nn.Linear(in_dim, hidden)
        self.fc2 = nn.Linear(hidden, hidden)
        self.fc3 = nn.Linear(hidden, out_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        return self.fc3(x)


# ------------------------------------------------------------------- buffer
@dataclass
class Transition:
    s: np.ndarray
    a: int
    r: float
    s2: np.ndarray
    d: bool


class Replay:
    def __init__(self, capacity: int = 100_000) -> None:
        self.buf: deque[Transition] = deque(maxlen=capacity)

    def push(self, t: Transition) -> None:
        self.buf.append(t)

    def sample(self, batch: int):
        ts = random.sample(self.buf, batch)
        s = torch.from_numpy(np.stack([t.s for t in ts])).float()
        a = torch.tensor([t.a for t in ts], dtype=torch.long)
        r = torch.tensor([t.r for t in ts], dtype=torch.float32)
        s2 = torch.from_numpy(np.stack([t.s2 for t in ts])).float()
        d = torch.tensor([t.d for t in ts], dtype=torch.float32)
        return s, a, r, s2, d

    def __len__(self) -> int:
        return len(self.buf)


# --------------------------------------------------------------------- main
def main() -> None:
    out_dir = os.path.dirname(os.path.abspath(__file__))
    public_dir = os.path.dirname(out_dir)  # projects/snake-rl/

    # Hyperparameters — tuned for fast wall-clock on Snake-11.
    EPISODES = 4000
    BATCH = 256
    GAMMA = 0.95
    LR = 1e-3
    EPS_START = 1.0
    EPS_END = 0.02
    EPS_DECAY_STEPS = 60_000
    TARGET_SYNC = 500          # gradient steps
    LEARN_STARTS = 2_000       # env steps before learning
    TRAIN_EVERY = 4            # env steps per gradient step
    MAX_STEPS_PER_EP = 2_000

    env = SnakeEnv(seed=SEED)
    qnet = QNet()
    target = QNet()
    target.load_state_dict(qnet.state_dict())
    optim = torch.optim.Adam(qnet.parameters(), lr=LR)
    buf = Replay()

    history = {
        "episode": [],
        "score": [],
        "reward": [],
        "length": [],
        "epsilon": [],
        "smoothed_score": [],
        "smoothed_reward": [],
    }
    best_smoothed = -1e9
    smooth_score = 0.0
    smooth_reward = 0.0
    step = 0
    grad_steps = 0
    t0 = time.time()

    print(f"[train] starting — episodes={EPISODES} grid={GRID}")

    for ep in range(1, EPISODES + 1):
        s = env.reset()
        ep_reward = 0.0
        ep_len = 0
        done = False
        while not done and ep_len < MAX_STEPS_PER_EP:
            eps = max(EPS_END, EPS_START - (EPS_START - EPS_END) * (step / EPS_DECAY_STEPS))
            if random.random() < eps:
                a = random.randrange(N_ACTIONS)
            else:
                with torch.no_grad():
                    q = qnet(torch.from_numpy(s).float().unsqueeze(0))
                    a = int(q.argmax(dim=1).item())

            res = env.step(a)
            buf.push(Transition(s, a, res.reward, res.obs, res.done))
            s = res.obs
            ep_reward += res.reward
            ep_len += 1
            step += 1
            done = res.done

            if len(buf) >= LEARN_STARTS and step % TRAIN_EVERY == 0:
                S, A, R, S2, D = buf.sample(BATCH)
                with torch.no_grad():
                    q_next = target(S2).max(dim=1).values
                    target_q = R + GAMMA * q_next * (1.0 - D)
                q_pred = qnet(S).gather(1, A.unsqueeze(1)).squeeze(1)
                loss = F.smooth_l1_loss(q_pred, target_q)
                optim.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(qnet.parameters(), 5.0)
                optim.step()
                grad_steps += 1
                if grad_steps % TARGET_SYNC == 0:
                    target.load_state_dict(qnet.state_dict())

        score = env.score
        smooth_score = 0.98 * smooth_score + 0.02 * score
        smooth_reward = 0.98 * smooth_reward + 0.02 * ep_reward
        history["episode"].append(ep)
        history["score"].append(score)
        history["reward"].append(round(ep_reward, 4))
        history["length"].append(ep_len)
        history["epsilon"].append(round(eps, 4))
        history["smoothed_score"].append(round(smooth_score, 4))
        history["smoothed_reward"].append(round(smooth_reward, 4))

        if smooth_score > best_smoothed:
            best_smoothed = smooth_score
            _export_weights(qnet, public_dir, meta={
                "episode": ep,
                "smoothed_score": round(smooth_score, 4),
                "epsilon": round(eps, 4),
                "grad_steps": grad_steps,
                "env_steps": step,
                "grid": GRID,
            })

        if ep % 50 == 0 or ep == 1:
            elapsed = time.time() - t0
            print(
                f"[train] ep={ep:4d} score={score:3d} "
                f"len={ep_len:4d} eps={eps:.3f} "
                f"smooth_score={smooth_score:.2f} elapsed={elapsed:.1f}s"
            )

        if ep % 25 == 0 or ep == EPISODES:
            with open(os.path.join(public_dir, "history.json"), "w") as f:
                json.dump(history, f)

    # final export — even if not best, so the latest is also persisted to a sibling file
    _export_weights(qnet, public_dir, meta={
        "episode": EPISODES,
        "smoothed_score": round(smooth_score, 4),
        "epsilon": round(EPS_END, 4),
        "grad_steps": grad_steps,
        "env_steps": step,
        "grid": GRID,
        "final": True,
    }, filename="weights_final.json")

    elapsed = time.time() - t0
    print(f"[train] done in {elapsed:.1f}s — best smoothed score {best_smoothed:.2f}")


def _export_weights(net: nn.Module, public_dir: str, meta: dict, filename: str = "weights.json") -> None:
    """Dump full architecture + params as plain JSON so the browser can do
    pure-JS inference without ONNX runtime."""
    layers = []
    state = net.state_dict()
    layers.append({
        "type": "linear", "activation": "relu",
        "W": state["fc1.weight"].cpu().tolist(),
        "b": state["fc1.bias"].cpu().tolist(),
    })
    layers.append({
        "type": "linear", "activation": "relu",
        "W": state["fc2.weight"].cpu().tolist(),
        "b": state["fc2.bias"].cpu().tolist(),
    })
    layers.append({
        "type": "linear", "activation": "linear",
        "W": state["fc3.weight"].cpu().tolist(),
        "b": state["fc3.bias"].cpu().tolist(),
    })
    payload = {
        "obs_dim": OBS_DIM,
        "n_actions": N_ACTIONS,
        "grid": GRID,
        "layers": layers,
        "meta": meta,
    }
    path = os.path.join(public_dir, filename)
    with open(path, "w") as f:
        json.dump(payload, f)


if __name__ == "__main__":
    main()
