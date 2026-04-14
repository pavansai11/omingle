const { loadEnvConfig } = require('@next/env');
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const socialStore = require('./lib/social-store.cjs');
const redis = require('./lib/upstash-redis.cjs');

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');
const MAX_CHAT_MESSAGE_LENGTH = 1000;
const MAX_REPORT_DETAILS_LENGTH = 500;
const MAX_PROFILE_NAME_LENGTH = 60;
const MAX_IMAGE_URL_LENGTH = 500;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function generateId() {
  return Math.random().toString(36).substring(2, 12);
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

// ── Logging: only emit info/debug in dev; always emit errors ─────────────────
function logInfo(...args) {
  if (dev) console.log(...args);
}

function logWarn(...args) {
  if (dev) console.warn(...args);
}

function logError(...args) {
  // Sanitize: never log raw cookie values, user IDs, or IP addresses in production
  if (dev) {
    console.error(...args);
  } else {
    // In production, log sanitized error messages only
    const safe = args.map(a => (a instanceof Error ? a.message : typeof a === 'object' ? '[object]' : String(a))).join(' ');
    console.error('[error]', safe);
  }
}

function logDebug(...args) {
  if (dev) console.log('[debug]', ...args);
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
}

function sanitizeImageUrl(value) {
  const trimmed = sanitizeString(value, MAX_IMAGE_URL_LENGTH);
  if (typeof trimmed === 'undefined') return undefined;
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isValidGuestId(id) {
  return typeof id === 'string' && /^guest_[a-f0-9]{32}$/.test(id);
}

function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS || '';
  const parsed = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (parsed.length) return parsed;
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.NEXT_PUBLIC_BASE_URL || 'https://hippichat.com',
  ].filter(Boolean);
}

function assertProductionConfig() {
  if (dev) return;
  const missing = [];
  const hasMongo = !!(process.env.MONGODB_URI || process.env.MONGO_URL || (process.env.MONGO_USERNAME && process.env.MONGO_PASSWORD && process.env.MONGO_HOST));
  if (!hasMongo) missing.push('MongoDB configuration');
  if (!process.env.REDIS_URL) missing.push('REDIS_URL');
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
}

assertProductionConfig();

// ── IP extraction helper ─────────────────────────────────────────────────────
function getClientIp(handshake) {
  const forwarded = handshake?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return handshake?.address || 'unknown';
}

