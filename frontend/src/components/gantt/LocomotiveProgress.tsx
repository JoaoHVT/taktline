import { useRef } from 'react'
import type { TipoKey } from '@/lib/tipos'

/**
 * Themed loading indicator for the Master Schedule launch: a coupled train — one
 * locomotive per selected line type, plus a few random wagons — riding a track toward a
 * tunnel on the right.
 *
 * PURELY PRESENTATIONAL. It owns no state, no timers and no data flow — `percent` and
 * `colors` are values the caller already has, so the animation can never disagree with
 * what is on screen, and removing this component changes nothing but the visuals.
 *
 * Two modes:
 *  • determinate (`percent`)   — the HEAD loco's position IS the loading percentage; the
 *                                rest of the train trails behind it, so the front of the
 *                                consist is always the true progress.
 *  • indeterminate             — no percentage exists for that phase (the period/cache
 *                                fetch), so the train crosses on a loop. The rail stays
 *                                unfilled, because a filled rail would imply a completion
 *                                ratio nobody measured.
 *
 * COUPLING: every car shares ONE head position (`left`, or the keyframe) and is pushed
 * back from it by a static `transform: translateX(-offset)`. That single trick is what
 * lets locos + wagons move as one unit in both modes.
 *
 * WAGON-BY-WAGON TUNNEL ENTRY: the crossing keyframe runs the head PAST the right edge by
 * the full train length (`--optv-end`), so every car — head, then each wagon in turn —
 * slides under the opaque tunnel and is occluded one at a time before the loop resets. The
 * old keyframe stopped at `left: 100%`, which parked the head at the portal while the
 * wagons were still mid-track, so the reset teleported the whole consist away at once. Now
 * the tail is fully swallowed before the jump, and the entry reads car by car.
 */
const RED = '#D32F2F'

const LOCO_W = 20
const WAGON_W = 15
const TUNNEL_W = 24
const LOCO_GAP = 2          // tight coupling between locomotives of the consist
const BAND_H = 30           // container height; the extra room above the track holds the label

/** Per-line-type livery. Every value is a color the app already uses elsewhere, so the
 *  strip stays inside the existing palette instead of introducing a new one. */
// `Record<TipoKey, …>` on purpose: registering a new Tipo must fail the build here rather
// than render a locomotive with `undefined` for a livery.
export const LINE_TYPE_COLORS: Record<TipoKey, string> = {
  montagem: '#D32F2F',   // the app accent
}

/** Two neutral wagon shades — the "small visual variant", kept greyscale so wagons
 *  never compete with the colored locomotives for attention. */
const WAGON_SHADES = ['#9CA3AF', '#6B7280']

/** Crossing loops (indeterminate) + the always-on label wave. The run ends at the per-mount
 *  `--optv-end` (right edge + train length) instead of `left: 100%`, so the whole consist clears
 *  the tunnel before the loop resets — see the wagon-by-wagon note up top.
 *
 *  `shunt` is a straight run that backs up once mid-way before carrying on — a nod to real
 *  yard shunting, and it keeps repeated loads from looking identical.
 *
 *  ── NO `prefers-reduced-motion` BLOCK, DELIBERATELY ──────────────────────────────────────
 *  There used to be one, parking the train and stilling the label and the smoke. It is the single
 *  thing that made this band look broken, and it cost a full day of debugging: on Windows,
 *  "Animation effects" (Settings → Accessibility → Visual effects, read by Chrome through
 *  SPI_GETCLIENTAREAANIMATION) is a plain display preference that plenty of machines have off
 *  without ever asking for a still screen — this repo's own dev machine included. For those users
 *  every `@keyframes` here died while the inline-driven parts (the determinate `left` + transition)
 *  and Tailwind's `animate-spin` beside it kept moving, so the band read as a frozen app during the
 *  one moment its whole job is to say "still working". Re-adding the block re-creates that bug.
 *  If reduced motion is ever honored here again it must SUBDUE the motion, never remove it. */
