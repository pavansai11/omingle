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
    transports: ['websocket'],
    allowUpgrades: false,
    httpCompression: false,
    perMessageDeflate: false,
    pingTimeout: 30000,
    pingInterval: 15000,
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

  // Simple presence count (connected sockets)
  let connectedCount = 0;
  const PRESENCE_TTL_SECONDS = 180;
  const INVITE_TTL_SECONDS = 30;
  const QUEUE_TTL_SECONDS = 600;
  const ROOM_TTL_SECONDS = 2 * 60 * 60;
  const QUEUE_KEY = 'hippichat:queue:v2'; // kept for legacy compat, no longer the live queue
  const QUEUE_MEMBERS_KEY = 'hippichat:queue-members:v3';

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

  async function addToRedisQueue(entry) {
    try {
      const entryData = {
        socketId: entry.socketId,
        identityId: getIdentityId(entry),
        mode: entry.mode,
        interests: entry.interests || [],
        joinedAt: entry.joinedAt instanceof Date ? entry.joinedAt.toISOString() : (entry.joinedAt || new Date().toISOString()),
      };

      const [, members] = await Promise.all([
        redis.setJson(getQueueEntryKey(entry.socketId), entryData, QUEUE_TTL_SECONDS),
        redis.getJson(QUEUE_MEMBERS_KEY).catch(() => []),
      ]);

      const currentMembers = Array.isArray(members) ? members : [];
      if (!currentMembers.includes(entry.socketId)) {
        currentMembers.push(entry.socketId);
        await redis.setJson(QUEUE_MEMBERS_KEY, currentMembers, QUEUE_TTL_SECONDS);
      }
    } catch (err) {
      logError('[Redis] Failed to add to queue:', err?.message || err);
    }
  }

  async function removeFromRedisQueue(socketId) {
    try {
      const [, members] = await Promise.all([
        redis.delKey(getQueueEntryKey(socketId)).catch(() => null),
        redis.getJson(QUEUE_MEMBERS_KEY).catch(() => []),
      ]);

      const currentMembers = Array.isArray(members) ? members : [];
      const updated = currentMembers.filter((id) => id !== socketId);
      if (updated.length !== currentMembers.length) {
        await redis.setJson(QUEUE_MEMBERS_KEY, updated, QUEUE_TTL_SECONDS);
      }
    } catch (err) {
      logError('[Redis] Failed to remove from queue:', err?.message || err);
    }
  }

  async function getRedisQueueLength() {
    try {
      const members = await redis.getJson(QUEUE_MEMBERS_KEY).catch(() => []);
      return Array.isArray(members) ? members.length : 0;
    } catch {
      return 0;
    }
  }

  async function findAndClaimFromRedisQueue(socketId, mode, interests = []) {
    const normalizedInterests = normalizeInterestKeywords(interests);
    const members = await redis.getJson(QUEUE_MEMBERS_KEY).catch(() => []);
    const currentMembers = Array.isArray(members) ? members : [];

    const candidateIds = currentMembers.filter(
      (id) => id !== socketId && !matchingInProgress.has(id)
    );
    if (!candidateIds.length) return null;

    const entries = await Promise.all(
      candidateIds.map((id) => redis.getJson(getQueueEntryKey(id)).catch(() => null))
    );

    const candidates = entries
      .map((entry) => (entry && entry.mode === mode ? entry : null))
      .filter(Boolean);

    if (!candidates.length) return null;

    candidates.sort((a, b) =>
      new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
    );

    const withOverlap = candidates
      .map((c) => ({ entry: c, overlap: getMatchedInterests(normalizedInterests, c.interests || []) }))
      .filter((c) => c.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length);

    const selected = withOverlap[0]?.entry || candidates[0];
    if (!selected) return null;

    if (matchingInProgress.has(selected.socketId) || matchingInProgress.has(socketId)) {
      return null;
    }

    matchingInProgress.add(selected.socketId);
    matchingInProgress.add(socketId);

    try {
      const updatedMembers = currentMembers.filter(
        (id) => id !== selected.socketId && id !== socketId
      );

      await Promise.all([
        redis.delKey(getQueueEntryKey(selected.socketId)).catch(() => null),
        redis.delKey(getQueueEntryKey(socketId)).catch(() => null),
        redis.setJson(QUEUE_MEMBERS_KEY, updatedMembers, QUEUE_TTL_SECONDS),
      ]);

      return selected;
    } finally {
      matchingInProgress.delete(selected.socketId);
      matchingInProgress.delete(socketId);
    }
  }

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

    queueBackground((async () => {
      const members = await redis.getJson(QUEUE_MEMBERS_KEY).catch(() => []) || [];
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
        await redis.delKey(getQueueEntryKey(socketId)).catch(() => null);
      }
      if (validMembers.length !== members.length) {
        await redis.setJson(QUEUE_MEMBERS_KEY, validMembers, QUEUE_TTL_SECONDS);
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
    if (normalizeMode(sessionA.mode) !== resolvedMode || normalizeMode(sessionB.mode) !== resolvedMode) {
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

      const [, , moderationBlock] = await Promise.all([
        leaveRoom(socket),
        removeFromQueue(socket.id),
        getModerationBlock(getIdentityId({
          userId: (socket.data?.authUser || null)?.id || null,
          anonUserId: anonUserId || `guest_${socket.id}`,
          socketId: socket.id,
        })),
      ]);

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
      userSessions.set(socket.id, session);

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

      await addToRedisQueue(session);
      const match = await findMatch(socket.id, session.mode, session.interests);

      if (match) {
        const matchSession = userSessions.get(match.socketId);
        if (!matchSession) {
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
          await addToRedisQueue(matchSession);
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

      socket.emit('partner-likes-updated', { likes: partnerRep.likesReceived });
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
        mode: requestedMode || normalizeMode(session.mode) || normalizeMode(friendSession.mode),
        timeout,
      });

      queueBackground(setPendingInvite(inviteId, pendingFriendInvites.get(inviteId)), '[Redis] Failed to persist pending invite');

      io.to(friendSocketId).emit('friend-connect-invite', {
        inviteId,
        fromUserId: myAnon,
        mode: requestedMode || normalizeMode(session.mode) || normalizeMode(friendSession.mode),
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
      inviterSession.mode = inviteMode;
      inviteeSession.mode = inviteMode;

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

  httpServer.listen(port, hostname, () => {
    logInfo(`> HippiChat ready on http://${hostname}:${port}`);
    logInfo('> Socket.io server attached');
  });
});