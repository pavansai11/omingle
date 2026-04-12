'use client'

import { useEffect, useRef, useCallback } from 'react'

const FACE_CHECK_INTERVAL_MS = 2000
const NO_FACE_TIMEOUT_MS = 10000
const MODELS_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model'

/**
 * useFaceDetection
 * Monitors a <video> element for face presence.
 * Only active when `enabled` is true (video mode + connected).
 *
 * @param {object} options
 * @param {React.RefObject} options.videoRef - ref to the local <video> element
 * @param {boolean} options.enabled - whether to run detection
 * @param {function} options.onNoFace - called when no face detected (starts countdown)
 * @param {function} options.onFaceBack - called when face detected again
 * @param {function} options.onTimeout - called after NO_FACE_TIMEOUT_MS with no face
 */
export function useFaceDetection({ videoRef, enabled, onNoFace, onFaceBack, onTimeout }) {
  const loadedRef = useRef(false)
  const intervalRef = useRef(null)
  const noFaceTimerRef = useRef(null)
  const noFaceStartRef = useRef(null)
  const faceAbsentRef = useRef(false)
  const onNoFaceRef = useRef(onNoFace)
  const onFaceBackRef = useRef(onFaceBack)
  const onTimeoutRef = useRef(onTimeout)

  useEffect(() => { onNoFaceRef.current = onNoFace }, [onNoFace])
  useEffect(() => { onFaceBackRef.current = onFaceBack }, [onFaceBack])
  useEffect(() => { onTimeoutRef.current = onTimeout }, [onTimeout])

  const stopDetection = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (noFaceTimerRef.current) clearTimeout(noFaceTimerRef.current)
    intervalRef.current = null
    noFaceTimerRef.current = null
    noFaceStartRef.current = null
    faceAbsentRef.current = false
  }, [])

  const startDetection = useCallback(async () => {
    if (!videoRef.current) return
    if (!loadedRef.current) {
      try {
        // Dynamically load @vladmandic/face-api from CDN
        if (!window.faceapi) {
          await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-faceapi]')
            if (existing) { resolve(); return }
            const s = document.createElement('script')
            s.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js'
            s.async = true
            s.dataset.faceapi = 'true'
            s.onload = resolve
            s.onerror = reject
            document.head.appendChild(s)
          })
        }

        const faceapi = window.faceapi
        if (!faceapi) return

        await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL)
        loadedRef.current = true
      } catch (e) {
        console.warn('[FaceDetection] Failed to load model, disabling:', e)
        return
      }
    }

    const faceapi = window.faceapi
    if (!faceapi) return

    intervalRef.current = setInterval(async () => {
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.paused) return

      try {
        const result = await faceapi.detectSingleFace(
          video,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 })
        )

        const faceFound = !!result

        if (!faceFound && !faceAbsentRef.current) {
          // Face just disappeared
          faceAbsentRef.current = true
          noFaceStartRef.current = Date.now()
          onNoFaceRef.current?.()

          noFaceTimerRef.current = setTimeout(() => {
            if (faceAbsentRef.current) {
              onTimeoutRef.current?.()
            }
          }, NO_FACE_TIMEOUT_MS)
        } else if (faceFound && faceAbsentRef.current) {
          // Face came back
          faceAbsentRef.current = false
          noFaceStartRef.current = null
          if (noFaceTimerRef.current) clearTimeout(noFaceTimerRef.current)
          noFaceTimerRef.current = null
          onFaceBackRef.current?.()
        }
      } catch (e) {}
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