const CSS = `
@keyframes optvLocoRun {
  from { left: -${LOCO_W + 6}px; }
  to   { left: var(--optv-end, 100%); }
}
@keyframes optvLocoShunt {
  0%   { left: -${LOCO_W + 6}px; }
  45%  { left: 48%; }
  58%  { left: 30%; }
  100% { left: var(--optv-end, 100%); }
}
@keyframes optvLabelWave {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.55; }
  30%           { transform: translateY(-2px); opacity: 1; }
}
@keyframes optvSmoke {
  0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
  20%  { opacity: 0.35; }
  100% { transform: translate(-6px, -12px) scale(1.4); opacity: 0; }
}
.optv-loco-run   { animation: optvLocoRun   2.6s linear infinite; }
.optv-loco-shunt { animation: optvLocoShunt 3.6s ease-in-out infinite; }
.optv-label span { display: inline-block; animation: optvLabelWave 1.4s ease-in-out infinite; }
.optv-smoke      { animation: optvSmoke 1.6s ease-out infinite; }
`

/** Indeterminate variants. `flip` mirrors the WHOLE strip on X, which relocates the tunnel to
 *  the left edge and turns the train around in one property — a right-to-left run with no extra
 *  artwork or keyframes. Picked once per mount, so a given load is stable and only a NEW load
 *  looks different. `dur` matches the class it pairs with (later scaled by a random speed). */
const VARIANTS = [
  { cls: 'optv-loco-run',   dur: 2.6, flip: false },
  { cls: 'optv-loco-run',   dur: 2.6, flip: true  },
  { cls: 'optv-loco-shunt', dur: 3.6, flip: false },
  { cls: 'optv-loco-shunt', dur: 3.6, flip: true  },
] as const

/** Simple side-profile locomotive, chimney at the front (direction of travel). */
function Locomotive({ color }: { color: string }) {
  return (
    <svg width={LOCO_W} height={LOCO_W * (18 / 28)} viewBox="0 0 28 18" fill="none" aria-hidden="true">
      <circle cx="7"  cy="14.5" r="2.6" fill={color} />
      <circle cx="13" cy="15"   r="1.7" fill={color} />
      <circle cx="19" cy="14.5" r="2.6" fill={color} />
      <path d="M2.5 3.5a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v3h11.5a1.5 1.5 0 0 1 1.5 1.5v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" fill={color} />
      <rect x="20.5" y="1.5" width="3.5" height="4" rx="0.8" fill={color} />
      {/* Cab window — near-white so it reads as a punch-out against ANY livery. */}
      <rect x="4.5" y="4.5" width="4" height="3.5" rx="0.6" fill="#FFFFFF" opacity="0.9" />
    </svg>
  )
}

type WagonStyle = 'box' | 'tank' | 'container'

/** Freight car. `box` is the default; `tank` and `container` are the rare "special wagon"
 *  variants (#4D) — same silhouette footprint and wheels, only the body differs, so the
 *  coupling maths and offsets are untouched. */
