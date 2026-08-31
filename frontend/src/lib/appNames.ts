/**
 * Canonical display names of the two apps.
 *
 * One source so the header's switch tooltip, the footer's current-app label and the Home
 * landing cards can never drift apart — a control that promises "Carga de Fábrica" must land on
 * a screen that calls itself the same thing.
 */
export const APP_NAMES = {
  analise: 'Análise de Capacidade',
  gantt:   'Carga de Fábrica',
} as const

export type AppMode = keyof typeof APP_NAMES
