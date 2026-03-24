'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, LogOut } from 'lucide-react'

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID

export default function GoogleAuthButton({ compact = false, onUserChange, onOpenSettings, userOverride = null }) {
  const containerRef = useRef(null)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadSession() {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled) {
          setUser(data?.user || null)
        }
      } catch (err) {
        if (!cancelled) {
          setError('Unable to load session')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    onUserChange?.(user)
  }, [onUserChange, user])

  useEffect(() => {
    if (userOverride) {
      setUser(userOverride)
    }
  }, [userOverride])

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || user || loading || !containerRef.current) return

    let active = true

    async function renderGoogleButton() {
      try {
        if (!window.google?.accounts?.id) {
          await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-google-gsi]')
            if (existing) {
              existing.addEventListener('load', resolve, { once: true })
              existing.addEventListener('error', reject, { once: true })
              return
            }

            const script = document.createElement('script')
            script.src = 'https://accounts.google.com/gsi/client'
            script.async = true
            script.defer = true
            script.dataset.googleGsi = 'true'
            script.onload = resolve
            script.onerror = reject
            document.body.appendChild(script)
          })
        }

        if (!active || !window.google?.accounts?.id || !containerRef.current) return

        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async ({ credential }) => {
            setLoading(true)
            setError(null)
            try {
              const res = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential }),
              })

              const data = await res.json()
              if (!res.ok) {
                throw new Error(data?.error || 'Google sign-in failed')
              }

              setUser(data?.user || null)
            } catch (err) {
              setError(err?.message || 'Google sign-in failed')
            } finally {
              setLoading(false)
            }
          },
        })

        containerRef.current.innerHTML = ''
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: 'outline',
          size: compact ? 'medium' : 'large',
          shape: 'pill',
          text: compact ? 'signin' : 'signin_with',
          width: compact ? 180 : 240,
        })
      } catch (err) {
        setError('Google sign-in unavailable right now')
      }
    }

    renderGoogleButton()

    return () => {
      active = false
    }
  }, [compact, loading, user])

  async function handleLogout() {
    setLoading(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      setUser(null)
      setError(null)
      setMenuOpen(false)
      if (window.google?.accounts?.id) {
        window.google.accounts.id.disableAutoSelect()
      }
    } catch (err) {
      setError('Logout failed')
    } finally {
      setLoading(false)
    }
  }

  if (!GOOGLE_CLIENT_ID) {
    return null
  }

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/80 px-3 py-2 text-xs text-gray-300">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
      </div>
    )
  }

  if (user) {
    return (
      <div className="relative z-[80]">
        <button
          onClick={() => setMenuOpen((prev) => !prev)}
          className="rounded-full border border-gray-800 bg-gray-900/80 p-0.5"
          aria-label="Open user menu"
        >
          {user.image ? (
            <img
              src={user.image}
              alt={user.name || 'User'}
              className="h-9 w-9 rounded-full"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-white font-semibold">
              {(user.name || 'U').charAt(0).toUpperCase()}
            </div>
          )}
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-2 w-52 overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl z-[90]">
            <div className="border-b border-gray-800 px-4 py-3">
              <p className="truncate text-sm font-medium text-white">{user.name || 'Omingle User'}</p>
              <p className="truncate text-xs text-gray-500">{user.email}</p>
            </div>
            {onOpenSettings && (
              <button
                onClick={() => {
                  setMenuOpen(false)
                  onOpenSettings(user)
                }}
                className="w-full px-4 py-3 text-left text-sm text-gray-200 hover:bg-gray-800"
              >
                Settings
              </button>
            )}
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-200 hover:bg-gray-800"
            >
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div ref={containerRef} />
      {error && <p className="text-[11px] text-amber-300">{error}</p>}
    </div>
  )
}
