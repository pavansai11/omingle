'use client'

import { useEffect } from 'react'

const MONETAG_POPUNDER_ZONE = '10809114'

/**
 * MonetagPopunderLoader
 * Loads the Monetag popunder tag once on mount.
 * The popunder fires when the user explicitly clicks specific UI elements.
 * We use a synthetic click on a hidden anchor to trigger it on demand.
 */
export default function MonetagPopunderLoader() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const scriptId = `monetag-popunder-${MONETAG_POPUNDER_ZONE}`
    if (document.getElementById(scriptId)) return

    // Monetag popunder tag — exactly as provided
    const s = document.createElement('script')
    s.id = scriptId
    s.dataset.zone = MONETAG_POPUNDER_ZONE
    s.src = 'https://al5sm.com/tag.min.js'
    ;([document.documentElement, document.body].filter(Boolean).pop()).appendChild(s)
  }, [])

  return null
}

/**
 * triggerMonetagPopunder
 * Simulates a user click to trigger the Monetag popunder.
 * Safe to call before script loads (no-op if not ready).
 * Call only from explicit user-initiated actions.
 */
export function triggerMonetagPopunder() {
  try {
    if (typeof window === 'undefined') return
    // Monetag popunder fires on user click events.
    // We dispatch a synthetic click from a trusted user-gesture context.
    const a = document.createElement('a')
    a.href = '#'
    a.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0;width:1px;height:1px;'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } catch (e) {}
}