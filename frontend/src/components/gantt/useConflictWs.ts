import { useSyncExternalStore } from 'react'
import { getConflictWs, subscribeConflictWs } from '@/lib/ganttUtils'

/**
 * Subscribe a component to the session conflict-workstation override. Returns the current
 * effective set and re-renders on Apply/Reset. Include the returned value in the deps of
 * any `computeConflictCounts` memo so counts recompute live when the override changes.
 */
export function useConflictWs(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeConflictWs, getConflictWs, getConflictWs)
}
