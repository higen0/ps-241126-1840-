import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWallViewFurnitureDimensions,
  computeWallViewRoomDimensions,
  extractWallViewSnapGeometry,
  layoutWallViewDimensions,
  snapWallViewMeasurementPoint,
} from './wallViewMeasurements.ts';
import { computeWallViewFurnitureClearances } from './wallViewFurniture.ts';
import type { FurnitureInstance, Room, Wall } from '../types/plan.ts';

function makeWall(id: string, x1: number, y1: number, x2: number, y2: number, heightMm = 2600): Wall {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thicknessMm: 150,
    heightMm,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    innerColor: '#FFFFFF',
    outerColor: '#E2E8F0',
    innerMaterial: 'paint',
    outerMaterial: 'paint',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    hasBaseboard: false,
    baseboardHeightMm: 80,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 60,
    crownColor: '#FFFFFF',
    visible: true,
    locked: false,
  };
}

function makeFurn(id: string, name: string, attachedWallId?: string): FurnitureInstance {
  return {
    id,
    templateId: 'cabinet_wall',
    name,
    category: 'Kitchen',
    xMm: 1000,
    yMm: 200,
    elevationMm: 1400,
    rotationDeg: 0,
    parts: [
      {
        id: 'p1',
        name: 'Body',
        shape: 'box',
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm: 800,
        depthMm: 350,
        heightMm: 700,
        rotationDeg: 0,
        color: '#CBD5E1',
        material: 'wood',
      },
    ],
    mountingType: attachedWallId ? 'wall' : 'freestanding',
    attachedWallId,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    visible: true,
    locked: false,
  };
}

test('Wall View measurement tool snaps accurately to corners/edges and respects Shift free bypass', () => {
  const geom = extractWallViewSnapGeometry({
    wallLenMm: 4000,
    wallHeightMm: 2600,
    innerLeftX: 75,
    innerRightX: 3925,
    furnRects: [
      {
        id: 'cab1',
        name: 'Wall Cabinet',
        leftX: 600,
        rightX: 1400,
        zBottom: 1400,
        zTop: 2100,
        centerX: 1000,
        elevW: 800,
        elevH: 700,
      },
    ],
    wallEdgeObstacles: [
      { id: 'win1', name: 'Window', leftX: 2200, rightX: 3200, zBottom: 900, zTop: 2100 },
    ],
    solidArchObstacles: [],
  });

  // Snap to furniture top-left corner
  const snapCorner = snapWallViewMeasurementPoint(
    { xMm: 618, zMm: 2085 },
    geom,
    { bypassSnap: false, pointTolMm: 45, edgeTolMm: 30 }
  );
  assert.equal(snapCorner.snappedKind, 'furniture');
  assert.deepEqual(snapCorner.point, { xMm: 600, zMm: 2100 });

  // Snap to opening edge (away from midpoint 2700)
  const snapEdge = snapWallViewMeasurementPoint(
    { xMm: 2450, zMm: 912 },
    geom,
    { bypassSnap: false, pointTolMm: 35, edgeTolMm: 30 }
  );
  assert.equal(snapEdge.snappedKind, 'edge');
  assert.deepEqual(snapEdge.point, { xMm: 2450, zMm: 900 });

  // Shift bypasses snapping for free measurement
  const freePt = snapWallViewMeasurementPoint(
    { xMm: 618, zMm: 2085 },
    geom,
    { bypassSnap: true, pointTolMm: 45, edgeTolMm: 30 }
  );
  assert.equal(freePt.snappedKind, 'free');
  assert.deepEqual(freePt.point, { xMm: 618, zMm: 2085 });
});

test('computeWallViewRoomDimensions computes overall room width and height along viewed wall', () => {
  const wall = makeWall('w1', 0, 0, 4200, 0, 2700);
  const room: Room = {
    id: 'r1',
    name: 'Kitchen',
    polygon: [
      { x: 75, y: 75 },
      { x: 4125, y: 75 },
      { x: 4125, y: 3075 },
      { x: 75, y: 3075 },
    ],
    areaM2: 12.15,
    perimeterM: 14.1,
    floorColor: '#FFFFFF',
    floorMaterial: 'tile',
    floorTextureScale: 1,
    floorTextureRotDeg: 0,
    floorLevelMm: 0,
    hasCeiling: true,
    ceilingHeightMm: 2700,
    ceilingColor: '#FFFFFF',
    ceilingMaterial: 'paint',
    visible: true,
    locked: false,
  };

  const dims = computeWallViewRoomDimensions({
    wall,
    rooms: [room],
    viewedPhysicalSide: 'left',
    wallLenMm: 4200,
    wallHeightMm: 2700,
    isLeftView: true,
  });
  assert.ok(dims);
  assert.equal(dims.roomName, 'Kitchen');
  assert.equal(dims.widthMm, 4050);
  assert.equal(dims.heightMm, 2700);
});

