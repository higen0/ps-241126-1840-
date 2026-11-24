import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import {
  ArchElement,
  Curtain,
  EditorTool,
  FurnitureInstance,
  FurniturePart,
  Level,
  Opening,
  PersonInstance,
  Point2D,
  ProjectSettings,
  RailingPathNode,
  RailingStyleId,
  SelectionTarget,
  Wall,
} from '../types/plan';
import { applyRigidFurnitureGroupDelta2D } from '../utils/wallViewFurniture';
import {
  AttachmentTargetPreview,
  ConnectedWallLengthResult,
  AlignmentGuide,
  buildWallDimensionChain,
  computeFurnitureClashIntersectionRegions,
  computePlanFurnitureOverlapMetadata,
  computeAttachedChimneyTransform,
  computePolygonAreaM2,
  computePolygonPerimeterM,
  computeSurfaceLocalCoords,
  computeWallInnerBounds,
  computeWallPolygon,
  dist,
  findConnectedWallEndpoints,
  findFurnitureHitsAtPoint,
  findNearMissWallGaps,
  getChimneyCornerPin,
  getChimneyTouchingEdges,
  getDefaultChimneyFaceColors,
  getEffectiveFurnitureZOrder,
  getFurnitureOrientedCorners,
  getFurniturePlacement,
  getFurnitureSolidFootprintPrimitives,
  getNonCrossingClearances,
  getWallArcLength,
  getWallCenterlinePoint,
  getWallMountedComponents,
  healNearWallGaps,
  isCeilingFixture,
  isFixedSizeFurniture,
  isRugFurniture,
  lerpPoint,
  pointInPolygon,
  polygonCentroid,
  projectPointOnSegment,
  propagateParentFurnitureTransforms,
  propagateWallAttachments,
  reorderFurnitureZOrder,
  resolveChimneyFaceColors,
  resolveWallFaces,
  snapArchElementToPlan,
  snapChimneyToWallEdge,
  snapPointToPlan,
  snapStandaloneCurtainToWall,
  solveChimneyResize,
  solveConnectedWallLengthChange,
  solveSolidFurnitureMove,
  solveWallClearanceEdit,
  solveWallComponentDrag,
  solveWallComponentResize,
  sortFurnitureByElevationForPlan,
  splitWallAtPoint,
  wallOffsets,
} from '../utils/geometry';
import {
  remapBacksplashesOnWallSplit,
  resolvePatternMetrics,
} from '../utils/materialPattern';
import { VectorSurfacePatternDef } from '../utils/materialPatternSvg';
import {
  isFurnitureLightingActive,
  isFurnitureLightObject,
  resolveEffectiveFurnitureLights,
  resolveLightSourceHex,
} from '../utils/lighting';
import {
  computeSvgFitScale,
  generateDefaultTopViewFromParts,
  isValidSvgSource,
  parseSvgSourceToProjectedView,
  resolveEffectiveRepresentationMode,
} from '../utils/svgImport';
import {
  getEffectiveViewElements,
  hasCustomView,
  renderFurnitureRepresentationView,
} from '../utils/svgRepresentationRenderer';
import { evaluateFurniturePlanParity } from '../utils/parityOverlay';
import {
  DEFAULT_RAILING_STYLE,
  buildRailingArchElementFromWorldPoints,
  computeRailingPathMetrics,
  computeStaircaseGeometrySpec,
  localToWorldPoint,
  recenterRailingNodes,
  resolveHostDeckRailings,
  resolveHostStairRailings,
  resolveRailingConfig,
  snapRailingDrawPoint,
  worldToLocalPoint,
} from '../utils/railings';
import { formatAreaM2, formatSmartMetric, scaleToBaseZoom, uid } from '../utils/units';
import {
  classifyWheelGesture,
  computeAnchoredZoom,
  evaluateMarqueeSelection,
  getAdjacentStackLayerIds,
  mergeMarqueeSelection,
  resolveAltStackClickId,
  resolveMarqueeMode,
  resolvePlainStackClickId,
} from '../utils/selectionNav';
import {
  CardinalRotationDeg,
  computePanForViewRotationStep,
  computeRotatedGridWorldBounds,
  computeRotatedPlanFit,
  normalizeScreenUprightAngleDeg,
  screenRelCenterToWorld,
  worldToScreenPoint,
} from '../utils/viewRotation2d';
import {
  computeZoomSnapTolerances,
  createHostDwellTracker,
  CursorHintPayload,
  evaluateHostDwellStep,
  HostDwellTracker,
  pickWithSnapHysteresis,
  resolveSingleDragHint,
  sampleSnapVisualTween,
  SnapHysteresisState,
  SnapVisualTweenState,
  updateSnapVisualTweenOnSolverResult,
} from '../utils/dragErgonomics';
import { computePlanStackVisualData, outsetPolygon2D } from '../utils/stackVisualization';
import {
  applyWallConsolidation,
  clearWallConsolidation,
  validateWallConsolidationEligibility,
} from '../utils/wallConsolidation';
import { CanvasContextMenu, ContextMenuState } from './CanvasContextMenu';
import { CursorHintChip } from './CursorHintChip';

interface Canvas2DProps {
  level: Level;
  settings: ProjectSettings;
  activeTool: EditorTool;
  pendingOpeningSpec: { category: Opening['category']; subtype: Opening['subtype'] };
  activeRailingStyle?: RailingStyleId;
  selection: SelectionTarget[];
  zoomMultiplier: number;
  viewRotationDeg?: CardinalRotationDeg;
  fitSignal: number;
  svgRefExternal?: React.RefObject<SVGSVGElement | null>;
  onSelect: (targets: SelectionTarget[]) => void;
  onToolChange: (tool: EditorTool) => void;
  onCursorCoords: (pt: Point2D) => void;
  onZoomChange: (nextMult: number) => void;
  onResetViewRotation?: () => void;
  onUpdateLevel: (
    updater: (lvl: Level) => Level,
    recomputeRooms?: boolean,
    recordHistory?: boolean,
    label?: string,
    coalesceKey?: string
  ) => void;
  onCommitDrag: (label: string) => void;
  onCancelDrag: () => void;
  onPickEyedropperColor: (hex: string) => void;
  onCalibrateDistance?: (pixelDistMm: number) => void;
  onConstraintError?: (message: string) => void;
  onToggleBlackAndWhite?: () => void;
  hasClipboard?: boolean;
  onDuplicateSelected?: () => void;
  onDeleteSelected?: () => void;
  onPasteClipboard?: () => void;
  onFitToScreen?: () => void;
}

type DragState =
  | { kind: 'pan'; startClient: Point2D; startPan: Point2D; byMiddle?: boolean }
  | {
      kind: 'wall_vertex';
      wallId: string;
      end: 'start' | 'end';
      origPoint: Point2D;
      startClient: Point2D;
      detachSingle?: boolean;
      linkedEndpoints: Array<{ wallId: string; endpoint: 'start' | 'end' }>;
      label: string;
    }
  | {
      kind: 'wall_body';
      wallId: string;
      startWorld: Point2D;
      origStart: Point2D;
      origEnd: Point2D;
      startClient: Point2D;
      label: string;
    }
  | { kind: 'opening'; openingId: string; startClient: Point2D; label: string }
  | {
      kind: 'comp_edge';
      compId: string;
      compKind: 'opening' | 'chimney';
      wallId: string;
      edge: 'left' | 'right';
      startClient: Point2D;
      label: string;
    }
  | {
      kind: 'chimney_depth';
      compId: string;
      wallId: string;
      startClient: Point2D;
      label: string;
    }
  | {
      kind: 'furniture';
      id: string;
      offsetMm: Point2D;
      startClient: Point2D;
      wasAlreadySelected: boolean;
      ctrlToggleOnClick?: boolean;
      altOnDown?: boolean;
      stackHitIds: string[];
      subPartCandidateId?: string;
      label: string;
    }
  | {
      kind: 'furniture_rotate';
      id: string;
      center: Point2D;
      origRotDeg: number;
      startPointerDeg: number;
      startClient: Point2D;
      label: string;
    }
  | {
      kind: 'part_edge';
      furnId: string;
      partId: string;
      edge: 'left' | 'right' | 'top' | 'bottom';
      origPart: FurniturePart;
      startLocal: Point2D;
      startClient: Point2D;
      label: string;
    }
  | { kind: 'curtain'; id: string; offsetMm: Point2D; startClient: Point2D; label: string }
  | { kind: 'person'; id: string; offsetMm: Point2D; startClient: Point2D; label: string }
  | { kind: 'arch'; id: string; offsetMm: Point2D; startClient: Point2D; label: string }
  | { kind: 'railing_node'; elId: string; nodeIndex: number; startClient: Point2D; label: string }
  | { kind: 'section_end'; end: 'start' | 'end'; startClient: Point2D; label: string }
  | {
      kind: 'marquee';
      startWorld: Point2D;
      curWorld: Point2D;
      startClient: Point2D;
      curClient: Point2D;
      shiftKey: boolean;
      ctrlKey?: boolean;
      prevSelection: SelectionTarget[];
      roomClickTarget?: SelectionTarget;
    };

