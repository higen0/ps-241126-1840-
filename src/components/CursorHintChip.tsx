import React, { useEffect, useState } from 'react';
import type { CursorHintPayload } from '../utils/dragErgonomics.ts';

interface CursorHintChipProps {
  hint: CursorHintPayload | null;
  clientPos: { x: number; y: number } | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Compact, single-line cursor-following hint chip with 120 ms opacity fade-in/out
 * that clears immediately when a drag ends or is cancelled.
 */
export const CursorHintChip: React.FC<CursorHintChipProps> = ({
  hint,
  clientPos,
  containerRef,
}) => {
  const [renderedHint, setRenderedHint] = useState<CursorHintPayload | null>(hint);
  const [renderedPos, setRenderedPos] = useState<{ x: number; y: number } | null>(clientPos);
  const [visible, setVisible] = useState<boolean>(Boolean(hint && clientPos));

  useEffect(() => {
    if (hint && clientPos) {
      setRenderedHint(hint);
      setRenderedPos(clientPos);
      const raf = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = window.setTimeout(() => {
      setRenderedHint(null);
    }, 125);
    return () => window.clearTimeout(timer);
  }, [hint, clientPos]);

  if (!renderedHint || !renderedPos) return null;

  const rect = containerRef.current?.getBoundingClientRect();
  const relX = rect ? renderedPos.x - rect.left : renderedPos.x;
  const relY = rect ? renderedPos.y - rect.top : renderedPos.y;
  const maxW = rect ? rect.width : 1200;
  const maxH = rect ? rect.height : 800;

  const left = Math.max(8, Math.min(maxW - 210, relX + 14));
  const top = Math.max(8, Math.min(maxH - 36, relY + 18));

  const toneClass =
    renderedHint.tone === 'clash'
      ? 'text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/70 bg-white/95 dark:bg-slate-900/95'
      : renderedHint.tone === 'attachment'
        ? 'text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/70 bg-white/95 dark:bg-slate-900/95'
        : renderedHint.tone === 'snap'
          ? 'text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/70 bg-white/95 dark:bg-slate-900/95'
          : 'text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95';

  return (
    <div
      data-testid="cursor-hint-chip"
      data-active={hint ? 'true' : 'false'}
      data-tone={renderedHint.tone}
      style={{
        transform: `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`,
      }}
      className={`pointer-events-none absolute top-0 left-0 z-40 select-none px-2 py-1 rounded border shadow-xs backdrop-blur-xs text-[11.5px] font-medium leading-none whitespace-nowrap max-w-[230px] truncate transition-opacity duration-[120ms] ease-out ${
        visible && hint ? 'opacity-100' : 'opacity-0'
      } ${toneClass}`}
    >
      {renderedHint.text}
    </div>
  );
};
