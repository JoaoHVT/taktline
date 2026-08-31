'use client'
import Image from 'next/image'
import { useEffect, useState } from 'react'
import { Boxes, CalendarDays, KeyRound, LogOut, Plus, Power, Truck, Users } from 'lucide-react'
import { DenodoModal } from '@/components/DenodoModal'
import { LogisticaModal } from '@/components/LogisticaModal'
import { MateriaisModal } from '@/components/MateriaisModal'
import { HomeShowcase } from '@/components/HomeShowcase'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ManageUsersModal } from '@/components/ManageUsersModal'
import { ManageCalendarModal } from '@/components/ManageCalendarModal'
import { ServerControlModal } from '@/components/ServerControlModal'
import { ChangePasswordModal } from '@/components/ChangePasswordModal'
import { AdminAlertsBell } from '@/components/AdminAlertsBell'
import { OnlineUsersBadge } from '@/components/OnlineUsersBadge'
import { useAuth } from '@/hooks/useAuth'
import { usePermissions } from '@/context/PermissionsContext'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  onOpenAnalise: () => void
  onOpenGantt:   () => void
}

// ── The classic split Home ────────────────────────────────────────────────────
//
// Two photographic halves, a centre divider, a stack of feature bullets per side, and a toggle
// that switched to the (then experimental) showcase. The showcase is now THE Home tab, so none of
// this renders — but it is kept, commented, exactly as it was, so the old view can be brought
// back by uncommenting this block, re-adding the `Sparkles` icon and the `homePrefs` store
// (`getHomeShowcase` / `setHomeShowcase` / `subscribeHomeShowcase` / `homeShowcaseServerSnapshot`,
// still present in lib/homePrefs.ts), and rendering <HomeViewClassic/> behind the toggle again.
// The showcase's own "Visual clássico" button is commented out in HomeShowcase.tsx for the same
// reason and comes back with it.
//
// ── Feature bullet ────────────────────────────────────────────────────────────
//
// function FeatureDot({ text }: { text: string }) {
//   return (
//     <li className="flex items-start gap-2 text-sm leading-snug text-white/90">
//       <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/70" />
//       {text}
//     </li>
//   )
// }
//
// ── App card overlay ──────────────────────────────────────────────────────────
//
// interface AppCardProps {
//   side:         'left' | 'right'
//   title:        string
//   subtitle:     string
//   features:     string[]
//   emphasis:     string
//   hovered:      boolean
//   dimmed:       boolean
//   onMouseEnter: () => void
//   onMouseLeave: () => void
//   onClick:      () => void
// }
//
// function AppCard({
//   side, title, subtitle, features, emphasis,
//   hovered, dimmed, onMouseEnter, onMouseLeave, onClick,
// }: AppCardProps) {
//   const isLeft = side === 'left'
//   const accentColor = isLeft ? '#f87171' : '#4ade80'
//
//   return (
//     <div
//       role="button"
//       tabIndex={0}
//       aria-label={`Abrir ${title}`}
//       onMouseEnter={onMouseEnter}
//       onMouseLeave={onMouseLeave}
//       onClick={onClick}
//       onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
//       className="relative flex-1 flex flex-col items-center justify-end cursor-pointer select-none outline-none"
//       style={{ height: '100%' }}
//     >
//       {/* Side-tinted overlay — darker when the OTHER side is hovered */}
//       <div
//         className="absolute inset-0 transition-all duration-500"
//         style={{
//           background: isLeft
//             ? hovered
//               ? 'linear-gradient(to bottom, rgba(10,20,40,0.15) 0%, rgba(10,20,40,0.68) 50%, rgba(10,20,40,0.90) 100%)'
//               : dimmed
//                 ? 'linear-gradient(to bottom, rgba(10,20,40,0.50) 0%, rgba(10,20,40,0.80) 55%, rgba(10,20,40,0.95) 100%)'
//                 : 'linear-gradient(to bottom, rgba(10,20,40,0.15) 0%, rgba(10,20,40,0.55) 55%, rgba(10,20,40,0.85) 100%)'
//             : hovered
//               ? 'linear-gradient(to bottom, rgba(5,30,15,0.15) 0%, rgba(5,30,15,0.68) 50%, rgba(5,30,15,0.90) 100%)'
//               : dimmed
//                 ? 'linear-gradient(to bottom, rgba(5,30,15,0.50) 0%, rgba(5,30,15,0.80) 55%, rgba(5,30,15,0.95) 100%)'
//                 : 'linear-gradient(to bottom, rgba(5,30,15,0.15) 0%, rgba(5,30,15,0.55) 55%, rgba(5,30,15,0.85) 100%)',
//         }}
//       />
//
//       {/* Content card at bottom */}
//       <div
//         className="relative z-10 w-full px-8 pb-12"
//         style={{ maxWidth: 520 }}
//       >
//         {/* Title */}
//         <h2
//           className="text-3xl font-bold tracking-tight transition-all duration-300"
//           style={{
//             color: hovered ? accentColor : '#fff',
//             textShadow: hovered
//               ? `0 0 30px ${isLeft ? 'rgba(239,68,68,0.55)' : 'rgba(34,197,94,0.55)'}, 0 2px 14px rgba(0,0,0,0.8)`
//               : '0 2px 12px rgba(0,0,0,0.7)',
//           }}
//         >
//           {title}
//         </h2>
//
//         {/* Subtitle */}
//         <p className="mt-1 text-sm font-medium text-white/60 uppercase tracking-widest">
//           {subtitle}
//         </p>
//
//         {/* Divider */}
//         <div
//           className="my-4 h-px transition-all duration-300"
//           style={{
//             background: isLeft
//               ? 'linear-gradient(to right, #ef4444, transparent)'
//               : 'linear-gradient(to right, #22c55e, transparent)',
//             width: hovered ? '80%' : '40%',
//           }}
//         />
//
//         {/* Feature list */}
//         <ul
//           className="space-y-1.5 transition-all duration-300 overflow-hidden"
//           style={{ maxHeight: hovered ? 200 : 120, opacity: hovered ? 1 : 0.75 }}
//         >
//           {features.map((f, i) => <FeatureDot key={i} text={f} />)}
//         </ul>
//
//         {/* Emphasis tag */}
//         <div
//           className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider transition-all duration-300"
//           style={{
//             background: isLeft
//               ? hovered ? 'rgba(239,68,68,0.9)' : 'rgba(239,68,68,0.55)'
//               : hovered ? 'rgba(34,197,94,0.9)'  : 'rgba(34,197,94,0.55)',
//             color: '#fff',
//             boxShadow: hovered ? '0 0 16px rgba(0,0,0,0.4)' : 'none',
//           }}
//         >
//           <span
//             className="h-1.5 w-1.5 rounded-full bg-white"
//             style={{ animation: hovered ? 'pulse 1.5s infinite' : 'none' }}
//           />
//           {emphasis}
//         </div>
//       </div>
//     </div>
//   )
// }
//
// ── Divider center line ───────────────────────────────────────────────────────
//
// function CenterDivider() {
//   return (
//     <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center pointer-events-none">
//       <div className="w-px flex-1 bg-white/20" />
//       <div
//         className="my-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm"
//         style={{ border: '1px solid rgba(255,255,255,0.2)' }}
//       >
//         <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
//           <circle cx="6" cy="6" r="3" fill="rgba(255,255,255,0.7)" />
//         </svg>
//       </div>
//       <div className="w-px flex-1 bg-white/20" />
//     </div>
//   )
// }
//
// ── The classic view itself ───────────────────────────────────────────────────
//
// function HomeViewClassic({ onOpenAnalise, onOpenGantt, onPickShowcase }: Props & { onPickShowcase: () => void }) {
//   const [hovered, setHovered] = useState<'left' | 'right' | null>(null)
//
//   return (
//     <>
//       {/* ── Left background half — always shows the left (desert) scene ──── */}
//       <div className="absolute left-0 top-0 h-full overflow-hidden" style={{ width: '50%' }}>
//         <div
//           className="absolute inset-0"
//           style={{
//             backgroundImage: "url('/imagens/LeftBack1.webp')",
//             backgroundSize: 'cover',
//             backgroundPosition: 'left center',
//             backgroundRepeat: 'no-repeat',
//             transform: hovered === 'left' ? 'scale(1.05)' : 'scale(1)',
//             transformOrigin: 'right center',
//             transition: 'transform 0.6s ease',
//           }}
//         />
//       </div>
//
//       {/* ── Right background half — always shows the right (green) scene ─── */}
//       <div className="absolute right-0 top-0 h-full overflow-hidden" style={{ width: '50%' }}>
//         <div
//           className="absolute inset-0"
//           style={{
//             backgroundImage: "url('/imagens/RightBack2.webp')",
//             backgroundSize: 'cover',
//             backgroundPosition: 'right center',
//             backgroundRepeat: 'no-repeat',
//             transform: hovered === 'right' ? 'scale(1.05)' : 'scale(1)',
//             transformOrigin: 'left center',
//             transition: 'transform 0.6s ease',
//           }}
//         />
//       </div>
//
//       {/* ── Base dark vignette ───────────────────────────────────── */}
//       <div
//         className="absolute inset-0 z-[1]"
//         style={{
//           background: 'radial-gradient(ellipse at center top, transparent 30%, rgba(0,0,0,0.35) 100%)',
//         }}
//       />
//
//       {/* ── Split interactive zones ──────────────────────────────── */}
//       <div className="absolute inset-0 z-[2] flex">
//         <AppCard
//           side="left"
//           title="Análise de Capacidade"
//           subtitle="Capacity Analysis"
//           features={[
//             'Análise de gargalos e capacidade produtiva',
//             'Mapeamento de itens e operações por WSN',
//             'Acompanhamento semanal de performance',
//           ]}
//           emphasis="Foco: Alocação otimizada de pessoas"
//           hovered={hovered === 'left'}
//           dimmed={hovered === 'right'}
//           onMouseEnter={() => setHovered('left')}
//           onMouseLeave={() => setHovered(null)}
//           onClick={onOpenAnalise}
//         />
//
//         <AppCard
//           side="right"
//           title="Carga de Fábrica"
//           subtitle="Factory Load & Master Schedule"
//           features={[
//             'Resumo geral e planejamento de capacidade',
//             'Mapeamento de volume e carga da fábrica',
//             'Visão geral do Schedule em Gantt',
//           ]}
//           emphasis="Foco: Otimização do Master Schedule"
//           hovered={hovered === 'right'}
//           dimmed={hovered === 'left'}
//           onMouseEnter={() => setHovered('right')}
//           onMouseLeave={() => setHovered(null)}
//           onClick={onOpenGantt}
//         />
//       </div>
//
//       {/* ── Center divider ───────────────────────────────────────── */}
//       <CenterDivider />
//
//       {/* ── Top header bar ───────────────────────────────────────── */}
//       <header className="absolute top-0 left-0 right-0 z-30 flex flex-col items-center pt-8 pb-5 pointer-events-none">
//         {/* Logo */}
//         <div
//           className="flex items-center justify-center rounded-xl p-2.5 mb-3"
//           style={{
//             background: 'rgba(0,0,0,0.45)',
//             backdropFilter: 'blur(12px)',
//             border: '1px solid rgba(255,255,255,0.12)',
//             boxShadow: '0 4px 30px rgba(0,0,0,0.5)',
//           }}
//         >
//           <Image
//             src="/imagens/wab1.png"
//             alt="OptVision logo"
//             width={52}
//             height={52}
//             className="object-contain"
//           />
//         </div>
//
//         {/* Title */}
//         <div className="text-center">
//           <h1
//             className="text-2xl font-extrabold tracking-widest uppercase"
//             style={{
//               color: '#fff',
//               textShadow: '0 2px 20px rgba(0,0,0,0.9), 0 0 60px rgba(211,47,47,0.3)',
//               letterSpacing: '0.18em',
//             }}
//           >
//             OptVision
//           </h1>
//           <p
//             className="text-xs font-semibold tracking-[0.22em] uppercase mt-0.5"
//             style={{ color: '#fff', textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}
//           >
//             Wabtec Optimization Tool
//           </p>
//         </div>
//
//         {/* Instruction hint */}
//         <p
//           className="mt-5 text-sm font-bold tracking-[0.28em] uppercase"
//           style={{
//             color: 'rgba(255,255,255,0.82)',
//             textShadow: '0 1px 12px rgba(0,0,0,0.95), 0 0 40px rgba(0,0,0,0.7)',
//             letterSpacing: '0.28em',
//           }}
//         >
//           Selecione uma aplicação
//         </p>
//       </header>
//
//       {/* ── Switch to the experimental showcase view ──────────────── */}
//       <button
//         type="button"
//         onClick={onPickShowcase}
//         className="absolute top-6 left-6 z-40 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white/85 transition-all duration-300 hover:text-white hover:scale-105"
//         style={GLASS}
//       >
//         <Sparkles size={14} strokeWidth={2} />
//         Novo visual
//       </button>
//     </>
//   )
// }

