// $HERMES_HOME/desktop-plugins/sulfgreyrat-office/plugin.js
//
// SulfGreyrat's office — пиксельный офис агентов Hermes в интерьере учебного
// центра ADVANCE.
//
// Каждый профиль Hermes — человек со своим ПК:
//   работает  -> сидит за ПК спиной к нам, на экране видно, чем занят (код, макет,
//                тесты, терминал…), над монитором задача;
//   свободен  -> отдыхает в холле с чаем, болтает в переговорной, смотрит доску;
//   не на смене (gateway выключен) -> уходит домой через дверь.
// Основной профиль (default) — Оркестратор, у него на экране мини-доска задач.
//
// Рендер: Canvas 2D, сцена 640x384 в "игровых" пикселях, масштабируется
// без сглаживания. Подписи и пузыри рисуются поверх в экранном разрешении.
// Данные: GET /api/plugins/sulfgreyrat-office/state (plugin_api.py рядом).
// Автор: SulfGreyrat · github.com/SulfGreyrat

import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  useQuery,
  host,
  EmptyState,
  ErrorState,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Геометрия и палитра
// ---------------------------------------------------------------------------
const T = 16
const COLS = 40
const ROWS = 24
const W = COLS * T
const H = ROWS * T
const FPS = 15
const WALK_SPEED = 46

const C = {
  floor: '#eef1f5',
  floorAlt: '#e8ecf1',
  grout: '#d9dee5',
  shine: '#ffffff',
  wallTop: '#2a2e38',
  wallTopHi: '#3b404c',
  wallFace: '#f5f6f8',
  wallFaceShade: '#e2e6eb',
  base: '#c9cfd7',
  red: '#e3262e',
  redDark: '#b31c22',
  blue: '#1f4fbf',
  blueDark: '#163a8f',
  blueLight: '#4a7be6',
  black: '#16181d',
  yellow: '#ffd21f',
  yellowDark: '#e6b800',
  stripe: '#5b6069',
  deskTop: '#fbfbfc',
  deskEdge: '#c3cad3',
  deskFace: '#e1e5ea',
  metal: '#22252b',
  chair: '#1d1f24',
  chairHi: '#3a3e46',
  lid: '#aab3bd',
  lidDark: '#7d8792',
  lidHi: '#cdd3da',
  ink: '#1b1d22',
}

const SKINS = ['#f1c7a3', '#e0ac85', '#c98e67', '#f5d2b6', '#e9b98f']
const HAIRS = ['#2b1d16', '#4a2f1f', '#1c1c1c', '#6b4a2e', '#c9a15a', '#3b2a4a']
const SHIRTS = ['#3d6fe0', '#d9534f', '#5cb85c', '#9b59b6', '#f0ad4e', '#17a2b8', '#e83e8c', '#6c757d']

const ROLES = {
  default: { label: 'Оркестратор', shirt: '#1f4fbf', pants: '#262a33', hair: '#2b1d16', skin: '#e9b98f', boss: true },
  architect: { label: 'Архитектор', shirt: '#6d4bc2', pants: '#2d2f38', hair: '#1c1c1c', skin: '#f1c7a3' },
  designer: { label: 'Дизайнер', shirt: '#e0529c', pants: '#3a3350', hair: '#6b3a22', skin: '#f5d2b6' },
  developer: { label: 'Разработчик', shirt: '#2f9e57', pants: '#27313a', hair: '#1c1c1c', skin: '#e0ac85' },
  devops: { label: 'DevOps', shirt: '#e07b2c', pants: '#30343c', hair: '#4a2f1f', skin: '#c98e67' },
  'prod-operator': { label: 'Прод-оператор', shirt: '#e3262e', pants: '#23262d', hair: '#2b1d16', skin: '#f1c7a3' },
  researcher: { label: 'Исследователь', shirt: '#1b9aaa', pants: '#2e3440', hair: '#c9a15a', skin: '#f5d2b6' },
  reviewer: { label: 'Ревьюер', shirt: '#8a6d3b', pants: '#2b2e35', hair: '#3b2a4a', skin: '#e0ac85' },
  tester: { label: 'Тестировщик', shirt: '#c9a400', pants: '#2f3542', hair: '#1c1c1c', skin: '#c98e67' },
}

function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function roleOf(name) {
  if (ROLES[name]) return ROLES[name]
  const h = hashStr(name)
  return {
    label: name,
    shirt: SHIRTS[h % SHIRTS.length],
    pants: '#2b2e35',
    hair: HAIRS[(h >>> 3) % HAIRS.length],
    skin: SKINS[(h >>> 7) % SKINS.length],
  }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16)
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)))
  const r = f((n >> 16) & 255)
  const g = f((n >> 8) & 255)
  const b = f(n & 255)
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
}

// ---------------------------------------------------------------------------
// Пиксельный шрифт 3x5 (латиница, цифры) — для надписей на стенах
// ---------------------------------------------------------------------------
const GLYPHS = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'],
  ' ': ['..', '..', '..', '..', '..'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '#', '#'],
  "'": ['#', '#', '.', '.', '.'],
  '-': ['...', '...', '###', '...', '...'],
  ':': ['.', '#', '.', '#', '.'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
}

function glyph(ch) {
  return GLYPHS[ch] || GLYPHS['?']
}

function pxTextW(str, sc = 1) {
  let w = 0
  for (const ch of str.toUpperCase()) w += (glyph(ch)[0].length + 1) * sc
  return Math.max(0, w - sc)
}

function pxText(g, str, x, y, color, sc = 1) {
  g.fillStyle = color
  let cx = Math.round(x)
  for (const ch of str.toUpperCase()) {
    const gl = glyph(ch)
    for (let r = 0; r < 5; r++) {
      const row = gl[r]
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '#') g.fillRect(cx + c * sc, Math.round(y) + r * sc, sc, sc)
      }
    }
    cx += (gl[0].length + 1) * sc
  }
}

function rect(g, x, y, w, h, color) {
  g.fillStyle = color
  g.fillRect(x, y, w, h)
}

function disc(g, cx, cy, r, color) {
  g.fillStyle = color
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35)
    g.fillRect(cx - half, cy + dy, half * 2 + 1, 1)
  }
}

// ---------------------------------------------------------------------------
// План этажа (в тайлах 16x16)
// ---------------------------------------------------------------------------
// Класс: x 1..24, y 3..22 · переговорная (жёлтая): x 26..38, y 3..10
// Холл-кафе: x 26..38, y 13..22 · выход вниз по x 31..33
// Рабочие места: стол 4 тайла, ПК экраном к нам, агент сидит спиной к зрителю.
// Три ряда по три места; четвёртый ряд появляется, если профилей больше девяти.
const DESK_COLS = [3, 10, 17]
const DESK_ROWS = [6, 11, 16, 21]
const DESKS = []
for (const y of DESK_ROWS) for (const x of DESK_COLS) DESKS.push({ x, y })
// место — тайл под столом, человек смещён на полтайла вправо, к центру стола
const SEATS = DESKS.map((d) => ({ x: d.x + 1, y: d.y + 1, ox: 8, desk: d }))
const BASE_DESKS = 9

const PRINTER = { x: 1, y: 3 }
const EXIT = { x: 32, y: 23 }
const MEETING_TABLE = { x: 29, y: 6, w: 6 }
const CAFE_TABLES = [{ x: 31, y: 16 }, { x: 35, y: 16 }, { x: 32, y: 20 }]
const RECEPTION = { x: 27, y: 14 }
const COOLER = { x: 38, y: 18 }
const PLANTS = [{ x: 1, y: 22 }, { x: 24, y: 22 }, { x: 26, y: 22 }, { x: 38, y: 22 }, { x: 26, y: 3 }]
const BOARD = { x: 450, y: 7, w: 140, h: 35 } // доска Kanban на стене переговорной (пиксели)

const IDLE_SPOTS = [
  { x: 30, y: 16, facing: 'right', pose: 'sit', act: 'tea' },
  { x: 33, y: 16, facing: 'left', pose: 'sit', act: 'tea' },
  { x: 34, y: 16, facing: 'right', pose: 'sit', act: 'tea' },
  { x: 37, y: 16, facing: 'left', pose: 'sit', act: 'tea' },
  { x: 31, y: 20, facing: 'right', pose: 'sit', act: 'tea' },
  { x: 34, y: 20, facing: 'left', pose: 'sit', act: 'tea' },
  { x: 37, y: 18, facing: 'right', pose: 'stand', act: 'tea' },
  { x: 29, y: 5, facing: 'down', pose: 'sit', act: 'chat' },
  { x: 31, y: 5, facing: 'down', pose: 'sit', act: 'chat' },
  { x: 33, y: 5, facing: 'down', pose: 'sit', act: 'chat' },
  { x: 30, y: 7, facing: 'up', pose: 'sit', act: 'chat' },
  { x: 32, y: 7, facing: 'up', pose: 'sit', act: 'chat' },
  { x: 34, y: 7, facing: 'up', pose: 'sit', act: 'chat' },
  { x: 30, y: 3, facing: 'up', pose: 'stand', act: 'board' },
  { x: 33, y: 3, facing: 'up', pose: 'stand', act: 'board' },
  { x: 36, y: 4, facing: 'right', pose: 'stand', act: 'read' },
]

const CHATTER = [
  'Ещё чаю?',
  'Band 9 — легко!',
  'Кто взял маркер?',
  'Жду задачу…',
  'Мок в субботу',
  'No excuses!',
  'Focus!',
  'Speaking на 7.5',
  'Где пульт от ТВ?',
]

