import * as THREE from 'three';
import type { MaterialPreset, SurfaceMaterialSettings } from '../types/plan';
import {
  getMaterialCapabilities,
  getMaterialPresetMeta,
  isPresetPreTinted,
} from '../data/materials';
import { resolvePatternMetrics } from './materialPattern';

const oakTexUrl = new URL('../assets/images/oak_wood_tex_1794957035530.jpg', import.meta.url).href;
const walnutTexUrl = new URL('../assets/images/walnut_wood_tex_1794957036232.jpg', import.meta.url).href;
const carraraTexUrl = new URL('../assets/images/carrara_marble_tex_1794957035647.jpg', import.meta.url).href;
const travertineTexUrl = new URL('../assets/images/travertine_stone_tex_1794957036064.jpg', import.meta.url).href;
const concreteTexUrl = new URL('../assets/images/concrete_surface_tex_1794957037740.jpg', import.meta.url).href;
const brickTexUrl = new URL('../assets/images/red_brick_tex_1794957037947.jpg', import.meta.url).href;
const leatherTexUrl = new URL('../assets/images/cognac_leather_tex_1794957039190.jpg', import.meta.url).href;
const linenTexUrl = new URL('../assets/images/linen_weave_tex_1794957054268.jpg', import.meta.url).href;
const terrazzoTexUrl = new URL('../assets/images/terrazzo_stone_tex_1794957056077.jpg', import.meta.url).href;
const boucleTexUrl = new URL('../assets/images/boucle_wool_tex_1794957070945.jpg', import.meta.url).href;
const slateTexUrl = new URL('../assets/images/slate_stone_tex_1794957071075.jpg', import.meta.url).href;

type TexRole = 'albedo' | 'bump' | 'roughness';

const TEXTURE_CACHE = new Map<string, THREE.CanvasTexture>();
const MAX_TEXTURE_CACHE_ENTRIES = 128;
const IMAGE_CACHE = new Map<string, HTMLImageElement>();
const PENDING_DRAWS = new Map<string, Array<() => void>>();

function setCachedTexture(key: string, tex: THREE.CanvasTexture): void {
  if (TEXTURE_CACHE.has(key)) {
    TEXTURE_CACHE.delete(key);
  }
  TEXTURE_CACHE.set(key, tex);
  while (TEXTURE_CACHE.size > MAX_TEXTURE_CACHE_ENTRIES) {
    const oldestKey = TEXTURE_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestTex = TEXTURE_CACHE.get(oldestKey);
    TEXTURE_CACHE.delete(oldestKey);
    oldestTex?.dispose();
  }
}

let onTextureReadyCallback: (() => void) | null = null;

export function setTextureReadyCallback(cb: (() => void) | null): void {
  onTextureReadyCallback = cb;
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function makeCanvas(size = 512): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = (hex || '#FFFFFF').replace('#', '');
  if (clean.length !== 6) return [248, 250, 252];
  const n = parseInt(clean, 16);
  if (Number.isNaN(n)) return [248, 250, 252];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function getSourceImageUrl(preset: MaterialPreset): string | null {
  switch (preset) {
    case 'wood':
    case 'oak':
    case 'oak_wide':
    case 'teak':
    case 'smoked_oak':
    case 'wood_strip':
    case 'parquet':
    case 'herringbone':
    case 'chevron':
    case 'basketweave':
    case 'paneling':
      return oakTexUrl;
    case 'walnut':
      return walnutTexUrl;
    case 'marble':
    case 'calacatta_gold':
    case 'nero_marble':
      return carraraTexUrl;
    case 'travertine':
    case 'limestone':
      return travertineTexUrl;
    case 'slate':
      return slateTexUrl;
    case 'concrete':
    case 'microcement':
    case 'plaster':
    case 'stucco':
      return concreteTexUrl;
    case 'brick':
      return brickTexUrl;
    case 'terrazzo':
      return terrazzoTexUrl;
    case 'fabric':
    case 'wallpaper':
    case 'velvet':
      return linenTexUrl;
    case 'boucle':
      return boucleTexUrl;
    case 'leather_cognac':
    case 'leather_black':
    case 'leather_cream':
      return leatherTexUrl;
    default:
      return null;
  }
}

function requestImage(url: string, onReady: () => void): HTMLImageElement | null {
  const existing = IMAGE_CACHE.get(url);
  if (existing && existing.complete && existing.naturalWidth > 0) {
    return existing;
  }
  const waiters = PENDING_DRAWS.get(url);
  if (waiters) {
    waiters.push(onReady);
    return null;
  }

  PENDING_DRAWS.set(url, [onReady]);
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      IMAGE_CACHE.set(url, img);
      const list = PENDING_DRAWS.get(url) ?? [];
      PENDING_DRAWS.delete(url);
      for (const fn of list) fn();
      onTextureReadyCallback?.();
    };
    img.onerror = () => {
      PENDING_DRAWS.delete(url);
    };
    img.src = url;
  }
  return null;
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

interface ProceduralDrawParams {
  primaryColor?: string;
  secondaryColor?: string;
  groutRatio: number;
  staggerPct: number;
}

/**
 * Draws crisp procedural textures (tiles, subway tiles, porcelain, penny mosaic,
 * 2x2 checker, harlequin, encaustic, pinwheel, hex, striped wallpaper, wainscot, brushed metal)
 * synchronized 1:1 with SVG vector patterns.
 */
function drawFallbackOrPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  preset: MaterialPreset,
  role: TexRole,
  params: ProceduralDrawParams
) {
  const isBump = role === 'bump';
  const isRough = role === 'roughness';
  const groutPx = Math.max(0, Math.min(size * 0.08, params.groutRatio * size));
  const groutLineW = Math.max(2, groutPx);
  const tileA = params.primaryColor || '#F8FAFC';
  const tileB = params.secondaryColor || '#94A3B8';

  if (
    preset === 'tile' ||
    preset === 'subway_tile' ||
    preset === 'porcelain_slab' ||
    preset === 'limestone'
  ) {
    const baseHex = isBump ? '#EAEAEA' : isRough ? '#585858' : tileA;
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, size, size);

    const cells = 2;
    const step = size / cells;
    const stagRatio =
      preset === 'subway_tile' ? params.staggerPct / 100 : (params.staggerPct || 0) / 100;
    const [pr, pg, pb] = hexToRgb(tileA);

    for (let r = 0; r < cells; r++) {
      const rowOffset = r % 2 === 1 ? stagRatio * step : 0;
      for (let c = -1; c <= cells; c++) {
        const x = c * step + rowOffset;
        const y = r * step;
        const j = ((r * 7 + (c + 3) * 11) % 7) - 3;
        if (isBump) {
          const v = 238 + j;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else if (isRough) {
          const v = 58 + j * 3;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else {
          ctx.fillStyle = `rgb(${clampByte(pr + j * 1.4)},${clampByte(pg + j * 1.4)},${clampByte(pb + j * 1.4)})`;
        }
        ctx.fillRect(x + groutLineW * 0.5, y + groutLineW * 0.5, step - groutLineW, step - groutLineW);
      }
    }

    if (groutPx > 0.25) {
      ctx.strokeStyle = isBump ? '#323232' : isRough ? '#DCDCDC' : tileB;
      ctx.lineWidth = groutLineW;
      for (let r = 0; r <= cells; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * step);
        ctx.lineTo(size, r * step);
        ctx.stroke();
      }
      for (let r = 0; r < cells; r++) {
        const rowOffset = r % 2 === 1 ? stagRatio * step : 0;
        for (let c = -1; c <= cells + 1; c++) {
          const x = c * step + rowOffset;
          ctx.beginPath();
          ctx.moveTo(x, r * step);
          ctx.lineTo(x, (r + 1) * step);
          ctx.stroke();
        }
      }
    }
    return;
  }

  if (preset === 'hex_tile') {
    ctx.fillStyle = isBump ? '#EAEAEA' : isRough ? '#5C5C5C' : tileA;
    ctx.fillRect(0, 0, size, size);
    const r = size / 11;
    const dx = r * 1.5;
    const dy = r * Math.sqrt(3);
    const [pr, pg, pb] = hexToRgb(tileA);
    ctx.strokeStyle = isBump ? '#383838' : isRough ? '#DCDCDC' : tileB;
    ctx.lineWidth = Math.max(2, groutLineW);
    for (let col = -1; col < 10; col++) {
      for (let row = -1; row < 10; row++) {
        const cx = col * dx;
        const cy = row * dy + (col % 2 === 0 ? 0 : dy / 2);
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const ang = (Math.PI / 3) * k;
          const hx = cx + r * Math.cos(ang);
          const hy = cy + r * Math.sin(ang);
          if (k === 0) ctx.moveTo(hx, hy);
          else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        const alt = (col + row * 2) % 3;
        if (isBump) {
          const v = 234 + alt * 5;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else if (isRough) {
          const v = 62 + alt * 8;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else {
          ctx.fillStyle = `rgb(${clampByte(pr - alt * 3)},${clampByte(pg - alt * 3)},${clampByte(pb - alt * 3)})`;
        }
        ctx.fill();
        if (groutPx > 0.2) ctx.stroke();
      }
    }
    return;
  }

  if (preset === 'penny_tile') {
    ctx.fillStyle = isBump ? '#3C3C3C' : isRough ? '#DCDCDC' : tileB;
    ctx.fillRect(0, 0, size, size);
    const cols = 6;
    const rows = 6;
    const stepX = size / cols;
    const stepY = size / rows;
    const rad = Math.max(6, Math.min(stepX, stepY) * 0.44 - groutLineW * 0.4);
    const [pr, pg, pb] = hexToRgb(tileA);
    for (let r = 0; r < rows; r++) {
      const shiftX = r % 2 === 1 ? stepX * 0.5 : 0;
      for (let c = -1; c <= cols; c++) {
        const cx = (c + 0.5) * stepX + shiftX;
        const cy = (r + 0.5) * stepY;
        const j = ((r * 13 + c * 7) % 7) - 3;
        if (isBump) {
          const v = 238 + j;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else if (isRough) {
          const v = 52 + j * 3;
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        } else {
          ctx.fillStyle = `rgb(${clampByte(pr + j * 1.4)},${clampByte(pg + j * 1.4)},${clampByte(pb + j * 1.4)})`;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return;
  }

  if (preset === 'checker') {
    // 2x2 grid strictly matching 2D & Wall View SVG
    const cells = 2;
    const step = size / cells;
    ctx.fillStyle = isBump ? '#EAEAEA' : isRough ? '#666666' : tileA;
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const even = (r + c) % 2 === 0;
        ctx.fillStyle = isBump
          ? even
            ? '#EEEEEE'
            : '#D8D8D8'
          : isRough
            ? even
              ? '#5E5E5E'
              : '#787878'
            : even
              ? tileA
              : tileB;
        ctx.fillRect(c * step, r * step, step, step);
        if (groutPx > 0.25) {
          ctx.strokeStyle = isBump ? '#3A3A3A' : isRough ? '#D8D8D8' : 'rgba(100,116,139,0.28)';
          ctx.lineWidth = groutLineW;
          ctx.strokeRect(c * step, r * step, step, step);
        }
      }
    }
    return;
  }

  if (preset === 'harlequin') {
    ctx.fillStyle = isBump ? '#EAEAEA' : isRough ? '#626262' : tileA;
    ctx.fillRect(0, 0, size, size);
    const half = size / 2;
    ctx.fillStyle = isBump ? '#D6D6D6' : isRough ? '#7A7A7A' : tileB;
    ctx.beginPath();
    ctx.moveTo(half, 0);
    ctx.lineTo(size, half);
    ctx.lineTo(half, size);
    ctx.lineTo(0, half);
    ctx.closePath();
    ctx.fill();
    if (groutPx > 0.25) {
      ctx.strokeStyle = isBump ? '#383838' : isRough ? '#DCDCDC' : 'rgba(100,116,139,0.32)';
      ctx.lineWidth = groutLineW;
      ctx.stroke();
    }
    return;
  }

  if (preset === 'encaustic_tile') {
    ctx.fillStyle = isBump ? '#EAEAEA' : isRough ? '#9A9A9A' : tileA;
    ctx.fillRect(0, 0, size, size);
    const cells = 2;
    const step = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const cx = (c + 0.5) * step;
        const cy = (r + 0.5) * step;
        const outer = step * 0.4;
        const inner = step * 0.14;
        ctx.fillStyle = isBump ? '#D8D8D8' : isRough ? '#B5B5B5' : tileB;
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const ang = (k * Math.PI) / 4;
          const rad = k % 2 === 0 ? outer : inner;
          const px = cx + rad * Math.cos(ang);
          const py = cy + rad * Math.sin(ang);
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    if (groutPx > 0.2) {
      ctx.strokeStyle = isBump ? '#363636' : isRough ? '#DCDCDC' : 'rgba(100,116,139,0.38)';
      ctx.lineWidth = groutLineW;
      ctx.strokeRect(0, 0, size, size);
      ctx.beginPath();
      ctx.moveTo(size / 2, 0);
      ctx.lineTo(size / 2, size);
      ctx.moveTo(0, size / 2);
      ctx.lineTo(size, size / 2);
      ctx.stroke();
    }
    return;
  }

  if (preset === 'pinwheel_tile') {
    ctx.fillStyle = isBump ? '#EAEAEA' : isRough ? '#646464' : tileA;
    ctx.fillRect(0, 0, size, size);
    const half = size / 2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const ox = c * half;
        const oy = r * half;
        const cab = half * 0.31;
        const pad = (half - cab) / 2;
        ctx.fillStyle = isBump ? '#D2D2D2' : isRough ? '#868686' : tileB;
        ctx.fillRect(ox + pad, oy + pad, cab, cab);
        ctx.strokeStyle = isBump ? '#383838' : isRough ? '#DCDCDC' : 'rgba(100,116,139,0.42)';
        ctx.lineWidth = Math.max(2, groutLineW);
        ctx.strokeRect(ox, oy, half, half);
        ctx.beginPath();
        ctx.moveTo(ox, oy + pad);
        ctx.lineTo(ox + pad + cab, oy + pad);
        ctx.moveTo(ox + pad, oy);
        ctx.lineTo(ox + pad, oy + pad + cab);
        ctx.moveTo(ox + pad, oy + pad + cab);
        ctx.lineTo(ox + half, oy + pad + cab);
        ctx.moveTo(ox + pad + cab, oy + pad);
        ctx.lineTo(ox + pad + cab, oy + half);
        ctx.stroke();
      }
    }
    return;
  }

  if (preset === 'striped_wallpaper') {
    ctx.fillStyle = isBump ? '#E0E0E0' : isRough ? '#B2B2B2' : tileA;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = isBump ? '#C8C8C8' : isRough ? '#989898' : tileB;
    ctx.fillRect(0, 0, size / 2, size);
    for (let x = 0; x < size; x += 6) {
      ctx.fillStyle = isBump ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, 0, 2, size);
    }
    return;
  }

  if (preset === 'ribbed_paneling') {
    ctx.fillStyle = isBump ? '#ECECEC' : isRough ? '#787878' : tileA;
    ctx.fillRect(0, 0, size, size);
    const cols = 4;
    const cw = size / cols;
    const grooveW = Math.max(4, groutLineW * 1.4);
    for (let c = 0; c < cols; c++) {
      const gx = c * cw;
      ctx.fillStyle = isBump ? '#3A3A3A' : isRough ? '#CCCCCC' : tileB;
      ctx.fillRect(gx, 0, grooveW, size);
      ctx.fillStyle = isBump ? '#FFFFFF' : 'rgba(255,255,255,0.22)';
      ctx.fillRect(gx + grooveW, 0, Math.max(2, grooveW * 0.5), size);
    }
    return;
  }

  // Brushed metal anisotropic micro-streaks
  if (
    preset === 'metal' ||
    preset === 'brass' ||
    preset === 'bronze' ||
    preset === 'chrome' ||
    preset === 'matte_black_metal'
  ) {
    const baseHex =
      preset === 'brass'
        ? '#D6B162'
        : preset === 'bronze'
          ? '#654F3D'
          : preset === 'matte_black_metal'
            ? '#333840'
            : preset === 'chrome'
              ? '#F1F5F9'
              : '#DDE3EA';
    ctx.fillStyle = isBump ? '#C8C8C8' : isRough ? '#787878' : baseHex;
    ctx.fillRect(0, 0, size, size);
    const streakCount = preset === 'chrome' ? 180 : 550;
    for (let i = 0; i < streakCount; i++) {
      const y = (i * 197 + 13) % size;
      const x = (i * 313 + 7) % size;
      const w = 60 + (i % 180);
      const light = i % 2 === 0;
      ctx.fillStyle = isBump
        ? light
          ? 'rgba(255,255,255,0.14)'
          : 'rgba(40,40,40,0.14)'
        : isRough
          ? light
            ? 'rgba(200,200,200,0.16)'
            : 'rgba(70,70,70,0.16)'
          : light
            ? 'rgba(255,255,255,0.10)'
            : 'rgba(15,23,42,0.08)';
      ctx.fillRect(x, y, w, 1.5);
    }
    return;
  }

  // Fallback high-key tone for plaster / paint / wood / stone before image finishes decoding
  const meta = getMaterialPresetMeta(preset);
  ctx.fillStyle = isBump ? '#C8C8C8' : isRough ? '#B8B8B8' : isPresetPreTinted(preset) ? meta.previewBase : '#F7F7F5';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = (i * 173 + 19) % size;
    const y = (i * 257 + 41) % size;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.045)';
    ctx.fillRect(x, y, 4 + (i % 6), 2);
  }
}

