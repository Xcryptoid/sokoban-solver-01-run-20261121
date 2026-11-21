// Sokoban solver: push-optimal A* per room.
//
// Each level is a hallway with one to four small rooms off it, and a box pushed
// out of a room can never come back, so every room is an independent problem and
// a level's push optimum is the sum of its rooms' optima. This program solves
// each room on its own with an A* search over pushes, then stitches the rooms'
// move sequences together by walking the player from one door to the next.
//
// A search state is the rooms' boxes (sorted) plus the player's reachable region
// (named by its lowest square): walking is free, only pushes are scored, so the
// player square inside its region does not matter. A push costs 1; the estimate
// is the cheapest assignment of boxes to goals by shortest-path distance (an
// admissible, consistent estimate, so the first solved state the search pops is
// push-optimal). Two prunings keep the search small: a square is dead when no
// pull from a goal can reach it, and a 2x2 block of walls and boxes holding a box
// off its goal is frozen. A room the heuristic search ever gives up on is
// retried with a plain breadth-first push search, the search the generator
// itself keeps rooms by, so an unseen room still gets its optimum. The search
// is bounded by work (a fixed expansion cap),
// never by the clock, and nothing here reads the time, the environment or any
// file outside /input and /output, so two runs on the same set answer alike.
//
// Run: node main.ts  (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override /input /output)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search expands before it gives up: work, never the clock. */
const MAX_EXPANSIONS = 400_000;
/** The most states the breadth-first retry expands: the generator keeps a room only when its own breadth-first search solves it within this many. */
const BFS_EXPANSIONS = 250_000;

type Dir = { dx: number; dy: number; step: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // Nothing leaves the board: the outermost frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box can stand on and still be pulled back onto some goal, found by pulling from the goals. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step;
      if (!wall[y] && !wall[y - step] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room, its squares, boxes and goals. Null when the level is no set of
 * rooms (a box in the hallway, a goal cut away, or a part with boxes != goals).
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i] as number;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const r = rooms[part[b] as number];
    if (r) r.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    const r = rooms[part[g] as number];
    if (r) r.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** All orderings of n goal indexes, for the cheapest box-to-goal assignment. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const walk = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      walk();
      cur.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}

/** A binary heap on (f, then deeper g, then earlier entry): the search's open list. In breadth-first mode it orders by (g, then earlier entry) instead, which makes the same search a plain push BFS. */
class Heap {
  private readonly bfs: boolean;
  private f: number[] = [];
  private g: number[] = [];
  private seq: number[] = [];
  private idx: number[] = [];
  private n = 0;

  constructor(bfs = false) {
    this.bfs = bfs;
  }

  get size(): number {
    return this.n;
  }

  private less(a: number, b: number): boolean {
    if (this.bfs) {
      if (this.g[a] !== this.g[b]) return (this.g[a] as number) < (this.g[b] as number);
      return (this.seq[a] as number) < (this.seq[b] as number);
    }
    if (this.f[a] !== this.f[b]) return (this.f[a] as number) < (this.f[b] as number);
    if (this.g[a] !== this.g[b]) return (this.g[a] as number) > (this.g[b] as number);
    return (this.seq[a] as number) < (this.seq[b] as number);
  }

