import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchElement, FurnitureInstance, Level, Wall } from '../types/plan.ts';
import {
  computeZoomSnapTolerances,
  createHostDwellTracker,
  DEFAULT_HOST_DWELL_MS,
  easeOutCubic,
  evaluateHostDwellStep,
  pickWithSnapHysteresis,
  resolveSingleDragHint,
  sampleSnapVisualTween,
  SNAP_ANIMATION_DURATION_MS,
  SNAP_HYSTERESIS_EXIT_FACTOR,
  updateSnapVisualTweenOnSolverResult,
} from './dragErgonomics.ts';
import {
  snapArchElementToPlan,
  snapFurnitureToPlan,
  snapPointToPlan,
  solveSolidFurnitureMove,
  solveWallComponentDrag,
} from './geometry.ts';

function makeBoxFurn(
  id: string,
  name: string,
  xMm: number,
  yMm: number,
  widthMm: number,
  depthMm: number,
  heightMm: number,
  extra?: Partial<FurnitureInstance>
): FurnitureInstance {
  return {
    id,
    templateId: `tpl_${id}`,
    name,
    category: 'Tables & Desks',
    xMm,
    yMm,
    elevationMm: 0,
    rotationDeg: 0,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    visible: true,
    locked: false,
    parts: [
      {
        id: `${id}_body`,
        name: 'Body',
        shape: 'box',
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm,
        depthMm,
        heightMm,
        rotationDeg: 0,
        material: 'oak',
        color: '#CBD5E1',
      },
    ],
    ...extra,
  };
}

function makeWall(id: string, x1: number, y1: number, x2: number, y2: number, thicknessMm = 120): Wall {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thicknessMm,
    heightMm: 2700,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    innerColor: '#FFFFFF',
    outerColor: '#FFFFFF',
    innerMaterial: 'plaster',
    outerMaterial: 'plaster',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    hasBaseboard: true,
    baseboardHeightMm: 80,
    baseboardColor: '#CBD5E1',
    hasCrownMolding: false,
    crownHeightMm: 60,
    crownColor: '#FFFFFF',
    visible: true,
    locked: false,
  };
}

function makeMinimalLevel(walls: Wall[], furniture: FurnitureInstance[], archElements: ArchElement[] = []): Level {
  return {
    id: 'lvl_1',
    name: 'Level 1',
    elevationMm: 0,
    ceilingHeightMm: 2700,
    walls,
    openings: [],
    rooms: [],
    furniture,
    curtains: [],
    people: [],
    archElements,
    measurements: [],
    annotations: [],
    sectionLine: null,
    backgroundTrace: null,
    layers: {
      walls: true,
      rooms: true,
      openings: true,
      furniture: true,
      curtains: true,
      people: true,
      archElements: true,
      measurements: true,
      annotations: true,
      autoDimensions: true,
      grid: true,
    },
  };
}

describe('Milestone 2 — Zoom-aware screen-pixel snap tolerances', () => {
  it('scales pixel budgets inversely with pxPerMm and clamps within sane mm bounds', () => {
    const mid = computeZoomSnapTolerances(0.1);
    assert.equal(mid.vertexWallTolMm, 120); // 12 px / 0.1
    assert.equal(mid.furnFlushTolMm, 100); // 10 px / 0.1
    assert.equal(mid.alignTolMm, 80); // 8 px / 0.1
    assert.equal(mid.roomCenterTolMm, 80);
    assert.equal(mid.strongRoomCenterTolMm, 110);
    assert.equal(mid.surfaceRoomCenterTolMm, 70);

    const zoomedIn = computeZoomSnapTolerances(2.0);
    assert.equal(zoomedIn.vertexWallTolMm, 25); // clamped floor
    assert.equal(zoomedIn.furnFlushTolMm, 20);
    assert.equal(zoomedIn.alignTolMm, 18);
    assert.equal(zoomedIn.strongRoomCenterTolMm, 24);
    assert.equal(zoomedIn.surfaceRoomCenterTolMm, 16);

    const zoomedOut = computeZoomSnapTolerances(0.01);
    assert.equal(zoomedOut.vertexWallTolMm, 240); // clamped ceiling
    assert.equal(zoomedOut.furnFlushTolMm, 180);
    assert.equal(zoomedOut.alignTolMm, 160);
    assert.equal(zoomedOut.strongRoomCenterTolMm, 210);
    assert.equal(zoomedOut.surfaceRoomCenterTolMm, 130);
  });
});

