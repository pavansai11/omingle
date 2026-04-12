'use client'

import { useEffect, useRef, useCallback } from 'react'

// ── Tuning constants ──────────────────────────────────────────────────────────
// Check every 2.5 s.  Require 3 consecutive misses before raising the alarm
// (~7.5 s of genuine absence before any UI appears).  This means:
//   • Blinking / closing eyes                → ignored (single miss at most)
//   • Leaning back or looking away briefly   → ignored
//   • Actually leaving the camera            → triggers after ~7.5 s
//   • Countdown timer after warning appears  → 10 s (same as before)
const FACE_CHECK_INTERVAL_MS = 2500
const CONSECUTIVE_MISSES_REQUIRED = 3          // misses before "face absent" state
const NO_FACE_TIMEOUT_MS = 10_000              // seconds shown in countdown
const FACEAPI_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js'
const FACEAPI_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model'

// Higher scoreThreshold = fewer false "face found" hits when eyes are closed or
// the face is very small / sideways.  0.55 is a good middle ground.
const DETECTOR_OPTIONS = { inputSize: 224, scoreThreshold: 0.55 }

/**
 * useFaceDetection
 * Monitors a <video> element for genuine face absence (not just eye blinks).
 *
 * Lifecycle:
 *   1. Every FACE_CHECK_INTERVAL_MS, run TinyFaceDetector.
 *   2. On each MISS, increment consecutiveMisses.
 *   3. Only after CONSECUTIVE_MISSES_REQUIRED consecutive misses → onNoFace().
 *   4. On any HIT, reset consecutiveMisses and (if previously absent) onFaceBack().
 *   5. NO_FACE_TIMEOUT_MS after onNoFace(), call onTimeout() if still absent.
 *
 * @param {object}              options
 * @param {React.RefObject}     options.videoRef     - ref to local <video>
 * @param {boolean}             options.enabled      - run only when true
 * @param {function}            options.onNoFace     - called when face first disappears
 * @param {function}            options.onFaceBack   - called when face returns
 * @param {function}            options.onTimeout    - called after NO_FACE_TIMEOUT_MS
 */
export function useFaceDetection({ videoRef, enabled, onNoFace, onFaceBack, onTimeout }) {
  const loadedRef              = useRef(false)
  const intervalRef            = useRef(null)
  const noFaceTimerRef         = useRef(null)
  const faceAbsentRef          = useRef(false)        // true = warning is showing
  const consecutiveMissesRef   = useRef(0)            // streak of no-face frames
  const onNoFaceRef            = useRef(onNoFace)
  const onFaceBackRef          = useRef(onFaceBack)
  const onTimeoutRef           = useRef(onTimeout)

  // Keep callback refs fresh without re-triggering effects
  useEffect(() => { onNoFaceRef.current  = onNoFace  }, [onNoFace])
  useEffect(() => { onFaceBackRef.current = onFaceBack }, [onFaceBack])
  useEffect(() => { onTimeoutRef.current = onTimeout  }, [onTimeout])

  const stopDetection = useCallback(() => {
    if (intervalRef.current)    clearInterval(intervalRef.current)
    if (noFaceTimerRef.current) clearTimeout(noFaceTimerRef.current)
    intervalRef.current        = null
    noFaceTimerRef.current     = null
    faceAbsentRef.current      = false
    consecutiveMissesRef.current = 0
  }, [])

  const startDetection = useCallback(async () => {
    if (!videoRef.current) return

    // ── Load face-api once ────────────────────────────────────────────────────
    if (!loadedRef.current) {
      try {
        if (!window.faceapi) {
          await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-faceapi]')
            if (existing) { resolve(); return }
            const s = document.createElement('script')
            s.src = FACEAPI_CDN
            s.async = true
            s.dataset.faceapi = 'true'
            s.onload  = resolve
            s.onerror = reject
            document.head.appendChild(s)
          })
        }
        if (!window.faceapi) return
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(FACEAPI_MODELS)
        loadedRef.current = true
      } catch (e) {
        console.warn('[FaceDetection] Failed to load model, face detection disabled:', e)
        return
      }
    }

    const faceapi = window.faceapi
    if (!faceapi) return

    // ── Detection loop ────────────────────────────────────────────────────────
    intervalRef.current = setInterval(async () => {
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.paused) return

      try {
        const result = await faceapi.detectSingleFace(
          video,
          new faceapi.TinyFaceDetectorOptions(DETECTOR_OPTIONS)
        )
        const faceFound = !!result

        if (faceFound) {
          // ── Face present ────────────────────────────────────────────────────
          consecutiveMissesRef.current = 0          // reset streak

          if (faceAbsentRef.current) {
            // Face came back while warning was showing
            faceAbsentRef.current = false
            if (noFaceTimerRef.current) {
              clearTimeout(noFaceTimerRef.current)
              noFaceTimerRef.current = null
            }
            onFaceBackRef.current?.()
          }
        } else {
          // ── Face absent ─────────────────────────────────────────────────────
          consecutiveMissesRef.current += 1

          if (
            consecutiveMissesRef.current >= CONSECUTIVE_MISSES_REQUIRED &&
            !faceAbsentRef.current
          ) {
            // Only trigger after N consecutive misses
            faceAbsentRef.current = true
            onNoFaceRef.current?.()

            noFaceTimerRef.current = setTimeout(() => {
              if (faceAbsentRef.current) {
                onTimeoutRef.current?.()
              }
            }, NO_FACE_TIMEOUT_MS)
          }
        }
      } catch (_e) {
        // Ignore per-frame errors (e.g., video size 0 during resize)
      }
    }, FACE_CHECK_INTERVAL_MS)
  }, [videoRef])

  useEffect(() => {
    if (!enabled) {
      stopDetection()
      return
    }
    startDetection()
    return stopDetection
  }, [enabled, startDetection, stopDetection])

  return { stopDetection }
}

export const NO_FACE_TIMEOUT_SECONDS = NO_FACE_TIMEOUT_MS / 1000