// ── Extras cluster (top-right) ────────────────────────────────────────────────
// TWO controls side by side, each expanding downward into its own stack:
//
//   • the initials bubble — identity: the admin actions (usuários, calendário, servidor) and
//     "Sair". Home has no header, so without this the only way to reach any of them was to
//     enter an app first.
//   • "+" — the secondary entry points (Denodo, Materiais, Logística) that used to sit loose
//     along the bottom edge, Denodo pinned bottom-left and the other two stacked bottom-right.
//
// They were briefly ONE control, with the profile folded into the "+" menu. Split back apart:
// "who am I / let me out" and "what else can I open" are different questions, and answering both
// from one button made a menu long enough that the identity row read as another feature.
//
// Only one may be open at a time (the cluster owns that state, not the columns), which is also
// what keeps the two stacks from being drawn over each other.

const GLASS = {
  background: 'rgba(0,0,0,0.45)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.14)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
} as const

/** First + last initial; a single-word name falls back to its first two letters. Same rule as
 *  AppHeader's avatar, so the bubble reads identically in both places. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
  }
  return (parts[0] ?? '').slice(0, 2).toUpperCase()
}

/** First + last name, both whole words — never truncated mid-word. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length <= 2) return name
  return `${parts[0]} ${parts[parts.length - 1]}`
}

interface MenuItem {
  key:      string
  label:    string
  icon:     React.ReactNode
  onClick:  () => void
  /** Red hover treatment — used by "Sair" only. */
  danger?:  boolean
}

