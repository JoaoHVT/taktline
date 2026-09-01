/**
 * Assembly widget constants — mirrors WAB colour definitions from the original desktop tool.
 */
import type { ScopeKey } from '@/lib/api'

export const SCOPE_COLOR: Record<ScopeKey, string> = {
  LEVE:   '#388E3C',
  MEDIO:  '#F57C00',
  PESADO: '#D32F2F',
  UNICO:  '#7B1FA2',
}

export const SCOPE_LABEL: Record<ScopeKey, string> = {
  LEVE:   'ESCOPO LEVE',
  MEDIO:  'ESCOPO MÉDIO',
  PESADO: 'ESCOPO PESADO',
  UNICO:  'ESCOPO ÚNICO',
}

/** Hides browser number-input spinner arrows (all engines). */
export const NO_ARROWS: React.CSSProperties = {
  MozAppearance:    'textfield',
  appearance:       'textfield',
  WebkitAppearance: 'none',
}