function buildGrid(deskCount = BASE_DESKS) {
  const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(false))
  const set = (x0, y0, x1, y1, v) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = v
  }
  set(1, 3, 24, 22, true)
  set(26, 3, 38, 10, true)
  set(26, 13, 38, 22, true)
  set(25, 18, 25, 20, true)
  set(36, 11, 37, 12, true)
  set(31, 23, 33, 23, true)
  for (const d of DESKS.slice(0, deskCount)) set(d.x, d.y, d.x + 3, d.y, false)
  set(PRINTER.x, PRINTER.y, PRINTER.x + 1, PRINTER.y, false)
  set(21, 3, 23, 3, false)
  set(MEETING_TABLE.x, MEETING_TABLE.y, MEETING_TABLE.x + MEETING_TABLE.w - 1, MEETING_TABLE.y, false)
  set(37, 3, 38, 4, false)
  for (const t of CAFE_TABLES) set(t.x, t.y, t.x + 1, t.y, false)
  set(RECEPTION.x, RECEPTION.y, RECEPTION.x + 2, RECEPTION.y, false)
  set(COOLER.x, COOLER.y, COOLER.x, COOLER.y, false)
  for (const p of PLANTS) set(p.x, p.y, p.x, p.y, false)
  return g
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function bfs(grid, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return []
  const key = (x, y) => y * COLS + x
  const prev = new Int32Array(COLS * ROWS).fill(-1)
  const start = key(sx, sy)
  const goal = key(tx, ty)
  prev[start] = start
  const q = [start]
  let head = 0
  while (head < q.length) {
    const k = q[head++]
    if (k === goal) break
    const x = k % COLS
    const y = (k / COLS) | 0
    for (const [dx, dy] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue
      const nk = key(nx, ny)
      if (prev[nk] !== -1) continue
      if (!grid[ny][nx] && nk !== goal) continue
      prev[nk] = k
      q.push(nk)
    }
  }
  if (prev[goal] === -1) return null
  const out = []
  for (let k = goal; k !== start; k = prev[k]) out.push({ x: k % COLS, y: (k / COLS) | 0 })
  return out.reverse()
}

function feet(tx, ty) {
  return { x: tx * T + 8, y: ty * T + 13 }
}

// ---------------------------------------------------------------------------
// Статичный фон: пол, стены, росписи
// ---------------------------------------------------------------------------
function dayPhase(d) {
  const h = d.getHours() + d.getMinutes() / 60
  if (h >= 7 && h < 17.5) return 'day'
  if (h >= 17.5 && h < 19.5) return 'dusk'
  if (h >= 5.5 && h < 7) return 'dusk'
  return 'night'
}

const SKY = { day: '#a9d8ff', dusk: '#ffb47e', night: '#1c2548' }

function drawFloorArea(g, x0, y0, x1, y1, rnd) {
  // x0..x1, y0..y1 в тайлах включительно; крупная глянцевая плитка 32x32
  const px0 = x0 * T
  const py0 = y0 * T
  const pw = (x1 - x0 + 1) * T
  const ph = (y1 - y0 + 1) * T
  rect(g, px0, py0, pw, ph, C.floor)
  for (let y = py0; y < py0 + ph; y += 32) {
    for (let x = px0; x < px0 + pw; x += 32) {
      if (((x >> 5) + (y >> 5)) % 2 === 0) rect(g, x, y, Math.min(32, px0 + pw - x), Math.min(32, py0 + ph - y), C.floorAlt)
    }
  }
  g.fillStyle = C.grout
  for (let x = px0 + 32 - (px0 % 32); x < px0 + pw; x += 32) g.fillRect(x, py0, 1, ph)
  for (let y = py0 + 32 - (py0 % 32); y < py0 + ph; y += 32) g.fillRect(px0, y, pw, 1)
  // отражения потолочных светильников на глянце
  for (let y = py0 + 20; y < py0 + ph - 6; y += 48) {
    for (let x = px0 + 24; x < px0 + pw - 10; x += 56) {
      g.fillStyle = 'rgba(255,255,255,0.85)'
      g.fillRect(x, y, 6, 1)
      g.fillStyle = 'rgba(255,255,255,0.5)'
      g.fillRect(x - 1, y + 1, 8, 1)
    }
  }
  for (let i = 0; i < (pw * ph) / 900; i++) {
    g.fillStyle = 'rgba(255,255,255,0.9)'
    g.fillRect(px0 + Math.floor(rnd() * pw), py0 + Math.floor(rnd() * ph), 1, 1)
  }
}

function drawWindow(g, x, y, w, h, phase, rnd) {
  rect(g, x - 2, y - 2, w + 4, h + 4, '#d7dce3')
  rect(g, x, y, w, h, SKY[phase])
  if (phase === 'night') {
    for (let i = 0; i < 14; i++) rect(g, x + Math.floor(rnd() * w), y + Math.floor(rnd() * h), 1, 1, '#ffffff')
    rect(g, x + w - 12, y + 4, 4, 4, '#f4f1c9')
  } else if (phase === 'day') {
    rect(g, x + 8, y + 6, 12, 3, '#ffffff')
    rect(g, x + 11, y + 4, 6, 2, '#ffffff')
    rect(g, x + w - 20, y + 16, 10, 2, '#ffffff')
  } else {
    rect(g, x, y + h - 8, w, 8, '#ff8e5e')
  }
  // жалюзи «зебра»: плотные и прозрачные полосы
  for (let yy = y; yy < y + h; yy += 6) {
    g.fillStyle = 'rgba(250,250,250,0.82)'
    g.fillRect(x, yy, w, 2)
    g.fillStyle = 'rgba(250,250,250,0.14)'
    g.fillRect(x, yy + 2, w, 4)
  }
  rect(g, x, y, w, 2, '#ffffff')
  rect(g, x - 2, y + h + 2, w + 4, 1, '#b9c0c9')
}

function drawBuffett(g, x, y) {
  // стилизованный портрет в духе росписи «Warren Buffett»
  rect(g, x + 4, y + 2, 12, 4, '#e8e8e8')
  rect(g, x + 3, y + 4, 2, 5, '#e8e8e8')
  rect(g, x + 15, y + 4, 2, 5, '#e8e8e8')
  rect(g, x + 5, y + 5, 10, 11, '#d9d9d9')
  rect(g, x + 5, y + 8, 10, 1, C.black)
  rect(g, x + 6, y + 8, 3, 2, C.black)
  rect(g, x + 11, y + 8, 3, 2, C.black)
  rect(g, x + 7, y + 8, 1, 1, '#ffffff')
  rect(g, x + 12, y + 8, 1, 1, '#ffffff')
  rect(g, x + 9, y + 11, 2, 1, '#9a9a9a')
  rect(g, x + 8, y + 13, 4, 1, '#8a8a8a')
  rect(g, x + 3, y + 16, 14, 8, '#f0f0f0')
  rect(g, x + 9, y + 16, 2, 6, C.black)
}

function drawBigA(g, x, y, h) {
  // огромная «A» из красной и синей диагоналей, как на стенах ADVANCE
  const apex = x + Math.floor(h * 0.62)
  for (let r = 0; r < h; r++) {
    const off = Math.floor(r * 0.62)
    g.fillStyle = C.blue
    g.fillRect(apex - off - 7, y + r, 7, 1)
    g.fillStyle = C.red
    g.fillRect(apex + off, y + r, 7, 1)
  }
  rect(g, apex - Math.floor(h * 0.62 * 0.62) - 2, y + Math.floor(h * 0.62), Math.floor(h * 0.62 * 1.24) + 4, 3, C.black)
}

function drawStripes(g, x, y, w, h, color, step, width, dir) {
  g.fillStyle = color
  for (let r = 0; r < h; r++) {
    for (let s = -h; s < w + h; s += step) {
      const sx = s + (dir > 0 ? r : -r)
      const a = Math.max(x, x + sx)
      const b = Math.min(x + w, x + sx + width)
      if (b > a) g.fillRect(a, y + r, b - a, 1)
    }
  }
}

