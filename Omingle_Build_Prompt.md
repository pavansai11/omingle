# Omingle — Complete AI Build Prompt
### Full-Stack Random Video/Voice Chat App with Real-Time Translation
**Use this file in Cursor AI, Claude Code, or any AI coding tool. Feed each PHASE as a separate prompt.**

---

## MASTER CONTEXT (paste this at the top of EVERY prompt)

```
I am building "Omingle" — a random stranger video/voice chat web app where users who speak different languages are automatically matched and their speech is translated in real-time as live captions. Think Omegle but with real-time cross-language translation subtitles.

TECH STACK (do not deviate):
- Frontend: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- Backend: Node.js signaling server using Socket.io (separate Express server)
- Real-time video/voice: WebRTC (browser-native, P2P, free)
- TURN server: Coturn (self-hosted) — for users behind firewalls
- Speech-to-text: Browser Web Speech API (free, no API cost)
- Translation (Indian languages): Bhashini API (free, Govt of India)
- Translation (all other languages): Google Cloud Translation API v2
- Database: MongoDB Atlas (free M0 tier) via Mongoose
- Caching/rooms: Redis (Upstash free tier) for matchmaking queue
- Hosting: Hetzner CX21 VPS (€3.29/mo) — backend + TURN server
- Frontend hosting: Vercel (free tier)
- CDN + DDoS: Cloudflare (free tier)
- Ads (revenue): Google AdSense + PropellerAds script tags
- Analytics: Google Analytics 4 (free)
- Domain: Any registrar, pointed to Cloudflare

CORE RULES:
1. All code must be TypeScript with strict mode
2. Use Tailwind for ALL styling — no CSS modules, no inline styles
3. All environment variables go in .env.local (never hardcode keys)
4. Mobile-first responsive design
5. All WebRTC signaling goes through Socket.io server
6. Text chat is always on — it's the fallback when translation lag is high
7. Bhashini handles: Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Odia, Assamese, Urdu, Sanskrit — all other languages use Google Translate
8. Web Speech API does STT in the user's browser — zero API cost for speech recognition
9. Never use any paid STT or TTS service — not needed for CC-only (captions) mode
```

---

## PHASE 1 — Project Scaffolding & Folder Structure

```
Using the MASTER CONTEXT above, scaffold the complete Omingle project.

Create the following exact folder structure:

Omingle/
├── apps/
│   ├── web/                          ← Next.js 14 frontend (Vercel)
│   │   ├── app/
│   │   │   ├── layout.tsx            ← Root layout with GA4 script
│   │   │   ├── page.tsx              ← Home/landing page
│   │   │   ├── chat/
│   │   │   │   └── page.tsx          ← Main chat room page
│   │   │   ├── globals.css
│   │   │   └── fonts/
│   │   ├── components/
│   │   │   ├── home/
│   │   │   │   ├── Hero.tsx          ← Landing hero section
│   │   │   │   ├── ConsentModal.tsx  ← Age + terms consent
│   │   │   │   ├── LanguageSelector.tsx ← Multi-select language picker
│   │   │   │   └── ModeSelector.tsx  ← Video vs Voice choice
│   │   │   ├── chat/
│   │   │   │   ├── VideoPanel.tsx    ← Local + remote video feeds
│   │   │   │   ├── CaptionOverlay.tsx ← Live translated subtitles
│   │   │   │   ├── TextChat.tsx      ← Text chat sidebar
│   │   │   │   ├── ControlBar.tsx    ← Mute, cam off, next, report
│   │   │   │   ├── WaitingScreen.tsx ← Matching screen (ad slot)
│   │   │   │   └── LanguageBadge.tsx ← Shows matched user's language
│   │   │   └── shared/
│   │   │       ├── AdBanner.tsx      ← PropellerAds/AdSense wrapper
│   │   │       └── Navbar.tsx
│   │   ├── hooks/
│   │   │   ├── useWebRTC.ts          ← Full WebRTC connection logic
│   │   │   ├── useSocket.ts          ← Socket.io client
│   │   │   ├── useSpeechRecognition.ts ← Web Speech API wrapper
│   │   │   └── useTranslation.ts     ← Bhashini + Google Translate
│   │   ├── lib/
│   │   │   ├── languages.ts          ← All supported languages list
│   │   │   ├── bhashini.ts           ← Bhashini API client
│   │   │   ├── googleTranslate.ts    ← Google Translate client
│   │   │   └── constants.ts
│   │   ├── types/
│   │   │   └── index.ts              ← All shared TypeScript types
│   │   ├── public/
│   │   │   └── og-image.png
│   │   ├── next.config.js
│   │   ├── tailwind.config.ts
│   │   ├── tsconfig.json
│   │   └── .env.local.example
│   │
│   └── server/                       ← Node.js signaling server (Hetzner)
│       ├── src/
│       │   ├── index.ts              ← Express + Socket.io entry
│       │   ├── socket/
│       │   │   ├── matchmaking.ts    ← Queue + pairing logic
│       │   │   ├── signaling.ts      ← WebRTC offer/answer/ICE
│       │   │   └── chat.ts           ← Text message relay
│       │   ├── services/
│       │   │   └── redis.ts          ← Upstash Redis client (queue)
│       │   ├── models/
│       │   │   ├── User.ts           ← MongoDB user session schema
│       │   │   └── Report.ts         ← User report schema
│       │   └── middleware/
│       │       └── rateLimit.ts      ← 10 connections/min per IP
│       ├── package.json
│       ├── tsconfig.json
│       └── .env.example
└── README.md

Generate all config files: package.json for both apps, tsconfig.json for both, tailwind.config.ts, next.config.js with proper headers for WebRTC permissions. Include all npm install commands needed.

In .env.local.example and .env.example, list every environment variable with a comment explaining where to get it.
```