describe('Milestone 2 — Snap hysteresis (~40% exit margin & active target preference)', () => {
  it('retains previous snap key until pointer leaves by 1.4x and resists near-tie flicker', () => {
    const enterTol = 100;
    const enter = pickWithSnapHysteresis(
      [
        { key: 'target_a', dist: 80, data: 'A' },
        { key: 'target_b', dist: 95, data: 'B' },
      ],
      undefined,
      enterTol
    );
    assert.equal(enter?.key, 'target_a');

    // Moves slightly closer to target_b (75 vs 85), should stick to target_a (no chatter)
    const holdNearTie = pickWithSnapHysteresis(
      [
        { key: 'target_a', dist: 85, data: 'A' },
        { key: 'target_b', dist: 75, data: 'B' },
      ],
      'target_a',
      enterTol
    );
    assert.equal(holdNearTie?.key, 'target_a');

    // Moves outside enterTol (100) to 132 (still <= 140), must stay snapped to target_a
    const holdInExitBand = pickWithSnapHysteresis(
      [{ key: 'target_a', dist: 132, data: 'A' }],
      'target_a',
      enterTol
    );
    assert.equal(holdInExitBand?.key, 'target_a');

    // Moves beyond 1.4 * 100 = 140 mm, cleanly releases
    const releaseOutside = pickWithSnapHysteresis(
      [{ key: 'target_a', dist: Math.ceil(enterTol * SNAP_HYSTERESIS_EXIT_FACTOR) + 2, data: 'A' }],
      'target_a',
      enterTol
    );
    assert.equal(releaseOutside, null);

    // Switches cleanly if competitor is decisively closer (< 0.72x prev)
    const decisiveSwitch = pickWithSnapHysteresis(
      [
        { key: 'target_a', dist: 90, data: 'A' },
        { key: 'target_b', dist: 30, data: 'B' },
      ],
      'target_a',
      enterTol
    );
    assert.equal(decisiveSwitch?.key, 'target_b');
  });

  it('applies hysteresis inside snapPointToPlan, solveWallComponentDrag, snapFurnitureToPlan, and snapArchElementToPlan', () => {
    const walls = [makeWall('w1', 0, 0, 2000, 0), makeWall('w2', 3000, 0, 3000, 2000)];

    // 1. snapPointToPlan vertex hysteresis
    const p1 = snapPointToPlan(
      { x: 60, y: 0 },
      { walls, gridSizeMm: 50, snapEnabled: true, angleSnapDeg: 0, orthoMode: false, snapThresholdMm: 100 }
    );
    assert.equal(p1.snappedKind, 'vertex');
    assert.deepEqual(p1.point, { x: 0, y: 0 });
    assert.ok(p1.hysteresis?.pointKey);

    // Move to 125mm away (> 100 enter, < 140 exit) -> stays snapped to (0,0)
    const p2 = snapPointToPlan(
      { x: 125, y: 0 },
      {
        walls,
        gridSizeMm: 50,
        snapEnabled: true,
        angleSnapDeg: 0,
        orthoMode: false,
        snapThresholdMm: 100,
        hysteresis: p1.hysteresis,
      }
    );
    assert.equal(p2.snappedKind, 'vertex');
    assert.deepEqual(p2.point, { x: 0, y: 0 });

    // 2. solveWallComponentDrag hysteresis
    const compDrag1 = solveWallComponentDrag(
      [{ id: 'op1', kind: 'opening', name: 'Door', t: 0.5, widthMm: 800, leftS: 1100, rightS: 1900, centerS: 1500, locked: false, resizeAnchor: 'center' }],
      { lengthMm: 3000, innerStartS: 100, innerEndS: 2900, leftStartS: 100, leftEndS: 2900, rightStartS: 100, rightEndS: 2900 },
      'op1',
      1475,
      true,
      60
    );
    assert.equal(compDrag1.snapKey, 'wall_center');
    assert.equal(compDrag1.centerS, 1500);

    // At 1575mm (75mm from center, >60 enter, <84 exit) -> stays at 1500 with hysteresis
    const compDrag2 = solveWallComponentDrag(
      [{ id: 'op1', kind: 'opening', name: 'Door', t: 0.5, widthMm: 800, leftS: 1100, rightS: 1900, centerS: 1500, locked: false, resizeAnchor: 'center' }],
      { lengthMm: 3000, innerStartS: 100, innerEndS: 2900, leftStartS: 100, leftEndS: 2900, rightStartS: 100, rightEndS: 2900 },
      'op1',
      1575,
      true,
      60,
      compDrag1.snapKey
    );
    assert.equal(compDrag2.snapKey, 'wall_center');
    assert.equal(compDrag2.centerS, 1500);

    // 3. snapFurnitureToPlan hysteresis against another item
    const tableA = makeBoxFurn('a', 'Table A', 1000, 1000, 800, 800, 750);
    const tableB = makeBoxFurn('b', 'Table B', 2000, 1000, 800, 800, 750);
    const f1 = snapFurnitureToPlan({ x: 1855, y: 1000 }, tableB, [], [tableA], {
      snapEnabled: true,
      gridSizeMm: 50,
      furnSnapTolMm: 80,
      alignTolMm: 60,
    });
    assert.equal(f1.xMm, 1800);
    assert.ok(f1.hysteresis?.furnFlushXKey);
    const f2 = snapFurnitureToPlan({ x: 1900, y: 1000 }, tableB, [], [tableA], {
      snapEnabled: true,
      gridSizeMm: 50,
      furnSnapTolMm: 80,
      alignTolMm: 60,
      hysteresis: f1.hysteresis,
    });
    assert.equal(f2.xMm, 1800);

    // 4. snapArchElementToPlan hysteresis
    const blkA: ArchElement = {
      id: 'arch_a',
      type: 'platform',
      name: 'Platform A',
      xMm: 1000,
      yMm: 1000,
      widthMm: 1000,
      depthMm: 1000,
      heightMm: 200,
      elevationMm: 0,
      rotationDeg: 0,
      color: '#CBD5E1',
      accentColor: '#94A3B8',
      material: 'concrete',
      visible: true,
      locked: false,
    };
    const blkB: ArchElement = { ...blkA, id: 'arch_b', xMm: 2000 };
    const a1 = snapArchElementToPlan({ x: 2050, y: 1000 }, blkB, [], [blkA], {
      snapEnabled: true,
      gridSizeMm: 50,
      blockTolMm: 80,
    });
    assert.equal(a1.xMm, 2000);
    const a2 = snapArchElementToPlan({ x: 2095, y: 1000 }, blkB, [], [blkA], {
      snapEnabled: true,
      gridSizeMm: 50,
      blockTolMm: 80,
      hysteresis: a1.hysteresis,
    });
    assert.equal(a2.xMm, 2000);
  });
});