test('wall-mounted furniture emits nearest-corner measurement that updates on move/resize', () => {
  const bounds = { innerLeftX: 75, innerRightX: 3925, wallHeightMm: 2600 };
  const counter = {
    id: 'base1',
    name: 'Base Cabinet',
    leftX: 400,
    rightX: 1600,
    zBottom: 0,
    zTop: 900,
    centerX: 1000,
    elevW: 1200,
    elevH: 900,
  };
  const leftCab = {
    id: 'cab0',
    name: 'Left Cabinet',
    leftX: 150,
    rightX: 650,
    zBottom: 1450,
    zTop: 2150,
    centerX: 400,
    elevW: 500,
    elevH: 700,
  };
  const hood = {
    id: 'hood1',
    name: 'Hood',
    leftX: 1600,
    rightX: 2200,
    zBottom: 1550,
    zTop: 2100,
    centerX: 1900,
    elevW: 600,
    elevH: 550,
  };
  const cabA = {
    id: 'cab1',
    name: 'Wall Cabinet',
    leftX: 800,
    rightX: 1600,
    zBottom: 1450,
    zTop: 2150,
    centerX: 1200,
    elevW: 800,
    elevH: 700,
  };
  const allFurn = [
    makeFurn('cab1', 'Wall Cabinet', 'w1'),
    makeFurn('cab0', 'Left Cabinet', 'w1'),
    makeFurn('base1', 'Base Cabinet'),
    makeFurn('hood1', 'Hood', 'w1'),
  ];

  const clearances1 = computeWallViewFurnitureClearances(cabA, [counter, leftCab, hood], [], [], bounds);
  const dims1 = computeWallViewFurnitureDimensions({
    activeFurnId: 'cab1',
    furnRects: [counter, leftCab, hood, cabA],
    furnRectById: new Map([
      ['base1', counter],
      ['cab0', leftCab],
      ['hood1', hood],
      ['cab1', cabA],
    ]),
    allFurniture: allFurn,
    clearances: clearances1,
    dragBounds: bounds,
    targetWallId: 'w1',
  });

  // Width, Height, Floor (since bottom clearance stops at countertop), Corner (to left corner = 800 - 75 = 725, distinct from leftCab gap = 150)
  const wDim = dims1.find((d) => d.kind === 'furn_width');
  const hDim = dims1.find((d) => d.kind === 'furn_height');
  const flDim = dims1.find((d) => d.kind === 'furn_floor');
  const cornerDim = dims1.find((d) => d.kind === 'furn_corner');
  assert.equal(wDim?.valueMm, 800);
  assert.equal(hDim?.valueMm, 700);
  assert.equal(flDim?.valueMm, 1450);
  assert.equal(clearances1.left?.gapMm, 150);
  assert.equal(cornerDim?.valueMm, 725);

  // Move & resize cab1 closer to right wall -> corner updates automatically
  const cabMoved = {
    ...cabA,
    leftX: 3000,
    rightX: 3600,
    centerX: 3300,
    elevW: 600,
  };
  const clearances2 = computeWallViewFurnitureClearances(cabMoved, [counter, leftCab, hood], [], [], bounds);
  const dims2 = computeWallViewFurnitureDimensions({
    activeFurnId: 'cab1',
    furnRects: [counter, leftCab, hood, cabMoved],
    furnRectById: new Map([
      ['base1', counter],
      ['cab0', leftCab],
      ['hood1', hood],
      ['cab1', cabMoved],
    ]),
    allFurniture: allFurn,
    clearances: clearances2,
    dragBounds: bounds,
    targetWallId: 'w1',
  });
  assert.equal(dims2.find((d) => d.kind === 'furn_width')?.valueMm, 600);
  assert.equal(clearances2.right?.gapMm, 325);
});

test('layoutWallViewDimensions repositions overlapping labels away from furniture and other labels', () => {
  const obs = [{ minX: 500, maxX: 1300, minZ: 1400, maxZ: 2100 }];
  const raw = [
    {
      dimKey: 'd1',
      category: 'furniture' as const,
      kind: 'furn_width' as const,
      x1: 500,
      z1: 2050,
      x2: 1300,
      z2: 2050,
      valueMm: 800,
      vertical: false,
      nudgeDir: 1 as const,
      priority: 100,
    },
    {
      dimKey: 'd2',
      category: 'furniture' as const,
      kind: 'furn_corner' as const,
      x1: 75,
      z1: 2165,
      x2: 1300,
      z2: 2165,
      valueMm: 1225,
      vertical: false,
      nudgeDir: 1 as const,
      priority: 90,
    },
  ];

  const laid = layoutWallViewDimensions(raw, obs, 0.25);
  const d1 = laid.find((d) => d.dimKey === 'd1')!;
  const d2 = laid.find((d) => d.dimKey === 'd2')!;
  // d1 should be nudged above z=2100 so it doesn't sit inside the furniture box
  assert.ok(d1.z1 > 2100);
  // d2 overlaps d1's horizontal label at z=2165 so it should nudge further up
  assert.ok(d2.z1 > d1.z1);
});
