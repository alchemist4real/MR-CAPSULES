export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';

  // Verify user is logged in
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` }
  });
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbKey) return res.status(500).json({ error: 'Server config error' });

  const { action, seconds } = req.body;

  try {
    if (action === 'increment') {
      const inc = parseInt(seconds, 10) || 10;

      // Try to read current value
      const getRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const rows = await getRes.json();

      if (rows && rows.length > 0) {
        const newVal = (parseInt(rows[0].total_uptime, 10) || 0) + inc;
        await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1`, {
          method: 'PATCH',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ total_uptime: newVal })
        });
        return res.status(200).json({ success: true, total_uptime: newVal });
      } else {
        // Row doesn't exist, create it
        await fetch(`${supabaseUrl}/rest/v1/global_stats`, {
          method: 'POST',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id: 1, total_uptime: inc })
        });
        return res.status(200).json({ success: true, total_uptime: inc });
      }
    }

    if (action === 'get') {
      const getRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const rows = await getRes.json();
      var total = (rows && rows.length > 0) ? (parseInt(rows[0].total_uptime, 10) || 0) : 0;
      return res.status(200).json({ success: true, total_uptime: total });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
