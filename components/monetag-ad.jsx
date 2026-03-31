'use client'

import { useEffect, useRef } from 'react'

const DEFAULT_INPAGE_PUSH_SRC = 'https://nap5k.com/tag.min.js'

export default function MonetagAd({ zone, label = 'Advertisement', className = '', minHeightClassName = 'min-h-[250px]' }) {
  const containerRef = useRef(null)
  const scriptSrc = process.env.NEXT_PUBLIC_MONETAG_INPAGE_SCRIPT_SRC || DEFAULT_INPAGE_PUSH_SRC
  const directLinkUrl = process.env.NEXT_PUBLIC_DIRECT_LINK_URL || 'https://omg10.com/4/10800693'

  useEffect(() => {
    if (!zone || !containerRef.current || !scriptSrc) return undefined

    const container = containerRef.current
    container.innerHTML = ''

    const script = document.createElement('script')
    script.dataset.zone = zone
    script.src = scriptSrc
    script.async = true
    container.appendChild(script)

    return () => {
      container.innerHTML = ''
    }
  }, [zone, scriptSrc])

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