  push(f: number, g: number, seq: number, idx: number): void {
    let i = this.n++;
    this.f[i] = f;
    this.g[i] = g;
    this.seq[i] = seq;
    this.idx[i] = idx;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): { f: number; g: number; idx: number } {
    const top = { f: this.f[0] as number, g: this.g[0] as number, idx: this.idx[0] as number };
    this.n--;
    if (this.n > 0) {
      this.f[0] = this.f[this.n] as number;
      this.g[0] = this.g[this.n] as number;
      this.seq[0] = this.seq[this.n] as number;
      this.idx[0] = this.idx[this.n] as number;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= this.n) break;
        if (c + 1 < this.n && this.less(c + 1, c)) c++;
        if (!this.less(c, i)) break;
        this.swap(i, c);
        i = c;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const tf = this.f[a] as number;
    this.f[a] = this.f[b] as number;
    this.f[b] = tf;
    const tg = this.g[a] as number;
    this.g[a] = this.g[b] as number;
    this.g[b] = tg;
    const ts = this.seq[a] as number;
    this.seq[a] = this.seq[b] as number;
    this.seq[b] = ts;
    const ti = this.idx[a] as number;
    this.idx[a] = this.idx[b] as number;
    this.idx[b] = ti;
  }
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of `level` (or null when the search gives up): A*
 * over pushes, or, with `useHeuristic` off, a plain breadth-first push search
 * (the same code with a zero estimate and a breadth-first open list). `wall` is
 * the level's walls with any extra squares blocked, and `keyMode` picks a
 * numeric state key (small rooms) or a string one (a whole level, where too many
 * boxes overflow a number).
 */
function searchPushOptimal(level: Level, wall: Uint8Array, maxExpansions: number, numericKey: boolean, useHeuristic = true): SearchResult | null {
  const { w, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares({ ...level, wall });
  if (level.boxes.some((b) => !live[b])) return null;

  // Shortest walking distance from every square to each goal, over the floor alone (the heuristic needs it; the breadth-first retry does not).
  const distToGoal: Int32Array[] = [];
  if (useHeuristic) {
    for (const g of goals) {
      const dist = new Int32Array(size).fill(-1);
      const queue = [g];
      dist[g] = 0;
      for (let qi = 0; qi < queue.length; qi++) {
        const p = queue[qi] as number;
        for (const d of DIRS) {
          const q = p + d.dy * w + d.dx;
          if (!wall[q] && dist[q] < 0) {
            dist[q] = (dist[p] as number) + 1;
            queue.push(q);
          }
        }
      }
      distToGoal.push(dist);
    }
  }
  const n = level.boxes.length;
  const perms = permutations(n);
  const useMatching = n <= 6;
  const hMemo = new Map<number, number>();
  const heuristic = (boxes: number[]): number => {
    if (!useHeuristic) return 0;
    if (!useMatching) {
      // Many boxes: the sum of each box's nearest-goal distance, still a lower bound.
      let s = 0;
      for (const b of boxes) {
        let m = Infinity;
        for (let gi = 0; gi < goals.length; gi++) {
          const d = (distToGoal[gi] as Int32Array)[b] as number;
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) return Infinity;
        s += m;
      }
      return s;
    }
    let code = 0;
    for (const b of boxes) code = code * size + b;
    const memo = hMemo.get(code);
    if (memo !== undefined) return memo;
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = (distToGoal[p[i] as number] as Int32Array)[boxes[i] as number] as number;
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    hMemo.set(code, best);
    return best;
  };

  // Flood-fill scratch: the player's region from a square, around walls and boxes.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const regionLow = (occupied: Uint8Array, from: number, seenArr: Int32Array, stampVal: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seenArr[from] = stampVal;
    while (sp > 0) {
      const p = stack[--sp] as number;
      if (p < low) low = p;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (!wall[q] && !occupied[q] && seenArr[q] !== stampVal) {
          seenArr[q] = stampVal;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and
  // boxes holding a box off its goal.
  const frozenBlock = (occupied: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
    }
    return false;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const occupied = new Uint8Array(size);
  for (const b of level.boxes) occupied[b] = 1;

  // The states in the order found: boxes, the player's square after the push
  // that made them, parent, that push (from, to, direction), and state key.
  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const gOf: number[] = [0];
  const best = new Map<number | string, number>();
  const startLow = regionLow(occupied, level.player, seen, ++stamp);
  const keys: (number | string)[] = [keyOf(level.boxes, startLow)];
  best.set(keys[0] as number | string, 0);
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  const heap = new Heap(!useHeuristic);
  let seq = 0;
  heap.push(h0, 0, seq++, 0);
  let expanded = 0;
  let found = -1;

  while (heap.size > 0) {
    const { g, idx: s } = heap.pop();
    if ((best.get(keys[s] as number | string) as number) < g) continue;
    const boxes = statesBoxes[s] as number[];
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(occupied, statesPlayer[s] as number, seen, here);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi] as number;
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di] as Dir;
        const step = d.dy * w + d.dx;
        const t = b + step;
        if (seen[b - step] !== here || wall[t] || occupied[t] || !live[t]) continue;
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(occupied, t);
        let key: number | string = -1;
        let h = Infinity;
        if (!frozen) {
          h = heuristic(next);
          if (h !== Infinity) key = keyOf(next, regionLow(occupied, b, mark, ++stamp));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        best.set(key, g2);
        const ns = statesBoxes.length;
        statesBoxes.push(next);
        statesPlayer.push(b);
        keys.push(key);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(di);
        gOf.push(g2);
        heap.push(g2 + h, g2, seq++, ns);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s] as number[];
    const from = pushFrom[s] as number;
    const to = pushTo[s] as number;
    const d = DIRS[pushDir[s] as number] as Dir;
    const step = d.dy * w + d.dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - step);
    for (const b of boxes) occupied[b] = 0;
    moves += d.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. Null when a room's
 * search gives up or the level is no set of rooms.
 */
function solveByRooms(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    // No rooms to cut: one search over the whole level, with string state keys; a heuristic search first, then the breadth-first retry.
    return searchPushOptimal(level, level.wall, MAX_EXPANSIONS, false) ?? searchPushOptimal(level, level.wall, BFS_EXPANSIONS, false, false);
  }
  // Each room's boxes now: on their goals once the room is done, else where they started.
  const current: number[][] = rooms.map((r) => r.boxes.slice());
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri] as { squares: number[]; boxes: number[]; goals: number[] };
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of current[oj] as number[]) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: (current[ri] as number[]).slice().sort((a, b) => a - b),
      player,
    };
    // The heuristic search first; a room it gives up on gets the breadth-first retry the generator keeps rooms by.
    const solved = searchPushOptimal(sub, wall, MAX_EXPANSIONS, true) ?? searchPushOptimal(sub, wall, BFS_EXPANSIONS, true, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    current[ri] = room.goals.slice();
  }
  return { pushes, moves };
}

/** The moves solving one level, or '' when the level gives up (still a valid answer file). */
function solveLevel(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.player < 0 || level.boxes.length === 0) return '';
    const solved = solveByRooms(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  let isDir = false;
  try {
    isDir = statSync(join(I, id)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) continue;
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
