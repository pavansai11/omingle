import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const GUEST_COOKIE = 'hippichat_guest_id'
const GUEST_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

function generateGuestId() {
  return `guest_${crypto.randomUUID().replace(/-/g, '')}`
}

function isValidGuestId(id) {
  return typeof id === 'string' && /^guest_[a-f0-9]{32}$/.test(id)
}

// POST /api/auth/guest — create or retrieve guest session
export async function POST() {
  try {
    const cookieStore = cookies()
    const existing = cookieStore.get(GUEST_COOKIE)?.value

    const guestId = isValidGuestId(existing) ? existing : generateGuestId()

    const response = NextResponse.json({ guestId, isGuest: true })
    response.cookies.set(GUEST_COOKIE, guestId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: GUEST_MAX_AGE,
      path: '/',
    })
    return response
  } catch {
    return NextResponse.json({ error: 'Failed to create guest session' }, { status: 500 })
  }
}

// GET /api/auth/guest — retrieve existing guest session (no creation)
export async function GET() {
  try {
    const cookieStore = cookies()
    const guestId = cookieStore.get(GUEST_COOKIE)?.value

    if (isValidGuestId(guestId)) {
      return NextResponse.json({ guestId, isGuest: true })
    }
    return NextResponse.json({ guestId: null, isGuest: false })
  } catch {
    return NextResponse.json({ guestId: null, isGuest: false })
  }
}