function renderBackground(g, phase) {
  const rnd = mulberry32(77)
  g.clearRect(0, 0, W, H)
  rect(g, 0, 0, W, H, C.wallTop)

  // полы
  drawFloorArea(g, 1, 3, 24, 22, rnd)
  drawFloorArea(g, 26, 3, 38, 10, rnd)
  drawFloorArea(g, 26, 13, 38, 22, rnd)
  drawFloorArea(g, 25, 18, 25, 20, rnd)
  drawFloorArea(g, 36, 11, 37, 12, rnd)
  drawFloorArea(g, 31, 23, 33, 23, rnd)

  // --- стена класса (фасад, y 0..47) ---
  rect(g, 6, 0, 394, 48, C.wallFace)
  rect(g, 6, 0, 394, 3, C.wallTop)
  rect(g, 6, 3, 394, 1, C.wallTopHi)
  rect(g, 6, 44, 394, 4, C.base)
  drawWindow(g, 20, 9, 56, 30, phase, rnd)

  // чёрная панель «THE BEST INVESTMENT IS IN KNOWLEDGE»
  rect(g, 86, 6, 150, 37, C.black)
  for (let r = 0; r < 37; r++) {
    const w = r < 19 ? r : 36 - r
    g.fillStyle = C.red
    g.fillRect(86, 6 + r, Math.max(1, Math.floor(w * 0.45)), 1)
  }
  pxText(g, 'THE BEST INVESTMENT IS IN', 100, 11, '#ffffff', 1)
  pxText(g, 'KNOWLEDGE', 100, 19, '#ffffff', 2)
  pxText(g, 'W. BUFFETT', 158, 34, '#8e939b', 1)
  drawBuffett(g, 210, 12)

  // ТВ со слайдом (содержимое экрана рисуется каждый кадр)
  rect(g, 250, 12, 6, 16, C.black)
  rect(g, 318, 12, 6, 16, C.black)
  rect(g, 251, 14, 4, 4, '#2b2f36')
  rect(g, 319, 14, 4, 4, '#2b2f36')
  rect(g, 258, 8, 58, 34, '#0e0f12')

  // роспись с огромной «A»
  rect(g, 330, 4, 70, 40, '#ffffff')
  drawBigA(g, 334, 6, 38)
  drawStripes(g, 376, 6, 24, 38, C.blue, 18, 6, 1)

  // --- переговорная (жёлтая стена с серыми шевронами) ---
  rect(g, 416, 0, 208, 48, C.yellow)
  rect(g, 416, 0, 208, 3, C.wallTop)
  rect(g, 416, 3, 208, 1, C.wallTopHi)
  drawStripes(g, 418, 4, 26, 40, C.stripe, 14, 5, 1)
  drawStripes(g, 596, 4, 26, 40, C.stripe, 14, 5, -1)
  rect(g, 416, 44, 208, 4, C.yellowDark)
  // доска Kanban (стикеры рисуются каждый кадр)
  rect(g, BOARD.x - 3, BOARD.y - 3, BOARD.w + 6, BOARD.h + 7, '#b8bec6')
  rect(g, BOARD.x - 2, BOARD.y - 2, BOARD.w + 4, BOARD.h + 4, '#d5dae0')
  rect(g, BOARD.x, BOARD.y, BOARD.w, BOARD.h, '#fdfdfd')
  for (let i = 1; i < 4; i++) rect(g, BOARD.x + Math.round((BOARD.w * i) / 4), BOARD.y + 2, 1, BOARD.h - 4, '#e3e6ea')
  rect(g, BOARD.x + 10, BOARD.y + BOARD.h + 2, 30, 2, '#9aa1aa')
  rect(g, BOARD.x + 14, BOARD.y + BOARD.h + 1, 5, 1, C.blue)
  rect(g, BOARD.x + 21, BOARD.y + BOARD.h + 1, 5, 1, C.red)

  // --- стена холла с плакатом автора ---
  rect(g, 416, 176, 160, 32, C.wallFace)
  rect(g, 608, 176, 16, 32, C.wallFace)
  rect(g, 416, 176, 160, 3, C.wallTop)
  rect(g, 608, 176, 16, 3, C.wallTop)
  rect(g, 416, 204, 160, 4, C.base)
  rect(g, 608, 204, 16, 4, C.base)
  rect(g, 422, 180, 122, 24, C.blue)
  rect(g, 422, 180, 122, 1, C.blueLight)
  rect(g, 422, 203, 122, 1, C.blueDark)
  pxText(g, 'DEVELOPED BY', 428, 183, '#ffffff', 1)
  pxText(g, 'SULFGREYRAT', 428, 190, C.yellow, 2)
  pxText(g, '</>', 519, 190, '#ffffff', 2)
  rect(g, 480, 185, 60, 1, C.red)
  // часы
  disc(g, 556, 191, 7, '#20242c')
  disc(g, 556, 191, 6, '#ffffff')
  // косяки двери в переговорную
  rect(g, 575, 176, 1, 32, C.wallTop)
  rect(g, 608, 176, 1, 32, C.wallTop)

  // --- стены сверху (торцы) ---
  rect(g, 0, 0, 6, H, C.wallTop)
  rect(g, 634, 0, 6, H, C.wallTop)
  rect(g, 400, 0, 16, 288, C.wallTop)
  rect(g, 400, 336, 16, 32, C.wallTop)
  rect(g, 403, 0, 1, 288, C.wallTopHi)
  rect(g, 403, 336, 1, 32, C.wallTopHi)
  rect(g, 0, 368, 496, 16, C.wallTop)
  rect(g, 544, 368, 96, 16, C.wallTop)
  rect(g, 0, 368, 496, 1, C.wallTopHi)
  rect(g, 544, 368, 96, 1, C.wallTopHi)
  // коврик у входа
  rect(g, 500, 364, 40, 14, C.blue)
  rect(g, 502, 366, 36, 10, C.blueDark)
  pxText(g, 'ADVANCE', 506, 369, '#ffffff', 1)
}

// ---------------------------------------------------------------------------
// Мебель
// ---------------------------------------------------------------------------
function drawDeskTop(g, x, y, w) {
  rect(g, x, y + 1, w, 10, C.deskTop)
  rect(g, x, y + 1, w, 1, '#ffffff')
  rect(g, x, y + 11, w, 1, C.deskEdge)
  rect(g, x, y + 12, w, 2, C.deskFace)
  rect(g, x + 2, y + 12, 2, 4, C.metal)
  rect(g, x + w - 4, y + 12, 2, 4, C.metal)
  rect(g, x, y + 1, 1, 11, C.deskEdge)
  rect(g, x + w - 1, y + 1, 1, 11, C.deskEdge)
}

// Что на экране ПК: по роли видно, чем агент занят
const SCREEN_KIND = {
  default: 'kanban',
  architect: 'diagram',
  designer: 'design',
  developer: 'code',
  devops: 'terminal',
  'prod-operator': 'dash',
  researcher: 'web',
  reviewer: 'diff',
  tester: 'tests',
}

function h32(a, b) {
  return hashStr(a + ':' + b)
}

function drawScreen(g, x, y, w, h, owner, mode, time, board) {
  const seed = owner ? owner.seed : 0
  if (mode === 'off') {
    rect(g, x, y, w, h, '#0b0c0e')
    rect(g, x + 1, y + 1, 4, 1, '#262a31')
    rect(g, x + 1, y + 2, 1, 3, '#262a31')
    return
  }
  if (mode === 'idle') {
    // заставка: логотип «A» плавает по экрану цвета хозяина
    rect(g, x, y, w, h, shade(owner.role.shirt, 0.38))
    const ax = x + 1 + Math.floor((Math.sin(time * 0.7 + seed) * 0.5 + 0.5) * (w - 6))
    const ay = y + 1 + Math.floor((Math.cos(time * 0.5 + seed * 2) * 0.5 + 0.5) * (h - 7))
    pxText(g, 'A', ax, ay, '#ffffff', 1)
    return
  }
  const kind = SCREEN_KIND[owner.name] || 'code'
  const tick = Math.floor(time * 3 + seed)
  const n = owner.name
  const rows = Math.floor((h - 1) / 2)
  if (kind === 'code' || kind === 'terminal') {
    const term = kind === 'terminal'
    rect(g, x, y, w, h, term ? '#050607' : '#0f1720')
    if (!term) rect(g, x, y, 3, h, '#1a2430')
    const cols = term ? ['#4ade80', '#86efac', '#22c55e'] : ['#7ee787', '#79c0ff', '#ff7b72', '#d2a8ff', '#ffa657']
    const speed = term ? 2 : 1
    for (let i = 0; i < rows; i++) {
      const k = tick * speed + i
      const indent = term ? 2 : h32(n, k) % 5
      const len = 3 + (h32(n, k * 7) % Math.max(1, w - 8 - indent))
      rect(g, x + 1, y + 1 + i * 2, 1, 1, term ? '#9ca3af' : '#3b4a5c')
      rect(g, x + 4 + indent, y + 1 + i * 2, len, 1, cols[h32(n, k * 3) % cols.length])
    }
    if (Math.floor(time * 2) % 2 === 0) rect(g, x + w - 5, y + h - 2, 3, 1, '#e5e7eb')
  } else if (kind === 'design') {
    rect(g, x, y, w, h, '#f5f6f8')
    rect(g, x, y, w, 3, owner.role.shirt)
    rect(g, x + 2, y + 1, 4, 1, '#ffffff')
    const iw = Math.floor(w * 0.42)
    rect(g, x + 2, y + 5, iw, h - 8, '#bcd4f6')
    rect(g, x + 4, y + h - 7, 4, 3, '#2f9e57')
    rect(g, x + 6, y + h - 9, 3, 5, '#46c270')
    rect(g, x + iw + 4, y + 5, w - iw - 7, 1, '#6b7280')
    rect(g, x + iw + 4, y + 8, w - iw - 10, 1, '#c3c8cf')
    rect(g, x + iw + 4, y + 10, w - iw - 12, 1, '#c3c8cf')
    rect(g, x + iw + 4, y + h - 4, 8, 2, C.yellowDark)
    const mx = x + 2 + Math.floor((Math.sin(time * 1.3 + seed) * 0.5 + 0.5) * (w - 5))
    const my = y + 4 + Math.floor((Math.cos(time * 1.7) * 0.5 + 0.5) * (h - 7))
    rect(g, mx, my, 1, 3, C.ink)
    rect(g, mx + 1, my + 1, 1, 1, C.ink)
  } else if (kind === 'tests') {
    rect(g, x, y, w, h, '#101418')
    const shown = tick % (rows + 3)
    for (let i = 0; i < Math.min(shown, rows); i++) {
      const bad = h32(n, Math.floor(tick / (rows + 3)) * 10 + i) % 6 === 0
      rect(g, x + 2, y + 1 + i * 2, 2, 1, bad ? '#f87171' : '#4ade80')
      rect(g, x + 6, y + 1 + i * 2, 5 + (h32(n, i) % (w - 12)), 1, '#6b7280')
    }
    rect(g, x, y + h - 1, Math.floor((w * Math.min(shown, rows)) / rows), 1, '#4ade80')
  } else if (kind === 'web') {
    rect(g, x, y, w, h, '#ffffff')
    rect(g, x, y, w, 3, '#d9dde3')
    rect(g, x + 1, y + 1, 1, 1, '#f87171')
    rect(g, x + 3, y + 1, 1, 1, '#facc15')
    rect(g, x + 5, y + 1, 1, 1, '#4ade80')
    rect(g, x + 8, y + 1, w - 10, 1, '#ffffff')
    const off = tick % 4
    const top = y + 4
    const img = Math.floor(w * 0.36)
    const iy = top + 1 - off
    rect(g, x + 2, Math.max(top, iy), img, 6 - Math.max(0, top - iy), '#bfdbfe')
    for (let i = 0; i < rows; i++) {
      const yy = top + i * 2 - off
      if (yy >= top && yy < y + h) rect(g, x + img + 4, yy, 4 + (h32(n, i + tick) % (w - img - 8)), 1, '#9ca3af')
    }
  } else if (kind === 'diagram') {
    rect(g, x, y, w, h, '#1d3b6e')
    for (let gx = x + 3; gx < x + w; gx += 4) rect(g, gx, y, 1, h, '#24477f')
    const hi = tick % 3
    const box = (bx, by, i) => {
      rect(g, bx, by, 8, 5, i === hi ? '#93c5fd' : '#ffffff')
      rect(g, bx + 1, by + 1, 6, 3, '#1d3b6e')
    }
    const mid = x + Math.floor(w / 2)
    box(mid - 4, y + 2, 0)
    box(x + 2, y + h - 7, 1)
    box(x + w - 10, y + h - 7, 2)
    rect(g, mid, y + 7, 1, 3, '#ffffff')
    rect(g, x + 6, y + 9, w - 12, 1, '#ffffff')
    rect(g, x + 6, y + 9, 1, h - 16, '#ffffff')
    rect(g, x + w - 6, y + 9, 1, h - 16, '#ffffff')
  } else if (kind === 'diff') {
    rect(g, x, y, w, h, '#161b22')
    for (let i = 0; i < Math.floor(h / 2); i++) {
      const t = h32(n, i + Math.floor(tick / 2)) % 3
      const bg = t === 0 ? '#5a1e1e' : t === 1 ? '#1e4a2a' : '#161b22'
      rect(g, x, y + i * 2, w, 2, bg)
      rect(g, x + 1, y + i * 2, 1, 1, t === 0 ? '#f87171' : t === 1 ? '#4ade80' : '#374151')
      rect(g, x + 3, y + i * 2, 3 + (h32(n, i * 5) % (w - 8)), 1, t === 0 ? '#fca5a5' : t === 1 ? '#86efac' : '#6b7280')
    }
  } else if (kind === 'dash') {
    rect(g, x, y, w, h, '#12151a')
    const bars = Math.floor((w - 12) / 2)
    for (let i = 0; i < bars; i++) {
      const bh = 2 + (h32(n, i + tick) % (h - 5))
      rect(g, x + 2 + i * 2, y + h - 1 - bh, 1, bh, '#60a5fa')
    }
    disc(g, x + w - 6, y + Math.floor(h / 2), 4, '#374151')
    rect(g, x + w - 6, y + Math.floor(h / 2) - 3, 1, 4, '#facc15')
    if (Math.floor(time * 2) % 2 === 0) rect(g, x + w - 2, y + 1, 1, 1, '#ef4444')
  } else if (kind === 'kanban') {
    const b = board || {}
    rect(g, x, y, w, h, '#f7f7f9')
    const vals = [b.queue || 0, b.running || 0, b.done_today || 0]
    const cols = ['#facc15', '#4ade80', '#60a5fa']
    const cw = Math.floor((w - 2) / 3)
    for (let c = 0; c < 3; c++) {
      const cx = x + 1 + c * cw
      rect(g, cx, y + 1, cw - 2, 2, shade(cols[c], 0.7))
      if (c) rect(g, cx - 1, y + 1, 1, h - 2, '#e3e6ea')
      for (let i = 0; i < Math.min(6, vals[c]); i++) rect(g, cx + 1 + (i % 2) * 4, y + 5 + Math.floor(i / 2) * 4, 3, 3, cols[c])
    }
    if (Math.floor(time * 2) % 2 === 0) rect(g, x + w - 2, y + h - 2, 1, 1, owner.role.shirt)
  }
}