---

## PHASE 2 — Types, Constants & Language Data

```
Using the MASTER CONTEXT, build the complete types and data layer.

FILE: apps/web/types/index.ts
Define these exact TypeScript interfaces:

interface Language {
  code: string;          // BCP-47 code e.g. "hi-IN", "en-US", "ja-JP"
  name: string;          // Display name in English
  nativeName: string;    // Name in that language e.g. "हिन्दी"
  flag: string;          // Country flag emoji
  bhashiniCode?: string; // Bhashini internal code (only for Indian langs)
  webSpeechCode: string; // Code for Web Speech API
  googleCode: string;    // Code for Google Translate API
}

interface UserSession {
  socketId: string;
  primaryLanguage: Language;
  spokenLanguages: Language[];
  mode: 'video' | 'voice';
  isMatched: boolean;
  partnerId?: string;
  partnerLanguage?: Language;
  roomId?: string;
  joinedAt: Date;
}

interface ChatMessage {
  id: string;
  senderId: string;
  originalText: string;
  translatedText?: string;
  fromLanguage: string;
  toLanguage: string;
  timestamp: Date;
  isTranslating?: boolean;
}

interface TranscriptChunk {
  text: string;
  isFinal: boolean;
  languageCode: string;
  confidence?: number;
}

interface WebRTCSignal {
  type: 'offer' | 'answer' | 'ice-candidate' | 'end';
  from: string;
  to: string;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | null;
}

interface MatchEvent {
  roomId: string;
  partnerId: string;
  partnerLanguage: Language;
  isInitiator: boolean;
}

type ConnectionStatus = 'idle' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';

FILE: apps/web/lib/languages.ts
Create a complete array of 50+ Language objects covering:
- All 22 Indian official languages (with bhashiniCode)
- English (en-US, en-GB)
- Spanish, French, German, Italian, Portuguese
- Japanese, Korean, Chinese (Mandarin), Cantonese
- Arabic, Turkish, Russian, Polish, Dutch
- Thai, Vietnamese, Indonesian, Malay
- Swahili, Persian/Farsi, Hebrew

For each language include all 5 fields. Group them: INDIAN_LANGUAGES array and INTERNATIONAL_LANGUAGES array, then export ALL_LANGUAGES = [...INDIAN_LANGUAGES, ...INTERNATIONAL_LANGUAGES].

FILE: apps/web/lib/constants.ts
Export:
- SOCKET_URL (from env)
- STUN_SERVERS (Google STUN: stun:stun.l.google.com:19302 and stun:stun1.l.google.com:19302)
- TURN_SERVER config object (from env — your Hetzner Coturn)
- MAX_CHAT_MESSAGES = 100
- RECONNECT_ATTEMPTS = 3
- AD_SLOTS object with positions
- BHASHINI_INDIAN_LANG_CODES array (for routing logic)
```

---

## PHASE 3 — Home Page (Landing + Consent + Language + Mode Selection)