export const Canvas2D: React.FC<Canvas2DProps> = ({
  level,
  settings,
  activeTool,
  pendingOpeningSpec,
  activeRailingStyle,
  selection,
  zoomMultiplier,
  viewRotationDeg = 0,
  fitSignal,
  svgRefExternal,
  onSelect,
  onToolChange,
  onCursorCoords,
  onZoomChange,
  onResetViewRotation,
  onUpdateLevel,
  onCommitDrag,
  onCancelDrag,
  onPickEyedropperColor,
  onCalibrateDistance,
  onConstraintError,
  onToggleBlackAndWhite,
  hasClipboard = false,
  onDuplicateSelected,
  onDeleteSelected,
  onPasteClipboard,
  onFitToScreen,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef = svgRefExternal ?? internalSvgRef;

  const [size, setSize] = useState({ width: 900, height: 650 });
  const [panPx, setPanPx] = useState<Point2D>({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const prevViewRotationRef = useRef<CardinalRotationDeg>(viewRotationDeg);

  useEffect(() => {
    const prev = prevViewRotationRef.current;
    if (prev !== viewRotationDeg) {
      const delta = viewRotationDeg - prev;
      prevViewRotationRef.current = viewRotationDeg;
      setPanPx((p) => computePanForViewRotationStep(p, delta));
    }
  }, [viewRotationDeg]);

  // Interactive drawing states
  const [wallDraftPts, setWallDraftPts] = useState<Point2D[]>([]);
  const [railingDraftPts, setRailingDraftPts] = useState<RailingPathNode[]>([]);
  const [railingHoverInfo, setRailingHoverInfo] = useState<{
    elevationMm: number;
    label?: string;
  } | null>(null);
  const [typedLengthCm, setTypedLengthCm] = useState<string>('');
  const [centeredAxis, setCenteredAxis] = useState<'x' | 'y'>('x');
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [measureDraftPts, setMeasureDraftPts] = useState<Point2D[]>([]);
  const [activeDistanceResult, setActiveDistanceResult] = useState<{
    start: Point2D;
    end: Point2D;
  } | null>(null);
  const [activeAreaResult, setActiveAreaResult] = useState<{
    points: Point2D[];
    areaM2: number;
    perimeterM: number;
    roomName?: string;
  } | null>(null);
  const [arrowStart, setArrowStart] = useState<Point2D | null>(null);
  const [hoverWorld, setHoverWorld] = useState<Point2D | null>(null);
  const [snapBadge, setSnapBadge] = useState<'vertex' | 'wall' | 'align' | 'grid' | 'none'>('none');
  const [snapLabel, setSnapLabel] = useState<string | undefined>(undefined);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentTargetPreview | null>(null);
  const [roomCenterSnapTarget, setRoomCenterSnapTarget] = useState<{
    center: Point2D;
    roomName: string;
  } | null>(null);
  const [cursorHint, setCursorHint] = useState<CursorHintPayload | null>(null);
  const [cursorClientPos, setCursorClientPos] = useState<{ x: number; y: number } | null>(null);
  const snapHysteresisRef = useRef<SnapHysteresisState>({});
  const hostDwellRef = useRef<HostDwellTracker>(createHostDwellTracker(undefined));
  const hostDwellTimerRef = useRef<number | null>(null);
  const immediateHostSwitchRef = useRef<boolean>(false);
  const snapTweenRef = useRef<SnapVisualTweenState | null>(null);
  const snapTweenRafRef = useRef<number | null>(null);
  const [snapTweenOffset, setSnapTweenOffset] = useState<{
    targetKey: string;
    dx: number;
    dy: number;
  } | null>(null);
  const [devParityOverlay, setDevParityOverlay] = useState<boolean>(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('parity') === '1';
  });

  const clearHostDwellTimer = useCallback(() => {
    if (hostDwellTimerRef.current !== null) {
      window.clearTimeout(hostDwellTimerRef.current);
      hostDwellTimerRef.current = null;
    }
  }, []);

  const clearSnapTween = useCallback(() => {
    if (snapTweenRafRef.current !== null) {
      window.cancelAnimationFrame(snapTweenRafRef.current);
      snapTweenRafRef.current = null;
    }
    snapTweenRef.current = null;
    setSnapTweenOffset(null);
  }, []);

  const triggerSnapTween = useCallback(
    (
      targetKey: string,
      prevPos: Point2D,
      nextPos: Point2D,
      snapKey: string | undefined,
      maxJumpMm: number
    ) => {
      const nextTween = updateSnapVisualTweenOnSolverResult(
        snapTweenRef.current,
        targetKey,
        prevPos,
        nextPos,
        snapKey,
        maxJumpMm,
        performance.now()
      );
      snapTweenRef.current = nextTween;
      if (!nextTween) {
        setSnapTweenOffset(null);
        return;
      }
      const sample = sampleSnapVisualTween(nextTween, performance.now());
      if (!sample.active) {
        setSnapTweenOffset((cur) => (cur ? null : cur));
        return;
      }
      setSnapTweenOffset({ targetKey: nextTween.targetKey, dx: sample.dx, dy: sample.dy });
      if (snapTweenRafRef.current !== null) {
        window.cancelAnimationFrame(snapTweenRafRef.current);
      }
      const step = () => {
        const cur = snapTweenRef.current;
        if (!cur) {
          snapTweenRafRef.current = null;
          setSnapTweenOffset(null);
          return;
        }
        const s = sampleSnapVisualTween(cur, performance.now());
        if (!s.active) {
          snapTweenRafRef.current = null;
          setSnapTweenOffset(null);
          return;
        }
        setSnapTweenOffset({ targetKey: cur.targetKey, dx: s.dx, dy: s.dy });
        snapTweenRafRef.current = window.requestAnimationFrame(step);
      };
      snapTweenRafRef.current = window.requestAnimationFrame(step);
    },
    []
  );

  const lastDragPointerRef = useRef<{
    clientX: number;
    clientY: number;
    shiftKey: boolean;
    ctrlKey: boolean;
  } | null>(null);
  const heldCtrlRef = useRef(false);
  const heldShiftRef = useRef(false);
  const dragStackCandidatesRef = useRef<
    Array<{ hostId: string; hostName: string; deckHeightMm: number }>
  >([]);
  const preferredStackHostIdRef = useRef<string | undefined>(undefined);
  const getEffectiveModifiers = useCallback((rawShift = false, rawCtrl = false) => {
    return {
      shiftActive: rawShift || heldShiftRef.current,
      ctrlActive: rawCtrl || heldCtrlRef.current,
    };
  }, []);
  const [snapPulse, setSnapPulse] = useState<{ point: Point2D; label: string } | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [rotateReadout, setRotateReadout] = useState<{
    furnId: string;
    deg: number;
    snapped: boolean;
    step: number;
  } | null>(null);
  const dragMutatedRef = useRef(false);
  const [hoveredDimKey, setHoveredDimKey] = useState<string | null>(null);
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null);
  const [hoveredFurnId, setHoveredFurnId] = useState<string | null>(null);
  const [editingDim, setEditingDim] = useState<{
    key: string;
    kind: 'component_width' | 'clearance_left' | 'clearance_right' | 'wall_length';
    wallId: string;
    compId?: string;
    label: string;
    screenX: number;
    screenY: number;
    valueStr: string;
    origValueMm: number;
    error: string | null;
    previewUpdates?: Array<{ id: string; kind: 'opening' | 'chimney'; t: number; widthMm: number }>;
    previewWallEnds?: { start: Point2D; end: Point2D };
    previewConnectedResult?: ConnectedWallLengthResult;
  } | null>(null);
  const dimInputRef = useRef<HTMLInputElement>(null);

  const nearMissGaps = useMemo(() => findNearMissWallGaps(level.walls, 260, 6), [level.walls]);

  useEffect(() => {
    if (!snapPulse) return;
    const t = window.setTimeout(() => setSnapPulse(null), 900);
    return () => window.clearTimeout(t);
  }, [snapPulse]);

  useEffect(() => {
    return () => {
      clearHostDwellTimer();
      clearSnapTween();
    };
  }, [clearHostDwellTimer, clearSnapTween]);

  // Clear transient drafts when switching tools
  useEffect(() => {
    setWallDraftPts([]);
    setRailingDraftPts([]);
    setRailingHoverInfo(null);
    setTypedLengthCm('');
    setAlignmentGuides([]);
    setMeasureDraftPts([]);
    setArrowStart(null);
    setRoomCenterSnapTarget(null);
    setCursorHint(null);
    setCursorClientPos(null);
    clearHostDwellTimer();
    clearSnapTween();
    snapHysteresisRef.current = {};
    if (activeTool !== 'measure_distance') setActiveDistanceResult(null);
    if (activeTool !== 'measure_area') setActiveAreaResult(null);
  }, [activeTool, clearHostDwellTimer, clearSnapTween]);

  const pxPerMm = useMemo(
    () => scaleToBaseZoom(settings.scale) * zoomMultiplier,
    [settings.scale, zoomMultiplier]
  );

  const zoomSnapTols = useMemo(
    () => computeZoomSnapTolerances(pxPerMm),
    [pxPerMm]
  );
  const snapThreshMm = zoomSnapTols.vertexWallTolMm;

  // Measure container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({
          width: Math.max(200, e.contentRect.width),
          height: Math.max(200, e.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit-to-screen handler
  useEffect(() => {
    if (level.walls.length === 0 && level.furniture.length === 0) {
      setPanPx({ x: 0, y: 0 });
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const w of level.walls) {
      minX = Math.min(minX, w.start.x, w.end.x);
      maxX = Math.max(maxX, w.start.x, w.end.x);
      minY = Math.min(minY, w.start.y, w.end.y);
      maxY = Math.max(maxY, w.start.y, w.end.y);
    }
    for (const f of level.furniture) {
      minX = Math.min(minX, f.xMm - 600);
      maxX = Math.max(maxX, f.xMm + 600);
      minY = Math.min(minY, f.yMm - 600);
      maxY = Math.max(maxY, f.yMm + 600);
    }
    if (!Number.isFinite(minX)) return;
    const base = scaleToBaseZoom(settings.scale);
    const fitted = computeRotatedPlanFit({
      minX,
      maxX,
      minY,
      maxY,
      viewportWidth: size.width,
      viewportHeight: size.height,
      baseScalePxPerMm: base,
      rotDeg: viewRotationDeg,
    });
    onZoomChange(fitted.zoomMultiplier);
    setPanPx(fitted.panPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Commit a wall segment with automatic T-junction splitting
  const commitWallSegment = useCallback(
    (p1: Point2D, p2: Point2D, curved: boolean): string | null => {
      if (dist(p1, p2) < 40) return null;
      const newWallId = uid('wall');
      onUpdateLevel(
        (lvl) => {
          let walls = [...lvl.walls];
          let openings = [...lvl.openings];
          let backsplashes = [...(lvl.backsplashes ?? [])];

          // Split existing walls if p1 or p2 lands on their interior (T-junction)
          for (const pt of [p1, p2]) {
            for (let i = 0; i < walls.length; i++) {
              const w = walls[i];
              if (dist(pt, w.start) < 8 || dist(pt, w.end) < 8) continue;
              const proj = projectPointOnSegment(pt, w.start, w.end);
              if (proj.distance < 12 && proj.t > 0.02 && proj.t < 0.98) {
                const split = splitWallAtPoint(w, proj.point, openings);
                walls.splice(i, 1, split.walls[0], split.walls[1]);
                openings = split.openings;
                backsplashes = remapBacksplashesOnWallSplit(
                  backsplashes,
                  w.id,
                  split.walls[0].id,
                  split.walls[1].id,
                  split.tSplit
                );
                break;
              }
            }
          }

          const newWall: Wall = {
            id: newWallId,
            start: p1,
            end: p2,
            thicknessMm: 160,
            heightMm: lvl.ceilingHeightMm,
            alignment: 'center',
            isCurved: curved,
            curveBulgeMm: curved ? Math.round(dist(p1, p2) * 0.18) : 0,
            innerColor: '#FFFFFF',
            outerColor: '#FFFFFF',
            innerMaterial: 'paint',
            outerMaterial: 'paint',
            innerTextureScale: 1,
            outerTextureScale: 1,
            innerTextureRotDeg: 0,
            outerTextureRotDeg: 0,
            hasBaseboard: true,
            baseboardHeightMm: 80,
            baseboardColor: '#FFFFFF',
            hasCrownMolding: false,
            crownHeightMm: 60,
            crownColor: '#FFFFFF',
            visible: true,
            locked: false,
          };
          walls.push(newWall);
          return { ...lvl, walls, openings };
        },
        true,
        true,
        curved ? 'Add Curved Wall' : 'Add Wall'
      );
      return newWallId;
    },
    [onUpdateLevel]
  );

  const computeTypedWallEndpoints = useCallback(
    (lenMm: number, centerOverride?: Point2D): { p1: Point2D; p2: Point2D } => {
      const centerWorld = screenRelCenterToWorld(0, 0, panPx, pxPerMm, viewRotationDeg);
      const viewportCenter = {
        x: Math.round(centerWorld.x),
        y: Math.round(centerWorld.y),
      };
      if (wallDraftPts.length === 0) {
        const c = centerOverride ?? hoverWorld ?? viewportCenter;
        const half = lenMm / 2;
        if (centeredAxis === 'x') {
          return {
            p1: { x: Math.round(c.x - half), y: Math.round(c.y) },
            p2: { x: Math.round(c.x + half), y: Math.round(c.y) },
          };
        }
        return {
          p1: { x: Math.round(c.x), y: Math.round(c.y - half) },
          p2: { x: Math.round(c.x), y: Math.round(c.y + half) },
        };
      }
      const p1 = wallDraftPts[wallDraftPts.length - 1];
      const target = centerOverride ?? hoverWorld ?? { x: p1.x + 1000, y: p1.y };
      const dx = target.x - p1.x;
      const dy = target.y - p1.y;
      const d = Math.hypot(dx, dy);
      const ux = d > 1 ? dx / d : 1;
      const uy = d > 1 ? dy / d : 0;
      return {
        p1,
        p2: {
          x: Math.round(p1.x + ux * lenMm),
          y: Math.round(p1.y + uy * lenMm),
        },
      };
    },
    [centeredAxis, hoverWorld, panPx, pxPerMm, viewRotationDeg, wallDraftPts]
  );

  const placeSingleWallAndSelect = useCallback(
    (p1: Point2D, p2: Point2D, curved: boolean) => {
      const createdId = commitWallSegment(p1, p2, curved);
      setWallDraftPts([]);
      setTypedLengthCm('');
      setAlignmentGuides([]);
      if (createdId) {
        onSelect([{ kind: 'wall', id: createdId }]);
      }
      onToolChange('select');
    },
    [commitWallSegment, onSelect, onToolChange]
  );

  const commitRailingDraft = useCallback(
    (pts: RailingPathNode[], closed = false) => {
      if (pts.length < 2) return;
      const id = uid('rail');
      const railEl = buildRailingArchElementFromWorldPoints(
        id,
        pts,
        activeRailingStyle ?? DEFAULT_RAILING_STYLE,
        { closed }
      );
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          archElements: [...lvl.archElements, railEl],
        }),
        false,
        true,
        'Draw Railing'
      );
      onSelect([{ kind: 'arch', id }]);
      setRailingDraftPts([]);
      setRailingHoverInfo(null);
      onToolChange('select');
    },
    [activeRailingStyle, onSelect, onToolChange, onUpdateLevel]
  );

  // Keyboard shortcuts for cancelling drawing, numeric wall length input, finishing measurements & spacebar pan
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Space') {
        setSpacePressed(true);
      }

      if (activeTool === 'wall' || activeTool === 'wall_arc') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            setTypedLengthCm((prev) => (prev.length < 7 ? prev + e.key : prev));
            return;
          }
          if (e.key === '.' || e.key === ',') {
            e.preventDefault();
            e.stopPropagation();
            setTypedLengthCm((prev) => (prev.includes('.') ? prev : (prev || '0') + '.'));
            return;
          }
          if (e.key === 'Backspace' && typedLengthCm.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setTypedLengthCm((prev) => prev.slice(0, -1));
            return;
          }
          if (e.key === 'Tab' && wallDraftPts.length === 0 && typedLengthCm.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setCenteredAxis((a) => (a === 'x' ? 'y' : 'x'));
            return;
          }
        }
      }

      if (e.key === 'Backspace' && activeTool === 'railing' && railingDraftPts.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setRailingDraftPts((pts) => pts.slice(0, -1));
        return;
      }

      if (e.key === 'Tab' && dragStateRef.current?.kind === 'furniture') {
        const cands = dragStackCandidatesRef.current;
        if (cands.length > 1 && lastDragPointerRef.current) {
          e.preventDefault();
          e.stopPropagation();
          const curIdx = preferredStackHostIdRef.current
            ? Math.max(0, cands.findIndex((c) => c.hostId === preferredStackHostIdRef.current))
            : 0;
          const step = e.shiftKey ? -1 : 1;
          const nextIdx = (curIdx + step + cands.length) % cands.length;
          preferredStackHostIdRef.current = cands[nextIdx].hostId;
          const { shiftActive, ctrlActive } = getEffectiveModifiers(
            lastDragPointerRef.current.shiftKey,
            lastDragPointerRef.current.ctrlKey
          );
          immediateHostSwitchRef.current = true;
          try {
            executeFurnitureDragMoveRef.current(
              dragStateRef.current.id,
              dragStateRef.current.offsetMm,
              lastDragPointerRef.current.clientX,
              lastDragPointerRef.current.clientY,
              shiftActive,
              ctrlActive
            );
          } finally {
            immediateHostSwitchRef.current = false;
          }
        } else {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (dragStateRef.current) {
          e.preventDefault();
          e.stopPropagation();
          handleSvgPointerCancelRef.current();
          return;
        }
        if ((activeTool === 'wall' || activeTool === 'wall_arc') && typedLengthCm.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setTypedLengthCm('');
          return;
        }
        setWallDraftPts([]);
        setRailingDraftPts([]);
        setRailingHoverInfo(null);
        setTypedLengthCm('');
        setAlignmentGuides([]);
        setMeasureDraftPts([]);
        setArrowStart(null);
        setActiveDistanceResult(null);
        setActiveAreaResult(null);
        onToolChange('select');
      }
      if (e.key === 'Enter') {
        if (activeTool === 'railing') {
          e.preventDefault();
          e.stopPropagation();
          if (railingDraftPts.length >= 2) {
            commitRailingDraft(railingDraftPts, false);
          } else {
            setRailingDraftPts([]);
            setRailingHoverInfo(null);
            onToolChange('select');
          }
          return;
        }
        if (activeTool === 'wall' || activeTool === 'wall_arc') {
          if (typedLengthCm.length > 0) {
            const cm = Number(typedLengthCm);
            if (Number.isFinite(cm) && cm * 10 >= 40) {
              e.preventDefault();
              e.stopPropagation();
              const { p1, p2 } = computeTypedWallEndpoints(Math.round(cm * 10));
              placeSingleWallAndSelect(p1, p2, activeTool === 'wall_arc');
              return;
            }
          }
          if (wallDraftPts.length > 0) {
            setWallDraftPts([]);
            setAlignmentGuides([]);
            onToolChange('select');
            return;
          }
        }
        if (activeTool === 'measure_area' && measureDraftPts.length >= 3) {
          const areaM2 = computePolygonAreaM2(measureDraftPts);
          const perimeterM = computePolygonPerimeterM(measureDraftPts);
          setActiveAreaResult({ points: measureDraftPts, areaM2, perimeterM });
          setMeasureDraftPts([]);
          return;
        }
        if (activeDistanceResult || activeAreaResult) {
          setActiveDistanceResult(null);
          setActiveAreaResult(null);
          setMeasureDraftPts([]);
          onToolChange('select');
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    activeTool,
    wallDraftPts,
    railingDraftPts,
    typedLengthCm,
    measureDraftPts,
    activeDistanceResult,
    activeAreaResult,
    computeTypedWallEndpoints,
    placeSingleWallAndSelect,
    commitRailingDraft,
    onToolChange,
  ]);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point2D => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const sxRel = clientX - rect.left - size.width / 2;
      const syRel = clientY - rect.top - size.height / 2;
      return screenRelCenterToWorld(sxRel, syRel, panPx, pxPerMm, viewRotationDeg);
    },
    [panPx, pxPerMm, size.height, size.width, svgRef, viewRotationDeg]
  );

  const worldToScreen = useCallback(
    (worldPt: Point2D): Point2D =>
      worldToScreenPoint(worldPt, size.width, size.height, panPx, pxPerMm, viewRotationDeg),
    [panPx, pxPerMm, size.height, size.width, viewRotationDeg]
  );

  const worldToScreenTransform = `translate(${size.width / 2 + panPx.x}, ${
    size.height / 2 + panPx.y
  }) rotate(${viewRotationDeg}) scale(${pxPerMm})`;

  const isSelected = useCallback(
    (kind: SelectionTarget['kind'], id: string) =>
      selection.some((s) => s.kind === kind && s.id === id),
    [selection]
  );

  const selectedFurniturePart = useMemo(() => {
    const found = selection.find((s) => s.kind === 'furniture' && s.partId);
    return found && found.kind === 'furniture' ? found : null;
  }, [selection]);

  // Compute grid bounds in world mm across rotated viewport corners
  const gridRange = useMemo(() => {
    const bounds = computeRotatedGridWorldBounds(
      size.width,
      size.height,
      panPx,
      pxPerMm,
      viewRotationDeg
    );
    const step = settings.gridSizeMm;
    const minX = Math.floor(bounds.minX / step) * step;
    const maxX = Math.ceil(bounds.maxX / step) * step;
    const minY = Math.floor(bounds.minY / step) * step;
    const maxY = Math.ceil(bounds.maxY / step) * step;
    // Limit grid lines to avoid DOM explosion when zoomed way out
    const countX = (maxX - minX) / step;
    const countY = (maxY - minY) / step;
    const maxCount = Math.max(countX, countY);
    const effectiveStep = maxCount > 140 ? Math.ceil(maxCount / 100) * step : step;
    return {
      minX: Math.floor(minX / effectiveStep) * effectiveStep,
      maxX,
      minY: Math.floor(minY / effectiveStep) * effectiveStep,
      maxY,
      step: effectiveStep,
    };
  }, [panPx, pxPerMm, settings.gridSizeMm, size.height, size.width, viewRotationDeg]);



  // Place opening onto nearest wall at pointer (avoiding overlap with existing openings/chimneys)
  const tryPlaceOpeningAt = useCallback(
    (worldPt: Point2D) => {
      let bestWall: Wall | null = null;
      let bestT = 0.5;
      let bestDist = 450;
      for (const w of level.walls) {
        if (w.locked) continue;
        const proj = projectPointOnSegment(worldPt, w.start, w.end);
        if (proj.distance < bestDist) {
          bestDist = proj.distance;
          bestWall = w;
          bestT = Math.max(0.06, Math.min(0.94, proj.t));
        }
      }
      if (!bestWall) return;
      const cat = pendingOpeningSpec.category;
      const sub = pendingOpeningSpec.subtype;
      const isEuroPvc = sub.startsWith('euro_') || sub === 'balcony_single' || sub === 'balcony_double';
      const widthMm =
        cat === 'door'
          ? sub === 'double' || sub === 'french' || sub === 'garage' || sub === 'balcony_double'
            ? sub === 'balcony_double'
              ? 1650
              : 1600
            : sub === 'bifold'
              ? 1800
              : sub === 'balcony_single'
                ? 950
                : 900
          : cat === 'window'
            ? sub === 'triple' || sub === 'bay' || sub === 'euro_triple'
              ? sub === 'euro_triple'
                ? 2400
                : 2100
              : sub === 'euro_terrace'
                ? 1800
                : sub === 'euro_double'
                  ? 1600
                  : sub === 'euro_single'
                    ? 1000
                    : sub === 'round'
                      ? 900
                      : sub === 'clerestory'
                        ? 1600
                        : 1400
            : 1200;

      const wallLen = getWallArcLength(bestWall);
      const bounds = computeWallInnerBounds(bestWall, level.walls);
      const existingComps = getWallMountedComponents(bestWall, level.openings, level.archElements);
      const tempId = uid('op');
      const candComps = [
        ...existingComps,
        {
          id: tempId,
          kind: 'opening' as const,
          name: 'New Opening',
          centerS: bestT * wallLen,
          widthMm,
          leftS: bestT * wallLen - widthMm / 2,
          rightS: bestT * wallLen + widthMm / 2,
          t: bestT,
          locked: false,
          resizeAnchor: 'center' as const,
        },
      ].sort((a, b) => a.centerS - b.centerS);

      const solvedDrag = solveWallComponentDrag(
        candComps,
        bounds,
        tempId,
        bestT * wallLen,
        settings.snapEnabled
      );

      const newOp: Opening = {
        id: tempId,
        name:
          sub === 'balcony_single'
            ? 'Balcony Door'
            : sub === 'balcony_double'
              ? 'Double Balcony Door'
              : sub === 'euro_single'
                ? 'Euro Window'
                : sub === 'euro_double'
                  ? 'Euro Double Window'
                  : sub === 'euro_triple'
                    ? 'Euro Panoramic Window'
                    : sub === 'euro_terrace'
                      ? 'Euro Terrace Window'
                      : cat === 'door'
                        ? sub === 'doorframe'
                          ? 'Doorframe'
                          : 'Door'
                        : cat === 'window'
                          ? 'Window'
                          : 'Archway',
        wallId: bestWall.id,
        t: solvedDrag.t,
        category: cat,
        subtype: sub,
        widthMm,
        heightMm:
          cat === 'door'
            ? sub === 'balcony_single' || sub === 'balcony_double'
              ? 2200
              : 2100
            : cat === 'window'
              ? sub === 'floor_to_ceiling'
                ? 2350
                : sub === 'euro_terrace'
                  ? 2200
                  : sub === 'clerestory'
                    ? 650
                    : 1400
              : 2250,
        sillHeightMm:
          cat === 'window'
            ? sub === 'floor_to_ceiling'
              ? 100
              : sub === 'euro_terrace'
                ? 0
                : sub === 'clerestory'
                  ? 1750
                  : 850
            : 0,
        frameThicknessMm: isEuroPvc ? 65 : 55,
        frameColor: isEuroPvc ? '#F8FAFC' : '#1E293B',
        panelColor: isEuroPvc ? '#F8FAFC' : '#FFFFFF',
        glassColor: '#E0F2FE',
        swingSide: 'left',
        swingDirection: 'in',
        openAngleDeg: cat === 'door' ? 60 : 0,
        resizeAnchor: 'center',
        visible: true,
        locked: false,
      };
      onUpdateLevel(
        (lvl) => ({ ...lvl, openings: [...lvl.openings, newOp] }),
        false,
        true,
        `Add ${newOp.name}`
      );
      onSelect([{ kind: 'opening', id: newOp.id }]);
      onToolChange('select');
    },
    [
      level.archElements,
      level.openings,
      level.walls,
      onSelect,
      onToolChange,
      onUpdateLevel,
      pendingOpeningSpec,
      settings.snapEnabled,
    ]
  );

  // Place chimney / rectangular parallelepiped (snaps strictly flush to wall edge, never overlaps walls)
  const tryPlaceChimneyAt = useCallback(
    (worldPt: Point2D, snappedPt: Point2D) => {
      const defaultWidthMm = 650;
      const defaultDepthMm = 450;
      const id = uid('arch');
      const hasVisibleWalls = level.walls.some((w) => w.visible !== false);

      const snap = snapChimneyToWallEdge(
        worldPt,
        defaultWidthMm,
        defaultDepthMm,
        level.walls,
        level.openings,
        level.archElements,
        undefined,
        settings.snapEnabled
      );

      if (snap) {
        const hostWall = level.walls.find((w) => w.id === snap.wallId);
        if (!hostWall) return;
        const hostFaces = resolveWallFaces(hostWall, level.rooms);
        const faceSlot = snap.face === 'left' ? hostFaces.left.slot : hostFaces.right.slot;
        const faceColor = faceSlot === 'inner' ? hostWall.innerColor : hostWall.outerColor;
        const faceMat = faceSlot === 'inner' ? hostWall.innerMaterial : hostWall.outerMaterial;
        const defaultFaces = getDefaultChimneyFaceColors(id);
        const newEl: ArchElement = {
          id,
          name: 'Chimney',
          type: 'chimney',
          xMm: snap.xMm,
          yMm: snap.yMm,
          elevationMm: 0,
          widthMm: defaultWidthMm,
          depthMm: defaultDepthMm,
          heightMm: level.ceilingHeightMm,
          rotationDeg: snap.rotationDeg,
          color: faceColor,
          accentColor: '#334155',
          faceColors: defaultFaces,
          material: faceMat,
          connectToCeiling: true,
          attachedWallId: hostWall.id,
          attachedFace: snap.face,
          attachedT: snap.t,
          resizeAnchor: snap.cornerPin ?? 'center',
          hasBaseboard: hostWall.hasBaseboard,
          baseboardHeightMm: hostWall.baseboardHeightMm,
          baseboardColor: hostWall.baseboardColor,
          hasCrownMolding: hostWall.hasCrownMolding,
          crownHeightMm: hostWall.crownHeightMm,
          crownColor: hostWall.crownColor,
          visible: true,
          locked: false,
        };
        onUpdateLevel(
          (lvl) => ({ ...lvl, archElements: [...lvl.archElements, newEl] }),
          false,
          true,
          'Add Chimney'
        );
        onSelect([{ kind: 'arch', id }]);
        onToolChange('select');
        return;
      }

      if (hasVisibleWalls) {
        onConstraintError?.('No wall edge with enough clearance to place chimney without overlapping a wall.');
        return;
      }

      const defaultFaces = getDefaultChimneyFaceColors(id);
      const newEl: ArchElement = {
        id,
        name: 'Chimney',
        type: 'chimney',
        xMm: Math.round(snappedPt.x),
        yMm: Math.round(snappedPt.y),
        elevationMm: 0,
        widthMm: defaultWidthMm,
        depthMm: defaultDepthMm,
        heightMm: level.ceilingHeightMm,
        rotationDeg: 0,
        color: '#FFFFFF',
        accentColor: '#334155',
        faceColors: defaultFaces,
        material: 'paint',
        connectToCeiling: true,
        resizeAnchor: 'center',
        hasBaseboard: true,
        baseboardHeightMm: 80,
        baseboardColor: '#FFFFFF',
        hasCrownMolding: false,
        crownHeightMm: 60,
        crownColor: '#FFFFFF',
        visible: true,
        locked: false,
      };
      onUpdateLevel(
        (lvl) => ({ ...lvl, archElements: [...lvl.archElements, newEl] }),
        false,
        true,
        'Add Chimney'
      );
      onSelect([{ kind: 'arch', id }]);
      onToolChange('select');
    },
    [
      level.archElements,
      level.ceilingHeightMm,
      level.openings,
      level.walls,
      onConstraintError,
      onSelect,
      onToolChange,
      onUpdateLevel,
      settings.snapEnabled,
    ]
  );

  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const gesture = classifyWheelGesture({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    });
    if (gesture.kind === 'pan') {
      setPanPx((p) => ({
        x: p.x - gesture.deltaX,
        y: p.y - gesture.deltaY,
      }));
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    const cursorRelCenter = rect
      ? {
          x: e.clientX - rect.left - size.width / 2,
          y: e.clientY - rect.top - size.height / 2,
        }
      : { x: 0, y: 0 };
    const { zoom: nextZoom, panPx: nextPan } = computeAnchoredZoom(
      zoomMultiplier,
      panPx,
      cursorRelCenter,
      gesture.factor,
      0.15,
      6
    );
    if (rect) {
      setPanPx(nextPan);
    }
    onZoomChange(nextZoom);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const listener = (e: WheelEvent) => wheelHandlerRef.current(e);
    svg.addEventListener('wheel', listener, { passive: false });
    return () => svg.removeEventListener('wheel', listener);
  }, []);

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Middle click (hold only), pan tool, or spacebar drag -> pan
    if (e.button === 1 || activeTool === 'pan' || spacePressed) {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if synthetic event lacks active pointerId
      }
      setDragState({
        kind: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startPan: { ...panPx },
        byMiddle: e.button === 1,
      });
      return;
    }

    if (e.button !== 0) return;
    const rawWorld = screenToWorld(e.clientX, e.clientY);
    const anchor =
      wallDraftPts.length > 0
        ? wallDraftPts[wallDraftPts.length - 1]
        : measureDraftPts.length > 0
          ? measureDraftPts[measureDraftPts.length - 1]
          : arrowStart;

    const isCornerMeasure =
      activeTool === 'measure_distance' ||
      activeTool === 'measure_area' ||
      activeTool === 'calibrate_trace';

    const snapped = snapPointToPlan(rawWorld, {
      walls: level.walls,
      furniture: level.furniture,
      gridSizeMm: settings.gridSizeMm,
      snapEnabled: settings.snapEnabled,
      angleSnapDeg: settings.angleSnapDeg,
      orthoMode: settings.orthoMode,
      anchor,
      preferCornersOnly: isCornerMeasure,
      snapThresholdMm: isCornerMeasure ? Math.max(snapThreshMm, 220) : snapThreshMm,
      alignThresholdMm: zoomSnapTols.alignTolMm,
      enableAxisAlignment: activeTool === 'wall' || activeTool === 'wall_arc',
    });

    if (activeTool === 'wall' || activeTool === 'wall_arc') {
      const pt = snapped.point;
      if (typedLengthCm.length > 0) {
        const cm = Number(typedLengthCm);
        if (Number.isFinite(cm) && cm * 10 >= 40) {
          const { p1, p2 } = computeTypedWallEndpoints(Math.round(cm * 10), pt);
          placeSingleWallAndSelect(p1, p2, activeTool === 'wall_arc');
          return;
        }
      }
      if (wallDraftPts.length === 0) {
        setWallDraftPts([pt]);
      } else {
        const prev = wallDraftPts[wallDraftPts.length - 1];
        if (dist(prev, pt) > 40) {
          placeSingleWallAndSelect(prev, pt, activeTool === 'wall_arc');
        }
      }
      return;
    }

    if (activeTool === 'split_wall') {
      for (const w of level.walls) {
        if (w.locked) continue;
        const proj = projectPointOnSegment(rawWorld, w.start, w.end);
        if (proj.distance < Math.max(180, w.thicknessMm) && proj.t > 0.05 && proj.t < 0.95) {
          onUpdateLevel(
            (lvl) => {
              const idx = lvl.walls.findIndex((x) => x.id === w.id);
              if (idx < 0) return lvl;
              const split = splitWallAtPoint(w, proj.point, lvl.openings);
              const nextWalls = [...lvl.walls];
              nextWalls.splice(idx, 1, split.walls[0], split.walls[1]);
              const nextBacksplashes = remapBacksplashesOnWallSplit(
                lvl.backsplashes ?? [],
                w.id,
                split.walls[0].id,
                split.walls[1].id,
                split.tSplit
              );
              return {
                ...lvl,
                walls: nextWalls,
                openings: split.openings,
                backsplashes: nextBacksplashes,
              };
            },
            true,
            true,
            'Split Wall'
          );
          onToolChange('select');
          return;
        }
      }
      return;
    }

    if (activeTool === 'door' || activeTool === 'window' || activeTool === 'arch') {
      tryPlaceOpeningAt(rawWorld);
      return;
    }

    if (activeTool === 'chimney') {
      tryPlaceChimneyAt(rawWorld, snapped.point);
      return;
    }

    if (activeTool === 'railing') {
      const rSnap = snapRailingDrawPoint(rawWorld, {
        walls: level.walls,
        archElements: level.archElements,
        gridSizeMm: settings.gridSizeMm,
        snapEnabled: settings.snapEnabled,
        snapThresholdMm: Math.max(snapThreshMm, 170),
        ceilingHeightMm: level.ceilingHeightMm,
      });
      if (
        railingDraftPts.length >= 3 &&
        dist(rSnap.point, { x: railingDraftPts[0].xMm, y: railingDraftPts[0].yMm }) <
          Math.max(120, snapThreshMm * 0.9)
      ) {
        commitRailingDraft(railingDraftPts, true);
        return;
      }
      const nextNode: RailingPathNode = {
        xMm: rSnap.point.x,
        yMm: rSnap.point.y,
        elevationMm: rSnap.elevationMm,
      };
      if (railingDraftPts.length === 0) {
        setRailingDraftPts([nextNode]);
      } else {
        const prev = railingDraftPts[railingDraftPts.length - 1];
        if (Math.hypot(nextNode.xMm - prev.xMm, nextNode.yMm - prev.yMm) > 35) {
          setRailingDraftPts((pts) => [...pts, nextNode]);
        }
      }
      return;
    }

    if (activeTool === 'measure_distance' || activeTool === 'calibrate_trace') {
      const pt = snapped.point;
      if (measureDraftPts.length === 0) {
        setActiveDistanceResult(null);
        setMeasureDraftPts([pt]);
      } else {
        const startPt = measureDraftPts[0];
        if (activeTool === 'calibrate_trace') {
          const d = dist(startPt, pt);
          setMeasureDraftPts([]);
          if (d > 10 && onCalibrateDistance) onCalibrateDistance(d);
        } else {
          setActiveDistanceResult({ start: startPt, end: pt });
          setMeasureDraftPts([]);
        }
      }
      return;
    }

    if (activeTool === 'measure_area') {
      const pt = snapped.point;
      // If clicking inside a room directly (not starting a corner-trace polygon), immediately inspect that room's area
      if (
        measureDraftPts.length === 0 &&
        (snapped.snappedKind !== 'vertex' || dist(rawWorld, snapped.point) > 95)
      ) {
        const hitRoom = level.rooms.find(
          (r) => r.visible && r.polygon.length >= 3 && pointInPolygon(rawWorld, r.polygon)
        );
        if (hitRoom) {
          setActiveAreaResult({
            points: hitRoom.polygon,
            areaM2: hitRoom.areaM2,
            perimeterM: hitRoom.perimeterM,
            roomName: hitRoom.name,
          });
          return;
        }
      }
      setActiveAreaResult(null);
      if (measureDraftPts.length >= 3 && dist(pt, measureDraftPts[0]) < 220) {
        const areaM2 = computePolygonAreaM2(measureDraftPts);
        const perimeterM = computePolygonPerimeterM(measureDraftPts);
        setActiveAreaResult({ points: measureDraftPts, areaM2, perimeterM });
        setMeasureDraftPts([]);
      } else {
        setMeasureDraftPts((pts) => [...pts, pt]);
      }
      return;
    }

    if (activeTool === 'text') {
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          annotations: [
            ...lvl.annotations,
            {
              id: uid('note'),
              kind: 'text',
              xMm: snapped.point.x,
              yMm: snapped.point.y,
              text: 'Design Note',
              color: '#0F172A',
              fontSizeMm: 180,
            },
          ],
        }),
        false,
        true,
        'Add Text Note'
      );
      onToolChange('select');
      return;
    }

    if (activeTool === 'arrow') {
      if (!arrowStart) {
        setArrowStart(snapped.point);
      } else {
        onUpdateLevel(
          (lvl) => ({
            ...lvl,
            annotations: [
              ...lvl.annotations,
              {
                id: uid('arr'),
                kind: 'arrow',
                xMm: arrowStart.x,
                yMm: arrowStart.y,
                endXMm: snapped.point.x,
                endYMm: snapped.point.y,
                text: 'Callout',
                color: '#2563EB',
                fontSizeMm: 160,
              },
            ],
          }),
          false,
          true,
          'Add Callout Arrow'
        );
        setArrowStart(null);
        onToolChange('select');
      }
      return;
    }

    if (activeTool === 'section_line') {
      if (measureDraftPts.length === 0) {
        setMeasureDraftPts([snapped.point]);
      } else {
        onUpdateLevel(
          (lvl) => ({
            ...lvl,
            sectionLine: {
              id: uid('sec'),
              start: measureDraftPts[0],
              end: snapped.point,
              flipDirection: false,
              active: true,
            },
          }),
          false,
          true,
          'Place Section Line'
        );
        setMeasureDraftPts([]);
        onToolChange('select');
      }
      return;
    }

    if (activeTool === 'select') {
      // Background click clears selection or starts marquee box select
      const prevSelection = selection;
      if (!e.shiftKey) {
        onSelect([]);
      }
      setDragState({
        kind: 'marquee',
        startWorld: rawWorld,
        curWorld: rawWorld,
        startClient: { x: e.clientX, y: e.clientY },
        curClient: { x: e.clientX, y: e.clientY },
        shiftKey: e.shiftKey,
        prevSelection,
      });
    }
  };

  const executeFurnitureDragMove = useCallback(
    (
      furnId: string,
      offsetMm: Point2D,
      clientX: number,
      clientY: number,
      shiftKey: boolean,
      ctrlKey: boolean
    ) => {
      const furn = level.furniture.find((f) => f.id === furnId);
      if (!furn || furn.locked) {
        setAlignmentGuides([]);
        setSnapBadge('none');
        setSnapLabel(undefined);
        setAttachmentPreview(null);
        setRoomCenterSnapTarget(null);
        setCursorHint(null);
        clearHostDwellTimer();
        clearSnapTween();
        return;
      }

      if (!hostDwellRef.current.initialized) {
        hostDwellRef.current = createHostDwellTracker(furn.surfaceHostId);
      }

      setCursorClientPos({ x: clientX, y: clientY });
      const rawWorld = screenToWorld(clientX, clientY);
      const rawNx = rawWorld.x - offsetMm.x;
      const rawNy = rawWorld.y - offsetMm.y;
      const snapEnabled = settings.snapEnabled && !shiftKey;
      const immediateHostSwitch =
        ctrlKey || shiftKey || immediateHostSwitchRef.current;

      const selectedFurnIds = new Set(
        selection.filter((s) => s.kind === 'furniture').map((s) => s.id)
      );
      const isMultiGroupDrag = selectedFurnIds.has(furnId) && selectedFurnIds.size > 1;
      const solverLevel = isMultiGroupDrag
        ? {
            ...level,
            furniture: level.furniture.filter(
              (o) => o.id === furnId || !selectedFurnIds.has(o.id)
            ),
          }
        : level;

      const solved = solveSolidFurnitureMove(
        { x: furn.xMm, y: furn.yMm },
        { x: rawNx, y: rawNy },
        furn,
        solverLevel,
        {
          snapEnabled,
          gridSizeMm: settings.gridSizeMm,
          wallSnapTolMm: zoomSnapTols.vertexWallTolMm,
          furnSnapTolMm: zoomSnapTols.furnFlushTolMm,
          alignTolMm: zoomSnapTols.alignTolMm,
          roomCenterTolMm: zoomSnapTols.roomCenterTolMm,
          strongRoomCenterTolMm: zoomSnapTols.strongRoomCenterTolMm,
          surfaceRoomCenterTolMm: zoomSnapTols.surfaceRoomCenterTolMm,
          hysteresis: snapHysteresisRef.current,
          allowOverlap: shiftKey,
          allowFurnitureOverlap: shiftKey,
          forceFloor: ctrlKey,
          preferredHostId: preferredStackHostIdRef.current,
          rooms: level.rooms,
          resolveSurfaceHost: (rawHostId) => {
            const step = evaluateHostDwellStep(hostDwellRef.current, rawHostId, Date.now(), {
              dwellMs: 120,
              immediate: immediateHostSwitch || !rawHostId,
            });
            return step.resolvedHostId;
          },
        }
      );

      snapHysteresisRef.current = solved.hysteresis ?? {};
      const dwellStep = evaluateHostDwellStep(
        hostDwellRef.current,
        solved.rawSurfaceHostCandidateId,
        Date.now(),
        {
          dwellMs: 120,
          immediate: immediateHostSwitch || !solved.rawSurfaceHostCandidateId,
        }
      );
      hostDwellRef.current = dwellStep.nextTracker;
      clearHostDwellTimer();
      if (dwellStep.waitingForDwell && !immediateHostSwitch) {
        hostDwellTimerRef.current = window.setTimeout(() => {
          hostDwellTimerRef.current = null;
          const curDrag = dragStateRef.current;
          const ptr = lastDragPointerRef.current;
          if (curDrag?.kind === 'furniture' && ptr) {
            executeFurnitureDragMoveRef.current(
              curDrag.id,
              curDrag.offsetMm,
              ptr.clientX,
              ptr.clientY,
              ptr.shiftKey,
              ptr.ctrlKey
            );
          }
        }, 125);
      }

      const candidates = solved.stackCandidates ?? [];
      dragStackCandidatesRef.current = candidates;
      if (
        preferredStackHostIdRef.current &&
        !candidates.some((c) => c.hostId === preferredStackHostIdRef.current)
      ) {
        preferredStackHostIdRef.current = undefined;
      }

      const nx = solved.xMm;
      const ny = solved.yMm;
      const nextRot = solved.rotationDeg;
      const nextElev = solved.elevationMm;
      const nextHostId = solved.surfaceHostId;
      const nextZOrder =
        solved.zOrder !== undefined
          ? solved.zOrder
          : getEffectiveFurnitureZOrder(furn, level.furniture.indexOf(furn));

      const nextHostObjPreview = nextHostId
        ? level.furniture.find((f) => f.id === nextHostId)
        : undefined;
      const localCoordsPreview = nextHostObjPreview
        ? computeSurfaceLocalCoords({ x: nx, y: ny }, nextRot, nextHostObjPreview)
        : undefined;
      const previewNextParent: FurnitureInstance = {
        ...furn,
        xMm: nx,
        yMm: ny,
        rotationDeg: nextRot,
        elevationMm: nextElev,
        surfaceHostId: nextHostId,
        surfaceLocalXMm: localCoordsPreview?.localXMm,
        surfaceLocalYMm: localCoordsPreview?.localYMm,
        surfaceLocalRotDeg: localCoordsPreview?.localRotDeg,
        attachedWallId: solved.attachedWallId,
        attachedFace: solved.attachedFace,
        attachedT: solved.attachedT,
        zOrder: nextZOrder,
      };
      if (isMultiGroupDrag) {
        const previewGroup = applyRigidFurnitureGroupDelta2D(
          level.furniture,
          selectedFurnIds,
          furnId,
          furn,
          previewNextParent,
          level.walls,
          shiftKey
        );
        if (!previewGroup) {
          setCursorHint({ text: 'Group blocked by wall', tone: 'clash' });
          return;
        }
      }

      setAlignmentGuides(solved.guides);
      setHoverWorld({ x: nx, y: ny });
      setSnapBadge(solved.snappedKind);
      setSnapLabel(solved.snapLabel);
      setAttachmentPreview(solved.attachmentPreview ?? null);
      setRoomCenterSnapTarget(
        solved.roomCenterSnap
          ? { center: solved.roomCenterSnap.center, roomName: solved.roomCenterSnap.roomName }
          : null
      );
      onCursorCoords({ x: nx, y: ny });

      setCursorHint(
        resolveSingleDragHint({
          clashingNames: solved.clashingNames,
          isForceFloor: solved.isForceFloor,
          placingOnHostName: solved.placingOnHostName,
          attachedToWall: Boolean(solved.attachedWallId),
          roomCenterName: solved.roomCenterSnap?.roomName,
          snapLabel: solved.snappedKind === 'grid' ? undefined : solved.snapLabel,
          freeOverlap: shiftKey,
        })
      );

      triggerSnapTween(
        `furniture:${furnId}`,
        { x: furn.xMm, y: furn.yMm },
        { x: nx, y: ny },
        solved.snapKey,
        zoomSnapTols.vertexWallTolMm * 1.6
      );

      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => {
          const prevParent = lvl.furniture.find((f) => f.id === furnId);
          if (!prevParent || prevParent.locked) return lvl;
          const nextHostObj = nextHostId
            ? lvl.furniture.find((f) => f.id === nextHostId)
            : undefined;
          const localCoords = nextHostObj
            ? computeSurfaceLocalCoords({ x: nx, y: ny }, nextRot, nextHostObj)
            : undefined;
          const nextParent: FurnitureInstance = {
            ...prevParent,
            xMm: nx,
            yMm: ny,
            rotationDeg: nextRot,
            elevationMm: nextElev,
            surfaceHostId: nextHostId,
            surfaceLocalXMm: localCoords?.localXMm,
            surfaceLocalYMm: localCoords?.localYMm,
            surfaceLocalRotDeg: localCoords?.localRotDeg,
            attachedWallId: solved.attachedWallId,
            attachedFace: solved.attachedFace,
            attachedT: solved.attachedT,
            zOrder: nextZOrder,
          };
          if (isMultiGroupDrag) {
            const groupMoved = applyRigidFurnitureGroupDelta2D(
              lvl.furniture,
              selectedFurnIds,
              furnId,
              prevParent,
              nextParent,
              lvl.walls,
              shiftKey
            );
            if (!groupMoved) return lvl;
            return {
              ...lvl,
              furniture: groupMoved,
            };
          }
          let nextList = lvl.furniture.map((f) => (f.id === furnId ? nextParent : f));
          nextList = propagateParentFurnitureTransforms(nextList, furnId, prevParent, nextParent);
          return {
            ...lvl,
            furniture: nextList,
          };
        },
        false,
        false
      );
    },
    [
      clearHostDwellTimer,
      clearSnapTween,
      level,
      onCursorCoords,
      onUpdateLevel,
      screenToWorld,
      selection,
      settings.gridSizeMm,
      settings.snapEnabled,
      triggerSnapTween,
      zoomSnapTols,
    ]
  );

  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;
  const executeFurnitureDragMoveRef = useRef(executeFurnitureDragMove);
  executeFurnitureDragMoveRef.current = executeFurnitureDragMove;

  useEffect(() => {
    const isEditableEl = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };
    const refreshActiveDrag = () => {
      const curDrag = dragStateRef.current;
      if (curDrag?.kind !== 'furniture' || !lastDragPointerRef.current) return;
      const { shiftActive, ctrlActive } = getEffectiveModifiers(false, false);
      lastDragPointerRef.current = {
        ...lastDragPointerRef.current,
        shiftKey: shiftActive,
        ctrlKey: ctrlActive,
      };
      if (!dragMutatedRef.current) return;
      executeFurnitureDragMoveRef.current(
        curDrag.id,
        curDrag.offsetMm,
        lastDragPointerRef.current.clientX,
        lastDragPointerRef.current.clientY,
        shiftActive,
        ctrlActive
      );
    };

    const onModifierKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isEditableEl(e.target)) return;
      if (e.key === 'Control' && !e.metaKey) {
        if (!heldCtrlRef.current) {
          heldCtrlRef.current = true;
          refreshActiveDrag();
        }
      } else if (e.key === 'Shift') {
        if (!heldShiftRef.current) {
          heldShiftRef.current = true;
          refreshActiveDrag();
        }
      }
    };

    const onModifierKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        if (heldCtrlRef.current) {
          heldCtrlRef.current = false;
          refreshActiveDrag();
        }
      } else if (e.key === 'Shift') {
        if (heldShiftRef.current) {
          heldShiftRef.current = false;
          refreshActiveDrag();
        }
      }
    };

    const onWindowBlur = () => {
      const changed = heldCtrlRef.current || heldShiftRef.current;
      heldCtrlRef.current = false;
      heldShiftRef.current = false;
      if (changed) refreshActiveDrag();
    };

    window.addEventListener('keydown', onModifierKeyDown, true);
    window.addEventListener('keyup', onModifierKeyUp, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onModifierKeyDown, true);
      window.removeEventListener('keyup', onModifierKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
      heldCtrlRef.current = false;
      heldShiftRef.current = false;
    };
  }, [getEffectiveModifiers]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onParityKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setDevParityOverlay((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onParityKeyDown);
    return () => window.removeEventListener('keydown', onParityKeyDown);
  }, []);

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rawWorld = screenToWorld(e.clientX, e.clientY);
    const anchor =
      wallDraftPts.length > 0
        ? wallDraftPts[wallDraftPts.length - 1]
        : measureDraftPts.length > 0
          ? measureDraftPts[measureDraftPts.length - 1]
          : arrowStart;

    const isCornerMeasure =
      activeTool === 'measure_distance' ||
      activeTool === 'measure_area' ||
      activeTool === 'calibrate_trace';

    const snapped = snapPointToPlan(rawWorld, {
      walls: level.walls,
      furniture: level.furniture,
      gridSizeMm: settings.gridSizeMm,
      snapEnabled: settings.snapEnabled,
      angleSnapDeg: settings.angleSnapDeg,
      orthoMode: settings.orthoMode,
      anchor,
      preferCornersOnly: isCornerMeasure,
      snapThresholdMm: isCornerMeasure ? Math.max(snapThreshMm, 220) : snapThreshMm,
      alignThresholdMm: zoomSnapTols.alignTolMm,
      enableAxisAlignment: activeTool === 'wall' || activeTool === 'wall_arc',
    });

    if (dragState?.kind !== 'wall_vertex' && dragState?.kind !== 'furniture') {
      if (activeTool === 'railing' && !dragState) {
        const rSnap = snapRailingDrawPoint(rawWorld, {
          walls: level.walls,
          archElements: level.archElements,
          gridSizeMm: settings.gridSizeMm,
          snapEnabled: settings.snapEnabled,
          snapThresholdMm: Math.max(snapThreshMm, 170),
          ceilingHeightMm: level.ceilingHeightMm,
        });
        setHoverWorld(rSnap.point);
        setSnapBadge(
          rSnap.snappedKind === 'railing'
            ? 'vertex'
            : rSnap.snappedKind === 'stair_slope' ||
                rSnap.snappedKind === 'deck_edge' ||
                rSnap.snappedKind === 'wall'
              ? 'wall'
              : rSnap.snappedKind
        );
        setSnapLabel(rSnap.snapLabel);
        setRailingHoverInfo({ elevationMm: rSnap.elevationMm, label: rSnap.snapLabel });
        onCursorCoords(rSnap.point);
        setAlignmentGuides([]);
      } else {
        setHoverWorld(snapped.point);
        setSnapBadge(snapped.snappedKind);
        setSnapLabel(snapped.snapLabel);
        setRailingHoverInfo(null);
        onCursorCoords(snapped.point);
        if (!dragState && (activeTool === 'wall' || activeTool === 'wall_arc')) {
          setAlignmentGuides(snapped.guides);
        } else if (!dragState) {
          setAlignmentGuides([]);
        }
      }
    }

    if (!dragState) return;

    if (dragState.kind === 'pan') {
      if (dragState.byMiddle && (e.buttons & 4) === 0) {
        setDragState(null);
        return;
      }
      setPanPx({
        x: dragState.startPan.x + (e.clientX - dragState.startClient.x),
        y: dragState.startPan.y + (e.clientY - dragState.startClient.y),
      });
      return;
    }

    if (dragState.kind === 'marquee') {
      setDragState({
        ...dragState,
        curWorld: rawWorld,
        curClient: { x: e.clientX, y: e.clientY },
      });
      return;
    }

    if (
      !dragMutatedRef.current &&
      'startClient' in dragState &&
      dragState.startClient &&
      dragState.kind !== 'furniture'
    ) {
      const movedScreenPx = Math.hypot(
        e.clientX - dragState.startClient.x,
        e.clientY - dragState.startClient.y
      );
      if (movedScreenPx < 4) {
        return;
      }
    }

    if (dragState.kind !== 'furniture') {
      setCursorClientPos({ x: e.clientX, y: e.clientY });
    }

    if (dragState.kind === 'wall_vertex') {
      const targetWallObj = level.walls.find((w) => w.id === dragState.wallId);
      const otherEnd = targetWallObj
        ? dragState.end === 'start'
          ? targetWallObj.end
          : targetWallObj.start
        : null;
      const prevPt = targetWallObj
        ? dragState.end === 'start'
          ? targetWallObj.start
          : targetWallObj.end
        : dragState.origPoint;
      const isSingleDetached = dragState.linkedEndpoints.length === 0;
      const excludeWallIds = [dragState.wallId, ...dragState.linkedEndpoints.map((l) => l.wallId)];
      const vSnap = snapPointToPlan(rawWorld, {
        walls: level.walls,
        gridSizeMm: settings.gridSizeMm,
        snapEnabled: settings.snapEnabled && !e.shiftKey,
        angleSnapDeg: settings.angleSnapDeg,
        orthoMode: settings.orthoMode,
        anchor: isSingleDetached ? otherEnd : null,
        excludeWallIds,
        ignoreWallEnd: { wallId: dragState.wallId, endpoint: dragState.end },
        snapThresholdMm: zoomSnapTols.vertexWallTolMm,
        alignThresholdMm: zoomSnapTols.alignTolMm,
        hysteresis: snapHysteresisRef.current,
        enableAxisAlignment: true,
      });
      snapHysteresisRef.current = vSnap.hysteresis ?? {};
      const nextPt = vSnap.point;
      setHoverWorld(nextPt);
      setSnapBadge(vSnap.snappedKind);
      setSnapLabel(vSnap.snapLabel);
      setAlignmentGuides(vSnap.guides);
      onCursorCoords(nextPt);
      setCursorHint(
        resolveSingleDragHint({
          snapLabel:
            vSnap.snappedKind !== 'none' && vSnap.snappedKind !== 'grid'
              ? vSnap.snapLabel ?? (vSnap.snappedKind === 'vertex' ? 'Corner snap' : 'Aligned')
              : undefined,
        })
      );
      triggerSnapTween(
        `wall_vertex:${dragState.wallId}:${dragState.end}`,
        prevPt,
        nextPt,
        vSnap.snapKey,
        zoomSnapTols.vertexWallTolMm * 1.6
      );
      dragMutatedRef.current = true;
      const linkedMap = new Map<string, 'start' | 'end'>(
        dragState.linkedEndpoints.map((l) => [l.wallId, l.endpoint])
      );
      onUpdateLevel(
        (lvl) => {
          const targetWall = lvl.walls.find((w) => w.id === dragState.wallId);
          if (!targetWall || targetWall.locked) return lvl;
          const nextWalls = lvl.walls.map((w) => {
            if (w.id === dragState.wallId && !w.locked) {
              return {
                ...w,
                start: dragState.end === 'start' ? nextPt : w.start,
                end: dragState.end === 'end' ? nextPt : w.end,
              };
            }
            const linkedEnd = linkedMap.get(w.id);
            if (linkedEnd && !w.locked) {
              return {
                ...w,
                start: linkedEnd === 'start' ? nextPt : w.start,
                end: linkedEnd === 'end' ? nextPt : w.end,
              };
            }
            return w;
          });
          // Recompute flush positions for any wall-attached chimneys on moved walls
          const movedWallIds = new Set([dragState.wallId, ...linkedMap.keys()]);
          const nextArch = lvl.archElements.map((a) => {
            if (a.type !== 'chimney' || !a.attachedWallId || !movedWallIds.has(a.attachedWallId)) {
              return a;
            }
            const hw = nextWalls.find((w) => w.id === a.attachedWallId);
            if (!hw) return a;
            const xf = computeAttachedChimneyTransform(
              hw,
              a.attachedT ?? 0.5,
              a.depthMm,
              a.attachedFace ?? 'left'
            );
            return { ...a, xMm: xf.xMm, yMm: xf.yMm, rotationDeg: xf.rotationDeg };
          });
          const nextFurniture = propagateWallAttachments(lvl.furniture, nextWalls, movedWallIds);
          return {
            ...lvl,
            walls: nextWalls,
            archElements: nextArch,
            furniture: nextFurniture,
          };
        },
        true,
        false
      );
      return;
    }

    if (dragState.kind === 'wall_body') {
      const dx = rawWorld.x - dragState.startWorld.x;
      const dy = rawWorld.y - dragState.startWorld.y;
      const bodySnapEnabled = settings.snapEnabled && !e.shiftKey;
      const step = bodySnapEnabled ? settings.gridSizeMm : 1;
      let sdx = Math.round(dx / step) * step;
      let sdy = Math.round(dy / step) * step;
      const rawStart = { x: dragState.origStart.x + sdx, y: dragState.origStart.y + sdy };
      const rawEnd = { x: dragState.origEnd.x + sdx, y: dragState.origEnd.y + sdy };
      const bodyWallTol = Math.round(zoomSnapTols.vertexWallTolMm * 0.85);

      const sSnap = snapPointToPlan(rawStart, {
        walls: level.walls,
        gridSizeMm: settings.gridSizeMm,
        snapEnabled: bodySnapEnabled,
        angleSnapDeg: 0,
        orthoMode: false,
        excludeWallId: dragState.wallId,
        snapThresholdMm: bodyWallTol,
        alignThresholdMm: zoomSnapTols.alignTolMm,
        hysteresis: snapHysteresisRef.current,
        enableAxisAlignment: true,
      });
      const eSnap = snapPointToPlan(rawEnd, {
        walls: level.walls,
        gridSizeMm: settings.gridSizeMm,
        snapEnabled: bodySnapEnabled,
        angleSnapDeg: 0,
        orthoMode: false,
        excludeWallId: dragState.wallId,
        snapThresholdMm: bodyWallTol,
        alignThresholdMm: zoomSnapTols.alignTolMm,
        hysteresis: snapHysteresisRef.current,
        enableAxisAlignment: true,
      });

      let guides: AlignmentGuide[] = [];
      let bodySnapKey: string | undefined;
      let bodySnapLabel: string | undefined;
      if (sSnap.snappedKind === 'vertex') {
        sdx += sSnap.point.x - rawStart.x;
        sdy += sSnap.point.y - rawStart.y;
        guides = sSnap.guides;
        snapHysteresisRef.current = sSnap.hysteresis ?? {};
        bodySnapKey = sSnap.snapKey ? `s:${sSnap.snapKey}` : undefined;
        bodySnapLabel = sSnap.snapLabel ?? 'Connected corner';
      } else if (eSnap.snappedKind === 'vertex') {
        sdx += eSnap.point.x - rawEnd.x;
        sdy += eSnap.point.y - rawEnd.y;
        guides = eSnap.guides;
        snapHysteresisRef.current = eSnap.hysteresis ?? {};
        bodySnapKey = eSnap.snapKey ? `e:${eSnap.snapKey}` : undefined;
        bodySnapLabel = eSnap.snapLabel ?? 'Connected corner';
      } else {
        guides = [...sSnap.guides, ...eSnap.guides].slice(0, 3);
        if (sSnap.snappedKind === 'align') {
          sdx += sSnap.point.x - rawStart.x;
          sdy += sSnap.point.y - rawStart.y;
          snapHysteresisRef.current = sSnap.hysteresis ?? {};
          bodySnapKey = sSnap.snapKey ? `s:${sSnap.snapKey}` : undefined;
          bodySnapLabel = sSnap.snapLabel ?? 'Aligned';
        } else if (eSnap.snappedKind === 'align') {
          sdx += eSnap.point.x - rawEnd.x;
          sdy += eSnap.point.y - rawEnd.y;
          snapHysteresisRef.current = eSnap.hysteresis ?? {};
          bodySnapKey = eSnap.snapKey ? `e:${eSnap.snapKey}` : undefined;
          bodySnapLabel = eSnap.snapLabel ?? 'Aligned';
        } else {
          snapHysteresisRef.current = {};
        }
      }

      setAlignmentGuides(guides);
      setCursorHint(resolveSingleDragHint({ snapLabel: bodySnapLabel }));
      const nextStart = { x: dragState.origStart.x + sdx, y: dragState.origStart.y + sdy };
      const nextEnd = { x: dragState.origEnd.x + sdx, y: dragState.origEnd.y + sdy };
      const curWall = level.walls.find((w) => w.id === dragState.wallId);
      triggerSnapTween(
        `wall_body:${dragState.wallId}`,
        curWall?.start ?? dragState.origStart,
        nextStart,
        bodySnapKey,
        zoomSnapTols.vertexWallTolMm * 1.6
      );
      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => {
          const cur = lvl.walls.find((w) => w.id === dragState.wallId);
          if (!cur || cur.locked) return lvl;
          // Move ONLY the dragged wall; disconnect prior wall-attached chimneys without dragging other walls,
          // and keep wall-mounted furniture synced flush onto the moved wall.
          const nextWalls = lvl.walls.map((w) =>
            w.id === dragState.wallId ? { ...w, start: nextStart, end: nextEnd } : w
          );
          const nextFurniture = propagateWallAttachments(
            lvl.furniture,
            nextWalls,
            new Set([dragState.wallId])
          );
          return {
            ...lvl,
            walls: nextWalls,
            archElements: lvl.archElements.map((a) =>
              a.attachedWallId === dragState.wallId
                ? { ...a, attachedWallId: undefined, attachedFace: undefined, attachedT: undefined }
                : a
            ),
            furniture: nextFurniture,
          };
        },
        true,
        false
      );
      return;
    }

    if (dragState.kind === 'opening') {
      const op = level.openings.find((o) => o.id === dragState.openingId);
      if (!op || op.locked) return;
      const wall = level.walls.find((w) => w.id === op.wallId);
      if (!wall || wall.locked) return;
      const wallLen = getWallArcLength(wall);
      const proj = projectPointOnSegment(rawWorld, wall.start, wall.end);
      const bounds = computeWallInnerBounds(wall, level.walls);
      const comps = getWallMountedComponents(wall, level.openings, level.archElements);
      const solved = solveWallComponentDrag(
        comps,
        bounds,
        op.id,
        proj.t * wallLen,
        settings.snapEnabled && !e.shiftKey,
        zoomSnapTols.furnFlushTolMm,
        snapHysteresisRef.current.wallComponentKey
      );
      snapHysteresisRef.current = {
        ...snapHysteresisRef.current,
        wallComponentKey: solved.snapKey,
      };
      const prevPt = getWallCenterlinePoint(wall, op.t).point;
      const nextPt = getWallCenterlinePoint(wall, solved.t).point;
      triggerSnapTween(
        `opening:${op.id}`,
        prevPt,
        nextPt,
        solved.snapKey,
        zoomSnapTols.furnFlushTolMm * 1.6
      );
      setCursorHint(
        resolveSingleDragHint({
          attachedToWall: true,
          snapLabel: solved.snappedTo,
        })
      );
      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          openings: lvl.openings.map((o) => (o.id === op.id ? { ...o, t: solved.t } : o)),
        }),
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'comp_edge') {
      const wall = level.walls.find((w) => w.id === dragState.wallId);
      if (!wall || wall.locked) return;
      const wallLen = getWallArcLength(wall);
      if (wallLen < 1) return;
      const ux = (wall.end.x - wall.start.x) / wallLen;
      const uy = (wall.end.y - wall.start.y) / wallLen;
      let rawS = (rawWorld.x - wall.start.x) * ux + (rawWorld.y - wall.start.y) * uy;

      const bounds = computeWallInnerBounds(wall, level.walls);
      const comps = getWallMountedComponents(wall, level.openings, level.archElements);
      const target = comps.find((c) => c.id === dragState.compId);
      if (!target || target.locked) return;

      if (settings.snapEnabled && !e.shiftKey) {
        const edgeCands = [
          { key: 'inner_start', dist: Math.abs(bounds.innerStartS - rawS), data: bounds.innerStartS },
          { key: 'inner_end', dist: Math.abs(bounds.innerEndS - rawS), data: bounds.innerEndS },
          ...comps
            .filter((c) => c.id !== target.id)
            .flatMap((c) => [
              { key: `comp_${c.id}_l`, dist: Math.abs(c.leftS - rawS), data: c.leftS },
              { key: `comp_${c.id}_r`, dist: Math.abs(c.rightS - rawS), data: c.rightS },
            ]),
        ];
        const picked = pickWithSnapHysteresis(
          edgeCands,
          snapHysteresisRef.current.edgeSKey,
          zoomSnapTols.furnFlushTolMm
        );
        snapHysteresisRef.current = {
          ...snapHysteresisRef.current,
          edgeSKey: picked?.key,
        };
        if (picked) {
          rawS = picked.data;
          setCursorHint(resolveSingleDragHint({ snapLabel: 'Aligned edge' }));
        } else {
          const step = Math.max(10, Math.min(50, settings.gridSizeMm));
          rawS = Math.round(rawS / step) * step;
          setCursorHint(null);
        }
      } else {
        snapHysteresisRef.current = {};
        setCursorHint(null);
      }

      const rawWidthMm =
        dragState.edge === 'left'
          ? Math.round(target.rightS - rawS)
          : Math.round(rawS - target.leftS);
      const minW = dragState.compKind === 'chimney' ? 50 : 150;
      const anchor = dragState.edge === 'left' ? 'right' : 'left';

      if (dragState.compKind === 'chimney') {
        const chimEl = level.archElements.find((a) => a.id === dragState.compId);
        if (!chimEl) return;
        const solvedChim = solveChimneyResize(
          wall,
          level.walls,
          level.openings,
          level.archElements,
          dragState.compId,
          Math.max(minW, rawWidthMm),
          chimEl.depthMm,
          anchor
        );
        if (!solvedChim.ok) {
          onConstraintError?.(solvedChim.error ?? 'Cannot resize chimney further.');
          return;
        }
        dragMutatedRef.current = true;
        const updateMap = new Map(solvedChim.updates.map((u) => [u.id, u]));
        onUpdateLevel(
          (lvl) => {
            const host = lvl.walls.find((w) => w.id === dragState.wallId);
            return {
              ...lvl,
              openings: lvl.openings.map((o) => {
                const u = updateMap.get(o.id);
                return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
              }),
              archElements: lvl.archElements.map((a) => {
                const u = updateMap.get(a.id);
                if (!u || u.kind !== 'chimney' || !host) return a;
                const xf = computeAttachedChimneyTransform(
                  host,
                  u.t,
                  a.depthMm,
                  a.attachedFace ?? 'left'
                );
                return {
                  ...a,
                  widthMm: u.widthMm,
                  attachedT: u.t,
                  xMm: xf.xMm,
                  yMm: xf.yMm,
                  rotationDeg: xf.rotationDeg,
                  resizeAnchor:
                    a.id === dragState.compId
                      ? solvedChim.cornerPin ?? a.resizeAnchor
                      : a.resizeAnchor,
                };
              }),
            };
          },
          false,
          false
        );
        return;
      }

      const solved = solveWallComponentResize(
        wall,
        comps,
        bounds,
        dragState.compId,
        Math.max(minW, rawWidthMm),
        anchor
      );
      if (!solved.ok) {
        onConstraintError?.(solved.error ?? 'Cannot resize component further.');
        return;
      }

      dragMutatedRef.current = true;
      const updateMap = new Map(solved.updates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => {
          const host = lvl.walls.find((w) => w.id === dragState.wallId);
          return {
            ...lvl,
            openings: lvl.openings.map((o) => {
              const u = updateMap.get(o.id);
              return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
            }),
            archElements: lvl.archElements.map((a) => {
              const u = updateMap.get(a.id);
              if (!u || u.kind !== 'chimney' || !host) return a;
              const xf = computeAttachedChimneyTransform(
                host,
                u.t,
                a.depthMm,
                a.attachedFace ?? 'left'
              );
              return {
                ...a,
                widthMm: u.widthMm,
                attachedT: u.t,
                xMm: xf.xMm,
                yMm: xf.yMm,
                rotationDeg: xf.rotationDeg,
              };
            }),
          };
        },
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'chimney_depth') {
      const wall = level.walls.find((w) => w.id === dragState.wallId);
      const chimEl = level.archElements.find((a) => a.id === dragState.compId);
      if (!wall || !chimEl || chimEl.locked) return;
      const wallLen = getWallArcLength(wall);
      if (wallLen < 1) return;
      const ux = (wall.end.x - wall.start.x) / wallLen;
      const uy = (wall.end.y - wall.start.y) / wallLen;
      const nx = -uy;
      const ny = ux;
      const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
      const face = chimEl.attachedFace ?? 'left';
      const dNorm = (rawWorld.x - wall.start.x) * nx + (rawWorld.y - wall.start.y) * ny;
      const rawDepthMm = face === 'left' ? dNorm - left : right - dNorm;
      const step = settings.snapEnabled ? Math.max(10, Math.min(50, settings.gridSizeMm)) : 10;
      const nextDepthMm = Math.max(50, Math.round(rawDepthMm / step) * step);

      const solved = solveChimneyResize(
        wall,
        level.walls,
        level.openings,
        level.archElements,
        chimEl.id,
        chimEl.widthMm,
        nextDepthMm
      );
      if (!solved.ok) {
        onConstraintError?.(solved.error ?? 'Cannot extend chimney depth further.');
        return;
      }

      dragMutatedRef.current = true;
      const updateMap = new Map(solved.updates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => {
          const host = lvl.walls.find((w) => w.id === dragState.wallId);
          return {
            ...lvl,
            openings: lvl.openings.map((o) => {
              const u = updateMap.get(o.id);
              return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
            }),
            archElements: lvl.archElements.map((a) => {
              const u = updateMap.get(a.id);
              if (!u || u.kind !== 'chimney' || !host) return a;
              const useDepth = a.id === chimEl.id ? solved.depthMm : a.depthMm;
              const xf = computeAttachedChimneyTransform(
                host,
                u.t,
                useDepth,
                a.attachedFace ?? 'left'
              );
              return {
                ...a,
                depthMm: useDepth,
                widthMm: u.widthMm,
                attachedT: u.t,
                xMm: xf.xMm,
                yMm: xf.yMm,
                rotationDeg: xf.rotationDeg,
                resizeAnchor:
                  a.id === chimEl.id ? solved.cornerPin ?? a.resizeAnchor : a.resizeAnchor,
              };
            }),
          };
        },
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'furniture') {
      heldShiftRef.current = e.shiftKey;
      heldCtrlRef.current = e.ctrlKey && !e.metaKey;
      const { shiftActive, ctrlActive } = getEffectiveModifiers(
        e.shiftKey,
        e.ctrlKey && !e.metaKey
      );
      lastDragPointerRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        shiftKey: shiftActive,
        ctrlKey: ctrlActive,
      };
      const movedScreenPx = Math.hypot(
        e.clientX - dragState.startClient.x,
        e.clientY - dragState.startClient.y
      );
      if (!dragMutatedRef.current && movedScreenPx < 4) {
        return;
      }
      executeFurnitureDragMove(
        dragState.id,
        dragState.offsetMm,
        e.clientX,
        e.clientY,
        shiftActive,
        ctrlActive
      );
      return;
    }

    if (dragState.kind === 'furniture_rotate') {
      const curPointerDeg =
        (Math.atan2(rawWorld.y - dragState.center.y, rawWorld.x - dragState.center.x) * 180) /
        Math.PI;
      let delta = curPointerDeg - dragState.startPointerDeg;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      const rawDeg = dragState.origRotDeg + delta;
      const freeRotate = e.shiftKey || settings.angleSnapDeg <= 0;
      const step = freeRotate ? 0.5 : settings.angleSnapDeg;
      const stepped = freeRotate ? Math.round(rawDeg * 2) / 2 : Math.round(rawDeg / step) * step;
      const normalizedDeg = ((stepped % 360) + 360) % 360;
      dragMutatedRef.current = true;
      setRotateReadout({
        furnId: dragState.id,
        deg: normalizedDeg,
        snapped: !freeRotate,
        step,
      });
      onUpdateLevel(
        (lvl) => {
          const prevParent = lvl.furniture.find((f) => f.id === dragState.id);
          if (!prevParent || prevParent.locked) return lvl;
          const detachedFromWall =
            Boolean(prevParent.attachedWallId) &&
            Math.abs(normalizedDeg - prevParent.rotationDeg) > 0.5;
          const nextParent: FurnitureInstance = {
            ...prevParent,
            rotationDeg: normalizedDeg,
            ...(detachedFromWall
              ? { attachedWallId: undefined, attachedFace: undefined, attachedT: undefined }
              : {}),
          };
          let nextList = lvl.furniture.map((f) => (f.id === dragState.id ? nextParent : f));
          nextList = propagateParentFurnitureTransforms(
            nextList,
            dragState.id,
            prevParent,
            nextParent
          );
          return {
            ...lvl,
            furniture: nextList,
          };
        },
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'part_edge') {
      const furn = level.furniture.find((f) => f.id === dragState.furnId);
      if (!furn || furn.locked) return;
      const { x: localX, y: localY } = getFurniturePlacement(furn).worldToLocalPlan2D(
        rawWorld.x,
        rawWorld.y
      );
      const dX = Math.round(localX - dragState.startLocal.x);
      const dY = Math.round(localY - dragState.startLocal.y);
      const o = dragState.origPart;

      let nextW = o.widthMm;
      let nextD = o.depthMm;
      let nextX = o.xMm;
      let nextY = o.yMm;

      if (dragState.edge === 'right') {
        nextW = Math.max(40, o.widthMm + dX);
        nextX = o.xMm + (nextW - o.widthMm) / 2;
      } else if (dragState.edge === 'left') {
        nextW = Math.max(40, o.widthMm - dX);
        nextX = o.xMm - (nextW - o.widthMm) / 2;
      } else if (dragState.edge === 'bottom') {
        nextD = Math.max(40, o.depthMm + dY);
        nextY = o.yMm + (nextD - o.depthMm) / 2;
      } else if (dragState.edge === 'top') {
        nextD = Math.max(40, o.depthMm - dY);
        nextY = o.yMm - (nextD - o.depthMm) / 2;
      }

      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => {
          const prevParent = lvl.furniture.find((f) => f.id === furn.id);
          if (!prevParent || prevParent.locked) return lvl;
          const nextParent: FurnitureInstance = {
            ...prevParent,
            parts: prevParent.parts.map((p) =>
              p.id === dragState.partId
                ? { ...p, widthMm: nextW, depthMm: nextD, xMm: nextX, yMm: nextY }
                : p
            ),
          };
          let nextList = lvl.furniture.map((f) => (f.id === furn.id ? nextParent : f));
          nextList = propagateParentFurnitureTransforms(nextList, furn.id, prevParent, nextParent);
          return {
            ...lvl,
            furniture: nextList,
          };
        },
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'curtain' || dragState.kind === 'person' || dragState.kind === 'arch') {
      const g = settings.snapEnabled ? settings.gridSizeMm : 1;
      const nx = Math.round((rawWorld.x - dragState.offsetMm.x) / g) * g;
      const ny = Math.round((rawWorld.y - dragState.offsetMm.y) / g) * g;
      const rawTarget = {
        x: rawWorld.x - dragState.offsetMm.x,
        y: rawWorld.y - dragState.offsetMm.y,
      };

      if (dragState.kind === 'arch') {
        const el = level.archElements.find((a) => a.id === dragState.id);
        if (!el || el.locked) return;
        if (el.type === 'chimney') {
          const hasVisibleWalls = level.walls.some((w) => w.visible !== false);
          if (hasVisibleWalls) {
            const snap = snapChimneyToWallEdge(
              rawTarget,
              el.widthMm,
              el.depthMm,
              level.walls,
              level.openings,
              level.archElements,
              el.id,
              settings.snapEnabled && !e.shiftKey,
              el.attachedWallId,
              el.attachedFace,
              {
                snapThresholdMm: zoomSnapTols.furnFlushTolMm,
                hysteresisPrevKey: snapHysteresisRef.current.wallComponentKey,
              }
            );
            if (!snap) {
              return;
            }
            snapHysteresisRef.current = {
              ...snapHysteresisRef.current,
              wallComponentKey: snap.snapKey,
            };
            triggerSnapTween(
              `arch:${el.id}`,
              { x: el.xMm, y: el.yMm },
              { x: snap.xMm, y: snap.yMm },
              snap.snapKey,
              zoomSnapTols.vertexWallTolMm * 1.6
            );
            setCursorHint(resolveSingleDragHint({ attachedToWall: true }));
            dragMutatedRef.current = true;
            onUpdateLevel(
              (lvl) => ({
                ...lvl,
                archElements: lvl.archElements.map((a) =>
                  a.id === el.id
                    ? {
                        ...a,
                        xMm: snap.xMm,
                        yMm: snap.yMm,
                        rotationDeg: snap.rotationDeg,
                        attachedWallId: snap.wallId,
                        attachedFace: snap.face,
                        attachedT: snap.t,
                        resizeAnchor:
                          snap.cornerPin ??
                          (a.attachedWallId === snap.wallId && a.attachedFace === snap.face
                            ? a.resizeAnchor
                            : 'center'),
                      }
                    : a
                ),
              }),
              false,
              false
            );
            return;
          }
          setCursorHint(null);
          dragMutatedRef.current = true;
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              archElements: lvl.archElements.map((a) =>
                a.id === el.id
                  ? {
                      ...a,
                      xMm: nx,
                      yMm: ny,
                      attachedWallId: undefined,
                      attachedFace: undefined,
                      attachedT: undefined,
                    }
                  : a
              ),
            }),
            false,
            false
          );
          return;
        }

        const archSnap = snapArchElementToPlan(
          rawTarget,
          el,
          level.walls,
          level.archElements,
          {
            snapEnabled: settings.snapEnabled && !e.shiftKey,
            gridSizeMm: settings.gridSizeMm,
            blockTolMm: zoomSnapTols.furnFlushTolMm,
            wallTolMm: zoomSnapTols.vertexWallTolMm,
            hysteresis: snapHysteresisRef.current,
          }
        );
        snapHysteresisRef.current = archSnap.hysteresis ?? {};
        setAlignmentGuides(archSnap.guides);
        setSnapBadge(
          archSnap.snappedKind === 'align'
            ? 'align'
            : archSnap.snappedKind === 'grid'
              ? 'grid'
              : 'none'
        );
        setSnapLabel(archSnap.snapLabel);
        setCursorHint(
          resolveSingleDragHint({
            snapLabel: archSnap.snappedKind === 'align' ? archSnap.snapLabel : undefined,
          })
        );
        triggerSnapTween(
          `arch:${el.id}`,
          { x: el.xMm, y: el.yMm },
          { x: archSnap.xMm, y: archSnap.yMm },
          archSnap.snapKey,
          zoomSnapTols.vertexWallTolMm * 1.6
        );
        dragMutatedRef.current = true;
        onUpdateLevel(
          (lvl) => ({
            ...lvl,
            archElements: lvl.archElements.map((a) =>
              a.id === el.id ? { ...a, xMm: archSnap.xMm, yMm: archSnap.yMm } : a
            ),
          }),
          false,
          false
        );
        return;
      }

      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          curtains:
            dragState.kind === 'curtain'
              ? lvl.curtains.map((c) => {
                  if (c.id !== dragState.id || c.locked) return c;
                  const snap = snapStandaloneCurtainToWall(rawTarget, c, lvl.walls);
                  return {
                    ...c,
                    xMm: snap.xMm,
                    yMm: snap.yMm,
                    rotationDeg: snap.rotationDeg,
                    wallId: snap.wallId ?? c.wallId,
                  };
                })
              : lvl.curtains,
          people:
            dragState.kind === 'person'
              ? lvl.people.map((p) => (p.id === dragState.id && !p.locked ? { ...p, xMm: nx, yMm: ny } : p))
              : lvl.people,
        }),
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'railing_node') {
      const targetEl = level.archElements.find((a) => a.id === dragState.elId);
      if (!targetEl || targetEl.locked) return;
      const rSnap = snapRailingDrawPoint(rawWorld, {
        walls: level.walls,
        archElements: level.archElements,
        gridSizeMm: settings.gridSizeMm,
        snapEnabled: settings.snapEnabled && !e.shiftKey,
        snapThresholdMm: Math.max(snapThreshMm, 170),
        ceilingHeightMm: level.ceilingHeightMm,
        excludeArchId: dragState.elId,
      });
      const worldTarget = e.shiftKey ? rawWorld : rSnap.point;
      setHoverWorld(worldTarget);
      setSnapBadge(
        rSnap.snappedKind === 'railing'
          ? 'vertex'
          : rSnap.snappedKind === 'stair_slope' ||
              rSnap.snappedKind === 'deck_edge' ||
              rSnap.snappedKind === 'wall'
            ? 'wall'
            : rSnap.snappedKind
      );
      setSnapLabel(rSnap.snapLabel);
      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          archElements: lvl.archElements.map((a) => {
            if (a.id !== dragState.elId || a.locked) return a;
            const cfg = resolveRailingConfig(a);
            const localPt = worldToLocalPoint(a.xMm, a.yMm, a.rotationDeg, worldTarget.x, worldTarget.y);
            const nextNodes = cfg.nodes.map((n, idx) => {
              if (idx !== dragState.nodeIndex) return n;
              const useSnapElev =
                !e.shiftKey &&
                (rSnap.snappedKind === 'stair_slope' ||
                  rSnap.snappedKind === 'deck_edge' ||
                  rSnap.snappedKind === 'railing');
              return {
                xMm: Math.round(localPt.x),
                yMm: Math.round(localPt.y),
                elevationMm: useSnapElev
                  ? Math.round(rSnap.elevationMm - a.elevationMm)
                  : (n.elevationMm ?? 0),
              };
            });
            const rec = recenterRailingNodes(nextNodes, cfg.widthMm);
            const newOrigin = localToWorldPoint(
              a.xMm,
              a.yMm,
              a.rotationDeg,
              rec.centerLocal.x,
              rec.centerLocal.y
            );
            return {
              ...a,
              xMm: Math.round(newOrigin.x),
              yMm: Math.round(newOrigin.y),
              widthMm: rec.widthMm,
              depthMm: rec.depthMm,
              railing: { ...cfg, nodes: rec.nodes },
            };
          }),
        }),
        false,
        false
      );
      return;
    }

    if (dragState.kind === 'section_end') {
      dragMutatedRef.current = true;
      onUpdateLevel(
        (lvl) => {
          if (!lvl.sectionLine) return lvl;
          return {
            ...lvl,
            sectionLine: {
              ...lvl.sectionLine,
              [dragState.end]: snapped.point,
            },
          };
        },
        false,
        false
      );
    }
  };

  const handleSvgPointerUp = (e?: React.PointerEvent<SVGSVGElement>) => {
    if (e) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }
    }
    if (dragState?.kind === 'marquee') {
      const movedPx = Math.hypot(
        dragState.curClient.x - dragState.startClient.x,
        dragState.curClient.y - dragState.startClient.y
      );
      if (movedPx >= 4) {
        const mMode = resolveMarqueeMode(dragState.startClient.x, dragState.curClient.x);
        const hits = evaluateMarqueeSelection(level, dragState.startWorld, dragState.curWorld, mMode);
        const merged = mergeMarqueeSelection(dragState.prevSelection, hits, dragState.shiftKey);
        if (merged.length > 0 || !dragState.shiftKey) {
          onSelect(merged);
        }
      } else if (dragState.roomClickTarget) {
        const target = dragState.roomClickTarget;
        if (dragState.ctrlKey) {
          const exists = dragState.prevSelection.some((s) => s.kind === target.kind && s.id === target.id);
          if (exists) {
            onSelect(dragState.prevSelection.filter((s) => !(s.kind === target.kind && s.id === target.id)));
          } else {
            onSelect([...dragState.prevSelection, target]);
          }
        } else {
          onSelect([target]);
        }
      }
    } else if (
      dragState?.kind === 'furniture' &&
      !dragMutatedRef.current &&
      dragState.wasAlreadySelected
    ) {
      if (dragState.ctrlToggleOnClick) {
        onSelect(selection.filter((s) => !(s.kind === 'furniture' && s.id === dragState.id)));
      } else if (dragState.altOnDown && dragState.stackHitIds.length > 1) {
        const nextId = resolveAltStackClickId(dragState.stackHitIds, selection);
        if (nextId) onSelect([{ kind: 'furniture', id: nextId }]);
      } else {
        const topId = resolvePlainStackClickId(dragState.stackHitIds);
        if ((topId && topId !== dragState.id) || selection.length > 1) {
          onSelect([{ kind: 'furniture', id: topId || dragState.id }]);
        } else if (
          dragState.stackHitIds.length <= 1 &&
          dragState.subPartCandidateId &&
          selection.length === 1 &&
          selection[0].kind === 'furniture' &&
          selection[0].id === dragState.id
        ) {
          onSelect([
            { kind: 'furniture', id: dragState.id, partId: dragState.subPartCandidateId },
          ]);
        }
      }
    } else if (dragState && 'label' in dragState && dragMutatedRef.current) {
      if (dragState.kind === 'wall_vertex' && snapBadge === 'vertex' && hoverWorld) {
        setSnapPulse({ point: hoverWorld, label: 'Connected Corner' });
      }
      onCommitDrag(dragState.label);
    }
    dragMutatedRef.current = false;
    lastDragPointerRef.current = null;
    dragStackCandidatesRef.current = [];
    preferredStackHostIdRef.current = undefined;
    snapHysteresisRef.current = {};
    hostDwellRef.current = createHostDwellTracker(undefined);
    clearHostDwellTimer();
    setAlignmentGuides([]);
    setSnapBadge('none');
    setSnapLabel(undefined);
    setAttachmentPreview(null);
    setRoomCenterSnapTarget(null);
    setRotateReadout(null);
    setDragState(null);
    setCursorHint(null);
    setCursorClientPos(null);
  };

  const handleSvgPointerCancel = () => {
    const cur = dragStateRef.current;
    if (cur?.kind === 'marquee') {
      onSelect(cur.prevSelection);
    } else if (cur?.kind === 'pan') {
      setPanPx(cur.startPan);
    } else if (cur && 'label' in cur) {
      onCancelDrag();
    }
    dragMutatedRef.current = false;
    lastDragPointerRef.current = null;
    dragStackCandidatesRef.current = [];
    preferredStackHostIdRef.current = undefined;
    snapHysteresisRef.current = {};
    hostDwellRef.current = createHostDwellTracker(undefined);
    clearHostDwellTimer();
    clearSnapTween();
    setAlignmentGuides([]);
    setSnapBadge('none');
    setSnapLabel(undefined);
    setAttachmentPreview(null);
    setRoomCenterSnapTarget(null);
    setCursorHint(null);
    setCursorClientPos(null);
    setRotateReadout(null);
    setDragState(null);
  };
  const handleSvgPointerCancelRef = useRef(handleSvgPointerCancel);
  handleSvgPointerCancelRef.current = handleSvgPointerCancel;

  const handleDoubleClick = () => {
    if (activeTool === 'railing' && railingDraftPts.length >= 2) {
      commitRailingDraft(railingDraftPts, false);
      return;
    }
    if (wallDraftPts.length > 0) {
      setWallDraftPts([]);
      onToolChange('select');
    }
    if (activeTool === 'measure_area' && measureDraftPts.length >= 3) {
      const areaM2 = computePolygonAreaM2(measureDraftPts);
      const perimeterM = computePolygonPerimeterM(measureDraftPts);
      setActiveAreaResult({ points: measureDraftPts, areaM2, perimeterM });
      setMeasureDraftPts([]);
    }
  };

  const handleElementSelect = (e: React.PointerEvent, target: SelectionTarget, colorHint?: string) => {
    // Allow middle mouse button to pan and right-click context menu to preserve multi-selection
    if (e.button === 1 || e.button === 2) return;
    if (activeTool === 'eyedropper' && colorHint) {
      e.stopPropagation();
      onPickEyedropperColor(colorHint);
      return;
    }
    if (activeTool !== 'select') {
      return;
    }
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const exists = selection.some((s) => s.kind === target.kind && s.id === target.id);
      if (exists) {
        onSelect(selection.filter((s) => !(s.kind === target.kind && s.id === target.id)));
      } else {
        onSelect([...selection, target]);
      }
    } else {
      onSelect([target]);
    }
  };

  const isBw = !!settings.blackAndWhite2d;

  const furnElevInfo = useMemo(
    () => computePlanFurnitureOverlapMetadata(level.furniture, level.ceilingHeightMm),
    [level.furniture, level.ceilingHeightMm]
  );

  const orderedPlanFurniture = useMemo(
    () => sortFurnitureByElevationForPlan(level.furniture, furnElevInfo, level.ceilingHeightMm),
    [level.furniture, furnElevInfo, level.ceilingHeightMm]
  );

  const clashRegions = useMemo(
    () => computeFurnitureClashIntersectionRegions(level.furniture),
    [level.furniture]
  );

  const selectedStackInfo = useMemo(() => {
    if (selection.length !== 1 || selection[0].kind !== 'furniture') return null;
    const selId = selection[0].id;
    const selInfo = furnElevInfo.get(selId);
    if (!selInfo || selInfo.sameSpotOverlapIds.length === 0) return null;

    // Collect the full local overlapping stack cluster (already domain-isolated from wall/floor mismatches)
    const stackSet = new Set<string>([selId]);
    const queue = [selId];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      const curInfo = furnElevInfo.get(cur);
      if (!curInfo) continue;
      for (const nxt of curInfo.sameSpotOverlapIds) {
        if (!stackSet.has(nxt)) {
          stackSet.add(nxt);
          queue.push(nxt);
        }
      }
    }

    // Order topmost-first so the Vertical Stack card reads physically Top (1) -> Bottom (N)
    const stackItems = [...orderedPlanFurniture]
      .reverse()
      .filter((item) => item.visible !== false && stackSet.has(item.id));
    if (stackItems.length < 2) return null;

    const selFurn = level.furniture.find((item) => item.id === selId);
    if (!selFurn || selFurn.visible === false) return null;

    const canSwapZLayer = (a: FurnitureInstance, b: FurnitureInstance): boolean => {
      const aInfo = furnElevInfo.get(a.id);
      const bInfo = furnElevInfo.get(b.id);
      if (!aInfo || !bInfo) return false;
      const aIsRug = aInfo.band === 'rug' || isRugFurniture(a);
      const bIsRug = bInfo.band === 'rug' || isRugFurniture(b);
      if (aIsRug !== bIsRug) return false;
      const aOver = aInfo.band === 'overhead';
      const bOver = bInfo.band === 'overhead';
      if (aOver !== bOver) return false;
      if (a.surfaceHostId !== b.surfaceHostId) return false;
      return (
        Math.abs(aInfo.span.maxZ - bInfo.span.maxZ) <= 5 &&
        Math.abs(aInfo.span.minZ - bInfo.span.minZ) <= 5
      );
    };

    let maxElevMm = 100;
    const mappedItems = stackItems.map((item, idx) => {
      const localZ = getEffectiveFurnitureZOrder(item, 0);
      const span = furnElevInfo.get(item.id)?.span ?? {
        minZ: item.elevationMm ?? 0,
        maxZ: (item.elevationMm ?? 0) + 100,
      };
      if (span.maxZ > maxElevMm) maxElevMm = span.maxZ;
      const posLabel =
        idx === 0 ? 'Top' : idx === stackItems.length - 1 ? 'Bottom' : 'Middle';
      const canMoveUp = idx > 0 && canSwapZLayer(item, stackItems[idx - 1]);
      const canMoveDown =
        idx < stackItems.length - 1 && canSwapZLayer(item, stackItems[idx + 1]);
      return {
        id: item.id,
        tier: idx + 1,
        name: item.name,
        localZ,
        minZMm: Math.max(0, span.minZ),
        maxZMm: Math.max(Math.max(0, span.minZ), span.maxZ),
        posLabel,
        canMoveUp,
        canMoveDown,
        isSelected: item.id === selId,
      };
    });

    return {
      stackSet,
      maxElevMm,
      items: mappedItems,
    };
  }, [furnElevInfo, level.furniture, orderedPlanFurniture, selection]);

  const stackVisualData = useMemo(
    () =>
      computePlanStackVisualData(
        orderedPlanFurniture,
        furnElevInfo,
        pxPerMm,
        level.ceilingHeightMm,
        snapTweenOffset
      ),
    [orderedPlanFurniture, furnElevInfo, pxPerMm, level.ceilingHeightMm, snapTweenOffset]
  );

  const handleFurniturePointerDown = useCallback(
    (
      e: React.PointerEvent,
      f: FurnitureInstance,
      colorHint?: string,
      subPartCandidateId?: string
    ) => {
      if (e.button === 1) return;
      if (activeTool === 'eyedropper') {
        e.stopPropagation();
        onPickEyedropperColor(colorHint ?? f.parts[0]?.color ?? '#FFFFFF');
        return;
      }
      if (activeTool !== 'select') return;
      e.stopPropagation();
      if (e.button !== 0) return;

      const w = screenToWorld(e.clientX, e.clientY);
      const rawHits = findFurnitureHitsAtPoint(
        w,
        level.furniture,
        furnElevInfo,
        level.ceilingHeightMm,
        Math.max(14, 10 / pxPerMm)
      );
      const stackHits = rawHits.some((h) => h.id === f.id)
        ? rawHits
        : [f, ...rawHits];
      const alreadySelectedInStack = stackHits.find((h) => isSelected('furniture', h.id));
      const targetFurn = alreadySelectedInStack ?? stackHits[0] ?? f;
      const wasAlreadySelected = Boolean(alreadySelectedInStack);

      const isCtrlModifier = e.ctrlKey && !e.metaKey;
      if (e.metaKey || (isCtrlModifier && !wasAlreadySelected)) {
        handleElementSelect(e, { kind: 'furniture', id: f.id }, colorHint);
        return;
      }

      // First click on an unselected object ONLY selects it without initiating drag
      if (!wasAlreadySelected && !e.shiftKey) {
        if (e.altKey && stackHits.length > 1) {
          const belowId = resolveAltStackClickId(
            stackHits.map((h) => h.id),
            selection
          );
          onSelect([{ kind: 'furniture', id: belowId ?? targetFurn.id }]);
        } else {
          onSelect([{ kind: 'furniture', id: (stackHits[0] ?? f).id }]);
        }
        return;
      }

      clearHostDwellTimer();
      clearSnapTween();
      setCursorHint(null);
      setCursorClientPos(null);
      snapHysteresisRef.current = {};
      hostDwellRef.current = createHostDwellTracker(targetFurn.surfaceHostId);
      dragMutatedRef.current = false;
      dragStackCandidatesRef.current = [];
      preferredStackHostIdRef.current = undefined;
      const { shiftActive, ctrlActive } = getEffectiveModifiers(
        e.shiftKey,
        e.ctrlKey && !e.metaKey
      );
      lastDragPointerRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        shiftKey: shiftActive,
        ctrlKey: ctrlActive,
      };
      const selectedFurnCount = selection.filter((s) => s.kind === 'furniture').length;
      setDragState({
        kind: 'furniture',
        id: targetFurn.id,
        offsetMm: { x: w.x - targetFurn.xMm, y: w.y - targetFurn.yMm },
        startClient: { x: e.clientX, y: e.clientY },
        wasAlreadySelected,
        ctrlToggleOnClick: isCtrlModifier && wasAlreadySelected,
        altOnDown: e.altKey,
        stackHitIds: stackHits.map((h) => h.id),
        subPartCandidateId:
          subPartCandidateId && targetFurn.id === f.id ? subPartCandidateId : undefined,
        label:
          selectedFurnCount > 1 && selection.some((s) => s.kind === 'furniture' && s.id === targetFurn.id)
            ? `Move ${selectedFurnCount} items`
            : `Move ${targetFurn.name}`,
      });
    },
    [
      activeTool,
      furnElevInfo,
      isSelected,
      level.ceilingHeightMm,
      level.furniture,
      onPickEyedropperColor,
      onSelect,
      pxPerMm,
      screenToWorld,
      selection,
    ]
  );

  const getStackOrderForFurnitureId = useCallback(
    (furnId: string, pointWorld?: Point2D): string[] => {
      if (pointWorld) {
        const hits = findFurnitureHitsAtPoint(
          pointWorld,
          level.furniture,
          furnElevInfo,
          level.ceilingHeightMm,
          Math.max(14, 10 / pxPerMm)
        );
        if (hits.length > 1 && hits.some((h) => h.id === furnId)) {
          return hits.map((h) => h.id);
        }
      }
      const info = furnElevInfo.get(furnId);
      if (!info || info.sameSpotOverlapIds.length === 0) return [furnId];
      const cluster = new Set<string>([furnId]);
      const queue = [furnId];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cInfo = furnElevInfo.get(cur);
        if (!cInfo) continue;
        for (const nxt of cInfo.sameSpotOverlapIds) {
          if (!cluster.has(nxt)) {
            cluster.add(nxt);
            queue.push(nxt);
          }
        }
      }
      return [...orderedPlanFurniture]
        .reverse()
        .filter((item) => item.visible !== false && cluster.has(item.id))
        .map((item) => item.id);
    },
    [furnElevInfo, level.ceilingHeightMm, level.furniture, orderedPlanFurniture, pxPerMm]
  );

  const openContextMenuForTarget = useCallback(
    (clientX: number, clientY: number, hitTarget: SelectionTarget | null) => {
      if (!hitTarget) {
        setContextMenu({
          kind: 'empty',
          clientX,
          clientY,
          canPaste: hasClipboard,
        });
        return;
      }

      const w = screenToWorld(clientX, clientY);
      let activeSel = selection;
      let primaryTarget = hitTarget;

      if (hitTarget.kind === 'furniture') {
        const stackIds = getStackOrderForFurnitureId(hitTarget.id, w);
        const alreadySelId = stackIds.find((id) => isSelected('furniture', id));
        if (alreadySelId) {
          primaryTarget = { kind: 'furniture', id: alreadySelId };
        } else {
          const topId = stackIds[0] ?? hitTarget.id;
          primaryTarget = { kind: 'furniture', id: topId };
          activeSel = [primaryTarget];
          onSelect(activeSel);
        }
      } else if (!isSelected(hitTarget.kind, hitTarget.id)) {
        activeSel = [hitTarget];
        onSelect(activeSel);
      }

      const isLockedItem = (s: SelectionTarget): boolean => {
        if (s.kind === 'furniture') return Boolean(level.furniture.find((x) => x.id === s.id)?.locked);
        if (s.kind === 'wall') return Boolean(level.walls.find((x) => x.id === s.id)?.locked);
        if (s.kind === 'opening') return Boolean(level.openings.find((x) => x.id === s.id)?.locked);
        if (s.kind === 'curtain') return Boolean(level.curtains.find((x) => x.id === s.id)?.locked);
        if (s.kind === 'person') return Boolean(level.people.find((x) => x.id === s.id)?.locked);
        if (s.kind === 'arch') return Boolean(level.archElements.find((x) => x.id === s.id)?.locked);
        return false;
      };

      const lockedFlags = activeSel.map(isLockedItem);
      const isLocked = lockedFlags.length > 0 && lockedFlags.every(Boolean);

      const canDuplicate = activeSel.some(
        (s) =>
          s.kind === 'furniture' ||
          s.kind === 'person' ||
          s.kind === 'curtain' ||
          s.kind === 'arch' ||
          s.kind === 'wall'
      );
      const canMirror = activeSel.some(
        (s) =>
          s.kind === 'furniture' ||
          s.kind === 'opening' ||
          s.kind === 'arch' ||
          s.kind === 'curtain' ||
          s.kind === 'person'
      );
      const canRotate = activeSel.some(
        (s) =>
          s.kind === 'furniture' ||
          s.kind === 'person' ||
          s.kind === 'curtain' ||
          s.kind === 'arch' ||
          s.kind === 'wall'
      );

      let aboveId: string | null = null;
      let belowId: string | null = null;
      if (primaryTarget.kind === 'furniture') {
        const stackIds = getStackOrderForFurnitureId(primaryTarget.id, w);
        const adj = getAdjacentStackLayerIds(stackIds, primaryTarget.id);
        aboveId = adj.aboveId;
        belowId = adj.belowId;
      }

      const nameOfFurn = (id: string | null) =>
        id ? level.furniture.find((f) => f.id === id)?.name : undefined;

      let canConsolidateWalls = false;
      let canSeparateWalls = false;
      let consolidateIds: string[] | undefined;
      let separateIds: string[] | undefined;
      const selectedWallTargets = activeSel.filter((s) => s.kind === 'wall');
      if (primaryTarget.kind === 'wall' && selectedWallTargets.length >= 2) {
        const selWalls = selectedWallTargets
          .map((s) => level.walls.find((x) => x.id === s.id))
          .filter((x): x is Wall => Boolean(x));
        const elig = validateWallConsolidationEligibility(selWalls, level.walls);
        if (elig.eligible) {
          canConsolidateWalls = !elig.isConsolidated;
          canSeparateWalls = elig.hasAnyConsolidated;
          consolidateIds = elig.orderedWallIds;
          separateIds = selWalls.map((x) => x.id);
        }
      } else if (activeSel.length === 1 && activeSel[0].kind === 'wall') {
        const hitWall = level.walls.find((x) => x.id === activeSel[0].id);
        if (hitWall?.consolidatedGroupId) {
          const groupPeers = level.walls.filter(
            (x) => x.visible !== false && x.consolidatedGroupId === hitWall.consolidatedGroupId
          );
          if (
            groupPeers.length >= 2 &&
            validateWallConsolidationEligibility(groupPeers, level.walls).eligible
          ) {
            canSeparateWalls = true;
            separateIds = groupPeers.map((x) => x.id);
          }
        }
      }

      setContextMenu({
        kind: 'object',
        clientX,
        clientY,
        isLocked,
        canDuplicate,
        canMirror,
        canRotate,
        canSelectAbove: Boolean(aboveId),
        canSelectBelow: Boolean(belowId),
        aboveName: nameOfFurn(aboveId),
        belowName: nameOfFurn(belowId),
        canConsolidateWalls,
        canSeparateWalls,
      });
      ctxMetaRef.current = {
        target: primaryTarget,
        aboveId,
        belowId,
        nextLock: !isLocked,
        consolidateIds,
        separateIds,
      };
    },
    [
      getStackOrderForFurnitureId,
      hasClipboard,
      isSelected,
      level.archElements,
      level.curtains,
      level.furniture,
      level.openings,
      level.people,
      level.walls,
      onSelect,
      screenToWorld,
      selection,
    ]
  );

  const ctxMetaRef = useRef<{
    target: SelectionTarget;
    aboveId: string | null;
    belowId: string | null;
    nextLock: boolean;
    consolidateIds?: string[];
    separateIds?: string[];
  } | null>(null);

  const handleCtxToggleLock = useCallback(() => {
    const meta = ctxMetaRef.current;
    if (!meta || selection.length === 0) return;
    const nextLocked = meta.nextLock;
    const fIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
    const wIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
    const oIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
    const cIds = new Set(selection.filter((s) => s.kind === 'curtain').map((s) => s.id));
    const pIds = new Set(selection.filter((s) => s.kind === 'person').map((s) => s.id));
    const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
    onUpdateLevel(
      (lvl) => ({
        ...lvl,
        furniture: lvl.furniture.map((f) => (fIds.has(f.id) ? { ...f, locked: nextLocked } : f)),
        walls: lvl.walls.map((w) => (wIds.has(w.id) ? { ...w, locked: nextLocked } : w)),
        openings: lvl.openings.map((o) => (oIds.has(o.id) ? { ...o, locked: nextLocked } : o)),
        curtains: lvl.curtains.map((c) => (cIds.has(c.id) ? { ...c, locked: nextLocked } : c)),
        people: lvl.people.map((p) => (pIds.has(p.id) ? { ...p, locked: nextLocked } : p)),
        archElements: lvl.archElements.map((a) => (aIds.has(a.id) ? { ...a, locked: nextLocked } : a)),
      }),
      false,
      true,
      nextLocked ? 'Lock Selection' : 'Unlock Selection'
    );
  }, [onUpdateLevel, selection]);

  const handleCtxMirror = useCallback(() => {
    if (selection.length === 0) return;
    const fIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
    const oIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
    const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
    const cIds = new Set(selection.filter((s) => s.kind === 'curtain').map((s) => s.id));
    const pIds = new Set(selection.filter((s) => s.kind === 'person').map((s) => s.id));
    onUpdateLevel(
      (lvl) => {
        let nextFurniture = lvl.furniture.map((f) =>
          fIds.has(f.id) && !f.locked ? { ...f, mirroredX: !f.mirroredX } : f
        );
        for (const id of fIds) {
          const prevF = lvl.furniture.find((f) => f.id === id);
          const nextF = nextFurniture.find((f) => f.id === id);
          if (prevF && nextF && !prevF.locked) {
            nextFurniture = propagateParentFurnitureTransforms(nextFurniture, id, prevF, nextF);
          }
        }
        return {
          ...lvl,
          furniture: nextFurniture,
          openings: lvl.openings.map((o) =>
            oIds.has(o.id) && !o.locked
              ? { ...o, swingSide: o.swingSide === 'left' ? 'right' : 'left' }
              : o
          ),
          archElements: lvl.archElements.map((a) => {
            if (!aIds.has(a.id) || a.locked) return a;
            if (a.type === 'railing' && a.railing) {
              return {
                ...a,
                railing: {
                  ...a.railing,
                  nodes: a.railing.nodes.map((n) => ({ ...n, xMm: -n.xMm })),
                },
              };
            }
            return { ...a, rotationDeg: (a.rotationDeg + 180) % 360 };
          }),
          curtains: lvl.curtains.map((c) =>
            cIds.has(c.id) && !c.locked ? { ...c, rotationDeg: (c.rotationDeg + 180) % 360 } : c
          ),
          people: lvl.people.map((p) =>
            pIds.has(p.id) && !p.locked ? { ...p, rotationDeg: (360 - p.rotationDeg) % 360 } : p
          ),
        };
      },
      false,
      true,
      'Mirror Selection'
    );
  }, [onUpdateLevel, selection]);

  const handleCtxRotate90 = useCallback(() => {
    if (selection.length === 0) return;
    const fIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
    const pIds = new Set(selection.filter((s) => s.kind === 'person').map((s) => s.id));
    const cIds = new Set(selection.filter((s) => s.kind === 'curtain').map((s) => s.id));
    const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
    const wIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
    onUpdateLevel(
      (lvl) => {
        let nextFurniture = lvl.furniture.map((f) => {
          if (!fIds.has(f.id) || f.locked) return f;
          const nextRot = ((f.rotationDeg + 90) % 360 + 360) % 360;
          return {
            ...f,
            rotationDeg: nextRot,
            ...(f.attachedWallId
              ? { attachedWallId: undefined, attachedFace: undefined, attachedT: undefined }
              : {}),
          };
        });
        for (const id of fIds) {
          const prevF = lvl.furniture.find((f) => f.id === id);
          const nextF = nextFurniture.find((f) => f.id === id);
          if (prevF && nextF && !prevF.locked) {
            nextFurniture = propagateParentFurnitureTransforms(nextFurniture, id, prevF, nextF);
          }
        }
        const nextWalls = lvl.walls.map((w) => {
          if (!wIds.has(w.id) || w.locked) return w;
          const cx = (w.start.x + w.end.x) / 2;
          const cy = (w.start.y + w.end.y) / 2;
          const rotPt = (pt: Point2D): Point2D => ({
            x: Math.round(cx - (pt.y - cy)),
            y: Math.round(cy + (pt.x - cx)),
          });
          return { ...w, start: rotPt(w.start), end: rotPt(w.end) };
        });
        return {
          ...lvl,
          walls: nextWalls,
          furniture: nextFurniture,
          people: lvl.people.map((p) =>
            pIds.has(p.id) && !p.locked ? { ...p, rotationDeg: (p.rotationDeg + 90) % 360 } : p
          ),
          curtains: lvl.curtains.map((c) =>
            cIds.has(c.id) && !c.locked ? { ...c, rotationDeg: (c.rotationDeg + 90) % 360 } : c
          ),
          archElements: lvl.archElements.map((a) =>
            aIds.has(a.id) && !a.locked
              ? {
                  ...a,
                  rotationDeg: (a.rotationDeg + 90) % 360,
                  attachedWallId: undefined,
                  attachedFace: undefined,
                  attachedT: undefined,
                }
              : a
          ),
        };
      },
      wIds.size > 0,
      true,
      'Rotate 90°'
    );
  }, [onUpdateLevel, selection]);

  const resolveFurnitureTopPlanView = (
    f: FurnitureInstance,
    boundsW: number,
    boundsD: number,
    hasTilt: boolean
  ) => {
    const activeMode = resolveEffectiveRepresentationMode(f);
    const isCustomTop = hasCustomView(f.representation, 'top');
    const hasImportedSvgSource = typeof f.svgSource === 'string' && isValidSvgSource(f.svgSource);
    const hasExplicitDefaultTop = Boolean(f.representation?.defaultViews?.top?.elements?.length);
    let topRepForRender = f.representation;
    let derivedFromParts = false;
    let preserveAspect = false;

    if (
      hasTilt &&
      f.parts.length > 0 &&
      (isCustomTop || hasImportedSvgSource || (activeMode === 'default' && hasExplicitDefaultTop))
    ) {
      // Custom/flat 2D top SVGs project live from 3D tilted parts without mutating saved SVG views
      const generatedTilted = generateDefaultTopViewFromParts(f.parts, {
        rotationXDeg: f.rotationXDeg,
        rotationYDeg: f.rotationYDeg,
        mirroredX: f.mirroredX,
        mirroredY: f.mirroredY,
        templateId: f.templateId,
      });
      if (generatedTilted) {
        derivedFromParts = true;
        topRepForRender = {
          ...(f.representation ?? { mode: activeMode }),
          mode: activeMode,
          customViews: undefined,
          defaultViews: activeMode === 'default' ? { top: generatedTilted } : undefined,
          autoViews: activeMode !== 'default' ? { top: generatedTilted } : undefined,
        };
      }
    } else if (activeMode === 'default' && !isCustomTop) {
      if (hasExplicitDefaultTop) {
        topRepForRender = f.representation;
        preserveAspect = true;
      } else if (hasImportedSvgSource) {
        const parsedDefault = parseSvgSourceToProjectedView(f.svgSource!, boundsW, boundsD);
        if (parsedDefault) {
          preserveAspect = true;
          topRepForRender = {
            ...(f.representation ?? { mode: 'default' }),
            mode: 'default',
            defaultViews: {
              ...(f.representation?.defaultViews ?? {}),
              top: parsedDefault.view,
            },
          };
        }
      } else {
        const generated = generateDefaultTopViewFromParts(f.parts, {
          rotationXDeg: f.rotationXDeg,
          rotationYDeg: f.rotationYDeg,
          mirroredX: f.mirroredX,
          mirroredY: f.mirroredY,
          templateId: f.templateId,
        });
        if (generated) {
          derivedFromParts = true;
          topRepForRender = {
            ...(f.representation ?? { mode: 'default' }),
            mode: 'default',
            defaultViews: {
              ...(f.representation?.defaultViews ?? {}),
              top: generated,
            },
          };
        }
      }
    } else if (isCustomTop) {
      preserveAspect = true;
    }

    let effectiveRepForTop = derivedFromParts
      ? topRepForRender
      : topRepForRender && !isCustomTop && topRepForRender.mode !== activeMode
        ? { ...topRepForRender, mode: activeMode }
        : topRepForRender;
    let topResolved = getEffectiveViewElements(effectiveRepForTop, 'top');

    // If an auto-projected silhouette/hidden-line view has not been synced yet, derive top view from 3D parts
    if ((!topResolved.elements || topResolved.elements.length === 0) && f.parts.length > 0) {
      const generatedFallback = generateDefaultTopViewFromParts(f.parts, {
        rotationXDeg: f.rotationXDeg,
        rotationYDeg: f.rotationYDeg,
        mirroredX: f.mirroredX,
        mirroredY: f.mirroredY,
        templateId: f.templateId,
      });
      if (generatedFallback) {
        derivedFromParts = true;
        preserveAspect = false;
        effectiveRepForTop = {
          ...(f.representation ?? { mode: activeMode }),
          mode: activeMode,
          defaultViews: activeMode === 'default' ? { top: generatedFallback } : undefined,
          autoViews: activeMode !== 'default' ? { top: generatedFallback } : undefined,
        };
        topResolved = getEffectiveViewElements(effectiveRepForTop, 'top');
      }
    }

    const hasTopSvg = Boolean(topResolved.elements && topResolved.elements.length > 0);
    const baseTopW = topResolved.autoView?.baseWidthMm ?? boundsW;
    const baseTopD = topResolved.autoView?.baseHeightMm ?? boundsD;
    const { scaleX: topScaleX, scaleY: topScaleY } = computeSvgFitScale(
      baseTopW,
      baseTopD,
      boundsW,
      boundsD,
      preserveAspect && !derivedFromParts
    );
    // Tilted derived/auto views already bake mirror-before-tilt in 3D geometry
    const applyMirrorScale2D =
      !derivedFromParts &&
      (isCustomTop || !hasTilt || activeMode === 'default');
    return {
      isCustomTop,
      effectiveRepForTop,
      topResolved,
      hasTopSvg,
      topScaleX,
      topScaleY,
      applyMirrorScale2D,
    };
  };

  // Render helper for openings (door swings, window mullions, arches)
  const renderOpening2D = (op: Opening) => {
    const wall = level.walls.find((w) => w.id === op.wallId);
    if (!wall) return null;
    const { point, tangent, normal } = getWallCenterlinePoint(wall, op.t);
    const angleDeg = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
    const selected = isSelected('opening', op.id);
    const isDimHovered =
      hoveredCompId === op.id ||
      hoveredDimKey === `comp:${op.id}` ||
      hoveredDimKey === `width:${op.id}`;
    const halfW = op.widthMm / 2;
    const thick = wall.thicknessMm;
    const strokeColor = selected
      ? '#2563EB'
      : isDimHovered
        ? '#0EA5E9'
        : isBw
          ? '#0F172A'
          : op.locked
            ? '#64748B'
            : op.frameColor;
    const sw = Math.max(5, (isDimHovered ? 1.25 : 0.85) / pxPerMm);

    const swingSign = op.swingDirection === 'in' ? 1 : -1;
    const hingeX = op.swingSide === 'left' ? -halfW : halfW;
    const dirX = op.swingSide === 'left' ? 1 : -1;
    const leafLen =
      op.subtype === 'double' || op.subtype === 'french' || op.subtype === 'balcony_double' ? halfW : op.widthMm;
    const leafAng = (op.openAngleDeg * Math.PI) / 180;
    const isEuroFrame = op.subtype.startsWith('euro_') || op.subtype === 'balcony_single' || op.subtype === 'balcony_double';
    const effectiveStrokeColor = isBw
      ? '#0F172A'
      : isEuroFrame && strokeColor.toUpperCase() === '#F8FAFC' && !settings.darkMode
        ? '#475569'
        : strokeColor;

    const opTweenOff =
      snapTweenOffset && snapTweenOffset.targetKey === `opening:${op.id}`
        ? snapTweenOffset
        : null;

    return (
      <g
        key={op.id}
        data-ctx-kind="opening"
        data-ctx-id={op.id}
        transform={`translate(${point.x + (opTweenOff ? opTweenOff.dx : 0)}, ${point.y + (opTweenOff ? opTweenOff.dy : 0)}) rotate(${angleDeg})`}
        onPointerEnter={() => setHoveredCompId(op.id)}
        onPointerLeave={() => setHoveredCompId((cur) => (cur === op.id ? null : cur))}
        onPointerDown={(e) => {
          const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
          const alreadySelected = isSelected('opening', op.id);
          handleElementSelect(e, { kind: 'opening', id: op.id }, op.frameColor);
          if (alreadySelected && !isMultiMod && activeTool === 'select' && !op.locked && !wall.locked && e.button === 0) {
            snapHysteresisRef.current = {};
            clearSnapTween();
            setCursorHint(null);
            dragMutatedRef.current = false;
            setDragState({
              kind: 'opening',
              openingId: op.id,
              startClient: { x: e.clientX, y: e.clientY },
              label: `Move ${op.name}`,
            });
          }
        }}
        className={selected && !op.locked && !wall.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
      >
        {/* Wall cutout mask */}
        <rect
          x={-halfW}
          y={-thick * 0.65}
          width={op.widthMm}
          height={thick * 1.3}
          fill={isBw ? '#FFFFFF' : settings.darkMode ? '#0B1120' : '#FFFFFF'}
        />

        {/* Hover halo from linked dimension */}
        {isDimHovered && (
          <rect
            x={-halfW - 18}
            y={-thick * 0.68}
            width={op.widthMm + 36}
            height={thick * 1.36}
            fill="rgba(14, 165, 233, 0.16)"
            stroke="#0EA5E9"
            strokeWidth={1.4 / pxPerMm}
            rx={15}
            className="pointer-events-none"
          />
        )}

        {/* Jambs */}
        <rect
          x={-halfW}
          y={-thick / 2}
          width={op.frameThicknessMm}
          height={thick}
          fill={isBw && !selected ? 'none' : strokeColor}
          stroke={isBw ? effectiveStrokeColor : isEuroFrame ? effectiveStrokeColor : 'none'}
          strokeWidth={isBw ? sw : sw * 0.5}
        />
        <rect
          x={halfW - op.frameThicknessMm}
          y={-thick / 2}
          width={op.frameThicknessMm}
          height={thick}
          fill={isBw && !selected ? 'none' : strokeColor}
          stroke={isBw ? effectiveStrokeColor : isEuroFrame ? effectiveStrokeColor : 'none'}
          strokeWidth={isBw ? sw : sw * 0.5}
        />

        {op.category === 'door' && op.subtype === 'doorframe' && (
          <>
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={-thick / 2}
              x2={halfW - op.frameThicknessMm}
              y2={-thick / 2}
              stroke={effectiveStrokeColor}
              strokeWidth={sw}
              strokeDasharray="60 45"
            />
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={thick / 2}
              x2={halfW - op.frameThicknessMm}
              y2={thick / 2}
              stroke={effectiveStrokeColor}
              strokeWidth={sw}
              strokeDasharray="60 45"
            />
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={0}
              x2={halfW - op.frameThicknessMm}
              y2={0}
              stroke={isBw ? '#475569' : '#64748B'}
              strokeWidth={sw * 0.85}
            />
          </>
        )}

        {op.category === 'door' && op.subtype !== 'doorframe' && (
          <>
            {(op.subtype === 'single' || op.subtype === 'entrance' || op.subtype === 'balcony_single') && (
              <>
                <line
                  x1={hingeX}
                  y1={0}
                  x2={hingeX + dirX * leafLen * Math.cos(leafAng)}
                  y2={swingSign * leafLen * Math.sin(leafAng)}
                  stroke={effectiveStrokeColor}
                  strokeWidth={Math.max(10, (op.subtype === 'balcony_single' ? 1.8 : 1.35) / pxPerMm)}
                />
                {op.subtype === 'balcony_single' && (
                  <line
                    x1={hingeX}
                    y1={0}
                    x2={hingeX + dirX * leafLen * Math.cos(leafAng)}
                    y2={swingSign * leafLen * Math.sin(leafAng)}
                    stroke={isBw ? '#475569' : '#38BDF8'}
                    strokeWidth={Math.max(4, 0.7 / pxPerMm)}
                  />
                )}
                <path
                  d={`M ${hingeX + dirX * leafLen} 0 A ${leafLen} ${leafLen} 0 0 ${
                    (op.swingSide === 'left') === (swingSign > 0) ? 1 : 0
                  } ${hingeX + dirX * leafLen * Math.cos(leafAng)} ${
                    swingSign * leafLen * Math.sin(leafAng)
                  }`}
                  fill="none"
                  stroke={selected ? '#2563EB' : isBw ? '#475569' : '#64748B'}
                  strokeDasharray="60 45"
                  strokeWidth={sw}
                />
              </>
            )}
            {op.subtype === 'pivot' && (
              <>
                {(() => {
                  const pivotOffset = op.widthMm * 0.2;
                  const px = op.swingSide === 'left' ? -halfW + pivotOffset : halfW - pivotOffset;
                  const mainLen = op.widthMm - pivotOffset;
                  const tailLen = pivotOffset;
                  return (
                    <>
                      <circle
                        cx={px}
                        cy={0}
                        r={Math.max(18, 2.5 / pxPerMm)}
                        fill={isBw ? 'none' : strokeColor}
                        stroke={isBw ? strokeColor : 'none'}
                        strokeWidth={isBw ? sw : 0}
                      />
                      <line
                        x1={px - dirX * tailLen * Math.cos(leafAng)}
                        y1={-swingSign * tailLen * Math.sin(leafAng)}
                        x2={px + dirX * mainLen * Math.cos(leafAng)}
                        y2={swingSign * mainLen * Math.sin(leafAng)}
                        stroke={strokeColor}
                        strokeWidth={Math.max(10, 1.35 / pxPerMm)}
                      />
                      <path
                        d={`M ${px + dirX * mainLen} 0 A ${mainLen} ${mainLen} 0 0 ${
                          (op.swingSide === 'left') === (swingSign > 0) ? 1 : 0
                        } ${px + dirX * mainLen * Math.cos(leafAng)} ${
                          swingSign * mainLen * Math.sin(leafAng)
                        }`}
                        fill="none"
                        stroke={selected ? '#2563EB' : isBw ? '#475569' : '#64748B'}
                        strokeDasharray="60 45"
                        strokeWidth={sw}
                      />
                    </>
                  );
                })()}
              </>
            )}
            {(op.subtype === 'double' || op.subtype === 'french' || op.subtype === 'balcony_double') && (
              <>
                <line
                  x1={-halfW}
                  y1={0}
                  x2={-halfW + halfW * Math.cos(leafAng)}
                  y2={swingSign * halfW * Math.sin(leafAng)}
                  stroke={effectiveStrokeColor}
                  strokeWidth={Math.max(9, (op.subtype === 'balcony_double' ? 1.7 : 1.25) / pxPerMm)}
                />
                <line
                  x1={halfW}
                  y1={0}
                  x2={halfW - halfW * Math.cos(leafAng)}
                  y2={swingSign * halfW * Math.sin(leafAng)}
                  stroke={effectiveStrokeColor}
                  strokeWidth={Math.max(9, (op.subtype === 'balcony_double' ? 1.7 : 1.25) / pxPerMm)}
                />
                {op.subtype === 'balcony_double' && (
                  <>
                    <line
                      x1={-halfW}
                      y1={0}
                      x2={-halfW + halfW * Math.cos(leafAng)}
                      y2={swingSign * halfW * Math.sin(leafAng)}
                      stroke={isBw ? '#475569' : '#38BDF8'}
                      strokeWidth={Math.max(4, 0.65 / pxPerMm)}
                    />
                    <line
                      x1={halfW}
                      y1={0}
                      x2={halfW - halfW * Math.cos(leafAng)}
                      y2={swingSign * halfW * Math.sin(leafAng)}
                      stroke={isBw ? '#475569' : '#38BDF8'}
                      strokeWidth={Math.max(4, 0.65 / pxPerMm)}
                    />
                  </>
                )}
                <path
                  d={`M 0 0 A ${halfW} ${halfW} 0 0 ${swingSign > 0 ? 1 : 0} ${
                    -halfW + halfW * Math.cos(leafAng)
                  } ${swingSign * halfW * Math.sin(leafAng)}`}
                  fill="none"
                  stroke={isBw ? '#475569' : '#64748B'}
                  strokeDasharray="50 40"
                  strokeWidth={sw}
                />
                <path
                  d={`M 0 0 A ${halfW} ${halfW} 0 0 ${swingSign > 0 ? 0 : 1} ${
                    halfW - halfW * Math.cos(leafAng)
                  } ${swingSign * halfW * Math.sin(leafAng)}`}
                  fill="none"
                  stroke={isBw ? '#475569' : '#64748B'}
                  strokeDasharray="50 40"
                  strokeWidth={sw}
                />
              </>
            )}
            {(op.subtype === 'sliding' || op.subtype === 'pocket' || op.subtype === 'garage') && (
              <>
                <rect
                  x={-halfW + 30}
                  y={-18}
                  width={op.widthMm * 0.52}
                  height={24}
                  fill={isBw ? 'none' : op.panelColor}
                  stroke={strokeColor}
                  strokeWidth={sw}
                />
                <rect
                  x={-20}
                  y={8}
                  width={op.widthMm * 0.5}
                  height={24}
                  fill={isBw ? 'none' : op.panelColor}
                  stroke={strokeColor}
                  strokeWidth={sw}
                />
              </>
            )}
            {op.subtype === 'bifold' && (
              <polyline
                points={`${-halfW},0 ${-halfW / 2},${swingSign * 260} 0,0 ${halfW / 2},${
                  swingSign * 260
                } ${halfW},0`}
                fill="none"
                stroke={strokeColor}
                strokeWidth={Math.max(9, 1.25 / pxPerMm)}
              />
            )}
          </>
        )}

        {op.category === 'window' && (
          <>
            <rect
              x={-halfW + op.frameThicknessMm}
              y={-thick * 0.28}
              width={op.widthMm - op.frameThicknessMm * 2}
              height={thick * 0.56}
              fill={isBw ? 'none' : op.glassColor}
              fillOpacity={isBw ? 0 : 0.55}
              stroke={effectiveStrokeColor}
              strokeDasharray={op.subtype === 'clerestory' ? '45 30' : undefined}
              strokeWidth={sw}
            />
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={0}
              x2={halfW - op.frameThicknessMm}
              y2={0}
              stroke={effectiveStrokeColor}
              strokeWidth={sw * 1.1}
            />
            {(op.subtype === 'casement' || op.subtype === 'awning') && (
              <polyline
                points={`${-halfW + op.frameThicknessMm},0 0,${swingSign * 140} ${halfW - op.frameThicknessMm},0`}
                fill="none"
                stroke={effectiveStrokeColor}
                strokeDasharray="40 30"
                strokeWidth={sw * 0.85}
              />
            )}
            {(op.subtype === 'double' ||
              op.subtype === 'triple' ||
              op.subtype === 'bay' ||
              op.subtype === 'euro_double' ||
              op.subtype === 'euro_terrace') && (
              <line x1={0} y1={-thick * 0.28} x2={0} y2={thick * 0.28} stroke={effectiveStrokeColor} strokeWidth={sw} />
            )}
            {(op.subtype === 'triple' || op.subtype === 'euro_triple') && (
              <>
                <line
                  x1={-op.widthMm / 6}
                  y1={-thick * 0.28}
                  x2={-op.widthMm / 6}
                  y2={thick * 0.28}
                  stroke={effectiveStrokeColor}
                  strokeWidth={sw}
                />
                <line
                  x1={op.widthMm / 6}
                  y1={-thick * 0.28}
                  x2={op.widthMm / 6}
                  y2={thick * 0.28}
                  stroke={effectiveStrokeColor}
                  strokeWidth={sw}
                />
              </>
            )}
            {op.subtype === 'euro_terrace' && (
              <polyline
                points={`0,0 ${halfW * 0.5},${swingSign * 140} ${halfW - op.frameThicknessMm},0`}
                fill="none"
                stroke={effectiveStrokeColor}
                strokeDasharray="40 30"
                strokeWidth={sw * 0.85}
              />
            )}
          </>
        )}

        {op.category === 'arch' && (
          <>
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={-thick * 0.45}
              x2={halfW - op.frameThicknessMm}
              y2={-thick * 0.45}
              stroke={strokeColor}
              strokeDasharray="60 45"
              strokeWidth={sw}
            />
            <line
              x1={-halfW + op.frameThicknessMm}
              y1={thick * 0.45}
              x2={halfW - op.frameThicknessMm}
              y2={thick * 0.45}
              stroke={strokeColor}
              strokeDasharray="60 45"
              strokeWidth={sw}
            />
          </>
        )}

        {/* Selection center & left/right edge-drag resize handles */}
        {selected && (
          <>
            <circle
              cx={normal.x * 0}
              cy={0}
              r={Math.max(45, 5 / pxPerMm)}
              fill="#2563EB"
              fillOpacity={0.2}
              stroke="#2563EB"
              strokeWidth={sw}
              className="pointer-events-none"
            />
            {!op.locked && !wall.locked && activeTool === 'select' && (
              <>
                {(['left', 'right'] as const).map((edge) => {
                  const hx = edge === 'left' ? -halfW : halfW;
                  const gw = 8 / pxPerMm;
                  const gh = 20 / pxPerMm;
                  const hitW = 24 / pxPerMm;
                  const hitH = 26 / pxPerMm;
                  return (
                    <g
                      key={edge}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        dragMutatedRef.current = false;
                        setDragState({
                          kind: 'comp_edge',
                          compId: op.id,
                          compKind: 'opening',
                          wallId: wall.id,
                          edge,
                          startClient: { x: e.clientX, y: e.clientY },
                          label: `Resize ${op.name}`,
                        });
                      }}
                      style={{ cursor: 'ew-resize' }}
                    >
                      <rect
                        x={hx - hitW / 2}
                        y={-hitH / 2}
                        width={hitW}
                        height={hitH}
                        fill="transparent"
                      />
                      <rect
                        x={hx - gw / 2}
                        y={-gh / 2}
                        width={gw}
                        height={gh}
                        rx={gw * 0.3}
                        fill="#FFFFFF"
                        stroke="#2563EB"
                        strokeWidth={1.6 / pxPerMm}
                      />
                    </g>
                  );
                })}
              </>
            )}
          </>
        )}
      </g>
    );
  };

  // Evaluate live constraint edit in inline dimension input
  const applyDimInputValue = useCallback(
    (
      draft: NonNullable<typeof editingDim>,
      nextStr: string
    ): NonNullable<typeof editingDim> => {
      const cm = Number(nextStr);
      if (!nextStr.trim() || !Number.isFinite(cm) || cm <= 0) {
        return {
          ...draft,
          valueStr: nextStr,
          error: 'Enter a positive dimension in cm.',
          previewUpdates: undefined,
          previewWallEnds: undefined,
        };
      }
      const nextMm = Math.round(cm * 10);
      const wall = level.walls.find((w) => w.id === draft.wallId);
      if (!wall) return { ...draft, valueStr: nextStr, error: 'Host wall missing.' };

      if (draft.kind === 'wall_length') {
        const res = solveConnectedWallLengthChange(
          wall,
          level.walls,
          level.openings,
          level.archElements,
          nextMm
        );
        const selfUpd = res.wallUpdates.find((u) => u.id === wall.id);
        return {
          ...draft,
          valueStr: nextStr,
          error: res.ok ? null : res.error ?? 'Constraint violation.',
          previewWallEnds: res.ok && selfUpd ? { start: selfUpd.start, end: selfUpd.end } : undefined,
          previewConnectedResult: res.ok ? res : undefined,
        };
      }

      const bounds = computeWallInnerBounds(wall, level.walls);
      const comps = getWallMountedComponents(wall, level.openings, level.archElements);

      if (draft.kind === 'component_width' && draft.compId) {
        const chimEl = level.archElements.find((a) => a.id === draft.compId && a.type === 'chimney');
        if (chimEl) {
          const res = solveChimneyResize(
            wall,
            level.walls,
            level.openings,
            level.archElements,
            draft.compId,
            nextMm,
            chimEl.depthMm
          );
          return {
            ...draft,
            valueStr: nextStr,
            error: res.ok ? null : res.error ?? 'Constraint violation.',
            previewUpdates: res.ok ? res.updates : undefined,
          };
        }
        const res = solveWallComponentResize(wall, comps, bounds, draft.compId, nextMm);
        return {
          ...draft,
          valueStr: nextStr,
          error: res.ok ? null : res.error ?? 'Constraint violation.',
          previewUpdates: res.ok ? res.updates : undefined,
        };
      }

      if ((draft.kind === 'clearance_left' || draft.kind === 'clearance_right') && draft.compId) {
        const res = solveWallClearanceEdit(
          wall,
          comps,
          bounds,
          draft.compId,
          draft.kind === 'clearance_left' ? 'left' : 'right',
          nextMm
        );
        return {
          ...draft,
          valueStr: nextStr,
          error: res.ok ? null : res.error ?? 'Constraint violation.',
          previewUpdates: res.ok ? res.updates : undefined,
        };
      }

      return { ...draft, valueStr: nextStr, error: null };
    },
    [level.archElements, level.openings, level.walls]
  );

  const commitDimEditor = useCallback(() => {
    if (!editingDim) return;
    const evaluated = applyDimInputValue(editingDim, editingDim.valueStr);
    if (evaluated.error) {
      setEditingDim(evaluated);
      onConstraintError?.(evaluated.error);
      return;
    }

    if (evaluated.kind === 'wall_length' && evaluated.previewConnectedResult?.ok) {
      const res = evaluated.previewConnectedResult;
      const wallUpdMap = new Map(res.wallUpdates.map((u) => [u.id, u]));
      const opUpdMap = new Map(res.openingUpdates.map((u) => [u.id, u.t]));
      const chimUpdMap = new Map(res.chimneyUpdates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          walls: lvl.walls.map((w) => {
            const u = wallUpdMap.get(w.id);
            return u ? { ...w, start: u.start, end: u.end } : w;
          }),
          openings: lvl.openings.map((o) =>
            opUpdMap.has(o.id) ? { ...o, t: opUpdMap.get(o.id)! } : o
          ),
          archElements: lvl.archElements.map((a) => {
            const c = chimUpdMap.get(a.id);
            return c
              ? {
                  ...a,
                  attachedT: c.attachedT,
                  xMm: c.xMm,
                  yMm: c.yMm,
                  rotationDeg: c.rotationDeg,
                }
              : a;
          }),
        }),
        true,
        true,
        'Resize Wall'
      );
    } else if (evaluated.previewUpdates && evaluated.previewUpdates.length > 0) {
      const updateMap = new Map(evaluated.previewUpdates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => {
          const wall = lvl.walls.find((w) => w.id === evaluated.wallId);
          return {
            ...lvl,
            openings: lvl.openings.map((o) => {
              const u = updateMap.get(o.id);
              return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
            }),
            archElements: lvl.archElements.map((a) => {
              const u = updateMap.get(a.id);
              if (!u || u.kind !== 'chimney' || !wall) return a;
              const xf = computeAttachedChimneyTransform(
                wall,
                u.t,
                a.depthMm,
                a.attachedFace ?? 'left'
              );
              const pin = getChimneyCornerPin(
                wall,
                lvl.walls,
                u.t,
                u.widthMm,
                a.depthMm,
                a.attachedFace ?? 'left'
              );
              return {
                ...a,
                widthMm: u.widthMm,
                attachedT: u.t,
                xMm: xf.xMm,
                yMm: xf.yMm,
                rotationDeg: xf.rotationDeg,
                resizeAnchor: pin ?? a.resizeAnchor,
              };
            }),
          };
        },
        false,
        true,
        'Edit Dimension'
      );
    }
    setEditingDim(null);
  }, [applyDimInputValue, editingDim, onConstraintError, onUpdateLevel]);

  // Architectural Dimension Line Helper (centered text directly on line, perpendicular ticks + arrows)
  const renderArchDimLine = useCallback(
    (opts: {
      dimKey: string;
      p1: Point2D;
      p2: Point2D;
      ext1: Point2D;
      ext2: Point2D;
      valueMm: number;
      locked: boolean;
      editable: boolean;
      hoverId?: string;
      onClickEdit?: (midWorld: Point2D) => void;
    }) => {
      const span = dist(opts.p1, opts.p2);
      if (span < 1) return null;
      const mid = lerpPoint(opts.p1, opts.p2, 0.5);
      const dx = opts.p2.x - opts.p1.x;
      const dy = opts.p2.y - opts.p1.y;
      const ux = dx / span;
      const uy = dy / span;
      const nx = -uy;
      const ny = ux;
      const rawAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const angleDeg = normalizeScreenUprightAngleDeg(rawAngleDeg, viewRotationDeg);

      const isHovered = hoveredDimKey === opts.dimKey || (opts.hoverId && hoveredCompId === opts.hoverId);
      const lineColor = isBw
        ? opts.locked
          ? '#64748B'
          : isHovered
            ? '#0F172A'
            : '#334155'
        : opts.locked
          ? '#94A3B8'
          : isHovered
            ? settings.darkMode
              ? '#38BDF8'
              : '#1D4ED8'
            : settings.darkMode
              ? '#E2E8F0'
              : '#0EA5E9';
      const textColor = isBw
        ? opts.locked
          ? '#475569'
          : '#0F172A'
        : opts.locked
          ? '#94A3B8'
          : isHovered
            ? settings.darkMode
              ? '#7DD3FC'
              : '#1D4ED8'
            : settings.darkMode
              ? '#F1F5F9'
              : '#0369A1';
      const bgColor = isBw ? '#FFFFFF' : settings.darkMode ? '#020617' : '#FFFFFF';
      const strokeW = (isHovered ? 1.55 : 1.0) / pxPerMm;
      const tickHalf = 4.5 / pxPerMm;
      const arrowLen = Math.min(span * 0.22, 6.5 / pxPerMm);
      const arrowHalfW = 2.4 / pxPerMm;
      const labelText = formatSmartMetric(opts.valueMm);
      const fontSizeWorld = Math.max(85, Math.min(145, 11.5 / pxPerMm));
      const maskW = Math.max(fontSizeWorld * 2.2, labelText.length * fontSizeWorld * 0.64 + 60);
      const maskH = fontSizeWorld * 1.25;

      return (
        <g
          key={opts.dimKey}
          className={opts.editable ? 'cursor-pointer' : 'cursor-not-allowed'}
          onPointerEnter={() => {
            setHoveredDimKey(opts.dimKey);
            if (opts.hoverId) setHoveredCompId(opts.hoverId);
          }}
          onPointerLeave={() => {
            setHoveredDimKey((k) => (k === opts.dimKey ? null : k));
            if (opts.hoverId) setHoveredCompId((c) => (c === opts.hoverId ? null : c));
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !opts.onClickEdit) return;
            e.stopPropagation();
            opts.onClickEdit(mid);
          }}
        >
          {/* Extension lines from feature endpoints to dimension line */}
          <line
            x1={opts.ext1.x}
            y1={opts.ext1.y}
            x2={opts.p1.x}
            y2={opts.p1.y}
            stroke={lineColor}
            strokeOpacity={0.45}
            strokeWidth={0.65 / pxPerMm}
            strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
          />
          <line
            x1={opts.ext2.x}
            y1={opts.ext2.y}
            x2={opts.p2.x}
            y2={opts.p2.y}
            stroke={lineColor}
            strokeOpacity={0.45}
            strokeWidth={0.65 / pxPerMm}
            strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
          />
          {/* Main dimension line */}
          <line
            x1={opts.p1.x}
            y1={opts.p1.y}
            x2={opts.p2.x}
            y2={opts.p2.y}
            stroke={lineColor}
            strokeWidth={strokeW}
            strokeDasharray={opts.locked ? `${4 / pxPerMm} ${3 / pxPerMm}` : undefined}
          />
          {/* Perpendicular endpoint ticks */}
          <line
            x1={opts.p1.x - nx * tickHalf}
            y1={opts.p1.y - ny * tickHalf}
            x2={opts.p1.x + nx * tickHalf}
            y2={opts.p1.y + ny * tickHalf}
            stroke={lineColor}
            strokeWidth={strokeW * 1.15}
          />
          <line
            x1={opts.p2.x - nx * tickHalf}
            y1={opts.p2.y - ny * tickHalf}
            x2={opts.p2.x + nx * tickHalf}
            y2={opts.p2.y + ny * tickHalf}
            stroke={lineColor}
            strokeWidth={strokeW * 1.15}
          />
          {/* Arrowheads at both ticks */}
          {arrowLen > 2 / pxPerMm && (
            <>
              <polygon
                points={`${opts.p1.x},${opts.p1.y} ${opts.p1.x + ux * arrowLen + nx * arrowHalfW},${opts.p1.y + uy * arrowLen + ny * arrowHalfW} ${opts.p1.x + ux * arrowLen - nx * arrowHalfW},${opts.p1.y + uy * arrowLen - ny * arrowHalfW}`}
                fill={lineColor}
              />
              <polygon
                points={`${opts.p2.x},${opts.p2.y} ${opts.p2.x - ux * arrowLen + nx * arrowHalfW},${opts.p2.y - uy * arrowLen + ny * arrowHalfW} ${opts.p2.x - ux * arrowLen - nx * arrowHalfW},${opts.p2.y - uy * arrowLen - ny * arrowHalfW}`}
                fill={lineColor}
              />
            </>
          )}
          {/* Clean background break so text sits centered DIRECTLY ON the dimension line */}
          <g transform={`translate(${mid.x}, ${mid.y}) rotate(${angleDeg})`}>
            <rect
              x={-maskW / 2}
              y={-maskH / 2}
              width={maskW}
              height={maskH}
              rx={maskH * 0.25}
              fill={bgColor}
              fillOpacity={0.96}
              stroke={isHovered ? lineColor : 'none'}
              strokeWidth={0.8 / pxPerMm}
            />
            <text
              x={0}
              y={fontSizeWorld * 0.35}
              textAnchor="middle"
              fontSize={fontSizeWorld}
              fontFamily="JetBrains Mono, monospace"
              fontWeight={isHovered ? 700 : 600}
              fill={textColor}
            >
              {opts.locked ? `[LOCKED] ${labelText}` : labelText}
            </text>
          </g>
          {/* Generous invisible hit area for hovering and clicking */}
          <line
            x1={opts.p1.x}
            y1={opts.p1.y}
            x2={opts.p2.x}
            y2={opts.p2.y}
            stroke="transparent"
            strokeWidth={Math.max(180, 20 / pxPerMm)}
          />
        </g>
      );
    },
    [hoveredCompId, hoveredDimKey, pxPerMm, settings.darkMode, viewRotationDeg]
  );

  // Render wall draft preview info (supports rubber-band draft AND numeric typed-cm centered preview)
  const wallPreview = useMemo(() => {
    if (activeTool !== 'wall' && activeTool !== 'wall_arc') return null;

    if (typedLengthCm.length > 0) {
      const cm = Number(typedLengthCm);
      if (Number.isFinite(cm) && cm > 0) {
        const lenMm = Math.round(cm * 10);
        const { p1, p2 } = computeTypedWallEndpoints(lenMm);
        const angle = Math.round(((Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI + 360) % 360);
        return { p1, p2, len: lenMm, angle, isTyped: true };
      }
    }

    if (wallDraftPts.length === 0 || !hoverWorld) {
      return null;
    }
    const p1 = wallDraftPts[wallDraftPts.length - 1];
    const p2 = hoverWorld;
    const len = dist(p1, p2);
    const angle = Math.round(((Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI + 360) % 360);
    return { p1, p2, len, angle, isTyped: false };
  }, [activeTool, computeTypedWallEndpoints, hoverWorld, typedLengthCm, wallDraftPts]);

  return (
    <div
      ref={containerRef}
      data-testid="canvas-2d-container"
      className={
        isBw
          ? 'relative w-full h-full overflow-hidden bg-white select-none'
          : 'relative w-full h-full overflow-hidden bg-white dark:bg-slate-950 select-none'
      }
    >
      <svg
        ref={svgRef}
        data-testid="canvas-2d-svg"
        width={size.width}
        height={size.height}
        className={`block w-full h-full ${
          activeTool === 'pan' || spacePressed
            ? 'cursor-grab active:cursor-grabbing'
            : activeTool === 'select'
              ? 'cursor-default'
              : 'cursor-crosshair'
        }`}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragStateRef.current) return;
          const el = (e.target as Element | null)?.closest('[data-ctx-kind][data-ctx-id]');
          const kind = el?.getAttribute('data-ctx-kind') as SelectionTarget['kind'] | null;
          const id = el?.getAttribute('data-ctx-id');
          openContextMenuForTarget(e.clientX, e.clientY, kind && id ? { kind, id } : null);
        }}
        onPointerDown={(e) => {
          if (contextMenu) setContextMenu(null);
          handleSvgPointerDown(e);
        }}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
        onPointerCancel={handleSvgPointerCancel}
        onLostPointerCapture={handleSvgPointerCancel}
        onDoubleClick={handleDoubleClick}
      >
        <defs>
          <marker id="arrow_head" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill={isBw ? '#0F172A' : '#2563EB'} />
          </marker>
          {Array.from(stackVisualData.overlapClipPolygonsByLowerId.entries()).map(
            ([lowerId, clipPolys]) => (
              <clipPath
                key={`stack_overlap_clip_${lowerId}`}
                id={`stack_overlap_clip_${lowerId}`}
                clipPathUnits="userSpaceOnUse"
              >
                {clipPolys.map((poly, pIdx) => (
                  <polygon
                    key={pIdx}
                    points={poly.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                  />
                ))}
              </clipPath>
            )
          )}
          <pattern
            id="clash_diagonal_hatch"
            width={Math.max(40, 12 / pxPerMm)}
            height={Math.max(40, 12 / pxPerMm)}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="100%" height="100%" fill="rgba(239, 68, 68, 0.14)" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2={Math.max(40, 12 / pxPerMm)}
              stroke="#DC2626"
              strokeWidth={Math.max(8, 2.2 / pxPerMm)}
              strokeOpacity="0.88"
            />
          </pattern>
          <pattern
            id="bw_wall_hatch"
            width={80}
            height={80}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="80" height="80" fill="#FFFFFF" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="80"
              stroke="#334155"
              strokeWidth={Math.max(6, Math.min(18, 1.05 / pxPerMm))}
            />
          </pattern>
        </defs>

        <g transform={worldToScreenTransform}>
          {/* 1. Metric Grid */}
          {settings.showGrid && level.layers.grid && (
            <g className="pointer-events-none">
              {Array.from(
                { length: Math.max(0, Math.ceil((gridRange.maxX - gridRange.minX) / gridRange.step) + 1) },
                (_, i) => gridRange.minX + i * gridRange.step
              ).map((x) => {
                const isMeter = Math.abs(x % 1000) < 1;
                return (
                  <line
                    key={`gx_${x}`}
                    x1={x}
                    y1={gridRange.minY}
                    x2={x}
                    y2={gridRange.maxY}
                    stroke={
                      isBw
                        ? isMeter
                          ? 'rgba(15,23,42,0.14)'
                          : 'rgba(15,23,42,0.06)'
                        : isMeter
                          ? settings.darkMode
                            ? 'rgba(148,163,184,0.22)'
                            : 'rgba(100,116,139,0.20)'
                          : settings.darkMode
                            ? 'rgba(148,163,184,0.08)'
                            : 'rgba(148,163,184,0.12)'
                    }
                    strokeWidth={
                      isBw
                        ? Math.max(0.6, isMeter ? 0.95 : 0.6) / pxPerMm
                        : (isMeter ? 1.1 : 0.65) / pxPerMm
                    }
                  />
                );
              })}
              {Array.from(
                { length: Math.max(0, Math.ceil((gridRange.maxY - gridRange.minY) / gridRange.step) + 1) },
                (_, i) => gridRange.minY + i * gridRange.step
              ).map((y) => {
                const isMeter = Math.abs(y % 1000) < 1;
                return (
                  <line
                    key={`gy_${y}`}
                    x1={gridRange.minX}
                    y1={y}
                    x2={gridRange.maxX}
                    y2={y}
                    stroke={
                      isBw
                        ? isMeter
                          ? 'rgba(15,23,42,0.14)'
                          : 'rgba(15,23,42,0.06)'
                        : isMeter
                          ? settings.darkMode
                            ? 'rgba(148,163,184,0.22)'
                            : 'rgba(100,116,139,0.20)'
                          : settings.darkMode
                            ? 'rgba(148,163,184,0.08)'
                            : 'rgba(148,163,184,0.12)'
                    }
                    strokeWidth={
                      isBw
                        ? Math.max(0.6, isMeter ? 0.95 : 0.6) / pxPerMm
                        : (isMeter ? 1.1 : 0.65) / pxPerMm
                    }
                  />
                );
              })}
            </g>
          )}

          {/* 2. Background Floorplan Trace */}
          {level.backgroundTrace && level.backgroundTrace.visible && (
            <image
              href={level.backgroundTrace.imageDataUrl}
              x={level.backgroundTrace.xMm - level.backgroundTrace.widthMm / 2}
              y={level.backgroundTrace.yMm - level.backgroundTrace.heightMm / 2}
              width={level.backgroundTrace.widthMm}
              height={level.backgroundTrace.heightMm}
              opacity={level.backgroundTrace.opacity}
              transform={`rotate(${level.backgroundTrace.rotationDeg} ${level.backgroundTrace.xMm} ${level.backgroundTrace.yMm})`}
              className="pointer-events-none"
            />
          )}

          {/* 3. Detected Rooms (White architectural paper in B&W mode, or 3D-synced scale & rotation vector floor textures) */}
          {level.layers.rooms &&
            level.rooms.map((room) => {
              if (!room.visible || room.polygon.length < 3) return null;
              const ptsStr = room.polygon.map((p) => `${p.x},${p.y}`).join(' ');
              const selected = isSelected('room', room.id);
              const patId = `floor_pat_${room.id}`;
              const floorMetrics = resolvePatternMetrics(room.floorMaterial, {
                color: room.floorColor,
                secondaryColor: room.floorSecondaryColor,
                textureScale: room.floorTextureScale,
                textureRotDeg: room.floorTextureRotDeg,
                settings: room.floorSettings,
              });
              const hasPattern = !isBw && floorMetrics.hasPattern;

              return (
                <g
                  key={room.id}
                  onPointerDown={(e) => {
                    if (e.button === 1 || activeTool === 'pan' || spacePressed) return;
                    if (activeTool === 'eyedropper') {
                      handleElementSelect(e, { kind: 'room', id: room.id }, room.floorColor);
                      return;
                    }
                    if (activeTool !== 'select' || e.button !== 0) return;
                    e.stopPropagation();
                    const rawWorld = screenToWorld(e.clientX, e.clientY);
                    setDragState({
                      kind: 'marquee',
                      startWorld: rawWorld,
                      curWorld: rawWorld,
                      startClient: { x: e.clientX, y: e.clientY },
                      curClient: { x: e.clientX, y: e.clientY },
                      shiftKey: e.shiftKey,
                      ctrlKey: e.ctrlKey || e.metaKey,
                      prevSelection: selection,
                      roomClickTarget: { kind: 'room', id: room.id },
                    });
                  }}
                  className={activeTool === 'pan' || spacePressed ? 'cursor-grab' : 'cursor-pointer'}
                >
                  {hasPattern && (
                    <defs>
                      <VectorSurfacePatternDef id={patId} metrics={floorMetrics} />
                    </defs>
                  )}
                  <polygon
                    points={ptsStr}
                    fill={isBw ? '#FFFFFF' : floorMetrics.primaryHex}
                    fillOpacity={isBw ? 1 : 0.96}
                    stroke={selected ? '#2563EB' : 'none'}
                    strokeWidth={2 / pxPerMm}
                  />
                  {hasPattern && (
                    <polygon points={ptsStr} fill={`url(#${patId})`} className="pointer-events-none" />
                  )}
                </g>
              );
            })}

          {/* 4. Architectural Elements (Stairs, Columns, Platforms, Fireplaces; Chimneys union with walls below when walls layer is on) */}
          {level.layers.archElements &&
            level.archElements.map((el: ArchElement) => {
              if (!el.visible) return null;
              if (el.type === 'chimney' && level.layers.walls) return null;
              const selected = isSelected('arch', el.id);
              const isDimHovered =
                hoveredCompId === el.id ||
                hoveredDimKey === `comp:${el.id}` ||
                hoveredDimKey === `width:${el.id}`;
              const sw = (selected ? 2 : isDimHovered ? 1.8 : 1.05) / pxPerMm;
              const steps = el.stepCount ?? 12;
              const hw = el.widthMm / 2;
              const hd = el.depthMm / 2;
              const contourColor = selected
                ? '#2563EB'
                : isDimHovered
                  ? '#0EA5E9'
                  : isBw
                    ? '#0F172A'
                    : settings.darkMode
                      ? '#94A3B8'
                      : '#0F172A';
              const chimneyFill = isBw
                ? 'url(#bw_wall_hatch)'
                : el.color !== '#FFFFFF'
                  ? el.color
                  : settings.darkMode
                    ? '#1E293B'
                    : '#FFFFFF';

              const archTweenOff =
                snapTweenOffset && snapTweenOffset.targetKey === `arch:${el.id}`
                  ? snapTweenOffset
                  : null;

              return (
                <g
                  key={el.id}
                  data-ctx-kind="arch"
                  data-ctx-id={el.id}
                  transform={`translate(${el.xMm + (archTweenOff ? archTweenOff.dx : 0)}, ${el.yMm + (archTweenOff ? archTweenOff.dy : 0)}) rotate(${el.rotationDeg})`}
                  onPointerEnter={() => setHoveredCompId(el.id)}
                  onPointerLeave={() => setHoveredCompId((cur) => (cur === el.id ? null : cur))}
                  onPointerDown={(e) => {
                    const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
                    const alreadySelected = isSelected('arch', el.id);
                    handleElementSelect(e, { kind: 'arch', id: el.id }, el.color);
                    if (alreadySelected && !isMultiMod && activeTool === 'select' && !el.locked && e.button === 0) {
                      const w = screenToWorld(e.clientX, e.clientY);
                      snapHysteresisRef.current = {};
                      clearSnapTween();
                      setCursorHint(null);
                      dragMutatedRef.current = false;
                      setDragState({
                        kind: 'arch',
                        id: el.id,
                        offsetMm: { x: w.x - el.xMm, y: w.y - el.yMm },
                        startClient: { x: e.clientX, y: e.clientY },
                        label: `Move ${el.name}`,
                      });
                    }
                  }}
                  className={selected && !el.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                >
                  {el.type === 'column_round' ? (
                    <circle
                      cx={0}
                      cy={0}
                      r={hw}
                      fill={isBw ? 'none' : el.color}
                      stroke={contourColor}
                      strokeWidth={sw}
                    />
                  ) : el.type === 'railing' ? (
                    (() => {
                      const rCfg = resolveRailingConfig(el);
                      const metrics = computeRailingPathMetrics(rCfg);
                      const isGlass = rCfg.style === 'glass_panel' || rCfg.style === 'frameless_glass';
                      const railStrokeW = isBw ? Math.max(12, 1.35 / pxPerMm) : Math.max(28, rCfg.handrailWidthMm);
                      const postColor = isBw ? '#0F172A' : selected ? '#2563EB' : el.color || '#334155';
                      const railColor = isBw ? '#0F172A' : selected ? '#2563EB' : rCfg.handrailColor ?? el.color ?? '#334155';
                      const pathD =
                        rCfg.nodes.length >= 2
                          ? rCfg.nodes
                              .map((n, i) => `${i === 0 ? 'M' : 'L'} ${n.xMm} ${n.yMm}`)
                              .join(' ') + (rCfg.closed && rCfg.nodes.length >= 3 ? ' Z' : '')
                          : '';
                      return (
                        <g>
                          {/* Wide transparent hit target for reliable selection and dragging */}
                          {pathD && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={Math.max(220, rCfg.widthMm + 140)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                          {/* Style-specific infill band */}
                          {pathD && isGlass && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke={isBw ? '#64748B' : '#38BDF8'}
                              strokeOpacity={isBw ? 0.55 : 0.42}
                              strokeWidth={isBw ? Math.max(8, 0.85 / pxPerMm) : Math.max(18, rCfg.panelThicknessMm + 16)}
                              strokeLinejoin="round"
                            />
                          )}
                          {pathD && rCfg.style === 'solid_panel' && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke={isBw ? '#475569' : rCfg.secondaryColor || '#94A3B8'}
                              strokeWidth={isBw ? Math.max(10, 1.05 / pxPerMm) : Math.max(24, rCfg.panelThicknessMm + 10)}
                              strokeLinejoin="round"
                            />
                          )}
                          {pathD && (rCfg.style === 'cable' || rCfg.style === 'horizontal_metal') && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke={isBw ? '#475569' : rCfg.secondaryColor || '#64748B'}
                              strokeWidth={Math.max(8, 1.2 / pxPerMm)}
                              strokeDasharray={rCfg.style === 'cable' ? '36 24' : undefined}
                              strokeLinejoin="round"
                            />
                          )}
                          {/* Top handrail cap */}
                          {pathD && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke={railColor}
                              strokeOpacity={rCfg.style === 'frameless_glass' ? 0.72 : 0.96}
                              strokeWidth={railStrokeW}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                          {/* Wall standoff ticks for handrail-only */}
                          {rCfg.style === 'handrail_only' &&
                            metrics.segments.map((seg) =>
                              [0.15, 0.5, 0.85].map((t, bIdx) => {
                                const px = seg.start.xMm + (seg.end.xMm - seg.start.xMm) * t;
                                const py = seg.start.yMm + (seg.end.yMm - seg.start.yMm) * t;
                                const dx = seg.end.xMm - seg.start.xMm;
                                const dy = seg.end.yMm - seg.start.yMm;
                                const len = Math.hypot(dx, dy) || 1;
                                const nx = -dy / len;
                                const ny = dx / len;
                                return (
                                  <line
                                    key={`hb_${seg.index}_${bIdx}`}
                                    x1={px}
                                    y1={py}
                                    x2={px + nx * 42}
                                    y2={py + ny * 42}
                                    stroke={isBw ? '#0F172A' : rCfg.accentColor}
                                    strokeWidth={Math.max(10, 1.4 / pxPerMm)}
                                  />
                                );
                              })
                            )}
                          {/* Posts & Balusters along each run */}
                          {rCfg.style !== 'handrail_only' &&
                            rCfg.style !== 'frameless_glass' &&
                            metrics.segments.map((seg) => {
                              const dx = seg.end.xMm - seg.start.xMm;
                              const dy = seg.end.yMm - seg.start.yMm;
                              const segElevA = seg.start.elevationMm ?? 0;
                              const segElevB = seg.end.elevationMm ?? 0;
                              const midX = (seg.start.xMm + seg.end.xMm) / 2;
                              const midY = (seg.start.yMm + seg.end.yMm) / 2;
                              const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
                              const postHalf = Math.max(18, rCfg.postSizeMm * 0.58);
                              return (
                                <g key={`seg_${seg.index}`} className="pointer-events-none">
                                  {seg.balusterTs.map((bt, bi) => {
                                    const bx = seg.start.xMm + dx * bt;
                                    const by = seg.start.yMm + dy * bt;
                                    return (
                                      <circle
                                        key={`b_${bi}`}
                                        cx={bx}
                                        cy={by}
                                        r={Math.max(6, rCfg.balusterSizeMm * 0.45)}
                                        fill={isBw ? 'none' : rCfg.secondaryColor || postColor}
                                        stroke={isBw ? '#0F172A' : 'none'}
                                        strokeWidth={isBw ? Math.max(4, 0.7 / pxPerMm) : 0}
                                      />
                                    );
                                  })}
                                  {seg.postTs.map((pt, pi) => {
                                    const px = seg.start.xMm + dx * pt;
                                    const py = seg.start.yMm + dy * pt;
                                    const isEnd = pi === 0 || pi === seg.postTs.length - 1;
                                    const sHalf = isEnd
                                      ? Math.max(postHalf, (rCfg.endPostSizeMm ?? rCfg.postSizeMm) * 0.62)
                                      : postHalf;
                                    if (rCfg.postShape === 'round') {
                                      return (
                                        <circle
                                          key={`p_${pi}`}
                                          cx={px}
                                          cy={py}
                                          r={sHalf}
                                          fill={isBw ? 'none' : '#FFFFFF'}
                                          stroke={postColor}
                                          strokeWidth={Math.max(10, 1.4 / pxPerMm)}
                                        />
                                      );
                                    }
                                    return (
                                      <rect
                                        key={`p_${pi}`}
                                        x={px - sHalf}
                                        y={py - sHalf}
                                        width={sHalf * 2}
                                        height={sHalf * 2}
                                        fill={isBw ? 'none' : '#FFFFFF'}
                                        stroke={postColor}
                                        strokeWidth={Math.max(10, 1.4 / pxPerMm)}
                                      />
                                    );
                                  })}
                                  {Math.abs(segElevB - segElevA) > 15 && seg.planLengthMm > 350 && (
                                    <g transform={`translate(${midX}, ${midY}) rotate(${segElevB >= segElevA ? angDeg : angDeg + 180})`}>
                                      <path
                                        d="M-65 0 H65 M38 -26 L65 0 L38 26"
                                        fill="none"
                                        stroke={isBw ? '#0F172A' : '#2563EB'}
                                        strokeWidth={Math.max(12, 1.6 / pxPerMm)}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </g>
                                  )}
                                </g>
                              );
                            })}
                          {selected && pathD && (
                            <path
                              d={pathD}
                              fill="none"
                              stroke="#2563EB"
                              strokeWidth={railStrokeW + 24}
                              strokeOpacity={0.32}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="pointer-events-none"
                            />
                          )}
                        </g>
                      );
                    })()
                  ) : el.type === 'doorframe' ? (
                    (() => {
                      const jambW = Math.min(el.widthMm * 0.25, Math.max(45, Math.min(85, el.widthMm * 0.14)));
                      const jambFill = isBw ? 'none' : el.color === '#FFFFFF' ? '#CBD5E1' : el.color;
                      const casingExt = 18;
                      return (
                        <g>
                          {/* Invisible center hit area for smooth dragging & selection */}
                          <rect
                            x={-hw}
                            y={-hd}
                            width={el.widthMm}
                            height={el.depthMm}
                            fill="transparent"
                          />
                          {/* Dashed header opening lines (no door leaf / no swing arc) */}
                          <line
                            x1={-hw + jambW}
                            y1={-hd}
                            x2={hw - jambW}
                            y2={-hd}
                            stroke={contourColor}
                            strokeWidth={sw}
                            strokeDasharray="60 45"
                          />
                          <line
                            x1={-hw + jambW}
                            y1={hd}
                            x2={hw - jambW}
                            y2={hd}
                            stroke={contourColor}
                            strokeWidth={sw}
                            strokeDasharray="60 45"
                          />
                          {/* Optional threshold sill line */}
                          {el.hasRailing !== false && (
                            <line
                              x1={-hw + jambW}
                              y1={0}
                              x2={hw - jambW}
                              y2={0}
                              stroke={isBw ? '#475569' : el.accentColor || '#64748B'}
                              strokeWidth={sw * 0.9}
                            />
                          )}
                          {/* Left & Right Doorframe Jambs + Architrave ticks */}
                          <rect
                            x={-hw}
                            y={-hd - casingExt}
                            width={jambW}
                            height={el.depthMm + casingExt * 2}
                            fill={jambFill}
                            stroke={contourColor}
                            strokeWidth={sw}
                          />
                          <rect
                            x={hw - jambW}
                            y={-hd - casingExt}
                            width={jambW}
                            height={el.depthMm + casingExt * 2}
                            fill={jambFill}
                            stroke={contourColor}
                            strokeWidth={sw}
                          />
                        </g>
                      );
                    })()
                  ) : el.type.startsWith('stairs') ? (
                    (() => {
                      const stairSpec = computeStaircaseGeometrySpec(el, level.ceilingHeightMm);
                      const hostRails = resolveHostStairRailings(el, level.ceilingHeightMm);
                      const stairFill = isBw ? 'none' : el.color;
                      return (
                        <g>
                          {/* Hit area */}
                          <rect
                            x={-hw}
                            y={-hd}
                            width={el.widthMm}
                            height={el.depthMm}
                            fill="transparent"
                          />
                          {el.type === 'stairs_spiral' && (
                            <circle
                              cx={0}
                              cy={0}
                              r={Math.min(hw, hd)}
                              fill={stairFill}
                              fillOpacity={0.92}
                              stroke={contourColor}
                              strokeWidth={sw}
                            />
                          )}
                          {stairSpec.steps.map((st, idx) => {
                            if (st.wedgeRadiusMm && st.wedgeStartAngleRad !== undefined && st.wedgeSweepRad !== undefined) {
                              const rOut = st.wedgeRadiusMm;
                              const rIn = Math.max(85, rOut * 0.16);
                              const a0 = st.wedgeStartAngleRad;
                              const a1 = a0 + st.wedgeSweepRad;
                              const x0 = Math.cos(a0) * rIn;
                              const y0 = Math.sin(a0) * rIn;
                              const x1 = Math.cos(a0) * rOut;
                              const y1 = Math.sin(a0) * rOut;
                              const x2 = Math.cos(a1) * rOut;
                              const y2 = Math.sin(a1) * rOut;
                              const x3 = Math.cos(a1) * rIn;
                              const y3 = Math.sin(a1) * rIn;
                              const dAttr = `M ${x0} ${y0} L ${x1} ${y1} A ${rOut} ${rOut} 0 0 ${st.wedgeSweepRad >= 0 ? 1 : 0} ${x2} ${y2} L ${x3} ${y3} Z`;
                              return (
                                <path
                                  key={`step_${idx}`}
                                  d={dAttr}
                                  fill={stairFill}
                                  stroke={isBw ? '#0F172A' : '#475569'}
                                  strokeWidth={Math.max(6, 0.9 / pxPerMm)}
                                />
                              );
                            }
                            return (
                              <g
                                key={`step_${idx}`}
                                transform={`translate(${st.centerXMm}, ${st.centerYMm}) rotate(${st.rotationDeg})`}
                              >
                                <rect
                                  x={-st.widthMm / 2}
                                  y={-st.depthMm / 2}
                                  width={st.widthMm}
                                  height={st.depthMm}
                                  fill={stairFill}
                                  stroke={st.isLanding ? contourColor : isBw ? '#0F172A' : '#475569'}
                                  strokeWidth={st.isLanding ? sw : Math.max(6, 0.9 / pxPerMm)}
                                />
                              </g>
                            );
                          })}
                          {el.type === 'stairs_spiral' && (
                            <circle
                              cx={0}
                              cy={0}
                              r={Math.max(80, Math.min(hw, hd) * 0.15)}
                              fill={isBw ? 'none' : el.accentColor || '#334155'}
                              stroke={contourColor}
                              strokeWidth={sw}
                            />
                          )}
                          {stairSpec.walkLine2D.length >= 2 && (
                            <polyline
                              points={stairSpec.walkLine2D.map((p) => `${p.x},${p.y}`).join(' ')}
                              fill="none"
                              stroke={isBw ? '#0F172A' : '#2563EB'}
                              strokeWidth={1.6 / pxPerMm}
                              markerEnd="url(#arrow_head)"
                              className="pointer-events-none"
                            />
                          )}
                          {/* Integrated staircase railings in 2D */}
                          {hostRails.map((hRail, rIdx) => (
                            <g key={`hrail_${rIdx}`} className="pointer-events-none">
                              <polyline
                                points={hRail.nodes.map((n) => `${n.xMm},${n.yMm}`).join(' ')}
                                fill="none"
                                stroke={
                                  hRail.style === 'glass_panel' || hRail.style === 'frameless_glass'
                                    ? isBw
                                      ? '#475569'
                                      : '#0284C7'
                                    : isBw
                                      ? '#0F172A'
                                      : hRail.handrailColor ?? '#334155'
                                }
                                strokeWidth={Math.max(24, hRail.handrailWidthMm)}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeOpacity={0.92}
                              />
                              {hRail.nodes.map((n, nIdx) => (
                                <circle
                                  key={`hrn_${nIdx}`}
                                  cx={n.xMm}
                                  cy={n.yMm}
                                  r={Math.max(14, hRail.postSizeMm * 0.48)}
                                  fill="#FFFFFF"
                                  stroke={isBw ? '#0F172A' : '#334155'}
                                  strokeWidth={Math.max(8, 1.1 / pxPerMm)}
                                />
                              ))}
                            </g>
                          ))}
                        </g>
                      );
                    })()
                  ) : (
                    <>
                      <rect
                        x={-hw}
                        y={-hd}
                        width={el.widthMm}
                        height={el.depthMm}
                        fill={el.type === 'chimney' ? chimneyFill : isBw ? 'none' : el.color}
                        fillOpacity={isBw ? 1 : el.type === 'beam' ? 0.35 : 0.94}
                        stroke={contourColor}
                        strokeDasharray={el.type === 'beam' ? '70 50' : undefined}
                        strokeWidth={sw}
                      />
                      {(el.type === 'balcony' || el.type === 'platform') &&
                        resolveHostDeckRailings(el).map((dRail, dIdx) => {
                          const dStr =
                            dRail.nodes.map((n, i) => `${i === 0 ? 'M' : 'L'} ${n.xMm} ${n.yMm}`).join(' ') +
                            (dRail.closed && dRail.nodes.length >= 3 ? ' Z' : '');
                          return (
                            <g key={`drail_${dIdx}`} className="pointer-events-none">
                              <path
                                d={dStr}
                                fill="none"
                                stroke={
                                  dRail.style === 'glass_panel' || dRail.style === 'frameless_glass'
                                    ? isBw
                                      ? '#334155'
                                      : '#0284C7'
                                    : isBw
                                      ? '#0F172A'
                                      : dRail.handrailColor ?? '#334155'
                                }
                                strokeWidth={Math.max(26, dRail.handrailWidthMm)}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              {dRail.nodes.map((n, nIdx) => (
                                <circle
                                  key={`drn_${nIdx}`}
                                  cx={n.xMm}
                                  cy={n.yMm}
                                  r={Math.max(15, dRail.postSizeMm * 0.5)}
                                  fill="#FFFFFF"
                                  stroke={isBw ? '#0F172A' : '#334155'}
                                  strokeWidth={Math.max(8, 1.1 / pxPerMm)}
                                />
                              ))}
                            </g>
                          );
                        })}
                      {!isBw && el.type === 'chimney' && (() => {
                        const fc = resolveChimneyFaceColors(el);
                        const bandW = Math.max(18, Math.min(48, Math.min(el.widthMm, el.depthMm) * 0.14));
                        return (
                          <g className="pointer-events-none">
                            <rect x={-hw} y={-hd} width={el.widthMm} height={bandW} fill={fc.back} />
                            <rect x={-hw} y={hd - bandW} width={el.widthMm} height={bandW} fill={fc.front} />
                            <rect x={-hw} y={-hd} width={bandW} height={el.depthMm} fill={fc.left} />
                            <rect x={hw - bandW} y={-hd} width={bandW} height={el.depthMm} fill={fc.right} />
                          </g>
                        );
                      })()}
                    </>
                  )}
                </g>
              );
            })}

          {/* 5. Elevation-Aware Furniture & Multi-Part Sub-Objects (Pass 1: bottom-to-top Z layering) */}
          {level.layers.furniture &&
            orderedPlanFurniture.map((f) => {
              if (!f.visible) return null;
              const wholeSelected = isSelected('furniture', f.id);
              const fInfo = furnElevInfo.get(f.id);
              const isOverhead = fInfo?.band === 'overhead';
              const isCeilingSymbol = isOverhead && isCeilingFixture(f);
              const isCoveringUpper = (fInfo?.coveringLowerIds.length ?? 0) > 0;
              const isCoveredLower = (fInfo?.coveredByUpperIds.length ?? 0) > 0;
              // Every non-ceiling furniture piece renders crisp at full color; ceiling fixtures keep dashed overhead symbol
              const fillOpacityScale = isCeilingSymbol ? 0.16 : 1;
              const strokeDasharray = isCeilingSymbol ? '55 38' : undefined;
              const elementOpacity = isCeilingSymbol ? 0.84 : 1;
              const adjacentShadows = stackVisualData.shadowsBeforeUpperId.get(f.id);
              const contactShadowFill = !isBw && settings.darkMode ? '#020617' : '#0F172A';
              const contactShadowOpacity = isBw ? 0 : settings.darkMode ? 0.28 : 0.13;

              const placement = getFurniturePlacement(f);
              const mx = placement.mirrorSignX;
              const my = placement.mirrorSignY;
              const bounds = placement.tiltedLocalBounds;
              const boundsW = bounds.widthMm;
              const boundsD = bounds.depthMm;
              const activePartId =
                selectedFurniturePart?.id === f.id ? selectedFurniturePart.partId : undefined;
              const activePart = activePartId ? f.parts.find((p) => p.id === activePartId) : undefined;

              const {
                isCustomTop,
                effectiveRepForTop,
                hasTopSvg,
                topScaleX,
                topScaleY,
                applyMirrorScale2D,
              } = resolveFurnitureTopPlanView(f, boundsW, boundsD, placement.hasTilt);

              const selPad = 5 / pxPerMm;
              const repCenterShiftX = (bounds.minX + bounds.maxX) / 2;
              const repCenterShiftY = (bounds.minY + bounds.maxY) / 2;
              const handleCx = (bounds.minX + bounds.maxX) / 2;
              const handleTopY = bounds.minY - selPad;
              const handleY = handleTopY - 28 / pxPerMm;
              const isRotatingThis =
                dragState?.kind === 'furniture_rotate' &&
                dragState.id === f.id &&
                rotateReadout?.furnId === f.id;
              const showElevBadge =
                (wholeSelected || hoveredFurnId === f.id) &&
                (Boolean(fInfo?.sameSpotOverlapIds.length) ||
                  fInfo?.band === 'elevated' ||
                  isOverhead ||
                  isCoveredLower ||
                  isCoveringUpper);

              const furnTweenOff =
                snapTweenOffset &&
                (snapTweenOffset.targetKey === `furniture:${f.id}` ||
                  (f.surfaceHostId && snapTweenOffset.targetKey === `furniture:${f.surfaceHostId}`))
                  ? snapTweenOffset
                  : null;

              return (
                <React.Fragment key={f.id}>
                  {!isBw &&
                    adjacentShadows &&
                    adjacentShadows.map((sh) => (
                      <g
                        key={sh.key}
                        data-testid={`contact-shadow-${sh.upperId}-${sh.lowerId}`}
                        data-offset-px={sh.offsetPx.toFixed(2)}
                        opacity={contactShadowOpacity}
                        className="pointer-events-none"
                      >
                        {sh.polygons.map((poly, pIdx) => (
                          <polygon
                            key={pIdx}
                            points={poly.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                            fill={contactShadowFill}
                          />
                        ))}
                      </g>
                    ))}
                  <g
                    data-ctx-kind="furniture"
                    data-ctx-id={f.id}
                    transform={`translate(${f.xMm + (furnTweenOff ? furnTweenOff.dx : 0)}, ${f.yMm + (furnTweenOff ? furnTweenOff.dy : 0)}) rotate(${f.rotationDeg})`}
                    onPointerEnter={() => setHoveredFurnId(f.id)}
                    onPointerLeave={() => setHoveredFurnId((c) => (c === f.id ? null : c))}
                  >
                    {hasTopSvg ? (
                      <>
                        <g
                          transform={`translate(${repCenterShiftX}, ${repCenterShiftY}) scale(${applyMirrorScale2D ? mx : 1}, ${applyMirrorScale2D ? my : 1})`}
                        onPointerDown={(e) =>
                          handleFurniturePointerDown(e, f, f.parts[0]?.color)
                        }
                        className={wholeSelected && !f.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                      >
                        <rect
                          x={-boundsW / 2}
                          y={-boundsD / 2}
                          width={boundsW}
                          height={boundsD}
                          fill="transparent"
                          stroke="none"
                        />
                        {renderFurnitureRepresentationView(effectiveRepForTop, 'top', {
                          baseStrokeMm: Math.max(isBw ? 4.5 : 4, (isBw ? 0.85 : 0.78) / pxPerMm),
                          selected: wholeSelected && !activePartId,
                          useMaterialFill: Boolean(f.representation?.useMaterialFill && !isBw),
                          darkMode: settings.darkMode,
                          blackAndWhite: isBw,
                          fillOpacityScale: isBw ? 0 : fillOpacityScale,
                          elementOpacity,
                          strokeDasharray,
                          scaleX: topScaleX,
                          scaleY: topScaleY,
                        })}
                      </g>
                      {/* Invisible part hit-targets when whole object is selected so multi-part editing stays accessible */}
                      {wholeSelected && !isCustomTop && !placement.hasTilt && f.parts.length > 1 && (
                        <g transform={`scale(${mx}, ${my})`}>
                          {[...f.parts]
                            .sort((a, b) => a.zMm - b.zMm)
                            .map((p) => {
                              const isPartSel = activePartId === p.id;
                              return (
                                <g
                                  key={`hit_${p.id}`}
                                  transform={`translate(${p.xMm}, ${p.yMm}) rotate(${p.rotationDeg})`}
                                  onPointerDown={(e) =>
                                    handleFurniturePointerDown(e, f, p.color, p.id)
                                  }
                                  className={!f.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                                >
                                  <rect
                                    x={-p.widthMm / 2}
                                    y={-p.depthMm / 2}
                                    width={p.widthMm}
                                    height={p.depthMm}
                                    fill="transparent"
                                    stroke={isPartSel ? '#2563EB' : 'none'}
                                    strokeWidth={isPartSel ? Math.max(8, 1.4 / pxPerMm) : 0}
                                    strokeDasharray={isPartSel ? '30 20' : undefined}
                                  />
                                </g>
                              );
                            })}
                        </g>
                      )}
                    </>
                  ) : (
                    <rect
                      x={bounds.minX}
                      y={bounds.minY}
                      width={boundsW}
                      height={boundsD}
                      fill={isBw ? 'none' : '#E2E8F0'}
                      fillOpacity={isBw ? 0 : fillOpacityScale}
                      stroke={wholeSelected ? '#2563EB' : isBw ? '#0F172A' : '#1E293B'}
                      strokeWidth={Math.max(isBw ? 4.5 : 4, (isBw ? 0.85 : 0.78) / pxPerMm)}
                      strokeDasharray={strokeDasharray}
                      onPointerDown={(e) =>
                        handleFurniturePointerDown(e, f, f.parts[0]?.color)
                      }
                      className={wholeSelected && !f.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                    />
                  )}

                  {/* Overall Selection Outline & Centered Rotate Handle */}
                  {wholeSelected && (
                    <g>
                      <rect
                        x={bounds.minX - selPad}
                        y={bounds.minY - selPad}
                        width={boundsW + selPad * 2}
                        height={boundsD + selPad * 2}
                        fill="none"
                        stroke="#2563EB"
                        strokeDasharray={`${6 / pxPerMm} ${4 / pxPerMm}`}
                        strokeWidth={1.6 / pxPerMm}
                        className="pointer-events-none"
                      />
                      <line
                        x1={handleCx}
                        y1={handleTopY}
                        x2={handleCx}
                        y2={handleY}
                        stroke="#2563EB"
                        strokeWidth={1.4 / pxPerMm}
                      />
                      <g
                        className={isRotatingThis ? 'cursor-grabbing' : 'cursor-grab'}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          if (!f.locked) {
                            const w = screenToWorld(e.clientX, e.clientY);
                            const startPointerDeg =
                              (Math.atan2(w.y - f.yMm, w.x - f.xMm) * 180) / Math.PI;
                            dragMutatedRef.current = false;
                            setRotateReadout({
                              furnId: f.id,
                              deg: ((f.rotationDeg % 360) + 360) % 360,
                              snapped: !e.shiftKey && settings.angleSnapDeg > 0,
                              step: settings.angleSnapDeg > 0 ? settings.angleSnapDeg : 0.5,
                            });
                            setDragState({
                              kind: 'furniture_rotate',
                              id: f.id,
                              center: { x: f.xMm, y: f.yMm },
                              origRotDeg: f.rotationDeg,
                              startPointerDeg,
                              startClient: { x: e.clientX, y: e.clientY },
                              label: `Rotate ${f.name}`,
                            });
                          }
                        }}
                      >
                        <title>Drag to rotate horizontally · Hold Shift for unrestricted angle</title>
                        <circle
                          data-testid={`rotate-handle-hit-${f.id}`}
                          cx={handleCx}
                          cy={handleY}
                          r={12 / pxPerMm}
                          fill="transparent"
                        />
                        <circle
                          data-testid={`rotate-handle-${f.id}`}
                          cx={handleCx}
                          cy={handleY}
                          r={7 / pxPerMm}
                          fill={isRotatingThis ? '#2563EB' : '#FFFFFF'}
                          stroke="#2563EB"
                          strokeWidth={2 / pxPerMm}
                        />
                      </g>
                      {isRotatingThis && rotateReadout && (
                        <g
                          transform={`translate(${handleCx}, ${handleY - 22 / pxPerMm}) rotate(${-f.rotationDeg - viewRotationDeg})`}
                          className="pointer-events-none"
                        >
                          <rect
                            x={-54 / pxPerMm}
                            y={-12 / pxPerMm}
                            width={108 / pxPerMm}
                            height={20 / pxPerMm}
                            rx={4 / pxPerMm}
                            fill="#0F172A"
                            fillOpacity={0.92}
                            stroke="#3B82F6"
                            strokeWidth={1 / pxPerMm}
                          />
                          <text
                            x={0}
                            y={2.5 / pxPerMm}
                            textAnchor="middle"
                            fontSize={10.5 / pxPerMm}
                            fontFamily="JetBrains Mono, monospace"
                            fontWeight={600}
                            fill="#FFFFFF"
                          >
                            {rotateReadout.snapped
                              ? `${rotateReadout.deg}° · ${rotateReadout.step}°`
                              : `${rotateReadout.deg}° · Free`}
                          </text>
                        </g>
                      )}
                    </g>
                  )}

                  {/* Subtle Elevation Span Readout Tag on Hover or Selection */}
                  {showElevBadge && fInfo && (
                    <g
                      transform={`translate(${bounds.maxX}, ${bounds.minY - 12 / pxPerMm}) rotate(${-f.rotationDeg - viewRotationDeg})`}
                      className="pointer-events-none"
                    >
                      {(() => {
                        const minCm = Math.round(fInfo.span.minZ / 10);
                        const maxCm = Math.round(fInfo.span.maxZ / 10);
                        const zText = `Z ${minCm}–${maxCm} cm`;
                        const badgeW = Math.max(66, zText.length * 6.2 + 12) / pxPerMm;
                        return (
                          <>
                            <rect
                              x={-badgeW}
                              y={-15 / pxPerMm}
                              width={badgeW}
                              height={16 / pxPerMm}
                              rx={3 / pxPerMm}
                              fill={wholeSelected ? '#1E3A8A' : '#0F172A'}
                              fillOpacity={0.86}
                              stroke={wholeSelected ? '#60A5FA' : '#475569'}
                              strokeWidth={0.9 / pxPerMm}
                            />
                            <text
                              x={-badgeW / 2}
                              y={-4 / pxPerMm}
                              textAnchor="middle"
                              fontSize={9 / pxPerMm}
                              fontFamily="JetBrains Mono, monospace"
                              fontWeight={600}
                              fill="#F8FAFC"
                            >
                              {zText}
                            </text>
                          </>
                        );
                      })()}
                    </g>
                  )}

                  {/* Selected-Only Read-Only 2D Light Source Visual Indicators */}
                  {wholeSelected && isFurnitureLightObject(f) && (() => {
                    const furnLights = resolveEffectiveFurnitureLights(f);
                    if (furnLights.length === 0) return null;
                    const masterLit = isFurnitureLightingActive(f);
                    const markerR = 5.5 / pxPerMm;
                    const aimLen = Math.max(190, 26 / pxPerMm);
                    return (
                      <g transform={`scale(${mx}, ${my})`} opacity={masterLit ? 1 : 0.45} className="pointer-events-none">
                        {furnLights.map((light) => {
                          const hex = masterLit && light.enabled ? resolveLightSourceHex(light) : '#94A3B8';
                          const azRad = (light.aimAzimuthDeg * Math.PI) / 180;
                          const dirX = Math.sin(azRad);
                          const dirY = Math.cos(azRad);
                          const hasAim =
                            light.type === 'spot' ||
                            light.type === 'area' ||
                            light.type === 'linear';
                          const aimTipX = light.xMm + dirX * aimLen;
                          const aimTipY = light.yMm + dirY * aimLen;
                          const halfConeRad = ((light.coneAngleDeg ?? 58) * Math.PI) / 180;
                          const sectorR = Math.min(aimLen * 1.15, Math.max(220, (light.rangeMm || 3500) * 0.14));
                          const leftConeX = light.xMm + Math.sin(azRad - halfConeRad * 0.55) * sectorR;
                          const leftConeY = light.yMm + Math.cos(azRad - halfConeRad * 0.55) * sectorR;
                          const rightConeX = light.xMm + Math.sin(azRad + halfConeRad * 0.55) * sectorR;
                          const rightConeY = light.yMm + Math.cos(azRad + halfConeRad * 0.55) * sectorR;

                          return (
                            <g key={light.id} className="pointer-events-none">
                              {light.type === 'area' && (
                                <rect
                                  x={light.xMm - (light.widthMm ?? 400) / 2}
                                  y={light.yMm - (light.lengthMm ?? 400) / 2}
                                  width={light.widthMm ?? 400}
                                  height={light.lengthMm ?? 400}
                                  fill={hex}
                                  fillOpacity={light.enabled ? 0.16 : 0.06}
                                  stroke={hex}
                                  strokeWidth={1.3 / pxPerMm}
                                  strokeDasharray={`${32} ${22}`}
                                />
                              )}
                              {light.type === 'linear' && (
                                <line
                                  x1={light.xMm - (light.widthMm ?? 700) / 2}
                                  y1={light.yMm}
                                  x2={light.xMm + (light.widthMm ?? 700) / 2}
                                  y2={light.yMm}
                                  stroke={hex}
                                  strokeWidth={Math.max(24, 3.6 / pxPerMm)}
                                  strokeLinecap="round"
                                  strokeOpacity={light.enabled ? 0.72 : 0.3}
                                />
                              )}
                              {light.type === 'spot' && light.enabled && (
                                <path
                                  d={`M ${light.xMm} ${light.yMm} L ${leftConeX} ${leftConeY} L ${rightConeX} ${rightConeY} Z`}
                                  fill={hex}
                                  fillOpacity={0.14}
                                  stroke={hex}
                                  strokeOpacity={0.45}
                                  strokeWidth={1 / pxPerMm}
                                  strokeDasharray="24 20"
                                />
                              )}
                              {hasAim && (
                                <>
                                  <line
                                    x1={light.xMm}
                                    y1={light.yMm}
                                    x2={aimTipX}
                                    y2={aimTipY}
                                    stroke={hex}
                                    strokeWidth={1.6 / pxPerMm}
                                    strokeDasharray="28 18"
                                  />
                                  <circle
                                    cx={aimTipX}
                                    cy={aimTipY}
                                    r={2.8 / pxPerMm}
                                    fill={hex}
                                    fillOpacity={0.75}
                                  />
                                </>
                              )}
                              <circle
                                cx={light.xMm}
                                cy={light.yMm}
                                r={markerR * 1.65}
                                fill={hex}
                                fillOpacity={light.enabled ? 0.22 : 0.08}
                              />
                              <circle
                                data-testid={`light-marker-${f.id}-${light.id}`}
                                cx={light.xMm}
                                cy={light.yMm}
                                r={markerR}
                                fill={hex}
                                stroke="#0F172A"
                                strokeWidth={1.6 / pxPerMm}
                              >
                                <title>{`${light.name} (${light.type}) · Visual light indicator`}</title>
                              </circle>
                            </g>
                          );
                        })}
                      </g>
                    );
                  })()}

                  {/* Direct Part-Edge Resize Handles when an individual part is selected */}
                  {activePart && !f.locked && !isFixedSizeFurniture(f) && (
                    <g transform={`scale(${mx}, ${my})`}>
                      <g transform={`translate(${activePart.xMm}, ${activePart.yMm}) rotate(${activePart.rotationDeg})`}>
                        {(
                          [
                            { edge: 'left', cx: -activePart.widthMm / 2, cy: 0, cur: 'ew-resize' },
                            { edge: 'right', cx: activePart.widthMm / 2, cy: 0, cur: 'ew-resize' },
                            { edge: 'top', cx: 0, cy: -activePart.depthMm / 2, cur: 'ns-resize' },
                            { edge: 'bottom', cx: 0, cy: activePart.depthMm / 2, cur: 'ns-resize' },
                          ] as const
                        ).map((h) => (
                          <g
                            key={h.edge}
                            style={{ cursor: h.cur }}
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              e.stopPropagation();
                              const w = screenToWorld(e.clientX, e.clientY);
                              const rad = (-f.rotationDeg * Math.PI) / 180;
                              const dxW = w.x - f.xMm;
                              const dyW = w.y - f.yMm;
                              const localX =
                                (dxW * Math.cos(rad) - dyW * Math.sin(rad)) * (f.mirroredX ? -1 : 1);
                              const localY =
                                (dxW * Math.sin(rad) + dyW * Math.cos(rad)) * (f.mirroredY ? -1 : 1);
                              dragMutatedRef.current = false;
                              setDragState({
                                kind: 'part_edge',
                                furnId: f.id,
                                partId: activePart.id,
                                edge: h.edge,
                                origPart: { ...activePart },
                                startLocal: { x: localX, y: localY },
                                startClient: { x: e.clientX, y: e.clientY },
                                label: `Resize ${activePart.name}`,
                              });
                            }}
                          >
                            <rect
                              x={h.cx - 12 / pxPerMm}
                              y={h.cy - 12 / pxPerMm}
                              width={24 / pxPerMm}
                              height={24 / pxPerMm}
                              fill="transparent"
                            />
                            <rect
                              x={h.cx - 5 / pxPerMm}
                              y={h.cy - 5 / pxPerMm}
                              width={10 / pxPerMm}
                              height={10 / pxPerMm}
                              fill="#2563EB"
                              stroke="#FFFFFF"
                              strokeWidth={1.5 / pxPerMm}
                            />
                          </g>
                        ))}
                      </g>
                    </g>
                  )}
                </g>
                </React.Fragment>
              );
            })}

          {/* 5b. Pass 2 (pointer-events-none): Overlap-Clipped Muted Slate Dashed Contours for Lower Items */}
          {level.layers.furniture &&
            orderedPlanFurniture
              .filter(
                (f) =>
                  f.visible &&
                  (stackVisualData.overlapClipPolygonsByLowerId.get(f.id)?.length ?? 0) > 0
              )
              .map((f) => {
                const wholeSelected = isSelected('furniture', f.id);
                const lowerStrokeColor = isBw
                  ? '#475569'
                  : settings.darkMode
                    ? '#94A3B8'
                    : '#64748B';
                const placement = getFurniturePlacement(f);
                const mx = placement.mirrorSignX;
                const my = placement.mirrorSignY;
                const bounds = placement.tiltedLocalBounds;
                const boundsW = bounds.widthMm;
                const boundsD = bounds.depthMm;
                const repCenterShiftX = (bounds.minX + bounds.maxX) / 2;
                const repCenterShiftY = (bounds.minY + bounds.maxY) / 2;
                const {
                  effectiveRepForTop,
                  topResolved,
                  hasTopSvg,
                  topScaleX,
                  topScaleY,
                  applyMirrorScale2D,
                } = resolveFurnitureTopPlanView(f, boundsW, boundsD, placement.hasTilt);
                const strokelessTopSvg =
                  hasTopSvg &&
                  Boolean(topResolved.elements?.every((el) => el.stroke === 'none'));

                const covTweenOff =
                  snapTweenOffset &&
                  (snapTweenOffset.targetKey === `furniture:${f.id}` ||
                    (f.surfaceHostId && snapTweenOffset.targetKey === `furniture:${f.surfaceHostId}`))
                    ? snapTweenOffset
                    : null;

                return (
                  <g
                    key={`covered_contour_${f.id}`}
                    data-testid={`covered-contour-${f.id}`}
                    clipPath={`url(#stack_overlap_clip_${f.id})`}
                    className="pointer-events-none"
                    opacity={wholeSelected ? 0.96 : 0.88}
                  >
                    <g
                      transform={`translate(${f.xMm + (covTweenOff ? covTweenOff.dx : 0)}, ${f.yMm + (covTweenOff ? covTweenOff.dy : 0)}) rotate(${f.rotationDeg})`}
                    >
                      {hasTopSvg && !strokelessTopSvg ? (
                        <g
                          transform={`translate(${repCenterShiftX}, ${repCenterShiftY}) scale(${applyMirrorScale2D ? mx : 1}, ${applyMirrorScale2D ? my : 1})`}
                        >
                          {renderFurnitureRepresentationView(effectiveRepForTop, 'top', {
                            baseStrokeMm: Math.max(4, 0.85 / pxPerMm),
                            selected: wholeSelected,
                            selectedStrokeColor: '#2563EB',
                            overrideStrokeColor: lowerStrokeColor,
                            useMaterialFill: false,
                            darkMode: settings.darkMode,
                            blackAndWhite: isBw,
                            fillOpacityScale: 0,
                            strokeDasharray: '42 26',
                            scaleX: topScaleX,
                            scaleY: topScaleY,
                          })}
                        </g>
                      ) : (
                        <rect
                          x={bounds.minX}
                          y={bounds.minY}
                          width={boundsW}
                          height={boundsD}
                          fill="none"
                          stroke={wholeSelected ? '#2563EB' : lowerStrokeColor}
                          strokeWidth={Math.max(5, 0.9 / pxPerMm)}
                          strokeDasharray="42 26"
                        />
                      )}
                    </g>
                  </g>
                );
              })}

          {/* 5c. Full-Cover 1-3 Constant-Screen-Pixel Hairline Offset Outlines (replaces insets & numeric tier badges) */}
          {level.layers.furniture &&
            Array.from(stackVisualData.fullCoverHairlinesByUpperId.values()).map((cluster) => {
              const wholeSelected = isSelected('furniture', cluster.upperId);
              const hairlineStroke = wholeSelected
                ? '#2563EB'
                : !isBw && settings.darkMode
                  ? '#94A3B8'
                  : '#475569';
              const strokeW = Math.max(3, 1.0 / pxPerMm);
              return (
                <g key={`hairline_cluster_${cluster.upperId}`} className="pointer-events-none">
                  {Array.from({ length: cluster.count }, (_, idx) => {
                    const ringIdx = idx + 1;
                    const offsetMm = (ringIdx * 3.0) / Math.max(0.015, pxPerMm);
                    const ringOpacity = Math.max(0.36, 0.74 - idx * 0.16);
                    return cluster.basePolygons.map((poly, pIdx) => {
                      const outset = outsetPolygon2D(poly, offsetMm);
                      return (
                        <polygon
                          key={`hl_${cluster.upperId}_${ringIdx}_${pIdx}`}
                          data-testid={`stack-hairline-${cluster.upperId}-${ringIdx}`}
                          points={outset.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                          fill="none"
                          stroke={hairlineStroke}
                          strokeWidth={strokeW}
                          strokeOpacity={wholeSelected ? Math.min(0.95, ringOpacity + 0.15) : ringOpacity}
                        />
                      );
                    });
                  })}
                </g>
              );
            })}

          {/* 5d. Exact Red Diagonal-Line Clash Overlay (shown only when an overlapping item is selected) */}
          {level.layers.furniture &&
            (() => {
              const selectedClashRegions = clashRegions.filter(
                (reg) => isSelected('furniture', reg.idA) || isSelected('furniture', reg.idB)
              );
              if (selectedClashRegions.length === 0) return null;
              return (
                <g data-testid="clash-overlays-layer" className="pointer-events-none">
                  {selectedClashRegions.map((reg, idx) => (
                    <polygon
                      key={`clash_${reg.idA}_${reg.idB}_${idx}`}
                      data-testid="clash-intersection-poly"
                      className="animate-clash-fade-in"
                      points={reg.poly.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="url(#clash_diagonal_hatch)"
                      stroke="#DC2626"
                      strokeWidth={Math.max(5, 1.35 / pxPerMm)}
                      strokeOpacity="0.92"
                    />
                  ))}
                </g>
              );
            })()}

          {/* 5e. Dev-only 3D Footprint Parity Overlay (toggled via ?parity=1 or Ctrl+Shift+P) */}
          {import.meta.env.DEV && devParityOverlay && level.layers.furniture && (
            <g data-testid="dev-parity-overlay" className="pointer-events-none">
              {orderedPlanFurniture
                .filter((f) => f.visible)
                .map((f) => {
                  const placement = getFurniturePlacement(f, {
                    effectiveCeilingMm: level.ceilingHeightMm,
                  });
                  const bounds = placement.tiltedLocalBounds;
                  const topInfo = resolveFurnitureTopPlanView(
                    f,
                    bounds.widthMm,
                    bounds.depthMm,
                    placement.hasTilt
                  );
                  const report = evaluateFurniturePlanParity(
                    f,
                    {
                      elements: topInfo.topResolved.elements,
                      topScaleX: topInfo.topScaleX,
                      topScaleY: topInfo.topScaleY,
                      applyMirrorScale2D: topInfo.applyMirrorScale2D,
                    },
                    level.ceilingHeightMm,
                    1.0
                  );
                  const strokeCol = report.hasMismatch ? '#EF4444' : '#10B981';
                  const repCol = report.hasMismatch ? '#F97316' : '#0EA5E9';
                  const labelText = report.hasMismatch
                    ? `>1mm Δ${report.maxDiffMm.toFixed(1)}mm`
                    : `${report.maxDiffMm.toFixed(2)}mm`;
                  const fontSizeMm = Math.max(24, 10 / pxPerMm);
                  return (
                    <g
                      key={`parity_3d_${f.id}`}
                      data-testid={`parity-3d-${f.id}`}
                      data-parity-mismatch={report.hasMismatch ? 'true' : 'false'}
                      data-parity-diff-mm={report.maxDiffMm.toFixed(3)}
                    >
                      <polygon
                        points={report.hull2d.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                        fill="none"
                        stroke={repCol}
                        strokeWidth={Math.max(4, 1.05 / pxPerMm)}
                        strokeDasharray={`${8 / pxPerMm} ${5 / pxPerMm}`}
                        strokeOpacity={0.85}
                      />
                      <polygon
                        points={report.hull3d.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                        fill={strokeCol}
                        fillOpacity={report.hasMismatch ? 0.14 : 0.06}
                        stroke={strokeCol}
                        strokeWidth={Math.max(5, 1.45 / pxPerMm)}
                        strokeOpacity={0.95}
                      />
                      <text
                        x={report.bounds3d.minX}
                        y={report.bounds3d.minY - fontSizeMm * 0.35}
                        fontSize={fontSizeMm}
                        fontWeight={report.hasMismatch ? 700 : 600}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        fill={strokeCol}
                      >
                        {labelText}
                      </text>
                    </g>
                  );
                })}
            </g>
          )}

          {/* 6. Walls — Two-pass union so 2-wall corners connect seamlessly without inner edge seams */}
          {level.layers.walls &&
            (() => {
              let renderWallsList = level.walls;
              if (snapTweenOffset && snapTweenOffset.targetKey.startsWith('wall_body:')) {
                const wId = snapTweenOffset.targetKey.slice('wall_body:'.length);
                renderWallsList = level.walls.map((w) =>
                  w.id === wId
                    ? {
                        ...w,
                        start: { x: w.start.x + snapTweenOffset.dx, y: w.start.y + snapTweenOffset.dy },
                        end: { x: w.end.x + snapTweenOffset.dx, y: w.end.y + snapTweenOffset.dy },
                      }
                    : w
                );
              } else if (snapTweenOffset && snapTweenOffset.targetKey.startsWith('wall_vertex:')) {
                const rest = snapTweenOffset.targetKey.slice('wall_vertex:'.length);
                const lastColon = rest.lastIndexOf(':');
                const wId = rest.slice(0, lastColon);
                const ep = rest.slice(lastColon + 1) as 'start' | 'end';
                const linkedList =
                  dragState?.kind === 'wall_vertex' && dragState.wallId === wId
                    ? dragState.linkedEndpoints
                    : [];
                const linkedMap = new Map(linkedList.map((l) => [l.wallId, l.endpoint]));
                renderWallsList = level.walls.map((w) => {
                  if (w.id === wId) {
                    return {
                      ...w,
                      [ep]: { x: w[ep].x + snapTweenOffset.dx, y: w[ep].y + snapTweenOffset.dy },
                    };
                  }
                  const lep = linkedMap.get(w.id);
                  if (lep) {
                    return {
                      ...w,
                      [lep]: { x: w[lep].x + snapTweenOffset.dx, y: w[lep].y + snapTweenOffset.dy },
                    };
                  }
                  return w;
                });
              }

              const wallItems = renderWallsList
                .filter((w) => w.visible)
                .map((wall) => ({ wall, poly: computeWallPolygon(wall, renderWallsList) }))
                .filter((item) => item.poly.length >= 3);

              const outerContourColor = isBw ? '#0F172A' : settings.darkMode ? '#94A3B8' : '#0F172A';
              const sleekOutlineW = 1.05 / pxPerMm;

              return (
                <g data-testid="walls-layer">
                  {/* Pass 1: Continuous outer perimeter stroke (double width; inner half gets masked by Pass 2) */}
                  {wallItems.map(({ wall, poly }) => (
                    <polygon
                      key={`w_stroke_${wall.id}`}
                      points={poly.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={outerContourColor}
                      strokeWidth={sleekOutlineW * 2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      className="pointer-events-none"
                    />
                  ))}

                  {/* Pass 2: Seamless interior fill (covers internal corner/miter joints so walls merge cleanly) */}
                  {wallItems.map(({ wall, poly }) => {
                    const ptsStr = poly.map((p) => `${p.x},${p.y}`).join(' ');
                    const wallFill = isBw
                      ? '#FFFFFF'
                      : wall.innerColor !== '#FFFFFF'
                        ? wall.innerColor
                        : settings.darkMode
                          ? '#1E293B'
                          : '#FFFFFF';
                    const wallSelected = isSelected('wall', wall.id);
                    return (
                      <polygon
                        key={`w_fill_${wall.id}`}
                        data-ctx-kind="wall"
                        data-ctx-id={wall.id}
                        points={ptsStr}
                        fill={wallFill}
                        stroke={wallFill}
                        strokeWidth={0.25 / pxPerMm}
                        strokeLinejoin="round"
                        onPointerDown={(e) => {
                          if (e.button === 1) return;
                          const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
                          const alreadySelected = isSelected('wall', wall.id);
                          handleElementSelect(e, { kind: 'wall', id: wall.id }, wall.innerColor);
                          if (alreadySelected && !isMultiMod && activeTool === 'select' && !wall.locked && e.button === 0) {
                            const origWall = level.walls.find((w) => w.id === wall.id) ?? wall;
                            snapHysteresisRef.current = {};
                            clearSnapTween();
                            setCursorHint(null);
                            dragMutatedRef.current = false;
                            setDragState({
                              kind: 'wall_body',
                              wallId: wall.id,
                              startWorld: screenToWorld(e.clientX, e.clientY),
                              origStart: { ...origWall.start },
                              origEnd: { ...origWall.end },
                              startClient: { x: e.clientX, y: e.clientY },
                              label: 'Move Wall',
                            });
                          }
                        }}
                        className={wallSelected && !wall.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                      />
                    );
                  })}

                  {/* Pass 2b (B&W architectural print mode): Continuous diagonal poché hatch over merged white wall cores */}
                  {isBw &&
                    wallItems.map(({ wall, poly }) => (
                      <polygon
                        key={`w_bw_hatch_${wall.id}`}
                        points={poly.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="url(#bw_wall_hatch)"
                        stroke="none"
                        className="pointer-events-none"
                      />
                    ))}

                  {/* Pass 2.5: Chimneys union cleanly after wall Pass 2 so wall border strokes never bisect touching faces */}
                  {level.layers.archElements &&
                    level.archElements
                      .filter((el) => el.visible && el.type === 'chimney')
                      .map((el) => {
                        const selected = isSelected('arch', el.id);
                        const isDimHovered =
                          hoveredCompId === el.id ||
                          hoveredDimKey === `comp:${el.id}` ||
                          hoveredDimKey === `width:${el.id}`;
                        const sw = (selected ? 2 : isDimHovered ? 1.8 : 1.05) / pxPerMm;
                        const hostWall = el.attachedWallId
                          ? level.walls.find((w) => w.id === el.attachedWallId)
                          : undefined;
                        const attachFace = el.attachedFace ?? 'left';
                        const hw = el.widthMm / 2;
                        const hd = el.depthMm / 2;
                        const contourColor = selected
                          ? '#2563EB'
                          : isDimHovered
                            ? '#0EA5E9'
                            : outerContourColor;
                        const chimneyFill = isBw
                          ? 'url(#bw_wall_hatch)'
                          : el.color !== '#FFFFFF'
                            ? el.color
                            : settings.darkMode
                              ? '#1E293B'
                              : '#FFFFFF';

                        const touching = getChimneyTouchingEdges(el, level.walls);
                        const seamPad = Math.max(1.5, 0.7 / pxPerMm);
                        const x1 = touching.left ? -hw - seamPad : -hw;
                        const x2 = touching.right ? hw + seamPad : hw;
                        const y1 = touching.top ? -hd - seamPad : -hd;
                        const y2 = touching.bottom ? hd + seamPad : hd;
                        const frontEdgeY = attachFace === 'left' ? hd : -hd;

                        const chimTweenOff =
                          snapTweenOffset && snapTweenOffset.targetKey === `arch:${el.id}`
                            ? snapTweenOffset
                            : null;

                        return (
                          <g
                            key={el.id}
                            data-ctx-kind="arch"
                            data-ctx-id={el.id}
                            transform={`translate(${el.xMm + (chimTweenOff ? chimTweenOff.dx : 0)}, ${el.yMm + (chimTweenOff ? chimTweenOff.dy : 0)}) rotate(${el.rotationDeg})`}
                            onPointerEnter={() => setHoveredCompId(el.id)}
                            onPointerLeave={() =>
                              setHoveredCompId((cur) => (cur === el.id ? null : cur))
                            }
                            onPointerDown={(e) => {
                              const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
                              const alreadySelected = isSelected('arch', el.id);
                              handleElementSelect(e, { kind: 'arch', id: el.id }, el.color);
                              if (
                                alreadySelected &&
                                !isMultiMod &&
                                activeTool === 'select' &&
                                !el.locked &&
                                e.button === 0
                              ) {
                                const w = screenToWorld(e.clientX, e.clientY);
                                snapHysteresisRef.current = {};
                                clearSnapTween();
                                setCursorHint(null);
                                dragMutatedRef.current = false;
                                setDragState({
                                  kind: 'arch',
                                  id: el.id,
                                  offsetMm: { x: w.x - el.xMm, y: w.y - el.yMm },
                                  startClient: { x: e.clientX, y: e.clientY },
                                  label: `Move ${el.name}`,
                                });
                              }
                            }}
                            className={
                              selected && !el.locked && activeTool === 'select'
                                ? 'cursor-move'
                                : 'cursor-pointer'
                            }
                          >
                            {/* Fill extends slightly on touching edges to erase Pass 1's outward wall contour */}
                            {isBw && (
                              <rect
                                x={x1}
                                y={y1}
                                width={x2 - x1}
                                height={y2 - y1}
                                fill="#FFFFFF"
                              />
                            )}
                            <rect
                              x={x1}
                              y={y1}
                              width={x2 - x1}
                              height={y2 - y1}
                              fill={chimneyFill}
                            />
                            {/* Per-face deterministic color edge bands (hidden in B&W architectural print mode) */}
                            {!isBw && (() => {
                              const fc = resolveChimneyFaceColors(el);
                              const bandW = Math.max(16, Math.min(44, Math.min(el.widthMm, el.depthMm) * 0.14));
                              return (
                                <g className="pointer-events-none">
                                  <rect x={-hw} y={-hd} width={el.widthMm} height={bandW} fill={fc.back} />
                                  <rect x={-hw} y={hd - bandW} width={el.widthMm} height={bandW} fill={fc.front} />
                                  <rect x={-hw} y={-hd} width={bandW} height={el.depthMm} fill={fc.left} />
                                  <rect x={hw - bandW} y={-hd} width={bandW} height={el.depthMm} fill={fc.right} />
                                </g>
                              );
                            })()}
                            {/* Draw perimeter line ONLY on exposed edges NOT touching a wall */}
                            {!touching.top && (
                              <line
                                x1={-hw}
                                y1={-hd}
                                x2={hw}
                                y2={-hd}
                                stroke={contourColor}
                                strokeWidth={sw}
                                strokeLinecap="square"
                              />
                            )}
                            {!touching.bottom && (
                              <line
                                x1={-hw}
                                y1={hd}
                                x2={hw}
                                y2={hd}
                                stroke={contourColor}
                                strokeWidth={sw}
                                strokeLinecap="square"
                              />
                            )}
                            {!touching.left && (
                              <line
                                x1={-hw}
                                y1={-hd}
                                x2={-hw}
                                y2={hd}
                                stroke={contourColor}
                                strokeWidth={sw}
                                strokeLinecap="square"
                              />
                            )}
                            {!touching.right && (
                              <line
                                x1={hw}
                                y1={-hd}
                                x2={hw}
                                y2={hd}
                                stroke={contourColor}
                                strokeWidth={sw}
                                strokeLinecap="square"
                              />
                            )}
                            {/* Width & Depth resize handles on exposed edges when selected */}
                            {hostWall &&
                              selected &&
                              !el.locked &&
                              activeTool === 'select' && (
                                <>
                                  {!hostWall.locked &&
                                    (['left', 'right'] as const)
                                      .filter((edge) =>
                                        edge === 'left' ? !touching.left : !touching.right
                                      )
                                      .map((edge) => {
                                        const hx = edge === 'left' ? -hw : hw;
                                        const gw = 8 / pxPerMm;
                                        const gh = 20 / pxPerMm;
                                        const hitW = 24 / pxPerMm;
                                        const hitH = 26 / pxPerMm;
                                        return (
                                          <g
                                            key={edge}
                                            onPointerDown={(e) => {
                                              if (e.button !== 0) return;
                                              e.stopPropagation();
                                              dragMutatedRef.current = false;
                                              setDragState({
                                                kind: 'comp_edge',
                                                compId: el.id,
                                                compKind: 'chimney',
                                                wallId: hostWall.id,
                                                edge,
                                                startClient: { x: e.clientX, y: e.clientY },
                                                label: `Resize ${el.name}`,
                                              });
                                            }}
                                            style={{ cursor: 'ew-resize' }}
                                          >
                                            <rect
                                              x={hx - hitW / 2}
                                              y={-hitH / 2}
                                              width={hitW}
                                              height={hitH}
                                              fill="transparent"
                                            />
                                            <rect
                                              x={hx - gw / 2}
                                              y={-gh / 2}
                                              width={gw}
                                              height={gh}
                                              rx={gw * 0.3}
                                              fill="#FFFFFF"
                                              stroke="#2563EB"
                                              strokeWidth={1.6 / pxPerMm}
                                            />
                                          </g>
                                        );
                                      })}
                                  {/* Depth resize handle on front exposed face */}
                                  <g
                                    onPointerDown={(e) => {
                                      if (e.button !== 0) return;
                                      e.stopPropagation();
                                      dragMutatedRef.current = false;
                                      setDragState({
                                        kind: 'chimney_depth',
                                        compId: el.id,
                                        wallId: hostWall.id,
                                        startClient: { x: e.clientX, y: e.clientY },
                                        label: `Resize ${el.name} Depth`,
                                      });
                                    }}
                                    style={{ cursor: 'ns-resize' }}
                                  >
                                    {(() => {
                                      const dw = 22 / pxPerMm;
                                      const dh = 8 / pxPerMm;
                                      const hitW = 26 / pxPerMm;
                                      const hitH = 24 / pxPerMm;
                                      return (
                                        <>
                                          <rect
                                            x={-hitW / 2}
                                            y={frontEdgeY - hitH / 2}
                                            width={hitW}
                                            height={hitH}
                                            fill="transparent"
                                          />
                                          <rect
                                            x={-dw / 2}
                                            y={frontEdgeY - dh / 2}
                                            width={dw}
                                            height={dh}
                                            rx={dh * 0.3}
                                            fill="#FFFFFF"
                                            stroke="#2563EB"
                                            strokeWidth={1.6 / pxPerMm}
                                          />
                                        </>
                                      );
                                    })()}
                                  </g>
                                </>
                              )}
                          </g>
                        );
                      })}

                  {/* Pass 3: Selection highlight, distinct face accents, dimensions, and vertex handles */}
                  {wallItems.map(({ wall, poly }) => {
                    const selected = isSelected('wall', wall.id);
                    const ptsStr = poly.map((p) => `${p.x},${p.y}`).join(' ');

                    return (
                      <g key={wall.id}>
                        {selected && (
                          <polygon
                            points={ptsStr}
                            fill="none"
                            stroke="#2563EB"
                            strokeWidth={1.7 / pxPerMm}
                            strokeLinejoin="round"
                            className="pointer-events-none"
                          />
                        )}

                        {!isBw && !wall.isCurved && poly.length === 4 && (() => {
                          const wFaces = resolveWallFaces(wall, level.rooms);
                          const leftColor = wFaces.left.slot === 'inner' ? wall.innerColor : wall.outerColor;
                          const rightColor = wFaces.right.slot === 'inner' ? wall.innerColor : wall.outerColor;
                          return (
                            <>
                              {leftColor !== '#FFFFFF' && (
                                <line
                                  x1={poly[0].x}
                                  y1={poly[0].y}
                                  x2={poly[1].x}
                                  y2={poly[1].y}
                                  stroke={leftColor}
                                  strokeWidth={1.45 / pxPerMm}
                                  className="pointer-events-none"
                                />
                              )}
                              {rightColor !== '#FFFFFF' && (
                                <line
                                  x1={poly[3].x}
                                  y1={poly[3].y}
                                  x2={poly[2].x}
                                  y2={poly[2].y}
                                  stroke={rightColor}
                                  strokeWidth={1.45 / pxPerMm}
                                  className="pointer-events-none"
                                />
                              )}
                            </>
                          );
                        })()}

                        {selected && !wall.isCurved && (() => {
                          const wFaces = resolveWallFaces(wall, level.rooms);
                          const { point: midPt, normal: midN } = getWallCenterlinePoint(wall, 0.5);
                          const { left: offL, right: offR } = wallOffsets(wall.thicknessMm, wall.alignment);
                          const gap = 18 / pxPerMm;
                          const lPt = {
                            x: midPt.x + midN.x * (offL + gap),
                            y: midPt.y + midN.y * (offL + gap),
                          };
                          const rPt = {
                            x: midPt.x + midN.x * (offR - gap),
                            y: midPt.y + midN.y * (offR - gap),
                          };
                          const renderBadge = (
                            pt: Point2D,
                            label: string,
                            isPrimary: boolean
                          ) => (
                            <g transform={`translate(${pt.x}, ${pt.y})`} className="pointer-events-none">
                              <rect
                                x={-(label.length * 3.4 + 8) / pxPerMm}
                                y={-7.5 / pxPerMm}
                                width={(label.length * 6.8 + 16) / pxPerMm}
                                height={15 / pxPerMm}
                                rx={3 / pxPerMm}
                                fill={isPrimary ? '#2563EB' : '#475569'}
                                fillOpacity={0.9}
                              />
                              <text
                                x={0}
                                y={3 / pxPerMm}
                                textAnchor="middle"
                                fontSize={9 / pxPerMm}
                                fontFamily="Inter, sans-serif"
                                fontWeight={600}
                                fill="#FFFFFF"
                              >
                                {label}
                              </text>
                            </g>
                          );
                          return (
                            <>
                              {renderBadge(lPt, wFaces.left.label, wFaces.left.id === wFaces.primary.id && wFaces.left.physicalSide === wFaces.primary.physicalSide)}
                              {renderBadge(rPt, wFaces.right.label, wFaces.right.id === wFaces.primary.id && wFaces.right.physicalSide === wFaces.primary.physicalSide)}
                            </>
                          );
                        })()}

                        {/* Hover highlight when dimension segment on this wall is hovered */}
                        {hoveredDimKey && (() => {
                          const chain = buildWallDimensionChain(wall, level.walls, level.openings, level.archElements);
                          const seg = chain.segments.find((s) => s.key === hoveredDimKey);
                          if (!seg || seg.kind !== 'wall_gap') return null;
                          const len = Math.max(1, getWallArcLength(wall));
                          const pA = getWallCenterlinePoint(wall, seg.startS / len).point;
                          const pB = getWallCenterlinePoint(wall, seg.endS / len).point;
                          return (
                            <line
                              x1={pA.x}
                              y1={pA.y}
                              x2={pB.x}
                              y2={pB.y}
                              stroke="#0EA5E9"
                              strokeOpacity={0.35}
                              strokeWidth={wall.thicknessMm * 0.9}
                              className="pointer-events-none"
                            />
                          );
                        })()}

                        {selected && !wall.locked && (
                          <>
                            {(['start', 'end'] as const).map((ep) => {
                              const origWall = level.walls.find((w) => w.id === wall.id) ?? wall;
                              const origPt = ep === 'start' ? origWall.start : origWall.end;
                              const pt = ep === 'start' ? wall.start : wall.end;
                              const linked = findConnectedWallEndpoints(
                                level.walls,
                                origPt,
                                8,
                                new Set([wall.id])
                              );
                              const isConnected = linked.length > 0;
                              return (
                                <g
                                  key={ep}
                                  className="cursor-pointer"
                                  onPointerDown={(e) => {
                                    if (e.button === 1) return;
                                    e.stopPropagation();
                                    const detachSingle = e.altKey;
                                    if (!detachSingle && linked.some((l) => level.walls.find((w) => w.id === l.wallId)?.locked)) {
                                      onConstraintError?.('Connected neighbor wall is locked — hold Alt while dragging to detach this wall.');
                                      return;
                                    }
                                    dragMutatedRef.current = false;
                                    setDragState({
                                      kind: 'wall_vertex',
                                      wallId: wall.id,
                                      end: ep,
                                      origPoint: { ...pt },
                                      startClient: { x: e.clientX, y: e.clientY },
                                      detachSingle,
                                      linkedEndpoints: detachSingle
                                        ? []
                                        : linked.map((l) => ({ wallId: l.wallId, endpoint: l.endpoint })),
                                      label: detachSingle ? 'Detach Wall Endpoint' : 'Move Corner',
                                    });
                                  }}
                                >
                                  <title>
                                    {isConnected
                                      ? `Connected Corner (${linked.length + 1} walls) · Drag to reshape room · Hold Alt to detach`
                                      : 'Open Wall Endpoint · Drag near another corner to connect'}
                                  </title>
                                  <circle cx={pt.x} cy={pt.y} r={12 / pxPerMm} fill="transparent" />
                                  <circle
                                    cx={pt.x}
                                    cy={pt.y}
                                    r={6.5 / pxPerMm}
                                    fill={isConnected ? '#EFF6FF' : '#FFFBEB'}
                                    stroke={isConnected ? '#2563EB' : '#F59E0B'}
                                    strokeWidth={1.8 / pxPerMm}
                                  />
                                </g>
                              );
                            })}
                          </>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* 7. Openings */}
          {level.layers.openings && level.openings.map((op) => op.visible && renderOpening2D(op))}

          {/* 8. Curtains & Blinds */}
          {level.layers.curtains &&
            level.curtains.map((c: Curtain) => {
              if (!c.visible) return null;
              const selected = isSelected('curtain', c.id);
              const closedFraction = 1 - c.openPercent / 100;
              const wingW = Math.max(120, (c.widthMm / 2) * closedFraction);
              return (
                <g
                  key={c.id}
                  data-ctx-kind="curtain"
                  data-ctx-id={c.id}
                  transform={`translate(${c.xMm}, ${c.yMm}) rotate(${c.rotationDeg})`}
                  onPointerDown={(e) => {
                    const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
                    const alreadySelected = isSelected('curtain', c.id);
                    handleElementSelect(e, { kind: 'curtain', id: c.id }, c.color);
                    if (alreadySelected && !isMultiMod && activeTool === 'select' && !c.locked && e.button === 0) {
                      const w = screenToWorld(e.clientX, e.clientY);
                      dragMutatedRef.current = false;
                      setDragState({
                        kind: 'curtain',
                        id: c.id,
                        offsetMm: { x: w.x - c.xMm, y: w.y - c.yMm },
                        startClient: { x: e.clientX, y: e.clientY },
                        label: `Move ${c.name}`,
                      });
                    }
                  }}
                  className={selected && !c.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                >
                  <line
                    x1={-c.widthMm / 2}
                    y1={0}
                    x2={c.widthMm / 2}
                    y2={0}
                    stroke={selected ? '#2563EB' : isBw ? '#0F172A' : c.rodColor}
                    strokeWidth={24}
                  />
                  {c.style === 'blinds' || c.style === 'roller_shade' ? (
                    <rect
                      x={-c.widthMm / 2}
                      y={-35}
                      width={c.widthMm}
                      height={70}
                      fill={isBw ? 'none' : c.color}
                      stroke={selected ? '#2563EB' : isBw ? '#0F172A' : '#475569'}
                      strokeWidth={Math.max(4, 1 / pxPerMm)}
                    />
                  ) : (
                    <>
                      <path
                        d={`M ${-c.widthMm / 2} -45 Q ${-c.widthMm / 2 + wingW / 2} 55 ${
                          -c.widthMm / 2 + wingW
                        } -45 L ${-c.widthMm / 2 + wingW} 45 Q ${-c.widthMm / 2 + wingW / 2} -25 ${
                          -c.widthMm / 2
                        } 45 Z`}
                        fill={isBw ? 'none' : c.color}
                        fillOpacity={isBw ? 0 : 0.35}
                        stroke={selected ? '#2563EB' : isBw ? '#0F172A' : '#475569'}
                        strokeWidth={Math.max(4, 1 / pxPerMm)}
                      />
                      <path
                        d={`M ${c.widthMm / 2 - wingW} -45 Q ${c.widthMm / 2 - wingW / 2} 55 ${
                          c.widthMm / 2
                        } -45 L ${c.widthMm / 2} 45 Q ${c.widthMm / 2 - wingW / 2} -25 ${
                          c.widthMm / 2 - wingW
                        } 45 Z`}
                        fill={isBw ? 'none' : c.color}
                        fillOpacity={isBw ? 0 : 0.35}
                        stroke={selected ? '#2563EB' : isBw ? '#0F172A' : '#475569'}
                        strokeWidth={Math.max(4, 1 / pxPerMm)}
                      />
                    </>
                  )}
                </g>
              );
            })}

          {/* 9. People Silhouettes */}
          {level.layers.people &&
            level.people.map((person: PersonInstance) => {
              if (!person.visible) return null;
              const selected = isSelected('person', person.id);
              const scale = person.heightMm / 1750;
              const isLying = person.pose === 'lying_back' || person.pose === 'lying_side';
              const strokeCol = selected ? '#2563EB' : isBw ? '#0F172A' : settings.darkMode ? '#CBD5E1' : '#334155';
              const bodyFill = isBw ? 'none' : person.color !== '#FFFFFF' ? person.color : '#E2E8F0';
              return (
                <g
                  key={person.id}
                  data-ctx-kind="person"
                  data-ctx-id={person.id}
                  transform={`translate(${person.xMm}, ${person.yMm}) rotate(${person.rotationDeg}) scale(${scale})`}
                  onPointerDown={(e) => {
                    const isMultiMod = e.ctrlKey || e.metaKey || e.shiftKey;
                    const alreadySelected = isSelected('person', person.id);
                    handleElementSelect(e, { kind: 'person', id: person.id }, person.color);
                    if (alreadySelected && !isMultiMod && activeTool === 'select' && !person.locked && e.button === 0) {
                      const w = screenToWorld(e.clientX, e.clientY);
                      dragMutatedRef.current = false;
                      setDragState({
                        kind: 'person',
                        id: person.id,
                        offsetMm: { x: w.x - person.xMm, y: w.y - person.yMm },
                        startClient: { x: e.clientX, y: e.clientY },
                        label: `Move ${person.name}`,
                      });
                    }
                  }}
                  className={selected && !person.locked && activeTool === 'select' ? 'cursor-move' : 'cursor-pointer'}
                >
                  {isLying ? (
                    <g>
                      {/* Full horizontal lying figure top-down plan silhouette (head at -Y, feet at +Y) */}
                      <rect
                        x={person.pose === 'lying_side' ? -190 : -220}
                        y={-520}
                        width={person.pose === 'lying_side' ? 380 : 440}
                        height={620}
                        rx={140}
                        fill={bodyFill}
                        stroke={strokeCol}
                        strokeWidth={1.5 / pxPerMm}
                      />
                      {person.pose === 'lying_side' ? (
                        <>
                          {/* Slightly bent knees on side sleeping pose */}
                          <path
                            d="M-90,70 L-160,440 L-100,800 L40,800 L-10,430 L110,70 Z"
                            fill={bodyFill}
                            stroke={strokeCol}
                            strokeWidth={1.4 / pxPerMm}
                          />
                          <circle cx={-35} cy={-660} r={105} fill={bodyFill} stroke={strokeCol} strokeWidth={1.4 / pxPerMm} />
                        </>
                      ) : (
                        <>
                          {/* Left & right supine legs + feet */}
                          <rect x={-165} y={80} width={145} height={740} rx={65} fill={bodyFill} stroke={strokeCol} strokeWidth={1.3 / pxPerMm} />
                          <rect x={20} y={80} width={145} height={740} rx={65} fill={bodyFill} stroke={strokeCol} strokeWidth={1.3 / pxPerMm} />
                          <circle cx={0} cy={-660} r={108} fill={bodyFill} stroke={strokeCol} strokeWidth={1.4 / pxPerMm} />
                        </>
                      )}
                    </g>
                  ) : (
                    <g>
                      {/* Stride foot hints for walking figure */}
                      {person.pose === 'walking' && (
                        <>
                          <ellipse cx={-75} cy={-115} rx={48} ry={75} fill={isBw ? 'none' : '#475569'} stroke={strokeCol} strokeWidth={1 / pxPerMm} />
                          <ellipse cx={75} cy={125} rx={48} ry={75} fill={isBw ? 'none' : '#475569'} stroke={strokeCol} strokeWidth={1 / pxPerMm} />
                        </>
                      )}
                      {/* Top-down architectural shoulder/head silhouette */}
                      <ellipse
                        cx={0}
                        cy={0}
                        rx={230}
                        ry={person.pose === 'seated' ? 145 : 112}
                        fill={bodyFill}
                        stroke={strokeCol}
                        strokeWidth={1.6 / pxPerMm}
                      />
                      <circle cx={0} cy={12} r={92} fill={bodyFill} stroke={strokeCol} strokeWidth={1.2 / pxPerMm} />
                      <path
                        d="M-55,-20 Q0,-85 55,-20"
                        fill="none"
                        stroke={strokeCol}
                        strokeWidth={1.2 / pxPerMm}
                      />
                      {/* Facing nose marker */}
                      <polygon
                        points="-24,104 24,104 0,146"
                        fill={isBw ? 'none' : strokeCol}
                        stroke={isBw ? strokeCol : 'none'}
                        strokeWidth={isBw ? 1.1 / pxPerMm : 0}
                      />
                    </g>
                  )}
                </g>
              );
            })}

          {/* 10. Measurements */}
          {level.layers.measurements &&
            level.measurements.map((m) => {
              const selected = isSelected('measurement', m.id);
              const measStroke = selected ? '#1D4ED8' : isBw ? '#334155' : '#2563EB';
              if (m.kind === 'distance') {
                const d = dist(m.start, m.end);
                const mid = lerpPoint(m.start, m.end, 0.5);
                return (
                  <g
                    key={m.id}
                    onPointerDown={(e) => handleElementSelect(e, { kind: 'measurement', id: m.id })}
                    className="cursor-pointer"
                  >
                    <line
                      x1={m.start.x}
                      y1={m.start.y}
                      x2={m.end.x}
                      y2={m.end.y}
                      stroke={measStroke}
                      strokeWidth={1.8 / pxPerMm}
                    />
                    <circle cx={m.start.x} cy={m.start.y} r={4 / pxPerMm} fill={measStroke} />
                    <circle cx={m.end.x} cy={m.end.y} r={4 / pxPerMm} fill={measStroke} />
                    <g transform={`translate(${mid.x}, ${mid.y}) rotate(${-viewRotationDeg})`}>
                      <rect
                        x={-360}
                        y={-105}
                        width={720}
                        height={210}
                        rx={40}
                        fill={isBw && !selected ? '#FFFFFF' : '#2563EB'}
                        stroke={isBw && !selected ? '#0F172A' : 'none'}
                        strokeWidth={isBw && !selected ? 1.1 / pxPerMm : 0}
                      />
                      <text
                        x={0}
                        y={45}
                        textAnchor="middle"
                        fontSize={125}
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight={600}
                        fill={isBw && !selected ? '#0F172A' : '#FFFFFF'}
                      >
                        {formatSmartMetric(d)}
                      </text>
                    </g>
                  </g>
                );
              }
              const area = computePolygonAreaM2(m.points);
              const c = polygonCentroid(m.points);
              return (
                <g
                  key={m.id}
                  onPointerDown={(e) => handleElementSelect(e, { kind: 'measurement', id: m.id })}
                  className="cursor-pointer"
                >
                  <polygon
                    points={m.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill={isBw ? 'none' : 'rgba(37, 99, 235, 0.12)'}
                    stroke={measStroke}
                    strokeDasharray="60 40"
                    strokeWidth={1.6 / pxPerMm}
                  />
                  <text
                    x={0}
                    y={0}
                    transform={`translate(${c.x}, ${c.y}) rotate(${-viewRotationDeg})`}
                    textAnchor="middle"
                    fontSize={140}
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight={600}
                    fill={selected ? '#1D4ED8' : isBw ? '#0F172A' : '#1D4ED8'}
                  >
                    {formatAreaM2(area)}
                  </text>
                </g>
              );
            })}

          {/* 10b. Room Name Labels (no always-shown area values — use Area Finder tool!) */}
          {level.layers.rooms &&
            level.rooms.map((room) => {
              if (!room.visible || room.polygon.length < 3) return null;
              const center = polygonCentroid(room.polygon);
              const haloColor = !isBw && settings.darkMode ? 'rgba(15,23,42,0.88)' : 'rgba(255,255,255,0.92)';
              return (
                <g
                  key={`lbl_${room.id}`}
                  transform={`translate(${center.x}, ${center.y}) rotate(${-viewRotationDeg})`}
                  className="pointer-events-none select-none"
                >
                  <text
                    x={0}
                    y={45}
                    textAnchor="middle"
                    fontSize={155}
                    fontWeight={600}
                    fill={!isBw && settings.darkMode ? '#F8FAFC' : '#0F172A'}
                    stroke={haloColor}
                    strokeWidth={70}
                    strokeLinejoin="round"
                    style={{ paintOrder: 'stroke' }}
                  >
                    {room.name}
                  </text>
                </g>
              );
            })}

          {/* 10c. Active Transient Distance Result (dismisses cleanly on Done) */}
          {activeDistanceResult && (
            <g className="pointer-events-none">
              <line
                x1={activeDistanceResult.start.x}
                y1={activeDistanceResult.start.y}
                x2={activeDistanceResult.end.x}
                y2={activeDistanceResult.end.y}
                stroke="#2563EB"
                strokeWidth={2.4 / pxPerMm}
              />
              <circle cx={activeDistanceResult.start.x} cy={activeDistanceResult.start.y} r={5.5 / pxPerMm} fill="#10B981" stroke="#FFFFFF" strokeWidth={1.5 / pxPerMm} />
              <circle cx={activeDistanceResult.end.x} cy={activeDistanceResult.end.y} r={5.5 / pxPerMm} fill="#10B981" stroke="#FFFFFF" strokeWidth={1.5 / pxPerMm} />
              {(() => {
                const mid = lerpPoint(activeDistanceResult.start, activeDistanceResult.end, 0.5);
                const d = dist(activeDistanceResult.start, activeDistanceResult.end);
                return (
                  <g transform={`translate(${mid.x}, ${mid.y}) rotate(${-viewRotationDeg})`}>
                    <rect x={-370} y={-110} width={740} height={220} rx={48} fill="#2563EB" />
                    <text
                      textAnchor="middle"
                      dy={45}
                      fontSize={130}
                      fontFamily="JetBrains Mono, monospace"
                      fontWeight={700}
                      fill="#FFFFFF"
                    >
                      {formatSmartMetric(d)}
                    </text>
                  </g>
                );
              })()}
            </g>
          )}

          {/* 10d. Active Transient Area Finder Result (dismisses cleanly on Done) */}
          {activeAreaResult && activeAreaResult.points.length >= 3 && (
            <g className="pointer-events-none">
              <polygon
                points={activeAreaResult.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="rgba(37, 99, 235, 0.14)"
                stroke="#2563EB"
                strokeWidth={2.4 / pxPerMm}
              />
              {activeAreaResult.points.map((pt, i) => (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={4.5 / pxPerMm}
                  fill="#10B981"
                  stroke="#FFFFFF"
                  strokeWidth={1.2 / pxPerMm}
                />
              ))}
              {(() => {
                const c = polygonCentroid(activeAreaResult.points);
                return (
                  <g transform={`translate(${c.x}, ${c.y}) rotate(${-viewRotationDeg})`}>
                    <rect x={-520} y={-180} width={1040} height={360} rx={56} fill="#1D4ED8" />
                    <text
                      y={-20}
                      textAnchor="middle"
                      fontSize={145}
                      fontFamily="JetBrains Mono, monospace"
                      fontWeight={700}
                      fill="#FFFFFF"
                    >
                      {formatAreaM2(activeAreaResult.areaM2)}
                    </text>
                    <text
                      y={115}
                      textAnchor="middle"
                      fontSize={105}
                      fontFamily="JetBrains Mono, monospace"
                      fontWeight={500}
                      fill="#DBEAFE"
                    >
                      Perim {activeAreaResult.perimeterM.toFixed(2)} m
                    </text>
                  </g>
                );
              })()}
            </g>
          )}

          {/* 11. Annotations */}
          {level.layers.annotations &&
            level.annotations.map((n) => {
              const selected = isSelected('annotation', n.id);
              return (
                <g
                  key={n.id}
                  onPointerDown={(e) => handleElementSelect(e, { kind: 'annotation', id: n.id }, n.color)}
                  className="cursor-pointer"
                >
                  {n.kind === 'arrow' && n.endXMm !== undefined && n.endYMm !== undefined && (
                    <line
                      x1={n.xMm}
                      y1={n.yMm}
                      x2={n.endXMm}
                      y2={n.endYMm}
                      stroke={selected ? '#1D4ED8' : isBw ? '#0F172A' : n.color}
                      strokeWidth={2 / pxPerMm}
                      markerEnd="url(#arrow_head)"
                    />
                  )}
                  <text
                    x={0}
                    y={-40}
                    transform={`translate(${n.xMm}, ${n.yMm}) rotate(${-viewRotationDeg})`}
                    fontSize={n.fontSizeMm}
                    fontWeight={500}
                    fill={selected ? '#2563EB' : isBw ? '#0F172A' : n.color}
                  >
                    {n.text}
                  </text>
                </g>
              );
            })}

          {/* 12. Cut-Through Section Line */}
          {level.sectionLine && level.sectionLine.active && (
            <g>
              <line
                x1={level.sectionLine.start.x}
                y1={level.sectionLine.start.y}
                x2={level.sectionLine.end.x}
                y2={level.sectionLine.end.y}
                stroke="#DC2626"
                strokeDasharray="160 80 35 80"
                strokeWidth={2.2 / pxPerMm}
              />
              {(['start', 'end'] as const).map((end) => {
                const pt = end === 'start' ? level.sectionLine!.start : level.sectionLine!.end;
                return (
                  <g
                    key={end}
                    transform={`translate(${pt.x}, ${pt.y})`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      dragMutatedRef.current = false;
                      setDragState({
                        kind: 'section_end',
                        end,
                        startClient: { x: e.clientX, y: e.clientY },
                        label: 'Move Section Line',
                      });
                    }}
                    className="cursor-pointer"
                  >
                    <circle r={13 / pxPerMm} fill="transparent" />
                    <circle r={11 / pxPerMm} fill="#DC2626" />
                    <text
                      transform={viewRotationDeg ? `rotate(${-viewRotationDeg})` : undefined}
                      textAnchor="middle"
                      dy={3.8 / pxPerMm}
                      fontSize={10 / pxPerMm}
                      fontWeight={700}
                      fill="#FFFFFF"
                    >
                      {end === 'start' ? 'A' : "A'"}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* 13. Live Rubber-Band Drafting Previews */}
          {activeTool === 'railing' && railingDraftPts.length > 0 && (
            <g className="pointer-events-none">
              <polyline
                points={[
                  ...railingDraftPts.map((n) => `${n.xMm},${n.yMm}`),
                  ...(hoverWorld ? [`${hoverWorld.x},${hoverWorld.y}`] : []),
                ].join(' ')}
                fill="none"
                stroke="#0284C7"
                strokeWidth={50}
                strokeOpacity={0.3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={[
                  ...railingDraftPts.map((n) => `${n.xMm},${n.yMm}`),
                  ...(hoverWorld ? [`${hoverWorld.x},${hoverWorld.y}`] : []),
                ].join(' ')}
                fill="none"
                stroke="#0284C7"
                strokeWidth={2 / pxPerMm}
                strokeDasharray="60 40"
              />
              {railingDraftPts.map((pt, i) => (
                <circle
                  key={`rdraft_${i}`}
                  cx={pt.xMm}
                  cy={pt.yMm}
                  r={i === 0 && railingDraftPts.length >= 3 ? 9 / pxPerMm : 5.5 / pxPerMm}
                  fill={i === 0 && railingDraftPts.length >= 3 ? 'rgba(16,185,129,0.28)' : '#0284C7'}
                  stroke={i === 0 && railingDraftPts.length >= 3 ? '#10B981' : '#FFFFFF'}
                  strokeWidth={1.6 / pxPerMm}
                />
              ))}
              {hoverWorld && railingDraftPts.length > 0 && (() => {
                const last = railingDraftPts[railingDraftPts.length - 1];
                const segLen = Math.hypot(hoverWorld.x - last.xMm, hoverWorld.y - last.yMm);
                if (segLen < 40) return null;
                const mx = (last.xMm + hoverWorld.x) / 2;
                const my = (last.yMm + hoverWorld.y) / 2 - 200;
                const curElev = railingHoverInfo?.elevationMm ?? 0;
                const elevText = curElev > 0 ? ` · +${Math.round(curElev / 10)}cm` : '';
                return (
                  <g transform={`translate(${mx}, ${my}) rotate(${-viewRotationDeg})`}>
                    <rect x={-520} y={-110} width={1040} height={220} rx={45} fill="#0F172A" />
                    <text
                      textAnchor="middle"
                      dy={45}
                      fontSize={120}
                      fontFamily="JetBrains Mono, monospace"
                      fontWeight={600}
                      fill="#FFFFFF"
                    >
                      {formatSmartMetric(segLen)}
                      {elevText}
                    </text>
                  </g>
                );
              })()}
            </g>
          )}
          {wallPreview && (
            <g className="pointer-events-none">
              <line
                x1={wallPreview.p1.x}
                y1={wallPreview.p1.y}
                x2={wallPreview.p2.x}
                y2={wallPreview.p2.y}
                stroke="#2563EB"
                strokeWidth={160}
                strokeOpacity={0.35}
                strokeLinecap="round"
              />
              <line
                x1={wallPreview.p1.x}
                y1={wallPreview.p1.y}
                x2={wallPreview.p2.x}
                y2={wallPreview.p2.y}
                stroke="#2563EB"
                strokeWidth={2 / pxPerMm}
                strokeDasharray="60 40"
              />
              {wallDraftPts.length >= 2 && (
                <circle
                  cx={wallDraftPts[0].x}
                  cy={wallDraftPts[0].y}
                  r={10 / pxPerMm}
                  fill="rgba(37,99,235,0.2)"
                  stroke="#2563EB"
                  strokeWidth={1.8 / pxPerMm}
                />
              )}
              {wallPreview.isTyped && wallDraftPts.length === 0 && (
                <circle
                  cx={(wallPreview.p1.x + wallPreview.p2.x) / 2}
                  cy={(wallPreview.p1.y + wallPreview.p2.y) / 2}
                  r={6.5 / pxPerMm}
                  fill="#2563EB"
                  stroke="#FFFFFF"
                  strokeWidth={1.8 / pxPerMm}
                />
              )}
              <g transform={`translate(${(wallPreview.p1.x + wallPreview.p2.x) / 2}, ${(wallPreview.p1.y + wallPreview.p2.y) / 2 - 220}) rotate(${-viewRotationDeg})`}>
                <rect x={-460} y={-110} width={920} height={220} rx={45} fill="#0F172A" />
                <text
                  textAnchor="middle"
                  dy={45}
                  fontSize={130}
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight={600}
                  fill="#FFFFFF"
                >
                  {formatSmartMetric(wallPreview.len)} · {wallPreview.angle}°
                </text>
              </g>
            </g>
          )}

          {/* Live Distance / Area Measurement Preview */}
          {measureDraftPts.length > 0 && hoverWorld && (
            <g className="pointer-events-none">
              <polyline
                points={[...measureDraftPts, hoverWorld].map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="#2563EB"
                strokeDasharray="55 35"
                strokeWidth={1.8 / pxPerMm}
              />
              <text
                x={160}
                y={-160}
                transform={`translate(${hoverWorld.x}, ${hoverWorld.y}) rotate(${-viewRotationDeg})`}
                fontSize={140}
                fontFamily="JetBrains Mono, monospace"
                fontWeight={600}
                fill="#2563EB"
              >
                {formatSmartMetric(
                  dist(measureDraftPts[measureDraftPts.length - 1], hoverWorld)
                )}
              </text>
            </g>
          )}

          {/* 12b. Interactive Architectural Dimensions Layer */}
          {(() => {
            // Check if user selected a single wall-mounted component (opening or attached chimney)
            let focusedComp: { wall: Wall; compId: string; kind: 'opening' | 'chimney' } | null = null;
            let focusedWall: Wall | null = null;

            if (selection.length === 1) {
              const sel = selection[0];
              if (sel.kind === 'opening') {
                const op = level.openings.find((o) => o.id === sel.id && o.visible);
                const w = op ? level.walls.find((x) => x.id === op.wallId && x.visible) : undefined;
                if (op && w) focusedComp = { wall: w, compId: op.id, kind: 'opening' };
              } else if (sel.kind === 'arch') {
                const el = level.archElements.find((a) => a.id === sel.id && a.visible);
                const w =
                  el && el.type === 'chimney' && el.attachedWallId
                    ? level.walls.find((x) => x.id === el.attachedWallId && x.visible)
                    : undefined;
                if (el && w) focusedComp = { wall: w, compId: el.id, kind: 'chimney' };
              } else if (sel.kind === 'wall') {
                focusedWall = level.walls.find((x) => x.id === sel.id && x.visible) ?? null;
              }
            }

            if (focusedComp) {
              const w = focusedComp.wall;
              const len = Math.max(1, getWallArcLength(w));
              const chain = buildWallDimensionChain(w, level.walls, level.openings, level.archElements);
              const { target, left, right } = getNonCrossingClearances(
                focusedComp.compId,
                chain.components,
                chain.bounds,
                w.locked
              );
              if (!target) return null;
              const dir = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
              const nrm = { x: -dir.y, y: dir.x };
              const sPt = (s: number, offset: number): Point2D => ({
                x: w.start.x + dir.x * s + nrm.x * offset,
                y: w.start.y + dir.y * s + nrm.y * offset,
              });
              const offObj = w.thicknessMm / 2 + 240;
              const offClear = w.thicknessMm / 2 + 240;
              const openEditor = (
                key: string,
                kind: 'component_width' | 'clearance_left' | 'clearance_right',
                label: string,
                origMm: number,
                midWorld: Point2D
              ) => {
                if (w.locked || target.locked) {
                  onConstraintError?.(w.locked ? 'Host wall is locked.' : `"${target.name}" is locked.`);
                  return;
                }
                const scr = worldToScreen(midWorld);
                setEditingDim({
                  key,
                  kind,
                  wallId: w.id,
                  compId: target.id,
                  label,
                  screenX: scr.x,
                  screenY: scr.y,
                  valueStr: String(Math.round((origMm / 10) * 10) / 10),
                  origValueMm: origMm,
                  error: null,
                });
              };

              return (
                <g data-testid="focused-object-dimensions">
                  {/* Width above/outside object */}
                  {renderArchDimLine({
                    dimKey: `width:${target.id}`,
                    p1: sPt(target.leftS, -offObj),
                    p2: sPt(target.rightS, -offObj),
                    ext1: sPt(target.leftS, -w.thicknessMm / 2),
                    ext2: sPt(target.rightS, -w.thicknessMm / 2),
                    valueMm: target.widthMm,
                    locked: w.locked || target.locked,
                    editable: true,
                    hoverId: target.id,
                    onClickEdit: (midW) =>
                      openEditor(`width:${target.id}`, 'component_width', `${target.name} Width`, target.widthMm, midW),
                  })}
                  {/* Non-crossing Left Clearance (stops at sibling edge or inside corner) */}
                  {left && left.lengthMm >= 1 && renderArchDimLine({
                    dimKey: `clear_left:${target.id}`,
                    p1: sPt(left.startS, offClear),
                    p2: sPt(left.endS, offClear),
                    ext1: sPt(left.startS, w.thicknessMm / 2),
                    ext2: sPt(left.endS, w.thicknessMm / 2),
                    valueMm: left.lengthMm,
                    locked: left.locked,
                    editable: true,
                    hoverId: left.neighborId,
                    onClickEdit: (midW) =>
                      openEditor(
                        `clear_left:${target.id}`,
                        'clearance_left',
                        left.stopsAt === 'component'
                          ? `Gap to ${left.neighborName}`
                          : 'Distance to Left Corner',
                        left.lengthMm,
                        midW
                      ),
                  })}
                  {/* Non-crossing Right Clearance (stops at sibling edge or inside corner) */}
                  {right && right.lengthMm >= 1 && renderArchDimLine({
                    dimKey: `clear_right:${target.id}`,
                    p1: sPt(right.startS, offClear),
                    p2: sPt(right.endS, offClear),
                    ext1: sPt(right.startS, w.thicknessMm / 2),
                    ext2: sPt(right.endS, w.thicknessMm / 2),
                    valueMm: right.lengthMm,
                    locked: right.locked,
                    editable: true,
                    hoverId: right.neighborId,
                    onClickEdit: (midW) =>
                      openEditor(
                        `clear_right:${target.id}`,
                        'clearance_right',
                        right.stopsAt === 'component'
                          ? `Gap to ${right.neighborName}`
                          : 'Distance to Right Corner',
                        right.lengthMm,
                        midW
                      ),
                  })}
                </g>
              );
            }

            if (focusedWall) {
              const w = focusedWall;
              const len = Math.max(1, getWallArcLength(w));
              const chain = buildWallDimensionChain(w, level.walls, level.openings, level.archElements);
              const dir = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
              const nrm = { x: -dir.y, y: dir.x };
              const sPt = (s: number, offset: number): Point2D => ({
                x: w.start.x + dir.x * s + nrm.x * offset,
                y: w.start.y + dir.y * s + nrm.y * offset,
              });
              const offSeg = w.thicknessMm / 2 + 230;
              const offTotal = w.thicknessMm / 2 + 490;

              return (
                <g data-testid="focused-wall-dimensions">
                  {/* Row 1: All individual segments along selected wall */}
                  {chain.segments.map((seg) => {
                    const editableSeg =
                      seg.kind === 'component' ||
                      chain.components.length > 0;
                    return renderArchDimLine({
                      dimKey: seg.key,
                      p1: sPt(seg.startS, offSeg),
                      p2: sPt(seg.endS, offSeg),
                      ext1: sPt(seg.startS, w.thicknessMm / 2),
                      ext2: sPt(seg.endS, w.thicknessMm / 2),
                      valueMm: seg.lengthMm,
                      locked: seg.locked,
                      editable: editableSeg,
                      hoverId: seg.componentId,
                      onClickEdit: (midW) => {
                        if (seg.locked) {
                          onConstraintError?.('This segment is locked.');
                          return;
                        }
                        if (seg.kind === 'component' && seg.componentId) {
                          const scr = worldToScreen(midW);
                          setEditingDim({
                            key: seg.key,
                            kind: 'component_width',
                            wallId: w.id,
                            compId: seg.componentId,
                            label: `${seg.label} Width`,
                            screenX: scr.x,
                            screenY: scr.y,
                            valueStr: String(Math.round((seg.lengthMm / 10) * 10) / 10),
                            origValueMm: seg.lengthMm,
                            error: null,
                          });
                        } else if (chain.components.length === 0) {
                          if ((w.anchorMode ?? 'fixed_left') === 'fixed_length') {
                            onConstraintError?.('Wall length is anchored as Fixed Total Length.');
                            return;
                          }
                          const scr = worldToScreen(midW);
                          setEditingDim({
                            key: 'wall_total',
                            kind: 'wall_length',
                            wallId: w.id,
                            label: 'Wall Length',
                            screenX: scr.x,
                            screenY: scr.y,
                            valueStr: String(Math.round((len / 10) * 10) / 10),
                            origValueMm: len,
                            error: null,
                          });
                        } else {
                          // Map bare wall gap segment to left/right clearance of adjacent component
                          const nextComp = chain.components.find((c) => c.leftS >= seg.endS - 2);
                          const prevComp = [...chain.components].reverse().find((c) => c.rightS <= seg.startS + 2);
                          const adjComp = nextComp ?? prevComp;
                          if (!adjComp) return;
                          if (adjComp.locked) {
                            onConstraintError?.(`Adjacent component "${adjComp.name}" is locked.`);
                            return;
                          }
                          const side = nextComp ? 'clearance_left' : 'clearance_right';
                          const scr = worldToScreen(midW);
                          setEditingDim({
                            key: seg.key,
                            kind: side,
                            wallId: w.id,
                            compId: adjComp.id,
                            label: `${adjComp.name} ${nextComp ? 'Left' : 'Right'} Wall Gap`,
                            screenX: scr.x,
                            screenY: scr.y,
                            valueStr: String(Math.round((seg.lengthMm / 10) * 10) / 10),
                            origValueMm: seg.lengthMm,
                            error: null,
                          });
                        }
                      },
                    });
                  })}

                  {/* Row 2: Overall Wall Length */}
                  {renderArchDimLine({
                    dimKey: `wall_total:${w.id}`,
                    p1: sPt(0, offTotal),
                    p2: sPt(len, offTotal),
                    ext1: sPt(0, w.thicknessMm / 2),
                    ext2: sPt(len, w.thicknessMm / 2),
                    valueMm: len,
                    locked: w.locked || w.anchorMode === 'fixed_length',
                    editable: true,
                    onClickEdit: (midW) => {
                      if (w.locked) {
                        onConstraintError?.('Wall is locked.');
                        return;
                      }
                      if (w.anchorMode === 'fixed_length') {
                        onConstraintError?.('Wall length is anchored as Fixed Total Length.');
                        return;
                      }
                      const scr = worldToScreen(midW);
                      setEditingDim({
                        key: `wall_total:${w.id}`,
                        kind: 'wall_length',
                        wallId: w.id,
                        label: 'Wall Total Length',
                        screenX: scr.x,
                        screenY: scr.y,
                        valueStr: String(Math.round((len / 10) * 10) / 10),
                        origValueMm: len,
                        error: null,
                      });
                    },
                  })}
                </g>
              );
            }

            // General plan dimensions when no wall/object is focused
            if (!settings.autoDimensions && !level.layers.autoDimensions) return null;
            return (
              <g data-testid="auto-wall-dimensions" className="pointer-events-none">
                {level.walls
                  .filter((w) => w.visible)
                  .map((w) => {
                    const len = getWallArcLength(w);
                    if (len < 60) return null;
                    const mid = getWallCenterlinePoint(w, 0.5);
                    const dir = mid.tangent;
                    const nrm = mid.normal;
                    const off = w.thicknessMm / 2 + 230;
                    const p1 = {
                      x: w.start.x + nrm.x * off,
                      y: w.start.y + nrm.y * off,
                    };
                    const p2 = {
                      x: w.end.x + nrm.x * off,
                      y: w.end.y + nrm.y * off,
                    };
                    const e1 = { x: w.start.x + nrm.x * (w.thicknessMm / 2), y: w.start.y + nrm.y * (w.thicknessMm / 2) };
                    const e2 = { x: w.end.x + nrm.x * (w.thicknessMm / 2), y: w.end.y + nrm.y * (w.thicknessMm / 2) };
                    void dir;
                    return renderArchDimLine({
                      dimKey: `auto_wall:${w.id}`,
                      p1,
                      p2,
                      ext1: e1,
                      ext2: e2,
                      valueMm: len,
                      locked: w.locked,
                      editable: false,
                    });
                  })}
              </g>
            );
          })()}

          {/* Live Ghost Preview while Inline Editing a Dimension */}
          {editingDim && !editingDim.error && (() => {
            const w = level.walls.find((x) => x.id === editingDim.wallId);
            if (!w) return null;
            if (editingDim.previewConnectedResult?.ok) {
              return (
                <g className="pointer-events-none">
                  {editingDim.previewConnectedResult.wallUpdates.map((wu) => {
                    const origW = level.walls.find((x) => x.id === wu.id);
                    return (
                      <line
                        key={wu.id}
                        x1={wu.start.x}
                        y1={wu.start.y}
                        x2={wu.end.x}
                        y2={wu.end.y}
                        stroke="#0EA5E9"
                        strokeWidth={origW?.thicknessMm ?? w.thicknessMm}
                        strokeOpacity={0.35}
                        strokeDasharray="80 50"
                      />
                    );
                  })}
                </g>
              );
            }
            if (editingDim.previewWallEnds) {
              const p = editingDim.previewWallEnds;
              return (
                <line
                  x1={p.start.x}
                  y1={p.start.y}
                  x2={p.end.x}
                  y2={p.end.y}
                  stroke="#0EA5E9"
                  strokeWidth={w.thicknessMm}
                  strokeOpacity={0.35}
                  strokeDasharray="80 50"
                  className="pointer-events-none"
                />
              );
            }
            if (editingDim.previewUpdates) {
              return (
                <g className="pointer-events-none">
                  {editingDim.previewUpdates.map((u) => {
                    const { point, tangent } = getWallCenterlinePoint(w, u.t);
                    const ang = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
                    return (
                      <g key={u.id} transform={`translate(${point.x}, ${point.y}) rotate(${ang})`}>
                        <rect
                          x={-u.widthMm / 2}
                          y={-w.thicknessMm / 2 - 20}
                          width={u.widthMm}
                          height={w.thicknessMm + 40}
                          fill="rgba(14, 165, 233, 0.25)"
                          stroke="#0EA5E9"
                          strokeWidth={1.8 / pxPerMm}
                          strokeDasharray="60 40"
                        />
                      </g>
                    );
                  })}
                </g>
              );
            }
            return null;
          })()}

          {/* Near-Miss Open Wall Gap Halos (helps spot and heal disconnected crooked corners) */}
          {nearMissGaps.length > 0 && (
            <g data-testid="wall-gap-halos" className="pointer-events-none">
              {nearMissGaps.map((g, idx) => (
                <g key={`${g.wallAId}_${g.endA}_${idx}`}>
                  <line
                    x1={g.pointA.x}
                    y1={g.pointA.y}
                    x2={g.pointB.x}
                    y2={g.pointB.y}
                    stroke="#F59E0B"
                    strokeWidth={1.6 / pxPerMm}
                    strokeDasharray={`${5 / pxPerMm} ${4 / pxPerMm}`}
                  />
                  <circle
                    cx={g.pointA.x}
                    cy={g.pointA.y}
                    r={9 / pxPerMm}
                    fill="#F59E0B"
                    fillOpacity={0.14}
                    stroke="#F59E0B"
                    strokeWidth={1.5 / pxPerMm}
                  />
                  <circle
                    cx={g.pointB.x}
                    cy={g.pointB.y}
                    r={9 / pxPerMm}
                    fill="#F59E0B"
                    fillOpacity={0.14}
                    stroke="#F59E0B"
                    strokeWidth={1.5 / pxPerMm}
                  />
                </g>
              ))}
            </g>
          )}

          {/* Live Chimney Placement Preview on Hover (snapped flush to nearest valid wall edge) */}
          {activeTool === 'chimney' &&
            hoverWorld &&
            (() => {
              const previewSnap = snapChimneyToWallEdge(
                hoverWorld,
                650,
                450,
                level.walls,
                level.openings,
                level.archElements,
                undefined,
                settings.snapEnabled
              );
              const hasWalls = level.walls.some((w) => w.visible !== false);
              if (previewSnap) {
                return (
                  <g
                    transform={`translate(${previewSnap.xMm}, ${previewSnap.yMm}) rotate(${previewSnap.rotationDeg})`}
                    className="pointer-events-none"
                  >
                    <rect
                      x={-325}
                      y={-225}
                      width={650}
                      height={450}
                      fill="rgba(37, 99, 235, 0.16)"
                      stroke="#2563EB"
                      strokeDasharray="60 40"
                      strokeWidth={1.5 / pxPerMm}
                    />
                  </g>
                );
              }
              return (
                <g
                  transform={`translate(${hoverWorld.x}, ${hoverWorld.y})`}
                  className="pointer-events-none"
                >
                  <rect
                    x={-325}
                    y={-225}
                    width={650}
                    height={450}
                    fill={hasWalls ? 'rgba(239, 68, 68, 0.14)' : 'rgba(37, 99, 235, 0.16)'}
                    stroke={hasWalls ? '#EF4444' : '#2563EB'}
                    strokeDasharray="60 40"
                    strokeWidth={1.5 / pxPerMm}
                  />
                </g>
              );
            })()}

          {/* Selected Single Railing Interactive Vertex & Midpoint Handles */}
          {activeTool === 'select' &&
            selection.length === 1 &&
            selection[0].kind === 'arch' &&
            (() => {
              const selEl = level.archElements.find(
                (a) => a.id === selection[0].id && a.type === 'railing' && !a.locked
              );
              if (!selEl) return null;
              const rCfg = resolveRailingConfig(selEl);
              const worldPts = rCfg.nodes.map((n) => ({
                ...localToWorldPoint(selEl.xMm, selEl.yMm, selEl.rotationDeg, n.xMm, n.yMm),
                elevationMm: n.elevationMm ?? 0,
              }));
              const segCount = rCfg.closed && worldPts.length >= 3 ? worldPts.length : worldPts.length - 1;
              return (
                <g data-testid="railing-node-handles">
                  {Array.from({ length: segCount }, (_, sIdx) => {
                    const a = worldPts[sIdx];
                    const b = worldPts[(sIdx + 1) % worldPts.length];
                    if (Math.hypot(b.x - a.x, b.y - a.y) < 360) return null;
                    const mx = (a.x + b.x) / 2;
                    const my = (a.y + b.y) / 2;
                    return (
                      <g
                        key={`mid_${sIdx}`}
                        transform={`translate(${mx}, ${my})`}
                        className="cursor-pointer"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          const localMid = worldToLocalPoint(selEl.xMm, selEl.yMm, selEl.rotationDeg, mx, my);
                          const midElev = Math.round(((a.elevationMm ?? 0) + (b.elevationMm ?? 0)) / 2);
                          const insertAt = sIdx + 1;
                          const nextNodes = [...rCfg.nodes];
                          nextNodes.splice(insertAt, 0, {
                            xMm: Math.round(localMid.x),
                            yMm: Math.round(localMid.y),
                            elevationMm: midElev,
                          });
                          onUpdateLevel(
                            (lvl) => ({
                              ...lvl,
                              archElements: lvl.archElements.map((x) =>
                                x.id === selEl.id
                                  ? { ...x, railing: { ...rCfg, nodes: nextNodes } }
                                  : x
                              ),
                            }),
                            false,
                            false
                          );
                          dragMutatedRef.current = true;
                          setDragState({
                            kind: 'railing_node',
                            elId: selEl.id,
                            nodeIndex: insertAt,
                            startClient: { x: e.clientX, y: e.clientY },
                            label: 'Insert Railing Node',
                          });
                        }}
                      >
                        <circle r={12 / pxPerMm} fill="transparent" />
                        <circle
                          r={5 / pxPerMm}
                          fill="#FFFFFF"
                          stroke="#0284C7"
                          strokeWidth={1.6 / pxPerMm}
                        />
                        <line
                          x1={-2.5 / pxPerMm}
                          y1={0}
                          x2={2.5 / pxPerMm}
                          y2={0}
                          stroke="#0284C7"
                          strokeWidth={1.3 / pxPerMm}
                        />
                        <line
                          x1={0}
                          y1={-2.5 / pxPerMm}
                          x2={0}
                          y2={2.5 / pxPerMm}
                          stroke="#0284C7"
                          strokeWidth={1.3 / pxPerMm}
                        />
                      </g>
                    );
                  })}
                  {worldPts.map((wp, idx) => (
                    <g
                      key={`rnode_${idx}`}
                      className="cursor-grab active:cursor-grabbing"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        dragMutatedRef.current = false;
                        setDragState({
                          kind: 'railing_node',
                          elId: selEl.id,
                          nodeIndex: idx,
                          startClient: { x: e.clientX, y: e.clientY },
                          label: 'Edit Railing Node',
                        });
                      }}
                    >
                      <circle cx={wp.x} cy={wp.y} r={12 / pxPerMm} fill="transparent" />
                      <circle
                        cx={wp.x}
                        cy={wp.y}
                        r={6.5 / pxPerMm}
                        fill="#2563EB"
                        stroke="#FFFFFF"
                        strokeWidth={2 / pxPerMm}
                      />
                    </g>
                  ))}
                </g>
              );
            })()}

          {/* Marquee Box Select (L->R: solid blue enclosed; R->L: dashed emerald crossing) */}
          {dragState?.kind === 'marquee' &&
            Math.hypot(
              dragState.curClient.x - dragState.startClient.x,
              dragState.curClient.y - dragState.startClient.y
            ) >= 4 && (() => {
            const mMode = resolveMarqueeMode(dragState.startClient.x, dragState.curClient.x);
            const isEnclosed = mMode === 'enclosed';
            return (
              <rect
                data-testid="marquee-box"
                data-mode={mMode}
                x={Math.min(dragState.startWorld.x, dragState.curWorld.x)}
                y={Math.min(dragState.startWorld.y, dragState.curWorld.y)}
                width={Math.abs(dragState.curWorld.x - dragState.startWorld.x)}
                height={Math.abs(dragState.curWorld.y - dragState.startWorld.y)}
                fill={isEnclosed ? 'rgba(37,99,235,0.08)' : 'rgba(5,150,105,0.09)'}
                stroke={isEnclosed ? '#2563EB' : '#059669'}
                strokeDasharray={isEnclosed ? undefined : `${6 / pxPerMm} ${4 / pxPerMm}`}
                strokeWidth={1.5 / pxPerMm}
                className="pointer-events-none"
              />
            );
          })()}

          {/* 13a. Live Surface / Wall Attachment Target Feedback */}
          {attachmentPreview && (
            <g data-testid="attachment-preview" className="pointer-events-none">
              {attachmentPreview.kind === 'surface' &&
                attachmentPreview.surfacePolygon &&
                attachmentPreview.surfacePolygon.length >= 3 && (
                  <polygon
                    points={attachmentPreview.surfacePolygon.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(37, 99, 235, 0.08)"
                    stroke="#2563EB"
                    strokeOpacity={0.9}
                    strokeWidth={2.2 / pxPerMm}
                    strokeDasharray={`${6 / pxPerMm} ${3.5 / pxPerMm}`}
                    strokeLinejoin="round"
                  />
                )}
              {attachmentPreview.kind === 'wall' && attachmentPreview.wallSegment && (
                <line
                  x1={attachmentPreview.wallSegment.from.x}
                  y1={attachmentPreview.wallSegment.from.y}
                  x2={attachmentPreview.wallSegment.to.x}
                  y2={attachmentPreview.wallSegment.to.y}
                  stroke="#2563EB"
                  strokeOpacity={0.92}
                  strokeWidth={4 / pxPerMm}
                  strokeLinecap="round"
                />
              )}
            </g>
          )}

          {/* 13b. Moving Half-Translucent Dashed Wall Alignment & Extension Guide Lines */}
          {alignmentGuides.length > 0 && (
            <g data-testid="alignment-guides" className="pointer-events-none">
              {alignmentGuides.map((g, idx) => {
                const mx = (g.from.x + g.to.x) / 2;
                const my = (g.from.y + g.to.y) / 2;
                const d = dist(g.from, g.to);
                const isWallSnap = g.label === 'WALL FLUSH' || g.label === 'CORNER' || g.label === 'ROOM CENTER';
                const isAngled = g.axis === 'ext' || g.axis === 'perp' || g.label === 'FLUSH';
                const guideColor = isWallSnap ? '#10B981' : isAngled ? '#06B6D4' : '#2563EB';
                const badgeText =
                  g.label ??
                  (g.axis === 'ext'
                    ? 'EXTEND'
                    : g.axis === 'perp'
                      ? '90° PERP'
                      : `ALIGN ${g.axis.toUpperCase()}`);
                const pillW = Math.max(60, badgeText.length * 7 + 16);
                return (
                  <g key={`${g.axis}_${idx}`}>
                    <line
                      x1={g.from.x}
                      y1={g.from.y}
                      x2={g.to.x}
                      y2={g.to.y}
                      stroke={guideColor}
                      strokeOpacity={0.68}
                      strokeWidth={1.8 / pxPerMm}
                      strokeDasharray={`${8 / pxPerMm} ${5 / pxPerMm}`}
                      strokeLinecap="round"
                    />
                    <circle
                      cx={g.to.x}
                      cy={g.to.y}
                      r={6.5 / pxPerMm}
                      fill={guideColor}
                      fillOpacity={0.22}
                      stroke={guideColor}
                      strokeOpacity={0.85}
                      strokeWidth={1.6 / pxPerMm}
                    />
                    <circle
                      cx={g.from.x}
                      cy={g.from.y}
                      r={5 / pxPerMm}
                      fill="none"
                      stroke={guideColor}
                      strokeOpacity={0.85}
                      strokeWidth={1.5 / pxPerMm}
                    />
                    {d > 260 && (
                      <g transform={`translate(${mx}, ${my}) rotate(${-viewRotationDeg})`}>
                        <rect
                          x={(-pillW / 2) / pxPerMm}
                          y={-10 / pxPerMm}
                          width={pillW / pxPerMm}
                          height={20 / pxPerMm}
                          rx={4 / pxPerMm}
                          fill={guideColor}
                          fillOpacity={0.88}
                        />
                        <text
                          textAnchor="middle"
                          dy={3.5 / pxPerMm}
                          fontSize={10 / pxPerMm}
                          fontFamily="JetBrains Mono, monospace"
                          fontWeight={700}
                          fill="#FFFFFF"
                        >
                          {badgeText}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          )}

          {/* Distinct Room Center Target Crosshair */}
          {roomCenterSnapTarget && dragState?.kind === 'furniture' && (
            <g
              data-testid="room-center-indicator"
              transform={`translate(${roomCenterSnapTarget.center.x}, ${roomCenterSnapTarget.center.y})`}
              className="pointer-events-none"
            >
              <circle
                r={18 / pxPerMm}
                fill="#10B981"
                fillOpacity={0.12}
                stroke="#10B981"
                strokeWidth={1.6 / pxPerMm}
                strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
              />
              <circle
                r={8.5 / pxPerMm}
                fill="none"
                stroke="#059669"
                strokeWidth={2 / pxPerMm}
              />
              <circle r={2.5 / pxPerMm} fill="#059669" />
              <line x1={-26 / pxPerMm} y1={0} x2={26 / pxPerMm} y2={0} stroke="#059669" strokeWidth={1.4 / pxPerMm} />
              <line x1={0} y1={-26 / pxPerMm} x2={0} y2={26 / pxPerMm} stroke="#059669" strokeWidth={1.4 / pxPerMm} />
            </g>
          )}

          {/* Snap Indicator Marker + Live Tooltip */}
          {hoverWorld && (activeTool !== 'select' || dragState?.kind === 'wall_vertex' || dragState?.kind === 'furniture') && activeTool !== 'pan' && (
            <g transform={`translate(${hoverWorld.x}, ${hoverWorld.y})`} className="pointer-events-none">
              {snapBadge === 'vertex' && (
                <>
                  <circle r={11 / pxPerMm} fill="#10B981" fillOpacity={0.15} stroke="#10B981" strokeWidth={1.4 / pxPerMm} />
                  <circle r={6.5 / pxPerMm} fill="none" stroke="#10B981" strokeWidth={2.2 / pxPerMm} />
                </>
              )}
              {snapBadge === 'align' && (
                <g>
                  <circle r={6.5 / pxPerMm} fill="rgba(6,182,212,0.18)" stroke="#06B6D4" strokeWidth={1.8 / pxPerMm} />
                  <line x1={-10 / pxPerMm} y1={0} x2={10 / pxPerMm} y2={0} stroke="#06B6D4" strokeWidth={1.4 / pxPerMm} />
                  <line x1={0} y1={-10 / pxPerMm} x2={0} y2={10 / pxPerMm} stroke="#06B6D4" strokeWidth={1.4 / pxPerMm} />
                </g>
              )}
              {snapBadge === 'wall' && (
                <rect
                  x={-5.5 / pxPerMm}
                  y={-5.5 / pxPerMm}
                  width={11 / pxPerMm}
                  height={11 / pxPerMm}
                  transform="rotate(45)"
                  fill="rgba(245,158,11,0.18)"
                  stroke="#F59E0B"
                  strokeWidth={2 / pxPerMm}
                />
              )}
              {snapLabel && snapBadge !== 'grid' && snapBadge !== 'none' && (
                <g transform={`translate(${14 / pxPerMm}, ${-14 / pxPerMm}) rotate(${-viewRotationDeg})`}>
                  <rect
                    x={0}
                    y={-12 / pxPerMm}
                    width={(snapLabel.length * 6.5 + 14) / pxPerMm}
                    height={17 / pxPerMm}
                    rx={4 / pxPerMm}
                    fill={snapBadge === 'vertex' ? '#059669' : snapBadge === 'wall' ? '#D97706' : '#0284C7'}
                    fillOpacity={0.92}
                  />
                  <text
                    x={7 / pxPerMm}
                    y={-0.5 / pxPerMm}
                    fontSize={9.5 / pxPerMm}
                    fontFamily="Inter, system-ui, sans-serif"
                    fontWeight={600}
                    fill="#FFFFFF"
                  >
                    {snapLabel}
                  </text>
                </g>
              )}
            </g>
          )}

          {/* Connected Corner Confirmation Pulse */}
          {snapPulse && (
            <g transform={`translate(${snapPulse.point.x}, ${snapPulse.point.y})`} className="pointer-events-none">
              <circle r={14 / pxPerMm} fill="#10B981" fillOpacity={0.22} stroke="#10B981" strokeWidth={2.2 / pxPerMm} />
              <g transform={`translate(0, ${-22 / pxPerMm}) rotate(${-viewRotationDeg})`}>
                <rect x={-52 / pxPerMm} y={-10 / pxPerMm} width={104 / pxPerMm} height={18 / pxPerMm} rx={4 / pxPerMm} fill="#059669" />
                <text textAnchor="middle" dy={2.5 / pxPerMm} fontSize={10 / pxPerMm} fontWeight={700} fill="#FFFFFF">
                  {snapPulse.label}
                </text>
              </g>
            </g>
          )}
        </g>
      </svg>

      {/* Subtle in-canvas Scale Bar (metric) & Print B&W Toggle */}
      <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 text-[11px] font-mono-nums text-slate-600 dark:text-slate-300 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 px-2.5 py-1 rounded shadow-xs">
        <span className="inline-block border-b-2 border-l-2 border-r-2 border-slate-700 dark:border-slate-300 h-1.5" style={{ width: `${Math.max(24, Math.min(140, 1000 * pxPerMm))}px` }} />
        <span>1.00 m · {settings.scale}</span>
      </div>

      <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
        {viewRotationDeg !== 0 && onResetViewRotation && (
          <button
            type="button"
            data-testid="canvas2d-reset-rotation"
            onClick={onResetViewRotation}
            title={`2D View rotated ${viewRotationDeg}° — Click to reset to 0°`}
            className="flex items-center gap-1 px-2 py-1 rounded border border-blue-300 dark:border-blue-800 bg-blue-50/95 dark:bg-blue-950/90 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900 shadow-xs text-[11px] font-mono-nums font-semibold transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>{viewRotationDeg}° · Reset</span>
          </button>
        )}

        {onToggleBlackAndWhite && (
          <button
            type="button"
            data-testid="canvas2d-bw-toggle"
            onClick={onToggleBlackAndWhite}
            title="Toggle Black & White architectural sheet mode (clean white print drawing)"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border shadow-xs text-[11px] font-semibold transition-colors cursor-pointer ${
              isBw
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white/95 dark:bg-slate-900/95 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full border ${
                isBw
                  ? 'bg-white border-white'
                  : 'bg-gradient-to-r from-slate-900 to-white border-slate-400'
              }`}
            />
            <span>B&amp;W Plan</span>
          </button>
        )}
      </div>

      {/* Compact single-line cursor hint chip (120 ms fade, clears immediately on drop) */}
      <CursorHintChip
        hint={cursorHint}
        clientPos={cursorClientPos}
        containerRef={containerRef}
      />

      {/* Fixed Top-Left Mini Side-Elevation Stack Card under scale bar */}
      {selectedStackInfo && (() => {
        const trackW = 58;
        const rowH = 38;
        const trackH = Math.min(180, Math.max(96, selectedStackInfo.items.length * rowH));
        const padTop = 8;
        const padBottom = 8;
        const usableH = Math.max(40, trackH - padTop - padBottom);
        const scaleMaxMm = Math.max(100, selectedStackInfo.maxElevMm);
        const nItems = selectedStackInfo.items.length;
        const laneAreaW = trackW - 10;
        const barGap = 2;
        const laneW = Math.max(4, Math.min(12, Math.floor((laneAreaW - (nItems - 1) * barGap) / Math.max(1, nItems))));
        const startLaneX = Math.max(5, Math.floor((trackW - (nItems * laneW + Math.max(0, nItems - 1) * barGap)) / 2));

        return (
          <div
            data-testid="elevation-stack-switcher"
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute top-11 left-3 z-30 w-[256px] bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border border-slate-200 dark:border-slate-700 rounded shadow-md overflow-hidden"
          >
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/60">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                Side Elevation ({nItems})
              </span>
              <span className="text-[10px] font-mono-nums font-medium text-slate-400 dark:text-slate-500">
                0–{Math.round(scaleMaxMm)} mm
              </span>
            </div>
            <div className="flex items-stretch">
              {/* Left Vertical Elevation Track */}
              <div className="w-[58px] shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 flex items-center justify-center">
                <svg
                  data-testid="stack-elevation-track"
                  width={trackW}
                  height={trackH}
                  className="block select-none"
                >
                  {/* Reference elevation ticks (top & 50% & floor 0mm) */}
                  <line
                    x1={4}
                    y1={padTop}
                    x2={trackW - 4}
                    y2={padTop}
                    stroke="#CBD5E1"
                    strokeDasharray="2 2"
                    strokeWidth={1}
                  />
                  <line
                    x1={4}
                    y1={padTop + usableH * 0.5}
                    x2={trackW - 4}
                    y2={padTop + usableH * 0.5}
                    stroke="#E2E8F0"
                    strokeDasharray="2 2"
                    strokeWidth={1}
                  />
                  <line
                    x1={4}
                    y1={padTop + usableH}
                    x2={trackW - 4}
                    y2={padTop + usableH}
                    stroke="#64748B"
                    strokeWidth={1.25}
                  />
                  {[...selectedStackInfo.items].reverse().map((item, revIdx) => {
                    const yBottom = padTop + usableH - (item.minZMm / scaleMaxMm) * usableH;
                    const yTopRaw = padTop + usableH - (item.maxZMm / scaleMaxMm) * usableH;
                    const barH = Math.max(3, yBottom - yTopRaw);
                    const barY = Math.max(padTop - 1, yBottom - barH);
                    const barX = startLaneX + revIdx * (laneW + barGap);
                    return (
                      <rect
                        key={`elev_bar_${item.id}`}
                        data-testid={`stack-elev-bar-${item.id}`}
                        x={barX}
                        y={barY}
                        width={laneW}
                        height={barH}
                        rx={1.5}
                        fill={item.isSelected ? '#2563EB' : '#94A3B8'}
                        fillOpacity={item.isSelected ? 0.95 : 0.72}
                        stroke={item.isSelected ? '#1D4ED8' : '#64748B'}
                        strokeWidth={1}
                        className="cursor-pointer transition-colors"
                        onClick={() => onSelect([{ kind: 'furniture', id: item.id }])}
                      >
                        <title>{`${item.name}: ${Math.round(item.minZMm)}–${Math.round(item.maxZMm)} mm`}</title>
                      </rect>
                    );
                  })}
                </svg>
              </div>

              {/* Right Interactive Layer Rows */}
              <div className="min-w-0 flex-1 max-h-[180px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
                {selectedStackInfo.items.map((item) => {
                  const hasTieButtons = item.canMoveUp || item.canMoveDown;
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between gap-1 px-2 py-1.5 transition-colors ${
                        item.isSelected
                          ? 'bg-blue-50/90 dark:bg-blue-950/60'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
                      }`}
                    >
                      <button
                        type="button"
                        data-testid={`stack-switch-${item.id}`}
                        onClick={() => onSelect([{ kind: 'furniture', id: item.id }])}
                        className="min-w-0 flex-1 flex items-center gap-1.5 text-left cursor-pointer"
                      >
                        <span
                          className={`w-1.5 h-5 rounded-full shrink-0 ${
                            item.isSelected
                              ? 'bg-blue-600'
                              : 'bg-slate-300 dark:bg-slate-600'
                          }`}
                        />
                        <span className="min-w-0 flex flex-col">
                          <span
                            className={`truncate text-[11px] leading-tight ${
                              item.isSelected
                                ? 'text-blue-700 dark:text-blue-300 font-semibold'
                                : 'text-slate-700 dark:text-slate-200 font-medium'
                            }`}
                          >
                            {item.name}
                          </span>
                          <span
                            data-testid={`stack-elev-label-${item.id}`}
                            className="text-[9.5px] leading-tight text-slate-400 dark:text-slate-500 font-mono-nums"
                          >
                            {Math.round(item.minZMm)}–{Math.round(item.maxZMm)} mm
                          </span>
                        </span>
                      </button>
                      {hasTieButtons && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            data-testid={`stack-up-${item.id}`}
                            disabled={!item.canMoveUp}
                            title={item.canMoveUp ? 'Move layer up (same elevation tie)' : 'Top of elevation tie'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateLevel(
                                (lvl) => ({
                                  ...lvl,
                                  furniture: reorderFurnitureZOrder(lvl.furniture, [item.id], 'forward'),
                                }),
                                false,
                                true,
                                'Move Stack Layer Up'
                              );
                            }}
                            className="p-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ChevronUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            data-testid={`stack-down-${item.id}`}
                            disabled={!item.canMoveDown}
                            title={item.canMoveDown ? 'Move layer down (same elevation tie)' : 'Bottom of elevation tie'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateLevel(
                                (lvl) => ({
                                  ...lvl,
                                  furniture: reorderFurnitureZOrder(lvl.furniture, [item.id], 'backward'),
                                }),
                                false,
                                true,
                                'Move Stack Layer Down'
                              );
                            }}
                            className="p-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 1-Click Gap Reconnect Action when near-miss open corners exist */}
      {nearMissGaps.length > 0 && !activeDistanceResult && !activeAreaResult && !cursorHint && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-amber-50 dark:bg-amber-950/90 border border-amber-300 dark:border-amber-700 rounded-lg shadow-md px-3 py-1.5 text-xs text-amber-900 dark:text-amber-100">
          <span>
            {nearMissGaps.length} near-miss corner {nearMissGaps.length === 1 ? 'gap' : 'gaps'} detected
          </span>
          <button
            type="button"
            data-testid="heal-wall-gaps-btn"
            onClick={() => {
              onUpdateLevel(
                (lvl) => {
                  const healed = healNearWallGaps(lvl.walls, 260);
                  return { ...lvl, walls: healed.walls };
                },
                true,
                true,
                'Reconnect Wall Corners'
              );
            }}
            className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer"
          >
            Reconnect Corners
          </button>
        </div>
      )}

      {/* Transient Distance Measurement Done Bar */}
      {activeDistanceResult && (
        <div
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg px-3 py-1.5 text-xs"
        >
          <span className="text-slate-500">Corner Distance</span>
          <span className="font-mono-nums font-semibold text-blue-600 dark:text-blue-400">
            {formatSmartMetric(dist(activeDistanceResult.start, activeDistanceResult.end))}
          </span>
          <button
            type="button"
            onClick={() => {
              setActiveDistanceResult(null);
              setMeasureDraftPts([]);
              onToolChange('select');
            }}
            className="px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium hover:opacity-90 cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {/* Transient Area Finder Done Bar */}
      {activeAreaResult && (
        <div
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg px-3 py-1.5 text-xs"
        >
          <span className="text-slate-500">
            {activeAreaResult.roomName ? `${activeAreaResult.roomName}` : 'Measured Area'}
          </span>
          <span className="font-mono-nums font-semibold text-blue-600 dark:text-blue-400">
            {formatAreaM2(activeAreaResult.areaM2)}
          </span>
          <span className="font-mono-nums text-slate-400">
            ({activeAreaResult.perimeterM.toFixed(2)} m perim)
          </span>
          <button
            type="button"
            onClick={() => {
              setActiveAreaResult(null);
              setMeasureDraftPts([]);
              onToolChange('select');
            }}
            className="px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium hover:opacity-90 cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {/* Helpful drawing hint banner & numeric wall length input HUD */}
      {(activeTool === 'wall' || activeTool === 'wall_arc') && (
        <div
          data-testid="wall-length-hud"
          className="pointer-events-none absolute top-11 right-3 flex items-center gap-2 text-xs bg-slate-900/95 text-white px-3 py-1.5 rounded-md shadow-md border border-slate-700"
        >
          {typedLengthCm.length > 0 ? (
            <>
              <span className="text-slate-300">Wall Length:</span>
              <span className="font-mono-nums font-bold text-blue-400">{typedLengthCm} cm</span>
              <span className="text-slate-400">
                ({wallDraftPts.length === 0 ? `${centeredAxis === 'x' ? 'Horizontal' : 'Vertical'} · centered on cursor` : 'from start'}) · Enter or Click to place · Tab flip · Esc clear
              </span>
            </>
          ) : wallDraftPts.length > 0 ? (
            <span>Click end corner or type length in cm (e.g. 320 + Enter) · Esc to finish</span>
          ) : (
            <span>Click start corner or type length in cm (e.g. 320 + Enter) for centered wall</span>
          )}
        </div>
      )}
      {/* Inline Interactive Dimension Editor Popover */}
      {editingDim && (
        <div
          style={{
            left: `${Math.max(12, Math.min(size.width - 230, editingDim.screenX - 100))}px`,
            top: `${Math.max(12, Math.min(size.height - 96, editingDim.screenY - 26))}px`,
          }}
          className="absolute z-40 w-[216px] bg-white dark:bg-slate-900 border border-blue-500 rounded-lg shadow-xl p-2 text-xs"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1 font-medium">
            <span className="truncate">{editingDim.label}</span>
            <span>Enter · Esc</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={dimInputRef}
              autoFocus
              type="number"
              step="0.5"
              value={editingDim.valueStr}
              onChange={(e) => setEditingDim(applyDimInputValue(editingDim, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDimEditor();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingDim(null);
                }
              }}
              className="w-full px-2 py-1 font-mono-nums text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-[11px] font-mono-nums text-slate-500 shrink-0">cm</span>
            <button
              type="button"
              onClick={commitDimEditor}
              className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 cursor-pointer shrink-0"
            >
              OK
            </button>
          </div>
          {editingDim.error && (
            <p className="mt-1 text-[10px] text-red-600 dark:text-red-400 leading-tight">
              {editingDim.error}
            </p>
          )}
        </div>
      )}

      {activeTool === 'chimney' && (
        <div className="pointer-events-none absolute top-11 right-3 text-xs bg-slate-900 text-white px-3 py-1.5 rounded-md shadow-sm">
          Click near a wall face to attach Chimney flush, or click open floor · Esc cancel
        </div>
      )}
      {activeTool === 'railing' && (
        <div className="absolute top-11 right-3 z-30 flex items-center gap-2 text-xs bg-slate-900/95 text-white px-3 py-1.5 rounded-md shadow-md border border-slate-700">
          <span className="pointer-events-none">
            {railingDraftPts.length === 0
              ? 'Click corners, stair sides, or balcony edges to start railing · Esc cancel'
              : `P${railingDraftPts.length} placed · Click next corner · Enter / Double-click finish`}
            {railingHoverInfo && railingHoverInfo.elevationMm > 0
              ? ` · Elev +${Math.round(railingHoverInfo.elevationMm / 10)} cm`
              : ''}
          </span>
          {railingDraftPts.length >= 2 && (
            <button
              type="button"
              onClick={() => commitRailingDraft(railingDraftPts, false)}
              className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold cursor-pointer"
            >
              Finish
            </button>
          )}
        </div>
      )}
      {activeTool === 'measure_distance' && !activeDistanceResult && (
        <div className="pointer-events-none absolute top-11 right-3 text-xs bg-slate-900 text-white px-3 py-1.5 rounded-md shadow-sm">
          {measureDraftPts.length === 0
            ? 'Click first corner (snaps to wall & furniture corners)'
            : 'Click second corner to measure distance · Esc cancel'}
        </div>
      )}
      {activeTool === 'measure_area' && !activeAreaResult && (
        <div className="pointer-events-none absolute top-11 right-3 text-xs bg-blue-600 text-white px-3 py-1.5 rounded-md shadow-sm">
          {measureDraftPts.length === 0
            ? 'Click inside a room or click corners to trace an area'
            : 'Click next corner · Double-click, Enter, or click start to calculate'}
        </div>
      )}
      <CanvasContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onDuplicate={onDuplicateSelected}
        onDelete={onDeleteSelected}
        onToggleLock={handleCtxToggleLock}
        onMirror={handleCtxMirror}
        onRotate90={handleCtxRotate90}
        onSelectLayerAbove={() => {
          const aboveId = ctxMetaRef.current?.aboveId;
          if (aboveId) onSelect([{ kind: 'furniture', id: aboveId }]);
        }}
        onSelectLayerBelow={() => {
          const belowId = ctxMetaRef.current?.belowId;
          if (belowId) onSelect([{ kind: 'furniture', id: belowId }]);
        }}
        onConsolidateWalls={() => {
          const ids = ctxMetaRef.current?.consolidateIds;
          if (!ids || ids.length < 2) return;
          const gid = uid('wgrp');
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              walls: applyWallConsolidation(lvl.walls, ids, gid),
            }),
            false,
            true,
            'Consolidate Wall Representation'
          );
        }}
        onSeparateWalls={() => {
          const ids = ctxMetaRef.current?.separateIds;
          if (!ids || ids.length === 0) return;
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              walls: clearWallConsolidation(lvl.walls, ids),
            }),
            false,
            true,
            'Separate Wall Representation'
          );
        }}
        onPaste={onPasteClipboard}
        onFitToScreen={onFitToScreen}
      />
    </div>
  );
};
