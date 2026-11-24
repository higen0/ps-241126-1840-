import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FurnitureInstance, Wall } from '../types/plan.ts';
import { computeAttachedWallFurnitureTransform } from './geometry.ts';
import {
  applyRigidFurnitureGroupDelta2D,
  applyWallViewFurnitureGroupDelta,
  computeWallViewFurnitureClearances,
  isFurnitureInteractiveInWallView,
  solveWallViewFurnitureDrag,
  type WallViewElevRect,
} from './wallViewFurniture.ts';

function makeBoxFurn(
  id: string,
  name: string,
  opts: {
    xMm: number;
    yMm: number;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    elevationMm?: number;
    rotationDeg?: number;
    mountingType?: 'floor' | 'wall' | 'ceiling';
    attachedWallId?: string;
    attachedFace?: 'left' | 'right';
    attachedT?: number;
    surfaceHostId?: string;
  }
): FurnitureInstance {
  return {
    id,
    templateId: 'custom_box',
    name,
    category: 'Kitchen',
    xMm: opts.xMm,
    yMm: opts.yMm,
    elevationMm: opts.elevationMm ?? 0,
    rotationDeg: opts.rotationDeg ?? 0,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    mountingType: opts.mountingType,
    attachedWallId: opts.attachedWallId,
    attachedFace: opts.attachedFace,
    attachedT: opts.attachedT,
    surfaceHostId: opts.surfaceHostId,
    visible: true,
    locked: false,
    parts: [
      {
        id: `${id}_p1`,
        name: 'Body',
        shape: 'box',
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm: opts.widthMm,
        depthMm: opts.depthMm,
        heightMm: opts.heightMm,
        rotationDeg: 0,
        color: '#CBD5E1',
        material: 'wood',
      },
    ],
  };
}

const WALL_SOUTH: Wall = {
  id: 'w1',
  start: { x: 0, y: 0 },
  end: { x: 4000, y: 0 },
  thicknessMm: 150,
  heightMm: 2700,
  alignment: 'center',
  innerColor: '#FFFFFF',
  outerColor: '#FFFFFF',
  innerMaterial: 'paint',
  outerMaterial: 'paint',
  hasBaseboard: false,
  baseboardHeightMm: 0,
  baseboardColor: '#FFFFFF',
  hasCrownMolding: false,
  crownHeightMm: 0,
  crownColor: '#FFFFFF',
  visible: true,
  locked: false,
  isCurved: false,
  curveBulgeMm: 0,
  innerTextureScale: 1,
  outerTextureScale: 1,
  innerTextureRotDeg: 0,
  outerTextureRotDeg: 0,
};

test('isFurnitureInteractiveInWallView allows wall-mounted and flush (<=30mm) furniture only', () => {
  const mounted = makeBoxFurn('m1', 'Cabinet', {
    xMm: 1000,
    yMm: 250,
    widthMm: 600,
    depthMm: 350,
    heightMm: 700,
    mountingType: 'wall',
    attachedWallId: 'w1',
  });
  const flush = makeBoxFurn('f1', 'Worktop', {
    xMm: 2000,
    yMm: 380,
    widthMm: 1200,
    depthMm: 600,
    heightMm: 900,
  });
  assert.equal(isFurnitureInteractiveInWallView(mounted, 200, 'w1', true), true);
  assert.equal(isFurnitureInteractiveInWallView(flush, 12, 'w1', true), true);
  assert.equal(isFurnitureInteractiveInWallView(flush, 45, 'w1', true), false);
});

test('solveWallViewFurnitureDrag resists worktop collision initially then snaps elevation over worktop', () => {
  const bounds = { innerLeftX: 0, innerRightX: 4000, wallHeightMm: 2700 };
  const worktop: WallViewElevRect = {
    id: 'wt',
    name: 'Worktop',
    leftX: 1500,
    rightX: 2700,
    zBottom: 0,
    zTop: 900,
    centerX: 2100,
    elevW: 1200,
    elevH: 900,
  };
  const cupboard: WallViewElevRect = {
    id: 'cup',
    name: 'Cupboard',
    leftX: 500,
    rightX: 1100,
    zBottom: 0,
    zTop: 700,
    centerX: 800,
    elevW: 600,
    elevH: 700,
  };

  // Slight push into worktop side (< threshold) resists horizontally flush against worktop
  const resisted = solveWallViewFurnitureDrag(
    cupboard,
    1260,
    0,
    { centerX: 800, zBottom: 0 },
    [worktop],
    [],
    bounds,
    { snapEnabled: true, allowOverlap: false, gridSizeMm: 50, horizTolMm: 40, vertTolMm: 40 }
  );
  assert.equal(resisted.centerX, 1200);
  assert.equal(resisted.zBottom, 0);

  // Persisting upward/deeper over worktop snaps cleanly OVER worktop top elevation (900mm)
  const snappedOver = solveWallViewFurnitureDrag(
    cupboard,
    1900,
    500,
    { centerX: 1200, zBottom: 0 },
    [worktop],
    [],
    bounds,
    { snapEnabled: true, allowOverlap: false, gridSizeMm: 50, horizTolMm: 40, vertTolMm: 40 }
  );
  assert.equal(snappedOver.zBottom, 900);
  assert.equal(snappedOver.snappedOverName, 'Worktop');

  // Shift allowOverlap allows free placement through worktop
  const free = solveWallViewFurnitureDrag(
    cupboard,
    1900,
    250,
    { centerX: 1200, zBottom: 0 },
    [worktop],
    [],
    bounds,
    { snapEnabled: false, allowOverlap: true, gridSizeMm: 50, horizTolMm: 40, vertTolMm: 40 }
  );
  assert.equal(free.centerX, 1900);
  assert.equal(free.zBottom, 250);
});