function Wagon({ color, style }: { color: string; style: WagonStyle }) {
  const H = LOCO_W * (18 / 28)
  if (style === 'tank') {
    return (
      <svg width={WAGON_W} height={H} viewBox="0 0 21 18" fill="none" aria-hidden="true">
        <circle cx="6"  cy="14.5" r="2.4" fill={color} />
        <circle cx="15" cy="14.5" r="2.4" fill={color} />
        <rect x="1" y="10.5" width="19" height="2" rx="0.5" fill={color} />
        {/* Cylindrical tank body — a capsule sitting on the frame. */}
        <rect x="2.5" y="4.5" width="16" height="6.5" rx="3.25" fill={color} />
        <rect x="9" y="2.5" width="3" height="2.5" rx="0.5" fill={color} />
      </svg>
    )
  }
  if (style === 'container') {
    return (
      <svg width={WAGON_W} height={H} viewBox="0 0 21 18" fill="none" aria-hidden="true">
        <circle cx="6"  cy="14.5" r="2.4" fill={color} />
        <circle cx="15" cy="14.5" r="2.4" fill={color} />
        <rect x="1.5" y="4" width="18" height="8.5" rx="1" fill={color} />
        {/* Corrugation lines so the box reads as a shipping container. */}
        <rect x="6"  y="4.5" width="0.9" height="7.5" fill="#FFFFFF" opacity="0.35" />
        <rect x="10" y="4.5" width="0.9" height="7.5" fill="#FFFFFF" opacity="0.35" />
        <rect x="14" y="4.5" width="0.9" height="7.5" fill="#FFFFFF" opacity="0.35" />
      </svg>
    )
  }
  return (
    <svg width={WAGON_W} height={H} viewBox="0 0 21 18" fill="none" aria-hidden="true">
      <circle cx="6"  cy="14.5" r="2.4" fill={color} />
      <circle cx="15" cy="14.5" r="2.4" fill={color} />
      <rect x="1.5" y="4" width="18" height="8.5" rx="1.2" fill={color} />
    </svg>
  )
}

type Car = { kind: 'loco' | 'wagon'; color: string; w: number; gapBefore: number; wagonStyle?: WagonStyle }

