import type { FurnitureInstance, Point2D, Wall } from '../types/plan';
import {
  computeAttachedWallFurnitureTransform,
  computeFurnitureBoundsMm,
  computeFurnitureElevationSpanMm,
  computeFurnitureTiltedLocalBoundsMm,
  computePolygonOverlapMTV,
  computeWallPolygon,
  getFurnitureOrientedCorners,
  getFurnitureSolidFootprintPrimitives,
  getWallArcLength,
  getWallCenterlinePoint,
  projectPointOnSegment,
  propagateParentFurnitureTransforms,
  wallOffsets,
} from './geometry';
import { pickWithSnapHysteresis, type SnapHysteresisState } from './dragErgonomics';
import { resolveFurnitureMountingType } from './mounting';

function doesMovedFurnitureOverlapWalls(
  candPos: Point2D,
  item: FurnitureInstance,
  walls: Wall[],
  toleranceMm = 6
): boolean {
  const span = computeFurnitureElevationSpanMm(item);
  const selfPrims = getFurnitureSolidFootprintPrimitives(candPos, item);
  if (selfPrims.length === 0) return false;
  for (const w of walls) {
    if (w.visible === false) continue;
    if (span.minZ >= w.heightMm - 10) continue;
    const wallPolys: Point2D[][] = [];
    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) {
      const steps = 12;
      const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
      const pts: Point2D[] = [];
      const nrms: Point2D[] = [];
      for (let i = 0; i <= steps; i++) {
        const res = getWallCenterlinePoint(w, i / steps);
        pts.push(res.point);
        nrms.push(res.normal);
      }
      for (let i = 0; i < steps; i++) {
        wallPolys.push([
          { x: pts[i].x + nrms[i].x * left, y: pts[i].y + nrms[i].y * left },
          { x: pts[i + 1].x + nrms[i + 1].x * left, y: pts[i + 1].y + nrms[i + 1].y * left },
          { x: pts[i + 1].x + nrms[i + 1].x * right, y: pts[i + 1].y + nrms[i + 1].y * right },
          { x: pts[i].x + nrms[i].x * right, y: pts[i].y + nrms[i].y * right },
        ]);
      }
    } else {
      const wp = computeWallPolygon(w, walls);
      if (wp.length >= 3) wallPolys.push(wp);
    }
    for (const wp of wallPolys) {
      for (const sp of selfPrims) {
        const mtv = computePolygonOverlapMTV(sp.poly, wp);
        if (mtv && mtv.depth > toleranceMm) return true;
      }
    }
  }
  return false;
}

export const WALL_FLUSH_MAX_DIST_MM = 30;
export const WALL_CLEARANCE_FLUSH_EPS_MM = 5;

export interface WallViewElevRect {
  id: string;
  name: string;
  leftX: number;
  rightX: number;
  zBottom: number;
  zTop: number;
  centerX: number;
  elevW: number;
  elevH: number;
}

export interface WallViewOpeningObstacle {
  id: string;
  name: string;
  leftX: number;
  rightX: number;
  zBottom: number;
  zTop: number;
}

