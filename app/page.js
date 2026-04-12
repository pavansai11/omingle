'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import { AdsterraBanner, AdsterraNativeBanner } from '@/components/adsterra-ads'
import SiteFooter from '@/components/site-footer'
import { Mic, Video, MessageSquare, Shield, ArrowRight, X, Check, Sparkles, Loader2, Users } from 'lucide-react'

const HERO_PHRASES = [
  { text: 'Meet strangers', hint: 'Live worldwide' },
  { text: 'Video or voice', hint: 'Your choice' },
  { text: 'Add friends', hint: 'Reconnect later' },
  { text: 'Skip fast', hint: 'Move on instantly' },
]

export default function HomePage() {
  const router = useRouter()
  const [step, setStep] = useState('landing')
  const [consent, setConsent] = useState({ age: false, terms: false, monitoring: false })
  const [sessionUser, setSessionUser] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [showAuthGate, setShowAuthGate] = useState(false)
  const [authIntentMode, setAuthIntentMode] = useState(null)
  const [phraseIndex, setPhraseIndex] = useState(0)
  const [onlineCount, setOnlineCount] = useState(null)

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
      } catch (e) {
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
      } catch (e) {}
    }
    fetchStats()
  }, [])

  const allConsented = consent.age && consent.terms && consent.monitoring

  const proceedToChat = useCallback((mode) => router.push(buildChatUrl(mode)), [buildChatUrl, router])

  const handleStartChat = useCallback(async (mode) => {
    if (sessionLoading) return
    try {
      const freshUser = await loadSession()
      if (freshUser) { setSessionUser(freshUser); proceedToChat(mode); return }
    } catch (error) {}
    setAuthIntentMode(mode)
    setShowAuthGate(true)
  }, [loadSession, proceedToChat, sessionLoading])

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
          <p className="text-sm text-gray-400 mb-4">Please sign in with your Google account before starting chat.</p>
          <div className="flex justify-center">
            <GoogleAuthButton onSignInSuccess={handleAuthGateSignInSuccess} />
          </div>
        </div>
      </div>
    )
  }

  if (step === 'landing') {
    return (
      // FIX 6: Full-screen layout so CTA is always above the fold
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

          {/* FIX 6: Hero — compact enough that CTA stays above fold on all screens */}
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

            {/* FIX 6: CTA - prominent "Meet a Stranger" button, always visible */}
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

            <p className="text-xs text-gray-500 mt-2">Google sign-in required · Video + voice · Friends & history</p>

            {/* FIX 6: Phrase animation — compact horizontal below CTA */}
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

            {/* FIX 6: Ad placement — no empty box, just render ads directly.
                Mobile: 320x50 banner (already loaded from AdsterraBanner).
                Desktop: 728x90. No wrapper border if ad is empty. */}
            <div className="mt-5 sm:mt-6 w-full flex justify-center">
              <AdsterraBanner />
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5 sm:mt-6 w-full">
              {[
                { icon: Video, title: 'Video + Voice', desc: 'Choose between face-to-face video or voice-only matching.' },
                { icon: MessageSquare, title: 'Text Chat Included', desc: 'Built-in text chat during every match.' },
                { icon: Sparkles, title: 'Friends + History', desc: 'Add people you liked and revisit recent interactions.' },
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

            {/* Native banner ad below features — no box border */}
            <div className="mt-5 w-full">
              <AdsterraNativeBanner />
            </div>

            {/* Bottom CTA repeat for mobile users who scrolled past */}
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
        <SiteFooter />
      </div>
    )
  }

  if (step === 'consent') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setStep('landing')} />
        <div className="relative z-10 bg-gray-900 border border-gray-800 rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">Before we start</h2>
            <button onClick={() => setStep('landing')} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
          </div>
          <p className="text-sm text-gray-400 mb-6">HippiChat connects you with random strangers. Please review our guidelines:</p>
          <div className="space-y-4 mb-6">
            {[
              { key: 'age', label: <span>I confirm I am <strong>18 years or older</strong></span> },
              { key: 'terms', label: <span>I agree to the <strong>Terms of Service</strong> and <strong>Community Guidelines</strong></span> },
              { key: 'monitoring', label: <span>I understand conversations may be <strong>monitored for safety</strong></span> },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-start gap-3 cursor-pointer group">
                <div
                  className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${consent[key] ? 'bg-violet-600 border-violet-600' : 'border-gray-600 group-hover:border-violet-400'}`}
                  onClick={() => setConsent(p => ({ ...p, [key]: !p[key] }))}
                >
                  {consent[key] && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="text-sm text-gray-300" onClick={() => setConsent(p => ({ ...p, [key]: !p[key] }))}>{label}</span>
              </label>
            ))}
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 mb-6 text-xs text-gray-400">
            <p className="font-semibold text-gray-300 mb-2 flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-violet-400" /> Community Guidelines</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>No nudity or sexual content</li>
              <li>No hate speech, harassment, or bullying</li>
              <li>No spam or commercial solicitation</li>
              <li>Report abusive users immediately</li>
            </ul>
          </div>
          <button disabled={!allConsented} onClick={() => setStep('mode')}
            className={`w-full py-3 rounded-xl font-semibold transition-all duration-200 ${allConsented ? 'bg-violet-600 hover:bg-violet-500 text-white active:scale-[0.98]' : 'bg-gray-800 text-gray-500 cursor-not-allowed'}`}>
            I Agree &amp; Continue
          </button>
        </div>
        {renderAuthGate()}
      </div>
    )
  }

  if (step === 'mode') {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-8 flex flex-col items-center justify-center">
        <div className="max-w-2xl mx-auto w-full">
          <button onClick={() => setStep('consent')} className="text-gray-400 hover:text-white text-sm mb-8 flex items-center gap-1">← Back</button>
          <h2 className="text-2xl font-bold mb-2 text-center">How do you want to chat?</h2>
          <p className="text-gray-400 mb-8 text-center">Choose how you want to connect.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <button onClick={() => handleStartChat('video')} className="group bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left hover:border-violet-500/50 transition-all hover:bg-gray-900/80 active:scale-[0.98]">
              <div className="w-14 h-14 rounded-xl bg-violet-600/10 flex items-center justify-center mb-5 group-hover:bg-violet-600/20 transition-colors">
                <Video className="w-7 h-7 text-violet-400" />
              </div>
              <h3 className="text-lg font-bold mb-2">Video Chat</h3>
              <p className="text-sm text-gray-400 mb-4">See and hear your match instantly with the default HippiChat experience</p>
              <div className="flex items-center gap-1.5 text-xs text-violet-400"><MessageSquare className="w-3.5 h-3.5" /> Text chat always available</div>
            </button>
            <button onClick={() => handleStartChat('voice')} className="group bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left hover:border-violet-500/50 transition-all hover:bg-gray-900/80 active:scale-[0.98]">
              <div className="w-14 h-14 rounded-xl bg-purple-600/10 flex items-center justify-center mb-5 group-hover:bg-purple-600/20 transition-colors">
                <Mic className="w-7 h-7 text-purple-400" />
              </div>
              <h3 className="text-lg font-bold mb-2">Voice Only</h3>
              <p className="text-sm text-gray-400 mb-4">Talk without video when you want a lighter and more private experience</p>
              <div className="flex items-center gap-1.5 text-xs text-purple-400"><MessageSquare className="w-3.5 h-3.5" /> Text chat always available</div>
            </button>
          </div>
        </div>
        {renderAuthGate()}
      </div>
    )
  }

  return null
}