```
Using the MASTER CONTEXT, build the complete home page flow.

FILE: apps/web/app/page.tsx
This is a multi-step single-page flow. States: 'landing' | 'consent' | 'setup' | 'ready'

STEP 1 — Landing (Hero.tsx):
- Full-viewport hero with dark background (bg-gray-950)
- Large headline: "Talk to anyone. In any language." 
- Subheadline: "Random video & voice chat with real-time translation. No common language needed."
- Animated visual showing two speech bubbles — one in Hindi, one in Japanese — with a translation arrow between them (CSS animation, no library)
- Big CTA button "Start Chatting" → triggers consent modal
- Below fold: 3 feature cards (Real-time translation, Voice + Video, Text always on)
- Ad banner slot at the bottom (300×250 or 728×90 based on viewport)
- Fully responsive, mobile-first

STEP 2 — ConsentModal.tsx (shown as a bottom sheet on mobile, centered modal on desktop):
- Checkbox: "I confirm I am 18 years or older"
- Checkbox: "I agree to the Terms of Service and Community Guidelines"  
- Checkbox: "I understand conversations may be monitored for safety"
- All 3 must be checked to proceed
- Brief community guidelines summary (no nudity, no hate speech, report abuse)
- "I Agree & Continue" button
- Use Tailwind for modal overlay (fixed inset-0 bg-black/60 backdrop-blur-sm)

STEP 3 — LanguageSelector.tsx:
- Section 1: "What is your primary language?" — Single select searchable dropdown
  - Search input that filters the ALL_LANGUAGES array
  - Show flag + native name + english name for each option
  - Grouped: Indian Languages first, then International
  - Stores selection in localStorage too (remembered next visit)
- Section 2: "What other languages can you speak?" — Multi-select (optional)
  - Same searchable list, checkboxes, show selected as pill tags
  - User can select up to 5 additional languages
- "Continue" button

STEP 4 — ModeSelector.tsx:
- Two large cards side by side (stack on mobile):
  Card 1 — "Video Chat" with camera icon, description: "See and hear your match with live translated captions"
  Card 2 — "Voice Only" with microphone icon, description: "Voice call with live translated captions — no camera"  
- Both cards mention: "Text chat always available"
- Clicking either card stores mode and redirects to /chat with URL params:
  /chat?mode=video&lang=hi-IN&others=en-US,ta-IN
- Show a "What to expect" note: average wait time <30 seconds

FILE: apps/web/app/layout.tsx
- Add Google Analytics 4 script (gtag) using next/script with afterInteractive strategy
- Add Open Graph meta tags for social sharing
- Add viewport and PWA meta tags
- Add Google AdSense script tag (from env variable AD_CLIENT_ID)
- Font: Inter from next/font/google
```

---

## PHASE 4 — WebRTC & Socket.io Hooks

```
Using the MASTER CONTEXT, build the complete real-time connection layer.

FILE: apps/web/hooks/useSocket.ts
Create a custom React hook using socket.io-client:
- Connect to SOCKET_URL from constants on mount
- Auto-reconnect with exponential backoff (max 3 retries)
- Expose: socket instance, connectionStatus, emit helper, on/off helpers
- On unmount, properly disconnect
- Handle connection errors gracefully — set status to 'error'

FILE: apps/web/hooks/useWebRTC.ts
This is the most critical hook. Build it completely:

Parameters: { socket, mode: 'video'|'voice', onPartnerStream, onConnectionChange }

Internal state:
- localStream: MediaStream | null
- remoteStream: MediaStream | null  
- peerConnection: RTCPeerConnection | null
- connectionStatus: ConnectionStatus

Functions to expose:
- startMedia(): Promise<void> — gets camera/mic (video mode) or mic-only (voice mode)
  - Use exact constraints: video: { width:640, height:480, facingMode:'user' } for video
  - Always request audio: { echoCancellation:true, noiseSuppression:true, sampleRate:48000 }
  - Handle PermissionDeniedError gracefully with clear user message
  
- initPeerConnection(isInitiator: boolean, partnerLanguage: Language): void
  - Create RTCPeerConnection with both STUN and TURN servers from constants
  - Add all localStream tracks to peer connection
  - If isInitiator: create offer → set local description → emit 'signal' to socket
  - Listen for ontrack → set remoteStream
  - Listen for onicecandidate → emit ICE candidate to socket
  - Listen for onconnectionstatechange → update connectionStatus
  - Listen for onnegotiationneeded

- handleSignal(signal: WebRTCSignal): Promise<void>
  - Handle 'offer': set remote description → create answer → set local → emit answer
  - Handle 'answer': set remote description
  - Handle 'ice-candidate': add ICE candidate to peerConnection

- endCall(): void — close peer connection, stop all tracks, reset state

- toggleMute(): void — toggle audio track enabled
- toggleCamera(): void — toggle video track enabled (video mode only)

Socket event listeners to set up inside this hook:
- 'matched' → call initPeerConnection with isInitiator from event
- 'signal' → call handleSignal
- 'partner-left' → call endCall, set status to 'disconnected'

FILE: apps/web/hooks/useSpeechRecognition.ts
Wrapper around the browser Web Speech API:
- Check if window.SpeechRecognition or window.webkitSpeechRecognition exists
- Parameters: { language: string, onTranscript: (chunk: TranscriptChunk) => void, enabled: boolean }
- Set recognition.continuous = true, recognition.interimResults = true
- onresult handler: emit both interim (isFinal:false) and final (isFinal:true) results
- Auto-restart on recognition end (it stops after silence)
- Handle errors: 'not-allowed', 'network', 'no-speech' — expose errorState
- Expose: start(), stop(), isListening, isSupported, error

FILE: apps/web/hooks/useTranslation.ts
Parameters: { fromLang: string, toLang: string }
- Determine routing: if fromLang is in BHASHINI_INDIAN_LANG_CODES AND toLang is in BHASHINI_INDIAN_LANG_CODES → use Bhashini
- Otherwise → use Google Translate (via our own Next.js API route, never call Google directly from browser)
- translateText(text: string): Promise<string>
  - Call /api/translate with { text, from, to } 
  - Return translated string
  - Cache last 20 translations in a Map to avoid duplicate API calls for same phrase
- translateChunk(chunk: TranscriptChunk): Promise<string>
  - Only translate if isFinal = true (don't waste API calls on interim)
  - Return translation immediately
- Expose: translateText, translateChunk, isTranslating, error

FILE: apps/web/app/api/translate/route.ts (Next.js API Route)
POST handler:
- Read { text, from, to } from request body
- Determine if Bhashini route or Google route
- For Bhashini: POST to https://dhruva-api.bhashini.gov.in/services/inference/pipeline
  with Authorization header (BHASHINI_API_KEY from env)
  Body structure: { pipelineTasks: [{taskType:"translation", config:{language:{sourceLanguage:from, targetLanguageList:[to]}}}], inputData:{input:[{source:text}]} }
- For Google: GET https://translation.googleapis.com/language/translate/v2?key=KEY&q=text&source=from&target=to
- Return { translatedText: string }
- Rate limit: 60 requests per minute per IP using a simple in-memory counter
- Add proper error handling and return 400/500 with message on failure
```

