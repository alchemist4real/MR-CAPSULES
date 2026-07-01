export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!sbKey) return res.status(500).json({ error: 'Server config error' });

  try {
    const getRes = await fetch(`${supabaseUrl}/rest/v1/app_settings?limit=1`, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
    });
    if (!getRes.ok) throw new Error("Config not found");
    
    const data = await getRes.json();
    if (!data || data.length === 0) throw new Error("Config not found in db");
    
    const configObj = data[0];
    
    // Map snake_case to camelCase for backwards compatibility
    const formattedConfig = {
      allowSignup: configObj.allow_signup,
      maintenanceMode: configObj.maintenance_mode,
      bannedDevices: configObj.banned_devices
    };

    return res.status(200).json(formattedConfig);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
