'use client'

import { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import ProfileSettingsModal from '@/components/profile-settings-modal'
import AgeGateModal from '@/components/age-gate-modal'
import { ALL_LANGUAGES } from '@/lib/languages'
import { buildRtcConfig, MAX_CHAT_MESSAGES, LANGUAGE_FACTS, MAX_INTEREST_KEYWORDS, TURN_CREDENTIALS_ENDPOINT } from '@/lib/constants'
import {
  Mic, MicOff, Video, VideoOff, SkipForward, Phone, Flag, Captions, UserPlus,
  Send, MessageSquare, X, Loader2, Globe, Volume2, Users, Play, Square, SlidersHorizontal,
  AlertTriangle, ThumbsUp, Heart
} from 'lucide-react'

const FACE_CHECK_INTERVAL_MS = 5000
const FACE_CONSECUTIVE_MISSES_REQUIRED = 4
const NO_FACE_TIMEOUT_MS = 10000
const FACEAPI_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js'
const FACEAPI_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model'
const FACE_DETECTOR_OPTIONS = { inputSize: 224, scoreThreshold: 0.55 }

const SKIP_THRESHOLD_FOR_AD = 10
const triggerMonetagVignette = () => loadMonetagForNextClick()

function generateId() {
  return Math.random().toString(36).substring(2, 12)
}

const CAPTION_DEBOUNCE_MS = 700
const CAPTIONS_UI_ENABLED = false
const BLUR_FEATURE_ENABLED = false
const MAX_HISTORY_ITEMS = 10
const REPORT_REASONS = [
  { value: 'nudity', label: 'Nudity / sexual content' },
  { value: 'harassment', label: 'Harassment / bullying' },
  { value: 'hate-speech', label: 'Hate speech' },
  { value: 'spam', label: 'Spam / scam' },
  { value: 'underage', label: 'Appears underage' },
  { value: 'other', label: 'Other' },
]

function regionCodeToFlag(regionCode) {
  if (!regionCode || regionCode.length !== 2) return '🌐'
  return regionCode.toUpperCase().split('').map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('')
}

function countryFromCode(regionCode) {
  if (!regionCode) return { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' }
  const upper = regionCode.toUpperCase()
  let countryName = upper
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
    countryName = displayNames.of(upper) || upper
  } catch (e) {}
  return { countryCode: upper, countryName, countryFlag: regionCodeToFlag(upper) }
}

function deriveCountryFromLanguage(language) {
  const code = language?.code
  const regionCode = typeof code === 'string' && code.includes('-') ? code.split('-')[1].toUpperCase() : null
  const country = countryFromCode(regionCode)
  return { ...country, countryFlag: language?.flag || country.countryFlag }
}

function createAnonUserId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `anon_${crypto.randomUUID()}`
  return `anon_${generateId()}_${Date.now()}`
}

function normalizeInterestKeywords(rawKeywords = []) {
  return [...new Set(
    (Array.isArray(rawKeywords) ? rawKeywords : [])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean)
      .map((k) => k.slice(0, 32))
  )].slice(0, MAX_INTEREST_KEYWORDS)
}