test('computeWallViewFurnitureClearances measures countertop below and omits flush sides (<5mm)', () => {
  const bounds = { innerLeftX: 0, innerRightX: 4000, wallHeightMm: 2700 };
  const worktop: WallViewElevRect = {
    id: 'wt',
    name: 'Worktop',
    leftX: 1000,
    rightX: 2600,
    zBottom: 0,
    zTop: 900,
    centerX: 1800,
    elevW: 1600,
    elevH: 900,
  };
  const fridge: WallViewElevRect = {
    id: 'fr',
    name: 'Fridge',
    leftX: 2800,
    rightX: 3500,
    zBottom: 0,
    zTop: 2100,
    centerX: 3150,
    elevW: 700,
    elevH: 2100,
  };
  const highCabinet: WallViewElevRect = {
    id: 'hc',
    name: 'High Cupboard',
    leftX: 0, // flush with left wall -> left clearance omitted
    rightX: 1600,
    zBottom: 1450,
    zTop: 2150,
    centerX: 800,
    elevW: 1600,
    elevH: 700,
  };

  const c = computeWallViewFurnitureClearances(highCabinet, [worktop, fridge], [], [], bounds);
  assert.equal(c.left, null);
  assert.ok(c.right && c.right.gapMm === 1200 && c.right.boundaryLabel === 'Fridge');
  assert.ok(c.bottom && c.bottom.gapMm === 550 && c.bottom.boundaryLabel === 'Worktop');
  assert.ok(c.top && c.top.gapMm === 550 && c.top.boundaryLabel === 'Ceiling');
});

test('rigid group delta preserves spacing, elevations, wall mount, and child link in 2D and Wall View', () => {
  const host = makeBoxFurn('table', 'Table', {
    xMm: 1000,
    yMm: 1000,
    widthMm: 1200,
    depthMm: 600,
    heightMm: 750,
    elevationMm: 0,
  });
  const vase = makeBoxFurn('vase', 'Vase', {
    xMm: 1100,
    yMm: 1000,
    widthMm: 150,
    depthMm: 150,
    heightMm: 250,
    elevationMm: 750,
    surfaceHostId: 'table',
  });
  const wallXf = computeAttachedWallFurnitureTransform(WALL_SOUTH, 0.25, 'left', {
    parts: [{ id: 'p', name: 'b', shape: 'box', xMm: 0, yMm: 0, zMm: 0, widthMm: 600, depthMm: 300, heightMm: 500, rotationDeg: 0, color: '#fff', material: 'wood' }],
    mirroredX: false,
    mirroredY: false,
    rotationXDeg: 0,
    rotationYDeg: 0,
  });
  const shelf = makeBoxFurn('shelf', 'Shelf', {
    xMm: wallXf.xMm,
    yMm: wallXf.yMm,
    widthMm: 600,
    depthMm: 300,
    heightMm: 500,
    elevationMm: 1400,
    rotationDeg: wallXf.rotationDeg,
    mountingType: 'wall',
    attachedWallId: WALL_SOUTH.id,
    attachedFace: 'left',
    attachedT: wallXf.attachedT,
  });

  // 2D rigid group delta moving host+vase +300mm X without double-moving vase
  const selected2d = new Set(['table', 'vase']);
  const nextTable = { ...host, xMm: 1300, yMm: 1100 };
  const moved2d = applyRigidFurnitureGroupDelta2D(
    [host, vase],
    selected2d,
    'table',
    host,
    nextTable,
    [WALL_SOUTH],
    false
  );
  assert.ok(moved2d);
  const v2 = moved2d.find((f) => f.id === 'vase')!;
  assert.equal(v2.xMm, 1400); // 1100 + 300 (not double moved)
  assert.equal(v2.yMm, 1100);
  assert.equal(v2.surfaceHostId, 'table');
  assert.equal(v2.elevationMm, 750);

  // Wall View rigid group delta preserving wall attachment & relative elevation
  const flushStand = makeBoxFurn('stand', 'Stand', {
    xMm: 1800,
    yMm: 225,
    widthMm: 600,
    depthMm: 300,
    heightMm: 500,
    elevationMm: 0,
  });
  const origMap = new Map([
    [
      'shelf',
      {
        id: 'shelf',
        origXMm: shelf.xMm,
        origYMm: shelf.yMm,
        origElevationMm: 1400,
        origRotDeg: shelf.rotationDeg,
        origAttachedWallId: shelf.attachedWallId,
        origAttachedFace: shelf.attachedFace,
        origAttachedT: shelf.attachedT,
        origCenterX: 1000,
        origZBottom: 1400,
        elevW: 600,
        elevH: 500,
      },
    ],
    [
      'stand',
      {
        id: 'stand',
        origXMm: 1800,
        origYMm: 225,
        origElevationMm: 0,
        origRotDeg: 0,
        origCenterX: 1800,
        origZBottom: 0,
        elevW: 600,
        elevH: 500,
      },
    ],
  ]);
  const movedWv = applyWallViewFurnitureGroupDelta(
    [shelf, flushStand],
    new Set(['shelf', 'stand']),
    WALL_SOUTH,
    'left',
    400,
    200,
    origMap
  );
  const sh2 = movedWv.find((f) => f.id === 'shelf')!;
  const st2 = movedWv.find((f) => f.id === 'stand')!;
  assert.equal(sh2.attachedWallId, WALL_SOUTH.id);
  assert.equal(sh2.elevationMm, 1600);
  assert.equal(st2.xMm, 2200);
  assert.equal(st2.yMm, 225);
  assert.equal(st2.elevationMm, 200);
});
