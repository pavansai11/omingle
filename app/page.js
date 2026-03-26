'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import { ALL_LANGUAGES, INDIAN_LANGUAGES, INTERNATIONAL_LANGUAGES, getLanguageByCode } from '@/lib/languages'
import { Mic, Video, MessageSquare, Shield, ArrowRight, X, Search, Check, Languages, Sparkles, Loader2 } from 'lucide-react'

const HERO_PHRASES = [
  { text: 'Meet strangers', lang: 'Live worldwide' },
  { text: 'Video or voice', lang: 'Your choice' },
  { text: 'Add friends', lang: 'Reconnect later' },
  { text: 'Skip fast', lang: 'Move on instantly' },
  { text: 'Stay simple', lang: 'No clutter, just chat' },
]

export default function HomePage() {
  const router = useRouter()
  const [step, setStep] = useState('landing')
  const [consent, setConsent] = useState({ age: false, terms: false, monitoring: false })
  const [sessionUser, setSessionUser] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [showAuthGate, setShowAuthGate] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [primaryLanguage, setPrimaryLanguage] = useState(null)
  const [additionalLanguages, setAdditionalLanguages] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [phraseIndex, setPhraseIndex] = useState(0)
  const [setupSaving, setSetupSaving] = useState(false)
  const [setupError, setSetupError] = useState(null)

  const buildChatUrlForUser = useCallback((mode = 'video', user = sessionUser) => {
    const primary = user?.primaryLanguage || getLanguageByCode('en-US') || ALL_LANGUAGES[0]
    const additional = Array.isArray(user?.additionalLanguages) ? user.additionalLanguages : []
    const others = additional.map((lang) => lang.code).filter(Boolean).join(',')
    return `/chat?mode=${mode}&lang=${primary.code}${others ? `&others=${others}` : ''}`
  }, [sessionUser])

  // Rotate phrases
  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex(prev => (prev + 1) % HERO_PHRASES.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [])

  // Load saved language from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('omingle_primary_lang')
      if (saved) {
        const parsed = JSON.parse(saved)
        const found = ALL_LANGUAGES.find(l => l.code === parsed.code)
        if (found) setPrimaryLanguage(found)
      }
    } catch (e) {}
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
    if (!sessionLoading && sessionUser?.profileCompleted) {
      router.replace(buildChatUrlForUser('video', sessionUser))
    }
  }, [buildChatUrlForUser, router, sessionLoading, sessionUser])

  useEffect(() => {
    if (!sessionLoading && sessionUser && !sessionUser.profileCompleted) {
      setStep('setup')
      if (sessionUser.primaryLanguage) {
        setPrimaryLanguage(sessionUser.primaryLanguage)
      }
      if (Array.isArray(sessionUser.additionalLanguages)) {
        setAdditionalLanguages(sessionUser.additionalLanguages)
      }
    }
  }, [sessionLoading, sessionUser])

  const allConsented = consent.age && consent.terms && consent.monitoring

  const filteredLanguages = useMemo(() => {
    if (!searchQuery.trim()) return { indian: INDIAN_LANGUAGES, international: INTERNATIONAL_LANGUAGES }
    const q = searchQuery.toLowerCase()
    return {
      indian: INDIAN_LANGUAGES.filter(l =>
        l.name.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q)
      ),
      international: INTERNATIONAL_LANGUAGES.filter(l =>
        l.name.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q)
      ),
    }
  }, [searchQuery])

  const handleSelectPrimary = useCallback((lang) => {
    setPrimaryLanguage(lang)
    try { localStorage.setItem('omingle_primary_lang', JSON.stringify(lang)) } catch (e) {}
  }, [])

  const handleToggleAdditional = useCallback((lang) => {
    setAdditionalLanguages(prev => {
      if (prev.find(l => l.code === lang.code)) {
        return prev.filter(l => l.code !== lang.code)
      }
      if (prev.length >= 5) return prev
      return [...prev, lang]
    })
  }, [])

  const proceedToChat = useCallback((mode) => {
    router.push(buildChatUrlForUser(mode))
  }, [buildChatUrlForUser, router])

  const ensureAuthenticated = useCallback((action) => {
    if (sessionUser) return true
    setPendingAction(action)
    setShowAuthGate(true)
    return false
  }, [sessionUser])

  const handleStartChat = useCallback((mode) => {
    if (!sessionUser?.profileCompleted && !primaryLanguage) return
    if (!ensureAuthenticated({ type: 'chat', mode })) return
    proceedToChat(mode)
  }, [ensureAuthenticated, primaryLanguage, proceedToChat, sessionUser?.profileCompleted])

  useEffect(() => {
    if (!sessionUser || !pendingAction) return

    const action = pendingAction
    setPendingAction(null)
    setShowAuthGate(false)

    if (action.type === 'start-flow') {
      if (sessionUser?.profileCompleted) {
        proceedToChat('video')
      } else {
        setStep('consent')
      }
      return
    }

    if (action.type === 'chat') {
      proceedToChat(action.mode)
    }
  }, [pendingAction, proceedToChat, sessionUser])

  async function handleContinueFromSetup() {
    if (!sessionUser?.id || !primaryLanguage) {
      setSetupError('Please choose a primary language to continue')
      return
    }

    setSetupSaving(true)
    setSetupError(null)
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sessionUser.name,
          primaryLanguage,
          additionalLanguages,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to save your profile')
      }

      setSessionUser(data.user)
      setStep('mode')
    } catch (error) {
      setSetupError(error?.message || 'Failed to save your profile')
    } finally {
      setSetupSaving(false)
    }
  }

  if (sessionLoading || sessionUser?.profileCompleted) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="inline-flex items-center gap-3 rounded-full border border-gray-800 bg-gray-900/80 px-4 py-3 text-sm text-gray-300">
          <Loader2 className="w-4 h-4 animate-spin" /> Redirecting to chat...
        </div>
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

  const currentPhrase = HERO_PHRASES[phraseIndex]
  const nextPhrase = HERO_PHRASES[(phraseIndex + 1) % HERO_PHRASES.length]

  // =================== LANDING STEP ===================
  if (step === 'landing') {
    return (
      <div className="min-h-screen relative overflow-hidden">
        {/* Gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-gray-950 via-violet-950/20 to-gray-950" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-violet-600/10 rounded-full blur-3xl" />

        <div className="relative z-10">
          {/* Nav */}
          <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
            <button onClick={() => router.push('/')} className="flex items-center">
              <img src="/logo.svg" alt="HappiChat" className="h-10 sm:h-11 w-auto" />
            </button>
            {sessionLoading ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/80 px-3 py-2 text-xs text-gray-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
              </div>
            ) : (
              <GoogleAuthButton compact onUserChange={setSessionUser} />
            )}
          </nav>

          {/* Hero */}
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
              HappiChat makes random video and voice chat simple.
              Meet strangers worldwide, skip quickly, add friends, and reconnect later.
            </p>

            {/* Animated Translation Visual */}
            <div className="flex items-center gap-4 sm:gap-8 mb-12">
              <div className="animate-float">
                <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-2xl px-6 py-4 shadow-lg shadow-violet-900/20">
                  <div className="text-2xl sm:text-3xl font-medium mb-1 transition-all duration-500" key={phraseIndex}>
                    {currentPhrase.text}
                  </div>
                  <div className="text-xs text-gray-500">{currentPhrase.lang}</div>
                </div>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="w-10 h-10 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center animate-glow-pulse">
                  <Languages className="w-5 h-5 text-violet-400" />
                </div>
                <div className="text-[10px] text-violet-400/60">AI</div>
              </div>

              <div className="animate-float-delayed">
                <div className="bg-gray-800/80 backdrop-blur border border-gray-700/50 rounded-2xl px-6 py-4 shadow-lg shadow-purple-900/20">
                  <div className="text-2xl sm:text-3xl font-medium mb-1 transition-all duration-500" key={phraseIndex + 100}>
                    {nextPhrase.text}
                  </div>
                  <div className="text-xs text-gray-500">{nextPhrase.lang}</div>
                </div>
              </div>
            </div>

            {/* CTA */}
            <button
              onClick={() => {
                if (!ensureAuthenticated({ type: 'start-flow' })) return
                setStep('consent')
              }}
              className="group px-8 py-4 bg-violet-600 hover:bg-violet-500 rounded-xl text-lg font-semibold transition-all duration-200 active:scale-95 shadow-lg shadow-violet-600/25 hover:shadow-violet-500/30 flex items-center gap-3"
            >
              Start Chatting
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>

            <p className="text-sm text-gray-500 mt-4">
              Google sign-in required • Video + voice chat • Friends and history built in
            </p>

            {/* Feature Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-20 w-full">
              {[
                { icon: Video, title: 'Video + Voice', desc: 'Choose between face-to-face video chat or voice-only matching.' },
                { icon: MessageSquare, title: 'Text Chat Included', desc: 'Keep the conversation going with built-in text chat during every match.' },
                { icon: Sparkles, title: 'Friends + History', desc: 'Add people you liked and revisit recent interactions whenever needed.' },
              ].map((f, i) => (
                <div key={i} className="bg-gray-900/50 backdrop-blur border border-gray-800/50 rounded-2xl p-6 text-left hover:border-violet-500/30 transition-colors">
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

  // =================== CONSENT STEP ===================
  if (step === 'consent') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setStep('landing')} />
        <div className="relative z-10 bg-gray-900 border border-gray-800 rounded-2xl p-6 sm:p-8 max-w-md w-full animate-slide-up shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">Before we start</h2>
            <button onClick={() => setStep('landing')} className="text-gray-400 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-gray-400 mb-6">
            HappiChat connects you with random strangers. Please review our guidelines:
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
            onClick={() => setStep('setup')}
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

  // =================== LANGUAGE SETUP STEP ===================
  if (step === 'setup') {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <button onClick={() => setStep('consent')} className="text-gray-400 hover:text-white text-sm mb-8 flex items-center gap-1">
            ← Back
          </button>

          <h2 className="text-2xl font-bold mb-2">Choose your language</h2>
          <p className="text-gray-400 mb-8">We'll match you with people and translate in real-time.</p>

          {/* Search */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search languages..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all"
            />
          </div>

          {/* Primary Language */}
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <span className="w-5 h-5 bg-violet-600 rounded-full text-xs flex items-center justify-center text-white font-bold">1</span>
              Your primary language
            </h3>

            {primaryLanguage && (
              <div className="mb-3 flex items-center gap-2 bg-violet-600/10 border border-violet-500/30 rounded-xl px-4 py-2.5">
                <span className="text-lg">{primaryLanguage.flag}</span>
                <span className="font-medium">{primaryLanguage.name}</span>
                <span className="text-sm text-gray-400">({primaryLanguage.nativeName})</span>
                <button onClick={() => setPrimaryLanguage(null)} className="ml-auto text-gray-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {!primaryLanguage && (
              <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                {filteredLanguages.indian.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 px-1">Indian Languages</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {filteredLanguages.indian.map(lang => (
                        <button key={lang.code} onClick={() => handleSelectPrimary(lang)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-900/50 hover:bg-gray-800 border border-gray-800/50 hover:border-violet-500/30 transition-all text-left">
                          <span className="text-lg">{lang.flag}</span>
                          <div>
                            <div className="text-sm font-medium">{lang.name}</div>
                            <div className="text-xs text-gray-500">{lang.nativeName}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {filteredLanguages.international.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 px-1 mt-4">International Languages</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {filteredLanguages.international.map(lang => (
                        <button key={lang.code} onClick={() => handleSelectPrimary(lang)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-900/50 hover:bg-gray-800 border border-gray-800/50 hover:border-violet-500/30 transition-all text-left">
                          <span className="text-lg">{lang.flag}</span>
                          <div>
                            <div className="text-sm font-medium">{lang.name}</div>
                            <div className="text-xs text-gray-500">{lang.nativeName}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Additional Languages */}
          {primaryLanguage && (
            <div className="mb-8 animate-fade-in">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <span className="w-5 h-5 bg-gray-700 rounded-full text-xs flex items-center justify-center text-white font-bold">2</span>
                Other languages you speak <span className="text-gray-500 font-normal">(optional, max 5)</span>
              </h3>

              {additionalLanguages.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {additionalLanguages.map(lang => (
                    <div key={lang.code} className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-3 py-1.5 text-sm">
                      <span>{lang.flag}</span> {lang.name}
                      <button onClick={() => handleToggleAdditional(lang)} className="text-gray-500 hover:text-white ml-1">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="max-h-40 overflow-y-auto pr-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {ALL_LANGUAGES.filter(l => l.code !== primaryLanguage?.code).map(lang => {
                    const isSelected = additionalLanguages.some(al => al.code === lang.code)
                    return (
                      <button key={lang.code} onClick={() => handleToggleAdditional(lang)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-all ${isSelected
                          ? 'bg-violet-600/10 border border-violet-500/30 text-violet-300'
                          : 'bg-gray-900/30 border border-gray-800/30 hover:bg-gray-800 text-gray-300'}`}>
                        <span>{lang.flag}</span>
                        <span className="truncate">{lang.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Continue to mode selection */}
          {setupError && <p className="mt-3 text-sm text-amber-300">{setupError}</p>}

          {primaryLanguage && (
            <button
              onClick={handleContinueFromSetup}
              disabled={setupSaving}
              className="w-full py-3.5 bg-violet-600 hover:bg-violet-500 rounded-xl font-semibold transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {setupSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Continue <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
        {renderAuthGate()}
      </div>
    )
  }

  // =================== MODE SELECTION STEP ===================
  if (step === 'mode') {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-8 flex flex-col items-center justify-center">
        <div className="max-w-2xl mx-auto w-full">
          <button onClick={() => setStep('setup')} className="text-gray-400 hover:text-white text-sm mb-8 flex items-center gap-1">
            ← Back
          </button>

          <h2 className="text-2xl font-bold mb-2 text-center">How do you want to chat?</h2>
          <p className="text-gray-400 mb-8 text-center">
            Speaking <span className="text-violet-400 font-medium">{primaryLanguage?.name}</span> {primaryLanguage?.flag}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            {/* Video Card */}
            <button
              onClick={() => handleStartChat('video')}
              className="group bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left hover:border-violet-500/50 transition-all hover:bg-gray-900/80 active:scale-[0.98]"
            >
              <div className="w-14 h-14 rounded-xl bg-violet-600/10 flex items-center justify-center mb-5 group-hover:bg-violet-600/20 transition-colors">
                <Video className="w-7 h-7 text-violet-400" />
              </div>
              <h3 className="text-lg font-bold mb-2">Video Chat</h3>
              <p className="text-sm text-gray-400 mb-4">See and hear your match instantly with the default HappiChat experience</p>
              <div className="flex items-center gap-1.5 text-xs text-violet-400">
                <MessageSquare className="w-3.5 h-3.5" /> Text chat always available
              </div>
            </button>

            {/* Voice Card */}
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

          <p className="text-center text-sm text-gray-500">
            Average wait time: <span className="text-gray-300">&lt;30 seconds</span>
          </p>
        </div>
        {renderAuthGate()}
      </div>
    )
  }

  return null
}
