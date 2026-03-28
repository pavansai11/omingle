'use client'

import { useEffect, useRef } from 'react'

export default function MonetagAd({ zone, label = 'Advertisement', className = '', minHeightClassName = 'min-h-[250px]' }) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!zone || !containerRef.current) return undefined

    const container = containerRef.current
    container.innerHTML = ''

    const script = document.createElement('script')
    script.dataset.zone = zone
    script.src = 'https://izcle.com/vignette.min.js'
    script.async = true
    container.appendChild(script)

    return () => {
      container.innerHTML = ''
    }
  }, [zone])

  if (!zone) return null

  return (
    <div className={className}>
      <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-gray-500">{label}</p>
      <div ref={containerRef} className={`overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/70 ${minHeightClassName}`} />
    </div>
  )
}