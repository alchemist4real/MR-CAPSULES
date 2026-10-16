// api/env.js
// Handles public system environment and configuration endpoints
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const host = req.headers.host || 'mr-capsules.vercel.app';
  const urlObj = new URL(req.url, `https://${host}`);
  const isConfigReq = urlObj.pathname.includes('/config') || urlObj.searchParams.get('type') === 'config';
  const isUptimeReq = urlObj.pathname.includes('/uptime') || urlObj.searchParams.get('type') === 'uptime';

  const supabaseUrl = process.env.SUPABASE_URL || 'https://hdhvrlkizorscvehttzd.supabase.co';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey;

  // Handle Uptime API
  if (isUptimeReq) {
    if (req.method === 'POST') {
      const authHeader = req.headers.authorization || '';
      if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
      const token = authHeader.replace('Bearer ', '');
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
      });
      if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });

      const { action, seconds } = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {};
      if (action === 'increment') {
        const inc = parseInt(seconds, 10) || 10;
        const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_uptime`, {
          method: 'POST',
          headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inc })
        });
        const newVal = await rpcRes.json();
        return res.status(200).json({ success: true, total_uptime: newVal });
      }
      if (action === 'get') {
        const getRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
          headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
        });
        const rows = await getRes.json();
        const total = (rows && rows.length > 0) ? (parseInt(rows[0].total_uptime, 10) || 0) : 0;
        return res.status(200).json({ success: true, total_uptime: total });
      }
      return res.status(400).json({ error: 'Unknown action' });
    } else {
      const getRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });
      const rows = await getRes.json();
      const total = (rows && rows.length > 0) ? (parseInt(rows[0].total_uptime, 10) || 0) : 0;
      return res.status(200).json({ success: true, total_uptime: total });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (isConfigReq) {
    // 1. Ensure durable server-side device ID cookie (Safari ITP resistant)
    let cookieDevId = null;
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)mr_device_id=([^;]*)/);
    if (match) cookieDevId = decodeURIComponent(match[1]);

    const deviceId = cookieDevId || (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'dev_' + Math.random().toString(36).substr(2, 9));
    const isHttps = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
    res.setHeader('Set-Cookie', `mr_device_id=${deviceId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`);

    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/app_settings?limit=1`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          return res.status(200).json({
            allowSignup: data[0].allow_signup ?? true,
            allowGuest: data[0].allow_guest ?? true,
            maintenanceMode: data[0].maintenance_mode ?? false,
            bannedDevices: data[0].banned_devices || [],
            deviceId: deviceId
          });
        }
      }
    } catch (e) {}

    return res.status(200).json({
      allowSignup: true,
      allowGuest: true,
      maintenanceMode: false,
      bannedDevices: [],
      deviceId: deviceId
    });
  }

  // Default: Return public Supabase url & anon key
  return res.status(200).json({
    url: supabaseUrl,
    key: anonKey
  });
}
