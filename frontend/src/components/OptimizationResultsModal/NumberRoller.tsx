'use client'
import { useState, useRef, useEffect } from 'react'
import { X, ChevronUp, ChevronDown } from 'lucide-react'
import type { PropagateMode } from '../gantt/MoveNotePrompt'
import { GlobalPropOptionsButton } from '../gantt/GlobalPropOptionsButton'

export function NumberRoller({
  value, min, max, step, onChange, textColor,
}: {
  value:      number
  min:        number
  max:        number
  step:       number
  onChange:   (v: number) => void
  textColor?: string
}) {
  const clamp    = (v: number) => Math.max(min, Math.min(max, v))
  // Display in pt-BR: integers stay bare (1, 2), fractional steps show a comma (1,5 · 2,5).
  const fmt      = (n: number) => Number.isInteger(n) ? String(n) : String(n).replace('.', ',')
  const valRef   = useRef(value)
  const cbRef    = useRef(onChange)
  valRef.current = value
  cbRef.current  = onChange

  const rollerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rollerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const next = valRef.current + (e.deltaY < 0 ? step : -step)
      cbRef.current(Math.max(min, Math.min(max, next)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [min, max, step])

  const ITEM_H  = 34
  const offsets = [-2, -1, 0, 1, 2] as const

  return (
    <div className="flex flex-col items-center gap-0 select-none">
      <button
        onMouseDown={e => e.preventDefault()}
        onClick={() => onChange(clamp(value + step))}
        className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ChevronUp size={16} />
      </button>

      <div
        ref={rollerRef}
        className="relative overflow-hidden"
        style={{ height: ITEM_H * 5, width: 88 }}
      >
        {/* Gradient fade — top */}
        <div
          className="absolute inset-x-0 top-0 z-10 pointer-events-none"
          style={{ height: ITEM_H * 2, background: 'linear-gradient(to bottom, #fff 20%, transparent)' }}
        />
        {/* Gradient fade — bottom */}
        <div
          className="absolute inset-x-0 bottom-0 z-10 pointer-events-none"
          style={{ height: ITEM_H * 2, background: 'linear-gradient(to top, #fff 20%, transparent)' }}
        />
        {/* Center highlight band */}
        <div
          className="absolute inset-x-2 z-0 rounded"
          style={{ top: ITEM_H * 2, height: ITEM_H, backgroundColor: '#F3F4F6', borderTop: '1px solid #E5E7EB', borderBottom: '1px solid #E5E7EB' }}
        />
        {/* Number rows */}
        <div className="relative z-[1] flex flex-col">
          {offsets.map(offset => {
            const v        = value + offset * step
            const valid    = v >= min && v <= max
            const isCenter = offset === 0
            const dist     = Math.abs(offset)
            return (
              <div
                key={offset}
                className="flex items-center justify-center"
                style={{ height: ITEM_H, cursor: valid && !isCenter ? 'pointer' : 'default' }}
                onClick={() => { if (valid && !isCenter) onChange(clamp(v)) }}
              >
                {valid && (
                  <span
                    className="tabular-nums leading-none"
                    style={{
                      fontSize:   isCenter ? 26 : dist === 1 ? 17 : 13,
                      fontWeight: isCenter ? 700 : dist === 1 ? 500 : 400,
                      color:      isCenter
                        ? (textColor ?? '#111827')
                        : dist === 1 ? '#9CA3AF' : '#D1D5DB',
                    }}
                  >
                    {fmt(v)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <button
        onMouseDown={e => e.preventDefault()}
        onClick={() => onChange(clamp(value - step))}
        className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ChevronDown size={16} />
      </button>
    </div>
  )
}

export function PanelNumberInput({
  title, subtitle, label, value, min, max, step, defaultValue, onSave, onClose, onClear, accentColor, textColor,
}: {
  title:         string
  subtitle?:     string
  label:         string
  value:         number | null
  min:           number
  max:           number
  step:          number
  defaultValue?: number
  onSave:        (v: number) => void
  onClose:       () => void
  onClear:       () => void
  accentColor:   string
  textColor?:    string
}) {
  const initVal = value ?? defaultValue ?? Math.max(min, Math.min(max, min + Math.round(((max - min) / 2) / step) * step))
  const [val, setVal] = useState<number>(initVal)

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl w-64">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800 truncate">{title}</span>
            {subtitle && <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>
        <div className="px-4 py-3 flex flex-col items-center gap-1">
          <span className="text-[11px] text-gray-500">{label}</span>
          <NumberRoller
            value={val}
            min={min}
            max={max}
            step={step}
            onChange={setVal}
            textColor={textColor}
          />
        </div>
        <div className="flex justify-between px-3 py-2 border-t border-gray-100">
          <button onClick={() => { onClear(); onClose() }} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded hover:bg-gray-50">Remover</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">Cancelar</button>
            <button
              onClick={() => { onSave(val); onClose() }}
              className="px-3 py-1.5 text-xs text-white rounded font-medium"
              style={{ backgroundColor: accentColor }}
            >Salvar</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── PanelLocoEdit ─────────────────────────────────────────────────────────────
// "Editar LOCO" — same split layout / tab strip / roller style as PanelLimites.
// Three independent sections, each toggleable:
//   Duração        → novo takt do LOCO (1–15); recalcula todo o LOCO.
//   Deslocar Início → ±10 dias úteis (− = adiantar, + = atrasar); recalcula o LOCO.
//   Deslocar Término → ±10 dias úteis; muda data fim → Dias de Proteção.
// "Salvar" devolve (takt|null, startShift|null, finishShift|null) — null = sem alteração.

type LocoEditTab = 'duracao' | 'inicio' | 'termino' | 'horas'

export function PanelLocoEdit({
  title, subtitle,
  takt, startShift, finishShift,
  onSave, onClose, onClear,
  accentColor = '#DC2626', textColor,
  showPropagate = false, propagate = 'no',
  showHours = false, hoursTotal = null, hoursActive = false, hoursDisabled = false,
  hoursDisabledMsg, hoursAsWs = false,
}: {
  title:        string
  subtitle?:    string
  takt:         number | null   // takt atual do LOCO (default da seção Duração)
  startShift:   number | null   // deslocamento de início já aplicado (0 se nenhum)
  finishShift:  number | null   // deslocamento de término já aplicado (0 se nenhum)
  onSave:       (takt: number | null, startShift: number | null, finishShift: number | null, propagate: PropagateMode, hoursTotal?: number | null) => void
  onClose:      () => void
  onClear:      () => void
  accentColor?: string
  textColor?:   string
  // Workstation/Componente edits show a "Propagar efeitos?" control (cascade to later workstations).
  // Tri-state: Não / Local (within this loco) / Global (ripple this WS across subsequent locos). LOCO
  // edits never show it (whole-LOCO semantics).
  showPropagate?: boolean
  propagate?:     PropagateMode
  // "Horas totais" — rescale the total hours at the SAME duration. Editable at the COMPONENT level:
  // a single-component workstation reaches here as its sole component (hoursAsWs → "da workstation"
  // wording); a multi-component workstation shows the tab DISABLED with hoursDisabledMsg. hoursTotal =
  // current effective total (prefill); hoursActive = an override is stored (open section ON);
  // hoursDisabled = can't edit here (zero-hour component, or a multi-component workstation).
  showHours?:      boolean
  hoursTotal?:     number | null
  hoursActive?:    boolean
  hoursDisabled?:  boolean
  hoursDisabledMsg?: string   // shown when hoursDisabled; defaults to the zero-hour component message
  hoursAsWs?:      boolean    // label the section for a workstation instead of a component
}) {
  // Snap to the nearest 0.5 so the prefill aligns with the half-step roller (1; 1,5; 2; …).
  const baseTakt = Math.max(1, Math.min(15, Math.round((takt ?? 1) * 2) / 2))

  const [tab, setTab] = useState<LocoEditTab>('duracao')

  const [taktVal,   setTaktVal]   = useState<number>(baseTakt)
  const [iniVal,    setIniVal]    = useState<number>(Math.max(-10, Math.min(10, startShift ?? 0)))
  const [fimVal,    setFimVal]    = useState<number>(Math.max(-10, Math.min(10, finishShift ?? 0)))
  // Hours as TEXT so partial entries ("10.", "") are allowed while typing; parsed to a number on save.
  // Accept up to 2 decimals (10 · 10.5 · 10.25 — never 10.123), and a comma as decimal separator. The
  // same validation gates typing AND pasting (both fire onChange), and the parsed value is what saves.
  const fmtHours = (n: number) => String(Math.round(Math.max(0, n) * 100) / 100)
  const [hoursText, setHoursText] = useState<string>(fmtHours(hoursTotal ?? 0))
  const hoursVal = Math.max(0, Number(hoursText) || 0)
  const onHoursInput = (raw: string) => {
    const s = raw.replace(',', '.')
    if (s === '' || /^\d*(\.\d{0,2})?$/.test(s)) setHoursText(s)
  }

  const [taktOn,    setTaktOn]    = useState<boolean>(takt != null)
  const [iniOn,     setIniOn]     = useState<boolean>(startShift != null && startShift !== 0)
  const [fimOn,     setFimOn]     = useState<boolean>(finishShift != null && finishShift !== 0)
  const [hoursOn,   setHoursOn]   = useState<boolean>(hoursActive)
  const [propMode, setPropMode] = useState<PropagateMode>(propagate)

  const shiftLabel = (v: number) =>
    v === 0 ? 'sem deslocamento' : v < 0 ? `${Math.abs(v)} dia(s) antes` : `${v} dia(s) depois`

  const TABS: { id: LocoEditTab; label: string; on: boolean }[] = [
    { id: 'duracao', label: 'Duração', on: taktOn },
    { id: 'inicio',  label: 'Início',  on: iniOn  },
    { id: 'termino', label: 'Término', on: fimOn  },
    ...(showHours ? [{ id: 'horas' as const, label: 'Horas', on: hoursOn }] : []),
  ]

  return (
    // Clicking the backdrop (anywhere outside the white panel) closes the editor.
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col" style={{ width: 300, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800 truncate">{title}</span>
            {subtitle && <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-gray-200 shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex-1 py-2 text-xs font-semibold transition-all flex items-center justify-center gap-1"
              style={{
                borderBottom:    tab === t.id ? `2px solid ${accentColor}` : '2px solid transparent',
                color:           tab === t.id ? accentColor : '#6B7280',
                backgroundColor: tab === t.id ? `${accentColor}10` : 'transparent',
              }}
            >
              {t.label}
              {t.on && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />}
            </button>
          ))}
        </div>

        {/* Body — fixed min-height so switching tabs (especially to the short Hours tab) never resizes
            the modal. The tallest tab is a roller (~326px); this floor keeps every tab the same size. */}
        <div className="flex-1 overflow-auto" style={{ minHeight: 332 }}>

          {tab === 'duracao' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setTaktOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: taktOn ? accentColor : '#D1D5DB' }}
                >
                  <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: taktOn ? 'calc(100% - 14px)' : '2px' }} />
                </button>
                <span className="text-[11px] text-gray-600">Alterar duração (takt) do LOCO</span>
              </div>
              <div className={taktOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Takt (dias)</span>
                <NumberRoller value={taktVal} min={1} max={15} step={0.5} onChange={setTaktVal} textColor={textColor} />
              </div>
              <div className="w-full px-3 py-1.5 rounded-lg text-center text-[11px]"
                style={{ backgroundColor: accentColor + '12', color: accentColor, opacity: taktOn ? 1 : 0.4 }}>
                Recalcula todo o LOCO
              </div>
            </div>
          )}

          {tab === 'inicio' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setIniOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: iniOn ? accentColor : '#D1D5DB' }}
                >
                  <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: iniOn ? 'calc(100% - 14px)' : '2px' }} />
                </button>
                <span className="text-[11px] text-gray-600">Deslocar início do LOCO</span>
              </div>
              <div className={iniOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Dias úteis (− adianta · + atrasa)</span>
                <NumberRoller value={iniVal} min={-10} max={10} step={1} onChange={setIniVal} textColor={textColor} />
              </div>
              <div className="w-full px-3 py-1.5 rounded-lg text-center text-[11px]"
                style={{ backgroundColor: accentColor + '12', color: accentColor, opacity: iniOn ? 1 : 0.4 }}>
                {shiftLabel(iniVal)}
              </div>
            </div>
          )}

          {tab === 'termino' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setFimOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: fimOn ? accentColor : '#D1D5DB' }}
                >
                  <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: fimOn ? 'calc(100% - 14px)' : '2px' }} />
                </button>
                <span className="text-[11px] text-gray-600">Deslocar término (Dias de Proteção)</span>
              </div>
              <div className={fimOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Dias úteis (− adianta · + atrasa)</span>
                <NumberRoller value={fimVal} min={-10} max={10} step={1} onChange={setFimVal} textColor={textColor} />
              </div>
              <div className="w-full px-3 py-1.5 rounded-lg text-center text-[11px]"
                style={{ backgroundColor: accentColor + '12', color: accentColor, opacity: fimOn ? 1 : 0.4 }}>
                {shiftLabel(fimVal)} · ajusta Dias de Proteção
              </div>
            </div>
          )}

          {tab === 'horas' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => { if (!hoursDisabled) setHoursOn(v => !v) }}
                  disabled={hoursDisabled}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: (hoursOn && !hoursDisabled) ? accentColor : '#D1D5DB', opacity: hoursDisabled ? 0.5 : 1, cursor: hoursDisabled ? 'not-allowed' : 'pointer' }}
                >
                  <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: (hoursOn && !hoursDisabled) ? 'calc(100% - 14px)' : '2px' }} />
                </button>
                <span className="text-[11px] text-gray-600">Alterar horas totais {hoursAsWs ? 'da workstation' : 'do componente'}</span>
              </div>
              {hoursDisabled ? (
                <div className="w-full px-3 py-1.5 rounded-lg text-center text-[11px]" style={{ backgroundColor: '#F3F4F6', color: '#9CA3AF' }}>
                  {hoursDisabledMsg ?? 'Componente sem horas — não editável'}
                </div>
              ) : (
                <>
                  <div className={hoursOn ? 'w-full' : 'w-full opacity-40 pointer-events-none'}>
                    <span className="text-[11px] font-semibold text-gray-900 block text-center mb-1">Horas totais</span>
                    {/* The typed value must be BLACK on the white field. It used to take `textColor`,
                        which this panel's only caller never passes — so the input fell back to the
                        UA/inherited colour and rendered grey-on-white, effectively unreadable while
                        typing. The rollers on the other tabs already default the same way
                        (`textColor ?? '#111827'`); this matches them. */}
                    <input
                      type="text" inputMode="decimal" value={hoursText}
                      onChange={(e) => onHoursInput(e.target.value)}
                      className="w-full text-center border border-gray-300 rounded-lg py-1.5 text-sm font-semibold focus:outline-none"
                      style={{ color: textColor ?? '#111827' }}
                    />
                  </div>
                  <div className="w-full px-3 py-1.5 rounded-lg text-center text-[11px]"
                    style={{ backgroundColor: accentColor + '12', color: accentColor, opacity: hoursOn ? 1 : 0.4 }}>
                    Redistribui nas mesmas datas · atualiza Plano de Produção
                  </div>
                </>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex flex-col gap-1.5 px-3 py-2.5 border-t border-gray-100 shrink-0">
          {/* Propagate effects — tri-state segmented control (Workstation/Componente edits only):
              Não (this item only) · Local (shift later workstations in THIS loco) · Global (also ripple
              this workstation's delay/recovery through subsequent same-line locos). */}
          {showPropagate && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 px-0.5">
                <span className="text-[11px] font-semibold text-gray-700">Propagar efeitos?</span>
                <span className="flex-1 min-w-0 truncate text-[10px] leading-tight text-gray-400">
                  {propMode === 'no' ? 'altera apenas este item'
                    : propMode === 'local' ? 'desloca as workstations seguintes'
                    : 'propaga este WS nos LOCOs seguintes'}
                </span>
                {/* Sub-options for Global, same store the Move-Mode prompt writes. Only meaningful
                    while Global is the selected mode, so it is shown only then. */}
                {propMode === 'global' && <GlobalPropOptionsButton align="right" />}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {([
                  { id: 'no' as const,     label: 'Não' },
                  { id: 'local' as const,  label: 'Local' },
                  { id: 'global' as const, label: 'Global' },
                ]).map(opt => {
                  const on = propMode === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setPropMode(opt.id)}
                      className="px-2 py-1 rounded-md text-[11px] font-semibold transition-colors border"
                      style={on
                        ? { backgroundColor: opt.id === 'no' ? '#F3F4F6' : '#FFF7ED', borderColor: opt.id === 'no' ? '#9CA3AF' : '#F97316', color: opt.id === 'no' ? '#374151' : '#C2410C' }
                        : { backgroundColor: '#F9FAFB', borderColor: '#E5E7EB', color: '#9CA3AF' }}
                    >{opt.label}</button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="flex justify-between items-center">
            <button
              onClick={() => { onClear(); onClose() }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
            >Remover edição</button>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">Cancelar</button>
              <button
                onClick={() => {
                  onSave(
                    taktOn ? taktVal : null,
                    iniOn  ? iniVal  : null,
                    fimOn  ? fimVal  : null,
                    showPropagate ? propMode : 'no',
                    showHours && hoursOn && !hoursDisabled ? hoursVal : null,
                  )
                  onClose()
                }}
                className="px-3 py-1.5 text-xs text-white rounded font-medium"
                style={{ backgroundColor: accentColor }}
              >Salvar</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── PanelLimites ──────────────────────────────────────────────────────────────
// Two-tab panel combining max hours (with multi-person estimate) and max people.
// "Horas / semana": roller 0 → 5× one-person weekly cap; shows ≈ dias · TOP% · N pessoas.
// "Pessoas":        roller 0–999 for max headcount.
// Both limits can be toggled on/off independently; "Salvar" saves both.

type LimitesTab = 'horas' | 'pessoas' | 'turnos'

export function PanelLimites({
  title, subtitle,
  maxPeople, maxHours, maxTurnos,
  topPct,
  onSave, onClose, onClear,
  accentColor, textColor,
}: {
  title:        string
  subtitle?:    string
  maxPeople:    number | null
  maxHours:     number | null
  maxTurnos:    number | null
  topPct:       number
  onSave:       (people: number | null, hours: number | null, turnos: number | null) => void
  onClose:      () => void
  onClear:      () => void
  accentColor:  string
  textColor?:   string
}) {
  const hoursPerDay    = 8.8 * Math.max(0, topPct) / 100
  // capWeekly = 1 full-person week in hours; maxHoursRoller = 5-person cap, hard-capped at 999
  const capWeekly      = Math.round(hoursPerDay * 5 * 10) / 10
  const maxHoursRoller = Math.max(1, Math.min(999, Math.round(capWeekly * 5)))

  const [tab,       setTab]       = useState<LimitesTab>('horas')
  // Clamp initial hoursVal to [0, maxHoursRoller] and round to integer (step=1)
  const [hoursVal,  setHoursVal]  = useState<number>(
    Math.max(0, Math.min(maxHoursRoller, Math.round(maxHours ?? capWeekly)))
  )
  const [peopleVal, setPeopleVal] = useState<number>(maxPeople ?? 3)
  const [turnosVal, setTurnosVal] = useState<number>(Math.max(1, Math.min(3, maxTurnos ?? 1)))
  const [hoursOn,   setHoursOn]   = useState<boolean>(maxHours  != null)
  const [peopleOn,  setPeopleOn]  = useState<boolean>(maxPeople != null)
  const [turnosOn,  setTurnosOn]  = useState<boolean>(maxTurnos != null)

  const totalDias = hoursPerDay > 0 ? hoursVal / hoursPerDay : 0
  const nPessoas  = capWeekly   > 0 ? hoursVal / capWeekly   : 1
  const diasStr   = totalDias.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const pessStr   = nPessoas .toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const pessLabel = Math.abs(nPessoas - 1) < 0.1 ? 'pessoa' : 'pessoas'

  const footerParts = [
    hoursOn  ? `${hoursVal.toFixed(1)} h`                                          : null,
    peopleOn ? `máx ${peopleVal} p/turno` : null,
    turnosOn ? `${turnosVal} turno${turnosVal !== 1 ? 's' : ''}`      : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col" style={{ width: 300, maxHeight: '80vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800 truncate">{title}</span>
            {subtitle && <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-gray-200 shrink-0">
          {(['horas', 'pessoas', 'turnos'] as LimitesTab[]).map(t => {
            const isOn = t === 'horas' ? hoursOn : t === 'pessoas' ? peopleOn : turnosOn
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="flex-1 py-2 text-xs font-semibold transition-all flex items-center justify-center gap-1"
                style={{
                  borderBottom:    tab === t ? `2px solid ${accentColor}` : '2px solid transparent',
                  color:           tab === t ? accentColor : '#6B7280',
                  backgroundColor: tab === t ? `${accentColor}10` : 'transparent',
                }}
              >
                {t === 'horas' ? 'Horas / semana' : t === 'pessoas' ? 'Pessoas' : 'Turnos'}
                {isOn && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />}
              </button>
            )
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">

          {tab === 'horas' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setHoursOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: hoursOn ? accentColor : '#D1D5DB' }}
                >
                  <span
                    className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: hoursOn ? 'calc(100% - 14px)' : '2px' }}
                  />
                </button>
                <span className="text-[11px] text-gray-600">Limite de horas ativo</span>
              </div>
              <div className={hoursOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Máximo de horas semanais</span>
                <NumberRoller
                  value={hoursVal}
                  min={0}
                  max={maxHoursRoller}
                  step={1}
                  onChange={setHoursVal}
                  textColor={textColor}
                />
              </div>
              <div
                className="w-full px-3 py-1.5 rounded-lg text-center text-[11px] tabular-nums"
                style={{ backgroundColor: accentColor + '12', color: accentColor, opacity: hoursOn ? 1 : 0.4 }}
              >
                ≈ {diasStr} dias · TOP {topPct}% · {pessStr} {pessLabel}
              </div>
            </div>
          )}

          {tab === 'pessoas' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setPeopleOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: peopleOn ? accentColor : '#D1D5DB' }}
                >
                  <span
                    className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: peopleOn ? 'calc(100% - 14px)' : '2px' }}
                  />
                </button>
                <span className="text-[11px] text-gray-600">Limite de pessoas ativo</span>
              </div>
              <div className={peopleOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Máx. pessoas por turno</span>
                <NumberRoller
                  value={peopleVal}
                  min={0}
                  max={999}
                  step={1}
                  onChange={setPeopleVal}
                  textColor={textColor}
                />
              </div>
            </div>
          )}

          {tab === 'turnos' && (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={() => setTurnosOn(v => !v)}
                  className="shrink-0 h-4 rounded-full transition-colors relative"
                  style={{ width: 30, backgroundColor: turnosOn ? accentColor : '#D1D5DB' }}
                >
                  <span
                    className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                    style={{ left: turnosOn ? 'calc(100% - 14px)' : '2px' }}
                  />
                </button>
                <span className="text-[11px] text-gray-600">Limite de turnos ativo</span>
              </div>
              <div className={turnosOn ? '' : 'opacity-40 pointer-events-none'}>
                <span className="text-[11px] text-gray-500 block text-center mb-1">Nº de turnos</span>
                <NumberRoller
                  value={turnosVal}
                  min={1}
                  max={3}
                  step={1}
                  onChange={setTurnosVal}
                  textColor={textColor}
                />
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex flex-col gap-1.5 px-3 py-2.5 border-t border-gray-100 shrink-0">
          {footerParts && (
            <div className="text-center text-[11px] text-gray-500 tabular-nums">{footerParts}</div>
          )}
          <div className="flex justify-between items-center">
            <button
              onClick={() => { onClear(); onClose() }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
            >Remover</button>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">Cancelar</button>
              <button
                onClick={() => { onSave(peopleOn ? peopleVal : null, hoursOn ? hoursVal : null, turnosOn ? turnosVal : null); onClose() }}
                className="px-3 py-1.5 text-xs text-white rounded font-medium"
                style={{ backgroundColor: accentColor }}
              >Salvar</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
