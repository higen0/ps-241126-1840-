import { BUILTIN_CATALOG } from '../data/catalog';
import type {
  CatalogTemplate,
  FurnitureInstance,
  FurniturePart,
  Point2D,
  ProjectedViewSvg,
  ProjectionViewId,
  RepresentationMode,
  SvgEllipseElementData,
  SvgLineElementData,
  SvgPathElementData,
  SvgPolylineElementData,
  SvgRectElementData,
  SvgVectorElement,
} from '../types/plan';
import { fastHashString } from './assetStore';
import {
  computeConvexHull2D,
  computeFurnitureBoundsMm,
  type CutThroughProjectedPart,
  getFurniturePlacement,
  getPartFurnitureLocalBoundary3D,
  getPartLocalOutline2D,
  rotateThreeYXZ,
} from './geometry';

const BUILTIN_TEMPLATE_IDS = new Set(BUILTIN_CATALOG.map((c) => c.id));

type Matrix2D = [number, number, number, number, number, number]; // [a, b, c, d, e, f]

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

function mulMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: Matrix2D, x: number, y: number): Point2D {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseLengthPx(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.endsWith('%')) return null;
  const m = trimmed.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|mm|cm|m|in|pt|pc)?$/i);
  if (!m) return null;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = (m[2] ?? 'px').toLowerCase();
  const unitToPx: Record<string, number> = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    m: 9600 / 2.54,
  };
  return val * (unitToPx[unit] ?? 1);
}

