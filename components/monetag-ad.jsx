'use client'

import { useEffect } from 'react'

// Zone ID for the Monetag vignette ad unit
const MONETAG_ZONE_ID = '10800687'

/**
 * MonetagVignetteLoader
 * Loads the Monetag vignette script once on mount using the correct CDN URL.
 * The vignette is triggered imperatively via triggerMonetagVignette().
 */
export default function MonetagVignetteLoader() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const scriptId = `monetag-vignette-${MONETAG_ZONE_ID}`
    if (document.getElementById(scriptId)) return

    // ── Inline the vignette bootstrap exactly as Monetag documents it ────────
    // This mimics: (function(s){s.dataset.zone='ZONE',s.src='https://n6wxm.com/vignette.min.js'})
    //              ([document.documentElement, document.body].filter(Boolean).pop()
    //               .appendChild(document.createElement('script')))
    const container = [document.documentElement, document.body].filter(Boolean).pop()
    const script = document.createElement('script')
    script.id = scriptId
    script.src = 'https://n6wxm.com/vignette.min.js'
    script.async = true
    script.dataset.zone = MONETAG_ZONE_ID
    container.appendChild(script)
  }, [])

  return null
}

/**
 * Imperatively trigger the Monetag vignette.
 * Call this from specific UX actions (skip threshold, friend request, filters).
 * Safe to call before the script loads — it will be a no-op.
 */
export function triggerMonetagVignette() {
  try {
    const fnName = `show_${MONETAG_ZONE_ID}`
    if (typeof window !== 'undefined' && typeof window[fnName] === 'function') {
      window[fnName]()
    }
  } catch (e) {
    // Silently fail — ad blocker or script not yet loaded
  }
}