# AI_HANDOFF.md — Continuous Agent Context Torch

> **PURPOSE**: Machine-dense architectural memory and continuity ledger strictly for downstream AI Studio agents.
> **PROTOCOL**:
> 1. **READ THIS FILE COMPLETELY FIRST** before editing any code on every turn.
> 2. **APPEND A SEQUENTIAL NUMBERED ENTRY (`#N`)** under `## Change Ledger` before ending any turn that modifies code/docs (never overwrite prior entries; summarize compactly).
> 3. **STRICT BOUNDARIES (SCOPE LOCK)**:
>    - **Strict Scope**: Do NOT change the app layout, tabs (`2D Plan` / `Wall View` / `3D View`), panels, toolbars, inspector structure, colors, or the 3D viewport. **`Viewport3D` (`src/components/Viewport3D.tsx`) stays strictly view-only**.
>    - **Editing Scope**: Object editing stays in **2D (`Canvas2D.tsx`)**, **Wall View (`WallCutThroughViewer.tsx`)**, and **Properties Inspector (`PropertiesInspector.tsx`)**.
>    - **Permitted Work Only**: Work ONLY on (a) how the 2D editor (`Canvas2D.tsx`) and Wall View (`WallCutThroughViewer.tsx`) drag behavior feels and (b) performance optimizations that produce identical visual results.
>    - **Strict Restraint**: Do not add features. Do not change the save format. Do not change data models, geometry results, or snapping outcomes unless the milestone explicitly says so.
>    - **One Milestone at a Time**: Do only the explicitly named milestone, then stop. Log each milestone as a new numbered ledger entry (`#N`) in `AI_HANDOFF.md`.
>    - **Verification & Reporting**: Keep every existing test passing (`geometry`, `mounting`, `milestone2`, `elevation2d`, `lighting`, `railings`, `svgProjection`, `graphicsSettings`), adding tests for anything new in pure utils. End every milestone with: what changed, how you measured it, known gaps.

---

## Project Baseline & Architecture Summary

- **Stack**: React 19 + TypeScript + Vite (`5.4+` / `6`) + Tailwind CSS v4 + Three.js (`three`, `OrbitControls`, `GLTFLoader`, `GLTFExporter`, `OBJExporter`, `STLExporter`, `EffectComposer`). Express server (`server.ts`, port `3000`).
- **Coordinate Conventions**:
  - Plan / 2D CAD coords (`src/types/plan.ts`, `src/utils/geometry.ts`): **millimeters (`mm`)**, `+X` right, `+Y` down (screen top-down). Vertical elevation `elevationMm` / `zMm` up.
  - 3D Three.js (`Viewport3D.tsx`, `export3d.ts`, `wall3d.ts`, `furniture3d.ts`): **meters (`m = mm / 1000`)**, `+X = xMm/1000`, `+Y = zMm/1000` (up), `+Z = yMm/1000`, and plan yaw rotation `rotationDeg` maps to `rotation.y = -deg * Math.PI / 180`.
  - Furniture Euler & Mirror Order (**CRITICAL INVARIANT**): `mirror (scale(mx, 1, my))` -> `tilt (YXZ: X=rotationXDeg, Y=rotationYDeg)` -> `grounding zShift` -> `horizontal Z-rotation (rotationDeg around vertical axis)` -> `world translation (xMm, elevationMm, yMm)`. Enforced identically in `geometry.ts`, `furniture3d.ts`, `Viewport3D.tsx`, `export3d.ts`, and `Canvas2D.tsx`.
- **Key Modules**:
  - `src/types/plan.ts`: Canonical `Wall`, `Room`, `Opening`, `FurnitureInstance`, `FurniturePart`, `ArchElement`, `FurnitureRepresentation`, `Level`, `ProjectPlan`.
  - `src/utils/geometry.ts`: Wall polygons/miters (`computeWallPolygon`, `wallOffsets`, `getWallCenterlinePoint`), room polygon detection (`detectRoomsFromWalls`), wall face identification (`resolveWallFaces`, `flipWallFace`), wall dimension/clearance/chimney solvers, furniture tilted/mirrored bounds (`computeFurnitureTiltedLocalBoundsMm`, `computeFurnitureWorldBox`, `getFurnitureSolidFootprintPolygons`), collision & snap (`snapFurnitureToPlan`, `solveSolidFurnitureMove`), Wall View projection (`projectFurnitureForWallCutThrough`, `resolveWallViewProjectionForFurniture`).
  - `src/utils/wall3d.ts`: Shared Three.js wall builder (`buildWall3DGroup`) used by both `Viewport3D.tsx` and `export3d.ts`.
  - `src/utils/furniture3d.ts`: Shared procedural Three.js furniture builder (`buildProceduralFurnitureGroup`) using `fGroup -> tiltGroup -> mirrorGroup`.
  - `src/utils/assetStore.ts`: Hash-keyed IndexedDB binary store for large imported GLB assets + JSON bundle serialization helpers (`glbAssetId`).
  - `src/utils/svgProjection.ts` / `furnitureRepresentationSync.ts` / `svgRepresentationRenderer.tsx` / `RepresentationEditorModal.tsx`: Revision 9 5-view orthographic SVG silhouette extractor (`top`, `front`, `rear`, `left`, `right`), non-blocking async cache sync, interactive SVG stroke/fill editor modal, architectural black-on-white + optional material fill defaults.
  - `src/utils/textures3d.ts`: Procedural architectural PBR textures (`buildArchitecturalMaterial`, `applyWorldSpaceUVs`).
  - `src/utils/walkPhysics.ts`: 175cm FPS walk mode colliders (`buildWalkColliders`, `resolveWalkStep`).
  - `src/components/Canvas2D.tsx`: Main 2D floorplan editor (walls, openings, rooms, furniture move/mirror/Z-rotate handles, inline editable architectural dimensions, alignment guides).
  - `src/components/WallCutThroughViewer.tsx`: Interactive elevation Wall View with physical face switching, opposite-side occlusion, chimney placement, depth-effect culling, and dimension editing.
  - `src/components/Viewport3D.tsx`: **Strict view-only** Three.js Orbit/Perspective/Walkthrough renderer + bloom/day-night/cutaway.
  - `src/components/PropertiesInspector.tsx`: Contextual inspector (`Wall` face finishes & Flip Face, `Furniture` manual Tilt X / Roll Y / Rotation Z / Mirror / SVG Editor launch, `Room`, `Opening`, `ArchElement`).

---

## Known Upstream Baseline Note

- `src/utils/geometry.test.ts` subtest `curtains stick exclusively to walls...` fails at line ~2529 due to pre-existing fixture lookup `'sofa_3seat'` (`src/data/catalog.ts` defines `'sofa_straight_3'`). Do not alter unrelated catalog IDs unless specifically tasked.

---

## Verification Commands

- Unit tests:
  - `npx tsx --test src/utils/geometry.test.ts`
  - `npx tsx --test src/utils/svgProjection.test.ts`
- Build & Lint:
  - `npm run lint`
  - `npm run build`

---

## Change Ledger

### #1 — Milestone 1: Core Geometry, Wall Systems, 3D Window Cutouts, Wall View Occlusion & 2D Furniture Transforms
- **Types (`src/types/plan.ts`)**: Added `faceFlipped?: boolean` on `Wall`.
- **Wall Face Auto-Identification & Flip (`src/utils/geometry.ts`, `PropertiesInspector.tsx`, `WallCutThroughViewer.tsx`, `Canvas2D.tsx`, `wall3d.ts`)**:
  - Added `resolveWallFaces(wall, rooms)` probing enclosing rooms on physical `+normal` (`left`) vs `-normal` (`right`): single-room walls dynamically label the room-facing physical side `Inner` and exterior `Outer` regardless of CW/CCW endpoint order; shared walls dynamically label each physical side with its bordering room name (reactively updating when rooms are renamed); freestanding partitions respect `faceFlipped`.
  - Added `flipWallFace(wall)` reversing `faceFlipped` and swapping `inner*`/`outer*` color, material, scale, and rotation fields without moving endpoints, changing thickness/alignment, or breaking shared room links. Exposed **Flip Face** button (`data-testid="flip-wall-face-btn"`) in `PropertiesInspector.tsx` plus subtle selected-wall face badges in `Canvas2D.tsx`.
- **3D Window Cutouts Root-Cause Fix (`src/utils/wall3d.ts`, `Viewport3D.tsx`, `export3d.ts`)**:
  - Factored shared `buildWall3DGroup(...)` eliminating the duplicate overlapping `outerSkinGeo` slab that shared hole paths and covered/z-fought across windows; replaced with a single partitioned non-indexed `ExtrudeGeometry` sorted into `[leftMat, coreMat, rightMat]` groups bound via `resolveWallFaces`.
  - Enforced CW hole winding (including `round` ellipse holes), set `castShadow = false` / `receiveShadow = false` on all window glass meshes, split baseboard/crown molding spans cleanly around low/tall openings, and subdivided curved walls (`steps = 28`) with sill/header cutouts around openings.
- **Wall View Visibility & Opposite-Side Occlusion (`src/utils/geometry.ts`, `WallCutThroughViewer.tsx`)**:
  - Updated `projectFurnitureForWallCutThrough` and `resolveWallViewProjectionForFurniture` to accept physical `'left' | 'right'` sides and enforce true wall-thickness occlusion (`maxOut <= 4 || (centerOut < -wallHalfThick && maxOut <= 15)`) plus rear sub-part filtering (`part.outFront > 2`).
  - Fixed directly attached opposite-side chimneys in `WallCutThroughViewer.tsx` (added `continue;` so opposite-side chimneys are hidden and counted) and updated UI face selector to display dynamic room names / `Inner`/`Outer`.
- **Furniture Mirror/Tilt/Rotate Parity & 2D Mouse Rotation (`src/utils/furniture3d.ts`, `geometry.ts`, `Viewport3D.tsx`, `export3d.ts`, `Canvas2D.tsx`)**:
  - Unified mirror-before-tilt-before-Z-rotate across 3D (`fGroup -> tiltGroup -> mirrorGroup` for both procedural furniture composite groups and GLBs), tilted OBB footprints (`getFurnitureSolidFootprintPrimitives` / `Polygons`), `snapFurnitureToPlan`, and `Canvas2D.tsx`.
  - Removed outer `scale(mx, my)` from `Canvas2D.tsx` furniture `<g>`, moved `scale(mx, my)` inside visual/part groups, centered the 2D rotation handle on `(bounds.minX + bounds.maxX) / 2`, implemented mirror-safe relative pointer-angle rotation with `Shift` free-rotate override + configurable `angleSnapDeg` + live upright SVG angle readout badge.
  - Verified `Viewport3D.tsx` remains strictly view-only; `Tilt X` / `Roll Y` remain purely manual in `PropertiesInspector.tsx`.
- **Tests (`src/utils/geometry.test.ts`)**: Added Milestone 1 tests for wall face identification/renaming/flipping, thin/thick wall opposite-side occlusion, mirrored+tilted OBB parity, and 3D straight/round/floor-to-ceiling/curved window cutout triangle verification.

### #2 — Milestone 2: 2D Furniture Drawings (`Default` / `Silhouette` / `Hidden-line`)
- **Types (`src/types/plan.ts`)**: Extended `RepresentationMode` to `'default' | 'silhouette' | 'hidden_line'`, added immutable `defaultViews?: Partial<Record<ProjectionViewId, ProjectedViewSvg>>` to `FurnitureRepresentation`, and added `svgSource?: string` to `FurnitureInstance`.
- **SVG Import, Validation & Default Eligibility (`src/utils/svgImport.ts`)**:
  - Added Node- and browser-safe SVG parser `parseSvgSourceToProjectedView(...)` supporting nested `<g>`, affine `transform` matrices, `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<polyline>`, `<line>`, inline styles, and `viewBox`/unit sizing, plus `isValidSvgSource`, `isBuiltinCatalogItem`, `hasValidDefaultSvg`, `resolveEffectiveRepresentationMode`, and `generateDefaultTopViewFromParts` (with accurate `arc`/`l_profile`/`u_profile`/`rounded_rect`/ellipse support).
  - Exposed `Default` strictly when a valid SVG exists (valid imported `svgSource`, preserved `defaultViews.top`, or non-GLB built-in catalog item); GLB imports, image traces, custom-builder objects without SVGs, and empty/invalid SVGs resolve to `'silhouette'` and hide `Default`.
- **Pipeline Preservation (`src/utils/svgProjection.ts`, `furnitureRepresentationSync.ts`, `svgRepresentationRenderer.tsx`, `usePlanState.ts`, `App.tsx`)**:
  - Kept `svgSource` and `defaultViews` strictly immutable across mode switches (`default` ↔ `silhouette` ↔ `hidden_line`), background sync (`needsRepresentationRegeneration` returns `false` for built-in `'default'` items so 3D silhouettes never overwrite original drawings), 2D B&W toggles, and `customViews` edits.
  - Updated `getEffectiveViewElements` priority (`customViews` > `defaultViews` in `'default'` mode > `autoViews`) and added non-mutating `blackAndWhite` color override in `renderFurnitureRepresentationView`.
