'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import { AdsterraBanner, AdsterraNativeBanner } from '@/components/adsterra-ads'
import SiteFooter from '@/components/site-footer'
import {
  Mic, Video, MessageSquare, Shield, ArrowRight, X, Check, Sparkles,
  Loader2, Users, UserX, Lock, Eye, Heart, History, UserPlus
} from 'lucide-react'

const HERO_PHRASES = [
  { text: 'Meet strangers', hint: 'Live worldwide' },
  { text: 'Video or voice', hint: 'Your choice' },
  { text: 'Add friends', hint: 'Reconnect later' },
  { text: 'Skip fast', hint: 'Move on instantly' },
]

const GUEST_LIMITS = [
  { icon: History, label: 'History tab', desc: 'Sign in to keep history', blocked: true },
  { icon: UserPlus, label: 'Add friends', desc: 'Sign in to add friends', blocked: true },
  { icon: Heart, label: 'Receive likes', desc: 'Sign in to receive likes', blocked: true },
  { icon: Video, label: 'Video + voice chat', desc: 'Full access', blocked: false },
  { icon: MessageSquare, label: 'Text chat', desc: 'Full access', blocked: false },
  { icon: Heart, label: 'Like others', desc: 'Full access', blocked: false },
]

export default function HomePage() {
  const router = useRouter()
  const [sessionUser, setSessionUser] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [showAuthGate, setShowAuthGate] = useState(false)
  const [authIntentMode, setAuthIntentMode] = useState(null)
  const [phraseIndex, setPhraseIndex] = useState(0)
  const [onlineCount, setOnlineCount] = useState(null)
  const [guestLoading, setGuestLoading] = useState(false)
  const [showGuestLimits, setShowGuestLimits] = useState(false)

  const loadSession = useCallback(async () => {
    const res = await fetch('/api/auth/session', { cache: 'no-store' })
    const data = await res.json()
    return data?.user || null
  }, [])

  const buildChatUrl = useCallback((mode = 'video') => `/chat?mode=${mode}`, [])

  useEffect(() => {
    const interval = setInterval(() => setPhraseIndex((prev) => (prev + 1) % HERO_PHRASES.length), 2500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function initSession() {
      try {
        const user = await loadSession()
        if (!cancelled) setSessionUser(user)
      } catch {
        if (!cancelled) setSessionUser(null)
      } finally {
        if (!cancelled) setSessionLoading(false)
      }
    }
    initSession()
    return () => { cancelled = true }
  }, [loadSession])

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/stats', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (typeof data?.online === 'number') setOnlineCount(data.online)
        }
      } catch {}
    }
    fetchStats()
  }, [])

  const proceedToChat = useCallback((mode) => router.push(buildChatUrl(mode)), [buildChatUrl, router])

  const handleStartChat = useCallback(async (mode) => {
    if (sessionLoading) return
    try {
      const freshUser = await loadSession()
      if (freshUser) { setSessionUser(freshUser); proceedToChat(mode); return }
    } catch {}
    setAuthIntentMode(mode)
    setShowAuthGate(true)
  }, [loadSession, proceedToChat, sessionLoading])

  const handleContinueAsGuest = useCallback(async (mode = 'video') => {
    if (guestLoading) return
    setGuestLoading(true)
    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (data?.guestId) {
        proceedToChat(mode)
      }
    } catch {
      setGuestLoading(false)
    }
  }, [guestLoading, proceedToChat])

  const handleAuthGateSignInSuccess = useCallback((user) => {
    if (!user) return
    setSessionUser(user)
    setShowAuthGate(false)
    const mode = authIntentMode || 'video'
    setAuthIntentMode(null)
    proceedToChat(mode)
  }, [authIntentMode, proceedToChat])

  function renderOnlineCount() {
    if (onlineCount !== null && onlineCount >= 100) {
      return (
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <Users className="w-3.5 h-3.5" />
          {onlineCount.toLocaleString()}+ people online now
        </div>
      )
    }
    return (
      <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        People online and ready to chat
      </div>
    )
  }

  const renderAuthGate = () => {
    if (!showAuthGate) return null
    return (
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Sign in to continue</h3>
            <button onClick={() => { setShowAuthGate(false); setAuthIntentMode(null) }} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <p className="text-sm text-gray-400 mb-4">Sign in with Google for the full experience — history, friends, and more.</p>
          <div className="flex justify-center mb-4">
            <GoogleAuthButton onSignInSuccess={handleAuthGateSignInSuccess} />
          </div>
          <div className="border-t border-gray-800 pt-4">
            <p className="text-xs text-center text-gray-500 mb-3">Or try without an account</p>
            <button
              onClick={() => { setShowAuthGate(false); handleContinueAsGuest(authIntentMode || 'video') }}
              disabled={guestLoading}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 transition-all disabled:opacity-50"
            >
              <UserX className="w-4 h-4" />
              {guestLoading ? 'Loading...' : 'Continue as Guest'}
            </button>
            <p className="text-[11px] text-gray-600 text-center mt-2">History, friends & likes require sign-in</p>
          </div>
        </div>
      </div>
    )
  }

  const renderGuestLimitsModal = () => {
    if (!showGuestLimits) return null
    return (
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Guest access</h3>
            <button onClick={() => setShowGuestLimits(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="space-y-2 mb-5">
            {GUEST_LIMITS.map((item, i) => (
              <div key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${item.blocked ? 'opacity-60' : ''}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${item.blocked ? 'bg-red-500/10' : 'bg-emerald-500/10'}`}>
                  {item.blocked ? <X className="w-3 h-3 text-red-400" /> : <Check className="w-3 h-3 text-emerald-400" />}
                </div>
                <div>
                  <span className="text-white font-medium">{item.label}</span>
                  <span className="text-gray-500 ml-2 text-xs">{item.desc}</span>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setShowGuestLimits(false); handleContinueAsGuest('video') }}
            disabled={guestLoading}
            className="w-full rounded-xl bg-gray-800 border border-gray-700 px-4 py-3 text-sm font-medium text-white hover:bg-gray-700 transition-all mb-2 disabled:opacity-50"
          >
            {guestLoading ? 'Loading...' : 'Continue as Guest'}
          </button>
          <button
            onClick={() => { setShowGuestLimits(false); setShowAuthGate(true); setAuthIntentMode('video') }}
            className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-500 transition-all"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen relative overflow-x-hidden flex flex-col bg-gray-950">
      <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-violet-600/8 rounded-full blur-3xl" />

      <div className="relative z-10 flex-1 flex flex-col">
        {/* Nav */}
        <nav className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 max-w-6xl mx-auto w-full">
          <button onClick={() => router.push('/')} className="flex items-center">
            <img src="/logo.svg" alt="HippiChat" className="h-10 sm:h-12 w-auto" />
          </button>
          {sessionLoading ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/80 px-3 py-2 text-xs text-gray-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
            </div>
          ) : (
            <GoogleAuthButton compact onSignInSuccess={setSessionUser} onLogoutSuccess={() => setSessionUser(null)} userOverride={sessionUser} />
          )}
        </nav>

        <main className="flex flex-col items-center px-4 sm:px-6 pt-4 sm:pt-8 pb-4 max-w-4xl mx-auto w-full text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-600/10 border border-violet-500/20 text-violet-300 text-xs sm:text-sm mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            Random video and voice chat
          </div>

          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-bold leading-tight mb-3 sm:mb-4">
            Meet someone new.<br />
            <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">Start talking instantly.</span>
          </h1>

          <p className="text-sm sm:text-base lg:text-lg text-gray-400 max-w-xl mb-3 sm:mb-4">
            Random video and voice chat — meet strangers worldwide, skip fast, add friends, and reconnect later.
          </p>

          {renderOnlineCount()}

          {/* Primary CTAs */}
          <div className="mt-4 sm:mt-5 flex flex-col sm:flex-row items-center gap-3">
            <button
              onClick={() => { void handleStartChat('video') }}
              disabled={sessionLoading}
              className="group w-full sm:w-auto px-8 sm:px-10 py-3.5 sm:py-4 bg-violet-600 hover:bg-violet-500 rounded-xl text-lg sm:text-xl font-bold transition-all duration-200 active:scale-95 shadow-lg shadow-violet-600/25 flex items-center justify-center gap-3 disabled:opacity-60"
            >
              Meet a Stranger
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
            <button
              onClick={() => { void handleStartChat('voice') }}
              disabled={sessionLoading}
              className="group w-full sm:w-auto px-6 py-3.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl text-base font-semibold transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <Mic className="w-4 h-4 text-purple-400" />
              Voice Chat
            </button>
          </div>

          {/* Guest option */}
          <div className="mt-3 flex flex-col items-center gap-1">
            <button
              onClick={() => setShowGuestLimits(true)}
              disabled={guestLoading}
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
            >
              <UserX className="w-3.5 h-3.5" />
              {guestLoading ? 'Loading...' : 'Continue as Guest'}
            </button>
            <p className="text-xs text-gray-600">No account needed · limited features</p>
          </div>

          {/* Phrase animation */}
          <div className="mt-4 sm:mt-5 flex items-center gap-2 sm:gap-4">
            <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-xl px-3 sm:px-5 py-2 sm:py-3">
              <div className="text-sm sm:text-lg font-medium">{HERO_PHRASES[phraseIndex].text}</div>
              <div className="text-[10px] sm:text-xs text-gray-500">{HERO_PHRASES[phraseIndex].hint}</div>
            </div>
            <ArrowRight className="w-4 h-4 text-violet-400 shrink-0" />
            <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-xl px-3 sm:px-5 py-2 sm:py-3">
              <div className="text-sm sm:text-lg font-medium">{HERO_PHRASES[(phraseIndex + 1) % HERO_PHRASES.length].text}</div>
              <div className="text-[10px] sm:text-xs text-gray-500">{HERO_PHRASES[(phraseIndex + 1) % HERO_PHRASES.length].hint}</div>
            </div>
          </div>

          {/* Ad banners */}
          <div className="mt-5 sm:mt-6 w-full flex justify-center">
            <AdsterraBanner />
          </div>
          <div className="mt-4 w-full">
            <AdsterraNativeBanner />
          </div>

          {/* Feature cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5 sm:mt-6 w-full">
            {[
              { icon: Video, title: 'Video + Voice', desc: 'Choose between face-to-face video or voice-only matching.' },
              { icon: MessageSquare, title: 'Text Chat Included', desc: 'Built-in text chat during every match.' },
              { icon: Sparkles, title: 'Friends + History', desc: 'Add people you liked and revisit recent interactions. (Sign-in required)' },
            ].map((f, i) => (
              <div key={i} className="bg-gray-900/50 backdrop-blur border border-gray-800/50 rounded-2xl p-4 sm:p-5 text-left">
                <div className="w-9 h-9 rounded-lg bg-violet-600/10 flex items-center justify-center mb-3">
                  <f.icon className="w-4 h-4 text-violet-400" />
                </div>
                <h3 className="font-semibold text-white mb-1 text-sm">{f.title}</h3>
                <p className="text-xs text-gray-400">{f.desc}</p>
              </div>
            ))}
          </div>

          {/* Bottom CTA for mobile */}
          <button
            onClick={() => { void handleStartChat('video') }}
            disabled={sessionLoading}
            className="mt-6 sm:hidden group w-full px-8 py-4 bg-violet-600 hover:bg-violet-500 rounded-xl text-lg font-bold transition-all duration-200 active:scale-95 shadow-lg shadow-violet-600/25 flex items-center justify-center gap-3 disabled:opacity-60"
          >
            Meet a Stranger
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </button>
        </main>
      </div>

      {renderAuthGate()}
      {renderGuestLimitsModal()}
      <SiteFooter />
    </div>
  )
}