---

## PHASE 5 — Signaling Server (Node.js + Socket.io)

```
Using the MASTER CONTEXT, build the complete backend signaling server.

FILE: apps/server/src/index.ts
- Express app + http server + Socket.io server
- CORS: allow origin from FRONTEND_URL env variable
- Socket.io options: transports: ['websocket', 'polling'], pingTimeout: 60000
- Rate limiting middleware: max 10 socket connections per IP per minute (use express-rate-limit)
- Mount socket handlers
- Start HTTP server on PORT (default 3001)
- Health check GET /health → returns { status:'ok', connections: io.engine.clientsCount }

FILE: apps/server/src/services/redis.ts
- Connect to Upstash Redis using ioredis with the REDIS_URL from env
- Export redis client
- Helper functions:
  addToQueue(socketId, userData): adds user to matchmaking sorted set with timestamp score
  removeFromQueue(socketId): removes user from queue
  getQueueLength(): returns queue size
  findMatch(socketId, userLangs): 
    Strategy 1: find another user in queue who has NO common language with current user (needs translation — ideal match)
    Strategy 2: if no ideal match after 10s, match with anyone in queue
    Returns matched socketId or null

FILE: apps/server/src/socket/matchmaking.ts
Handle these socket events:

'join-queue' (data: { primaryLanguage, spokenLanguages, mode }):
  - Save user session data in memory Map keyed by socketId
  - Add to Redis queue
  - Attempt findMatch immediately
  - If match found:
    - Generate roomId = nanoid(10)
    - Store room in memory { roomId, user1: socket.id, user2: matchedId, mode, startedAt }
    - Emit 'matched' to BOTH sockets with { roomId, partnerId, partnerLanguage, isInitiator }
    - isInitiator = true for the user who was already in queue, false for new joiner
    - Remove both from Redis queue
  - If no match: start 30s timeout, retry findMatch every 3s
  - Emit 'queue-status' every 3s with { position, waitTime }

'leave-queue':
  - Remove from Redis queue
  - Clear any retry timeout

'next' (find new partner):
  - If currently in a room, emit 'partner-left' to current partner
  - Close current room
  - Re-add to queue and restart matching

on disconnect:
  - Remove from queue
  - If in a room, emit 'partner-left' to other user
  - Clean up room from memory

FILE: apps/server/src/socket/signaling.ts
Handle these socket events:

'signal' (data: WebRTCSignal):
  - Validate that sender and receiver are in the same room
  - Forward the signal payload directly to data.to socket
  - Handle: offer, answer, ice-candidate, end

'translation-ready' (data: { roomId, text, fromLang, toLang }):
  - Relay translated text to partner in room
  - This is used when one user's browser translates and sends to partner

FILE: apps/server/src/socket/chat.ts
Handle these socket events:

'send-message' (data: { roomId, message: string, fromLang: string }):
  - Validate user is in that room
  - Generate messageId = nanoid()
  - Store message in MongoDB (async, don't await)
  - Emit 'receive-message' to partner with { messageId, text: message, fromLang, timestamp }

'typing' / 'stop-typing':
  - Relay to partner in room

FILE: apps/server/src/models/User.ts (Mongoose schema)
Schema: { socketId, primaryLanguage, spokenLanguages, mode, roomId, connectedAt, disconnectedAt, reportCount, isBanned, ipHash }
ipHash: SHA256 of IP address (never store raw IP for privacy)

FILE: apps/server/src/models/Report.ts (Mongoose schema)  
Schema: { reporterId, reportedId, roomId, reason (enum: nudity|harassment|spam|underage|other), description, timestamp, resolved }

FILE: apps/server/src/middleware/rateLimit.ts
- Max 10 new socket connections per IP per minute
- Max 60 messages per minute per socketId (sliding window in Redis)
- Ban IPs that get 3+ reports within 24 hours
- Return socket error event 'rate-limited' with retry-after seconds
```

