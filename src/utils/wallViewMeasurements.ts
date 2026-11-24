import type { FurnitureInstance, Room, Wall } from '../types/plan';
import { formatSmartMetric } from './units';
import { resolveWallFaces } from './geometry';
import { resolveFurnitureMountingType } from './mounting';
import type {
  WallViewClearancesResult,
  WallViewDragBounds,
  WallViewElevRect,
  WallViewOpeningObstacle,
} from './wallViewFurniture';

export interface ElevPoint {
  xMm: number;
  zMm: number;
}

export type WallViewSnapKind = 'corner' | 'wall' | 'furniture' | 'opening' | 'edge' | 'free';

export interface WallViewSnapTarget {
  xMm: number;
  zMm: number;
  kind: 'corner' | 'wall' | 'furniture' | 'opening';
  label: string;
}

export interface WallViewSnapEdge {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  kind: 'wall' | 'furniture' | 'opening';
  label: string;
}

export interface WallViewSnapGeometry {
  points: WallViewSnapTarget[];
  edges: WallViewSnapEdge[];
}

export interface WallViewSnapResult {
  point: ElevPoint;
  snappedKind: WallViewSnapKind;
  label?: string;
}

export interface WallViewRoomDims {
  roomId: string;
  roomName: string;
  leftX: number;
  rightX: number;
  widthMm: number;
  heightMm: number;
}

export interface WallViewElevDimSpec {
  dimKey: string;
  category: 'room_wall' | 'furniture';
  kind:
    | 'room_width'
    | 'room_height'
    | 'furn_width'
    | 'furn_height'
    | 'furn_floor'
    | 'furn_ceiling'
    | 'furn_corner'
    | 'neighbor_width'
    | 'neighbor_height';
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  ext1x?: number;
  ext1z?: number;
  ext2x?: number;
  ext2z?: number;
  valueMm: number;
  vertical: boolean;
  hoverId?: string;
  subtle?: boolean;
  prefix?: string;
  nudgeDir: 1 | -1 | 0;
  priority: number;
  labelOffsetPerpMm?: number;
}

export interface WorldBox2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Extracts exact model-millimeter elevation snap points & edges for the Wall View measurement tool.
 */
