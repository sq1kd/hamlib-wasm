/**
 * The landing page's background: an FT8 waterfall drawn the way WSJT-X draws
 * one.
 *
 * Audio frequency runs across (200-3000 Hz) and time runs down, a new row on
 * top every 100 ms.  FT8 is 8-FSK at 6.25 Hz spacing, 0.16 s a symbol and
 * 12.64 s on air inside a 15 s slot, so each station is a ~50 Hz bar with a
 * stepping bright tone and a quiet gap before the next slot; even and odd
 * slots carry different stations.  Noise follows an SSB receive filter.
 *
 * It is decoration: synthetic, seeded, and never read from a radio.  It rests
 * on one still frame under reduced motion and stops while off-screen or in a
 * background tab.
 */

const F0 = 200;
const F1 = 3000;
const ROW_S = 0.1;
const SLOT_S = 15;
const TX_S = 12.64;
const SYM_S = 0.16;

/* The page ground, through deep teal, to the accent and a near-white core:
 * position, then red, green, blue. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 7, 9, 12],
  [0.28, 9, 22, 30],
  [0.5, 14, 58, 62],
  [0.72, 44, 160, 140],
  [0.88, 89, 224, 197],
  [1, 226, 255, 248],
];

interface Station {
  readonly f: number;
  readonly a: number;
  readonly qsb: number;
  readonly qsbRate: number;
  readonly dt: number;
  readonly tones: readonly number[];
}

function palette(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);

  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const k = Math.max(1, STOPS.findIndex(([at]) => v <= at));
    const [a = 0, ...ca] = STOPS[k - 1] ?? [];
    const [b = 1, ...cb] = STOPS[k] ?? [];
    const t = (v - a) / (b - a);

    for (let c = 0; c < 3; c++) {
      const from = ca[c] ?? 0;

      lut[i * 3 + c] = from + ((cb[c] ?? 0) - from) * t;
    }
  }

  return lut;
}

export function startWaterfall(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d', { alpha: false });

  if (ctx === null) {
    return;
  }

  const W = canvas.width;
  const H = canvas.height;
  const hz = (F1 - F0) / W;
  const lut = palette();

  let seed = 20261106;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;

    return seed / 2147483647;
  };
  const noise = (): number => (rnd() + rnd() + rnd() + rnd()) / 4;

  /* Receiver passband: flat 300-2700 Hz, soft skirts outside. */
  const floor = new Float32Array(W);

  for (let x = 0; x < W; x++) {
    const f = F0 + x * hz;
    const lo = Math.min(1, Math.max(0, (f - 220) / 120));
    const hi = Math.min(1, Math.max(0, (2850 - f) / 180));

    floor[x] = 0.1 + 0.16 * lo * hi;
  }

  const stations = (n: number): Station[] => Array.from({ length: n }, () => ({
    f: 320 + rnd() * 2300,
    a: 0.12 + rnd() ** 2.2 * 0.75,
    qsb: rnd() * 6.28,
    qsbRate: 0.2 + rnd() * 0.6,
    dt: -0.2 + rnd() * 1.2,
    tones: Array.from({ length: 79 }, () => Math.floor(rnd() * 8)),
  }));

  const slots = new Map<number, Station[]>();
  const slotAt = (i: number): Station[] => {
    let slot = slots.get(i);

    if (slot === undefined) {
      slot = stations(i % 2 === 0 ? 15 : 11);
      slots.set(i, slot);
      slots.delete(i - 4);
    }

    return slot;
  };

  const row = ctx.createImageData(W, 1);
  const px = row.data;
  const line = new Float32Array(W);
  const prev = new Float32Array(W);
  let t = 0;

  const drawRow = (): void => {
    for (let x = 0; x < W; x++) {
      line[x] = (floor[x] ?? 0) * (0.55 + noise() * 0.9);
    }

    const slot = Math.floor(t / SLOT_S);
    const inSlot = t - slot * SLOT_S;

    for (const s of slotAt(slot)) {
      const on = inSlot - 0.5 - s.dt;

      if (on < 0 || on > TX_S) {
        continue;
      }

      const tone = s.tones[Math.min(78, Math.floor(on / SYM_S))] ?? 0;
      const amp = s.a * (0.75 + 0.25 * Math.sin(s.qsb + t * s.qsbRate));
      const fc = (s.f + tone * 6.25 - F0) / hz;
      const base = (s.f - F0) / hz;
      const span = 50 / hz;
      const x0 = Math.max(0, Math.floor(base - 4));
      const x1 = Math.min(W - 1, Math.floor(base + span + 4));

      for (let x = x0; x <= x1; x++) {
        const d = x - fc;

        line[x] = (line[x] ?? 0)
          + amp * 0.8 * Math.exp(-(d * d) / 9)
          + amp * 0.42 * Math.exp(-(((x - base - span / 2) / (span * 0.55)) ** 4));
      }
    }

    /* WSJT-X averages a few FFTs a row, and marks each 15 s with a faint line. */
    const tick = inSlot < ROW_S ? 0.06 : 0;

    for (let x = 0; x < W; x++) {
      const smooth = (prev[x] ?? 0) * 0.45 + (line[x] ?? 0) * 0.55;
      const i = Math.min(255, Math.max(0, Math.floor((smooth + tick) * 255))) * 3;
      const o = x * 4;

      prev[x] = smooth;
      px[o] = lut[i] ?? 0;
      px[o + 1] = lut[i + 1] ?? 0;
      px[o + 2] = lut[i + 2] ?? 0;
      px[o + 3] = 255;
    }

    ctx.drawImage(canvas, 0, 0, W, H - 1, 0, 1, W, H - 1);
    ctx.putImageData(row, 0, 0);
    t += ROW_S;
  };

  /* Fill the screen with history so it never starts empty. */
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--hw-bg');
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < H; i++) {
    drawRow();
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sync = (): void => {
    clearInterval(timer);
    timer = undefined;

    if (visible && !document.hidden && !reduced.matches) {
      timer = setInterval(drawRow, ROW_S * 1000);
    }
  };

  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    sync();
  }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  sync();
}