// монитор: рамка 30x19, экран 28x17; верх рамки — на 14 px выше столешницы
const MON = { w: 30, h: 19, up: 14 }

function drawWorkstation(g, d, owner, time, board) {
  const dx = d.x * T
  const dy = d.y * T
  const cx = dx + 32
  drawDeskTop(g, dx, dy, 64)
  const mode = !owner || owner.state === 'offline' ? 'off' : owner.state === 'busy' && owner.act === 'type' ? 'work' : 'idle'
  const mx = cx - MON.w / 2
  const my = dy - MON.up
  rect(g, cx - 1, my + MON.h, 2, 3, '#3a3e46')
  rect(g, cx - 5, my + MON.h + 2, 10, 1, '#2b2f36')
  rect(g, mx, my, MON.w, MON.h, '#1b1d22')
  rect(g, mx, my, MON.w, 1, '#3a3e46')
  drawScreen(g, mx + 1, my + 1, MON.w - 2, MON.h - 2, owner, mode, time, board)
  if (mode === 'work') {
    g.fillStyle = 'rgba(150,220,255,0.16)'
    g.fillRect(mx - 2, my + MON.h, MON.w + 4, 5)
  }
  // клавиатура, мышь, мелочи на столе
  rect(g, cx - 8, dy + 9, 16, 2, '#d5dae0')
  rect(g, cx - 8, dy + 10, 16, 1, '#b7bec8')
  rect(g, cx + 11, dy + 8, 2, 3, '#d5dae0')
  if (owner) {
    rect(g, dx + 4, dy + 4, 4, 4, owner.role.shirt)
    rect(g, dx + 4, dy + 4, 4, 1, '#ffffff')
  }
  const hh = hashStr(d.x + ',' + d.y)
  if (hh % 3 === 0) drawPaper(g, dx + 51, dy + 4)
  else if (hh % 3 === 1) {
    rect(g, dx + 54, dy + 3, 5, 5, '#eceff3')
    rect(g, dx + 55, dy - 1, 3, 4, '#46c270')
  }
}

function drawPrinter(g) {
  const x = PRINTER.x * T + 2
  const y = PRINTER.y * T - 4
  rect(g, x, y, 28, 16, '#e5e7eb')
  rect(g, x, y, 28, 1, '#ffffff')
  rect(g, x, y + 15, 28, 1, '#b7bec8')
  rect(g, x + 4, y + 3, 20, 3, '#9ca3af')
  rect(g, x + 6, y + 8, 16, 5, '#ffffff')
  rect(g, x + 22, y + 9, 2, 2, '#4ade80')
}

function drawPaper(g, x, y) {
  rect(g, x, y, 7, 5, '#ffffff')
  rect(g, x, y + 5, 7, 1, '#cfd5dd')
  rect(g, x + 1, y + 1, 5, 1, '#b7bec8')
  rect(g, x + 1, y + 3, 4, 1, '#b7bec8')
  rect(g, x + 8, y + 1, 1, 4, C.blue)
}

// part: 'seat' | 'back' — у стула спинкой к зрителю сиденье рисуется до человека,
// а спинка после, иначе сиденье закроет сидящего
function drawChair(g, tx, ty, facing, ox = 0, part) {
  const px = tx * T + 8 + ox
  const py = ty * T
  if (facing === 'down') {
    rect(g, px - 5, py + 1, 10, 5, C.chair)
    rect(g, px - 5, py + 1, 10, 1, C.chairHi)
    rect(g, px - 5, py + 6, 10, 6, '#26292f')
    rect(g, px - 4, py + 12, 1, 2, '#8d939b')
    rect(g, px + 3, py + 12, 1, 2, '#8d939b')
  } else if (facing === 'up') {
    if (part !== 'back') rect(g, px - 5, py + 3, 10, 6, '#26292f')
    if (part !== 'seat') {
      rect(g, px - 5, py + 9, 10, 5, C.chair)
      rect(g, px - 5, py + 9, 10, 1, C.chairHi)
    }
  } else {
    const back = facing === 'right' ? px - 6 : px + 3
    rect(g, px - 5, py + 6, 10, 6, '#26292f')
    rect(g, back, py + 1, 3, 11, C.chair)
    rect(g, back, py + 1, 3, 1, C.chairHi)
    rect(g, px - 4, py + 12, 1, 2, '#8d939b')
    rect(g, px + 3, py + 12, 1, 2, '#8d939b')
  }
}

function drawCabinet(g) {
  const x = 21 * T
  const y = 3 * T - 6
  rect(g, x, y, 48, 20, '#f3f4f6')
  rect(g, x, y, 48, 1, '#ffffff')
  rect(g, x, y + 19, 48, 1, '#c3cad3')
  rect(g, x + 2, y + 9, 44, 1, '#d5dae0')
  const books = ['#e3262e', '#1f4fbf', '#ffd21f', '#2f9e57', '#1f4fbf', '#e3262e', '#8a6d3b', '#6d4bc2']
  for (let i = 0; i < books.length; i++) rect(g, x + 3 + i * 5, y + 2 + (i % 3 === 1 ? 1 : 0), 4, 7 - (i % 3 === 1 ? 1 : 0), books[i])
  rect(g, x + 4, y + 12, 18, 6, '#e8ebef')
  rect(g, x + 26, y + 12, 18, 6, '#e8ebef')
  rect(g, x + 12, y + 14, 2, 1, '#9aa1aa')
  rect(g, x + 34, y + 14, 2, 1, '#9aa1aa')
}

function drawShelf(g) {
  const x = 37 * T
  const y = 3 * T - 10
  rect(g, x, y, 30, 36, '#f3f4f6')
  rect(g, x, y, 30, 1, '#ffffff')
  rect(g, x, y + 35, 30, 1, '#c3cad3')
  const cols = ['#e3262e', '#1f4fbf', '#ffd21f', '#2f9e57', '#ffffff', '#6d4bc2']
  for (let s = 0; s < 3; s++) {
    const sy = y + 3 + s * 11
    rect(g, x + 1, sy + 9, 28, 1, '#cfd5dd')
    for (let i = 0; i < 6; i++) rect(g, x + 2 + i * 4 + (s % 2), sy + (i % 2), 3, 9 - (i % 2), cols[(i + s * 2) % cols.length])
  }
}

function drawCafeTable(g, t, rnd) {
  const cx = t.x * T + 16
  const cy = t.y * T + 7
  rect(g, cx - 1, cy + 4, 3, 5, '#9aa1aa')
  disc(g, cx, cy, 9, '#c9ced6')
  disc(g, cx, cy - 1, 8, '#fdfdfd')
  rect(g, cx - 4, cy - 5, 5, 1, '#ffffff')
  rect(g, cx - 6, cy - 2, 3, 3, '#ffffff')
  rect(g, cx - 6, cy - 2, 3, 1, '#7a4b2a')
  rect(g, cx + 3, cy, 3, 3, C.red)
  rect(g, cx + 3, cy, 3, 1, '#7a4b2a')
}

function drawReception(g) {
  const x = RECEPTION.x * T
  const y = RECEPTION.y * T
  drawDeskTop(g, x, y, 48)
  rect(g, x, y + 8, 48, 8, C.blue)
  rect(g, x, y + 8, 48, 1, C.blueLight)
  pxText(g, 'ADVANCE', x + 10, y + 10, '#ffffff', 1)
  rect(g, x + 4, y - 4, 12, 8, '#2b2f36')
  rect(g, x + 5, y - 3, 10, 5, '#3c4350')
  rect(g, x + 36, y + 2, 4, 3, '#e8c24a')
}

function drawCooler(g) {
  const x = COOLER.x * T + 3
  const y = COOLER.y * T
  rect(g, x, y + 2, 10, 13, '#f5f6f8')
  rect(g, x, y + 14, 10, 1, '#c3cad3')
  rect(g, x + 2, y + 6, 2, 2, C.blue)
  rect(g, x + 6, y + 6, 2, 2, C.red)
  rect(g, x + 1, y - 8, 8, 10, 'rgba(111,183,255,0.85)')
  rect(g, x + 2, y - 7, 2, 7, 'rgba(255,255,255,0.6)')
}

