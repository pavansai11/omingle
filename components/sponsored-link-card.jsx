'use client'

export default function SponsoredLinkCard({ href, title = 'Sponsored', description = 'Explore this sponsored offer', cta = 'Open offer', className = '' }) {
  if (!href) return null

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow sponsored"
      className={`block rounded-2xl border border-gray-800 bg-gray-900/70 p-4 text-left transition-all hover:border-violet-500/40 hover:bg-gray-900 ${className}`}
    >
      <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-gray-500">Sponsored</p>
      <h4 className="text-sm font-semibold text-white">{title}</h4>
      <p className="mt-1 text-sm text-gray-400">{description}</p>
      <span className="mt-3 inline-flex rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white">
        {cta}
      </span>
    </a>
  )
}