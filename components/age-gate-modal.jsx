'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'hippichat_age_confirmed'
const STORAGE_DATE_KEY = 'hippichat_age_confirmed_at'

export default function AgeGateModal() {
  const [isOpen, setIsOpen] = useState(true)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(STORAGE_KEY) === 'true') {
      setIsOpen(false)
    }
  }, [])

  const confirmAge = () => {
    if (!checked || typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, 'true')
    window.localStorage.setItem(STORAGE_DATE_KEY, new Date().toISOString())
    setIsOpen(false)
  }

  const declineAge = () => {
    if (typeof window !== 'undefined') {
      window.location.href = 'https://www.google.com'
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0d1117] p-7 text-center shadow-2xl">
        <h2 className="mb-2 text-2xl font-semibold text-[#F5C842]">HippiChat</h2>
        <p className="mb-5 text-sm leading-6 text-white/65">
          This platform connects you with strangers via random video and text chat. You must be 18 or older to enter.
        </p>

        <label className="mb-5 flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3 text-left">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-[#F5C842]"
          />
          <span className="text-xs leading-5 text-white/60">
            I confirm I am at least <strong className="text-white">18 years old</strong> and I agree to the{' '}
            <Link href="/terms" target="_blank" className="text-[#F5C842] hover:underline">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" target="_blank" className="text-[#F5C842] hover:underline">
              Privacy Policy
            </Link>
            . I understand this platform contains random interactions with strangers.
          </span>
        </label>

        <button
          onClick={confirmAge}
          disabled={!checked}
          className="mb-3 w-full rounded-lg bg-[#F5C842] px-4 py-3 text-sm font-semibold text-[#1a1400] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enter HippiChat
        </button>

        <button
          onClick={declineAge}
          className="w-full rounded-lg border border-white/15 bg-transparent px-4 py-3 text-sm text-white/50 transition hover:bg-white/5 hover:text-white/70"
        >
          I am under 18 — Exit
        </button>
      </div>
    </div>
  )
}