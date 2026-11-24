import type { Point2D } from '../types/plan.ts';

export interface ZoomSnapTolerances {
  /** Wall endpoint, wall-face, intersection, and corner snap threshold in mm (12 px base). */
  vertexWallTolMm: number;
  /** Adjacent furniture flush, wall component slide/edge, and arch block flush threshold in mm (10 px base). */
  furnFlushTolMm: number;
  /** Edge/center axis alignment & grid pull threshold in mm (8 px base). */
  alignTolMm: number;
  /** Standard room-center snap threshold in mm (8 px base). */
  roomCenterTolMm: number;
  /** Strong room-center snap threshold (tables, rugs, islands, ceiling fixtures) in mm (11 px base). */
  strongRoomCenterTolMm: number;
  /** Surface-mounted item room-center snap threshold in mm (7 px base). */
  surfaceRoomCenterTolMm: number;
}

const clampMm = (val: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(val)));

/**
 * Converts balanced screen-pixel snap budgets into clamped millimeter tolerances
 * so snap reach remains steady at any canvas zoom factor.
 */
export function computeZoomSnapTolerances(pxPerMm: number): ZoomSnapTolerances {
  const safePx = Number.isFinite(pxPerMm) && pxPerMm > 0.002 ? pxPerMm : 0.06;
  return {
    vertexWallTolMm: clampMm(12 / safePx, 25, 240),
    furnFlushTolMm: clampMm(10 / safePx, 20, 180),
    alignTolMm: clampMm(8 / safePx, 18, 160),
    roomCenterTolMm: clampMm(8 / safePx, 18, 160),
    strongRoomCenterTolMm: clampMm(11 / safePx, 24, 210),
    surfaceRoomCenterTolMm: clampMm(7 / safePx, 16, 130),
  };
}

export interface SnapHysteresisCandidate<T = unknown> {
  key: string;
  dist: number;
  data: T;
}

export interface SnapHysteresisState {
  pointKey?: string;
  wallKey?: string;
  furnFlushXKey?: string;
  furnFlushYKey?: string;
  alignXKey?: string;
  alignYKey?: string;
  roomCenterKey?: string;
  wallComponentKey?: string;
  edgeSKey?: string;
  sillStepKey?: string;
  wallFurnHKey?: string;
  wallFurnVKey?: string;
}

export const SNAP_HYSTERESIS_EXIT_FACTOR = 1.4;
export const SNAP_HYSTERESIS_SWITCH_RATIO = 0.72;

/**
 * Selects the winning snap candidate with ~40% exit hysteresis and active-target
 * preference so snapping does not chatter or flicker between nearby candidates.
 */
export function pickWithSnapHysteresis<T>(
  candidates: ReadonlyArray<SnapHysteresisCandidate<T>>,
  prevKey: string | undefined,
  enterTolMm: number,
  exitFactor = SNAP_HYSTERESIS_EXIT_FACTOR,
  switchRatio = SNAP_HYSTERESIS_SWITCH_RATIO
): SnapHysteresisCandidate<T> | null {
  if (candidates.length === 0) return null;

  const exitTol = enterTolMm * exitFactor;
  const prevCand = prevKey ? candidates.find((c) => c.key === prevKey) : undefined;

  let bestWithinEnter: SnapHysteresisCandidate<T> | null = null;
  for (const c of candidates) {
    if (c.dist <= enterTolMm && (!bestWithinEnter || c.dist < bestWithinEnter.dist)) {
      bestWithinEnter = c;
    }
  }

  if (prevCand && prevCand.dist <= exitTol) {
    if (
      bestWithinEnter &&
      bestWithinEnter.key !== prevCand.key &&
      bestWithinEnter.dist < prevCand.dist * switchRatio &&
      prevCand.dist - bestWithinEnter.dist > Math.max(4, enterTolMm * 0.15)
    ) {
      return bestWithinEnter;
    }
    return prevCand;
  }

  return bestWithinEnter;
}

