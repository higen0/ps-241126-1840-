import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_CATALOG } from '../data/catalog';
import type { FurnitureInstance, SvgVectorElement, Wall } from '../types/plan';
import { projectFurnitureForWallCutThrough } from './geometry';
import {
  clearWallAngleProjectionCache,
  computeCustomSvgWallViewTransform,
  computeSvgElementsBoundsMm,
  computeWallCameraRelativeYawDeg,
  computeWallEndOcclusion,
  getCachedWallAngleProjection,
  getWallAngleProjectionCacheStats,
} from './wallViewProjection';

function makeWall(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thicknessMm = 150
): Wall {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thicknessMm,
    heightMm: 2800,
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
    hasBaseboard: false,
    baseboardHeightMm: 100,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 80,
    crownColor: '#FFFFFF',
    locked: false,
    visible: true,
  };
}

test('Milestone 6: Wall-end occlusion distinguishes open room ends from perpendicular corner walls', () => {
  const mainWall = makeWall('w_main', 0, 0, 4000, 0);
  const openRes = computeWallEndOcclusion(mainWall, [mainWall], 'inner');
  assert.equal(openRes.leftClipX, null);
  assert.equal(openRes.rightClipX, null);

  // Perpendicular wall extending into the viewed room side (+Y) on the left end only
  const leftCornerWall = makeWall('w_left', 0, 0, 0, 3000);
  // Perpendicular wall extending behind the viewed wall (-Y) on the right end
  const rearRightWall = makeWall('w_right_rear', 4000, 0, 4000, -2500);
  const cornerRes = computeWallEndOcclusion(
    mainWall,
    [mainWall, leftCornerWall, rearRightWall],
    'inner'
  );
  assert.equal(cornerRes.leftClipX, 0);
  assert.ok(cornerRes.leftBlockingOutMm > 2800);
  assert.equal(cornerRes.rightClipX, null);
});

test('Milestone 6: Asymmetric custom SVG elements center by actual SVG bounds without left cutoff', () => {
  // Asymmetric arc lamp SVG whose elements span x in [-520, +80], y in [-1800, 0]
  const asymmetricLampEls: SvgVectorElement[] = [
    {
      id: 'base',
      kind: 'rect',
      name: 'Base',
      x: -100,
      y: -50,
      width: 180,
      height: 50,
      stroke: '#0F172A',
      strokeWidthMm: 8,
      fill: '#FFFFFF',
      fillOpacity: 1,
      visible: true,
    },
    {
      id: 'arm_shade',
      kind: 'polyline',
      name: 'Arc & Shade',
      points: [
        { x: -10, y: -50 },
        { x: -300, y: -1750 },
        { x: -520, y: -1800 },
        { x: -520, y: -1520 },
      ],
      closed: false,
      stroke: '#0F172A',
      strokeWidthMm: 8,
      fill: 'none',
      fillOpacity: 0,
      visible: true,
    },
  ];

  const b = computeSvgElementsBoundsMm(asymmetricLampEls);
  assert.equal(b.minX, -520);
  assert.equal(b.maxX, 80);
  assert.equal(b.widthMm, 600);
  assert.equal(b.centerX, -220);
  assert.equal(b.bottomY, 0);

  const xf = computeCustomSvgWallViewTransform(
    asymmetricLampEls,
    undefined,
    {
      viewId: 'front',
      flipX: false,
      hasTilt: false,
      viewXCenter: 1500,
      elevW: 600,
      elevH: 1800,
      zBottom: 0,
    },
    0,
    { preserveAspectOnFlat: true }
  );
  // Translating by (-srcCenterX) moves [-520, +80] to [-300, +300] around viewXCenter (1500)
  const renderedMinX = xf.translateX + (b.minX - xf.srcCenterX) * xf.scaleX;
  const renderedMaxX = xf.translateX + (b.maxX - xf.srcCenterX) * xf.scaleX;
  assert.ok(Math.abs(renderedMinX - 1200) < 0.5);
  assert.ok(Math.abs(renderedMaxX - 1800) < 0.5);
});

test('Milestone 6: Custom SVG oblique rotation stays bounded without severe stretching', () => {
  const customEls: SvgVectorElement[] = [
    {
      id: 'rect_1',
      kind: 'rect',
      name: 'Body',
      x: -210,
      y: -1800,
      width: 420,
      height: 1800,
      stroke: '#0F172A',
      strokeWidthMm: 8,
      fill: '#FFFFFF',
      fillOpacity: 1,
      visible: true,
    },
  ];
  const xfOblique = computeCustomSvgWallViewTransform(
    customEls,
    undefined,
    {
      viewId: 'front',
      flipX: false,
      hasTilt: false,
      viewXCenter: 2000,
      elevW: 890, // wide rotated AABB compared to 420mm front SVG
      elevH: 1800,
      zBottom: 0,
    },
    44,
    { preserveAspectOnFlat: true }
  );
  // Vertical scale stays 1.0, horizontal stretch is gently bounded (<= 1.18) instead of 2.12x
  assert.ok(Math.abs(xfOblique.scaleY - 1) < 1e-4);
  assert.ok(Math.abs(xfOblique.scaleX) <= 1.181);
});

