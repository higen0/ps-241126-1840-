import React from 'react';
import type { ResolvedPatternMetrics } from './materialPattern';

interface SurfacePatternDefProps {
  id: string;
  metrics: ResolvedPatternMetrics;
  /** Optional stroke contrast boost for dark surfaces */
  isDarkSurface?: boolean;
  /** Optional pattern coordinate offset in mm (e.g. for consolidated wall segments) */
  originXMm?: number;
  originYMm?: number;
}

/**
 * Shared SVG vector pattern definition for 2D Plan floors, Wall View wall faces,
 * and Wall View backsplashes. Uses exact real-world mm dimensions from `resolvePatternMetrics`
 * so pattern scale, tile/plank dimensions, stagger %, grout width, and secondary colors match 3D 1:1.
 */
export const VectorSurfacePatternDef: React.FC<SurfacePatternDefProps> = ({
  id,
  metrics,
  isDarkSurface = false,
  originXMm = 0,
  originYMm = 0,
}) => {
  if (!metrics.hasPattern) return null;

  const {
    preset,
    repeatWidthMm,
    repeatHeightMm,
    rotDeg,
    secondaryHex,
    groutRatioX,
    groutRatioY,
    staggerPct,
  } = metrics;

  const lineInk =
    preset === 'nero_marble' || isDarkSurface
      ? 'rgba(255,255,255,0.22)'
      : 'rgba(15,23,42,0.16)';
  const subtleInk =
    preset === 'nero_marble' || isDarkSurface
      ? 'rgba(255,255,255,0.12)'
      : 'rgba(15,23,42,0.10)';

  // Grout stroke widths scaled into 256x256 pattern viewBox
  const gwX = Math.max(1.6, Math.min(26, groutRatioX * 256));
  const gwY = Math.max(1.6, Math.min(26, groutRatioY * 256));
  const gw = Math.max(gwX, gwY);
  const stagShift = (staggerPct / 100) * 128; // stagger in 2-col 256 space

  const transforms: string[] = [];
  if (originXMm !== 0 || originYMm !== 0) {
    transforms.push(`translate(${originXMm}, ${originYMm})`);
  }
  if (rotDeg !== 0) {
    transforms.push(`rotate(${rotDeg})`);
  }

  return (
    <pattern
      id={id}
      width={Math.max(10, repeatWidthMm)}
      height={Math.max(10, repeatHeightMm)}
      viewBox="0 0 256 256"
      preserveAspectRatio="none"
      patternUnits="userSpaceOnUse"
      patternTransform={transforms.length > 0 ? transforms.join(' ') : undefined}
    >
      {/* Straight wood plank presets */}
      {(preset === 'wood' ||
        preset === 'oak' ||
        preset === 'oak_wide' ||
        preset === 'walnut' ||
        preset === 'teak' ||
        preset === 'smoked_oak') && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2, gw * 0.7)}>
          <path d="M0 0 V256 M64 0 V256 M128 0 V256 M192 0 V256" />
          <path
            d={`M0 ${Math.round(48 + staggerPct * 1.4)} H64 M64 ${Math.round(112 + staggerPct * 1.2)} H128 M128 ${Math.round(32 + staggerPct * 2.0)} H192 M192 ${Math.round(140 + staggerPct * 1.1)} H256`}
          />
          <path
            d="M22 0 V256 M96 0 V256 M158 0 V256 M224 0 V256"
            stroke={subtleInk}
            strokeWidth="1.4"
            strokeDasharray="24 18"
          />
        </g>
      )}

      {preset === 'wood_strip' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(1.8, gw * 0.65)}>
          <path d="M0 0 V256 M42.6 0 V256 M85.3 0 V256 M128 0 V256 M170.6 0 V256 M213.3 0 V256" />
          <path
            d="M0 90 H42.6 M42.6 196 H85.3 M85.3 52 H128 M128 156 H170.6 M170.6 220 H213.3 M213.3 116 H256"
            strokeWidth="1.6"
          />
        </g>
      )}

      {preset === 'parquet' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2, gw * 0.65)}>
          <rect x="0" y="0" width="64" height="256" fill="rgba(120,82,42,0.04)" />
          <rect x="64" y="0" width="64" height="256" />
          <rect x="128" y="0" width="64" height="256" fill="rgba(120,82,42,0.05)" />
          <rect x="192" y="0" width="64" height="256" />
          <path
            d={`M0 ${Math.round(44 + staggerPct * 1.1)} H64 M64 ${Math.round(140 + staggerPct * 0.9)} H128 M128 ${Math.round(28 + staggerPct * 1.6)} H192 M192 ${Math.round(118 + staggerPct * 1.0)} H256`}
          />
        </g>
      )}

      {preset === 'herringbone' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2.2, gw * 0.7)}>
          <path d="M0 0 L64 64 L64 128 M64 64 L128 0 M128 0 L192 64 L192 128 M192 64 L256 0 M0 128 L64 192 L64 256 M64 192 L128 128 M128 128 L192 192 L192 256 M192 192 L256 128" />
        </g>
      )}

      {preset === 'chevron' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2.2, gw * 0.7)}>
          <path d="M0 64 L64 0 L128 64 L192 0 L256 64 M0 128 L64 64 L128 128 L192 64 L256 128 M0 192 L64 128 L128 192 L192 128 L256 192 M0 256 L64 192 L128 256 L192 192 L256 256 M64 0 V256 M192 0 V256" />
        </g>
      )}

      {preset === 'basketweave' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2, gw * 0.7)}>
          {/* Top-left horizontal planks */}
          <rect x="0" y="0" width="128" height="42.6" fill="rgba(120,82,42,0.03)" />
          <rect x="0" y="42.6" width="128" height="42.6" />
          <rect x="0" y="85.3" width="128" height="42.7" fill="rgba(120,82,42,0.03)" />
          {/* Top-right vertical planks */}
          <rect x="128" y="0" width="42.6" height="128" />
          <rect x="170.6" y="0" width="42.6" height="128" fill="rgba(120,82,42,0.04)" />
          <rect x="213.3" y="0" width="42.7" height="128" />
          {/* Bottom-left vertical planks */}
          <rect x="0" y="128" width="42.6" height="128" />
          <rect x="42.6" y="128" width="42.6" height="128" fill="rgba(120,82,42,0.04)" />
          <rect x="85.3" y="128" width="42.7" height="128" />
          {/* Bottom-right horizontal planks */}
          <rect x="128" y="128" width="128" height="42.6" fill="rgba(120,82,42,0.03)" />
          <rect x="128" y="170.6" width="128" height="42.6" />
          <rect x="128" y="213.3" width="128" height="42.7" fill="rgba(120,82,42,0.03)" />
        </g>
      )}

      {/* Architectural paneling & striped wallpaper */}
      {preset === 'paneling' && (
        <g fill="none" stroke={lineInk} strokeWidth={Math.max(2.4, gw * 0.9)}>
          <path d="M0 0 V256 M42.6 0 V256 M85.3 0 V256 M128 0 V256 M170.6 0 V256 M213.3 0 V256" />
        </g>
      )}

      {preset === 'ribbed_paneling' && (
        <g>
          <path
            d="M0 0 V256 M64 0 V256 M128 0 V256 M192 0 V256"
            stroke={secondaryHex}
            strokeOpacity="0.45"
            strokeWidth={Math.max(3, gw * 1.1)}
            fill="none"
          />
          <path
            d="M8 0 V256 M72 0 V256 M136 0 V256 M200 0 V256"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="2"
            fill="none"
          />
        </g>
      )}

      {preset === 'striped_wallpaper' && (
        <g>
          <rect x="0" y="0" width="128" height="256" fill={secondaryHex} fillOpacity="0.42" />
          <line x1="0" y1="0" x2="0" y2="256" stroke={subtleInk} strokeWidth="2" />
          <line x1="128" y1="0" x2="128" y2="256" stroke={subtleInk} strokeWidth="2" />
        </g>
      )}

      {/* Rectified & staggered tile presets */}
      {(preset === 'tile' || preset === 'porcelain_slab' || preset === 'limestone') && (
        <g>
          <path
            d={
              staggerPct > 1
                ? `M0 0 H256 M0 128 H256 M0 0 V128 M128 0 V128 M${stagShift} 128 V256 M${(stagShift + 128) % 256} 128 V256`
                : 'M0 0 H256 M0 128 H256 M0 0 V256 M128 0 V256'
            }
            stroke={metrics.capabilities.supportsSecondaryColor ? secondaryHex : lineInk}
            strokeOpacity={metrics.capabilities.supportsSecondaryColor ? 0.72 : 1}
            strokeWidth={Math.max(2.6, gw * 1.1)}
            fill="none"
          />
        </g>
      )}

      {(preset === 'subway_tile' ||
        preset === 'travertine' ||
        preset === 'slate' ||
        preset === 'brick') && (
        <g>
          <path
            d={`M0 0 H256 M0 128 H256 M0 0 V128 M128 0 V128 M${stagShift} 128 V256 M${(stagShift + 128) % 256} 128 V256`}
            stroke={preset === 'brick' || preset === 'subway_tile' ? secondaryHex : lineInk}
            strokeOpacity={preset === 'brick' ? 0.78 : preset === 'subway_tile' ? 0.72 : 1}
            strokeWidth={
              preset === 'brick' ? Math.max(4.5, gw * 1.5) : Math.max(2.8, gw * 1.15)
            }
            fill="none"
          />
        </g>
      )}

      {preset === 'hex_tile' && (
        <path
          d="M0 128 L42 54 L128 54 L170 128 L128 202 L42 202 Z M170 128 L256 128 M128 54 L170 -20 M128 202 L170 276 M-42 54 L42 54 M-42 202 L42 202"
          stroke={secondaryHex}
          strokeOpacity="0.62"
          strokeWidth={Math.max(2.6, gw * 1.1)}
          fill="none"
        />
      )}

      {preset === 'penny_tile' && (
        <g>
          <rect x="0" y="0" width="256" height="256" fill={secondaryHex} fillOpacity="0.45" />
          {[21, 64, 107, 149, 192, 235].map((cy, row) =>
            [21, 64, 107, 149, 192, 235].map((cx, col) => (
              <circle
                key={`${row}_${col}`}
                cx={row % 2 === 1 ? (cx + 21) % 256 : cx}
                cy={cy}
                r={Math.max(10, 18 - gw * 0.45)}
                fill={metrics.primaryHex}
                stroke={subtleInk}
                strokeWidth="1.2"
              />
            ))
          )}
        </g>
      )}

      {preset === 'checker' && (
        <g>
          <rect x="0" y="0" width="128" height="128" fill={secondaryHex} />
          <rect x="128" y="128" width="128" height="128" fill={secondaryHex} />
          {gw > 1.8 && (
            <path
              d="M0 0 H256 M0 128 H256 M0 0 V256 M128 0 V256"
              stroke="rgba(15,23,42,0.18)"
              strokeWidth={Math.min(12, gw * 0.85)}
              fill="none"
            />
          )}
        </g>
      )}

      {preset === 'harlequin' && (
        <g>
          <polygon points="128,0 256,128 128,256 0,128" fill={secondaryHex} />
          <path
            d="M0 128 L128 0 L256 128 L128 256 Z"
            stroke={subtleInk}
            strokeWidth={Math.max(2, gw * 0.8)}
            fill="none"
          />
        </g>
      )}

      {preset === 'encaustic_tile' && (
        <g>
          <g fill={secondaryHex} fillOpacity="0.82">
            <polygon points="64,14 78,50 114,64 78,78 64,114 50,78 14,64 50,50" />
            <polygon points="192,14 206,50 242,64 206,78 192,114 178,78 142,64 178,50" />
            <polygon points="64,142 78,178 114,192 78,206 64,242 50,206 14,192 50,178" />
            <polygon points="192,142 206,178 242,192 206,206 192,242 178,206 142,192 178,178" />
          </g>
          <path
            d="M0 0 H256 M0 128 H256 M0 0 V256 M128 0 V256"
            stroke={lineInk}
            strokeWidth={Math.max(2.4, gw)}
            fill="none"
          />
        </g>
      )}

      {preset === 'pinwheel_tile' && (
        <g>
          {[
            [0, 0],
            [128, 0],
            [0, 128],
            [128, 128],
          ].map(([ox, oy], idx) => (
            <g key={idx} transform={`translate(${ox}, ${oy})`}>
              <rect x="44" y="44" width="40" height="40" fill={secondaryHex} fillOpacity="0.85" />
              <path
                d="M0 0 H128 V128 H0 Z M0 44 H84 M44 0 V84 M44 84 H128 M84 44 V128"
                stroke={lineInk}
                strokeWidth={Math.max(2.2, gw * 0.9)}
                fill="none"
              />
            </g>
          ))}
        </g>
      )}

      {preset === 'terrazzo' && (
        <g>
          <g fill={secondaryHex} fillOpacity="0.58">
            <polygon points="28,24 46,16 40,40" />
            <polygon points="118,46 142,56 124,74" />
            <polygon points="205,28 228,44 208,60" />
            <polygon points="62,135 88,126 76,152" />
            <polygon points="158,158 180,150 172,176" />
            <polygon points="34,212 56,204 56,228" />
            <polygon points="212,196 234,212 212,230" />
          </g>
          <g fill={subtleInk}>
            <polygon points="82,28 96,34 84,48" />
            <polygon points="178,94 196,86 190,108" />
            <polygon points="112,208 128,198 134,220" />
          </g>
        </g>
      )}

      {(preset === 'marble' || preset === 'calacatta_gold' || preset === 'nero_marble') && (
        <g>
          <path
            d="M0 64 Q80 28 156 88 T256 60 M0 184 Q96 150 184 206 T256 176"
            stroke={
              metrics.capabilities.supportsSecondaryColor
                ? secondaryHex
                : preset === 'nero_marble'
                  ? 'rgba(255,255,255,0.22)'
                  : 'rgba(15,23,42,0.12)'
            }
            strokeOpacity={0.34}
            strokeWidth="3.2"
            fill="none"
          />
          {metrics.capabilities.supportsDimensions && (
            <path
              d="M0 0 H256 M0 128 H256 M0 0 V256 M128 0 V256"
              stroke={subtleInk}
              strokeWidth={Math.max(1.8, gw * 0.7)}
              fill="none"
            />
          )}
        </g>
      )}

      {(preset === 'concrete' ||
        preset === 'microcement' ||
        preset === 'plaster' ||
        preset === 'stucco' ||
        preset === 'fabric' ||
        preset === 'boucle' ||
        preset === 'velvet' ||
        preset === 'wallpaper' ||
        preset === 'leather_cognac' ||
        preset === 'leather_black' ||
        preset === 'leather_cream' ||
        preset === 'metal' ||
        preset === 'brass' ||
        preset === 'bronze' ||
        preset === 'chrome' ||
        preset === 'matte_black_metal') && (
        <g
          fill={preset === 'microcement' ? secondaryHex : subtleInk}
          fillOpacity={preset === 'microcement' ? 0.25 : 0.75}
        >
          <circle cx="28" cy="34" r="2.6" />
          <circle cx="110" cy="68" r="2.2" />
          <circle cx="198" cy="24" r="2.8" />
          <circle cx="68" cy="148" r="2.2" />
          <circle cx="164" cy="190" r="2.6" />
          <circle cx="222" cy="142" r="2.0" />
        </g>
      )}
    </pattern>
  );
};