describe('Milestone 2 — Collision sliding & free overlap escape', () => {
  it('slides tangentially along a 45-degree blocking wall instead of stopping dead', () => {
    const diagWall = makeWall('w_diag', 0, 0, 2000, 2000, 100);
    const box = makeBoxFurn('sofa', 'Sofa', 600, 100, 400, 400, 700);
    const lvl = makeMinimalLevel([diagWall], [box]);

    // Move diagonally down-right across the 45-degree wall:
    // Moving toward (+300, +300) moves mostly parallel along the wall, slightly into it.
    // Rather than freezing at (600, 100), solver slides parallel to (1,1) without penetrating wall.
    const solved = solveSolidFurnitureMove(
      { x: 600, y: 100 },
      { x: 920, y: 550 },
      box,
      lvl,
      {
        snapEnabled: false,
        gridSizeMm: 50,
      }
    );

    assert.ok(solved.xMm > 650, `Expected tangential slide along X, got x=${solved.xMm}`);
    assert.ok(solved.yMm > 150, `Expected tangential slide along Y, got y=${solved.yMm}`);
    assert.ok(
      solved.xMm - solved.yMm > 260,
      `Expected furniture to stay on its valid side of the 45-deg wall without tunneling`
    );
  });

  it('allows free separation from a pre-existing wall overlap while still blocking deeper penetration', () => {
    const wall = makeWall('w1', 0, 1000, 4000, 1000, 120);
    // Start furniture intentionally overlapping the wall (wall occupies y in [940, 1060]; box spans y +/- 200)
    const overlappingBox = makeBoxFurn('chair', 'Chair', 1500, 1020, 400, 400, 700);
    const lvl = makeMinimalLevel([wall], [overlappingBox]);

    // Drag outward (+Y toward 1350): must separate freely!
    const escapeMove = solveSolidFurnitureMove(
      { x: 1500, y: 1020 },
      { x: 1500, y: 1350 },
      overlappingBox,
      lvl,
      { snapEnabled: false, gridSizeMm: 50 }
    );
    assert.ok(
      escapeMove.yMm >= 1300,
      `Expected free escape from pre-existing overlap toward 1350, got y=${escapeMove.yMm}`
    );
  });
});

