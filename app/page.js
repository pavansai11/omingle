'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import SponsoredLinkCard from '@/components/sponsored-link-card'
import { Mic, Video, MessageSquare, Shield, ArrowRight, X, Check, Sparkles, Loader2 } from 'lucide-react'

const HERO_PHRASES = [
  { text: 'Meet strangers', hint: 'Live worldwide' },
  { text: 'Video or voice', hint: 'Your choice' },
  { text: 'Add friends', hint: 'Reconnect later' },
  { text: 'Skip fast', hint: 'Move on instantly' },
]

const DIRECT_LINK_URL = process.env.NEXT_PUBLIC_DIRECT_LINK_URL || 'https://omg10.com/4/10800693'
const TESTING_ALLOW_ANON = process.env.NEXT_PUBLIC_TESTING_ALLOW_ANON === 'true'
const TESTING_DISABLE_ADS = process.env.NEXT_PUBLIC_TESTING_DISABLE_ADS === 'true'

export default function HomePage() {
  const router = useRouter()
  const [step, setStep] = useState('landing')
  const [consent, setConsent] = useState({ age: false, terms: false, monitoring: false })
  const [sessionUser, setSessionUser] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [showAuthGate, setShowAuthGate] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [phraseIndex, setPhraseIndex] = useState(0)

  const buildChatUrlForUser = useCallback((mode = 'video', user = sessionUser) => {
    const primaryCode = user?.primaryLanguage?.code || 'en-US'
    const additional = Array.isArray(user?.additionalLanguages) ? user.additionalLanguages : []
    const others = additional.map((lang) => lang?.code).filter(Boolean).join(',')
    return `/chat?mode=${mode}&lang=${primaryCode}${others ? `&others=${others}` : ''}`
  }, [sessionUser])

  const buildAnonChatUrl = useCallback((mode = 'video') => {
    return `/chat?mode=${mode}&lang=en-US`
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % HERO_PHRASES.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadSession() {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled) {
          setSessionUser(data?.user || null)
        }
      } catch (e) {
        if (!cancelled) {
          setSessionUser(null)
        }
      } finally {
        if (!cancelled) {
          setSessionLoading(false)
        }
      }
    }

    loadSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (TESTING_ALLOW_ANON && !sessionLoading && !sessionUser) {
      router.replace(buildAnonChatUrl('video'))
      return
    }
    if (!sessionLoading && sessionUser) {
      router.replace(buildChatUrlForUser('video', sessionUser))
    }
  }, [buildAnonChatUrl, buildChatUrlForUser, router, sessionLoading, sessionUser])

  const allConsented = consent.age && consent.terms && consent.monitoring

  const proceedToChat = useCallback((mode, user = sessionUser) => {
    if (TESTING_ALLOW_ANON && !user) {
      router.push(buildAnonChatUrl(mode))
      return
    }
    router.push(buildChatUrlForUser(mode, user))
  }, [buildAnonChatUrl, buildChatUrlForUser, router, sessionUser])

  const ensureAuthenticated = useCallback((action) => {
    if (TESTING_ALLOW_ANON) return true
    if (sessionUser) return true
    setPendingAction(action)
    setShowAuthGate(true)
    return false
  }, [sessionUser])

  const handleStartChat = useCallback((mode) => {
    if (!ensureAuthenticated({ type: 'chat', mode })) return
    proceedToChat(mode)
  }, [ensureAuthenticated, proceedToChat])

  useEffect(() => {
    if (!sessionUser || !pendingAction) return

    const action = pendingAction
    setPendingAction(null)
    setShowAuthGate(false)

    if (action.type === 'start-flow') {
      setStep('consent')
      return
    }

    if (action.type === 'chat') {
      proceedToChat(action.mode, sessionUser)
    }
  }, [pendingAction, proceedToChat, sessionUser])

  const renderAuthGate = () => {
    if (!showAuthGate) return null

    return (
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Sign in to continue</h3>
            <button onClick={() => setShowAuthGate(false)} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-gray-400 mb-4">
            Please sign in with your Google account before starting chat.
          </p>
          <div className="flex justify-center">
            <GoogleAuthButton onUserChange={setSessionUser} />
          </div>
        </div>
      </div>
    )
  }

  if (!sessionLoading && sessionUser) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="inline-flex items-center gap-3 rounded-full border border-gray-800 bg-gray-900/80 px-4 py-3 text-sm text-gray-300">
          <Loader2 className="w-4 h-4 animate-spin" /> Redirecting to chat...
        </div>
      </div>
    )
  }

  const currentPhrase = HERO_PHRASES[phraseIndex]
  const nextPhrase = HERO_PHRASES[(phraseIndex + 1) % HERO_PHRASES.length]

  if (step === 'landing') {
    return (
      <div className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-gray-950 via-violet-950/20 to-gray-950" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-violet-600/10 rounded-full blur-3xl" />

        <div className="relative z-10">
          <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
            <button onClick={() => router.push('/')} className="flex items-center">
              <img src="/logo.svg" alt="HippiChat" className="h-10 sm:h-11 w-auto" />
            </button>
            {sessionLoading ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/80 px-3 py-2 text-xs text-gray-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
              </div>
            ) : TESTING_ALLOW_ANON ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                Testing mode
              </div>
            ) : (
              <GoogleAuthButton compact onUserChange={setSessionUser} />
            )}
          </nav>

          <main className="flex flex-col items-center justify-center px-6 pt-16 pb-24 max-w-4xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-600/10 border border-violet-500/20 text-violet-300 text-sm mb-8">
              <Sparkles className="w-4 h-4" />
              Random video and voice chat
            </div>

            <h1 className="text-5xl sm:text-7xl font-bold leading-tight mb-6">
              Meet someone new.
              <br />
              <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Start talking instantly.
              </span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mb-12">
              HippiChat makes random video and voice chat simple.
              Meet strangers worldwide, skip quickly, add friends, and reconnect later.
            </p>

            <div className="flex items-center gap-4 sm:gap-8 mb-12">
              <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-2xl px-6 py-4">
                <div className="text-2xl sm:text-3xl font-medium mb-1">{currentPhrase.text}</div>
                <div className="text-xs text-gray-500">{currentPhrase.hint}</div>
              </div>

              <ArrowRight className="w-5 h-5 text-violet-400" />

              <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-2xl px-6 py-4">
                <div className="text-2xl sm:text-3xl font-medium mb-1">{nextPhrase.text}</div>
                <div className="text-xs text-gray-500">{nextPhrase.hint}</div>
              </div>
            </div>

            <button
              onClick={() => {
                if (!ensureAuthenticated({ type: 'start-flow' })) return
                setStep('consent')
              }}
              className="group px-8 py-4 bg-violet-600 hover:bg-violet-500 rounded-xl text-lg font-semibold transition-all duration-200 active:scale-95 shadow-lg shadow-violet-600/25 flex items-center gap-3"
            >
              Start Chatting
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>

            <p className="text-sm text-gray-500 mt-4">
              {TESTING_ALLOW_ANON
                ? 'Testing mode • Anonymous access enabled • Video + voice chat'
                : 'Google sign-in required • Video + voice chat • Friends and history built in'}
            </p>

            {!TESTING_DISABLE_ADS && (
              <SponsoredLinkCard
                href={DIRECT_LINK_URL}
                title="Sponsored offer"
                description="Explore this sponsored link while we keep HippiChat free to use."
                cta="Learn more"
                className="mt-10 w-full max-w-2xl"
              />
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-20 w-full">
              {[
                { icon: Video, title: 'Video + Voice', desc: 'Choose between face-to-face video chat or voice-only matching.' },
                { icon: MessageSquare, title: 'Text Chat Included', desc: 'Keep the conversation going with built-in text chat during every match.' },
                { icon: Sparkles, title: 'Friends + History', desc: 'Add people you liked and revisit recent interactions whenever needed.' },
              ].map((f, i) => (
                <div key={i} className="bg-gray-900/50 backdrop-blur border border-gray-800/50 rounded-2xl p-6 text-left">
                  <div className="w-10 h-10 rounded-lg bg-violet-600/10 flex items-center justify-center mb-4">
                    <f.icon className="w-5 h-5 text-violet-400" />
                  </div>
                  <h3 className="font-semibold text-white mb-2">{f.title}</h3>
                  <p className="text-sm text-gray-400">{f.desc}</p>
                </div>
              ))}
            </div>
          </main>
        </div>
        {renderAuthGate()}
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
            <button onClick={() => setStep('landing')} className="text-gray-400 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-gray-400 mb-6">
            HippiChat connects you with random strangers. Please review our guidelines:
          </p>

          <div className="space-y-4 mb-6">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${consent.age ? 'bg-violet-600 border-violet-600' : 'border-gray-600 group-hover:border-violet-400'}`}
                onClick={() => setConsent(p => ({ ...p, age: !p.age }))}>
                {consent.age && <Check className="w-3 h-3 text-white" />}
              </div>
              <span className="text-sm text-gray-300" onClick={() => setConsent(p => ({ ...p, age: !p.age }))}>
                I confirm I am <strong>18 years or older</strong>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer group">
              <div className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${consent.terms ? 'bg-violet-600 border-violet-600' : 'border-gray-600 group-hover:border-violet-400'}`}
                onClick={() => setConsent(p => ({ ...p, terms: !p.terms }))}>
                {consent.terms && <Check className="w-3 h-3 text-white" />}
              </div>
              <span className="text-sm text-gray-300" onClick={() => setConsent(p => ({ ...p, terms: !p.terms }))}>
                I agree to the <strong>Terms of Service</strong> and <strong>Community Guidelines</strong>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer group">
              <div className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${consent.monitoring ? 'bg-violet-600 border-violet-600' : 'border-gray-600 group-hover:border-violet-400'}`}
                onClick={() => setConsent(p => ({ ...p, monitoring: !p.monitoring }))}>
                {consent.monitoring && <Check className="w-3 h-3 text-white" />}
              </div>
              <span className="text-sm text-gray-300" onClick={() => setConsent(p => ({ ...p, monitoring: !p.monitoring }))}>
                I understand conversations may be <strong>monitored for safety</strong>
              </span>
            </label>
          </div>

          <div className="bg-gray-800/50 rounded-xl p-4 mb-6 text-xs text-gray-400">
            <p className="font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-violet-400" /> Community Guidelines
            </p>
            <ul className="space-y-1 list-disc list-inside">
              <li>No nudity or sexual content</li>
              <li>No hate speech, harassment, or bullying</li>
              <li>No spam or commercial solicitation</li>
              <li>Report abusive users immediately</li>
            </ul>
          </div>

          <button
            disabled={!allConsented}
            onClick={() => setStep('mode')}
            className={`w-full py-3 rounded-xl font-semibold transition-all duration-200 ${allConsented
              ? 'bg-violet-600 hover:bg-violet-500 text-white active:scale-[0.98]'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed'}`}
          >
            I Agree & Continue
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
          <button onClick={() => setStep('consent')} className="text-gray-400 hover:text-white text-sm mb-8 flex items-center gap-1">
            ← Back
          </button>

          <h2 className="text-2xl font-bold mb-2 text-center">How do you want to chat?</h2>
          <p className="text-gray-400 mb-8 text-center">
            Choose how you want to connect. Interests can be adjusted later from Filters.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <button
              onClick={() => handleStartChat('video')}
              className="group bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left hover:border-violet-500/50 transition-all hover:bg-gray-900/80 active:scale-[0.98]"
            >
              <div className="w-14 h-14 rounded-xl bg-violet-600/10 flex items-center justify-center mb-5 group-hover:bg-violet-600/20 transition-colors">
                <Video className="w-7 h-7 text-violet-400" />
              </div>
              <h3 className="text-lg font-bold mb-2">Video Chat</h3>
              <p className="text-sm text-gray-400 mb-4">See and hear your match instantly with the default HippiChat experience</p>
              <div className="flex items-center gap-1.5 text-xs text-violet-400">
                <MessageSquare className="w-3.5 h-3.5" /> Text chat always available
              </div>
            </button>

            <button
              onClick={() => handleStartChat('voice')}
              className="group bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left hover:border-violet-500/50 transition-all hover:bg-gray-900/80 active:scale-[0.98]"
            >
              <div className="w-14 h-14 rounded-xl bg-purple-600/10 flex items-center justify-center mb-5 group-hover:bg-purple-600/20 transition-colors">
                <Mic className="w-7 h-7 text-purple-400" />
              </div>
              <h3 className="text-lg font-bold mb-2">Voice Only</h3>
              <p className="text-sm text-gray-400 mb-4">Talk without video when you want a lighter and more private experience</p>
              <div className="flex items-center gap-1.5 text-xs text-purple-400">
                <MessageSquare className="w-3.5 h-3.5" /> Text chat always available
              </div>
            </button>
          </div>
        </div>
        {renderAuthGate()}
      </div>
    )
  }

  return null
}