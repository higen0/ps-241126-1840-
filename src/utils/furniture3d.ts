import * as THREE from 'three';
import type {
  FurnitureInstance,
  FurniturePart,
  MountingFace,
  MountingType,
} from '../types/plan';
import {
  ArchitecturalMaterialOptions,
  applyWorldSpaceUVs,
  buildArchitecturalMaterial,
  createArtCanvasTexture,
  createRugPatternTexture,
} from './textures3d';
import {
  type FurniturePlacement,
  getFurniturePlacement,
  isCurtainOrBlindFurniture,
} from './geometry';
import {
  resolveFurnitureMountingFace,
  resolveFurnitureMountingType,
} from './mounting';
import { fitGlbSceneToFurnitureBounds } from './furnitureRepresentationSync';
import {
  applyProceduralPartEmissive,
  buildThreeLightsForFurniture,
  type EmissiveTargetEntry,
  isFurnitureLightingActive,
  resolveEffectiveFurnitureLights,
  resolveLightSourceThreeColor,
  type SceneBulbLightEntry,
} from './lighting';
import {
  createCanonicalPartBaseGeometry,
  createExtrudedCentered,
  extractThreeObjectBoundaryVerticesMm,
  ovalShape,
  type PartLocalVertex3DMm,
  registerCompositePartBoundaryExtractor,
  roundedRectShape,
} from './partGeometry3d';
export { createCanonicalPartBaseGeometry };

export interface Furniture3DBuildContext {
  matOpts: ArchitecturalMaterialOptions;
  castShadows: boolean;
  clippingPlanes: THREE.Plane[];
  nightMix: number;
  partEdgeMat: THREE.LineBasicMaterial;
  kelvinToColor: (kelvin: number) => THREE.Color;
  effectiveCeilingMm?: number;
  isSoftwareGl?: boolean;
}

export interface BuiltFurnitureResult {
  group: THREE.Group;
  bulbLights: SceneBulbLightEntry[];
  emissiveTargets: EmissiveTargetEntry[];
}

let meshUvSeedSeq = 1;

function createPartBaseGeometry(part: FurniturePart): THREE.BufferGeometry {
  return createCanonicalPartBaseGeometry(part);
}

function clampCompositeGroupToPartBounds(
  obj: THREE.Object3D,
  pw: number,
  ph: number,
  pd: number,
  stretchToFill = false
): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.add(obj);
  wrapper.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj);
  if (!bb.isEmpty()) {
    const tol = 0.0002;
    const adjustAxis = (axis: 'x' | 'y' | 'z', targetSpan: number) => {
      const half = targetSpan / 2;
      const minV = bb.min[axis];
      const maxV = bb.max[axis];
      const span = maxV - minV;
      if (span <= 1e-5) return;
      if (stretchToFill) {
        const s = targetSpan / span;
        obj.scale[axis] *= s;
        const mid = (minV + maxV) / 2;
        obj.position[axis] -= mid * s;
        return;
      }
      if (minV >= -half - tol && maxV <= half + tol) return;
      if (span <= targetSpan + tol) {
        if (minV < -half) {
          obj.position[axis] += -half - minV;
        } else if (maxV > half) {
          obj.position[axis] += half - maxV;
        }
      } else {
        const s = targetSpan / span;
        obj.scale[axis] *= s;
        const mid = (minV + maxV) / 2;
        obj.position[axis] -= mid * s;
      }
    };
    adjustAxis('x', pw);
    adjustAxis('y', ph);
    adjustAxis('z', pd);
  }
  return wrapper;
}

function makeMat(part: FurniturePart, ctx: Furniture3DBuildContext, override?: Partial<ArchitecturalMaterialOptions>) {
  return buildArchitecturalMaterial(part.material, part.color, {
    ...ctx.matOpts,
    roughness: part.roughness ?? override?.roughness,
    metalness: part.metalness ?? override?.metalness,
    ...override,
  });
}

function addMesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  castShadows: boolean,
  edgeMat?: THREE.LineBasicMaterial
): THREE.Mesh {
  const stdMat = mat as THREE.MeshStandardMaterial;
  const isClampedArtOrRug =
    stdMat.map && stdMat.map.wrapS === THREE.ClampToEdgeWrapping;
  if (!isClampedArtOrRug) {
    meshUvSeedSeq = (meshUvSeedSeq + 1) % 10000;
    applyWorldSpaceUVs(geo, 1.0, meshUvSeedSeq, true);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = castShadows;
  mesh.receiveShadow = castShadows;
  if (edgeMat) {
    const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 32), edgeMat);
    edgeLines.raycast = () => undefined;
    mesh.add(edgeLines);
  }
  parent.add(mesh);
  return mesh;
}

function buildPlanterPotGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.08, part.widthMm / 1000);
  const pd = Math.max(0.08, part.depthMm / 1000);
  const ph = Math.max(0.08, part.heightMm / 1000);
  const r = pw / 2;

  const potColor = part.color === '#FFFFFF' ? '#F8FAFC' : part.color;
  const potMat = buildArchitecturalMaterial(part.material, potColor, {
    ...ctx.matOpts,
    roughness: part.material === 'tile' ? 0.24 : 0.62,
    clearcoat: part.material === 'tile' ? 0.45 : 0.08,
  });

  // Lathe tapered planter silhouette with rolled top lip strictly inside [0..r]
  const pts = [
    new THREE.Vector2(0.001, -ph / 2),
    new THREE.Vector2(r * 0.7, -ph / 2),
    new THREE.Vector2(r * 0.84, -ph * 0.15),
    new THREE.Vector2(r * 0.96, ph * 0.38),
    new THREE.Vector2(r, ph * 0.44),
    new THREE.Vector2(r, ph / 2),
    new THREE.Vector2(r * 0.88, ph / 2),
    new THREE.Vector2(r * 0.84, ph * 0.36),
  ];
  const potGeo = new THREE.LatheGeometry(pts, 28);
  if (Math.abs(pd - pw) > 0.004) potGeo.scale(1, 1, pd / pw);
  addMesh(g, potGeo, potMat, ctx.castShadows);

  // Dark rich potting soil disc inside top rim
  const soilMat = new THREE.MeshStandardMaterial({
    color: 0x3b2a1e,
    roughness: 0.96,
    metalness: 0,
    clippingPlanes: ctx.clippingPlanes,
  });
  const soilGeo = new THREE.CylinderGeometry(r * 0.86, r * 0.86, 0.02, 24);
  if (Math.abs(pd - pw) > 0.004) soilGeo.scale(1, 1, pd / pw);
  const soil = new THREE.Mesh(soilGeo, soilMat);
  soil.position.y = ph * 0.41;
  soil.receiveShadow = ctx.castShadows;
  g.add(soil);

  return g;
}

function createLeafBladeGeometry(length: number, width: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(width * 0.65, length * 0.25, width * 0.55, length * 0.78, 0, length);
  s.bezierCurveTo(-width * 0.55, length * 0.78, -width * 0.65, length * 0.25, 0, 0);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.006,
    bevelEnabled: false,
    curveSegments: 8,
  });
  geo.rotateX(Math.PI / 2);
  // Gentle natural droop along blade length
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, z / Math.max(0.01, length)));
    pos.setY(i, pos.getY(i) + Math.sin(t * Math.PI) * length * 0.14 - t * t * length * 0.12);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function buildBotanicalFoliageGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.16, part.widthMm / 1000);
  const ph = Math.max(0.16, part.heightMm / 1000);
  const r = pw / 2;
  const ds = part.detailStyle;

  const baseHex =
    part.color && part.color !== '#FFFFFF'
      ? part.color
      : ds === 'leaves_olive'
        ? '#5F775A'
        : ds === 'leaves_palm'
          ? '#2F6F44'
          : '#3B7A4A';
  const baseCol = new THREE.Color(baseHex);
  const lighterCol = baseCol.clone().offsetHSL(0.01, 0.05, 0.07);
  const darkerCol = baseCol.clone().offsetHSL(-0.01, 0.03, -0.06);

  const makeLeafMat = (c: THREE.Color) =>
    buildArchitecturalMaterial('paint', `#${c.getHexString()}`, {
      ...ctx.matOpts,
      roughness: 0.44,
      clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.18,
    });

  const leafMats = [makeLeafMat(baseCol), makeLeafMat(lighterCol), makeLeafMat(darkerCol)];
  const stemMat = new THREE.MeshStandardMaterial({
    color: ds === 'leaves_olive' ? 0x6b5b4b : 0x3b6639,
    roughness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });

  if (ds === 'leaves_olive') {
    // Airy branched olive canopy clusters + woody forked shoots
    const branchCount = 4;
    for (let b = 0; b < branchCount; b++) {
      const ang = (b / branchCount) * Math.PI * 2 + 0.35;
      const spread = r * 0.52;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -ph * 0.5, 0),
        new THREE.Vector3(Math.cos(ang) * spread * 0.45, -ph * 0.1, Math.sin(ang) * spread * 0.45),
        new THREE.Vector3(Math.cos(ang) * spread, ph * 0.25, Math.sin(ang) * spread),
      ]);
      addMesh(g, new THREE.TubeGeometry(curve, 8, 0.011, 7, false), stemMat, ctx.castShadows);

      // 3 foliage puffs per branch
      for (let k = 0; k < 3; k++) {
        const subAng = ang + (k - 1) * 0.65;
        const distOut = spread * (0.65 + k * 0.18);
        const clusterGeo = new THREE.IcosahedronGeometry(r * (0.28 + (k % 2) * 0.06), 1);
        clusterGeo.scale(1.15, 0.72, 1.05);
        const cluster = new THREE.Mesh(clusterGeo, leafMats[(b + k) % 3]);
        cluster.position.set(
          Math.cos(subAng) * distOut,
          ph * (0.05 + k * 0.15) - ph * 0.05,
          Math.sin(subAng) * distOut
        );
        cluster.rotation.set(0.2 * k, subAng, 0.15);
        cluster.castShadow = ctx.castShadows;
        cluster.receiveShadow = ctx.castShadows;
        g.add(cluster);
      }
    }
    const crownGeo = new THREE.IcosahedronGeometry(r * 0.36, 1);
    crownGeo.scale(1.1, 0.78, 1.1);
    const crown = new THREE.Mesh(crownGeo, leafMats[1]);
    crown.position.y = ph * 0.28;
    crown.castShadow = ctx.castShadows;
    g.add(crown);
    return g;
  }

  // Fiddle leaf / Monstera radiating arched stems + sculpted leaves
  const leafCount = ds === 'leaves_palm' ? 11 : 13;
  const bladeLen = ds === 'leaves_palm' ? r * 0.78 : r * 0.58;
  const bladeWid = ds === 'leaves_palm' ? r * 0.42 : r * 0.36;
  const leafGeo = createLeafBladeGeometry(bladeLen, bladeWid);

  for (let i = 0; i < leafCount; i++) {
    const goldenAngle = i * 2.39996;
    const tier = i / leafCount; // 0 bottom outer -> 1 upper inner
    const reach = r * (0.28 + (1 - tier) * 0.36);
    const tipY = -ph * 0.22 + tier * ph * 0.62;

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -ph * 0.45, 0),
      new THREE.Vector3(Math.cos(goldenAngle) * reach * 0.35, -ph * 0.15 + tier * ph * 0.32, Math.sin(goldenAngle) * reach * 0.35),
      new THREE.Vector3(Math.cos(goldenAngle) * reach, tipY, Math.sin(goldenAngle) * reach),
    ]);
    addMesh(g, new THREE.TubeGeometry(curve, 8, 0.008, 6, false), stemMat, ctx.castShadows);

    const leaf = new THREE.Mesh(leafGeo, leafMats[i % 3]);
    leaf.position.set(Math.cos(goldenAngle) * reach * 0.85, tipY, Math.sin(goldenAngle) * reach * 0.85);
    leaf.rotation.y = -goldenAngle + Math.PI / 2;
    leaf.rotation.x = 0.22 + (1 - tier) * 0.35;
    leaf.scale.setScalar(0.82 + (i % 3) * 0.14);
    leaf.castShadow = ctx.castShadows;
    leaf.receiveShadow = ctx.castShadows;
    g.add(leaf);
  }
  return g;
}

function buildVaseGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.06, part.widthMm / 1000);
  const ph = Math.max(0.1, part.heightMm / 1000);
  const r = pw / 2;

  const vaseColor = part.color === '#FFFFFF' ? '#F8FAFC' : part.color;
  const vaseMat = buildArchitecturalMaterial(part.material, vaseColor, {
    ...ctx.matOpts,
    roughness: 0.2,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.68,
  });

  // Sculpted Lathe ceramic amphora vase (scaled vertically to leave headroom for sprigs inside [-ph/2, ph/2])
  const pts = [
    new THREE.Vector2(0.001, -ph / 2),
    new THREE.Vector2(r * 0.56, -ph / 2),
    new THREE.Vector2(r, -ph * 0.2),
    new THREE.Vector2(r * 0.92, 0),
    new THREE.Vector2(r * 0.38, ph * 0.16),
    new THREE.Vector2(r * 0.46, ph * 0.26),
    new THREE.Vector2(r * 0.32, ph * 0.26),
    new THREE.Vector2(r * 0.28, ph * 0.08),
  ];
  addMesh(g, new THREE.LatheGeometry(pts, 28), vaseMat, ctx.castShadows);

  // Subtle botanical sprigs emerging from vase neck inside [-ph/2, ph/2]
  const twigMat = new THREE.MeshStandardMaterial({
    color: 0x6b705c,
    roughness: 0.78,
    clippingPlanes: ctx.clippingPlanes,
  });
  const budMat = new THREE.MeshStandardMaterial({
    color: 0xd6ccc2,
    roughness: 0.92,
    clippingPlanes: ctx.clippingPlanes,
  });
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2 + 0.4;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, ph * 0.08, 0),
      new THREE.Vector3(Math.cos(ang) * r * 0.3, ph * 0.28, Math.sin(ang) * r * 0.3),
      new THREE.Vector3(Math.cos(ang) * r * 0.72, ph * (0.4 + i * 0.03), Math.sin(ang) * r * 0.72),
    ]);
    addMesh(g, new THREE.TubeGeometry(curve, 6, 0.004, 5, false), twigMat, ctx.castShadows);
    const tip = curve.getPoint(1);
    const bud = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 8), budMat);
    bud.scale.set(0.7, 1.3, 0.7);
    bud.position.copy(tip);
    g.add(bud);
  }
  return g;
}

function buildLampBaseGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.08, part.widthMm / 1000);
  const ph = Math.max(0.1, part.heightMm / 1000);
  const r = pw / 2;

  const baseColor = part.color === '#FFFFFF' ? '#F8FAFC' : part.color;
  const mat = buildArchitecturalMaterial(part.material, baseColor, {
    ...ctx.matOpts,
    roughness: 0.22,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.62,
  });

  // Sculpted ceramic gourd / urn table lamp base without stems
  const pts = [
    new THREE.Vector2(0.001, -ph / 2),
    new THREE.Vector2(r * 0.68, -ph / 2),
    new THREE.Vector2(r * 0.98, -ph * 0.14),
    new THREE.Vector2(r * 0.94, ph * 0.16),
    new THREE.Vector2(r * 0.42, ph * 0.42),
    new THREE.Vector2(r * 0.48, ph / 2),
    new THREE.Vector2(0.001, ph / 2),
  ];
  addMesh(g, new THREE.LatheGeometry(pts, 24), mat, ctx.castShadows);
  return g;
}

function buildBasinGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.16, part.widthMm / 1000);
  const pd = Math.max(0.16, part.depthMm / 1000);
  const ph = Math.max(0.025, part.heightMm / 1000);
  const outerMat = makeMat(part, ctx, {
    roughness: part.material === 'metal' ? 0.22 : 0.18,
    metalness: part.material === 'metal' ? 0.85 : 0.04,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : part.material === 'tile' ? 0.65 : 0.15,
  });
  const wellMat = new THREE.MeshStandardMaterial({
    color: part.material === 'metal' ? 0x64748b : 0xe2e8f0,
    roughness: 0.28,
    metalness: part.material === 'metal' ? 0.78 : 0.02,
    clippingPlanes: ctx.clippingPlanes,
  });
  const drainMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.25,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });

  const rimThickness = Math.min(pw, pd) * 0.09;
  const outerShape =
    part.shape === 'oval'
      ? ovalShape(pw, pd)
      : roundedRectShape(pw, pd, Math.min(pw, pd) * 0.16);
  const innerW = Math.max(0.08, pw - rimThickness * 2);
  const innerD = Math.max(0.08, pd - rimThickness * 2);
  const holePath =
    part.shape === 'oval'
      ? ovalShape(innerW, innerD)
      : roundedRectShape(innerW, innerD, Math.min(innerW, innerD) * 0.14);
  outerShape.holes.push(holePath);

  const rimMesh = addMesh(
    g,
    createExtrudedCentered(outerShape, ph, 0.004, 0.004, 2),
    outerMat,
    ctx.castShadows
  );
  rimMesh.position.y = 0;

  // Lower recessed basin floor + chrome drain strainer
  const floorH = Math.max(0.01, ph * 0.25);
  const floorShape =
    part.shape === 'oval'
      ? ovalShape(innerW * 1.02, innerD * 1.02)
      : roundedRectShape(innerW * 1.02, innerD * 1.02, Math.min(innerW, innerD) * 0.12);
  const floorMesh = addMesh(g, createExtrudedCentered(floorShape, floorH), wellMat, ctx.castShadows);
  floorMesh.position.y = -ph * 0.5 + floorH * 0.5;

  const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.006, 16), drainMat);
  drain.position.set(0, -ph * 0.5 + floorH + 0.002, -pd * 0.1);
  g.add(drain);
  return g;
}

function buildBathtubGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.8, part.widthMm / 1000);
  const pd = Math.max(0.55, part.depthMm / 1000);
  const ph = Math.max(0.35, part.heightMm / 1000);
  const shellMat = makeMat(part, ctx, {
    roughness: 0.16,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.72,
  });
  const wellMat = new THREE.MeshStandardMaterial({
    color: 0xf1f5f9,
    roughness: 0.2,
    clippingPlanes: ctx.clippingPlanes,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.18,
    metalness: 0.92,
    clippingPlanes: ctx.clippingPlanes,
  });

  const rimW = 0.085;
  const outerShape =
    part.shape === 'oval'
      ? ovalShape(pw, pd)
      : roundedRectShape(pw, pd, Math.min(pw, pd) * 0.16);
  const innerW = pw - rimW * 2;
  const innerD = pd - rimW * 2;
  const holeShape =
    part.shape === 'oval'
      ? ovalShape(innerW, innerD)
      : roundedRectShape(innerW, innerD, Math.min(innerW, innerD) * 0.22);
  outerShape.holes.push(holeShape);

  // Hollow sculpted tub rim & walls
  addMesh(g, createExtrudedCentered(outerShape, ph, 0.012, 0.01, 2), shellMat, ctx.castShadows);

  // Inner tub floor + sloped backrest pillow ledge + chrome drain
  const floorShape =
    part.shape === 'oval'
      ? ovalShape(innerW * 1.02, innerD * 1.02)
      : roundedRectShape(innerW * 1.02, innerD * 1.02, Math.min(innerW, innerD) * 0.2);
  const floor = addMesh(g, createExtrudedCentered(floorShape, 0.09), wellMat, ctx.castShadows);
  floor.position.y = -ph * 0.5 + 0.045;

  const slope = new THREE.Mesh(new THREE.BoxGeometry(innerW * 0.16, ph * 0.58, innerD * 0.72), wellMat);
  slope.position.set(-innerW * 0.42, -ph * 0.12, 0);
  slope.rotation.z = -0.32;
  g.add(slope);

  const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.008, 16), chromeMat);
  drain.position.set(innerW * 0.34, -ph * 0.5 + 0.092, 0);
  g.add(drain);
  return g;
}

function buildToiletBowlGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.24, part.widthMm / 1000);
  const pd = Math.max(0.32, part.depthMm / 1000);
  const ph = Math.max(0.05, part.heightMm / 1000);
  const ceramicMat = makeMat(part, ctx, {
    roughness: 0.14,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.78,
  });
  const seatMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.22,
    clippingPlanes: ctx.clippingPlanes,
  });
  const bowlWaterMat = new THREE.MeshPhysicalMaterial({
    color: 0xbae6fd,
    roughness: 0.06,
    transparent: true,
    opacity: 0.65,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Outer hollow bowl rim (top inset by seat height so seat ring stays within [-ph/2, ph/2])
  const seatH = Math.min(0.022, ph * 0.3);
  const rimH = Math.max(0.02, ph - seatH);
  const outer = ovalShape(pw, pd);
  outer.holes.push(ovalShape(pw * 0.62, pd * 0.58));
  const rimMesh = addMesh(
    g,
    createExtrudedCentered(outer, rimH, 0.006, 0.005, 2, { pw, ph: rimH, pd }),
    ceramicMat,
    ctx.castShadows
  );
  rimMesh.position.y = -ph * 0.5 + rimH * 0.5;

  // Contoured seat ring atop bowl flush at +ph/2
  const seat = ovalShape(pw * 0.94, pd * 0.9);
  seat.holes.push(ovalShape(pw * 0.58, pd * 0.54));
  const seatMesh = addMesh(
    g,
    createExtrudedCentered(seat, seatH, 0.004, 0.003, 2, { pw: pw * 0.94, ph: seatH, pd: pd * 0.9 }),
    seatMat,
    ctx.castShadows
  );
  seatMesh.position.y = ph * 0.5 - seatH * 0.5;

  // Inner ceramic bottom & water disc
  const well = addMesh(g, createExtrudedCentered(ovalShape(pw * 0.64, pd * 0.6), ph * 0.3), ceramicMat, ctx.castShadows);
  well.position.y = -ph * 0.35;
  const water = new THREE.Mesh(new THREE.CylinderGeometry(pw * 0.22, pw * 0.18, 0.012, 18), bowlWaterMat);
  water.position.y = -ph * 0.18;
  g.add(water);
  return g;
}

function buildBowlGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.1, part.widthMm / 1000);
  const ph = Math.max(0.05, part.heightMm / 1000);
  const r = pw / 2;

  const bowlMat = makeMat(part, ctx, {
    roughness: 0.25,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.45,
  });
  const pts = [
    new THREE.Vector2(0.001, -ph / 2),
    new THREE.Vector2(r * 0.45, -ph / 2),
    new THREE.Vector2(r * 0.5, -ph * 0.32),
    new THREE.Vector2(r * 0.98, ph * 0.3),
    new THREE.Vector2(r, ph / 2),
    new THREE.Vector2(r * 0.9, ph / 2),
    new THREE.Vector2(r * 0.42, -ph * 0.18),
    new THREE.Vector2(0.001, -ph * 0.22),
  ];
  addMesh(g, new THREE.LatheGeometry(pts, 24), bowlMat, ctx.castShadows);

  // Decorative ceramic/organic orbs inside bowl
  const accentColors = [0xd4a373, 0x9c6644, 0x588157];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.22, 14, 12),
      new THREE.MeshStandardMaterial({
        color: accentColors[i],
        roughness: 0.55,
        clippingPlanes: ctx.clippingPlanes,
      })
    );
    orb.position.set(Math.cos(a) * r * 0.28, ph * 0.08, Math.sin(a) * r * 0.28);
    orb.castShadow = ctx.castShadows;
    g.add(orb);
  }
  return g;
}

function buildBooksGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.12, part.widthMm / 1000);
  const pd = Math.max(0.1, part.depthMm / 1000);
  const ph = Math.max(0.04, part.heightMm / 1000);

  const spinePalette = ['#1E3A5F', '#9A3412', '#3F6212', '#475569', '#854D0E', '#6B21A8'];
  const pageMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });

  const isHorizontalStack = pw > ph * 1.4 && ph < 0.16;
  if (isHorizontalStack) {
    const count = 3;
    const bookH = ph / count;
    for (let i = 0; i < count; i++) {
      const shrink = 1 - i * 0.1;
      const coverColor = i === 0 && part.color !== '#FFFFFF' ? part.color : spinePalette[i % spinePalette.length];
      const coverMat = new THREE.MeshStandardMaterial({
        color: coverColor,
        roughness: 0.72,
        clippingPlanes: ctx.clippingPlanes,
      });
      const yPos = -ph / 2 + (i + 0.5) * bookH;
      const bw = pw * shrink;
      const bd = pd * shrink;
      const pageMesh = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.94, bookH * 0.72, bd * 0.94), pageMat);
      pageMesh.position.set(0, yPos, 0);
      pageMesh.castShadow = ctx.castShadows;
      const coverTop = new THREE.Mesh(new THREE.BoxGeometry(bw, bookH * 0.15, bd), coverMat);
      coverTop.position.set(0, yPos + bookH * 0.4, 0);
      coverTop.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.05;
      const coverBot = new THREE.Mesh(new THREE.BoxGeometry(bw, bookH * 0.15, bd), coverMat);
      coverBot.position.set(0, yPos - bookH * 0.4, 0);
      g.add(pageMesh, coverTop, coverBot);
    }
    return g;
  }

  // Row of upright varied books for bookcases & sideboards
  const count = Math.max(4, Math.min(12, Math.floor(pw / 0.036)));
  const slotW = pw / count;
  for (let i = 0; i < count; i++) {
    const bThick = slotW * (0.76 + (i % 3) * 0.06);
    const bHeight = ph * (0.72 + ((i * 7) % 5) * 0.065);
    const bDepth = pd * (0.82 + (i % 2) * 0.1);
    const col = spinePalette[(i * 5 + Math.round(pw * 100)) % spinePalette.length];
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.68,
      clippingPlanes: ctx.clippingPlanes,
    });
    const bx = -pw / 2 + (i + 0.5) * slotW;
    const by = -ph / 2 + bHeight / 2;
    const book = new THREE.Mesh(new THREE.BoxGeometry(bThick, bHeight, bDepth), mat);
    book.position.set(bx, by, 0);
    if (i === count - 1 && count > 5) {
      book.rotation.z = 0.16;
      book.position.x -= bThick * 0.35;
    }
    book.castShadow = ctx.castShadows;
    book.receiveShadow = ctx.castShadows;
    g.add(book);
  }
  return g;
}

function buildCandleTrayGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.16, part.widthMm / 1000);
  const pd = Math.max(0.16, part.depthMm / 1000);
  const ph = Math.max(0.06, part.heightMm / 1000);

  const trayColor = part.color === '#FFFFFF' ? '#F8FAFC' : part.color;
  const trayMat = buildArchitecturalMaterial('paint', trayColor, {
    ...ctx.matOpts,
    roughness: 0.32,
  });
  const trayH = 0.022;
  const trayMesh = new THREE.Mesh(
    createExtrudedCentered(roundedRectShape(pw, pd, Math.min(pw, pd) * 0.18), trayH, 0.004, 0.004, 2),
    trayMat
  );
  trayMesh.position.y = -ph / 2 + trayH / 2;
  trayMesh.castShadow = ctx.castShadows;
  trayMesh.receiveShadow = ctx.castShadows;
  g.add(trayMesh);

  // Pillar candles + tiny warm glowing wicks
  const waxMat = new THREE.MeshStandardMaterial({
    color: 0xfaf5ee,
    roughness: 0.65,
    clippingPlanes: ctx.clippingPlanes,
  });
  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xfde68a,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.95,
    clippingPlanes: ctx.clippingPlanes,
  });
  const specs = [
    { x: -pw * 0.2, z: -pd * 0.1, h: ph * 0.86, r: Math.min(pw, pd) * 0.12 },
    { x: pw * 0.12, z: pd * 0.12, h: ph * 0.62, r: Math.min(pw, pd) * 0.11 },
    { x: pw * 0.24, z: -pd * 0.18, h: ph * 0.45, r: Math.min(pw, pd) * 0.095 },
  ];
  for (const c of specs) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, c.h, 16), waxMat);
    body.position.set(c.x, -ph / 2 + trayH + c.h / 2, c.z);
    body.castShadow = ctx.castShadows;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(c.r * 0.28, 0.022, 8), flameMat);
    flame.position.set(c.x, -ph / 2 + trayH + c.h + 0.011, c.z);
    g.add(body, flame);
  }
  return g;
}

function buildFaucetGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const ph = Math.max(0.12, part.heightMm / 1000);
  const pd = Math.max(0.08, part.depthMm / 1000);
  const mat = makeMat(part, ctx, { roughness: 0.18, metalness: 0.92 });

  const baseZ = -pd * 0.32;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.032, 16), mat);
  base.position.set(0, -ph / 2 + 0.016, baseZ);
  g.add(base);

  // Curved gooseneck spout arcing forward strictly within [-pd/2, +pd/2]
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -ph / 2 + 0.02, baseZ),
    new THREE.Vector3(0, ph * 0.24, baseZ),
    new THREE.Vector3(0, ph * 0.46, pd * 0.14),
    new THREE.Vector3(0, ph * 0.22, pd * 0.44),
  ]);
  addMesh(g, new THREE.TubeGeometry(curve, 16, 0.01, 10, false), mat, ctx.castShadows);

  // Side mixer lever positioned within [-pw/2, +pw/2]
  const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.048, 8), mat);
  lever.rotation.z = Math.PI / 2;
  lever.position.set(0.026, -ph / 2 + 0.055, baseZ);
  g.add(lever);
  return g;
}

function buildCasterBaseGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.38, part.widthMm / 1000);
  const ph = Math.max(0.2, part.heightMm / 1000);
  const r = pw / 2;
  const chromeMat = makeMat(part, ctx, { roughness: 0.22, metalness: 0.88 });
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.82,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Pneumatic center column
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, ph, 16), chromeMat);
  col.castShadow = ctx.castShadows;
  g.add(col);

  // 5-star spoke legs + dual caster wheels
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const armLen = r * 0.88;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.022, armLen), chromeMat);
    arm.position.set(Math.sin(ang) * (armLen / 2), -ph / 2 + 0.065, Math.cos(ang) * (armLen / 2));
    arm.rotation.y = ang;
    arm.castShadow = ctx.castShadows;
    g.add(arm);

    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.036, 12), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.rotation.y = ang;
    wheel.position.set(Math.sin(ang) * armLen, -ph / 2 + 0.024, Math.cos(ang) * armLen);
    wheel.castShadow = ctx.castShadows;
    g.add(wheel);
  }
  const pd = Math.max(0.1, part.depthMm / 1000);
  if (Math.abs(pd - pw) > 0.001) {
    g.scale.z = pd / pw;
  }
  return g;
}

function buildTowelRailGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.3, part.widthMm / 1000);
  const ph = Math.max(0.6, part.heightMm / 1000);
  const metalMat = makeMat(part, ctx, { roughness: 0.2, metalness: 0.9 });
  const towelMat = buildArchitecturalMaterial('fabric', '#E2E8F0', {
    ...ctx.matOpts,
    roughness: 0.94,
  });

  // Vertical side rails
  for (const sx of [-pw / 2 + 0.02, pw / 2 - 0.02]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, ph, 12), metalMat);
    rail.position.set(sx, 0, 0);
    rail.castShadow = ctx.castShadows;
    g.add(rail);
  }

  // Horizontal rungs
  const rungCount = 6;
  for (let i = 0; i < rungCount; i++) {
    const y = -ph * 0.4 + (i / (rungCount - 1)) * ph * 0.82;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, pw - 0.04, 10), metalMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, y, 0);
    bar.castShadow = ctx.castShadows;
    g.add(bar);
  }

  // Draped folded bath towel
  const towel = new THREE.Mesh(
    createExtrudedCentered(roundedRectShape(pw * 0.56, 0.055, 0.02), ph * 0.34, 0.01, 0.01, 2),
    towelMat
  );
  towel.position.set(0, ph * 0.14, 0.015);
  towel.castShadow = ctx.castShadows;
  g.add(towel);
  return g;
}

function buildGasHobGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.3, part.widthMm / 1000);
  const pd = Math.max(0.3, part.depthMm / 1000);
  const ph = Math.max(0.03, part.heightMm / 1000);

  const deckMat = buildArchitecturalMaterial(part.material === 'glass' ? 'glass' : 'metal', part.color, {
    ...ctx.matOpts,
    roughness: part.material === 'glass' ? 0.1 : 0.28,
    metalness: part.material === 'glass' ? 0.1 : 0.78,
  });
  const ironMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.78,
    metalness: 0.45,
    clippingPlanes: ctx.clippingPlanes,
  });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.26,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Main beveled hob deck
  const deckGeo = createExtrudedCentered(roundedRectShape(pw, pd, 0.025), ph * 0.52, 0.004, 0.004, 2);
  const deckMesh = addMesh(g, deckGeo, deckMat, ctx.castShadows);
  deckMesh.position.y = -ph * 0.22;

  // 4 stepped gas burners + cast-iron grate crosses
  const burnerOffsets = [
    { x: -pw * 0.25, z: -pd * 0.2, r: Math.min(pw, pd) * 0.13 },
    { x: pw * 0.25, z: -pd * 0.2, r: Math.min(pw, pd) * 0.1 },
    { x: -pw * 0.25, z: pd * 0.18, r: Math.min(pw, pd) * 0.1 },
    { x: pw * 0.25, z: pd * 0.18, r: Math.min(pw, pd) * 0.12 },
  ];
  for (const b of burnerOffsets) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.72, b.r * 0.82, ph * 0.28, 18), brassMat);
    cup.position.set(b.x, ph * 0.08, b.z);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.85, b.r * 0.85, ph * 0.1, 18), ironMat);
    cap.position.set(b.x, ph * 0.24, b.z);
    g.add(cup, cap);

    // Intersecting cast-iron pan support bars
    const armW = pw * 0.38;
    const armD = pd * 0.36;
    const barX = new THREE.Mesh(new THREE.BoxGeometry(armW, 0.012, 0.014), ironMat);
    barX.position.set(b.x, ph * 0.36, b.z);
    const barZ = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, armD), ironMat);
    barZ.position.set(b.x, ph * 0.36, b.z);
    barX.castShadow = ctx.castShadows;
    barZ.castShadow = ctx.castShadows;
    g.add(barX, barZ);
  }

  // Front rotary control knobs
  for (let i = 0; i < 4; i++) {
    const kx = -pw * 0.3 + i * (pw * 0.2);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.018, 14), brassMat);
    knob.position.set(kx, ph * 0.14, pd * 0.42);
    g.add(knob);
  }
  return g;
}

function buildGlassHobGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  isInduction: boolean
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.3, part.widthMm / 1000);
  const pd = Math.max(0.3, part.depthMm / 1000);
  const ph = Math.max(0.025, part.heightMm / 1000);

  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.24,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0f172a,
    roughness: 0.08,
    metalness: 0.12,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.92,
    clearcoatRoughness: 0.06,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Outer brushed frame + beveled dark vitroceramic plate
  const frame = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw, pd, 0.02), ph * 0.72, 0.003, 0.003, 2),
    rimMat,
    ctx.castShadows
  );
  frame.position.y = -ph * 0.12;

  const glass = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw * 0.96, pd * 0.95, 0.016), ph * 0.5, 0.002, 0.002, 1),
    glassMat,
    ctx.castShadows
  );
  glass.position.y = ph * 0.18;

  // Etched / glowing heating zones
  const ringMat = new THREE.MeshStandardMaterial({
    color: isInduction ? 0x94a3b8 : 0xef4444,
    emissive: isInduction ? 0x1e293b : 0x991b1b,
    emissiveIntensity: isInduction ? 0.15 : 0.45,
    roughness: 0.35,
    clippingPlanes: ctx.clippingPlanes,
  });

  const zones = [
    { x: -pw * 0.24, z: -pd * 0.18, r: Math.min(pw, pd) * 0.16 },
    { x: pw * 0.24, z: -pd * 0.18, r: Math.min(pw, pd) * 0.13 },
    { x: -pw * 0.24, z: pd * 0.17, r: Math.min(pw, pd) * 0.13 },
    { x: pw * 0.24, z: pd * 0.17, r: Math.min(pw, pd) * 0.15 },
  ];
  for (const z of zones) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(z.r, 0.0035, 8, 28), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(z.x, ph * 0.44, z.z);
    g.add(ring);

    if (isInduction) {
      // Crosshair tick mark in center of induction zone
      const crossA = new THREE.Mesh(new THREE.BoxGeometry(z.r * 0.45, 0.002, 0.004), ringMat);
      crossA.position.set(z.x, ph * 0.44, z.z);
      const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.002, z.r * 0.45), ringMat);
      crossB.position.set(z.x, ph * 0.44, z.z);
      g.add(crossA, crossB);
    }
  }

  // Front capacitive touch slider strip
  const slider = new THREE.Mesh(
    new THREE.BoxGeometry(pw * 0.42, 0.003, 0.016),
    new THREE.MeshStandardMaterial({
      color: 0x64748b,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.22,
      clippingPlanes: ctx.clippingPlanes,
    })
  );
  slider.position.set(0, ph * 0.44, pd * 0.4);
  g.add(slider);
  return g;
}

function buildOvenMicrowaveGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  isMicrowave: boolean
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.28, part.widthMm / 1000);
  const isSlimDoorFront = part.depthMm <= 80;
  const pd = Math.max(0.016, part.depthMm / 1000);
  const ph = Math.max(0.2, part.heightMm / 1000);

  const stainlessMat = buildArchitecturalMaterial('metal', '#CBD5E1', {
    ...ctx.matOpts,
    roughness: 0.24,
    metalness: 0.85,
  });
  const darkFrameMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.35,
    metalness: 0.4,
    clippingPlanes: ctx.clippingPlanes,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x090d16,
    roughness: 0.08,
    metalness: 0.15,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.9,
    clippingPlanes: ctx.clippingPlanes,
  });

  if (!isSlimDoorFront) {
    // Full-depth appliance housing (e.g. countertop microwave)
    addMesh(g, new THREE.BoxGeometry(pw, ph, pd * 0.92), makeMat(part, ctx), ctx.castShadows);
  }

  const frontZ = isSlimDoorFront ? -pd * 0.008 : pd * 0.46;
  const bezelThick = isSlimDoorFront ? pd * 0.984 : 0.022;
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(isSlimDoorFront ? pw : pw * 0.98, isSlimDoorFront ? ph : ph * 0.96, bezelThick),
    stainlessMat
  );
  bezel.position.set(0, 0, frontZ);
  bezel.castShadow = ctx.castShadows;
  g.add(bezel);

  const faceFront = frontZ + bezelThick * 0.5;
  const maxDetailDepth = isSlimDoorFront ? Math.max(0.0004, pd * 0.016) : 0.032;
  const detailProtrude = isSlimDoorFront ? maxDetailDepth * 0.4 : 0.004;
  const handleRadius = isSlimDoorFront ? Math.min(0.0025, maxDetailDepth * 0.25) : 0.009;
  const handleOffset = isSlimDoorFront ? maxDetailDepth - handleRadius : 0.032;

  if (!isMicrowave) {
    const glassW = pw * 0.82;
    const glassH = ph * 0.58;
    const win = new THREE.Mesh(new THREE.BoxGeometry(glassW, glassH, detailProtrude * 2), glassMat);
    win.position.set(0, -ph * 0.08, faceFront + detailProtrude);
    g.add(win);

    // Chrome tubular handle bar across top of oven window
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(handleRadius, handleRadius, glassW * 0.9, 12), stainlessMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, ph * 0.24, faceFront + handleOffset);
    g.add(bar);
    for (const sx of [-glassW * 0.38, glassW * 0.38]) {
      const standLen = Math.max(0.0005, handleOffset);
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(handleRadius * 0.78, handleRadius * 0.78, standLen, 8), stainlessMat);
      stand.rotation.x = Math.PI / 2;
      stand.position.set(sx, ph * 0.24, faceFront + standLen * 0.5);
      g.add(stand);
    }

    // Top control strip with rotary dials & digital clock bar
    const panel = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.9, ph * 0.14, detailProtrude * 2), darkFrameMat);
    panel.position.set(0, ph * 0.38, faceFront + detailProtrude);
    g.add(panel);
    for (const kx of [-pw * 0.3, pw * 0.3]) {
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, handleOffset, 14), stainlessMat);
      dial.rotation.x = Math.PI / 2;
      dial.position.set(kx, ph * 0.38, faceFront + handleOffset * 0.5);
      g.add(dial);
    }
    const lcd = new THREE.Mesh(
      new THREE.BoxGeometry(pw * 0.24, ph * 0.06, detailProtrude * 1.4),
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.4,
        clippingPlanes: ctx.clippingPlanes,
      })
    );
    lcd.position.set(0, ph * 0.38, faceFront + detailProtrude * 1.5);
    g.add(lcd);
  } else {
    // Microwave: left smoked glass window + right touchpad/dial strip
    const winW = pw * 0.64;
    const winH = ph * 0.74;
    const win = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, detailProtrude * 2), glassMat);
    win.position.set(-pw * 0.12, 0, faceFront + detailProtrude);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.22, winH, detailProtrude * 2), darkFrameMat);
    pad.position.set(pw * 0.34, 0, faceFront + detailProtrude);
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(pw * 0.14, ph * 0.12, detailProtrude * 1.4),
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.45,
        clippingPlanes: ctx.clippingPlanes,
      })
    );
    led.position.set(pw * 0.34, ph * 0.2, faceFront + detailProtrude * 1.5);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(handleRadius, handleRadius, winH * 0.78, 10), stainlessMat);
    handle.position.set(pw * 0.17, 0, faceFront + handleOffset);
    g.add(win, pad, led, handle);
  }
  return g;
}

function buildFridgeGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.35, part.widthMm / 1000);
  const pd = Math.max(0.35, part.depthMm / 1000);
  const ph = Math.max(0.7, part.heightMm / 1000);
  const ds = part.detailStyle;

  const bodyMat = makeMat(part, ctx, { roughness: 0.26, metalness: part.material === 'metal' ? 0.85 : 0.12 });
  const handleMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.18,
    metalness: 0.92,
    clippingPlanes: ctx.clippingPlanes,
  });
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.65,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Main carcass slightly recessed behind front doors
  const carcassDepth = pd * 0.88;
  const carcass = addMesh(g, new THREE.BoxGeometry(pw, ph, carcassDepth), bodyMat, ctx.castShadows);
  carcass.position.z = -pd * 0.06;

  const doorThick = pd * 0.09;
  const doorZ = pd * 0.5 - doorThick * 0.5;
  const addVerticalHandle = (hx: number, hy: number, hLen: number) => {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, hLen, 12), handleMat);
    bar.position.set(hx, hy, doorZ + doorThick * 0.5 + 0.028);
    bar.castShadow = ctx.castShadows;
    g.add(bar);
    for (const sy of [hy - hLen * 0.36, hy + hLen * 0.36]) {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.028, 8), handleMat);
      stand.rotation.x = Math.PI / 2;
      stand.position.set(hx, sy, doorZ + doorThick * 0.5 + 0.014);
      g.add(stand);
    }
  };

  if (ds === 'wine_cooler') {
    // Frame door with dark transparent smoked glass + interior wooden shelves + wine bottles
    const frameThick = 0.045;
    const frameLeft = new THREE.Mesh(new THREE.BoxGeometry(frameThick, ph * 0.94, doorThick), seamMat);
    frameLeft.position.set(-pw / 2 + frameThick / 2, 0, doorZ);
    const frameRight = new THREE.Mesh(new THREE.BoxGeometry(frameThick, ph * 0.94, doorThick), seamMat);
    frameRight.position.set(pw / 2 - frameThick / 2, 0, doorZ);
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.96, frameThick, doorThick), seamMat);
    frameTop.position.set(0, ph * 0.47 - frameThick / 2, doorZ);
    const frameBot = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.96, frameThick, doorThick), seamMat);
    frameBot.position.set(0, -ph * 0.47 + frameThick / 2, doorZ);
    g.add(frameLeft, frameRight, frameTop, frameBot);

    const shelfMat = new THREE.MeshStandardMaterial({ color: 0xc2956e, roughness: 0.65, clippingPlanes: ctx.clippingPlanes });
    const bottleMat = new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.25, clippingPlanes: ctx.clippingPlanes });
    const shelves = Math.max(4, Math.round(ph / 0.18));
    for (let s = 0; s < shelves; s++) {
      const sy = -ph * 0.34 + (s / Math.max(1, shelves - 1)) * ph * 0.68;
      const rack = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.82, 0.012, pd * 0.66), shelfMat);
      rack.position.set(0, sy, -0.02);
      g.add(rack);
      const bCount = Math.max(3, Math.floor(pw / 0.11));
      for (let b = 0; b < bCount; b++) {
        const bx = -pw * 0.34 + (b / Math.max(1, bCount - 1)) * pw * 0.68;
        const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, pd * 0.42, 10), bottleMat);
        bottle.rotation.x = Math.PI / 2;
        bottle.position.set(bx, sy + 0.036, -0.02);
        g.add(bottle);
      }
    }

    const glassPane = new THREE.Mesh(
      new THREE.BoxGeometry(pw - frameThick * 2, ph * 0.94 - frameThick * 2, 0.01),
      new THREE.MeshPhysicalMaterial({
        color: 0x0f172a,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        roughness: 0.08,
        clearcoat: 0.9,
        clippingPlanes: ctx.clippingPlanes,
      })
    );
    glassPane.position.set(0, 0, doorZ);
    glassPane.renderOrder = 12;
    g.add(glassPane);
    addVerticalHandle(pw * 0.42, 0, ph * 0.56);
    return g;
  }

  if (ds === 'fridge_side_by_side') {
    const leftW = pw * 0.41;
    const rightW = pw * 0.57;
    const leftDoor = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(leftW, doorThick, 0.008), ph * 0.96, 0.003, 0.003, 1),
      bodyMat,
      ctx.castShadows
    );
    leftDoor.position.set(-pw * 0.5 + leftW * 0.5 + 0.004, 0, doorZ);
    const rightDoor = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(rightW, doorThick, 0.008), ph * 0.96, 0.003, 0.003, 1),
      bodyMat,
      ctx.castShadows
    );
    rightDoor.position.set(pw * 0.5 - rightW * 0.5 - 0.004, 0, doorZ);

    // Water & ice dispenser alcove on left door
    const alcove = new THREE.Mesh(new THREE.BoxGeometry(leftW * 0.54, ph * 0.18, 0.022), seamMat);
    alcove.position.set(-pw * 0.5 + leftW * 0.5, ph * 0.12, doorZ + doorThick * 0.42);
    g.add(alcove);

    addVerticalHandle(-pw * 0.5 + leftW - 0.04, 0.04, ph * 0.54);
    addVerticalHandle(pw * 0.5 - rightW + 0.04, 0.04, ph * 0.54);
    return g;
  }

  if (ds === 'fridge_french') {
    const upperH = ph * 0.62;
    const lowerH = ph * 0.34;
    const halfW = pw * 0.492;
    for (const side of [-1, 1]) {
      const topDoor = addMesh(
        g,
        createExtrudedCentered(roundedRectShape(halfW, doorThick, 0.008), upperH, 0.003, 0.003, 1),
        bodyMat,
        ctx.castShadows
      );
      topDoor.position.set(side * (pw * 0.25), ph * 0.5 - upperH * 0.5 - 0.008, doorZ);
      addVerticalHandle(side * 0.045, ph * 0.5 - upperH * 0.5, upperH * 0.68);
    }
    // Lower pull-out freezer drawer + horizontal bar handle
    const drawer = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(pw * 0.985, doorThick, 0.008), lowerH, 0.003, 0.003, 1),
      bodyMat,
      ctx.castShadows
    );
    drawer.position.set(0, -ph * 0.5 + lowerH * 0.5 + 0.008, doorZ);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, pw * 0.72, 12), handleMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, -ph * 0.5 + lowerH * 0.78, doorZ + doorThick * 0.5 + 0.026);
    g.add(bar);
    return g;
  }

  if (ds === 'fridge_double') {
    const topH = ph * 0.3;
    const botH = ph * 0.66;
    const topDoor = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(pw * 0.985, doorThick, 0.008), topH, 0.003, 0.003, 1),
      bodyMat,
      ctx.castShadows
    );
    topDoor.position.set(0, ph * 0.5 - topH * 0.5 - 0.006, doorZ);
    const botDoor = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(pw * 0.985, doorThick, 0.008), botH, 0.003, 0.003, 1),
      bodyMat,
      ctx.castShadows
    );
    botDoor.position.set(0, -ph * 0.5 + botH * 0.5 + 0.006, doorZ);
    addVerticalHandle(-pw * 0.42, ph * 0.5 - topH * 0.5, topH * 0.65);
    addVerticalHandle(-pw * 0.42, -ph * 0.5 + botH * 0.55, botH * 0.52);
    return g;
  }

  // fridge_single
  const sDoor = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw * 0.985, doorThick, 0.008), ph * 0.96, 0.003, 0.003, 1),
    bodyMat,
    ctx.castShadows
  );
  sDoor.position.set(0, 0, doorZ);
  addVerticalHandle(-pw * 0.42, 0.06, ph * 0.48);
  return g;
}

function buildLaundryDrumGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  isDryer: boolean
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.4, part.widthMm / 1000);
  const pd = Math.max(0.4, part.depthMm / 1000);
  const ph = Math.max(0.6, part.heightMm / 1000);

  const bodyMat = makeMat(part, ctx, { roughness: 0.34, metalness: 0.08 });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: isDryer ? 0x334155 : 0xe2e8f0,
    roughness: 0.2,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0f172a,
    roughness: 0.08,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.9,
    clippingPlanes: ctx.clippingPlanes,
  });

  addMesh(g, new THREE.BoxGeometry(pw, ph, pd * 0.94), bodyMat, ctx.castShadows);
  const frontZ = pd * 0.47;

  // Circular chrome porthole bezel + smoked glass dome
  const drumR = Math.min(pw, ph) * 0.27;
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(drumR, drumR * 0.14, 14, 28), chromeMat);
  bezel.position.set(0, -ph * 0.06, frontZ + 0.015);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(drumR * 0.92, drumR * 0.92, 0.018, 24), glassMat);
  glass.rotation.x = Math.PI / 2;
  glass.position.set(0, -ph * 0.06, frontZ + 0.012);
  g.add(bezel, glass);

  // Detergent/condenser drawer seam + central program selector dial + LED display
  const drawer = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.28, ph * 0.1, 0.014), bodyMat);
  drawer.position.set(-pw * 0.3, ph * 0.39, frontZ + 0.008);
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.026, 0.02, 16), chromeMat);
  dial.rotation.x = Math.PI / 2;
  dial.position.set(0, ph * 0.39, frontZ + 0.014);
  const display = new THREE.Mesh(
    new THREE.BoxGeometry(pw * 0.22, ph * 0.07, 0.008),
    new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.38,
      clippingPlanes: ctx.clippingPlanes,
    })
  );
  display.position.set(pw * 0.28, ph * 0.39, frontZ + 0.01);
  g.add(drawer, dial, display);
  return g;
}

function buildDishwasherGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.42, part.widthMm / 1000);
  const pd = Math.max(0.45, part.depthMm / 1000);
  const ph = Math.max(0.7, part.heightMm / 1000);

  const bodyMat = makeMat(part, ctx, { roughness: 0.26, metalness: part.material === 'metal' ? 0.84 : 0.12 });
  const steelMat = buildArchitecturalMaterial('metal', '#CBD5E1', {
    ...ctx.matOpts,
    roughness: 0.22,
    metalness: 0.88,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.4,
    metalness: 0.35,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Recessed toe-kick plinth + upper appliance carcass
  const kickH = ph * 0.11;
  const kick = addMesh(g, new THREE.BoxGeometry(pw * 0.98, kickH, pd * 0.86), darkMat, ctx.castShadows);
  kick.position.set(0, -ph * 0.5 + kickH * 0.5, -pd * 0.04);

  const mainH = ph - kickH;
  const carcass = addMesh(g, new THREE.BoxGeometry(pw, mainH, pd * 0.92), bodyMat, ctx.castShadows);
  carcass.position.set(0, -ph * 0.5 + kickH + mainH * 0.5, -pd * 0.04);

  // Chamfered stainless front door + top control facia + LED timer + tubular handle
  const frontZ = pd * 0.44;
  const doorH = mainH * 0.84;
  const door = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw * 0.97, 0.026, 0.008), doorH, 0.003, 0.003, 1),
    steelMat,
    ctx.castShadows
  );
  door.position.set(0, -ph * 0.5 + kickH + doorH * 0.5 + 0.008, frontZ);

  const faciaH = mainH * 0.12;
  const facia = addMesh(
    g,
    new THREE.BoxGeometry(pw * 0.97, faciaH, 0.024),
    darkMat,
    ctx.castShadows
  );
  facia.position.set(0, ph * 0.5 - faciaH * 0.5 - 0.006, frontZ);

  const timer = new THREE.Mesh(
    new THREE.BoxGeometry(pw * 0.14, faciaH * 0.42, 0.006),
    new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.45,
      clippingPlanes: ctx.clippingPlanes,
    })
  );
  timer.position.set(0, ph * 0.5 - faciaH * 0.5 - 0.006, frontZ + 0.012);
  g.add(timer);

  // Stainless horizontal door handle bar
  const handleY = ph * 0.5 - faciaH - 0.048;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, pw * 0.72, 12), steelMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, handleY, frontZ + 0.036);
  g.add(bar);
  for (const hx of [-pw * 0.3, pw * 0.3]) {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.026, 8), steelMat);
    stand.rotation.x = Math.PI / 2;
    stand.position.set(hx, handleY, frontZ + 0.023);
    g.add(stand);
  }
  return g;
}

function buildTopLoadWasherGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.45, part.widthMm / 1000);
  const pd = Math.max(0.45, part.depthMm / 1000);
  const ph = Math.max(0.75, part.heightMm / 1000);

  const bodyMat = makeMat(part, ctx, { roughness: 0.34, metalness: 0.06 });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.2,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0f172a,
    roughness: 0.08,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.9,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    clippingPlanes: ctx.clippingPlanes,
  });
  const steelDrumMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.28,
    metalness: 0.85,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Main washer cabinet up to deck height
  const deckH = ph * 0.88;
  const cabinet = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw, pd, 0.024), deckH, 0.004, 0.004, 1),
    bodyMat,
    ctx.castShadows
  );
  cabinet.position.y = -ph * 0.5 + deckH * 0.5;

  // Raised rear backsplash control console
  const consoleH = ph - deckH;
  const consoleD = pd * 0.16;
  const backConsole = addMesh(
    g,
    new THREE.BoxGeometry(pw * 0.98, consoleH, consoleD),
    bodyMat,
    ctx.castShadows
  );
  backConsole.position.set(0, ph * 0.5 - consoleH * 0.5, -pd * 0.5 + consoleD * 0.5 + 0.01);

  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.018, 16), chromeMat);
  dial.rotation.x = Math.PI / 2;
  dial.position.set(0, ph * 0.5 - consoleH * 0.5, -pd * 0.5 + consoleD + 0.014);
  g.add(dial);

  // Top hinged smoked glass lid + visible stainless inner drum + chrome rim
  const lidY = -ph * 0.5 + deckH;
  const lidW = pw * 0.78;
  const lidD = pd * 0.64;
  const lidZ = pd * 0.06;
  const lidRim = new THREE.Mesh(new THREE.BoxGeometry(lidW, 0.014, lidD), chromeMat);
  lidRim.position.set(0, lidY + 0.005, lidZ);
  const lidGlass = new THREE.Mesh(new THREE.BoxGeometry(lidW * 0.88, 0.016, lidD * 0.84), glassMat);
  lidGlass.position.set(0, lidY + 0.008, lidZ);
  const drum = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.min(lidW, lidD) * 0.38, Math.min(lidW, lidD) * 0.34, 0.02, 22),
    steelDrumMat
  );
  drum.position.set(0, lidY - 0.012, lidZ);
  g.add(lidRim, lidGlass, drum);
  return g;
}

function buildWallTvGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.45, part.widthMm / 1000);
  const isSlimScreenOnly = part.depthMm <= 24;
  const pd = Math.max(0.01, part.depthMm / 1000);
  const ph = Math.max(0.26, part.heightMm / 1000);

  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.35,
    metalness: 0.85,
    clippingPlanes: ctx.clippingPlanes,
  });
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.25,
    metalness: 0.72,
    clippingPlanes: ctx.clippingPlanes,
  });
  const oledMat = new THREE.MeshPhysicalMaterial({
    color: 0x090d16,
    roughness: 0.06,
    metalness: 0.18,
    clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.96,
    clearcoatRoughness: 0.04,
    clippingPlanes: ctx.clippingPlanes,
  });

  if (!isSlimScreenOnly) {
    // Wall-side mounting plate (-pd/2) + dual steel VESA arms reaching forward
    const wallPlate = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.36, ph * 0.42, 0.014), metalMat);
    wallPlate.position.set(0, 0, -pd / 2 + 0.007);
    wallPlate.castShadow = ctx.castShadows;
    g.add(wallPlate);

    const armLen = Math.max(0.022, pd * 0.52);
    for (const ax of [-pw * 0.12, pw * 0.12]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.026, armLen), metalMat);
      arm.position.set(ax, 0, -pd / 2 + 0.014 + armLen / 2);
      g.add(arm);
    }
  }

  // Ultra-slim bezel chassis + glossy OLED panel at front (outer bezel spans full part envelope)
  const chassisD = isSlimScreenOnly ? pd * 0.96 : 0.024;
  const panelZ = isSlimScreenOnly ? -pd * 0.02 : pd / 2 - 0.015;
  const chassis = addMesh(g, new THREE.BoxGeometry(pw, ph, chassisD), bezelMat, ctx.castShadows);
  chassis.position.set(0, 0, panelZ);

  const oled = new THREE.Mesh(
    new THREE.BoxGeometry(pw * 0.98, ph * 0.97, isSlimScreenOnly ? pd * 0.08 : 0.006),
    oledMat
  );
  oled.position.set(0, 0, isSlimScreenOnly ? pd * 0.46 : panelZ + chassisD * 0.5 + 0.001);
  g.add(oled);
  return g;
}

function buildSmallApplianceGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  kind: 'coffee_machine' | 'drip_coffee' | 'kettle' | 'toaster' | 'stand_mixer'
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.12, part.widthMm / 1000);
  const pd = Math.max(0.12, part.depthMm / 1000);
  const ph = Math.max(0.12, part.heightMm / 1000);

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.22,
    metalness: 0.88,
    clippingPlanes: ctx.clippingPlanes,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.5,
    metalness: 0.25,
    clippingPlanes: ctx.clippingPlanes,
  });
  const bodyMat = makeMat(part, ctx, { roughness: 0.26, metalness: part.material === 'metal' ? 0.82 : 0.08 });

  if (kind === 'coffee_machine') {
    const back = addMesh(g, new THREE.BoxGeometry(pw * 0.94, ph * 0.86, pd * 0.54), bodyMat, ctx.castShadows);
    back.position.set(0, -ph * 0.05, -pd * 0.21);
    const head = addMesh(g, new THREE.BoxGeometry(pw * 0.94, ph * 0.3, pd * 0.42), bodyMat, ctx.castShadows);
    head.position.set(0, ph * 0.23, pd * 0.12);
    const dripBase = addMesh(g, new THREE.BoxGeometry(pw * 0.96, ph * 0.14, pd * 0.42), steelMat, ctx.castShadows);
    dripBase.position.set(0, -ph * 0.43, pd * 0.18);
    // Grouphead + compact portafilter handle strictly inside footprint
    const groupCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.04, 16), steelMat);
    groupCyl.position.set(0, ph * 0.06, pd * 0.2);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, pd * 0.26, 10), darkMat);
    handle.rotation.x = Math.PI / 2;
    handle.position.set(0, ph * 0.04, pd * 0.35);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(Math.min(pw, pd) * 0.3, 0.004, 6, 20), steelMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(0, ph * 0.41, -pd * 0.16);
    g.add(groupCyl, handle, rail);
    return g;
  }

  if (kind === 'drip_coffee') {
    const tower = addMesh(g, new THREE.BoxGeometry(pw * 0.9, ph * 0.96, pd * 0.46), bodyMat, ctx.castShadows);
    tower.position.set(0, 0, -pd * 0.24);
    const hood = addMesh(g, new THREE.BoxGeometry(pw * 0.88, ph * 0.22, pd * 0.48), darkMat, ctx.castShadows);
    hood.position.set(0, ph * 0.36, pd * 0.12);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(pw * 0.38, pw * 0.4, 0.025, 18), darkMat);
    plate.position.set(0, -ph * 0.47, pd * 0.16);
    const carafe = new THREE.Mesh(
      new THREE.CylinderGeometry(pw * 0.34, pw * 0.38, ph * 0.46, 18),
      new THREE.MeshPhysicalMaterial({ color: 0x1e293b, transparent: true, opacity: 0.58, depthWrite: false, roughness: 0.1, clippingPlanes: ctx.clippingPlanes })
    );
    carafe.position.set(0, -ph * 0.18, pd * 0.16);
    const brew = new THREE.Mesh(new THREE.CylinderGeometry(pw * 0.33, pw * 0.35, ph * 0.22, 16), darkMat);
    brew.position.set(0, -ph * 0.28, pd * 0.16);
    g.add(plate, carafe, brew);
    return g;
  }

  if (kind === 'kettle') {
    const r = Math.min(pw, pd) * 0.33;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.08, ph * 0.08, 20), darkMat);
    base.position.y = -ph * 0.45;
    const pts = [
      new THREE.Vector2(0.001, -ph * 0.4),
      new THREE.Vector2(r * 0.98, -ph * 0.4),
      new THREE.Vector2(r * 0.72, ph * 0.36),
      new THREE.Vector2(r * 0.78, ph * 0.4),
      new THREE.Vector2(0.001, ph * 0.42),
    ];
    addMesh(g, new THREE.LatheGeometry(pts, 22), bodyMat, ctx.castShadows);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.02, 12), darkMat);
    knob.position.y = ph * 0.46;
    const spoutCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(r * 0.76, -ph * 0.2, 0),
      new THREE.Vector3(r * 1.26, ph * 0.08, 0),
      new THREE.Vector3(r * 1.42, ph * 0.3, 0),
    ]);
    addMesh(g, new THREE.TubeGeometry(spoutCurve, 12, 0.007, 8, false), steelMat, ctx.castShadows);
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-r * 0.7, ph * 0.22, 0),
      new THREE.Vector3(-r * 1.32, 0, 0),
      new THREE.Vector3(-r * 0.82, -ph * 0.28, 0),
    ]);
    addMesh(g, new THREE.TubeGeometry(handleCurve, 12, 0.009, 8, false), darkMat, ctx.castShadows);
    g.add(base, knob);
    return g;
  }

  if (kind === 'stand_mixer') {
    // Classic planetary stand mixer: sculpted foot + rear column + tilted motor head + chrome mixing bowl
    const foot = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(pw * 0.88, pd * 0.92, 0.035), ph * 0.1, 0.005, 0.005, 1),
      bodyMat,
      ctx.castShadows
    );
    foot.position.y = -ph * 0.45;
    const neck = addMesh(
      g,
      new THREE.CylinderGeometry(pw * 0.22, pw * 0.28, ph * 0.68, 16),
      bodyMat,
      ctx.castShadows
    );
    neck.position.set(0, -ph * 0.08, -pd * 0.26);
    const head = addMesh(
      g,
      createExtrudedCentered(roundedRectShape(pw * 0.62, pd * 0.78, 0.055), ph * 0.26, 0.012, 0.012, 2),
      bodyMat,
      ctx.castShadows
    );
    head.position.set(0, ph * 0.33, -pd * 0.06);
    // Stainless steel mixing bowl sitting forward under planetary hub
    const bowlR = Math.min(pw, pd) * 0.36;
    const bowlH = ph * 0.44;
    const bowlPts = [
      new THREE.Vector2(0.001, -bowlH * 0.5),
      new THREE.Vector2(bowlR * 0.65, -bowlH * 0.5),
      new THREE.Vector2(bowlR * 0.96, bowlH * 0.38),
      new THREE.Vector2(bowlR, bowlH * 0.5),
      new THREE.Vector2(bowlR * 0.92, bowlH * 0.5),
      new THREE.Vector2(bowlR * 0.58, -bowlH * 0.38),
      new THREE.Vector2(0.001, -bowlH * 0.4),
    ];
    const bowl = addMesh(g, new THREE.LatheGeometry(bowlPts, 24), steelMat, ctx.castShadows);
    bowl.position.set(0, -ph * 0.16, pd * 0.14);
    const beater = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.016, ph * 0.22, 10), steelMat);
    beater.position.set(0, ph * 0.11, pd * 0.14);
    const speedLever = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.025, 10), darkMat);
    speedLever.rotation.z = Math.PI / 2;
    speedLever.position.set(pw * 0.33, ph * 0.33, -pd * 0.12);
    g.add(beater, speedLever);
    return g;
  }

  // toaster
  const body = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw * 0.94, pd * 0.92, 0.028), ph * 0.88, 0.008, 0.008, 2),
    bodyMat,
    ctx.castShadows
  );
  body.position.y = -ph * 0.04;
  for (const sz of [-pd * 0.16, pd * 0.16]) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.66, 0.012, 0.026), darkMat);
    slot.position.set(0, ph * 0.42, sz);
    g.add(slot);
  }
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.014, 0.026), darkMat);
  lever.position.set(pw * 0.45, ph * 0.12, 0);
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.014, 12), steelMat);
  dial.rotation.z = Math.PI / 2;
  dial.position.set(pw * 0.45, -ph * 0.16, 0);
  g.add(lever, dial);
  return g;
}

function buildSculpturalGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.1, part.widthMm / 1000);
  const ph = Math.max(0.1, part.heightMm / 1000);
  const mat = makeMat(part, ctx, { roughness: 0.35, clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.35 });
  const r = Math.min(pw, ph) * 0.28;
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.65, ph * 0.12, pw * 0.65), mat);
  plinth.position.y = -ph * 0.44;
  plinth.castShadow = ctx.castShadows;
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(r, r * 0.28, 48, 12, 2, 3), mat);
  knot.position.y = ph * 0.06;
  knot.castShadow = ctx.castShadows;
  g.add(plinth, knot);
  return g;
}

function buildCurtainPleatGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  isLinen = false
): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.18, part.widthMm / 1000);
  const pd = Math.max(0.05, part.depthMm / 1000);
  const ph = Math.max(0.5, part.heightMm / 1000);
  const isSheer = part.material === 'glass';
  let mat: THREE.Material;
  if (isSheer) {
    mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(part.color),
      roughness: 0.82,
      metalness: 0,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      transmission: 0.25,
      side: THREE.DoubleSide,
      clippingPlanes: ctx.clippingPlanes,
    });
  } else {
    const fabricMat = makeMat(part, ctx, { roughness: 0.92, sheen: 0.45 });
    if (isLinen) {
      fabricMat.transparent = true;
      fabricMat.opacity = 0.35;
      fabricMat.depthWrite = false;
      fabricMat.side = THREE.DoubleSide;
      fabricMat.needsUpdate = true;
    }
    mat = fabricMat;
  }

  const folds = Math.max(5, Math.min(26, Math.round(pw / 0.075)));
  const waveAmp = pd * 0.38;
  const stepX = pw / folds;
  const pleatR = Math.max(0.018, Math.min(0.042, stepX * 0.56));
  for (let i = 0; i < folds; i++) {
    const fx = -pw / 2 + (i + 0.5) * stepX;
    const fz = Math.sin((i / folds) * Math.PI * (folds / 2)) * waveAmp * 0.5 + (i % 2 === 0 ? waveAmp * 0.35 : -waveAmp * 0.35);
    const foldMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(pleatR * 0.92, pleatR * 1.06, ph, 12),
      mat
    );
    foldMesh.scale.set(1.0, 1, 1.35);
    foldMesh.position.set(fx, 0, fz);
    foldMesh.castShadow = ctx.castShadows && !isSheer && !isLinen;
    foldMesh.receiveShadow = ctx.castShadows;
    if (isLinen || isSheer) foldMesh.renderOrder = 8;
    g.add(foldMesh);
  }
  // Top heading pinch band
  const headerBand = new THREE.Mesh(new THREE.BoxGeometry(pw, Math.min(0.09, ph * 0.04), pd * 0.36), mat);
  headerBand.position.set(0, ph / 2 - Math.min(0.045, ph * 0.02), 0);
  if (isLinen || isSheer) headerBand.renderOrder = 8;
  g.add(headerBand);
  return g;
}

function buildBlindsSlatsGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.25, part.widthMm / 1000);
  const pd = Math.max(0.02, part.depthMm / 1000);
  const ph = Math.max(0.3, part.heightMm / 1000);
  const slatMat = makeMat(part, ctx, { roughness: 0.45 });
  const cordMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.5,
    clippingPlanes: ctx.clippingPlanes,
  });

  const slatCount = Math.max(8, Math.min(34, Math.round(ph / 0.052)));
  const slatD = Math.max(0.024, Math.min(0.042, pd * 0.9));
  const slatGeo = new THREE.BoxGeometry(pw, 0.004, slatD);
  for (let i = 0; i < slatCount; i++) {
    const sy = -ph / 2 + ((i + 0.5) / slatCount) * ph;
    const slat = new THREE.Mesh(slatGeo, slatMat);
    slat.position.set(0, sy, 0);
    slat.rotation.x = 0.24; // Subtle tilted louver angle
    slat.castShadow = ctx.castShadows;
    slat.receiveShadow = ctx.castShadows;
    g.add(slat);
  }

  // Ladder lift cords
  for (const cx of [-pw * 0.34, 0, pw * 0.34]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, ph, 6), cordMat);
    cord.position.set(cx, 0, 0);
    g.add(cord);
  }
  return g;
}

function buildRollerBlindGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.25, part.widthMm / 1000);
  const ph = Math.max(0.25, part.heightMm / 1000);
  const mat = makeMat(part, ctx, { roughness: 0.85, sheen: 0.2 });
  const sheet = addMesh(g, new THREE.BoxGeometry(pw, ph, 0.008), mat, ctx.castShadows);
  sheet.position.set(0, 0, 0.006);
  // Rolled fabric tube near top
  const roll = addMesh(g, new THREE.CylinderGeometry(0.024, 0.024, pw, 16), mat, ctx.castShadows);
  roll.rotation.z = Math.PI / 2;
  roll.position.set(0, ph / 2 - 0.024, -0.004);
  return g;
}

function buildAcIndoorGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.45, part.widthMm / 1000);
  const pd = Math.max(0.14, part.depthMm / 1000);
  const ph = Math.max(0.18, part.heightMm / 1000);

  const shellMat = makeMat(part, ctx, { roughness: 0.28, clearcoat: ctx.matOpts.isSoftwareGl ? 0 : 0.35 });
  const darkVentMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.65,
    metalness: 0.2,
    clippingPlanes: ctx.clippingPlanes,
  });
  const displayMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.38,
    roughness: 0.25,
    clippingPlanes: ctx.clippingPlanes,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.22,
    metalness: 0.85,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Main curved European split AC body (Extruded profile along width X -> side contour rounded front-bottom)
  const profile = new THREE.Shape();
  const hd = pd / 2;
  const hh = ph / 2;
  profile.moveTo(-hd, -hh * 0.72);
  profile.lineTo(-hd, hh);
  profile.lineTo(hd * 0.82, hh);
  profile.quadraticCurveTo(hd, hh * 0.96, hd, hh * 0.55);
  profile.lineTo(hd * 0.94, -hh * 0.55);
  profile.quadraticCurveTo(hd * 0.88, -hh, hd * 0.35, -hh);
  profile.lineTo(-hd * 0.82, -hh);
  profile.quadraticCurveTo(-hd, -hh, -hd, -hh * 0.72);

  const chassisGeo = new THREE.ExtrudeGeometry(profile, {
    depth: pw,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.008,
    bevelSegments: 3,
    curveSegments: 14,
  });
  // Rotate so extrusion length runs along X and shape stays in YZ plane
  chassisGeo.rotateY(Math.PI / 2);
  chassisGeo.center();
  addMesh(g, chassisGeo, shellMat, ctx.castShadows);

  // Subtle horizontal front accent line
  const accentStrip = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.94, 0.006, 0.008), chromeMat);
  accentStrip.position.set(0, -hh * 0.2, hd * 0.96);
  g.add(accentStrip);

  // Top intake grille slats
  const intakeCount = Math.max(8, Math.round(pw / 0.065));
  for (let i = 0; i < intakeCount; i++) {
    const sx = -pw * 0.44 + (i / Math.max(1, intakeCount - 1)) * pw * 0.88;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, pd * 0.58), darkVentMat);
    rib.position.set(sx, hh + 0.001, -pd * 0.05);
    g.add(rib);
  }

  // Bottom discharge outlet recess + tilted white deflector flap
  const outlet = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.88, 0.022, pd * 0.28), darkVentMat);
  outlet.position.set(0, -hh + 0.012, hd * 0.45);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.86, 0.008, pd * 0.24), shellMat);
  flap.position.set(0, -hh - 0.004, hd * 0.52);
  flap.rotation.x = 0.28;
  flap.castShadow = ctx.castShadows;
  g.add(outlet, flap);

  // Compact LED temperature display pill on front right
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.024, 0.006), displayMat);
  led.position.set(pw * 0.34, -hh * 0.05, hd * 0.96);
  g.add(led);

  return g;
}

function buildAcOutdoorGroup(part: FurniturePart, ctx: Furniture3DBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pw = Math.max(0.45, part.widthMm / 1000);
  const pd = Math.max(0.22, part.depthMm / 1000);
  const ph = Math.max(0.4, part.heightMm / 1000);

  const metalMat = makeMat(part, ctx, { roughness: 0.38, metalness: 0.32 });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.72,
    metalness: 0.35,
    clippingPlanes: ctx.clippingPlanes,
  });
  const grilleMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.5,
    metalness: 0.55,
    clippingPlanes: ctx.clippingPlanes,
  });
  const lidMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.42,
    metalness: 0.45,
    clippingPlanes: ctx.clippingPlanes,
  });

  // Main sheet-metal housing
  const chassis = addMesh(
    g,
    createExtrudedCentered(roundedRectShape(pw, pd, 0.018), ph * 0.95, 0.006, 0.006, 2),
    metalMat,
    ctx.castShadows
  );
  chassis.position.y = -ph * 0.015;

  // Stamped top lid cap flush within housing footprint
  const cap = addMesh(g, new THREE.BoxGeometry(pw * 0.995, 0.022, pd * 0.995), lidMat, ctx.castShadows);
  cap.position.y = ph * 0.485;

  // Circular fan aperture recess + 3-blade impeller + concentric wire safety grille inside front face
  const fanCx = -pw * 0.14;
  const fanR = Math.min(pw * 0.28, ph * 0.37);
  const shroudBack = new THREE.Mesh(new THREE.CylinderGeometry(fanR, fanR, 0.016, 28), darkMat);
  shroudBack.rotation.x = Math.PI / 2;
  shroudBack.position.set(fanCx, 0, pd / 2 - 0.014);
  g.add(shroudBack);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(fanR * 0.22, fanR * 0.22, 0.016, 16), grilleMat);
  hub.rotation.x = Math.PI / 2;
  hub.position.set(fanCx, 0, pd / 2 - 0.01);
  g.add(hub);

  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(fanR * 0.78, fanR * 0.24, 0.006), darkMat);
    const a = (i / 3) * Math.PI * 2;
    blade.position.set(fanCx + Math.cos(a) * fanR * 0.45, Math.sin(a) * fanR * 0.45, pd / 2 - 0.01);
    blade.rotation.z = a;
    blade.rotation.x = 0.22;
    g.add(blade);
  }

  for (const ringFrac of [0.42, 0.68, 0.94]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(fanR * ringFrac, 0.004, 6, 28), grilleMat);
    ring.position.set(fanCx, 0, pd / 2 - 0.004);
    g.add(ring);
  }

  for (let b = 0; b < 7; b++) {
    const by = -fanR * 0.75 + (b / 6) * (fanR * 1.5);
    const span = Math.sqrt(Math.max(0.01, fanR * fanR - by * by)) * 1.9;
    const wire = new THREE.Mesh(new THREE.BoxGeometry(span, 0.004, 0.004), grilleMat);
    wire.position.set(fanCx, by, pd / 2 - 0.002);
    g.add(wire);
  }

  // Right-hand side service panel / brand badge & valve cover tucked flush inside envelope
  const valveCover = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.05, ph * 0.36, pd * 0.42), lidMat);
  valveCover.position.set(pw / 2 - pw * 0.025, -ph * 0.22, -pd * 0.14);
  g.add(valveCover);

  // Rear heat-exchanger coil fins flush inside rear edge
  const coil = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.82, ph * 0.78, 0.012), grilleMat);
  coil.position.set(-pw * 0.04, 0, -pd / 2 + 0.006);
  g.add(coil);

  return g;
}

export interface PlacedGlbContainer {
  fGroup: THREE.Group;
  tiltGroup: THREE.Group;
  mirrorGroup: THREE.Group;
  placement: FurniturePlacement;
  mountingType: MountingType;
  mountingFace: MountingFace;
}