function parseSvgTransform(attr: string | undefined): Matrix2D {
  if (!attr || !attr.trim()) return IDENTITY_MATRIX;
  let mat: Matrix2D = IDENTITY_MATRIX;
  const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = fnRe.exec(attr)) !== null) {
    const fn = match[1].toLowerCase();
    const nums = (match[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    let next: Matrix2D | null = null;
    if (fn === 'matrix' && nums.length >= 6) {
      next = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
    } else if (fn === 'translate' && nums.length >= 1) {
      next = [1, 0, 0, 1, nums[0], nums[1] ?? 0];
    } else if (fn === 'scale' && nums.length >= 1) {
      const sx = nums[0];
      const sy = nums.length >= 2 ? nums[1] : sx;
      next = [sx, 0, 0, sy, 0, 0];
    } else if (fn === 'rotate' && nums.length >= 1) {
      const rad = (nums[0] * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = nums[1] ?? 0;
      const cy = nums[2] ?? 0;
      const rot: Matrix2D = [cos, sin, -sin, cos, 0, 0];
      if (cx !== 0 || cy !== 0) {
        next = mulMatrix([1, 0, 0, 1, cx, cy], mulMatrix(rot, [1, 0, 0, 1, -cx, -cy]));
      } else {
        next = rot;
      }
    } else if (fn === 'skewx' && nums.length >= 1) {
      next = [1, 0, Math.tan((nums[0] * Math.PI) / 180), 1, 0, 0];
    } else if (fn === 'skewy' && nums.length >= 1) {
      next = [1, Math.tan((nums[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    if (next) {
      mat = mulMatrix(mat, next);
    }
  }
  return mat;
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

function parseAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

function parseSvgXmlTree(xml: string): XmlNode | null {
  const trimmed = xml.trim();
  if (!trimmed || /<parsererror[\s>]/i.test(trimmed)) return null;
  // Strip XML declarations, DOCTYPE, and comments
  const cleaned = trimmed
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const tagRe = /<\s*(\/?)\s*([a-zA-Z_][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  const stack: XmlNode[] = [];
  let svgRoot: XmlNode | null = null;
  let hasClosingSvg = false;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(cleaned)) !== null) {
    const isClosing = match[1] === '/';
    const rawTag = match[2];
    const tag = rawTag.includes(':') ? rawTag.split(':').pop()!.toLowerCase() : rawTag.toLowerCase();
    const rawAttrs = match[3];
    const isSelfClosing = match[4] === '/';

    if (isClosing) {
      if (tag === 'svg' && stack.some((n) => n.tag === 'svg')) {
        hasClosingSvg = true;
      }
      while (stack.length > 0) {
        const popped = stack.pop()!;
        if (popped.tag === tag) break;
      }
      continue;
    }

    const node: XmlNode = {
      tag,
      attrs: parseAttributes(rawAttrs),
      children: [],
    };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else if (tag === 'svg' && !svgRoot) {
      svgRoot = node;
    }
    if (!isSelfClosing) {
      stack.push(node);
    } else if (tag === 'svg') {
      // Self-closing <svg ... /> has no geometry
      return null;
    }
  }

  if (!svgRoot || !hasClosingSvg) return null;
  return svgRoot;
}

function parseStyleString(styleAttr: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!styleAttr) return out;
  for (const decl of styleAttr.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

interface InheritedStyle {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  fillRule?: 'evenodd' | 'nonzero';
  hidden: boolean;
}

function resolveStyle(node: XmlNode, parent: InheritedStyle): InheritedStyle {
  const css = parseStyleString(node.attrs.style);
  const getAttr = (k: string): string | undefined => css[k] ?? node.attrs[k];

  const display = getAttr('display')?.toLowerCase();
  const visibility = getAttr('visibility')?.toLowerCase();
  const opacityRaw = getAttr('opacity');
  const opacity = opacityRaw !== undefined ? Number(opacityRaw) : 1;
  const hidden =
    parent.hidden ||
    display === 'none' ||
    visibility === 'hidden' ||
    visibility === 'collapse' ||
    (Number.isFinite(opacity) && opacity <= 0);

  let fill = parent.fill;
  const rawFill = getAttr('fill');
  if (rawFill !== undefined) {
    const trimmed = rawFill.trim();
    if (/^url\(/i.test(trimmed)) {
      fill = '#CBD5E1';
    } else {
      fill = trimmed;
    }
  }

  let fillOpacity = parent.fillOpacity;
  const rawFillOp = getAttr('fill-opacity');
  if (rawFillOp !== undefined) {
    const n = Number(rawFillOp);
    if (Number.isFinite(n)) fillOpacity = Math.max(0, Math.min(1, n));
  }
  if (Number.isFinite(opacity) && opacity < 1) {
    fillOpacity *= Math.max(0, opacity);
  }

  let stroke = parent.stroke;
  const rawStroke = getAttr('stroke');
  if (rawStroke !== undefined) {
    const trimmed = rawStroke.trim();
    stroke = /^url\(/i.test(trimmed) ? '#0F172A' : trimmed;
  }

  let strokeWidth = parent.strokeWidth;
  const rawSw = getAttr('stroke-width');
  if (rawSw !== undefined) {
    const parsed = parseLengthPx(rawSw);
    if (parsed !== null) strokeWidth = parsed;
    else if (Number(rawSw) === 0) strokeWidth = 0;
  }

  const rawRule = getAttr('fill-rule')?.toLowerCase();
  const fillRule =
    rawRule === 'evenodd' || rawRule === 'nonzero' ? rawRule : parent.fillRule;

  return {
    fill,
    fillOpacity,
    stroke,
    strokeWidth,
    fillRule,
    hidden,
  };
}

function parseSvgPathTokens(d: string): string[] {
  return d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
}

function transformPathData(d: string, mat: Matrix2D): { d: string; points: Point2D[] } | null {
  const tokens = parseSvgPathTokens(d);
  if (tokens.length === 0) return null;

  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC2x = 0;
  let lastC2y = 0;
  let lastQx = 0;
  let lastQy = 0;
  let lastCmd = '';
  const out: string[] = [];
  const pts: Point2D[] = [];

  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const nextNum = (): number | null => {
    if (i >= tokens.length || isCmd(tokens[i])) return null;
    const v = Number(tokens[i++]);
    return Number.isFinite(v) ? v : null;
  };
  const nextFlag = (): number | null => nextNum();
  const pushPt = (x: number, y: number): Point2D => {
    const p = applyMatrix(mat, x, y);
    const rp = { x: round2(p.x), y: round2(p.y) };
    pts.push(rp);
    return rp;
  };

  const scaleX = Math.hypot(mat[0], mat[1]);
  const scaleY = Math.hypot(mat[2], mat[3]);
  const matAngleDeg = (Math.atan2(mat[1], mat[0]) * 180) / Math.PI;
  const det = mat[0] * mat[3] - mat[1] * mat[2];

  while (i < tokens.length) {
    if (isCmd(tokens[i])) {
      cmd = tokens[i++];
    } else if (!cmd) {
      break;
    }

    const rel = cmd >= 'a' && cmd <= 'z';
    const upper = cmd.toUpperCase();

    if (upper === 'Z') {
      out.push('Z');
      cx = sx;
      cy = sy;
      lastCmd = 'Z';
      cmd = '';
      continue;
    }

    if (upper === 'M') {
      const nx = nextNum();
      const ny = nextNum();
      if (nx === null || ny === null) break;
      cx = rel ? cx + nx : nx;
      cy = rel ? cy + ny : ny;
      sx = cx;
      sy = cy;
      const p = pushPt(cx, cy);
      out.push(`M ${p.x} ${p.y}`);
      lastCmd = 'M';
      cmd = rel ? 'l' : 'L';
    } else if (upper === 'L') {
      const nx = nextNum();
      const ny = nextNum();
      if (nx === null || ny === null) break;
      cx = rel ? cx + nx : nx;
      cy = rel ? cy + ny : ny;
      const p = pushPt(cx, cy);
      out.push(`L ${p.x} ${p.y}`);
      lastCmd = 'L';
    } else if (upper === 'H') {
      const nx = nextNum();
      if (nx === null) break;
      cx = rel ? cx + nx : nx;
      const p = pushPt(cx, cy);
      out.push(`L ${p.x} ${p.y}`);
      lastCmd = 'H';
    } else if (upper === 'V') {
      const ny = nextNum();
      if (ny === null) break;
      cy = rel ? cy + ny : ny;
      const p = pushPt(cx, cy);
      out.push(`L ${p.x} ${p.y}`);
      lastCmd = 'V';
    } else if (upper === 'C') {
      const x1 = nextNum();
      const y1 = nextNum();
      const x2 = nextNum();
      const y2 = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) break;
      const ax1 = rel ? cx + x1 : x1;
      const ay1 = rel ? cy + y1 : y1;
      const ax2 = rel ? cx + x2 : x2;
      const ay2 = rel ? cy + y2 : y2;
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const p1 = pushPt(ax1, ay1);
      const p2 = pushPt(ax2, ay2);
      const p = pushPt(ax, ay);
      out.push(`C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p.x} ${p.y}`);
      lastC2x = ax2;
      lastC2y = ay2;
      cx = ax;
      cy = ay;
      lastCmd = 'C';
    } else if (upper === 'S') {
      const x2 = nextNum();
      const y2 = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (x2 === null || y2 === null || x === null || y === null) break;
      const ax1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * cx - lastC2x : cx;
      const ay1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * cy - lastC2y : cy;
      const ax2 = rel ? cx + x2 : x2;
      const ay2 = rel ? cy + y2 : y2;
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const p1 = pushPt(ax1, ay1);
      const p2 = pushPt(ax2, ay2);
      const p = pushPt(ax, ay);
      out.push(`C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p.x} ${p.y}`);
      lastC2x = ax2;
      lastC2y = ay2;
      cx = ax;
      cy = ay;
      lastCmd = 'S';
    } else if (upper === 'Q') {
      const x1 = nextNum();
      const y1 = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (x1 === null || y1 === null || x === null || y === null) break;
      const ax1 = rel ? cx + x1 : x1;
      const ay1 = rel ? cy + y1 : y1;
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const p1 = pushPt(ax1, ay1);
      const p = pushPt(ax, ay);
      out.push(`Q ${p1.x} ${p1.y} ${p.x} ${p.y}`);
      lastQx = ax1;
      lastQy = ay1;
      cx = ax;
      cy = ay;
      lastCmd = 'Q';
    } else if (upper === 'T') {
      const x = nextNum();
      const y = nextNum();
      if (x === null || y === null) break;
      const ax1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * cx - lastQx : cx;
      const ay1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * cy - lastQy : cy;
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const p1 = pushPt(ax1, ay1);
      const p = pushPt(ax, ay);
      out.push(`Q ${p1.x} ${p1.y} ${p.x} ${p.y}`);
      lastQx = ax1;
      lastQy = ay1;
      cx = ax;
      cy = ay;
      lastCmd = 'T';
    } else if (upper === 'A') {
      const rx = nextNum();
      const ry = nextNum();
      const rot = nextNum();
      const largeArc = nextFlag();
      const sweep = nextFlag();
      const x = nextNum();
      const y = nextNum();
      if (
        rx === null ||
        ry === null ||
        rot === null ||
        largeArc === null ||
        sweep === null ||
        x === null ||
        y === null
      ) {
        break;
      }
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const p = pushPt(ax, ay);
      const trx = round2(Math.abs(rx * scaleX));
      const try_ = round2(Math.abs(ry * scaleY));
      const trot = round2(rot + matAngleDeg);
      const tsweep = det < 0 ? (sweep ? 0 : 1) : sweep ? 1 : 0;
      out.push(`A ${trx} ${try_} ${trot} ${largeArc ? 1 : 0} ${tsweep} ${p.x} ${p.y}`);
      cx = ax;
      cy = ay;
      lastCmd = 'A';
    } else {
      break;
    }
  }

  if (out.length === 0 || pts.length === 0) return null;
  return { d: out.join(' '), points: pts };
}

function parsePointsList(raw: string | undefined): Point2D[] {
  if (!raw) return [];
  const nums = (raw.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
  const pts: Point2D[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) {
      pts.push({ x: nums[i], y: nums[i + 1] });
    }
  }
  return pts;
}

const SKIP_CONTAINERS = new Set([
  'defs',
  'clippath',
  'mask',
  'pattern',
  'symbol',
  'lineargradient',
  'radialgradient',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
]);

interface RawShapeEntry {
  node: XmlNode;
  mat: Matrix2D;
  style: InheritedStyle;
}

function collectRawShapes(
  node: XmlNode,
  parentMat: Matrix2D,
  parentStyle: InheritedStyle,
  out: RawShapeEntry[]
): void {
  if (SKIP_CONTAINERS.has(node.tag)) return;
  const style = resolveStyle(node, parentStyle);
  if (style.hidden) return;
  const localMat = parseSvgTransform(node.attrs.transform);
  const mat = mulMatrix(parentMat, localMat);

  if (
    node.tag === 'path' ||
    node.tag === 'rect' ||
    node.tag === 'circle' ||
    node.tag === 'ellipse' ||
    node.tag === 'polygon' ||
    node.tag === 'polyline' ||
    node.tag === 'line'
  ) {
    out.push({ node, mat, style });
    return;
  }

  for (const child of node.children) {
    collectRawShapes(child, mat, style, out);
  }
}

function computeRawBounds(entries: RawShapeEntry[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePt = (p: Point2D) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };

  for (const { node, mat } of entries) {
    if (node.tag === 'rect') {
      const x = Number(node.attrs.x ?? 0);
      const y = Number(node.attrs.y ?? 0);
      const w = Number(node.attrs.width ?? 0);
      const h = Number(node.attrs.height ?? 0);
      if (w > 0 && h > 0 && Number.isFinite(x) && Number.isFinite(y)) {
        includePt(applyMatrix(mat, x, y));
        includePt(applyMatrix(mat, x + w, y));
        includePt(applyMatrix(mat, x + w, y + h));
        includePt(applyMatrix(mat, x, y + h));
      }
    } else if (node.tag === 'circle') {
      const cx = Number(node.attrs.cx ?? 0);
      const cy = Number(node.attrs.cy ?? 0);
      const r = Number(node.attrs.r ?? 0);
      if (r > 0 && Number.isFinite(cx) && Number.isFinite(cy)) {
        includePt(applyMatrix(mat, cx - r, cy - r));
        includePt(applyMatrix(mat, cx + r, cy + r));
        includePt(applyMatrix(mat, cx + r, cy - r));
        includePt(applyMatrix(mat, cx - r, cy + r));
      }
    } else if (node.tag === 'ellipse') {
      const cx = Number(node.attrs.cx ?? 0);
      const cy = Number(node.attrs.cy ?? 0);
      const rx = Number(node.attrs.rx ?? 0);
      const ry = Number(node.attrs.ry ?? 0);
      if (rx > 0 && ry > 0 && Number.isFinite(cx) && Number.isFinite(cy)) {
        includePt(applyMatrix(mat, cx - rx, cy - ry));
        includePt(applyMatrix(mat, cx + rx, cy + ry));
        includePt(applyMatrix(mat, cx + rx, cy - ry));
        includePt(applyMatrix(mat, cx - rx, cy + ry));
      }
    } else if (node.tag === 'line') {
      const x1 = Number(node.attrs.x1 ?? 0);
      const y1 = Number(node.attrs.y1 ?? 0);
      const x2 = Number(node.attrs.x2 ?? 0);
      const y2 = Number(node.attrs.y2 ?? 0);
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        includePt(applyMatrix(mat, x1, y1));
        includePt(applyMatrix(mat, x2, y2));
      }
    } else if (node.tag === 'polygon' || node.tag === 'polyline') {
      for (const p of parsePointsList(node.attrs.points)) {
        includePt(applyMatrix(mat, p.x, p.y));
      }
    } else if (node.tag === 'path' && node.attrs.d) {
      const parsed = transformPathData(node.attrs.d, mat);
      if (parsed) {
        for (const p of parsed.points) includePt(p);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

export interface ParsedSvgImportResult {
  view: ProjectedViewSvg;
  parts: FurniturePart[];
}

export function parseSvgSourceToProjectedView(
  svgSource: string,
  targetWidthMm: number,
  targetDepthMm: number,
  extrudeHeightMm = 750,
  fallbackColor = '#64748B'
): ParsedSvgImportResult | null {
  const root = parseSvgXmlTree(svgSource);
  if (!root) return null;

  const baseStyle: InheritedStyle = {
    fill: '#000000',
    fillOpacity: 1,
    stroke: 'none',
    strokeWidth: 1,
    fillRule: 'nonzero',
    hidden: false,
  };

  const entries: RawShapeEntry[] = [];
  for (const child of root.children) {
    collectRawShapes(child, IDENTITY_MATRIX, baseStyle, entries);
  }
  if (entries.length === 0) return null;

  let vbMinX = 0;
  let vbMinY = 0;
  let vbW = 0;
  let vbH = 0;

  if (root.attrs.viewbox) {
    const nums = root.attrs.viewbox.trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
      [vbMinX, vbMinY, vbW, vbH] = nums;
    }
  }
  if (vbW <= 0 || vbH <= 0) {
    const attrW = parseLengthPx(root.attrs.width);
    const attrH = parseLengthPx(root.attrs.height);
    if (attrW && attrH) {
      vbW = attrW;
      vbH = attrH;
    } else {
      const rawBounds = computeRawBounds(entries);
      if (!rawBounds) return null;
      vbMinX = rawBounds.minX;
      vbMinY = rawBounds.minY;
      vbW = rawBounds.maxX - rawBounds.minX;
      vbH = rawBounds.maxY - rawBounds.minY;
    }
  }

  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) {
    return null;
  }

  const widthMm = Math.max(20, Math.round(targetWidthMm));
  const depthMm = Math.max(20, Math.round(targetDepthMm));
  // Uniform aspect-fit preserves SVG proportions inside target bounds without stretching
  const uScale = Math.min(widthMm / vbW, depthMm / vbH);
  const sx = uScale;
  const sy = uScale;
  const vbCx = vbMinX + vbW / 2;
  const vbCy = vbMinY + vbH / 2;
  const viewToMm: Matrix2D = [sx, 0, 0, sy, -vbCx * sx, -vbCy * sy];
  const avgScale = uScale;

  const elements: SvgVectorElement[] = [];
  const extractedParts: FurniturePart[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const { node, mat, style } = entries[idx];
    const totalMat = mulMatrix(viewToMm, mat);
    const hasFill = style.fill.toLowerCase() !== 'none' && style.fillOpacity > 0;
    const hasStroke = style.stroke.toLowerCase() !== 'none' && style.strokeWidth > 0;
    if (!hasFill && !hasStroke) continue;

    const strokeColor = hasStroke ? style.stroke : 'none';
    const strokeWidthMm = hasStroke ? Math.max(2, round2(style.strokeWidth * avgScale)) : 0;
    const fillColor = hasFill ? style.fill : 'none';
    const fillOpacity = hasFill ? round2(style.fillOpacity) : 0;
    const partColor =
      /^#[0-9A-Fa-f]{6}$/.test(style.fill)
        ? style.fill.toUpperCase()
        : /^#[0-9A-Fa-f]{6}$/.test(style.stroke)
          ? style.stroke.toUpperCase()
          : fallbackColor;

    const isAxisAligned = Math.abs(totalMat[1]) < 1e-4 && Math.abs(totalMat[2]) < 1e-4;

    if (node.tag === 'rect') {
      const x = Number(node.attrs.x ?? 0);
      const y = Number(node.attrs.y ?? 0);
      const w = Number(node.attrs.width ?? 0);
      const h = Number(node.attrs.height ?? 0);
      const rxRaw = Number(node.attrs.rx ?? node.attrs.ry ?? 0);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;

      if (isAxisAligned) {
        const p0 = applyMatrix(totalMat, x, y);
        const p1 = applyMatrix(totalMat, x + w, y + h);
        const minX = Math.min(p0.x, p1.x);
        const minY = Math.min(p0.y, p1.y);
        const rw = Math.abs(p1.x - p0.x);
        const rh = Math.abs(p1.y - p0.y);
        const el: SvgRectElementData = {
          id: `svg_orig_rect_${idx}`,
          kind: 'rect',
          name: `SVG Rect ${idx + 1}`,
          x: round2(minX),
          y: round2(minY),
          width: round2(rw),
          height: round2(rh),
          rx: rxRaw > 0 ? round2(rxRaw * Math.abs(totalMat[0])) : undefined,
          stroke: strokeColor,
          strokeWidthMm,
          fill: fillColor,
          fillOpacity,
          visible: true,
        };
        elements.push(el);
        if (extractedParts.length < 24 && rw >= 10 && rh >= 10) {
          extractedParts.push({
            id: `svgp_${idx}`,
            name: `SVG Shape ${idx + 1}`,
            shape: rxRaw > 0 ? 'rounded_rect' : 'box',
            xMm: Math.round(minX + rw / 2),
            yMm: Math.round(minY + rh / 2),
            zMm: 0,
            widthMm: Math.max(20, Math.round(rw)),
            depthMm: Math.max(20, Math.round(rh)),
            heightMm: extrudeHeightMm,
            rotationDeg: 0,
            color: partColor,
            material: 'wood',
          });
        }
      } else {
        const corners = [
          applyMatrix(totalMat, x, y),
          applyMatrix(totalMat, x + w, y),
          applyMatrix(totalMat, x + w, y + h),
          applyMatrix(totalMat, x, y + h),
        ].map((p) => ({ x: round2(p.x), y: round2(p.y) }));
        const el: SvgPolylineElementData = {
          id: `svg_orig_rect_${idx}`,
          kind: 'polyline',
          name: `SVG Rect ${idx + 1}`,
          points: corners,
          closed: true,
          stroke: strokeColor,
          strokeWidthMm,
          fill: fillColor,
          fillOpacity,
          visible: true,
        };
        elements.push(el);
      }
    } else if (node.tag === 'circle' || node.tag === 'ellipse') {
      const cx = Number(node.attrs.cx ?? 0);
      const cy = Number(node.attrs.cy ?? 0);
      const rx = Number(node.tag === 'circle' ? node.attrs.r ?? 0 : node.attrs.rx ?? node.attrs.ry ?? 0);
      const ry = Number(node.tag === 'circle' ? node.attrs.r ?? 0 : node.attrs.ry ?? node.attrs.rx ?? 0);
      if (![cx, cy, rx, ry].every(Number.isFinite) || rx <= 0 || ry <= 0) continue;
      const center = applyMatrix(totalMat, cx, cy);
      const sxMat = Math.hypot(totalMat[0], totalMat[1]);
      const syMat = Math.hypot(totalMat[2], totalMat[3]);
      const rotDeg = (Math.atan2(totalMat[1], totalMat[0]) * 180) / Math.PI;
      const erx = round2(rx * sxMat);
      const ery = round2(ry * syMat);
      const el: SvgEllipseElementData = {
        id: `svg_orig_ell_${idx}`,
        kind: 'ellipse',
        name: `SVG Ellipse ${idx + 1}`,
        cx: round2(center.x),
        cy: round2(center.y),
        rx: erx,
        ry: ery,
        rotationDeg: Math.abs(rotDeg) > 0.1 ? round2(rotDeg) : undefined,
        stroke: strokeColor,
        strokeWidthMm,
        fill: fillColor,
        fillOpacity,
        visible: true,
      };
      elements.push(el);
      if (extractedParts.length < 24 && erx >= 5 && ery >= 5) {
        extractedParts.push({
          id: `svgp_${idx}`,
          name: `SVG Ellipse ${idx + 1}`,
          shape: 'cylinder',
          xMm: Math.round(center.x),
          yMm: Math.round(center.y),
          zMm: 0,
          widthMm: Math.max(20, Math.round(erx * 2)),
          depthMm: Math.max(20, Math.round(ery * 2)),
          heightMm: extrudeHeightMm,
          rotationDeg: Math.round(rotDeg),
          color: partColor,
          material: 'wood',
        });
      }
    } else if (node.tag === 'line') {
      const x1 = Number(node.attrs.x1 ?? 0);
      const y1 = Number(node.attrs.y1 ?? 0);
      const x2 = Number(node.attrs.x2 ?? 0);
      const y2 = Number(node.attrs.y2 ?? 0);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      if (!hasStroke) continue;
      const p1 = applyMatrix(totalMat, x1, y1);
      const p2 = applyMatrix(totalMat, x2, y2);
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-3) continue;
      const el: SvgLineElementData = {
        id: `svg_orig_line_${idx}`,
        kind: 'line',
        name: `SVG Line ${idx + 1}`,
        x1: round2(p1.x),
        y1: round2(p1.y),
        x2: round2(p2.x),
        y2: round2(p2.y),
        stroke: strokeColor,
        strokeWidthMm: Math.max(2, strokeWidthMm),
        visible: true,
      };
      elements.push(el);
    } else if (node.tag === 'polygon' || node.tag === 'polyline') {
      const pts = parsePointsList(node.attrs.points).map((p) => {
        const tp = applyMatrix(totalMat, p.x, p.y);
        return { x: round2(tp.x), y: round2(tp.y) };
      });
      if (pts.length < 2) continue;
      const el: SvgPolylineElementData = {
        id: `svg_orig_poly_${idx}`,
        kind: 'polyline',
        name: `SVG ${node.tag === 'polygon' ? 'Polygon' : 'Polyline'} ${idx + 1}`,
        points: pts,
        closed: node.tag === 'polygon',
        stroke: strokeColor,
        strokeWidthMm,
        fill: node.tag === 'polygon' ? fillColor : 'none',
        fillOpacity: node.tag === 'polygon' ? fillOpacity : 0,
        visible: true,
      };
      elements.push(el);
    } else if (node.tag === 'path' && node.attrs.d) {
      const transformed = transformPathData(node.attrs.d, totalMat);
      if (!transformed) continue;
      const el: SvgPathElementData = {
        id: `svg_orig_path_${idx}`,
        kind: 'path',
        name: `SVG Path ${idx + 1}`,
        d: transformed.d,
        stroke: strokeColor,
        strokeWidthMm,
        fill: fillColor,
        fillOpacity,
        fillRule: style.fillRule,
        visible: true,
      };
      elements.push(el);
    }
  }

  if (elements.length === 0) return null;

  if (extractedParts.length === 0) {
    extractedParts.push({
      id: 'svgp_body',
      name: 'Extruded SVG Body',
      shape: 'box',
      xMm: 0,
      yMm: 0,
      zMm: 0,
      widthMm,
      depthMm,
      heightMm: extrudeHeightMm,
      rotationDeg: 0,
      color: fallbackColor,
      material: 'wood',
    });
  }

  return {
    view: {
      view: 'top',
      viewBox: {
        minX: -widthMm / 2,
        minY: -depthMm / 2,
        width: widthMm,
        height: depthMm,
      },
      baseWidthMm: widthMm,
      baseHeightMm: depthMm,
      elements,
    },
    parts: extractedParts,
  };
}

const svgValidityCache = new Map<string, boolean>();

export function isValidSvgSource(svgSource?: string | null): boolean {
  if (typeof svgSource !== 'string') return false;
  const trimmed = svgSource.trim();
  if (!trimmed || !/<svg[\s>]/i.test(trimmed)) return false;
  const key = `${trimmed.length}_${fastHashString(trimmed)}`;
  const cached = svgValidityCache.get(key);
  if (cached !== undefined) return cached;
  const parsed = parseSvgSourceToProjectedView(trimmed, 1000, 1000);
  const valid = Boolean(parsed && parsed.view.elements.length > 0);
  if (svgValidityCache.size > 256) svgValidityCache.clear();
  svgValidityCache.set(key, valid);
  return valid;
}

export function isBuiltinCatalogItem(
  item: { templateId?: string; id?: string; isCustom?: boolean } | undefined | null
): boolean {
  if (!item) return false;
  if (item.isCustom) return false;
  const tplId = item.templateId ?? item.id;
  return Boolean(tplId && BUILTIN_TEMPLATE_IDS.has(tplId));
}

export type RepresentationTargetItem =
  | (Partial<
      Pick<
        FurnitureInstance,
        'templateId' | 'svgSource' | 'glbAssetId' | 'glbDataUrl' | 'parts' | 'representation'
      >
    > & { id?: string; isCustom?: boolean })
  | (Partial<
      Pick<
        CatalogTemplate,
        'id' | 'isCustom' | 'svgSource' | 'glbAssetId' | 'glbDataUrl' | 'parts' | 'representation'
      >
    > & { templateId?: string });

export function hasValidDefaultSvg(item: RepresentationTargetItem | undefined | null): boolean {
  if (!item) return false;
  // Explicit SVG source (imported or embedded): must validate cleanly
  if (typeof item.svgSource === 'string' && item.svgSource.trim().length > 0) {
    return isValidSvgSource(item.svgSource);
  }
  // Preserved immutable defaultViews on representation (e.g., imported SVG or saved built-in copy)
  const topDefault = item.representation?.defaultViews?.top;
  if (topDefault && Array.isArray(topDefault.elements) && topDefault.elements.length > 0) {
    return true;
  }
  // Built-in catalog furniture (non-GLB) has original architectural 2D vector drawing
  if (!item.glbAssetId && !item.glbDataUrl && isBuiltinCatalogItem(item)) {
    return Array.isArray(item.parts) && item.parts.length > 0;
  }
  return false;
}

export function getDefaultRepresentationMode(item: RepresentationTargetItem | undefined | null): RepresentationMode {
  return hasValidDefaultSvg(item) ? 'default' : 'silhouette';
}

export function resolveEffectiveRepresentationMode(
  item: RepresentationTargetItem | undefined | null
): RepresentationMode {
  if (!item) return 'silhouette';
  const canDefault = hasValidDefaultSvg(item);
  const raw = item.representation?.mode;
  if (!raw) return canDefault ? 'default' : 'silhouette';
  if (raw === 'default' && !canDefault) return 'silhouette';
  return raw;
}

/**
 * Appends strictly bounded, part-derived architectural plan accents inside a rectangular
 * part footprint centered at (cx, cy) with optional rotation.
 */
function pushBoundedPartPlanDetails(
  elements: SvgVectorElement[],
  p: FurniturePart,
  prefix: string,
  cx: number,
  cy: number,
  rotDeg: number
): void {
  const ds = p.detailStyle;
  if (!ds) return;
  const w = Math.max(10, p.widthMm);
  const d = Math.max(10, p.depthMm);
  const hw = w / 2;
  const hd = d / 2;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toParent = (lx: number, ly: number): Point2D => ({
    x: round2(cx + lx * cos - ly * sin),
    y: round2(cy + lx * sin + ly * cos),
  });
  const isDark = p.color === '#0F172A' || p.color === '#1E293B' || p.color === '#334155';
  const stroke = isDark ? '#CBD5E1' : '#475569';
  const thinSw = 5;
  let seq = 0;
  const nextId = () => `${prefix}_d_${seq++}`;

  const addLine = (x1: number, y1: number, x2: number, y2: number, sw = thinSw, st = stroke) => {
    const a = toParent(x1, y1);
    const b = toParent(x2, y2);
    elements.push({
      id: nextId(),
      kind: 'line',
      name: `${p.name} Detail`,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: st,
      strokeWidthMm: sw,
      visible: true,
    });
  };

  const addEllipse = (
    lx: number,
    ly: number,
    rx: number,
    ry: number,
    fill = 'none',
    fillOpacity = 0,
    st = stroke,
    sw = thinSw
  ) => {
    const c = toParent(lx, ly);
    elements.push({
      id: nextId(),
      kind: 'ellipse',
      name: `${p.name} Detail`,
      cx: c.x,
      cy: c.y,
      rx: round2(Math.max(2, rx)),
      ry: round2(Math.max(2, ry)),
      rotationDeg: rotDeg || undefined,
      stroke: st,
      strokeWidthMm: sw,
      fill,
      fillOpacity,
      visible: true,
    });
  };

  const addRect = (lx: number, ly: number, rw: number, rh: number, rx = 0, st = stroke, sw = thinSw) => {
    const c = toParent(lx + rw / 2, ly + rh / 2);
    elements.push({
      id: nextId(),
      kind: 'rect',
      name: `${p.name} Detail`,
      x: round2(c.x - rw / 2),
      y: round2(c.y - rh / 2),
      width: round2(rw),
      height: round2(rh),
      rx: rx > 0 ? round2(rx) : undefined,
      rotationDeg: rotDeg || undefined,
      stroke: st,
      strokeWidthMm: sw,
      fill: 'none',
      fillOpacity: 0,
      visible: true,
    });
  };

  const isRoundShape = p.shape === 'oval' || p.shape === 'cylinder' || p.shape === 'sphere';
  const isRectShape = p.shape === 'box' || p.shape === 'rounded_rect';

  switch (ds) {
    case 'cushion':
    case 'pillow':
    case 'mattress':
    case 'blanket':
      if (w >= 80 && d >= 80) {
        if (isRoundShape) {
          addEllipse(0, 0, hw * 0.84, hd * 0.82);
        } else if (isRectShape) {
          addRect(-hw * 0.84, -hd * 0.82, w * 0.84, d * 0.82, Math.min(hw, hd) * 0.14);
        }
      }
      break;
    case 'tufted':
      if (w >= 120 && d >= 120) {
        if (isRoundShape) {
          addEllipse(0, 0, hw * 0.86, hd * 0.84);
        } else if (isRectShape) {
          addRect(-hw * 0.86, -hd * 0.84, w * 0.86, d * 0.84, Math.min(hw, hd) * 0.12);
        }
        if (isRoundShape || isRectShape) {
          for (const fx of [-0.4, 0, 0.4]) {
            addEllipse(hw * fx, -hd * 0.22, 8, 8, stroke, 0.4, stroke, 3);
            addEllipse(hw * fx, hd * 0.22, 8, 8, stroke, 0.4, stroke, 3);
          }
        }
      }
      break;
    case 'basin':
    case 'tub_inner':
      addRect(-hw * 0.72, -hd * 0.68, w * 0.72, d * 0.68, Math.min(hw, hd) * 0.22);
      addEllipse(0, -hd * 0.16, Math.min(w, d) * 0.055, Math.min(w, d) * 0.055, stroke, 0.5, stroke, 4);
      break;
    case 'toilet_bowl':
      addEllipse(0, -hd * 0.08, hw * 0.62, hd * 0.58, 'none', 0, stroke, 5);
      addEllipse(0, -hd * 0.14, hw * 0.38, hd * 0.38, 'none', 0, stroke, 4);
      break;
    case 'drainboard':
      for (const fy of [-0.55, -0.275, 0, 0.275, 0.55]) {
        addLine(-hw * 0.78, hd * fy, hw * 0.78, hd * fy, 4);
      }
      break;
    case 'burner':
    case 'gas_hob':
    case 'electric_hob':
    case 'induction_hob': {
      const rBig = Math.min(w, d) * 0.14;
      const rSmall = Math.min(w, d) * 0.11;
      addEllipse(-hw * 0.42, -hd * 0.36, rBig, rBig, 'none', 0, stroke, 6);
      addEllipse(hw * 0.42, -hd * 0.36, rSmall, rSmall, 'none', 0, stroke, 6);
      addEllipse(-hw * 0.42, hd * 0.32, rSmall, rSmall, 'none', 0, stroke, 6);
      addEllipse(hw * 0.42, hd * 0.32, rBig, rBig, 'none', 0, stroke, 6);
      break;
    }
    case 'curtain_pleat': {
      const folds = Math.max(4, Math.min(18, Math.round(w / 100)));
      const pts: Point2D[] = [];
      for (let k = 0; k <= folds; k++) {
        const lx = -hw * 0.86 + (k / folds) * w * 0.86;
        const ly = k % 2 === 0 ? -hd * 0.55 : hd * 0.55;
        pts.push(toParent(lx, ly));
      }
      elements.push({
        id: nextId(),
        kind: 'polyline',
        name: `${p.name} Pleats`,
        points: pts,
        closed: false,
        stroke,
        strokeWidthMm: 4,
        fill: 'none',
        fillOpacity: 0,
        visible: true,
      });
      break;
    }
    case 'slatted_wood':
    case 'blinds_slats': {
      const count = Math.max(4, Math.min(12, Math.round(w / 100)));
      for (let k = 0; k < count; k++) {
        const lx = -hw * 0.82 + (k / (count - 1)) * w * 0.82;
        addLine(lx, -hd * 0.65, lx, hd * 0.65, 4);
      }
      break;
    }
    case 'rug':
    case 'fringe_rug':
      if (w >= 250 && d >= 250) {
        if (isRoundShape) {
          addEllipse(0, 0, hw * 0.86, hd * 0.86, 'none', 0, stroke, 4);
        } else {
          addRect(-hw * 0.86, -hd * 0.86, w * 0.86, d * 0.86, 0, stroke, 4);
        }
      }
      break;
    case 'foliage':
    case 'leaves_palm':
    case 'leaves_olive':
      addEllipse(0, 0, hw * 0.48, hd * 0.48, 'none', 0, stroke, 4);
      addLine(-hw * 0.42, 0, hw * 0.42, 0, 4);
      addLine(0, -hd * 0.42, 0, hd * 0.42, 4);
      break;
    case 'books': {
      const bCount = Math.max(3, Math.min(9, Math.round(w / 45)));
      for (let k = 1; k < bCount; k++) {
        const lx = -hw * 0.82 + (k / bCount) * w * 0.82;
        addLine(lx, -hd * 0.72, lx, hd * 0.72, 3);
      }
      break;
    }
    case 'washer_topload':
      addRect(-hw * 0.72, -hd * 0.52, w * 0.72, d * 0.62, 16, stroke, 5);
      break;
    case 'ac_indoor':
    case 'ac_outdoor':
      addLine(-hw * 0.82, hd * 0.42, hw * 0.82, hd * 0.42, 5);
      break;
  }
}

const COMPOSITE_TOP_HULL_STYLES = new Set<string>([
  'planter_pot',
  'foliage',
  'leaves_palm',
  'leaves_olive',
  'lamp_base',
  'basin',
  'tub_inner',
  'toilet_bowl',
  'vase',
  'bowl',
  'books',
  'candle_tray',
  'faucet',
  'towel_rail',
  'gas_hob',
  'electric_hob',
  'induction_hob',
  'oven_front',
  'microwave_front',
  'fridge_single',
  'fridge_double',
  'fridge_side_by_side',
  'fridge_french',
  'wine_cooler',
  'dishwasher',
  'washer_topload',
  'washer_drum',
  'dryer_drum',
  'wall_tv',
  'coffee_machine',
  'drip_coffee',
  'kettle',
  'toaster',
  'stand_mixer',
  'sculptural',
  'curtain_pleat',
  'blinds_slats',
  'roller_blind',
  'ac_indoor',
  'ac_outdoor',
]);

/**
 * Generates an editable top-down vector representation from parametric FurniturePart[]
 * derived strictly from the object's 3D parts and placement transform (mirror + YXZ tilt).
 */
export function generateDefaultTopViewFromParts(
  parts: FurniturePart[],
  options?: {
    rotationXDeg?: number;
    rotationYDeg?: number;
    mirroredX?: boolean;
    mirroredY?: boolean;
    templateId?: string;
  }
): ProjectedViewSvg | null {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const rxDeg = options?.rotationXDeg ?? 0;
  const ryDeg = options?.rotationYDeg ?? 0;
  const hasTilt = Math.abs(rxDeg) >= 0.05 || Math.abs(ryDeg) >= 0.05;

  // When tilted in 3D, project every part's true mirrored-then-tilted 3D boundary vertices
  if (hasTilt) {
    const placement = getFurniturePlacement({
      parts,
      templateId: options?.templateId,
      rotationDeg: 0,
      elevationMm: 0,
      rotationXDeg: rxDeg,
      rotationYDeg: ryDeg,
      mirroredX: options?.mirroredX,
      mirroredY: options?.mirroredY,
    });
    const tb = placement.tiltedLocalBounds;
    const cx = (tb.minX + tb.maxX) / 2;
    const cy = (tb.minY + tb.maxY) / 2;
    const mx = placement.mirrorSignX;
    const my = placement.mirrorSignY;

    const tiltedParts = parts
      .map((p, idx) => {
        let minTiltedZ = Infinity;
        const pts2D: Point2D[] = [];
        for (const v of getPartFurnitureLocalBoundary3D(p, options?.templateId)) {
          const r = rotateThreeYXZ(v.x * mx, v.z, v.y * my, rxDeg, ryDeg);
          if (r.z < minTiltedZ) minTiltedZ = r.z;
          pts2D.push({ x: r.x - cx, y: r.y - cy });
        }
        const hull = computeConvexHull2D(pts2D);
        return { p, idx, minTiltedZ, hull };
      })
      .sort((a, b) => a.minTiltedZ - b.minTiltedZ || a.p.zMm - b.p.zMm);

    const elements: SvgVectorElement[] = [];
    for (const entry of tiltedParts) {
      if (entry.hull.length < 3) continue;
      elements.push({
        id: `def_tilted_part_${entry.idx}`,
        kind: 'polyline',
        name: entry.p.name,
        points: entry.hull.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) })),
        closed: true,
        stroke: '#1E293B',
        strokeWidthMm: 10,
        fill: entry.p.material === 'glass' ? '#E0F2FE' : entry.p.color || '#FFFFFF',
        fillOpacity: entry.p.material === 'glass' ? 0.45 : 1,
        visible: true,
      });
    }

    const bw = Math.max(20, round2(tb.widthMm));
    const bd = Math.max(20, round2(tb.depthMm));
    return {
      view: 'top',
      viewBox: {
        minX: -bw / 2,
        minY: -bd / 2,
        width: bw,
        height: bd,
      },
      baseWidthMm: bw,
      baseHeightMm: bd,
      elements,
    };
  }

  const basePlacement = getFurniturePlacement({
    parts,
    templateId: options?.templateId,
    rotationDeg: 0,
    elevationMm: 0,
  });
  const bounds = basePlacement.tiltedLocalBounds;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const sorted = [...parts].sort((a, b) => a.zMm - b.zMm);
  const elements: SvgVectorElement[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const w = Math.max(10, p.widthMm);
    const d = Math.max(10, p.depthMm);
    const hw = w / 2;
    const hd = d / 2;
    const px = round2(p.xMm - cx);
    const py = round2(p.yMm - cy);
    const fill = p.material === 'glass' ? '#E0F2FE' : p.color || '#FFFFFF';
    const fillOpacity = p.material === 'glass' ? 0.45 : 1;
    const stroke = '#1E293B';
    const strokeWidthMm = 10;
    const isCompositeHull =
      (Boolean(p.detailStyle) && COMPOSITE_TOP_HULL_STYLES.has(p.detailStyle!)) ||
      (options?.templateId === 'light_floor' && /arm/i.test(p.name));

    if (p.detailStyle === 'caster_base') {
      const hull = getPartLocalOutline2D(p);
      const radP = (p.rotationDeg * Math.PI) / 180;
      const cosP = Math.cos(radP);
      const sinP = Math.sin(radP);
      const toParent = (lx: number, ly: number): Point2D => ({
        x: round2(px + lx * cosP - ly * sinP),
        y: round2(py + lx * sinP + ly * cosP),
      });
      if (hull.length >= 3) {
        elements.push({
          id: `def_part_${i}`,
          kind: 'polyline',
          name: p.name,
          points: hull.map((pt: Point2D) => toParent(pt.x, pt.y)),
          closed: true,
          stroke,
          strokeWidthMm,
          fill,
          fillOpacity: 0.25,
          visible: true,
        });
      }
      const pwEff = Math.max(380, w);
      const armLen = (pwEff / 2) * 0.88;
      const zScale = Math.abs(d - w) > 1 ? d / pwEff : 1;
      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2;
        const tip = toParent(Math.sin(ang) * armLen, Math.cos(ang) * armLen * zScale);
        elements.push({
          id: `def_part_${i}_spoke_${k}`,
          kind: 'line',
          name: `${p.name} Arm ${k + 1}`,
          x1: px,
          y1: py,
          x2: tip.x,
          y2: tip.y,
          stroke,
          strokeWidthMm: 8,
          visible: true,
        });
      }
      elements.push({
        id: `def_part_${i}_hub`,
        kind: 'ellipse',
        name: `${p.name} Hub`,
        cx: px,
        cy: py,
        rx: 32,
        ry: 32,
        stroke,
        strokeWidthMm: 6,
        fill,
        fillOpacity: 1,
        visible: true,
      });
    } else if (isCompositeHull) {
      const hull3d = computeConvexHull2D(
        getPartFurnitureLocalBoundary3D(p, options?.templateId).map((v) => ({
          x: v.x - cx,
          y: v.y - cy,
        }))
      );
      if (hull3d.length >= 3) {
        elements.push({
          id: `def_part_${i}`,
          kind: 'polyline',
          name: p.name,
          points: hull3d.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) })),
          closed: true,
          stroke,
          strokeWidthMm,
          fill,
          fillOpacity,
          visible: true,
        });
      }
      pushBoundedPartPlanDetails(elements, p, `def_part_${i}`, px, py, p.rotationDeg);
    } else if (p.shape === 'cylinder' || p.shape === 'sphere' || p.shape === 'oval') {
      elements.push({
        id: `def_part_${i}`,
        kind: 'ellipse',
        name: p.name,
        cx: px,
        cy: py,
        rx: round2(hw),
        ry: round2(hd),
        rotationDeg: p.rotationDeg || undefined,
        stroke,
        strokeWidthMm,
        fill,
        fillOpacity,
        visible: true,
      });
      pushBoundedPartPlanDetails(elements, p, `def_part_${i}`, px, py, p.rotationDeg);
    } else if (p.shape === 'arc') {
      const rawArcD = `M ${round2(-hw)} ${round2(hd)} A ${round2(hw)} ${round2(d)} 0 0 1 ${round2(hw)} ${round2(hd)} L ${round2(hw * 0.65)} ${round2(hd)} A ${round2(hw * 0.65)} ${round2(d * 0.65)} 0 0 0 ${round2(-hw * 0.65)} ${round2(hd)} Z`;
      const rad = (p.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const transformed = transformPathData(rawArcD, [cos, sin, -sin, cos, px, py]);
      if (transformed) {
        elements.push({
          id: `def_part_${i}`,
          kind: 'path',
          name: p.name,
          d: transformed.d,
          stroke,
          strokeWidthMm,
          fill,
          fillOpacity,
          visible: true,
        });
      }
    } else if (p.shape === 'l_profile' || p.shape === 'u_profile') {
      const rad = (p.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const tx = (lx: number, ly: number) => ({
        x: round2(px + lx * cos - ly * sin),
        y: round2(py + lx * sin + ly * cos),
      });
      let localPts: Point2D[];
      if (p.shape === 'l_profile') {
        const armW = Math.min(w * 0.42, Math.max(w * 0.25, 320));
        const armD = Math.min(d * 0.42, Math.max(d * 0.25, 320));
        localPts = [
          { x: -hw, y: -hd },
          { x: hw, y: -hd },
          { x: hw, y: -hd + armD },
          { x: -hw + armW, y: -hd + armD },
          { x: -hw + armW, y: hd },
          { x: -hw, y: hd },
        ];
      } else {
        const armW = Math.min(w * 0.3, Math.max(w * 0.2, 260));
        const backD = Math.min(d * 0.35, Math.max(d * 0.22, 260));
        localPts = [
          { x: -hw, y: -hd },
          { x: hw, y: -hd },
          { x: hw, y: hd },
          { x: hw - armW, y: hd },
          { x: hw - armW, y: -hd + backD },
          { x: -hw + armW, y: -hd + backD },
          { x: -hw + armW, y: hd },
          { x: -hw, y: hd },
        ];
      }
      elements.push({
        id: `def_part_${i}`,
        kind: 'polyline',
        name: p.name,
        points: localPts.map((pt) => tx(pt.x, pt.y)),
        closed: true,
        stroke,
        strokeWidthMm,
        fill,
        fillOpacity,
        visible: true,
      });
    } else {
      // box, rounded_rect, extruded_svg, wedge (match 3D rounded/beveled corner radius 1:1)
      const ds = p.detailStyle;
      const isCushioned = ds === 'cushion' || ds === 'pillow' || ds === 'mattress' || ds === 'blanket';
      const isBeveledStyle =
        ds === 'table_top' || ds === 'chair_seat' || ds === 'armrest' || ds === 'backrest' || Boolean(p.bevel);
      const rawRx =
        p.shape === 'rounded_rect' || (p.shape === 'box' && isBeveledStyle)
          ? p.shape === 'box'
            ? Math.min(w, d) * 0.04
            : isCushioned
              ? Math.min(w * 0.16, d * 0.16, 90)
              : isBeveledStyle
                ? Math.min(w * 0.2, d * 0.2, 120)
                : Math.min(w * 0.22, d * 0.22, 140)
          : 0;
      const clampedRx =
        rawRx > 0 ? round2(Math.max(2, Math.min(rawRx, hw * 0.48, hd * 0.48))) : undefined;
      elements.push({
        id: `def_part_${i}`,
        kind: 'rect',
        name: p.name,
        x: round2(px - hw),
        y: round2(py - hd),
        width: round2(w),
        height: round2(d),
        rx: clampedRx,
        rotationDeg: p.rotationDeg || undefined,
        stroke,
        strokeWidthMm,
        fill,
        fillOpacity,
        visible: true,
      });
      if (p.shape === 'wedge' && w >= 60) {
        const rad = (p.rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        elements.push({
          id: `def_part_${i}_slope`,
          kind: 'line',
          name: `${p.name} Slope`,
          x1: round2(px + -hw * 0.55 * cos - -hd * 0.85 * sin),
          y1: round2(py + -hw * 0.55 * sin + -hd * 0.85 * cos),
          x2: round2(px + -hw * 0.55 * cos - hd * 0.85 * sin),
          y2: round2(py + -hw * 0.55 * sin + hd * 0.85 * cos),
          stroke: '#64748B',
          strokeWidthMm: 4,
          visible: true,
        });
      }
      pushBoundedPartPlanDetails(elements, p, `def_part_${i}`, px, py, p.rotationDeg);
    }
  }

  const bw = Math.max(20, round2(bounds.widthMm));
  const bd = Math.max(20, round2(bounds.depthMm));
  return {
    view: 'top',
    viewBox: {
      minX: -bw / 2,
      minY: -bd / 2,
      width: bw,
      height: bd,
    },
    baseWidthMm: bw,
    baseHeightMm: bd,
    elements,
  };
}

function appendBoundedElevationPartAccents(
  elements: SvgVectorElement[],
  vp: CutThroughProjectedPart,
  idx: number,
  blackAndWhite: boolean
): void {
  const p = vp.part;
  const ds = p.detailStyle;
  if (!ds) return;
  const x0 = vp.viewX - vp.elevW / 2;
  const y0 = -(vp.zBottom + vp.elevH);
  const w = vp.elevW;
  const h = vp.elevH;
  const cx = vp.viewX;
  const cy = -(vp.zBottom + h / 2);
  let seq = 0;
  const nextId = () => `wv_d_${idx}_${seq++}`;

  const resolveBwAccentStroke = (rawStroke: string): string => {
    const s = rawStroke.trim().toUpperCase();
    if (s === 'NONE') return '#0F172A';
    if (s === '#0F172A' || s === '#1E293B' || s === '#334155' || s === '#475569' || s === '#64748B') {
      return s;
    }
    return '#475569';
  };

  const addRect = (
    x: number,
    y: number,
    rw: number,
    rh: number,
    fill = 'none',
    fillOpacity = 0,
    stroke = '#475569',
    sw = 8,
    rx = 0
  ) => {
    const finalFill = blackAndWhite ? 'none' : fill;
    const finalFillOpacity = blackAndWhite ? 0 : fillOpacity;
    const finalStroke = blackAndWhite ? resolveBwAccentStroke(stroke) : stroke;
    const finalSw = blackAndWhite ? Math.max(7, sw) : sw;
    elements.push({
      id: nextId(),
      kind: 'rect',
      name: `${p.name} Detail`,
      x: round2(x),
      y: round2(y),
      width: round2(Math.max(2, rw)),
      height: round2(Math.max(2, rh)),
      rx: rx > 0 ? round2(rx) : undefined,
      stroke: finalStroke,
      strokeWidthMm: finalSw,
      fill: finalFill,
      fillOpacity: finalFillOpacity,
      visible: true,
    });
  };
  const addLine = (x1: number, y1: number, x2: number, y2: number, stroke = '#475569', sw = 8) => {
    const finalStroke = blackAndWhite ? resolveBwAccentStroke(stroke) : stroke;
    const finalSw = blackAndWhite ? Math.max(7, sw) : sw;
    elements.push({
      id: nextId(),
      kind: 'line',
      name: `${p.name} Detail`,
      x1: round2(x1),
      y1: round2(y1),
      x2: round2(x2),
      y2: round2(y2),
      stroke: finalStroke,
      strokeWidthMm: finalSw,
      visible: true,
    });
  };
  const addEllipse = (
    ecx: number,
    ecy: number,
    rx: number,
    ry: number,
    fill = 'none',
    fillOpacity = 0,
    stroke = '#475569',
    sw = 8
  ) => {
    const finalFill = blackAndWhite ? 'none' : fill;
    const finalFillOpacity = blackAndWhite ? 0 : fillOpacity;
    const finalStroke = blackAndWhite ? resolveBwAccentStroke(stroke) : stroke;
    const finalSw = blackAndWhite ? Math.max(7, sw) : sw;
    elements.push({
      id: nextId(),
      kind: 'ellipse',
      name: `${p.name} Detail`,
      cx: round2(ecx),
      cy: round2(ecy),
      rx: round2(Math.max(2, rx)),
      ry: round2(Math.max(2, ry)),
      stroke: finalStroke,
      strokeWidthMm: finalSw,
      fill: finalFill,
      fillOpacity: finalFillOpacity,
      visible: true,
    });
  };

  if (ds === 'oven_front' || ds === 'microwave_front') {
    addRect(
      x0 + w * 0.08,
      y0 + h * (ds === 'oven_front' ? 0.26 : 0.14),
      w * (ds === 'oven_front' ? 0.84 : 0.62),
      h * (ds === 'oven_front' ? 0.6 : 0.72),
      '#0F172A',
      0.85,
      '#64748B',
      8,
      Math.min(10, w * 0.04)
    );
    if (ds === 'oven_front') {
      addLine(x0 + w * 0.16, y0 + h * 0.2, x0 + w * 0.84, y0 + h * 0.2, '#CBD5E1', 14);
      const knobR = Math.min(18, w * 0.032);
      addEllipse(x0 + w * 0.2, y0 + h * 0.11, knobR, knobR, '#CBD5E1', 1, '#64748B', 6);
      addEllipse(x0 + w * 0.8, y0 + h * 0.11, knobR, knobR, '#CBD5E1', 1, '#64748B', 6);
      addRect(x0 + w * 0.38, y0 + h * 0.08, w * 0.24, h * 0.06, '#1E293B', 1, '#64748B', 6);
    } else {
      addRect(x0 + w * 0.75, y0 + h * 0.18, w * 0.17, h * 0.16, '#1E293B', 1, '#64748B', 6);
      addLine(x0 + w * 0.7, y0 + h * 0.2, x0 + w * 0.7, y0 + h * 0.8, '#CBD5E1', 12);
    }
  } else if (ds === 'washer_drum' || ds === 'dryer_drum') {
    addLine(x0, y0 + h * 0.2, x0 + w, y0 + h * 0.2, '#475569', 8);
    addRect(x0 + w * 0.08, y0 + h * 0.05, w * 0.26, h * 0.1, 'none', 0, '#475569', 8, 4);
    const dialR = Math.min(20, w * 0.04);
    addEllipse(cx, y0 + h * 0.1, dialR, dialR, '#CBD5E1', 1, '#475569', 6);
    const drumR = Math.min(w, h) * 0.28;
    addEllipse(cx, y0 + h * 0.56, drumR, drumR, '#0F172A', 0.85, '#94A3B8', 14);
    addEllipse(cx, y0 + h * 0.56, Math.min(w, h) * 0.19, Math.min(w, h) * 0.19, 'none', 0, '#475569', 6);
  } else if (ds === 'fridge_single' || ds === 'fridge_double' || ds === 'fridge_side_by_side' || ds === 'fridge_french') {
    if (ds === 'fridge_double') addLine(x0, y0 + h * 0.32, x0 + w, y0 + h * 0.32, '#475569', 8);
    if (ds === 'fridge_side_by_side') {
      addLine(x0 + w * 0.42, y0, x0 + w * 0.42, y0 + h, '#475569', 8);
      addRect(x0 + w * 0.1, y0 + h * 0.25, w * 0.22, h * 0.18, '#1E293B', 1, '#475569', 8);
    }
    if (ds === 'fridge_french') {
      addLine(x0, y0 + h * 0.64, x0 + w, y0 + h * 0.64, '#475569', 8);
      addLine(cx, y0, cx, y0 + h * 0.64, '#475569', 8);
      addLine(x0 + w * 0.16, y0 + h * 0.71, x0 + w * 0.84, y0 + h * 0.71, '#475569', 12);
    }
    const hx = x0 + w * (ds === 'fridge_french' ? 0.44 : ds === 'fridge_side_by_side' ? 0.36 : 0.1);
    addLine(hx, y0 + h * 0.18, hx, y0 + h * 0.52, '#475569', 12);
  } else if (ds === 'wine_cooler') {
    const wcStroke = blackAndWhite ? '#334155' : '#92400E';
    addRect(x0 + w * 0.1, y0 + h * 0.08, w * 0.8, h * 0.84, '#0F172A', 0.82, '#334155', 8);
    for (const fy of [0.24, 0.4, 0.56, 0.72]) {
      addLine(x0 + w * 0.14, y0 + h * fy, x0 + w * 0.86, y0 + h * fy, wcStroke, 6);
    }
  } else if (ds === 'wall_tv' || ds === 'screen') {
    addRect(x0 + w * 0.03, y0 + h * 0.04, w * 0.94, h * 0.92, '#0F172A', 0.92, '#475569', 7);
    addLine(x0 + w * 0.2, y0 + h * 0.72, x0 + w * 0.44, y0 + h * 0.24, blackAndWhite ? '#475569' : '#94A3B8', 10);
  } else if (ds === 'curtain_pleat') {
    const cnt = Math.min(18, Math.max(4, Math.floor(w / 75)));
    for (let k = 0; k < cnt; k++) {
      const fx = x0 + ((k + 1) / (cnt + 1)) * w;
      addLine(fx, y0 + 10, fx, y0 + h - 10, blackAndWhite ? '#0F172A' : '#64748B', 6);
    }
  } else if (ds === 'blinds_slats') {
    const cnt = Math.min(24, Math.max(5, Math.floor(h / 55)));
    for (let k = 0; k < cnt; k++) {
      const sy = y0 + ((k + 1) / (cnt + 1)) * h;
      addLine(x0 + 8, sy, x0 + w - 8, sy, blackAndWhite ? '#0F172A' : '#64748B', 6);
    }
  } else if (ds === 'ac_indoor') {
    const st = blackAndWhite ? '#0F172A' : '#475569';
    addLine(x0 + w * 0.06, y0 + h * 0.72, x0 + w * 0.94, y0 + h * 0.72, st, 12);
    addRect(x0 + w * 0.72, y0 + h * 0.36, w * 0.14, h * 0.16, '#0F172A', 1, st, 6);
  } else if (ds === 'ac_outdoor') {
    const st = blackAndWhite ? '#0F172A' : '#475569';
    const fr = Math.min(w * 0.28, h * 0.36);
    addEllipse(x0 + w * 0.36, cy, fr, fr, '#1E293B', 0.85, st, 8);
    addEllipse(x0 + w * 0.36, cy, fr * 0.55, fr * 0.55, 'none', 0, '#94A3B8', 6);
    addLine(x0 + w * 0.74, y0 + h * 0.12, x0 + w * 0.74, y0 + h * 0.88, st, 8);
  } else if ((ds === 'fluted' || ds === 'slatted_wood') && w > 120) {
    const cnt = Math.min(18, Math.max(4, Math.floor(w / 65)));
    for (let k = 0; k < cnt; k++) {
      const fx = x0 + ((k + 1) / (cnt + 1)) * w;
      addLine(fx, y0 + 12, fx, y0 + h - 12, '#64748B', 5);
    }
  } else if (ds === 'hood_filter') {
    for (let k = 0; k < 7; k++) {
      const lx = x0 + ((k + 1) / 8) * w;
      addLine(lx, y0 + h * 0.15, lx, y0 + h * 0.85, '#64748B', 6);
    }
  } else if (ds === 'dishwasher') {
    addRect(x0 + w * 0.02, y0 + h * 0.02, w * 0.96, h * 0.13, '#1E293B', 1, '#475569', 8);
    addRect(x0 + w * 0.38, y0 + h * 0.06, w * 0.24, h * 0.05, '#0F172A', 1, 'none', 0);
    addRect(x0 + w * 0.02, y0 + h * 0.16, w * 0.96, h * 0.72, '#CBD5E1', 0.35, '#475569', 8);
    addLine(x0 + w * 0.14, y0 + h * 0.22, x0 + w * 0.86, y0 + h * 0.22, '#334155', 14);
    addRect(x0 + w * 0.04, y0 + h * 0.89, w * 0.92, h * 0.11, '#334155', 1, '#475569', 8);
  } else if (ds === 'washer_topload') {
    addRect(x0 + w * 0.02, y0, w * 0.96, h * 0.12, '#F1F5F9', 1, '#475569', 8);
    const kr = Math.min(20, w * 0.04);
    addEllipse(cx, y0 + h * 0.06, kr, kr, '#CBD5E1', 1, '#475569', 6);
    addLine(x0, y0 + h * 0.13, x0 + w, y0 + h * 0.13, '#475569', 8);
    addRect(x0 + w * 0.14, y0 + h * 0.15, w * 0.72, h * 0.03, '#0F172A', 1, '#475569', 6);
  } else if (ds === 'stand_mixer') {
    addRect(x0 + w * 0.12, y0 + h * 0.06, w * 0.76, h * 0.28, '#F8FAFC', 1, '#475569', 8, Math.min(20, h * 0.12));
    addRect(x0 + w * 0.2, y0 + h * 0.34, w * 0.42, h * 0.46, '#CBD5E1', 0.85, '#475569', 8);
    addRect(x0 + w * 0.06, y0 + h * 0.88, w * 0.88, h * 0.12, '#E2E8F0', 1, '#475569', 8);
  } else if (ds === 'lamp_base') {
    addEllipse(cx, cy, w * 0.46, h * 0.44, 'none', 0, '#94A3B8', 7);
  } else if (ds === 'faucet') {
    elements.push({
      id: nextId(),
      kind: 'path',
      name: `${p.name} Spout`,
      d: `M ${round2(cx)} ${round2(y0 + h)} L ${round2(cx)} ${round2(y0 + h * 0.28)} Q ${round2(cx + w * 0.18)} ${round2(y0 + 6)} ${round2(cx + w * 0.34)} ${round2(y0 + h * 0.35)}`,
      stroke: blackAndWhite ? '#0F172A' : '#334155',
      strokeWidthMm: 12,
      fill: 'none',
      fillOpacity: 0,
      visible: true,
    });
  }
}

/**
 * Generates Wall View Default-mode SVG vector elements directly from visible
 * world-projected parts (`projectFurnitureForWallCutThrough`).
 */
export function generateWallCutThroughElevationElements(
  visibleParts: CutThroughProjectedPart[],
  furn: Pick<FurnitureInstance, 'templateId' | 'rotationXDeg' | 'rotationYDeg'>,
  blackAndWhite: boolean
): SvgVectorElement[] {
  const elements: SvgVectorElement[] = [];
  const hasTilt = Math.abs(furn.rotationXDeg ?? 0) >= 0.05 || Math.abs(furn.rotationYDeg ?? 0) >= 0.05;

  for (let idx = 0; idx < visibleParts.length; idx++) {
    const vp = visibleParts[idx];
    const p = vp.part;
    const ds = p.detailStyle;
    const x0 = vp.viewX - vp.elevW / 2;
    const y0 = -(vp.zBottom + vp.elevH);
    const w = vp.elevW;
    const h = vp.elevH;
    const cx = vp.viewX;
    const cy = -(vp.zBottom + h / 2);

    const fill = blackAndWhite ? 'none' : p.color;
    const fillOpacity = blackAndWhite
      ? 0
      : p.material === 'glass' || (furn.templateId === 'curtain_linen_drapes' && ds === 'curtain_pleat')
        ? 0.35
        : 1;
    const stroke = blackAndWhite ? '#0F172A' : '#475569';

    if (vp.elevPolygon && vp.elevPolygon.length >= 3) {
      elements.push({
        id: `wv_part_${idx}`,
        kind: 'polyline',
        name: p.name,
        points: vp.elevPolygon.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) })),
        closed: true,
        stroke,
        strokeWidthMm: 8,
        fill,
        fillOpacity,
        visible: true,
      });
    } else if (p.shape === 'oval' && ds === 'mirror') {
      elements.push({
        id: `wv_part_${idx}`,
        kind: 'ellipse',
        name: p.name,
        cx: round2(cx),
        cy: round2(cy),
        rx: round2(w / 2),
        ry: round2(h / 2),
        stroke,
        strokeWidthMm: 8,
        fill,
        fillOpacity,
        visible: true,
      });
      elements.push({
        id: `wv_part_${idx}_shine`,
        kind: 'line',
        name: `${p.name} Shine`,
        x1: round2(cx - w * 0.22),
        y1: round2(cy + h * 0.14),
        x2: round2(cx + w * 0.22),
        y2: round2(cy - h * 0.18),
        stroke: blackAndWhite ? '#475569' : '#FFFFFF',
        strokeWidthMm: 10,
        visible: true,
      });
    } else {
      const rx =
        p.shape === 'rounded_rect'
          ? Math.min(24, w * 0.2, h * 0.2)
          : p.shape === 'oval'
            ? Math.min(w, h) * 0.28
            : 0;
      elements.push({
        id: `wv_part_${idx}`,
        kind: 'rect',
        name: p.name,
        x: round2(x0),
        y: round2(y0),
        width: round2(w),
        height: round2(h),
        rx: rx > 0 ? round2(rx) : undefined,
        stroke,
        strokeWidthMm: 8,
        fill,
        fillOpacity,
        visible: true,
      });
    }

    if (!hasTilt) {
      appendBoundedElevationPartAccents(elements, vp, idx, blackAndWhite);
    }
  }

  return elements;
}

