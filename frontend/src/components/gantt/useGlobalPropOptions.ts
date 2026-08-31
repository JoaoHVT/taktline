import { useSyncExternalStore } from 'react'
import { getGlobalPropOptions, subscribeGlobalPropOptions, type GlobalPropOptions } from '@/lib/globalPropOptions'

/**
 * Subscribe a component to the Global-propagation sub-options (the arrow next to "Global").
 * Returns the current options and re-renders when any of them is toggled.
 */
export function useGlobalPropOptions(): GlobalPropOptions {
  return useSyncExternalStore(subscribeGlobalPropOptions, getGlobalPropOptions, getGlobalPropOptions)
}
