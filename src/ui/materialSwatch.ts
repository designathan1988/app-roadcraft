import type { Finish } from '@world/buildings/materials';

/**
 * A tile's picture for a finish: the surface itself, drawn rather than
 * lettered. Thirteen rollers painted the same glyph before this, which named
 * the materials without showing any of them.
 *
 * The colours are the finish's own character - brick is brick-red before it is
 * painted - and the pattern is what tells one from another at 56 px.
 */

const BASE: Readonly<Record<Finish, string>> = {
  plaster: '#e6e0d4',
  stucco: '#dcd4c4',
  ceramic: '#cfd6da',
  brick: '#a4563f',
  stone: '#b7b2a6',
  concrete: '#b4b4b0',
  wood: '#9c6b43',
  metal: '#9aa3a8',
  glass: '#9db6c2',
  tile: '#bd6a52',
  slate: '#585b5f',
  panel: '#8f9ba5',
  roofing: '#7b4a37',
};

/** A darker shade of a hex colour, for mortar, seams and shadow. */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const mix = (channel: number): number => Math.max(0, Math.min(255, Math.round(channel * (1 + amount))));
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff);
  const b = mix(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function draw(ctx: CanvasRenderingContext2D, finish: Finish, size: number): void {
  const base = BASE[finish];
  const dark = shade(base, -0.3);
  const light = shade(base, 0.22);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const line = (x0: number, y0: number, x1: number, y1: number, colour: string, width = 1): void => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };

  switch (finish) {
    case 'plaster':
    case 'concrete': {
      // Flat and matte: a breath of noise, and a form line on concrete.
      ctx.fillStyle = shade(base, -0.06);
      for (let i = 0; i < 90; i++) {
        ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
      }
      if (finish === 'concrete') {
        line(0, size * 0.55, size, size * 0.55, shade(base, -0.16));
        line(size * 0.5, 0, size * 0.5, size, shade(base, -0.1));
      }
      break;
    }
    case 'stucco': {
      ctx.fillStyle = shade(base, -0.12);
      for (let i = 0; i < 240; i++) {
        const r = 0.6 + Math.random();
        ctx.beginPath();
        ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'ceramic': {
      const step = size / 3;
      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? base : shade(base, -0.07);
          ctx.fillRect(x * step + 1, y * step + 1, step - 2, step - 2);
        }
      }
      ctx.strokeStyle = shade(base, -0.25);
      for (let i = 1; i < 3; i++) {
        line(i * step, 0, i * step, size, shade(base, -0.25));
        line(0, i * step, size, i * step, shade(base, -0.25));
      }
      break;
    }
    case 'brick': {
      const course = size / 4;
      ctx.fillStyle = shade(base, -0.22);
      ctx.fillRect(0, 0, size, size);
      for (let row = 0; row < 4; row++) {
        const offset = row % 2 === 0 ? 0 : -size / 6;
        for (let col = -1; col < 4; col++) {
          ctx.fillStyle = row % 2 === 0 ? base : shade(base, -0.06);
          ctx.fillRect(col * (size / 3) + offset + 2, row * course + 2, size / 3 - 3, course - 3);
        }
      }
      break;
    }
    case 'stone': {
      let seed = 7;
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 14; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = size * (0.18 + rand() * 0.22);
        const h = size * (0.14 + rand() * 0.2);
        ctx.fillStyle = shade(base, -0.25 + rand() * 0.35);
        ctx.beginPath();
        ctx.ellipse(x, y, w / 2, h / 2, rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = shade(base, -0.32);
        ctx.stroke();
      }
      break;
    }
    case 'wood': {
      const plank = size / 4;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 === 0 ? base : shade(base, -0.07);
        ctx.fillRect(i * plank, 0, plank - 1, size);
        line(i * plank, 0, i * plank, size, shade(base, -0.3));
      }
      ctx.strokeStyle = shade(base, -0.16);
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        line(x, y, x + 2 + Math.random() * 5, y + 1, shade(base, -0.18));
      }
      break;
    }
    case 'metal': {
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, light);
      gradient.addColorStop(0.45, base);
      gradient.addColorStop(0.5, light);
      gradient.addColorStop(1, dark);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      line(size * 0.5, 0, size * 0.5, size, shade(base, -0.35));
      break;
    }
    case 'glass': {
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, light);
      gradient.addColorStop(0.5, base);
      gradient.addColorStop(1, dark);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.moveTo(size * 0.16, size);
      ctx.lineTo(size * 0.44, 0);
      ctx.lineTo(size * 0.62, 0);
      ctx.lineTo(size * 0.34, size);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = shade(base, -0.4);
      ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
      break;
    }
    case 'tile':
    case 'roofing': {
      const rows = finish === 'tile' ? 3 : 5;
      const step = size / rows;
      for (let row = 0; row < rows; row++) {
        ctx.fillStyle = row % 2 === 0 ? base : shade(base, -0.1);
        ctx.fillRect(0, row * step, size, step - 1);
        line(0, row * step, size, row * step, shade(base, -0.35), 1.4);
        if (finish === 'tile') {
          for (let x = 0; x < 4; x++) line(x * (size / 4), row * step, x * (size / 4), (row + 1) * step, shade(base, -0.28));
        }
      }
      break;
    }
    case 'slate': {
      const rows = 4;
      const step = size / rows;
      for (let row = 0; row < rows; row++) {
        const offset = row % 2 === 0 ? 0 : -size / 6;
        for (let col = -1; col < 4; col++) {
          ctx.fillStyle = shade(base, -0.16 + ((row + col) % 3) * 0.09);
          ctx.beginPath();
          ctx.moveTo(col * (size / 3) + offset + 1, row * step + 1);
          ctx.lineTo(col * (size / 3) + offset + size / 3 - 1, row * step + 1);
          ctx.lineTo(col * (size / 3) + offset + size / 3 - 1, (row + 1) * step - 2);
          ctx.lineTo(col * (size / 3) + offset + 1, (row + 1) * step - 1);
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }
    case 'panel': {
      const step = size / 4;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 === 0 ? base : shade(base, -0.08);
        ctx.fillRect(0, i * step + 1, size, step - 2);
        line(0, i * step, size, i * step, shade(base, -0.32));
      }
      break;
    }
  }
}

/** Drawn once per finish: the tray asks for these on every redraw. */
const CACHE = new Map<string, string>();

export function materialSwatch(finish: Finish, size = 56, dpr = 2): string {
  const key = `${finish}|${size}@${dpr}`;
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);
  draw(ctx, finish, size);
  const url = canvas.toDataURL('image/png');
  CACHE.set(key, url);
  return url;
}
