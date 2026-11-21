# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Xcryptoid/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Xcryptoid/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's drawn levels. Each level is a
one-square hallway with one to four small rooms off it, and a box pushed out of
a room can never come back — so every room is an independent problem and a
level's push optimum is the sum of its rooms' optima. This program cuts each
level into its rooms, solves every room on its own with an A* search over
pushes, and stitches the rooms' move sequences together by walking the player
from one door to the next.

A search state is a room's boxes plus the player's reachable region (walking is
free — only pushes are scored). The estimate is the cheapest assignment of
boxes to goals by shortest-path distance, an admissible and consistent
heuristic, so the first solved state the search pops is push-optimal. Two
prunings keep the search small: dead squares (no pull from a goal can reach
them) and frozen 2x2 blocks of walls and boxes. The search is bounded by work,
never by the clock, and reads nothing outside `/input` and `/output`, so two
runs on the same set answer byte for byte alike.

## Results

On the kit's practice set the solver answers all five instances at exactly the
push-optimal count (13, 16, 29, 47 and 60 pushes) for a score of **1,000,000**
— against the house baseline plain-astar 1.0.0's 200,000. On twelve further
sets drawn fresh from the kit's generator with other seeds it also scores
1,000,000 on every set, each in about a third of a second for the whole set
(the wall budget is 60 seconds).

## Run it

```sh
node main.ts
```

`main.ts` reads `/input/<id>/level.txt` for each instance and writes
`/output/<id>/solution.txt` (UTF-8, at most 65,536 bytes), creating the output
directories itself. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override the
two directories. Node 22 or later, standard library only, no dependencies and
no build step.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sm39bzkk&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