export function LocomotiveProgress({ percent = 0, indeterminate = false, colors }: {
  percent?: number
  indeterminate?: boolean
  /** One color per loaded line type — that many locomotives lead the train. Empty/omitted
   *  falls back to a single brand-red loco, so the strip is never blank. */
  colors?: string[]
}) {
  // Clamped only for rendering; the caller's own value is never touched.
  const pct = Math.max(0, Math.min(100, percent))
  const livery = colors && colors.length > 0 ? colors : [RED]

  // Rolled ONCE per mount. Re-rolling on render would reshuffle the train mid-load. The
  // component remounts on each new loading phase (it lives under a `&&`), so a fresh
  // composition — variant, speed, wagon count/styles, spacing, shades, scenery, tunnel — is
  // drawn per load, not per frame.
  const roll = useRef(rollComposition()).current

  // Cars: the live locomotives (one per line type), then the rolled wagons.
  const cars: Car[] = [
    ...livery.map((color, i) => ({ kind: 'loco' as const, color, w: LOCO_W, gapBefore: i === 0 ? 0 : LOCO_GAP })),
    ...roll.wagons,
  ]
  // Cumulative px each car sits BEHIND the head — the argument to translateX.
  const offsets: number[] = []
  cars.reduce((acc, c, i) => (offsets[i] = i === 0 ? 0 : acc + cars[i - 1].w + c.gapBefore, offsets[i]), 0)

  // Full pixel length of the consist (head-left → tail-rear). The crossing keyframe runs the
  // head this far past the right edge so the LAST wagon fully clears the tunnel before reset.
  const last = cars.length - 1
  const trainLen = offsets[last] + cars[last].w + 10

  // Per-mount speed jitter (#4B): fast/normal/heavy freight, kept subtle.
  const runDur = roll.variant.dur * roll.speed

  const containerStyle = {
    position: 'relative', height: BAND_H, width: '100%', overflow: 'hidden',
    '--optv-end': `calc(100% + ${trainLen}px)`,
    ...(indeterminate && roll.variant.flip ? { transform: 'scaleX(-1)' } : null),
  } as React.CSSProperties

  return (
    <div style={containerStyle} aria-hidden="true">
      <style>{CSS}</style>

      {/* Themed horizon backdrop — a static, muted silhouette painted first so it sits UNDER
          the scenery and train (z 0). It sets the "place" (mountains, desert, ocean…) that the
          tunnel surface and trackside props are chosen to match. No animation, one SVG, free. */}
      <Backdrop theme={roll.theme} />

      {/* Sparse scenery — behind everything (z 0), static, low-contrast so it never competes
          with the train. Rolled per mount; often empty. */}
      {roll.scenery.map((s, i) => (
        <div key={`sc${i}`} style={{ position: 'absolute', bottom: 5, left: `${s.leftPct}%`, zIndex: 0, opacity: 0.4 }}>
          <Scenery kind={s.kind} />
        </div>
      ))}

      {/* Rail — darker steel grey; fills behind the train ONLY when there is a real percentage. */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, height: 2, borderRadius: 1, background: '#9AA0A8', zIndex: 1 }}>
        {!indeterminate && (
          <div style={{ height: '100%', width: `${pct}%`, background: RED, borderRadius: 1, transition: 'width 100ms linear' }} />
        )}
      </div>
      {/* Sleepers — a lightweight repeating tick pattern in a muted wooden-tie brown, no extra elements. */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, zIndex: 1,
        backgroundImage: 'repeating-linear-gradient(to right, #A98467 0 1px, transparent 1px 8px)',
      }} />

      {/* The train. Every car shares ONE head position and is pushed back by translateX, so the
          whole consist is rigid: determinate → head sits at the percentage; indeterminate → the
          keyframe drives the head (out to --optv-end) and the couplings follow, so each car
          slides under the tunnel and is occluded in turn. */}
      {cars.map((car, i) => (
        <div
          key={i}
          className={indeterminate ? roll.variant.cls : undefined}
          style={{
            position: 'absolute', bottom: 5, zIndex: 2,
            transform: `translateX(-${offsets[i]}px)`,
            ...(indeterminate
              ? { animationDuration: `${runDur}s` }   // keyframe owns `left`; only the speed is per-mount
              : { left: `calc(${pct}% - ${(pct / 100) * LOCO_W}px)`, transition: 'left 100ms linear' }),
          }}
        >
          {/* Subtle chimney smoke off the head loco only (#4E): 2 sparse puffs, no particle system. */}
          {i === 0 && (
            <>
              <span className="optv-smoke" style={{ position: 'absolute', left: LOCO_W - 3, top: -2, width: 3, height: 3, borderRadius: '50%', background: '#9CA3AF', animationDelay: '0s' }} />
              <span className="optv-smoke" style={{ position: 'absolute', left: LOCO_W - 3, top: -2, width: 3, height: 3, borderRadius: '50%', background: '#9CA3AF', animationDelay: '0.8s' }} />
            </>
          )}
          {car.kind === 'loco'
            ? <Locomotive color={car.color} />
            : <Wagon color={car.color} style={car.wagonStyle ?? 'box'} />}
        </div>
      ))}

      {/* Tunnel — TOP of the stack (z 3) and fully opaque, so any car sliding under it is
          occluded, and the container's overflow:hidden clips anything past the right edge. The
          portal is wider than a locomotive, so the whole nose disappears before the couplings
          reach it. Style (mountain / brick / industrial) is rolled per mount (#4A). */}
      <Tunnel style={roll.tunnel} />

      {/* "Carregando…" — in the free strip above the track. Renders in BOTH phases (the wave
          keyframe is always on), so the period fetch and the launch both show the same label.
          Per-letter wave; small and muted. */}
      <div className="optv-label" style={{
        position: 'absolute', top: 1, zIndex: 4, whiteSpace: 'nowrap',
        fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: '#4B5563',
        // The strip is mirrored (scaleX(-1)) in the flip variants, which relocates the tunnel to
        // the visual LEFT. Anchor the label past the tunnel's width and counter-flip it around its
        // CENTER (readable glyphs, box stays put) so the tunnel NEVER covers the text — the reported
        // right-to-left overlap. Non-flip keeps it hard-left; the tunnel is on the right, clear of it.
        ...(indeterminate && roll.variant.flip
          ? { right: TUNNEL_W + 4, transform: 'scaleX(-1)', transformOrigin: 'center' }
          : { left: 2 }),
      }}>
        {'Carregando…'.split('').map((ch, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.08}s` }}>{ch === ' ' ? ' ' : ch}</span>
        ))}
      </div>
    </div>
  )
}

/** One-shot random train + scenery composition. Pure; called once per mount. */
function rollComposition() {
  const variant = VARIANTS[Math.floor(Math.random() * VARIANTS.length)]

  // Subtle speed jitter around the base duration: fast freight ↔ heavy freight (#4B).
  const speed = 0.82 + Math.random() * 0.5   // 0.82…1.32× base duration

  const wagonCount = Math.floor(Math.random() * 5)   // 0…4
  const wagons: Car[] = Array.from({ length: wagonCount }, () => ({
    kind: 'wagon' as const,
    color: WAGON_SHADES[Math.floor(Math.random() * WAGON_SHADES.length)],
    w: WAGON_W,
    gapBefore: 3 + Math.floor(Math.random() * 4),     // 3…6 px — subtle spacing variation
    wagonStyle: rollWagonStyle(),
  }))

  // A single scene theme drives the backdrop silhouette, the tunnel surface AND which trackside
  // props appear — so the strip reads as one coherent place instead of a random mix (no cacti
  // next to a brick tunnel). Rolled once per mount, exactly like everything else here.
  const themeName = THEME_NAMES[Math.floor(Math.random() * THEME_NAMES.length)]
  const theme = THEMES[themeName]

  // 3–5 scenery pieces, always at least three. Positions are slotted: the left ~78% (clear of
  // the tunnel) is split into `count` even bands and each piece is jittered within its own band,
  // so more props never means them stacking on top of each other — still reads as sparse. Kinds
  // are drawn from the theme's own set so the props belong to the scene.
  const sceneryCount = 3 + Math.floor(Math.random() * 3)   // 3…5
  const band = 78 / sceneryCount
  const scenery = Array.from({ length: sceneryCount }, (_, i) => ({
    kind: theme.scenery[Math.floor(Math.random() * theme.scenery.length)],
    leftPct: Math.round(6 + i * band + Math.random() * (band * 0.6)),
  }))

  return { variant, speed, wagons, scenery, tunnel: theme.tunnel, theme: themeName }
}

/** Mostly plain boxcars; a special wagon turns up ~1 in 5 (#4D). */
function rollWagonStyle(): WagonStyle {
  const r = Math.random()
  if (r < 0.1) return 'tank'
  if (r < 0.2) return 'container'
  return 'box'
}

// ── Scene themes ────────────────────────────────────────────────────────────────
// Each theme bundles a muted backdrop tint, the tunnel surface that fits it, and the
// trackside prop set that belongs to it. Rolled once per mount in rollComposition so the
// whole strip (backdrop + tunnel + scenery) shares one setting. Tints are soft and the
// backdrop is rendered at low opacity, so the colored (information-bearing) locomotives
// always stay the focal point.
//
// `mountains` is the one that produced the reported white line, and it is STILL HERE. Its
// ridge is the only silhouette with repeated high peaks across the full width (apexes at
// y=4…9 of a 24-unit viewBox) and `preserveAspectRatio="none"` stretches them flat, so it was
// the theme that reached the "Carregando…" label first — but the drawing was never the fault.
// The Backdrop BOX was too tall (see the note there); with it capped, this ridge lands well
// below the text, so the art is kept exactly as it was rather than flattened to dodge a
// geometry bug.
type Theme = 'mountains' | 'desert' | 'forest' | 'ocean' | 'industrial' | 'canyon'
const THEME_NAMES: Theme[] = ['mountains', 'desert', 'forest', 'ocean', 'industrial', 'canyon']
const THEMES: Record<Theme, { tint: string; tunnel: TunnelStyle; scenery: SceneryKind[] }> = {
  mountains:  { tint: '#B6BCC6', tunnel: 'mountain',   scenery: ['tree', 'rock', 'pole'] },
  desert:     { tint: '#E0C9A6', tunnel: 'brick',      scenery: ['rock', 'marker', 'barrel'] },
  forest:     { tint: '#A7C4A0', tunnel: 'mountain',   scenery: ['tree', 'bush', 'grass'] },
  ocean:      { tint: '#A9C7D9', tunnel: 'mountain',   scenery: ['pole', 'marker', 'rock'] },
  industrial: { tint: '#B0B4BA', tunnel: 'industrial', scenery: ['pole', 'barrel', 'sign'] },
  canyon:     { tint: '#D2A679', tunnel: 'brick',      scenery: ['rock', 'marker'] },
}

/** Static themed horizon silhouette behind the train. ONE stretched SVG (preserveAspectRatio
 *  none → fills the strip width), no animation, no images — negligible cost. One path per theme
 *  in the theme tint, no second fill anywhere: a lighter accent on top of a silhouette is what
 *  produced the white-streak report. Muted via the wrapper opacity so it never competes with
 *  the consist. */
function Backdrop({ theme }: { theme: Theme }) {
  const t = THEMES[theme].tint
  return (
    // HEIGHT IS AN INVARIANT, NOT A LOOK. The band is BAND_H (30px) tall and the "Carregando…"
    // label sits at top:1 with a ~13px line box, so anything painted above y=14 lands behind the
    // text. This box is bottom-anchored 4px up, so `height` is the only thing deciding how far up
    // it can reach: 30 − 4 − 12 = 14. At the old 20 it started at y=6, straight through the label,
    // and any theme whose silhouette rose into its own top third drew a pale streak across the
    // loading text — `mountains` did it worst, which is why it got blamed. Flattening that ridge
    // would fix one drawing and leave the next one to be found the same way; capping the BOX fixes
    // the class, so every theme keeps its full artwork. Do not grow it past 12 without moving
    // the label.
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, height: 12, zIndex: 0, opacity: 0.5, pointerEvents: 'none' }}>
      <svg width="100%" height="100%" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        {/* One path, no second fill: the snow caps this ridge used to carry were a near-white
            accent stretched into a streak, and deleting them was the earlier (partial) fix. */}
        {theme === 'mountains' && (
          <path d="M0,24 L15,8 L22,14 L38,4 L50,14 L62,6 L78,16 L88,9 L100,24 Z" fill={t} />
        )}
        {theme === 'desert' && (
          <path d="M0,24 Q25,10 50,18 T100,16 L100,24 Z" fill={t} />
        )}
        {theme === 'forest' && (
          <path d="M0,24 Q20,8 40,20 Q60,6 80,20 Q90,12 100,22 L100,24 Z" fill={t} />
        )}
        {theme === 'ocean' && (
          <path d="M0,15 Q10,12 20,15 T40,15 T60,15 T80,15 T100,15 L100,24 L0,24 Z" fill={t} />
        )}
        {theme === 'industrial' && (
          <path d="M0,24 L0,16 L14,16 L14,10 L28,10 L28,16 L46,16 L46,7 L52,7 L52,16 L70,16 L70,12 L86,12 L86,16 L100,16 L100,24 Z" fill={t} />
        )}
        {theme === 'canyon' && (
          <path d="M0,24 L0,14 L20,14 L20,20 L34,20 L34,9 L54,9 L54,18 L70,18 L70,13 L90,13 L90,24 Z" fill={t} />
        )}
      </svg>
    </div>
  )
}

type TunnelStyle = 'mountain' | 'brick' | 'industrial'

/** Portal at the far edge. All variants keep the same opaque footprint so occlusion/clipping
 *  is identical — only the surface treatment changes (#4A). */
function Tunnel({ style }: { style: TunnelStyle }) {
  const outerR = style === 'industrial' ? 2 : TUNNEL_W / 2
  const innerR = style === 'industrial' ? 1 : (TUNNEL_W - 8) / 2
  return (
    <div style={{
      position: 'absolute', right: 0, bottom: 4, zIndex: 3,
      width: TUNNEL_W, height: BAND_H - 6,
      borderRadius: `${outerR}px ${outerR}px 0 0`,
      background: style === 'industrial' ? '#6B7280' : '#9CA3AF',
      // Brick courses as a faint horizontal repeat; mountain/industrial leave it flat.
      ...(style === 'brick'
        ? { backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 3px, rgba(255,255,255,0.25) 3px 4px)' }
        : null),
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
    }}>
      {/* Mountain hump behind the arch — a lighter rounded shoulder for a bit of relief. */}
      {style === 'mountain' && (
        <div style={{
          position: 'absolute', top: -4, left: -6, width: TUNNEL_W + 12, height: BAND_H,
          borderRadius: '50% 50% 0 0', background: '#B6BCC6', zIndex: -1,
        }} />
      )}
      <div style={{
        width: TUNNEL_W - 8, height: BAND_H - 14,
        borderRadius: `${innerR}px ${innerR}px 0 0`,
        background: '#4B5563',
      }} />
    </div>
  )
}

type SceneryKind = 'tree' | 'sign' | 'marker' | 'bush' | 'rock' | 'pole' | 'barrel' | 'grass'

/** Tiny, muted trackside props. Purely decorative; all share the one greyscale tone. */
function Scenery({ kind }: { kind: SceneryKind }) {
  const C = '#9CA3AF'
  switch (kind) {
    case 'tree':
      return (
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none" aria-hidden="true">
          <rect x="4" y="9" width="2" height="5" fill={C} />
          <path d="M5 0 L9 9 H1 Z" fill={C} />
        </svg>
      )
    case 'sign':
      return (
        <svg width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="1.5" height="10" fill={C} />
          <rect x="0.5" y="1" width="8" height="4" rx="0.8" fill={C} />
        </svg>
      )
    case 'bush':
      return (
        <svg width="12" height="9" viewBox="0 0 12 9" fill="none" aria-hidden="true">
          <circle cx="3.5" cy="6" r="3" fill={C} />
          <circle cx="7"   cy="4.5" r="3.5" fill={C} />
          <circle cx="9.5" cy="6.5" r="2.5" fill={C} />
        </svg>
      )
    case 'rock':
      return (
        <svg width="11" height="7" viewBox="0 0 11 7" fill="none" aria-hidden="true">
          <path d="M1 7 L2.5 2.5 L5 1 L8 2 L10 7 Z" fill={C} />
        </svg>
      )
    case 'pole':
      return (
        <svg width="8" height="15" viewBox="0 0 8 15" fill="none" aria-hidden="true">
          <rect x="3.4" y="1" width="1.2" height="14" fill={C} />
          <rect x="0.5" y="3" width="7" height="1.2" fill={C} />
          <rect x="1.5" y="5" width="5" height="1" fill={C} />
        </svg>
      )
    case 'barrel':
      return (
        <svg width="7" height="11" viewBox="0 0 7 11" fill="none" aria-hidden="true">
          <rect x="0.8" y="1" width="5.4" height="9" rx="1.4" fill={C} />
          <rect x="0.8" y="3.5" width="5.4" height="0.9" fill="#F3F4F6" opacity="0.6" />
          <rect x="0.8" y="6.5" width="5.4" height="0.9" fill="#F3F4F6" opacity="0.6" />
        </svg>
      )
    case 'grass':
      return (
        <svg width="10" height="7" viewBox="0 0 10 7" fill="none" aria-hidden="true">
          <path d="M2 7 Q1 3 3 0" stroke={C} strokeWidth="1" fill="none" />
          <path d="M5 7 L5 1" stroke={C} strokeWidth="1" fill="none" />
          <path d="M8 7 Q9 3 7 0" stroke={C} strokeWidth="1" fill="none" />
        </svg>
      )
    case 'marker':
    default:
      return (
        <svg width="4" height="12" viewBox="0 0 4 12" fill="none" aria-hidden="true">
          <rect x="1" y="2" width="2" height="10" fill={C} />
          <circle cx="2" cy="2" r="2" fill={C} />
        </svg>
      )
  }
}