function drawPlant(g, p) {
  const x = p.x * T + 3
  const y = p.y * T
  rect(g, x, y + 8, 10, 7, '#eceff3')
  rect(g, x, y + 8, 10, 1, '#ffffff')
  rect(g, x + 1, y + 14, 8, 1, '#c3cad3')
  const leaf = ['#2f9e57', '#46c270', '#23804a']
  rect(g, x + 1, y + 2, 4, 6, leaf[0])
  rect(g, x + 5, y, 4, 8, leaf[1])
  rect(g, x - 1, y + 4, 3, 3, leaf[2])
  rect(g, x + 8, y + 3, 3, 3, leaf[0])
  rect(g, x + 3, y - 3, 3, 4, leaf[1])
}

// ---------------------------------------------------------------------------
// Человечки
// ---------------------------------------------------------------------------
function drawPerson(g, a, time) {
  const r = a.role
  const f = a.facing
  const sit = a.pose === 'sit'
  const walking = a.path.length > 0
  const fr = walking ? Math.floor(time * 7 + a.seed) % 2 : 0
  const typing = a.act === 'type'
  const bob = typing ? Math.floor(time * 6 + a.seed) % 2 : 0
  const x = Math.round(a.x)
  const y = Math.round(a.y)
  const top = (sit ? y - 15 : y - 20) + bob

  if (!sit) {
    g.fillStyle = 'rgba(30,40,60,0.22)'
    g.fillRect(x - 4, y, 9, 2)
    const lUp = walking && fr === 1 ? 1 : 0
    const rUp = walking && fr === 0 ? 1 : 0
    rect(g, x - 3, y - 6, 3, 6 - lUp, r.pants)
    rect(g, x + 1, y - 6, 3, 6 - rUp, r.pants)
    rect(g, x - 3, y - 1 - lUp, 3, 1, C.ink)
    rect(g, x + 1, y - 1 - rUp, 3, 1, C.ink)
  } else if (f === 'left' || f === 'right') {
    const d = f === 'right' ? 1 : -1
    rect(g, d > 0 ? x - 1 : x - 4, y - 3, 6, 3, r.pants)
    rect(g, d > 0 ? x + 3 : x - 4, y, 2, 2, r.pants)
    rect(g, d > 0 ? x + 3 : x - 5, y + 2, 3, 1, C.ink)
  } else {
    rect(g, x - 4, y - 3, 8, 3, r.pants)
  }

  // торс
  const bt = top + 7
  const bh = sit ? 6 : 7
  rect(g, x - 4, bt, 8, bh, r.shirt)
  rect(g, x - 4, bt + bh - 1, 8, 1, shade(r.shirt, 0.78))
  if (r.boss && f !== 'up') {
    rect(g, x - 1, bt, 2, 2, '#ffffff')
    rect(g, x - 1, bt + 2, 1, 4, C.red)
  }
  if (!r.boss && f === 'down') rect(g, x - 1, bt, 2, 1, shade(r.shirt, 1.25))

  // руки
  const sleeve = shade(r.shirt, 0.82)
  if (typing) {
    // со спины видно, как ходят локти
    const k = Math.floor(time * 8 + a.seed) % 2
    rect(g, x - 5, bt + 1 + k, 1, 4, sleeve)
    rect(g, x + 4, bt + 2 - k, 1, 4, sleeve)
    if (f !== 'up') {
      rect(g, x - 5, bt + 5 - k, 1, 1, r.skin)
      rect(g, x + 4, bt + 4 + k, 1, 1, r.skin)
    }
  } else {
    rect(g, x - 5, bt + 1, 1, 5, sleeve)
    rect(g, x + 4, bt + 1, 1, 5, sleeve)
    rect(g, x - 5, bt + 6, 1, 1, r.skin)
    rect(g, x + 4, bt + 6, 1, 1, r.skin)
  }
  if (a.act === 'tea' && !walking) {
    const cx = f === 'left' ? x - 7 : x + 4
    rect(g, cx, bt + 3, 3, 3, '#ffffff')
    rect(g, cx, bt + 3, 3, 1, '#7a4b2a')
    rect(g, f === 'left' ? cx - 1 : cx + 3, bt + 4, 1, 1, '#ffffff')
  }
  if (a.act === 'read' && !walking) {
    rect(g, x + 3, bt + 2, 4, 5, C.blue)
    rect(g, x + 3, bt + 2, 4, 1, '#ffffff')
  }

  // голова
  rect(g, x - 3, top + 1, 6, 6, r.skin)
  rect(g, x - 1, top + 6, 2, 1, shade(r.skin, 0.85))
  g.fillStyle = r.hair
  if (f === 'up') {
    g.fillRect(x - 3, top, 6, 7)
    g.fillRect(x - 4, top + 1, 1, 4)
    g.fillRect(x + 3, top + 1, 1, 4)
  } else {
    g.fillRect(x - 3, top, 6, 2)
    g.fillRect(x - 4, top + 1, 1, 3)
    g.fillRect(x + 3, top + 1, 1, 3)
    if (f === 'left') g.fillRect(x + 1, top + 1, 3, 4)
    if (f === 'right') g.fillRect(x - 4, top + 1, 3, 4)
  }
  const blink = (time + a.seed) % 4.2 < 0.13
  if (!blink && f !== 'up') {
    g.fillStyle = C.ink
    if (f === 'down') {
      g.fillRect(x - 2, top + 3, 1, 1)
      g.fillRect(x + 1, top + 3, 1, 1)
    } else if (f === 'left') {
      g.fillRect(x - 2, top + 3, 1, 1)
    } else {
      g.fillRect(x + 1, top + 3, 1, 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Сцена: состояние, поведение, отрисовка
// ---------------------------------------------------------------------------
function createScene(opts) {
  const now = (opts && opts.now) || (() => new Date())
  let deskCount = BASE_DESKS
  let grid = buildGrid(deskCount)
  const agents = new Map()
  const particles = []
  const rnd = mulberry32(Date.now() & 0xffffffff)
  const bg = document.createElement('canvas')
  bg.width = W
  bg.height = H
  const fg = document.createElement('canvas')
  fg.width = W
  fg.height = H
  let bgPhase = ''
  let data = null
  let first = true
  let time = 0
  const mouse = { x: -1, y: -1 }
  let layout = { s: 1, ox: 0, oy: 0 }

  function seatOwner(seat) {
    for (const a of agents.values()) if (a.seat === seat) return a
    return null
  }

  function makeAgent(name) {
    return {
      name,
      role: roleOf(name),
      seed: (hashStr(name) % 1000) / 100,
      x: 0,
      y: 0,
      path: [],
      target: null,
      facing: 'down',
      pose: 'stand',
      act: 'none',
      state: 'offline',
      visible: false,
      spot: null,
      seat: null,
      waitUntil: 0,
      bubble: null,
      info: null,
      doneSeen: null,
      removeWhenGone: false,
    }
  }

  function pickSpot(a) {
    const taken = new Set()
    for (const o of agents.values()) if (o !== a && o.spot != null) taken.add(o.spot)
    const free = []
    for (let i = 0; i < IDLE_SPOTS.length; i++) if (!taken.has(i) && i !== a.spot) free.push(i)
    if (!free.length) {
      a.spot = null
      return a.seat ? { x: a.seat.x, y: a.seat.y, ox: a.seat.ox, facing: 'up', pose: 'sit', act: 'tea' } : { x: 32, y: 18, facing: 'down', pose: 'stand', act: 'none' }
    }
    const i = free[Math.floor(rnd() * free.length)]
    a.spot = i
    return IDLE_SPOTS[i]
  }

  function targetFor(a) {
    if (a.state === 'busy') {
      a.spot = null
      return { x: a.seat.x, y: a.seat.y, ox: a.seat.ox, facing: 'up', pose: 'sit', act: 'type' }
    }
    return pickSpot(a)
  }

  function arrive(a, tgt) {
    a.path = []
    a.facing = tgt.facing || 'down'
    a.pose = tgt.pose || 'stand'
    a.act = tgt.act || 'none'
    if (tgt.exit) {
      a.visible = false
      a.act = 'none'
      if (a.removeWhenGone) agents.delete(a.name)
      return
    }
    a.waitUntil = time + 8 + rnd() * 14
  }

  function walkTo(a, tgt) {
    const sx = Math.max(0, Math.min(COLS - 1, Math.floor(a.x / T)))
    const sy = Math.max(0, Math.min(ROWS - 1, Math.floor((a.y - 1) / T)))
    a.target = tgt
    const tiles = bfs(grid, sx, sy, tgt.x, tgt.y)
    if (tiles === null) {
      const p = feet(tgt.x, tgt.y)
      a.x = p.x + (tgt.ox || 0)
      a.y = p.y
      arrive(a, tgt)
      return
    }
    a.path = tiles.map((t) => feet(t.x, t.y))
    if (tgt.ox) {
      const p = feet(tgt.x, tgt.y)
      a.path.push({ x: p.x + tgt.ox, y: p.y })
    }
    a.pose = 'stand'
    a.act = 'walk'
    if (!a.path.length) arrive(a, tgt)
  }

  function place(a) {
    if (a.state === 'offline') {
      a.visible = false
      return
    }
    a.visible = true
    const tgt = targetFor(a)
    const p = feet(tgt.x, tgt.y)
    a.x = p.x + (tgt.ox || 0)
    a.y = p.y
    arrive(a, tgt)
    a.waitUntil = time + rnd() * 12
  }

  function plan(a) {
    if (a.state === 'offline') {
      a.spot = null
      if (!a.visible) {
        if (a.removeWhenGone) agents.delete(a.name)
        return
      }
      walkTo(a, { x: EXIT.x, y: EXIT.y, facing: 'down', exit: true })
      return
    }
    if (!a.visible) {
      const p = feet(EXIT.x, EXIT.y)
      a.visible = true
      a.x = p.x
      a.y = p.y
    }
    walkTo(a, targetFor(a))
  }

  function say(a, text, sec, kind) {
    a.bubble = { text, until: time + sec, kind: kind || 'chat' }
  }

  function celebrate(a, title) {
    say(a, '✓ Готово: ' + title, 12, 'done')
    for (let i = 0; i < 18; i++) {
      particles.push({
        x: a.x,
        y: a.y - 18,
        vx: (rnd() - 0.5) * 50,
        vy: -30 - rnd() * 30,
        g: 70,
        life: 1.6,
        max: 1.6,
        color: [C.red, C.blue, C.yellow, '#2f9e57', '#ffffff'][i % 5],
      })
    }
  }

  function setData(snap) {
    if (!snap || !Array.isArray(snap.profiles)) return
    data = snap
    const need = snap.profiles.length > BASE_DESKS ? DESKS.length : BASE_DESKS
    if (need !== deskCount) {
      deskCount = need
      grid = buildGrid(deskCount)
    }
    const names = new Set()
    let si = 0
    for (const p of snap.profiles) {
      names.add(p.profile)
      let a = agents.get(p.profile)
      if (!a) {
        a = makeAgent(p.profile)
        agents.set(p.profile, a)
      }
      a.removeWhenGone = false
      a.info = p
      a.seat = SEATS[Math.min(si++, SEATS.length - 1)]
      const next = !p.online ? 'offline' : p.busy ? 'busy' : 'idle'
      if (p.just_done && a.doneSeen !== p.just_done.id) {
        a.doneSeen = p.just_done.id
        if (!first) celebrate(a, p.just_done.title)
      }
      if (first) {
        a.state = next
        place(a)
      } else if (next !== a.state) {
        a.state = next
        plan(a)
      }
    }
    for (const a of agents.values()) {
      if (!names.has(a.name) && !a.removeWhenGone) {
        a.removeWhenGone = true
        a.state = 'offline'
        plan(a)
      }
    }
    first = false
  }

  function update(dt) {
    time += dt
    for (const a of agents.values()) {
      if (!a.visible) continue
      if (a.bubble && a.bubble.until < time) a.bubble = null
      if (a.path.length) {
        const wp = a.path[0]
        const dx = wp.x - a.x
        const dy = wp.y - a.y
        const d = Math.hypot(dx, dy)
        const step = WALK_SPEED * dt
        if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? 'right' : 'left'
        else if (dy !== 0) a.facing = dy > 0 ? 'down' : 'up'
        if (d <= step) {
          a.x = wp.x
          a.y = wp.y
          a.path.shift()
          if (!a.path.length) arrive(a, a.target)
        } else {
          a.x += (dx / d) * step
          a.y += (dy / d) * step
        }
        continue
      }
      if (a.state === 'idle' && time > a.waitUntil) {
        if (rnd() < 0.55) walkTo(a, pickSpot(a))
        else a.waitUntil = time + 6 + rnd() * 10
      }
      if (a.state === 'idle' && !a.bubble && rnd() < dt * 0.01) {
        say(a, CHATTER[Math.floor(rnd() * CHATTER.length)], 4)
      }
      if (a.act === 'type' && rnd() < dt * 2.2) {
        const sy = a.seat ? a.seat.desk.y * T - MON.up : a.y - 20
        particles.push({ x: a.x - 12 + rnd() * 24, y: sy, vx: 0, vy: -9, g: 0, life: 1.1, max: 1.1, color: rnd() < 0.5 ? '#6dffb0' : '#8fd3ff' })
      }
      if (a.act === 'tea' && rnd() < dt * 1.4) {
        const cx = a.facing === 'left' ? a.x - 6 : a.x + 5
        particles.push({ x: cx + rnd() * 2, y: a.y - (a.pose === 'sit' ? 12 : 16), vx: (rnd() - 0.5) * 3, vy: -6, g: 0, life: 1.4, max: 1.4, color: '#ffffff' })
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      p.life -= dt
      if (p.life <= 0) {
        particles.splice(i, 1)
        continue
      }
      p.vy += (p.g || 0) * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }

  // --- низкое разрешение ---
  function drawTv(g) {
    const x = 260
    const y = 10
    const w = 54
    const h = 30
    const boss = [...agents.values()].find((a) => a.role.boss)
    const b = data && data.board
    if (boss && boss.state === 'busy' && b) {
      rect(g, x, y, w, h, '#ffffff')
      rect(g, x, y, w, 6, C.blue)
      pxText(g, 'TASKS', x + 2, y + 1, '#ffffff', 1)
      const vals = [b.queue, b.running, b.blocked, b.done_today]
      const cols = [C.yellowDark, '#2f9e57', C.red, C.blue]
      const mx = Math.max(1, ...vals)
      for (let i = 0; i < 4; i++) {
        const bh = Math.max(1, Math.round((vals[i] / mx) * 18))
        rect(g, x + 5 + i * 12, y + h - 3 - bh, 8, bh, cols[i])
      }
      return
    }
    const slide = Math.floor(time / 7) % 4
    if (slide === 0) {
      rect(g, x, y, w, h, '#ffe23d')
      rect(g, x, y, w, 5, '#1b1d22')
      pxText(g, 'IELTS', x + 4, y + 8, C.ink, 2)
      pxText(g, 'BAND 9.0', x + 4, y + 21, C.red, 1)
    } else if (slide === 3) {
      rect(g, x, y, w, h, C.black)
      pxText(g, 'SULFGREYRAT', x + 5, y + 5, '#ffffff', 1)
      pxText(g, 'SITE CRM', x + 5, y + 13, C.yellow, 1)
      pxText(g, 'EXAMS BOTS', x + 5, y + 20, C.yellow, 1)
      rect(g, x + 44, y + 5, 5, 5, C.red)
    } else if (slide === 1) {
      rect(g, x, y, w, h, C.blue)
      pxText(g, 'ADVANCE', x + 5, y + 6, '#ffffff', 1)
      pxText(g, 'CEFR C1', x + 5, y + 14, C.yellow, 1)
      rect(g, x + 5, y + 22, 40, 2, C.red)
    } else {
      rect(g, x, y, w, h, '#ffffff')
      pxText(g, 'MOCK EXAM', x + 4, y + 4, C.ink, 1)
      for (let i = 0; i < 3; i++) rect(g, x + 4, y + 12 + i * 5, 30 - i * 6, 2, '#b7bec8')
      rect(g, x + 40, y + 12, 9, 12, C.yellow)
    }
    rect(g, x, y, w, 1, 'rgba(255,255,255,0.35)')
  }

  function drawClock(g) {
    const d = now()
    const cx = 556
    const cy = 191
    const hr = ((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6)
    const mn = d.getMinutes() * (Math.PI / 30)
    g.fillStyle = C.ink
    for (let i = 0; i <= 3; i++) g.fillRect(Math.round(cx + Math.sin(hr) * i), Math.round(cy - Math.cos(hr) * i), 1, 1)
    g.fillStyle = C.red
    for (let i = 0; i <= 5; i++) g.fillRect(Math.round(cx + Math.sin(mn) * i), Math.round(cy - Math.cos(mn) * i), 1, 1)
  }

  function drawBoardNotes(g) {
    const b = (data && data.board) || { queue: 0, running: 0, blocked: 0, done_today: 0 }
    const vals = [b.queue, b.running, b.blocked, b.done_today]
    const cols = ['#ffe066', '#7be495', '#ff8a8a', '#8ecbff']
    const cw = BOARD.w / 4
    for (let c = 0; c < 4; c++) {
      const n = Math.min(vals[c] || 0, 8)
      const x0 = Math.round(BOARD.x + c * cw) + 5
      for (let i = 0; i < n; i++) {
        const nx = x0 + (i % 4) * 6
        const ny = BOARD.y + 12 + Math.floor(i / 4) * 6
        rect(g, nx, ny, 5, 4, cols[c])
        rect(g, nx, ny + 4, 5, 1, shade(cols[c], 0.8))
      }
    }
  }

  function renderLow() {
    const phase = dayPhase(now())
    if (phase !== bgPhase) {
      renderBackground(bg.getContext('2d'), phase)
      bgPhase = phase
    }
    const g = fg.getContext('2d')
    g.imageSmoothingEnabled = false
    g.clearRect(0, 0, W, H)
    g.drawImage(bg, 0, 0)
    drawTv(g)
    drawClock(g)
    drawBoardNotes(g)

    const items = []
    const add = (base, draw) => items.push({ base, draw })
    const board = data && data.board
    SEATS.slice(0, deskCount).forEach((s) => {
      const d = s.desk
      add(s.y * T + 4, () => drawChair(g, s.x, s.y, 'up', s.ox, 'seat'))
      add(s.y * T + 15, () => drawChair(g, s.x, s.y, 'up', s.ox, 'back'))
      add(d.y * T + 16, () => drawWorkstation(g, d, seatOwner(s), time, board))
    })
    add(PRINTER.y * T + 12, () => drawPrinter(g))
    add(3 * T + 14, drawCabinet.bind(null, g))
    add(4 * T + 16, drawShelf.bind(null, g))
    add(MEETING_TABLE.y * T + 16, () => {
      drawDeskTop(g, MEETING_TABLE.x * T, MEETING_TABLE.y * T, MEETING_TABLE.w * T)
      drawPaper(g, MEETING_TABLE.x * T + 20, MEETING_TABLE.y * T + 3)
      drawPaper(g, MEETING_TABLE.x * T + 60, MEETING_TABLE.y * T + 4)
    })
    for (const s of IDLE_SPOTS) {
      if (s.pose !== 'sit') continue
      if (s.facing === 'up') {
        add(s.y * T + 4, () => drawChair(g, s.x, s.y, 'up', 0, 'seat'))
        add(s.y * T + 15, () => drawChair(g, s.x, s.y, 'up', 0, 'back'))
      } else add(s.y * T + 4, () => drawChair(g, s.x, s.y, s.facing))
    }
    const cafeRnd = mulberry32(9)
    for (const t of CAFE_TABLES) add(t.y * T + 12, () => drawCafeTable(g, t, cafeRnd))
    add(RECEPTION.y * T + 16, () => drawReception(g))
    add(COOLER.y * T + 15, () => drawCooler(g))
    for (const p of PLANTS) add(p.y * T + 15, () => drawPlant(g, p))
    for (const a of agents.values()) {
      if (!a.visible) continue
      const base = a.y + (a.pose === 'sit' && a.facing === 'up' ? 1 : 0)
      add(base, () => drawPerson(g, a, time))
    }
    items.sort((p, q) => p.base - q.base)
    for (const it of items) it.draw()

    for (const p of particles) {
      g.globalAlpha = Math.max(0, Math.min(1, p.life / p.max))
      rect(g, Math.round(p.x), Math.round(p.y), 1, 1, p.color)
    }
    g.globalAlpha = 1
  }

  // --- экранный слой: подписи, пузыри, карточка ---
  function wrapText(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean)
    const lines = []
    let cur = ''
    let used = 0
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w
      if (ctx.measureText(test).width <= maxW || !cur) cur = test
      else {
        lines.push(cur)
        cur = w
      }
      if (lines.length === maxLines) break
      used++
    }
    if (lines.length < maxLines && cur) lines.push(cur)
    if (used < words.length && lines.length) {
      let last = lines[lines.length - 1]
      while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1)
      lines[lines.length - 1] = last + '…'
    }
    return lines.map((l) => {
      let s = l
      while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + '…'
      return s
    })
  }

  function box(ctx, x, y, w, h, fill, border, bw) {
    ctx.fillStyle = border
    ctx.fillRect(Math.round(x - bw), Math.round(y - bw), Math.round(w + bw * 2), Math.round(h + bw * 2))
    ctx.fillStyle = fill
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
  }

  function bubbleText(a) {
    if (a.state === 'busy') {
      if (a.info && a.info.task && a.info.task.title) return { text: a.info.task.title, kind: 'task' }
      return { text: a.role.boss ? 'Отвечает вам в чате…' : 'Работает в чате…', kind: 'task' }
    }
    if (a.bubble) return a.bubble
    return null
  }

  function headY(a) {
    return a.y - (a.pose === 'sit' ? 16 : 21)
  }

  // сидит за своим ПК — подпись и задача висят над монитором
  function atDesk(a) {
    if (!a.seat || a.path.length || a.pose !== 'sit' || a.facing !== 'up') return false
    const p = feet(a.seat.x, a.seat.y)
    return Math.abs(a.x - p.x - a.seat.ox) < 1 && Math.abs(a.y - p.y) < 1
  }

  function renderOverlay(ctx, dpr) {
    const { s, ox, oy } = layout
    const fs = Math.round(Math.max(10 * dpr, Math.min(13 * dpr, s * 4.4)))
    const font = (px, weight) => `${weight || 600} ${px}px "Segoe UI", system-ui, sans-serif`
    const X = (v) => ox + v * s
    const Y = (v) => oy + v * s

    // заголовки колонок доски
    const heads = ['Очередь', 'В работе', 'Блок', 'Готово']
    const b = (data && data.board) || {}
    const vals = [b.queue || 0, b.running || 0, b.blocked || 0, b.done_today || 0]
    const small = Math.round(fs * 0.78)
    ctx.textBaseline = 'top'
    for (let c = 0; c < 4; c++) {
      const cx = X(BOARD.x + (BOARD.w / 4) * c + BOARD.w / 8)
      ctx.font = font(small, 700)
      ctx.fillStyle = '#3a3f4a'
      ctx.textAlign = 'center'
      ctx.fillText(heads[c], cx, Y(BOARD.y + 1.5))
      ctx.font = font(small, 800)
      ctx.fillStyle = ['#a07800', '#1e7a42', '#b31c22', '#163a8f'][c]
      ctx.fillText(String(vals[c]), cx, Y(BOARD.y + BOARD.h - 9))
    }

    // подписи соседей не должны налезать: каждую следующую поднимаем выше
    const placed = []
    const pad = 2 * dpr
    const overlaps = (r) =>
      placed.some((p) => r.x < p.x + p.w + pad && r.x + r.w + pad > p.x && r.y < p.y + p.h + pad && r.y + r.h + pad > p.y)
    const settle = (r, step) => {
      for (let i = 0; i < 5 && overlaps(r); i++) r.y -= step
      placed.push(r)
      return r
    }
    const list = [...agents.values()].filter((a) => a.visible).sort((p, q) => q.y - p.y || p.x - q.x)
    for (const a of list) {
      const desk = atDesk(a)
      const cx = desk ? X(a.seat.desk.x * T + 32) : X(a.x)
      const head = desk ? Y(a.seat.desk.y * T - MON.up) - 2 * dpr : Y(headY(a)) - 3 * dpr
      // имя
      ctx.font = font(fs, 700)
      ctx.textAlign = 'center'
      const label = a.role.label
      const lw = ctx.measureText(label).width + 8 * dpr
      const lh = fs + 4 * dpr
      const lr = settle({ x: cx - lw / 2, y: head - lh, w: lw, h: lh }, lh + pad)
      if (lr.y + lh < head - pad) {
        ctx.fillStyle = a.role.shirt
        ctx.fillRect(Math.round(cx), Math.round(lr.y + lh), Math.max(1, Math.round(dpr)), Math.round(head - lr.y - lh))
      }
      box(ctx, lr.x, lr.y, lw, lh, 'rgba(20,23,30,0.86)', a.role.shirt, Math.max(1, Math.round(dpr)))
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, cx, lr.y + 2 * dpr)

      const bt = bubbleText(a)
      if (!bt) continue
      ctx.font = font(fs, 600)
      const maxW = Math.min(200 * dpr, 104 * s)
      const lines = wrapText(ctx, bt.text, maxW, bt.kind === 'task' && !desk ? 2 : 1)
      const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10 * dpr
      const bh = lines.length * (fs + 2 * dpr) + 6 * dpr
      const bx = Math.max(ox + 2, Math.min(cx - bw / 2, ox + W * s - bw - 2))
      const br = settle({ x: bx, y: lr.y - 4 * dpr - bh, w: bw, h: bh }, bh / 2 + pad)
      const fill = bt.kind === 'done' ? '#e9fff1' : bt.kind === 'task' ? '#ffffff' : '#fffbe6'
      const border = bt.kind === 'done' ? '#1e7a42' : bt.kind === 'task' ? '#1b1d22' : '#a07800'
      box(ctx, br.x, br.y, bw, bh, fill, border, Math.max(1, Math.round(1.5 * dpr)))
      ctx.fillStyle = border
      ctx.fillRect(Math.round(cx - 2 * dpr), Math.round(br.y + bh), Math.round(4 * dpr), Math.round(Math.max(3 * dpr, lr.y - br.y - bh)))
      ctx.fillStyle = '#1b1d22'
      ctx.textAlign = 'left'
      lines.forEach((l, i) => ctx.fillText(l, br.x + 5 * dpr, br.y + 3 * dpr + i * (fs + 2 * dpr)))
    }

    // карточка при наведении
    const hit = pick(mouse.x, mouse.y)
    if (hit && hit.agent) {
      const a = hit.agent
      const info = a.info || {}
      const st = a.state === 'busy' ? 'Работает' : a.state === 'idle' ? 'Свободен, на смене' : 'Не на смене'
      const rows = [
        [a.role.label + (a.role.label !== a.name ? '  ·  ' + a.name : ''), 700, '#ffffff'],
        [st, 600, a.state === 'busy' ? '#6dffb0' : a.state === 'idle' ? '#ffe066' : '#9aa1aa'],
      ]
      if (info.task && info.task.title) rows.push(['Задача: ' + info.task.title, 500, '#dfe3ea'])
      rows.push(['Токены: ' + compact(info.tokens_total || 0) + '  ·  $' + Number(info.cost_total || 0).toFixed(2), 500, '#aeb5bf'])
      ctx.font = font(fs, 600)
      const maxW = 300 * dpr
      const lines = []
      for (const [text, w, color] of rows) {
        ctx.font = font(fs, w)
        for (const l of wrapText(ctx, text, maxW, 2)) lines.push([l, w, color])
      }
      let cw = 0
      for (const [l, w] of lines) {
        ctx.font = font(fs, w)
        cw = Math.max(cw, ctx.measureText(l).width)
      }
      cw += 16 * dpr
      const ch = lines.length * (fs + 4 * dpr) + 10 * dpr
      let x = mouse.x * dpr + 14 * dpr
      let y = mouse.y * dpr + 14 * dpr
      if (x + cw > ctx.canvas.width - 4) x = mouse.x * dpr - cw - 14 * dpr
      if (y + ch > ctx.canvas.height - 4) y = mouse.y * dpr - ch - 14 * dpr
      box(ctx, x, y, cw, ch, 'rgba(16,19,26,0.96)', a.role.shirt, Math.max(1, Math.round(2 * dpr)))
      ctx.textAlign = 'left'
      lines.forEach(([l, w, color], i) => {
        ctx.font = font(fs, w)
        ctx.fillStyle = color
        ctx.fillText(l, x + 8 * dpr, y + 5 * dpr + i * (fs + 4 * dpr))
      })
    } else if (hit && hit.board) {
      ctx.font = font(fs, 600)
      const t = 'Открыть Kanban →'
      const tw = ctx.measureText(t).width + 12 * dpr
      box(ctx, mouse.x * dpr + 12 * dpr, mouse.y * dpr + 12 * dpr, tw, fs + 8 * dpr, 'rgba(16,19,26,0.96)', C.yellow, Math.max(1, Math.round(2 * dpr)))
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'left'
      ctx.fillText(t, mouse.x * dpr + 18 * dpr, mouse.y * dpr + 16 * dpr)
    }
  }

  function render(ctx, cw, ch, dpr) {
    renderLow()
    let s = Math.min(cw / W, ch / H)
    if (s >= 1 && Math.floor(s) / s > 0.8) s = Math.floor(s)
    const ox = Math.floor((cw - W * s) / 2)
    const oy = Math.floor((ch - H * s) / 2)
    layout = { s, ox, oy, dpr }
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(fg, ox, oy, Math.round(W * s), Math.round(H * s))
    renderOverlay(ctx, dpr)
  }

  // mx, my — CSS-пиксели относительно канваса
  function pick(mx, my) {
    if (mx < 0 || my < 0) return null
    const { s, ox, oy, dpr } = layout
    const ix = (mx * (dpr || 1) - ox) / s
    const iy = (my * (dpr || 1) - oy) / s
    let best = null
    for (const a of agents.values()) {
      if (!a.visible) continue
      const top = headY(a)
      if (ix >= a.x - 7 && ix <= a.x + 7 && iy >= top - 2 && iy <= a.y + 2) {
        if (!best || a.y > best.y) best = a
      }
    }
    if (best) return { agent: best }
    // наведение на монитор показывает его хозяина
    for (const a of agents.values()) {
      if (!a.seat) continue
      const cx = a.seat.desk.x * T + 32
      const dy = a.seat.desk.y * T
      if (ix >= cx - MON.w / 2 && ix <= cx + MON.w / 2 && iy >= dy - MON.up && iy <= dy - MON.up + MON.h) return { agent: a }
    }
    if (ix >= BOARD.x && ix <= BOARD.x + BOARD.w && iy >= BOARD.y && iy <= BOARD.y + BOARD.h) return { board: true }
    return null
  }

  return { setData, update, render, pick, mouse, agents, particles }
}

function compact(n) {
  const v = Number(n) || 0
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(v))
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------
function OfficeCanvas({ snapshot }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const sceneRef = useRef(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined
    const scene = createScene()
    sceneRef.current = scene
    if (snapshot) scene.setData(snapshot)
    let dpr = window.devicePixelRatio || 1

    const resize = () => {
      const r = wrap.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(r.width * dpr))
      canvas.height = Math.max(1, Math.round(r.height * dpr))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    let raf = 0
    let last = performance.now()
    let acc = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      acc += dt
      if (acc < 1 / FPS) return
      scene.update(acc)
      acc = 0
      const ctx = canvas.getContext('2d')
      if (ctx) scene.render(ctx, canvas.width, canvas.height, dpr)
    }
    raf = requestAnimationFrame(loop)

    const onMove = (e) => {
      const r = canvas.getBoundingClientRect()
      scene.mouse.x = e.clientX - r.left
      scene.mouse.y = e.clientY - r.top
      const hit = scene.pick(scene.mouse.x, scene.mouse.y)
      canvas.style.cursor = hit ? 'pointer' : 'default'
    }
    const onLeave = () => {
      scene.mouse.x = -1
      scene.mouse.y = -1
    }
    const onClick = (e) => {
      const r = canvas.getBoundingClientRect()
      const hit = scene.pick(e.clientX - r.left, e.clientY - r.top)
      if (!hit) return
      if (hit.board || (hit.agent && hit.agent.info && hit.agent.info.task)) {
        try {
          host.navigate('/kanban')
        } catch (err) {
          // Kanban может быть выключен — просто ничего не делаем
        }
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('click', onClick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('click', onClick)
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    if (sceneRef.current && snapshot) sceneRef.current.setData(snapshot)
  }, [snapshot])

  return jsx('div', {
    ref: wrapRef,
    className: 'relative w-full shrink-0 overflow-hidden rounded-md border border-[var(--ui-stroke-secondary)]',
    style: { aspectRatio: W + ' / ' + H, maxHeight: 'calc(100vh - 230px)', minHeight: 320 },
    children: jsx('canvas', { ref: canvasRef, className: 'absolute inset-0 block h-full w-full' }),
  })
}

function Chip({ value, label, accent }) {
  return jsxs('div', {
    className: 'flex items-baseline gap-1.5 rounded-md border border-[var(--ui-stroke-secondary)] px-2.5 py-1',
    children: [
      jsx('span', {
        className: 'text-sm font-semibold tabular-nums',
        style: accent ? { color: accent } : undefined,
        children: value,
      }),
      jsx('span', { className: 'text-xs text-[var(--ui-text-tertiary)]', children: label }),
    ],
  })
}

function Stats({ snapshot }) {
  const ps = snapshot.profiles || []
  const b = snapshot.board || {}
  const tokens = ps.reduce((s, p) => s + (p.tokens_total || 0), 0)
  const cost = ps.reduce((s, p) => s + (p.cost_total || 0), 0)
  return jsxs('div', {
    className: 'flex flex-wrap gap-2',
    children: [
      jsx(Chip, { value: ps.filter((p) => p.online).length + '/' + ps.length, label: 'на смене', accent: 'var(--ui-accent)' }),
      jsx(Chip, { value: String(ps.filter((p) => p.busy).length), label: 'работают', accent: ps.some((p) => p.busy) ? '#2f9e57' : undefined }),
      jsx(Chip, { value: String(b.queue || 0), label: 'в очереди' }),
      jsx(Chip, { value: String(b.blocked || 0), label: 'заблокировано', accent: b.blocked ? '#e3262e' : undefined }),
      jsx(Chip, { value: String(b.done_today || 0), label: 'готово сегодня' }),
      jsx(Chip, { value: compact(tokens), label: 'токенов' }),
      jsx(Chip, { value: '$' + cost.toFixed(2), label: 'расходы', accent: cost > 0 ? '#c9a400' : undefined }),
    ],
  })
}

function Legend({ snapshot }) {
  const ps = snapshot.profiles || []
  return jsx('div', {
    className: 'flex flex-wrap gap-1.5',
    children: ps.map((p) => {
      const r = roleOf(p.profile)
      const st = p.busy ? 'работает' : p.online ? 'свободен' : 'не на смене'
      const title = p.task && p.task.title ? p.task.title : undefined
      return jsxs(
        'div',
        {
          title,
          className: 'flex items-center gap-1.5 rounded border border-[var(--ui-stroke-secondary)] px-2 py-0.5 text-xs',
          style: { opacity: p.online ? 1 : 0.55 },
          children: [
            jsx('span', { style: { width: 8, height: 8, background: r.shirt, display: 'inline-block' } }),
            jsx('span', { className: 'text-[var(--ui-text-secondary)]', children: r.label }),
            jsx('span', { className: 'text-[var(--ui-text-tertiary)]', children: '· ' + st }),
          ],
        },
        p.profile
      )
    }),
  })
}

const HELP = [
  'Каждый человек — профиль Hermes, у каждого свой ПК. Основной профиль (default) — Оркестратор: он отвечает вам в чате и в Telegram и раздаёт задачи остальным.',
  'Сидит за своим ПК спиной к вам — работает прямо сейчас (есть активная сессия или задача «В работе» в Kanban). Над монитором — название задачи.',
  'По экрану видно, чем занят агент: у разработчика бежит код, у дизайнера макет, у тестировщика галочки тестов, у DevOps терминал, у ревьюера diff, у исследователя браузер, у архитектора схема, у прод-оператора дашборд, у Оркестратора мини-доска задач.',
  'Пьёт чай в холле, сидит в переговорной или смотрит на доску — на смене и свободен: gateway запущен, диспетчер Kanban может выдать ему задачу. На его мониторе — заставка.',
  'Никого нет, мониторы погашены — gateway выключен, все ушли домой.',
  'Чтобы в офисе закипела работа: создайте карточку в Kanban и назначьте исполнителя — диспетчер сам посадит агента за ПК. Или напишите Оркестратору: «разбей и раздай по команде: …». Или откройте чат с нужным профилем.',
  'Доска в переговорной — живой Kanban: клик по ней открывает доску. Наведите на человечка или его монитор — увидите задачу, токены и расходы.',
]

function Help() {
  return jsxs('details', {
    className: 'rounded-md border border-[var(--ui-stroke-secondary)] px-3 py-2 text-sm',
    children: [
      jsx('summary', {
        className: 'cursor-pointer select-none font-medium text-[var(--ui-text-secondary)]',
        children: 'Как пользоваться офисом',
      }),
      jsx('ul', {
        className: 'mt-2 flex list-disc flex-col gap-1 pl-5 text-[var(--ui-text-tertiary)]',
        children: HELP.map((t, i) => jsx('li', { children: t }, i)),
      }),
    ],
  })
}

function OfficePage({ ctx }) {
  const query = useQuery({
    queryKey: ['sulfgreyrat-office', 'state'],
    queryFn: () => ctx.rest('/state'),
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : 4000),
    refetchOnWindowFocus: true,
  })

  let body
  if (query.isError) {
    body = jsx(ErrorState, {
      title: 'Не удалось получить состояние офиса',
      description: String((query.error && query.error.message) || query.error || 'unknown error'),
    })
  } else if (query.data && Array.isArray(query.data.profiles) && query.data.profiles.length === 0) {
    body = jsx(EmptyState, { title: 'Профили не найдены', description: 'В HERMES_HOME нет ни одного профиля.' })
  } else {
    const snap = query.data || null
    body = jsxs('div', {
      className: 'flex min-h-0 w-full flex-1 flex-col gap-3',
      children: [
        jsx(OfficeCanvas, { snapshot: snap }),
        snap ? jsx(Stats, { snapshot: snap }) : null,
        snap ? jsx(Legend, { snapshot: snap }) : null,
        jsx(Help, {}),
      ],
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 w-full flex-col gap-3 overflow-auto p-4',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-baseline justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-baseline gap-2',
            children: [
              jsx('h1', { className: 'text-lg font-semibold text-[var(--ui-text-secondary)]', children: "SulfGreyrat's office" }),
              jsx('span', {
                className: 'text-xs text-[var(--ui-text-tertiary)]',
                children: 'пиксельный офис агентов Hermes',
              }),
            ],
          }),
          jsx('span', { className: 'text-xs text-[var(--ui-text-tertiary)]', children: 'живые данные · каждые 4 с' }),
        ],
      }),
      body,
    ],
  })
}

// ---------------------------------------------------------------------------
// Регистрация
// ---------------------------------------------------------------------------
export default {
  id: 'sulfgreyrat-office',
  name: "SulfGreyrat's office",
  description: 'Пиксельный офис агентов Hermes в интерьере учебного центра ADVANCE · by SulfGreyrat',
  defaultEnabled: true,
  register(c) {
    const ctx = c
    c.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/sulfgreyrat-office' },
      render: () => jsx(OfficePage, { ctx }),
    })
    c.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/sulfgreyrat-office', label: "SulfGreyrat's office", codicon: 'mortar-board' },
    })
  },
}

// Для офлайн-проверки сцены (tests/harness.html); приложению не нужно.
export const __test = { createScene, W, H, SEATS, IDLE_SPOTS, buildGrid, bfs }
