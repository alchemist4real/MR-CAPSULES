// api/telemetry.js
// High-throughput, non-blocking telemetry ingest endpoint for Mr. Capsules
import crypto from 'crypto';

function hashIp(rawIp) {
  const salt = process.env.IP_HASH_SALT || 'capsules_salt_privacy_2026';
  return crypto.createHash('sha256').update((rawIp || '127.0.0.1') + salt).digest('hex').slice(0, 32);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-info');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://hdhvrlkizorscvehttzd.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

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
