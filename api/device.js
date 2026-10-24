// api/device.js
// Advanced Serverless Device Tracking, Safari ITP Recognition & Telemetry Ingest
import crypto from 'crypto';

function parseCookie(cookieStr, key) {
  if (!cookieStr) return null;
  const match = cookieStr.match(new RegExp('(?:^|;\\s*)' + key + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function hashIp(rawIp) {
  const salt = process.env.IP_HASH_SALT || 'capsules_salt_privacy_2026';
  return crypto.createHash('sha256').update((rawIp || '127.0.0.1') + salt).digest('hex').slice(0, 32);
}

function setDeviceCookie(res, deviceId) {
  const isHttps = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const cookieVal = `mr_device_id=${deviceId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookieVal);
}

// Telemetry Ingest Handler
async function handleTelemetryIngest(req, res, supabaseUrl, serviceKey) {
  try {
    let body = {};
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        body = {};
      }
    } else {
      body = req.body || {};
    }

    // 1. Resolve User Identity (via Auth Token or Payload Fallback)
    let authUser = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${token}`
          }
        });
        if (userRes.ok) {
          authUser = await userRes.json();
        }
      } catch (e) {
        // Fallback to anonymous/guest if token verification encounters network error
      }
    }

    const userId = authUser ? authUser.id : (body.user_id || null);
    const userEmail = authUser ? authUser.email : (body.user_email || null);
    const isGuest = body.is_guest === true || (!authUser && (!userEmail || userEmail.startsWith('guest_') || userEmail.includes('@mrcapsules.com')));
    const userRole = authUser?.user_metadata?.role || (isGuest ? 'guest' : 'user');

    // 2. Extract Device & Network Telemetry
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    const ipHash = hashIp(rawIp);
    const geoCountry = req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || null;
    const geoCity = req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // 3. Normalize Events Array
    const rawEvents = Array.isArray(body.events) ? body.events : [body];
    const validEvents = [];

    for (const ev of rawEvents) {
      if (!ev || (!ev.event_type && !ev.type)) continue;

      const eventType = String(ev.event_type || ev.type).trim();
      const severity = ['info', 'warning', 'security', 'error'].includes(ev.severity) ? ev.severity : 'info';
      const payload = typeof ev.payload === 'object' && ev.payload !== null ? ev.payload : (ev.details || {});
      const sessionId = ev.session_id || body.session_id || null;
      const deviceId = ev.device_id || body.device_id || null;

      const evUserId = authUser ? authUser.id : (ev.user_id || userId);
      const evUserEmail = authUser ? authUser.email : (ev.user_email || userEmail);
      const evIsGuest = isGuest || ev.is_guest === true;

      validEvents.push({
        user_id: evUserId,
        user_email: evUserEmail,
        user_role: userRole,
        is_guest: evIsGuest,
        session_id: sessionId,
        device_id: deviceId,
        event_type: eventType,
        severity: severity,
        payload: payload,
        ip_hash: ipHash,
        geo_city: geoCity,
        geo_country: geoCountry,
        user_agent: userAgent,
        created_at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString()
      });
    }

    if (validEvents.length === 0) {
      return res.status(400).json({ error: 'No valid events provided in payload' });
    }

    // 4. Batch Insert into user_activity_logs
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/user_activity_logs`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(validEvents)
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[Telemetry Ingest] Supabase insert error:', errText);
      return res.status(500).json({ error: 'Failed to persist telemetry batch', details: errText });
    }

    return res.status(200).json({ success: true, count: validEvents.length });
  } catch (err) {
    console.error('[Telemetry Ingest Error]:', err);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-info');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://hdhvrlkizorscvehttzd.supabase.co';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzI2MzA3MiwiZXhwIjoyMDkyODM5MDcyfQ.1fW24fXFAZx98dtLelrWmw8ROvkRcap8ObsMkWpy-6E';

  // Check if this is a Telemetry request
  const host = req.headers.host || 'mr-capsules.vercel.app';
  const urlObj = new URL(req.url, `https://${host}`);
  const isTelemetry = urlObj.pathname.includes('/telemetry') || 
                      req.query.action === 'telemetry' || 
                      (req.method === 'POST' && req.body && (req.body.events || (req.body.event_type && !req.body.client_device_id && !req.body.browser)));

  if (isTelemetry) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    return handleTelemetryIngest(req, res, supabaseUrl, serviceKey);
  }

  // 1. Resolve Device ID (Cookie first, client ID second, new UUID fallback)
  let cookieDevId = parseCookie(req.headers.cookie, 'mr_device_id');
  let deviceId = cookieDevId;

  if (req.method === 'GET') {
    if (!deviceId) {
      deviceId = crypto.randomUUID();
    }
    setDeviceCookie(res, deviceId);
    return res.status(200).json({ success: true, device_id: deviceId });
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      body = {};
    }

    if (!deviceId) {
      if (body.client_device_id && typeof body.client_device_id === 'string' && !body.client_device_id.startsWith('dev_')) {
        deviceId = body.client_device_id;
      } else {
        deviceId = crypto.randomUUID();
      }
    }

    // Refresh durable HttpOnly cookie for 1 year
    setDeviceCookie(res, deviceId);

    // 2. Extract network & geo telemetry (Vercel native headers)
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    const ipHash = hashIp(rawIp);
    const country = req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || null;
    const city = req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null;

    // 3. Extract browser, OS, and Safari flag
    const ua = (req.headers['user-agent'] || '').slice(0, 512);
    const browser = body.browser || 'Unknown Browser';
    const os = body.os || 'Unknown OS';
    const deviceType = body.device_type || (os === 'iPad' ? 'tablet' : (/iPhone|Android/i.test(os) ? 'mobile' : 'desktop'));
    const isSafari = Boolean(body.is_safari !== undefined ? body.is_safari : (/Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua)));
    const fingerprint = body.fingerprint && typeof body.fingerprint === 'string' ? body.fingerprint : null;

    // 4. Check banned devices list
    let isBanned = false;
    try {
      const setRes = await fetch(`${supabaseUrl}/rest/v1/app_settings?select=banned_devices&limit=1`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });
      if (setRes.ok) {
        const rows = await setRes.json();
        const banned = (rows && rows[0]?.banned_devices) || [];
        if (banned.includes(deviceId) || (fingerprint && banned.includes(fingerprint))) {
          isBanned = true;
        }
      }
    } catch (e) {}

    // 5. Authenticate user if Bearer token is provided
    let authUser = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '').trim();
      if (token) {
        try {
          const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
          });
          if (userRes.ok) {
            authUser = await userRes.json();
          }
        } catch (e) {}
      }
    }

    // 6. Upsert into Supabase user_devices if user is authenticated
    if (authUser && authUser.id) {
      try {
        const devicePayload = {
          user_id: authUser.id,
          device_id: deviceId,
          device_name: `${browser} / ${os}`,
          user_agent: ua,
          fingerprint: fingerprint,
          browser: browser,
          os: os,
          device_type: deviceType,
          country: country,
          city: city,
          ip_hash: ipHash,
          is_safari: isSafari,
          last_seen: new Date().toISOString()
        };

        await fetch(`${supabaseUrl}/rest/v1/user_devices`, {
          method: 'POST',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify([devicePayload])
        });

        // Clean up any legacy ephemeral dev_ fallbacks for this user
        if (!deviceId.startsWith('dev_')) {
          await fetch(`${supabaseUrl}/rest/v1/user_devices?user_id=eq.${authUser.id}&device_id=like.dev_%25`, {
            method: 'DELETE',
            headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
          });
        }
      } catch (err) {
        console.error('Failed to upsert user_device:', err);
      }
    }

    return res.status(200).json({
      success: true,
      device_id: deviceId,
      banned: isBanned,
      country: country,
      city: city,
      ip_hash: ipHash,
      is_safari: isSafari
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