---

## PHASE 6 — Chat Room Page (Main UI)

```
Using the MASTER CONTEXT, build the complete chat room interface.

FILE: apps/web/app/chat/page.tsx
- Read URL params: mode, lang, others
- Initialize all hooks: useSocket, useWebRTC, useSpeechRecognition, useTranslation
- Manage state machine: 'waiting' | 'connecting' | 'connected' | 'disconnected'
- On mount: call startMedia(), then emit 'join-queue' to socket
- On 'matched' socket event: update state to 'connecting'
- On WebRTC connectionStatus = 'connected': update to 'connected'
- Layout: full viewport, no scroll
  - Left/Main: VideoPanel or voice-call visualizer (takes 65% width on desktop)
  - Right: TextChat sidebar (35% width, full height on desktop)
  - Bottom: ControlBar (fixed)
  - Caption overlay is absolute positioned over video

FILE: components/chat/WaitingScreen.tsx
- Shown during 'waiting' state
- Animated searching indicator (pulsing dots)
- Queue position counter ("Looking for your match...")
- Fun language facts that rotate every 5 seconds (hardcode 20 facts)
- IMPORTANT: Large 300×250 ad unit placed prominently here (this is your highest-earning slot)
  The user is idle here — maximum ad viewability
- Average wait time counter
- "Cancel" button → emits 'leave-queue', goes back to home

FILE: components/chat/VideoPanel.tsx
Props: { localStream, remoteStream, mode, partnerLanguage, connectionStatus }
- Video mode: two video elements
  - Remote video: large, fills the panel (object-fit: cover)
  - Local video: small picture-in-picture in corner (120×90px, draggable on desktop)
  - Both videos: autoPlay, muted (local), playsInline
- Voice mode: 
  - Large animated waveform visualizer using Web Audio API (AnalyserNode)
  - Show partner's language flag and name in center
  - Audio levels visualized as vertical bars (canvas element)
- Connection status overlay: show 'Connecting...' spinner while ICE is negotiating
- LanguageBadge: shows partner's primary language + flag in top-left corner of remote video

FILE: components/chat/CaptionOverlay.tsx
Props: { myTranscript: TranscriptChunk | null, translatedPartnerText: string | null, partnerLang: Language, myLang: Language }
- Positioned absolute over video, bottom 80px, left/right 16px
- My transcript (interim): shown as faint white text at bottom (what I'm saying right now)
- Partner's translated text: shown as white text with semi-transparent black pill background
  Format: "[Flag] [PartnerLang] → [MyLang]: translated text here"
- Fade in/out animation on each new caption
- Font: 18px on desktop, 14px on mobile
- Max 2 lines visible at once — older captions fade out

FILE: components/chat/TextChat.tsx
Props: { messages: ChatMessage[], onSend, isTyping, partnerLang, myLang }
- Chat sidebar with scrollable message history
- Each message bubble:
  - My messages: right-aligned, blue background
  - Partner messages: left-aligned, gray background
  - Show BOTH original text AND translated text (if different)
  - Format: Original: "Namaste" | Translated: "Hello"
  - Small language flag next to each message
- Input box at bottom with send button + Enter to send
- Typing indicator ("Partner is typing..." with dots animation)
- Emoji picker button (use a simple inline grid of 20 common emojis — no library)
- Auto-scroll to newest message
- Translation happens automatically: when partner sends message in their lang,
  call translateText before displaying

FILE: components/chat/ControlBar.tsx
Props: { isMuted, isCameraOff, mode, onMute, onCamera, onNext, onReport, onEnd }
- Fixed bottom bar, full width, dark background
- Buttons (left to right):
  - Mute/Unmute (mic icon, red when muted)
  - Camera On/Off (only in video mode)
  - "Next" button (skip to new partner) — most important button, center, prominent
  - Report (flag icon) → opens a small modal with report reasons
  - End/Leave (X button, red)
- Show connection quality indicator (green/yellow/red dot based on RTCStatsReport)
- Show call duration timer (MM:SS)
- On mobile: slightly larger touch targets (min 44×44px)

FILE: components/chat/ReportModal.tsx
- Reason options: Nudity, Harassment, Hate Speech, Spam, Appears Underage, Other
- Optional description text area
- Submit → emit 'report' to socket with roomId + reason
- Show confirmation toast after submit
- Auto-close after 3 seconds
```

