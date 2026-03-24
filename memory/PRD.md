# Omingle — Random Video/Voice Chat with Real-Time Translation

## Overview
Omingle is a random stranger video/voice chat web app where users who speak different languages are matched and their speech is translated in real-time as live captions. Think Omegle but with real-time cross-language translation subtitles.

## Tech Stack
- **Frontend**: Next.js 14 (App Router) + Tailwind CSS + shadcn/ui
- **Backend**: Custom Node.js server with Socket.io signaling
- **Real-time video/voice**: WebRTC (browser-native, P2P)
- **Speech-to-text**: Browser Web Speech API (free)
- **Translation**: MOCKED (ready for Bhashini + Google Cloud Translation API)
- **Matchmaking**: In-memory queue (ready for Redis/Upstash)
- **Database**: MongoDB (available via MONGO_URL)

## Features Implemented
1. **Landing Page** - Beautiful dark-themed hero with animated translation bubbles
2. **Consent Flow** - Age verification, terms, and safety guidelines
3. **Language Selection** - 40+ languages with search, grouped Indian/International
4. **Mode Selection** - Video Chat or Voice Only
5. **Waiting Room** - Animated search with language facts
6. **WebRTC Video/Voice Chat** - P2P connection via Socket.io signaling
7. **Real-Time Captions** - Web Speech API for speech recognition
8. **Text Chat Sidebar** - Always available, auto-translated messages
9. **Controls** - Mute, camera toggle, Next, End call

## Architecture
- `server.js` - Custom server wrapping Next.js + Socket.io
- `app/page.js` - Landing page with 4-step onboarding
- `app/chat/page.js` - Full chat room with WebRTC, captions, text chat
- `app/api/[[...path]]/route.js` - Translation API (mocked)
- `lib/languages.js` - 40+ language definitions
- `lib/constants.js` - App configuration

## Translation Integration (MOCKED)
Translation currently returns original text. To enable real translation:
1. Add `BHASHINI_API_KEY` for Indian languages
2. Add `GOOGLE_TRANSLATE_API_KEY` for international languages
3. Update `/app/api/[[...path]]/route.js` with real API calls
