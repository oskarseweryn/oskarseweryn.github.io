"""
Minimal Snake environment with an 11-feature relative observation.
Same feature ordering must be reproduced in JS for browser inference.

Grid: GRID x GRID cells, walls at the border.
Actions (relative to current heading):
    0 = go straight
    1 = turn right (clockwise)
    2 = turn left  (counter-clockwise)
Reward shaping:
    +1.0 on eating food
    -1.0 on death (wall or self)
    -0.001 per step (mild time pressure, prevents looping)
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np

GRID = 12

# Heading vectors: 0=up, 1=right, 2=down, 3=left
DIRS: List[Tuple[int, int]] = [(0, -1), (1, 0), (0, 1), (-1, 0)]


def _turn_right(d: int) -> int:
    return (d + 1) % 4


def _turn_left(d: int) -> int:
    return (d + 3) % 4


@dataclass
class StepResult:
    obs: np.ndarray
    reward: float
    done: bool
    info: dict


class SnakeEnv:
    def __init__(self, grid: int = GRID, seed: int | None = None) -> None:
        self.grid = grid
        self.rng = random.Random(seed)
        self.reset()

    # ------------------------------------------------------------------ core
    def reset(self) -> np.ndarray:
        cx, cy = self.grid // 2, self.grid // 2
        self.snake: List[Tuple[int, int]] = [(cx, cy), (cx - 1, cy), (cx - 2, cy)]
        self.direction = 1  # facing right
        self._spawn_food()
        self.steps = 0
        self.steps_since_food = 0
        self.score = 0
        return self._obs()

    def step(self, action: int) -> StepResult:
        if action == 1:
            self.direction = _turn_right(self.direction)
        elif action == 2:
            self.direction = _turn_left(self.direction)
        # action 0 = no turn

        dx, dy = DIRS[self.direction]
        head = self.snake[0]
        new_head = (head[0] + dx, head[1] + dy)

        self.steps += 1
        self.steps_since_food += 1

        # death by wall
        if not (0 <= new_head[0] < self.grid and 0 <= new_head[1] < self.grid):
            return StepResult(self._obs(), -1.0, True, {"reason": "wall", "score": self.score})
        # death by self (except tail tip, which moves out)
        if new_head in self.snake[:-1]:
            return StepResult(self._obs(), -1.0, True, {"reason": "self", "score": self.score})

        self.snake.insert(0, new_head)
        ate = new_head == self.food
        if ate:
            self.score += 1
            self.steps_since_food = 0
            self._spawn_food()
            reward = 1.0
        else:
            self.snake.pop()
            reward = -0.001

        # safety: kill obvious infinite loops (no food for a long time)
        if self.steps_since_food > 100 * (len(self.snake)):
            return StepResult(self._obs(), -1.0, True, {"reason": "stall", "score": self.score})

        return StepResult(self._obs(), reward, False, {"reason": "step", "score": self.score})

    # ------------------------------------------------------------------ obs
    def _obs(self) -> np.ndarray:
        head = self.snake[0]
        d = self.direction
        # neighbour cells in absolute terms
        front = DIRS[d]
        right = DIRS[_turn_right(d)]
        left = DIRS[_turn_left(d)]

        def collide(delta: Tuple[int, int]) -> float:
            x, y = head[0] + delta[0], head[1] + delta[1]
            if not (0 <= x < self.grid and 0 <= y < self.grid):
                return 1.0
            # body, except the tail which will move out next step
            if (x, y) in self.snake[:-1]:
                return 1.0
            return 0.0

        fx, fy = self.food
        hx, hy = head
        food_left = float(fx < hx)
        food_right = float(fx > hx)
        food_up = float(fy < hy)
        food_down = float(fy > hy)

        # Direction one-hot
        dir_up = float(d == 0)
        dir_right = float(d == 1)
        dir_down = float(d == 2)
        dir_left = float(d == 3)

        return np.array([
            collide(front),
            collide(right),
            collide(left),
            dir_up,
            dir_right,
            dir_down,
            dir_left,
            food_left,
            food_right,
            food_up,
            food_down,
        ], dtype=np.float32)

    # ------------------------------------------------------------------ misc
    def _spawn_food(self) -> None:
        free = [
            (x, y)
            for x in range(self.grid)
            for y in range(self.grid)
            if (x, y) not in self.snake
        ]
        if not free:
            self.food = (-1, -1)  # win condition, board full
        else:
            self.food = self.rng.choice(free)

    def render_ascii(self) -> str:
        rows = []
        for y in range(self.grid):
            row = []
            for x in range(self.grid):
                if (x, y) == self.snake[0]:
                    row.append("@")
                elif (x, y) in self.snake:
                    row.append("o")
                elif (x, y) == self.food:
                    row.append("*")
                else:
                    row.append(".")
            rows.append("".join(row))
        return "\n".join(rows)


OBS_DIM = 11
N_ACTIONS = 3
