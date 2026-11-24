import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Unlock, AlertCircle, Trash2 } from 'lucide-react';
import { ResizeAnchor } from '../../types/plan';

interface InspectorSectionProps {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}

export const InspectorSection: React.FC<InspectorSectionProps> = ({
  title,
  summary,
  defaultOpen = true,
  open: controlledOpen,
  onToggle,
  action,
  children,
  testId,
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleToggle = () => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalOpen((v) => !v);
    }
  };

  return (
    <section
      data-testid={testId}
      className="border-b border-slate-200/85 dark:border-slate-800/85 last:border-b-0"
    >
      <div className="flex items-center justify-between gap-1.5 py-2">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={isOpen}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left group py-0.5 rounded focus:outline-none cursor-pointer"
        >
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 shrink-0" />
          )}
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 truncate">
            {title}
          </span>
          {!isOpen && summary && (
            <span className="ml-auto text-[10px] font-mono-nums text-slate-400 dark:text-slate-500 truncate max-w-[120px]">
              {summary}
            </span>
          )}
        </button>
        {action && <div className="shrink-0 flex items-center gap-1">{action}</div>}
      </div>
      {isOpen && <div className="pb-3 pt-0.5 space-y-2.5">{children}</div>}
    </section>
  );
};

interface InspectorHeaderProps {
  title: React.ReactNode;
  subtitle?: string;
  icon?: React.ReactNode;
  locked?: boolean;
  lockLabel?: string;
  onToggleLock?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  actions?: React.ReactNode;
}

export const InspectorHeader: React.FC<InspectorHeaderProps> = ({
  title,
  subtitle,
  icon,
  locked,
  lockLabel,
  onToggleLock,
  onDelete,
  deleteLabel = 'Delete selected element',
  actions,
}) => (
  <div className="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 flex items-center justify-between gap-2 shrink-0">
    <div className="min-w-0 flex items-center gap-2 flex-1">
      {icon && (
        <span className="w-6 h-6 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 shrink-0">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {typeof title === 'string' ? (
          <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
            {title}
          </div>
        ) : (
          title
        )}
        {subtitle && (
          <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate font-mono-nums">
            {subtitle}
          </div>
        )}
      </div>
    </div>
    <div className="flex items-center gap-1 shrink-0">
      {actions}
      {onToggleLock && (
        <LockToggleButton locked={Boolean(locked)} onToggle={onToggleLock} label={lockLabel} />
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={Boolean(locked)}
          title={deleteLabel}
          aria-label={deleteLabel}
          className="p-1.5 rounded border border-transparent text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-35 transition-colors cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  </div>
);

export const LockToggleButton: React.FC<{
  locked: boolean;
  onToggle: () => void;
  label?: string;
}> = ({ locked, onToggle, label }) => (
  <button
    type="button"
    onClick={onToggle}
    title={locked ? `Unlock ${label ?? 'element'}` : `Lock ${label ?? 'element'} in place`}
    aria-label={locked ? `Unlock ${label ?? 'element'}` : `Lock ${label ?? 'element'}`}
    aria-pressed={locked}
    className={`px-1.5 py-1 rounded border text-[11px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer ${
      locked
        ? 'bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25'
        : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
    }`}
  >
    {locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
    <span className="hidden sm:inline">{locked ? 'Locked' : 'Lock'}</span>
  </button>
);

export const LockedBanner: React.FC = () => (
  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/30 text-[11px] text-amber-800 dark:text-amber-200">
    <Lock className="w-3.5 h-3.5 shrink-0" />
    <span>Locked in place. Unlock to move, resize, or delete.</span>
  </div>
);

export const ConstraintErrorBanner: React.FC<{
  message: string | null;
  onDismiss?: () => void;
}> = ({ message, onDismiss }) => {
  if (!message) return null;
  return (
    <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-[11px] text-red-700 dark:text-red-300">
      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span className="flex-1 leading-snug">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-red-500 hover:text-red-700 font-semibold px-1 cursor-pointer"
          aria-label="Dismiss constraint warning"
        >
          ×
        </button>
      )}
    </div>
  );
};

export const ResizeAnchorSelector: React.FC<{
  value: ResizeAnchor;
  onChange: (anchor: ResizeAnchor) => void;
}> = ({ value, onChange }) => {
  const options: Array<{ id: ResizeAnchor; label: string; hint: string }> = [
    { id: 'left', label: 'Left Edge', hint: 'Pin Left Edge (expand Right)' },
    { id: 'center', label: 'Middle', hint: 'Expand Equally From Middle (Default)' },
    { id: 'right', label: 'Right Edge', hint: 'Pin Right Edge (expand Left)' },
  ];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Resize Anchor
        </span>
        <span className="text-[10px] text-slate-400">
          {value === 'left' ? 'Left Edge Fixed' : value === 'right' ? 'Right Edge Fixed' : 'Middle Fixed'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {options.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              title={opt.hint}
              onClick={() => onChange(opt.id)}
              className={`relative py-1 px-1.5 rounded border text-[11px] font-medium flex flex-col items-center gap-1 transition-colors cursor-pointer ${
                active
                  ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-500 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="w-7 h-1.5 rounded-xs bg-slate-200 dark:bg-slate-700 relative overflow-hidden flex items-center justify-center">
                {opt.id === 'left' && (
                  <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${active ? 'bg-blue-600' : 'bg-slate-400'}`} />
                )}
                {opt.id === 'center' && (
                  <span className={`w-1.5 h-full ${active ? 'bg-blue-600' : 'bg-slate-400'}`} />
                )}
                {opt.id === 'right' && (
                  <span className={`absolute right-0 top-0 bottom-0 w-1.5 ${active ? 'bg-blue-600' : 'bg-slate-400'}`} />
                )}
              </span>
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