/**
 * Shared GLB container creation using canonical getFurniturePlacement for
 * both Viewport3D and 3D GLB/OBJ/STL export.
 */
export function createPlacedGlbContainer(
  f: FurnitureInstance,
  effectiveCeilingMm?: number
): PlacedGlbContainer {
  const placement = getFurniturePlacement(f, { effectiveCeilingMm });
  const mountingType = resolveFurnitureMountingType(f);
  const mountingFace = resolveFurnitureMountingFace(f);

  const fGroup = new THREE.Group();
  fGroup.name = `Furniture_${f.name || f.id}`;
  fGroup.position.set(f.xMm / 1000, placement.groupElevationMm / 1000, f.yMm / 1000);
  fGroup.rotation.y = (-f.rotationDeg * Math.PI) / 180;

  const tiltGroup = new THREE.Group();
  const rxRad = ((f.rotationXDeg ?? 0) * Math.PI) / 180;
  const ryRad = ((f.rotationYDeg ?? 0) * Math.PI) / 180;
  if (placement.hasTilt) {
    tiltGroup.rotation.set(rxRad, ryRad, 0, 'YXZ');
    tiltGroup.position.y = placement.tiltZShiftMm / 1000;
  }
  fGroup.add(tiltGroup);

  const mirrorGroup = new THREE.Group();
  mirrorGroup.scale.set(placement.mirrorSignX, 1, placement.mirrorSignY);
  tiltGroup.add(mirrorGroup);

  return {
    fGroup,
    tiltGroup,
    mirrorGroup,
    placement,
    mountingType,
    mountingFace,
  };
}

export function finalizeGlbModelInContainer(
  container: PlacedGlbContainer,
  model: THREE.Object3D
): void {
  fitGlbSceneToFurnitureBounds(model, container.placement.untiltLocalBounds, {
    mountingType: container.mountingType,
    mountingFace: container.mountingFace,
  });
  container.mirrorGroup.add(model);
  container.tiltGroup.position.y = 0;
  if (container.placement.hasTilt) {
    container.fGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(container.tiltGroup);
    if (Number.isFinite(box.min.y)) {
      container.tiltGroup.position.y += container.fGroup.position.y - box.min.y;
    } else {
      container.tiltGroup.position.y = container.placement.tiltZShiftMm / 1000;
    }
  }
}

const COMPOSITE_DETAIL_STYLES = new Set<string>([
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
  'caster_base',
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

function buildCompositePartBoundedGroup(
  part: FurniturePart,
  ctx: Furniture3DBuildContext,
  options: {
    templateId?: string;
    isLinenCurtain?: boolean;
    skipTextures?: boolean;
  } = {}
): THREE.Group | null {
  const ds = part.detailStyle;
  const isLightFloorArm = options.templateId === 'light_floor' && /arm/i.test(part.name);
  const isFringeBox = ds === 'fringe_rug' && part.shape !== 'oval';
  if ((!ds || !COMPOSITE_DETAIL_STYLES.has(ds)) && !isLightFloorArm && !isFringeBox) {
    return null;
  }

  const pw = Math.max(0.01, part.widthMm / 1000);
  const pd = Math.max(0.01, part.depthMm / 1000);
  const ph = Math.max(0.01, part.heightMm / 1000);

  let rawGroup: THREE.Group | null = null;
  let stretchToFill = true;

  if (ds === 'planter_pot') rawGroup = buildPlanterPotGroup(part, ctx);
  else if (ds === 'foliage' || ds === 'leaves_palm' || ds === 'leaves_olive') {
    rawGroup = buildBotanicalFoliageGroup(part, ctx);
  } else if (ds === 'lamp_base') rawGroup = buildLampBaseGroup(part, ctx);
  else if (ds === 'basin') rawGroup = buildBasinGroup(part, ctx);
  else if (ds === 'tub_inner') rawGroup = buildBathtubGroup(part, ctx);
  else if (ds === 'toilet_bowl') rawGroup = buildToiletBowlGroup(part, ctx);
  else if (ds === 'vase') rawGroup = buildVaseGroup(part, ctx);
  else if (ds === 'bowl') rawGroup = buildBowlGroup(part, ctx);
  else if (ds === 'books') rawGroup = buildBooksGroup(part, ctx);
  else if (ds === 'candle_tray') rawGroup = buildCandleTrayGroup(part, ctx);
  else if (ds === 'faucet') rawGroup = buildFaucetGroup(part, ctx);
  else if (ds === 'caster_base') {
    rawGroup = buildCasterBaseGroup(part, ctx);
    stretchToFill = false;
  } else if (ds === 'towel_rail') rawGroup = buildTowelRailGroup(part, ctx);
  else if (ds === 'gas_hob') rawGroup = buildGasHobGroup(part, ctx);
  else if (ds === 'electric_hob' || ds === 'induction_hob') {
    rawGroup = buildGlassHobGroup(part, ctx, ds === 'induction_hob');
  } else if (ds === 'oven_front' || ds === 'microwave_front') {
    rawGroup = buildOvenMicrowaveGroup(part, ctx, ds === 'microwave_front');
  } else if (
    ds === 'fridge_single' ||
    ds === 'fridge_double' ||
    ds === 'fridge_side_by_side' ||
    ds === 'fridge_french' ||
    ds === 'wine_cooler'
  ) {
    rawGroup = buildFridgeGroup(part, ctx);
  } else if (ds === 'dishwasher') rawGroup = buildDishwasherGroup(part, ctx);
  else if (ds === 'washer_topload') rawGroup = buildTopLoadWasherGroup(part, ctx);
  else if (ds === 'washer_drum' || ds === 'dryer_drum') {
    rawGroup = buildLaundryDrumGroup(part, ctx, ds === 'dryer_drum');
  } else if (ds === 'wall_tv') rawGroup = buildWallTvGroup(part, ctx);
  else if (
    ds === 'coffee_machine' ||
    ds === 'drip_coffee' ||
    ds === 'kettle' ||
    ds === 'toaster' ||
    ds === 'stand_mixer'
  ) {
    rawGroup = buildSmallApplianceGroup(part, ctx, ds);
  } else if (ds === 'sculptural') rawGroup = buildSculpturalGroup(part, ctx);
  else if (ds === 'curtain_pleat') {
    rawGroup = buildCurtainPleatGroup(part, ctx, Boolean(options.isLinenCurtain));
  } else if (ds === 'blinds_slats') rawGroup = buildBlindsSlatsGroup(part, ctx);
  else if (ds === 'roller_blind') rawGroup = buildRollerBlindGroup(part, ctx);
  else if (ds === 'ac_indoor') rawGroup = buildAcIndoorGroup(part, ctx);
  else if (ds === 'ac_outdoor') rawGroup = buildAcOutdoorGroup(part, ctx);
  else if (isFringeBox) {
    const rugGroup = new THREE.Group();
    const geo = createPartBaseGeometry(part);
    const pMat = makeMat(part, ctx, { roughness: 0.94, sheen: 0.4 });
    if (!options.skipTextures) {
      pMat.map = createRugPatternTexture(`${options.templateId ?? 'rug'}_${part.id}`);
      pMat.needsUpdate = true;
    }
    addMesh(rugGroup, geo, pMat, false);
    const fringeMat = new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.95,
      clippingPlanes: ctx.clippingPlanes,
    });
    const tasselCount = Math.max(8, Math.min(26, Math.round(pd / 0.08)));
    for (const side of [-1, 1]) {
      for (let i = 0; i < tasselCount; i++) {
        const tz = -pd * 0.45 + (i / Math.max(1, tasselCount - 1)) * pd * 0.9;
        const tassel = new THREE.Mesh(
          new THREE.BoxGeometry(0.055, ph * 0.55, 0.018),
          fringeMat
        );
        towelOrTasselPos(tassel, side * Math.max(0.01, pw / 2 - 0.0275), -ph * 0.18, tz);
        rugGroup.add(tassel);
      }
    }
    rawGroup = rugGroup;
  } else if (isLightFloorArm) {
    const archCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -ph * 0.35, -pd / 2 + 0.014),
      new THREE.Vector3(0, ph * 0.42, -pd * 0.1),
      new THREE.Vector3(0, -ph * 0.25, pd / 2 - 0.014),
    ]);
    const archGeo = new THREE.TubeGeometry(archCurve, 20, Math.min(0.013, pw * 0.45, ph * 0.25), 10, false);
    const armGroup = new THREE.Group();
    addMesh(armGroup, archGeo, makeMat(part, ctx), ctx.castShadows);
    rawGroup = armGroup;
  }

  if (!rawGroup) return null;
  return clampCompositeGroupToPartBounds(rawGroup, pw, ph, pd, stretchToFill);
}

const BOUNDARY_EXTRACT_CTX: Furniture3DBuildContext = {
  matOpts: {
    materialQuality: 'standard',
    reflectionQuality: 'off',
    transparentQuality: 'standard',
    textureFiltering: 'bilinear',
    isSoftwareGl: true,
  },
  castShadows: false,
  clippingPlanes: [],
  nightMix: 0,
  partEdgeMat: new THREE.LineBasicMaterial({ color: 0x1e293b }),
  kelvinToColor: () => new THREE.Color('#FFE4C4'),
  isSoftwareGl: true,
};

registerCompositePartBoundaryExtractor((part, templateId): PartLocalVertex3DMm[] | null => {
  const bounded = buildCompositePartBoundedGroup(part, BOUNDARY_EXTRACT_CTX, {
    templateId,
    skipTextures: true,
  });
  if (!bounded) return null;
  return extractThreeObjectBoundaryVerticesMm(bounded);
});