app.prepare().then(() => {
  // Purge stale legacy queue keys
  Promise.all([
    redis.delKey('hippichat:queue:v2').catch(() => null),
    redis.delKey('hippichat:queue-members:v3').catch(() => null),
    redis.delKey('hippichat:queue-members').catch(() => null),
  ]).catch(() => {});

  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      logError('Request handler error:', err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  const allowedOrigins = new Set(getAllowedOrigins());

  const { Server: SocketServer } = require('socket.io');
  const io = new SocketServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (dev || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'), false);
      },
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  const redisAdapter = redis.createSocketIoAdapter?.();
  if (redisAdapter) {
    io.adapter(redisAdapter);
    logInfo('[Socket] Redis adapter enabled');
  }

  // In-memory state
  const matchingInProgress = new Set();
  const rooms = new Map();
  const userSessions = new Map();
  const userReputation = new Map();
  const roomActions = new Map();
  const onlineUsers = new Map();
  const friendsByUser = new Map();
  const userProfiles = new Map();
  const pendingFriendInvites = new Map();
  const joinQueueTokens = new Map();

  // ── Bot/abuse protection ─────────────────────────────────────────────────
  // Track connections per IP to detect socket-flood bots
  const ipConnectionCounts = new Map(); // ip -> count
  const ipBanList = new Map(); // ip -> bannedUntil timestamp
  const IP_MAX_CONNECTIONS = 15; // max simultaneous sockets per IP
  const IP_BAN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  function isIpBanned(ip) {
    if (!ip || ip === 'unknown') return false;
    const bannedUntil = ipBanList.get(ip);
    if (!bannedUntil) return false;
    if (Date.now() > bannedUntil) { ipBanList.delete(ip); return false; }
    return true;
  }

  function trackIpConnection(ip, delta) {
    if (!ip || ip === 'unknown') return;
    const current = (ipConnectionCounts.get(ip) || 0) + delta;
    if (current <= 0) { ipConnectionCounts.delete(ip); return; }
    ipConnectionCounts.set(ip, current);
    if (delta > 0 && current > IP_MAX_CONNECTIONS) {
      ipBanList.set(ip, Date.now() + IP_BAN_DURATION_MS);
      logWarn('[Security] IP throttled for too many connections');
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  let connectedCount = 0;
  const PRESENCE_TTL_SECONDS = 180;
  const INVITE_TTL_SECONDS = 30;
  const QUEUE_TTL_SECONDS = 600;
  const ROOM_TTL_SECONDS = 2 * 60 * 60;
  const QUEUE_MEMBERS_VIDEO_KEY = 'hippichat:queue-members:v4:video';
  const QUEUE_MEMBERS_VOICE_KEY = 'hippichat:queue-members:v4:voice';

  function getQueueMembersKey(mode) {
    return normalizeMode(mode) === 'voice' ? QUEUE_MEMBERS_VOICE_KEY : QUEUE_MEMBERS_VIDEO_KEY;
  }
  const QUEUE_CLAIM_LOCK_PREFIX = 'hippichat:queue-claim:';

  function getQueueEntryKey(socketId) { return `hippichat:queue-entry:${socketId}`; }
  function getPresenceKey(identityId) { return `hippichat:presence:${identityId}`; }
  function getInviteKey(inviteId) { return `hippichat:invite:${inviteId}`; }
  function getRoomKey(roomId) { return `hippichat:room:${roomId}`; }

  async function setPresence(identityId, sockets) {
    if (!identityId) return;
    if (!sockets?.length) { await redis.delKey(getPresenceKey(identityId)).catch(() => null); return; }
    await redis.setJson(getPresenceKey(identityId), { userId: identityId, sockets, online: true, updatedAt: new Date().toISOString() }, PRESENCE_TTL_SECONDS).catch(() => null);
  }

  async function setPendingInvite(inviteId, invite) {
    if (!inviteId || !invite) return;
    await redis.setJson(getInviteKey(inviteId), {
      inviteId, inviterUserId: invite.inviterUserId, inviterSocketId: invite.inviterSocketId,
      inviteeUserId: invite.inviteeUserId, inviteeSocketId: invite.inviteeSocketId,
      mode: invite.mode, createdAt: new Date().toISOString(),
    }, INVITE_TTL_SECONDS).catch(() => null);
  }

  async function clearPendingInvite(inviteId) {
    if (!inviteId) return;
    await redis.delKey(getInviteKey(inviteId)).catch(() => null);
  }

  function getQueueClaimLockKey(socketId) { return `${QUEUE_CLAIM_LOCK_PREFIX}${socketId}`; }

  async function acquireQueueClaimLock(socketId, ttlSeconds = 5) {
    if (!socketId) return false;
    try {
      const result = await redis.command('SET', [getQueueClaimLockKey(socketId), '1', 'EX', ttlSeconds, 'NX']);
      return result === 'OK';
    } catch { return false; }
  }

  async function releaseQueueClaimLock(socketId) {
    if (!socketId) return;
    await redis.delKey(getQueueClaimLockKey(socketId)).catch(() => null);
  }

  async function addToRedisQueue(entry) {
    try {
      const entryMode = normalizeMode(entry.mode);
      const membersKey = getQueueMembersKey(entryMode);
      const otherMembersKey = entryMode === 'voice' ? QUEUE_MEMBERS_VIDEO_KEY : QUEUE_MEMBERS_VOICE_KEY;
      const entryData = {
        socketId: entry.socketId,
        identityId: getIdentityId(entry),
        mode: entryMode,
        interests: entry.interests || [],
        joinedAt: entry.joinedAt instanceof Date ? entry.joinedAt.toISOString() : (entry.joinedAt || new Date().toISOString()),
      };
      await Promise.all([
        redis.setJson(getQueueEntryKey(entry.socketId), entryData, QUEUE_TTL_SECONDS),
        redis.sadd(membersKey, entry.socketId),
        redis.expire(membersKey, QUEUE_TTL_SECONDS).catch(() => 0),
        redis.srem(otherMembersKey, entry.socketId).catch(() => 0),
      ]);
    } catch (err) {
      logError('[Redis] Failed to add to queue:', err);
    }
  }

  async function removeFromRedisQueue(socketId) {
    try {
      await Promise.all([
        redis.delKey(getQueueEntryKey(socketId)).catch(() => null),
        redis.srem(QUEUE_MEMBERS_VIDEO_KEY, socketId).catch(() => 0),
        redis.srem(QUEUE_MEMBERS_VOICE_KEY, socketId).catch(() => 0),
        releaseQueueClaimLock(socketId),
      ]);
    } catch (err) {
      logError('[Redis] Failed to remove from queue:', err);
    }
  }

  async function getRedisQueueLength() {
    try {
      const [video, voice] = await Promise.all([
        redis.scard(QUEUE_MEMBERS_VIDEO_KEY).catch(() => 0),
        redis.scard(QUEUE_MEMBERS_VOICE_KEY).catch(() => 0),
      ]);
      return (video || 0) + (voice || 0);
    } catch { return 0; }
  }

  async function findAndClaimFromRedisQueue(socketId, mode, interests = []) {
    const resolvedMode = normalizeMode(mode);
    const normalizedInterests = normalizeInterestKeywords(interests);
    const membersKey = getQueueMembersKey(resolvedMode);
    const members = await redis.smembers(membersKey).catch(() => []);
    const currentMembers = Array.isArray(members) ? members : [];
    const candidateIds = currentMembers.filter(id => id !== socketId && !matchingInProgress.has(id));
    if (!candidateIds.length) return null;

    const entries = await Promise.all(candidateIds.map(id => redis.getJson(getQueueEntryKey(id)).catch(() => null)));
    const candidates = entries
      .map(entry => (entry && normalizeMode(entry.mode) === resolvedMode ? entry : null))
      .filter(Boolean);
    if (!candidates.length) return null;

    candidates.sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
    const withOverlap = candidates
      .map(c => ({ entry: c, overlap: getMatchedInterests(normalizedInterests, c.interests || []) }))
      .filter(c => c.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length);
    const selected = withOverlap[0]?.entry || candidates[0];
    if (!selected) return null;

    if (matchingInProgress.has(selected.socketId) || matchingInProgress.has(socketId)) return null;

    const [sourceLocked, targetLocked] = await Promise.all([
      acquireQueueClaimLock(socketId),
      acquireQueueClaimLock(selected.socketId),
    ]);
    if (!sourceLocked || !targetLocked) {
      if (sourceLocked) await releaseQueueClaimLock(socketId);
      if (targetLocked) await releaseQueueClaimLock(selected.socketId);
      return null;
    }

    matchingInProgress.add(selected.socketId);
    matchingInProgress.add(socketId);

    try {
      const [selectedEntry, requesterEntry] = await Promise.all([
        redis.getJson(getQueueEntryKey(selected.socketId)).catch(() => null),
        redis.getJson(getQueueEntryKey(socketId)).catch(() => null),
      ]);
      if (!selectedEntry || !requesterEntry) return null;
      if (normalizeMode(selectedEntry.mode) !== resolvedMode || normalizeMode(requesterEntry.mode) !== resolvedMode) {
        logWarn('[Queue] Mode mismatch after lock — discarding claim');
        return null;
      }
      await Promise.all([
        redis.delKey(getQueueEntryKey(selected.socketId)).catch(() => null),
        redis.delKey(getQueueEntryKey(socketId)).catch(() => null),
        redis.srem(membersKey, selected.socketId, socketId).catch(() => 0),
      ]);
      return selected;
    } finally {
      matchingInProgress.delete(selected.socketId);
      matchingInProgress.delete(socketId);
      await Promise.all([releaseQueueClaimLock(socketId), releaseQueueClaimLock(selected.socketId)]);
    }
  }

  async function syncRoomSnapshot(roomId) {
    const room = rooms.get(roomId);
    if (!room) { await redis.delKey(getRoomKey(roomId)).catch(() => null); return; }
    const user1Session = userSessions.get(room.user1);
    const user2Session = userSessions.get(room.user2);
    await redis.setJson(getRoomKey(roomId), {
      roomId, user1SocketId: room.user1, user2SocketId: room.user2,
      user1Id: getIdentityId(user1Session), user2Id: getIdentityId(user2Session),
      mode: room.mode, matchedInterests: room.matchedInterests || [], startedAt: room.startedAt,
    }, ROOM_TTL_SECONDS).catch(() => null);
  }

  function queueBackground(task, label) {
    Promise.resolve(task).catch(err => {
      if (dev) logError(label, err?.message || err);
    });
  }

  function getLiveSocketIds(identityId) {
    if (!identityId) return [];
    const socketSet = onlineUsers.get(identityId);
    if (!socketSet || typeof socketSet[Symbol.iterator] !== 'function') return [];
    return [...socketSet].filter(sid => userSessions.has(sid));
  }

  function isSocketInSameRoom(socketIdA, socketIdB) {
    if (!socketIdA || !socketIdB) return false;
    const sessionA = userSessions.get(socketIdA);
    const sessionB = userSessions.get(socketIdB);
    if (!sessionA?.roomId || !sessionB?.roomId || sessionA.roomId !== sessionB.roomId) return false;
    const room = rooms.get(sessionA.roomId);
    if (!room) return false;
    return (room.user1 === socketIdA && room.user2 === socketIdB) || (room.user1 === socketIdB && room.user2 === socketIdA);
  }

  function logRuntimeStats(label = 'runtime') {
    if (!dev) return; // Don't log runtime internals in production
    const memory = process.memoryUsage();
    console.log(`[Runtime:${label}] rss=${Math.round(memory.rss / 1024 / 1024)}MB heapUsed=${Math.round(memory.heapUsed / 1024 / 1024)}MB rooms=${rooms.size} sessions=${userSessions.size}`);
  }

  function pruneRuntimeState() {
    const now = Date.now();
    const activeSocketIds = new Set(io.sockets.sockets.keys());

    queueBackground((async () => {
      const [videoMembers, voiceMembers] = await Promise.all([
        redis.smembers(QUEUE_MEMBERS_VIDEO_KEY).catch(() => []),
        redis.smembers(QUEUE_MEMBERS_VOICE_KEY).catch(() => []),
      ]);
      for (const [membersKey, members] of [[QUEUE_MEMBERS_VIDEO_KEY, videoMembers || []], [QUEUE_MEMBERS_VOICE_KEY, voiceMembers || []]]) {
        const validMembers = [];
        for (const socketId of members) {
          if (activeSocketIds.has(socketId)) {
            const entry = await redis.getJson(getQueueEntryKey(socketId)).catch(() => null);
            if (entry) {
              const joinedAt = new Date(entry.joinedAt || now).getTime();
              if (now - joinedAt < 10 * 60 * 1000) { validMembers.push(socketId); continue; }
            }
          }
          await redis.delKey(getQueueEntryKey(socketId)).catch(() => null);
        }
        if (validMembers.length !== members.length) {
          const staleMembers = members.filter(id => !validMembers.includes(id));
          if (staleMembers.length) await redis.srem(membersKey, ...staleMembers).catch(() => 0);
          if (validMembers.length) await redis.expire(membersKey, QUEUE_TTL_SECONDS).catch(() => 0);
        }
      }
    })(), '[Runtime] Failed to prune Redis queue');

    for (const [roomId, room] of rooms.entries()) {
      const startedAt = new Date(room.startedAt || now).getTime();
      if (!activeSocketIds.has(room.user1) || !activeSocketIds.has(room.user2) || now - startedAt > 2 * 60 * 60 * 1000) {
        rooms.delete(roomId); roomActions.delete(roomId);
      }
    }
    for (const [socketId] of userSessions.entries()) {
      if (!activeSocketIds.has(socketId)) userSessions.delete(socketId);
    }
    for (const [userId, sockets] of onlineUsers.entries()) {
      for (const sid of [...sockets]) { if (!activeSocketIds.has(sid)) sockets.delete(sid); }
      if (sockets.size === 0) onlineUsers.delete(userId);
    }
    for (const [inviteId, invite] of pendingFriendInvites.entries()) {
      if (!activeSocketIds.has(invite.inviterSocketId) || !activeSocketIds.has(invite.inviteeSocketId)) {
        if (invite.timeout) clearTimeout(invite.timeout);
        pendingFriendInvites.delete(inviteId);
      }
    }
    for (const [userId, rep] of userReputation.entries()) {
      const lastSeen = new Date(rep.lastSeen || now).getTime();
      if (!onlineUsers.has(userId) && now - lastSeen > 6 * 60 * 60 * 1000) userReputation.delete(userId);
    }
    for (const [socketId] of joinQueueTokens.entries()) {
      if (!activeSocketIds.has(socketId)) joinQueueTokens.delete(socketId);
    }
    for (const [userId, profile] of userProfiles.entries()) {
      const lastSeen = new Date(profile.lastSeen || now).getTime();
      if (!onlineUsers.has(userId) && now - lastSeen > 6 * 60 * 60 * 1000) userProfiles.delete(userId);
    }
    // Prune IP ban list
    for (const [ip, bannedUntil] of ipBanList.entries()) {
      if (Date.now() > bannedUntil) ipBanList.delete(ip);
    }
  }

  function normalizeInterestKeywords(rawKeywords = []) {
    return [...new Set(
      (Array.isArray(rawKeywords) ? rawKeywords : [])
        .map(k => String(k || '').trim().toLowerCase()).filter(Boolean).map(k => k.slice(0, 32))
    )].slice(0, 5);
  }

  function getMatchedInterests(interestsA = [], interestsB = []) {
    if (!interestsA.length || !interestsB.length) return [];
    const setB = new Set(interestsB);
    return interestsA.filter(k => setB.has(k));
  }

  function normalizeMode(mode) { return mode === 'voice' ? 'voice' : 'video'; }
  function parseMode(mode) { if (mode === 'video' || mode === 'voice') return mode; return null; }

  function getReportDedupeKey(reporterId, reportedId) { return `hippichat:report-dedupe:${reporterId}:${reportedId}`; }
  function getReportCountKey(reportedId) { return `hippichat:report-count:${reportedId}`; }
  function getUserBlockKey(identityId) { return `hippichat:user-block:${identityId}`; }

  async function getModerationBlock(identityId) {
    if (!identityId) return null;
    return redis.getJson(getUserBlockKey(identityId)).catch(() => null);
  }

  async function setModerationBlock(identityId, payload, ttlSeconds) {
    if (!identityId || !ttlSeconds) return;
    await redis.setJson(getUserBlockKey(identityId), payload, ttlSeconds).catch(() => null);
  }

  async function applyModerationThreshold(reportedId, reason = 'other') {
    if (!reportedId) return null;
    const severeReasons = new Set(['underage', 'nudity', 'hate-speech', 'threats']);
    const count = await redis.incr(getReportCountKey(reportedId), 60 * 60 * 24).catch(() => 1);
    let ttlSeconds = 0;
    if (severeReasons.has(reason)) ttlSeconds = 60 * 60 * 24;
    else if (count >= 3) ttlSeconds = 60 * 60 * 24;
    else if (count >= 2) ttlSeconds = 60 * 60;
    if (!ttlSeconds) return null;
    const blockedUntil = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const payload = { blockedUntil, reason, count };
    await setModerationBlock(reportedId, payload, ttlSeconds);
    return payload;
  }

  function formatBlockMessage(block) {
    if (!block?.blockedUntil) return 'Your account is temporarily restricted from matching.';
    return `Your account is temporarily restricted from matching until ${new Date(block.blockedUntil).toLocaleString()}.`;
  }

  function disconnectUserSockets(identityId, blockPayload) {
    const socketIds = getLiveSocketIds(identityId);
    if (!socketIds.length) return;
    for (const sid of socketIds) {
      io.to(sid).emit('account-blocked', { ...blockPayload, message: formatBlockMessage(blockPayload) });
      io.in(sid).disconnectSockets(true);
    }
  }

  async function enforceSingleActiveSocket(identityId, socketId) { return; }
  async function clearActiveSocket(identityId, socketId) { return; }

  async function broadcastStats() {
    const queueLength = await getRedisQueueLength().catch(() => 0);
    io.emit('stats', { online: connectedCount, queueLength, rooms: rooms.size });
    queueBackground(
      redis.setJson('hippichat:stats', { online: connectedCount, queueLength, rooms: rooms.size, updatedAt: new Date().toISOString() }, 180),
      '[Redis] Failed to sync stats'
    );
  }

  async function getReputationSnapshot(userId) {
    if (!userId) return { likesReceived: 0, reportsReceived: 0 };
    try {
      const stored = await socialStore.getUserReputation(userId);
      const next = { likesReceived: Number(stored?.likesReceived || 0), reportsReceived: Number(stored?.reportsReceived || 0), lastSeen: new Date() };
      userReputation.set(userId, next);
      return next;
    } catch {
      const cached = userReputation.get(userId) || { likesReceived: 0, reportsReceived: 0, lastSeen: new Date() };
      cached.lastSeen = new Date();
      userReputation.set(userId, cached);
      return cached;
    }
  }

  async function incrementReputation(userId, deltas = {}) {
    if (!userId) return { likesReceived: 0, reportsReceived: 0 };
    try {
      const updated = await socialStore.incrementUserReputation(userId, deltas);
      const next = { likesReceived: Number(updated?.likesReceived || 0), reportsReceived: Number(updated?.reportsReceived || 0), lastSeen: new Date() };
      userReputation.set(userId, next);
      return next;
    } catch {
      const cached = userReputation.get(userId) || { likesReceived: 0, reportsReceived: 0, lastSeen: new Date() };
      cached.likesReceived = Math.max(0, Number(cached.likesReceived || 0) + Number(deltas?.likesReceived || 0));
      cached.reportsReceived = Math.max(0, Number(cached.reportsReceived || 0) + Number(deltas?.reportsReceived || 0));
      cached.lastSeen = new Date();
      userReputation.set(userId, cached);
      return cached;
    }
  }

  function getRoomPartnerId(room, socketId) {
    return room.user1 === socketId ? room.user2 : room.user1;
  }

  function requireAuthenticatedUser(socket, actionType = 'auth') {
    const authUser = socket.data?.authUser || null;
    if (!authUser?.id) {
      socket.emit('action-feedback', { type: actionType, status: 'unauthorized' });
      return null;
    }
    return authUser;
  }

  function getIdentityId(session) {
    if (!session) return null;
    return session.userId || session.anonUserId || `guest_${session.socketId}`;
  }

  function buildProfileSnapshot(session) {
    return {
      userId: getIdentityId(session),
      name: session.isGuest ? 'Guest' : (session.displayName || `User ${String(getIdentityId(session) || '').slice(-4)}`),
      email: session.isGuest ? '' : (session.email || ''),
      image: session.isGuest ? null : (session.image || null),
      countryCode: session.country?.countryCode || null,
      countryName: session.country?.countryName || 'Unknown',
      countryFlag: session.country?.countryFlag || '🌐',
    };
  }

  function resolveCountryPayload(sessionCountry, fallbackProfile = null) {
    if (sessionCountry?.countryName && sessionCountry.countryName !== 'Unknown') return sessionCountry;
    if (fallbackProfile?.countryName && fallbackProfile.countryName !== 'Unknown') {
      return { countryCode: fallbackProfile.countryCode || null, countryName: fallbackProfile.countryName, countryFlag: fallbackProfile.countryFlag || '🌐' };
    }
    return { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' };
  }

  function regionCodeToFlag(regionCode) {
    if (!regionCode || regionCode.length !== 2) return '🌐';
    return regionCode.toUpperCase().split('').map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
  }

  function countryNameFromRegion(regionCode) {
    if (!regionCode) return 'Unknown';
    try { const display = new Intl.DisplayNames(['en'], { type: 'region' }); return display.of(regionCode.toUpperCase()) || regionCode.toUpperCase(); }
    catch { return regionCode.toUpperCase(); }
  }

  function getSessionLanguageMap(session) {
    const map = new Map();
    const all = [session?.primaryLanguage, ...(session?.spokenLanguages || [])];
    for (const lang of all) {
      if (!lang?.code) continue;
      if (!map.has(lang.code)) map.set(lang.code, { code: lang.code, name: lang.name || lang.code });
    }
    return map;
  }

  function getCommonLanguages(sessionA, sessionB) {
    const aMap = getSessionLanguageMap(sessionA);
    const bMap = getSessionLanguageMap(sessionB);
    const common = [];
    for (const [code, lang] of aMap.entries()) { if (bMap.has(code)) common.push(lang); }
    return common.slice(0, 5);
  }

  function addOnlineSocket(anonUserId, socketId) {
    if (!anonUserId) return;
    if (!onlineUsers.has(anonUserId)) onlineUsers.set(anonUserId, new Set());
    onlineUsers.get(anonUserId).add(socketId);
    queueBackground(setPresence(anonUserId, [...onlineUsers.get(anonUserId)]), '[Redis] Failed to sync presence');
  }

  function removeOnlineSocket(anonUserId, socketId) {
    if (!anonUserId || !onlineUsers.has(anonUserId)) return;
    const sockets = onlineUsers.get(anonUserId);
    sockets.delete(socketId);
    if (sockets.size === 0) onlineUsers.delete(anonUserId);
    queueBackground(setPresence(anonUserId, [...sockets]), '[Redis] Failed to sync presence remove');
  }

  function isUserOnline(anonUserId) {
    return !!(anonUserId && onlineUsers.has(anonUserId) && onlineUsers.get(anonUserId).size > 0);
  }

  function getOnlineSocketIdForUser(anonUserId) {
    const socketIds = getLiveSocketIds(anonUserId);
    if (!socketIds.length) return null;
    for (const sid of socketIds) { if (userSessions.has(sid)) return sid; }
    return null;
  }

  function ensureFriendSet(anonUserId) {
    if (!friendsByUser.has(anonUserId)) friendsByUser.set(anonUserId, new Set());
    return friendsByUser.get(anonUserId);
  }

  async function getFriendsPayload(identityId) {
    const friends = await socialStore.listFriends(identityId);
    return friends.map(friend => ({
      friendAnonId: friend.friendUserId, friendUserId: friend.friendUserId,
      online: isUserOnline(friend.friendUserId),
      countryName: friend.countryName || 'Unknown', countryFlag: friend.countryFlag || '🌐',
      name: friend.name || `User ${String(friend.friendUserId || '').slice(-4)}`,
      image: friend.image || null,
    }));
  }

  async function emitFriendsStatus(identityId) {
    if (!identityId) return;
    const payload = await getFriendsPayload(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      // Don't send social data to guests
      const session = userSessions.get(sid);
      if (session?.isGuest) continue;
      io.to(sid).emit('friends-status', { friends: payload });
    }
  }

  async function emitFriendRequests(identityId) {
    if (!identityId) return;
    const incoming = await socialStore.listPendingRequests(identityId);
    const outgoing = await socialStore.listOutgoingRequests(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      const session = userSessions.get(sid);
      if (session?.isGuest) continue;
      io.to(sid).emit('friend-requests', { incoming, outgoing });
    }
  }

  async function emitHistory(identityId) {
    if (!identityId) return;
    const history = await socialStore.listHistory(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      const session = userSessions.get(sid);
      if (session?.isGuest) continue;
      io.to(sid).emit('history-updated', { history });
    }
  }

  async function refreshSocialViews(identityId) {
    if (!identityId) return;
    // Skip social view refresh for guests — they have no social data
    const socketIds = getLiveSocketIds(identityId);
    const isGuestIdentity = socketIds.some(sid => userSessions.get(sid)?.isGuest);
    if (isGuestIdentity) return;

    await emitFriendsStatus(identityId);
    await emitFriendRequests(identityId);
    await emitHistory(identityId);

    const friends = await socialStore.listFriends(identityId);
    for (const friend of friends) {
      if (friend?.friendUserId && onlineUsers.has(friend.friendUserId)) {
        await emitFriendsStatus(friend.friendUserId);
      }
    }
  }

  async function notifyFriendsOnlineStatusChanged(identityId) {
    if (!identityId) return;
    // Guests don't participate in friend online status
    const socketIds = getLiveSocketIds(identityId);
    const isGuestIdentity = socketIds.some(sid => userSessions.get(sid)?.isGuest);
    if (isGuestIdentity) return;

    const friends = await socialStore.listFriends(identityId);
    const online = isUserOnline(identityId);
    for (const friend of friends) {
      const fSocketIds = getLiveSocketIds(friend.friendUserId);
      if (!fSocketIds.length) continue;
      for (const sid of fSocketIds) {
        io.to(sid).emit('friend-online-status', { friendAnonId: identityId, friendUserId: identityId, online });
      }
    }
  }

  async function emitMatchedPair(socketIdA, sessionA, socketIdB, sessionB, options = {}) {
    const roomId = options.roomId || generateId();
    const resolvedMode = normalizeMode(options.mode || sessionA.mode || sessionB.mode);
    const modeA = normalizeMode(sessionA.mode);
    const modeB = normalizeMode(sessionB.mode);
    if (modeA !== resolvedMode || modeB !== resolvedMode || modeA !== modeB) {
      logWarn('[Match] Mode mismatch — refusing to pair');
      return null;
    }
    const matchedInterests = getMatchedInterests(sessionA.interests || [], sessionB.interests || []);

    rooms.set(roomId, { user1: socketIdA, user2: socketIdB, mode: resolvedMode, startedAt: new Date(), viaFriend: !!options.viaFriend, matchedInterests });
    roomActions.set(roomId, { likes: new Set(), reports: new Set() });
    sessionA.roomId = roomId;
    sessionB.roomId = roomId;

    const repA = await getReputationSnapshot(getIdentityId(sessionA));
    const repB = await getReputationSnapshot(getIdentityId(sessionB));
    const commonLanguages = getCommonLanguages(sessionA, sessionB);

    io.to(socketIdA).emit('matched', {
      roomId, partnerId: socketIdB,
      partnerUserId: getIdentityId(sessionB),
      partnerProfile: buildProfileSnapshot(sessionB),
      partnerLanguage: sessionB.primaryLanguage,
      partnerCountry: resolveCountryPayload(sessionB.country, userProfiles.get(getIdentityId(sessionB))),
      partnerLikes: sessionB.isGuest ? 0 : repB.likesReceived,
      mode: resolvedMode, commonLanguages, matchedInterests,
      isFriendConnection: !!options.viaFriend, isInitiator: true,
    });

    io.to(socketIdB).emit('matched', {
      roomId, partnerId: socketIdA,
      partnerUserId: getIdentityId(sessionA),
      partnerProfile: buildProfileSnapshot(sessionA),
      partnerLanguage: sessionA.primaryLanguage,
      partnerCountry: resolveCountryPayload(sessionA.country, userProfiles.get(getIdentityId(sessionA))),
      partnerLikes: sessionA.isGuest ? 0 : repA.likesReceived,
      mode: resolvedMode, commonLanguages, matchedInterests,
      isFriendConnection: !!options.viaFriend, isInitiator: false,
    });

    // Only record history for non-guest sessions
    if (!sessionA.isGuest || !sessionB.isGuest) {
      socialStore.recordMatchHistoryForUsers(buildProfileSnapshot(sessionA), buildProfileSnapshot(sessionB), {
        roomId, mode: resolvedMode, connectedAt: new Date(),
      }).catch(() => {});
    }

    syncRoomSnapshot(roomId);
    return roomId;
  }

  async function findMatch(socketId, mode, interests = []) {
    return findAndClaimFromRedisQueue(socketId, mode, interests);
  }

  async function leaveRoom(socket) {
    const session = userSessions.get(socket.id);
    if (!session || !session.roomId) return;
    const roomId = session.roomId;
    const room = rooms.get(roomId);
    if (room) {
      const partnerId = getRoomPartnerId(room, socket.id);
      io.to(partnerId).emit('partner-left');
      const partnerSession = userSessions.get(partnerId);
      if (partnerSession) partnerSession.roomId = null;
      rooms.delete(roomId);
      roomActions.delete(roomId);
      queueBackground(syncRoomSnapshot(roomId), '[Redis] Failed to sync room removal');
    }
    session.roomId = null;
  }

  async function removeFromQueue(socketId) {
    const session = userSessions.get(socketId);
    if (session) session.inQueue = false;
    await removeFromRedisQueue(socketId);
  }

  // ── Socket auth middleware ──────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const clientIp = getClientIp(socket.handshake);

      // IP ban check
      if (isIpBanned(clientIp)) {
        return next(new Error('Too many connections'));
      }

      const cookies = parseCookies(socket.handshake.headers.cookie || '');

      // Try Google/OAuth session first
      const sessionId = cookies.omingle_session;
      let authUser = null;
      try {
        authUser = sessionId ? await socialStore.getUserBySessionId(sessionId) : null;
      } catch {
        authUser = null;
      }

      socket.data.authUser = authUser;
      socket.data.clientIp = clientIp;

      // If no OAuth session, check for guest cookie
      if (!authUser) {
        const guestId = cookies.hippichat_guest_id;
        if (isValidGuestId(guestId)) {
          socket.data.isGuest = true;
          socket.data.guestId = guestId;
        } else {
          socket.data.isGuest = false;
        }
      } else {
        socket.data.isGuest = false;
      }

      return next();
    } catch {
      socket.data.authUser = null;
      socket.data.isGuest = false;
      return next();
    }
  });

  io.on('connection', (socket) => {
    const clientIp = socket.data?.clientIp || 'unknown';
    trackIpConnection(clientIp, 1);

    connectedCount += 1;
    queueBackground((async () => {
      const queueLength = await getRedisQueueLength().catch(() => 0);
      socket.emit('stats', { online: connectedCount, queueLength, rooms: rooms.size });
    })(), '[Stats] Failed to emit initial stats');
    queueBackground(broadcastStats(), '[Stats] Failed to broadcast on connect');

    socket.on('identify-user', async (data = {}) => {
      const existing = userSessions.get(socket.id) || { socketId: socket.id, spokenLanguages: [], roomId: null };
      const previousIdentityId = getIdentityId(existing);
      const authUser = socket.data?.authUser || null;
      const isGuest = !authUser && (socket.data?.isGuest || false);

      const guestAnonId = socket.data?.guestId || null;

      const session = {
        ...existing,
        socketId: socket.id,
        isGuest,
        // For guests: use their persistent guest cookie ID as the anonUserId
        anonUserId: isGuest
          ? (guestAnonId || data.anonUserId || `guest_${socket.id}`)
          : (data.anonUserId || existing.anonUserId || `guest_${socket.id}`),
        userId: isGuest ? null : (authUser?.id || existing.userId || null),
        displayName: isGuest ? null : (authUser?.name || existing.displayName || null),
        email: isGuest ? '' : (authUser?.email || existing.email || ''),
        image: isGuest ? null : (authUser?.image || existing.image || null),
        country: data.country?.countryName ? data.country : existing.country || null,
        joinedAt: existing.joinedAt || new Date(),
      };

      userSessions.set(socket.id, session);
      const identityId = getIdentityId(session);
      if (!identityId) return;

      session.country = resolveCountryPayload(session.country, userProfiles.get(identityId));
      userSessions.set(socket.id, session);

      await enforceSingleActiveSocket(identityId, socket.id);

      if (previousIdentityId && previousIdentityId !== identityId) removeOnlineSocket(previousIdentityId, socket.id);
      addOnlineSocket(identityId, socket.id);

      if (!isGuest) {
        queueBackground(getReputationSnapshot(identityId), '[Reputation] Failed to load reputation');
        const storedProfile = {
          userId: identityId,
          name: authUser?.name || session.displayName || `User ${String(identityId || '').slice(-4)}`,
          email: session.email || '', image: session.image || null,
          countryCode: session.country?.countryCode || null,
          countryName: session.country?.countryName || 'Unknown',
          countryFlag: session.country?.countryFlag || '🌐',
          lastSeen: new Date(),
        };
        userProfiles.set(identityId, storedProfile);
        queueBackground(socialStore.upsertUserProfile(storedProfile), '[Profile] Failed to upsert profile');
        queueBackground(refreshSocialViews(identityId), '[Social] Failed to refresh social views');
        queueBackground(notifyFriendsOnlineStatusChanged(identityId), '[Social] Failed to notify friends');
      }
    });

    socket.on('join-queue', async (data) => {
      const { primaryLanguage, spokenLanguages, mode, anonUserId, country, interestKeywords } = data;
      const requestedMode = normalizeMode(mode);
      const authUser = socket.data?.authUser || null;
      const isGuest = !authUser && (socket.data?.isGuest || false);
      const guestAnonId = socket.data?.guestId || null;

      const joinToken = generateId();
      joinQueueTokens.set(socket.id, joinToken);
      const isThisJoinCurrent = () => joinQueueTokens.get(socket.id) === joinToken;

      const effectiveIdentityId = isGuest
        ? (guestAnonId || anonUserId || `guest_${socket.id}`)
        : (authUser?.id || anonUserId || `guest_${socket.id}`);

      const [, , moderationBlock] = await Promise.all([
        leaveRoom(socket),
        removeFromQueue(socket.id),
        getModerationBlock(effectiveIdentityId),
      ]);

      if (!isThisJoinCurrent()) return;

      const session = {
        socketId: socket.id,
        isGuest,
        primaryLanguage,
        spokenLanguages: spokenLanguages || [],
        mode: requestedMode,
        anonUserId: isGuest ? (guestAnonId || anonUserId || `guest_${socket.id}`) : (anonUserId || `guest_${socket.id}`),
        userId: isGuest ? null : (authUser?.id || null),
        displayName: isGuest ? null : (authUser?.name || null),
        email: isGuest ? '' : (authUser?.email || ''),
        image: isGuest ? null : (authUser?.image || null),
        country: country?.countryName ? country : { countryCode: null, countryName: 'Unknown', countryFlag: '🌐' },
        interests: normalizeInterestKeywords(interestKeywords),
        roomId: null,
        joinedAt: new Date(),
      };
      userSessions.set(socket.id, session);
      const identityId = getIdentityId(session);
      session.country = resolveCountryPayload(session.country, userProfiles.get(identityId));
      session.inQueue = true;
      userSessions.set(socket.id, session);

      if (moderationBlock?.blockedUntil) {
        socket.emit('account-blocked', { ...moderationBlock, message: formatBlockMessage(moderationBlock) });
        return;
      }

      // Rate limit guests more aggressively on join-queue
      if (isGuest) {
        const guestQueueKey = `hippichat:rate:guest-queue:${identityId}`;
        const allowed = await redis.checkRateLimit(guestQueueKey, 30, 60).catch(() => true);
        if (!allowed) {
          socket.emit('account-blocked', { message: 'Too many attempts. Please wait a moment.' });
          return;
        }
      }

      addOnlineSocket(identityId, socket.id);

      if (!isGuest) {
        const storedProfile = {
          userId: identityId, name: authUser?.name || `User ${String(identityId || '').slice(-4)}`,
          email: session.email || '', image: session.image || null,
          countryCode: session.country?.countryCode || null,
          countryName: session.country?.countryName || 'Unknown',
          countryFlag: session.country?.countryFlag || '🌐',
          lastSeen: new Date(),
        };
        userProfiles.set(identityId, storedProfile);
        queueBackground(socialStore.upsertUserProfile(storedProfile), '[Profile] Failed to upsert queue profile');
        queueBackground(emitFriendsStatus(identityId), '[Social] Failed to emit friends status');
        queueBackground(emitFriendRequests(identityId), '[Social] Failed to emit friend requests');
        queueBackground(emitHistory(identityId), '[Social] Failed to emit history');
        queueBackground(notifyFriendsOnlineStatusChanged(identityId), '[Social] Failed to notify friends online status');
      }

      await addToRedisQueue(session);

      if (!isThisJoinCurrent()) {
        await removeFromRedisQueue(socket.id);
        return;
      }

      // Continuation of join-queue handler
      let match = await findMatch(socket.id, session.mode, session.interests);

      if (!match) {
        for (const delayMs of [250, 500]) {
          await new Promise(r => setTimeout(r, delayMs));
          const currentSession = userSessions.get(socket.id);
          if (!currentSession?.inQueue || currentSession?.roomId) break;
          match = await findMatch(socket.id, session.mode, session.interests);
          if (match) break;
        }
      }

      if (match) {
        const matchSession = userSessions.get(match.socketId);
        if (!matchSession) {
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', { position: queueLength, queueLength, interests: session.interests });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after stale match');
          return;
        }

        if (normalizeMode(matchSession.mode) !== session.mode) {
          matchSession.inQueue = true;
          await addToRedisQueue(matchSession);
          session.inQueue = true;
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', { position: queueLength, queueLength, interests: session.interests });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after mode mismatch');
          return;
        }

        const roomId = await emitMatchedPair(match.socketId, matchSession, socket.id, session, { mode: session.mode });

        if (!roomId) {
          await addToRedisQueue(matchSession);
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', { position: queueLength, queueLength, interests: session.interests });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after failed match');
          return;
        }

        queueBackground(broadcastStats(), '[Stats] Failed to broadcast after match');
      } else {
        const queueLength = await getRedisQueueLength().catch(() => 0);
        socket.emit('queue-status', { position: queueLength, queueLength, interests: session.interests });
        queueBackground(broadcastStats(), '[Stats] Failed to broadcast after queue add');
      }
    });

    socket.on('leave-queue', async () => {
      await removeFromQueue(socket.id);
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after leave-queue');
    });

    socket.on('signal', (data) => {
      const targetSocketId = sanitizeString(data?.to, 128);
      const signalType = sanitizeString(data?.type, 32);
      if (!targetSocketId || !signalType) return;
      if (!isSocketInSameRoom(socket.id, targetSocketId)) return;
      io.to(targetSocketId).emit('signal', {
        type: signalType, from: socket.id, to: targetSocketId, payload: data?.payload,
      });
    });

    socket.on('send-message', async (data) => {
      try {
        const session = userSessions.get(socket.id);
        const identityId = getIdentityId(session);
        // Rate limit: guests get stricter limits
        const limit = session?.isGuest ? 20 : 40;
        const allowed = await redis.checkRateLimit(`hippichat:rate:message:${socket.id}`, limit, 15);
        if (!allowed) { socket.emit('action-feedback', { type: 'message', status: 'rate-limited' }); return; }
      } catch {}

      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      const safeMessage = sanitizeString(data?.message, MAX_CHAT_MESSAGE_LENGTH);
      const safeFromLang = sanitizeString(data?.fromLang, 32) || null;
      if (!safeMessage) return;
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      io.to(partnerId).emit('receive-message', {
        id: generateId(), text: safeMessage, fromLang: safeFromLang, timestamp: new Date().toISOString(),
      });
    });

    socket.on('update-profile', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      const authUser = requireAuthenticatedUser(socket, 'profile');
      if (!authUser) return;

      const identityId = getIdentityId(session);
      const nextName = sanitizeString(data?.name, MAX_PROFILE_NAME_LENGTH) || '';
      const nextCustomImage = sanitizeImageUrl(data?.customImage);
      if (nextCustomImage === null) { socket.emit('action-feedback', { type: 'profile', status: 'invalid-image-url' }); return; }
      if (!identityId || (!nextName && typeof nextCustomImage === 'undefined')) return;

      if (nextName) session.displayName = nextName;
      if (typeof nextCustomImage !== 'undefined') session.image = nextCustomImage || authUser?.image || null;
      userSessions.set(socket.id, session);

      const nextProfile = {
        userId: identityId, name: nextName || session.displayName, email: session.email || '',
        image: session.image || null,
        customImage: typeof nextCustomImage !== 'undefined' ? (nextCustomImage || null) : (userProfiles.get(identityId)?.customImage || null),
        countryName: session.country?.countryName || 'Unknown', countryFlag: session.country?.countryFlag || '🌐', lastSeen: new Date(),
      };

      socket.data.authUser = { ...authUser, name: nextName || authUser?.name, image: session.image || authUser?.image || null };
      userProfiles.set(identityId, nextProfile);
      await socialStore.upsertUserProfile(nextProfile);
      await refreshSocialViews(identityId);
    });

    socket.on('like-partner', async () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;

      const actorAnon = getIdentityId(session);
      const actions = roomActions.get(session.roomId) || { likes: new Set(), reports: new Set() };

      if (actions.likes.has(actorAnon)) { socket.emit('action-feedback', { type: 'like', status: 'duplicate' }); return; }
      actions.likes.add(actorAnon);
      roomActions.set(session.roomId, actions);

      const partnerId = getRoomPartnerId(room, socket.id);
      const partnerSession = userSessions.get(partnerId);
      if (!partnerSession) return;

      // Guests can like, but their partner doesn't receive the like notification
      // (and guests themselves don't accumulate likes in reputation)
      const partnerAnon = getIdentityId(partnerSession);

      if (!partnerSession.isGuest) {
        // Only increment reputation for non-guest recipients
        const partnerRep = await incrementReputation(partnerAnon, { likesReceived: 1 });
        socket.emit('partner-likes-updated', { likes: partnerRep.likesReceived });
        io.to(partnerId).emit('received-like', { totalLikes: partnerRep.likesReceived });
      } else {
        // Partner is a guest — still show the like-updated count locally but don't persist
        socket.emit('partner-likes-updated', { likes: 0 });
      }

      socket.emit('action-feedback', { type: 'like', status: 'ok' });
    });

    socket.on('report-partner', async (data) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const explicitReportedId = sanitizeString(data?.targetUserId, 128) || null;
      const effectiveRoomId = session.roomId || data?.roomId || null;
      const room = effectiveRoomId ? rooms.get(effectiveRoomId) : null;

      const actorAnon = getIdentityId(session);
      const actions = effectiveRoomId ? (roomActions.get(effectiveRoomId) || { likes: new Set(), reports: new Set() }) : { likes: new Set(), reports: new Set() };
      const reason = sanitizeString(data?.reason, 40) || 'other';
      const details = sanitizeString(data?.details, MAX_REPORT_DETAILS_LENGTH) || '';

      if (effectiveRoomId && actions.reports.has(actorAnon)) { socket.emit('action-feedback', { type: 'report', status: 'duplicate' }); return; }
      if (effectiveRoomId) { actions.reports.add(actorAnon); roomActions.set(effectiveRoomId, actions); }

      const partnerId = room ? getRoomPartnerId(room, socket.id) : null;
      const partnerSession = partnerId ? userSessions.get(partnerId) : null;
      const partnerAnon = explicitReportedId || (partnerSession ? getIdentityId(partnerSession) : (partnerId ? `guest_${partnerId}` : null));
      if (!partnerAnon) return;

      const partnerRep = await incrementReputation(partnerAnon, { reportsReceived: 1 });

      queueBackground((async () => {
        const dedupeKey = getReportDedupeKey(actorAnon, partnerAnon);
        const alreadyCounted = await redis.getJson(dedupeKey).catch(() => null);
        if (!alreadyCounted) {
          await redis.setJson(dedupeKey, true, 60 * 60 * 24).catch(() => null);
          const blockPayload = await applyModerationThreshold(partnerAnon, reason);
          if (blockPayload) disconnectUserSockets(partnerAnon, blockPayload);
        }
        await socialStore.createReport({
          reporterId: actorAnon, reportedId: partnerAnon, roomId: effectiveRoomId,
          reason, details,
          reporterProfile: buildProfileSnapshot(session),
          reportedProfile: partnerSession ? buildProfileSnapshot(partnerSession) : null,
        });
      })(), '[Moderation] Failed to persist report');

      if (room && session.roomId) { await leaveRoom(socket); socket.emit('partner-left'); }
      socket.emit('action-feedback', { type: 'report', status: 'ok' });
      socket.emit('report-submitted', { ok: true });
    });

    // Social features — block guests from all friend/social socket actions
    socket.on('send-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) { socket.emit('action-feedback', { type: 'friend-request', status: 'unauthorized' }); return; }
      if (!requireAuthenticatedUser(socket, 'friend-request')) return;

      const requesterId = getIdentityId(session);
      let recipientId = sanitizeString(data?.targetUserId, 128) || null;

      if (!recipientId && session.roomId) {
        const room = rooms.get(session.roomId);
        if (room) {
          const partnerId = getRoomPartnerId(room, socket.id);
          const partnerSession = userSessions.get(partnerId);
          if (partnerSession?.isGuest) { socket.emit('action-feedback', { type: 'friend-request', status: 'guest-not-supported' }); return; }
          recipientId = getIdentityId(partnerSession);
        }
      }
      if (!requesterId || !recipientId) return;

      const allowed = await redis.checkRateLimit(`hippichat:rate:friend-request:${requesterId}`, 10, 60).catch(() => true);
      if (!allowed) { socket.emit('action-feedback', { type: 'friend-request', status: 'rate-limited' }); return; }

      const result = await socialStore.createFriendRequest({ requesterId, recipientId });
      socket.emit('action-feedback', { type: 'friend-request', status: result.status === 'created' ? 'ok' : result.status });

      await refreshSocialViews(requesterId);
      if (onlineUsers.has(recipientId)) {
        await refreshSocialViews(recipientId);
        const socketIds = getLiveSocketIds(recipientId);
        for (const sid of socketIds) { io.to(sid).emit('friend-request-received', { fromUserId: requesterId }); }
      }
    });

    socket.on('accept-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      if (!requireAuthenticatedUser(socket, 'friend-request-accept')) return;
      const myUserId = getIdentityId(session);
      const result = await socialStore.acceptFriendRequest({ requestId: data.requestId, userId: myUserId });
      if (result.status !== 'accepted') { socket.emit('action-feedback', { type: 'friend-request-accept', status: result.status }); return; }
      const otherUserId = result.request.requesterId;
      await refreshSocialViews(myUserId);
      if (onlineUsers.has(otherUserId)) await refreshSocialViews(otherUserId);
      socket.emit('action-feedback', { type: 'friend-request-accept', status: 'ok' });
    });

    socket.on('reject-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      if (!requireAuthenticatedUser(socket, 'friend-request-reject')) return;
      const myUserId = getIdentityId(session);
      const result = await socialStore.rejectFriendRequest({ requestId: data.requestId, userId: myUserId });
      if (result.status !== 'rejected') { socket.emit('action-feedback', { type: 'friend-request-reject', status: result.status }); return; }
      await refreshSocialViews(myUserId);
      socket.emit('action-feedback', { type: 'friend-request-reject', status: 'ok' });
    });

    socket.on('connect-friend', async (data) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) { socket.emit('friend-connect-result', { ok: false, reason: 'unauthorized' }); return; }
      const friendAnonId = sanitizeString(data?.friendAnonId, 128);
      const explicitRequestedMode = parseMode(data?.mode);
      if (typeof data?.mode !== 'undefined' && !explicitRequestedMode) { socket.emit('friend-connect-result', { ok: false, reason: 'invalid-mode' }); return; }
      const requestedMode = explicitRequestedMode || null;
      if (!requireAuthenticatedUser(socket, 'friend-connect')) return;

      const myAnon = getIdentityId(session);
      const myFriends = await socialStore.listFriends(myAnon);
      if (!myFriends.some(friend => friend.friendUserId === friendAnonId)) { socket.emit('friend-connect-result', { ok: false, reason: 'not-friends' }); return; }

      const friendSocketId = getOnlineSocketIdForUser(friendAnonId);
      if (!friendSocketId) { socket.emit('friend-connect-result', { ok: false, reason: 'offline' }); return; }
      const friendSession = userSessions.get(friendSocketId);
      if (!friendSession) { socket.emit('friend-connect-result', { ok: false, reason: 'offline' }); return; }
      const friendSocket = io.sockets.sockets.get(friendSocketId);
      if (!friendSocket) { socket.emit('friend-connect-result', { ok: false, reason: 'offline' }); return; }

      const inviteId = generateId();
      const resolvedInviteMode = requestedMode || normalizeMode(session.mode) || 'video';
      const timeout = setTimeout(() => {
        pendingFriendInvites.delete(inviteId);
        queueBackground(clearPendingInvite(inviteId), '[Redis] Failed to clear expired invite');
        io.to(socket.id).emit('friend-connect-result', { ok: false, reason: 'expired' });
      }, 30_000);

      pendingFriendInvites.set(inviteId, {
        inviteId, inviterUserId: myAnon, inviterSocketId: socket.id,
        inviteeUserId: friendAnonId, inviteeSocketId: friendSocketId,
        mode: resolvedInviteMode, timeout,
      });
      queueBackground(setPendingInvite(inviteId, pendingFriendInvites.get(inviteId)), '[Redis] Failed to persist invite');

      io.to(friendSocketId).emit('friend-connect-invite', {
        inviteId, fromUserId: myAnon, mode: resolvedInviteMode, profile: buildProfileSnapshot(session),
      });
      socket.emit('friend-connect-result', { ok: true, pending: true, inviteId });
    });

    socket.on('respond-friend-connect', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      const inviteId = sanitizeString(data?.inviteId, 128);
      const accepted = !!data?.accepted;
      if (!inviteId || !pendingFriendInvites.has(inviteId)) return;

      const invite = pendingFriendInvites.get(inviteId);
      if (invite.timeout) clearTimeout(invite.timeout);
      pendingFriendInvites.delete(inviteId);
      queueBackground(clearPendingInvite(inviteId), '[Redis] Failed to clear invite');

      if (getIdentityId(session) !== invite.inviteeUserId) return;
      if (!accepted) { io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: false, reason: 'declined' }); return; }

      const inviterSession = userSessions.get(invite.inviterSocketId);
      const inviteeSession = userSessions.get(socket.id);
      if (!inviterSession || !inviteeSession) { io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: false, reason: 'offline' }); return; }

      const inviteMode = normalizeMode(invite.mode);
      inviterSession.mode = inviteMode;
      inviteeSession.mode = inviteMode;

      await leaveRoom(io.sockets.sockets.get(invite.inviterSocketId));
      await removeFromQueue(invite.inviterSocketId);
      await leaveRoom(socket);
      await removeFromQueue(socket.id);

      const roomId = await emitMatchedPair(invite.inviterSocketId, inviterSession, socket.id, inviteeSession, { mode: inviteMode, viaFriend: true });
      io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: true, roomId });
      socket.emit('friend-connect-result', { ok: true, roomId });
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after friend connect');
    });

    socket.on('unfriend', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      if (!requireAuthenticatedUser(socket, 'unfriend')) return;
      const myUserId = getIdentityId(session);
      const friendUserId = sanitizeString(data?.friendUserId, 128);
      if (!friendUserId) return;
      const result = await socialStore.removeFriendship({ userId: myUserId, friendUserId });
      socket.emit('action-feedback', { type: 'unfriend', status: result.status === 'removed' ? 'ok' : result.status });
      if (result.status === 'removed') {
        await refreshSocialViews(myUserId);
        if (onlineUsers.has(friendUserId)) await refreshSocialViews(friendUserId);
      }
    });

    socket.on('get-friends-status', async () => {
      const session = userSessions.get(socket.id);
      if (!session || session.isGuest) return;
      const identityId = getIdentityId(session);
      await refreshSocialViews(identityId);
    });

    socket.on('typing', () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      io.to(getRoomPartnerId(room, socket.id)).emit('typing');
    });

    socket.on('stop-typing', () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      io.to(getRoomPartnerId(room, socket.id)).emit('stop-typing');
    });

    socket.on('next', async (data = {}) => {
      const session = userSessions.get(socket.id);
      const room = session?.roomId ? rooms.get(session.roomId) : null;
      if (room && data?.reason === 'skip') {
        io.to(getRoomPartnerId(room, socket.id)).emit('partner-skipped');
      }
      await leaveRoom(socket);
      await removeFromQueue(socket.id);
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after next');
    });

    socket.on('disconnect', async (reason) => {
      joinQueueTokens.delete(socket.id);
      const session = userSessions.get(socket.id);
      await leaveRoom(socket);
      await removeFromQueue(socket.id);
      if (session) {
        const identityId = getIdentityId(session);
        if (identityId) {
          removeOnlineSocket(identityId, socket.id);
          clearActiveSocket(identityId, socket.id);
          if (!session.isGuest) notifyFriendsOnlineStatusChanged(identityId);
        }
      }
      userSessions.delete(socket.id);
      trackIpConnection(clientIp, -1);
      connectedCount = Math.max(0, connectedCount - 1);
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after disconnect');
    });
  });

  setInterval(() => {
    try { pruneRuntimeState(); logRuntimeStats('interval'); }
    catch (err) { logError('[Runtime] Failed during prune cycle:', err); }
  }, 60_000);

  // ── Periodic queue scanner ────────────────────────────────────────────────
  setInterval(async () => {
    try {
      for (const scanMode of ['video', 'voice']) {
        const membersKey = getQueueMembersKey(scanMode);
        const members = await redis.smembers(membersKey).catch(() => []);
        if (!Array.isArray(members) || members.length < 2) continue;

        const candidates = members.filter(sid => {
          const s = userSessions.get(sid);
          return s?.inQueue && !s?.roomId && normalizeMode(s.mode) === scanMode;
        });
        if (candidates.length < 2) continue;

        candidates.sort((a, b) => {
          const sA = userSessions.get(a);
          const sB = userSessions.get(b);
          return new Date(sA?.joinedAt || 0).getTime() - new Date(sB?.joinedAt || 0).getTime();
        });

        for (const socketId of candidates) {
          const session = userSessions.get(socketId);
          if (!session?.inQueue || session?.roomId) continue;
          const waitMs = session.joinedAt ? Date.now() - new Date(session.joinedAt).getTime() : 0;
          if (waitMs < 800) continue;

          const found = await findMatch(socketId, scanMode, session.interests).catch(() => null);
          if (!found) continue;
          const foundSession = userSessions.get(found.socketId);
          if (!foundSession) continue;
          if (normalizeMode(foundSession.mode) !== scanMode) continue;

          const roomId = await emitMatchedPair(found.socketId, foundSession, socketId, session, { mode: scanMode }).catch(() => null);
          if (roomId) {
            queueBackground(broadcastStats(), '[Stats] Failed to broadcast after scanner match');
            break;
          }
        }
      }
    } catch {}
  }, 1500);

  httpServer.listen(port, hostname, () => {
    logInfo(`> HippiChat ready on http://${hostname}:${port}`);
  });
});