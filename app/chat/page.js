'use client'

import { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import GoogleAuthButton from '@/components/google-auth-button'
import GoogleSponsoredAd from '@/components/google-sponsored-ad'
import ProfileSettingsModal from '@/components/profile-settings-modal'
import { ALL_LANGUAGES, getLanguageByCode } from '@/lib/languages'
import { buildRtcConfig, MAX_CHAT_MESSAGES, LANGUAGE_FACTS, MAX_INTEREST_KEYWORDS, TURN_CREDENTIALS_ENDPOINT } from '@/lib/constants'
import {
  Mic, MicOff, Video, VideoOff, SkipForward, Phone, Flag, Captions, UserPlus,
  Send, MessageSquare, X, Loader2, Globe, Volume2, Users, Play, Square, SlidersHorizontal, AlertTriangle, ThumbsUp, ExternalLink
} from 'lucide-react'

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

const DIRECT_LINK_URL = process.env.NEXT_PUBLIC_DIRECT_LINK_URL || 'https://omg10.com/4/10800693'

function regionCodeToFlag(regionCode) {
  if (!regionCode || regionCode.length !== 2) return '🌐'
  return regionCode
    .toUpperCase()
    .split('')
    .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('')
}

function countryFromCode(regionCode) {
  if (!regionCode) {
    return {
      countryCode: null,
      countryName: 'Unknown',
      countryFlag: '🌐',
    }
  }

  const upper = regionCode.toUpperCase()
  let countryName = upper
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
    countryName = displayNames.of(upper) || upper
  } catch (e) {}

  return {
    countryCode: upper,
    countryName,
    countryFlag: regionCodeToFlag(upper),
  }
}

function deriveCountryFromLanguage(language) {
  const code = language?.code
  const regionCode = typeof code === 'string' && code.includes('-')
    ? code.split('-')[1].toUpperCase()
    : null

  const country = countryFromCode(regionCode)
  return {
    ...country,
    countryFlag: language?.flag || country.countryFlag,
  }
}

function createAnonUserId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `anon_${crypto.randomUUID()}`
  }
  return `anon_${generateId()}_${Date.now()}`
}

function normalizeInterestKeywords(rawKeywords = []) {
  return [...new Set(
    (Array.isArray(rawKeywords) ? rawKeywords : [])
      .map((keyword) => String(keyword || '').trim().toLowerCase())
      .filter(Boolean)
      .map((keyword) => keyword.slice(0, 32))
  )].slice(0, MAX_INTEREST_KEYWORDS)
}

function ControlButtons({
  primaryActionIsStop,
  isMediaReady,
  connectionState,
  onPrimary,
  onSkip,
  onFilters,
  desktop = false,
}) {
  const baseButtonClass = desktop
    ? 'inline-flex min-w-[150px] items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold transition-all'
    : 'inline-flex w-full items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition-all whitespace-nowrap'

  return (
    <div className={desktop ? 'flex flex-wrap items-center justify-center gap-3' : 'grid grid-cols-3 gap-2 items-center max-w-xl mx-auto'}>
      <button
        onClick={onPrimary}
        disabled={!isMediaReady && !primaryActionIsStop}
        className={`${baseButtonClass} bg-gray-800/90 border border-gray-700 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:text-gray-500`}
      >
        {primaryActionIsStop ? <Square className={desktop ? 'w-4 h-4' : 'w-3.5 h-3.5'} /> : <Play className={desktop ? 'w-4 h-4' : 'w-3.5 h-3.5'} />}
        {primaryActionIsStop ? 'Stop' : 'Start'}
      </button>
      <button
        onClick={onSkip}
        disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
        className={`${baseButtonClass} bg-violet-600 text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500`}
      >
        <SkipForward className={desktop ? 'w-4 h-4' : 'w-3.5 h-3.5'} /> Skip
      </button>
      <button
        onClick={onFilters}
        className={`${baseButtonClass} bg-amber-400 text-gray-900 hover:bg-amber-300 ${desktop ? '' : ''}`}
      >
        <SlidersHorizontal className={desktop ? 'w-4 h-4' : 'w-3.5 h-3.5'} /> Filters
      </button>
    </div>
  )
}

function ChatPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const mode = searchParams.get('mode') || 'video'
  const langCode = searchParams.get('lang') || 'en-US'
  const othersParam = searchParams.get('others') || ''

  const primaryLanguage = useMemo(() => getLanguageByCode(langCode) || ALL_LANGUAGES[0], [langCode])
  const additionalLanguages = useMemo(() => {
    if (!othersParam) return []
    return othersParam.split(',').map(c => getLanguageByCode(c)).filter(Boolean)
  }, [othersParam])

  // Core state
  const [connectionState, setConnectionState] = useState('initializing') // initializing | idle | waiting | connecting | connected
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [partnerLanguage, setPartnerLanguage] = useState(null)
  const [partnerCountry, setPartnerCountry] = useState(null)
  const [selfCountry, setSelfCountry] = useState({
    countryCode: null,
    countryName: 'Unknown',
    countryFlag: '🌐',
  })
  const [partnerId, setPartnerId] = useState(null)
  const [roomId, setRoomId] = useState(null)
  const [callDuration, setCallDuration] = useState(0)
  const [error, setError] = useState(null)
  const [isMediaReady, setIsMediaReady] = useState(false)
  const [backgroundBlurEnabled, setBackgroundBlurEnabled] = useState(false)
  const [backgroundBlurError, setBackgroundBlurError] = useState(null)

  // Chat state
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
  const [adEngagement, setAdEngagement] = useState({ skipCount: 0, shouldGateOnNextSkip: false })
  const [adGateOpen, setAdGateOpen] = useState(false)
  const [adGateReason, setAdGateReason] = useState(null)
  const [adGateLoading, setAdGateLoading] = useState(false)
  const [adGateNonce, setAdGateNonce] = useState(null)
  const [adGateSponsorClicked, setAdGateSponsorClicked] = useState(false)

  // Caption state
  const [myTranscript, setMyTranscript] = useState('')
  const [partnerCaption, setPartnerCaption] = useState(null)
  const [captionsVisible, setCaptionsVisible] = useState(true)
  const [captionEngineError, setCaptionEngineError] = useState(null)

  // Discovery / compatibility
  const [commonLanguagesNotice, setCommonLanguagesNotice] = useState('')

  // Friends
  const [friends, setFriends] = useState([])
  const [showFriendsPanel, setShowFriendsPanel] = useState(false)
  const [hasAddedFriendForCurrentMatch, setHasAddedFriendForCurrentMatch] = useState(false)

  // Reputation / engagement
  const [partnerLikes, setPartnerLikes] = useState(0)
  const [hasLikedPartner, setHasLikedPartner] = useState(false)
  const [hasReportedPartner, setHasReportedPartner] = useState(false)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [partnerUserId, setPartnerUserId] = useState(null)
  const [partnerProfile, setPartnerProfile] = useState(null)
  const [socketConnected, setSocketConnected] = useState(false)
  const [hasCameraPermission, setHasCameraPermission] = useState(mode !== 'video')

  // Language facts
  const [factIndex, setFactIndex] = useState(0)

  // Presence stats
  const [onlineCount, setOnlineCount] = useState(null)
  const [lastOnlineCount, setLastOnlineCount] = useState(null)
  const [interestKeywords, setInterestKeywords] = useState([])
  const [interestInput, setInterestInput] = useState('')
  const [matchedInterests, setMatchedInterests] = useState([])
  const [turnIceServers, setTurnIceServers] = useState([])
  const [matchedInterestsVisible, setMatchedInterestsVisible] = useState(false)
  const [connectionNotice, setConnectionNotice] = useState('')

  const partnerDisplayCountry = useMemo(() => {
    if (partnerCountry) return partnerCountry
    if (partnerProfile?.countryName || partnerProfile?.countryFlag) {
      return {
        countryCode: partnerProfile?.countryCode || null,
        countryName: partnerProfile?.countryName || 'Unknown',
        countryFlag: partnerProfile?.countryFlag || '🌐',
      }
    }
    return {
      countryCode: null,
      countryName: 'Unknown',
      countryFlag: '🌐',
    }
  }, [partnerCountry, partnerProfile])

  const sortedFriends = useMemo(() => {
    return [...friends].sort((a, b) => {
      if (a.online === b.online) return 0
      return a.online ? -1 : 1
    })
  }, [friends])

  const onlineFriends = useMemo(
    () => sortedFriends.filter(friend => friend.online),
    [sortedFriends]
  )

  const friendIds = useMemo(
    () => new Set(sortedFriends.map(friend => friend.friendUserId || friend.friendAnonId).filter(Boolean)),
    [sortedFriends]
  )

  const incomingRequestIds = useMemo(
    () => new Set((friendRequests.incoming || []).map(request => request.requesterId).filter(Boolean)),
    [friendRequests]
  )

  const outgoingRequestIds = useMemo(
    () => new Set((friendRequests.outgoing || []).map(request => request.recipientId).filter(Boolean)),
    [friendRequests]
  )

  const incomingRequestsCount = friendRequests.incoming?.length || 0
  const displayOnlineCount = onlineCount ?? lastOnlineCount

  const isSearching = connectionState === 'waiting' || connectionState === 'connecting'
  const isConnected = connectionState === 'connected'

  // Refs
  const socketRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const rawLocalStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const recognitionRef = useRef(null)
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
  const translationCacheRef = useRef(new Map())
  const debounceTimerRef = useRef(null)
  const pendingTextRef = useRef('')
  const lastSentCaptionRef = useRef('')
  const pendingStartRef = useRef(false)
  const currentMatchHistoryIdRef = useRef(null)
  const blurVideoRef = useRef(null)
  const blurCanvasRef = useRef(null)
  const blurFrameRef = useRef(null)
  const blurSegmentationRef = useRef(null)
  const processedVideoTrackRef = useRef(null)
  const countrySyncRef = useRef(false)
  const matchedInterestsTimeoutRef = useRef(null)
  const matchedInterestsHideTimeoutRef = useRef(null)
  const searchingModeRef = useRef(false)
  const pendingAdActionRef = useRef(null)

  // Keep refs in sync
  useEffect(() => { partnerIdRef.current = partnerId }, [partnerId])
  useEffect(() => { partnerLanguageRef.current = partnerLanguage }, [partnerLanguage])
  useEffect(() => { primaryLanguageRef.current = primaryLanguage }, [primaryLanguage])
  useEffect(() => { roomIdRef.current = roomId }, [roomId])
  useEffect(() => { searchingModeRef.current = pendingStartRef.current }, [connectionState])

  useEffect(() => {
    if (matchedInterestsTimeoutRef.current) clearTimeout(matchedInterestsTimeoutRef.current)
    if (matchedInterestsHideTimeoutRef.current) clearTimeout(matchedInterestsHideTimeoutRef.current)

    if (!matchedInterests.length) {
      setMatchedInterestsVisible(false)
      return undefined
    }

    setMatchedInterestsVisible(true)
    matchedInterestsHideTimeoutRef.current = setTimeout(() => {
      setMatchedInterestsVisible(false)
    }, 2500)
    matchedInterestsTimeoutRef.current = setTimeout(() => {
      setMatchedInterests([])
      setMatchedInterestsVisible(false)
    }, 3000)

    return () => {
      if (matchedInterestsTimeoutRef.current) clearTimeout(matchedInterestsTimeoutRef.current)
      if (matchedInterestsHideTimeoutRef.current) clearTimeout(matchedInterestsHideTimeoutRef.current)
    }
  }, [matchedInterests])

  useEffect(() => {
    try {
      const savedCaptionPref = localStorage.getItem('omingle_captions_enabled')
      if (CAPTIONS_UI_ENABLED && savedCaptionPref !== null) {
        setCaptionsVisible(savedCaptionPref === 'true')
      }

      const savedBlurPref = localStorage.getItem('omingle_background_blur_enabled')
      if (BLUR_FEATURE_ENABLED && savedBlurPref !== null) {
        setBackgroundBlurEnabled(savedBlurPref === 'true')
      }

      const savedInterests = localStorage.getItem('hippichat_interest_keywords')
      if (savedInterests) {
        setInterestKeywords(normalizeInterestKeywords(JSON.parse(savedInterests)))
      }

      let anonId = localStorage.getItem('omingle_anon_user_id')
      if (!anonId) {
        anonId = createAnonUserId()
        localStorage.setItem('omingle_anon_user_id', anonId)
      }
      anonUserIdRef.current = anonId
    } catch (e) {
      anonUserIdRef.current = `anon_fallback_${generateId()}`
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('hippichat_interest_keywords', JSON.stringify(interestKeywords))
    } catch (e) {}
  }, [interestKeywords])

  useEffect(() => {
    let cancelled = false

    async function loadSession() {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled) {
          setSessionUser(data?.user || null)
          setSessionResolved(true)
        }
      } catch (e) {
        if (!cancelled) {
          setSessionUser(null)
          setSessionResolved(true)
        }
      }
    }

    loadSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sessionResolved) return
    if (sessionUser) return
    router.replace('/')
  }, [sessionResolved, sessionUser, router])

  useEffect(() => {
    if (!sessionUser?.id) return
    let cancelled = false

    fetch('/api/ad-engagement', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setAdEngagement({
          skipCount: Number(data?.skipCount || 0),
          shouldGateOnNextSkip: !!data?.shouldGateOnNextSkip,
        })
      })
      .catch(() => {
        if (cancelled) return
        setAdEngagement({ skipCount: 0, shouldGateOnNextSkip: false })
      })

    return () => {
      cancelled = true
    }
  }, [sessionUser?.id])

  useEffect(() => {
    let cancelled = false

    async function loadTurnCredentials() {
      try {
        const res = await fetch(TURN_CREDENTIALS_ENDPOINT, { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled && res.ok && Array.isArray(data?.urls) && data?.username && data?.credential) {
          setTurnIceServers([
            {
              urls: data.urls,
              username: data.username,
              credential: data.credential,
            },
          ])
        }
      } catch (error) {
        if (!cancelled) {
          setTurnIceServers([])
        }
      }
    }

    loadTurnCredentials()
    return () => {
      cancelled = true
    }
  }, [sessionUser?.id])

  useEffect(() => {
    if (!sessionUser?.id) return
    if (!selfCountry?.countryName || selfCountry.countryName === 'Unknown') return
    if (countrySyncRef.current) return
    if (sessionUser?.countryCode === selfCountry.countryCode && sessionUser?.countryName === selfCountry.countryName && sessionUser?.countryFlag === selfCountry.countryFlag) return

    countrySyncRef.current = true
    fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: selfCountry.countryCode,
        countryName: selfCountry.countryName,
        countryFlag: selfCountry.countryFlag,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.user) setSessionUser(data.user)
      })
      .catch(() => {})
      .finally(() => {
        countrySyncRef.current = false
      })
  }, [selfCountry, sessionUser])

  useEffect(() => {
    if (sessionUser?.countryName || sessionUser?.countryFlag) {
      setSelfCountry((prev) => ({
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
      .then(data => {
        if (cancelled) return
        const region = data?.country_code
        if (!region) return
        const detected = countryFromCode(region)
        setSelfCountry(detected)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      clearTimeout(timeout)
      controller.abort()
    }
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
    const nextKeyword = interestInput.trim().toLowerCase()
    if (!nextKeyword) return
    setInterestKeywords((prev) => normalizeInterestKeywords([...prev, nextKeyword]))
    setInterestInput('')
  }

  function removeInterestKeyword(keywordToRemove) {
    setInterestKeywords((prev) => prev.filter((keyword) => keyword !== keywordToRemove))
  }

  function openUnfriendConfirmation(friend) {
    setUnfriendTarget(friend)
    setUnfriendConfirmStep(1)
  }

  function closeUnfriendConfirmation() {
    setUnfriendTarget(null)
    setUnfriendConfirmStep(1)
  }

  function handleUnfriend(friend) {
    const friendUserId = friend?.friendUserId || friend?.friendAnonId
    if (!socketRef.current || !friendUserId) return
    socketRef.current.emit('unfriend', { friendUserId })
    closeUnfriendConfirmation()
  }

  function respondToFriendInvite(accepted) {
    if (!socketRef.current || !friendInviteRequest?.inviteId) return
    socketRef.current.emit('respond-friend-connect', {
      inviteId: friendInviteRequest.inviteId,
      accepted,
    })
    setFriendInviteRequest(null)
  }

  function upsertInteractionHistory(entry) {
    if (!entry?.id) return
    setInteractionHistory(prev => {
      const existingIndex = prev.findIndex(item => item.id === entry.id)
      const next = existingIndex >= 0
        ? prev.map(item => item.id === entry.id ? { ...item, ...entry } : item)
        : [{ ...entry }, ...prev]
      return next.slice(0, MAX_HISTORY_ITEMS)
    })
  }

  function updateCurrentHistoryEntry(patch) {
    if (!currentMatchHistoryIdRef.current) return
    setInteractionHistory(prev => prev.map(item => (
      item.id === currentMatchHistoryIdRef.current ? { ...item, ...patch } : item
    )))
  }

  async function attachLocalPreviewStream(stream) {
    if (!localVideoRef.current || !stream || mode !== 'video') return

    if (localVideoRef.current.srcObject !== stream) {
      localVideoRef.current.srcObject = stream
    }
    localVideoRef.current.muted = true
    localVideoRef.current.playsInline = true

    try {
      await localVideoRef.current.play()
    } catch (e) {}
  }

  async function attachRemotePreviewStream() {
    if (!remoteVideoRef.current || !remoteStreamRef.current || mode !== 'video') return
    if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current
    }
    try {
      await remoteVideoRef.current.play()
    } catch (e) {}
  }

  async function replacePeerConnectionVideoTrack(track) {
    if (!pcRef.current || !track) return
    const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    try {
      await sender.replaceTrack(track)
    } catch (e) {
      console.error('[WebRTC] Failed to replace outgoing video track:', e)
    }
  }

  function stopBackgroundBlurProcessing({ restoreRaw = false } = {}) {
    if (blurFrameRef.current) {
      cancelAnimationFrame(blurFrameRef.current)
      blurFrameRef.current = null
    }

    if (blurVideoRef.current) {
      try {
        blurVideoRef.current.pause()
      } catch (e) {}
      blurVideoRef.current.srcObject = null
      blurVideoRef.current = null
    }

    if (processedVideoTrackRef.current) {
      try {
        processedVideoTrackRef.current.stop()
      } catch (e) {}
      processedVideoTrackRef.current = null
    }

    blurCanvasRef.current = null

    if (restoreRaw && rawLocalStreamRef.current) {
      localStreamRef.current = rawLocalStreamRef.current
      attachLocalPreviewStream(rawLocalStreamRef.current)
      replacePeerConnectionVideoTrack(rawLocalStreamRef.current.getVideoTracks?.()[0])
    }
  }

  async function ensureSegmentationLoaded() {
    if (typeof window === 'undefined') throw new Error('Window unavailable')
    if (window.SelfieSegmentation) return window.SelfieSegmentation

    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-mediapipe-selfie]')
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('Failed to load blur model')), { once: true })
        return
      }

      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js'
      script.async = true
      script.dataset.mediapipeSelfie = 'true'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load blur model'))
      document.body.appendChild(script)
    })

    if (!window.SelfieSegmentation) {
      throw new Error('Background blur model unavailable')
    }

    return window.SelfieSegmentation
  }

  async function enableBackgroundBlur() {
    if (!BLUR_FEATURE_ENABLED || mode !== 'video') return
    if (!rawLocalStreamRef.current) return

    const rawVideoTrack = rawLocalStreamRef.current.getVideoTracks?.()[0]
    if (!rawVideoTrack) return

    setBackgroundBlurError(null)

    try {
      const SelfieSegmentation = await ensureSegmentationLoaded()
      stopBackgroundBlurProcessing()

      const hiddenVideo = document.createElement('video')
      hiddenVideo.autoplay = true
      hiddenVideo.muted = true
      hiddenVideo.playsInline = true
      hiddenVideo.srcObject = rawLocalStreamRef.current
      blurVideoRef.current = hiddenVideo
      await hiddenVideo.play().catch(() => {})

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      blurCanvasRef.current = canvas

      const segmentation = new SelfieSegmentation({
        locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
      })
      segmentation.setOptions({ modelSelection: 1 })
      blurSegmentationRef.current = segmentation

      segmentation.onResults((results) => {
        const image = results.image
        const width = image.videoWidth || image.width || 640
        const height = image.videoHeight || image.height || 480

        if (!width || !height || !ctx) return
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }

        ctx.save()
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(results.segmentationMask, 0, 0, width, height)
        ctx.globalCompositeOperation = 'source-out'
        ctx.filter = 'blur(18px)'
        ctx.drawImage(image, 0, 0, width, height)
        ctx.globalCompositeOperation = 'destination-atop'
        ctx.filter = 'none'
        ctx.drawImage(image, 0, 0, width, height)
        ctx.restore()
      })

      const processFrame = async () => {
        if (!backgroundBlurEnabled || !blurVideoRef.current || blurVideoRef.current.readyState < 2) {
          blurFrameRef.current = requestAnimationFrame(processFrame)
          return
        }

        try {
          await segmentation.send({ image: blurVideoRef.current })
        } catch (e) {
          console.error('[Blur] Frame processing failed:', e)
        }

        blurFrameRef.current = requestAnimationFrame(processFrame)
      }

      blurFrameRef.current = requestAnimationFrame(processFrame)

      const processedStream = canvas.captureStream(24)
      const processedTrack = processedStream.getVideoTracks?.()[0]
      if (!processedTrack) throw new Error('Unable to create blurred video stream')
      processedVideoTrackRef.current = processedTrack

      const mixedStream = new MediaStream([
        processedTrack,
        ...rawLocalStreamRef.current.getAudioTracks(),
      ])

      localStreamRef.current = mixedStream
      await attachLocalPreviewStream(mixedStream)
      await replacePeerConnectionVideoTrack(processedTrack)
    } catch (err) {
      console.error('[Blur] Could not enable background blur:', err)
      setBackgroundBlurError('Background blur unavailable on this device/browser')
      setBackgroundBlurEnabled(false)
      try {
        localStorage.setItem('omingle_background_blur_enabled', 'false')
      } catch (e) {}
      stopBackgroundBlurProcessing({ restoreRaw: true })
    }
  }

  async function toggleBackgroundBlur() {
    if (!BLUR_FEATURE_ENABLED) return
    setBackgroundBlurEnabled(prev => {
      const next = !prev
      try {
        localStorage.setItem('omingle_background_blur_enabled', String(next))
      } catch (e) {}
      return next
    })
  }

  function showCommonLanguages(commonLanguages) {
    const names = (commonLanguages || [])
      .map(l => l?.name)
      .filter(Boolean)

    if (!names.length) {
      setCommonLanguagesNotice('')
      return
    }

    if (commonLanguagesTimeoutRef.current) {
      clearTimeout(commonLanguagesTimeoutRef.current)
    }

    setCommonLanguagesNotice(`You both can speak: ${names.join(', ')}`)
    commonLanguagesTimeoutRef.current = setTimeout(() => {
      setCommonLanguagesNotice('')
    }, 4200)
  }

  function upsertFriend(friend) {
    const friendId = friend?.friendUserId || friend?.friendAnonId
    if (!friendId) return
    setFriends(prev => {
      const normalized = { ...friend, friendUserId: friendId, friendAnonId: friendId }
      const idx = prev.findIndex(f => (f.friendUserId || f.friendAnonId) === friendId)
      if (idx === -1) return [normalized, ...prev]
      const clone = [...prev]
      clone[idx] = { ...clone[idx], ...normalized }
      return clone
    })
  }

  async function openAdGateSession(reason) {
    const response = await fetch('/api/ad-engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open-gate', reason }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data?.error || 'Unable to open ad gate')
    }
    setAdGateNonce(data?.pendingGate?.nonce || null)
    return data
  }

  async function openAdGate(reason, action) {
    setAdGateLoading(true)
    const opened = window.open(DIRECT_LINK_URL, '_blank', 'noopener,noreferrer')
    if (opened) setAdGateSponsorClicked(true)

    try {
      const data = await openAdGateSession(reason)
      await completeAdGate(reason, data?.pendingGate?.nonce || null)
    } catch (error) {
      // Allow flow to continue even if ad gate APIs fail.
    } finally {
      setAdGateLoading(false)
      action?.()
    }
  }

  async function completeAdGate(reason, nonce) {
    const res = await fetch('/api/ad-engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete-gate', reason, nonce }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Unable to complete ad gate')
    }
    setAdEngagement((prev) => ({
      ...prev,
      skipCount: Number(data?.skipCount || 0),
      shouldGateOnNextSkip: Number(data?.skipCount || 0) >= 9,
    }))
  }

  async function handleAdGateContinue() {
    if (adGateLoading) return
    setAdGateLoading(true)
    const reason = adGateReason
    try {
      await completeAdGate(reason, adGateNonce)
    } catch (error) {
      setAdGateLoading(false)
      showActionFeedback('Please wait for the sponsored step to finish')
      return
    }
    const action = pendingAdActionRef.current
    pendingAdActionRef.current = null
    setAdGateOpen(false)
    setAdGateReason(null)
    setAdGateNonce(null)
    setAdGateSponsorClicked(false)
    setAdGateLoading(false)
    action?.()
  }

  function closeAdGate() {
    if (adGateLoading) return
    setAdGateOpen(false)
    setAdGateReason(null)
    setAdGateNonce(null)
    setAdGateSponsorClicked(false)
    pendingAdActionRef.current = null
  }

  function handleOpenFilters() {
    openAdGate('filters', () => setShowPreferences(true))
  }

  function handleAddFriend(targetUserId = partnerUserId) {
    if (!socketRef.current || !targetUserId) return
    openAdGate('add-friend', () => {
      socketRef.current?.emit('send-friend-request', { targetUserId })
    })
  }

  function handleAcceptFriendRequest(requestId) {
    if (!socketRef.current || !requestId) return
    socketRef.current.emit('accept-friend-request', { requestId })
  }

  function handleRejectFriendRequest(requestId) {
    if (!socketRef.current || !requestId) return
    socketRef.current.emit('reject-friend-request', { requestId })
  }

  function handleConnectFriend(friendAnonId) {
    if (!socketRef.current || !friendAnonId) return
    socketRef.current.emit('connect-friend', { friendAnonId })
    setShowFriendsPanel(false)
  }

  // =================== SOCKET.IO CONNECTION ===================
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
          console.log('[Socket] Connected:', socket.id)
          setSocketConnected(true)
          setError(null)
          setConnectionNotice('')
          socket.emit('get-friends-status')
          if (pendingStartRef.current) {
            joinQueue()
          }
        })

        socket.on('matched', handleMatched)
        socket.on('signal', handleSignal)
        socket.on('partner-left', handlePartnerLeft)
        socket.on('partner-skipped', () => {
          showActionFeedback('Partner skipped to the next chat')
        })
        socket.on('receive-message', handleReceiveMessage)
        socket.on('typing', () => setIsPartnerTyping(true))
        socket.on('stop-typing', () => setIsPartnerTyping(false))
        socket.on('translation-ready', handleTranslationReady)
        socket.on('friends-status', (data) => {
          const list = Array.isArray(data?.friends) ? data.friends : []
          setFriends(list)
        })
        socket.on('friend-requests', (data) => {
          setFriendRequests({
            incoming: Array.isArray(data?.incoming) ? data.incoming : [],
            outgoing: Array.isArray(data?.outgoing) ? data.outgoing : [],
          })
        })
        socket.on('history-updated', (data) => {
          const history = Array.isArray(data?.history) ? data.history : []
          setInteractionHistory(history)
        })
        socket.on('friend-request-received', () => {
          showActionFeedback('New friend request received')
        })
        socket.on('friend-online-status', (data) => {
          if (!data?.friendAnonId && !data?.friendUserId) return
          upsertFriend({
            friendAnonId: data.friendUserId || data.friendAnonId,
            friendUserId: data.friendUserId || data.friendAnonId,
            online: !!data.online,
          })
        })
        socket.on('friend-connect-result', (data) => {
          if (!data?.ok) {
            if (data?.reason === 'offline') showActionFeedback('Friend is offline')
            else if (data?.reason === 'not-friends') showActionFeedback('You are not friends yet')
            else if (data?.reason === 'declined') showActionFeedback('Friend declined the invite')
            else if (data?.reason === 'expired') showActionFeedback('Friend invite expired')
            else showActionFeedback('Unable to connect friend right now')
            setPendingInviteRequestId(null)
            return
          }
          if (data?.pending) {
            setPendingInviteRequestId(data.inviteId)
            showActionFeedback('Invite sent to your friend')
            return
          }
          setPendingInviteRequestId(null)
          showActionFeedback('Connecting to friend...')
        })
        socket.on('friend-connect-invite', (data) => {
          setFriendInviteRequest(data)
        })
        socket.on('partner-likes-updated', (data) => {
          if (typeof data?.likes === 'number') {
            setPartnerLikes(data.likes)
          }
        })
        socket.on('received-like', (data) => {
          if (typeof data?.totalLikes === 'number') {
            showActionFeedback(`You got a like 👍 · Total ${data.totalLikes}`)
          } else {
            showActionFeedback('You got a like 👍')
          }
        })
        socket.on('action-feedback', (data) => {
          if (!data?.type) return
          if (data.type === 'like') {
            if (data.status === 'ok' || data.status === 'duplicate') {
              setHasLikedPartner(true)
            }
            showActionFeedback(data.status === 'duplicate' ? 'You already liked this user' : 'Like sent 👍')
          }

          if (data.type === 'report') {
            if (data.status === 'ok' || data.status === 'duplicate') {
              setHasReportedPartner(true)
            }
            showActionFeedback(data.status === 'duplicate' ? 'You already reported this user' : 'Report submitted')
          }

          if (data.type === 'friend-request') {
            if (data.status === 'ok' || data.status === 'duplicate' || data.status === 'awaiting-your-response' || data.status === 'already-friends') {
              setHasAddedFriendForCurrentMatch(true)
            }
            if (data.status === 'ok') showActionFeedback('Friend request sent')
            else if (data.status === 'duplicate') showActionFeedback('Friend request already sent')
            else if (data.status === 'awaiting-your-response') showActionFeedback('This user has already sent you a request')
            else if (data.status === 'already-friends') showActionFeedback('Already in your friends list')
          }

          if (data.type === 'friend-request-accept' && data.status === 'ok') {
            showActionFeedback('Friend request accepted')
          }

          if (data.type === 'friend-request-reject' && data.status === 'ok') {
            showActionFeedback('Friend request rejected')
          }

          if (data.type === 'unfriend' && data.status === 'ok') {
            showActionFeedback('Friend removed')
          }
        })
        socket.on('stats', (data) => {
          if (typeof data?.online === 'number') {
            setOnlineCount(data.online)
            setLastOnlineCount(data.online)
          }
        })
        socket.on('queue-status', (data) => {
          console.log('[Socket] Queue status:', data)
        })
        socket.on('account-blocked', (data) => {
          pendingStartRef.current = false
          resetSessionUi()
          setConnectionState('idle')
          setAccountBlockedInfo(data || null)
          setShowPreferences(false)
          setSettingsOpen(false)
          showActionFeedback(data?.message || 'Account temporarily blocked from matching')
        })
        socket.on('force-logout', async () => {
          try {
            await fetch('/api/auth/logout', { method: 'POST' })
          } catch (error) {}
          setSessionUser(null)
          setSettingsOpen(false)
          setShowPreferences(false)
          pendingStartRef.current = false
          showActionFeedback('Signed out because this account was used elsewhere')
          router.replace('/')
        })
        socket.emit('get-friends-status')

        socket.on('connect_error', (err) => {
          console.error('[Socket] Connection error:', err)
          setSocketConnected(false)
          if (pendingStartRef.current) {
            showConnectionNotice('Reconnecting to chat...')
          }
        })

        socket.on('disconnect', (reason) => {
          console.log('[Socket] Disconnected', reason)
          setSocketConnected(false)
          if (pendingStartRef.current && reason !== 'io client disconnect') {
            showConnectionNotice('Connection lost. Reconnecting...')
          }
        })
      } catch (err) {
        console.error('[Socket] Init error:', err)
        setError('Failed to initialize connection')
      }
    }

    initSocket()

    return () => {
      destroyed = true
      if (socket) {
        socket.off('matched')
        socket.off('signal')
        socket.off('partner-left')
        socket.off('partner-skipped')
        socket.off('receive-message')
        socket.off('typing')
        socket.off('stop-typing')
        socket.off('translation-ready')
        socket.off('friends-status')
        socket.off('friend-requests')
        socket.off('history-updated')
        socket.off('friend-request-received')
        socket.off('friend-online-status')
        socket.off('friend-connect-result')
        socket.off('friend-connect-invite')
        socket.off('partner-likes-updated')
        socket.off('received-like')
        socket.off('action-feedback')
        socket.off('stats')
        socket.off('queue-status')
        socket.off('account-blocked')
        socket.off('force-logout')
        socket.disconnect()
      }

      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current)
      }
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
    // For the “5232+” vibe
    if (n >= 1000) return `${Math.floor(n).toLocaleString()}+`
    return `${n}+`
  }

  // =================== MEDIA STREAM ===================
  const [mediaWarning, setMediaWarning] = useState(null)

  useEffect(() => {
    async function getMedia() {
      try {
        const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
        const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices)

        if (!getUserMedia) {
          const fallbackMessage = typeof window !== 'undefined' && !window.isSecureContext
            ? 'Camera/mic needs HTTPS or localhost. You can still use text chat.'
            : 'This browser/device does not support camera or mic access. You can still use text chat.'
          throw new Error(fallbackMessage)
        }

        const constraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48000,
            sampleSize: 16,
          },
          video: mode === 'video' ? { width: 640, height: 480, facingMode: 'user' } : false,
        }
        const stream = await getUserMedia(constraints)
        rawLocalStreamRef.current = stream
        localStreamRef.current = stream
        setHasCameraPermission(mode !== 'video' || stream.getVideoTracks().length > 0)

        if (localVideoRef.current && mode === 'video') {
          await attachLocalPreviewStream(stream)
        }

        setIsMediaReady(true)

        if (pendingStartRef.current && socketRef.current?.connected) {
          joinQueue()
        } else {
          setConnectionState('idle')
        }
      } catch (err) {
        console.error('[Media] Error:', err)
        const denied = err?.name === 'NotAllowedError'
        const message = denied
          ? mode === 'video' ? 'Camera access is required for video chat.' : 'Microphone permission denied. You can still use text chat.'
          : err?.message
            ? `${err.message}`
            : 'Could not access camera/mic. Text chat is still available.'

        setMediaWarning(message)
        setIsMediaReady(true)
        setHasCameraPermission(mode !== 'video')

        if (pendingStartRef.current && socketRef.current?.connected) {
          joinQueue()
        } else {
          setConnectionState('idle')
        }
      }
    }

    getMedia()

    return () => {
      stopBackgroundBlurProcessing()
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop())
      }
      if (rawLocalStreamRef.current && rawLocalStreamRef.current !== localStreamRef.current) {
        rawLocalStreamRef.current.getTracks().forEach(t => t.stop())
      }
    }
  }, [mode])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const onPopState = () => {
      if (showChat) {
        setShowChat(false)
        setUnreadCount(0)
        return
      }
      if (panelTab) {
        setPanelTab(null)
        setMobilePane('video')
      }
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [panelTab, showChat])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (showChat || panelTab) {
      window.history.pushState({ omingleOverlay: true, showChat, panelTab }, '', window.location.href)
    }
  }, [panelTab, showChat])

  // Ensure local preview attaches even if the <video> ref becomes available after getUserMedia resolves
  useEffect(() => {
    if (mode !== 'video') return
    if (!localVideoRef.current) return
    if (!localStreamRef.current) return

    attachLocalPreviewStream(localStreamRef.current)
  })

  useEffect(() => {
    attachRemotePreviewStream()
  })

  useEffect(() => {
    if (!BLUR_FEATURE_ENABLED || mode !== 'video') return
    if (!isMediaReady || !rawLocalStreamRef.current) return

    if (backgroundBlurEnabled) {
      enableBackgroundBlur()
    } else {
      stopBackgroundBlurProcessing({ restoreRaw: true })
      setBackgroundBlurError(null)
    }

    return () => {
      if (!backgroundBlurEnabled) {
        stopBackgroundBlurProcessing()
      }
    }
  }, [backgroundBlurEnabled, isMediaReady, mode])

  // =================== CALL TIMER ===================
  useEffect(() => {
    if (connectionState === 'connected') {
      setCallDuration(0)
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
    }
    return () => {
      if (callTimerRef.current) clearInterval(callTimerRef.current)
    }
  }, [connectionState])

  // =================== LANGUAGE FACTS ROTATION ===================
  useEffect(() => {
    if (connectionState === 'waiting') {
      const interval = setInterval(() => setFactIndex(i => (i + 1) % LANGUAGE_FACTS.length), 5000)
      return () => clearInterval(interval)
    }
  }, [connectionState])

  // =================== LIVE CAPTIONS ENGINE (AZURE STT) ===================
  function stopRecognitionEngine() {
    const recognizer = recognitionRef.current
    if (!recognizer) return

    try {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          try { recognizer.close() } catch (e) {}
        },
        () => {
          try { recognizer.close() } catch (e) {}
        }
      )
    } catch (e) {
      try { recognizer.close() } catch (closeErr) {}
    }

    recognitionRef.current = null
  }

  useEffect(() => {
    let cancelled = false

    if (!CAPTIONS_UI_ENABLED || !captionsVisible || connectionState !== 'connected') {
      stopRecognitionEngine()
      return
    }

    async function startAzureCaptions() {
      try {
        setCaptionEngineError(null)

        const tokenRes = await fetch('/api/speech-token', { method: 'POST' })
        const tokenData = await tokenRes.json().catch(() => ({}))

        if (!tokenRes.ok || !tokenData?.token || !tokenData?.region) {
          throw new Error(tokenData?.error || 'Failed to fetch speech token')
        }

        const sdk = await import('microsoft-cognitiveservices-speech-sdk')
        if (cancelled) return

        const lang = primaryLanguageRef.current?.webSpeechCode || primaryLanguageRef.current?.googleCode || 'en-US'
        const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(tokenData.token, tokenData.region)
        speechConfig.speechRecognitionLanguage = lang

        // Latency tuning
        speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, '700')
        speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '4000')

        const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput()
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig)
        recognitionRef.current = recognizer

        recognizer.recognizing = (_s, event) => {
          const text = event?.result?.text?.trim()
          if (!text) return
          setMyTranscript(text)
        }

        recognizer.recognized = (_s, event) => {
          const isRecognized = event?.result?.reason === sdk.ResultReason.RecognizedSpeech
          const text = event?.result?.text?.trim()
          if (!isRecognized || !text) return

          setMyTranscript(text)
          handleFinalTranscript(text)
        }

        recognizer.canceled = (_s, event) => {
          console.warn('[Speech] Azure canceled:', event?.errorDetails || event?.reason)
          if (!cancelled) {
            setCaptionEngineError('Live captions are temporarily unavailable')
          }
        }

        recognizer.startContinuousRecognitionAsync(
          () => {
            if (!cancelled) setCaptionEngineError(null)
          },
          (err) => {
            console.error('[Speech] Azure start error:', err)
            if (!cancelled) {
              setCaptionEngineError('Unable to start live captions')
            }
          }
        )
      } catch (err) {
        console.error('[Speech] Azure captions init failed:', err)
        if (!cancelled) {
          setCaptionEngineError('Live captions unavailable on this network/device')
        }
      }
    }

    startAzureCaptions()

    return () => {
      cancelled = true
      stopRecognitionEngine()
    }
  }, [connectionState, primaryLanguage?.webSpeechCode])

  // =================== HANDLERS ===================
  function joinQueue() {
    if (!socketRef.current?.connected) return
    if (!sessionUser?.id) {
      router.replace('/')
      return
    }
    console.log('[Client] joinQueue start', { mode, interests: interestKeywords })
    setConnectionState('waiting')
    setMessages([])
    setPartnerCaption(null)
    setMyTranscript('')
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
    console.log('[Match] Matched!', data)
    setConnectionState('connecting')
    setMobilePane('video')
    setPartnerId(data.partnerId)
    setPartnerUserId(data.partnerUserId || null)
    setPartnerProfile(data.partnerProfile || null)
    setPartnerLanguage(data.partnerLanguage)
    setPartnerCountry(
      data.partnerCountry ||
      (data.partnerProfile?.countryName || data.partnerProfile?.countryFlag
        ? {
            countryCode: data.partnerProfile?.countryCode || null,
            countryName: data.partnerProfile?.countryName || 'Unknown',
            countryFlag: data.partnerProfile?.countryFlag || '🌐',
          }
        : {
            countryCode: null,
            countryName: 'Unknown',
            countryFlag: '🌐',
          })
    )
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
    const derivedCountry = data.partnerCountry || (data.partnerProfile?.countryName || data.partnerProfile?.countryFlag
      ? {
          countryCode: data.partnerProfile?.countryCode || null,
          countryName: data.partnerProfile?.countryName || 'Unknown',
          countryFlag: data.partnerProfile?.countryFlag || '🌐',
        }
      : {
          countryCode: null,
          countryName: 'Unknown',
          countryFlag: '🌐',
        })
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

    // Small delay to ensure state is set
    setTimeout(() => {
      initPeerConnection(data.isInitiator, data.partnerId)
    }, 500)
  }

  async function handleSignal(data) {
    console.log('[Signal] Received:', data.type, 'from:', data.from)
    const pc = pcRef.current

    try {
      if (data.type === 'offer' && data.payload) {
        if (!pc) {
          initPeerConnection(false, data.from)
          await new Promise(r => setTimeout(r, 100))
        }
        const currentPc = pcRef.current
        if (!currentPc) return

        await currentPc.setRemoteDescription(new RTCSessionDescription(data.payload))

        // Process queued ICE candidates
        for (const candidate of iceCandidateQueue.current) {
          try { await currentPc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) {}
        }
        iceCandidateQueue.current = []

        const answer = await currentPc.createAnswer()
        await currentPc.setLocalDescription(answer)
        socketRef.current?.emit('signal', {
          type: 'answer',
          to: data.from,
          payload: answer,
        })
      } else if (data.type === 'answer' && data.payload && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.payload))

        // Process queued ICE candidates
        for (const candidate of iceCandidateQueue.current) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) {}
        }
        iceCandidateQueue.current = []
      } else if (data.type === 'ice-candidate' && data.payload) {
        if (pc && pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.payload)) } catch (e) {}
        } else {
          iceCandidateQueue.current.push(data.payload)
        }
      }
    } catch (err) {
      console.error('[Signal] Error handling signal:', err)
    }
  }

  function handlePartnerLeft() {
    console.log('[Partner] Left')
    const shouldKeepSearching = pendingStartRef.current
    updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
    resetSessionUi()

    if (shouldKeepSearching && socketRef.current?.connected) {
      showActionFeedback('Searching for the next match...')
      joinQueue()
      return
    }

    setConnectionState('idle')
    showActionFeedback('Partner left the chat')
  }

  function handleReceiveMessage(data) {
    const newMsg = {
      id: data.id,
      text: data.text,
      fromLang: data.fromLang,
      timestamp: data.timestamp,
      isMine: false,
      translatedText: null,
      isTranslating: false,
    }
    setMessages(prev => [...prev.slice(-MAX_CHAT_MESSAGES + 1), newMsg])
    setIsPartnerTyping(false)

    if (!showChat) {
      setUnreadCount(c => c + 1)
    }

  }

  function handleTranslationReady(data) {
    setPartnerCaption({
      text: data.text,
      originalText: data.originalText,
      fromLang: data.fromLang,
    })
    // Clear caption after 6 seconds
    if (captionTimeoutRef.current) clearTimeout(captionTimeoutRef.current)
    captionTimeoutRef.current = setTimeout(() => setPartnerCaption(null), 6000)
  }

  // =================== WEBRTC ===================
  function initPeerConnection(isInitiator, peerId) {
    cleanupPeerConnection()

    const pc = new RTCPeerConnection(buildRtcConfig(turnIceServers))
    pcRef.current = pc

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current)
      })
    }

    // Handle remote stream
    const remoteStream = new MediaStream()
    remoteStreamRef.current = remoteStream

    pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track:', event.track.kind)
      event.streams[0]?.getTracks().forEach(track => {
        remoteStream.addTrack(track)
      })
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
      }
    }

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('signal', {
          type: 'ice-candidate',
          to: peerId,
          payload: event.candidate.toJSON(),
        })
      }
    }

    // Connection state
    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] State:', pc.connectionState)
      if (pc.connectionState === 'connected') {
        setConnectionState('connected')
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        // Don't immediately reset - might be temporary
        setTimeout(() => {
          if (pcRef.current?.connectionState === 'failed') {
            cleanupPeerConnection()
            if (pendingStartRef.current && socketRef.current?.connected) {
              resetSessionUi()
              showActionFeedback('Connection ended · finding next')
              joinQueue()
            } else {
              setConnectionState('idle')
              showActionFeedback('Connection ended')
            }
          }
        }, 3000)
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', pc.iceConnectionState)
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setConnectionState('connected')
      }
    }

    // Create offer if initiator
    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          socketRef.current?.emit('signal', {
            type: 'offer',
            to: peerId,
            payload: offer,
          })
        } catch (err) {
          console.error('[WebRTC] Offer error:', err)
        }
      }
    }
  }

  function cleanupPeerConnection() {
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    remoteStreamRef.current = null
  }

  // =================== TRANSLATION ===================
  async function translateText(text, fromLang, toLang) {
    if (!text?.trim() || fromLang === toLang) return text

    const cacheKey = `${text}|${fromLang}|${toLang}`
    if (translationCacheRef.current.has(cacheKey)) {
      return translationCacheRef.current.get(cacheKey)
    }

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: fromLang, to: toLang }),
      })
      const data = await res.json()
      const result = data.translatedText || text
      translationCacheRef.current.set(cacheKey, result)

      // Keep cache size manageable
      if (translationCacheRef.current.size > 50) {
        const firstKey = translationCacheRef.current.keys().next().value
        translationCacheRef.current.delete(firstKey)
      }

      return result
    } catch (e) {
      console.error('[Translation] Error:', e)
      return text
    }
  }

  async function flushPendingTranscript() {
    const fullText = pendingTextRef.current.trim()
    pendingTextRef.current = ''
    if (!fullText) return

    // Avoid duplicate bursts from recognizer repeats
    if (fullText === lastSentCaptionRef.current) return

    const fromLang = primaryLanguageRef.current?.googleCode
    const toLang = partnerLanguageRef.current?.googleCode
    if (!fromLang || !toLang || !socketRef.current) return

    const translated = await translateText(fullText, fromLang, toLang)

    socketRef.current?.emit('translation-ready', {
      text: translated,
      originalText: fullText,
      fromLang,
      toLang,
    })

    lastSentCaptionRef.current = fullText
  }

  function handleFinalTranscript(text) {
    if (!text?.trim() || !partnerLanguageRef.current || !socketRef.current) return

    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) return

    pendingTextRef.current = `${pendingTextRef.current} ${cleaned}`.trim()

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    const shouldFlushNow = /[.!?।]$/.test(cleaned) || cleaned.split(' ').length >= 12

    if (shouldFlushNow) {
      flushPendingTranscript()
      return
    }

    debounceTimerRef.current = setTimeout(() => {
      flushPendingTranscript()
    }, CAPTION_DEBOUNCE_MS)
  }

  function toggleCaptions() {
    if (!CAPTIONS_UI_ENABLED) return
    setCaptionsVisible(prev => {
      const next = !prev
      try {
        localStorage.setItem('omingle_captions_enabled', String(next))
      } catch (e) {}

      if (!next) {
        setPartnerCaption(null)
        setMyTranscript('')
        pendingTextRef.current = ''
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      }

      if (next) setCaptionEngineError(null)

      return next
    })
  }

  function handleLikePartner() {
    if (!socketRef.current || !partnerIdRef.current || hasLikedPartner) return
    socketRef.current.emit('like-partner')
  }

  function openReportModal({ targetUserId = null, roomId = null, isCurrent = true } = {}) {
    setReportContext({ targetUserId, roomId, isCurrent })
    setReportModalOpen(true)
  }

  function handleReportPartner() {
    if (!socketRef.current) return
    if (reportContext.isCurrent && (!partnerIdRef.current || hasReportedPartner)) return
    if (reportContext.isCurrent) {
      setHasReportedPartner(true)
    }
    socketRef.current.emit('report-partner', {
      reason: reportReason,
      details: reportDetails,
      targetUserId: reportContext.targetUserId,
      roomId: reportContext.roomId,
    })
    setReportModalOpen(false)
    setReportDetails('')
    setReportContext({ targetUserId: null, roomId: null, isCurrent: true })
  }

  function resetSessionUi({ clearMessages = true } = {}) {
    cleanupPeerConnection()
    setPartnerId(null)
    setPartnerLanguage(null)
    setPartnerCountry(null)
    setPartnerUserId(null)
    setPartnerProfile(null)
    setPartnerLikes(0)
    setRoomId(null)
    setPartnerCaption(null)
    setCommonLanguagesNotice('')
    setHasAddedFriendForCurrentMatch(false)
    setShowFriendsPanel(false)
    setMyTranscript('')
    setIsPartnerTyping(false)
    setHasLikedPartner(false)
    setHasReportedPartner(false)
    setActionFeedback(null)
    setReportModalOpen(false)
    setFriendInviteRequest(null)
    setPendingInviteRequestId(null)
    setMatchedInterests([])
    setCallDuration(0)
    setUnreadCount(0)
    if (clearMessages) setMessages([])
    pendingTextRef.current = ''
    lastSentCaptionRef.current = ''
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    if (captionTimeoutRef.current) clearTimeout(captionTimeoutRef.current)
    if (commonLanguagesTimeoutRef.current) clearTimeout(commonLanguagesTimeoutRef.current)
  }

  function handleStartSearch() {
    if (!sessionUser?.id) {
      router.replace('/')
      return
    }
    if (mode === 'video' && !hasCameraPermission) {
      setMediaWarning('Camera access is required before you can start video chat.')
      return
    }
    pendingStartRef.current = true
    setMobilePane('video')
    resetSessionUi()
    if (socketRef.current?.connected) {
      joinQueue()
    } else {
      setConnectionState('waiting')
    }
  }

  function handleStopSearch() {
    pendingStartRef.current = false
    if (socketRef.current?.connected) {
      if (connectionState === 'waiting') {
        socketRef.current.emit('leave-queue')
      } else if (connectionState === 'connecting' || connectionState === 'connected') {
        socketRef.current.emit('next', { reason: 'stop' })
      }
    }
    resetSessionUi()
    setConnectionState('idle')
  }

  // =================== ACTIONS ===================
  function handleSendMessage() {
    const canSendNow = connectionState === 'connected' && !!roomIdRef.current && !!partnerIdRef.current
    if (!canSendNow || !messageInput.trim() || !socketRef.current) return

    const msg = {
      id: generateId(),
      text: messageInput.trim(),
      fromLang: primaryLanguage.googleCode,
      timestamp: new Date().toISOString(),
      isMine: true,
      translatedText: null,
      isTranslating: false,
    }
    setMessages(prev => [...prev.slice(-MAX_CHAT_MESSAGES + 1), msg])
    socketRef.current.emit('send-message', {
      roomId: roomIdRef.current,
      message: messageInput.trim(),
      fromLang: primaryLanguage.googleCode,
    })
    socketRef.current.emit('stop-typing')
    setMessageInput('')
  }

  function handleNext() {
    if (!sessionUser?.id) return
    const proceedWithSkip = () => {
      pendingStartRef.current = true
      updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
      socketRef.current?.emit('next', { reason: 'skip' })
      resetSessionUi()
      if (socketRef.current?.connected) {
        joinQueue()
      } else {
        setConnectionState('waiting')
      }
    }

    fetch('/api/ad-engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip-attempt' }),
    })
      .then((res) => res.json())
      .then((data) => {
        const skipCount = Number(data?.skipCount || 0)
        setAdEngagement({
          skipCount,
          shouldGateOnNextSkip: skipCount >= 9,
        })
        if (data?.shouldGate) {
          openAdGate('skip', proceedWithSkip)
          return
        }
        proceedWithSkip()
      })
      .catch(() => {
        proceedWithSkip()
      })
  }

  function handleEnd() {
    pendingStartRef.current = false
    updateCurrentHistoryEntry({ endedAt: new Date().toISOString() })
    socketRef.current?.emit('next', { reason: 'end' })
    cleanupPeerConnection()
    stopRecognitionEngine()
    stopBackgroundBlurProcessing()
    pendingTextRef.current = ''
    lastSentCaptionRef.current = ''
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    if (commonLanguagesTimeoutRef.current) clearTimeout(commonLanguagesTimeoutRef.current)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
    }
    router.push('/')
  }

  function toggleMute() {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setIsMuted(!audioTrack.enabled)
      }
    }
  }

  function toggleCamera() {
    if (localStreamRef.current && mode === 'video') {
      const videoTrack = localStreamRef.current.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setIsCameraOff(!videoTrack.enabled)
      }
    }
  }

  function handleInputChange(e) {
    setMessageInput(e.target.value)
    const canSendNow = connectionState === 'connected' && !!roomIdRef.current && !!partnerIdRef.current
    if (!canSendNow) return
    if (e.target.value.length > 0) {
      socketRef.current?.emit('typing')
    } else {
      socketRef.current?.emit('stop-typing')
    }
  }

  function handleChatScroll() {
    const container = chatScrollRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom < 80
  }

  // Auto-scroll chat only when user is near the bottom.
  useEffect(() => {
    const container = chatScrollRef.current
    if (!container || !shouldAutoScrollRef.current) return
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [messages, isPartnerTyping])

  function buildChatUrl(nextMode) {
    const others = additionalLanguages.map(lang => lang.code).join(',')
    return `/chat?mode=${nextMode}&lang=${primaryLanguage.code}${others ? `&others=${others}` : ''}`
  }

  function performModeSwitch(nextMode) {
    setShowChat(false)
    setMobilePane('video')
    setPanelTab(null)
    pendingStartRef.current = false
    socketRef.current?.emit('next', { reason: 'mode-switch' })
    router.push(buildChatUrl(nextMode))
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return
    if (isSearching || isConnected) {
      setModeSwitchConfirm({ nextMode })
      return
    }
    performModeSwitch(nextMode)
  }

  function openPanel(tab) {
    setShowChat(false)
    setPanelTab(prev => {
      const next = prev === tab ? null : tab
      setMobilePane(next || 'video')
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

  const activeHistoryFriendEntries = useMemo(() => {
    return interactionHistory.map(item => {
      const targetUserId = item.partnerUserId || item.friendAnonId || null
      const onlineFriend = targetUserId ? friends.find(friend => (friend.friendUserId || friend.friendAnonId) === targetUserId) : null
      return { ...item, onlineFriend }
    })
  }, [interactionHistory, friends])

  const primaryActionIsStop = isSearching || isConnected
  const hasActiveMatch = !!roomId && !!partnerId && (connectionState === 'connected' || connectionState === 'connecting')
  const canSendMessages = connectionState === 'connected' && !!roomId && !!partnerId
  const showMobileCenterPane = !showChat && !!panelTab && (mobilePane === 'history' || mobilePane === 'friends')
  const currentPartnerAlreadyFriend = partnerUserId ? friendIds.has(partnerUserId) : false
  const currentPartnerRequestPending = partnerUserId ? outgoingRequestIds.has(partnerUserId) : false
  const currentPartnerHasIncomingRequest = partnerUserId ? incomingRequestIds.has(partnerUserId) : false

  if (!sessionResolved) {
    return <ChatPageFallback />
  }

  if (!sessionUser) {
    return null
  }

  // =================== ERROR STATE ===================
  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <X className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">Connection Error</h2>
          <p className="text-gray-400 mb-6">{error}</p>
          <button onClick={() => router.push('/')} className="px-6 py-3 bg-violet-600 hover:bg-violet-500 rounded-xl font-medium transition-all">
            Go Home
          </button>
        </div>
      </div>
    )
  }

  // =================== UNIFIED CHAT LAYOUT ===================
  return (
    <div className="h-[100dvh] min-h-[100dvh] bg-gray-950 flex flex-col overflow-hidden">
      <div className="relative z-30 overflow-visible border-b border-gray-800 bg-gray-900/95 backdrop-blur px-3 sm:px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => router.push('/')} className="flex items-center">
            <img src="/logo.svg" alt="HippiChat" className="h-9 sm:h-11 lg:h-12 w-auto" />
          </button>

          <div className="flex items-center justify-end gap-2 min-w-[44px]">
            <>
              <div className="flex shrink-0 rounded-full border border-gray-800/60 bg-gray-900/85 px-2.5 py-1 text-[11px] text-gray-300 sm:hidden">
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  {displayOnlineCount !== null ? formatOnlineCount(displayOnlineCount) : '...'}
                </span>
              </div>
              <div className="hidden sm:flex rounded-full border border-gray-800/60 bg-gray-900/85 px-3 py-1.5 text-xs text-gray-300">
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <Users className="w-3.5 h-3.5 text-gray-400" />
                Online {displayOnlineCount !== null ? formatOnlineCount(displayOnlineCount) : '...'}
              </span>
              </div>
            </>
            <GoogleAuthButton
              compact
              onOpenSettings={() => setSettingsOpen(true)}
              onLogoutSuccess={() => router.replace('/')}
              userOverride={sessionUser}
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1 sm:justify-center sm:gap-2 overflow-x-auto no-scrollbar text-xs sm:text-sm font-medium text-gray-300">
          <button
            onClick={() => switchMode('video')}
            className={`rounded-full px-3 py-1.5 whitespace-nowrap transition-all ${mode === 'video' ? 'bg-white text-gray-900' : 'hover:bg-gray-800'}`}
          >
            Video Chat
          </button>
          <button
            onClick={() => switchMode('voice')}
            className={`rounded-full px-3 py-1.5 whitespace-nowrap transition-all ${mode === 'voice' ? 'bg-white text-gray-900' : 'hover:bg-gray-800'}`}
          >
            Voice Chat
          </button>
          <button
            onClick={() => openPanel('history')}
            className={`rounded-full px-3 py-1.5 whitespace-nowrap transition-all ${panelTab === 'history' ? 'bg-violet-600 text-white' : 'hover:bg-gray-800'}`}
          >
            History
          </button>
          <button
            onClick={() => openPanel('friends')}
            className={`relative rounded-full px-3 py-1.5 whitespace-nowrap transition-all ${panelTab === 'friends' ? 'bg-violet-600 text-white' : 'hover:bg-gray-800'}`}
          >
            Friends
            {incomingRequestsCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-400 px-1 text-[10px] font-bold text-gray-900">
                {incomingRequestsCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <ProfileSettingsModal
        open={settingsOpen}
        user={sessionUser}
        onClose={() => setSettingsOpen(false)}
        onSaved={(user) => {
          setSessionUser(user)
          socketRef.current?.emit('update-profile', {
            name: user?.name,
            customImage: user?.customImage || '',
          })
          const primary = user?.primaryLanguage || primaryLanguage
          const additional = Array.isArray(user?.additionalLanguages) ? user.additionalLanguages : additionalLanguages
          const others = additional.map((lang) => lang.code).filter(Boolean).join(',')
          if (primary?.code) {
            router.replace(`/chat?mode=${mode}&lang=${primary.code}${others ? `&others=${others}` : ''}`)
          }
        }}
      />

      {showPreferences && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Preferences</h3>
              <button onClick={() => setShowPreferences(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-sm text-gray-300">
              <div className="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Interest keywords</p>
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={interestInput}
                    onChange={(event) => setInterestInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addInterestKeyword()
                      }
                    }}
                    placeholder="e.g. gaming, music, anime"
                    className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                  />
                  <button
                    onClick={addInterestKeyword}
                    className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500"
                  >
                    Add
                  </button>
                </div>

                {interestKeywords.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {interestKeywords.map((keyword) => (
                      <button
                        key={keyword}
                        onClick={() => removeInterestKeyword(keyword)}
                        className="rounded-full border border-violet-500/30 bg-violet-600/10 px-3 py-1 text-xs text-violet-100 hover:bg-violet-600/20"
                      >
                        #{keyword} ×
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">
                    We first try to match people with overlapping interests, then quickly fall back to the next available user.
                  </p>
                )}
              </div>
              <div className="rounded-xl border border-gray-800 bg-gray-800/40 p-3 text-gray-400 text-xs">
                Filters apply to your next search. Shared interests are preferred, but we still fall back quickly to keep wait times low.
              </div>
            </div>
          </div>
        </div>
      )}

      {adGateOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Sponsored Break</h3>
            <p className="mt-2 text-sm text-gray-400">
              {adGateReason === 'skip'
                ? `You reached the 10-skip limit (current: ${adEngagement.skipCount}). View this sponsored step to continue.`
                : adGateReason === 'add-friend'
                  ? 'View this sponsored step before sending a friend request.'
                  : 'View this sponsored step before applying filters.'}
            </p>
            <button
              type="button"
              onClick={() => {
                const opened = window.open(DIRECT_LINK_URL, '_blank', 'noopener,noreferrer')
                if (opened) {
                  setAdGateSponsorClicked(true)
                }
              }}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/15 px-4 py-2.5 text-sm font-medium text-violet-200 hover:bg-violet-500/25"
            >
              Open Sponsor <ExternalLink className="h-4 w-4" />
            </button>
            <p className="mt-3 text-xs text-gray-500">
              {adGateSponsorClicked
                ? 'Sponsor link opened. You can continue now.'
                : 'Open the sponsor link, then continue.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeAdGate}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleAdGateContinue}
                disabled={adGateLoading || !adGateNonce}
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {adGateLoading ? 'Loading...' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reportModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Report this user</h3>
              <button onClick={() => setReportModalOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 mb-4">
              {REPORT_REASONS.map((reason) => (
                <button
                  key={reason.value}
                  onClick={() => setReportReason(reason.value)}
                  className={`w-full rounded-xl border px-4 py-3 text-left text-sm transition-all ${reportReason === reason.value
                    ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
                    : 'border-gray-800 bg-gray-800/40 text-gray-300 hover:bg-gray-800'}`}
                >
                  {reason.label}
                </button>
              ))}
            </div>

            <textarea
              value={reportDetails}
              onChange={(event) => setReportDetails(event.target.value)}
              placeholder="Optional details"
              className="mb-4 min-h-24 w-full rounded-xl border border-gray-800 bg-gray-800/40 px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setReportModalOpen(false)}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => handleReportPartner()}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-amber-400"
              >
                Submit report
              </button>
            </div>
          </div>
        </div>
      )}

      {accountBlockedInfo?.blockedUntil && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-red-500/20 bg-gray-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-2">Account temporarily restricted</h3>
            <p className="text-sm text-gray-300 mb-4">
              {accountBlockedInfo.message || `You cannot start new matches until ${new Date(accountBlockedInfo.blockedUntil).toLocaleString()}.`}
            </p>
            <button
              onClick={() => setAccountBlockedInfo(null)}
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
            >
              Okay
            </button>
          </div>
        </div>
      )}

      {modeSwitchConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-amber-500/10 p-2 text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Switch chat mode?</h3>
                <p className="mt-1 text-sm text-gray-400">
                  Switching to {modeSwitchConfirm.nextMode === 'video' ? 'Video Chat' : 'Voice Chat'} will end your current conversation/search and disconnect the current stranger. Do you want to continue?
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setModeSwitchConfirm(null)}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const nextMode = modeSwitchConfirm?.nextMode
                  setModeSwitchConfirm(null)
                  if (nextMode) performModeSwitch(nextMode)
                }}
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex relative overflow-hidden flex-col sm:flex-row min-h-0">
        {/* Video / Voice Panel */}
        <div className={`flex-1 relative ${showChat ? 'hidden sm:block' : showMobileCenterPane ? 'hidden sm:block' : ''}`}>
          {mode === 'video' ? (
            <div className="flex h-full flex-col gap-3 p-3 sm:p-4 pb-2 sm:pb-4">
              <div className="grid flex-1 min-h-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex min-h-0 flex-col gap-3">
                  <div className="relative w-full rounded-2xl border border-gray-800 bg-gray-900/60 p-2 sm:p-3 overflow-hidden">
                    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.05)]">
                      <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        className="w-full h-full object-contain bg-black"
                      />
                  <img
                    src="/logo.svg"
                    alt="HippiChat watermark"
                    className="pointer-events-none absolute bottom-3 right-3 h-8 w-auto select-none opacity-20 grayscale brightness-[2.4]"
                  />

                      {connectionState !== 'connected' && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900/95 via-gray-900/95 to-gray-950/95 px-6 text-center">
                          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-violet-500/20 bg-violet-500/10">
                            {isSearching ? (
                              <Loader2 className="h-7 w-7 animate-spin text-violet-400" />
                            ) : (
                              <Users className="h-7 w-7 text-violet-300" />
                            )}
                          </div>
                          <h3 className="text-lg font-semibold text-white">{getRemotePanelTitle()}</h3>
                          <p className="mt-2 max-w-md text-sm text-gray-400">{getRemotePanelSubtitle()}</p>
                          <div className="mt-5 rounded-full border border-gray-800 bg-gray-950/70 px-3 py-1 text-[11px] text-gray-400">
                            {mode === 'video' ? 'Video chat' : 'Voice chat'} · {selfCountry?.countryFlag || '🌐'} {selfCountry?.countryName || 'Unknown'}
                          </div>
                          {connectionState === 'waiting' && (
                            <GoogleSponsoredAd
                              label="Sponsored"
                              className="mt-5 w-full max-w-sm"
                              minHeightClassName="min-h-[150px]"
                            />
                          )}
                          {mediaWarning && (
                            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 max-w-sm">
                              {mediaWarning}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {connectionState === 'connected' && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={handleLikePartner}
                        disabled={hasLikedPartner}
                        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/15 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ThumbsUp className="h-4 w-4" /> {hasLikedPartner ? 'Liked' : 'Like'}
                      </button>
                      <button
                        onClick={() => openReportModal()}
                        disabled={hasReportedPartner}
                        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/15 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Flag className="h-4 w-4" /> {hasReportedPartner ? 'Reported' : 'Report'}
                      </button>
                    </div>
                  )}

                </div>

                <div className="flex min-h-0 flex-col gap-3">
                  <div className="relative w-full rounded-2xl border border-gray-800 bg-gray-900/60 p-2 sm:p-3 overflow-hidden">
                    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.05)]">
                      <canvas ref={blurCanvasRef} className="hidden" />
                      <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-full object-contain mirror bg-black"
                        style={{ transform: 'scaleX(-1)' }}
                      />
                      <img
                        src="/logo.svg"
                        alt="HippiChat watermark"
                        className="pointer-events-none absolute bottom-3 right-3 h-8 w-auto select-none opacity-20 grayscale brightness-[2.4]"
                      />
                      {isCameraOff && (
                        <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
                          <VideoOff className="w-6 h-6 text-gray-500" />
                        </div>
                      )}
                      {!localStreamRef.current && (
                        <div className="absolute inset-0 bg-gray-900/90 flex items-center justify-center text-xs text-gray-400">
                          Preview unavailable
                        </div>
                      )}
                    </div>
                    <div className="absolute left-5 bottom-5 text-xs px-2.5 py-1 rounded-full bg-black/50 backdrop-blur border border-white/10">
                      You · {selfCountry?.countryFlag || '🌐'} {selfCountry?.countryName || 'Unknown'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="hidden sm:flex justify-center pt-1">
                <ControlButtons
                  desktop
                  primaryActionIsStop={primaryActionIsStop}
                  isMediaReady={isMediaReady}
                  onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
                  onSkip={handleNext}
                  onFilters={handleOpenFilters}
                  connectionState={hasActiveMatch ? connectionState : 'idle'}
                />
              </div>
            </div>
          ) : (
            /* Voice mode visualization */
            <div className="w-full h-full min-h-0 flex flex-col bg-gradient-to-b from-gray-900 to-gray-950 px-4">
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
                <div className="w-24 h-24 rounded-full bg-violet-600/20 border-2 border-violet-500/30 flex items-center justify-center mb-4">
                  <Volume2 className="w-10 h-10 text-violet-400" />
                </div>
                {partnerDisplayCountry && (
                  <div className="text-center">
                    <span className="text-3xl">{partnerDisplayCountry.countryFlag}</span>
                    <p className="text-lg font-medium mt-2">{partnerDisplayCountry.countryName}</p>
                    <p className="text-sm text-gray-500">Stranger</p>
                  </div>
                )}
                <div className="flex items-end gap-1 mt-6 h-12">
                  {[1,2,3,4,5,6,7].map(i => (
                    <div key={i} className="w-1.5 bg-violet-500/60 rounded-full"
                      style={{
                        height: connectionState === 'connected' ? `${12 + Math.random() * 28}px` : '4px',
                        animation: connectionState === 'connected' ? `wave ${0.5 + i * 0.1}s ease-in-out infinite alternate` : 'none',
                      }} />
                  ))}
                </div>
                {connectionState === 'waiting' && (
                  <GoogleSponsoredAd
                    label="Sponsored"
                    className="mt-8 w-full max-w-sm px-4"
                    minHeightClassName="min-h-[150px]"
                  />
                )}
              </div>
              <div className="hidden sm:flex justify-center w-full pb-4 pt-2 shrink-0">
                <ControlButtons
                  desktop
                  primaryActionIsStop={primaryActionIsStop}
                  isMediaReady={isMediaReady}
                  onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
                  onSkip={handleNext}
                  onFilters={handleOpenFilters}
                  connectionState={hasActiveMatch ? connectionState : 'idle'}
                />
              </div>
              {/* Hidden audio element for remote stream */}
              <audio ref={remoteVideoRef} autoPlay className="hidden" />
            </div>
          )}

          {/* Connection overlay */}
          {connectionState === 'connecting' && mode !== 'video' && (
            <div className="absolute inset-0 bg-gray-950/80 backdrop-blur-sm flex items-center justify-center z-20">
              <div className="text-center">
                <Loader2 className="w-10 h-10 text-violet-400 animate-spin mx-auto mb-3" />
                <p className="text-lg font-medium">Connecting...</p>
                {partnerDisplayCountry && (
                  <p className="text-sm text-gray-400 mt-1">
                    {partnerDisplayCountry.countryFlag} {partnerDisplayCountry.countryName}
                  </p>
                )}
              </div>
            </div>
          )}

          {connectionNotice && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 rounded-full border border-gray-700 bg-gray-900/90 px-4 py-2 text-xs text-gray-200 backdrop-blur">
              {connectionNotice}
            </div>
          )}

          {/* Partner country badge */}
          {partnerDisplayCountry && connectionState === 'connected' && (
            <div className="absolute left-4 top-4 flex items-center gap-2 rounded-lg bg-gray-900/80 px-3 py-1.5 backdrop-blur z-10">
              <span className="text-sm">{partnerDisplayCountry.countryFlag}</span>
              <span className="text-xs font-medium">{partnerDisplayCountry.countryName}</span>
              <span className="ml-1 flex items-center gap-1 text-xs text-emerald-300">
                <ThumbsUp className="h-3 w-3" /> {partnerLikes}
              </span>
            </div>
          )}

          {matchedInterests.length > 0 && connectionState === 'connected' && (
            <div className={`absolute top-28 left-4 z-10 flex flex-wrap gap-2 max-w-[70%] transition-opacity duration-500 ${matchedInterestsVisible ? 'opacity-100' : 'opacity-0'}`}>
              {matchedInterests.map((interest) => (
                <span key={interest} className="rounded-full border border-violet-400/20 bg-violet-500/15 px-2.5 py-1 text-[11px] text-violet-100 backdrop-blur">
                  #{interest}
                </span>
              ))}
            </div>
          )}

        </div>

        <div className={`${showChat ? 'hidden' : showMobileCenterPane ? 'flex' : 'hidden'} ${panelTab ? 'sm:flex' : 'sm:hidden'} w-full sm:w-72 lg:w-80 min-h-0 flex-col border-t sm:border-t-0 sm:border-l border-gray-800 bg-gray-900/70 backdrop-blur`}>
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <span className="text-sm font-medium">{panelTab === 'history' ? 'History' : 'Friends'}</span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
            {panelTab === 'history' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500">Interacted users</p>
                  <span className="text-[11px] text-gray-500">{activeHistoryFriendEntries.length}</span>
                </div>
                {activeHistoryFriendEntries.length === 0 ? (
                  <div className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3 text-xs text-gray-500">
                    Your recent stranger history will appear here.
                  </div>
                ) : (
                  activeHistoryFriendEntries.map(item => {
                    const displayName = item.partnerName || item.displayName || `User ${String(item.partnerUserId || item.id).slice(-4)}`
                    const targetUserId = item.partnerUserId || null
                    const incomingRequest = friendRequests.incoming.find(request => request.requesterId === targetUserId)
                    const alreadyFriend = targetUserId ? friendIds.has(targetUserId) : false
                    const pendingOutgoing = targetUserId ? outgoingRequestIds.has(targetUserId) : false
                    const pendingIncoming = targetUserId ? incomingRequestIds.has(targetUserId) : false
                    return (
                      <div key={item.id} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            {item.partnerImage ? (
                              <img src={item.partnerImage} alt={displayName} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">
                                {displayName.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-white">{displayName}</p>
                              <p className="truncate text-[11px] text-gray-400">
                                {item.countryFlag || '🌐'} {item.countryName || 'Unknown'}
                              </p>
                            </div>
                          </div>
                          <span className="text-[10px] text-gray-500 uppercase">{item.mode}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">
                          {item.connectedAt ? new Date(item.connectedAt).toLocaleString() : 'Recently'}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {pendingIncoming ? (
                            <>
                              <button
                                onClick={() => handleAcceptFriendRequest(incomingRequest?.requestId)}
                                disabled={!incomingRequest?.requestId}
                                className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                              >
                                Accept Request
                              </button>
                              <button
                                onClick={() => handleRejectFriendRequest(incomingRequest?.requestId)}
                                disabled={!incomingRequest?.requestId}
                                className="rounded-md border border-gray-700 px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                              >
                                Reject
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleAddFriend(targetUserId)}
                              disabled={!targetUserId || alreadyFriend || pendingOutgoing}
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-600/20 border border-emerald-500/30 px-2 py-1 text-[11px] font-medium text-emerald-200 disabled:opacity-40"
                            >
                              <UserPlus className="h-3 w-3" />
                              {alreadyFriend ? 'Friend Added' : pendingOutgoing ? 'Request Sent' : 'Add Friend'}
                            </button>
                          )}
                          <button
                            onClick={() => openReportModal({ targetUserId, roomId: item.roomId || null, isCurrent: false })}
                            disabled={!targetUserId}
                            className="inline-flex items-center gap-1 rounded-md bg-amber-600/20 border border-amber-500/30 px-2 py-1 text-[11px] font-medium text-amber-200 disabled:opacity-40"
                          >
                            <Flag className="h-3 w-3" /> Report
                          </button>
                          {item.onlineFriend?.online && (
                            <button
                              onClick={() => handleConnectFriend(item.onlineFriend.friendAnonId)}
                              className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500"
                            >
                              Chat Again
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Friends</p>
                    <span className="text-[11px] text-gray-500">{sortedFriends.length}</span>
                  </div>
                  {sortedFriends.length === 0 ? (
                    <div className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3 text-xs text-gray-500">
                      Added friends will appear here.
                    </div>
                  ) : (
                    sortedFriends.map(friend => (
                      <div key={friend.friendUserId || friend.friendAnonId} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3">
                        <div className="flex items-center gap-3">
                          {friend.image ? (
                            <img src={friend.image} alt={friend.name || 'Friend'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">
                              {(friend.name || 'U').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-white">{friend.name || `User ${String(friend.friendUserId || friend.friendAnonId).slice(-4)}`}</p>
                            <p className="truncate text-[11px] text-gray-400">{friend.countryFlag || '🌐'} {friend.countryName || 'Unknown'}</p>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className={`text-[11px] ${friend.online ? 'text-green-300' : 'text-gray-500'}`}>
                            {friend.online ? 'Online' : 'Offline'}
                          </span>
                          <button
                            onClick={() => handleConnectFriend(friend.friendUserId || friend.friendAnonId)}
                            disabled={!friend.online || !!pendingInviteRequestId}
                            className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500"
                          >
                            {pendingInviteRequestId ? 'Pending' : 'Invite'}
                          </button>
                        </div>
                        <button
                          onClick={() => openUnfriendConfirmation(friend)}
                          className="mt-2 rounded-md border border-red-500/20 px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/10"
                        >
                          Unfriend
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="space-y-2 border-t border-gray-800 pt-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Requests</p>
                    <span className="text-[11px] text-gray-500">{(friendRequests.incoming?.length || 0) + (friendRequests.outgoing?.length || 0)}</span>
                  </div>

                  {friendRequests.incoming?.map((request) => (
                    <div key={request.requestId} className="rounded-xl border border-gray-800 bg-gray-800/50 px-3 py-3 space-y-2">
                      <div className="flex items-center gap-3">
                        {request.profile?.image ? (
                          <img src={request.profile.image} alt={request.profile?.name || 'Request'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">
                            {(request.profile?.name || 'U').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-white">{request.profile?.name || `User ${String(request.requesterId).slice(-4)}`}</p>
                          <p className="truncate text-[11px] text-gray-400">{request.profile?.countryFlag || '🌐'} {request.profile?.countryName || 'Unknown'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleAcceptFriendRequest(request.requestId)}
                          className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleRejectFriendRequest(request.requestId)}
                          className="rounded-md border border-gray-700 px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}

                  {friendRequests.outgoing?.map((request) => (
                    <div key={request.requestId} className="rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-3">
                      <div className="flex items-center gap-3">
                        {request.profile?.image ? (
                          <img src={request.profile.image} alt={request.profile?.name || 'Outgoing request'} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-sm font-semibold text-white">
                            {(request.profile?.name || 'U').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-white">{request.profile?.name || `User ${String(request.recipientId).slice(-4)}`}</p>
                          <p className="truncate text-[11px] text-gray-400">{request.profile?.countryFlag || '🌐'} {request.profile?.countryName || 'Unknown'}</p>
                        </div>
                        <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200">
                          Pending
                        </span>
                      </div>
                    </div>
                  ))}

                  {!friendRequests.incoming?.length && !friendRequests.outgoing?.length && (
                    <div className="rounded-xl border border-gray-800 bg-gray-800/30 px-3 py-3 text-xs text-gray-500">
                      No pending requests right now.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>


      {friendInviteRequest?.inviteId && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-2">Friend invite</h3>
            <p className="text-sm text-gray-300 mb-4">
              {friendInviteRequest.profile?.name || 'Your friend'} wants to connect with you on {friendInviteRequest.mode === 'voice' ? 'voice chat' : 'video chat'}.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => respondToFriendInvite(false)}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Decline
              </button>
              <button
                onClick={() => respondToFriendInvite(true)}
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {unfriendTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-2">
              {unfriendConfirmStep === 1 ? 'Remove friend?' : 'Are you absolutely sure?'}
            </h3>
            <p className="text-sm text-gray-300 mb-4">
              {unfriendConfirmStep === 1
                ? `This will remove ${unfriendTarget.name || 'this friend'} from your friends list.`
                : 'This action cannot be undone from chat history automatically.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={closeUnfriendConfirmation}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              {unfriendConfirmStep === 1 ? (
                <button
                  onClick={() => setUnfriendConfirmStep(2)}
                  className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400"
                >
                  Continue
                </button>
              ) : (
                <button
                  onClick={() => handleUnfriend(unfriendTarget)}
                  className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
                >
                  Unfriend
                </button>
              )}
            </div>
          </div>
        </div>
      )}
        {/* Text Chat Sidebar */}
        <div className={`${showChat ? 'w-full sm:w-80 lg:w-96' : 'hidden sm:block sm:w-80 lg:w-96'} flex h-full min-h-0 flex-col overflow-hidden bg-gray-900 border-l border-gray-800`}>
          {/* Chat header */}
          <div className="sticky top-0 z-10 px-4 py-3 border-b border-gray-800 bg-gray-900 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-gray-400" />
              <span className="text-sm font-medium">Text Chat</span>
            </div>
            <button onClick={() => { setShowChat(false); setUnreadCount(0) }} className="sm:hidden text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-3 pb-5 space-y-3"
          >
            {messages.length === 0 && (
              <div className="text-center text-gray-500 text-sm mt-8">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>{canSendMessages ? 'Send a message to start chatting!' : 'Match with someone to start chatting.'}</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.isMine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 ${msg.isMine
                  ? 'bg-violet-600 text-white rounded-br-sm'
                  : 'bg-gray-800 text-gray-200 rounded-bl-sm'}`}>
                  <p className="text-sm">{msg.text}</p>
                  <p className={`text-[10px] mt-1 ${msg.isMine ? 'text-violet-300' : 'text-gray-500'}`}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
            {isPartnerTyping && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-3.5 py-2.5 flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-1" />
                  <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-2" />
                  <div className="w-2 h-2 rounded-full bg-gray-500 bounce-dot-3" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="sticky bottom-0 mt-auto border-t border-gray-800 bg-gray-900 px-3 py-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={messageInput}
                onChange={handleInputChange}
                onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                placeholder={canSendMessages ? 'Type a message...' : 'Match with someone to chat'}
                disabled={!canSendMessages}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
              />
              <button
                onClick={handleSendMessage}
                disabled={!canSendMessages || !messageInput.trim()}
                className="p-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl transition-all"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Control Bar */}
      <div className="sticky bottom-0 z-20 bg-gray-900 border-t border-gray-800 px-3 py-4 sm:hidden">
        <ControlButtons
          primaryActionIsStop={primaryActionIsStop}
          isMediaReady={isMediaReady}
          onPrimary={primaryActionIsStop ? handleStopSearch : handleStartSearch}
          onSkip={handleNext}
          onFilters={handleOpenFilters}
          connectionState={hasActiveMatch ? connectionState : 'idle'}
        />

        <button
          onClick={() => { setShowChat(!showChat); setUnreadCount(0) }}
          className={`${showChat ? 'hidden' : 'sm:hidden absolute right-4 -top-14 inline-flex h-11 min-w-[96px] items-center justify-center gap-1 rounded-full bg-violet-600 px-3 text-xs font-semibold text-white shadow-lg shadow-black/30 hover:bg-violet-500'}`}
          aria-label="Toggle chat"
        >
          <MessageSquare className="w-4 h-4" /> Chat
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-black/80 rounded-full text-[10px] flex items-center justify-center font-bold">
              {unreadCount}
            </span>
          )}
        </button>
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
