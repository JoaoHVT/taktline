'use client'
import { useEffect, useRef } from 'react'
import { getLastBackendContactAt, onBackendContact, isBackendUnavailable } from '@/lib/api'
import { nextPollDelay, shouldPollOrActive } from '@/lib/awakeWindow'

// ── Live refresh for the admin indicators (online users, admin alerts) ───────────
// Shared by every header counter that must look real-time without holding Railway's
// backend awake. Three things drive a refresh:
//
//   1. An ADAPTIVE beat — ~30s while the app is actively used, ~5 min once it goes
//      idle (lib/awakeWindow.ts nextPollDelay). Fast polling is free while the user
//      is working, because their own traffic is already resetting the sleep timer.
//   2. REAL user traffic — any non-poll request may itself be what changed the data
//      (a role change creates an alert; any authenticated request marks its actor
//      online), so we refresh on the contact signal, debounced to collapse bursts.
//   3. TAB VISIBILITY — becoming visible refreshes at once; going hidden stops
//      everything, so a forgotten tab costs nothing.
//
// A self-scheduling setTimeout is used rather than setInterval specifically so the
// cadence can be re-decided on every beat — an interval would freeze whichever delay
// happened to be in force when the user started working.
//
// Safe by construction: activity is measured from real traffic only (background polls
// set _backgroundPoll in api.ts and are excluded), so the fast cadence always lapses
// ~3 min after the user stops. It cannot sustain itself.

const CONTACT_DEBOUNCE_MS = 15_000

export function useLivePoll(refresh: () => void) {
  const refreshRef = useRef(refresh)
  useEffect(() => { refreshRef.current = refresh })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastRunAt = 0

    const clear = () => { if (timer) { clearTimeout(timer); timer = null } }

    const run = () => { lastRunAt = Date.now(); refreshRef.current() }

    // Decide the next delay fresh each time, from the CURRENT activity state.
    const schedule = () => {
      clear()
      if (document.visibilityState !== 'visible') return
      timer = setTimeout(beat, nextPollDelay(getLastBackendContactAt()))
    }

    // One beat: refresh if the gates allow (working hours, local dev, or provably
    // awake right now), then reschedule regardless so the loop survives quiet periods
    // and resumes by itself at 08:00 Monday.
    //
    // Third gate: stand down entirely while the backend isn't answering (api.ts
    // isBackendUnavailable — no response or a gateway 5xx). These indicator refreshes
    // cannot succeed then, and beating on them was pure log noise. The timer keeps
    // running, so the first answered request anywhere in the app clears the flag and
    // the next beat resumes on its own.
    function beat() {
      if (!isBackendUnavailable() && shouldPollOrActive(getLastBackendContactAt())) run()
      schedule()
    }

    const onVis = () => {
      if (document.visibilityState === 'visible') beat()
      else clear()
    }

    const unsubContact = onBackendContact(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRunAt < CONTACT_DEBOUNCE_MS) { schedule(); return }
      run()
      schedule()
    })

    if (document.visibilityState === 'visible') beat()
    document.addEventListener('visibilitychange', onVis)

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      unsubContact()
      clear()
    }
  }, [])
}