export function extractWallViewSnapGeometry(params: {
  wallLenMm: number;
  wallHeightMm: number;
  innerLeftX: number;
  innerRightX: number;
  furnRects: WallViewElevRect[];
  wallEdgeObstacles: WallViewOpeningObstacle[];
  solidArchObstacles: WallViewOpeningObstacle[];
}): WallViewSnapGeometry {
  const {
    wallLenMm,
    wallHeightMm,
    innerLeftX,
    innerRightX,
    furnRects,
    wallEdgeObstacles,
    solidArchObstacles,
  } = params;

  const points: WallViewSnapTarget[] = [
    { xMm: 0, zMm: 0, kind: 'corner', label: 'Wall bottom-left' },
    { xMm: 0, zMm: wallHeightMm, kind: 'corner', label: 'Wall top-left' },
    { xMm: wallLenMm, zMm: 0, kind: 'corner', label: 'Wall bottom-right' },
    { xMm: wallLenMm, zMm: wallHeightMm, kind: 'corner', label: 'Wall top-right' },
  ];

  if (Math.abs(innerLeftX) > 2) {
    points.push(
      { xMm: innerLeftX, zMm: 0, kind: 'corner', label: 'Inner left corner (floor)' },
      { xMm: innerLeftX, zMm: wallHeightMm, kind: 'corner', label: 'Inner left corner (ceiling)' }
    );
  }
  if (Math.abs(innerRightX - wallLenMm) > 2) {
    points.push(
      { xMm: innerRightX, zMm: 0, kind: 'corner', label: 'Inner right corner (floor)' },
      { xMm: innerRightX, zMm: wallHeightMm, kind: 'corner', label: 'Inner right corner (ceiling)' }
    );
  }

  const edges: WallViewSnapEdge[] = [
    { x1: 0, z1: 0, x2: wallLenMm, z2: 0, kind: 'wall', label: 'Floor line' },
    { x1: 0, z1: wallHeightMm, x2: wallLenMm, z2: wallHeightMm, kind: 'wall', label: 'Ceiling line' },
    { x1: innerLeftX, z1: 0, x2: innerLeftX, z2: wallHeightMm, kind: 'wall', label: 'Left inner wall' },
    { x1: innerRightX, z1: 0, x2: innerRightX, z2: wallHeightMm, kind: 'wall', label: 'Right inner wall' },
  ];
  if (Math.abs(innerLeftX) > 2) {
    edges.push({ x1: 0, z1: 0, x2: 0, z2: wallHeightMm, kind: 'wall', label: 'Wall left edge' });
  }
  if (Math.abs(innerRightX - wallLenMm) > 2) {
    edges.push({ x1: wallLenMm, z1: 0, x2: wallLenMm, z2: wallHeightMm, kind: 'wall', label: 'Wall right edge' });
  }

  const addRect = (
    r: { leftX: number; rightX: number; zBottom: number; zTop: number; name: string },
    kind: 'furniture' | 'opening'
  ) => {
    const midX = (r.leftX + r.rightX) / 2;
    const midZ = (r.zBottom + r.zTop) / 2;
    points.push(
      { xMm: r.leftX, zMm: r.zBottom, kind, label: `${r.name} bottom-left` },
      { xMm: r.rightX, zMm: r.zBottom, kind, label: `${r.name} bottom-right` },
      { xMm: r.leftX, zMm: r.zTop, kind, label: `${r.name} top-left` },
      { xMm: r.rightX, zMm: r.zTop, kind, label: `${r.name} top-right` },
      { xMm: midX, zMm: r.zBottom, kind, label: `${r.name} bottom mid` },
      { xMm: midX, zMm: r.zTop, kind, label: `${r.name} top mid` },
      { xMm: r.leftX, zMm: midZ, kind, label: `${r.name} left mid` },
      { xMm: r.rightX, zMm: midZ, kind, label: `${r.name} right mid` }
    );
    edges.push(
      { x1: r.leftX, z1: r.zBottom, x2: r.rightX, z2: r.zBottom, kind, label: `${r.name} bottom edge` },
      { x1: r.leftX, z1: r.zTop, x2: r.rightX, z2: r.zTop, kind, label: `${r.name} top edge` },
      { x1: r.leftX, z1: r.zBottom, x2: r.leftX, z2: r.zTop, kind, label: `${r.name} left edge` },
      { x1: r.rightX, z1: r.zBottom, x2: r.rightX, z2: r.zTop, kind, label: `${r.name} right edge` }
    );
  };

  for (const r of furnRects) addRect(r, 'furniture');
  const seenObs = new Set<string>();
  for (const o of [...wallEdgeObstacles, ...solidArchObstacles]) {
    if (seenObs.has(o.id)) continue;
    seenObs.add(o.id);
    addRect(o, 'opening');
  }

  return { points, edges };
}

/**
 * Snaps a raw model-coordinate elevation pointer position to corners, furniture edges, openings, or wall lines.
 * Holding Shift (`bypassSnap: true`) returns exact raw model coordinates.
 */
