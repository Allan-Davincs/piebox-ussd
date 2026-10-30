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
    command: (body) => call('/v1/commands', { method: 'POST', body: JSON.stringify(body) }),
    airtimeReward: (body) => call('/v1/airtime/reward', { method: 'POST', body: JSON.stringify(body) })
  };
}

export async function handleUssd(fields, config, core) {
  const phone = normalizePhone(fields.phoneNumber);
  const sessionId = String(fields.sessionId || '');
  const text = String(fields.text || '').trim();
  if (!phone || !/^[A-Za-z0-9_-]{4,120}$/.test(sessionId) || text.length > 180) return 'END Ombi si sahihi.';
  if (text && !/^\d+(?:\*\d+)*$/.test(text)) return 'END Chaguo si sahihi.';
  const admin = phone === config.adminPhone;
  const steps = text ? text.split('*') : [];
  if (text === '0') return 'END Asante kwa kutumia PieBox.';
  const backIndex = steps.lastIndexOf('0');
  const path = steps.slice(backIndex + 1).join('*');
  const menu = () => `CON PieBox\n1. Hali ya mtandao\n2. Providers${admin ? '\n3. Auto routing\n4. Airtime' : ''}\n0. Toka`;
  try {
    if (path === '') return menu();
    if (path === '1') {
      const state = await core.status();
      const active = state.links.find(link => link.id === state.activeWan)?.label || 'Hakuna';
      const ready = state.links.filter(link => link.healthy !== false).length;
      return `CON Hali ya PieBox\nMtandao: ${active}\nMode: ${state.mode === 'auto' ? 'AUTO' : 'MANUAL'}\nProviders: ${ready}/${state.links.length} tayari\n0. Rudi`;
    }
    if (path === '2') {
      const state = await core.status();
      return `CON Providers\n${state.links.map((link, i) => `${i + 1}. ${link.label} (${link.id === state.activeWan ? 'active' : link.healthy === false ? 'down' : 'ready'})`).join('\n')}\n0. Rudi`;
    }
    if (/^2\*\d+$/.test(path)) {
      if (!admin) return 'END Kubadili provider kunahitaji namba ya admin.';
      const state = await core.status();
      const choice = Number(path.slice(2));
      if (!Number.isInteger(choice) || choice < 1 || choice > state.links.length) return 'END Chaguo si sahihi.';
      const link = state.links[choice - 1];
      if (link.id === state.activeWan) return `END ${link.label} tayari ndio mtandao active.`;
      if (link.healthy === false) return `END ${link.label} haipatikani sasa. Chagua provider mwingine.`;
      const result = await core.command({ deviceId: config.deviceId, actor: phone, channel: 'ussd',
        action: 'switch_wan', targetWan: link.id, idempotencyKey: `${sessionId}:${path}` });
      return `END Ombi la kuhamia ${link.label} limepokelewa. Utapata SMS ya matokeo.`;
    }
    if (path === '3') return admin ? 'CON Auto routing\n1. Washa\n2. Zima\n0. Rudi' : 'END Auto routing inahitaji namba ya admin.';
    if (path === '3*1' || path === '3*2') {
      if (!admin) return 'END Auto routing inahitaji namba ya admin.';
      const result = await core.command({ deviceId: config.deviceId, actor: phone, channel: 'ussd',
        action: path === '3*1' ? 'auto_on' : 'auto_off', idempotencyKey: `${sessionId}:${path}` });
      return `END Ombi la ${path === '3*1' ? 'kuwasha' : 'kuzima'} Auto routing limepokelewa. Utapata SMS ya matokeo.`;
    }
    if (path === '4') return admin ? `CON Airtime TZS 1,000\nKwa: ${phone}\n1. Thibitisha\n0. Rudi` : 'END Airtime inahitaji namba ya admin.';
    if (path === '4*1') {
      if (!admin) return 'END Airtime inahitaji namba ya admin.';
      const result = await core.airtimeReward({ phone, sessionId });
      return result.reward.status === 'failed'
        ? 'END Ombi la airtime limeshindwa. Tazama SMS kwa maelezo.'
        : 'END Ombi la airtime TZS 1,000 limepokelewa. Utapata SMS ya hali yake.';
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
