import { createHmac, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient } from '@prisma/client';

type CallScope = 'conversation' | 'group';
type CallJoinPayload = { scope: CallScope; roomId: string; callId: string };
type CallSignalPayload = {
  scope: CallScope;
  roomId: string;
  callId: string;
  targetUserId: string;
  kind: 'offer' | 'answer' | 'ice-candidate';
  data: unknown;
};

const roomName = ({ scope, roomId, callId }: CallJoinPayload) => `call:${scope}:${roomId}:${callId}`;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

async function canJoinCall(prisma: PrismaClient, userId: string, payload: CallJoinPayload) {
  if (payload.scope === 'conversation') {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: payload.roomId },
      select: { userId: true }
    });
    return members.length === 2 && members.some(member => member.userId === userId);
  }
  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: payload.roomId, userId } },
  });
  return !!membership;
}

export function createIceServers() {
  const iceServers: Array<Record<string, unknown>> = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];
  const urls = (process.env.TURN_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  const secret = process.env.TURN_SHARED_SECRET || '';
  if (urls.length && secret.length >= 32) {
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const username = `${expiresAt}:iefekt`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls, username, credential });
  }
  return iceServers;
}

export function attachCallSignaling(io: Server, prisma: PrismaClient, redis: Redis) {
  io.on('connection', (socket: Socket) => {
    const userId = (socket.data.user as { id: string }).id;
    const joinedRooms = new Map<string, string>();
    const evictUserFromRoom = async (room: string, targetUserId: string) => {
      const roomSockets = await io.in(room).fetchSockets();
      const revokedSockets = roomSockets.filter(peer => (peer.data.user as { id: string }).id === targetUserId);
      for (const peer of revokedSockets) {
        await peer.leave(room);
        if (peer.id === socket.id) joinedRooms.delete(room);
      }
      if (revokedSockets.length) io.to(room).emit('call:participant-left', { userId: targetUserId });
    };

    socket.on('call:invite', async (raw: CallJoinPayload, acknowledge?: (result: unknown) => void) => {
      try {
        const room = raw && validId(raw.roomId) && validId(raw.callId) && ['conversation', 'group'].includes(raw.scope)
          ? roomName(raw) : '';
        if (!room || joinedRooms.get(room) !== raw.roomId || !socket.rooms.has(room) || !(await canJoinCall(prisma, userId, raw))) {
          acknowledge?.({ ok: false, error: 'You are not allowed to invite people to this call.' });
          return;
        }
        const memberIds = raw.scope === 'conversation'
          ? (await prisma.conversationMember.findMany({ where: { conversationId: raw.roomId }, select: { userId: true } })).map(member => member.userId)
          : (await prisma.groupMember.findMany({ where: { groupId: raw.roomId }, select: { userId: true } })).map(member => member.userId);
        const activeSockets = await io.in(room).fetchSockets();
        const activeUserIds = new Set(activeSockets.map(peer => (peer.data.user as { id: string }).id));
        const invitees = [...new Set(memberIds)].filter(id => id !== userId && !activeUserIds.has(id));
        let invitedCount = 0;
        for (const inviteeId of invitees) {
          const stillMember = await canJoinCall(prisma, inviteeId, raw);
          if (stillMember) {
            io.to(`user:${inviteeId}`).emit('call:incoming', { ...raw, callerId: userId });
            invitedCount += 1;
          }
        }
        acknowledge?.({ ok: true, invited: invitedCount });
      } catch {
        acknowledge?.({ ok: false, error: 'Could not send the call invitation.' });
      }
    });

    socket.on('call:decline', (raw: CallJoinPayload & { callerId?: string }) => {
      if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId) || !validId(raw.callerId)) return;
      void canJoinCall(prisma, userId, raw).then(async allowed => {
        if (!allowed) return;
        const room = roomName(raw);
        const callers = await io.in(room).fetchSockets();
        if (callers.some(peer => (peer.data.user as { id: string }).id === raw.callerId)) {
          io.to(`user:${raw.callerId}`).emit('call:declined', { scope: raw.scope, roomId: raw.roomId, callId: raw.callId, userId });
        }
      }).catch(() => undefined);
    });

    socket.on('call:join', async (raw: CallJoinPayload, acknowledge?: (result: unknown) => void) => {
      try {
        if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId)) {
          acknowledge?.({ ok: false, error: 'Invalid call room.' });
          return;
        }
        const payload = raw;
        if (!(await canJoinCall(prisma, userId, payload))) {
          acknowledge?.({ ok: false, error: 'You are not an eligible member of this call.' });
          return;
        }
        const room = roomName(payload);
        // Serialize capacity checks across all app replicas using the same Redis
        // instance as the Socket.IO adapter. The lock is released by token so an
        // expired lease can never be deleted by a different holder.
        const lockKey = `iefekt:call-join-lock:${room}`;
        const lockToken = randomUUID();
        let acquired = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const result = await redis.set(lockKey, lockToken, 'PX', 30000, 'NX');
          if (result === 'OK') { acquired = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!acquired) {
          acknowledge?.({ ok: false, error: 'The call is busy processing another join. Please try again.' });
          return;
        }
        try {
          const sockets = await io.in(room).fetchSockets();
          const participantIds = [...new Set(sockets.map(peer => (peer.data.user as { id: string }).id))];
          const participantAlreadyPresent = participantIds.includes(userId);
          const maxParticipants = payload.scope === 'conversation' ? 2 : 12;
          if (!participantAlreadyPresent && participantIds.length >= maxParticipants) {
            acknowledge?.({ ok: false, error: 'This call has reached its participant limit.' });
            return;
          }
          // Do not join if the lease expired while the distributed room read ran.
          if (await redis.get(lockKey) !== lockToken) {
            acknowledge?.({ ok: false, error: 'The call is busy processing another join. Please try again.' });
            return;
          }
          await socket.join(room);
          joinedRooms.set(room, payload.roomId);
          if (!participantAlreadyPresent) socket.to(room).emit('call:participant-joined', { userId });
          acknowledge?.({ ok: true, roomId: payload.roomId, callId: payload.callId, participants: participantIds.filter(id => id !== userId) });
        } finally {
          // The lease has a TTL, so a transient Redis release error must not
          // turn a successfully joined call into a reported join failure.
          await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockToken).catch(() => 0);
        }
      } catch {
        acknowledge?.({ ok: false, error: 'Could not join the call. Please try again.' });
      }
    });

    socket.on('call:signal', async (raw: CallSignalPayload, acknowledge?: (result: unknown) => void) => {
      try {
        if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) ||
            !validId(raw.callId) || !validId(raw.targetUserId) || !['offer', 'answer', 'ice-candidate'].includes(raw.kind)) {
          acknowledge?.({ ok: false, error: 'Invalid call signal.' });
          return;
        }
        const encodedData = raw.data == null ? '' : JSON.stringify(raw.data);
        if (!encodedData || encodedData.length > 65536) {
          acknowledge?.({ ok: false, error: 'Call signal is empty or too large.' });
          return;
        }
        const room = roomName(raw);
        if (joinedRooms.get(room) !== raw.roomId || !socket.rooms.has(room)) {
          acknowledge?.({ ok: false, error: 'Join the call before sending signals.' });
          return;
        }
        if (!(await canJoinCall(prisma, userId, raw))) {
          await evictUserFromRoom(room, userId);
          acknowledge?.({ ok: false, error: 'You are no longer authorized to send signals in this call.' });
          return;
        }
        const peers = await io.in(room).fetchSockets();
        const targetSockets = peers.filter(peer => (peer.data.user as { id: string }).id === raw.targetUserId);
        const recipients = [];
        for (const peer of targetSockets) {
          const targetUserId = (peer.data.user as { id: string }).id;
          if (await canJoinCall(prisma, targetUserId, raw)) recipients.push(peer);
          else await evictUserFromRoom(room, targetUserId);
        }
        if (!recipients.length) {
          acknowledge?.({ ok: false, error: 'That participant is no longer authorized or present in the call.' });
          return;
        }
        for (const peer of recipients) {
          peer.emit('call:signal', { scope: raw.scope, roomId: raw.roomId, callId: raw.callId, fromUserId: userId, kind: raw.kind, data: raw.data });
        }
        acknowledge?.({ ok: true });
      } catch {
        acknowledge?.({ ok: false, error: 'Could not deliver the call signal.' });
      }
    });

    socket.on('call:leave', async (raw: CallJoinPayload) => {
      if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId)) return;
      const room = roomName(raw);
      if (joinedRooms.get(room) !== raw.roomId || !socket.rooms.has(room)) return;
      joinedRooms.delete(room);
      await socket.leave(room);
      const remainingSockets = await io.in(room).fetchSockets();
      if (!remainingSockets.some(peer => (peer.data.user as { id: string }).id === userId)) {
        io.to(room).emit('call:participant-left', { userId });
      }
    });

    socket.on('disconnecting', async () => {
      for (const room of joinedRooms.keys()) {
        if (!socket.rooms.has(room)) continue;
        const remainingSockets = (await io.in(room).fetchSockets()).filter(peer => peer.id !== socket.id);
        if (!remainingSockets.some(peer => (peer.data.user as { id: string }).id === userId)) {
          socket.to(room).emit('call:participant-left', { userId });
        }
      }
    });
  });
}
