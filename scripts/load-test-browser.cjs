#!/usr/bin/env node

const { chromium } = require('playwright')

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(value) ? value : fallback
}

function floatFromEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || '')
  return Number.isFinite(value) ? value : fallback
}

function boolFromEnv(name, fallback) {
  const value = (process.env[name] || '').trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

const BASE_URL = (process.env.LOAD_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const MODE = process.env.LOAD_MODE || 'video'
const LANG = process.env.LOAD_LANG || 'en-US'
const BROWSER_USERS = intFromEnv('BROWSER_USERS', 10)
const RAMP_MS = intFromEnv('RAMP_MS', 500)
const HOLD_MIN_MS = intFromEnv('HOLD_MIN_MS', 30000)
const HOLD_MAX_MS = intFromEnv('HOLD_MAX_MS', 90000)
const SKIP_CHANCE = floatFromEnv('SKIP_CHANCE', 0.35)
const TEST_DURATION_MS = intFromEnv('TEST_DURATION_MS', 120000)
const SUMMARY_MS = intFromEnv('SUMMARY_MS', 5000)
const HEADLESS = boolFromEnv('HEADLESS', true)
const PAGE_URL = `${BASE_URL}/chat?mode=${encodeURIComponent(MODE)}&lang=${encodeURIComponent(LANG)}`
const ORIGIN = new URL(BASE_URL).origin
const MEDIA_WARNING_PATTERNS = [
  /Camera access is required/i,
  /Camera\/mic needs HTTPS or localhost/i,
  /Microphone permission denied/i,
  /Preview unavailable/i,
]

const stats = {
  launched: 0,
  pagesReady: 0,
  connectionErrors: 0,
  matchedTransitions: 0,
  skipActions: 0,
  reconnectNotices: 0,
  pageErrors: 0,
  mediaWarnings: 0,
}

let stopRequested = false

function randomHoldMs() {
  if (HOLD_MAX_MS <= HOLD_MIN_MS) return HOLD_MIN_MS
  return HOLD_MIN_MS + Math.floor(Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logSummary(prefix = 'summary') {
  console.log(
    `[browser-load:${prefix}] launched=${stats.launched}/${BROWSER_USERS} ready=${stats.pagesReady} matchedTransitions=${stats.matchedTransitions} skipActions=${stats.skipActions} connectionErrors=${stats.connectionErrors} reconnectNotices=${stats.reconnectNotices} mediaWarnings=${stats.mediaWarnings} pageErrors=${stats.pageErrors}`
  )
}

async function ensureStarted(page) {
  const startButton = page.getByRole('button', { name: /^Start$/i }).first()
  const visible = await startButton.isVisible().catch(() => false)
  const enabled = visible && await startButton.isEnabled().catch(() => false)
  if (enabled) {
    await startButton.click().catch(() => {})
    return true
  }
  return false
}

async function detectMediaWarning(page) {
  const pageText = await page.locator('body').innerText().catch(() => '')
  return MEDIA_WARNING_PATTERNS.some((pattern) => pattern.test(pageText))
}

async function runUser(browser, index) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  })
  await context.grantPermissions(['camera', 'microphone'], { origin: ORIGIN }).catch(() => {})

  const page = await context.newPage()
  let inMatch = false
  let matchEnteredAt = 0
  let holdMs = randomHoldMs()

  page.on('pageerror', (error) => {
    stats.pageErrors += 1
    console.error(`[browser-load:user-${index}] pageerror:`, error?.message || error)
  })

  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('Connection Error') || text.includes('[Socket] Connection error')) {
      stats.connectionErrors += 1
    }
    if (text.includes('Reconnecting to chat') || text.includes('Connection lost. Reconnecting')) {
      stats.reconnectNotices += 1
    }
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  stats.pagesReady += 1
  await ensureStarted(page)

  while (!stopRequested) {
    if (await page.getByText('Connection Error').first().isVisible().catch(() => false)) {
      stats.connectionErrors += 1
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await ensureStarted(page)
      inMatch = false
      matchEnteredAt = 0
      holdMs = randomHoldMs()
      await sleep(1000)
      continue
    }

    if (await detectMediaWarning(page)) {
      stats.mediaWarnings += 1
      console.warn(`[browser-load:user-${index}] media warning detected on page ${PAGE_URL}`)
      await sleep(1000)
      continue
    }

    const skipButton = page.getByRole('button', { name: /^Skip$/i }).first()
    const skipEnabled = await skipButton.isVisible().catch(() => false) && await skipButton.isEnabled().catch(() => false)

    if (skipEnabled && !inMatch) {
      inMatch = true
      matchEnteredAt = Date.now()
      holdMs = randomHoldMs()
      stats.matchedTransitions += 1
    }

    if (!skipEnabled && inMatch) {
      inMatch = false
      matchEnteredAt = 0
      holdMs = randomHoldMs()
    }

    if (skipEnabled && inMatch && Date.now() - matchEnteredAt >= holdMs) {
      if (Math.random() <= SKIP_CHANCE) {
        await skipButton.click().catch(() => {})
        stats.skipActions += 1
      }
      inMatch = false
      matchEnteredAt = 0
      holdMs = randomHoldMs()
    }

    await ensureStarted(page)
    await sleep(1000)
  }

  await context.close()
}

async function main() {
  console.log(`[browser-load] launching ${BROWSER_USERS} fake-media browser users against ${PAGE_URL}`)
  console.log('[browser-load] make sure you have installed chromium once with: npx playwright install chromium')

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
      '--disable-features=MediaRouter',
      '--no-sandbox',
      ...(ORIGIN.startsWith('http://') ? [`--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`] : []),
    ],
  })

  const runners = []
  const summaryInterval = setInterval(() => logSummary(), SUMMARY_MS)

  for (let i = 0; i < BROWSER_USERS; i += 1) {
    stats.launched += 1
    runners.push(runUser(browser, i))
    if (i < BROWSER_USERS - 1) {
      await sleep(RAMP_MS)
    }
  }

  await sleep(TEST_DURATION_MS)
  stopRequested = true
  await Promise.allSettled(runners)
  clearInterval(summaryInterval)
  await browser.close()
  logSummary('final')
}

main().catch((error) => {
  console.error('[browser-load] fatal:', error)
  process.exit(1)
})