---

## PHASE 7 — Translation Integration (Bhashini + Google)

```
Using the MASTER CONTEXT, complete the full translation pipeline.

The full real-time caption flow works like this — implement it exactly:

1. User A speaks (in Hindi) → Web Speech API in User A's browser detects speech
2. useSpeechRecognition fires onTranscript callback with TranscriptChunk
3. If chunk.isFinal = true → call useTranslation.translateChunk(chunk)
4. translateChunk calls /api/translate with { text, from: 'hi', to: 'ja' }
5. /api/translate routes to Bhashini (if both Indian) or Google Translate
6. Translation comes back → emit 'translation-ready' to socket with translated text
7. Server relays 'translation-ready' to User B
8. User B's CaptionOverlay shows the translated text
9. Simultaneously: User A's own interim transcript shows on their own screen

FILE: apps/web/app/api/translate/route.ts — Complete Implementation:

import { NextRequest, NextResponse } from 'next/server';

const BHASHINI_INDIAN_CODES = ['hi','ta','te','kn','ml','bn','mr','gu','pa','or','as','ur','sa','mai','kok','sd','mni','doi','sat','ks','ne','bho'];

async function translateWithBhashini(text: string, sourceLang: string, targetLang: string): Promise<string> {
  const response = await fetch('https://dhruva-api.bhashini.gov.in/services/inference/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': process.env.BHASHINI_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pipelineTasks: [{
        taskType: 'translation',
        config: {
          language: {
            sourceLanguage: sourceLang,
            targetLanguageList: [targetLang]
          },
          serviceId: 'ai4bharat/indictrans-v2-all-gpu--t4',
        }
      }],
      inputData: {
        input: [{ source: text }]
      }
    }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  return data.pipelineResponse?.[0]?.output?.[0]?.target ?? text;
}

async function translateWithGoogle(text: string, sourceLang: string, targetLang: string): Promise<string> {
  const url = new URL('https://translation.googleapis.com/language/translate/v2');
  url.searchParams.set('key', process.env.GOOGLE_TRANSLATE_API_KEY!);
  url.searchParams.set('q', text);
  url.searchParams.set('source', sourceLang);
  url.searchParams.set('target', targetLang);
  url.searchParams.set('format', 'text');
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  return data.data?.translations?.[0]?.translatedText ?? text;
}

export async function POST(req: NextRequest) {
  const { text, from, to } = await req.json();
  if (!text || !from || !to) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  if (text.trim().length === 0) return NextResponse.json({ translatedText: '' });
  if (from === to) return NextResponse.json({ translatedText: text });
  
  const fromBase = from.split('-')[0];
  const toBase = to.split('-')[0];
  const useBhashini = BHASHINI_INDIAN_CODES.includes(fromBase) && BHASHINI_INDIAN_CODES.includes(toBase);
  
  try {
    const translatedText = useBhashini
      ? await translateWithBhashini(text, fromBase, toBase)
      : await translateWithGoogle(text, fromBase, toBase);
    return NextResponse.json({ translatedText });
  } catch (error) {
    return NextResponse.json({ error: 'Translation failed' }, { status: 500 });
  }
}

Also implement the full real-time caption pipeline in the chat page:
- useSpeechRecognition runs continuously while connected
- Each final transcript → translateChunk → emit 'translation-ready' via socket
- Incoming 'translation-ready' from socket → update CaptionOverlay state
- Interim transcripts (not final) → show only on the local user's screen as they speak
- Implement a 3-second debounce: if partner speaks continuously, batch words and translate every 3 seconds instead of every word (reduces API calls by 80%)
```

---

## PHASE 8 — UI Polish, Ad Slots & Analytics

