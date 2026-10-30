import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

export function configFromEnv(env = process.env) {
  const config = {
    port: Number(env.PORT || 3001), apiUrl: (env.MAIN_API_URL || '').replace(/\/$/, ''),
    deviceId: env.DEVICE_ID || 'piebox-001', adminPhone: env.ADMIN_PHONE || '+255759637644',
    adapterToken: env.ADAPTER_TOKEN, webhookSecret: env.USSD_WEBHOOK_SECRET,
    demoMode: env.DEMO_MODE === 'true'
  };
  if (!config.apiUrl.startsWith('https://') && !/^http:\/\/localhost(?::\d+)?$/.test(config.apiUrl)) throw new Error('MAIN_API_URL must use HTTPS');
  if (!config.adapterToken || config.adapterToken.length < 24 || !config.webhookSecret || config.webhookSecret.length < 24) {
    throw new Error('Set ADAPTER_TOKEN and USSD_WEBHOOK_SECRET (24+ characters)');
  }
  return config;
}

export function createCoreClient(config) {
  async function call(path, options = {}) {
    const response = await fetch(`${config.apiUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${config.adapterToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Core returned ${response.status}`);
    return response.json();
  }
  return {
    status: () => call(`/v1/devices/${encodeURIComponent(config.deviceId)}/status`),
    command: (body) => call('/v1/commands', { method: 'POST', body: JSON.stringify(body) })
  };
}

export async function handleUssd(fields, config, core) {
  const phone = normalizePhone(fields.phoneNumber);
  const sessionId = String(fields.sessionId || '');
  const text = String(fields.text || '').trim();
  if (!phone || phone !== config.adminPhone) return 'END Namba hii haijaruhusiwa kutumia PieBox.';
  if (!sessionId || sessionId.length > 180 || text.length > 180) return 'END Ombi si sahihi.';
  try {
    if (text === '') return 'CON PieBox\n1. Hali ya mtandao\n2. Chagua ISP\n3. Auto mode';
    if (text === '1') {
      const state = await core.status();
      return `END WAN: ${state.activeWan || 'hakuna'}\nMode: ${state.mode}\nUpdated: ${state.lastVerifiedAt || 'bado'}`;
    }
    if (text === '2') {
      const state = await core.status();
      return `CON Chagua ISP\n${state.links.map((link, i) => `${i + 1}. ${link.label} (${link.healthy === false ? 'down' : 'ready'})`).join('\n')}`;
    }
    if (text.startsWith('2*')) {
      const state = await core.status();
      const choice = Number(text.slice(2));
      if (!Number.isInteger(choice) || choice < 1 || choice > state.links.length) return 'END Chaguo si sahihi.';
      const link = state.links[choice - 1];
      const result = await core.command({ deviceId: config.deviceId, actor: phone, channel: 'ussd',
        action: 'switch_wan', targetWan: link.id, idempotencyKey: `${sessionId}:${text}` });
      return `END Ombi ${result.command.commandId.slice(0, 8)} limepokelewa. Utapata SMS ya matokeo.`;
    }
    if (text === '3') return 'CON Auto mode\n1. Washa\n2. Zima';
    if (text === '3*1' || text === '3*2') {
      const result = await core.command({ deviceId: config.deviceId, actor: phone, channel: 'ussd',
        action: text === '3*1' ? 'auto_on' : 'auto_off', idempotencyKey: `${sessionId}:${text}` });
      return `END Ombi ${result.command.commandId.slice(0, 8)} limepokelewa. Utapata SMS ya matokeo.`;
    }
    return 'END Chaguo si sahihi.';
  } catch (error) {
    console.error('USSD core call failed:', error);
    return 'END PieBox haipatikani sasa. Jaribu tena baadaye.';
  }
}

function normalizePhone(value) {
  const input = String(value || '').trim();
  const phone = input.startsWith('0') && input.length === 10 ? `+255${input.slice(1)}` : input;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function sameSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createServer(config, core = createCoreClient(config)) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/webhooks/africastalking/ussd/')) {
      res.writeHead(404); return res.end();
    }
    const secret = url.pathname.slice('/webhooks/africastalking/ussd/'.length);
    if (!sameSecret(secret, config.webhookSecret)) { res.writeHead(404); return res.end(); }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      res.writeHead(415); return res.end();
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 8192) { res.writeHead(413); return res.end(); }
      }
      const response = await handleUssd(Object.fromEntries(new URLSearchParams(body)), config, core);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(response);
    } catch (error) {
      console.error(error);
      res.writeHead(500); res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  createServer(config).listen(config.port, () => console.log(`PieBox USSD listening on :${config.port}`));
}
