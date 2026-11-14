# @lodestar/adapter-mock

Scriptable mock QQ adapter for Core E2E tests and MOCK-07..14 scenarios.

```ts
import { MockAdapter, MockControlServer } from '@lodestar/adapter-mock';

const adapter = new MockAdapter({ accountId: 10001 });
const control = new MockControlServer(adapter, { host: '127.0.0.1', token: 'optional' });
await control.start();
console.log(control.url);
```

## HTTP control plane

默认绑定 `127.0.0.1`；设置 `token` 后要求 `Authorization: Bearer <token>`。

| Method | Path | Body | Meaning |
| --- | --- | --- | --- |
| GET | `/health` | — | adapter health snapshot |
| GET | `/status` | — | health + sent actions |
| POST | `/emit` | `{text, groupId?, sourceEventId?}` | emit a normalized message event |
| POST | `/emit-meta` | `{metaEventType: "heartbeat"|"lifecycle"}` | test Core's meta rejection |
| POST | `/freeze` | — | stop events and action plane (fake death) |
| POST | `/freeze-events` | — | stop events only; actions still work |
| POST | `/resume` | — | resume data plane |
| POST | `/crash` | — | mark adapter stopped |
| POST | `/auth-fail` | — | simulate upstream 401/403 |
| POST | `/canary` | `{nonce}` | pre-filter inbound canary evidence |
| POST | `/slow-action` | `{ms}` | delay the next action |
| POST | `/version` | `{qqBuild}` | change reported build |
| POST | `/action` | `{action, params}` | call adapter.execute directly |

`/emit` returns the `PublishResult` from Core's EventSink (accepted/queued/duplicate/backpressure). `emit-meta` returns `forbidden_event_source` when wired to Core.