export function snapWallViewMeasurementPoint(
  rawPt: ElevPoint,
  geom: WallViewSnapGeometry,
  options: {
    bypassSnap: boolean;
    pointTolMm: number;
    edgeTolMm: number;
  }
): WallViewSnapResult {
  if (options.bypassSnap) {
    return {
      point: { xMm: Math.round(rawPt.xMm), zMm: Math.round(rawPt.zMm) },
      snappedKind: 'free',
    };
  }

  let bestPt: WallViewSnapTarget | null = null;
  let bestPtDist = options.pointTolMm;
  for (const p of geom.points) {
    const d = Math.hypot(p.xMm - rawPt.xMm, p.zMm - rawPt.zMm);
    if (d <= bestPtDist) {
      bestPtDist = d;
      bestPt = p;
    }
  }
  if (bestPt) {
    return {
      point: { xMm: Math.round(bestPt.xMm), zMm: Math.round(bestPt.zMm) },
      snappedKind: bestPt.kind,
      label: bestPt.label,
    };
  }

  let bestEdgePt: ElevPoint | null = null;
  let bestEdgeLabel: string | undefined;
  let bestEdgeDist = options.edgeTolMm;
  for (const e of geom.edges) {
    const dx = e.x2 - e.x1;
    const dz = e.z2 - e.z1;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-6) continue;
    const t = Math.max(
      0,
      Math.min(1, ((rawPt.xMm - e.x1) * dx + (rawPt.zMm - e.z1) * dz) / lenSq)
    );
    const px = e.x1 + dx * t;
    const pz = e.z1 + dz * t;
    const d = Math.hypot(px - rawPt.xMm, pz - rawPt.zMm);
    if (d <= bestEdgeDist) {
      bestEdgeDist = d;
      bestEdgePt = { xMm: Math.round(px), zMm: Math.round(pz) };
      bestEdgeLabel = e.label;
    }
  }
  if (bestEdgePt) {
    return {
      point: bestEdgePt,
      snappedKind: 'edge',
      label: bestEdgeLabel,
    };
  }

  return {
    point: { xMm: Math.round(rawPt.xMm), zMm: Math.round(rawPt.zMm) },
    snappedKind: 'free',
  };
}

/**
 * Computes enclosing room width & height along the viewed wall face when the face borders a detected room.
 */