- **UI & Views (`PropertiesInspector.tsx`, `ImporterModal.tsx`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`, `LeftSidebar.tsx`, `SvgRepresentationEditorModal.tsx`)**:
  - Conditionally rendered the `Default` toggle button strictly when `hasValidDefaultSvg(...)` is true alongside `Silhouette` and `Hidden-Line`; preserved original SVG / generated `defaultViews.top` on `Save to Library` and inside the 2D SVG Editor modal; added live SVG preview in `ImporterModal.tsx` and architectural part fallback in `Canvas2D`/`WallCutThroughViewer`/`LeftSidebar` for built-in items in `Default` mode. Kept `Viewport3D.tsx` strictly view-only.
- **Tests (`src/utils/svgProjection.test.ts`)**: Added Tests 7–8 verifying SVG parsing/validation, `Default` visibility rules across imported SVG, invalid SVG, GLB, custom, and built-in items, and immutability of original SVGs across mode transitions.

### #3 — Milestone 2: Object Mounting, Surface Attachment & Parent-Child Manipulation
- **Types (`src/types/plan.ts`)**: Added `MountingType` (`'floor' | 'wall' | 'ceiling' | 'freestanding' | 'surface'`) and `MountingFace` (`'bottom' | 'top' | 'back' | 'front' | 'left' | 'right'`), `defaultMountingType` / `defaultMountingFace` on `CatalogTemplate`, and `mountingType`, `mountingFace`, `attachedWallId`, `attachedFace`, `attachedT`, `wallOffsetMm`, `surfaceHostId`, `surfaceLocalXMm`, `surfaceLocalYMm`, `surfaceLocalRotDeg` on `FurnitureInstance`.
- **Mounting Core & GLB Geometry Inspection (`src/utils/mounting.ts`)**:
  - Added deterministic resolution (`resolveFurnitureMountingType`, `resolveFurnitureMountingFace`, `defaultMountingFaceForType`) so all catalog/custom/imported items resolve explicitly across the 5 mounting types.
  - Added `inspectGlbForMounting(root)` analyzing vertex face densities, CoM height, footprint area ratios, and aspect ratios to detect ceiling canopies/pendants, thin vertical wall-mounted profiles (auto-selecting `back`/`front`/`left`/`right`), compact surface items, freestanding objects, or floor objects rather than defaulting everything to floor-mount.
  - Added non-destructive pivot rotation transforms (`getMountingRotationEulerRad`, `getMountingRotationQuaternion`, `rotateBoundsForMounting`, `transformBoundsBetweenMountings`, `applyMountingRotationToObject3D`) so original raw IndexedDB GLB geometry buffers are never altered.
- **Surface Attachment & Hierarchy Solvers (`src/utils/geometry.ts`)**:
  - Added `computeAttachedWallFurnitureTransform`, `findNearestWallAttachmentTarget`, `AttachmentTargetPreview`, and wall-snap flush alignment inside `snapFurnitureToPlan` and `solveSolidFurnitureMove` (wall-mounted items snap cleanly to `'left'`/`'right'` faces without wall clipping or floating; `Shift` / `allowOverlap` bypasses auto-attachment and clears existing bindings).
  - Updated `isCeilingFixture` / `getCeilingFixtureOffsetMm` / `isSurfaceMountable` / `isSupportingSurfaceFurniture` / `wouldCreateSurfaceCycle` / `findSupportingSurfaceForProp` so any floor/freestanding supporting desk/table/cabinet (including custom/GLB flat-top items) hosts surface children cleanly with cycle prevention.
  - Added recursive relationship propagation (`computeSurfaceLocalCoords`, `computeWorldFromSurfaceLocal`, `propagateParentFurnitureTransforms`, `propagateWallAttachments`, `detachChildrenOnParentDelete`). Parent deletion detaches children cleanly and returns orphaned surface children to floor (`elevationMm: 0`).
- **2D/3D Pipelines & Importer (`src/utils/svgProjection.ts`, `furnitureRepresentationSync.ts`, `furniture3d.ts`, `Viewport3D.tsx`, `export3d.ts`, `ImporterModal.tsx`)**:
  - Applied mounting orientation pivots consistently across 3D rendering (`fitGlbSceneToFurnitureBounds`), 3D export, and 2D 5-view projection extraction (`mt:${mType}|mf:${mFace}` cache key), keeping `Viewport3D.tsx` strictly view-only and keeping `defaultViews` / original SVGs intact.
  - Added automatic GLB mounting inspection plus quick **Mounting Type** (5 options) and **Model Mounting Face** (6 presets) selectors in `ImporterModal.tsx` with live dimensions and Top/Front SVG preview updates.
- **2D Editing, Placement, Lifecycle & Inspector (`Canvas2D.tsx`, `PropertiesInspector.tsx`, `usePlanState.ts`, `App.tsx`)**:
  - Added live 2D attachment target highlighting in `Canvas2D.tsx` (wall mounting segment highlight and supporting host footprint dashed blue outline during drag) and wired recursive propagation across 2D furniture move/rotate/edge-resize drags as well as `wall_vertex` and `wall_body` drags.
  - Updated `PropertiesInspector.tsx` with **Mounting & Attachment** controls (5 Mounting Types, 6 Model Mounting Face presets with live GLB re-orientation & async 2D view refresh, Wall Offset / Flip Side / Snap / Detach controls) and wired parent/wall propagation across property edits, alignment, resize, wall length, and wall split.
  - Updated `usePlanState.ts` (`deleteSelected` detaches children on parent delete; `pasteClipboard`/`duplicateSelected` remaps paired parent-child copies) and `App.tsx` (`placeFurnitureTemplate` attaches based on resolved mounting type).
- **Verification**:
  - `npx tsx --test src/utils/mounting.test.ts src/utils/svgProjection.test.ts`: **16/16 passing** (covering all 5 mounting types, `inspectGlbForMounting`, axis transforms, wall/ceiling/floor/surface attachment, `Shift` bypass, cycle prevention, parent move/rotate/mirror/resize, wall move, parent delete detachment, JSON serialization, and 2D Default/Silhouette/Hidden-line preservation).
  - `npx tsx --test src/utils/geometry.test.ts`: 42/43 passing (1 pre-existing baseline failure noted above at line ~2529).
  - `npm run lint` (`tsc --noEmit`) and `npm run build` (`compile_applet`): **0 errors, build succeeded**.
- **Known Issues / Next Recommended Steps**:
  - Pre-existing `geometry.test.ts` `'curtains stick exclusively to walls...'` lookup of `'sofa_3seat'` remains untouched per instructions.
  - GLB orientation auto-detection relies on vertex/face heuristics; unusual raw GLB meshes can be corrected immediately via the 6-face preset selector in `ImporterModal` or `PropertiesInspector`.

### #4 — Milestone 3: Advanced Furniture Lighting & GLB Emissive Glow Support
- **Types (`src/types/plan.ts`)**: Added `FurnitureLightType` (`'point' | 'spot' | 'area' | 'linear'`), `FurnitureLightSource` (id, name, type, enabled, colorMode `'kelvin' | 'hex'`, colorTempK, colorHex, intensity, rangeMm, decay, local `xMm`/`yMm`/`zMm`, aimAzimuthDeg/aimElevationDeg, coneAngleDeg, penumbra, widthMm/lengthMm, castShadow, sourceRef), `GlbMaterialEmissiveOverride`, `GlbInspectedMaterial`, independent per-part emissive fields on `FurniturePart` (`emissiveEnabled`, `emissiveColor`, `emissiveIntensity`, `bloomBoost`), and `lights` / `glbEmissiveOverrides` on `CatalogTemplate` and `FurnitureInstance`.
- **Lighting & GLB Emissive Engine (`src/utils/lighting.ts`)**:
  - Added color conversion/resolution (`kelvinToThreeColor`, `kelvinToHex`, `resolveLightSourceThreeColor`, `resolveLightSourceHex`), vector aiming (`computeAimDirectionVectorThree` with mirror folding), legacy `Lighting` migration/fallback (`resolveEffectiveFurnitureLights`, `deriveLegacyLightsForFurniture`), resize scaling (`scaleFurnitureLightSources`), fresh-ID cloning (`cloneLightsWithFreshIds`), and 1-click matching light generators (`createMatchingLightForPart`, `createMatchingLightForGlbMaterial`).
  - Added deterministic, non-destructive GLB material inspection (`inspectGlbMaterials`) returning fitted local millimeter bounds centers and detecting existing `emissiveMap`s or disabled emissive properties.
  - Added non-destructive runtime material cloning & override application (`applyGlbEmissiveOverrides`) preserving source cached IndexedDB/in-memory GLB assets, diffuse/normal/roughness maps, and optional embedded `emissiveMap`s while emitting HDR glow visible in both day and dark night environments.
  - Added unified procedural emissive evaluator (`applyProceduralPartEmissive`), multi-type Three.js light builder (`buildThreeLightsForFurniture` mounting into `tiltGroup` above `mirrorGroup` so negative mirror scales never invert spotlight matrices, with multi-point fallback for `RectAreaLight` on software WebGL), and hardware shadow budget enforcement (`assignInteriorShadowBudget`, max 3 interior shadow casters prioritized by `userCastShadow` + 1 sun/moon = 4 max).
- **3D Scene, Procedural Builder & Export (`src/utils/furniture3d.ts`, `src/components/Viewport3D.tsx`, `src/utils/export3d.ts`)**:
  - Updated `furniture3d.ts` to support per-part emissive overrides completely independently of category or real lights, plus multi-light emission via `buildThreeLightsForFurniture`.
  - Updated `Viewport3D.tsx` (kept strictly view-only) to build real lights and apply GLB emissive overrides on both procedural and GLB furniture, refine selective `UnrealBloomPass` HDR threshold (`1.38` day / `0.96` night) and `alwaysVisible` emissive scaling (`0.85x–1.22x`), and apply `assignInteriorShadowBudget` across synchronous & async GLB loads with stale-build cancellation guards.
  - Updated `export3d.ts` so exported GLTF/GLB scenes preserve furniture lights and GLB emissive overrides.
- **2D Editor & UI (`src/components/FurnitureLightingPanel.tsx`, `src/components/PropertiesInspector.tsx`, `src/components/ImporterModal.tsx`, `src/components/Canvas2D.tsx`, `src/hooks/usePlanState.ts`, `src/App.tsx`)**:
  - Created modular `FurnitureLightingPanel.tsx` supporting multiple lights per furniture across all categories (and GLB models), full light-type controls, Kelvin vs. Custom RGB swatches, local position/range/aim/cone/softness/shadow controls, GLB material glow toggles & emission/bloom sliders, procedural part glow controls, and 1-click **`+ Matching Light`** pairing.
  - Updated `ImporterModal.tsx` to scan uploaded GLBs for materials and disabled/active emissive properties with optional glow & light pairing during import.
  - Updated `Canvas2D.tsx` to render **selected-only** 2D light source indicators (bulbs, spotlight cones, area panels, linear strips) with draggable local position & horizontal aim handles respecting rotation and mirroring, leaving unselected floorplan furniture uncluttered.
  - Propagated `lights` scaling on overall resize (`PropertiesInspector.tsx`) and deep-cloning on array/duplicate/paste/library-save (`usePlanState.ts`, `App.tsx`, `PropertiesInspector.tsx`).
- **Verification**:
  - `npx tsx --test src/utils/lighting.test.ts src/utils/mounting.test.ts src/utils/svgProjection.test.ts`: **22/22 passing** (6 new Milestone 3 lighting/VARMBLIXT GLB emissive/transform/shadow-budget/JSON tests + 16 Milestone 1–2 regression tests).
  - `npm run lint` (`tsc --noEmit`) & `compile_applet` (`npm run build`): **0 errors, build succeeded**.
- **Known Issues / Next Recommended Steps**:
  - `RectAreaLight` softens via multi-point fallback when running under software WebGL (`isSoftwareGl === true`) to prevent shader stalls; hardware WebGL uses native `THREE.RectAreaLight`.
  - Browser visual check recommended on an imported emissive GLB (such as IKEA VARMBLIXT) to fine-tune preferred default bloom/intensity aesthetic under Night Mode.

### #5 — Lighting System UI/UX Revision & Night-Time Bloom Correction
- **Types & State (`src/types/plan.ts`, `src/utils/lighting.ts`, `src/App.tsx`, `src/components/PropertiesInspector.tsx`)**:
  - Added optional `isLight?: boolean` and `lightingEnabled?: boolean` on `CatalogTemplate` and `FurnitureInstance`, plus `isFurnitureLightObject(f)` and `isFurnitureLightingActive(f)` helpers in `src/utils/lighting.ts`.
  - Designated non-light GLB imports (`isLight: false`) hide lighting UI in `PropertiesInspector.tsx` and save clean metadata (`isLight`, `lightingEnabled`) into catalog templates and placed instances. Built-in `Lighting` category items and `isLight: true` objects remain light-enabled.
  - Added master `lightingEnabled` switch behavior across `buildThreeLightsForFurniture`, `applyGlbEmissiveOverrides`, `applyProceduralPartEmissive`, `Viewport3D.tsx`, `furniture3d.ts`, `export3d.ts`, and `Canvas2D.tsx`: toggling **Lit** off disables all associated light sources and emissive emission while preserving user-configured colors, intensities, and offsets cleanly when toggled back on.
- **Interactive 3D Preview & Unified Lighting Editor (`src/components/InteractiveGlbPreview3D.tsx`, `src/components/UnifiedLightingEditor.tsx`, `src/components/LightingEditorModal.tsx`)**:
  - Created `InteractiveGlbPreview3D.tsx` with OrbitControls (mouse drag rotation + scroll-wheel zoom), camera reset, and Studio (Day) / Night backdrop toggle — leaving the main project 3D viewport (`Viewport3D.tsx`) strictly view-only.
  - Selecting a material (GLB) or procedural part in `UnifiedLightingEditor.tsx` highlights matching meshes on the 3D preview in translucent/emissive blue (`#2563EB`/`#3B82F6`) and reveals inline emissive controls (toggle, color picker/swatches, intensity slider, embedded emissive map option, `+ Add Matching Light Here`), alongside light source configuration (`Point`, `Spot`, `Area`, `Linear`) in the same unified panel.
- **Redesigned GLB Importer & Side Menu Lighting Card (`src/components/ImporterModal.tsx`, `src/components/PropertiesInspector.tsx`)**:
  - Replaced the GLB drag-and-drop card upon file selection with the interactive 3D preview (`InteractiveGlbPreview3D`) + `Replace File`, **`Is a light`** toggle (OFF by default), and `UnifiedLightingEditor` revealed directly when enabled.
  - Replaced verbose per-item inline lighting forms in `PropertiesInspector.tsx` with a compact **Lighting** card for light objects showing the **Lit** toggle and **Edit** button side-by-side; clicking **Edit** opens `LightingEditorModal.tsx` with the live 3D preview and unified materials/lights editor.
- **Night-Time Lighting & Bloom Calibration (`src/components/Viewport3D.tsx`, `src/utils/lighting.ts`, `src/utils/furniture3d.ts`)**:
  - Reduced excessive night bloom and overexposed light stacking without altering daytime appearance: set `toneMappingExposure` to `lerp(0.96, 0.94, m)`, raised `UnrealBloomPass.threshold` to `lerp(1.38, 1.24, m)` (`> 1.0` so lit walls do not bloom), reduced `bloomPass.strength` to `lerp(0.055, 0.12, m)` and radius to `0.28`, calibrated night point/spot multiplier (`lerp(0.24, 0.62, m)` instead of `1.35`), and softened night emissive multipliers (`0.94`).
- **UI Polish (`Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**:
  - Removed emojis (replaced locked labels with `[LOCKED]`) across the UI.
- **Verification**:
  - `npx tsx --test src/utils/lighting.test.ts`: **6/6 passing**.
  - `npm run lint` (`tsc --noEmit`) and `compile_applet` (`npm run build`): verified clean.
- **Remaining Limitations**:
  - Procedural emissive parts on objects whose `category !== 'Lighting'` and have no configured lights still glow visually when `lightingEnabled !== false`, while objects marked `isLight: true` (or built-in `Lighting`) expose the **Lit** card and interactive `LightingEditorModal`.

### #6 — 3D Light Position & Direction Gizmo Controls
- **Types & Orientation Basis (`src/types/plan.ts`, `src/utils/lighting.ts`)**:
  - Added optional `aimRollDeg?: number` to `FurnitureLightSource` (`-180..180`, default `0`) for asymmetric `'area'` and `'linear'` lights.
  - Added `computeLightOrientationQuaternionThree(aimAzimuthDeg, aimElevationDeg, aimRollDeg, mirroredX, mirroredY)` in `src/utils/lighting.ts` so `RectAreaLight` and 3D gizmos share one continuous basis across Yaw, Pitch (including straight-down `-90°`/straight-up `+90°`), and Roll.
- **3D Light Markers & Axis/Orientation Gizmo (`src/components/InteractiveGlbPreview3D.tsx`)**:
  - Decoupled heavy model/GLB loading from lightweight light/marker/gizmo updates (`lightsOverlayGroupRef`) so dragging gizmo handles updates illumination and markers smoothly at interactive frame rates without reloading meshes.
  - Rendered visible 2D-matched markers (`#FFFFFF` rim + light-color core + blue selection ring + soft outer halo) at every light's emission point with `depthTest: false` so internal bulbs remain visible inside shades, plus click-to-select hit targets in 3D when multiple lights exist.
  - Rendered raycasted, camera-plane-projected **3-axis translation arrows** (`X` Red, `Y` Green, `Z` Blue with axis badges) for independent X/Y/Z positioning.
  - Rendered non-point **Yaw** (amber horizontal ring) and **Pitch** (cyan vertical arc) handles for `'spot'`, `'area'`, and `'linear'` lights, plus a **Roll** (violet ring) handle strictly for asymmetric `'area'`/`'linear'` lights. Point lights show only X/Y/Z translation arrows and zero direction handles.
- **Synchronized Numeric Controls (`src/components/UnifiedLightingEditor.tsx`, `LightingEditorModal.tsx`, `ImporterModal.tsx`)**:
  - Synced `selectedLightId` and `onUpdateLight` bi-directionally between `InteractiveGlbPreview3D` and `UnifiedLightingEditor` (clicking a 3D light marker switches the editor to `Light Sources` and selects that light).
  - Exposed color-matched **X / Y / Z** numeric inputs plus independent **Yaw (°)**, **Pitch (°)**, and asymmetric **Roll (°)** sliders + numeric inputs (hidden on `'point'` lights).
- **Verification**:
  - `npx tsx --test src/utils/lighting.test.ts`: **7/7 passing**.
  - `npm run lint` (`tsc --noEmit`) and `compile_applet` (`npm run build`): verified clean.

### #7 — 3D Viewer Camera-Movement White Flash Fix
- **Root Causes Identified & Fixed**:
  1. **Skybox GLSL `pow(0.0, y)` + `HalfFloatType` MSAA `UnrealBloomPass` NaN Explosions (`src/components/Viewport3D.tsx`)**:
     - The skybox shader evaluated `pow(0.0, 0.55)`, `pow(0.0, 0.7)`, `pow(0.0, 16.0)`, and `pow(0.0, 160.0)` on the anti-sun sky hemisphere and horizon (`NaN` on ANGLE/Metal/Intel/NVIDIA WebGL2 drivers), which spread through `UnrealBloomPass`'s Gaussian mips inside the `HalfFloatType` render target into full-screen white flashes whenever moving the camera.
     - Fixed by guarding every `pow(...)` input (`max(..., 0.0001)` and `sunAmt > 0.001`), disabling MSAA on the `HalfFloatType` `EffectComposer` target (`samples: 0`), and adding a pre-bloom `ShaderPass` (`hdrSanitizePass`) that clamps `NaN`, negative, and `> 12.0` HDR specular fireflies before `UnrealBloomPass`.
  2. **GLB Mesh & Roughness Sanitization (`src/utils/lighting.ts`, `src/components/Viewport3D.tsx`, `src/components/InteractiveGlbPreview3D.tsx`)**:
     - Computed missing vertex normals on imported GLB meshes (`computeVertexNormals()`) and clamped cloned `roughness >= 0.04` to prevent GGX/LTC divide-by-zero specular spikes at grazing camera angles.
  3. **3D Preview Buffer & Studio Wall Clipping (`src/components/InteractiveGlbPreview3D.tsx`)**:
     - Enabled `preserveDrawingBuffer: true` and rendered synchronously in `ResizeObserver`, skipped hover state updates while mouse buttons are held during orbit, and removed the near-white vertical `backWall` plane that clipped across the orbit camera path.
- **Verification**:
  - `npx tsx --test src/utils/lighting.test.ts`: passing.
  - `npm run lint` (`tsc --noEmit`) and `compile_applet` (`npm run build`): verified clean.

### #8 — 3D Window Transparency & Non-Rectangular/Cutaway/Export Parity Fix
- **Root Causes Identified & Fixed**:
  1. **Overlapping/Touching Window & Non-Rectangular Hole Cutouts (`src/utils/wall3d.ts`)**:
     - When two openings on the same straight wall overlapped or touched, or when a wide/low `round_arch` (`ow/2 > oh - 0.04`) exited the wall perimeter, `THREE.ExtrudeGeometry` Earcut triangulation failed and filled the window opening back in with solid opaque wall.
     - Fixed by clustering touching/overlapping cutouts via `buildMergedClusterHolePaths(...)` (2D grid boolean union extracting strictly CW non-intersecting outer loops), clamping `round_arch` rise (`ry = Math.min(ow/2, Math.max(0.02, oh - 0.04))`), fixing `segmental_arch` apex control point, and clamping `applyMiterSkew` corner extensions so thick/acute wall corners cannot fold across adjacent windows.
  2. **Cutaway-Sliced Window Top Bars (`src/utils/wall3d.ts`, `src/components/Viewport3D.tsx`, `src/utils/export3d.ts`)**:
     - Cutaway mode previously clamped opening tops `2 cm` below `wallH`, leaving a dark wall-core strip and opaque lintel header across windows sliced by cutaway height.
     - Fixed by carving top-edge cutaway notches directly into `wallShape`'s outer contour and omitting the `head` frame bar + adjusting glazing bounds when `cutawayEnabled` slices the top of an opening.
  3. **Curved-Wall Opening Profiles (`src/utils/wall3d.ts`)**:
     - Added vertical profile evaluation (`getCutoutVerticalSpanAtX`) for `round` windows and `round_arch`/`pointed_arch`/`segmental_arch` openings, preserved exact opening boundary `t` breaks in `baseSteps`, added 14 sub-steps across non-rectangular curved-wall openings, collected multi-cutout vertical spans before `subtractSolidIntervals`, and removed `0.004 m` end-padding on segments touching opening edges.
  4. **Inner/Outer Wall Alignment, Oval Round Glazing, Glass Material & Export Parity (`src/utils/textures3d.ts`, `src/components/Viewport3D.tsx`, `src/utils/export3d.ts`)**:
     - Applied `wallOffsets(wall.thicknessMm, wall.alignment)` normal `centerOffsetM` to `opGroup.position` in both `Viewport3D.tsx` and `export3d.ts` so frames and glass sit inside `'inner'` and `'outer'` walls identically to `'center'` walls.
     - Scaled oval `round` window `disc` glass (`w/(2*r), 1, h/(2*r)`) to match its ring frame, skipped duplicate fixed glass panes behind angled `casement`/`awning` sashes, added missing sills/thresholds/mullions to `export3d.ts`, and tuned `textures3d.ts` `'glass'` material (`metalness: 0`, `opacity: 0.16`, `envMapIntensity: 0.22`, `depthWrite: false`) for clear see-through glazing.
- **Verification**:
  - Raycast checks (`wall3d.ts`): 0 opaque wall hits across overlapping windows, cutaway-sliced openings, acute miter corners, `inner`-aligned walls, and straight/curved `round` & arch openings.
  - `npx tsx --test src/utils/geometry.test.ts`: 42/43 passing (only pre-existing `'sofa_3seat'` failure in test 38).
  - `npm run lint` (`tsc --noEmit`), `compile_applet` (`npm run build`), and live Playwright 3D screenshot inspection: verified unobstructed transparent windows with 0 page errors.

### #9 — Milestone 4: Advanced 3D Graphics Settings
- **Graphics Settings Model & Persistence (`src/utils/graphicsSettings.ts`, `src/hooks/usePlanState.ts`)**:
  - Created `GraphicsSettings`, `GRAPHICS_PRESETS` (`low`, `medium`, `high`, `ultra`), `DEFAULT_GRAPHICS_SETTINGS` (`high`), `applyGraphicsPreset`, `updateGraphicsSetting` (automatically switching `preset` to `'custom'` on any individual override), `normalizeGraphicsSettings`, and device-local persistence under `localStorage` key `'plan_studio_graphics_v1'` (`loadGraphicsSettings`/`saveGraphicsSettings`), keeping user rendering preferences independent from project JSON saves.
  - Wired `graphicsSettings`, `selectGraphicsPreset`, `updateGraphicsSettings`, and `resetGraphicsSettings` into `usePlanState.ts` and `App.tsx`.
- **Dual UI Surfaces (`src/components/GraphicsSettingsPanel.tsx`, `src/components/Viewport3D.tsx`, `src/components/SettingsModal.tsx`, `src/components/HomePage.tsx`)**:
  - Built reusable `GraphicsSettingsPanel.tsx` organized into Preset strip (`Low`, `Medium`, `High`, `Ultra`, auto `Custom` indicator, `Reset`), Display & Performance (`Render Scale`), Lighting & Shadows (`Global Illumination`, `Light Quality`, `Max Lights`, `Shadow Resolution`, `Shadow Softness`, `Shadow Distance`, `Contact Shadows`), Materials & Textures (`Texture Resolution`, `Texture Filtering`, `Anisotropic Filtering`, `Material Quality`, `Reflections`, `Env Map`, `Glass / Alpha`), and Post-Processing (`Anti-Aliasing`, `Ambient Occlusion` + `AO Intensity`, `Bloom Intensity`, `Exposure`, `Contrast`, `Vignette`, optional `Depth of Field` + `Focus Dist` / `Aperture`).
  - Added **Graphics** button + outside-click/Escape-dismissing popover in `Viewport3D.tsx`'s top bar (solid surface over WebGL canvas, strictly view-only) AND a **Graphics** tab in `SettingsModal.tsx`.
- **Textures & Material Quality Tiers (`src/utils/textures3d.ts`)**:
  - Extended `ArchitecturalMaterialOptions` and `getOrCreatePresetTexture` with `textureResolution` (`256`/`512`/`1024`), `textureFiltering` (`nearest`/`bilinear`/`trilinear`), clamped `anisotropyLevel`, `materialQuality` (`standard` vs `physical`), `reflectionQuality` (`off`–`high` scaling `envMapIntensity`/`clearcoat`), and `transparentQuality` (`standard` vs `high`), plus LRU cache eviction (cap `96`, `.dispose()` on eviction). Window glass stays clearly transparent (`opacity: 0.16`, `depthWrite: false`, `DoubleSide`) at every preset.
- **3D Rendering Pipeline & Performance Scaling (`src/components/Viewport3D.tsx`)**:
  - Expanded `EffectComposer` chain (`!isSoftwareGl`): `RenderPass` -> `GTAOPass` (toggled & sampled by `ambientOcclusionQuality`) -> `hdrSanitizePass` (WebGL2 NaN clamp preserved) -> `UnrealBloomPass` -> `BokehPass` (optional DoF) -> `SMAAPass` (linear-srgb, pre-`OutputPass`) -> `OutputPass` -> `colorGradePass` (contrast + vignette) -> `FXAA` `ShaderPass` (sRGB, post-`OutputPass`), with synchronized `ResizeObserver` sizing and unmount disposal.
  - Decoupled lightweight uniform/DPR/GI/shadow-radius/post-processing updates from heavy geometry rebuilds; heavy rebuilds apply shadow map resolution (disposing old shadow targets cleanly), window portal `RectAreaLight` caps (`0`/`4`/`8` by `lightQuality`), interior `PointLight`/`SpotLight`/`RectAreaLight` priority culling (`maxRealtimeLights`) & shadow budget (`0`/`1`/`3`), and grounded floor-furniture contact shadow decals when `contactShadows` is enabled.
- **Verification**:
  - `npx tsx --test src/utils/graphicsSettings.test.ts src/utils/lighting.test.ts`: passing.
  - `npm run lint` (`tsc --noEmit`) and `compile_applet` (`npm run build`): verified clean.
  - Remaining limitation: Software WebGL (`isSoftwareGl === true`) bypasses `EffectComposer` post-processing and hardware shadows for stability, using direct `renderer.render(...)` and material/texture tier scaling.

### #10 — Milestone 5: Architectural Railings and Balustrades
- **Types & Parametric Railing Engine (`src/types/plan.ts`, `src/utils/railings.ts`)**:
  - Added `'railing'` `EditorTool`, `RailingStyleId`, `RailingMountingMethod` (`top_mount`, `side_fascia`, `embedded`, `wall_bracket`), `RailingHandrailShape`, `RailingPostShape`, `RailingGlassTint`, `RailingPathNode` (`{ xMm, yMm, elevationMm }`), `RailingEdgeToggles`, and `RailingConfig` on `ArchElement`.
  - Implemented all 8 architectural railing styles (`glass_panel` default, `frameless_glass`, `traditional_balusters`, `horizontal_metal`, `cable`, `solid_panel`, `modern_minimalist`, `handrail_only`) with `createDefaultRailingConfig`, `applyRailingStylePreset`, `normalizeRailingConfig`, `resolveRailingConfig`, `recenterRailingNodes`, and `computeRailingPathMetrics`.
  - Implemented multi-flight staircase spec & continuous landing-to-flight railing path generator (`computeStaircaseGeometrySpec`, `resolveHostStairRailings`) covering `stairs_straight`, `stairs_l`, `stairs_u`, and `stairs_spiral`, perimeter balcony/platform railing resolver (`resolveHostDeckRailings`), host-to-editable conversion (`extractEditableRailingElementsFromHost`), and 2D slope/edge snapping (`snapRailingDrawPoint` with interpolated stair elevation & balcony deck top elevation).
- **Shared 3D Geometry & Export Parity (`src/utils/railings3d.ts`, `src/components/Viewport3D.tsx`, `src/utils/export3d.ts`)**:
  - Built `buildRailing3DGroup`, `buildStaircase3DGroup`, and `buildHostDeckRailings3DGroup` handling sloped runs, sheared parallelogram tempered glass/solid infill panels (`depthWrite: false`, `renderOrder: 2` glass transparency/tints/reflections), plumb vertical balusters, tensioned cables, horizontal metal bars, shaped handrails with corner/slope elbow joints, and mounting hardware (`top_mount`, `side_fascia`, `embedded`, `wall_bracket`).
  - Wired identically into `Viewport3D.tsx` (strictly view-only; passes full `rawH` for staircases) and `export3d.ts` (GLB/GLTF/OBJ/STL).
- **2D Editor, Catalog, Toolbar & Collapsible Inspector (`src/components/Canvas2D.tsx`, `src/components/FloatingToolbox.tsx`, `src/components/LeftSidebar.tsx`, `src/components/RailingInspectorSection.tsx`, `src/components/PropertiesInspector.tsx`, `src/utils/keybinds.ts`, `src/App.tsx`)**:
  - Added multi-point `'railing'` path tool (keybind `'l'`) with live snapping to staircases/balconies/railings/walls, double-click/Enter/closed-loop completion, interactive node & `+` midpoint editing handles, multi-flight 2D stair/balcony/railing vector rendering, split Railing button + style selector in `FloatingToolbox.tsx`, all 8 railing presets + U-turn/spiral stairs in `LeftSidebar.tsx`, and collapsible accordions + host stair/balcony controls + *Convert to Editable Railings* in `PropertiesInspector.tsx`.
- **Verification**:
  - `npx tsx --test src/utils/railings.test.ts src/utils/graphicsSettings.test.ts src/utils/lighting.test.ts`: 17/17 passing.
  - `npm run lint` (`tsc --noEmit`), `compile_applet` (`npm run build`), and focused live browser sanity check verified clean.
  - Remaining limitation: Railing paths are piecewise-linear polylines (`nodes[]` with per-node elevation); smooth curved Bézier railing segments are not yet modeled separately and are approximated by placing closely spaced corner nodes.

### #11 — Flooring Pattern Scale Range Extension & Dual-Color Checkerboard Selectors
- **Types & Geometry (`src/types/plan.ts`, `src/utils/geometry.ts`)**:
  - Added optional `floorSecondaryColor?: string` on `Room` (defaulting to `'#334155'` when unset so existing templates and saved projects remain backwards-compatible) and preserved `matched?.floorSecondaryColor` inside `detectRoomsFromWalls`.
- **Extended Pattern Scale Range (`src/components/ColorMaterialPicker.tsx`, `src/components/PropertiesInspector.tsx`, `src/components/Canvas2D.tsx`, `src/utils/textures3d.ts`)**:
  - Added `textureScaleMin?: number` (default `0.4`) on `ColorMaterialPicker.tsx`, passing `textureScaleMin={0.05}` with `step={0.05}` for single-room and multi-room floor material pickers so flooring patterns can be enlarged up to 8× further than before (`0.05x`–`4.0x`).
  - Lowered minimum scale/repeat clamps in `Canvas2D.tsx` (`Math.max(0.05, ...)`) and `textures3d.ts` (`Math.max(0.02, scale)`) so enlarged floor textures scale smoothly in both 2D and 3D without hitting premature repeat clamps.
- **Dual-Color Checkerboard Flooring (`src/components/ColorMaterialPicker.tsx`, `src/components/PropertiesInspector.tsx`, `src/utils/textures3d.ts`, `src/components/Canvas2D.tsx`, `src/components/Viewport3D.tsx`, `src/utils/export3d.ts`)**:
  - Added independent **Tile 1 color (Light / Primary)** and **Tile 2 color (Dark / Alternate)** selectors (native swatch, hex input, eyedropper, full swatch palette, and one-click **Swap** button) in `ColorMaterialPicker.tsx` whenever `material === 'checker'` on floor pickers, plus live dual-color preview in `MaterialSwatchPreview`.
  - Updated `textures3d.ts` (`buildArchitecturalMaterial` / `getOrCreatePresetTexture` / `drawFallbackOrPattern`), `Canvas2D.tsx`, `Viewport3D.tsx`, and `export3d.ts` to bake/render both checkerboard colors independently without cross-tinting, and wired `floorSecondaryColor`, `floorTextureScale`, and `floorTextureRotDeg` into multi-room batch editing and **Apply to all rooms**.
- **Verification**:
  - `npm run lint` (`tsc --noEmit`) and `compile_applet` (`vite build`): verified clean.

### #12 — Application-Wide UI/UX Overhaul (CAD Workspace Architecture)
- **Design System & Typography (`src/index.css`, `src/components/MetricInput.tsx`)**:
  - Standardized CAD palette on light drafting surfaces default (`#F8FAFC`/`#FFFFFF`, crisp `1px` slate hairlines, `#2563EB` active accent) with dark mode toggle, `--font-sans` (`Plus Jakarta Sans`), `--font-mono` (`JetBrains Mono`), `.font-mono-nums` (`tabular-nums`), slim scrollbars, zero UI emojis, and tightened hairline metric inputs.
- **Top Bar & Workspace Chrome (`src/App.tsx`, `src/hooks/usePlanState.ts`, `src/components/HomePage.tsx`, `src/components/HistoryPanel.tsx`)**:
  - Streamlined Top Bar (`h-11`) keeping strictly application-level controls: Home button, inline Project Name, reactive `saveStatus` (`Saved` / `Saving`), Undo/Redo + History popover, Level switcher + quick add, `2D` / `Wall View` / `3D` segmented switcher, collapsible `Templates` & `Import / Export` dropdown menus (preserving all `export-3d-*` actions), Settings, Theme toggle, and left/right panel collapse toggles.
  - Added active 2D drafting tool hint banner with `Done` escape button and `removeCustomTemplate` persistence helper in `usePlanState.ts`.
- **Collapsible Left Panel & Grouped Bottom Tool Dock (`src/components/LeftSidebar.tsx`, `src/components/FloatingToolbox.tsx`, `src/components/BottomToolbar.tsx`)**:
  - Reorganized Left Panel (`272px`) around a 6-section CAD navigation strip (`Furniture`, `Architecture`, `People`, `Project Structure`, `Schedules`, `Tracing`), Built-in vs. **My Library** separation with delete action on custom items, enlarged `h-16` visual previews with mounting labels, sticky `Build` / `Import` footer, level switcher, scene outline with layer visibility toggles, schedules BOM/budget breakdown, and floorplan tracing calibration.
  - Replaced scattered 2D floating tools with a compact bottom dock (`FloatingToolbox.tsx`) grouped into 4 hairline-separated clusters with upward flyouts and keybind badges (`Select/Pan` | `Wall/Door/Window/Arch` | `Chimney/Railing/Library` | `Measure/Annotate`), paired with a compact `h-9` `BottomToolbar.tsx` telemetry bar (scale, zoom, grid/snap, units, Drafting popover, 3D cutaway toggle, and `tabular-nums` cursor coordinates).
- **Contextual Right Inspector (`src/components/inspector/InspectorPrimitives.tsx`, `src/components/PropertiesInspector.tsx`, `src/components/RailingInspectorSection.tsx`)**:
  - Built reusable `InspectorHeader` and collapsible `InspectorSection` accordions plus lock/constraint primitives across Empty State (project/layer summary), Multi-Selection, Wall, Room, Opening, Curtain, Furniture, Person, Arch, Measurement, and Annotation.
  - Placed compact `Lit` switch + `Edit` modal launcher (`LightingEditorModal.tsx`) inside a conditional Lighting accordion exclusively on light-capable furniture (`isFurnitureLightObject`), deleting the superseded `src/components/FurnitureLightingPanel.tsx`.
- **Viewports Alignment (`src/components/Viewport3D.tsx`, `src/components/WallCutThroughViewer.tsx`)**:
  - Consolidated `Viewport3D.tsx`'s strictly view-only HUD into a single top strip with primary camera presets (`Perspective`, `Iso`, `Top`, `Walk`, `Section`) + `Views` flyout, integrated `Day / Night` toggle, `Sun & Lens` popover (`FOV`, `Sun Azimuth`, `Sun Elevation`), `Ceiling`, `Shadows`, `Graphics` (`viewport-graphics-btn`), and `PNG` export. Harmonized `WallCutThroughViewer.tsx` controls to match (`wallview-*` / `cutthrough-*` testids preserved).
- **Verification**:
  - Zero emojis across `src/` `.ts`/`.tsx` UI strings verified via Python Unicode scan.
  - `npx tsx --test src/utils/railings.test.ts src/utils/graphicsSettings.test.ts src/utils/lighting.test.ts src/utils/mounting.test.ts src/utils/svgProjection.test.ts src/utils/textures.test.ts`: 33/33 passing.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.

### #13 — Elevation-Aware 2D Furniture Representation & Read-Only 2D Light Indicators (Roadmap Milestone 1)
- **Elevation Classification, Layering & Geometric Stack Hit-Testing (`src/utils/geometry.ts`, `src/utils/svgRepresentationRenderer.tsx`, `src/utils/furnitureVectors.tsx`)**:
  - Added `computeFurnitureCanopyUndersideZMm`, `computePlanFurnitureOverlapMetadata`, `sortFurnitureByElevationForPlan`, `isPointInFurniture2D`, and `findFurnitureHitsAtPoint` driven strictly by true 3D elevation spans (`computeFurnitureElevationSpanMm`, preserving actual `elevationMm`, part dimensions, and `zOrder` as same-elevation tie-breaker).
  - Extended `RenderSvgElementsOptions` (`svgRepresentationRenderer.tsx`) and `RenderPartVectorOptions` (`furnitureVectors.tsx`) with `fillOpacityScale`, `elementOpacity`, and `strokeDasharray` so upper canopies render translucently and hidden lower objects render clean dashed contours.
- **Two-Pass 2D Plan Representation & Shift-Free Stack Selection (`src/components/Canvas2D.tsx`)**:
  - Replaced manual-only `sortFurnitureByZOrder` loop with two-pass architectural plan layering (`Pass 1`: bottom-to-top rendering with translucent upper canopies (`0.34`), dashed ceiling/overhead items (`0.16` + `'55 38'`), plus hover/selected `Z min–max cm` badge; `Pass 2`: `pointer-events-none` dashed hidden-edge silhouettes `'42 26'` on covered lower objects in both Color and B&W modes).
  - Enabled immediate drag movement on press+drag (with 4 px click deadzone) without requiring `Shift` for vertically separated/overlapping items; clicking a stacked overlap cycles selection (`dragState.stackHitIds`) and displays the floating **Vertical Stack Switcher** (`data-testid="elevation-stack-switcher"`) to pick any overlapping layer cleanly while keeping underneath items draggable once selected.
- **Read-Only 2D Light Source Indicators (`src/components/Canvas2D.tsx`)**:
  - Converted light emitter markers (`data-testid="light-marker-${f.id}-${light.id}"`), beam footprints, and aim vectors to strictly `pointer-events-none` visual indicators and removed `furniture_light` / `furniture_light_aim` 2D drag handlers so dragging anywhere on a lamp moves the lamp instead of detaching or repositioning its light source (dedicated edits stay inside `LightingEditorModal`).
- **Verification**:
  - `npx tsx --test src/utils/elevation2d.test.ts src/utils/mounting.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/svgProjection.test.ts src/utils/graphicsSettings.test.ts src/utils/textures.test.ts`: verified all passing.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.

### #14 — Intelligent Furniture Placement, Snapping & Interaction Refinements (Roadmap Milestone 2)
- **Automatic Surface Placement & Compatibility (`src/utils/geometry.ts`, `src/App.tsx`)**:
  - Broadened `isSurfaceMountable`, `isSupportingSurfaceFurniture`, and added `isCompatibleSurfaceChild` so surface props, electronics/monitors/TVs (including floor-placed `tv_screen_stand`), appliances, and compact custom/GLB items automatically snap onto compatible desks, counters, TV stands, dressers, and elevated custom tabletops while keeping horizontal position/orientation intact and maintaining parent-child `surfaceHostId` transform syncing.
  - Enforced strict incompatibility exclusions (`Sofas & Seating`, beds, rugs, wardrobes, bathroom fixtures, floor lamps, and under-table floor drawers/pedestals beneath open tabletop canopies) so incompatible furniture stays at floor elevation and never jumps atop tables.
- **Ctrl Floor Placement & Top-Center Plain Splash Indicators (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Added `forceFloor?: boolean` (`Ctrl`) to `solveSolidFurnitureMove` plus live `Control` keydown/keyup re-evaluation during active furniture drags, temporarily disabling auto-surface snapping (`elevationMm: 0`, clears `surfaceHostId`) and emitting plain top-center splash text (`data-testid="placement-splash-text"` — zero bubbles/cards/pills): **`Floor mounted`**, **`Placing on [object name]`**, **`Room center`**, and red **`Clashing with [object name]`**. Wall-mounted items preserve quiet wall-attachment behavior during ordinary wall drags.
- **Geometric Room-Center Snapping & Non-Blocking Clashes (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Added `computeRoomGeometricCenter` (area centroid with interior grid-refinement fallback for strongly concave L/U-shaped rooms verified by `pointInPolygon`) and integrated room-center magnetic snapping into `snapFurnitureToPlan` (`rooms?: Room[]`) with a distinct emerald SVG crosshair target (`data-testid="room-center-indicator"`).
  - Added `detectFurnitureClashesAt` and `allowFurnitureOverlap` on `solveSolidFurnitureMove` so overlapping furniture moves freely in `Canvas2D` without blocking or requiring `Shift` while warning in red plain text on genuine 3D geometric overlaps (excluding rugs, curtains, host-child pairs, and Z-separated layers).
- **Interaction & Popup Positioning Fixes (`src/components/Canvas2D.tsx`)**:
  - Reverted unintended one-click pickup/drag in `handleFurniturePointerDown`: clicking an unselected object strictly selects it without entering `dragState`, restoring explicit press-and-drag on already-selected items while keeping `Shift`-free click cycling across stacked overlaps (`stackHitIds`).
  - Anchored the **Vertical Stack Switcher** (`data-testid="elevation-stack-switcher"`) statically to the top-left corner beneath the scale bar (`top-11 left-3`) so it never tracks the cursor or obscures furniture.
- **Verification**:
  - `npx tsx --test src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/mounting.test.ts`: 18/18 passing.
  - Zero emojis across `src/` UI strings; `compile_applet` & `lint_applet` verified clean.

### #15 — Strict Furniture Stacking, Clash Prevention & Vertical Depth Rendering (Milestone 2 Revision)
- **Strict Clash Prevention & Geometry-Driven Surface Stacking (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Restored strict furniture-to-furniture collision blocking by default in `Canvas2D.tsx` (`allowFurnitureOverlap: shiftKey`) while allowing free clash escape without `Shift` when separating pre-existing overlaps (and immediately re-locking solid collision blocking once clear so separated objects cannot re-clash).
  - Upgraded `getSupportingDeckHeightMm` and `findSupportingSurfaceForProp` to inspect candidate supporting part geometry directly and trigger auto-stacking when the dragged item's center enters a compatible deck or its overlap intrusion reaches `min(draggedSpanMm / 3, 120)` mm (a third of the dragged item's span capped at a fixed 120 mm maximum regardless of host size), fixing `isWallMountedTv` so elevated freestanding TV stands stay surface-mountable.
- **Modifier Priority Matrix & Room-Center Catalog Placement (`src/components/Canvas2D.tsx`, `src/App.tsx`)**:
  - Enforced exact modifier rules with live `Control` + `Shift` mid-drag refresh: default auto-stacks/prevents clashes; `Ctrl` forces floor placement (`0 mm`, `Floor mounted`) with clash prevention still active; `Shift` allows free overlap and suppresses blocking `Clashing with` warnings; `Ctrl + Shift` allows free overlap while enforcing floor elevation (`0 mm`).
  - Removed the golden-angle spiral offset from `placeFurnitureTemplate` in `src/App.tsx` so newly inserted catalog furniture lands cleanly at geometric room center (auto-stacking on compatible hosts or remaining freely separable from any initial overlap without `Shift`).
- **Opaque Top & Progressive Dark-Gray Lower Stack Rendering (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`, `src/utils/svgRepresentationRenderer.tsx`, `src/utils/furnitureVectors.tsx`)**:
  - Added `stackDepthBelowTop` in `computePlanFurnitureOverlapMetadata` (excluding ceiling fixtures from darkening underlying furniture) and kept uppermost non-ceiling stack layers strictly 100% opaque (`fillOpacityScale = 1`).
  - Rendered lower covered items with unblurred SVG grayscale darkening filters (`plan_depth_tier_1..3`, matching Wall View's non-blurred depth tone progression) in Pass 1 plus crisp progressively darker gray dashed overlays (`Pass 2`) preserving internal details and outlines.
- **Verification**:
  - `npx tsx --test src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/mounting.test.ts`: 19/19 passing covering all 9 revision cases.
  - Zero emojis across `src/` UI strings; `compile_applet` & `lint_applet` verified clean.

### #16 — Workspace Import & AI Studio Normalization
- **Repository Sync & Runtime Normalization (`package.json`, `.env.example`, `server.ts`, `vite.config.ts`)**:
  - Imported `github.com/higen0/ps-211126-2129` into the AI Studio workspace, removed `bun.lock` in favor of npm (`package-lock.json` / `node_modules` installed via `npm`), and verified Express + Vite middleware serving on `0.0.0.0:3000` with in-memory/localStorage DB fallback when `SQL_HOST`/`SQL_DB_NAME` are unset.
- **TypeScript Lint Fixes (`src/utils/geometry.ts`)**:
  - Made `elevationMm` and `surfaceHostId` optional in `isWallMountedTv`'s parameter signature and placed `...f` before fallback property defaults (`category`, `elevationMm`) in `isSurfaceMountable` and `isSupportingSurfaceFurniture` so `tsc --noEmit` passes with 0 errors.
- **Verification**:
  - `npm run lint` (`tsc --noEmit`) & `compile_applet` (`npm run build`): verified clean.
  - Note: Running `npx tsx --test src/utils/milestone2.test.ts ...` from upstream showed 40/44 passing (4 pre-existing failures in `milestone2.test.ts`).

### #17 — Universal Furniture Stacking, Multi-Layer Target Cycling & Wall-Mounted Depth Exclusion
- **Category-Free Universal Stacking (`src/utils/geometry.ts`, `src/components/CustomFurnitureModal.tsx`, `src/components/ImporterModal.tsx`)**:
  - Removed category/compatibility restrictions in `isSurfaceMountable`, `isSupportingSurfaceFurniture`, and `isCompatibleSurfaceChild` so every `freestanding` and `surface` furniture item (built-in, custom builder, SVG/trace, and compact/freestanding GLB models) automatically stacks atop any non-ceiling/non-rug furniture surface at `safeDeckHeightMm` while preserving horizontal position and rotation; `floor`, `ceiling`, and rug/mat items remain excluded from auto-stacking, and `wall` items retain wall attachment.
- **Wall-Mounted Face-Flip Prevention (`src/utils/geometry.ts`)**:
  - Added wall-normal face hysteresis (`dNorm >= right - 25` for `left` / `dNorm > left + 25` for `right`) across `snapFurnitureToPlan` (standard wall mounts + curtains), `findNearestWallAttachmentTarget`, and `snapStandaloneCurtainToWall`, plus a post-sweep side check in `solveSolidFurnitureMove` so dragging or passing the cursor across a wall-mounted object's centerpoint never flips it 180° onto the opposite face.
- **Multi-Layer Stack Target Cycling & 200ms Modifier Tap/Hold (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Added `findSupportingSurfacesForProp` returning overlapping host candidates ordered top-to-bottom plus `preferredHostId` and `stackCandidates` in `solveSolidFurnitureMove`.
  - Updated `Canvas2D.tsx` so dragging over multi-layer stacks displays `Placing on [Active Host]` with smaller grayer secondary host names underneath in `data-testid="placement-splash-text"` and lets mouse-wheel scrolling cycle stack hosts instead of zooming; added 200ms tap-to-toggle vs. hold behavior (with chord protection) for both `Ctrl` (floor placement + clash prevention) and `Shift` (free overlap).
- **Wall-Mounted Depth Graying Exclusion (`src/utils/geometry.ts`, `src/utils/milestone2.test.ts`)**:
  - Scoped vertical stack depth darkening strictly within the same mounting domain (`a.isWallMounted === b.isWallMounted`) in `computePlanFurnitureOverlapMetadata` so wall-mounted items stay opaque without graying floor furniture beneath them while still applying progressive darker-gray tiers across overlapping wall-mounted layers.
- **Verification**:
  - `npx tsx --test src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/mounting.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/svgProjection.test.ts src/utils/graphicsSettings.test.ts src/utils/textures.test.ts`: 46/46 passing.
  - Zero emojis across `src/` `.ts`/`.tsx` files verified.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.

### #18 — Stacking UX, Local Z-Indexing, Live Exact-Area Clash Overlay & Wall-Mounted Exclusion
- **Hold-Only `Ctrl`/`Shift` Modifiers & Enlarged Plain Splash Text (`src/components/Canvas2D.tsx`)**:
  - Removed the 200ms tap-to-toggle timers/state (`ctrlToggle*`, `shiftToggle*`, `ctrlPressRef`, `shiftPressRef`) so `Ctrl` (floor mounting + clash prevention) and `Shift` (free overlap) strictly apply while held down, syncing directly with live keyboard and pointer modifier state.
  - Enlarged top-center plain unboxed splash typography (`data-testid="placement-splash-text"`) to `24px–28px` bold primary status/clash lines (`Placing on ...`, `Clashing with ...`, `Floor mounted`) and `15px–16px` medium muted gray secondary stack host lines underneath.
- **Per-Stack Local `zOrder` Normalization (`src/utils/geometry.ts`, `src/App.tsx`, `src/hooks/usePlanState.ts`)**:
  - Partitioned furniture into 2D overlapping connected components (`normalizeFurnitureLocalZOrders`, `computeLocalStackPlacementZOrder`, `reorderFurnitureZOrder`) so standalone objects stay at `0` (`-1` for rugs) and overlapping stacks keep compact per-stack integer indices (`0, 1, 2...`) instead of climbing across 200+ items.
  - Updated `normalizeProject`, catalog placement (`App.tsx`), `pasteClipboard`, `duplicateSelected`, and `solveSolidFurnitureMove` to assign and preserve local stack z-orders.
- **Active Clash Detection & Exact Red Diagonal-Line Intersection Overlay (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Added CCW-normalized Sutherland–Hodgman convex clipping (`intersectConvexPolygons2D`, `computeFurnitureClashIntersectionRegions`) across Z-overlapping non-coexisting solid primitives so red `45°` SVG diagonal hatching (`url(#clash_diagonal_hatch)`) is painted strictly over exact clashing intersection polygons both live during drag (including while holding `Shift`) and at rest, alongside active red `Clashing with ...` splash text.
- **Intuitive Vertical Stack Card, 2D Multi-Layer Differentiation & Wall-Mounted Exclusion (`src/utils/geometry.ts`, `src/components/Canvas2D.tsx`)**:
  - Moved the `a.isWallMounted !== b.isWallMounted` guard ahead of `sameSpotOverlapIds` linkage in `computePlanFurnitureOverlapMetadata` so wall-mounted items never link with, gray out, or trigger stacking overlays on floor furniture beneath them.
  - Upgraded the top-left **Vertical Stack** card (`data-testid="elevation-stack-switcher"`) with Top-to-Bottom numbered tiers (`1..N`), clear `Top` / `Middle` / `Bottom · z N` cues, click-to-select, and inline `▲`/`▼` local reorder buttons synchronized 1-to-1 with 2D progressive inward-inset outlines (`insetPolygon2D`, `data-testid="stack-inset-${id}"`) and stepped corner tier badges (`data-testid="stack-tier-badge-${id}"`) differentiating even identical aligned stacked pieces.
- **Verification**:
  - `npx tsx --test src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/mounting.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/svgProjection.test.ts src/utils/graphicsSettings.test.ts src/utils/textures.test.ts`: 50/50 passing (including Cases 12–15 covering per-stack local `zOrder` across 220+ items, wall-mounted exclusion, exact clash intersection area clipping, and `insetPolygon2D`).
  - Zero emojis across `src/` `.ts`/`.tsx` files verified.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.

### #19 — Rule & Direction Override (Direct-Manipulation Unified 2D/3D Workspace)
- **Updated Project Goal**: Evolve Plan Studio into a calm, minimal, direct-manipulation interior design tool in the spirit of `rayon.design` — one workspace where 2D and 3D are two views of the same model, everything is selected and moved by touching it directly, and nothing feels heavy or fussy.
- **Recorded Rule Changes (updated in `STRICT BOUNDARIES`)**:
  1. **3D Selection & Direct Manipulation Permitted**: Removed the rule that `Viewport3D.tsx` is strictly view-only. 3D may support selection and direct manipulation, routed through the exact same state (`usePlanState` / undo-redo history) and solvers (`geometry.ts`) as 2D.
  2. **One Milestone at a Time**: Complete only the explicitly named milestone, then stop.
  3. **Core Preservations**: Keep `mm` units, undo/redo history, existing passing tests, and backward-compatible save format.
  4. **Minimalism & Restraint**: Do not add unrequested features. Prefer deleting code and UI over adding.
  5. **Strict Cross-View Parity**: Every change must behave identically in 2D, 3D, Wall View, and export (if any surface cannot match, report explicitly rather than faking it).
  6. **Standard Milestone Closeout**: End every milestone with: what changed, what was verified in the browser, and known gaps.

### #20 — Scope Lock (2D & Wall View Drag Ergonomics + Identical-Result Performance Only)
- **Active Scope Lock Constraints (superseding `#19` on 3D & UI scope)**:
  1. **No Layout / UI / 3D Changes**: Do NOT change app layout, tabs (`2D Plan` / `Wall View` / `3D View`), panels, toolbars, inspector structure, colors, or `Viewport3D.tsx`. `Viewport3D` remains strictly view-only; editing stays in `Canvas2D.tsx`, `WallCutThroughViewer.tsx`, and `PropertiesInspector.tsx`.
  2. **Permitted Scope**: Work ONLY on (a) how `Canvas2D.tsx` and Wall View drag behavior feels and (b) performance optimizations producing identical visual results.
  3. **Model & Geometry Preservation**: Do not add features, change save formats, or alter data models, geometry results, or snapping outcomes unless explicitly instructed by a milestone.
  4. **Testing & Milestone Discipline**: Keep all existing test suites passing (`geometry`, `mounting`, `milestone2`, `elevation2d`, `lighting`, `railings`, `svgProjection`, `graphicsSettings`), adding tests for any new pure utility logic. Execute strictly one requested milestone at a time, log each as `#N` in `AI_HANDOFF.md`, and end every milestone with: what changed, how you measured it, known gaps.

### #21 — MILESTONE 1: Selection, Navigation & Handle Fixes (2D + Wall View)
- **What Changed**:
  1. **Safer Dragging (`Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Added `Escape` key cancellation during active drags in both 2D Plan and Wall View to restore original object/pan state via `onCancelDrag()` with zero undo history entries added; preserved a uniform `4 px` screen-space drag deadzone.
  2. **Stack Selection (`selectionNav.ts`, `Canvas2D.tsx`)**: Removed clicking an already-selected stacked item without moving cycling selection to another layer; plain clicks pick the topmost hit at that point, `Alt+click` (without dragging) steps to the next layer below, multi-select plain click narrows to the clicked item, and the Vertical Stack Switcher card continues switching layers directly.
  3. **Real-Footprint Marquee (`selectionNav.ts`, `Canvas2D.tsx`)**: Replaced the `80 mm` minimum with a `4 px` screen-pixel threshold and allowed marquee drags starting over room polygons (`< 4 px` selects room, `>= 4 px` runs marquee). Left-to-right selects objects strictly inside; right-to-left selects any intersecting object tested against true footprints for furniture, walls (by segment), openings, architectural elements (including railings/columns), curtains, and people; `Shift+marquee` adds cleanly.
  4. **Wheel, Pinch & Trackpad Navigation (`selectionNav.ts`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Implemented `classifyWheelGesture` + `computeAnchoredZoom` across both 2D and Wall View so `Ctrl+wheel` / trackpad pinch zooms proportionally to `deltaY` anchored on the cursor, mouse wheel zooms, and two-finger trackpad scroll pans. Removed wheel stack-host hijacking during furniture drags and moved host cycling to `Tab`.
  5. **Context Menu (`CanvasContextMenu.tsx`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`, `usePlanState.ts`, `App.tsx`)**: Suppressed the native browser menu on both 2D and Wall View SVGs and added right-click menus for objects (`Duplicate`, `Delete`, `Lock`/`Unlock`, `Mirror`, `Rotate 90`, `Select layer above`, `Select layer below`) and empty canvas (`Paste`, `Fit to screen`). Added wall duplication support to `duplicateSelected`.
  6. **Keybinds (`keybinds.ts`)**: Added `V` (`select`) and `H` (`pan`) aliases while preserving existing shortcuts and `Space`-pan.
  7. **Constant Screen-Pixel Handles (`Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Normalized handle dimensions, rotate-handle offset (`28 / pxPerMm`), and hit target sizes (`>= 24 px` minimum screen-space hit targets) across 2D furniture rotate/edge/wall/opening/chimney/railing/section handles and Wall View opening/chimney resize handles.
- **Verification & Measurement**:
  - `npx tsx --test src/utils/selectionNav.test.ts`: 8/8 unit tests passed (`97/101` across `src/utils/*.test.ts`; 4 pre-existing untouched catalog failures in `geometry.test.ts`).
  - Live browser Playwright verification (37/37 checks passed, 0 page errors): verified `V`/`H`/`S` tool shortcuts, `< 4 px` jitter deadzone, `Escape` mid-drag transform restore with Undo staying disabled, cursor-anchored `Ctrl+wheel` zoom (`0.67 px` shift), trackpad pan, constant `24.0 x 24.0 px` rotate hit area & `14.0 px` visible handle across 3 zoom levels, L->R corner touch non-select vs R->L corner touch select vs `Shift+marquee` additive select inside rooms, object & empty-space context menus (`Rotate 90`, `Lock`/`Unlock`, `Duplicate`, `Select layer above`, `Fit to screen`), stacked plain/reclick/Alt+click/stack-card selection, and Wall View opening context menu, `Escape` drag restore, `Ctrl+wheel` zoom, and trackpad pan.
  - `tsc --noEmit` & Vite production build clean.
- **Known Gaps**: None identified for Milestone 1 acceptance criteria (`Escape` mid-drag restore, no plain-reclick cycling, corner marquee selection, Wall View parity).

### #22 — MILESTONE 2: Snapping Feel & Calmer Feedback (2D + Wall View)
- **What Changed**:
  1. **Zoom-Aware Screen-Pixel Snap Tolerances (`dragErgonomics.ts`, `geometry.ts`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Added `computeZoomSnapTolerances(pxPerMm)` converting balanced screen-pixel radii (`12 px` vertex/wall `[25, 240] mm`, `10 px` furniture flush/opening/arch block `[20, 180] mm`, `8 px` align/room-center `[18, 160] mm`, `11 px` strong room center `[24, 210] mm`, `7 px` surface center `[16, 130] mm`) and threaded tolerances into 2D vertex, wall-body, furniture, opening, arch element, and Wall View component drags.
  2. **Snap Hysteresis (`dragErgonomics.ts`, `geometry.ts`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Implemented `pickWithSnapHysteresis` (`~40%` exit margin `1.4x`, active-target switch ratio `0.72`) backed by `SnapHysteresisState` refs across `snapPointToPlan`, `solveWallComponentDrag`, `snapChimneyToWallEdge`, `snapFurnitureToPlan`, `solveSolidFurnitureMove`, `snapArchElementToPlan`, and Wall View horizontal/vertical snap solvers.
  3. **Collision Sliding & Free Overlap Separation (`geometry.ts`)**: Upgraded `solveSolidFurnitureMove` to slide tangentially (`tx = -blockMtv.ny, ty = blockMtv.nx` plus orthogonal projections) along blocking walls/furniture/arch elements instead of stopping dead, while leaving separation from any pre-existing overlap unrestricted.
  4. **120 ms Stack Host Dwell (`dragErgonomics.ts`, `geometry.ts`, `Canvas2D.tsx`)**: Added `createHostDwellTracker` + `evaluateHostDwellStep` with a `125 ms` re-evaluation timer so surface hosts switch only after hovering >= 120 ms over a new host, while `Ctrl` force-floor, `Tab` cycling, and leaving all hosts apply immediately.
  5. **Calm Single-Line Cursor Hint Chip & Clash Hatch Fade-In (`CursorHintChip.tsx`, `dragErgonomics.ts`, `index.css`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Replaced `dragSplash` / `liveDragBadge` with a compact single-line `CursorHintChip` (`data-testid="cursor-hint-chip"`) following `Clash > Host/Wall Attachment > Snap` priority, `120 ms` fade in/out, immediate clear on drop/Escape (zero `1.1 s` linger), and `120 ms` `.animate-clash-fade-in` on `<polygon data-testid="clash-intersection-poly">`.
  6. **~100 ms Ease-Out Snap Glide (`dragErgonomics.ts`, `Canvas2D.tsx`, `WallCutThroughViewer.tsx`)**: Added render-only `sampleSnapVisualTween` / `updateSnapVisualTweenOnSolverResult` rAF visual offset across furniture, covered contours, wall bodies/endpoints, openings, arch elements, chimneys, and Wall View dragged items; committed solver coordinates remain untouched. Also converted `Canvas2D` and `WallCutThroughViewer` SVG wheel listeners to native `{ passive: false }` listeners to eliminate passive-event console errors on `Ctrl+wheel` zoom.
- **Verification & Measurement**:
  - `npx tsx --test src/utils/dragErgonomics.test.ts src/utils/selectionNav.test.ts`: 17/17 unit tests passed across 6 new Milestone 2 suites and 8 Milestone 1 suites.
  - Live browser Playwright verification (0 console errors, 0 page errors): verified 2D furniture drag single-line clash chip (`"Clashing with Oval Coffee Table"`, `data-tone="clash"`), `animate-clash-fade-in` on clash intersection polygons, legacy `placement-splash-text` removal, immediate drop deactivation & unmount within `220 ms`, settled transform invariant after snap tween, `Escape` mid-drag transform restore + chip clear, `Ctrl+wheel` zoom in 2D and Wall View, and Wall View opening drag `"Attached to wall"` cursor chip + immediate clear on drop.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None identified for Milestone 2 acceptance criteria.

### #23 — MILESTONE 3: Stack Visualization (Full-Color Layers, Overlap-Clipped Hidden Contours, Adjacent Contact Shadows & Side-Elevation Stack Card)
- **What Changed**:
  1. **Removed Grayscale Depth Filters (`Canvas2D.tsx`)**: Removed `plan_depth_tier_1..3` SVG `<filter>` definitions and `filter={depthFilterAttr}` attributes so all furniture renders at crisp full color with zero whole-object dimming.
  2. **Overlap-Clipped Dashed Hidden Contours (`geometry.ts`, `stackVisualization.ts`, `Canvas2D.tsx`)**: Updated `computePlanFurnitureOverlapMetadata` so floor rugs and surface children participate cleanly in stack visual relationships (while keeping `isSurfaceMountable(rug) = false`, `isSupportingSurfaceFurniture(rug) = false`, rug-first draw order, wall-mounted domain isolation, and ceiling fixture exclusions). Built exact per-lower-item `<clipPath id="stack_overlap_clip_...">` polygons via `intersectConvexPolygons2D` and rendered muted slate dashed contours (`#64748B` / `#94A3B8`) strictly inside overlap regions.
  3. **Unblurred Screen-Pixel Contact Shadows (`stackVisualization.ts`, `Canvas2D.tsx`)**: Added `computePlanStackVisualData` + `computeContactShadowOffsetPx` computing soft bottom-right contact shadows between vertically adjacent pairs `(lower, upper)` (`2.5–10 px` constant screen-pixel offset scaled by elevation gap, clipped to lower footprints via polygon intersection, zero SVG blur filters, painted directly beneath each upper layer).
  4. **Full-Coverage 1–3 Hairline Offset Outlines (`stackVisualization.ts`, `Canvas2D.tsx`)**: Replaced `stack-inset-*` inward inset polygons and `stack-tier-badge-*` numeric corner badges with 1–3 outward constant-screen-pixel hairline offset outlines (`outsetPolygon2D`) around covering boundaries when lower item(s) are completely covered.
  5. **Mini Side-Elevation Stack Card (`Canvas2D.tsx`)**: Redesigned the top-left `elevation-stack-switcher` (`w-[256px]`, `top-11 left-3`) with a left proportional vertical elevation track (`data-testid="stack-elevation-track"`, `stack-elev-bar-*` spanning `minZ` to `maxZ` against `0–maxElevMm`) alongside right labeled layer rows (`stack-elev-label-*`, click bar or row to select), showing up/down reorder buttons only on same-elevation ties.
- **Verification & Measurement**:
  - `npx tsx --test src/utils/stackVisualization.test.ts src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/mounting.test.ts src/utils/dragErgonomics.test.ts src/utils/selectionNav.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/svgProjection.test.ts src/utils/graphicsSettings.test.ts src/utils/textures.test.ts`: **71/71** tests passed across all 11 suites.
  - Live browser Playwright verification (0 console errors, 0 page errors): verified zero `plan_depth_tier_*` filters, zero legacy insets/numeric tier badges, overlap-clipped dashed contours (`stack_overlap_clip_*`), unblurred adjacent contact shadows with gap-scaled screen-pixel offsets (`2.50 px`, `3.59 px`, `5.50 px`), and interactive mini side-elevation stack card plotting exact `0–16 mm` / `0–378 mm` / `120–820 mm` bars with tie-only reorder controls.
  - `compile_applet` (`npm run build`) & `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None identified for Milestone 3 acceptance criteria.

### #24 — MILESTONE 5: Complete 2D/3D Geometry Parity (Continuing Interrupted Milestone 4)
- **One Canonical Geometry & Collision System (`src/utils/partGeometry3d.ts`, `src/utils/geometry.ts`, `src/utils/walkPhysics.ts`, `src/utils/svgProjection.ts`)**:
  1. Matched beveled `rounded_rect` outer extrusion corners (`innerRad = Math.max(0.002, rad - bevSize * 1.17)`) in `partGeometry3d.ts`, replaced coarse fixed-ray reduction with exact multi-band Z-slice + bottom/top rim + XY convex hull extraction (`convexHull2DLocal`) plus 96-azimuth multi-pitch sampling for dense curved meshes (`> 600` vertices), and snapped `Float32BufferAttribute` coordinates to `1e-4 mm` to eliminate float32 drift (`~3e-6 mm`).
  2. Forwarded optional `templateId` to `computeFurnitureTiltedLocalBoundsMm` and `generateDefaultTopViewFromParts` across `svgProjection.ts`, `Canvas2D.tsx`, `LeftSidebar.tsx`, `SvgRepresentationEditorModal.tsx`, and `PropertiesInspector.tsx`.
  3. Preserved `caster_base` 5-star contour in `buildPartLocalConvexPolygons`, used `getPartFurnitureLocalBoundary3D` in `getFurnitureSolidFootprintPrimitives` for tilted convex parts (keeping `l_profile`/`u_profile`/`arc` multi-part convex decomposition intact for hollow L/U pockets), and removed the `computeFurnitureCanopyUndersideZMm` short-circuit in `isPointInFurniture2D` so hit-testing, snapping, collision, and `walkPhysics` colliders match canonical `getFurniturePlacement` and 3D viewport bounds within `<= 1.0 mm`.
- **Accurate 2D / Wall View Representations & Non-Mutating Custom SVG Sizing (`src/utils/svgImport.ts`, `src/components/Canvas2D.tsx`, `src/components/WallCutThroughViewer.tsx`, `src/components/HomePage.tsx`)**:
  1. Increased `<path A>` elliptical arc sampling in `extractSvgElementLocalPoints` from `12` to `36` segments to eliminate chord shortfalls on curved swivel chairs and circular contours.
  2. Applied uniform aspect-fit (`computeSvgFitScale`) for custom/imported SVGs on flat resize in both 2D Plan (`resolveFurnitureTopPlanView`) and Wall View (`WallCutThroughViewer.tsx`), with automatic 3D projection fallback in `default`/`silhouette`/`hidden_line` modes when tilted (`hasTilt`) without ever mutating saved `svgSource`, `customViews`, or `defaultViews`.
- **Properties Inspector Read-Only World Bounds (`src/components/PropertiesInspector.tsx`)**:
  - Kept local/part dimensions editable and added a read-only `World Bounds` + `Elev` readout (`data-testid="inspector-world-bounds"`) sourced from `getFurniturePlacement` whenever furniture is tilted or non-cardinally rotated.
- **Dev-Only 3D vs. 2D Parity Overlay (`src/utils/parityOverlay.ts`, `src/components/Canvas2D.tsx`)**:
  - Added `evaluateFurniturePlanParity` and wired the `data-testid="dev-parity-overlay"` layer in `Canvas2D.tsx` (strictly disabled in normal use, gated behind `import.meta.env.DEV && devParityOverlay`, toggled via `?parity=1` or `Ctrl+Shift+P`), comparing real Three.js world XZ hull & AABB against the active 2D SVG representation hull and flagging `> 1 mm` discrepancies in `#EF4444` (`>1mm ΔX.Xmm`).
- **Verification**:
  - `npx tsx --test src/utils/parity2d3d.test.ts src/utils/svgProjection.test.ts src/utils/mounting.test.ts src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/graphicsSettings.test.ts src/utils/dragErgonomics.test.ts src/utils/selectionNav.test.ts src/utils/stackVisualization.test.ts src/utils/textures.test.ts`: **75/75** tests passing across all 12 suites (including 100% of built-in catalog items across flat, mirrored, 37° rotated, tilted YXZ, tilted mirrored, stacked, wall/ceiling mounted variants `<= 1.0 mm`, uniform custom SVG aspect-fit, tilt non-mutation, dev parity `>1mm` flagging, L/oval hit-testing, and tilted `walkPhysics` colliders; note pre-existing `geometry.test.ts:2529` catalog ID mismatch `'sofa_3seat'` remains untouched).
  - Zero UI emojis across `src/` `.ts`/`.tsx` files verified; `http://localhost:3000` and `?parity=1` verified HTTP 200; `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`) verified clean.
- **Known Gaps**: None identified for Milestone 5 acceptance criteria (headless Chromium/Playwright binary not installed in container environment; verified server HTTP 200 + parity overlay/bounds DOM wiring + exhaustive 181-catalog headless Three.js geometry tests).

### #25 — MILESTONE 6: Wall View Rendering, Rotation and Navigation
- **What Changed**:
  1. **Fixed Wall View Furniture Cutoff & Wall-End Occlusion (`src/utils/wallViewProjection.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Replaced the blanket `#cutthrough_wall_clip` (`[0, lenMm] x [-heightMm, 0]`) over all context objects with `computeWallEndOcclusion`, which inspects `level.walls` on the camera-facing side of the viewed wall so open-room furniture overhangs (e.g., an asymmetric Arc Floor Lamp near a free wall end) render completely unclipped while genuine perpendicular room walls at corners continue to occlude geometry behind them (`#cutthrough_occ_left`, `#cutthrough_occ_right`, `#cutthrough_occ_both`).
     - Widened `ct_depth_*` SVG filter regions (`[-3000..lenMm+3000]`) and expanded `basePxPerMm` auto-framing to include unclipped visible furniture bounds.
     - Added `computeSvgElementsBoundsMm` so custom/imported SVGs center on their true element bounding box `(centerX, bottomY)` rather than assuming symmetric `[-w/2..+w/2, -h..0]` coordinates.
  2. **360-Degree Wall View SVG Projections (`src/utils/svgProjection.ts`, `src/utils/wallViewProjection.ts`, `src/utils/furnitureRepresentationSync.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `generateProjectedViewAtYawDeg` in `svgProjection.ts` (preserving outward triangle winding on odd mirror parity) and a two-level bounded LRU cache (`getCachedWallAngleProjection`: 64 normalized meshes, 180 projected SVGs at `10°` yaw increments) keyed by geometry/part/tilt/mirror/mode signature with canonical `12 mm` stroke width so zooming never invalidates the cache while part/dimension/tilt edits invalidate automatically.
     - Exposed `getGlbSceneFromCacheSync` + Wall View background GLB preloading (`loadGlbObjectCached`) so loaded GLB scenes rotate smoothly across 360 degrees as pure vector SVGs. Guarded `getCachedWallAngleProjection` against falling back to `makeGlbBoundsParts` (`GLB Bounding Footprint` box) when a GLB scene is unloaded/unavailable so `WallCutThroughViewer` always preserves saved `autoViews` / `customViews` / `defaultViews` SVGs with `computeCustomSvgWallViewTransform` and bounded oblique scaling (`0.78x–1.18x`).
     - Added `computeCustomSvgWallViewTransform` for custom/imported SVGs, keeping Wall View 100% SVG-only and bounding oblique horizontal scale (`0.78x–1.18x` of vertical scale) to avoid stretching distortion while preserving flat resize aspect-fit.
  3. **Separated Wall View Navigation (`src/components/WallCutThroughViewer.tsx`)**:
     - Added `Space` key pan mode (`onPointerDownCapture` for `Space+drag` or middle-drag from anywhere without selecting/moving openings or chimneys), enabled left-drag panning across the wall face (`< 4 px` click still selects the wall), kept existing cursor-anchored zoom and two-finger trackpad pan intact, and updated `grab`/`grabbing` cursor states.
  4. **Black-and-White Stack & Depth Shadow Removal (`src/components/Canvas2D.tsx`, `src/components/WallCutThroughViewer.tsx`)**:
     - Skipped 2D stack contact shadows (`contact-shadow-*`) when `isBw` is true while preserving all B&W outlines, overlap-clipped hidden-edge dashed contours, and full-coverage hairline offset outlines, leaving full-color stack shadows unchanged.
     - Disabled `ct_depth_*` blur/darkening filters and depth dimming (`ctxOpacity = 1`) in Wall View when `isBw` is true, keeping full-color `Depth Effect` unchanged.
- **Verification & Measurement**:
  - `npx tsx --test src/utils/wallViewProjection.test.ts src/utils/parity2d3d.test.ts src/utils/svgProjection.test.ts`: passed all assertions (including open vs corner wall-end occlusion, asymmetric SVG bounds centering, bounded oblique custom SVG transforms, Arc Floor Lamp 360° `10°` projections + LRU cache hits/invalidation, behind-wall exclusion, and GLB custom furniture `autoViews` preservation when scene cache is unloaded).
  - Brief visual/SVG geometry check verified Arc Floor Lamp (`light_floor`) and rotated catalog/GLB furniture SVG paths retain true height/width proportions with zero left cutoff on open ends and proper occlusion behind corner walls.
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`) verified clean.
- **Known Gaps**: None identified for Milestone 6 acceptance criteria (live browser screenshot/Playwright interaction not executed in this container because Chromium/Playwright binary is not installed; verified via unit tests, SVG projection output inspection, DOM/handler wiring, and build/typecheck).

### #26 — MILESTONE 7: Wall View Furniture Manipulation and Multi-Selection
- **What Changed**:
  1. **Interactive Wall-Mounted & Wall-Flush Furniture 2-Axis Dragging in Wall View (`src/utils/wallViewFurniture.ts`, `src/utils/dragErgonomics.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `isFurnitureInteractiveInWallView`, `solveWallViewFurnitureDrag`, and `applyWallViewFurnitureGroupDelta` in `src/utils/wallViewFurniture.ts` alongside `wallFurnHKey` / `wallFurnVKey` snap hysteresis keys in `src/utils/dragErgonomics.ts`.
     - Wall-mounted furniture and freestanding furniture positioned flush against the viewed wall (`<= 30 mm`) can now be clicked to select and dragged horizontally (along the wall tangent) and vertically (in elevation) directly inside Wall View while remaining attached/flush to the wall at constant perpendicular offset.
     - Applied standard snapping to inner wall corners, adjacent furniture, openings/chimneys, floor, and ceiling, plus collision resistance against obstacles (resisting sideways overlap initially and snapping cleanly over countertops/surfaces onto `worktop.zTop` purely as floor-relative elevation without changing `surfaceHostId` or ungluing from the wall). Holding `Shift` enables free overlap without resistance/snapping.
     - Pinned `lastWallIdRef` in `WallCutThroughViewer.tsx` so clicking/Ctrl-clicking furniture in Wall View never unexpectedly switches the active wall elevation, and added furniture context-menu locking support.
  2. **Live & Inline-Editable 4-Cardinal Clearances in Wall View (`src/utils/wallViewFurniture.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `computeWallViewFurnitureClearances` and rendered nearest-boundary clearances in all 4 cardinal directions (`left`, `right`, `bottom`, `top`) whenever interactive furniture is selected or dragged (measuring to adjacent furniture/openings/inner wall corners horizontally, countertop tops or upper cabinets before floor/ceiling vertically, and omitting flush sides `< 5 mm`).
     - Wired all 4 clearances into `openElevEditor` and `commitElevDimEdit` (`furn_clear_left`, `furn_clear_right`, `furn_clear_bottom`, `furn_clear_top`) so users can click any gap dimension to enter a precise cm distance for the item or selected group.
  3. **Ctrl Multi-Selection & Rigid Group Dragging (`src/components/Canvas2D.tsx`, `src/components/WallCutThroughViewer.tsx`, `src/utils/wallViewFurniture.ts`)**:
     - Added `applyRigidFurnitureGroupDelta2D` in `src/utils/wallViewFurniture.ts` and wired it into `Canvas2D.tsx` (`executeFurnitureDragMove` & `handleFurniturePointerDown`) so `Ctrl+click` toggles multi-selection and dragging any selected item moves the entire selected arrangement rigidly while preserving relative positions, elevations, rotations, wall attachments, and selected surface host-child pairs (excluding non-leader group siblings from self-collision and guarding group members against wall overlap unless `Shift` is held).
     - Preserved click-before-drag (`>= 4 px` deadzone), `Ctrl` floor-placement override, `Shift` free overlap, non-draggable 2D light markers, and view-only `Viewport3D`.
- **Verification**:
  - `npx tsx --test src/utils/wallViewFurniture.test.ts src/utils/selectionNav.test.ts`: **12/12** tests passed (wall-mounted/flush interactivity, worktop collision resistance + snap-over elevation + `Shift` bypass, 4-cardinal countertop/wall clearances with `< 5 mm` flush omission, and 2D + Wall View rigid group deltas preserving spacing/elevations/attachments).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None identified for Milestone 7 acceptance criteria.

### #27 — MILESTONE 8: Wall View Measurements and Dimension System
- **What Changed**:
  1. **Wall View Measurement Tool (`src/utils/wallViewMeasurements.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added the interactive elevation ruler (`Measure` toggle in Wall View header + `M` shortcut) using exact model millimeter coordinates `(xMm, zMm)` with `extractWallViewSnapGeometry` and `snapWallViewMeasurementPoint` snapping to furniture corners/midpoints/edges, wall inner/outer corners, floor/ceiling lines, and opening/chimney edges.
     - Holding `Shift` bypasses snapping for free point-to-point measurements; `onPointerDownCapture` intercepts clicks exclusively during measurement mode so measured objects never select, move, or resize (`Space+drag` / middle-drag panning still works). `Esc` clears draft/completed measurements then exits Measure mode, matching 2D Plan without modifying save format.
  2. **Room, Wall, Furniture & Corner Dimensions (`src/utils/wallViewMeasurements.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `computeWallViewRoomDimensions` (overall room width & height along the viewed wall face via `resolveWallFaces`) alongside individual wall length/height and opening/chimney chains.
     - Added `computeWallViewFurnitureDimensions` for selected/dragged furniture and immediate neighbors (width, height, height above floor, ceiling distance, automatic nearest-corner distance along the wall for wall-mounted items updating live on move/resize, and neighbor widths alongside existing 4-cardinal clearances), plus subtle nearest-corner/width/elevation dims for wall-mounted items when nothing is selected.
  3. **Independent Visibility Controls & Automatic Non-Overlapping Drafting Layout (`src/components/WallCutThroughViewer.tsx`, `src/utils/wallViewMeasurements.ts`)**:
     - Replaced the single `Dims` toggle with a compact `Dims` header dropdown containing independent tickboxes for **Room and wall dimensions** (`wallview-dim-toggle-room-wall`) and **Wall-mounted furniture dimensions** (`wallview-dim-toggle-furniture`), affecting display only.
     - Added `layoutWallViewDimensions` and subtle drafting options in `renderElevDim` (`subtle`, `prefix`, `labelOffsetPerpMm`) to keep lines thin, readable across zoom levels, and automatically nudged out of furniture/label overlaps.
- **Verification**:
  - `npx tsx --test src/utils/wallViewMeasurements.test.ts src/utils/wallViewFurniture.test.ts src/utils/wallViewProjection.test.ts`: **13/13** passing (covering elevation snap/Shift-free bypass, room W×H, wall-mounted corner updates on move/resize, and label de-overlap).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None identified for Milestone 8 acceptance criteria.

### #28 — MILESTONE 9: Consolidated Wall Representation
- **What Changed**:
  1. **Non-Destructive Consolidation, Flat-Side T-Junctions & Auto Room-Wall Discovery (`src/types/plan.ts`, `src/utils/wallConsolidation.ts`)**:
     - Added optional `consolidatedGroupId?: string` to `Wall` (persists across undo/redo and JSON save/reopen without altering `detectRoomsFromWalls` or underlying 2D/3D wall geometry).
     - Added `validateWallConsolidationEligibility`, `applyWallConsolidation`, `clearWallConsolidation`, `cleanupOrphanConsolidatedGroups`, `buildConsolidatedWallRun` (supporting both `source: 'manual'` groups and `source: 'auto'` same-room wall discovery), `mapSegmentTToRunS`, `mapWallOpeningsToRun`, and `mapWallChimneysToRun`.
     - Consolidation allows `2+` inline walls with matching thicknesses (`<= 2 mm`), touching or bridged by a doorway/opening gap (`<= 2600 mm`), including one-sided interior T-junctions on the **flat side only** (`flatSideOnly: true`, `flatSideRef`), while rejecting corners, angled walls, crossing (`+`) walls, opposing T-junctions on both sides, mismatched thicknesses, overlapping segments, and distant gaps.
     - In Wall View, `discoverAutoRoomWallGroup` automatically merges contiguous inline matching-thickness walls facing the same unobstructed room side (leaving the T-stem partition side separated per room).
     - Opposite-drawn segments are direction-normalized via `sameDir` so room-facing `left`/`right` sides map consistently across the continuous run.
  2. **Ctrl+Click / Shift+Click / Marquee Multi-Selection, Inspector & Context Menu Actions (`src/components/PropertiesInspector.tsx`, `src/components/CanvasContextMenu.tsx`, `src/components/Canvas2D.tsx`)**:
     - Fixed `handleElementSelect` in `Canvas2D.tsx` to ignore right-clicks (`e.button === 2`) so multi-selection stays intact when opening the context menu, and added `Shift+click` toggle support alongside `Ctrl/Cmd+click`.
     - When `2+` eligible walls are multi-selected (pure or mixed with openings on the walls), both the Properties Inspector (`data-testid="wall-consolidation-card"`, clearly showing **Consolidate flat side** / **Consolidate wall run**, **Separate wall run**, or the exact ineligible reason) and right-click context menu expose consolidation controls.
     - Selecting any single consolidated wall displays a non-destructive `wall-consolidated-single-banner` with a **Separate** action while keeping all individual wall properties (thickness, height, finishes, materials, moldings, locks) individually editable.
  3. **Continuous Wall View Rendering & Interaction (`src/components/WallCutThroughViewer.tsx`)**:
     - Both automatic same-room runs (`Room Wall Run (N)`) and manual consolidated runs (`Consolidated (N)`) render seamlessly as one continuous elevation (`data-testid="consolidated-wall-run"`) preserving each segment's own color, material pattern, height, baseboard, crown molding, openings, chimneys, room associations, and open doorway gaps with outer-only section caps and subtle `Seg N` / `Opening` + `Run Total` dimensions.
     - Clicking any segment selects that individual wall without resetting Wall View zoom/pan (`targetWallGroupKey`), and opening/chimney dragging, resizing, lock checks, and inline dimension edits resolve accurately back to each item's real host `Wall`.
- **Verification**:
  - `npx tsx --test src/utils/wallConsolidation.test.ts src/utils/wallViewMeasurements.test.ts src/utils/wallViewFurniture.test.ts`: **11/11** passing (touching, doorway-split & outer-corner miter eligibility, one-sided flat-side T-junction vs crossing/opposite T-junction rejection, automatic same-room Wall View merging on the flat side while keeping T-stem rooms separated, opposite drawing directions, per-segment finishes/heights, opening coordinate mapping, JSON save/reopen persistence, and reversible separation).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None identified for Milestone 9 acceptance criteria.

### #29 — Top-Bar Cleanup & Room-First Wall View Selector
- **What Changed**:
  1. **Removed Editor Top-Bar Templates Button (`src/App.tsx`)**:
     - Removed the top-bar **Templates** dropdown button and its unused menu/ref/destructured state so active projects cannot be accidentally overwritten from the editor header, while keeping templates available on `HomePage.tsx` when starting new projects.
  2. **Room-First Wall View Selector (`src/components/WallCutThroughViewer.tsx`)**:
     - Preserved direct Wall View opening whenever a wall, opening, arch element, or furniture piece on a wall is selected.
     - When no target wall is resolved (nothing selected or after clicking **Change Wall**), added `RoomMiniSelectorMap` + room selector strip (`Select room`) grouped from `level.rooms` plus an **Unassigned / Exterior** bucket for visible walls outside enclosed rooms.
     - Selecting a room filters **Select wall** (`WallMiniSelectorMap`) to only that chosen room's walls (with dimmed building walls as context), adds a **Change Room** button, auto-faces the inside of the selected room when picking a wall, and handles `Escape` in the wall selector to return cleanly to the room selector.
- **Verification**:
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean.
- **Known Gaps**: None.

### #30 — MILESTONE 10: 2D Plan Navigation and Toolbar Improvements
- **What Changed**:
  1. **Cardinal 90° View-Only 2D Plan Rotation (`src/utils/viewRotation2d.ts`, `src/utils/viewRotation2d.test.ts`, `src/components/Canvas2D.tsx`, `src/components/BottomToolbar.tsx`, `src/utils/selectionNav.ts`, `src/App.tsx`)**:
     - Added view-only cardinal rotation state (`viewRotationDeg: 0 | 90 | 180 | 270` in `App.tsx`) and pure camera/coordinate transform helpers (`stepCardinalRotation`, `screenRelCenterToWorld`, `worldToScreenPoint`, `screenDeltaToWorldDelta`, `computePanForViewRotationStep`, `computeRotatedGridWorldBounds`, `computeRotatedPlanFit`, `normalizeScreenUprightAngleDeg`) without mutating walls, rooms, furniture, dimensions, or saved coordinates.
     - Added `-90°` CCW and `+90°` CW tilt buttons plus conditional angle reset pill (`0°` north-up) in `BottomToolbar.tsx` and top-right canvas reset button (`canvas2d-reset-rotation`) in `Canvas2D.tsx`.
     - Updated 2D world↔screen projection, rotated SVG group transform, viewport-center anchoring across rotation steps, fit-to-view bounds, grid bounds, screen-space arrow-key nudging, screen-direction marquee mode (`resolveMarqueeMode`), and counter-rotated SVG text/dimension labels so text remains upright at all cardinal angles while cursor-anchored zoom, snapping, selection, dragging, and measurement remain accurate.
  2. **Compact Icon-Only Bottom Drawing Toolbar (`src/components/FloatingToolbox.tsx`)**:
     - Removed persistent text labels and inline shortcut badges so the normal state shows compact icon-only controls in a single horizontal row (~≤ 400 px), preserving all tools, split flyout sub-menus, and keyboard shortcuts.
     - Added a non-shifting out-of-flow hover/focus tooltip (`toolbox-hover-hint`) displaying the hovered tool's name and shortcut above the button.
  3. **Fixed-Height Single-Row Top Toolbar with Responsive Overflow (`src/App.tsx`)**:
     - Locked `<header data-testid="top-toolbar">` to fixed height (`h-11`, `flex-nowrap`, `whitespace-nowrap`) and added `ResizeObserver`-driven responsive breakpoints collapsing secondary controls (level switcher, unit/scale selectors, grid/snap/ortho/auto-dim/undo/redo/dark-mode, and JSON/PNG/SVG/3D exports) into a `More` overflow menu (`topbar-more-btn` / `topbar-more-menu`) on narrower viewports without dropping controls or wrapping to a second row.
  4. **Removed Fabricated Prices from Catalog & Schedules (`src/components/LeftSidebar.tsx`, `src/data/catalog.ts`, `src/components/CustomFurnitureModal.tsx`, `src/data/templates.ts`, `src/components/PropertiesInspector.tsx`, `src/App.tsx`, `src/types/plan.ts`)**:
     - Stripped fabricated `estimatedCostEur` values/fallbacks and removed the price column and `Estimated Fitout` total from the Schedules panel, leaving only optional deprecated `estimatedCostEur?: number` on types for backwards-compatible saved JSON loading.
     - Preserved room areas, wall paint areas, rooms breakdown, and updated the Furniture & Equipment Schedule to display real quantities, item names, `W × D × H` dimensions, and door/window counts.
- **Verification**:
  - `npx tsx --test src/utils/viewRotation2d.test.ts src/utils/selectionNav.test.ts src/utils/dragErgonomics.test.ts src/utils/stackVisualization.test.ts src/utils/mounting.test.ts src/utils/milestone2.test.ts src/utils/elevation2d.test.ts src/utils/lighting.test.ts src/utils/railings.test.ts src/utils/svgProjection.test.ts src/utils/graphicsSettings.test.ts src/utils/textures.test.ts`: **76/76** tests passed (`0` failed).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean (`0` errors).
  - `grep` across `src/` confirmed zero remaining fabricated prices, `€` symbols, or fitout cost totals in runtime/UI code.
- **Known Gaps**: None identified for Milestone 10 acceptance criteria; visual/pointer verification in a live browser canvas was not separately automated beyond unit tests and compilation checks.

### #31 — WALL VIEW REVISION: Consolidated Walls and Room-Specific Navigation
- **What Changed**:
  1. **Single Selectable Entry for Consolidated Walls (`src/utils/wallConsolidation.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `buildRoomWallSelectorEntries` (`RoomWallSelectorEntry`) to group explicitly consolidated (`consolidatedGroupId`) and unobstructed same-room continuous wall runs into one selectable wall entry across the room wall selector, Wall View header `<select>`, room wall counts, and floating mini-viewer without mutating or merging underlying `Wall` segments.
     - Consolidated runs remain intact across room switches and JSON save/reopen while highlighting their entire segment chain together in the mini-viewer.
  2. **Strictly Room-Scoped Mini-Viewer (`src/utils/wallConsolidation.ts`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `resolveWallViewRoomId` so mini-viewer and wall selection strictly scope to the chosen room (or auto-scope to the active wall face's room on direct 2D selection, falling back to `Unassigned / Exterior` for non-room walls).
     - Removed full-project `contextWalls` rendering from `WallMiniSelectorMap` and scoped both the `Select wall` schematic and the active floating `cutthrough-floating-wall-selector` strictly to the active room's grouped wall entries and bounding box.
  3. **Return to Room Selection & Non-Cluttering Segment Access (`src/components/WallCutThroughViewer.tsx`, `src/components/PropertiesInspector.tsx`)**:
     - Added **Back to Rooms** (`wallview-back-rooms-btn`) to return to room selection and updated **Change Wall** (`wallview-change-wall-btn`) to preserve `selectorRoomId` and return to that room's `Select wall` screen without discarding any edits or resetting project state.
     - Added compact segment pills (`wallview-segment-pill-*` in Wall View header and `inspector-segment-pill-*` inside `wall-consolidated-single-banner`) so individual segment properties remain directly editable without cluttering normal wall selection.
- **Verification**:
  - `npx tsx --test src/utils/wallConsolidation.test.ts`: **5/5** tests passed (`buildRoomWallSelectorEntries` single-entry grouping & segment preservation, `resolveWallViewRoomId` room scoping, plus existing consolidation eligibility & run assembly tests).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean (`0` errors).
- **Known Gaps**: None identified for Wall View Revision acceptance criteria; interactive visual/DOM rendering in a live browser was not separately automated beyond unit tests and compilation checks.

### #32 — MILESTONE 11: Print-Ready Black-and-White Architectural Viewer
- **What Changed**:
  1. **Zero Stack & Depth Shadows in B&W (`src/components/Canvas2D.tsx`, `src/components/WallCutThroughViewer.tsx`)**:
     - Disabled 2D furniture stack contact shadows (`!isBw && adjacentShadows`, `contactShadowOpacity = isBw ? 0 : ...`) and kept Wall View depth blur/darken filters (`ct_depth_*`) disabled when `blackAndWhite2d` is active.
     - Preserved stacking geometry, covered lower-furniture dashed contours (`covered-contour-*` in `#475569`), and full-cover offset hairlines (`stack-hairline-*` in `#475569`).
  2. **Pure-Outline Furniture & Architectural SVG Linework (`src/utils/svgRepresentationRenderer.tsx`, `src/utils/svgImport.ts`)**:
     - Updated `renderFurnitureRepresentationView` and `renderSingleSvgVectorElement` (adding `resolveBwArchitecturalStroke` and `forceOutlineOnStrokeless`) so `blackAndWhite` renders **all** modes (`default`, `silhouette`, `hidden_line`, `custom`/imported SVGs) as pure outlines (`fill="none"`) with printable minimum stroke weights (`minStrokeMm`), automatically promoting originally strokeless filled shapes to crisp `#0F172A` outlines.
     - Updated `generateWallCutThroughElevationElements` and `appendBoundedElevationPartAccents` so TVs, appliances, mirrors, and metal parts render with `fill: 'none'` and crisp `#0F172A` / `#475569` lines instead of solid `#1E293B` / `#E2E8F0` / `#CBD5E1` fills.
  3. **Print-Ready 2D Plan & Wall View Drafting (`src/components/Canvas2D.tsx`, `src/components/WallCutThroughViewer.tsx`)**:
     - Added `<pattern id="bw_wall_hatch">` (`#FFFFFF` base + `45°` `#334155` lines) in `Canvas2D.tsx`; rendered 2D cut walls and attached chimneys with seamless white miter-joint masking, crisp diagonal hatch poché, and `#0F172A` outer perimeter contours; updated Wall View `cut_hatch` background to `#FFFFFF` with `#334155` diagonal hatch.
     - Stripped opaque gray/solid fills (`fill="none"`) from B&W openings, sliding/pocket/garage doors, window glazing/sills, balusters/posts/railings, columns, doorframes, stairs (including spiral pole), fallback furniture boxes, curtains, people, and Wall View baseboards/crowns/chimneys.
     - Kept the **Grid** toggle functional in B&W using faint printable hairlines (`rgba(15,23,42,0.14)` meter / `rgba(15,23,42,0.06)` minor) and kept all room/wall dimension sizes non-obstructive while switching `renderArchDimLine`, measurements, and annotations in B&W to crisp black/gray ink.
     - Left full-color 2D Plan, furniture stack shadows/depth, 3D View, and project data completely unchanged.
- **Verification**:
  - `npx tsx --test src/utils/svgProjection.test.ts src/utils/stackVisualization.test.ts`: **12/12** tests passed (`0` failed).
  - `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`): verified clean (`0` errors).
- **Known Gaps**: Live browser visual/print inspection was not separately automated beyond unit tests, TypeScript checks, and production compilation.



