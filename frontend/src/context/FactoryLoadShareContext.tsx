'use client'
/**
 * FactoryLoadShareContext — carries the loaded Carga de Fábrica dataset ACROSS the two apps.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * `page.tsx` keeps BOTH apps permanently mounted (hidden with display:none to preserve their
 * state), each inside its own `LayoutShell` — so there are TWO `AppHeader` instances:
 *
 *   Análise de Capacidade  → <LayoutShell mode="analise">  … owns the Simular menu
 *   Carga de Fábrica       → <LayoutShell mode="gantt">    … owns the Gantt lifecycle
 *
 * Every piece of Gantt state (`ganttCache`, `ganttOpenedOnce`, the scenario/comparison data,
 * the period and line filter) is `useState` INSIDE AppHeader, so it belongs to whichever
 * instance loaded it — the gantt one. The Simular menu lives in the OTHER instance, whose
 * copies of those states stay at their initial values forever. Gating "Simular → Carga de
 * Fábrica" on them therefore never opened, no matter what the user loaded: the flags were
 * being read from a component that could not possibly have set them.
 *
 * `GanttInlineContext` cannot serve this: its provider is mounted only inside the Carga de
 * Fábrica app, precisely so the Capacity app has none (`useGanttInlineMaybe()` → null there).
 *
 * This provider sits ABOVE both apps and passes the ACTIVE raw dataset + the period/line
 * filter across. The receiving header windows it exactly as the publisher would, so the
 * imported items match the Plano de Produção grid the user is looking at.
 *
 * ── Ownership ────────────────────────────────────────────────────────────────────────────
 * Both headers publish, so publishing must not let an EMPTY instance wipe a populated one
 * (the Capacity header has no dataset and re-publishes on every render of its own effect).
 * Each caller passes a stable identity; a snapshot carrying data claims ownership, and a null
 * snapshot only clears when it comes from the CURRENT owner. That keeps "Limpar" working
 * (the owner clears itself) without the idle instance ever blanking the loaded one.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { GanttData } from '@/lib/api'

export interface FactoryLoadSnapshot {
  /** Active raw dataset (base or scenario, or the active comparison side). null = nothing
   *  loaded, or the Gantt was never opened — the Simular entry point stays disabled. */
  data: GanttData | null
  /** Period picked in the Gantt launch modal (dd/mm/yyyy), applied before any display. */
  dateRange: { from?: string; to?: string } | null
  /** Line filter (linha names) picked in the launch modal. */
  lineFilter: string[] | null
  /** The published GCR plan, when GCR is in the loaded Tipo selection.
   *
   *  A SECOND source, not part of `data`: the Schedule payload has no GCR block, and the plan
   *  is fetched separately from the database. Plano de Produção shows the two as one grid, so
   *  the Capacity import has to receive both or it lists a subset of what the user is looking
   *  at. NOT windowed by `dateRange`/`lineFilter` — those describe the Schedule's period and
   *  lines, and a published plan is described in neither. */
}

/** Opaque per-publisher identity. Each AppHeader instance holds one for its whole lifetime. */
export type FactoryLoadPublisherId = { readonly __brand: 'factoryLoadPublisher' }

interface FactoryLoadShareState extends FactoryLoadSnapshot {
  publish: (id: FactoryLoadPublisherId, snap: FactoryLoadSnapshot) => void
}

const EMPTY: FactoryLoadSnapshot = { data: null, dateRange: null, lineFilter: null }

const Ctx = createContext<FactoryLoadShareState | null>(null)

/** Stable per-instance publisher identity. Held in state, not a ref: a lazy ref would have to
 *  be initialised during render, which React forbids reading back in the same pass. */
export function useFactoryLoadPublisherId(): FactoryLoadPublisherId {
  const [id] = useState<FactoryLoadPublisherId>(() => ({}) as FactoryLoadPublisherId)
  return id
}

/** Falls back to an inert snapshot when no provider is mounted, so a header rendered outside
 *  the shell (tests, storybook) simply sees "nothing loaded" instead of crashing. */
export function useFactoryLoadShare(): FactoryLoadShareState {
  const ctx = useContext(Ctx)
  const fallback = useMemo<FactoryLoadShareState>(() => ({ ...EMPTY, publish: () => {} }), [])
  return ctx ?? fallback
}

export function FactoryLoadShareProvider({ children }: { children: React.ReactNode }) {
  const [snap, setSnap] = useState<FactoryLoadSnapshot>(EMPTY)
  const ownerRef = useRef<FactoryLoadPublisherId | null>(null)

  const publish = useCallback((id: FactoryLoadPublisherId, next: FactoryLoadSnapshot) => {
    if (next.data == null && ownerRef.current !== null && ownerRef.current !== id) return
    if (next.data != null) ownerRef.current = id
    else if (ownerRef.current === id) ownerRef.current = null
    setSnap(prev => (
      prev.data === next.data
      && prev.dateRange === next.dateRange
      && prev.lineFilter === next.lineFilter
      // The plan arrives on its own clock — it is fetched after the dataset — so a snapshot
      // identical in every other field is still a NEW one once its rows land.
    ) ? prev : next)
  }, [])

  const value = useMemo<FactoryLoadShareState>(() => ({ ...snap, publish }), [snap, publish])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
