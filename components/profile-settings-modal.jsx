'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { ALL_LANGUAGES } from '@/lib/languages'

export default function ProfileSettingsModal({ open, user, onClose, onSaved }) {
  const [name, setName] = useState(user?.name || '')
  const [primaryLanguageCode, setPrimaryLanguageCode] = useState(user?.primaryLanguage?.code || 'en-US')
  const [additionalLanguageCodes, setAdditionalLanguageCodes] = useState(user?.additionalLanguages?.map(lang => lang.code) || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const availableAdditionalLanguages = useMemo(
    () => ALL_LANGUAGES.filter((lang) => lang.code !== primaryLanguageCode),
    [primaryLanguageCode]
  )

  useEffect(() => {
    setName(user?.name || '')
    setPrimaryLanguageCode(user?.primaryLanguage?.code || 'en-US')
    setAdditionalLanguageCodes(user?.additionalLanguages?.map(lang => lang.code) || [])
    setError(null)
  }, [user])

  if (!open) return null

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name cannot be empty')
      return
    }

    const primaryLanguage = ALL_LANGUAGES.find((lang) => lang.code === primaryLanguageCode)
    if (!primaryLanguage) {
      setError('Please choose a primary language')
      return
    }

    const additionalLanguages = ALL_LANGUAGES.filter((lang) => additionalLanguageCodes.includes(lang.code) && lang.code !== primaryLanguage.code)

    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          primaryLanguage,
          additionalLanguages,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to save profile')
      }
      onSaved?.(data.user)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Settings</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {user?.image ? (
              <img src={user.image} alt={user.name || 'User'} className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-white font-semibold text-lg">
                {(user?.name || 'U').charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-white">{user?.email || 'Signed in user'}</p>
              <p className="text-xs text-gray-500">
                {user?.countryFlag || '🌐'} {user?.countryName || 'Country updating from your network'}
              </p>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Display name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              placeholder="Enter your name"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Primary language</label>
            <select
              value={primaryLanguageCode}
              onChange={(e) => {
                const nextCode = e.target.value
                setPrimaryLanguageCode(nextCode)
                setAdditionalLanguageCodes((prev) => prev.filter((code) => code !== nextCode))
              }}
              className="w-full rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            >
              {ALL_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.flag} {lang.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Other languages</label>
            <div className="max-h-40 overflow-y-auto rounded-xl border border-gray-800 bg-gray-800/40 p-2">
              <div className="flex flex-wrap gap-2">
                {availableAdditionalLanguages.map((lang) => {
                  const active = additionalLanguageCodes.includes(lang.code)
                  return (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => {
                        setAdditionalLanguageCodes((prev) => (
                          active ? prev.filter((code) => code !== lang.code) : [...prev, lang.code].slice(0, 5)
                        ))
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs transition-all ${active
                        ? 'border-violet-500/50 bg-violet-600/20 text-violet-200'
                        : 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-700'}`}
                    >
                      {lang.flag} {lang.name}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500">Select up to 5 additional languages.</p>
          </div>

          {error && <p className="text-sm text-amber-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