test('Milestone 6: Arc Floor Lamp 360-deg 10-degree projections match rotated bounds & hit LRU cache', () => {
  clearWallAngleProjectionCache();
  const lampTpl = BUILTIN_CATALOG.find((c) => c.id === 'light_floor')!;
  assert.ok(lampTpl, 'Arc Floor Lamp catalog item must exist');

  const wall = makeWall('w1', 0, 0, 4000, 0);
  const baseLamp: FurnitureInstance = {
    id: 'lamp_1',
    templateId: 'light_floor',
    name: lampTpl.name,
    category: lampTpl.category,
    xMm: 2000,
    yMm: 600,
    elevationMm: 0,
    rotationDeg: 0,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    parts: lampTpl.parts.map((p) => ({ ...p })),
    visible: true,
    locked: false,
  };

  for (const rot of [0, 35, 90, 142, 180, 228, 270, 315]) {
    const rotatedLamp = { ...baseLamp, rotationDeg: rot };
    const cut = projectFurnitureForWallCutThrough(wall, 'inner', rotatedLamp, 2800, 1500);
    assert.equal(cut.status, 'visible');
    const yawInfo = computeWallCameraRelativeYawDeg(wall, 'inner', rotatedLamp);
    const proj = getCachedWallAngleProjection(rotatedLamp, yawInfo.bucketYawDeg, 'silhouette', 12);
    assert.ok(proj);
    assert.ok(proj.elements.length > 0);
    assert.ok(
      Math.abs(proj.baseHeightMm - cut.projection!.elevH) <= 2,
      `Height mismatch at ${rot} deg: ${proj.baseHeightMm} vs ${cut.projection!.elevH}`
    );
    // At exact 10-deg multiples, projected width closely matches rotated 3D AABB width
    if (rot % 10 === 0) {
      assert.ok(
        Math.abs(proj.baseWidthMm - cut.projection!.elevW) <= 4,
        `Width mismatch at ${rot} deg: ${proj.baseWidthMm} vs ${cut.projection!.elevW}`
      );
    }
  }

  // Verify LRU cache hit on repeated lookup
  const before = getWallAngleProjectionCacheStats();
  getCachedWallAngleProjection(baseLamp, 40, 'silhouette', 12);
  const afterHit = getWallAngleProjectionCacheStats();
  assert.equal(afterHit.hits, before.hits + 1);
  assert.equal(afterHit.misses, before.misses);

  // Verify cache invalidates automatically when dimensions/parts change
  const resizedLamp: FurnitureInstance = {
    ...baseLamp,
    parts: baseLamp.parts.map((p) =>
      p.id === 'shade' ? { ...p, widthMm: 620, depthMm: 620 } : p
    ),
  };
  const resizedProj = getCachedWallAngleProjection(resizedLamp, 0, 'silhouette', 12);
  const afterResize = getWallAngleProjectionCacheStats();
  assert.equal(afterResize.misses, afterHit.misses + 1);
  assert.ok(resizedProj);
  assert.ok(resizedProj.baseWidthMm >= 615);

  // Verify behind-wall lamp stays hidden/opposite_side (legitimate wall occlusion preserved)
  const behindLamp = { ...baseLamp, yMm: -700 };
  const behindCut = projectFurnitureForWallCutThrough(wall, 'inner', behindLamp, 2800, 1500);
  assert.equal(behindCut.status, 'opposite_side');
});

test('Milestone 6: Custom GLB furniture never degrades to GLB Bounding Footprint box when 3D scene is unloaded', () => {
  clearWallAngleProjectionCache();
  const wall = makeWall('w_glb', 0, 0, 4000, 0);
  const customGlbFurn: FurnitureInstance = {
    id: 'glb_custom_1',
    templateId: 'imp_glb_custom_lamp',
    name: 'Imported Custom Curved Lamp',
    category: 'My Library',
    xMm: 1800,
    yMm: 700,
    elevationMm: 0,
    rotationDeg: 25,
    mirroredX: false,
    mirroredY: false,
    lockProportions: true,
    glbAssetId: 'unloaded_glb_asset_key',
    parts: [
      {
        id: 'p_bbox',
        name: 'GLB Bounding Footprint',
        shape: 'box',
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm: 650,
        depthMm: 650,
        heightMm: 1750,
        rotationDeg: 0,
        color: '#94A3B8',
        material: 'wood',
      },
    ],
    representation: {
      mode: 'silhouette',
      autoViews: {
        front: {
          view: 'front',
          viewBox: { minX: -325, minY: -1750, width: 650, height: 1750 },
          baseWidthMm: 650,
          baseHeightMm: 1750,
          elements: [
            {
              id: 'sil_front',
              kind: 'path',
              name: 'Silhouette',
              d: 'M -80 0 L 80 0 L 20 -1750 L -250 -1500 Z',
              stroke: '#0F172A',
              strokeWidthMm: 12,
              fill: '#FFFFFF',
              fillOpacity: 1,
              visible: true,
            },
          ],
        },
      },
    },
    visible: true,
    locked: false,
  };

  const yawInfo = computeWallCameraRelativeYawDeg(wall, 'inner', customGlbFurn);
  // While GLB scene is not yet in gltfSceneCache, projection must return null (NOT a box!)
  // so WallCutThroughViewer renders saved autoViews SVG cleanly.
  const proj = getCachedWallAngleProjection(customGlbFurn, yawInfo.bucketYawDeg, 'silhouette', 12);
  assert.equal(proj, null);
});