function ControlButtons({ primaryActionIsStop, isMediaReady, connectionState, onPrimary, onSkip, onFilters, desktop = false, compact = false }) {
  if (desktop && !compact) {
    return (
      <div className="flex items-stretch gap-2 w-full h-full">
        <button onClick={onPrimary} disabled={!isMediaReady && !primaryActionIsStop}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl text-sm font-bold transition-all bg-gray-800/90 border border-gray-700 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:text-gray-500 py-3">
          {primaryActionIsStop ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {primaryActionIsStop ? 'Stop' : 'Start'}
        </button>
        <button onClick={onSkip} disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl text-sm font-bold transition-all bg-violet-600 text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500 py-3">
          <SkipForward className="w-4 h-4" /> Skip
        </button>
        <button onClick={onFilters}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl text-sm font-bold transition-all bg-amber-400 text-gray-900 hover:bg-amber-300 py-3">
          <SlidersHorizontal className="w-4 h-4" /> Filters
        </button>
      </div>
    )
  }
  if (desktop && compact) {
    return (
      <div className="flex items-stretch gap-2 w-full">
        <button onClick={onPrimary} disabled={!isMediaReady && !primaryActionIsStop}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all bg-gray-800/90 border border-gray-700 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:text-gray-500 py-2.5">
          {primaryActionIsStop ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {primaryActionIsStop ? 'Stop' : 'Start'}
        </button>
        <button onClick={onSkip} disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all bg-violet-600 text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500 py-2.5">
          <SkipForward className="w-3.5 h-3.5" /> Skip
        </button>
        <button onClick={onFilters}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all bg-amber-400 text-gray-900 hover:bg-amber-300 py-2.5">
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters
        </button>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-2 items-center max-w-xl mx-auto">
      <button onClick={onPrimary} disabled={!isMediaReady && !primaryActionIsStop}
        className="inline-flex w-full items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition-all whitespace-nowrap bg-gray-800/90 border border-gray-700 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:text-gray-500">
        {primaryActionIsStop ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        {primaryActionIsStop ? 'Stop' : 'Start'}
      </button>
      <button onClick={onSkip} disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
        className="inline-flex w-full items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition-all whitespace-nowrap bg-violet-600 text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500">
        <SkipForward className="w-3.5 h-3.5" /> Skip
      </button>
      <button onClick={onFilters}
        className="inline-flex w-full items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition-all whitespace-nowrap bg-amber-400 text-gray-900 hover:bg-amber-300">
        <SlidersHorizontal className="w-3.5 h-3.5" /> Filters
      </button>
    </div>
  )
}

function FaceDetectionWarning({ visible, countdown, onDismiss }) {
  if (!visible) return null
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm rounded-xl">
      <div className="text-center px-6 py-5 rounded-2xl border border-amber-500/30 bg-gray-900/90 max-w-xs">
        <div className="text-3xl mb-3">📷</div>
        <p className="text-sm font-semibold text-amber-200 mb-1">Face not detected</p>
        <p className="text-xs text-gray-400 mb-4">Show your face to continue chatting.</p>
        <div className="text-2xl font-bold text-amber-300 tabular-nums">{countdown}s</div>
        <p className="text-[11px] text-gray-500 mt-1">Chat will end if face is not shown</p>
      </div>
    </div>
  )
}

function ReceivedLikeToast({ message, visible }) {
  if (!visible || !message) return null
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 animate-fade-in">
      <div className="flex items-center gap-2 rounded-full border border-pink-500/30 bg-gray-900/90 px-4 py-2 text-sm text-pink-200 shadow-lg backdrop-blur">
        <Heart className="w-4 h-4 text-pink-400 fill-pink-400" />
        {message}
      </div>
    </div>
  )
}

function loadMonetagForNextClick() {
  if (typeof window === 'undefined') return
  try {
    const prev = document.getElementById('monetag-onclick-pop')
    if (prev) prev.parentNode?.removeChild(prev)
    const s = document.createElement('script')
    s.id = 'monetag-onclick-pop'
    s.textContent = "(function(s){s.dataset.zone='10809114',s.src='https://al5sm.com/tag.min.js'})([document.documentElement,document.body].filter(Boolean).pop().appendChild(document.createElement('script')))"
    document.head.appendChild(s)
  } catch (e) {}
}

// ── FIX: ChatMobileAdBanner starts with height 0 to eliminate the gap.
// It expands to 52px only when the ad script actually loads.
function ChatMobileAdBanner() {
  const ref = useRef(null)
  const containerRef = useRef(null)
  const injected = useRef(false)
  useEffect(() => {
    if (injected.current || !ref.current) return
    injected.current = true
    const opt = document.createElement('script')
    opt.text = "window.atOptions = {'key':'136ca117e40190a371bbc86e466823b3','format':'iframe','height':50,'width':320,'params':{}};"
    ref.current.appendChild(opt)
    const inv = document.createElement('script')
    inv.src = 'https://theoreticalassertshame.com/136ca117e40190a371bbc86e466823b3/invoke.js'
    inv.async = true
    inv.onload = () => {
      if (containerRef.current) {
        containerRef.current.style.height = '52px'
      }
    }
    ref.current.appendChild(inv)
  }, [])
  return (
    <div
      ref={containerRef}
      className="sm:hidden shrink-0 w-full bg-gray-950"
      style={{ height: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'height 0.2s' }}
    >
      <div ref={ref} style={{ width: 320, height: 50 }} />
    </div>
  )
}

function ChatDesktopAdBanner({ className = '' }) {
  const ref = useRef(null)
  const injected = useRef(false)
  useEffect(() => {
    if (injected.current || !ref.current) return
    injected.current = true
    const opt = document.createElement('script')
    opt.text = `window.atOptions = {'key':'c58e822612d97408c8a0dfc46a90d5fd','format':'iframe','height':60,'width':468,'params':{}};`
    const inv = document.createElement('script')
    inv.src = 'https://theoreticalassertshame.com/c58e822612d97408c8a0dfc46a90d5fd/invoke.js'
    inv.async = true
    ref.current.appendChild(opt)
    ref.current.appendChild(inv)
  }, [])
  return (
    <div className={`hidden sm:flex shrink-0 justify-center items-center border-t border-gray-800/50 bg-gray-950/50 ${className}`} style={{ height: 62 }}>
      <div ref={ref} style={{ width: 468, height: 60, overflow: 'hidden' }} />
    </div>
  )
}

// ─── VP8 codec preference ─────────────────────────────────────────────────────
function preferVP8(sdp) {
  return sdp.replace(/(m=video \d+ \S+)([\d ]+)/g, (match, prefix, codecs) => {
    const list = codecs.trim().split(' ')
    const vp8 = list.find(pt => sdp.includes(`a=rtpmap:${pt} VP8/`))
    if (!vp8) return match
    return `${prefix} ${[vp8, ...list.filter(c => c !== vp8)].join(' ')}`
  })
}

function ChatPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const mode = searchParams.get('mode') || 'video'
  const primaryLanguage = useMemo(() => ALL_LANGUAGES[0], [])
  const additionalLanguages = useMemo(() => [], [])

  const [connectionState, setConnectionState] = useState('initializing')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [partnerLanguage, setPartnerLanguage] = useState(null)
  const [partnerCountry, setPartnerCountry] = useState(null)
  const [selfCountry, setSelfCountry] = useState({ countryCode: null, countryName: 'Unknown', countryFlag: '🌐' })
  const [partnerId, setPartnerId] = useState(null)
  const [roomId, setRoomId] = useState(null)
  const [callDuration, setCallDuration] = useState(0)
  const [error, setError] = useState(null)
  const [isMediaReady, setIsMediaReady] = useState(false)

  const [messages, setMessages] = useState([])
  const [messageInput, setMessageInput] = useState('')
  const [isPartnerTyping, setIsPartnerTyping] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [mobilePane, setMobilePane] = useState('video')
  const [panelTab, setPanelTab] = useState(null)
  const [showPreferences, setShowPreferences] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modeSwitchConfirm, setModeSwitchConfirm] = useState(null)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [reportReason, setReportReason] = useState('harassment')
  const [reportDetails, setReportDetails] = useState('')
  const [accountBlockedInfo, setAccountBlockedInfo] = useState(null)
  const [friendInviteRequest, setFriendInviteRequest] = useState(null)
  const [pendingInviteRequestId, setPendingInviteRequestId] = useState(null)
  const [unfriendTarget, setUnfriendTarget] = useState(null)
  const [unfriendConfirmStep, setUnfriendConfirmStep] = useState(1)
  const [reportContext, setReportContext] = useState({ targetUserId: null, roomId: null, isCurrent: true })
  const [interactionHistory, setInteractionHistory] = useState([])
  const [friendRequests, setFriendRequests] = useState({ incoming: [], outgoing: [] })
  const [sessionUser, setSessionUser] = useState(null)
  const [sessionResolved, setSessionResolved] = useState(false)
  const [partnerCaption, setPartnerCaption] = useState(null)
  const [commonLanguagesNotice, setCommonLanguagesNotice] = useState('')
  const [friends, setFriends] = useState([])
  const [showFriendsPanel, setShowFriendsPanel] = useState(false)
  const [hasAddedFriendForCurrentMatch, setHasAddedFriendForCurrentMatch] = useState(false)
  const [partnerLikes, setPartnerLikes] = useState(0)
  const [hasLikedPartner, setHasLikedPartner] = useState(false)
  const [hasReportedPartner, setHasReportedPartner] = useState(false)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [partnerUserId, setPartnerUserId] = useState(null)
  const [partnerProfile, setPartnerProfile] = useState(null)
  const [socketConnected, setSocketConnected] = useState(false)
  const [hasCameraPermission, setHasCameraPermission] = useState(mode !== 'video')
  const [factIndex, setFactIndex] = useState(0)
  const [onlineCount, setOnlineCount] = useState(null)
  const [lastOnlineCount, setLastOnlineCount] = useState(null)
  const [interestKeywords, setInterestKeywords] = useState([])
  const [interestInput, setInterestInput] = useState('')
  const [matchedInterests, setMatchedInterests] = useState([])
  const [turnIceServers, setTurnIceServers] = useState([])
  const [matchedInterestsVisible, setMatchedInterestsVisible] = useState(false)
  const [connectionNotice, setConnectionNotice] = useState('')
  const [mediaWarning, setMediaWarning] = useState(null)
  const [skipCount, setSkipCount] = useState(0)

  const [faceWarningVisible, setFaceWarningVisible] = useState(false)
  const [faceCountdown, setFaceCountdown] = useState(10)
  const faceDetectionEnabledRef = useRef(false)
  const faceIntervalRef = useRef(null)
  const faceTimerRef = useRef(null)
  const faceCountdownIntervalRef = useRef(null)
  const faceApiLoadedRef = useRef(false)
  const faceAbsentRef = useRef(false)
  const faceConsecutiveMissesRef = useRef(0)

  const [receivedLikeToast, setReceivedLikeToast] = useState({ visible: false, message: '' })
  const receivedLikeTimerRef = useRef(null)

  const partnerDisplayCountry = useMemo(() => {
    if (partnerCountry) return partnerCountry
    if (partnerProfile?.countryName || partnerProfile?.countryFlag) {
      return {
        countryCode: partnerProfile?.countryCode || null,
        countryName: partnerProfile?.countryName || 'Unknown',
        countryFlag: partnerProfile?.countryFlag || '🌐',
      }
    }
    return { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' }
  }, [partnerCountry, partnerProfile])

  const sortedFriends = useMemo(() => [...friends].sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1)), [friends])
  const friendIds = useMemo(() => new Set(sortedFriends.map(f => f.friendUserId || f.friendAnonId).filter(Boolean)), [sortedFriends])
  const incomingRequestIds = useMemo(() => new Set((friendRequests.incoming || []).map(r => r.requesterId).filter(Boolean)), [friendRequests])
  const outgoingRequestIds = useMemo(() => new Set((friendRequests.outgoing || []).map(r => r.recipientId).filter(Boolean)), [friendRequests])
  const incomingRequestsCount = friendRequests.incoming?.length || 0
  const displayOnlineCount = onlineCount ?? lastOnlineCount
  const isSearching = connectionState === 'waiting' || connectionState === 'connecting'
  const isConnected = connectionState === 'connected'

  const socketRef = useRef(null)
  const pcRef = useRef(null)
  const preWarmedPcRef = useRef(null)
  const localStreamRef = useRef(null)
  const rawLocalStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const callTimerRef = useRef(null)
  const chatEndRef = useRef(null)
  const chatScrollRef = useRef(null)
  const shouldAutoScrollRef = useRef(true)
  const partnerIdRef = useRef(null)
  const partnerLanguageRef = useRef(null)
  const primaryLanguageRef = useRef(null)
  const roomIdRef = useRef(null)
  const anonUserIdRef = useRef(null)
  const iceCandidateQueue = useRef([])
  const isInitiatorRef = useRef(false)
  const captionTimeoutRef = useRef(null)
  const commonLanguagesTimeoutRef = useRef(null)
  const actionFeedbackTimeoutRef = useRef(null)
  const pendingStartRef = useRef(false)
  const currentMatchHistoryIdRef = useRef(null)
  const countrySyncRef = useRef(false)
  const matchedInterestsTimeoutRef = useRef(null)
  const matchedInterestsHideTimeoutRef = useRef(null)
  const recognitionRef = useRef(null)

  useEffect(() => { partnerIdRef.current = partnerId }, [partnerId])
  useEffect(() => { partnerLanguageRef.current = partnerLanguage }, [partnerLanguage])
  useEffect(() => { primaryLanguageRef.current = primaryLanguage }, [primaryLanguage])
  useEffect(() => { roomIdRef.current = roomId }, [roomId])

  async function loadFaceApi() {
    if (faceApiLoadedRef.current) return true
    try {
      if (!window.faceapi) {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector('script[data-faceapi]')
          if (existing) { resolve(); return }
          const s = document.createElement('script')
          s.src = FACEAPI_CDN
          s.async = true
          s.dataset.faceapi = 'true'
          s.onload = resolve
          s.onerror = () => reject(new Error('Failed to load face-api'))
          document.head.appendChild(s)
        })
      }
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(FACEAPI_MODELS)
      faceApiLoadedRef.current = true
      return true
    } catch (e) {
      console.warn('[FaceDetection] Could not load model:', e)
      return false
    }
  }

  function clearFaceTimers() {
    if (faceIntervalRef.current) clearInterval(faceIntervalRef.current)
    if (faceTimerRef.current) clearTimeout(faceTimerRef.current)
    if (faceCountdownIntervalRef.current) clearInterval(faceCountdownIntervalRef.current)
    faceIntervalRef.current = null
    faceTimerRef.current = null
    faceCountdownIntervalRef.current = null
  }

  function startFaceCountdown() {
    setFaceCountdown(Math.round(NO_FACE_TIMEOUT_MS / 1000))
    faceCountdownIntervalRef.current = setInterval(() => {
      setFaceCountdown(prev => {
        if (prev <= 1) { clearInterval(faceCountdownIntervalRef.current); return 0 }
        return prev - 1
      })
    }, 1000)
  }

  async function startFaceDetection() {
    if (mode !== 'video') return
    const ok = await loadFaceApi()
    if (!ok) return
    faceDetectionEnabledRef.current = true
    faceAbsentRef.current = false
    faceConsecutiveMissesRef.current = 0
    faceIntervalRef.current = setInterval(async () => {
      if (!faceDetectionEnabledRef.current) return
      const video = localVideoRef.current
      if (!video || video.readyState < 2 || video.paused || !window.faceapi) return
      try {
        const result = await window.faceapi.detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions(FACE_DETECTOR_OPTIONS))
        const faceFound = !!result
        if (faceFound) {
          faceConsecutiveMissesRef.current = 0
          if (faceAbsentRef.current) {
            faceAbsentRef.current = false
            setFaceWarningVisible(false)
            if (faceTimerRef.current) clearTimeout(faceTimerRef.current)
            if (faceCountdownIntervalRef.current) clearInterval(faceCountdownIntervalRef.current)
          }
        } else {
          faceConsecutiveMissesRef.current += 1
          if (faceConsecutiveMissesRef.current >= FACE_CONSECUTIVE_MISSES_REQUIRED && !faceAbsentRef.current) {
            faceAbsentRef.current = true
            setFaceWarningVisible(true)
            startFaceCountdown()
            faceTimerRef.current = setTimeout(() => {
              if (faceAbsentRef.current && faceDetectionEnabledRef.current) handleNext()
            }, NO_FACE_TIMEOUT_MS)
          }
        }
      } catch (e) {}
    }, FACE_CHECK_INTERVAL_MS)
  }

  function stopFaceDetection() {
    faceDetectionEnabledRef.current = false
    faceAbsentRef.current = false
    faceConsecutiveMissesRef.current = 0
    clearFaceTimers()
    setFaceWarningVisible(false)
    setFaceCountdown(10)
  }

  useEffect(() => {
    if (connectionState === 'connected' && mode === 'video') startFaceDetection()
    else stopFaceDetection()
    return stopFaceDetection
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, mode])

  function maybeShowAdOnSkip(nextSkipCount) {
    if (nextSkipCount > 0 && nextSkipCount % SKIP_THRESHOLD_FOR_AD === 0) triggerMonetagVignette()
  }

  function showReceivedLike(senderName) {
    const message = senderName ? `${senderName} liked you!` : 'Someone liked you!'
    setReceivedLikeToast({ visible: true, message })
    if (receivedLikeTimerRef.current) clearTimeout(receivedLikeTimerRef.current)
    receivedLikeTimerRef.current = setTimeout(() => setReceivedLikeToast({ visible: false, message: '' }), 3000)
  }

  useEffect(() => {
    if (matchedInterestsTimeoutRef.current) clearTimeout(matchedInterestsTimeoutRef.current)
    if (matchedInterestsHideTimeoutRef.current) clearTimeout(matchedInterestsHideTimeoutRef.current)
    if (!matchedInterests.length) { setMatchedInterestsVisible(false); return }
    setMatchedInterestsVisible(true)
    matchedInterestsHideTimeoutRef.current = setTimeout(() => setMatchedInterestsVisible(false), 2500)
    matchedInterestsTimeoutRef.current = setTimeout(() => { setMatchedInterests([]); setMatchedInterestsVisible(false) }, 3000)
    return () => {
      if (matchedInterestsTimeoutRef.current) clearTimeout(matchedInterestsTimeoutRef.current)
      if (matchedInterestsHideTimeoutRef.current) clearTimeout(matchedInterestsHideTimeoutRef.current)
    }
  }, [matchedInterests])

  useEffect(() => {
    try {
      const savedInterests = localStorage.getItem('hippichat_interest_keywords')
      if (savedInterests) setInterestKeywords(normalizeInterestKeywords(JSON.parse(savedInterests)))
      let anonId = localStorage.getItem('omingle_anon_user_id')
      if (!anonId) { anonId = createAnonUserId(); localStorage.setItem('omingle_anon_user_id', anonId) }
      anonUserIdRef.current = anonId
      const savedSkips = localStorage.getItem('hippichat_skip_count')
      if (savedSkips) setSkipCount(parseInt(savedSkips, 10) || 0)
    } catch (e) {
      anonUserIdRef.current = `anon_fallback_${generateId()}`
    }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('hippichat_interest_keywords', JSON.stringify(interestKeywords)) } catch (e) {}
  }, [interestKeywords])

  useEffect(() => {
    try { localStorage.setItem('hippichat_skip_count', String(skipCount)) } catch (e) {}
  }, [skipCount])

  useEffect(() => {
    let cancelled = false
    async function loadSession() {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled) { setSessionUser(data?.user || null); setSessionResolved(true) }
      } catch (e) {
        if (!cancelled) { setSessionUser(null); setSessionResolved(true) }
      }
    }
    loadSession()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!sessionResolved) return
    if (sessionUser) return
    router.replace('/')
  }, [sessionResolved, sessionUser, router])

  useEffect(() => {
    let cancelled = false
    async function loadTurnCredentials() {
      try {
        const res = await fetch(TURN_CREDENTIALS_ENDPOINT, { cache: 'no-store' })
        const data = await res.json()
        const iceServers = Array.isArray(data?.iceServers) ? data.iceServers.filter(s => s && (Array.isArray(s.urls) || typeof s.urls === 'string')) : []
        if (!cancelled) setTurnIceServers(res.ok ? iceServers : [])
      } catch (error) {
        if (!cancelled) setTurnIceServers([])
      }
    }
    loadTurnCredentials()
    return () => { cancelled = true }
  }, [sessionUser?.id])

  useEffect(() => {
    if (!sessionUser?.id) return
    if (!selfCountry?.countryName || selfCountry.countryName === 'Unknown') return
    if (countrySyncRef.current) return
    if (sessionUser?.countryCode === selfCountry.countryCode && sessionUser?.countryName === selfCountry.countryName) return
    countrySyncRef.current = true
    fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: selfCountry.countryCode, countryName: selfCountry.countryName, countryFlag: selfCountry.countryFlag }),
    }).then(r => r.json()).then(data => { if (data?.user) setSessionUser(data.user) }).catch(() => {}).finally(() => { countrySyncRef.current = false })
  }, [selfCountry, sessionUser])

  useEffect(() => {
    if (sessionUser?.countryName || sessionUser?.countryFlag) {
      setSelfCountry(prev => ({
        countryCode: sessionUser?.countryCode || prev.countryCode || null,
        countryName: sessionUser?.countryName || prev.countryName || 'Unknown',
        countryFlag: sessionUser?.countryFlag || prev.countryFlag || '🌐',
      }))
    }
  }, [sessionUser])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    fetch('https://ipapi.co/json/', { signal: controller.signal })
      .then(r => r.json())
      .then(data => { if (cancelled) return; const region = data?.country_code; if (!region) return; setSelfCountry(countryFromCode(region)) })
      .catch(() => {})
    return () => { cancelled = true; clearTimeout(timeout); controller.abort() }
  }, [])

  function showActionFeedback(message) {
    setActionFeedback(message)
    if (actionFeedbackTimeoutRef.current) clearTimeout(actionFeedbackTimeoutRef.current)
    actionFeedbackTimeoutRef.current = setTimeout(() => setActionFeedback(null), 2500)
  }

  function showConnectionNotice(message) {
    setConnectionNotice(message)
    if (actionFeedbackTimeoutRef.current) clearTimeout(actionFeedbackTimeoutRef.current)
    actionFeedbackTimeoutRef.current = setTimeout(() => setConnectionNotice(''), 3500)
  }

  function addInterestKeyword() {
    const next = interestInput.trim().toLowerCase()
    if (!next) return
    setInterestKeywords(prev => normalizeInterestKeywords([...prev, next]))
    setInterestInput('')
  }

  function removeInterestKeyword(kw) {
    setInterestKeywords(prev => prev.filter(k => k !== kw))
  }

  function openUnfriendConfirmation(friend) { setUnfriendTarget(friend); setUnfriendConfirmStep(1) }
  function closeUnfriendConfirmation() { setUnfriendTarget(null); setUnfriendConfirmStep(1) }

  function handleUnfriend(friend) {
    const friendUserId = friend?.friendUserId || friend?.friendAnonId
    if (!socketRef.current || !friendUserId) return
    socketRef.current.emit('unfriend', { friendUserId })
    closeUnfriendConfirmation()
  }

  function respondToFriendInvite(accepted) {
    if (!socketRef.current || !friendInviteRequest?.inviteId) return
    socketRef.current.emit('respond-friend-connect', { inviteId: friendInviteRequest.inviteId, accepted })
    setFriendInviteRequest(null)
  }

  function upsertInteractionHistory(entry) {
    if (!entry?.id) return
    setInteractionHistory(prev => {
      const idx = prev.findIndex(i => i.id === entry.id)
      const next = idx >= 0 ? prev.map(i => i.id === entry.id ? { ...i, ...entry } : i) : [{ ...entry }, ...prev]
      return next.slice(0, MAX_HISTORY_ITEMS)
    })
  }

  function updateCurrentHistoryEntry(patch) {
    if (!currentMatchHistoryIdRef.current) return
    setInteractionHistory(prev => prev.map(i => i.id === currentMatchHistoryIdRef.current ? { ...i, ...patch } : i))
  }

  async function attachLocalPreviewStream(stream) {
    if (!localVideoRef.current || !stream || mode !== 'video') return
    if (localVideoRef.current.srcObject !== stream) localVideoRef.current.srcObject = stream
    localVideoRef.current.muted = true
    localVideoRef.current.playsInline = true
    try { await localVideoRef.current.play() } catch (e) {}
  }

  async function attachRemotePreviewStream() {
    if (!remoteVideoRef.current || !remoteStreamRef.current || mode !== 'video') return
    if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current
    try { await remoteVideoRef.current.play() } catch (e) {}
  }

  async function replacePeerConnectionVideoTrack(track) {
    if (!pcRef.current || !track) return
    const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    try { await sender.replaceTrack(track) } catch (e) {}
  }

  function showCommonLanguages(commonLanguages) {
    const names = (commonLanguages || []).map(l => l?.name).filter(Boolean)
    if (!names.length) { setCommonLanguagesNotice(''); return }
    if (commonLanguagesTimeoutRef.current) clearTimeout(commonLanguagesTimeoutRef.current)
    setCommonLanguagesNotice(`You both can speak: ${names.join(', ')}`)
    commonLanguagesTimeoutRef.current = setTimeout(() => setCommonLanguagesNotice(''), 4200)
  }

  function upsertFriend(friend) {
    const friendId = friend?.friendUserId || friend?.friendAnonId
    if (!friendId) return
    setFriends(prev => {
      const normalized = { ...friend, friendUserId: friendId, friendAnonId: friendId }
      const idx = prev.findIndex(f => (f.friendUserId || f.friendAnonId) === friendId)
      if (idx === -1) return [normalized, ...prev]
      const clone = [...prev]; clone[idx] = { ...clone[idx], ...normalized }; return clone
    })
  }

  function handleOpenFilters() {
    triggerMonetagVignette()
    setShowPreferences(true)
  }

  function handleAddFriend(targetUserId = partnerUserId) {
    if (!socketRef.current || !targetUserId) return
    triggerMonetagVignette()
    socketRef.current?.emit('send-friend-request', { targetUserId })
  }

  function handleAcceptFriendRequest(requestId) {
    if (!socketRef.current || !requestId) return
    socketRef.current.emit('accept-friend-request', { requestId })
  }

  function handleRejectFriendRequest(requestId) {
    if (!socketRef.current || !requestId) return
    socketRef.current.emit('reject-friend-request', { requestId })
  }

  function handleConnectFriend(friendAnonId, explicitMode) {
    if (!socketRef.current || !friendAnonId) return
    const connectMode = explicitMode || mode
    socketRef.current.emit('connect-friend', { friendAnonId, mode: connectMode })
    setShowFriendsPanel(false)
  }

  useEffect(() => {
    if (!sessionResolved || !sessionUser?.id) return undefined
    let socket = null
    let destroyed = false

    async function initSocket() {
      try {
        const { io } = await import('socket.io-client')
        if (destroyed) return
        socket = io(window.location.origin, {
          transports: ['polling', 'websocket'],
          reconnection: true,
          reconnectionAttempts: 20,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 8000,
          timeout: 20000,
        })
        socketRef.current = socket

        socket.on('connect', () => {
          setSocketConnected(true)
          setError(null)
          setConnectionNotice('')
          socket.emit('get-friends-status')
          if (pendingStartRef.current) joinQueue()
        })

        socket.on('matched', handleMatched)
        socket.on('signal', handleSignal)
        socket.on('partner-left', handlePartnerLeft)
        socket.on('partner-skipped', () => showActionFeedback('Partner skipped to the next chat'))
        socket.on('receive-message', handleReceiveMessage)
        socket.on('typing', () => setIsPartnerTyping(true))
        socket.on('stop-typing', () => setIsPartnerTyping(false))
        socket.on('friends-status', data => setFriends(Array.isArray(data?.friends) ? data.friends : []))
        socket.on('friend-requests', data => setFriendRequests({ incoming: Array.isArray(data?.incoming) ? data.incoming : [], outgoing: Array.isArray(data?.outgoing) ? data.outgoing : [] }))
        socket.on('history-updated', data => setInteractionHistory(Array.isArray(data?.history) ? data.history : []))
        socket.on('friend-request-received', () => showActionFeedback('New friend request received'))
        socket.on('friend-online-status', data => {
          if (!data?.friendAnonId && !data?.friendUserId) return
          upsertFriend({ friendAnonId: data.friendUserId || data.friendAnonId, friendUserId: data.friendUserId || data.friendAnonId, online: !!data.online })
        })
        socket.on('friend-connect-result', data => {
          if (!data?.ok) {
            const msgs = { offline: 'Friend is offline', 'not-friends': 'You are not friends yet', declined: 'Friend declined the invite', expired: 'Friend invite expired' }
            showActionFeedback(msgs[data?.reason] || 'Unable to connect friend right now')
            setPendingInviteRequestId(null); return
          }
          if (data?.pending) { setPendingInviteRequestId(data.inviteId); showActionFeedback('Invite sent to your friend'); return }
          setPendingInviteRequestId(null); showActionFeedback('Connecting to friend...')
        })
        socket.on('friend-connect-invite', data => setFriendInviteRequest(data))
        socket.on('partner-likes-updated', data => { if (typeof data?.likes === 'number') setPartnerLikes(data.likes) })
        socket.on('received-like', data => {
          const senderName = data?.senderName || null
          showReceivedLike(senderName)
          if (typeof data?.totalLikes === 'number') showActionFeedback(`You got a like 👍 · Total ${data.totalLikes}`)
          else showActionFeedback('You got a like 👍')
        })
        socket.on('action-feedback', data => {
          if (!data?.type) return
          if (data.type === 'like') {
            if (data.status === 'ok' || data.status === 'duplicate') setHasLikedPartner(true)
            showActionFeedback(data.status === 'duplicate' ? 'You already liked this user' : 'Like sent 👍')
          }
          if (data.type === 'report') {
            if (data.status === 'ok' || data.status === 'duplicate') setHasReportedPartner(true)
            showActionFeedback(data.status === 'duplicate' ? 'You already reported this user' : 'Report submitted')
          }
          if (data.type === 'friend-request') {
            if (['ok', 'duplicate', 'awaiting-your-response', 'already-friends'].includes(data.status)) setHasAddedFriendForCurrentMatch(true)
            const msgs = { ok: 'Friend request sent', duplicate: 'Friend request already sent', 'awaiting-your-response': 'This user has already sent you a request', 'already-friends': 'Already in your friends list' }
            if (msgs[data.status]) showActionFeedback(msgs[data.status])
          }
          if (data.type === 'friend-request-accept' && data.status === 'ok') showActionFeedback('Friend request accepted')
          if (data.type === 'friend-request-reject' && data.status === 'ok') showActionFeedback('Friend request rejected')
          if (data.type === 'unfriend' && data.status === 'ok') showActionFeedback('Friend removed')
        })
        socket.on('stats', data => {
          if (typeof data?.online === 'number') { setOnlineCount(data.online); setLastOnlineCount(data.online) }
        })
        socket.on('account-blocked', data => {
          pendingStartRef.current = false
          resetSessionUi(); setConnectionState('idle'); setAccountBlockedInfo(data || null)
          showActionFeedback(data?.message || 'Account temporarily blocked from matching')
        })
        socket.on('force-logout', async () => {
          try { await fetch('/api/auth/logout', { method: 'POST' }) } catch {}
          setSessionUser(null); router.replace('/')
        })
        socket.on('connect_error', () => { setSocketConnected(false); if (pendingStartRef.current) showConnectionNotice('Reconnecting to chat...') })
        socket.on('disconnect', reason => { setSocketConnected(false); if (pendingStartRef.current && reason !== 'io client disconnect') showConnectionNotice('Connection lost. Reconnecting...') })
        socket.emit('get-friends-status')
      } catch (err) {
        setError('Failed to initialize connection')
      }
    }

    initSocket()
    return () => {
      destroyed = true
      if (socket) {
        ['matched','signal','partner-left','partner-skipped','receive-message','typing','stop-typing',
         'friends-status','friend-requests','history-updated','friend-request-received','friend-online-status',
         'friend-connect-result','friend-connect-invite','partner-likes-updated','received-like','action-feedback',
         'stats','account-blocked','force-logout'].forEach(ev => socket.off(ev))
        socket.disconnect()
      }
      if (actionFeedbackTimeoutRef.current) clearTimeout(actionFeedbackTimeoutRef.current)
    }
  }, [sessionResolved, sessionUser?.id])

  useEffect(() => {
    if (!socketConnected || !socketRef.current) return
    socketRef.current.emit('identify-user', {
      anonUserId: anonUserIdRef.current,
      userId: sessionUser?.id || null,
      displayName: sessionUser?.name || null,
      email: sessionUser?.email || '',
      image: sessionUser?.image || null,
      country: selfCountry,
    })
    socketRef.current.emit('get-friends-status')
  }, [sessionUser, selfCountry, socketConnected])

  function formatOnlineCount(n) {
    if (typeof n !== 'number') return null
    if (n >= 1000) return `${Math.floor(n).toLocaleString()}+`
    return `${n}+`
  }

  function renderOnlineCountBadge() {
    if (displayOnlineCount !== null && displayOnlineCount >= 100) {
      return (
        <>
          <div className="flex shrink-0 rounded-full border border-gray-800/60 bg-gray-900/85 px-2.5 py-1 text-[11px] text-gray-300 sm:hidden">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              {formatOnlineCount(displayOnlineCount)}
            </span>
          </div>
          <div className="hidden sm:flex rounded-full border border-gray-800/60 bg-gray-900/85 px-3 py-1.5 text-xs text-gray-300">
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              <Users className="w-3.5 h-3.5 text-gray-400" />
              Online {formatOnlineCount(displayOnlineCount)}
            </span>
          </div>
        </>
      )
    }
    return (
      <>
        <div className="flex shrink-0 rounded-full border border-gray-800/60 bg-gray-900/85 px-2.5 py-1 text-[11px] text-gray-300 sm:hidden">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Live now
          </span>
        </div>
        <div className="hidden sm:flex rounded-full border border-gray-800/60 bg-gray-900/85 px-3 py-1.5 text-xs text-gray-300">
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            People chatting live
          </span>
        </div>
      </>
    )
  }

  useEffect(() => {
    async function getMedia() {
      try {
        const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
        const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices)
        if (!getUserMedia) {
          const msg = typeof window !== 'undefined' && !window.isSecureContext
            ? 'Camera/mic needs HTTPS or localhost. You can still use text chat.'
            : 'This browser/device does not support camera or mic access. You can still use text chat.'
          throw new Error(msg)
        }
        const constraints = {
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000, sampleSize: 16 },
          video: mode === 'video' ? { width: 640, height: 480, facingMode: 'user' } : false,
        }
        const stream = await getUserMedia(constraints)
        rawLocalStreamRef.current = stream
        localStreamRef.current = stream
        setHasCameraPermission(mode !== 'video' || stream.getVideoTracks().length > 0)
        if (localVideoRef.current && mode === 'video') await attachLocalPreviewStream(stream)
        setIsMediaReady(true)
        if (pendingStartRef.current && socketRef.current?.connected) joinQueue()
        else setConnectionState('idle')
      } catch (err) {
        const denied = err?.name === 'NotAllowedError'
        const message = denied
          ? mode === 'video' ? 'Camera access is required for video chat.' : 'Microphone permission denied. You can still use text chat.'
          : err?.message || 'Could not access camera/mic. Text chat is still available.'
        setMediaWarning(message)
        setIsMediaReady(true)
        setHasCameraPermission(mode !== 'video')
        if (pendingStartRef.current && socketRef.current?.connected) joinQueue()
        else setConnectionState('idle')
      }
    }
    getMedia()
    return () => {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop())
      if (rawLocalStreamRef.current && rawLocalStreamRef.current !== localStreamRef.current) rawLocalStreamRef.current.getTracks().forEach(t => t.stop())
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'video' || !localVideoRef.current || !localStreamRef.current) return
    attachLocalPreviewStream(localStreamRef.current)
  })

  useEffect(() => { attachRemotePreviewStream() })

  useEffect(() => {
    if (connectionState === 'connected') {
      setCallDuration(0)
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
    }
    return () => { if (callTimerRef.current) clearInterval(callTimerRef.current) }
  }, [connectionState])

  useEffect(() => {
    if (connectionState === 'waiting') {
      const interval = setInterval(() => setFactIndex(i => (i + 1) % LANGUAGE_FACTS.length), 5000)
      return () => clearInterval(interval)
    }
  }, [connectionState])

  function preWarmPeerConnection() {
    if (preWarmedPcRef.current) {
      try { preWarmedPcRef.current.close() } catch (_) {}
      preWarmedPcRef.current = null
    }
    if (!localStreamRef.current) return
    try {
      const baseConfig = buildRtcConfig(turnIceServers)
      const pc = new RTCPeerConnection({
        ...baseConfig,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 10,
      })
      localStreamRef.current.getTracks().forEach(t => {
        try { pc.addTrack(t, localStreamRef.current) } catch (_) {}
      })
      preWarmedPcRef.current = pc
    } catch (_) {}
  }

  function joinQueue() {
    if (!socketRef.current?.connected) return
    if (!sessionUser?.id) { router.replace('/'); return }
    if (isMediaReady) preWarmPeerConnection()
    setConnectionState('waiting')
    setMessages([])
    setPartnerCaption(null)
    setCallDuration(0)
    socketRef.current.emit('join-queue', {
      primaryLanguage,
      spokenLanguages: additionalLanguages,
      mode,
      interestKeywords,
      anonUserId: anonUserIdRef.current,
      userId: sessionUser?.id || null,
      displayName: sessionUser?.name || null,
      email: sessionUser?.email || '',
      image: sessionUser?.image || null,
      country: selfCountry,
    })
  }

  function handleMatched(data) {
    const matchedMode = data?.mode === 'voice' ? 'voice' : 'video'
    if (matchedMode !== mode) {
      socketRef.current?.emit('next', { reason: 'mode-mismatch' })
      resetSessionUi()
      if (socketRef.current?.connected) joinQueue()
      else setConnectionState('waiting')
      return
    }
    setConnectionState('connecting')
    setMobilePane('video')
    setPartnerId(data.partnerId)
    setPartnerUserId(data.partnerUserId || null)
    setPartnerProfile(data.partnerProfile || null)
    setPartnerLanguage(data.partnerLanguage)
    setPartnerCountry(data.partnerCountry || { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' })
    showCommonLanguages(data.commonLanguages)
    setPartnerLikes(typeof data?.partnerLikes === 'number' ? data.partnerLikes : 0)
    setMatchedInterests(Array.isArray(data?.matchedInterests) ? data.matchedInterests.slice(0, 3) : [])
    setRoomId(data.roomId)
    setShowFriendsPanel(false)
    setHasAddedFriendForCurrentMatch(false)
    setHasLikedPartner(false)
    setHasReportedPartner(false)
    setActionFeedback(null)
    isInitiatorRef.current = data.isInitiator
    iceCandidateQueue.current = []
    const historyId = data.roomId || `${data.partnerId}_${Date.now()}`
    currentMatchHistoryIdRef.current = historyId
    const derivedCountry = data.partnerCountry || { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' }
    upsertInteractionHistory({
      id: historyId,
      partnerSocketId: data.partnerId,
      partnerUserId: data.partnerUserId || null,
      partnerName: data.partnerProfile?.name || data.partnerLanguage?.name || 'Unknown',
      partnerImage: data.partnerProfile?.image || null,
      countryName: derivedCountry?.countryName || 'Unknown',
      countryFlag: derivedCountry?.countryFlag || '🌐',
      languageName: data.partnerLanguage?.name || 'Unknown',
      mode,
      connectedAt: new Date().toISOString(),
      isFriendConnection: !!data.isFriendConnection,
    })
    initPeerConnection(data.isInitiator, data.partnerId)
  }

  async function handleSignal(data) {
    const pc = pcRef.current
    try {
      if (data.type === 'offer' && data.payload) {
        if (!pcRef.current) initPeerConnection(false, data.from)
        const currentPc = pcRef.current
        if (!currentPc) return
        await currentPc.setRemoteDescription(new RTCSessionDescription(data.payload))
        const queuedForOffer = iceCandidateQueue.current.splice(0)
        await Promise.all(queuedForOffer.map(c => currentPc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})))
        const answer = await currentPc.createAnswer()
        const optimisedSdp = preferVP8(answer.sdp)
        await currentPc.setLocalDescription({ type: answer.type, sdp: optimisedSdp })
        socketRef.current?.emit('signal', { type: 'answer', to: data.from, payload: currentPc.localDescription })
      } else if (data.type === 'answer' && data.payload && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.payload))
        const queuedForAnswer = iceCandidateQueue.current.splice(0)
        await Promise.all(queuedForAnswer.map(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})))
      } else if (data.type === 'ice-candidate' && data.payload) {
        if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(new RTCIceCandidate(data.payload)) } catch (e) {} }
        else iceCandidateQueue.current.push(data.payload)
      }
    } catch (err) {}
  }

  function handlePartnerLeft() {
    const shouldKeepSearching = pendingStartRef.current
    updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
    resetSessionUi()
    if (shouldKeepSearching && socketRef.current?.connected) {
      showActionFeedback('Searching for the next match...')
      joinQueue(); return
    }
    setConnectionState('idle')
    showActionFeedback('Partner left the chat')
  }

  function handleReceiveMessage(data) {
    setMessages(prev => [...prev.slice(-MAX_CHAT_MESSAGES + 1), { id: data.id, text: data.text, fromLang: data.fromLang, timestamp: data.timestamp, isMine: false }])
    setIsPartnerTyping(false)
    if (!showChat) setUnreadCount(c => c + 1)
  }

  function initPeerConnection(isInitiator, peerId) {
    cleanupPeerConnection()
    const prewarm = preWarmedPcRef.current
    let pc
    if (
      prewarm &&
      prewarm.signalingState === 'stable' &&
      prewarm.connectionState !== 'closed' &&
      prewarm.connectionState !== 'failed'
    ) {
      pc = prewarm
      preWarmedPcRef.current = null
    } else {
      if (prewarm) {
        try { prewarm.close() } catch (_) {}
        preWarmedPcRef.current = null
      }
      const baseConfig = buildRtcConfig(turnIceServers)
      pc = new RTCPeerConnection({
        ...baseConfig,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 10,
      })
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => {
          try { pc.addTrack(t, localStreamRef.current) } catch (_) {}
        })
      }
    }

    pcRef.current = pc
    const remoteStream = new MediaStream()
    remoteStreamRef.current = remoteStream

    pc.ontrack = event => {
      const tracks = event.streams?.[0]?.getTracks() || [event.track]
      tracks.forEach(t => {
        if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t)
      })
      const vid = remoteVideoRef.current
      if (vid) {
        if (vid.srcObject !== remoteStream) vid.srcObject = remoteStream
        vid.play().catch(() => {})
      }
    }

    pc.onicecandidate = event => {
      if (event.candidate)
        socketRef.current?.emit('signal', { type: 'ice-candidate', to: peerId, payload: event.candidate.toJSON() })
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionState('connected')
      else if (pc.connectionState === 'failed') {
        cleanupPeerConnection()
        if (pendingStartRef.current && socketRef.current?.connected) {
          resetSessionUi(); showActionFeedback('Finding next match...'); joinQueue()
        } else {
          setConnectionState('idle'); showActionFeedback('Connection failed')
        }
      } else if (pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (pcRef.current?.connectionState === 'disconnected' || pcRef.current?.connectionState === 'failed') {
            cleanupPeerConnection()
            if (pendingStartRef.current && socketRef.current?.connected) {
              resetSessionUi(); showActionFeedback('Reconnecting...'); joinQueue()
            } else {
              setConnectionState('idle'); showActionFeedback('Connection ended')
            }
          }
        }, 1500)
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
        setConnectionState('connected')
    }

    if (isInitiator) {
      ;(async () => {
        try {
          if (pc.signalingState !== 'stable') return
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: mode === 'video',
          })
          if (pc.signalingState !== 'stable') return
          const optimisedSdp = preferVP8(offer.sdp)
          await pc.setLocalDescription({ type: offer.type, sdp: optimisedSdp })
          socketRef.current?.emit('signal', { type: 'offer', to: peerId, payload: pc.localDescription })
        } catch (_) {}
      })()
    }
  }

  function cleanupPeerConnection() {
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    remoteStreamRef.current = null
  }

  function resetSessionUi({ clearMessages = true } = {}) {
    if (preWarmedPcRef.current) {
      try { preWarmedPcRef.current.close() } catch (_) {}
      preWarmedPcRef.current = null
    }
    cleanupPeerConnection()
    stopFaceDetection()
    setPartnerId(null); setPartnerLanguage(null); setPartnerCountry(null); setPartnerUserId(null); setPartnerProfile(null)
    setPartnerLikes(0); setRoomId(null); setPartnerCaption(null); setCommonLanguagesNotice('')
    setHasAddedFriendForCurrentMatch(false); setShowFriendsPanel(false)
    setIsPartnerTyping(false); setHasLikedPartner(false); setHasReportedPartner(false)
    setActionFeedback(null); setReportModalOpen(false); setFriendInviteRequest(null)
    setPendingInviteRequestId(null); setMatchedInterests([]); setCallDuration(0); setUnreadCount(0)
    if (clearMessages) setMessages([])
    setReceivedLikeToast({ visible: false, message: '' })
  }

  function handleStartSearch() {
    if (!sessionUser?.id) { router.replace('/'); return }
    if (mode === 'video' && !hasCameraPermission) { setMediaWarning('Camera access is required before you can start video chat.'); return }
    pendingStartRef.current = true
    setMobilePane('video')
    resetSessionUi()
    if (socketRef.current?.connected) joinQueue()
    else setConnectionState('waiting')
  }

  function handleStopSearch() {
    pendingStartRef.current = false
    if (socketRef.current?.connected) {
      if (connectionState === 'waiting') socketRef.current.emit('leave-queue')
      else if (connectionState === 'connecting' || connectionState === 'connected') socketRef.current.emit('next', { reason: 'stop' })
    }
    resetSessionUi()
    setConnectionState('idle')
  }

  function handleSendMessage() {
    const canSendNow = connectionState === 'connected' && !!roomIdRef.current && !!partnerIdRef.current
    if (!canSendNow || !messageInput.trim() || !socketRef.current) return
    const msg = { id: generateId(), text: messageInput.trim(), fromLang: primaryLanguage.googleCode, timestamp: new Date().toISOString(), isMine: true }
    setMessages(prev => [...prev.slice(-MAX_CHAT_MESSAGES + 1), msg])
    socketRef.current.emit('send-message', { roomId: roomIdRef.current, message: messageInput.trim(), fromLang: primaryLanguage.googleCode })
    socketRef.current.emit('stop-typing')
    setMessageInput('')
  }

  function handleNext() {
    if (!sessionUser?.id) return
    const nextSkipCount = skipCount + 1
    setSkipCount(nextSkipCount)
    maybeShowAdOnSkip(nextSkipCount)
    pendingStartRef.current = true
    updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
    socketRef.current?.emit('next', { reason: 'skip' })
    resetSessionUi()
    if (socketRef.current?.connected) joinQueue()
    else setConnectionState('waiting')
  }

  function handleEnd() {
    pendingStartRef.current = false
    updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
    socketRef.current?.emit('next', { reason: 'end' })
    if (preWarmedPcRef.current) {
      try { preWarmedPcRef.current.close() } catch (_) {}
      preWarmedPcRef.current = null
    }
    cleanupPeerConnection()
    stopFaceDetection()
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop())
    router.push('/')
  }

  function toggleMute() {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0]
      if (audioTrack) { audioTrack.enabled = !audioTrack.enabled; setIsMuted(!audioTrack.enabled) }
    }
  }

  function toggleCamera() {
    if (localStreamRef.current && mode === 'video') {
      const videoTrack = localStreamRef.current.getVideoTracks()[0]
      if (videoTrack) { videoTrack.enabled = !videoTrack.enabled; setIsCameraOff(!videoTrack.enabled) }
    }
  }

  function handleInputChange(e) {
    setMessageInput(e.target.value)
    const canSendNow = connectionState === 'connected' && !!roomIdRef.current && !!partnerIdRef.current
    if (!canSendNow) return
    if (e.target.value.length > 0) socketRef.current?.emit('typing')
    else socketRef.current?.emit('stop-typing')
  }

  function handleChatScroll() {
    const container = chatScrollRef.current
    if (!container) return
    shouldAutoScrollRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80
  }

  useEffect(() => {
    const container = chatScrollRef.current
    if (!container || !shouldAutoScrollRef.current) return
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [messages])

  function buildChatUrl(nextMode) {
    return `/chat?mode=${nextMode}`
  }

  function performModeSwitch(nextMode) {
    setShowChat(false); setMobilePane('video'); setPanelTab(null)
    pendingStartRef.current = false
    socketRef.current?.emit('next', { reason: 'mode-switch' })
    router.push(buildChatUrl(nextMode))
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return
    if (isSearching || isConnected) { setModeSwitchConfirm({ nextMode }); return }
    performModeSwitch(nextMode)
  }

  function openPanel(tab) {
    setShowChat(false)
    setPanelTab(prev => {
      const next = prev === tab ? null : tab
      if (next) setMobilePane(next)
      else setMobilePane('video')
      return next
    })
  }

  function getRemotePanelTitle() {
    if (connectionState === 'waiting') return 'Searching for a stranger...'
    if (connectionState === 'connecting') return 'Match found · connecting...'
    return 'Press Start to begin searching'
  }

  function getRemotePanelSubtitle() {
    if (connectionState === 'waiting') return 'You can already see yourself while we look for someone new.'
    if (connectionState === 'connecting') return 'The stranger video will appear here as soon as the connection is ready.'
    return 'Your preview stays visible here. The stranger will appear in this space once matched.'
  }

  function openReportModal({ targetUserId = null, roomId = null, isCurrent = true } = {}) {
    setReportContext({ targetUserId, roomId, isCurrent })
    setReportModalOpen(true)
  }

  function handleReportPartner() {
    if (!socketRef.current) return
    if (reportContext.isCurrent && (!partnerIdRef.current || hasReportedPartner)) return
    if (reportContext.isCurrent) setHasReportedPartner(true)
    socketRef.current.emit('report-partner', { reason: reportReason, details: reportDetails, targetUserId: reportContext.targetUserId, roomId: reportContext.roomId })
    setReportModalOpen(false); setReportDetails(''); setReportContext({ targetUserId: null, roomId: null, isCurrent: true })
  }

  function handleLikePartner() {
    if (!socketRef.current || !partnerIdRef.current || hasLikedPartner) return
    socketRef.current.emit('like-partner')
  }

  const activeHistoryFriendEntries = useMemo(() => interactionHistory.map(item => {
    const targetUserId = item.partnerUserId || item.friendAnonId || null
    const onlineFriend = targetUserId ? friends.find(f => (f.friendUserId || f.friendAnonId) === targetUserId) : null
    return { ...item, onlineFriend }
  }), [interactionHistory, friends])

  const primaryActionIsStop = isSearching || isConnected
  const hasActiveMatch = !!roomId && !!partnerId && (connectionState === 'connected' || connectionState === 'connecting')
  const canSendMessages = connectionState === 'connected' && !!roomId && !!partnerId
  const showMobileCenterPane = !showChat && !!panelTab && (mobilePane === 'history' || mobilePane === 'friends')
  const currentPartnerAlreadyFriend = partnerUserId ? friendIds.has(partnerUserId) : false
  const currentPartnerRequestPending = partnerUserId ? outgoingRequestIds.has(partnerUserId) : false
  const currentPartnerHasIncomingRequest = partnerUserId ? incomingRequestIds.has(partnerUserId) : false

  // ── Whether to hide the sticky mobile bar (controls are overlaid on self-view in video mode)
  const hideMobileBar = mode === 'video' && !showChat && !showMobileCenterPane

  if (!sessionResolved) return <ChatPageFallback />
  if (!sessionUser) return null

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <X className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">Connection Error</h2>
          <p className="text-gray-400 mb-6">{error}</p>
          <button onClick={() => router.push('/')} className="px-6 py-3 bg-violet-600 hover:bg-violet-500 rounded-xl font-medium transition-all">Go Home</button>
        </div>
      </div>
    )
  }

  const isPanelOpen = !!panelTab

  return (
    <div className="bg-gray-950 flex flex-col" style={{ height: '100dvh', maxHeight: '100dvh', overflow: 'hidden' }}>
      <AgeGateModal />
      <div className="flex flex-col overflow-hidden overscroll-none bg-gray-950" style={{ height: '100%' }}>

        {/* Header */}
        <div className="relative z-30 shrink-0 overflow-visible border-b border-gray-800 bg-gray-900/95 backdrop-blur px-3 sm:px-5 py-2">
          <div className="flex items-center justify-between gap-3">
            <button onClick={() => router.push('/')} className="flex items-center">
              <img src="/logo.svg" alt="HippiChat" className="h-9 sm:h-12 w-auto" />
            </button>
            <div className="flex items-center justify-end gap-2 min-w-[44px]">
              {renderOnlineCountBadge()}
              <GoogleAuthButton compact onOpenSettings={() => setSettingsOpen(true)} onLogoutSuccess={() => router.replace('/')} userOverride={sessionUser} />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-1 sm:justify-center sm:gap-3 overflow-x-auto no-scrollbar text-xs sm:text-sm font-medium text-gray-300">
            {['video', 'voice'].map(m => (
              <button key={m} onClick={() => switchMode(m)} className={`rounded-full px-3 py-1 sm:px-5 sm:py-2 whitespace-nowrap transition-all ${mode === m ? 'bg-white text-gray-900' : 'hover:bg-gray-800'}`}>
                {m === 'video' ? 'Video Chat' : 'Voice Chat'}
              </button>
            ))}
            <button onClick={() => openPanel('history')} className={`rounded-full px-3 py-1 sm:px-5 sm:py-2 whitespace-nowrap transition-all ${panelTab === 'history' ? 'bg-violet-600 text-white' : 'hover:bg-gray-800'}`}>History</button>
            <button onClick={() => openPanel('friends')} className={`relative rounded-full px-3 py-1 sm:px-5 sm:py-2 whitespace-nowrap transition-all ${panelTab === 'friends' ? 'bg-violet-600 text-white' : 'hover:bg-gray-800'}`}>
              Friends
              {incomingRequestsCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-400 px-1 text-[10px] font-bold text-gray-900">{incomingRequestsCount}</span>
              )}
            </button>
          </div>
        </div>

        <ProfileSettingsModal open={settingsOpen} user={sessionUser} onClose={() => setSettingsOpen(false)}
          onSaved={user => {
            setSessionUser(user)
            socketRef.current?.emit('update-profile', { name: user?.name })
            router.replace(`/chat?mode=${mode}`)
          }}
        />

        {/* Preferences Modal */}
        {showPreferences && (
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Preferences</h3>
                <button onClick={() => setShowPreferences(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="space-y-3 text-sm text-gray-300">
                <div className="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Interest keywords</p>
                  <div className="flex gap-2 mb-3">
                    <input type="text" value={interestInput} onChange={e => setInterestInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInterestKeyword() } }}
                      placeholder="e.g. gaming, music, anime"
                      className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                    />
                    <button onClick={addInterestKeyword} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500">Add</button>
                  </div>
                  {interestKeywords.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {interestKeywords.map(kw => (
                        <button key={kw} onClick={() => removeInterestKeyword(kw)} className="rounded-full border border-violet-500/30 bg-violet-600/10 px-3 py-1 text-xs text-violet-100 hover:bg-violet-600/20">#{kw} ×</button>
                      ))}
                    </div>
                  ) : <p className="text-xs text-gray-500">We prefer matching people with shared interests, then fall back to any available user.</p>}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Report Modal */}
        {reportModalOpen && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">Report this user</h3>
                <button onClick={() => setReportModalOpen(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="space-y-2 mb-4">
                {REPORT_REASONS.map(r => (
                  <button key={r.value} onClick={() => setReportReason(r.value)}
                    className={`w-full rounded-xl border px-4 py-3 text-left text-sm transition-all ${reportReason === r.value ? 'border-amber-400/40 bg-amber-500/10 text-amber-100' : 'border-gray-800 bg-gray-800/40 text-gray-300 hover:bg-gray-800'}`}>
                    {r.label}
                  </button>
                ))}
              </div>
              <textarea value={reportDetails} onChange={e => setReportDetails(e.target.value)} placeholder="Optional details"
                className="mb-4 min-h-24 w-full rounded-xl border border-gray-800 bg-gray-800/40 px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none" />
              <div className="flex justify-end gap-2">
                <button onClick={() => setReportModalOpen(false)} className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
                <button onClick={handleReportPartner} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-amber-400">Submit report</button>
              </div>
            </div>
          </div>
        )}

        {accountBlockedInfo?.blockedUntil && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-red-500/20 bg-gray-900 p-6 shadow-2xl">
              <h3 className="text-lg font-semibold text-white mb-2">Account temporarily restricted</h3>
              <p className="text-sm text-gray-300 mb-4">{accountBlockedInfo.message || `Restricted until ${new Date(accountBlockedInfo.blockedUntil).toLocaleString()}.`}</p>
              <button onClick={() => setAccountBlockedInfo(null)} className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100">Okay</button>
            </div>
          </div>
        )}

        {modeSwitchConfirm && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
              <div className="mb-4 flex items-start gap-3">
                <div className="mt-0.5 rounded-full bg-amber-500/10 p-2 text-amber-300"><AlertTriangle className="h-5 w-5" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-white">Switch chat mode?</h3>
                  <p className="mt-1 text-sm text-gray-400">Switching to {modeSwitchConfirm.nextMode === 'video' ? 'Video Chat' : 'Voice Chat'} will end your current conversation. Continue?</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setModeSwitchConfirm(null)} className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
                <button onClick={() => { const m = modeSwitchConfirm?.nextMode; setModeSwitchConfirm(null); if (m) performModeSwitch(m) }} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">Switch</button>
              </div>
            </div>
          </div>
        )}

        {friendInviteRequest?.inviteId && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
              <h3 className="text-lg font-semibold text-white mb-2">Friend invite</h3>
              <p className="text-sm text-gray-300 mb-4">{friendInviteRequest.profile?.name || 'Your friend'} wants to connect on {friendInviteRequest.mode === 'voice' ? 'voice chat' : 'video chat'}.</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => respondToFriendInvite(false)} className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800">Decline</button>
                <button onClick={() => respondToFriendInvite(true)} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">Accept</button>
              </div>
            </div>
          </div>
        )}

        {unfriendTarget && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
              <h3 className="text-lg font-semibold text-white mb-2">{unfriendConfirmStep === 1 ? 'Remove friend?' : 'Are you absolutely sure?'}</h3>
              <p className="text-sm text-gray-300 mb-4">{unfriendConfirmStep === 1 ? `This will remove ${unfriendTarget.name || 'this friend'} from your friends list.` : 'This action cannot be undone.'}</p>
              <div className="flex justify-end gap-2">
                <button onClick={closeUnfriendConfirmation} className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
                {unfriendConfirmStep === 1
                  ? <button onClick={() => setUnfriendConfirmStep(2)} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400">Continue</button>
                  : <button onClick={() => handleUnfriend(unfriendTarget)} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500">Unfriend</button>}
              </div>
            </div>
          </div>
        )}

        {/* ── MAIN LAYOUT ── */}
        <div className="flex-1 flex relative overflow-hidden min-h-0">

          {/* ── LEFT: Video/Voice + Controls ── */}
          <div className={`
            min-h-0 relative overflow-hidden flex flex-col
            ${showChat ? 'hidden sm:flex' : showMobileCenterPane ? 'hidden sm:flex' : 'flex'}
            ${isPanelOpen ? 'sm:flex-1' : 'flex-1'}
          `}>
            {mode === 'video' ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                {/* ── FIX: starts at height:0, expands to 52px only when ad actually loads ── */}
                <ChatMobileAdBanner />

                {/*
                  ── FIX: Removed sm:p / sm:gap so no outer padding on mobile.
                  Videos are edge-to-edge on mobile for a full-screen feel.
                  On mobile: flex-col with proportional heights.
                  On desktop: grid 2-col with padding and gap.
                ──*/}
                <div className="flex-1 min-h-0 sm:p-1.5 flex flex-col sm:grid sm:grid-cols-2 sm:gap-1.5 overflow-hidden">

                  {/* ── Stranger / Remote video ── */}
                  <div className="relative flex-[3] sm:flex-none min-h-0 sm:rounded-xl overflow-hidden bg-black">
                    <video ref={remoteVideoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover bg-black" />

                    {/* Watermark */}
                    <img src="/logo.svg" alt="" className="pointer-events-none absolute bottom-2 right-2 h-4 sm:h-5 w-auto select-none opacity-20 grayscale brightness-[2.4]" />

                    <ReceivedLikeToast message={receivedLikeToast.message} visible={receivedLikeToast.visible} />

                    {/* ── FIX: Partner country badge — now INSIDE the remote video div,
                        visible on BOTH mobile and desktop. Shows as soon as we're
                        connecting or connected (so it persists throughout the call). ── */}
                    {(connectionState === 'connected' || connectionState === 'connecting') &&
                      partnerDisplayCountry?.countryFlag && (
                      <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-lg bg-gray-900/75 px-2 py-1 backdrop-blur-sm border border-white/10">
                        <span className="text-base leading-none">{partnerDisplayCountry.countryFlag}</span>
                        {partnerDisplayCountry.countryName && partnerDisplayCountry.countryName !== 'Unknown' && (
                          <span className="text-xs font-medium text-white">{partnerDisplayCountry.countryName}</span>
                        )}
                        {connectionState === 'connected' && (
                          <span className="flex items-center gap-0.5 text-[11px] text-emerald-300 ml-0.5">
                            <ThumbsUp className="h-2.5 w-2.5" />
                            {partnerLikes}
                          </span>
                        )}
                      </div>
                    )}

                    {/* ── Chat toggle button floating on remote video (mobile, video mode) ── */}
                    <button
                      onClick={() => { setShowChat(true); setUnreadCount(0) }}
                      className="sm:hidden absolute top-2 right-2 z-10 flex items-center gap-1 rounded-full bg-gray-900/75 border border-white/10 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-sm"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      Chat
                      {unreadCount > 0 && (
                        <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-violet-500 px-1 text-[10px] font-bold">{unreadCount}</span>
                      )}
                    </button>

                    {/* Not-connected overlay */}
                    {connectionState !== 'connected' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900/95 via-gray-900/95 to-gray-950/95 px-3 text-center">
                        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-violet-500/20 bg-violet-500/10">
                          {isSearching ? <Loader2 className="h-5 w-5 animate-spin text-violet-400" /> : <Users className="h-5 w-5 text-violet-300" />}
                        </div>
                        <h3 className="text-sm font-semibold text-white">{getRemotePanelTitle()}</h3>
                        <p className="hidden sm:block mt-1 max-w-xs text-[11px] text-gray-400">{getRemotePanelSubtitle()}</p>
                        <div className="mt-2 rounded-full border border-gray-800 bg-gray-950/70 px-2.5 py-0.5 text-[10px] text-gray-400">
                          {selfCountry?.countryFlag || '🌐'} {selfCountry?.countryName || 'Unknown'}
                        </div>
                        {mediaWarning && (
                          <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 max-w-[180px]">{mediaWarning}</div>
                        )}
                      </div>
                    )}

                    {/* Like button */}
                    {connectionState === 'connected' && (
                      <button onClick={handleLikePartner} disabled={hasLikedPartner}
                        className={`absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-lg transition-all backdrop-blur border
                          ${hasLikedPartner ? 'bg-pink-600/80 border-pink-400/30 text-white cursor-default' : 'bg-gray-900/80 border-gray-700/50 text-pink-300 hover:bg-pink-600/80 hover:border-pink-400/30 hover:text-white active:scale-95'}`}>
                        <Heart className={`w-2.5 h-2.5 ${hasLikedPartner ? 'fill-white' : 'fill-none'}`} />
                        {hasLikedPartner ? 'Liked' : 'Like'}
                      </button>
                    )}
                  </div>

                  {/* ── Self / Local video ──
                      FIX: On mobile this is flex-[2] so it fills the remaining space
                      all the way to the bottom of the screen (no sticky bar below it).
                      The Start / Skip / Filters controls are overlaid at the bottom of
                      this panel via an absolutely-positioned gradient strip. ── */}
                  <div className="relative flex-[2] sm:flex-none sm:rounded-xl overflow-hidden bg-black">
                    <video ref={localVideoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover bg-black" style={{ transform: 'scaleX(-1)' }} />

                    {/* Watermark */}
                    <img src="/logo.svg" alt="" className="pointer-events-none absolute bottom-14 sm:bottom-2 right-1 sm:right-2 h-3.5 sm:h-5 w-auto select-none opacity-20 grayscale brightness-[2.4]" />

                    {isCameraOff && (
                      <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
                        <VideoOff className="w-4 sm:w-5 h-4 sm:h-5 text-gray-500" />
                      </div>
                    )}
                    {!localStreamRef.current && (
                      <div className="absolute inset-0 bg-gray-900/90 hidden sm:flex items-center justify-center text-xs text-gray-400">Preview unavailable</div>
                    )}

                    <FaceDetectionWarning visible={faceWarningVisible} countdown={faceCountdown} />

                    {/* "You" label — pushed up on mobile to stay above controls */}
                    <div className="absolute left-1.5 sm:left-2 bottom-14 sm:bottom-2 text-[9px] sm:text-[10px] px-1.5 sm:px-2 py-0.5 rounded-full bg-black/50 backdrop-blur border border-white/10">
                      You · {selfCountry?.countryFlag || '🌐'} <span className="hidden sm:inline">{selfCountry?.countryName || 'Unknown'}</span>
                    </div>

                    {/* ── FIX: Mobile-only control overlay at bottom of self-view ──
                        This replaces the sticky bottom bar on mobile in video mode.
                        The gradient blends into the video so it feels native. ── */}
                    <div className="sm:hidden absolute bottom-0 left-0 right-0 z-20 px-2 pt-6 pb-2 bg-gradient-to-t from-gray-950/80 via-gray-950/40 to-transparent">
                      <ControlButtons
                        primaryActionIsStop={primaryActionIsStop}
                        isMediaReady={isMediaReady}
                        onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
                        onSkip={handleNext}
                        onFilters={handleOpenFilters}
                        connectionState={hasActiveMatch ? connectionState : 'idle'}
                      />
                    </div>
                  </div>
                </div>

                <ChatDesktopAdBanner />

                {/* Desktop control bar */}
                <div className="shrink-0 hidden sm:block px-3 py-2 border-t border-gray-800/40">
                  <ControlButtons desktop compact={isPanelOpen} primaryActionIsStop={primaryActionIsStop} isMediaReady={isMediaReady}
                    onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
                    onSkip={handleNext} onFilters={handleOpenFilters}
                    connectionState={hasActiveMatch ? connectionState : 'idle'} />
                </div>
              </div>
            ) : (
              /* ── VOICE MODE ── */
              <div className="w-full flex-1 min-h-0 flex flex-col bg-gradient-to-b from-gray-900 to-gray-950 overflow-hidden">
                <ChatMobileAdBanner />
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-4 py-3">
                  <div className="w-20 h-20 rounded-full bg-violet-600/20 border-2 border-violet-500/30 flex items-center justify-center">
                    <Volume2 className="w-9 h-9 text-violet-400" />
                  </div>
                  {partnerDisplayCountry && (connectionState === 'connected' || connectionState === 'connecting') && (
                    <div className="text-center">
                      <span className="text-2xl">{partnerDisplayCountry.countryFlag}</span>
                      {partnerDisplayCountry.countryName && partnerDisplayCountry.countryName !== 'Unknown' && (
                        <p className="text-base font-medium mt-1">{partnerDisplayCountry.countryName}</p>
                      )}
                      <p className="text-sm text-gray-500">Stranger</p>
                    </div>
                  )}
                  {(connectionState === 'waiting') && (
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-violet-400 animate-spin mx-auto mb-2" />
                      <p className="text-sm text-gray-400">Searching for a voice chat partner…</p>
                      <p className="text-xs text-gray-600 mt-1">Voice chat may take longer to match — please wait</p>
                    </div>
                  )}
                  <div className="flex items-end gap-1 h-10">
                    {[1,2,3,4,5,6,7].map(i => (
                      <div key={i} className="w-1.5 bg-violet-500/60 rounded-full"
                        style={{ height: connectionState === 'connected' ? `${12 + Math.random() * 24}px` : '4px',
                          animation: connectionState === 'connected' ? `wave ${0.5 + i * 0.1}s ease-in-out infinite alternate` : 'none' }} />
                    ))}
                  </div>
                </div>
                <ChatDesktopAdBanner />
                <div className="shrink-0 hidden sm:block px-3 py-2 border-t border-gray-800/40">
                  <ControlButtons desktop compact={isPanelOpen} primaryActionIsStop={primaryActionIsStop} isMediaReady={isMediaReady}
                    onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
                    onSkip={handleNext} onFilters={handleOpenFilters}
                    connectionState={hasActiveMatch ? connectionState : 'idle'} />
                </div>
                <audio ref={remoteVideoRef} autoPlay className="hidden" />
              </div>
            )}

            {connectionState === 'connecting' && mode !== 'video' && (
              <div className="absolute inset-0 bg-gray-950/80 backdrop-blur-sm flex items-center justify-center z-20">
                <div className="text-center">
                  <Loader2 className="w-10 h-10 text-violet-400 animate-spin mx-auto mb-3" />
                  <p className="text-lg font-medium">Connecting…</p>
                  {partnerDisplayCountry && partnerDisplayCountry.countryName !== 'Unknown' && (
                    <p className="text-sm text-gray-400 mt-1">{partnerDisplayCountry.countryFlag} {partnerDisplayCountry.countryName}</p>
                  )}
                </div>
              </div>
            )}

            {connectionNotice && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 rounded-full border border-gray-700 bg-gray-900/90 px-4 py-2 text-xs text-gray-200 backdrop-blur">{connectionNotice}</div>
            )}

            {/* ── Matched-interests badge (desktop only) ── */}
            {matchedInterests.length > 0 && connectionState === 'connected' && (
              <div className={`absolute top-28 left-4 z-10 hidden sm:flex flex-wrap gap-2 max-w-[70%] transition-opacity duration-500 ${matchedInterestsVisible ? 'opacity-100' : 'opacity-0'}`}>
                {matchedInterests.map(interest => (
                  <span key={interest} className="rounded-full border border-violet-400/20 bg-violet-500/15 px-2.5 py-1 text-[11px] text-violet-100 backdrop-blur">#{interest}</span>
                ))}
              </div>
            )}
          </div>

          {/* ── CENTER: History / Friends panel ── */}
          <div className={`
            ${showChat ? 'hidden' : ''}
            ${showMobileCenterPane ? 'flex' : 'hidden'}
            ${isPanelOpen ? 'sm:flex' : 'sm:hidden'}
            w-full sm:w-72 lg:w-80 min-h-0 flex-col border-t sm:border-t-0 sm:border-l border-gray-800 bg-gray-900/70 backdrop-blur
          `}>
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <span className="text-sm font-medium">{panelTab === 'history' ? 'History' : 'Friends'}</span>
              <button onClick={() => openPanel(panelTab)} className="text-gray-400 hover:text-white hidden sm:block"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
              {panelTab === 'history' ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Interacted users</p>
                    <span className="text-[11px] text-gray-500">{activeHistoryFriendEntries.length}</span>
                  </div>
                  {activeHistoryFriendEntries.length === 0 ? (
                    <div className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3 text-xs text-gray-500">Your recent stranger history will appear here.</div>
                  ) : activeHistoryFriendEntries.map(item => {
                    const displayName = item.partnerName || `User ${String(item.partnerUserId || item.id).slice(-4)}`
                    const targetUserId = item.partnerUserId || null
                    const incomingRequest = friendRequests.incoming.find(r => r.requesterId === targetUserId)
                    const alreadyFriend = targetUserId ? friendIds.has(targetUserId) : false
                    const pendingOutgoing = targetUserId ? outgoingRequestIds.has(targetUserId) : false
                    const pendingIncoming = targetUserId ? incomingRequestIds.has(targetUserId) : false
                    return (
                      <div key={item.id} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            {item.partnerImage
                              ? <img src={item.partnerImage} alt={displayName} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                              : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">{displayName.charAt(0).toUpperCase()}</div>}
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-white">{displayName}</p>
                              <p className="truncate text-[11px] text-gray-400">{item.countryFlag || '🌐'} {item.countryName || 'Unknown'}</p>
                            </div>
                          </div>
                          <span className="text-[10px] text-gray-500 uppercase">{item.mode}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">{item.connectedAt ? new Date(item.connectedAt).toLocaleString() : 'Recently'}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {pendingIncoming ? (
                            <>
                              <button onClick={() => handleAcceptFriendRequest(incomingRequest?.requestId)} disabled={!incomingRequest?.requestId} className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Accept Request</button>
                              <button onClick={() => handleRejectFriendRequest(incomingRequest?.requestId)} disabled={!incomingRequest?.requestId} className="rounded-md border border-gray-700 px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700 disabled:opacity-40">Reject</button>
                            </>
                          ) : (
                            <button onClick={() => handleAddFriend(targetUserId)} disabled={!targetUserId || alreadyFriend || pendingOutgoing}
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-600/20 border border-emerald-500/30 px-2 py-1 text-[11px] font-medium text-emerald-200 disabled:opacity-40">
                              <UserPlus className="h-3 w-3" />
                              {alreadyFriend ? 'Friend Added' : pendingOutgoing ? 'Request Sent' : 'Add Friend'}
                            </button>
                          )}
                          <button onClick={() => openReportModal({ targetUserId, roomId: item.roomId || null, isCurrent: false })} disabled={!targetUserId}
                            className="inline-flex items-center gap-1 rounded-md bg-amber-600/20 border border-amber-500/30 px-2 py-1 text-[11px] font-medium text-amber-200 disabled:opacity-40">
                            <Flag className="h-3 w-3" /> Report
                          </button>
                          {item.onlineFriend?.online && (
                            <div className="flex gap-1">
                              <button onClick={() => handleConnectFriend(item.onlineFriend.friendAnonId, 'video')}
                                className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">
                                <Video className="h-3 w-3" /> Video
                              </button>
                              <button onClick={() => handleConnectFriend(item.onlineFriend.friendAnonId, 'voice')}
                                className="inline-flex items-center gap-1 rounded-md bg-purple-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-purple-500">
                                <Mic className="h-3 w-3" /> Voice
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">Friends</p>
                      <span className="text-[11px] text-gray-500">{sortedFriends.length}</span>
                    </div>
                    {sortedFriends.length === 0
                      ? <div className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3 text-xs text-gray-500">Added friends will appear here.</div>
                      : sortedFriends.map(friend => (
                          <div key={friend.friendUserId || friend.friendAnonId} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3">
                            <div className="flex items-center gap-3">
                              {friend.image
                                ? <img src={friend.image} alt={friend.name || 'Friend'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                                : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">{(friend.name || 'U').charAt(0).toUpperCase()}</div>}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-white">{friend.name || `User ${String(friend.friendUserId || friend.friendAnonId).slice(-4)}`}</p>
                                <p className="truncate text-[11px] text-gray-400">{friend.countryFlag || '🌐'} {friend.countryName || 'Unknown'}</p>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center gap-1">
                              <span className={`text-[11px] flex-1 ${friend.online ? 'text-green-300' : 'text-gray-500'}`}>{friend.online ? 'Online' : 'Offline'}</span>
                              {friend.online && (
                                <>
                                  <button onClick={() => handleConnectFriend(friend.friendUserId || friend.friendAnonId, 'video')}
                                    disabled={!!pendingInviteRequestId}
                                    className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500">
                                    <Video className="h-3 w-3" /> Video
                                  </button>
                                  <button onClick={() => handleConnectFriend(friend.friendUserId || friend.friendAnonId, 'voice')}
                                    disabled={!!pendingInviteRequestId}
                                    className="inline-flex items-center gap-1 rounded-md bg-purple-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500">
                                    <Mic className="h-3 w-3" /> Voice
                                  </button>
                                </>
                              )}
                              {!friend.online && <span className="text-[11px] text-gray-600 italic">Offline</span>}
                            </div>
                            <button onClick={() => openUnfriendConfirmation(friend)} className="mt-2 rounded-md border border-red-500/20 px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/10">Unfriend</button>
                          </div>
                        ))}
                  </div>

                  <div className="space-y-2 border-t border-gray-800 pt-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">Requests</p>
                      <span className="text-[11px] text-gray-500">{(friendRequests.incoming?.length || 0) + (friendRequests.outgoing?.length || 0)}</span>
                    </div>
                    {friendRequests.incoming?.map(request => (
                      <div key={request.requestId} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3 space-y-2">
                        <div className="flex items-center gap-3">
                          {request.profile?.image
                            ? <img src={request.profile.image} alt={request.profile?.name || 'Request'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                            : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">{(request.profile?.name || 'U').charAt(0).toUpperCase()}</div>}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-white">{request.profile?.name || `User ${String(request.requesterId).slice(-4)}`}</p>
                            <p className="truncate text-[11px] text-gray-400">{request.profile?.countryFlag || '🌐'} {request.profile?.countryName || 'Unknown'}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleAcceptFriendRequest(request.requestId)} className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500">Accept</button>
                          <button onClick={() => handleRejectFriendRequest(request.requestId)} className="rounded-md border border-gray-700 px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700">Reject</button>
                        </div>
                      </div>
                    ))}
                    {friendRequests.outgoing?.map(request => (
                      <div key={request.requestId} className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3">
                        <div className="flex items-center gap-3">
                          {request.profile?.image
                            ? <img src={request.profile.image} alt={request.profile?.name || 'Outgoing'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                            : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-sm font-semibold text-white">{(request.profile?.name || 'U').charAt(0).toUpperCase()}</div>}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-white">{request.profile?.name || `User ${String(request.recipientId).slice(-4)}`}</p>
                            <p className="truncate text-[11px] text-gray-400">{request.profile?.countryFlag || '🌐'} {request.profile?.countryName || 'Unknown'}</p>
                          </div>
                          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200">Pending</span>
                        </div>
                      </div>
                    ))}
                    {!friendRequests.incoming?.length && !friendRequests.outgoing?.length && (
                      <div className="rounded-xl border border-gray-800 bg-gray-800/30 px-3 py-3 text-xs text-gray-500">No pending requests right now.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT: Text chat sidebar ── */}
          <div className={`${showChat ? 'flex w-full h-full flex-1 sm:w-80 lg:w-96' : 'hidden sm:flex sm:w-80 lg:w-96'} min-h-0 flex-col overflow-hidden border-l border-gray-800 bg-gray-900`}>
            <div className="shrink-0 border-b border-gray-800 bg-gray-900 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium">Text Chat</span>
                </div>
                <button onClick={() => { setShowChat(false); setUnreadCount(0) }} className="sm:hidden text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex min-h-0 h-0 flex-1 flex-col overflow-hidden">
              <div ref={chatScrollRef} onScroll={handleChatScroll}
                onWheelCapture={e => { if (e.deltaY < 0) shouldAutoScrollRef.current = false }}
                onTouchMove={() => { shouldAutoScrollRef.current = false }}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3">
                <div className="space-y-3 pr-1">
                  {messages.length === 0 && (
                    <div className="mt-8 text-center text-sm text-gray-500">
                      <MessageSquare className="mx-auto mb-2 h-8 w-8 opacity-40" />
                      <p>{canSendMessages ? 'Send a message to start chatting!' : 'Match with someone to start chatting.'}</p>
                    </div>
                  )}
                  {messages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] break-words rounded-2xl px-3.5 py-2 ${msg.isMine ? 'bg-violet-600 text-white rounded-br-sm' : 'bg-gray-800 text-gray-200 rounded-bl-sm'}`}>
                        <p className="text-sm">{msg.text}</p>
                        <p className={`mt-1 text-[10px] ${msg.isMine ? 'text-violet-300' : 'text-gray-500'}`}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                    </div>
                  ))}
                  {isPartnerTyping && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-gray-800 px-3.5 py-2.5">
                        <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-1" />
                        <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-2" />
                        <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-3" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              </div>
              <div className="shrink-0 border-t border-gray-800 bg-gray-900 px-3 py-3">
                <div className="flex gap-2">
                  <input type="text" value={messageInput} onChange={handleInputChange} onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                    placeholder={canSendMessages ? 'Type a message...' : 'Match with someone to chat'}
                    disabled={!canSendMessages}
                    className="flex-1 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50" />
                  <button onClick={handleSendMessage} disabled={!canSendMessages || !messageInput.trim()} className="rounded-xl bg-violet-600 p-2.5 transition-all hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500">
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/*
          ── FIX: Mobile sticky bar ──
          Hidden in video mode (controls are overlaid on self-view instead).
          Still visible in voice mode and when chat/panel is open on mobile.
        ──*/}
        {!hideMobileBar && (
          <div className="sticky bottom-0 z-20 shrink-0 bg-gray-900 border-t border-gray-800 px-3 py-2 sm:hidden">
            <ControlButtons primaryActionIsStop={primaryActionIsStop} isMediaReady={isMediaReady}
              onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
              onSkip={handleNext} onFilters={handleOpenFilters}
              connectionState={hasActiveMatch ? connectionState : 'idle'} />
          </div>
        )}
      </div>
    </div>
  )
}

function ChatPageFallback() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="text-center">
        <Loader2 className="w-10 h-10 text-violet-400 animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-400">Loading chat...</p>
      </div>
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatPageFallback />}>
      <ChatPageContent />
    </Suspense>
  )
}