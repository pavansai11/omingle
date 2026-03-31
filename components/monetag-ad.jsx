'use client'

import { useEffect, useRef } from 'react'

const DEFAULT_INPAGE_PUSH_SRC = 'https://nap5k.com/tag.min.js'
const VIGNETTE_ZONE_IDS = new Set(['10800687'])

export default function MonetagAd({
  zone,
  label = 'Advertisement',
  className = '',
  minHeightClassName = 'min-h-[250px]',
  onLoaded,
}) {
  const containerRef = useRef(null)
  const rawScriptSrc = process.env.NEXT_PUBLIC_MONETAG_INPAGE_SCRIPT_SRC || DEFAULT_INPAGE_PUSH_SRC
  const scriptSrc = String(rawScriptSrc || '')
  const isVignetteScript = scriptSrc.includes('vignette')
  const isVignetteZone = VIGNETTE_ZONE_IDS.has(String(zone || ''))
  const shouldLoadScript = !isVignetteScript && !isVignetteZone
  const directLinkUrl = process.env.NEXT_PUBLIC_DIRECT_LINK_URL || 'https://omg10.com/4/10800693'

  useEffect(() => {
    if (!zone || !containerRef.current || !scriptSrc || !shouldLoadScript) return undefined

    const container = containerRef.current
    container.innerHTML = ''

    const script = document.createElement('script')
    script.dataset.zone = zone
    script.src = scriptSrc
    script.async = true
    script.onload = () => onLoaded?.(true)
    script.onerror = () => onLoaded?.(false)
    container.appendChild(script)

    return () => {
      container.innerHTML = ''
    }
  }, [onLoaded, scriptSrc, shouldLoadScript, zone])

  useEffect(() => {
    if (!zone) return
    if (!isVignetteScript && !isVignetteZone) return
    console.warn('[Ads] Blocked vignette config. Falling back to non-vignette placement.', {
      zone,
      scriptSrc,
    })
    onLoaded?.(false)
  }, [isVignetteScript, isVignetteZone, onLoaded, scriptSrc, zone])

  if (!zone) return null

  return (
    <div className={className}>
      <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-gray-500">{label}</p>
      <div ref={containerRef} className={`overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/70 ${minHeightClassName}`}>
        <a
          href={directLinkUrl}
          target="_blank"
          rel="noopener noreferrer nofollow sponsored"
          className="sr-only"
        >
          Sponsored
        </a>
      </div>
    </div>
  )
}