export function computeWallViewRoomDimensions(params: {
  wall: Wall;
  rooms: Room[];
  viewedPhysicalSide: 'left' | 'right';
  wallLenMm: number;
  wallHeightMm: number;
  isLeftView: boolean;
}): WallViewRoomDims | null {
  const { wall, rooms, viewedPhysicalSide, wallLenMm, wallHeightMm, isLeftView } = params;
  const faces = resolveWallFaces(wall, rooms);
  const roomId = viewedPhysicalSide === 'left' ? faces.left.roomId : faces.right.roomId;
  if (!roomId) return null;
  const room = rooms.find((r) => r.id === roomId && r.visible && r.polygon.length >= 3);
  if (!room) return null;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const straightLen = Math.hypot(dx, dy) || 1;
  const ux = dx / straightLen;
  const uy = dy / straightLen;

  let minS = Infinity;
  let maxS = -Infinity;
  for (const pt of room.polygon) {
    const s = (pt.x - wall.start.x) * ux + (pt.y - wall.start.y) * uy;
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
  if (!Number.isFinite(minS) || !Number.isFinite(maxS) || maxS - minS < 50) return null;

  const mapX = (s: number) => (isLeftView ? s : wallLenMm - s);
  const x1 = mapX(minS);
  const x2 = mapX(maxS);
  const leftX = Math.round(Math.min(x1, x2));
  const rightX = Math.round(Math.max(x1, x2));
  const widthMm = Math.max(100, rightX - leftX);

  return {
    roomId: room.id,
    roomName: room.name,
    leftX,
    rightX,
    widthMm,
    heightMm: Math.round(wallHeightMm),
  };
}

/**
 * Generates contextual furniture dimensions for Wall View:
 * - When a furniture piece is selected/dragged: shows its W × H, floor height, ceiling gap,
 *   distance along the wall to its nearest relevant corner (especially for wall-mounted items),
 *   and immediate neighboring furniture W × H alongside the 4-cardinal clearances.
 * - When nothing is selected: shows clean W × H, floor height, and nearest corner distance for
 *   wall-mounted furniture on the viewed wall.
 */
export function computeWallViewFurnitureDimensions(params: {
  activeFurnId: string | undefined;
  furnRects: WallViewElevRect[];
  furnRectById: Map<string, WallViewElevRect>;
  allFurniture: FurnitureInstance[];
  clearances: WallViewClearancesResult | null;
  dragBounds: WallViewDragBounds;
  targetWallId: string;
}): WallViewElevDimSpec[] {
  const {
    activeFurnId,
    furnRects,
    furnRectById,
    allFurniture,
    clearances,
    dragBounds,
    targetWallId,
  } = params;

  const furnById = new Map(allFurniture.map((f) => [f.id, f]));
  const dims: WallViewElevDimSpec[] = [];

  const isWallMountedItem = (f: FurnitureInstance | undefined) => {
    if (!f) return false;
    return f.attachedWallId === targetWallId || resolveFurnitureMountingType(f) === 'wall';
  };

  if (activeFurnId) {
    const rect = furnRectById.get(activeFurnId);
    const item = furnById.get(activeFurnId);
    if (!rect || !item) return dims;

    // 1. Selected furniture Width (above top edge) & Height (to right or left)
    const ceilingRoom = dragBounds.wallHeightMm - rect.zTop;
    const widthAbove = ceilingRoom >= 140 || rect.zBottom < 140;
    const widthZ = widthAbove ? rect.zTop + 120 : Math.max(60, rect.zBottom - 120);
    dims.push({
      dimKey: `fd_w:${rect.id}`,
      category: 'furniture',
      kind: 'furn_width',
      x1: rect.leftX,
      z1: widthZ,
      x2: rect.rightX,
      z2: widthZ,
      ext1x: rect.leftX,
      ext1z: widthAbove ? rect.zTop : rect.zBottom,
      ext2x: rect.rightX,
      ext2z: widthAbove ? rect.zTop : rect.zBottom,
      valueMm: rect.elevW,
      vertical: false,
      hoverId: rect.id,
      prefix: 'W',
      nudgeDir: widthAbove ? 1 : -1,
      priority: 100,
    });

    const spaceRight = dragBounds.innerRightX - rect.rightX;
    const spaceLeft = rect.leftX - dragBounds.innerLeftX;
    const heightOnRight = spaceRight >= 160 || spaceRight >= spaceLeft;
    const heightX = heightOnRight ? rect.rightX + 120 : rect.leftX - 120;
    dims.push({
      dimKey: `fd_h:${rect.id}`,
      category: 'furniture',
      kind: 'furn_height',
      x1: heightX,
      z1: rect.zBottom,
      x2: heightX,
      z2: rect.zTop,
      ext1x: heightOnRight ? rect.rightX : rect.leftX,
      ext1z: rect.zBottom,
      ext2x: heightOnRight ? rect.rightX : rect.leftX,
      ext2z: rect.zTop,
      valueMm: rect.elevH,
      vertical: true,
      hoverId: rect.id,
      prefix: 'H',
      nudgeDir: heightOnRight ? 1 : -1,
      priority: 98,
    });

    // 2. Height above floor (when not already represented identically by bottom clearance to Floor)
    const floorShownByClearance =
      clearances?.bottom && clearances.bottom.boundaryLabel === 'Floor';
    if (rect.zBottom >= 5 && !floorShownByClearance) {
      const floorX = Math.max(dragBounds.innerLeftX + 60, rect.leftX + Math.min(80, rect.elevW * 0.2));
      dims.push({
        dimKey: `fd_floor:${rect.id}`,
        category: 'furniture',
        kind: 'furn_floor',
        x1: floorX,
        z1: 0,
        x2: floorX,
        z2: rect.zBottom,
        ext1x: rect.leftX,
        ext1z: 0,
        ext2x: rect.leftX,
        ext2z: rect.zBottom,
        valueMm: rect.zBottom,
        vertical: true,
        hoverId: rect.id,
        subtle: true,
        prefix: 'Fl',
        nudgeDir: -1,
        priority: 82,
      });
    }

    // 3. Distance to ceiling (when not already represented identically by top clearance to Ceiling)
    const ceilingShownByClearance =
      clearances?.top && clearances.top.boundaryLabel === 'Ceiling';
    if (ceilingRoom >= 5 && !ceilingShownByClearance) {
      const ceilX = Math.min(dragBounds.innerRightX - 60, rect.rightX - Math.min(80, rect.elevW * 0.2));
      dims.push({
        dimKey: `fd_ceil:${rect.id}`,
        category: 'furniture',
        kind: 'furn_ceiling',
        x1: ceilX,
        z1: rect.zTop,
        x2: ceilX,
        z2: dragBounds.wallHeightMm,
        ext1x: rect.rightX,
        ext1z: rect.zTop,
        ext2x: rect.rightX,
        ext2z: dragBounds.wallHeightMm,
        valueMm: ceilingRoom,
        vertical: true,
        hoverId: rect.id,
        subtle: true,
        prefix: 'Ceil',
        nudgeDir: 1,
        priority: 80,
      });
    }

    // 4. Nearest wall corner along the wall (always for wall-mounted items, or when corner gap differs from adjacent clearance)
    const leftCornerGap = Math.max(0, rect.leftX - dragBounds.innerLeftX);
    const rightCornerGap = Math.max(0, dragBounds.innerRightX - rect.rightX);
    const nearestSide = leftCornerGap <= rightCornerGap ? 'left' : 'right';
    const nearestGap = nearestSide === 'left' ? leftCornerGap : rightCornerGap;
    const cornerShownByClearance =
      (nearestSide === 'left' && clearances?.left?.boundaryLabel === 'Left wall') ||
      (nearestSide === 'right' && clearances?.right?.boundaryLabel === 'Right wall');

    if (nearestGap >= 5 && !cornerShownByClearance && (isWallMountedItem(item) || nearestGap > 5)) {
      const cornerZ = Math.min(dragBounds.wallHeightMm - 90, rect.zTop + 230);
      const cx1 = nearestSide === 'left' ? dragBounds.innerLeftX : rect.rightX;
      const cx2 = nearestSide === 'left' ? rect.leftX : dragBounds.innerRightX;
      dims.push({
        dimKey: `fd_corner:${rect.id}`,
        category: 'furniture',
        kind: 'furn_corner',
        x1: cx1,
        z1: cornerZ,
        x2: cx2,
        z2: cornerZ,
        ext1x: cx1,
        ext1z: rect.zTop,
        ext2x: cx2,
        ext2z: rect.zTop,
        valueMm: nearestGap,
        vertical: false,
        hoverId: rect.id,
        subtle: true,
        prefix: 'Corner',
        nudgeDir: 1,
        priority: isWallMountedItem(item) ? 90 : 75,
      });
    }

    // 5. Immediate neighbor widths (for adjacent objects identified by clearances, max 2 horizontal neighbors)
    if (clearances) {
      const neighborNames = new Set<string>();
      if (clearances.left && clearances.left.boundaryLabel !== 'Left wall') {
        neighborNames.add(clearances.left.boundaryLabel);
      }
      if (clearances.right && clearances.right.boundaryLabel !== 'Right wall') {
        neighborNames.add(clearances.right.boundaryLabel);
      }
      if (clearances.bottom && clearances.bottom.boundaryLabel !== 'Floor') {
        neighborNames.add(clearances.bottom.boundaryLabel);
      }
      if (clearances.top && clearances.top.boundaryLabel !== 'Ceiling') {
        neighborNames.add(clearances.top.boundaryLabel);
      }
      let addedNeighbors = 0;
      for (const nr of furnRects) {
        if (nr.id === rect.id || !neighborNames.has(nr.name)) continue;
        if (addedNeighbors >= 3) break;
        addedNeighbors += 1;
        const nAbove = dragBounds.wallHeightMm - nr.zTop >= 120;
        const nz = nAbove ? nr.zTop + 100 : Math.max(50, nr.zBottom - 100);
        dims.push({
          dimKey: `fd_nw:${nr.id}`,
          category: 'furniture',
          kind: 'neighbor_width',
          x1: nr.leftX,
          z1: nz,
          x2: nr.rightX,
          z2: nz,
          ext1x: nr.leftX,
          ext1z: nAbove ? nr.zTop : nr.zBottom,
          ext2x: nr.rightX,
          ext2z: nAbove ? nr.zTop : nr.zBottom,
          valueMm: nr.elevW,
          vertical: false,
          hoverId: nr.id,
          subtle: true,
          nudgeDir: nAbove ? 1 : -1,
          priority: 55,
        });
      }
    }

    return dims;
  }

  // No selection: display compact dimensions for wall-mounted furniture items on this wall
  const wallMountedRects = furnRects.filter((r) => isWallMountedItem(furnById.get(r.id)));
  for (const r of wallMountedRects.slice(0, 6)) {
    const leftCornerGap = Math.max(0, r.leftX - dragBounds.innerLeftX);
    const rightCornerGap = Math.max(0, dragBounds.innerRightX - r.rightX);
    const nearestSide = leftCornerGap <= rightCornerGap ? 'left' : 'right';
    const nearestGap = nearestSide === 'left' ? leftCornerGap : rightCornerGap;

    const wAbove = dragBounds.wallHeightMm - r.zTop >= 110;
    const wz = wAbove ? r.zTop + 105 : Math.max(55, r.zBottom - 105);
    dims.push({
      dimKey: `fd_wm_w:${r.id}`,
      category: 'furniture',
      kind: 'furn_width',
      x1: r.leftX,
      z1: wz,
      x2: r.rightX,
      z2: wz,
      ext1x: r.leftX,
      ext1z: wAbove ? r.zTop : r.zBottom,
      ext2x: r.rightX,
      ext2z: wAbove ? r.zTop : r.zBottom,
      valueMm: r.elevW,
      vertical: false,
      hoverId: r.id,
      subtle: true,
      nudgeDir: wAbove ? 1 : -1,
      priority: 70,
    });

    if (r.zBottom >= 5) {
      dims.push({
        dimKey: `fd_wm_fl:${r.id}`,
        category: 'furniture',
        kind: 'furn_floor',
        x1: r.centerX,
        z1: 0,
        x2: r.centerX,
        z2: r.zBottom,
        valueMm: r.zBottom,
        vertical: true,
        hoverId: r.id,
        subtle: true,
        nudgeDir: 1,
        priority: 62,
      });
    }

    if (nearestGap >= 5) {
      const cz = Math.min(dragBounds.wallHeightMm - 90, r.zTop + 210);
      const cx1 = nearestSide === 'left' ? dragBounds.innerLeftX : r.rightX;
      const cx2 = nearestSide === 'left' ? r.leftX : dragBounds.innerRightX;
      dims.push({
        dimKey: `fd_wm_corner:${r.id}`,
        category: 'furniture',
        kind: 'furn_corner',
        x1: cx1,
        z1: cz,
        x2: cx2,
        z2: cz,
        ext1x: cx1,
        ext1z: r.zTop,
        ext2x: cx2,
        ext2z: r.zTop,
        valueMm: nearestGap,
        vertical: false,
        hoverId: r.id,
        subtle: true,
        prefix: 'Corner',
        nudgeDir: 1,
        priority: 68,
      });
    }
  }

  return dims;
}

function boxesOverlap(a: WorldBox2D, b: WorldBox2D, padMm = 0): boolean {
  return (
    a.minX < b.maxX + padMm &&
    a.maxX > b.minX - padMm &&
    a.minZ < b.maxZ + padMm &&
    a.maxZ > b.minZ - padMm
  );
}

/**
 * Automatically repositions dimension lanes and flips tight labels outside narrow spans
 * so dimension lines & text never overlap furniture silhouettes or other dimensions.
 */
export function layoutWallViewDimensions(
  dims: WallViewElevDimSpec[],
  obstacles: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>,
  pxPerMm: number
): WallViewElevDimSpec[] {
  const safePx = Math.max(0.02, pxPerMm);
  const fontSizeMm = Math.max(48, Math.min(130, 10.5 / safePx));
  const labelH = fontSizeMm * 1.45 + 6 / safePx;
  const placedBoxes: WorldBox2D[] = [];
  const sorted = [...dims].sort((a, b) => b.priority - a.priority);
  const resultByKey = new Map<string, WallViewElevDimSpec>();

  for (const d of sorted) {
    const labelStr = d.prefix
      ? `${d.prefix} ${formatSmartMetric(d.valueMm)}`
      : formatSmartMetric(d.valueMm);
    const labelW = Math.max(3, labelStr.length) * fontSizeMm * 0.62 + 12 / safePx;

    let x1 = d.x1;
    let z1 = d.z1;
    let x2 = d.x2;
    let z2 = d.z2;
    let labelOffsetPerpMm = d.labelOffsetPerpMm ?? 0;

    const spanMm = d.vertical ? Math.abs(z2 - z1) : Math.abs(x2 - x1);
    if (spanMm < labelW + 14 / safePx && labelOffsetPerpMm === 0) {
      labelOffsetPerpMm = (d.nudgeDir >= 0 ? 1 : -1) * (labelH * 0.9 + 6 / safePx);
    }

    const buildBox = (cx1: number, cz1: number, cx2: number, cz2: number): WorldBox2D => {
      const mx = (cx1 + cx2) / 2;
      const mz = (cz1 + cz2) / 2;
      if (d.vertical) {
        const bx = mx + labelOffsetPerpMm;
        return {
          minX: bx - labelH / 2,
          maxX: bx + labelH / 2,
          minZ: mz - labelW / 2,
          maxZ: mz + labelW / 2,
        };
      }
      const bz = mz + labelOffsetPerpMm;
      return {
        minX: mx - labelW / 2,
        maxX: mx + labelW / 2,
        minZ: bz - labelH / 2,
        maxZ: bz + labelH / 2,
      };
    };

    const stepMm = Math.max(115, 22 / safePx);
    const dir = d.nudgeDir === 0 ? 1 : d.nudgeDir;
    let bestBox = buildBox(x1, z1, x2, z2);

    if (d.nudgeDir !== 0) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const testX1 = d.vertical ? d.x1 + dir * attempt * stepMm : x1;
        const testX2 = d.vertical ? d.x2 + dir * attempt * stepMm : x2;
        const testZ1 = d.vertical ? z1 : d.z1 + dir * attempt * stepMm;
        const testZ2 = d.vertical ? z2 : d.z2 + dir * attempt * stepMm;
        const box = buildBox(testX1, testZ1, testX2, testZ2);

        const hitsObstacle =
          d.kind !== 'furn_floor' &&
          obstacles.some((o) => boxesOverlap(box, o, 6 / safePx));
        const hitsLabel = placedBoxes.some((pb) => boxesOverlap(box, pb, 4 / safePx));

        if (!hitsObstacle && !hitsLabel) {
          x1 = testX1;
          x2 = testX2;
          z1 = testZ1;
          z2 = testZ2;
          bestBox = box;
          break;
        }
        if (attempt === 5) {
          x1 = testX1;
          x2 = testX2;
          z1 = testZ1;
          z2 = testZ2;
          bestBox = box;
        }
      }
    }

    placedBoxes.push(bestBox);
    resultByKey.set(d.dimKey, {
      ...d,
      x1,
      z1,
      x2,
      z2,
      labelOffsetPerpMm,
    });
  }

  return dims.map((d) => resultByKey.get(d.dimKey) ?? d);
}