export function buildProceduralFurnitureGroup(
  f: FurnitureInstance,
  ctx: Furniture3DBuildContext
): BuiltFurnitureResult {
  const placement = getFurniturePlacement(f, { effectiveCeilingMm: ctx.effectiveCeilingMm });
  const fGroup = new THREE.Group();
  fGroup.position.set(f.xMm / 1000, placement.groupElevationMm / 1000, f.yMm / 1000);
  fGroup.rotation.y = (-f.rotationDeg * Math.PI) / 180;

  const tiltGroup = new THREE.Group();
  const rxRad = ((f.rotationXDeg ?? 0) * Math.PI) / 180;
  const ryRad = ((f.rotationYDeg ?? 0) * Math.PI) / 180;
  if (placement.hasTilt) {
    tiltGroup.rotation.set(rxRad, ryRad, 0, 'YXZ');
    tiltGroup.position.y = placement.tiltZShiftMm / 1000;
  }
  fGroup.add(tiltGroup);

  const mirrorGroup = new THREE.Group();
  mirrorGroup.scale.set(placement.mirrorSignX, 1, placement.mirrorSignY);
  tiltGroup.add(mirrorGroup);

  const isLighting = f.category === 'Lighting';
  const lightingActive = isFurnitureLightingActive(f);
  const effectiveLights = resolveEffectiveFurnitureLights(f);
  const firstActiveLight = lightingActive
    ? effectiveLights.find((l) => l.enabled && l.intensity > 0)
    : undefined;
  const lightCfg = f.lightConfig ?? { enabled: true, colorTempK: 3200, intensity: 0.6 };
  const hasAnyActiveLampLight =
    lightingActive &&
    (Array.isArray(f.lights) ? Boolean(firstActiveLight) : isLighting && lightCfg.enabled);
  const lightColor = firstActiveLight
    ? resolveLightSourceThreeColor(firstActiveLight)
    : ctx.kelvinToColor(lightCfg.colorTempK);
  const primaryLightIntensity = firstActiveLight
    ? firstActiveLight.intensity
    : lightCfg.intensity;

  const bulbLights: SceneBulbLightEntry[] = [];
  const emissiveTargets: EmissiveTargetEntry[] = [];
  let partIdx = 0;

  const applyManualPartEmissive = (groupObj: THREE.Object3D, part: FurniturePart) => {
    if (!lightingActive || part.emissiveEnabled !== true) return;
    const emColor = new THREE.Color(part.emissiveColor || part.color || '#FFBE76');
    const baseEmissive =
      Math.max(0, part.emissiveIntensity ?? 1.2) * Math.max(0.25, Math.min(1.6, part.bloomBoost ?? 1.0));
    const seenMats = new Set<THREE.Material>();
    groupObj.traverse((node) => {
      const m = (node as THREE.Mesh).material;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mat of mats) {
        if (seenMats.has(mat)) continue;
        seenMats.add(mat);
        const std = mat as THREE.MeshStandardMaterial;
        if ('emissive' in std) {
          std.emissive = emColor.clone();
          std.emissiveIntensity = baseEmissive * THREE.MathUtils.lerp(0.85, 0.94, ctx.nightMix);
          std.needsUpdate = true;
          emissiveTargets.push({ mat: std, baseIntensity: baseEmissive, alwaysVisible: true });
        }
      }
    });
  };

  for (const part of f.parts) {
    partIdx += 1;
    const pw = Math.max(0.01, part.widthMm / 1000);
    const pd = Math.max(0.01, part.depthMm / 1000);
    const ph = Math.max(0.01, part.heightMm / 1000);
    const ds = part.detailStyle;

    const px = part.xMm / 1000;
    const py = part.zMm / 1000 + ph / 2;
    const pz = part.yMm / 1000;
    const rotY = (-part.rotationDeg * Math.PI) / 180;

    const placeBoundedSubGroup = (rawGroup: THREE.Group, stretchToFill = true) => {
      const bounded = clampCompositeGroupToPartBounds(rawGroup, pw, ph, pd, stretchToFill);
      bounded.position.set(px, py, pz);
      bounded.rotation.y = rotY;
      mirrorGroup.add(bounded);
    };

    // 1. Bespoke Composite Procedural Sub-Assemblies & Bounded Fringed Rugs / Lamp Arm
    const isLinenCurtain =
      ds === 'curtain_pleat' &&
      (f.templateId === 'curtain_linen_drapes' ||
        (isCurtainOrBlindFurniture(f) &&
          (f.name.toLowerCase().includes('linen') || part.name.toLowerCase().includes('linen'))));
    const boundedComposite = buildCompositePartBoundedGroup(part, ctx, {
      templateId: f.templateId,
      isLinenCurtain,
    });
    if (boundedComposite) {
      boundedComposite.position.set(px, py, pz);
      boundedComposite.rotation.y = rotY;
      mirrorGroup.add(boundedComposite);
      continue;
    }

    // 2. Sculpted Rugs with Woven Pattern (oval or standard fringe-free)
    if (ds === 'rug' || ds === 'fringe_rug') {
      const rugGroup = new THREE.Group();
      const geo = createPartBaseGeometry(part);
      const rugTex = createRugPatternTexture(`${f.templateId}_${part.id}`);
      const pMat = makeMat(part, ctx, { roughness: 0.94, sheen: 0.4 });
      pMat.map = rugTex;
      pMat.needsUpdate = true;
      addMesh(rugGroup, geo, pMat, false);
      placeBoundedSubGroup(rugGroup);
      continue;
    }

    // 3. Framed Art Canvas with Editorial Painting Texture
    if (ds === 'art_canvas') {
      const artGeo = new THREE.BoxGeometry(pw, ph, pd);
      const artTex = createArtCanvasTexture(`${f.id}_${part.id}`, part.color);
      const artMat = new THREE.MeshStandardMaterial({
        map: artTex,
        color: 0xffffff,
        roughness: 0.72,
        metalness: 0,
        clippingPlanes: ctx.clippingPlanes,
      });
      const mesh = addMesh(mirrorGroup, artGeo, artMat, ctx.castShadows);
      mesh.position.set(px, py, pz);
      mesh.rotation.y = rotY;
      continue;
    }

    // 4. Reflective Mirror Glass
    if (ds === 'mirror') {
      const geo = createPartBaseGeometry(part);
      const mirrorMat = !ctx.matOpts.isSoftwareGl
        ? new THREE.MeshPhysicalMaterial({
            color: new THREE.Color('#E2E8F0'),
            roughness: 0.04,
            metalness: 0.96,
            clearcoat: 1.0,
            clearcoatRoughness: 0.04,
            envMapIntensity: 1.5,
            clippingPlanes: ctx.clippingPlanes,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            roughness: 0.08,
            metalness: 0.92,
            envMapIntensity: 1.3,
            clippingPlanes: ctx.clippingPlanes,
          });
      const mesh = addMesh(mirrorGroup, geo, mirrorMat, ctx.castShadows);
      mesh.position.set(px, py, pz);
      mesh.rotation.y = rotY;
      continue;
    }

    // 6. Standard / Enhanced Parametric Geometry + Fluted Cabinetry Detail
    const geo = createPartBaseGeometry(part);
    const alignGrain =
      part.material === 'wood' ||
      part.material === 'oak' ||
      part.material === 'walnut' ||
      part.material === 'teak' ||
      part.material === 'smoked_oak' ||
      part.material === 'parquet' ||
      part.material === 'herringbone' ||
      part.material === 'paneling';
    const partSeed =
      (f.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 97) + partIdx * 13;
    applyWorldSpaceUVs(geo, 1.0, partSeed, alignGrain);
    const pMat = makeMat(part, ctx);

    const emissiveEntry = applyProceduralPartEmissive(pMat, part, {
      isLightingCategory: isLighting,
      hasAnyActiveLampLight,
      fallbackLightColor: lightColor,
      primaryLightIntensity,
      nightMix: ctx.nightMix,
      masterLightingEnabled: lightingActive,
    });
    const isEmissivePart = Boolean(emissiveEntry);
    if (emissiveEntry) {
      emissiveTargets.push(emissiveEntry);
    }

    const pMesh = new THREE.Mesh(geo, pMat);
    pMesh.castShadow = ctx.castShadows && !isEmissivePart && part.material !== 'glass';
    pMesh.receiveShadow = ctx.castShadows;
    if (part.material === 'glass' && !isEmissivePart) {
      pMesh.renderOrder = 12;
    }

    const hasSubDetails =
      ds === 'fluted' ||
      ds === 'slatted_wood' ||
      ds === 'tufted' ||
      ds === 'drainboard' ||
      ds === 'hood_filter';

    // Fluted or slatted vertical architectural ribs flush strictly inside curved/rounded envelope
    if (ds === 'fluted' || ds === 'slatted_wood') {
      const slatMat = makeMat(part, ctx, { roughness: ds === 'slatted_wood' ? 0.48 : 0.52 });
      if (part.shape === 'cylinder' || part.shape === 'oval') {
        const fluteCount = Math.max(14, Math.min(44, Math.round((Math.PI * (pw + pd)) / 0.055)));
        const fluteR = Math.min(0.008, (Math.PI * Math.min(pw, pd)) / (fluteCount * 2.5));
        const rxEff = Math.max(0.004, pw / 2 - fluteR);
        const rzEff = Math.max(0.004, pd / 2 - fluteR);
        const fluteGeo = new THREE.CylinderGeometry(fluteR, fluteR, ph * 0.94, 8);
        for (let i = 0; i < fluteCount; i++) {
          const ang = (i / fluteCount) * Math.PI * 2;
          const flute = new THREE.Mesh(fluteGeo, slatMat);
          flute.position.set(Math.cos(ang) * rxEff, 0, Math.sin(ang) * rzEff);
          flute.castShadow = ctx.castShadows;
          pMesh.add(flute);
        }
      } else {
        const isRoundedOrBeveled =
          part.shape === 'rounded_rect' ||
          (part.shape === 'box' && (Boolean(part.bevel)));
        const cornerRx = isRoundedOrBeveled
          ? Math.max(
              0.002,
              Math.min(
                part.shape === 'box' ? Math.min(pw, pd) * 0.04 : Math.min(pw * 0.22, pd * 0.22, 0.14),
                (pw / 2) * 0.48,
                (pd / 2) * 0.48
              )
            )
          : 0;
        const slatCount = Math.max(6, Math.min(36, Math.round(pw / 0.045)));
        const slatW = Math.min(0.018, (pw / slatCount) * 0.55);
        const slatD = Math.min(0.014, pd * 0.25);
        if (ds === 'slatted_wood' && ph <= 0.14 && ph < pd * 0.45) {
          // Flat slatted bench seat or outdoor table top: place flush slatted bars along top surface
          const topMarginX = cornerRx + slatW * 0.6;
          const usableW = Math.max(0.02, pw - topMarginX * 2);
          const barGeo = new THREE.BoxGeometry(slatW, Math.min(0.008, ph * 0.2), Math.max(0.02, pd * 0.86 - cornerRx * 0.5));
          for (let i = 0; i < slatCount; i++) {
            const sx = -usableW * 0.5 + (i / Math.max(1, slatCount - 1)) * usableW;
            const slat = new THREE.Mesh(barGeo, slatMat);
            slat.position.set(sx, ph / 2 - Math.min(0.004, ph * 0.1), 0);
            slat.castShadow = ctx.castShadows;
            pMesh.add(slat);
          }
        } else {
          const marginX = Math.max(pw * 0.03, cornerRx + slatW * 0.65);
          const spanX = Math.max(0.02, pw - marginX * 2);
          const slatGeo = new THREE.BoxGeometry(slatW, ph * 0.94, slatD);
          for (let i = 0; i < slatCount; i++) {
            const sx = -spanX * 0.5 + (i / Math.max(1, slatCount - 1)) * spanX;
            const slat = new THREE.Mesh(slatGeo, slatMat);
            slat.position.set(sx, 0, pd / 2 - slatD / 2);
            slat.castShadow = ctx.castShadows;
            pMesh.add(slat);
          }
        }
      }
    }

    // Subtle button-tufted grid dimples flush inside upholstered surfaces
    if (ds === 'tufted') {
      const cols = Math.max(2, Math.min(6, Math.round(pw / 0.26)));
      const rows = 2;
      const tuftGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.008, 10);
      const tuftMat = makeMat(part, ctx, { roughness: 0.72 });
      const faceTop = ph > pd * 1.2 ? false : true;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const tx = -pw * 0.34 + (cols > 1 ? (c / (cols - 1)) * pw * 0.68 : 0);
          const tuft = new THREE.Mesh(tuftGeo, tuftMat);
          if (faceTop) {
            const tz = -pd * 0.25 + r * pd * 0.5;
            tuft.position.set(tx, ph / 2 - 0.004, tz);
          } else {
            const ty = -ph * 0.22 + r * ph * 0.44;
            tuft.rotation.x = Math.PI / 2;
            tuft.position.set(tx, ty, pd / 2 - 0.004);
          }
          pMesh.add(tuft);
        }
      }
    }

    // Raised metallic drainer ribs flush at top edge
    if (ds === 'drainboard') {
      const ribCount = Math.max(4, Math.min(9, Math.round(pw / 0.06)));
      const ribGeo = new THREE.BoxGeometry(0.008, 0.004, pd * 0.72);
      const ribMat = makeMat(part, ctx, { roughness: 0.24, metalness: 0.85 });
      for (let i = 0; i < ribCount; i++) {
        const rx = -pw * 0.36 + (i / Math.max(1, ribCount - 1)) * pw * 0.72;
        const rib = new THREE.Mesh(ribGeo, ribMat);
        rib.position.set(rx, ph / 2 - 0.002, 0);
        pMesh.add(rib);
      }
    }

    // Baffle grease filter louvers underneath extractor hoods inside bottom face
    if (ds === 'hood_filter') {
      const barCount = Math.max(5, Math.round(pw / 0.08));
      const barGeo = new THREE.BoxGeometry((pw * 0.9) / barCount * 0.65, 0.006, pd * 0.82);
      const barMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.3, metalness: 0.85, clippingPlanes: ctx.clippingPlanes });
      for (let i = 0; i < barCount; i++) {
        const bx = -pw * 0.42 + (i / Math.max(1, barCount - 1)) * pw * 0.84;
        const bar = new THREE.Mesh(barGeo, barMat);
        bar.position.set(bx, -ph / 2 + 0.003, 0);
        pMesh.add(bar);
      }
    }

    // Only draw subtle silhouette edges on crisp architectural/box parts (never on organic cushions/spheres/cylinders)
    const isSoftOrganic =
      ds === 'cushion' ||
      ds === 'pillow' ||
      ds === 'blanket' ||
      ds === 'mattress' ||
      part.shape === 'sphere' ||
      part.shape === 'oval' ||
      part.shape === 'cylinder';

    if (!isEmissivePart && !isSoftOrganic) {
      const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 32), ctx.partEdgeMat);
      edgeLines.raycast = () => undefined;
      pMesh.add(edgeLines);
    }

    if (hasSubDetails) {
      const wrapGroup = new THREE.Group();
      wrapGroup.add(pMesh);
      placeBoundedSubGroup(wrapGroup);
    } else {
      pMesh.position.set(px, py, pz);
      pMesh.rotation.y = rotY;
      mirrorGroup.add(pMesh);
    }
  }

  // Allow explicit manual emissive toggle even on composite procedural parts
  for (const part of f.parts) {
    if (part.emissiveEnabled === true && part.detailStyle) {
      const targetChild = mirrorGroup.children.find(
        (c) =>
          Math.abs(c.position.x - part.xMm / 1000) < 0.002 &&
          Math.abs(c.position.z - part.yMm / 1000) < 0.002
      );
      if (targetChild) {
        applyManualPartEmissive(targetChild, part);
      }
    }
  }

  // Real light emission: multi-source Point / Spot / Area / Linear lights inside tiltGroup
  const builtLights = buildThreeLightsForFurniture(f, tiltGroup, {
    nightMix: ctx.nightMix,
    isSoftwareGl: ctx.isSoftwareGl,
    useLegacyFillForUnmigratedLamp: true,
  });
  for (const bl of builtLights) {
    bulbLights.push(bl);
  }

  return { group: fGroup, bulbLights, emissiveTargets };
}

function towelOrTasselPos(m: THREE.Object3D, x: number, y: number, z: number) {
  m.position.set(x, y, z);
}