describe('Milestone 2 — 120 ms stack host dwell', () => {
  it('waits 120 ms before adopting a new surface host and switches immediately when forced', () => {
    const t0 = createHostDwellTracker(undefined);
    const step1 = evaluateHostDwellStep(t0, 'desk_1', 1000);
    assert.equal(step1.resolvedHostId, undefined);
    assert.equal(step1.waitingForDwell, true);

    const stepTooEarly = evaluateHostDwellStep(step1.nextTracker, 'desk_1', 1080);
    assert.equal(stepTooEarly.resolvedHostId, undefined);
    assert.equal(stepTooEarly.waitingForDwell, true);

    const stepCommitted = evaluateHostDwellStep(stepTooEarly.nextTracker, 'desk_1', 1000 + DEFAULT_HOST_DWELL_MS);
    assert.equal(stepCommitted.resolvedHostId, 'desk_1');
    assert.equal(stepCommitted.waitingForDwell, false);

    // Leaving back to floor (candidate undefined) drops immediately when immediate:true is passed
    const stepFloor = evaluateHostDwellStep(stepCommitted.nextTracker, undefined, 1200, { immediate: true });
    assert.equal(stepFloor.resolvedHostId, undefined);
    assert.equal(stepFloor.waitingForDwell, false);
  });

  it('integrates with solveSolidFurnitureMove via resolveSurfaceHost', () => {
    const desk = makeBoxFurn('desk', 'Oak Desk', 1500, 1500, 1600, 800, 750);
    const lamp = makeBoxFurn('lamp', 'Desk Lamp', 400, 400, 220, 220, 380);
    const lvl = makeMinimalLevel([], [desk, lamp]);

    let tracker = createHostDwellTracker(undefined);
    const solveAt = (nowMs: number, immediate = false) => {
      const res = solveSolidFurnitureMove({ x: 400, y: 400 }, { x: 1500, y: 1500 }, lamp, lvl, {
        snapEnabled: false,
        gridSizeMm: 50,
        resolveSurfaceHost: (rawHostId) =>
          evaluateHostDwellStep(tracker, rawHostId, nowMs, { immediate: immediate || !rawHostId }).resolvedHostId,
      });
      tracker = evaluateHostDwellStep(tracker, res.rawSurfaceHostCandidateId, nowMs, {
        immediate: immediate || !res.rawSurfaceHostCandidateId,
      }).nextTracker;
      return res;
    };

    const first = solveAt(1000);
    assert.equal(first.rawSurfaceHostCandidateId, 'desk');
    assert.equal(first.surfaceHostId, undefined); // Held by dwell gate
    assert.equal(first.elevationMm, 0);

    const settled = solveAt(1130);
    assert.equal(settled.surfaceHostId, 'desk'); // Committed after 130 ms >= 120 ms
    assert.equal(settled.elevationMm, 750);
  });
});

describe('Milestone 2 — Single-line cursor hint priority', () => {
  it('prioritizes Clash > Host/Wall Attachment > Snap with single-line output', () => {
    const clashWins = resolveSingleDragHint({
      clashingNames: ['Sofa', 'Lamp'],
      placingOnHostName: 'Oak Desk',
      attachedToWall: true,
      roomCenterName: 'Living Room',
      snapLabel: 'Flush to wall',
    });
    assert.deepEqual(clashWins, { text: 'Clashing with Sofa (+1)', tone: 'clash' });

    const hostWinsOverSnap = resolveSingleDragHint({
      placingOnHostName: 'Oak Desk',
      attachedToWall: true,
      roomCenterName: 'Living Room',
      snapLabel: 'Aligned edge',
    });
    assert.deepEqual(hostWinsOverSnap, { text: 'On Oak Desk', tone: 'attachment' });

    const wallAttachWinsOverSnap = resolveSingleDragHint({
      attachedToWall: true,
      snapLabel: 'Flush to wall',
    });
    assert.deepEqual(wallAttachWinsOverSnap, { text: 'Attached to wall', tone: 'attachment' });

    const snapFallback = resolveSingleDragHint({
      snapLabel: 'Aligned center',
    });
    assert.deepEqual(snapFallback, { text: 'Aligned center', tone: 'snap' });
    assert.ok(!clashWins!.text.includes('\n'));
  });
});

describe('Milestone 2 — ~100 ms ease-out snap visual tween', () => {
  it('glides visually on snap engagement without mutating committed solver coordinates', () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.ok(easeOutCubic(0.5) > 0.5);

    const tween = updateSnapVisualTweenOnSolverResult(
      null,
      'furniture:sofa',
      { x: 1000, y: 1000 },
      { x: 1040, y: 1000 },
      'wall_w1',
      120,
      5000
    );
    assert.ok(tween);
    assert.deepEqual(tween.lastCommittedPos, { x: 1040, y: 1000 });

    const atStart = sampleSnapVisualTween(tween, 5000);
    assert.equal(atStart.active, true);
    assert.equal(Math.round(atStart.dx), -40);

    const atMid = sampleSnapVisualTween(tween, 5050);
    assert.equal(atMid.active, true);
    assert.ok(atMid.dx < 0 && atMid.dx > -10); // ease-out covers most distance in first half

    const atEnd = sampleSnapVisualTween(tween, 5000 + SNAP_ANIMATION_DURATION_MS);
    assert.equal(atEnd.active, false);
    assert.equal(atEnd.dx, 0);
    assert.equal(atEnd.dy, 0);
  });
});
