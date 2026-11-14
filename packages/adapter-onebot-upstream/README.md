# @lodestar/adapter-onebot-upstream

> **Compatibility/migration backend, not the final Lodestar backend.** The target
> backend is a clean-room native NTQQ injection adapter (M3 spike) that attaches
> to the real QQ client. This package exists to validate Core against real
> events/actions during migration and as a fallback if the injection spike fails.

Connect Lodestar Core to an existing OneBot v11 backend (NapCat / SnowLuma /
LLOneBot) over the backend's WebSocket server.

```ts
import { OneBotUpstreamAdapter } from '@lodestar/adapter-onebot-upstream';

const adapter = new OneBotUpstreamAdapter({
  url: 'ws://127.0.0.1:3001/',
  accessToken: 'optional-upstream-token',
  selfId: 123456789,
});
```

## Behavior

- Connects as a OneBot v11 WebSocket **client**; the upstream must expose a WS server.
- Events: `message` / `notice` / `request` are forwarded to Core's EventSink; backend `meta_event` is ignored (Core owns lifecycle/heartbeat).
- `message_id` is preserved as `sourceEventId`/`nativeMessageId`; other events have no stable source id.
- Actions use `{action, params, echo}` and resolve by matching the same echo.
- `get_login_info` updates `loginState` (non-zero `user_id` → `LOGGED_IN`).
- Reconnect uses exponential backoff; HTTP 401/403 enters `auth_failed` and disables automatic reconnect until `resume()`.
- Backpressure from Core pauses the upstream socket briefly.

## Not yet

- Media/file streaming is proxied as OneBot segments only; no local media cache.
- Multi-account requires one adapter instance per account.
- Upstream `meta_event heartbeat` is not used as a health signal; Probe uses actions + inbound cursor.
