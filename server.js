const { loadEnvConfig } = require('@next/env');
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const socialStore = require('./lib/social-store.cjs');
const redis = require('./lib/upstash-redis.cjs');

// Ensure `.env` is loaded even when PM2/systemd starts `node server.js`
// directly in production. This avoids relying on shell `source .env` hacks.
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

function logInfo(...args) {
  console.log(...args);
}

function logWarn(...args) {
  console.warn(...args);
}

function logError(...args) {
  console.error(...args);
}

function logDebug(...args) {
  if (dev) console.log(...args);
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
  } catch (error) {
    return null;
  }
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
  if (!process.env.REDIS_URL) {
    missing.push('REDIS_URL');
  }

  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
}

assertProductionConfig();

app.prepare().then(() => {
  // ── Startup: purge any stale legacy queue keys from previous code versions.
  // The old shared-set keys (v2, v3) stored all modes mixed together and can
  // still exist in Redis with up to 10-minute TTLs.  Deleting them on startup
  // ensures the v4 per-mode sets are the only authoritative source of truth.
  Promise.all([
    redis.delKey('hippichat:queue:v2').catch(() => null),
    redis.delKey('hippichat:queue-members:v3').catch(() => null),
    redis.delKey('hippichat:queue-members').catch(() => null),
  ]).then(() => logInfo('[Startup] Legacy queue keys pruned'))
    .catch(() => {});

  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request:', req.url, err);
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
        return callback(new Error(`Origin not allowed: ${origin}`), false);
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
    console.log('[Socket] Redis adapter enabled');
  }

  // In-memory state
  // waitingQueue removed — queue is now fully Redis-authoritative
  const matchingInProgress = new Set(); // socketIds currently being matched (process-local mutex)
  const rooms = new Map(); // roomId -> { user1, user2, mode, startedAt }
  const userSessions = new Map(); // socketId -> session data
  const userReputation = new Map(); // anonUserId -> { likesReceived, reportsReceived }
  const roomActions = new Map(); // roomId -> { likes: Set<anonUserId>, reports: Set<anonUserId> }
  const onlineUsers = new Map(); // anonUserId -> Set<socketId>
  const friendsByUser = new Map(); // anonUserId -> Set<anonUserId>
  const userProfiles = new Map(); // anonUserId -> { countryName, countryFlag }
  const pendingFriendInvites = new Map(); // inviteId -> { inviterUserId, inviterSocketId, inviteeUserId, inviteeSocketId, mode, timeout }
  // Per-socket token that is replaced on every new join-queue call.
  // Any in-flight coroutine from an older call detects the mismatch and aborts,
  // preventing two concurrent join-queue calls from interleaving their Redis writes
  // and leaving a socket registered in the wrong mode set.
  const joinQueueTokens = new Map(); // socketId -> token string

  // Simple presence count (connected sockets)
  let connectedCount = 0;
  const PRESENCE_TTL_SECONDS = 180;
  const INVITE_TTL_SECONDS = 30;
  const QUEUE_TTL_SECONDS = 600;
  const ROOM_TTL_SECONDS = 2 * 60 * 60;
  const QUEUE_KEY = 'hippichat:queue:v2'; // kept for legacy compat, no longer the live queue
  // v3 (single shared set) is retired — v4 uses one set per mode so cross-mode
  // candidates are physically impossible to select.
  const QUEUE_MEMBERS_VIDEO_KEY = 'hippichat:queue-members:v4:video';
  const QUEUE_MEMBERS_VOICE_KEY = 'hippichat:queue-members:v4:voice';
  function getQueueMembersKey(mode) {
    return normalizeMode(mode) === 'voice' ? QUEUE_MEMBERS_VOICE_KEY : QUEUE_MEMBERS_VIDEO_KEY;
  }
  const QUEUE_CLAIM_LOCK_PREFIX = 'hippichat:queue-claim:';

  function getQueueEntryKey(socketId) {
    return `hippichat:queue-entry:${socketId}`;
  }

  function getPresenceKey(identityId) {
    return `hippichat:presence:${identityId}`;
  }

  function getInviteKey(inviteId) {
    return `hippichat:invite:${inviteId}`;
  }

  function getInviteTimeoutKey(inviteId) {
    return `hippichat:invite-timeout:${inviteId}`;
  }

  function getRoomKey(roomId) {
    return `hippichat:room:${roomId}`;
  }

  async function setPresence(identityId, sockets) {
    if (!identityId) return;
    if (!sockets?.length) {
      await redis.delKey(getPresenceKey(identityId)).catch(() => null);
      return;
    }
    await redis.setJson(getPresenceKey(identityId), {
      userId: identityId,
      sockets,
      online: true,
      updatedAt: new Date().toISOString(),
    }, PRESENCE_TTL_SECONDS).catch(() => null);
  }

  async function setPendingInvite(inviteId, invite) {
    if (!inviteId || !invite) return;
    await redis.setJson(getInviteKey(inviteId), {
      inviteId,
      inviterUserId: invite.inviterUserId,
      inviterSocketId: invite.inviterSocketId,
      inviteeUserId: invite.inviteeUserId,
      inviteeSocketId: invite.inviteeSocketId,
      mode: invite.mode,
      createdAt: new Date().toISOString(),
    }, INVITE_TTL_SECONDS).catch(() => null);
  }

  async function clearPendingInvite(inviteId) {
    if (!inviteId) return;
    await redis.delKey(getInviteKey(inviteId)).catch(() => null);
  }

  function getQueueClaimLockKey(socketId) {
    return `${QUEUE_CLAIM_LOCK_PREFIX}${socketId}`;
  }

  async function acquireQueueClaimLock(socketId, ttlSeconds = 5) {
    if (!socketId) return false;
    try {
      const result = await redis.command('SET', [getQueueClaimLockKey(socketId), '1', 'EX', ttlSeconds, 'NX']);
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async function releaseQueueClaimLock(socketId) {
    if (!socketId) return;
    await redis.delKey(getQueueClaimLockKey(socketId)).catch(() => null);
  }

  // ─── Redis-authoritative queue — optimised for minimum round-trips ──────────
  //
  // CALL COUNT (before → after):
  //   removeFromRedisQueue : 3 sequential  → 2 parallel  (delKey + getJson together)
  //   addToRedisQueue      : 3 sequential  → 2 rounds    (setJson || getJson, then setJson)
  //   findAndClaimFromRQ   : 4+ sequential → 3 rounds    (getJson, parallel-getJson, parallel-delKey+setJson)
  //   Total hot path       : 11 sequential → ~7 round-trips with parallelism
  //
  // matchingInProgress (in-memory Set) is the process-local mutex preventing
  // two concurrent join-queue coroutines from double-claiming the same candidate.

  async function addToRedisQueue(entry) {
    try {
      const entryMode = normalizeMode(entry.mode);
      const membersKey = getQueueMembersKey(entryMode);
      // Belt-and-suspenders: also remove from the OTHER mode set so that a
      // socket can never appear in both sets simultaneously.
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
        redis.srem(otherMembersKey, entry.socketId).catch(() => 0), // prevent ghost entries in wrong mode set
      ]);
    } catch (err) {
      logError('[Redis] Failed to add to queue:', err?.message || err);
    }
  }

  async function removeFromRedisQueue(socketId) {
    try {
      // Remove from both per-mode sets — srem on a non-member is a no-op,
      // so this is safe and ensures no ghost entries remain in either set.
      await Promise.all([
        redis.delKey(getQueueEntryKey(socketId)).catch(() => null),
        redis.srem(QUEUE_MEMBERS_VIDEO_KEY, socketId).catch(() => 0),
        redis.srem(QUEUE_MEMBERS_VOICE_KEY, socketId).catch(() => 0),
        releaseQueueClaimLock(socketId),
      ]);
    } catch (err) {
      logError('[Redis] Failed to remove from queue:', err?.message || err);
    }
  }

  async function getRedisQueueLength() {
    try {
      const [video, voice] = await Promise.all([
        redis.scard(QUEUE_MEMBERS_VIDEO_KEY).catch(() => 0),
        redis.scard(QUEUE_MEMBERS_VOICE_KEY).catch(() => 0),
      ]);
      return (video || 0) + (voice || 0);
    } catch {
      return 0;
    }
  }

  async function findAndClaimFromRedisQueue(socketId, mode, interests = []) {
    const resolvedMode = normalizeMode(mode);
    const normalizedInterests = normalizeInterestKeywords(interests);

    // Round 1: read only the set for the requested mode — cross-mode candidates
    // are impossible at this level, no in-memory filtering needed.
    const membersKey = getQueueMembersKey(resolvedMode);
    const members = await redis.smembers(membersKey).catch(() => []);
    const currentMembers = Array.isArray(members) ? members : [];

    const candidateIds = currentMembers.filter(
      (id) => id !== socketId && !matchingInProgress.has(id)
    );
    if (!candidateIds.length) return null;

    // Round 2: fetch all candidate entries IN PARALLEL
    const entries = await Promise.all(
      candidateIds.map((id) => redis.getJson(getQueueEntryKey(id)).catch(() => null))
    );

    // Validate: entry must exist AND be the correct mode (defense-in-depth).
    const candidates = entries
      .map((entry) => (entry && normalizeMode(entry.mode) === resolvedMode ? entry : null))
      .filter(Boolean);

    if (!candidates.length) return null;

    // Sort: prefer interest overlap, then longest wait
    candidates.sort((a, b) =>
      new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
    );
    const withOverlap = candidates
      .map((c) => ({ entry: c, overlap: getMatchedInterests(normalizedInterests, c.interests || []) }))
      .filter((c) => c.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length);

    const selected = withOverlap[0]?.entry || candidates[0];
    if (!selected) return null;

    // Process-local mutex: synchronous check before any await, so no two
    // coroutines in the same Node.js event-loop tick can claim the same pair.
    if (matchingInProgress.has(selected.socketId) || matchingInProgress.has(socketId)) {
      return null;
    }

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
      // Re-fetch after holding the lock to guard against concurrent claims.
      const [selectedEntry, requesterEntry] = await Promise.all([
        redis.getJson(getQueueEntryKey(selected.socketId)).catch(() => null),
        redis.getJson(getQueueEntryKey(socketId)).catch(() => null),
      ]);

      if (!selectedEntry || !requesterEntry) return null;

      // Final mode assertion — all three must agree.
      if (
        normalizeMode(selectedEntry.mode) !== resolvedMode ||
        normalizeMode(requesterEntry.mode) !== resolvedMode
      ) {
        logWarn('[Queue] Mode mismatch after lock — discarding claim:', {
          selected: selectedEntry.mode, requester: requesterEntry.mode, expected: resolvedMode,
        });
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
      await Promise.all([
        releaseQueueClaimLock(socketId),
        releaseQueueClaimLock(selected.socketId),
      ]);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  async function syncRoomSnapshot(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      await redis.delKey(getRoomKey(roomId)).catch(() => null);
      return;
    }

    const user1Session = userSessions.get(room.user1);
    const user2Session = userSessions.get(room.user2);
    await redis.setJson(getRoomKey(roomId), {
      roomId,
      user1SocketId: room.user1,
      user2SocketId: room.user2,
      user1Id: getIdentityId(user1Session),
      user2Id: getIdentityId(user2Session),
      mode: room.mode,
      matchedInterests: room.matchedInterests || [],
      startedAt: room.startedAt,
    }, ROOM_TTL_SECONDS).catch(() => null);
  }

  function queueBackground(task, label) {
    Promise.resolve(task).catch((error) => {
      console.error(label, error?.message || error);
    });
  }

  function getLiveSocketIds(identityId) {
    if (!identityId) return [];
    const socketSet = onlineUsers.get(identityId);
    if (!socketSet || typeof socketSet[Symbol.iterator] !== 'function') return [];
    return [...socketSet].filter((sid) => userSessions.has(sid));
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
    const memory = process.memoryUsage();
    console.log(`[Runtime:${label}] rss=${Math.round(memory.rss / 1024 / 1024)}MB heapUsed=${Math.round(memory.heapUsed / 1024 / 1024)}MB heapTotal=${Math.round(memory.heapTotal / 1024 / 1024)}MB rooms=${rooms.size} sessions=${userSessions.size} onlineUsers=${onlineUsers.size} profiles=${userProfiles.size} reputation=${userReputation.size} invites=${pendingFriendInvites.size}`);
  }

  function pruneRuntimeState() {
    const now = Date.now();
    const activeSocketIds = new Set(io.sockets.sockets.keys());

    // Prune stale Redis queue entries (sockets no longer connected)
    // We do this async but fire-and-forget; failures are non-critical
    queueBackground((async () => {
      // Collect members from BOTH per-mode sets and clean each independently.
      const [videoMembers, voiceMembers] = await Promise.all([
        redis.smembers(QUEUE_MEMBERS_VIDEO_KEY).catch(() => []),
        redis.smembers(QUEUE_MEMBERS_VOICE_KEY).catch(() => []),
      ]);

      for (const [membersKey, members] of [
        [QUEUE_MEMBERS_VIDEO_KEY, videoMembers || []],
        [QUEUE_MEMBERS_VOICE_KEY, voiceMembers || []],
      ]) {
        const validMembers = [];
        for (const socketId of members) {
          if (activeSocketIds.has(socketId)) {
            const entry = await redis.getJson(getQueueEntryKey(socketId)).catch(() => null);
            if (entry) {
              const joinedAt = new Date(entry.joinedAt || now).getTime();
              if (now - joinedAt < 10 * 60 * 1000) {
                validMembers.push(socketId);
                continue;
              }
            }
          }
          // Remove stale entry key
          await redis.delKey(getQueueEntryKey(socketId)).catch(() => null);
        }
        if (validMembers.length !== members.length) {
          const staleMembers = members.filter((id) => !validMembers.includes(id));
          if (staleMembers.length) {
            await redis.srem(membersKey, ...staleMembers).catch(() => 0);
          }
          if (validMembers.length) {
            await redis.expire(membersKey, QUEUE_TTL_SECONDS).catch(() => 0);
          }
        }
      }
    })(), '[Runtime] Failed to prune Redis queue');

    for (const [roomId, room] of rooms.entries()) {
      const startedAt = new Date(room.startedAt || now).getTime();
      const stale = !activeSocketIds.has(room.user1) || !activeSocketIds.has(room.user2) || now - startedAt > 2 * 60 * 60 * 1000;
      if (stale) {
        rooms.delete(roomId);
        roomActions.delete(roomId);
      }
    }

    for (const [socketId, session] of userSessions.entries()) {
      if (!activeSocketIds.has(socketId)) {
        userSessions.delete(socketId);
      } else {
        session.lastSeen = new Date();
      }
    }

    for (const [userId, sockets] of onlineUsers.entries()) {
      for (const sid of [...sockets]) {
        if (!activeSocketIds.has(sid)) sockets.delete(sid);
      }
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
      if (!onlineUsers.has(userId) && now - lastSeen > 6 * 60 * 60 * 1000) {
        userReputation.delete(userId);
      }
    }

    for (const [socketId] of joinQueueTokens.entries()) {
      if (!activeSocketIds.has(socketId)) joinQueueTokens.delete(socketId);
    }

    for (const [userId, profile] of userProfiles.entries()) {
      const lastSeen = new Date(profile.lastSeen || now).getTime();
      if (!onlineUsers.has(userId) && now - lastSeen > 6 * 60 * 60 * 1000) {
        userProfiles.delete(userId);
      }
    }
  }

  function normalizeInterestKeywords(rawKeywords = []) {
    return [...new Set(
      (Array.isArray(rawKeywords) ? rawKeywords : [])
        .map((keyword) => String(keyword || '').trim().toLowerCase())
        .filter(Boolean)
        .map((keyword) => keyword.slice(0, 32))
    )].slice(0, 5);
  }

  function getMatchedInterests(interestsA = [], interestsB = []) {
    if (!interestsA.length || !interestsB.length) return [];
    const setB = new Set(interestsB);
    return interestsA.filter((keyword) => setB.has(keyword));
  }

  function getQueueEntryWaitMs(entry) {
    return Math.max(0, Date.now() - new Date(entry.joinedAt || Date.now()).getTime());
  }

  function normalizeMode(mode) {
    return mode === 'voice' ? 'voice' : 'video';
  }

  function parseMode(mode) {
    if (mode === 'video' || mode === 'voice') return mode;
    return null;
  }

  function getActiveSocketKey(identityId) {
    return `hippichat:active-socket:${identityId}`;
  }

  function getReportDedupeKey(reporterId, reportedId) {
    return `hippichat:report-dedupe:${reporterId}:${reportedId}`;
  }

  function getReportCountKey(reportedId) {
    return `hippichat:report-count:${reportedId}`;
  }

  function getUserBlockKey(identityId) {
    return `hippichat:user-block:${identityId}`;
  }

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
      io.to(sid).emit('account-blocked', {
        ...blockPayload,
        message: formatBlockMessage(blockPayload),
      });
      io.in(sid).disconnectSockets(true);
    }
  }

  async function enforceSingleActiveSocket(identityId, socketId) {
    // Intentionally relaxed to allow the same authenticated account to use
    // multiple devices/tabs independently for matching and chatting.
    return;
  }

  async function clearActiveSocket(identityId, socketId) {
    return;
  }

  async function broadcastStats() {
    const queueLength = await getRedisQueueLength().catch(() => 0);
    io.emit('stats', {
      online: connectedCount,
      queueLength,
      rooms: rooms.size,
    });

    queueBackground(
      redis.setJson('hippichat:stats', {
        online: connectedCount,
        queueLength,
        rooms: rooms.size,
        updatedAt: new Date().toISOString(),
      }, 180),
      '[Redis] Failed to sync stats'
    );
  }

  async function getReputationSnapshot(userId) {
    if (!userId) return { likesReceived: 0, reportsReceived: 0 };

    try {
      const stored = await socialStore.getUserReputation(userId);
      const next = {
        likesReceived: Number(stored?.likesReceived || 0),
        reportsReceived: Number(stored?.reportsReceived || 0),
        lastSeen: new Date(),
      };
      userReputation.set(userId, next);
      return next;
    } catch (error) {
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
      const next = {
        likesReceived: Number(updated?.likesReceived || 0),
        reportsReceived: Number(updated?.reportsReceived || 0),
        lastSeen: new Date(),
      };
      userReputation.set(userId, next);
      return next;
    } catch (error) {
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
      name: session.displayName || `User ${String(getIdentityId(session) || '').slice(-4)}`,
      email: session.email || '',
      image: session.image || null,
      countryCode: session.country?.countryCode || null,
      countryName: session.country?.countryName || 'Unknown',
      countryFlag: session.country?.countryFlag || '🌐',
    };
  }

  function resolveCountryPayload(sessionCountry, fallbackProfile = null) {
    if (sessionCountry?.countryName && sessionCountry.countryName !== 'Unknown') {
      return sessionCountry;
    }
    if (fallbackProfile?.countryName && fallbackProfile.countryName !== 'Unknown') {
      return {
        countryCode: fallbackProfile.countryCode || null,
        countryName: fallbackProfile.countryName,
        countryFlag: fallbackProfile.countryFlag || '🌐',
      };
    }
    return {
      countryCode: null,
      countryName: 'Unknown',
      countryFlag: '🌐',
    };
  }

  function regionCodeToFlag(regionCode) {
    if (!regionCode || regionCode.length !== 2) return '🌐';
    return regionCode
      .toUpperCase()
      .split('')
      .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
      .join('');
  }

  function countryNameFromRegion(regionCode) {
    if (!regionCode) return 'Unknown';
    try {
      const display = new Intl.DisplayNames(['en'], { type: 'region' });
      return display.of(regionCode.toUpperCase()) || regionCode.toUpperCase();
    } catch (e) {
      return regionCode.toUpperCase();
    }
  }

  function deriveCountry(primaryLanguage) {
    const code = primaryLanguage?.code;
    const region = typeof code === 'string' && code.includes('-')
      ? code.split('-')[1].toUpperCase()
      : null;

    return {
      countryCode: region,
      countryName: countryNameFromRegion(region),
      countryFlag: primaryLanguage?.flag || regionCodeToFlag(region),
    };
  }

  function getSessionLanguageMap(session) {
    const map = new Map();
    const all = [session?.primaryLanguage, ...(session?.spokenLanguages || [])];
    for (const lang of all) {
      if (!lang?.code) continue;
      if (!map.has(lang.code)) {
        map.set(lang.code, {
          code: lang.code,
          name: lang.name || lang.code,
        });
      }
    }
    return map;
  }

  function getCommonLanguages(sessionA, sessionB) {
    const aMap = getSessionLanguageMap(sessionA);
    const bMap = getSessionLanguageMap(sessionB);
    const common = [];
    for (const [code, lang] of aMap.entries()) {
      if (bMap.has(code)) common.push(lang);
    }
    return common.slice(0, 5);
  }

  function addOnlineSocket(anonUserId, socketId) {
    if (!anonUserId) return;
    if (!onlineUsers.has(anonUserId)) {
      onlineUsers.set(anonUserId, new Set());
    }
    onlineUsers.get(anonUserId).add(socketId);

    queueBackground(setPresence(anonUserId, [...onlineUsers.get(anonUserId)]), '[Redis] Failed to sync presence add');
  }

  function removeOnlineSocket(anonUserId, socketId) {
    if (!anonUserId || !onlineUsers.has(anonUserId)) return;
    const sockets = onlineUsers.get(anonUserId);
    sockets.delete(socketId);
    if (sockets.size === 0) {
      onlineUsers.delete(anonUserId);
    }

    queueBackground(setPresence(anonUserId, [...sockets]), '[Redis] Failed to sync presence remove');
  }

  function isUserOnline(anonUserId) {
    return !!(anonUserId && onlineUsers.has(anonUserId) && onlineUsers.get(anonUserId).size > 0);
  }

  function getOnlineSocketIdForUser(anonUserId) {
    const socketIds = getLiveSocketIds(anonUserId);
    if (!socketIds.length) return null;
    for (const sid of socketIds) {
      if (userSessions.has(sid)) return sid;
    }
    return null;
  }

  function ensureFriendSet(anonUserId) {
    if (!friendsByUser.has(anonUserId)) {
      friendsByUser.set(anonUserId, new Set());
    }
    return friendsByUser.get(anonUserId);
  }

  function addFriendship(a, b) {
    if (!a || !b || a === b) return false;
    const setA = ensureFriendSet(a);
    const setB = ensureFriendSet(b);
    const beforeA = setA.size;
    setA.add(b);
    setB.add(a);
    return setA.size !== beforeA;
  }

  async function getFriendsPayload(identityId) {
    const friends = await socialStore.listFriends(identityId);
    return friends.map(friend => ({
      friendAnonId: friend.friendUserId,
      friendUserId: friend.friendUserId,
      online: isUserOnline(friend.friendUserId),
      countryName: friend.countryName || 'Unknown',
      countryFlag: friend.countryFlag || '🌐',
      name: friend.name || `User ${String(friend.friendUserId || '').slice(-4)}`,
      image: friend.image || null,
    }));
  }

  async function emitFriendsStatus(identityId) {
    if (!identityId) return;
    const payload = await getFriendsPayload(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      io.to(sid).emit('friends-status', { friends: payload });
    }
  }

  async function emitFriendRequests(identityId) {
    if (!identityId) return;
    const incoming = await socialStore.listPendingRequests(identityId);
    const outgoing = await socialStore.listOutgoingRequests(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      io.to(sid).emit('friend-requests', { incoming, outgoing });
    }
  }

  async function emitHistory(identityId) {
    if (!identityId) return;
    const history = await socialStore.listHistory(identityId);
    const socketIds = getLiveSocketIds(identityId);
    for (const sid of socketIds) {
      io.to(sid).emit('history-updated', { history });
    }
  }

  async function refreshSocialViews(identityId) {
    if (!identityId) return;
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
    const friends = await socialStore.listFriends(identityId);
    const online = isUserOnline(identityId);
    for (const friend of friends) {
      const socketIds = getLiveSocketIds(friend.friendUserId);
      if (!socketIds.length) continue;
      for (const sid of socketIds) {
        io.to(sid).emit('friend-online-status', {
          friendAnonId: identityId,
          friendUserId: identityId,
          online,
        });
      }
    }
  }

  async function emitMatchedPair(socketIdA, sessionA, socketIdB, sessionB, options = {}) {
    const roomId = options.roomId || generateId();
    const resolvedMode = normalizeMode(options.mode || sessionA.mode || sessionB.mode);
    // Strict mode guard: both sessions AND the requested mode must all agree.
    // This is the single authoritative check — every caller relies on it.
    const modeA = normalizeMode(sessionA.mode);
    const modeB = normalizeMode(sessionB.mode);
    if (modeA !== resolvedMode || modeB !== resolvedMode || modeA !== modeB) {
      logWarn('[Match] Mode mismatch — refusing to pair:', { modeA, modeB, resolvedMode, socketIdA, socketIdB });
      return null;
    }
    const matchedInterests = getMatchedInterests(sessionA.interests || [], sessionB.interests || []);

    rooms.set(roomId, {
      user1: socketIdA,
      user2: socketIdB,
      mode: resolvedMode,
      startedAt: new Date(),
      viaFriend: !!options.viaFriend,
      matchedInterests,
    });

    roomActions.set(roomId, {
      likes: new Set(),
      reports: new Set(),
    });

    sessionA.roomId = roomId;
    sessionB.roomId = roomId;

    const repA = await getReputationSnapshot(getIdentityId(sessionA));
    const repB = await getReputationSnapshot(getIdentityId(sessionB));
    const commonLanguages = getCommonLanguages(sessionA, sessionB);

    io.to(socketIdA).emit('matched', {
      roomId,
      partnerId: socketIdB,
      partnerUserId: getIdentityId(sessionB),
      partnerProfile: buildProfileSnapshot(sessionB),
      partnerLanguage: sessionB.primaryLanguage,
      partnerCountry: resolveCountryPayload(sessionB.country, userProfiles.get(getIdentityId(sessionB))),
      partnerLikes: repB.likesReceived,
      mode: resolvedMode,
      commonLanguages,
      matchedInterests,
      isFriendConnection: !!options.viaFriend,
      isInitiator: true,
    });

    io.to(socketIdB).emit('matched', {
      roomId,
      partnerId: socketIdA,
      partnerUserId: getIdentityId(sessionA),
      partnerProfile: buildProfileSnapshot(sessionA),
      partnerLanguage: sessionA.primaryLanguage,
      partnerCountry: resolveCountryPayload(sessionA.country, userProfiles.get(getIdentityId(sessionA))),
      partnerLikes: repA.likesReceived,
      mode: resolvedMode,
      commonLanguages,
      matchedInterests,
      isFriendConnection: !!options.viaFriend,
      isInitiator: false,
    });

    socialStore.recordMatchHistoryForUsers(buildProfileSnapshot(sessionA), buildProfileSnapshot(sessionB), {
      roomId,
      mode: resolvedMode,
      connectedAt: new Date(),
    }).catch((error) => {
      console.error('[History] Failed to persist match history:', error?.message || error);
    });

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

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie || '');
      const sessionId = cookies.omingle_session;
      socket.data.authUser = await socialStore.getUserBySessionId(sessionId);
      return next();
    } catch (error) {
      console.error('[SocketAuth] Failed to resolve authenticated session:', error?.message || error);
      socket.data.authUser = null;
      return next();
    }
  });

  io.on('connection', (socket) => {
    logDebug('[Socket] Connected:', socket.id);

    connectedCount += 1;
    queueBackground((async () => {
      const queueLength = await getRedisQueueLength().catch(() => 0);
      socket.emit('stats', { online: connectedCount, queueLength, rooms: rooms.size });
    })(), '[Stats] Failed to emit initial stats');
    queueBackground(broadcastStats(), '[Stats] Failed to broadcast on connect');

    socket.on('identify-user', async (data = {}) => {
      const existing = userSessions.get(socket.id) || { socketId: socket.id, spokenLanguages: [], roomId: null }
      const previousIdentityId = getIdentityId(existing)
      const authUser = socket.data?.authUser || null

      const session = {
        ...existing,
        socketId: socket.id,
        anonUserId: data.anonUserId || existing.anonUserId || `guest_${socket.id}`,
        userId: authUser?.id || existing.userId || null,
        displayName: authUser?.name || existing.displayName || null,
        email: authUser?.email || existing.email || '',
        image: authUser?.image || existing.image || null,
        country: data.country?.countryName ? data.country : existing.country || null,
        joinedAt: existing.joinedAt || new Date(),
      }

      userSessions.set(socket.id, session)

      const identityId = getIdentityId(session)
      if (!identityId) return

      session.country = resolveCountryPayload(session.country, userProfiles.get(identityId))
      userSessions.set(socket.id, session)

      await enforceSingleActiveSocket(identityId, socket.id)

      if (previousIdentityId && previousIdentityId !== identityId) {
        removeOnlineSocket(previousIdentityId, socket.id)
      }

      addOnlineSocket(identityId, socket.id)
      queueBackground(getReputationSnapshot(identityId), '[Reputation] Failed to load queue reputation')

      const storedProfile = {
        userId: identityId,
        name: authUser?.name || session.displayName || `User ${String(identityId || '').slice(-4)}`,
        email: session.email || '',
        image: session.image || null,
        countryCode: session.country?.countryCode || null,
        countryName: session.country?.countryName || 'Unknown',
        countryFlag: session.country?.countryFlag || '🌐',
        lastSeen: new Date(),
      }

      userProfiles.set(identityId, storedProfile)
      queueBackground(socialStore.upsertUserProfile(storedProfile), '[Profile] Failed to upsert identified profile')
      queueBackground(refreshSocialViews(identityId), '[Social] Failed to refresh identified social views')
      queueBackground(notifyFriendsOnlineStatusChanged(identityId), '[Social] Failed to notify friend online status change')
    })

    socket.on('join-queue', async (data) => {
      const { primaryLanguage, spokenLanguages, mode, anonUserId, country, interestKeywords } = data;
      const requestedMode = normalizeMode(mode);
      logDebug('[Socket] join-queue:', socket.id, requestedMode, primaryLanguage?.code);
      const authUser = socket.data?.authUser || null

      // Issue a fresh token for this join attempt.  If a newer join-queue event
      // arrives for the same socket while this one is suspended at an await, the
      // token will differ and we bail out — preventing two coroutines from
      // writing to Redis concurrently and leaving the socket in the wrong mode set.
      const joinToken = generateId();
      joinQueueTokens.set(socket.id, joinToken);
      const isThisJoinCurrent = () => joinQueueTokens.get(socket.id) === joinToken;

      // Clean up any existing room/queue membership AND check moderation in parallel
      const [, , moderationBlock] = await Promise.all([
        leaveRoom(socket),
        removeFromQueue(socket.id),
        getModerationBlock(getIdentityId({
          userId: (socket.data?.authUser || null)?.id || null,
          anonUserId: anonUserId || `guest_${socket.id}`,
          socketId: socket.id,
        })),
      ]);

      // Abort if a newer join-queue already superseded this one
      if (!isThisJoinCurrent()) {
        logDebug('[JoinQueue] Superseded after cleanup, aborting', socket.id);
        return;
      }

      const session = {
        socketId: socket.id,
        primaryLanguage,
        spokenLanguages: spokenLanguages || [],
        mode: requestedMode,
        anonUserId: anonUserId || `guest_${socket.id}`,
        userId: authUser?.id || null,
        displayName: authUser?.name || null,
        email: authUser?.email || '',
        image: authUser?.image || null,
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

      // moderationBlock was already fetched in parallel with leaveRoom/removeFromQueue above
      if (moderationBlock?.blockedUntil) {
        socket.emit('account-blocked', {
          ...moderationBlock,
          message: formatBlockMessage(moderationBlock),
        });
        return;
      }

      queueBackground(getReputationSnapshot(identityId), '[Reputation] Failed to load session reputation');
      addOnlineSocket(identityId, socket.id);
      const storedProfile = {
        userId: identityId,
        name: authUser?.name || session.displayName || `User ${String(identityId || '').slice(-4)}`,
        email: session.email || '',
        image: session.image || null,
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

      logDebug('[Socket] Queue candidate ready:', { socketId: socket.id, mode: session.mode });

      // ── KEY FIX: Add self to Redis queue BEFORE scanning for a match.
      // This ensures both users are visible to each other during concurrent joins.
      await addToRedisQueue(session);

      // Second token check: if a newer join-queue wrote its own entry to Redis
      // after ours, our write may have overwritten the correct one.  Clean up and
      // yield to the newer coroutine which is already running.
      if (!isThisJoinCurrent()) {
        logDebug('[JoinQueue] Superseded after addToRedisQueue, removing stale entry', socket.id);
        await removeFromRedisQueue(socket.id);
        return;
      }

      // Try to find and atomically claim a waiting match
      let match = await findMatch(socket.id, session.mode, session.interests);

      // Retry with brief delays to handle simultaneous-join race conditions.
      // When two users join at the same moment, Redis lock contention can cause
      // one side's findMatch to return null even though the other user IS in queue.
      // The other side will have already emitted a 'matched' event in that case
      // (session.roomId gets set), so we stop retrying if already matched.
      if (!match) {
        for (const delayMs of [250, 500]) {
          await new Promise(r => setTimeout(r, delayMs));
          const currentSession = userSessions.get(socket.id);
          // Stop if disconnected, left queue, or already matched by the other side
          if (!currentSession?.inQueue || currentSession?.roomId) break;
          match = await findMatch(socket.id, session.mode, session.interests);
          if (match) break;
        }
      }

      if (match) {
        const matchSession = userSessions.get(match.socketId);
        if (!matchSession) {
          // Match candidate disconnected after being claimed — stay in queue
          // (our own entry was already removed by findAndClaimFromRedisQueue,
          //  so re-add ourselves)
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', {
            position: queueLength,
            queueLength,
            interests: session.interests,
          });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after stale match');
          return;
        }

        if (normalizeMode(matchSession.mode) !== session.mode) {
          // Mode mismatch after claiming — return both users to their own queues.
          // Re-add the match candidate first so they aren't stranded.
          matchSession.inQueue = true;
          await addToRedisQueue(matchSession);
          session.inQueue = true;
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', {
            position: queueLength,
            queueLength,
            interests: session.interests,
          });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after mode mismatch');
          return;
        }

        const roomId = await emitMatchedPair(match.socketId, matchSession, socket.id, session, {
          mode: session.mode,
        });

        if (!roomId) {
          // emitMatchedPair rejected (e.g., mode guard) — put both back
          await addToRedisQueue(matchSession);
          await addToRedisQueue(session);
          const queueLength = await getRedisQueueLength().catch(() => 0);
          socket.emit('queue-status', {
            position: queueLength,
            queueLength,
            interests: session.interests,
          });
          queueBackground(broadcastStats(), '[Stats] Failed to broadcast after failed match');
          return;
        }

        logDebug('[Socket] Matched:', match.socketId, '<->', socket.id, 'Room:', roomId);
        queueBackground(broadcastStats(), '[Stats] Failed to broadcast after match');
      } else {
        // No match yet — stay in queue (already added above)
        const queueLength = await getRedisQueueLength().catch(() => 0);
        socket.emit('queue-status', {
          position: queueLength,
          queueLength,
          interests: session.interests,
        });
        logDebug('[Socket] Waiting in queue. Queue size:', queueLength);
        logRuntimeStats('queue-add');
        queueBackground(broadcastStats(), '[Stats] Failed to broadcast after queue add');
      }
    });

    socket.on('leave-queue', async () => {
      logDebug('[Socket] leave-queue:', socket.id);
      await removeFromQueue(socket.id);

      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after leave-queue');
    });

    socket.on('signal', (data) => {
      const targetSocketId = sanitizeString(data?.to, 128);
      const signalType = sanitizeString(data?.type, 32);
      if (!targetSocketId || !signalType) return;
      if (!isSocketInSameRoom(socket.id, targetSocketId)) return;

      io.to(targetSocketId).emit('signal', {
        type: signalType,
        from: socket.id,
        to: targetSocketId,
        payload: data?.payload,
      });
    });

    socket.on('send-message', async (data) => {
      try {
        const allowed = await redis.checkRateLimit(`hippichat:rate:message:${socket.id}`, 40, 15);
        if (!allowed) {
          socket.emit('action-feedback', { type: 'message', status: 'rate-limited' });
          return;
        }
      } catch (error) {
        logWarn('[Redis] Message rate-limit warning', error?.message || error);
      }
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      const safeMessage = sanitizeString(data?.message, MAX_CHAT_MESSAGE_LENGTH);
      const safeFromLang = sanitizeString(data?.fromLang, 32) || null;
      if (!safeMessage) return;
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      io.to(partnerId).emit('receive-message', {
        id: generateId(),
        text: safeMessage,
        fromLang: safeFromLang,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('update-profile', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const authUser = requireAuthenticatedUser(socket, 'profile');
      if (!authUser) return;

      const identityId = getIdentityId(session);
      const nextName = sanitizeString(data?.name, MAX_PROFILE_NAME_LENGTH) || '';
      const nextCustomImage = sanitizeImageUrl(data?.customImage);
      if (nextCustomImage === null) {
        socket.emit('action-feedback', { type: 'profile', status: 'invalid-image-url' });
        return;
      }
      if (!identityId || (!nextName && typeof nextCustomImage === 'undefined')) return;

      if (nextName) {
        session.displayName = nextName;
      }
      if (typeof nextCustomImage !== 'undefined') {
        session.image = nextCustomImage || authUser?.image || null;
      }
      userSessions.set(socket.id, session);

      const nextProfile = {
        userId: identityId,
        name: nextName || session.displayName,
        email: session.email || '',
        image: session.image || null,
        customImage: typeof nextCustomImage !== 'undefined' ? (nextCustomImage || null) : (userProfiles.get(identityId)?.customImage || null),
        countryName: session.country?.countryName || 'Unknown',
        countryFlag: session.country?.countryFlag || '🌐',
        lastSeen: new Date(),
      };

      socket.data.authUser = {
        ...authUser,
        name: nextName || authUser?.name,
        image: session.image || authUser?.image || null,
      };

      userProfiles.set(identityId, nextProfile);
      await socialStore.upsertUserProfile(nextProfile);
      await refreshSocialViews(identityId);
    });

    socket.on('translation-ready', (data) => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      const partnerId = getRoomPartnerId(room, socket.id);
      const safeText = sanitizeString(data?.text, MAX_CHAT_MESSAGE_LENGTH);
      const safeOriginalText = sanitizeString(data?.originalText, MAX_CHAT_MESSAGE_LENGTH);
      const safeFromLang = sanitizeString(data?.fromLang, 32) || null;
      const safeToLang = sanitizeString(data?.toLang, 32) || null;
      if (!safeText) return;
      io.to(partnerId).emit('translation-ready', {
        text: safeText,
        originalText: safeOriginalText,
        fromLang: safeFromLang,
        toLang: safeToLang,
      });
    });

    socket.on('like-partner', async () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;

      const actorAnon = getIdentityId(session);
      const actions = roomActions.get(session.roomId) || { likes: new Set(), reports: new Set() };

      if (actions.likes.has(actorAnon)) {
        socket.emit('action-feedback', { type: 'like', status: 'duplicate' });
        return;
      }

      actions.likes.add(actorAnon);
      roomActions.set(session.roomId, actions);

      const partnerId = getRoomPartnerId(room, socket.id);
      const partnerSession = userSessions.get(partnerId);
      if (!partnerSession) return;

      const partnerAnon = getIdentityId(partnerSession);
      const partnerRep = await incrementReputation(partnerAnon, { likesReceived: 1 });

      // Update liker's view of partner likes
      socket.emit('partner-likes-updated', { likes: partnerRep.likesReceived });

      // Notify partner they received appreciation
      io.to(partnerId).emit('received-like', { totalLikes: partnerRep.likesReceived });
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

      if (effectiveRoomId && actions.reports.has(actorAnon)) {
        socket.emit('action-feedback', { type: 'report', status: 'duplicate' });
        return;
      }

      if (effectiveRoomId) {
        actions.reports.add(actorAnon);
        roomActions.set(effectiveRoomId, actions);
      }

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
          if (blockPayload) {
            disconnectUserSockets(partnerAnon, blockPayload);
          }
        }

        await socialStore.createReport({
          reporterId: actorAnon,
          reportedId: partnerAnon,
          roomId: effectiveRoomId,
          reason,
          details,
          reporterProfile: buildProfileSnapshot(session),
          reportedProfile: partnerSession ? buildProfileSnapshot(partnerSession) : null,
        });
      })(), '[Moderation] Failed to persist report or apply moderation threshold');

      logDebug('[Socket] report-partner:', { reporter: socket.id, roomId: effectiveRoomId, reason, reportsReceived: partnerRep.reportsReceived });

      if (room && session.roomId) {
        await leaveRoom(socket);
        socket.emit('partner-left');
      }

      socket.emit('action-feedback', { type: 'report', status: 'ok' });
      socket.emit('report-submitted', { ok: true });
    });

    socket.on('send-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'friend-request')) return;

      const requesterId = getIdentityId(session);
      let recipientId = sanitizeString(data?.targetUserId, 128) || null;

      if (!recipientId && session.roomId) {
        const room = rooms.get(session.roomId);
        if (room) {
          const partnerId = getRoomPartnerId(room, socket.id);
          const partnerSession = userSessions.get(partnerId);
          recipientId = getIdentityId(partnerSession);
        }
      }

      if (!requesterId || !recipientId) return;

      const allowed = await redis.checkRateLimit(`hippichat:rate:friend-request:${requesterId}`, 10, 60).catch((error) => {
        console.error('[Redis] Friend request rate-limit failed:', error?.message || error);
        return true;
      });
      if (!allowed) {
        socket.emit('action-feedback', { type: 'friend-request', status: 'rate-limited' });
        return;
      }

      const result = await socialStore.createFriendRequest({ requesterId, recipientId });

      if (result.status === 'created') {
        socket.emit('action-feedback', { type: 'friend-request', status: 'ok' });
      } else {
        socket.emit('action-feedback', { type: 'friend-request', status: result.status });
      }

      await refreshSocialViews(requesterId);
      if (onlineUsers.has(recipientId)) {
        await refreshSocialViews(recipientId);
        const socketIds = getLiveSocketIds(recipientId);
        for (const sid of socketIds) {
          io.to(sid).emit('friend-request-received', { fromUserId: requesterId });
        }
      }
    });

    socket.on('accept-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'friend-request-accept')) return;
      const myUserId = getIdentityId(session);
      const result = await socialStore.acceptFriendRequest({ requestId: data.requestId, userId: myUserId });
      if (result.status !== 'accepted') {
        socket.emit('action-feedback', { type: 'friend-request-accept', status: result.status });
        return;
      }

      const otherUserId = result.request.requesterId;
      await refreshSocialViews(myUserId);
      if (onlineUsers.has(otherUserId)) {
        await refreshSocialViews(otherUserId);
      }
      socket.emit('action-feedback', { type: 'friend-request-accept', status: 'ok' });
    });

    socket.on('reject-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'friend-request-reject')) return;
      const myUserId = getIdentityId(session);
      const result = await socialStore.rejectFriendRequest({ requestId: data.requestId, userId: myUserId });
      if (result.status !== 'rejected') {
        socket.emit('action-feedback', { type: 'friend-request-reject', status: result.status });
        return;
      }

      await refreshSocialViews(myUserId);
      socket.emit('action-feedback', { type: 'friend-request-reject', status: 'ok' });
    });

    socket.on('connect-friend', async (data) => {
      const friendAnonId = sanitizeString(data?.friendAnonId, 128);
      const explicitRequestedMode = parseMode(data?.mode);
      if (typeof data?.mode !== 'undefined' && !explicitRequestedMode) {
        socket.emit('friend-connect-result', { ok: false, reason: 'invalid-mode' });
        return;
      }
      const requestedMode = explicitRequestedMode || null;
      const session = userSessions.get(socket.id);
      if (!session || !friendAnonId) return;
      if (!requireAuthenticatedUser(socket, 'friend-connect')) return;

      const myAnon = getIdentityId(session);
      const myFriends = await socialStore.listFriends(myAnon);
      if (!myFriends.some(friend => friend.friendUserId === friendAnonId)) {
        socket.emit('friend-connect-result', { ok: false, reason: 'not-friends' });
        return;
      }

      const friendSocketId = getOnlineSocketIdForUser(friendAnonId);
      if (!friendSocketId) {
        socket.emit('friend-connect-result', { ok: false, reason: 'offline' });
        return;
      }

      const friendSession = userSessions.get(friendSocketId);
      if (!friendSession) {
        socket.emit('friend-connect-result', { ok: false, reason: 'offline' });
        return;
      }

      const friendSocket = io.sockets.sockets.get(friendSocketId);
      if (!friendSocket) {
        socket.emit('friend-connect-result', { ok: false, reason: 'offline' });
        return;
      }
      const inviteId = generateId();
      // The mode is determined exclusively by what the inviter explicitly requested,
      // falling back to the inviter's own current mode — never the invitee's mode,
      // which could differ and cause cross-mode connections.
      const resolvedInviteMode = requestedMode || normalizeMode(session.mode) || 'video';
      const timeout = setTimeout(() => {
        pendingFriendInvites.delete(inviteId);
        queueBackground(clearPendingInvite(inviteId), '[Redis] Failed to clear expired pending invite');
        io.to(socket.id).emit('friend-connect-result', { ok: false, reason: 'expired' });
      }, 30_000);

      pendingFriendInvites.set(inviteId, {
        inviteId,
        inviterUserId: myAnon,
        inviterSocketId: socket.id,
        inviteeUserId: friendAnonId,
        inviteeSocketId: friendSocketId,
        mode: resolvedInviteMode,
        timeout,
      });
      queueBackground(setPendingInvite(inviteId, pendingFriendInvites.get(inviteId)), '[Redis] Failed to persist pending invite');

      io.to(friendSocketId).emit('friend-connect-invite', {
        inviteId,
        fromUserId: myAnon,
        mode: resolvedInviteMode,
        profile: buildProfileSnapshot(session),
      });
      socket.emit('friend-connect-result', { ok: true, pending: true, inviteId });
    });

    socket.on('respond-friend-connect', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const inviteId = sanitizeString(data?.inviteId, 128);
      const accepted = !!data?.accepted;
      if (!inviteId || !pendingFriendInvites.has(inviteId)) return;

      const invite = pendingFriendInvites.get(inviteId);
      if (invite.timeout) clearTimeout(invite.timeout);
      pendingFriendInvites.delete(inviteId);
      queueBackground(clearPendingInvite(inviteId), '[Redis] Failed to clear pending invite');

      if (getIdentityId(session) !== invite.inviteeUserId) return;

      if (!accepted) {
        io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: false, reason: 'declined' });
        return;
      }

      const inviterSession = userSessions.get(invite.inviterSocketId);
      const inviteeSession = userSessions.get(socket.id);
      if (!inviterSession || !inviteeSession) {
        io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: false, reason: 'offline' });
        return;
      }
      const inviteMode = normalizeMode(invite.mode);
      // Forcibly set both sessions to the agreed invite mode before pairing.
      // This is the single source of truth — both sides must use the same mode
      // that the inviter originally requested.
      inviterSession.mode = inviteMode;
      inviteeSession.mode = inviteMode;
      logDebug('[FriendConnect] Pairing with mode:', inviteMode, invite.inviterSocketId, '<->', socket.id);

      await leaveRoom(io.sockets.sockets.get(invite.inviterSocketId));
      await removeFromQueue(invite.inviterSocketId);
      await leaveRoom(socket);
      await removeFromQueue(socket.id);

      const roomId = await emitMatchedPair(invite.inviterSocketId, inviterSession, socket.id, inviteeSession, {
        mode: inviteMode,
        viaFriend: true,
      });

      io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: true, roomId });
      socket.emit('friend-connect-result', { ok: true, roomId });
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after friend connect');
    });

    socket.on('unfriend', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'unfriend')) return;
      const myUserId = getIdentityId(session);
      const friendUserId = sanitizeString(data?.friendUserId, 128);
      if (!friendUserId) return;

      const result = await socialStore.removeFriendship({ userId: myUserId, friendUserId });
      socket.emit('action-feedback', { type: 'unfriend', status: result.status === 'removed' ? 'ok' : result.status });
      if (result.status === 'removed') {
        await refreshSocialViews(myUserId);
        if (onlineUsers.has(friendUserId)) {
          await refreshSocialViews(friendUserId);
        }
      }
    });

    socket.on('get-friends-status', async () => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const identityId = getIdentityId(session);
      await refreshSocialViews(identityId);
    });

    socket.on('typing', () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      const partnerId = getRoomPartnerId(room, socket.id);
      io.to(partnerId).emit('typing');
    });

    socket.on('stop-typing', () => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      const partnerId = getRoomPartnerId(room, socket.id);
      io.to(partnerId).emit('stop-typing');
    });

    socket.on('next', async (data = {}) => {
      logDebug('[Socket] next:', socket.id, data?.reason || 'unknown');
      const session = userSessions.get(socket.id);
      const room = session?.roomId ? rooms.get(session.roomId) : null;
      if (room && data?.reason === 'skip') {
        const partnerId = getRoomPartnerId(room, socket.id);
        io.to(partnerId).emit('partner-skipped');
      }
      await leaveRoom(socket);
      await removeFromQueue(socket.id);

      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after next');
    });

    socket.on('disconnect', async (reason) => {
      logDebug('[Socket] Disconnected:', socket.id, reason);
      joinQueueTokens.delete(socket.id);
      const session = userSessions.get(socket.id);
      await leaveRoom(socket);
      await removeFromQueue(socket.id);
      if (session) {
        const identityId = getIdentityId(session);
        if (identityId) {
          removeOnlineSocket(identityId, socket.id);
          clearActiveSocket(identityId, socket.id);
          notifyFriendsOnlineStatusChanged(identityId);
        }
      }
      userSessions.delete(socket.id);

      connectedCount = Math.max(0, connectedCount - 1);
      queueBackground(broadcastStats(), '[Stats] Failed to broadcast after disconnect');
    });
  });

  setInterval(() => {
    try {
      pruneRuntimeState();
      logRuntimeStats('interval');
    } catch (error) {
      logError('[Runtime] Failed during prune/log cycle:', error?.message || error);
    }
  }, 60_000);

  // ── Periodic queue scanner ────────────────────────────────────────────────
  // Runs every 1.5 s. Picks up any waiting users that were missed due to
  // simultaneous-join race conditions (both sides' initial findMatch ran
  // before the other's addToRedisQueue completed in Redis).
  //
  // Each mode queue is scanned independently — cross-mode candidates cannot
  // appear because we read from mode-specific Redis sets.
  setInterval(async () => {
    try {
      for (const scanMode of ['video', 'voice']) {
        const membersKey = getQueueMembersKey(scanMode);
        const members = await redis.smembers(membersKey).catch(() => []);
        if (!Array.isArray(members) || members.length < 2) continue;

        // Only consider sockets with active in-memory sessions in this mode.
        const candidates = members.filter(sid => {
          const s = userSessions.get(sid);
          return s?.inQueue && !s?.roomId && normalizeMode(s.mode) === scanMode;
        });
        if (candidates.length < 2) continue;

        // Sort by wait time so longest-waiting users are tried first.
        candidates.sort((a, b) => {
          const sA = userSessions.get(a);
          const sB = userSessions.get(b);
          return new Date(sA?.joinedAt || 0).getTime() - new Date(sB?.joinedAt || 0).getTime();
        });

        // Attempt one match per mode per scan cycle (avoids thundering herd).
        for (const socketId of candidates) {
          const session = userSessions.get(socketId);
          if (!session?.inQueue || session?.roomId) continue;

          // Only retry for users who have been waiting > 800 ms.
          const waitMs = session.joinedAt ? Date.now() - new Date(session.joinedAt).getTime() : 0;
          if (waitMs < 800) continue;

          const found = await findMatch(socketId, scanMode, session.interests).catch(() => null);
          if (!found) continue;

          const foundSession = userSessions.get(found.socketId);
          if (!foundSession) continue;

          // Mode guard — emitMatchedPair also checks, but be explicit here.
          if (normalizeMode(foundSession.mode) !== scanMode) {
            logWarn('[Scanner] Mode mismatch after claim — discarding:', found.socketId, normalizeMode(foundSession.mode), '!==', scanMode);
            continue;
          }

          const roomId = await emitMatchedPair(found.socketId, foundSession, socketId, session, {
            mode: scanMode,
          }).catch(() => null);

          if (roomId) {
            logDebug('[Scanner] Matched waiting pair:', found.socketId, '<->', socketId, 'mode:', scanMode, 'Room:', roomId);
            queueBackground(broadcastStats(), '[Stats] Failed to broadcast after scanner match');
            break; // One match per mode per cycle
          }
        }
      }
    } catch (e) {
      // Never let scanner errors affect the server
    }
  }, 1500);

  // Status endpoint
  const originalListeners = httpServer.listeners('request').slice();

  httpServer.listen(port, hostname, () => {
    logInfo(`> HippiChat ready on http://${hostname}:${port}`);
    logInfo(`> Socket.io server attached`);
  });
});