/**
 * Draws the loaded photo into the canvas and applies calibrated grading / derived PBR bump & roughness
 */
function renderPhotoDerivedTexture(
  ctx: CanvasRenderingContext2D,
  size: number,
  img: HTMLImageElement,
  preset: MaterialPreset,
  role: TexRole,
  params: ProceduralDrawParams
) {
  ctx.fillStyle = getMaterialPresetMeta(preset).previewBase;
  ctx.fillRect(0, 0, size, size);

  const groutPx = Math.max(1.5, Math.min(18, params.groutRatio * size));

  if (
    preset === 'parquet' ||
    preset === 'wood' ||
    preset === 'oak' ||
    preset === 'oak_wide' ||
    preset === 'walnut' ||
    preset === 'teak' ||
    preset === 'smoked_oak' ||
    preset === 'wood_strip'
  ) {
    const planks = preset === 'oak_wide' ? 3 : preset === 'wood_strip' ? 6 : 4;
    const pw = size / planks;
    const stagFrac = Math.max(0.05, Math.min(0.85, (params.staggerPct || 50) / 100));
    for (let i = 0; i < planks; i++) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(i * pw, 0, pw, size);
      ctx.clip();
      const shiftX = ((i % 2) * size) / 2;
      const shiftY = (i * 137) % size;
      for (const ox of [shiftX - size, shiftX]) {
        for (const oy of [shiftY - size, shiftY]) {
          ctx.drawImage(img, ox, oy, size, size);
        }
      }
      ctx.restore();

      const grooveColor =
        role === 'bump'
          ? 'rgba(20,20,20,0.45)'
          : role === 'roughness'
            ? 'rgba(220,220,220,0.35)'
            : 'rgba(42,26,14,0.26)';
      ctx.strokeStyle = grooveColor;
      ctx.lineWidth = Math.max(1.6, groutPx * 0.85);
      ctx.beginPath();
      ctx.moveTo(i * pw, 0);
      ctx.lineTo(i * pw, size);
      ctx.stroke();
      const crossY = ((i * stagFrac * size * 0.72) + size * 0.25) % size;
      ctx.beginPath();
      ctx.moveTo(i * pw, crossY);
      ctx.lineTo((i + 1) * pw, crossY);
      ctx.stroke();
    }
  } else if (preset === 'herringbone') {
    const cols = 4;
    const colW = size / cols;
    const blkH = size / 4;
    ctx.drawImage(img, 0, 0, size, size);
    for (let r = -1; r < 5; r++) {
      for (let c = 0; c < cols; c++) {
        const y = r * blkH + (c % 2 === 0 ? 0 : blkH * 0.5);
        ctx.save();
        ctx.translate(c * colW + colW / 2, y + blkH / 2);
        ctx.rotate(c % 2 === 0 ? Math.PI * 0.25 : -Math.PI * 0.25);
        ctx.drawImage(img, -colW * 0.7, -blkH * 0.45, colW * 1.4, blkH * 0.9);
        ctx.strokeStyle = role === 'bump' ? 'rgba(20,20,20,0.4)' : 'rgba(38,24,12,0.30)';
        ctx.lineWidth = Math.max(1.6, groutPx * 0.8);
        ctx.strokeRect(-colW * 0.68, -blkH * 0.42, colW * 1.36, blkH * 0.84);
        ctx.restore();
      }
    }
  } else if (preset === 'chevron') {
    const cols = 4;
    const colW = size / cols;
    const rowH = size / 4;
    ctx.drawImage(img, 0, 0, size, size);
    for (let r = -1; r < 5; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * colW;
        const y0 = r * rowH;
        const dir = c % 2 === 0 ? 1 : -1;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x0, dir > 0 ? y0 + rowH * 0.5 : y0);
        ctx.lineTo(x0 + colW, dir > 0 ? y0 : y0 + rowH * 0.5);
        ctx.lineTo(x0 + colW, dir > 0 ? y0 + rowH : y0 + rowH * 1.5);
        ctx.lineTo(x0, dir > 0 ? y0 + rowH * 1.5 : y0 + rowH);
        ctx.closePath();
        ctx.clip();
        ctx.translate(x0 + colW / 2, y0 + rowH * 0.75);
        ctx.rotate(dir > 0 ? -Math.PI * 0.22 : Math.PI * 0.22);
        ctx.drawImage(img, -colW, -rowH, colW * 2, rowH * 2);
        ctx.restore();

        ctx.strokeStyle = role === 'bump' ? 'rgba(20,20,20,0.42)' : 'rgba(38,24,12,0.28)';
        ctx.lineWidth = Math.max(1.6, groutPx * 0.8);
        ctx.beginPath();
        ctx.moveTo(x0, dir > 0 ? y0 + rowH * 0.5 : y0);
        ctx.lineTo(x0 + colW, dir > 0 ? y0 : y0 + rowH * 0.5);
        ctx.stroke();
      }
    }
  } else if (preset === 'basketweave') {
    const half = size / 2;
    const strip = half / 3;
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        const horizontal = (qx + qy) % 2 === 0;
        const ox = qx * half;
        const oy = qy * half;
        for (let s = 0; s < 3; s++) {
          ctx.save();
          if (horizontal) {
            ctx.beginPath();
            ctx.rect(ox, oy + s * strip, half, strip);
            ctx.clip();
            ctx.drawImage(img, ox - s * 40, oy - s * 25, size, size);
            ctx.strokeStyle = role === 'bump' ? 'rgba(20,20,20,0.45)' : 'rgba(38,24,12,0.32)';
            ctx.lineWidth = Math.max(1.5, groutPx * 0.8);
            ctx.strokeRect(ox, oy + s * strip, half, strip);
          } else {
            ctx.beginPath();
            ctx.rect(ox + s * strip, oy, strip, half);
            ctx.clip();
            ctx.translate(ox + s * strip + strip / 2, oy + half / 2);
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(img, -half, -half + s * 30, size, size);
            ctx.restore();
            ctx.save();
            ctx.strokeStyle = role === 'bump' ? 'rgba(20,20,20,0.45)' : 'rgba(38,24,12,0.32)';
            ctx.lineWidth = Math.max(1.5, groutPx * 0.8);
            ctx.strokeRect(ox + s * strip, oy, strip, half);
          }
          ctx.restore();
        }
      }
    }
  } else {
    ctx.drawImage(img, 0, 0, size, size);
  }

  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;
  const hasCustomSec = Boolean(params.secondaryColor);
  const [secR, secG, secB] = hexToRgb(params.secondaryColor || '#8F969E');

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (role === 'bump') {
      let h = lum;
      if (preset === 'brick' || preset === 'tile') {
        h = lum < 165 ? lum * 0.72 : Math.min(255, lum * 1.05);
      } else if (preset === 'stucco') {
        h = 128 + (lum - 128) * 1.95;
      } else {
        h = 128 + (lum - 128) * 1.45;
      }
      const vb = clampByte(h);
      d[i] = vb;
      d[i + 1] = vb;
      d[i + 2] = vb;
      continue;
    }

    if (role === 'roughness') {
      let rough = 215 - (lum - 128) * 0.35;
      if (preset === 'marble' || preset === 'calacatta_gold' || preset === 'nero_marble') {
        rough = lum < 185 ? 210 : 145;
      } else if (
        preset === 'travertine' ||
        preset === 'limestone' ||
        preset === 'concrete' ||
        preset === 'brick' ||
        preset === 'stucco'
      ) {
        rough = 228 - (lum - 120) * 0.45;
      } else if (preset === 'terrazzo') {
        rough = 188 + (lum < 170 ? -25 : 15);
      }
      const vr = clampByte(rough);
      d[i] = vr;
      d[i + 1] = vr;
      d[i + 2] = vr;
      continue;
    }

    switch (preset) {
      case 'wood': {
        const gNorm = 226 + (lum - 160) * 0.42;
        d[i] = clampByte(gNorm + 5);
        d[i + 1] = clampByte(gNorm + 2);
        d[i + 2] = clampByte(gNorm - 4);
        break;
      }
      case 'oak_wide':
      case 'wood_strip': {
        d[i] = clampByte(r * 0.98 + 8);
        d[i + 1] = clampByte(g * 0.94 + 4);
        d[i + 2] = clampByte(b * 0.86);
        break;
      }
      case 'teak': {
        d[i] = clampByte(r * 0.92 + 24);
        d[i + 1] = clampByte(g * 0.72 + 12);
        d[i + 2] = clampByte(b * 0.46 + 4);
        break;
      }
      case 'smoked_oak': {
        d[i] = clampByte(r * 0.44 + 8);
        d[i + 1] = clampByte(g * 0.39 + 6);
        d[i + 2] = clampByte(b * 0.36 + 5);
        break;
      }
      case 'paneling': {
        d[i] = clampByte(r * 0.96 + 10);
        d[i + 1] = clampByte(g * 0.92 + 6);
        d[i + 2] = clampByte(b * 0.85 + 2);
        break;
      }
      case 'marble': {
        const v = 240 + (lum - 210) * 0.65;
        if (hasCustomSec) {
          const vein = Math.max(0, Math.min(1, (220 - lum) / 80));
          d[i] = clampByte(248 * (1 - vein) + secR * vein);
          d[i + 1] = clampByte(248 * (1 - vein) + secG * vein);
          d[i + 2] = clampByte(248 * (1 - vein) + secB * vein);
        } else {
          d[i] = clampByte(v);
          d[i + 1] = clampByte(v);
          d[i + 2] = clampByte(v + 2);
        }
        break;
      }
      case 'calacatta_gold': {
        const veinStrength = Math.max(0, Math.min(1, (222 - lum) / 85));
        const vr = hasCustomSec ? secR : 178;
        const vg = hasCustomSec ? secG : 142;
        const vb = hasCustomSec ? secB : 84;
        d[i] = clampByte(248 * (1 - veinStrength) + vr * veinStrength);
        d[i + 1] = clampByte(244 * (1 - veinStrength) + vg * veinStrength);
        d[i + 2] = clampByte(236 * (1 - veinStrength) + vb * veinStrength);
        break;
      }
      case 'nero_marble': {
        const vein = Math.max(0, Math.min(1, (225 - lum) / 72));
        const vr = hasCustomSec ? secR : 232;
        const vg = hasCustomSec ? secG : 234;
        const vb = hasCustomSec ? secB : 242;
        d[i] = clampByte(24 * (1 - vein) + vr * vein);
        d[i + 1] = clampByte(26 * (1 - vein) + vg * vein);
        d[i + 2] = clampByte(30 * (1 - vein) + vb * vein);
        break;
      }
      case 'limestone': {
        const v = 228 + (lum - 165) * 0.35;
        d[i] = clampByte(v + 4);
        d[i + 1] = clampByte(v + 2);
        d[i + 2] = clampByte(v - 6);
        break;
      }
      case 'plaster': {
        const v = 236 + (lum - 140) * 0.24;
        d[i] = clampByte(v + 2);
        d[i + 1] = clampByte(v + 1);
        d[i + 2] = clampByte(v - 2);
        break;
      }
      case 'stucco': {
        const v = 238 + (lum - 140) * 0.42;
        d[i] = clampByte(v + 2);
        d[i + 1] = clampByte(v + 1);
        d[i + 2] = clampByte(v - 2);
        break;
      }
      case 'microcement': {
        const blend = Math.max(0, Math.min(0.65, (180 - lum) / 110));
        if (hasCustomSec) {
          d[i] = clampByte(216 * (1 - blend) + secR * blend);
          d[i + 1] = clampByte(213 * (1 - blend) + secG * blend);
          d[i + 2] = clampByte(206 * (1 - blend) + secB * blend);
        } else {
          const v = 214 + (lum - 145) * 0.22;
          d[i] = clampByte(v + 1);
          d[i + 1] = clampByte(v);
          d[i + 2] = clampByte(v - 3);
        }
        break;
      }
      case 'fabric':
      case 'velvet': {
        const v = preset === 'velvet' ? 236 + (lum - 190) * 0.22 : 242 + (lum - 195) * 0.45;
        d[i] = clampByte(v);
        d[i + 1] = clampByte(v);
        d[i + 2] = clampByte(v);
        break;
      }
      case 'wallpaper': {
        const v = 238 + (lum - 195) * 0.35;
        d[i] = clampByte(v + 1);
        d[i + 1] = clampByte(v);
        d[i + 2] = clampByte(v - 2);
        break;
      }
      case 'leather_black': {
        d[i] = clampByte(lum * 0.22 + 12);
        d[i + 1] = clampByte(lum * 0.23 + 13);
        d[i + 2] = clampByte(lum * 0.25 + 16);
        break;
      }
      case 'leather_cream': {
        const v = 236 + (lum - 115) * 0.26;
        d[i] = clampByte(v + 4);
        d[i + 1] = clampByte(v);
        d[i + 2] = clampByte(v - 8);
        break;
      }
      default:
        break;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  if (preset === 'paneling') {
    const slatW = Math.max(12, Math.round(size / 6));
    const slotW = Math.max(3, groutPx);
    for (let x = 0; x < size; x += slatW) {
      ctx.fillStyle = role === 'bump' ? '#363636' : 'rgba(20,14,10,0.34)';
      ctx.fillRect(x, 0, slotW, size);
      ctx.fillStyle = role === 'bump' ? '#ECECEC' : 'rgba(255,255,255,0.14)';
      ctx.fillRect(x + slotW, 0, 2.5, size);
    }
  } else if (
    (preset === 'marble' ||
      preset === 'calacatta_gold' ||
      preset === 'nero_marble' ||
      preset === 'travertine' ||
      preset === 'limestone' ||
      preset === 'slate') &&
    params.groutRatio > 0.001
  ) {
    // Draw subtle slab/tile joints matching 2D vector grid
    const half = size / 2;
    const stag =
      preset === 'travertine' || preset === 'slate'
        ? (params.staggerPct / 100) * half
        : 0;
    ctx.strokeStyle =
      role === 'bump'
        ? '#383838'
        : role === 'roughness'
          ? '#D8D8D8'
          : hasCustomSec && (preset === 'limestone' || preset === 'travertine')
            ? params.secondaryColor!
            : 'rgba(100,116,139,0.28)';
    ctx.lineWidth = Math.max(1.5, groutPx);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.moveTo(0, half);
    ctx.lineTo(size, half);
    ctx.moveTo(0, 0);
    ctx.lineTo(0, half);
    ctx.moveTo(half, 0);
    ctx.lineTo(half, half);
    ctx.moveTo(stag, half);
    ctx.lineTo(stag, size);
    ctx.moveTo((stag + half) % size, half);
    ctx.lineTo((stag + half) % size, size);
    ctx.stroke();
  } else if (preset === 'brick' && hasCustomSec && role === 'albedo') {
    // Overlay custom mortar color cleanly on brick mortar courses
    ctx.strokeStyle = params.secondaryColor!;
    ctx.lineWidth = Math.max(3, groutPx * 1.4);
    const half = size / 2;
    const stag = (params.staggerPct / 100) * half;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.moveTo(0, half);
    ctx.lineTo(size, half);
    ctx.moveTo(0, 0);
    ctx.lineTo(0, half);
    ctx.moveTo(half, 0);
    ctx.lineTo(half, half);
    ctx.moveTo(stag, half);
    ctx.lineTo(stag, size);
    ctx.moveTo((stag + half) % size, half);
    ctx.lineTo((stag + half) % size, size);
    ctx.stroke();
  } else if (preset === 'terrazzo' && hasCustomSec && role === 'albedo') {
    // Sprinkle subtle custom-colored aggregate chips over terrazzo base
    ctx.fillStyle = params.secondaryColor!;
    ctx.globalAlpha = 0.65;
    const chips: Array<[number, number, number]> = [
      [0.09, 0.08, 12],
      [0.36, 0.21, 15],
      [0.72, 0.14, 14],
      [0.2, 0.56, 13],
      [0.62, 0.64, 16],
      [0.86, 0.44, 11],
      [0.14, 0.84, 14],
      [0.78, 0.82, 15],
    ];
    for (const [fx, fy, r] of chips) {
      const cx = fx * size;
      const cy = fy * size;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r * 0.3);
      ctx.lineTo(cx - r * 0.4, cy + r * 0.9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function applyTextureSampling(
  tex: THREE.CanvasTexture,
  filtering: 'nearest' | 'bilinear' | 'trilinear',
  anisotropy: number
): void {
  if (filtering === 'nearest') {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = 1;
  } else if (filtering === 'bilinear') {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = Math.max(1, anisotropy);
  } else {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.max(1, anisotropy);
  }
}

function getOrCreatePresetTexture(
  preset: MaterialPreset,
  role: TexRole,
  repeatX = 1,
  repeatY = 1,
  rotDeg = 0,
  maxAnisotropy = 4,
  texRes: 256 | 512 | 1024 = 512,
  texFilter: 'nearest' | 'bilinear' | 'trilinear' = 'trilinear',
  primaryColor?: string,
  secondaryColor?: string,
  groutRatio = 0.01,
  staggerPct = 50,
  uvPreScaled = false
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const effectiveAniso = texFilter === 'nearest' ? 1 : Math.max(1, Math.round(maxAnisotropy));
  const caps = getMaterialCapabilities(preset);
  const bakesPrimary =
    preset === 'checker' ||
    preset === 'harlequin' ||
    preset === 'encaustic_tile' ||
    preset === 'pinwheel_tile' ||
    preset === 'striped_wallpaper' ||
    preset === 'ribbed_paneling' ||
    preset === 'penny_tile' ||
    preset === 'tile' ||
    preset === 'subway_tile' ||
    preset === 'porcelain_slab' ||
    preset === 'hex_tile';
  const bakesSecondary = Boolean(caps.supportsSecondaryColor && secondaryColor);
  const colorKey =
    role === 'albedo'
      ? `${bakesPrimary ? `_${(primaryColor || '#F8FAFC').toUpperCase()}` : ''}${bakesSecondary ? `_${(secondaryColor || '#334155').toUpperCase()}` : ''}`
      : '';
  const uvKey = uvPreScaled
    ? 'preuv'
    : `${repeatX.toFixed(3)}_${repeatY.toFixed(3)}_${Math.round(rotDeg)}`;
  const geomKey = `g${Math.round(groutRatio * 1000)}_s${Math.round(staggerPct)}`;
  const key = `${role}_${preset}_${uvKey}_${geomKey}_${texRes}_${texFilter}_${effectiveAniso}${colorKey}`;
  const existing = TEXTURE_CACHE.get(key);
  if (existing) {
    TEXTURE_CACHE.delete(key);
    TEXTURE_CACHE.set(key, existing);
    return existing;
  }

  const size = texRes;
  const [canvas, ctx] = makeCanvas(size);

  const tex = new THREE.CanvasTexture(canvas);
  if (role === 'albedo') {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (uvPreScaled) {
    tex.repeat.set(1, 1);
    tex.center.set(0, 0);
    tex.rotation = 0;
  } else {
    tex.repeat.set(Math.max(0.02, repeatX), Math.max(0.02, repeatY));
    tex.center.set(0.5, 0.5);
    tex.rotation = (rotDeg * Math.PI) / 180;
  }
  applyTextureSampling(tex, texFilter, effectiveAniso);

  const drawParams: ProceduralDrawParams = {
    primaryColor,
    secondaryColor,
    groutRatio,
    staggerPct,
  };

  const photoUrl = getSourceImageUrl(preset);
  if (photoUrl) {
    const loaded = requestImage(photoUrl, () => {
      const cachedImg = IMAGE_CACHE.get(photoUrl);
      if (cachedImg) {
        renderPhotoDerivedTexture(ctx, size, cachedImg, preset, role, drawParams);
        tex.needsUpdate = true;
      }
    });
    if (loaded) {
      renderPhotoDerivedTexture(ctx, size, loaded, preset, role, drawParams);
    } else {
      drawFallbackOrPattern(ctx, size, preset, role, drawParams);
    }
  } else {
    drawFallbackOrPattern(ctx, size, preset, role, drawParams);
  }

  tex.needsUpdate = true;
  setCachedTexture(key, tex);
  return tex;
}

/**
 * Recomputes seamless world-meter triplanar/box UVs on a BufferGeometry so PBR textures
 * never look stretched or artificially tiled across varying part dimensions.
 */
export function applyWorldSpaceUVs(
  geo: THREE.BufferGeometry,
  tileMeters = 1.0,
  seed = 0,
  alignLongestHorizontal = false
): void {
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return;

  if (!geo.getAttribute('normal')) {
    geo.computeVertexNormals();
  }
  const normAttr = geo.getAttribute('normal');
  if (!normAttr) return;

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sizeX = bb ? bb.max.x - bb.min.x : 1;
  const sizeZ = bb ? bb.max.z - bb.min.z : 1;
  const swapXZ = alignLongestHorizontal && sizeZ > sizeX * 1.15;

  const offsetU = ((seed * 0.371) % 1 + 1) % 1;
  const offsetV = ((seed * 0.619) % 1 + 1) % 1;
  const invTile = 1 / Math.max(0.15, tileMeters);

  const uvArray = new Float32Array(posAttr.count * 2);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const nx = Math.abs(normAttr.getX(i));
    const ny = Math.abs(normAttr.getY(i));
    const nz = Math.abs(normAttr.getZ(i));

    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = (swapXZ ? z : x) * invTile + offsetU;
      v = (swapXZ ? x : z) * invTile + offsetV;
    } else if (nx >= ny && nx >= nz) {
      u = z * invTile + offsetU;
      v = y * invTile + offsetV;
    } else {
      u = x * invTile + offsetU;
      v = y * invTile + offsetV;
    }
    uvArray[i * 2] = u;
    uvArray[i * 2 + 1] = v;
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
}

export interface ArchitecturalMaterialOptions {
  scale?: number;
  rotDeg?: number;
  secondaryColor?: string;
  settings?: SurfaceMaterialSettings;
  /** True when geometry UVs have already been scaled & rotated in exact metric units via applyPlanarUVTransform */
  uvPreScaled?: boolean;
  maxAnisotropy?: number;
  anisotropyLevel?: number;
  textureResolution?: 256 | 512 | 1024;
  textureFiltering?: 'nearest' | 'bilinear' | 'trilinear';
  materialQuality?: 'standard' | 'physical';
  reflectionQuality?: 'off' | 'low' | 'medium' | 'high';
  transparentQuality?: 'standard' | 'high';
  clippingPlanes?: THREE.Plane[];
  isSoftwareGl?: boolean;
  roughness?: number;
  metalness?: number;
  clearcoat?: number;
  sheen?: number;
  envMapIntensity?: number;
}

const artTextureCache = new Map<string, THREE.CanvasTexture>();
const rugTextureCache = new Map<string, THREE.CanvasTexture>();

export function createArtCanvasTexture(seedKey: string, tintHex = '#D97757'): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const key = `${seedKey}_${tintHex}`;
  const cached = artTextureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const seed = hashString(key);
  const variant = seed % 3;

  ctx.fillStyle = '#F7F3EB';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 1400; i++) {
    const x = (i * 173 + seed) % size;
    const y = (i * 251 + seed * 3) % size;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(15,23,42,0.03)' : 'rgba(255,255,255,0.22)';
    ctx.fillRect(x, y, 2, 2);
  }

  const accent = tintHex && tintHex !== '#FFFFFF' ? tintHex : '#C26D4E';

  if (variant === 0) {
    ctx.fillStyle = '#E5DEC9';
    ctx.fillRect(48, 48, size - 96, size - 96);

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.52, size * 0.24, Math.PI, 0);
    ctx.lineTo(size * 0.74, size * 0.84);
    ctx.lineTo(size * 0.26, size * 0.84);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#EAB308';
    ctx.beginPath();
    ctx.arc(size * 0.66, size * 0.3, size * 0.085, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.56, size * 0.16, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  } else if (variant === 1) {
    ctx.fillStyle = '#DCE6DF';
    ctx.fillRect(46, 54, size * 0.44, size * 0.62);
    ctx.fillStyle = '#2F4858';
    ctx.beginPath();
    ctx.arc(size * 0.62, size * 0.66, size * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(size * 0.46, size * 0.85);
    ctx.quadraticCurveTo(size * 0.44, size * 0.45, size * 0.56, size * 0.22);
    ctx.stroke();

    ctx.fillStyle = '#4A6B53';
    for (let i = 0; i < 6; i++) {
      const t = (i + 1) / 7;
      const lx = size * (0.46 + t * 0.08);
      const ly = size * (0.8 - t * 0.52);
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.ellipse(lx + dir * 28, ly, 34, 14, dir * -0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.ellipse(size * 0.38, size * 0.44, size * 0.22, size * 0.28, -0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.ellipse(size * 0.64, size * 0.58, size * 0.2, size * 0.22, 0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#F7F3EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(size * 0.24, size * 0.68);
    ctx.bezierCurveTo(size * 0.4, size * 0.34, size * 0.6, size * 0.72, size * 0.78, size * 0.34);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  artTextureCache.set(key, tex);
  return tex;
}

export function createRugPatternTexture(seedKey: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const cached = rugTextureCache.get(seedKey);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)';
  ctx.lineWidth = 2;
  for (let i = 0; i < size; i += 6) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.055)';
  for (let j = 0; j < size; j += 8) {
    ctx.beginPath();
    ctx.moveTo(0, j);
    ctx.lineTo(size, j);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)';
  ctx.lineWidth = 3.5;
  const step = 128;
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + step / 2, y + 8);
      ctx.lineTo(x + step - 8, y + step / 2);
      ctx.lineTo(x + step / 2, y + step - 8);
      ctx.lineTo(x + 8, y + step / 2);
      ctx.closePath();
      ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
  ctx.lineWidth = 10;
  ctx.strokeRect(18, 18, size - 36, size - 36);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  rugTextureCache.set(seedKey, tex);
  return tex;
}

function reflectionMultiplier(quality: 'off' | 'low' | 'medium' | 'high' | undefined): number {
  switch (quality) {
    case 'off':
      return 0;
    case 'low':
      return 0.35;
    case 'medium':
      return 0.7;
    case 'high':
    default:
      return 1.0;
  }
}

export function buildArchitecturalMaterial(
  preset: MaterialPreset,
  colorHex: string,
  options: ArchitecturalMaterialOptions = {}
): THREE.MeshStandardMaterial {
  const metrics = resolvePatternMetrics(preset, {
    color: colorHex,
    secondaryColor: options.secondaryColor,
    textureScale: options.scale,
    textureRotDeg: options.rotDeg,
    settings: options.settings,
  });
  const repeatX = 1 / Math.max(0.05, metrics.repeatWidthM);
  const repeatY = 1 / Math.max(0.05, metrics.repeatHeightM);
  const rotDeg = metrics.rotDeg;
  const groutRatio = Math.max(metrics.groutRatioX, metrics.groutRatioY);
  const staggerPct = metrics.staggerPct;
  const uvPreScaled = Boolean(options.uvPreScaled);

  const hwMaxAniso = Math.max(1, options.maxAnisotropy ?? 4);
  const requestedAniso = options.anisotropyLevel ?? hwMaxAniso;
  const maxAniso = Math.max(1, Math.min(hwMaxAniso, requestedAniso));
  const texRes: 256 | 512 | 1024 = options.textureResolution ?? 512;
  const texFilter: 'nearest' | 'bilinear' | 'trilinear' = options.textureFiltering ?? 'trilinear';
  const reflScale = reflectionMultiplier(options.reflectionQuality);
  const reflFactor = reflScale * (0.35 + metrics.reflectivity * 0.95);
  const usePhysical = !options.isSoftwareGl && options.materialQuality !== 'standard';
  const highTransparent = !options.isSoftwareGl && options.transparentQuality !== 'standard';

  if (preset === 'glass') {
    if (highTransparent && usePhysical) {
      return new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(colorHex || '#E0F2FE'),
        roughness: options.roughness ?? metrics.roughness,
        metalness: options.metalness ?? 0,
        clearcoat: reflScale > 0 ? 0.16 * (0.4 + metrics.reflectivity * 0.8) : 0,
        clearcoatRoughness: 0.06,
        reflectivity: 0.55 * Math.max(0.25, reflFactor),
        envMapIntensity: 0.24 * reflFactor,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
        clippingPlanes: options.clippingPlanes,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex || '#E0F2FE'),
      roughness: options.roughness ?? metrics.roughness,
      metalness: options.metalness ?? 0,
      envMapIntensity: 0.2 * reflFactor,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
      clippingPlanes: options.clippingPlanes,
    });
  }

  const meta = getMaterialPresetMeta(preset);
  const baseRoughness = options.roughness ?? metrics.roughness;
  const baseMetalness = options.metalness ?? meta.metalness;

  const isPlainFlat =
    preset === 'paint' ||
    preset === 'satin_paint' ||
    preset === 'plastic_matte' ||
    preset === 'plastic_gloss';

  const normalizedHex = (colorHex || '#FFFFFF').toUpperCase();
  const hasPhotoOrPattern = !isPlainFlat;
  const map = hasPhotoOrPattern
    ? getOrCreatePresetTexture(
        preset,
        'albedo',
        repeatX,
        repeatY,
        rotDeg,
        maxAniso,
        texRes,
        texFilter,
        metrics.primaryHex,
        metrics.secondaryHex,
        groutRatio,
        staggerPct,
        uvPreScaled
      )
    : null;
  const bumpMap = hasPhotoOrPattern
    ? getOrCreatePresetTexture(
        preset,
        'bump',
        repeatX,
        repeatY,
        rotDeg,
        maxAniso,
        texRes,
        texFilter,
        undefined,
        undefined,
        groutRatio,
        staggerPct,
        uvPreScaled
      )
    : null;
  const roughnessMap =
    hasPhotoOrPattern && usePhysical && getSourceImageUrl(preset)
      ? getOrCreatePresetTexture(
          preset,
          'roughness',
          repeatX,
          repeatY,
          rotDeg,
          maxAniso,
          texRes,
          texFilter,
          undefined,
          undefined,
          groutRatio,
          staggerPct,
          uvPreScaled
        )
      : null;

  const bumpScaleMap: Partial<Record<MaterialPreset, number>> = {
    brick: 0.036,
    tile: 0.024,
    subway_tile: 0.024,
    porcelain_slab: 0.016,
    penny_tile: 0.026,
    hex_tile: 0.024,
    checker: 0.02,
    harlequin: 0.018,
    encaustic_tile: 0.018,
    pinwheel_tile: 0.02,
    wood: 0.015,
    oak: 0.017,
    oak_wide: 0.017,
    wood_strip: 0.016,
    walnut: 0.016,
    teak: 0.016,
    smoked_oak: 0.018,
    parquet: 0.02,
    herringbone: 0.02,
    chevron: 0.02,
    basketweave: 0.02,
    paneling: 0.028,
    ribbed_paneling: 0.024,
    concrete: 0.02,
    microcement: 0.01,
    plaster: 0.014,
    stucco: 0.022,
    travertine: 0.022,
    limestone: 0.018,
    slate: 0.028,
    terrazzo: 0.01,
    fabric: 0.016,
    boucle: 0.026,
    velvet: 0.012,
    leather_cognac: 0.016,
    leather_black: 0.016,
    leather_cream: 0.015,
    wallpaper: 0.014,
    striped_wallpaper: 0.008,
    marble: 0.006,
    calacatta_gold: 0.006,
    nero_marble: 0.006,
    metal: 0.005,
    brass: 0.005,
    bronze: 0.006,
    matte_black_metal: 0.007,
  };

  // Materials whose procedural albedo directly bakes primary+secondary colors stay #FFFFFF so
  // tinting doesn't bleed primary hue into grout/secondary stripes.
  const bakesPrimary =
    preset === 'checker' ||
    preset === 'harlequin' ||
    preset === 'encaustic_tile' ||
    preset === 'pinwheel_tile' ||
    preset === 'striped_wallpaper' ||
    preset === 'ribbed_paneling' ||
    preset === 'penny_tile' ||
    preset === 'tile' ||
    preset === 'subway_tile' ||
    preset === 'porcelain_slab' ||
    preset === 'hex_tile';

  const effectiveColorHex = bakesPrimary
    ? '#FFFFFF'
    : isPresetPreTinted(preset) && normalizedHex === '#FFFFFF'
      ? '#FFFFFF'
      : normalizedHex;

  const isMetal =
    preset === 'metal' ||
    preset === 'brass' ||
    preset === 'bronze' ||
    preset === 'chrome' ||
    preset === 'matte_black_metal';
  const baseEnvIntensity = options.envMapIntensity ?? (isMetal ? 0.82 : 0.34);

  if (usePhysical) {
    const defaultClearcoat =
      preset === 'marble' ||
      preset === 'calacatta_gold' ||
      preset === 'nero_marble' ||
      preset === 'tile' ||
      preset === 'subway_tile' ||
      preset === 'porcelain_slab' ||
      preset === 'penny_tile' ||
      preset === 'hex_tile' ||
      preset === 'satin_paint' ||
      preset === 'plastic_gloss'
        ? 0.42
        : preset === 'parquet' ||
            preset === 'herringbone' ||
            preset === 'chevron' ||
            preset === 'basketweave' ||
            preset === 'walnut'
          ? 0.16
          : 0;
    const clearcoat =
      options.clearcoat ?? Math.max(defaultClearcoat, Math.max(0, metrics.reflectivity - 0.35) * 0.65);

    const isTextile = preset === 'fabric' || preset === 'boucle' || preset === 'velvet';
    const sheen = options.sheen ?? (preset === 'velvet' ? 0.85 : isTextile ? 0.55 : 0);

    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(effectiveColorHex),
      map,
      bumpMap,
      bumpScale: bumpScaleMap[preset] ?? 0,
      roughnessMap,
      envMapIntensity: baseEnvIntensity * reflFactor,
      roughness: baseRoughness,
      metalness: baseMetalness,
      clearcoat: reflScale === 0 ? 0 : clearcoat * Math.max(0.35, reflFactor),
      clearcoatRoughness:
        preset === 'plastic_gloss' ||
        preset === 'marble' ||
        preset === 'calacatta_gold' ||
        preset === 'nero_marble' ||
        preset === 'subway_tile' ||
        preset === 'porcelain_slab'
          ? 0.12
          : 0.3,
      sheen,
      sheenRoughness: preset === 'velvet' ? 0.55 : 0.82,
      sheenColor: new THREE.Color('#F8FAFC'),
      anisotropy: isMetal && preset !== 'chrome' ? 0.35 : 0,
      clippingPlanes: options.clippingPlanes,
      clipShadows: true,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(effectiveColorHex),
    map,
    bumpMap,
    bumpScale: bumpScaleMap[preset] ?? 0,
    envMapIntensity: baseEnvIntensity * reflFactor,
    roughness: baseRoughness,
    metalness: baseMetalness,
    clippingPlanes: options.clippingPlanes,
    clipShadows: !options.isSoftwareGl,
  });
}
