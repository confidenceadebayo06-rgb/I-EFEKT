import { createHmac } from 'node:crypto';
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

const roomName = ({ scope, callId }: CallJoinPayload) => `call:${scope}:${callId}`;
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

export function attachCallSignaling(io: Server, prisma: PrismaClient) {
  io.on('connection', (socket: Socket) => {
    const userId = (socket.data.user as { id: string }).id;
    const joinedRooms = new Set<string>();

    socket.on('call:invite', async (raw: CallJoinPayload, acknowledge?: (result: unknown) => void) => {
      try {
        if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId) ||
            !(await canJoinCall(prisma, userId, raw))) {
          acknowledge?.({ ok: false, error: 'You are not allowed to invite people to this call.' });
          return;
        }
        const memberIds = raw.scope === 'conversation'
          ? (await prisma.conversationMember.findMany({ where: { conversationId: raw.roomId }, select: { userId: true } })).map(member => member.userId)
          : (await prisma.groupMember.findMany({ where: { groupId: raw.roomId }, select: { userId: true } })).map(member => member.userId);
        const invitees = [...new Set(memberIds)].filter(id => id !== userId);
        for (const inviteeId of invitees) {
          io.to(`user:${inviteeId}`).emit('call:incoming', { ...raw, callerId: userId });
        }
        acknowledge?.({ ok: true, invited: invitees.length });
      } catch {
        acknowledge?.({ ok: false, error: 'Could not send the call invitation.' });
      }
    });

    socket.on('call:decline', (raw: CallJoinPayload & { callerId?: string }) => {
      if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId) || !validId(raw.callerId)) return;
      void canJoinCall(prisma, userId, raw).then(allowed => {
        if (allowed) io.to(`user:${raw.callerId}`).emit('call:declined', { scope: raw.scope, roomId: raw.roomId, userId });
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
        const alreadyJoined = joinedRooms.has(room);
        const sockets = await io.in(room).fetchSockets();
        const participantIds = [...new Set(sockets.map(peer => (peer.data.user as { id: string }).id))];
        const maxParticipants = payload.scope === 'conversation' ? 2 : 12;
        if (!participantIds.includes(userId) && participantIds.length >= maxParticipants) {
          acknowledge?.({ ok: false, error: 'This call has reached its participant limit.' });
          return;
        }
        await socket.join(room);
        joinedRooms.add(room);
        if (!alreadyJoined) socket.to(room).emit('call:participant-joined', { userId });
        acknowledge?.({ ok: true, roomId: payload.roomId, callId: payload.callId, participants: participantIds.filter(id => id !== userId) });
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
        if (!joinedRooms.has(room)) {
          acknowledge?.({ ok: false, error: 'Join the call before sending signals.' });
          return;
        }
        const peers = await io.in(room).fetchSockets();
        const recipients = peers.filter(peer => (peer.data.user as { id: string }).id === raw.targetUserId);
        if (!recipients.length) {
          acknowledge?.({ ok: false, error: 'That participant is no longer in the call.' });
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

    socket.on('call:leave', (raw: CallJoinPayload) => {
      if (!raw || !['conversation', 'group'].includes(raw.scope) || !validId(raw.roomId) || !validId(raw.callId)) return;
      const room = roomName(raw);
      if (!joinedRooms.delete(room)) return;
      void socket.leave(room);
      socket.to(room).emit('call:participant-left', { userId });
    });

    socket.on('disconnecting', () => {
      for (const room of joinedRooms) {
        socket.to(room).emit('call:participant-left', { userId });
      }
    });
  });
}
