const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const socialStore = require('./lib/social-store.cjs');
const redis = require('./lib/upstash-redis.cjs');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');

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
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    missing.push('Upstash Redis REST configuration');
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
  const waitingQueue = []; // { socketId, primaryLanguage, spokenLanguages, mode, joinedAt }
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

  function queueBackground(task, label) {
    Promise.resolve(task).catch((error) => {
      console.error(label, error?.message || error);
    });
  }

  function logRuntimeStats(label = 'runtime') {
    const memory = process.memoryUsage();
    console.log(`[Runtime:${label}] rss=${Math.round(memory.rss / 1024 / 1024)}MB heapUsed=${Math.round(memory.heapUsed / 1024 / 1024)}MB heapTotal=${Math.round(memory.heapTotal / 1024 / 1024)}MB queue=${waitingQueue.length} rooms=${rooms.size} sessions=${userSessions.size} onlineUsers=${onlineUsers.size} profiles=${userProfiles.size} reputation=${userReputation.size} invites=${pendingFriendInvites.size}`);
  }

  function pruneRuntimeState() {
    const now = Date.now();
    const activeSocketIds = new Set(io.sockets.sockets.keys());

    for (let i = waitingQueue.length - 1; i >= 0; i -= 1) {
      const entry = waitingQueue[i];
      const joinedAt = new Date(entry.joinedAt || now).getTime();
      if (!activeSocketIds.has(entry.socketId) || now - joinedAt > 10 * 60 * 1000) {
        waitingQueue.splice(i, 1);
      }
    }

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
    if (!identityId || !onlineUsers.has(identityId)) return;
    for (const sid of onlineUsers.get(identityId)) {
      io.to(sid).emit('account-blocked', {
        ...blockPayload,
        message: formatBlockMessage(blockPayload),
      });
      io.in(sid).disconnectSockets(true);
    }
  }

  async function enforceSingleActiveSocket(identityId, socketId) {
    if (!identityId || !socketId) return;
    const key = getActiveSocketKey(identityId);
    const existingSocketId = await redis.getJson(key).catch(() => null);

    if (existingSocketId && existingSocketId !== socketId) {
      io.to(existingSocketId).emit('force-logout', { reason: 'signed-in-elsewhere' });
      io.in(existingSocketId).disconnectSockets(true);
    }

    await redis.setJson(key, socketId, 60 * 60 * 24 * 7).catch(() => null);
  }

  async function clearActiveSocket(identityId, socketId) {
    if (!identityId || !socketId) return;
    const key = getActiveSocketKey(identityId);
    const currentSocketId = await redis.getJson(key).catch(() => null);
    if (currentSocketId === socketId) {
      await redis.delKey(key).catch(() => null);
    }
  }

  function broadcastStats() {
    io.emit('stats', {
      online: connectedCount,
      queueLength: waitingQueue.length,
      rooms: rooms.size,
    });

    queueBackground(
      redis.setJson('hippichat:stats', {
        online: connectedCount,
        queueLength: waitingQueue.length,
        rooms: rooms.size,
        updatedAt: new Date().toISOString(),
      }, 180),
      '[Redis] Failed to sync stats'
    );
  }

  function getOrCreateReputation(anonUserId) {
    if (!anonUserId) return { likesReceived: 0, reportsReceived: 0 };
    if (!userReputation.has(anonUserId)) {
      userReputation.set(anonUserId, { likesReceived: 0, reportsReceived: 0, lastSeen: new Date() });
    }
    const rep = userReputation.get(anonUserId);
    rep.lastSeen = new Date();
    return rep;
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

    queueBackground(
      redis.setJson(`hippichat:presence:${anonUserId}`, {
        userId: anonUserId,
        sockets: [...onlineUsers.get(anonUserId)],
        online: true,
        updatedAt: new Date().toISOString(),
      }, 180),
      '[Redis] Failed to sync presence add'
    );
  }

  function removeOnlineSocket(anonUserId, socketId) {
    if (!anonUserId || !onlineUsers.has(anonUserId)) return;
    const sockets = onlineUsers.get(anonUserId);
    sockets.delete(socketId);
    if (sockets.size === 0) {
      onlineUsers.delete(anonUserId);
    }

    queueBackground(
      sockets.size === 0
        ? redis.delKey(`hippichat:presence:${anonUserId}`)
        : redis.setJson(`hippichat:presence:${anonUserId}`, {
            userId: anonUserId,
            sockets: [...sockets],
            online: true,
            updatedAt: new Date().toISOString(),
          }, 180),
      '[Redis] Failed to sync presence remove'
    );
  }

  function isUserOnline(anonUserId) {
    return !!(anonUserId && onlineUsers.has(anonUserId) && onlineUsers.get(anonUserId).size > 0);
  }

  function getOnlineSocketIdForUser(anonUserId) {
    if (!anonUserId || !onlineUsers.has(anonUserId)) return null;
    for (const sid of onlineUsers.get(anonUserId).values()) {
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
    if (!identityId || !onlineUsers.has(identityId)) return;
    const payload = await getFriendsPayload(identityId);
    for (const sid of onlineUsers.get(identityId)) {
      io.to(sid).emit('friends-status', { friends: payload });
    }
  }

  async function emitFriendRequests(identityId) {
    if (!identityId || !onlineUsers.has(identityId)) return;
    const incoming = await socialStore.listPendingRequests(identityId);
    const outgoing = await socialStore.listOutgoingRequests(identityId);
    for (const sid of onlineUsers.get(identityId)) {
      io.to(sid).emit('friend-requests', { incoming, outgoing });
    }
  }

  async function emitHistory(identityId) {
    if (!identityId || !onlineUsers.has(identityId)) return;
    const history = await socialStore.listHistory(identityId);
    for (const sid of onlineUsers.get(identityId)) {
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

  function syncQueueSnapshot() {
    const snapshot = waitingQueue.map((entry) => ({
      socketId: entry.socketId,
      identityId: getIdentityId(entry),
      mode: entry.mode,
      interests: entry.interests || [],
      joinedAt: entry.joinedAt,
    }));

    queueBackground(
      redis.setJson('hippichat:queue', snapshot, 180),
      '[Redis] Failed to sync queue snapshot'
    );
  }

  function syncRoomSnapshot(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      queueBackground(redis.delKey(`hippichat:room:${roomId}`), '[Redis] Failed to delete room snapshot');
      return;
    }

    const user1Session = userSessions.get(room.user1);
    const user2Session = userSessions.get(room.user2);
    queueBackground(
      redis.setJson(`hippichat:room:${roomId}`, {
        roomId,
        user1SocketId: room.user1,
        user2SocketId: room.user2,
        user1Id: getIdentityId(user1Session),
        user2Id: getIdentityId(user2Session),
        mode: room.mode,
        matchedInterests: room.matchedInterests || [],
        startedAt: room.startedAt,
      }, 180),
      '[Redis] Failed to sync room snapshot'
    );
  }

  async function notifyFriendsOnlineStatusChanged(identityId) {
    if (!identityId) return;
    const friends = await socialStore.listFriends(identityId);
    const online = isUserOnline(identityId);
    for (const friend of friends) {
      if (!onlineUsers.has(friend.friendUserId)) continue;
      for (const sid of onlineUsers.get(friend.friendUserId)) {
        io.to(sid).emit('friend-online-status', {
          friendAnonId: identityId,
          friendUserId: identityId,
          online,
        });
      }
    }
  }

  function emitMatchedPair(socketIdA, sessionA, socketIdB, sessionB, options = {}) {
    const roomId = options.roomId || generateId();
    const matchedInterests = getMatchedInterests(sessionA.interests || [], sessionB.interests || []);

    rooms.set(roomId, {
      user1: socketIdA,
      user2: socketIdB,
      mode: options.mode || sessionA.mode || sessionB.mode || 'video',
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

    const repA = getOrCreateReputation(getIdentityId(sessionA));
    const repB = getOrCreateReputation(getIdentityId(sessionB));
    const commonLanguages = getCommonLanguages(sessionA, sessionB);

    io.to(socketIdA).emit('matched', {
      roomId,
      partnerId: socketIdB,
      partnerUserId: getIdentityId(sessionB),
      partnerProfile: buildProfileSnapshot(sessionB),
      partnerLanguage: sessionB.primaryLanguage,
      partnerCountry: resolveCountryPayload(sessionB.country, userProfiles.get(getIdentityId(sessionB))),
      partnerLikes: repB.likesReceived,
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
      commonLanguages,
      matchedInterests,
      isFriendConnection: !!options.viaFriend,
      isInitiator: false,
    });

    socialStore.recordMatchHistoryForUsers(buildProfileSnapshot(sessionA), buildProfileSnapshot(sessionB), {
      roomId,
      mode: options.mode || sessionA.mode || sessionB.mode,
      connectedAt: new Date(),
    }).catch((error) => {
      console.error('[History] Failed to persist match history:', error?.message || error);
    });

    syncRoomSnapshot(roomId);

    return roomId;
  }

  function findMatch(socketId, mode, interests = []) {
    const normalizedInterests = normalizeInterestKeywords(interests);
    const candidates = waitingQueue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.mode === mode && entry.socketId !== socketId)
      .sort((a, b) => getQueueEntryWaitMs(b.entry) - getQueueEntryWaitMs(a.entry));

    const bestInterestCandidate = candidates
      .map((candidate) => ({
        ...candidate,
        overlap: getMatchedInterests(normalizedInterests, candidate.entry.interests || []),
      }))
      .filter((candidate) => candidate.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length || a.index - b.index)[0];

    const selected = bestInterestCandidate || candidates[0];
    if (!selected) return null;

    return waitingQueue.splice(selected.index, 1)[0] || null;
  }

  function leaveRoom(socket) {
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
      syncRoomSnapshot(roomId);
    }
    session.roomId = null;
  }

  function removeFromQueue(socketId) {
    const idx = waitingQueue.findIndex(u => u.socketId === socketId);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    syncQueueSnapshot();
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
    console.log('[Socket] Connected:', socket.id);

    connectedCount += 1;
    socket.emit('stats', {
      online: connectedCount,
      queueLength: waitingQueue.length,
      rooms: rooms.size,
    });
    broadcastStats();

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
      getOrCreateReputation(identityId)

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
      console.log('[Socket] join-queue:', socket.id, mode, primaryLanguage?.code);
      const authUser = socket.data?.authUser || null

      // Clean up any existing room
      leaveRoom(socket);
      removeFromQueue(socket.id);

      const session = {
        socketId: socket.id,
        primaryLanguage,
        spokenLanguages: spokenLanguages || [],
        mode: mode || 'video',
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

      const moderationBlock = await getModerationBlock(identityId);
      if (moderationBlock?.blockedUntil) {
        socket.emit('account-blocked', {
          ...moderationBlock,
          message: formatBlockMessage(moderationBlock),
        });
        return;
      }

      getOrCreateReputation(identityId);
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

      console.log('[Socket] Queue candidate ready:', {
        socketId: socket.id,
        identityId,
        mode: session.mode,
        interests: session.interests,
        country: session.country,
      });

      // Try to find a match
      const match = findMatch(socket.id, session.mode, session.interests);
      if (match) {
        const matchSession = userSessions.get(match.socketId);
        if (!matchSession) {
          waitingQueue.push(session);
          return;
        }

        const roomId = emitMatchedPair(match.socketId, matchSession, socket.id, session, {
          mode: session.mode,
        });

        console.log('[Socket] Matched:', match.socketId, '<->', socket.id, 'Room:', roomId);

        broadcastStats();
      } else {
        waitingQueue.push(session);
        syncQueueSnapshot();
        socket.emit('queue-status', {
          position: waitingQueue.length,
          queueLength: waitingQueue.length,
          interests: session.interests,
        });
        console.log('[Socket] Added to queue. Queue size:', waitingQueue.length);
        logRuntimeStats('queue-add');

        broadcastStats();
      }
    });

    socket.on('leave-queue', () => {
      console.log('[Socket] leave-queue:', socket.id);
      removeFromQueue(socket.id);

      broadcastStats();
    });

    socket.on('signal', (data) => {
      // Forward WebRTC signal to the target peer
      if (data.to) {
        io.to(data.to).emit('signal', {
          type: data.type,
          from: socket.id,
          to: data.to,
          payload: data.payload,
        });
      }
    });

    socket.on('send-message', async (data) => {
      try {
        const allowed = await redis.checkRateLimit(`hippichat:rate:message:${socket.id}`, 40, 15);
        if (!allowed) {
          socket.emit('action-feedback', { type: 'message', status: 'rate-limited' });
          return;
        }
      } catch (error) {
        console.error('[Redis] Message rate-limit warning', error?.message || error);
      }
      console.log('[Socket] send-message received:', socket.id, data);
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) {
        console.log('[Socket] send-message: no session or room for', socket.id);
        return;
      }
      const room = rooms.get(session.roomId);
      if (!room) {
        console.log('[Socket] send-message: no room found for', session.roomId);
        return;
      }
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      console.log('[Socket] send-message: forwarding to partner', partnerId);
      io.to(partnerId).emit('receive-message', {
        id: generateId(),
        text: data.message,
        fromLang: data.fromLang,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('update-profile', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const authUser = requireAuthenticatedUser(socket, 'profile');
      if (!authUser) return;

      const identityId = getIdentityId(session);
      const nextName = typeof data?.name === 'string' ? data.name.trim() : '';
      const nextCustomImage = typeof data?.customImage === 'string' ? data.customImage.trim() : undefined;
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
      io.to(partnerId).emit('translation-ready', {
        text: data.text,
        originalText: data.originalText,
        fromLang: data.fromLang,
        toLang: data.toLang,
      });
    });

    socket.on('like-partner', () => {
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
      const partnerRep = getOrCreateReputation(partnerAnon);
      partnerRep.likesReceived += 1;

      // Update liker's view of partner likes
      socket.emit('partner-likes-updated', { likes: partnerRep.likesReceived });

      // Notify partner they received appreciation
      io.to(partnerId).emit('received-like', { totalLikes: partnerRep.likesReceived });
      socket.emit('action-feedback', { type: 'like', status: 'ok' });
    });

    socket.on('report-partner', (data) => {
      const session = userSessions.get(socket.id);
      if (!session || !session.roomId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;

      const actorAnon = getIdentityId(session);
      const actions = roomActions.get(session.roomId) || { likes: new Set(), reports: new Set() };
      const reason = data?.reason || 'other';
      const details = typeof data?.details === 'string' ? data.details : '';

      if (actions.reports.has(actorAnon)) {
        socket.emit('action-feedback', { type: 'report', status: 'duplicate' });
        return;
      }

      actions.reports.add(actorAnon);
      roomActions.set(session.roomId, actions);

      const partnerId = getRoomPartnerId(room, socket.id);
      const partnerSession = userSessions.get(partnerId);
      const partnerAnon = partnerSession ? getIdentityId(partnerSession) : `guest_${partnerId}`;
      const partnerRep = getOrCreateReputation(partnerAnon);
      partnerRep.reportsReceived += 1;

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
          roomId: session.roomId,
          reason,
          details,
          reporterProfile: buildProfileSnapshot(session),
          reportedProfile: partnerSession ? buildProfileSnapshot(partnerSession) : null,
        });
      })(), '[Moderation] Failed to persist report or apply moderation threshold');

      console.log('[Socket] report-partner:', {
        reporter: socket.id,
        partner: partnerId,
        roomId: session.roomId,
        reason,
        reportsReceived: partnerRep.reportsReceived,
      });

      leaveRoom(socket);
      socket.emit('partner-left');

      socket.emit('action-feedback', { type: 'report', status: 'ok' });
      socket.emit('report-submitted', { ok: true });
    });

    socket.on('send-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'friend-request')) return;

      const requesterId = getIdentityId(session);
      let recipientId = data?.targetUserId || null;

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
        for (const sid of onlineUsers.get(recipientId)) {
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
      const friendAnonId = data?.friendAnonId;
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
        io.to(socket.id).emit('friend-connect-result', { ok: false, reason: 'expired' });
      }, 30_000);

      pendingFriendInvites.set(inviteId, {
        inviteId,
        inviterUserId: myAnon,
        inviterSocketId: socket.id,
        inviteeUserId: friendAnonId,
        inviteeSocketId: friendSocketId,
        mode: session.mode || friendSession.mode,
        timeout,
      });

      io.to(friendSocketId).emit('friend-connect-invite', {
        inviteId,
        fromUserId: myAnon,
        mode: session.mode || friendSession.mode,
        profile: buildProfileSnapshot(session),
      });
      socket.emit('friend-connect-result', { ok: true, pending: true, inviteId });
    });

    socket.on('respond-friend-connect', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      const inviteId = data?.inviteId;
      const accepted = !!data?.accepted;
      if (!inviteId || !pendingFriendInvites.has(inviteId)) return;

      const invite = pendingFriendInvites.get(inviteId);
      if (invite.timeout) clearTimeout(invite.timeout);
      pendingFriendInvites.delete(inviteId);

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

      leaveRoom(io.sockets.sockets.get(invite.inviterSocketId));
      removeFromQueue(invite.inviterSocketId);
      leaveRoom(socket);
      removeFromQueue(socket.id);

      const roomId = emitMatchedPair(invite.inviterSocketId, inviterSession, socket.id, inviteeSession, {
        mode: invite.mode || inviterSession.mode || inviteeSession.mode,
        viaFriend: true,
      });

      io.to(invite.inviterSocketId).emit('friend-connect-result', { ok: true, roomId });
      socket.emit('friend-connect-result', { ok: true, roomId });
      broadcastStats();
    });

    socket.on('unfriend', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;
      if (!requireAuthenticatedUser(socket, 'unfriend')) return;
      const myUserId = getIdentityId(session);
      const friendUserId = data?.friendUserId;
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

    socket.on('next', () => {
      console.log('[Socket] next:', socket.id);
      leaveRoom(socket);
      removeFromQueue(socket.id);

      broadcastStats();
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', socket.id, reason);
      const session = userSessions.get(socket.id);
      leaveRoom(socket);
      removeFromQueue(socket.id);
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
      broadcastStats();
    });
  });

  setInterval(() => {
    try {
      pruneRuntimeState();
      logRuntimeStats('interval');
    } catch (error) {
      console.error('[Runtime] Failed during prune/log cycle:', error?.message || error);
    }
  }, 60_000);

  // Status endpoint
  const originalListeners = httpServer.listeners('request').slice();

  httpServer.listen(port, hostname, () => {
    console.log(`> HippiChat ready on http://${hostname}:${port}`);
    console.log(`> Socket.io server attached`);
  });
});