/** One 50×50 glass button and the stack it expands into.
 *
 *  The stack is ABSOLUTELY positioned under the button and right-aligned to it, so an open menu
 *  never changes the cluster's layout: the labels grow leftward into empty screen instead of
 *  widening the column and shoving the sibling button sideways. */
function MenuColumn({ children, title, open, onToggle, items, head, overlay }: {
  /** Button face — the "+" glyph or the initials bubble. */
  children: React.ReactNode
  title:    string
  open:     boolean
  onToggle: () => void
  items:    MenuItem[]
  /** Optional non-interactive first row (the identity label), slot 0 of the stagger. A render
   *  function, not a node: it receives the fade style and MUST spread it onto the glass pane
   *  itself rather than a wrapper — see the Backdrop Root note on `paneFade`. */
  head?:    (fade: React.CSSProperties) => React.ReactNode
  /** Badges pinned over the button's corners. Rendered as the button's SIBLING, never inside it:
   *  they are controls of their own (each opens a panel), and an interactive element nested in a
   *  <button> is both invalid and unclickable — the click would toggle this menu instead. The
   *  wrapper is exactly the button's box, so `-top-1.5 -left-1.5` lands where it does in
   *  AppHeader. */
  overlay?: React.ReactNode
}) {
  const offset = head ? 1 : 0
  const total  = items.length + offset
  const [hover, setHover] = useState<string | null>(null)
  // A row closed while lit would come back lit on the next open: the stack is never
  // unmounted, so there is no remount to clear the state for us.
  useEffect(() => { if (!open) setHover(null) }, [open])

  // Opening runs top-down (the entry nearest the button first), closing bottom-up, so the stack
  // reads as growing out of the button and folding back into it.
  const delay = (i: number) => `${(open ? i : total - 1 - i) * 45}ms`

  // THE FADE AND THE MOVE ARE ON DIFFERENT ELEMENTS, and that split is the whole point.
  //
  // Every row is built from glass panes — `backdrop-filter: blur(12px)` over the showcase. Per
  // Filter Effects 2, an ancestor with `opacity < 1` becomes the Backdrop Root, so while a row
  // faded in, its panes were blurring an EMPTY backdrop: flat charcoal for the length of the
  // transition, then the real blur snapping in the frame opacity reached 1. That snap is the
  // flash — panes reading "more or less opaque" on the way in.
  //
  // Opacity on the pane ITSELF does not create that root (only ancestors do), so the blur keeps
  // sampling the page the whole way and the fade is continuous. Hence: transform on the row,
  // opacity on the panes, never opacity on anything that CONTAINS a pane.
  const rowMotion = (i: number): React.CSSProperties => ({
    transform: open ? 'translateY(0)' : 'translateY(-14px) scale(0.85)',
    pointerEvents: open ? 'auto' : 'none',
    transition: 'transform 300ms ease',
    transitionDelay: delay(i),
  })

  // Hover affordance. Until now only "Sair" reacted to the pointer, because its red text has a
  // `group-hover` shade and the white entries have nothing to brighten to — so every other entry
  // read as a label rather than a button. The lift belongs to the PANES, not to the row: the row
  // already owns `transform` for the stagger, and stealing it for hover would make the hover
  // inherit the stagger's delay (up to 180ms of lag on the bottom entry).
  //
  // Panes may take their own transform — only an ANCESTOR transform breaks a child's
  // backdrop-filter in Chrome, and here the scale sits on the blurred element itself.
  //
  // Per-property durations are spelled out in one shorthand because the fade keeps the stagger
  // delay while the hover response must be immediate; a single `transitionDelay` would apply to
  // both.
  const paneStyle = (i: number, hot: boolean): React.CSSProperties => ({
    ...GLASS,
    background:  hot ? 'rgba(0,0,0,0.68)'             : 'rgba(0,0,0,0.45)',
    border:      hot ? '1px solid rgba(255,255,255,0.34)' : '1px solid rgba(255,255,255,0.14)',
    boxShadow:   hot ? '0 6px 28px rgba(0,0,0,0.62)'  : '0 4px 24px rgba(0,0,0,0.5)',
    transform:   hot ? 'scale(1.05)' : 'scale(1)',
    opacity: open ? 1 : 0,
    transition:
      `opacity 300ms ease ${delay(i)}, background-color 160ms ease, ` +
      'border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
  })

  // The head pane is decorative (it is the identity label, not a control), so it never lights up.
  const paneFade = (i: number): React.CSSProperties => paneStyle(i, false)

  return (
    <div className="relative">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-[50px] w-[50px] items-center justify-center rounded-xl transition-all duration-300 hover:scale-105"
        style={GLASS}
      >
        {children}
      </button>
      {overlay}

      {/* The CLOSED stack still occupies its box: the rows are only faded out (opacity 0), never
          unmounted, because they have to be there for the stagger to have something to animate.
          That box is what made the "+" column swallow clicks aimed at the identity column's top
          entries — it is drawn after its sibling, right-aligned, and wide enough to reach across.
          `pointerEvents` on the CONTAINER is the fix; per-row values alone cannot help, because
          the container's own box is what receives the click. */}
      <div
        className="absolute right-0 top-[60px] flex flex-col items-end gap-2.5"
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      >
        {head && (
          <div className="flex items-center" style={rowMotion(0)}>
            {head(paneFade(0))}
          </div>
        )}
        {items.map((x, i) => {
          // Keyboard focus lights the row too: the entries are reachable by Tab while the menu is
          // open, and a focus ring alone on a glass pane is nearly invisible over the showcase.
          const hot = hover === x.key
          return (
            <button
              key={x.key}
              type="button"
              aria-label={x.label}
              tabIndex={open ? 0 : -1}
              onClick={() => { onToggle(); x.onClick() }}
              onPointerEnter={() => setHover(x.key)}
              onPointerLeave={() => setHover(h => (h === x.key ? null : h))}
              onFocus={() => setHover(x.key)}
              onBlur={() => setHover(h => (h === x.key ? null : h))}
              className="group flex items-center gap-2.5 outline-none"
              style={rowMotion(i + offset)}
            >
              <span
                className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold ${
                  x.danger ? 'text-red-300 group-hover:text-red-200' : 'text-white'
                }`}
                style={paneStyle(i + offset, hot)}
              >
                {x.label}
              </span>
              <span
                className="flex h-[50px] w-[50px] items-center justify-center rounded-xl"
                style={paneStyle(i + offset, hot)}
              >
                {x.icon}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ExtrasCluster({ userItems, plusItems }: { userItems: MenuItem[]; plusItems: MenuItem[] }) {
  // ONE piece of state for both columns: opening either closes the other, so the two stacks are
  // never drawn over one another and Escape/click-away have a single thing to clear.
  const [openKey, setOpenKey] = useState<'user' | 'plus' | null>(null)
  const { currentUser } = useAuth()
  const { role, canManageUsers } = usePermissions()

  useEffect(() => {
    if (!openKey) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenKey(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openKey])

  const roleColor = role === 'admin' ? '#D32F2F' : role === 'editor' ? '#D97706' : '#9CA3AF'
  const roleLabel = role === 'admin' ? 'Administrador' : role === 'editor' ? 'Editor' : 'Leitor'
  const userOpen = openKey === 'user'

  const toggle = (k: 'user' | 'plus') => () => setOpenKey(cur => (cur === k ? null : k))

  return (
    <>
      {/* Click-away. Only mounted while a column is open, so it never intercepts the two app
          cards during normal use. Sits just under the cluster's own tier. */}
      {openKey && (
        <div className="fixed inset-0 z-[39]" onClick={() => setOpenKey(null)} aria-hidden />
      )}

      {/* Top-right. It used to sit bottom-right, where it landed on top of the showcase's own
          "Abrir" button. `items-start` keeps both buttons on the top line whatever their open
          stacks do — the stacks are out of flow (see MenuColumn). */}
      <div className="absolute top-5 right-5 z-40 flex items-start gap-2.5">
        {/* Identity — admin actions + Sair. Left of the "+", which keeps its corner. */}
        {currentUser && (
          <MenuColumn
            title={`${currentUser.email} — conta e administração`}
            open={userOpen}
            onToggle={toggle('user')}
            items={userItems}
            head={(fade) => (
              <span
                className="flex flex-col items-end whitespace-nowrap rounded-md px-2.5 py-1 text-white"
                style={{ ...GLASS, ...fade }}
                title={currentUser.email}
              >
                <span className="text-xs font-semibold leading-tight">{shortName(currentUser.name)}</span>
                {/* Grey "Leitor" is also what an UNRESOLVED role looks like, so this line and the
                    bubble below both re-colour the moment /api/permissions/me answers. The colour
                    is tweened rather than swapped: an abrupt grey→red on a name is read as a state
                    change in the system, not as a lookup that finished. */}
                <span
                  className="text-[10px] font-medium leading-tight transition-colors duration-500"
                  style={{ color: roleColor }}
                >
                  {roleLabel}
                </span>
              </span>
            )}
            overlay={
              // Mounted ONLY while this column is open: each badge polls the backend, and AppHeader
              // already keeps a permanently-mounted copy per app, so leaving a third alive behind a
              // closed menu would be pure extra traffic.
              userOpen && canManageUsers ? <><AdminAlertsBell /><OnlineUsersBadge /></> : null
            }
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full select-none transition-colors duration-500"
              style={{ backgroundColor: roleColor }}
            >
              <span className="text-white text-xs font-bold leading-none">
                {initialsOf(currentUser.name)}
              </span>
            </span>
          </MenuColumn>
        )}

        {/* Extra entry points. Unchanged role: Denodo, Materiais, Logística. */}
        <MenuColumn
          title="Mais opções"
          open={openKey === 'plus'}
          onToggle={toggle('plus')}
          items={plusItems}
        >
          {/* One icon, rotated — a "+" turning into an "×" is the affordance itself. */}
          <Plus
            size={28}
            strokeWidth={1.8}
            className="text-white/90 transition-transform duration-300"
            style={{ transform: openKey === 'plus' ? 'rotate(45deg)' : 'rotate(0deg)' }}
          />
        </MenuColumn>
      </div>
    </>
  )
}

// ── HomeView ──────────────────────────────────────────────────────────────────
// The showcase is the Home tab now: there is no toggle and no stored preference, only this view
// plus the extras cluster and the modals reachable from it.

export function HomeView({ onOpenAnalise, onOpenGantt }: Props) {
  const [denodoOpen,         setDenodoOpen]         = useState(false)
  const [logisticaOpen,      setLogisticaOpen]      = useState(false)
  const [materiaisOpen,      setMateriaisOpen]      = useState(false)
  const [showManageUsers,    setShowManageUsers]    = useState(false)
  const [showManageCalendar, setShowManageCalendar] = useState(false)
  const [showServerControl,  setShowServerControl]  = useState(false)
  const [confirmLogout,      setConfirmLogout]      = useState(false)
  const [showChangePw,       setShowChangePw]       = useState(false)

  const { isAuthenticated, tokenReady, currentUser, logout } = useAuth()
  const { canManageUsers } = usePermissions()

  // Every modal reachable from this view is drawn ON TOP of the showcase, and none of them is
  // opaque enough to hide it. A scene that re-tilts and re-lights itself under a Denodo grid is
  // motion competing with the thing being read, so the cursor stops driving it while one is open
  // — but only the cursor. The ambient life (breathing, the load swinging on the hook) keeps
  // running: stopping that too reads as the page having hung, which is the worse artefact.
  const modalOpen =
    denodoOpen || logisticaOpen || materiaisOpen ||
    showManageUsers || showManageCalendar || showServerControl || confirmLogout || showChangePw

  // The showcase must not react to the pointer while the LoginModal is up. That modal is a 60%
  // scrim, so Home is visible behind it — a scene tilting under a cursor that cannot click
  // anything reads as a live app the user is locked out of. `interactive` holds pointer
  // tracking, the idle breathing and the hoist at rest and defers the light sweep, so the
  // sweep lands as the arrival after login instead of playing to a login screen.
  //
  // An open modal is deliberately NOT folded in here: that is a narrower hold (`trackPointer`),
  // because the login case wants the whole view still and this one only wants the cursor out.
  const interactive = isAuthenticated && tokenReady !== 'reauth-required'

  // Behind the initials bubble: who you are and what you can do to the system.
  const userItems: MenuItem[] = [
    ...(canManageUsers ? [
      {
        key: 'usuarios',
        label: 'Gerenciar Usuários',
        icon: <Users size={26} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
        onClick: () => setShowManageUsers(true),
      },
      {
        key: 'calendario',
        label: 'Gerenciar Calendário',
        icon: <CalendarDays size={26} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
        onClick: () => setShowManageCalendar(true),
      },
      {
        key: 'servidor',
        label: 'Controle do Servidor',
        icon: <Power size={26} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
        onClick: () => setShowServerControl(true),
      },
    ] : []),
    // Trocar a PRÓPRIA senha não é ação de admin: com o login local, todo mundo entrou
    // com uma senha gerada na migração e precisa poder substituí-la. Fica acima de "Sair"
    // e disponível para qualquer papel.
    ...(currentUser ? [{
      key: 'senha',
      label: 'Alterar Senha',
      icon: <KeyRound size={26} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
      onClick: () => setShowChangePw(true),
    }] : []),
    ...(currentUser ? [{
      key: 'sair',
      label: 'Sair',
      icon: <LogOut size={26} className="text-red-300 group-hover:text-red-200 transition-colors" strokeWidth={1.6} />,
      onClick: () => setConfirmLogout(true),
      danger: true,
    }] : []),
  ]

  // Behind the "+": extra surfaces to open.
  const plusItems: MenuItem[] = [
    {
      key: 'denodo',
      label: 'Denodo',
      icon: <Image src="/imagens/Denodo_logo.png" alt="" width={30} height={30} className="object-contain" />,
      onClick: () => setDenodoOpen(true),
    },
    {
      key: 'materiais',
      label: 'Materiais',
      icon: <Boxes size={28} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
      onClick: () => setMateriaisOpen(true),
    },
    {
      key: 'logistica',
      label: 'Logística',
      icon: <Truck size={28} className="text-white/90 group-hover:text-white transition-colors" strokeWidth={1.6} />,
      onClick: () => setLogisticaOpen(true),
    },
  ]

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black">

      <HomeShowcase
        onOpenAnalise={onOpenAnalise}
        onOpenGantt={onOpenGantt}
        interactive={interactive}
        trackPointer={!modalOpen}
      />

      {/* ── Extras cluster (top-right): profile bubble + "+" ─────── */}
      <ExtrasCluster userItems={userItems} plusItems={plusItems} />

      {/* ── Denodo modal ─────────────────────────────────────────── */}
      {denodoOpen && <DenodoModal onClose={() => setDenodoOpen(false)} />}

      {/* ── Logística modal ──────────────────────────────────────── */}
      {logisticaOpen && <LogisticaModal onClose={() => setLogisticaOpen(false)} />}

      {/* ── Materiais modal ──────────────────────────────────────── */}
      {materiaisOpen && <MateriaisModal onClose={() => setMateriaisOpen(false)} />}

      {/* ── Admin modals — re-gated here, not just on the menu entry ──────────
          The menu only decides what is offered; this gate is what actually keeps a non-admin
          from mounting an admin surface. */}
      {showManageUsers && canManageUsers && (
        <ManageUsersModal onClose={() => setShowManageUsers(false)} />
      )}

      {showManageCalendar && canManageUsers && (
        <ManageCalendarModal onClose={() => setShowManageCalendar(false)} />
      )}

      {showServerControl && canManageUsers && (
        <ServerControlModal onClose={() => setShowServerControl(false)} />
      )}

      {showChangePw && currentUser && (
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      )}

      {/* ── Logout confirmation ──────────────────────────────────── */}
      {confirmLogout && currentUser && (
        <ConfirmDialog
          title="Sair da conta"
          message={`Deseja sair da conta ${currentUser.email}?`}
          detail="Você precisará fazer login novamente para continuar usando o sistema."
          confirmLabel="Sair"
          danger
          onConfirm={() => { setConfirmLogout(false); logout() }}
          onCancel={() => setConfirmLogout(false)}
        />
      )}
    </div>
  )
}
