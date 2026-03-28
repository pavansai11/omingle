import crypto from 'crypto'
import { getDatabase } from '@/lib/mongodb'

const SESSION_COOKIE_NAME = 'omingle_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7

const memoryUsers = new Map()
const memorySessions = new Map()

function normalizeUser(user) {
  if (!user) return null
  return {
    id: user.id || user.googleId || user._id?.toString(),
    googleId: user.googleId,
    name: user.name,
    email: user.email,
    image: user.customImage || user.image || null,
    customImage: user.customImage || null,
    primaryLanguage: user.primaryLanguage || null,
    additionalLanguages: Array.isArray(user.additionalLanguages) ? user.additionalLanguages : [],
    countryCode: user.countryCode || null,
    countryName: user.countryName || null,
    countryFlag: user.countryFlag || null,
    profileCompleted: !!user.profileCompleted,
  }
}

async function getCollections() {
  const db = await getDatabase()
  if (!db) return null

  return {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
  }
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME
}

export async function upsertGoogleUser(profile) {
  const user = {
    id: profile.sub,
    userId: profile.sub,
    googleId: profile.sub,
    name: profile.name || profile.email || 'HippiChat User',
    email: profile.email || '',
    image: profile.picture || null,
    updatedAt: new Date(),
  }

  const collections = await getCollections()
  if (!collections) {
    memoryUsers.set(user.googleId, { ...user, createdAt: new Date() })
    return normalizeUser(memoryUsers.get(user.googleId))
  }

  await collections.users.updateOne(
    { googleId: user.googleId },
    {
      $set: user,
      $setOnInsert: {
        createdAt: new Date(),
        primaryLanguage: null,
        additionalLanguages: [],
        profileCompleted: false,
      },
    },
    { upsert: true }
  )

  const stored = await collections.users.findOne({ googleId: user.googleId })
  return normalizeUser(stored)
}

export async function createUserSession(user) {
  const sessionId = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const session = {
    sessionId,
    userId: user.id,
    user,
    expiresAt,
    createdAt: new Date(),
  }

  const collections = await getCollections()
  if (!collections) {
    for (const [existingSessionId, existingSession] of memorySessions.entries()) {
      if (existingSession.userId === user.id) {
        memorySessions.delete(existingSessionId)
      }
    }
    memorySessions.set(sessionId, session)
    return session
  }

  await collections.sessions.deleteMany({ userId: user.id })
  await collections.sessions.insertOne(session)
  return session
}

export async function getUserSession(sessionId) {
  if (!sessionId) return null

  const collections = await getCollections()
  if (!collections) {
    const session = memorySessions.get(sessionId)
    if (!session) return null
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      memorySessions.delete(sessionId)
      return null
    }

    return {
      sessionId,
      user: normalizeUser(session.user),
      expiresAt: session.expiresAt,
    }
  }

  const session = await collections.sessions.findOne({ sessionId })
  if (!session) return null
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await collections.sessions.deleteOne({ sessionId })
    return null
  }

  let user = session.user || null
  if (!user && session.userId) {
    user = await collections.users.findOne({ $or: [{ userId: session.userId }, { googleId: session.userId }] })
  }

  return {
    sessionId,
    user: normalizeUser(user),
    expiresAt: session.expiresAt,
  }
}

export async function deleteUserSession(sessionId) {
  if (!sessionId) return

  const collections = await getCollections()
  if (!collections) {
    memorySessions.delete(sessionId)
    return
  }

  await collections.sessions.deleteOne({ sessionId })
}

export async function updateUserProfile(userId, updates) {
  if (!userId) return null

  const safeUpdates = {}
  if (typeof updates?.name === 'string') {
    safeUpdates.name = updates.name.trim()
  }
  if (typeof updates?.customImage === 'string') {
    safeUpdates.customImage = updates.customImage.trim() || null
  }
  if (updates?.primaryLanguage && typeof updates.primaryLanguage === 'object') {
    safeUpdates.primaryLanguage = updates.primaryLanguage
  }
  if (Array.isArray(updates?.additionalLanguages)) {
    safeUpdates.additionalLanguages = updates.additionalLanguages
  }
  if (typeof safeUpdates.primaryLanguage !== 'undefined' || typeof safeUpdates.additionalLanguages !== 'undefined') {
    safeUpdates.profileCompleted = !!safeUpdates.primaryLanguage
  }
  if (typeof updates?.countryCode === 'string') safeUpdates.countryCode = updates.countryCode
  if (typeof updates?.countryName === 'string') safeUpdates.countryName = updates.countryName
  if (typeof updates?.countryFlag === 'string') safeUpdates.countryFlag = updates.countryFlag

  if (Object.keys(safeUpdates).length === 0) {
    return null
  }

  const collections = await getCollections()
  if (!collections) {
    const existing = memoryUsers.get(userId)
    if (!existing) return null
    const next = { ...existing, ...safeUpdates, updatedAt: new Date() }
    memoryUsers.set(userId, next)

    for (const [sessionId, session] of memorySessions.entries()) {
      if (session.userId === userId) {
        memorySessions.set(sessionId, { ...session, user: { ...session.user, ...safeUpdates } })
      }
    }

    return normalizeUser(next)
  }

  await collections.users.updateOne(
    { $or: [{ userId }, { googleId: userId }] },
    { $set: { ...safeUpdates, updatedAt: new Date() } }
  )

  await collections.sessions.updateMany(
    { userId },
    { $set: Object.fromEntries(Object.entries(safeUpdates).map(([key, value]) => [`user.${key}`, value])) }
  )

  const stored = await collections.users.findOne({ $or: [{ userId }, { googleId: userId }] })
  return normalizeUser(stored)
}