export const DEFAULT_HOST_DWELL_MS = 120;

export interface HostDwellTracker {
  committedHostId?: string;
  pendingHostId?: string;
  pendingSinceMs: number;
  initialized: boolean;
}

export function createHostDwellTracker(initialHostId?: string): HostDwellTracker {
  return {
    committedHostId: initialHostId,
    pendingHostId: undefined,
    pendingSinceMs: 0,
    initialized: true,
  };
}

/**
 * Gates stack-host transitions behind a ~120 ms dwell timer so grazing over
 * neighboring furniture never triggers rapid elevation jumps.
 */
export function evaluateHostDwellStep(
  tracker: HostDwellTracker,
  candidateHostId: string | undefined,
  nowMs: number,
  options?: { dwellMs?: number; immediate?: boolean }
): {
  nextTracker: HostDwellTracker;
  resolvedHostId: string | undefined;
  waitingForDwell: boolean;
} {
  const dwellMs = options?.dwellMs ?? DEFAULT_HOST_DWELL_MS;

  if (!tracker.initialized || options?.immediate) {
    return {
      nextTracker: {
        committedHostId: candidateHostId,
        pendingHostId: undefined,
        pendingSinceMs: 0,
        initialized: true,
      },
      resolvedHostId: candidateHostId,
      waitingForDwell: false,
    };
  }

  if (candidateHostId === tracker.committedHostId) {
    return {
      nextTracker: {
        committedHostId: tracker.committedHostId,
        pendingHostId: undefined,
        pendingSinceMs: 0,
        initialized: true,
      },
      resolvedHostId: tracker.committedHostId,
      waitingForDwell: false,
    };
  }

  if (tracker.pendingHostId !== candidateHostId) {
    return {
      nextTracker: {
        committedHostId: tracker.committedHostId,
        pendingHostId: candidateHostId,
        pendingSinceMs: nowMs,
        initialized: true,
      },
      resolvedHostId: tracker.committedHostId,
      waitingForDwell: true,
    };
  }

  if (nowMs - tracker.pendingSinceMs >= dwellMs) {
    return {
      nextTracker: {
        committedHostId: candidateHostId,
        pendingHostId: undefined,
        pendingSinceMs: 0,
        initialized: true,
      },
      resolvedHostId: candidateHostId,
      waitingForDwell: false,
    };
  }

  return {
    nextTracker: tracker,
    resolvedHostId: tracker.committedHostId,
    waitingForDwell: true,
  };
}

export type CursorHintTone = 'clash' | 'attachment' | 'snap' | 'neutral';

export interface CursorHintPayload {
  text: string;
  tone: CursorHintTone;
}

export interface ResolveDragHintInput {
  clashingNames?: string[];
  placingOnHostName?: string;
  attachedToWall?: boolean;
  isForceFloor?: boolean;
  roomCenterName?: string;
  snapLabel?: string;
  freeOverlap?: boolean;
}

/**
 * Resolves strictly ONE concise line for the floating cursor hint chip in order:
 * 1) Clash -> 2) Host / Wall Attachment -> 3) Snap target -> 4) Free overlap.
 */
export function resolveSingleDragHint(input: ResolveDragHintInput): CursorHintPayload | null {
  if (input.clashingNames && input.clashingNames.length > 0) {
    const label =
      input.clashingNames.length > 1
        ? `Clashing with ${input.clashingNames[0]} (+${input.clashingNames.length - 1})`
        : `Clashing with ${input.clashingNames[0]}`;
    return { text: label, tone: 'clash' };
  }

  if (input.isForceFloor) {
    return { text: 'Floor mounted', tone: 'attachment' };
  }

  if (input.placingOnHostName) {
    return { text: `On ${input.placingOnHostName}`, tone: 'attachment' };
  }

  if (input.attachedToWall) {
    return { text: 'Attached to wall', tone: 'attachment' };
  }

  if (input.roomCenterName) {
    return { text: 'Room center', tone: 'snap' };
  }

  if (input.snapLabel) {
    return { text: input.snapLabel, tone: 'snap' };
  }

  if (input.freeOverlap) {
    return { text: 'Free overlap', tone: 'neutral' };
  }

  return null;
}