export interface WallViewCardinalClearance {
  side: 'left' | 'right' | 'bottom' | 'top';
  gapMm: number;
  boundaryMm: number;
  boundaryLabel: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface WallViewClearancesResult {
  left: WallViewCardinalClearance | null;
  right: WallViewCardinalClearance | null;
  bottom: WallViewCardinalClearance | null;
  top: WallViewCardinalClearance | null;
}

export interface WallViewDragBounds {
  innerLeftX: number;
  innerRightX: number;
  wallHeightMm: number;
}

export interface WallViewDragResult {
  centerX: number;
  zBottom: number;
  deltaX: number;
  deltaZ: number;
  snapKey?: string;
  snapLabel?: string;
  snappedOverName?: string;
  hysteresis: SnapHysteresisState;
}

export interface WallViewGroupOrigItem {
  id: string;
  origXMm: number;
  origYMm: number;
  origElevationMm: number;
  origRotDeg: number;
  origAttachedWallId?: string;
  origAttachedFace?: 'left' | 'right';
  origAttachedT?: number;
  origCenterX: number;
  origZBottom: number;
  elevW: number;
  elevH: number;
}

/**
 * Furniture is interactive in Wall View when it is explicitly wall-mounted (or attached to this wall)
 * OR physically flush against the viewed wall face (<= 30 mm).
 */
export function isFurnitureInteractiveInWallView(
  item: Pick<
    FurnitureInstance,
    'templateId' | 'category' | 'parts' | 'mountingType' | 'attachedWallId' | 'surfaceHostId'
  >,
  perpDistMm: number,
  targetWallId: string,
  hasProjection: boolean
): boolean {
  if (!hasProjection) return false;
  if (item.attachedWallId === targetWallId) return true;
  if (resolveFurnitureMountingType(item) === 'wall' && perpDistMm <= 120) return true;
  return perpDistMm <= WALL_FLUSH_MAX_DIST_MM;
}

/**
 * Computes nearest physical boundary clearances in all 4 cardinal directions
 * (left, right, bottom, top) for a Wall View furniture bounding box.
 * Omits any side that is flush (< 5 mm gap).
 */
export function computeWallViewFurnitureClearances(
  target: WallViewElevRect,
  otherFurniture: WallViewElevRect[],
  solidArchObstacles: WallViewOpeningObstacle[],
  wallEdgeObstacles: WallViewOpeningObstacle[],
  bounds: WallViewDragBounds
): WallViewClearancesResult {
  const L = target.leftX;
  const R = target.rightX;
  const B = target.zBottom;
  const T = target.zTop;

  const horizTargets = [...otherFurniture, ...wallEdgeObstacles];
  const vertTargets = [...otherFurniture, ...solidArchObstacles];

  // 1. LEFT nearest boundary (max rightX <= L + 4 with Z overlap > 2mm)
  let bestLeft: { x: number; label: string; zLo: number; zHi: number } = {
    x: bounds.innerLeftX,
    label: 'Left wall',
    zLo: B,
    zHi: T,
  };
  for (const o of horizTargets) {
    if (o.id === target.id) continue;
    if (o.rightX > L + 4) continue;
    const zLo = Math.max(B, o.zBottom);
    const zHi = Math.min(T, o.zTop);
    if (zHi - zLo <= 2) continue;
    if (o.rightX > bestLeft.x) {
      bestLeft = { x: o.rightX, label: o.name, zLo, zHi };
    }
  }
  const leftGap = Math.max(0, L - bestLeft.x);
  const leftAnchorZ = (bestLeft.zLo + bestLeft.zHi) / 2;
  const left: WallViewCardinalClearance | null =
    leftGap >= WALL_CLEARANCE_FLUSH_EPS_MM
      ? {
          side: 'left',
          gapMm: leftGap,
          boundaryMm: bestLeft.x,
          boundaryLabel: bestLeft.label,
          x1: bestLeft.x,
          z1: leftAnchorZ,
          x2: L,
          z2: leftAnchorZ,
        }
      : null;

  // 2. RIGHT nearest boundary (min leftX >= R - 4 with Z overlap > 2mm)
  let bestRight: { x: number; label: string; zLo: number; zHi: number } = {
    x: bounds.innerRightX,
    label: 'Right wall',
    zLo: B,
    zHi: T,
  };
  for (const o of horizTargets) {
    if (o.id === target.id) continue;
    if (o.leftX < R - 4) continue;
    const zLo = Math.max(B, o.zBottom);
    const zHi = Math.min(T, o.zTop);
    if (zHi - zLo <= 2) continue;
    if (o.leftX < bestRight.x) {
      bestRight = { x: o.leftX, label: o.name, zLo, zHi };
    }
  }
  const rightGap = Math.max(0, bestRight.x - R);
  const rightAnchorZ = (bestRight.zLo + bestRight.zHi) / 2;
  const right: WallViewCardinalClearance | null =
    rightGap >= WALL_CLEARANCE_FLUSH_EPS_MM
      ? {
          side: 'right',
          gapMm: rightGap,
          boundaryMm: bestRight.x,
          boundaryLabel: bestRight.label,
          x1: R,
          z1: rightAnchorZ,
          x2: bestRight.x,
          z2: rightAnchorZ,
        }
      : null;

  // 3. BOTTOM nearest physical boundary (max zTop <= B + 4 with X overlap > 2mm; countertop before floor)
  let bestBottom: { z: number; label: string; xLo: number; xHi: number } = {
    z: 0,
    label: 'Floor',
    xLo: L,
    xHi: R,
  };
  for (const o of vertTargets) {
    if (o.id === target.id) continue;
    if (o.zTop > B + 4) continue;
    const xLo = Math.max(L, o.leftX);
    const xHi = Math.min(R, o.rightX);
    if (xHi - xLo <= 2) continue;
    if (o.zTop > bestBottom.z) {
      bestBottom = { z: o.zTop, label: o.name, xLo, xHi };
    }
  }
  const bottomGap = Math.max(0, B - bestBottom.z);
  const bottomAnchorX = (bestBottom.xLo + bestBottom.xHi) / 2;
  const bottom: WallViewCardinalClearance | null =
    bottomGap >= WALL_CLEARANCE_FLUSH_EPS_MM
      ? {
          side: 'bottom',
          gapMm: bottomGap,
          boundaryMm: bestBottom.z,
          boundaryLabel: bestBottom.label,
          x1: bottomAnchorX,
          z1: bestBottom.z,
          x2: bottomAnchorX,
          z2: B,
        }
      : null;

  // 4. TOP nearest physical boundary (min zBottom >= T - 4 with X overlap > 2mm; upper object before ceiling)
  let bestTop: { z: number; label: string; xLo: number; xHi: number } = {
    z: bounds.wallHeightMm,
    label: 'Ceiling',
    xLo: L,
    xHi: R,
  };
  for (const o of vertTargets) {
    if (o.id === target.id) continue;
    if (o.zBottom < T - 4) continue;
    const xLo = Math.max(L, o.leftX);
    const xHi = Math.min(R, o.rightX);
    if (xHi - xLo <= 2) continue;
    if (o.zBottom < bestTop.z) {
      bestTop = { z: o.zBottom, label: o.name, xLo, xHi };
    }
  }
  const topGap = Math.max(0, bestTop.z - T);
  const topAnchorX = (bestTop.xLo + bestTop.xHi) / 2;
  const top: WallViewCardinalClearance | null =
    topGap >= WALL_CLEARANCE_FLUSH_EPS_MM
      ? {
          side: 'top',
          gapMm: topGap,
          boundaryMm: bestTop.z,
          boundaryLabel: bestTop.label,
          x1: topAnchorX,
          z1: T,
          x2: topAnchorX,
          z2: bestTop.z,
        }
      : null;

  return { left, right, bottom, top };
}

/**
 * Solves 2-axis horizontal (along wall) + vertical (elevation) drag for Wall View furniture
 * with wall/furniture/opening snapping, collision resistance, snap-over worktops/surfaces
 * (purely elevation-snapped without ungluing from wall or changing surfaceHostId),
 * and Shift free-overlap mode.
 */
export function solveWallViewFurnitureDrag(
  leaderOrig: WallViewElevRect,
  proposedCenterX: number,
  proposedZBottom: number,
  prevSettled: { centerX: number; zBottom: number },
  obstacles: WallViewElevRect[],
  wallEdgeObstacles: WallViewOpeningObstacle[],
  bounds: WallViewDragBounds,
  options: {
    snapEnabled: boolean;
    allowOverlap: boolean;
    gridSizeMm: number;
    horizTolMm: number;
    vertTolMm: number;
    hysteresis?: SnapHysteresisState;
    groupSpans?: Array<{ relLeft: number; relRight: number; relBottom: number; relTop: number }>;
  }
): WallViewDragResult {
  const halfW = leaderOrig.elevW / 2;
  const elevH = leaderOrig.elevH;

  // Group-aware wall room bounds so multi-selected arrangements respect inner corners/floor/ceiling
  let minAllowedCx = bounds.innerLeftX + halfW;
  let maxAllowedCx = bounds.innerRightX - halfW;
  let minAllowedZb = 0;
  let maxAllowedZb = Math.max(0, bounds.wallHeightMm - elevH);

  if (options.groupSpans && options.groupSpans.length > 0) {
    let minRelLeft = -halfW;
    let maxRelRight = halfW;
    let minRelBottom = 0;
    let maxRelTop = elevH;
    for (const gs of options.groupSpans) {
      minRelLeft = Math.min(minRelLeft, gs.relLeft);
      maxRelRight = Math.max(maxRelRight, gs.relRight);
      minRelBottom = Math.min(minRelBottom, gs.relBottom);
      maxRelTop = Math.max(maxRelTop, gs.relTop);
    }
    minAllowedCx = bounds.innerLeftX - minRelLeft;
    maxAllowedCx = bounds.innerRightX - maxRelRight;
    minAllowedZb = -minRelBottom;
    maxAllowedZb = Math.max(minAllowedZb, bounds.wallHeightMm - maxRelTop);
  }
  if (minAllowedCx > maxAllowedCx) {
    const mid = (bounds.innerLeftX + bounds.innerRightX) / 2;
    minAllowedCx = mid;
    maxAllowedCx = mid;
  }

  const clampCx = (x: number) => Math.max(minAllowedCx, Math.min(maxAllowedCx, x));
  const clampZb = (z: number) => Math.max(minAllowedZb, Math.min(maxAllowedZb, z));

  let cx = clampCx(proposedCenterX);
  let zb = clampZb(proposedZBottom);
  let nextHKey: string | undefined;
  let nextVKey: string | undefined;
  let snapLabel: string | undefined;
  let snappedOverName: string | undefined;

  if (options.snapEnabled) {
    const horizCands: Array<{
      key: string;
      dist: number;
      data: { val: number; label: string };
    }> = [
      {
        key: 'wall_left',
        dist: Math.abs(bounds.innerLeftX + halfW - cx),
        data: { val: bounds.innerLeftX + halfW, label: 'Left wall corner' },
      },
      {
        key: 'wall_right',
        dist: Math.abs(bounds.innerRightX - halfW - cx),
        data: { val: bounds.innerRightX - halfW, label: 'Right wall corner' },
      },
    ];
    for (const obs of [...obstacles, ...wallEdgeObstacles]) {
      horizCands.push(
        {
          key: `h_adj_l_${obs.id}`,
          dist: Math.abs(obs.leftX - halfW - cx),
          data: { val: obs.leftX - halfW, label: `Flush with ${obs.name}` },
        },
        {
          key: `h_adj_r_${obs.id}`,
          dist: Math.abs(obs.rightX + halfW - cx),
          data: { val: obs.rightX + halfW, label: `Flush with ${obs.name}` },
        },
        {
          key: `h_al_l_${obs.id}`,
          dist: Math.abs(obs.leftX + halfW - cx),
          data: { val: obs.leftX + halfW, label: `Aligned with ${obs.name}` },
        },
        {
          key: `h_al_r_${obs.id}`,
          dist: Math.abs(obs.rightX - halfW - cx),
          data: { val: obs.rightX - halfW, label: `Aligned with ${obs.name}` },
        }
      );
    }

    const pickedH = pickWithSnapHysteresis(
      horizCands.filter((c) => c.data.val >= minAllowedCx - 1 && c.data.val <= maxAllowedCx + 1),
      options.hysteresis?.wallFurnHKey,
      options.horizTolMm
    );
    if (pickedH) {
      cx = clampCx(pickedH.data.val);
      nextHKey = pickedH.key;
      snapLabel = pickedH.data.label;
    } else if (options.gridSizeMm >= 5) {
      const step = Math.max(10, Math.min(50, options.gridSizeMm));
      cx = clampCx(Math.round(cx / step) * step);
    }

    const vertCands: Array<{
      key: string;
      dist: number;
      data: { val: number; label: string; overName?: string };
    }> = [
      { key: 'floor', dist: Math.abs(0 - zb), data: { val: 0, label: 'Floor flush' } },
      {
        key: 'ceiling',
        dist: Math.abs(bounds.wallHeightMm - elevH - zb),
        data: { val: bounds.wallHeightMm - elevH, label: 'Ceiling flush' },
      },
    ];
    for (const obs of obstacles) {
      const horizOverlap =
        Math.min(cx + halfW, obs.rightX) - Math.max(cx - halfW, obs.leftX) > 20;
      if (horizOverlap && obs.zTop + elevH <= bounds.wallHeightMm + 2) {
        vertCands.push({
          key: `v_over_${obs.id}`,
          dist: Math.abs(obs.zTop - zb),
          data: { val: obs.zTop, label: `Over ${obs.name}`, overName: obs.name },
        });
      }
      vertCands.push(
        {
          key: `v_bot_${obs.id}`,
          dist: Math.abs(obs.zBottom - zb),
          data: { val: obs.zBottom, label: `Aligned bottom (${obs.name})` },
        },
        {
          key: `v_top_${obs.id}`,
          dist: Math.abs(obs.zTop - elevH - zb),
          data: { val: obs.zTop - elevH, label: `Aligned top (${obs.name})` },
        }
      );
    }
    for (const op of wallEdgeObstacles) {
      vertCands.push(
        {
          key: `v_op_sill_${op.id}`,
          dist: Math.abs(op.zBottom - zb),
          data: { val: op.zBottom, label: `Aligned sill (${op.name})` },
        },
        {
          key: `v_op_head_${op.id}`,
          dist: Math.abs(op.zTop - elevH - zb),
          data: { val: op.zTop - elevH, label: `Aligned head (${op.name})` },
        }
      );
    }

    const pickedV = pickWithSnapHysteresis(
      vertCands.filter((c) => c.data.val >= minAllowedZb - 1 && c.data.val <= maxAllowedZb + 1),
      options.hysteresis?.wallFurnVKey,
      options.vertTolMm
    );
    if (pickedV) {
      zb = clampZb(pickedV.data.val);
      nextVKey = pickedV.key;
      if (pickedV.data.overName) {
        snappedOverName = pickedV.data.overName;
        snapLabel = pickedV.data.label;
      } else if (!snapLabel) {
        snapLabel = pickedV.data.label;
      }
    } else if (options.gridSizeMm >= 5) {
      const step = Math.max(10, Math.min(50, options.gridSizeMm));
      zb = clampZb(Math.round(zb / step) * step);
    }
  }

  // Collision resistance & snap-over worktop behavior when not holding Shift
  if (!options.allowOverlap) {
    for (let pass = 0; pass < 2; pass++) {
      for (const obs of obstacles) {
        const L = cx - halfW;
        const R = cx + halfW;
        const T = zb + elevH;
        const ox = Math.min(R, obs.rightX) - Math.max(L, obs.leftX);
        const oz = Math.min(T, obs.zTop) - Math.max(zb, obs.zBottom);
        if (ox <= 4 || oz <= 4) continue;

        const penUp = obs.zTop - zb;
        const upFits = obs.zTop <= maxAllowedZb + 1;
        const penDown = T - obs.zBottom;
        const downZ = obs.zBottom - elevH;
        const downFits = downZ >= minAllowedZb - 1;
        const leftCx = obs.leftX - halfW;
        const penLeft = R - obs.leftX;
        const leftFits = leftCx >= minAllowedCx - 1;
        const rightCx = obs.rightX + halfW;
        const penRight = obs.rightX - L;
        const rightFits = rightCx <= maxAllowedCx + 1;

        const wasAboveObs = prevSettled.zBottom >= obs.zTop - 15;
        const bestSidePen = Math.min(
          leftFits ? penLeft : Infinity,
          rightFits ? penRight : Infinity
        );
        const bestSideCx =
          (leftFits ? penLeft : Infinity) <= (rightFits ? penRight : Infinity)
            ? leftCx
            : rightCx;
        const sideClearThreshold = Math.min(Math.max(45, obs.elevW * 0.35), 220);

        // If already above the worktop and dipping into it -> resist by resting cleanly atop obs.zTop
        if (wasAboveObs && upFits && bestSidePen > Math.min(80, options.vertTolMm * 1.8)) {
          zb = clampZb(obs.zTop);
          snappedOverName = obs.name;
          snapLabel = `Over ${obs.name}`;
          nextVKey = `v_over_${obs.id}`;
          continue;
        }

        // Resist sideways entry initially; if user persists upward or deeper past threshold, snap OVER obs.zTop
        const persistedOver =
          upFits &&
          (zb >= obs.zTop * 0.45 ||
            (penLeft > sideClearThreshold && penRight > sideClearThreshold) ||
            (bestSidePen > sideClearThreshold && penUp <= bestSidePen * 1.15));

        if (persistedOver) {
          zb = clampZb(obs.zTop);
          snappedOverName = obs.name;
          snapLabel = `Over ${obs.name}`;
          nextVKey = `v_over_${obs.id}`;
        } else if (downFits && penDown <= bestSidePen && (!upFits || penDown < penUp)) {
          zb = clampZb(downZ);
        } else if (Number.isFinite(bestSidePen)) {
          cx = clampCx(bestSideCx);
          snapLabel = snapLabel ?? `Flush with ${obs.name}`;
        } else if (upFits) {
          zb = clampZb(obs.zTop);
          snappedOverName = obs.name;
          snapLabel = `Over ${obs.name}`;
          nextVKey = `v_over_${obs.id}`;
        }
      }
    }
  }

  return {
    centerX: Math.round(cx),
    zBottom: Math.round(zb),
    deltaX: Math.round(cx) - leaderOrig.centerX,
    deltaZ: Math.round(zb) - leaderOrig.zBottom,
    snapKey: [nextHKey, nextVKey].filter(Boolean).join('|') || undefined,
    snapLabel,
    snappedOverName,
    hysteresis: {
      ...(options.hysteresis ?? {}),
      wallFurnHKey: nextHKey,
      wallFurnVKey: nextVKey,
    },
  };
}

/**
 * Applies a rigid shared (dx, dy) delta across all unlocked selected furniture items in 2D Plan
 * while preventing double-translation when both a surface host and its child are selected,
 * and preserving parallel wall attachments where applicable.
 */
export function applyRigidFurnitureGroupDelta2D(
  furnitureList: FurnitureInstance[],
  selectedFurnIds: Set<string>,
  leaderId: string,
  prevLeader: FurnitureInstance,
  nextLeader: FurnitureInstance,
  walls: Wall[],
  allowWallOverlap: boolean
): FurnitureInstance[] | null {
  const dx = nextLeader.xMm - prevLeader.xMm;
  const dy = nextLeader.yMm - prevLeader.yMm;
  const wallById = new Map(walls.map((w) => [w.id, w]));

  if (!allowWallOverlap && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
    for (const item of furnitureList) {
      if (item.id === leaderId || !selectedFurnIds.has(item.id) || item.locked) continue;
      if (resolveFurnitureMountingType(item) === 'ceiling') continue;
      const candPos = { x: item.xMm + dx, y: item.yMm + dy };
      if (doesMovedFurnitureOverlapWalls(candPos, item, walls, 6)) {
        return null;
      }
    }
  }

  const prevById = new Map(furnitureList.map((f) => [f.id, f]));
  const movedPairs: Array<{ prev: FurnitureInstance; next: FurnitureInstance }> = [];

  let nextList = furnitureList.map((f) => {
    if (f.id === leaderId) {
      movedPairs.push({ prev: f, next: nextLeader });
      return nextLeader;
    }
    if (!selectedFurnIds.has(f.id) || f.locked) return f;

    const nx = Math.round(f.xMm + dx);
    const ny = Math.round(f.yMm + dy);
    let nextAttachedWallId = f.attachedWallId;
    let nextAttachedFace = f.attachedFace;
    let nextAttachedT = f.attachedT;

    if (f.attachedWallId) {
      const aw = wallById.get(f.attachedWallId);
      if (aw) {
        const proj = projectPointOnSegment({ x: nx, y: ny }, aw.start, aw.end);
        const { normal } = getWallCenterlinePoint(aw, proj.t);
        const origProj = projectPointOnSegment({ x: f.xMm, y: f.yMm }, aw.start, aw.end);
        const perpDrift = Math.abs(
          (nx - f.xMm) * normal.x + (ny - f.yMm) * normal.y
        );
        const len = Math.max(1, getWallArcLength(aw));
        const alongS = proj.t * len;
        if (perpDrift <= 8 && proj.t >= 0.01 && proj.t <= 0.99 && Math.abs(origProj.t - proj.t) * len >= 0) {
          nextAttachedT = Math.max(0.01, Math.min(0.99, alongS / len));
        } else {
          nextAttachedWallId = undefined;
          nextAttachedFace = undefined;
          nextAttachedT = undefined;
        }
      } else {
        nextAttachedWallId = undefined;
        nextAttachedFace = undefined;
        nextAttachedT = undefined;
      }
    }

    const hostAlsoSelected = Boolean(f.surfaceHostId && selectedFurnIds.has(f.surfaceHostId));
    const nextItem: FurnitureInstance = {
      ...f,
      xMm: nx,
      yMm: ny,
      surfaceHostId: hostAlsoSelected ? f.surfaceHostId : undefined,
      surfaceLocalXMm: hostAlsoSelected ? f.surfaceLocalXMm : undefined,
      surfaceLocalYMm: hostAlsoSelected ? f.surfaceLocalYMm : undefined,
      surfaceLocalRotDeg: hostAlsoSelected ? f.surfaceLocalRotDeg : undefined,
      attachedWallId: nextAttachedWallId,
      attachedFace: nextAttachedFace,
      attachedT: nextAttachedT,
    };
    movedPairs.push({ prev: f, next: nextItem });
    return nextItem;
  });

  // Propagate only to descendants that are NOT themselves part of the selected rigid group
  const selectedSnapshot = new Map<string, FurnitureInstance>();
  for (const id of selectedFurnIds) {
    const cur = nextList.find((x) => x.id === id);
    if (cur) selectedSnapshot.set(id, cur);
  }
  for (const pair of movedPairs) {
    nextList = propagateParentFurnitureTransforms(nextList, pair.next.id, pair.prev, pair.next);
  }
  if (selectedSnapshot.size > 1) {
    nextList = nextList.map((f) => selectedSnapshot.get(f.id) ?? f);
  }
  void prevById;
  return nextList;
}

/**
 * Applies a rigid (deltaS along viewed wall, deltaZ elevation) delta across all unlocked
 * selected furniture items in Wall View while keeping every wall-attached item attached
 * and wall-flush items moving strictly parallel to the wall face.
 */
export function applyWallViewFurnitureGroupDelta(
  furnitureList: FurnitureInstance[],
  selectedFurnIds: Set<string>,
  targetWall: Wall,
  viewedPhysicalSide: 'left' | 'right',
  deltaS: number,
  deltaZ: number,
  origById: Map<string, WallViewGroupOrigItem>
): FurnitureInstance[] {
  const dxW = targetWall.end.x - targetWall.start.x;
  const dyW = targetWall.end.y - targetWall.start.y;
  const wallLenMm = Math.max(100, getWallArcLength(targetWall));
  const straightLen = Math.hypot(dxW, dyW) || 1;
  const ux = dxW / straightLen;
  const uy = dyW / straightLen;
  const movedPairs: Array<{ prev: FurnitureInstance; next: FurnitureInstance }> = [];

  let nextList = furnitureList.map((f) => {
    const orig = origById.get(f.id);
    if (!orig || f.locked) return f;

    const isCeiling = resolveFurnitureMountingType(f) === 'ceiling';
    const rawElev = isCeiling ? orig.origElevationMm - deltaZ : orig.origElevationMm + deltaZ;
    const nextElev = Math.max(
      0,
      Math.min(Math.max(0, targetWall.heightMm - orig.elevH), Math.round(rawElev))
    );

    if (orig.origAttachedWallId === targetWall.id) {
      const baseS = (orig.origAttachedT ?? 0.5) * wallLenMm;
      const nextT = Math.max(0.01, Math.min(0.99, (baseS + deltaS) / wallLenMm));
      const face = orig.origAttachedFace ?? viewedPhysicalSide;
      const xf = computeAttachedWallFurnitureTransform(targetWall, nextT, face, f);
      const nextItem: FurnitureInstance = {
        ...f,
        xMm: xf.xMm,
        yMm: xf.yMm,
        rotationDeg: xf.rotationDeg,
        elevationMm: nextElev,
        attachedWallId: targetWall.id,
        attachedFace: face,
        attachedT: xf.attachedT,
      };
      movedPairs.push({ prev: f, next: nextItem });
      return nextItem;
    }

    // Wall-flush (freestanding/floor) furniture: slide strictly parallel to wall tangent,
    // preserving perpendicular flush distance, orientation, and relative elevation.
    const nextItem: FurnitureInstance = {
      ...f,
      xMm: Math.round(orig.origXMm + ux * deltaS),
      yMm: Math.round(orig.origYMm + uy * deltaS),
      elevationMm: nextElev,
    };
    movedPairs.push({ prev: f, next: nextItem });
    return nextItem;
  });

  // Sync only unselected descendants so selected surface children do not double-move
  const selectedSnapshot = new Map<string, FurnitureInstance>();
  for (const id of selectedFurnIds) {
    const cur = nextList.find((x) => x.id === id);
    if (cur) selectedSnapshot.set(id, cur);
  }
  for (const pair of movedPairs) {
    nextList = propagateParentFurnitureTransforms(nextList, pair.next.id, pair.prev, pair.next);
  }
  if (selectedSnapshot.size > 1) {
    nextList = nextList.map((f) => selectedSnapshot.get(f.id) ?? f);
  }
  return nextList;
}

/**
 * Helper to compute outer tilted/rotated bounds offsets for a furniture item when needed.
 */
export function getFurnitureElevZSpanMm(
  furn: FurnitureInstance,
  roomCeilingMm: number
): { zBottom: number; elevH: number } {
  const b = computeFurnitureBoundsMm(furn.parts);
  const tb = computeFurnitureTiltedLocalBoundsMm(
    furn.parts,
    furn.rotationXDeg ?? 0,
    furn.rotationYDeg ?? 0,
    furn.mirroredX,
    furn.mirroredY,
    furn.templateId
  );
  const elevH = Math.max(10, Math.round(tb.maxZ - tb.minZ || b.heightMm));
  const mType = resolveFurnitureMountingType(furn);
  const zBottom =
    mType === 'ceiling'
      ? Math.max(0, Math.round(roomCeilingMm - elevH - (furn.elevationMm ?? 0)))
      : Math.max(0, Math.round(furn.elevationMm ?? 0));
  return { zBottom, elevH };
}

export function computePointFlushToWallCheck(
  wall: Wall,
  pt: Point2D,
  furn: FurnitureInstance,
  face: 'left' | 'right'
): number {
  const { point, normal } = getWallCenterlinePoint(wall, 0.5);
  const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
  const faceOff = face === 'left' ? left : right;
  const corners = getFurnitureOrientedCorners(pt, furn);
  const dCenter = (pt.x - point.x) * normal.x + (pt.y - point.y) * normal.y;
  const nVals = corners.map((c) => (c.x - point.x) * normal.x + (c.y - point.y) * normal.y);
  void dCenter;
  return face === 'left' ? Math.min(...nVals) - faceOff : faceOff - Math.max(...nVals);
}
