'use client'

import { useEffect, useRef } from 'react'

const DEFAULT_AD_CLIENT = 'ca-pub-9617793975321646'
const DEFAULT_AD_SLOT = '9273929402'

export default function GoogleSponsoredAd({
  label = 'Sponsored',
  className = '',
  minHeightClassName = 'min-h-[220px]',
  frameClassName = '',
  adClassName = 'aspect-square',
  adClient = DEFAULT_AD_CLIENT,
  adSlot = DEFAULT_AD_SLOT,
  onLoaded,
}) {
  const insRef = useRef(null)
  const pushedRef = useRef(false)
  const safeClassName = typeof className === 'string' ? className : ''
  const safeMinHeightClass = typeof minHeightClassName === 'string' ? minHeightClassName : ''
  const safeFrameClass = typeof frameClassName === 'string' ? frameClassName : ''
  const safeAdClass = typeof adClassName === 'string' ? adClassName : ''

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let timer = null

    const tryPush = () => {
      if (cancelled || pushedRef.current || !insRef.current) return
      attempts += 1
      try {
        window.adsbygoogle = window.adsbygoogle || []
        window.adsbygoogle.push({})
        pushedRef.current = true
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[GoogleSponsoredAd] push ok', { adSlot, attempts })
        }
        onLoaded?.(true)
      } catch (error) {
        if (attempts >= 8) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[GoogleSponsoredAd] push failed', { adSlot, attempts, error })
          }
          onLoaded?.(false)
          return
        }
        timer = window.setTimeout(tryPush, 350)
      }
    }

    tryPush()
    return () => {
      cancelled = true
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [onLoaded])

  return (
    <div className={safeClassName}>
      <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-gray-500">{label}</p>
      <div className={`overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/70 p-3 ${safeMinHeightClass} ${safeFrameClass}`.trim()}>
        <ins
          ref={insRef}
          className={`adsbygoogle block w-full ${safeAdClass}`.trim()}
          data-ad-client={adClient}
          data-ad-slot={adSlot}
          data-ad-format="auto"
          data-full-width-responsive="true"
          style={{ display: 'block' }}
        />
      </div>
    </div>
  )
}
