import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { handleUssd, createServer } from './server.js';

const config = { adminPhone: '+255759637644', deviceId: 'piebox-001' };
const commands = [];
const core = {
  status: async () => ({ activeWan: 'wan_a', mode: 'manual', lastVerifiedAt: '2026-10-30T00:00:00Z',
    links: [{ id: 'wan_a', label: 'ISP A', healthy: true }, { id: 'wan_b', label: 'ISP B', healthy: true }] }),
  command: async (body) => { commands.push(body); return { command: { commandId: '12345678-1234' } }; },
  airtimeReward: async (body) => ({ reward: { status: 'queued', ...body } })
};

test('USSD menu and switch use the shared Core', async () => {
  const fields = { phoneNumber: '0759637644', sessionId: 'session-1', text: '' };
  assert.match(await handleUssd(fields, config, core), /^CON PieBox/);
  assert.match(await handleUssd({ ...fields, text: '2' }, config, core), /ISP B/);
  assert.match(await handleUssd({ ...fields, text: '2*2' }, config, core), /^END Ombi/);
  assert.equal(commands[0].targetWan, 'wan_b');
  assert.equal(commands[0].idempotencyKey, 'session-1:2*2');
  assert.match(await handleUssd({ ...fields, phoneNumber: '+255700000000' }, config, core), /^END Namba hii haijaruhusiwa/);
  assert.match(await handleUssd({ ...fields, text: '4' }, config, core), /TZS 1000/);
  assert.match(await handleUssd({ ...fields, text: '4*1' }, config, core), /^END Ombi la airtime/);
});

test('USSD callback returns plain CON/END text and rejects wrong secret', async () => {
  const server = createServer({ ...config, webhookSecret: 'ussd-test-secret-123456789012' }, core);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = new URLSearchParams({ phoneNumber: '+255759637644', sessionId: 'session-2', text: '' });
  try {
    const wrong = await fetch(`${base}/webhooks/africastalking/ussd/wrong`, { method: 'POST', body });
    assert.equal(wrong.status, 404);
    const right = await fetch(`${base}/webhooks/africastalking/ussd/ussd-test-secret-123456789012`, { method: 'POST', body });
    assert.equal(right.status, 200);
    assert.match(right.headers.get('content-type'), /^text\/plain/);
    assert.match(await right.text(), /^CON PieBox/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