```
Using the MASTER CONTEXT, finalize all UI details and monetization integrations.

FILE: components/shared/AdBanner.tsx
- Wrapper component that renders ad units in designated slots
- Props: { slot: 'waiting-screen' | 'footer' | 'sidebar', size: '300x250' | '728x90' | '320x50' }
- For PropellerAds: renders their script tag in a div (use dangerouslySetInnerHTML safely)
- For AdSense: renders <ins className="adsbygoogle"> with correct data-ad-slot from env
- Use next/script to load ad scripts only after user consent
- Show a tasteful "Advertisement" label above each ad unit
- On mobile: use 320×50 (banner) size only to not obstruct content

AD SLOT PLACEMENTS:
1. WaitingScreen: 300×250 centered (shown 20–60 seconds while user waits — highest viewability)
2. Between calls: 300×250 shown for 5 seconds after clicking "Next" before next match starts (interstitial-style, user can skip after 3s)
3. Home page footer: 728×90 leaderboard (desktop) / 320×50 (mobile)
Total: 3 distinct placements, user sees ads without interrupting the chat itself.

FILE: apps/web/app/layout.tsx — Add Analytics:
- Google Analytics 4 using next/script (strategy: 'afterInteractive')
- Track these custom events:
  ga('event', 'join_queue', { mode, primary_language })
  ga('event', 'match_found', { wait_time_seconds })
  ga('event', 'call_ended', { duration_seconds, ended_by })
  ga('event', 'translation_used', { from_lang, to_lang })
  ga('event', 'next_clicked', { call_duration })

UI POLISH — apply these Tailwind patterns throughout:

Color scheme (dark theme, modern):
- Background: bg-gray-950 (main), bg-gray-900 (panels), bg-gray-800 (cards)
- Primary accent: bg-violet-600 hover:bg-violet-500 (buttons, CTAs)
- Text: text-white (primary), text-gray-400 (secondary), text-gray-500 (tertiary)
- Success: text-emerald-400 | Error: text-red-400 | Warning: text-amber-400
- Border: border-gray-800 (subtle), border-gray-700 (visible)

Animations (CSS only, no framer-motion):
- Waiting screen pulse: animate-pulse on searching indicator
- Caption fade: transition-opacity duration-300
- Button press: active:scale-95 transition-transform
- Modal open: animate-in from Tailwind (or simple CSS @keyframes slideUp)
- Connection dots: custom @keyframes bounce with staggered delays

Mobile-specific:
- VideoPanel: remote video full screen, local video small overlay (bottom-right)
- ControlBar: slightly taller (64px), buttons larger touch targets
- TextChat: collapsible drawer from bottom (toggle with a button)
- Caption text: smaller font but still readable (14px minimum)
- No horizontal scroll anywhere

Accessibility:
- All interactive elements have aria-label
- Keyboard navigation works (Tab through controls)
- Color contrast passes WCAG AA
- SpeechRecognition status announced via aria-live region
```

---

## PHASE 9 — Deployment Configuration

```
Using the MASTER CONTEXT, create all deployment and configuration files.

FILE: apps/web/.env.local.example
# Copy this to .env.local and fill in your values

# Socket Server (your Hetzner VPS IP)
NEXT_PUBLIC_SOCKET_URL=http://YOUR_HETZNER_IP:3001

# Bhashini API (free — get from bhashini.gov.in)
BHASHINI_API_KEY=your_bhashini_api_key_here
BHASHINI_USER_ID=your_bhashini_user_id_here

# Google Cloud Translation API
GOOGLE_TRANSLATE_API_KEY=your_google_api_key_here

# MongoDB Atlas (free M0 cluster)
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/Omingle

# Upstash Redis (free tier)
REDIS_URL=redis://default:password@host.upstash.io:port

# TURN Server (your Coturn on Hetzner)
NEXT_PUBLIC_TURN_URL=turn:YOUR_HETZNER_IP:3478
NEXT_PUBLIC_TURN_USERNAME=Omingle
NEXT_PUBLIC_TURN_CREDENTIAL=your_turn_password

# Ads
NEXT_PUBLIC_ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX
NEXT_PUBLIC_ADSENSE_SLOT_WAITING=XXXXXXXXXX
NEXT_PUBLIC_ADSENSE_SLOT_FOOTER=XXXXXXXXXX

# Analytics
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX

# App
NEXT_PUBLIC_APP_URL=https://yourdomain.com
NODE_ENV=production

FILE: apps/server/.env.example
PORT=3001
FRONTEND_URL=https://yourdomain.com
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/Omingle
REDIS_URL=redis://default:password@host.upstash.io:port
NODE_ENV=production

FILE: apps/server/ecosystem.config.js (PM2 config for Hetzner)
module.exports = {
  apps: [{
    name: 'Omingle-server',
    script: 'dist/index.js',
    instances: 2,
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '500M',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }]
};

FILE: apps/web/next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'Permissions-Policy', value: 'camera=self, microphone=self' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ],
    },
  ],
  async rewrites() {
    return [
      { source: '/socket.io/:path*', destination: `${process.env.NEXT_PUBLIC_SOCKET_URL}/socket.io/:path*` }
    ];
  }
};
module.exports = nextConfig;

FILE: Coturn setup script (coturn-setup.sh) for Hetzner:
#!/bin/bash
apt-get update && apt-get install -y coturn
cat > /etc/turnserver.conf << EOF
listening-port=3478
tls-listening-port=5349
listening-ip=YOUR_SERVER_IP
external-ip=YOUR_SERVER_IP
relay-ip=YOUR_SERVER_IP
realm=Omingle.app
server-name=Omingle.app
lt-cred-mech
user=Omingle:YOUR_PASSWORD
fingerprint
no-loopback-peers
no-multicast-peers
syslog
pidfile=/var/run/turnserver.pid
EOF
systemctl enable coturn && systemctl start coturn

Write a complete README.md with:
1. Prerequisites list
2. Local development setup (step by step)  
3. Production deployment steps (Hetzner + Vercel + Cloudflare)
4. All environment variable explanations
5. How to get each API key (exact links)
```