export const SNAP_ANIMATION_DURATION_MS = 100;

export interface SnapVisualTweenState {
  targetKey: string;
  startOffsetX: number;
  startOffsetY: number;
  startMs: number;
  durationMs: number;
  lastCommittedPos: Point2D;
  lastSnapKey?: string;
}

export function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * Evaluates the current render-only visual offset `(dxMm, dyMm)` for an active
 * ~100 ms ease-out snap animation without ever altering committed solver state.
 */
export function sampleSnapVisualTween(
  tween: SnapVisualTweenState | null,
  nowMs: number
): { dx: number; dy: number; active: boolean } {
  if (!tween) return { dx: 0, dy: 0, active: false };
  const elapsed = nowMs - tween.startMs;
  if (elapsed >= tween.durationMs) {
    return { dx: 0, dy: 0, active: false };
  }
  const rem = 1 - easeOutCubic(elapsed / tween.durationMs);
  return {
    dx: tween.startOffsetX * rem,
    dy: tween.startOffsetY * rem,
    active: Math.hypot(tween.startOffsetX * rem, tween.startOffsetY * rem) > 0.15,
  };
}

/**
 * Triggers or preserves a subtle ~100 ms visual-only settle offset when a drag
 * snaps onto a new target (or settles cleanly onto a snap coordinate on drop).
 */
export function updateSnapVisualTweenOnSolverResult(
  prevTween: SnapVisualTweenState | null,
  targetKey: string,
  prevVisualPos: Point2D | null,
  nextCommittedPos: Point2D,
  nextSnapKey: string | undefined,
  maxJumpMm: number,
  nowMs: number
): SnapVisualTweenState | null {
  const prevSample = sampleSnapVisualTween(
    prevTween && prevTween.targetKey === targetKey ? prevTween : null,
    nowMs
  );
  const currentRenderedPos: Point2D = prevVisualPos
    ? { x: prevVisualPos.x + prevSample.dx, y: prevVisualPos.y + prevSample.dy }
    : nextCommittedPos;

  const prevSnapKey = prevTween && prevTween.targetKey === targetKey ? prevTween.lastSnapKey : undefined;
  const engagedOrSwitchedSnap = Boolean(nextSnapKey) && nextSnapKey !== prevSnapKey;
  const jumpDist = Math.hypot(
    currentRenderedPos.x - nextCommittedPos.x,
    currentRenderedPos.y - nextCommittedPos.y
  );

  if (engagedOrSwitchedSnap && jumpDist >= 1.5 && jumpDist <= Math.max(maxJumpMm, 12)) {
    return {
      targetKey,
      startOffsetX: currentRenderedPos.x - nextCommittedPos.x,
      startOffsetY: currentRenderedPos.y - nextCommittedPos.y,
      startMs: nowMs,
      durationMs: SNAP_ANIMATION_DURATION_MS,
      lastCommittedPos: { ...nextCommittedPos },
      lastSnapKey: nextSnapKey,
    };
  }

  if (prevTween && prevTween.targetKey === targetKey && prevSample.active) {
    return {
      ...prevTween,
      lastCommittedPos: { ...nextCommittedPos },
      lastSnapKey: nextSnapKey,
    };
  }

  return {
    targetKey,
    startOffsetX: 0,
    startOffsetY: 0,
    startMs: nowMs - SNAP_ANIMATION_DURATION_MS,
    durationMs: SNAP_ANIMATION_DURATION_MS,
    lastCommittedPos: { ...nextCommittedPos },
    lastSnapKey: nextSnapKey,
  };
}
