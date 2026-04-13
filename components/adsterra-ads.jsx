'use client'

import { useEffect, useRef } from 'react'

/**
 * AdsterraBanner
 * 728x90 desktop / 320x50 mobile responsive banner.
 * Compact — fits in a thin bar without scrolling issues.
 */
export function AdsterraBanner({ className = '' }) {
  const desktopRef = useRef(null)
  const mobileRef = useRef(null)
  const injectedD = useRef(false)
  const injectedM = useRef(false)

  // Only inject desktop ad on desktop viewport — prevents window.atOptions collision
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) return
    if (injectedD.current || !desktopRef.current) return
    injectedD.current = true
    const optScript = document.createElement('script')
    optScript.text = `window.atOptions = {'key':'e3e6994248a1e5d1857a761f698ba4f5','format':'iframe','height':90,'width':728,'params':{}};`
    const invScript = document.createElement('script')
    invScript.src = 'https://theoreticalassertshame.com/e3e6994248a1e5d1857a761f698ba4f5/invoke.js'
    invScript.async = true
    desktopRef.current.appendChild(optScript)
    desktopRef.current.appendChild(invScript)
  }, [])

  // Only inject mobile ad on mobile viewport — prevents window.atOptions collision
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 640) return
    if (injectedM.current || !mobileRef.current) return
    injectedM.current = true
    const optScript = document.createElement('script')
    optScript.text = `window.atOptions = {'key':'136ca117e40190a371bbc86e466823b3','format':'iframe','height':50,'width':320,'params':{}};`
    const invScript = document.createElement('script')
    invScript.src = 'https://theoreticalassertshame.com/136ca117e40190a371bbc86e466823b3/invoke.js'
    invScript.async = true
    mobileRef.current.appendChild(optScript)
    mobileRef.current.appendChild(invScript)
  }, [])

  return (
    <div className={`w-full flex justify-center items-center overflow-hidden ${className}`}>
      {/* Desktop 728×90 */}
      <div
        ref={desktopRef}
        className="hidden sm:flex justify-center items-center"
        style={{ width: 728, height: 90, flexShrink: 0 }}
      />
      {/* Mobile 320×50 */}
      <div
        ref={mobileRef}
        className="flex sm:hidden justify-center items-center"
        style={{ width: 320, height: 50, flexShrink: 0 }}
      />
    </div>
  )
}

/**
 * AdsterraNativeBanner
 * Responsive 1:1 native/social-bar unit (zone 2d45ed9f6a976f07c6f4182a2e2b5428).
 * Works on both mobile and desktop. Use on the homepage only.
 * Wrap in a max-width container to keep it compact.
 */
export function AdsterraNativeBanner({ className = '' }) {
  const containerRef = useRef(null)
  const injected = useRef(false)

  useEffect(() => {
    if (injected.current || !containerRef.current) return
    injected.current = true

    const script = document.createElement('script')
    script.src = 'https://theoreticalassertshame.com/2d45ed9f6a976f07c6f4182a2e2b5428/invoke.js'
    script.async = true
    script.setAttribute('data-cfasync', 'false')
    containerRef.current.appendChild(script)
  }, [])

  return (
    <div className={`w-full ${className}`}>
      <div ref={containerRef}>
        <div id="container-2d45ed9f6a976f07c6f4182a2e2b5428" />
      </div>
    </div>
  )
}

// Default export kept for backward compat — just renders the banner
export default AdsterraBanner