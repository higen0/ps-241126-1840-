import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CardinalRotationDeg,
  computePanForViewRotationStep,
  computeRotatedGridWorldBounds,
  computeRotatedPlanFit,
  normalizeScreenUprightAngleDeg,
  screenDeltaToWorldDelta,
  screenRelCenterToWorld,
  stepCardinalRotation,
  worldToScreenPoint,
} from './viewRotation2d';

describe('viewRotation2d', () => {
  it('steps strictly through cardinal 90° angles CCW and CW', () => {
    let deg: CardinalRotationDeg = 0;
    deg = stepCardinalRotation(deg, 90);
    assert.equal(deg, 90);
    deg = stepCardinalRotation(deg, 90);
    assert.equal(deg, 180);
    deg = stepCardinalRotation(deg, 90);
    assert.equal(deg, 270);
    deg = stepCardinalRotation(deg, 90);
    assert.equal(deg, 0);

    deg = stepCardinalRotation(0, -90);
    assert.equal(deg, 270);
    deg = stepCardinalRotation(deg, -90);
    assert.equal(deg, 180);
    deg = stepCardinalRotation(deg, -90);
    assert.equal(deg, 90);
    deg = stepCardinalRotation(deg, -90);
    assert.equal(deg, 0);
  });

  it('round-trips worldToScreenPoint and screenRelCenterToWorld for all cardinal angles', () => {
    const W = 1200;
    const H = 800;
    const pan = { x: 45, y: -32 };
    const pxPerMm = 0.08;
    const worldPt = { x: 2450, y: -1380 };

    for (const rot of [0, 90, 180, 270] as CardinalRotationDeg[]) {
      const scr = worldToScreenPoint(worldPt, W, H, pan, pxPerMm, rot);
      const back = screenRelCenterToWorld(scr.x - W / 2, scr.y - H / 2, pan, pxPerMm, rot);
      assert.ok(Math.abs(back.x - worldPt.x) < 1e-6, `rot=${rot} x mismatch`);
      assert.ok(Math.abs(back.y - worldPt.y) < 1e-6, `rot=${rot} y mismatch`);
    }
  });

  it('keeps the viewport center world point fixed when stepping view rotation', () => {
    const pxPerMm = 0.1;
    let pan = { x: -180, y: 110 };
    let rot: CardinalRotationDeg = 0;
    const initialCenterWorld = screenRelCenterToWorld(0, 0, pan, pxPerMm, rot);

    for (const delta of [90, 90, -90, 90, 90] as Array<-90 | 90>) {
      pan = computePanForViewRotationStep(pan, delta);
      rot = stepCardinalRotation(rot, delta);
      const nextCenterWorld = screenRelCenterToWorld(0, 0, pan, pxPerMm, rot);
      assert.ok(Math.abs(nextCenterWorld.x - initialCenterWorld.x) < 1e-6);
      assert.ok(Math.abs(nextCenterWorld.y - initialCenterWorld.y) < 1e-6);
    }

    // Resetting back to 0° also preserves center world point
    pan = computePanForViewRotationStep(pan, -rot);
    rot = 0;
    const resetCenterWorld = screenRelCenterToWorld(0, 0, pan, pxPerMm, rot);
    assert.ok(Math.abs(resetCenterWorld.x - initialCenterWorld.x) < 1e-6);
    assert.ok(Math.abs(resetCenterWorld.y - initialCenterWorld.y) < 1e-6);
  });

  it('maps rotated grid bounds and fit-to-screen spans accurately at 90° and 270°', () => {
    const bounds90 = computeRotatedGridWorldBounds(1200, 600, { x: 0, y: 0 }, 0.1, 90);
    // Screen X (1200px = 12000mm) maps to world Y; Screen Y (600px = 6000mm) maps to world X
    assert.equal(Math.round(bounds90.maxX - bounds90.minX), 6000);
    assert.equal(Math.round(bounds90.maxY - bounds90.minY), 12000);

    const fit = computeRotatedPlanFit({
      minX: -5000,
      maxX: 5000,
      minY: -2000,
      maxY: 2000,
      viewportWidth: 1000,
      viewportHeight: 800,
      baseScalePxPerMm: 0.05,
      rotDeg: 90,
    });
    assert.ok(fit.zoomMultiplier >= 0.15 && fit.zoomMultiplier <= 6);
  });

  it('maps screen arrow nudges to rotated world deltas and keeps label angles upright', () => {
    // At 90° CW view rotation, world +X points down and world -Y points right
    const rightAt90 = screenDeltaToWorldDelta(50, 0, 90);
    assert.deepEqual(rightAt90, { x: 0, y: -50 });

    // Horizontal world line (0°) at 180° view rotation flips by 180° so screen angle stays 0°
    const dimAt180 = normalizeScreenUprightAngleDeg(0, 180);
    assert.equal(((dimAt180 + 180) % 360 + 360) % 360, 0);

    // Vertical world line (90°) at 90° view rotation becomes 180° on screen -> flipped to 0° on screen
    const dimAt90 = normalizeScreenUprightAngleDeg(90, 90);
    assert.equal(((dimAt90 + 90) % 360 + 360) % 360, 0);
  });
});