---

## WHERE TO GET EVERY API KEY & ACCOUNT

### 1. Bhashini API (FREE — Indian Languages)
- **URL:** https://bhashini.gov.in/ulca/model-form  
- **Steps:** Register at bhashini.gov.in → Login → Go to API section → Apply for Dhruva API access → Get `Authorization` key + `userId`
- **Cost:** Completely FREE, government of India initiative
- **Covers:** Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Odia, Assamese, Urdu, Sanskrit (22 Indian languages)
- **Rate limit:** 10 requests/second free, higher on request

### 2. Google Cloud Translation API
- **URL:** https://console.cloud.google.com
- **Steps:** Create project → Enable "Cloud Translation API" → Go to APIs & Services → Credentials → Create API Key → Restrict to Translation API only
- **Cost:** First 500,000 characters/month FREE. After that: $20 per 1 million characters. At your scale (year 1), expect ₹0–200/month
- **Note:** Require billing account but free tier covers you for months

### 3. MongoDB Atlas (FREE)
- **URL:** https://cloud.mongodb.com
- **Steps:** Sign up → Create free M0 cluster (select Mumbai region for low latency) → Create database user → Get connection string
- **Cost:** M0 FREE forever (512MB storage — handles 50,000+ users easily)

### 4. Upstash Redis (FREE)
- **URL:** https://upstash.com
- **Steps:** Sign up → Create Redis database → Select region closest to your server → Copy REST URL and token
- **Cost:** Free tier = 10,000 commands/day. More than enough for matchmaking queue

### 5. Hetzner VPS (Backend Server)
- **URL:** https://hetzner.com/cloud
- **Steps:** Register → Create server → Choose CX21 (2vCPU, 4GB RAM) → Select Nuremberg or Helsinki → Ubuntu 22.04 → Add your SSH key
- **Cost:** €3.29/month (~₹295/month) — includes 20TB outbound bandwidth FREE
- **What runs here:** Node.js signaling server (PM2) + Coturn TURN server

### 6. Vercel (Frontend Hosting — FREE)
- **URL:** https://vercel.com
- **Steps:** Sign up → Connect GitHub → Import your repo → Set environment variables → Deploy
- **Cost:** FREE for hobby (100GB bandwidth, unlimited deployments)

### 7. Cloudflare (CDN + DDoS — FREE)
- **URL:** https://cloudflare.com
- **Steps:** Add your domain → Change nameservers → Enable Proxy → Turn on "Under Attack Mode" if needed
- **Cost:** FREE tier fully sufficient

### 8. Google AdSense
- **URL:** https://adsense.google.com
- **Steps:** Apply with your domain → Wait 2–4 weeks for approval (need some content/traffic first) → Get Publisher ID (ca-pub-XXXXX) → Create ad units → Get slot IDs
- **Requirement:** Site must have real traffic and original content (your blog posts)
- **Alternative while waiting:** PropellerAds (https://propellerads.com) — approves in 24 hours, no minimum traffic

### 9. Google Analytics 4 (FREE)
- **URL:** https://analytics.google.com
- **Steps:** Create account → Create property → Get Measurement ID (G-XXXXXXXXXX)

### 10. Google Cloud Console (for Translate API)
- **URL:** https://console.cloud.google.com  
- **Note:** Same account as above. Enable billing (required) but you'll stay in free tier for months.

---

## DEVELOPMENT ORDER (do phases in this sequence)

```
Week 1: Phase 1 (scaffold) + Phase 2 (types/data) + Phase 3 (home page)
Week 2: Phase 4 (WebRTC hooks) + Phase 5 (signaling server)  
Week 3: Phase 6 (chat room UI) + Phase 7 (translation pipeline)
Week 4: Phase 8 (polish + ads) + Phase 9 (deployment)

Test locally:
- Run server: cd apps/server && npm run dev (port 3001)
- Run web: cd apps/web && npm run dev (port 3000)
- Use two different browser tabs to test matching
- Use Chrome for Web Speech API testing (best support)
- Test translation: set one tab lang=hi, other lang=ta, speak into one
```

---

## NEXT PHASE (Games — for later)

When you're ready to add games, use this as your next prompt:

```
Add a "Play a game while chatting" feature to Omingle.
Games: Tic-Tac-Toe and a word guessing game (Skribbl-like).
Both players must agree before a game starts (via a "Want to play?" invite).
Games run over the existing Socket.io connection — no new server needed.
Add a GamePanel component that overlays on the chat room.
Game state lives on the server in a roomGames Map, synced via socket events.
Keep video/audio/captions running during the game — game is a side panel only.
```
