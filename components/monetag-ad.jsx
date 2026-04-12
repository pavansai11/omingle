'use client'

import { useEffect } from 'react'

/**
 * MonetagVignetteLoader
 * Loads the Monetag vignette/interstitial script once on mount.
 * The actual trigger is done imperatively via window.show_XXXXX()
 * which is called from specific UX actions (skip threshold, friend request, filters).
 *
 * Replace ZONE_ID with your real Monetag zone ID.
 */
const MONETAG_ZONE_ID = '10800687' // Replace with your actual Monetag vignette zone ID

export default function MonetagVignetteLoader() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    // Load Monetag script once
    const existing = document.querySelector(`script[data-monetag="${MONETAG_ZONE_ID}"]`)
    if (existing) return

    const script = document.createElement('script')
    script.src = `https://ophoacit.com/1?z=${MONETAG_ZONE_ID}`
    script.async = true
    script.dataset.monetag = MONETAG_ZONE_ID
    document.head.appendChild(script)
  }, [])

  return null
}

/**
 * Imperatively trigger the Monetag vignette.
 * Call this from action handlers (skip count threshold, friend request, filters).
 */
export function triggerMonetagVignette() {
  try {
    const fnName = `show_${MONETAG_ZONE_ID}`
    if (typeof window !== 'undefined' && typeof window[fnName] === 'function') {
      window[fnName]()
    }
  } catch (e) {
    // Silently fail if ad blocker or script not loaded
  }
}