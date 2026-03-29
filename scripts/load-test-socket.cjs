#!/usr/bin/env node

const { io } = require('socket.io-client')
const crypto = require('crypto')

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(value) ? value : fallback
}

function floatFromEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || '')
  return Number.isFinite(value) ? value : fallback
}

const LOAD_URL = process.env.LOAD_URL || 'http://127.0.0.1:3000'
const LOAD_USERS = intFromEnv('LOAD_USERS', 100)
const LOAD_RAMP_MS = intFromEnv('LOAD_RAMP_MS', 150)
const HOLD_MIN_MS = intFromEnv('LOAD_HOLD_MIN_MS', 30000)
const HOLD_MAX_MS = intFromEnv('LOAD_HOLD_MAX_MS', 90000)
const SKIP_CHANCE = floatFromEnv('LOAD_SKIP_CHANCE', 0.35)
const SUMMARY_MS = intFromEnv('LOAD_SUMMARY_MS', 5000)
const LOAD_MODE = process.env.LOAD_MODE || 'video'
const INTERESTS = (process.env.LOAD_INTERESTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean)

const clients = new Map()
const stats = {
  created: 0,
  connected: 0,
  connectErrors: 0,
  disconnected: 0,
  queueStatus: 0,
  matched: 0,
  partnerLeft: 0,
  skips: 0,
  messages: 0,
}

function randomHoldMs() {
  if (HOLD_MAX_MS <= HOLD_MIN_MS) return HOLD_MIN_MS
  return HOLD_MIN_MS + Math.floor(Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS))
}

function createPrimaryLanguage(index) {
  return {
    code: 'en-US',
    name: `Load Test ${index + 1}`,
    googleCode: 'en',
    webSpeechCode: 'en-US',
    flag: '🌐',
  }
}

function printSummary() {
  const activeClients = [...clients.values()].filter((client) => client.socket.connected).length
  const matchedClients = [...clients.values()].filter((client) => client.roomId).length
  console.log(
    `[load-test] connected=${activeClients}/${LOAD_USERS} matchedClients=${matchedClients} created=${stats.created} connectedEvents=${stats.connected} matched=${stats.matched} queueStatus=${stats.queueStatus} skips=${stats.skips} partnerLeft=${stats.partnerLeft} connectErrors=${stats.connectErrors} disconnected=${stats.disconnected}`
  )
}

function scheduleRejoin(client, delay = 500) {
  clearTimeout(client.rejoinTimer)
  client.rejoinTimer = setTimeout(() => {
    if (!client.socket.connected) return
    client.roomId = null
    client.partnerId = null
    client.socket.emit('join-queue', {
      primaryLanguage: client.primaryLanguage,
      spokenLanguages: [],
      mode: LOAD_MODE,
      interestKeywords: INTERESTS,
      anonUserId: client.anonUserId,
      userId: null,
      displayName: null,
      email: '',
      image: null,
      country: { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' },
    })
  }, delay)
}

function createClient(index) {
  const anonUserId = `load_${index}_${crypto.randomUUID()}`
  const primaryLanguage = createPrimaryLanguage(index)
  const socket = io(LOAD_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    timeout: 20000,
  })

  const client = {
    index,
    anonUserId,
    primaryLanguage,
    socket,
    roomId: null,
    partnerId: null,
    holdTimer: null,
    rejoinTimer: null,
  }
  clients.set(index, client)
  stats.created += 1

  socket.on('connect', () => {
    stats.connected += 1
    socket.emit('identify-user', {
      anonUserId,
      userId: null,
      displayName: null,
      email: '',
      image: null,
      country: { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' },
    })
    scheduleRejoin(client, 100)
  })

  socket.on('queue-status', () => {
    stats.queueStatus += 1
  })

  socket.on('matched', (data) => {
    stats.matched += 1
    client.roomId = data?.roomId || null
    client.partnerId = data?.partnerId || null
    clearTimeout(client.holdTimer)
    client.holdTimer = setTimeout(() => {
      if (!socket.connected) return
      if (Math.random() <= SKIP_CHANCE) {
        stats.skips += 1
        socket.emit('next')
        scheduleRejoin(client, 400)
      }
    }, randomHoldMs())
  })

  socket.on('partner-left', () => {
    stats.partnerLeft += 1
    client.roomId = null
    client.partnerId = null
    scheduleRejoin(client, 400)
  })

  socket.on('receive-message', () => {
    stats.messages += 1
  })

  socket.on('connect_error', (error) => {
    stats.connectErrors += 1
    console.error(`[load-test] connect_error client=${index}:`, error?.message || error)
  })

  socket.on('disconnect', (reason) => {
    stats.disconnected += 1
    client.roomId = null
    client.partnerId = null
    clearTimeout(client.holdTimer)
    clearTimeout(client.rejoinTimer)
    console.log(`[load-test] disconnected client=${index} reason=${reason}`)
  })
}

console.log(`[load-test] starting ${LOAD_USERS} synthetic users against ${LOAD_URL}`)

let launched = 0
const ramp = setInterval(() => {
  if (launched >= LOAD_USERS) {
    clearInterval(ramp)
    return
  }
  createClient(launched)
  launched += 1
}, LOAD_RAMP_MS)

const summary = setInterval(printSummary, SUMMARY_MS)

function shutdown() {
  clearInterval(ramp)
  clearInterval(summary)
  for (const client of clients.values()) {
    clearTimeout(client.holdTimer)
    clearTimeout(client.rejoinTimer)
    client.socket.disconnect()
  }
  printSummary()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)