/**
 * Generates an orthographic elevation ProjectedViewSvg ('front' | 'rear' | 'left' | 'right')
 * directly from FurniturePart[] geometry, incorporating any mirror/tilt transforms.
 */
export function generateDefaultElevationViewFromParts(
  parts: FurniturePart[],
  view: Exclude<ProjectionViewId, 'top'>,
  options?: {
    rotationXDeg?: number;
    rotationYDeg?: number;
    mirroredX?: boolean;
    mirroredY?: boolean;
    templateId?: string;
  }
): ProjectedViewSvg | null {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const rxDeg = options?.rotationXDeg ?? 0;
  const ryDeg = options?.rotationYDeg ?? 0;
  const hasTilt = Math.abs(rxDeg) >= 0.05 || Math.abs(ryDeg) >= 0.05;
  const mx = options?.mirroredX ? -1 : 1;
  const my = options?.mirroredY ? -1 : 1;

  const projectPt = (lx: number, ly: number, lz: number) => {
    const px = lx * mx;
    const py = ly * my;
    const r = hasTilt ? rotateThreeYXZ(px, lz, py, rxDeg, ryDeg) : { x: px, y: py, z: lz };
    let u = r.x;
    let depth = r.y;
    if (view === 'rear') {
      u = -r.x;
      depth = -r.y;
    } else if (view === 'left') {
      u = r.y;
      depth = -r.x;
    } else if (view === 'right') {
      u = -r.y;
      depth = r.x;
    }
    return { u, z: r.z, depth };
  };

  let minU = Infinity;
  let maxU = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const partRecords = parts.map((part, idx) => {
    const pts2D: Point2D[] = [];
    let pMinU = Infinity;
    let pMaxU = -Infinity;
    let pMinZ = Infinity;
    let pMaxZ = -Infinity;
    let depthSum = 0;
    const bVerts = getPartFurnitureLocalBoundary3D(part, options?.templateId);
    for (const v of bVerts) {
      const pr = projectPt(v.x, v.y, v.z);
      if (pr.u < minU) minU = pr.u;
      if (pr.u > maxU) maxU = pr.u;
      if (pr.z < minZ) minZ = pr.z;
      if (pr.z > maxZ) maxZ = pr.z;
      if (pr.u < pMinU) pMinU = pr.u;
      if (pr.u > pMaxU) pMaxU = pr.u;
      if (pr.z < pMinZ) pMinZ = pr.z;
      if (pr.z > pMaxZ) pMaxZ = pr.z;
      depthSum += pr.depth;
      pts2D.push({ x: pr.u, y: pr.z });
    }
    return {
      part,
      idx,
      pts2D,
      pMinU,
      pMaxU,
      pMinZ,
      pMaxZ,
      avgDepth: bVerts.length > 0 ? depthSum / bVerts.length : 0,
    };
  });

  if (!Number.isFinite(minU) || !Number.isFinite(minZ)) return null;
  const centerU = (minU + maxU) / 2;
  const elevW = Math.max(20, Math.round(maxU - minU));
  const elevH = Math.max(20, Math.round(maxZ - minZ));

  partRecords.sort((a, b) => a.avgDepth - b.avgDepth || a.pMinZ - b.pMinZ);
  const elements: SvgVectorElement[] = [];

  for (const rec of partRecords) {
    const p = rec.part;
    const fill = p.material === 'glass' ? '#E0F2FE' : p.color || '#FFFFFF';
    const fillOpacity = p.material === 'glass' ? 0.45 : 1;
    const shifted = rec.pts2D.map((pt) => ({ x: pt.x - centerU, y: -(pt.y - minZ) }));
    const hull = computeConvexHull2D(shifted);
    if (hull.length >= 3) {
      elements.push({
        id: `def_elev_${view}_${rec.idx}`,
        kind: 'polyline',
        name: p.name,
        points: hull.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) })),
        closed: true,
        stroke: '#1E293B',
        strokeWidthMm: 8,
        fill,
        fillOpacity,
        visible: true,
      });
    }
  }

  return {
    view,
    viewBox: {
      minX: -elevW / 2,
      minY: -elevH,
      width: elevW,
      height: elevH,
    },
    baseWidthMm: elevW,
    baseHeightMm: elevH,
    elements,
  };
}

