const { MongoClient, ObjectId } = require('mongodb');
const isProduction = process.env.NODE_ENV === 'production';

const memory = {
  profiles: new Map(),
  friendRequests: new Map(),
  friendships: new Map(),
  matchHistory: [],
};

const cache = {
  client: null,
  db: null,
  promise: null,
  failed: false,
};

function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const username = process.env.MONGO_USERNAME;
  const password = process.env.MONGO_PASSWORD;
  const host = process.env.MONGO_HOST;

  if (username && password && host) {
    return `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`;
  }

  return process.env.MONGO_URL || null;
}

function pairKey(a, b) {
  return [a, b].sort().join('::');
}

async function getCollections() {
  const uri = resolveMongoUri();
  if (!uri) {
    if (isProduction) {
      throw new Error('MongoDB is required in production for social-store operations');
    }
    return null;
  }
  if (cache.failed) return null;
  if (cache.db) return buildCollections(cache.db);

  try {
    if (!cache.promise) {
      const client = new MongoClient(uri);
      cache.promise = client.connect().then((connectedClient) => {
        cache.client = connectedClient;
        cache.db = connectedClient.db(process.env.DB_NAME || 'HippiChat');
        return cache.db;
      });
    }

    const db = await cache.promise;
    return buildCollections(db);
  } catch (error) {
    if (isProduction) {
      cache.promise = null;
      throw error;
    }
    console.error('[SocialStore] Mongo unavailable, using memory fallback:', error?.message || error);
    cache.failed = true;
    cache.promise = null;
    return null;
  }
}

function buildCollections(db) {
  return {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    friendRequests: db.collection('friend_requests'),
    friendships: db.collection('friendships'),
    matchHistory: db.collection('match_history'),
    reports: db.collection('reports'),
  };
}

function normalizeAuthUser(user) {
  if (!user) return null;
  return {
    id: user.userId || user.googleId || user.id || user._id?.toString() || null,
    userId: user.userId || user.googleId || user.id || user._id?.toString() || null,
    googleId: user.googleId || user.userId || null,
    name: user.name || 'HippiChat User',
    email: user.email || '',
    image: user.customImage || user.image || null,
    customImage: user.customImage || null,
  };
}

function normalizeProfile(profile) {
  if (!profile) return null;
  return {
    userId: profile.userId || profile.id || profile.googleId || null,
    name: profile.name || 'HippiChat User',
    email: profile.email || '',
    image: profile.customImage || profile.image || null,
    customImage: profile.customImage || null,
    countryCode: profile.countryCode || null,
    countryName: profile.countryName || 'Unknown',
    countryFlag: profile.countryFlag || '🌐',
  };
}

