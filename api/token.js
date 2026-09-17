// api/token.js
// OAuth 2.0 Token Endpoint (RFC 6749 / RFC 7636 PKCE S256) with Refresh Token Rotation

import crypto from 'crypto';

function base64url(buffer) {
  return buffer.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sanitizeBase64Url(str) {
  if (!str) return '';
  return String(str).trim()
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function verifyPkce(codeVerifier, codeChallenge, method = 'S256') {
  if (!codeChallenge) return true; // Optional if no challenge was sent
  const cleanChallenge = sanitizeBase64Url(codeChallenge);
  const cleanVerifier = String(codeVerifier || '').trim();
  const sanitizedVerifier = sanitizeBase64Url(cleanVerifier);

  const cleanMethod = (method || 'S256').toUpperCase();

  if (cleanMethod === 'S256') {
    const hash1 = base64url(crypto.createHash('sha256').update(cleanVerifier).digest());
    if (hash1 === cleanChallenge) return true;
    const hash2 = base64url(crypto.createHash('sha256').update(sanitizedVerifier).digest());
    if (hash2 === cleanChallenge) return true;
    try {
      const decoded = decodeURIComponent(cleanVerifier);
      const hash3 = base64url(crypto.createHash('sha256').update(decoded).digest());
      if (hash3 === cleanChallenge) return true;
    } catch(e) {}
    return false;
  }
  if (cleanMethod === 'PLAIN') {
    return cleanVerifier === cleanChallenge || sanitizedVerifier === cleanChallenge;
  }
  return false;
}

export default async function handler(req, res) {
  const SUPABASE_URL = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SB_SERVICE_KEY) {
    return res.status(500).json({ error: 'server_error', error_description: 'Service role key not configured' });
  }

  // RFC 6749 Section 5.1: MUST include Cache-Control: no-store and Pragma: no-cache
  const requestOrigin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, api-key');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'invalid_request', error_description: 'Method not allowed' });
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    body = body.toString('utf-8');
  }
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try { body = JSON.parse(trimmed); } catch(e) {}
    }
    if (typeof body === 'string') {
      try {
        const params = new URLSearchParams(trimmed);
        const parsed = Object.fromEntries(params.entries());
        if (Object.keys(parsed).length > 0 && parsed[Object.keys(parsed)[0]] !== '') {
          body = parsed;
        } else {
          try { body = JSON.parse(trimmed); } catch(err) {}
        }
      } catch(e) {
        try { body = JSON.parse(trimmed); } catch(err) {}
      }
    }
  }

  body = body || {};

  // Extract client credentials from Basic Auth header (ChatGPT Action standard) or body
  const authHeader = req.headers.authorization || '';
  let authClientId = body.client_id;
  let authClientSecret = body.client_secret;

  if (authHeader.startsWith('Basic ')) {
    try {
      const creds = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf-8');
      const colonIdx = creds.indexOf(':');
      if (colonIdx !== -1) {
        authClientId = creds.slice(0, colonIdx);
        authClientSecret = creds.slice(colonIdx + 1);
      }
    } catch(e) {}
  }

  const grantType = body.grant_type;

  if (!grantType) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Missing grant_type parameter' });
  }

  // ── 1. Authorization Code Grant ──────────────────────────────────────────
  if (grantType === 'authorization_code') {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier || body.code_challenge; // Fallback

    if (!code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code parameter' });
    }

    if (!SB_SERVICE_KEY) {
      return res.status(500).json({ error: 'server_error', error_description: 'Service role key not configured' });
    }

    // Fetch code from Supabase oauth_codes
    const codeRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_codes?code=eq.${encodeURIComponent(code)}&select=*`, {
      headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
    });

    if (!codeRes.ok) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Failed to query authorization code' });
    }

    const rows = await codeRes.json();
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid, expired, or used authorization code' });
    }

    const codeRecord = rows[0];

    // Reject guest accounts from receiving OAuth tokens
    if (codeRecord.user_email && (codeRecord.user_email.toLowerCase().startsWith('guest_') || /^guest_\d+_\d+@/i.test(codeRecord.user_email))) {
      await fetch(`${SUPABASE_URL}/rest/v1/oauth_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
      });
      return res.status(403).json({ error: 'access_denied', error_description: 'Guest accounts cannot be issued OAuth tokens' });
    }

    // Check expiration
    if (new Date(codeRecord.expires_at) < new Date()) {
      // Delete expired code
      await fetch(`${SUPABASE_URL}/rest/v1/oauth_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
      });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    }

    // Verify PKCE BEFORE deleting code
    if (codeRecord.code_challenge) {
      if (!codeVerifier) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Missing code_verifier for PKCE' });
      }
      const pkceValid = verifyPkce(codeVerifier, codeRecord.code_challenge, codeRecord.code_challenge_method);
      if (!pkceValid) {
        console.error(`[OAuth PKCE Failure] timestamp="${new Date().toISOString()}" code="${code.slice(0, 15)}..." challenge_len=${codeRecord.code_challenge?.length || 0}`);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
    }

    // Delete single-use authorization code ONLY after successful PKCE validation
    await fetch(`${SUPABASE_URL}/rest/v1/oauth_codes?code=eq.${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
    });

    // Issue Access Token and Refresh Token
    const accessToken = `mrc_at_${crypto.randomBytes(32).toString('hex')}`;
    const refreshToken = `mrc_rt_${crypto.randomBytes(32).toString('hex')}`;
    const expiresIn = 86400; // 24 hours (prevents frequent expiration drops on mobile/Claude)
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
    const targetResource = body.resource || codeRecord.resource || `https://${host}/api/mcp`;
    let tokenUserId = String(codeRecord.user_id || codeRecord.user_email);
    if (!tokenUserId || !tokenUserId.includes('-')) {
      tokenUserId = crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-' + crypto.randomBytes(6).toString('hex');
    }

    // Store token pair in Supabase oauth_tokens
    const saveTokenRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens`, {
      method: 'POST',
      headers: {
        'apikey': SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        client_id: codeRecord.client_id,
        user_id: tokenUserId,
        user_email: codeRecord.user_email,
        resource: targetResource,
        expires_at: expiresAt,
        revoked: false
      })
    });

    if (!saveTokenRes.ok) {
      const errText = await saveTokenRes.text();
      console.error(`[OAuth Token Save Error] status=${saveTokenRes.status} body=${errText}`);
      return res.status(500).json({ error: 'server_error', error_description: 'Failed to persist access token: ' + errText });
    }

    console.log(`[OAuth Token Issued] timestamp="${new Date().toISOString()}" iss="https://${req.headers.host || 'mr-capsules.vercel.app'}" aud="${targetResource}" sub="${codeRecord.user_email}" client_id="${codeRecord.client_id}" access_token="${accessToken.slice(0, 15)}..."`);

    return res.status(200).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: 'mcp'
    });
  }

  // ── 2. Refresh Token Grant (Token Rotation with Parallel Grace Period) ───
  if (grantType === 'refresh_token') {
    const refreshTokenInput = body.refresh_token;
    if (!refreshTokenInput) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token parameter' });
    }

    if (!SB_SERVICE_KEY) {
      return res.status(500).json({ error: 'server_error', error_description: 'Service role key not configured' });
    }

    // Fetch existing token record
    const tokenRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens?refresh_token=eq.${encodeURIComponent(refreshTokenInput)}&revoked=eq.false&select=*`, {
      headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
    });

    if (!tokenRes.ok) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Failed to query refresh token' });
    }

    let rows = await tokenRes.json();
    let oldToken = (rows && rows.length > 0) ? rows[0] : null;

    // Grace period check for parallel requests (e.g. Claude issuing concurrent requests)
    if (!oldToken) {
      const graceRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens?refresh_token=eq.${encodeURIComponent(refreshTokenInput)}&revoked=eq.true&order=created_at.desc&limit=1`, {
        headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
      });
      if (graceRes.ok) {
        const graceRows = await graceRes.json();
        if (graceRows && graceRows.length > 0) {
          const recent = graceRows[0];
          const revokedAgeMs = Date.now() - new Date(recent.created_at).getTime();
          if (revokedAgeMs < 60000) {
            const activeRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens?client_id=eq.${encodeURIComponent(recent.client_id)}&user_email=eq.${encodeURIComponent(recent.user_email)}&revoked=eq.false&order=created_at.desc&limit=1`, {
              headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
            });
            if (activeRes.ok) {
              const activeRows = await activeRes.json();
              if (activeRows && activeRows.length > 0) {
                const latest = activeRows[0];
                return res.status(200).json({
                  access_token: latest.access_token,
                  token_type: 'Bearer',
                  expires_in: 86400,
                  refresh_token: latest.refresh_token,
                  scope: 'mcp'
                });
              }
            }
          }
        }
      }
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid, revoked, or expired refresh token' });
    }

    // Revoke old refresh token (Rotation enforcement)
    await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens?access_token=eq.${encodeURIComponent(oldToken.access_token)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ revoked: true })
    });

    // Issue new token pair (24h lifespan)
    const newAccessToken = `mrc_at_${crypto.randomBytes(32).toString('hex')}`;
    const newRefreshToken = `mrc_rt_${crypto.randomBytes(32).toString('hex')}`;
    const expiresIn = 86400; // 24 hours
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/oauth_tokens`, {
      method: 'POST',
      headers: {
        'apikey': SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        client_id: oldToken.client_id,
        user_id: oldToken.user_id,
        user_email: oldToken.user_email,
        resource: oldToken.resource,
        expires_at: expiresAt,
        revoked: false
      })
    });

    return res.status(200).json({
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: 'mcp'
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grantType}` });
}
