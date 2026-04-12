'use client'

import { useEffect, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// AdsterraNativeBanner
// Renders the Adsterra native/social-bar ad unit.
// Place above or below the "Find a Stranger" button on the home page.
// ─────────────────────────────────────────────────────────────────────────────
export function AdsterraNativeBanner({ className = '' }) {
  const containerRef = useRef(null)
  const injectedRef  = useRef(false)

  useEffect(() => {
    if (injectedRef.current || !containerRef.current) return
    injectedRef.current = true

    const script = document.createElement('script')
    script.src = 'https://theoreticalassertshame.com/2d45ed9f6a976f07c6f4182a2e2b5428/invoke.js'
    script.async = true
    script.setAttribute('data-cfasync', 'false')
    containerRef.current.appendChild(script)
  }, [])

  return (
    <div className={className}>
      {/* Adsterra injects into the div with matching id */}
      <div ref={containerRef} id="container-2d45ed9f6a976f07c6f4182a2e2b5428" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// AdsterraBanner
// Responsive banner: 728×90 on desktop, 320×50 on mobile.
// Uses CSS to switch between the two ad keys automatically.
// ─────────────────────────────────────────────────────────────────────────────
export function AdsterraBanner({ className = '' }) {
  const desktopRef = useRef(null)
  const mobileRef  = useRef(null)
  const injectedD  = useRef(false)
  const injectedM  = useRef(false)

  // Desktop 728×90
  useEffect(() => {
    if (injectedD.current || !desktopRef.current) return
    injectedD.current = true

    const inline = document.createElement('script')
    inline.text = `
      window.atOptions = {
        'key'   : 'e3e6994248a1e5d1857a761f698ba4f5',
        'format': 'iframe',
        'height': 90,
        'width' : 728,
        'params': {}
      };
    `
    const invoke = document.createElement('script')
    invoke.src  = 'https://theoreticalassertshame.com/e3e6994248a1e5d1857a761f698ba4f5/invoke.js'
    invoke.async = true

    desktopRef.current.appendChild(inline)
    desktopRef.current.appendChild(invoke)
  }, [])

  // Mobile 320×50
  useEffect(() => {
    if (injectedM.current || !mobileRef.current) return
    injectedM.current = true

    const inline = document.createElement('script')
    inline.text = `
      window.atOptions = {
        'key'   : '136ca117e40190a371bbc86e466823b3',
        'format': 'iframe',
        'height': 50,
        'width' : 320,
        'params': {}
      };
    `
    const invoke = document.createElement('script')
    invoke.src  = 'https://theoreticalassertshame.com/136ca117e40190a371bbc86e466823b3/invoke.js'
    invoke.async = true

    mobileRef.current.appendChild(inline)
    mobileRef.current.appendChild(invoke)
  }, [])

  return (
    <div className={`w-full flex justify-center overflow-hidden ${className}`}>
      {/* Desktop banner — hidden on mobile */}
      <div
        ref={desktopRef}
        className="hidden sm:flex items-center justify-center"
        style={{ width: 728, height: 90, maxWidth: '100%' }}
      />
      {/* Mobile banner — hidden on desktop */}
      <div
        ref={mobileRef}
        className="flex sm:hidden items-center justify-center"
        style={{ width: 320, height: 50, maxWidth: '100%' }}
      />
    </div>
  )
}