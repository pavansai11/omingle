const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const socialStore = require('./lib/social-store.cjs');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function generateId() {
  return Math.random().toString(36).substring(2, 12);
}

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

  const { Server: SocketServer } = require('socket.io');
  const io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // In-memory state
  const waitingQueue = []; // { socketId, primaryLanguage, spokenLanguages, mode, joinedAt }
  const rooms = new Map(); // roomId -> { user1, user2, mode, startedAt }
  const userSessions = new Map(); // socketId -> session data
  const userReputation = new Map(); // anonUserId -> { likesReceived, reportsReceived }
  const roomActions = new Map(); // roomId -> { likes: Set<anonUserId>, reports: Set<anonUserId> }
  const onlineUsers = new Map(); // anonUserId -> Set<socketId>
  const friendsByUser = new Map(); // anonUserId -> Set<anonUserId>
  const userProfiles = new Map(); // anonUserId -> { countryName, countryFlag }

  // Simple presence count (connected sockets)
  let connectedCount = 0;

  function broadcastStats() {
    io.emit('stats', {
      online: connectedCount,
      queueLength: waitingQueue.length,
      rooms: rooms.size,
    });
  }

  function getOrCreateReputation(anonUserId) {
    if (!anonUserId) return { likesReceived: 0, reportsReceived: 0 };
    if (!userReputation.has(anonUserId)) {
      userReputation.set(anonUserId, { likesReceived: 0, reportsReceived: 0 });
    }
    return userReputation.get(anonUserId);
  }

  function getRoomPartnerId(room, socketId) {
    return room.user1 === socketId ? room.user2 : room.user1;
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
      countryName: session.country?.countryName || 'Unknown',
      countryFlag: session.country?.countryFlag || '🌐',
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
  }

  function removeOnlineSocket(anonUserId, socketId) {
    if (!anonUserId || !onlineUsers.has(anonUserId)) return;
    const sockets = onlineUsers.get(anonUserId);
    sockets.delete(socketId);
    if (sockets.size === 0) {
      onlineUsers.delete(anonUserId);
    }
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

    rooms.set(roomId, {
      user1: socketIdA,
      user2: socketIdB,
      mode: options.mode || sessionA.mode || sessionB.mode || 'video',
      startedAt: new Date(),
      viaFriend: !!options.viaFriend,
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
      partnerCountry: sessionB.country,
      partnerLikes: repB.likesReceived,
      commonLanguages,
      isFriendConnection: !!options.viaFriend,
      isInitiator: true,
    });

    io.to(socketIdB).emit('matched', {
      roomId,
      partnerId: socketIdA,
      partnerUserId: getIdentityId(sessionA),
      partnerProfile: buildProfileSnapshot(sessionA),
      partnerLanguage: sessionA.primaryLanguage,
      partnerCountry: sessionA.country,
      partnerLikes: repA.likesReceived,
      commonLanguages,
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

    return roomId;
  }

  function findMatch(socketId, mode) {
    // Find someone in queue with same mode
    const idx = waitingQueue.findIndex(u => u.mode === mode && u.socketId !== socketId);
    if (idx !== -1) {
      return waitingQueue.splice(idx, 1)[0];
    }
    return null;
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
    }
    session.roomId = null;
  }

  function removeFromQueue(socketId) {
    const idx = waitingQueue.findIndex(u => u.socketId === socketId);
    if (idx !== -1) waitingQueue.splice(idx, 1);
  }

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

      const session = {
        ...existing,
        socketId: socket.id,
        anonUserId: data.anonUserId || existing.anonUserId || `guest_${socket.id}`,
        userId: data.userId || existing.userId || null,
        displayName: data.displayName || existing.displayName || null,
        email: data.email || existing.email || '',
        image: data.image || existing.image || null,
        country: data.country?.countryName ? data.country : existing.country || null,
        joinedAt: existing.joinedAt || new Date(),
      }

      userSessions.set(socket.id, session)

      const identityId = getIdentityId(session)
      if (!identityId) return

      if (previousIdentityId && previousIdentityId !== identityId) {
        removeOnlineSocket(previousIdentityId, socket.id)
      }

      addOnlineSocket(identityId, socket.id)
      getOrCreateReputation(identityId)

      const storedProfile = {
        userId: identityId,
        name: session.displayName || `User ${String(identityId || '').slice(-4)}`,
        email: session.email || '',
        image: session.image || null,
        countryName: session.country?.countryName || 'Unknown',
        countryFlag: session.country?.countryFlag || '🌐',
      }

      userProfiles.set(identityId, storedProfile)
      await socialStore.upsertUserProfile(storedProfile)
      await refreshSocialViews(identityId)
      await notifyFriendsOnlineStatusChanged(identityId)
    })

    socket.on('join-queue', async (data) => {
      const { primaryLanguage, spokenLanguages, mode, anonUserId, country, userId, displayName, email, image } = data;
      console.log('[Socket] join-queue:', socket.id, mode, primaryLanguage?.code);

      // Clean up any existing room
      leaveRoom(socket);
      removeFromQueue(socket.id);

      const session = {
        socketId: socket.id,
        primaryLanguage,
        spokenLanguages: spokenLanguages || [],
        mode: mode || 'video',
        anonUserId: anonUserId || `guest_${socket.id}`,
        userId: userId || null,
        displayName: displayName || null,
        email: email || '',
        image: image || null,
        country: country?.countryName ? country : deriveCountry(primaryLanguage),
        roomId: null,
        joinedAt: new Date(),
      };
      userSessions.set(socket.id, session);
      const identityId = getIdentityId(session);
      getOrCreateReputation(identityId);
      addOnlineSocket(identityId, socket.id);
      const storedProfile = {
        userId: identityId,
        name: session.displayName || `User ${String(identityId || '').slice(-4)}`,
        email: session.email || '',
        image: session.image || null,
        countryName: session.country?.countryName || 'Unknown',
        countryFlag: session.country?.countryFlag || '🌐',
      };
      userProfiles.set(identityId, storedProfile);
      await socialStore.upsertUserProfile(storedProfile);
      await emitFriendsStatus(identityId);
      await emitFriendRequests(identityId);
      await emitHistory(identityId);
      await notifyFriendsOnlineStatusChanged(identityId);

      // Try to find a match
      const match = findMatch(socket.id, session.mode);
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
        socket.emit('queue-status', {
          position: waitingQueue.length,
          queueLength: waitingQueue.length,
        });
        console.log('[Socket] Added to queue. Queue size:', waitingQueue.length);

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

    socket.on('send-message', (data) => {
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

      const identityId = getIdentityId(session);
      const nextName = typeof data?.name === 'string' ? data.name.trim() : '';
      if (!identityId || !nextName) return;

      session.displayName = nextName;
      userSessions.set(socket.id, session);

      const nextProfile = {
        userId: identityId,
        name: nextName,
        email: session.email || '',
        image: session.image || null,
        countryName: session.country?.countryName || 'Unknown',
        countryFlag: session.country?.countryFlag || '🌐',
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

      console.log('[Socket] report-partner:', {
        reporter: socket.id,
        partner: partnerId,
        roomId: session.roomId,
        reason: data?.reason || 'unspecified',
        reportsReceived: partnerRep.reportsReceived,
      });

      socket.emit('action-feedback', { type: 'report', status: 'ok' });
      socket.emit('report-submitted', { ok: true });
    });

    socket.on('send-friend-request', async (data = {}) => {
      const session = userSessions.get(socket.id);
      if (!session) return;

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

      leaveRoom(socket);
      removeFromQueue(socket.id);
      leaveRoom(friendSocket);
      removeFromQueue(friendSocketId);

      const roomId = emitMatchedPair(socket.id, session, friendSocketId, friendSession, {
        mode: session.mode || friendSession.mode,
        viaFriend: true,
      });

      socket.emit('friend-connect-result', { ok: true, roomId });
      io.to(friendSocketId).emit('friend-connect-result', { ok: true, roomId });

      broadcastStats();
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

    socket.on('disconnect', () => {
      console.log('[Socket] Disconnected:', socket.id);
      const session = userSessions.get(socket.id);
      leaveRoom(socket);
      removeFromQueue(socket.id);
      if (session) {
        const identityId = getIdentityId(session);
        if (identityId) {
          removeOnlineSocket(identityId, socket.id);
          notifyFriendsOnlineStatusChanged(identityId);
        }
      }
      userSessions.delete(socket.id);

      connectedCount = Math.max(0, connectedCount - 1);
      broadcastStats();
    });
  });

  // Status endpoint
  const originalListeners = httpServer.listeners('request').slice();

  httpServer.listen(port, hostname, () => {
    console.log(`> Omingle ready on http://${hostname}:${port}`);
    console.log(`> Socket.io server attached`);
  });
});
