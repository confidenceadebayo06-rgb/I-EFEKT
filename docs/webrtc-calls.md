# I-EFEKT WebRTC calling

## Supported call flows

- One-to-one calls are tied to a conversation containing exactly two members.
- Group calls are tied to an existing group and require an active membership.
- Group calls currently use a peer-to-peer mesh and are capped at 12 participants. This is suitable only for small groups; larger rooms should use an SFU such as a managed WebRTC media service.
- Socket.IO carries authenticated signaling only. Audio and video media flow through WebRTC peer connections.

## Required browser and deployment conditions

- Serve the application over HTTPS. Browsers generally block camera and microphone access on insecure origins (localhost is the development exception).
- The server's Permissions-Policy allows camera and microphone access from the same origin. Geolocation remains disabled.
- Users must grant camera and microphone permission.
- The browser must support `getUserMedia`, `RTCPeerConnection`, and the Socket.IO client.

## STUN and TURN

The app includes Google's public STUN endpoint as a connectivity fallback. For production reliability, configure a TURN service and set:

- `TURN_URLS`: comma-separated TURN URLs, for example `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`.
- `TURN_SHARED_SECRET`: the TURN service's REST-authentication shared secret (at least 32 characters).

The API creates time-limited TURN REST credentials with a one-hour expiry. Keep `TURN_SHARED_SECRET` in the deployment secret manager; never place it in browser code, source control, or logs. The secret must match the TURN server's REST-authentication configuration. If these variables are absent, the API returns STUN-only ICE configuration, which will not connect every pair of networks.

## Signaling events

- `call:invite`, `call:incoming`, `call:decline`, `call:declined`
- `call:join`, `call:participant-joined`, `call:participant-left`, `call:leave`
- `call:signal` with `offer`, `answer`, and `ice-candidate`

Every join and signal is checked against the authenticated user's conversation or active group membership. Signal payloads are limited to 64 KiB and are relayed only to a participant already joined to the same call room.

## Validation still required

Before enabling calls for production users, test on at least two separate devices and networks, including mobile browsers, camera/microphone permission denial, TURN relay-only connectivity, reconnects, group capacity, and participants leaving mid-call. Automated CI does not replace these end-to-end checks.
