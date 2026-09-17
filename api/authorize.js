// api/authorize.js
// Real OAuth 2.0 Authorization Endpoint with PKCE, RFC 8707 Resource, and Auto-Detected Session

import crypto from 'crypto';

function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const port = (parsed.port && parsed.port !== '80' && parsed.port !== '443') ? `:${parsed.port}` : '';
    let pathname = parsed.pathname.replace(/\/+$/, '');
    return `${scheme}//${host}${port}${pathname}`;
  } catch (e) {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  }
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
  const SUPABASE_URL = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const issuer = `https://${host}`;

  function isOriginAllowed(origin) {
    if (!origin) return true;
    const lower = origin.toLowerCase();
    return (
      lower.endsWith('claude.ai') ||
      lower.endsWith('anthropic.com') ||
      lower.endsWith('openai.com') ||
      lower.endsWith('chatgpt.com') ||
      lower.endsWith('oaistatic.com') ||
      lower.endsWith('oaiusercontent.com') ||
      lower.endsWith('antigravity.google') ||
      lower.includes('google.com') ||
      lower.includes('gemini.google.com') ||
      lower.includes('antigravity') ||
      lower.endsWith('vercel.app') ||
      lower.includes('localhost') ||
      lower.includes('127.0.0.1')
    );
  }

  const requestOrigin = req.headers.origin || '';
  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Helper for HTML escaping
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const url = new URL(req.url, `https://${host}`);

  // RFC 7591 Dynamic Client Registration Endpoint
  if (req.url && (req.url.includes('/register') || url.searchParams.get('action') === 'register' || (req.method === 'POST' && req.body && req.body.client_name))) {
    return handleClientRegistration(req, res, SUPABASE_URL, SB_SERVICE_KEY);
  }

  // RFC 8414 & OpenID Connect Discovery Metadata
  if (req.url && (req.url.includes('oauth-authorization-server') || req.url.includes('openid-configuration'))) {
    return res.status(200).json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      userinfo_endpoint: `${issuer}/api/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["HS256", "RS256"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["mcp", "openid", "profile", "email"],
      logo_uri: `${issuer}/logo.png`,
      icon_uri: `${issuer}/logo.png`,
      logo_url: `${issuer}/logo.png`,
      icon_url: `${issuer}/logo.png`,
      service_documentation: `${issuer}/docs#docsMcp`,
      client_name: "Mr. Capsules",
      name: "Mr. Capsules"
    });
  }

  // Parse OAuth query parameters
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state') || '';
  const responseType = url.searchParams.get('response_type') || 'code';
  const clientId = url.searchParams.get('client_id') || 'claude-mcp-client';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
  const resourceParam = url.searchParams.get('resource') || `${issuer}/api/mcp`;
  const canonicalResource = canonicalizeUrl(resourceParam);

  if (!redirectUri) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorization Error | Mr. Capsules</title></head>
      <body style="font-family:'OffBit-Dot','Courier New',monospace; padding:40px; text-align:center; background:#DCF4A2; color:#0055A4;">
        <h2>Missing redirect_uri parameter</h2>
        <p>This endpoint is used for OAuth 2.0 authorization by Claude.ai.</p>
      </body>
      </html>
    `);
  }

  function isAllowedRedirectUri(uri) {
    if (!uri || typeof uri !== 'string') return false;
    const trimmed = uri.trim();

    // Support custom desktop application URI schemes
    if (/^(chatgpt|openai|claude|vscode|cursor|antigravity|gemini):\/\//i.test(trimmed)) {
      return true;
    }

    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const protocol = parsed.protocol.toLowerCase();

      if (protocol !== 'http:' && protocol !== 'https:') {
        return false;
      }

      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local')
      ) {
        return true;
      }

      if (
        host === 'chatgpt.com' ||
        host.endsWith('.chatgpt.com') ||
        host === 'openai.com' ||
        host.endsWith('.openai.com') ||
        host === 'claude.ai' ||
        host.endsWith('.claude.ai') ||
        host === 'anthropic.com' ||
        host.endsWith('.anthropic.com') ||
        host === 'antigravity.google' ||
        host.endsWith('.antigravity.google') ||
        host === 'google.com' ||
        host.endsWith('.google.com') ||
        host === 'gemini.google.com' ||
        host === 'mr-capsules.vercel.app' ||
        host.endsWith('.vercel.app')
      ) {
        return true;
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  if (!isAllowedRedirectUri(redirectUri)) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorization Error | Mr. Capsules</title></head>
      <body style="font-family:'OffBit-Dot','Courier New',monospace; padding:40px; text-align:center; background:#DCF4A2; color:#0055A4;">
        <h2>Invalid redirect_uri parameter</h2>
        <p>The redirect URI <code>${escHtml(redirectUri)}</code> is not allowed.</p>
      </body>
      </html>
    `);
  }

  let errorMessage = '';

  // Handle POST submit (User Approval / Authentication)
  if (req.method === 'POST') {
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
    const email = (body.email || body.user_email || '').trim();
    const password = (body.password || '').trim();
    const sessionToken = (body.session_token || body.access_token || '').trim();

    let authenticatedUser = null;

    const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';

    // 1. Try active session token verification if provided
    if (sessionToken) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            'apikey': SB_SERVICE_KEY || ANON_KEY,
            'Authorization': `Bearer ${sessionToken}`
          }
        });
        if (userRes.ok) {
          authenticatedUser = await userRes.json();
        }
      } catch(e) {}
    }

    // 2. Fall back to password authentication if not authenticated by session token
    if (!authenticatedUser && email && password) {
      let targetEmail = email.toLowerCase().trim();

      // Auto-resolve username to email if no @ symbol
      if (!targetEmail.includes('@') && SB_SERVICE_KEY) {
        try {
          const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
            headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
          });
          if (uRes.ok) {
            const uData = await uRes.json();
            const matched = (uData.users || []).find(u =>
              (u.user_metadata?.username && u.user_metadata.username.toLowerCase() === targetEmail) ||
              (u.user_metadata?.full_name && u.user_metadata.full_name.toLowerCase() === targetEmail) ||
              (u.email && u.email.toLowerCase().startsWith(targetEmail + '@'))
            );
            if (matched) targetEmail = matched.email;
          }
        } catch(e) {}
      }

      try {
        let authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'apikey': ANON_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email: targetEmail, password })
        });

        if (!authRes.ok && SB_SERVICE_KEY) {
          authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
              'apikey': SB_SERVICE_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email: targetEmail, password })
          });
        }

        if (authRes.ok) {
          const authData = await authRes.json();
          authenticatedUser = authData.user;
        } else {
          const authErr = await authRes.json();
          errorMessage = authErr.error_description || authErr.msg || 'Invalid email or password.';
        }
      } catch(err) {
        errorMessage = 'Authentication error: ' + err.message;
      }
    }

    // Explicitly reject guest accounts from OAuth authorization
    if (authenticatedUser) {
      const uEmail = (authenticatedUser.email || email).toLowerCase().trim();
      const isGuest = uEmail.startsWith('guest_') || /^guest_\d+_\d+@/i.test(uEmail) || authenticatedUser.user_metadata?.is_guest === true;
      if (isGuest) {
        errorMessage = 'Guest accounts cannot authorize external AI connectors. Please sign in with a registered account.';
        authenticatedUser = null;
      }
    }

    if (authenticatedUser && SB_SERVICE_KEY) {
      // Generate single-use authorization code (valid 10 mins)
      const code = `mrc_code_${crypto.randomBytes(24).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const userEmail = authenticatedUser.email || email;
      let userId = authenticatedUser.id && String(authenticatedUser.id).includes('-') ? authenticatedUser.id : null;
      if (!userId && userEmail && SB_SERVICE_KEY) {
        try {
          const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
            headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` }
          });
          if (uRes.ok) {
            const uData = await uRes.json();
            const matched = (uData.users || []).find(u => u.email === userEmail);
            if (matched) userId = matched.id;
          }
        } catch(e) {}
      }
      if (!userId) userId = '5e1efdb8-cf7c-4e27-946e-43a4e035cdf4';

      // Save code in Supabase oauth_codes with canonical resource
      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_codes`, {
        method: 'POST',
        headers: {
          'apikey': SB_SERVICE_KEY,
          'Authorization': `Bearer ${SB_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          code,
          client_id: clientId,
          user_id: userId,
          user_email: userEmail,
          redirect_uri: redirectUri,
          resource: canonicalResource,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          expires_at: expiresAt
        })
      });

      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error(`[OAuth Code Save Error] status=${saveRes.status} body=${errText}`);
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>OAuth Server Error</title></head>
          <body style="font-family:'OffBit-Dot','Courier New',monospace; padding:40px; text-align:center; background:#DCF4A2; color:#0055A4;">
            <h2>Failed to issue authorization code</h2>
            <p style="color:#003870;">${escHtml(errText)}</p>
          </body>
          </html>
        `);
      }

      // Structured Server-Side Logging for correlation
      console.log(`[OAuth Auth Code Issued] timestamp="${new Date().toISOString()}" iss="${issuer}" aud="${canonicalResource}" sub="${userEmail}" client_id="${clientId}" code="${code.slice(0, 15)}..."`);

      // Redirect back to Claude.ai auth_callback
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);

      res.writeHead(302, { Location: callbackUrl.toString() });
      return res.end();
    } else if (!errorMessage) {
      if (sessionToken && !password) {
        errorMessage = 'Your browser session has expired. Please enter your password below.';
      } else if (!password) {
        errorMessage = 'Please enter your password to continue.';
      } else {
        errorMessage = 'Please enter your valid login credentials.';
      }
    }
  }

  // Render modern Mr. Capsules User Login Page with Session Auto-Detection
  const actionUrl = `/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=${encodeURIComponent(codeChallengeMethod)}&resource=${encodeURIComponent(canonicalResource)}`;

  // Detect client type for tailored UI branding
  const isAntigravity = clientId.includes('antigravity') || 
                        clientId.includes('gemini') || 
                        (redirectUri && (redirectUri.includes('antigravity') || redirectUri.startsWith('antigravity://') || redirectUri.startsWith('gemini://')));
  const isChatGPT = !isAntigravity && ((redirectUri && (redirectUri.includes('openai.com') || redirectUri.includes('chatgpt.com'))) || clientId.includes('chatgpt') || clientId.includes('openai'));
  const isClaude = !isAntigravity && !isChatGPT && (clientId.includes('claude') || (redirectUri && redirectUri.includes('claude.ai')));
  const clientDisplayName = isAntigravity ? 'Google Antigravity' : (isChatGPT ? 'ChatGPT' : (isClaude ? 'Claude' : 'AI Assistant'));

  const clientBadgeStyle = isAntigravity
    ? 'background:var(--c4, #003870); color:var(--c1, #DCF4A2); border:1.5px solid var(--c4, #003870);'
    : (isChatGPT 
      ? 'background:var(--c4, #003870); color:var(--c1, #DCF4A2); border:1.5px solid var(--c4, #003870);' 
      : 'background:transparent; color:var(--c4, #003870); border:1.5px solid var(--border-medium, rgba(0,85,164,0.45));');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Authorize ${escHtml(clientDisplayName)} | Mr. Capsules</title>
      <link rel="icon" type="image/png" href="/logo.png">
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
      <link rel="shortcut icon" href="/favicon.png">
      <link rel="stylesheet" href="/tokens.css">
      <style>
        /* ── Mr. Capsules 4-color palette (mirrors /tokens.css):
             --c1 #DCF4A2 base · --c2 #C7E885 panel · --c3 #0055A4 ink · --c4 #003870 accent ── */
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'OffBit-Dot', 'Courier New', monospace;
          background: var(--c1, #DCF4A2);
          color: var(--c3, #0055A4);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .auth-card {
          background: var(--c1, #DCF4A2);
          border: 1.5px solid var(--c3, #0055A4);
          border-radius: 8px;
          padding: 36px 32px;
          max-width: 440px;
          width: 100%;
          box-shadow: none;
          text-align: center;
          position: relative;
        }
        .logo-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-bottom: 20px;
        }
        .logo-icon { width: 40px; height: 40px; border-radius: 8px; }
        .plus-icon { color: var(--text-muted, #0055A4); font-size: 18px; font-weight: 300; opacity: 0.6; }
        .client-badge {
          ${clientBadgeStyle}
          font-family: 'OffBit-DotBold', 'Courier New', monospace;
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.03em;
          padding: 6px 14px;
          border-radius: 99px;
        }
        h1 {
          font-family: 'OffBit-DotBold', 'Courier New', monospace;
          font-size: 22px;
          font-weight: 700;
          margin-bottom: 6px;
          color: var(--c3, #0055A4);
          letter-spacing: 0.05em;
        }
        p.subtitle {
          color: var(--text-muted, #0055A4);
          font-size: 13px;
          line-height: 1.5;
          margin-bottom: 22px;
        }
        .session-detected-box {
          display: none;
          background: color-mix(in srgb, var(--c3, #0055A4) 8%, transparent);
          border: 1.5px solid var(--c3, #0055A4);
          color: var(--c3, #0055A4);
          padding: 14px 16px;
          border-radius: 8px;
          font-size: 13px;
          margin-bottom: 20px;
          text-align: left;
        }
        .session-badge {
          display: inline-block;
          background: var(--c4, #003870);
          color: var(--c1, #DCF4A2);
          font-family: 'OffBit-DotBold', monospace;
          font-size: 10.5px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 99px;
        }
        .session-user-line {
          font-size: 14px;
          color: var(--c4, #003870);
          margin-top: 6px;
          word-break: break-all;
        }
        .error-banner {
          background: color-mix(in srgb, var(--danger, #003870) 10%, transparent);
          border: 1.5px solid color-mix(in srgb, var(--danger, #003870) 45%, transparent);
          color: var(--danger, #003870);
          padding: 12px 14px;
          border-radius: 8px;
          font-size: 13px;
          margin-bottom: 20px;
          text-align: left;
        }
        .input-group { margin-bottom: 18px; text-align: left; position: relative; }
        label {
          display: block;
          font-family: 'OffBit-DotBold', 'Courier New', monospace;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted, #0055A4);
          margin-bottom: 6px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        input[type="email"], input[type="text"], input[type="password"] {
          width: 100%;
          padding: 12px 16px;
          border-radius: 99px;
          border: 1.5px solid var(--c3, #0055A4);
          background: transparent;
          color: var(--c3, #0055A4);
          font-family: 'OffBit-Dot', 'Courier New', monospace;
          font-size: 16px; /* 16px prevents iOS Safari from auto-zooming on focus */
          outline: none;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
          -webkit-appearance: none;
        }
        input[type="email"]:focus, input[type="text"]:focus, input[type="password"]:focus {
          border-color: var(--c4, #003870);
          box-shadow: 0 0 0 3px var(--focus-ring, rgba(0,85,164,0.45));
        }
        .password-wrapper { position: relative; }
        .password-toggle {
          position: absolute;
          right: 14px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          color: var(--text-muted, #0055A4);
          cursor: pointer;
          font-family: 'OffBit-DotBold', 'Courier New', monospace;
          font-size: 12px;
          padding: 4px;
        }
        .password-toggle:hover { color: var(--c3, #0055A4); }
        .btn-submit {
          width: 100%;
          padding: 14px;
          border-radius: 99px;
          border: none;
          background: var(--c3, #0055A4);
          color: var(--c1, #DCF4A2);
          font-family: 'OffBit-DotBold', 'Courier New', monospace;
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 0.03em;
          cursor: pointer;
          transition: opacity 0.2s ease, transform 0.1s ease, background 0.2s ease;
          margin-top: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .btn-submit:hover:not(:disabled) { opacity: 0.9; }
        .btn-submit:active:not(:disabled) { transform: scale(0.98); }
        .btn-submit:disabled {
          opacity: 0.75;
          cursor: not-allowed;
          background: var(--c4, #003870);
        }
        .btn-switch-account {
          background: none;
          border: none;
          color: var(--c4, #003870);
          font-family: 'OffBit-Dot', monospace;
          font-size: 12px;
          text-decoration: underline;
          cursor: pointer;
          padding: 4px 8px;
          transition: opacity 0.2s;
        }
        .btn-switch-account:hover { opacity: 0.75; }
        .spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(220, 244, 162, 0.4);
          border-top-color: var(--c1, #DCF4A2);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .footer-note { font-size: 12px; color: var(--text-muted, #0055A4); margin-top: 20px; letter-spacing: 0.05em; }
        .footer-note a { color: var(--c4, #003870); text-decoration: underline; font-weight: 500; }
        .footer-note a:hover { opacity: 0.8; }
      </style>
    </head>
    <body>
      <div class="auth-card">
        <div class="logo-row">
          <img src="/logo.svg" alt="MR-CAPSULES" class="logo-icon">
          <span class="plus-icon">&amp;</span>
          <span class="client-badge">${escHtml(clientDisplayName)}</span>
        </div>
        <h1>Connect to Mr. Capsules</h1>
        <p class="subtitle">Authorize <strong>${escHtml(clientDisplayName)}</strong> to access medical curriculum, content repository, Kanban tasks, and DoctorTablet clinical vault.</p>

        <!-- Active Session Card (shown and expanded when session detected) -->
        <div id="session-detected-box" class="session-detected-box">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <span class="session-badge">✓ Active Account</span>
            <span style="font-size:11px; color:var(--c4, #003870); opacity:0.8;">One-Click Authorize</span>
          </div>
          <div class="session-user-line">
            Signed in as: <strong id="detected-user-email"></strong>
          </div>
          <div style="font-size:12px; color:var(--text-muted, #0055A4); margin-top:4px;">
            Ready to connect directly with your existing browser session.
          </div>
        </div>

        ${errorMessage ? `<div class="error-banner">${escHtml(errorMessage)}</div>` : ''}

        <form id="auth-form" method="POST" action="${actionUrl}">
          <input type="hidden" id="session_token" name="session_token" value="">
          
          <!-- Credentials inputs group: HIDDEN if active session detected, VISIBLE if no session or switcher clicked -->
          <div id="credentials-group">
            <div class="input-group">
              <label for="email">Email Address / Username</label>
              <input type="text" id="email" name="email" placeholder="user@domain.com" required autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email">
            </div>
            
            <div class="input-group">
              <label for="password">Password</label>
              <div class="password-wrapper">
                <input type="password" id="password" name="password" placeholder="Enter your password" autocomplete="current-password" required autocapitalize="none" autocorrect="off" spellcheck="false">
                <button type="button" class="password-toggle" onclick="togglePasswordVisibility()">Show</button>
              </div>
            </div>
          </div>
          
          <button type="submit" id="submit-btn" class="btn-submit">
            <span id="btn-text">Approve &amp; Connect ${escHtml(clientDisplayName)}</span>
          </button>

          <!-- Toggle switch to use another account or reveal password -->
          <div id="switch-account-row" style="display:none; margin-top:14px;">
            <button type="button" id="switch-account-btn" class="btn-switch-account" onclick="switchToPasswordLogin()">
              ⇄ Use different account or re-enter password
            </button>
          </div>
        </form>

        <div class="footer-note">
          MR-CAPSULES OAuth 2.0 PKCE Protection • <a href="/admin.html" target="_blank">Admin Portal</a>
        </div>
      </div>

      <script>
        var clientName = ${JSON.stringify(clientDisplayName)};
        var hasError = ${JSON.stringify(!!errorMessage)};
        var sessionMode = false;

        (function() {
          try {
            var userEmail = null;
            var tokenVal = null;

            for (var i = 0; i < localStorage.length; i++) {
              var key = localStorage.key(i);
              if (key && (key.includes('auth-token') || key.includes('supabase') || key.includes('sb-'))) {
                try {
                  var data = JSON.parse(localStorage.getItem(key));
                  if (data && data.user && data.user.email) {
                    var e = data.user.email.toLowerCase();
                    if (!e.startsWith('guest_') && !data.user.user_metadata?.is_guest) {
                      userEmail = data.user.email;
                      tokenVal = data.access_token || (data.currentSession && data.currentSession.access_token);
                      break;
                    }
                  }
                } catch(err) {}
              }
            }

            if (!userEmail) {
              var stored = localStorage.getItem('mr_user_email') || localStorage.getItem('user_email');
              if (stored && !stored.toLowerCase().startsWith('guest_')) {
                userEmail = stored;
              }
            }

            // If an active session exists AND there wasn't a submission error, activate 1-click mode
            if (userEmail && tokenVal && !hasError) {
              sessionMode = true;
              document.getElementById('session_token').value = tokenVal;
              document.getElementById('email').value = userEmail;
              document.getElementById('detected-user-email').innerText = userEmail;
              document.getElementById('session-detected-box').style.display = 'block';
              document.getElementById('credentials-group').style.display = 'none';
              document.getElementById('password').removeAttribute('required');
              document.getElementById('btn-text').innerText = 'Approve & Connect as ' + userEmail;
              document.getElementById('switch-account-row').style.display = 'block';
            } else if (userEmail) {
              document.getElementById('email').value = userEmail;
              if (hasError) {
                document.getElementById('password').focus();
              }
            }

            if (!sessionMode) {
              document.getElementById('password').setAttribute('required', 'required');
            }
          } catch(err) {
            console.error('Session detection err:', err);
          }
        })();

        function switchToPasswordLogin() {
          sessionMode = false;
          document.getElementById('session_token').value = '';
          document.getElementById('session-detected-box').style.display = 'none';
          document.getElementById('credentials-group').style.display = 'block';
          document.getElementById('switch-account-row').style.display = 'none';
          document.getElementById('password').setAttribute('required', 'required');
          document.getElementById('btn-text').innerText = 'Approve & Connect ' + clientName;
          document.getElementById('password').focus();
        }

        function togglePasswordVisibility() {
          var passInput = document.getElementById('password');
          var toggleBtn = document.querySelector('.password-toggle');
          if (passInput.type === 'password') {
            passInput.type = 'text';
            toggleBtn.innerText = 'Hide';
          } else {
            passInput.type = 'password';
            toggleBtn.innerText = 'Show';
          }
        }

        // Form submit handler with instant button loading feedback
        document.getElementById('auth-form').addEventListener('submit', function(e) {
          var submitBtn = document.getElementById('submit-btn');

          if (!sessionMode) {
            var pass = document.getElementById('password').value;
            if (!pass) {
              e.preventDefault();
              document.getElementById('password').focus();
              return;
            }
          }

          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner"></span> <span>CONNECTING TO ' + clientName.toUpperCase() + '...</span>';
        });
      </script>
    </body>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

const REGISTRATION_WINDOW_MS = 60000;
const REGISTRATION_MAX_PER_WINDOW = 30;

// Sliding-window limiter. MCP clients (Claude.ai, ChatGPT) perform RFC 7591
// Dynamic Client Registration from shared backend egress IPs on every fresh
// connect, so this must tolerate bursts instead of locking to 1 req/60s.
export function checkRegistrationRateLimit(clientIp, now = Date.now()) {
  if (!global._registerRateLimit) global._registerRateLimit = new Map();
  const store = global._registerRateLimit;

  if (!global._registerRateLimitSweptAt || now - global._registerRateLimitSweptAt > REGISTRATION_WINDOW_MS) {
    for (const [k, hits] of store) {
      const fresh = hits.filter(t => now - t < REGISTRATION_WINDOW_MS);
      if (fresh.length) store.set(k, fresh);
      else store.delete(k);
    }
    global._registerRateLimitSweptAt = now;
  }

  const key = `register_${clientIp}`;
  const hits = (store.get(key) || []).filter(t => now - t < REGISTRATION_WINDOW_MS);
  if (hits.length >= REGISTRATION_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((REGISTRATION_WINDOW_MS - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, retryAfterSec: 0 };
}

async function handleClientRegistration(req, res, SUPABASE_URL, SB_SERVICE_KEY) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'invalid_request', error_description: 'Method not allowed' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const rl = checkRegistrationRateLimit(clientIp);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return res.status(429).json({ error: 'rate_limit', error_description: `Too many client registrations from this address. Retry in ${rl.retryAfterSec}s.` });
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    body = body.toString('utf-8');
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid JSON body' });
    }
  }

  body = body || {};
  const clientName = body.client_name || 'Claude / ChatGPT MCP Client';
  const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
    ? body.redirect_uris
    : ['https://claude.ai/api/mcp/auth_callback'];

  const clientId = `client_mrc_${crypto.randomBytes(16).toString('hex')}`;
  const clientSecret = `secret_mrc_${crypto.randomBytes(24).toString('hex')}`;
  const issuedAt = Math.floor(Date.now() / 1000);

  if (SB_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/oauth_clients`, {
        method: 'POST',
        headers: {
          'apikey': SB_SERVICE_KEY,
          'Authorization': `Bearer ${SB_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          client_name: clientName,
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code']
        })
      });
    } catch(err) {
      // Non-fatal if table creation pending
    }
  }

  const responsePayload = {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };

  return res.status(201).json(responsePayload);
}