function rotatePoint2DLocal(pt: Point2D, rad: number): Point2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: pt.x * c - pt.y * s,
    y: pt.x * s + pt.y * c,
  };
}

/**
 * Extracts accurate 2D boundary points (in element local mm coordinates) from an SvgVectorElement,
 * sampling rounded <rect rx>, ellipses, polylines, lines, and path commands.
 */
export function extractSvgElementLocalPoints(el: SvgVectorElement): Point2D[] {
  const pts: Point2D[] = [];
  if (!el.visible) return pts;

  if (el.kind === 'rect') {
    const x0 = el.x;
    const y0 = el.y;
    const w = el.width;
    const h = el.height;
    const r = el.rx && el.rx > 0 ? Math.min(el.rx, w * 0.48, h * 0.48) : 0;
    const rawPts: Point2D[] = [];
    if (r > 0.5) {
      const sampleQuad = (ax: number, ay: number, cx: number, cy: number, bx: number, by: number) => {
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          const omt = 1 - t;
          rawPts.push({
            x: omt * omt * ax + 2 * omt * t * cx + t * t * bx,
            y: omt * omt * ay + 2 * omt * t * cy + t * t * by,
          });
        }
      };
      sampleQuad(x0 + w - r, y0, x0 + w, y0, x0 + w, y0 + r);
      sampleQuad(x0 + w, y0 + h - r, x0 + w, y0 + h, x0 + w - r, y0 + h);
      sampleQuad(x0 + r, y0 + h, x0, y0 + h, x0, y0 + h - r);
      sampleQuad(x0, y0 + r, x0, y0, x0 + r, y0);
    } else {
      rawPts.push(
        { x: x0, y: y0 },
        { x: x0 + w, y: y0 },
        { x: x0 + w, y: y0 + h },
        { x: x0, y: y0 + h }
      );
    }
    if (el.rotationDeg) {
      const cx = x0 + w / 2;
      const cy = y0 + h / 2;
      const rad = (el.rotationDeg * Math.PI) / 180;
      for (const p of rawPts) {
        const rp = rotatePoint2DLocal({ x: p.x - cx, y: p.y - cy }, rad);
        pts.push({ x: cx + rp.x, y: cy + rp.y });
      }
    } else {
      pts.push(...rawPts);
    }
  } else if (el.kind === 'ellipse') {
    const rad = ((el.rotationDeg ?? 0) * Math.PI) / 180;
    const steps = 28;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const lx = Math.cos(t) * el.rx;
      const ly = Math.sin(t) * el.ry;
      const rp = rad ? rotatePoint2DLocal({ x: lx, y: ly }, rad) : { x: lx, y: ly };
      pts.push({ x: el.cx + rp.x, y: el.cy + rp.y });
    }
  } else if (el.kind === 'line') {
    pts.push({ x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 });
  } else if (el.kind === 'polyline') {
    pts.push(...el.points);
  } else if (el.kind === 'path') {
    const tokens = el.d.match(/[MLZACQHV]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
    let i = 0;
    let cmd = '';
    let curX = 0;
    let curY = 0;
    while (i < tokens.length) {
      const tk = tokens[i];
      if (/^[MLZACQHV]$/i.test(tk)) {
        cmd = tk.toUpperCase();
        i++;
        continue;
      }
      if (cmd === 'M' || cmd === 'L') {
        const x = Number(tokens[i]);
        const y = Number(tokens[i + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          curX = x;
          curY = y;
          pts.push({ x, y });
        }
        i += 2;
      } else if (cmd === 'H') {
        const x = Number(tokens[i]);
        if (Number.isFinite(x)) {
          curX = x;
          pts.push({ x: curX, y: curY });
        }
        i += 1;
      } else if (cmd === 'V') {
        const y = Number(tokens[i]);
        if (Number.isFinite(y)) {
          curY = y;
          pts.push({ x: curX, y: curY });
        }
        i += 1;
      } else if (cmd === 'A') {
        const rx = Math.abs(Number(tokens[i]));
        const ry = Math.abs(Number(tokens[i + 1]));
        const rot = (Number(tokens[i + 2]) * Math.PI) / 180;
        const largeArc = Number(tokens[i + 3]) !== 0;
        const sweep = Number(tokens[i + 4]) !== 0;
        const x = Number(tokens[i + 5]);
        const y = Number(tokens[i + 6]);
        if ([rx, ry, rot, x, y].every(Number.isFinite)) {
          // Sample elliptical arc points so curved SVG paths report exact extents
          if (rx > 0.1 && ry > 0.1 && (x !== curX || y !== curY)) {
            const dx2 = (curX - x) / 2;
            const dy2 = (curY - y) / 2;
            const cosR = Math.cos(rot);
            const sinR = Math.sin(rot);
            const x1p = cosR * dx2 + sinR * dy2;
            const y1p = -sinR * dx2 + cosR * dy2;
            let rxAdj = rx;
            let ryAdj = ry;
            const lambda = (x1p * x1p) / (rxAdj * rxAdj) + (y1p * y1p) / (ryAdj * ryAdj);
            if (lambda > 1) {
              const s = Math.sqrt(lambda);
              rxAdj *= s;
              ryAdj *= s;
            }
            const sign = largeArc === sweep ? -1 : 1;
            const num = Math.max(
              0,
              rxAdj * rxAdj * ryAdj * ryAdj - rxAdj * rxAdj * y1p * y1p - ryAdj * ryAdj * x1p * x1p
            );
            const den = rxAdj * rxAdj * y1p * y1p + ryAdj * ryAdj * x1p * x1p;
            const coef = den > 1e-8 ? sign * Math.sqrt(num / den) : 0;
            const cxp = (coef * rxAdj * y1p) / ryAdj;
            const cyp = (-coef * ryAdj * x1p) / rxAdj;
            const cx = cosR * cxp - sinR * cyp + (curX + x) / 2;
            const cy = sinR * cxp + cosR * cyp + (curY + y) / 2;
            const angle = (ux: number, uy: number, vx: number, vy: number) => {
              const dot = ux * vx + uy * vy;
              const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
              const a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
              return ux * vy - uy * vx < 0 ? -a : a;
            };
            const t1 = angle(1, 0, (x1p - cxp) / rxAdj, (y1p - cyp) / ryAdj);
            let dt = angle(
              (x1p - cxp) / rxAdj,
              (y1p - cyp) / ryAdj,
              (-x1p - cxp) / rxAdj,
              (-y1p - cyp) / ryAdj
            );
            if (!sweep && dt > 0) dt -= Math.PI * 2;
            if (sweep && dt < 0) dt += Math.PI * 2;
            for (let k = 1; k <= 36; k++) {
              const th = t1 + (dt * k) / 36;
              const px = cx + cosR * rxAdj * Math.cos(th) - sinR * ryAdj * Math.sin(th);
              const py = cy + sinR * rxAdj * Math.cos(th) + cosR * ryAdj * Math.sin(th);
              pts.push({ x: px, y: py });
            }
          }
          curX = x;
          curY = y;
          pts.push({ x, y });
        }
        i += 7;
      } else if (cmd === 'Q') {
        const cx = Number(tokens[i]);
        const cy = Number(tokens[i + 1]);
        const x = Number(tokens[i + 2]);
        const y = Number(tokens[i + 3]);
        if ([cx, cy, x, y].every(Number.isFinite)) {
          for (let k = 1; k <= 6; k++) {
            const t = k / 6;
            const omt = 1 - t;
            pts.push({
              x: omt * omt * curX + 2 * omt * t * cx + t * t * x,
              y: omt * omt * curY + 2 * omt * t * cy + t * t * y,
            });
          }
          curX = x;
          curY = y;
        }
        i += 4;
      } else if (cmd === 'C') {
        const c1x = Number(tokens[i]);
        const c1y = Number(tokens[i + 1]);
        const c2x = Number(tokens[i + 2]);
        const c2y = Number(tokens[i + 3]);
        const x = Number(tokens[i + 4]);
        const y = Number(tokens[i + 5]);
        if ([c1x, c1y, c2x, c2y, x, y].every(Number.isFinite)) {
          for (let k = 1; k <= 6; k++) {
            const t = k / 6;
            const omt = 1 - t;
            pts.push({
              x: omt ** 3 * curX + 3 * omt ** 2 * t * c1x + 3 * omt * t ** 2 * c2x + t ** 3 * x,
              y: omt ** 3 * curY + 3 * omt ** 2 * t * c1y + 3 * omt * t ** 2 * c2y + t ** 3 * y,
            });
          }
          curX = x;
          curY = y;
        }
        i += 6;
      } else {
        i++;
      }
    }
  }
  return pts;
}

/**
 * Computes uniform aspect-fit scale (sx === sy) when fitting a custom/imported SVG
 * inside target bounds without stretching, or exact non-uniform scaling for derived/3D views.
 */
export function computeSvgFitScale(
  baseWidthMm: number,
  baseHeightMm: number,
  targetWidthMm: number,
  targetHeightMm: number,
  preserveAspect: boolean
): { scaleX: number; scaleY: number } {
  const sx = baseWidthMm > 0 ? targetWidthMm / baseWidthMm : 1;
  const sy = baseHeightMm > 0 ? targetHeightMm / baseHeightMm : 1;
  if (!preserveAspect) return { scaleX: sx, scaleY: sy };
  const uniform = Math.min(sx, sy);
  return { scaleX: uniform, scaleY: uniform };
}

