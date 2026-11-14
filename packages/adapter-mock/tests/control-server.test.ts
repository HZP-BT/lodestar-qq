import { describe, expect, it } from 'vitest';

import { MockAdapter } from '../src/mock-adapter.js';
import { MockControlServer } from '../src/control-server.js';
import type { AdapterEvent, EventSink } from '../src/protocol.js';

function fakeSink() {
  const events: AdapterEvent[] = [];
  const sink: EventSink = {
    publish(event) {
      events.push(event);
      return Promise.resolve({
        accepted: true,
        eventKey: `key-${events.length}`,
        deliverSeq: events.length,
        mode: 'queued',
      });
    },
  };
  return { sink, events };
}

async function post(url: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('MockControlServer', () => {
  it('drives emit/freeze/resume/health over HTTP', async () => {
    const { sink, events } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001 });
    await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
    const control = new MockControlServer(adapter);
    await control.start();

    try {
      expect((await post(control.url, '/emit', { text: 'hello' })).status).toBe(200);
      expect(events).toHaveLength(1);

      expect((await post(control.url, '/emit', { text: '' })).status).toBe(400);
      const invalidJson = await fetch(`${control.url}/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad-json',
      });
      expect(invalidJson.status).toBe(400);
      expect(events).toHaveLength(1);

      expect((await post(control.url, '/freeze')).status).toBe(200);
      expect((await post(control.url, '/emit', { text: 'blocked' })).status).toBe(200);
      expect(events).toHaveLength(1);

      const health = (await (await fetch(`${control.url}/health`)).json()) as {
        dataPlane: string;
      };
      expect(health.dataPlane).toBe('silent');

      expect((await post(control.url, '/resume')).status).toBe(200);
      expect((await post(control.url, '/emit', { text: 'after' })).status).toBe(200);
      expect(events).toHaveLength(2);

      expect((await post(control.url, '/canary', { nonce: 'n1' })).status).toBe(200);
      const status = (await (await fetch(`${control.url}/status`)).json()) as {
        health: { inboundNonceSeen?: string };
      };
      expect(status.health.inboundNonceSeen).toBe('n1');
    } finally {
      await control.stop();
    }
  });

  it('forwards actions and rejects bad methods', async () => {
    const { sink } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001 });
    await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
    const control = new MockControlServer(adapter);
    await control.start();

    try {
      const response = await post(control.url, '/action', {
        action: 'get_login_info',
        params: {},
      });
      expect(await response.json()).toMatchObject({ ok: true });

      const notFound = await fetch(`${control.url}/nothing`);
      expect(notFound.status).toBe(404);
    } finally {
      await control.stop();
    }
  });
});