async function upsertUserProfile(profile) {
  const normalized = normalizeProfile(profile);
  if (!normalized?.userId) return null;

  const collections = await getCollections();
  if (!collections) {
    const existing = memory.profiles.get(normalized.userId) || {};
    const next = { ...existing, ...normalized, updatedAt: new Date(), createdAt: existing.createdAt || new Date() };
    memory.profiles.set(normalized.userId, next);
    return next;
  }

  await collections.users.updateOne(
    { $or: [{ userId: normalized.userId }, { googleId: normalized.userId }] },
    {
      $set: { ...normalized, googleId: normalized.userId, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return collections.users.findOne({ $or: [{ userId: normalized.userId }, { googleId: normalized.userId }] });
}

async function getUserProfile(userId) {
  if (!userId) return null;
  const collections = await getCollections();
  if (!collections) {
    return memory.profiles.get(userId) || null;
  }
  return collections.users.findOne({ $or: [{ userId }, { googleId: userId }] });
}

async function getUserProfiles(userIds) {
  const filtered = [...new Set((userIds || []).filter(Boolean))];
  if (!filtered.length) return [];

  const collections = await getCollections();
  if (!collections) {
    return filtered.map((userId) => memory.profiles.get(userId)).filter(Boolean);
  }

  return collections.users.find({
    $or: [
      { userId: { $in: filtered } },
      { googleId: { $in: filtered } },
    ],
  }).toArray();
}

async function createFriendRequest({ requesterId, recipientId }) {
  if (!requesterId || !recipientId || requesterId === recipientId) {
    return { status: 'invalid' };
  }

  const key = pairKey(requesterId, recipientId);
  const collections = await getCollections();

  if (!collections) {
    if (memory.friendships.has(key)) return { status: 'already-friends' };

    const existing = [...memory.friendRequests.values()].find((item) =>
      item.status === 'pending' && (
        (item.requesterId === requesterId && item.recipientId === recipientId) ||
        (item.requesterId === recipientId && item.recipientId === requesterId)
      )
    );

    if (existing) {
      return {
        status: existing.requesterId === requesterId ? 'duplicate' : 'awaiting-your-response',
        request: existing,
      };
    }

    const request = {
      id: new ObjectId().toString(),
      requesterId,
      recipientId,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    memory.friendRequests.set(request.id, request);
    return { status: 'created', request };
  }

  const friendship = await collections.friendships.findOne({ pairKey: key });
  if (friendship) return { status: 'already-friends' };

  const existing = await collections.friendRequests.findOne({
    status: 'pending',
    $or: [
      { requesterId, recipientId },
      { requesterId: recipientId, recipientId: requesterId },
    ],
  });

  if (existing) {
    return {
      status: existing.requesterId === requesterId ? 'duplicate' : 'awaiting-your-response',
      request: { ...existing, id: existing._id.toString() },
    };
  }

  const request = {
    requesterId,
    recipientId,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await collections.friendRequests.insertOne(request);
  return { status: 'created', request: { ...request, id: result.insertedId.toString() } };
}

async function acceptFriendRequest({ requestId, userId }) {
  if (!requestId || !userId) return { status: 'invalid' };
  const collections = await getCollections();

  if (!collections) {
    const request = memory.friendRequests.get(requestId);
    if (!request || request.recipientId !== userId || request.status !== 'pending') return { status: 'not-found' };
    request.status = 'accepted';
    request.updatedAt = new Date();
    memory.friendRequests.set(requestId, request);
    memory.friendships.set(pairKey(request.requesterId, request.recipientId), {
      userAId: request.requesterId,
      userBId: request.recipientId,
      createdAt: new Date(),
    });
    return { status: 'accepted', request };
  }

  const request = await collections.friendRequests.findOne({ _id: new ObjectId(requestId), recipientId: userId, status: 'pending' });
  if (!request) return { status: 'not-found' };

  await collections.friendRequests.updateOne(
    { _id: request._id },
    { $set: { status: 'accepted', updatedAt: new Date() } }
  );

  await collections.friendships.updateOne(
    { pairKey: pairKey(request.requesterId, request.recipientId) },
    {
      $set: {
        pairKey: pairKey(request.requesterId, request.recipientId),
        userAId: request.requesterId,
        userBId: request.recipientId,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { status: 'accepted', request: { ...request, id: request._id.toString() } };
}

async function rejectFriendRequest({ requestId, userId }) {
  if (!requestId || !userId) return { status: 'invalid' };
  const collections = await getCollections();

  if (!collections) {
    const request = memory.friendRequests.get(requestId);
    if (!request || request.recipientId !== userId || request.status !== 'pending') return { status: 'not-found' };
    request.status = 'rejected';
    request.updatedAt = new Date();
    memory.friendRequests.set(requestId, request);
    return { status: 'rejected', request };
  }

  const request = await collections.friendRequests.findOne({ _id: new ObjectId(requestId), recipientId: userId, status: 'pending' });
  if (!request) return { status: 'not-found' };

  await collections.friendRequests.updateOne(
    { _id: request._id },
    { $set: { status: 'rejected', updatedAt: new Date() } }
  );

  return { status: 'rejected', request: { ...request, id: request._id.toString() } };
}

async function listFriends(userId) {
  if (!userId) return [];
  const collections = await getCollections();

  if (!collections) {
    const items = [...memory.friendships.values()].filter((item) => item.userAId === userId || item.userBId === userId);
    const friendIds = items.map((item) => item.userAId === userId ? item.userBId : item.userAId);
    const profiles = await getUserProfiles(friendIds);
    const map = new Map(profiles.map((profile) => [profile.userId, profile]));
    return friendIds.map((friendUserId) => ({
      friendUserId,
      ...normalizeProfile(map.get(friendUserId)),
    }));
  }

  const items = await collections.friendships.find({
    $or: [{ userAId: userId }, { userBId: userId }],
  }).sort({ updatedAt: -1, createdAt: -1 }).toArray();

  const friendIds = items.map((item) => item.userAId === userId ? item.userBId : item.userAId);
  const profiles = await getUserProfiles(friendIds);
  const map = new Map(profiles.map((profile) => [profile.userId, profile]));

  return friendIds.map((friendUserId) => ({
    friendUserId,
    ...normalizeProfile(map.get(friendUserId)),
  }));
}

async function listPendingRequests(userId) {
  if (!userId) return [];
  const collections = await getCollections();

  let items;
  if (!collections) {
    items = [...memory.friendRequests.values()].filter((item) => item.recipientId === userId && item.status === 'pending');
  } else {
    items = await collections.friendRequests.find({ recipientId: userId, status: 'pending' }).sort({ createdAt: -1 }).toArray();
  }

  const requesterIds = items.map((item) => item.requesterId);
  const profiles = await getUserProfiles(requesterIds);
  const map = new Map(profiles.map((profile) => [profile.userId, profile]));

  return items.map((item) => ({
    requestId: item.id || item._id?.toString(),
    requesterId: item.requesterId,
    createdAt: item.createdAt,
    profile: normalizeProfile(map.get(item.requesterId)),
  }));
}

async function listOutgoingRequests(userId) {
  if (!userId) return [];
  const collections = await getCollections();

  let items;
  if (!collections) {
    items = [...memory.friendRequests.values()].filter((item) => item.requesterId === userId && item.status === 'pending');
  } else {
    items = await collections.friendRequests.find({ requesterId: userId, status: 'pending' }).sort({ createdAt: -1 }).toArray();
  }

  const recipientIds = items.map((item) => item.recipientId);
  const profiles = await getUserProfiles(recipientIds);
  const map = new Map(profiles.map((profile) => [profile.userId, profile]));

  return items.map((item) => ({
    requestId: item.id || item._id?.toString(),
    recipientId: item.recipientId,
    createdAt: item.createdAt,
    profile: normalizeProfile(map.get(item.recipientId)),
  }));
}

async function recordMatchHistoryForUsers(userA, userB, meta = {}) {
  const a = normalizeProfile(userA);
  const b = normalizeProfile(userB);
  if (!a?.userId || !b?.userId) return;

  const records = [
    {
      ownerUserId: a.userId,
      partnerUserId: b.userId,
      partnerName: b.name,
      partnerImage: b.image,
      countryName: b.countryName,
      countryFlag: b.countryFlag,
      mode: meta.mode || 'video',
      roomId: meta.roomId || null,
      connectedAt: meta.connectedAt || new Date(),
      createdAt: new Date(),
    },
    {
      ownerUserId: b.userId,
      partnerUserId: a.userId,
      partnerName: a.name,
      partnerImage: a.image,
      countryName: a.countryName,
      countryFlag: a.countryFlag,
      mode: meta.mode || 'video',
      roomId: meta.roomId || null,
      connectedAt: meta.connectedAt || new Date(),
      createdAt: new Date(),
    },
  ];

  const collections = await getCollections();
  if (!collections) {
    memory.matchHistory.unshift(...records);
    memory.matchHistory = memory.matchHistory.slice(0, 200);
    return;
  }

  await collections.matchHistory.insertMany(records);
}

async function listHistory(userId) {
  if (!userId) return [];
  const collections = await getCollections();
  let items;

  if (!collections) {
    items = memory.matchHistory.filter((item) => item.ownerUserId === userId).slice(0, 10);
  } else {
    items = await collections.matchHistory.find({ ownerUserId: userId }).sort({ connectedAt: -1, createdAt: -1 }).limit(10).toArray();
  }

  return items.map((item) => ({
    id: item._id?.toString() || `${item.ownerUserId}-${item.partnerUserId}-${new Date(item.connectedAt).getTime()}`,
    partnerUserId: item.partnerUserId,
    partnerName: item.partnerName,
    partnerImage: item.partnerImage || null,
    countryName: item.countryName || 'Unknown',
    countryFlag: item.countryFlag || '🌐',
    mode: item.mode || 'video',
    connectedAt: item.connectedAt,
    roomId: item.roomId || null,
  }));
}

async function getUserBySessionId(sessionId) {
  if (!sessionId) return null;
  const collections = await getCollections();
  if (!collections) return null;

  const session = await collections.sessions.findOne({ sessionId });
  if (!session) return null;

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await collections.sessions.deleteOne({ sessionId });
    return null;
  }

  let user = session.user || null;
  if (!user && session.userId) {
    user = await collections.users.findOne({
      $or: [{ userId: session.userId }, { googleId: session.userId }],
    });
  }

  return normalizeAuthUser(user);
}

async function createReport(record) {
  if (!record?.reporterId || !record?.reportedId) return null;

  const payload = {
    reporterId: record.reporterId,
    reportedId: record.reportedId,
    roomId: record.roomId || null,
    reason: record.reason || 'other',
    details: typeof record.details === 'string' ? record.details.trim().slice(0, 500) : '',
    reporterProfile: normalizeProfile(record.reporterProfile),
    reportedProfile: normalizeProfile(record.reportedProfile),
    createdAt: new Date(),
  };

  const collections = await getCollections();
  if (!collections) {
    const id = new ObjectId().toString();
    const next = { id, ...payload };
    memory.matchHistory.unshift({
      ownerUserId: payload.reporterId,
      partnerUserId: payload.reportedId,
      partnerName: payload.reportedProfile?.name || 'Reported user',
      partnerImage: payload.reportedProfile?.image || null,
      countryName: payload.reportedProfile?.countryName || 'Unknown',
      countryFlag: payload.reportedProfile?.countryFlag || '🌐',
      mode: 'report',
      roomId: payload.roomId,
      connectedAt: payload.createdAt,
      createdAt: payload.createdAt,
    });
    return next;
  }

  const result = await collections.reports.insertOne(payload);
  return { id: result.insertedId.toString(), ...payload };
}

async function removeFriendship({ userId, friendUserId }) {
  if (!userId || !friendUserId) return { status: 'invalid' };
  const key = pairKey(userId, friendUserId);
  const collections = await getCollections();

  if (!collections) {
    if (!memory.friendships.has(key)) return { status: 'not-found' };
    memory.friendships.delete(key);
    return { status: 'removed' };
  }

  const result = await collections.friendships.deleteOne({ pairKey: key });
  if (!result.deletedCount) return { status: 'not-found' };
  return { status: 'removed' };
}

module.exports = {
  upsertUserProfile,
  getUserProfile,
  getUserBySessionId,
  createFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  listFriends,
  listPendingRequests,
  listOutgoingRequests,
  recordMatchHistoryForUsers,
  listHistory,
  createReport,
  removeFriendship,
};
