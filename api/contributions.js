// Couple Contribution Package — DB-backed configuration
// Reads couple config from Supabase `couple_config` table instead of in-memory Sets

async function loadCoupleConfig(supabaseUrl, sbKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/couple_config?id=eq.1&select=*`, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0]; // { partner1_email, partner1_user_id, partner2_email, partner2_user_id, ... }
  } catch (e) {
    console.warn('Failed to load couple config:', e.message);
    return null;
  }
}

function isCoupleMember(user, coupleConfig) {
  if (!user || !coupleConfig) return false;
  const email = (user.email || '').toLowerCase();
  const p1Email = (coupleConfig.partner1_email || '').toLowerCase();
  const p2Email = (coupleConfig.partner2_email || '').toLowerCase();
  // Exact match by user_id or email only — no fuzzy matching
  if (user.id && (user.id === coupleConfig.partner1_user_id || user.id === coupleConfig.partner2_user_id)) return true;
  if (email && (email === p1Email || email === p2Email)) return true;
  return false;
}

function getCoupleLabel(coupleConfig, allUsers) {
  if (!coupleConfig) return null;
  const p1 = allUsers ? allUsers.find(u => (u.email || '').toLowerCase() === (coupleConfig.partner1_email || '').toLowerCase()) : null;
  const p2 = allUsers ? allUsers.find(u => (u.email || '').toLowerCase() === (coupleConfig.partner2_email || '').toLowerCase()) : null;
  const name1 = p1?.user_metadata?.username || coupleConfig.partner1_email.split('@')[0];
  const name2 = p2?.user_metadata?.username || coupleConfig.partner2_email.split('@')[0];
  return `Paket Contribution Couple: ${name1} & ${name2}`;
}

async function fetchAllAdminUsers(supabaseUrl, sbKey) {
  let allUsers = [];
  let userPage = 1;
  let hasMoreUsers = true;
  while (hasMoreUsers) {
    const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${userPage}&per_page=1000`, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store'
    });
    if (!usersRes.ok) break;
    try {
      const usersData = await usersRes.json();
      const pageUsers = (usersData && Array.isArray(usersData.users)) ? usersData.users : [];
      allUsers = allUsers.concat(pageUsers);
      if (pageUsers.length < 1000) hasMoreUsers = false;
      else userPage++;
    } catch(e) { break; }
  }
  return allUsers;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!sbKey) return res.status(500).json({ error: 'Server config error' });

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${token}`, 'Cache-Control': 'no-cache' },
    cache: 'no-store'
  });

  if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });
  const userData = await userRes.json();
  const userId = userData.id;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {}
  }
  const { action } = body;

  try {
    if (action === 'get_my_contributions') {
      const coupleConfig = await loadCoupleConfig(supabaseUrl, sbKey);
      const isCouple = isCoupleMember(userData, coupleConfig);
      let targetUserIds = [userId];

      if (isCouple) {
        const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
        const coupleUsers = allUsers.filter(u => isCoupleMember(u, coupleConfig));
        if (coupleUsers.length > 0) {
          targetUserIds = Array.from(new Set(coupleUsers.map(u => u.id)));
        }
      }

      const filterParam = targetUserIds.length > 1
        ? `user_id=in.(${targetUserIds.join(',')})`
        : `user_id=eq.${userId}`;

      const resData = await fetch(`${supabaseUrl}/rest/v1/contributions?${filterParam}&order=created_at.desc`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
        cache: 'no-store'
      });
      const data = await resData.json();
      if (!Array.isArray(data)) console.error('get_my_contributions error:', data);

      let coupleLabel = null;
      if (isCouple) {
        const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
        coupleLabel = getCoupleLabel(coupleConfig, allUsers);
      }

      return res.status(200).json({
        success: true,
        is_couple: isCouple,
        couple_package: coupleLabel,
        contributions: Array.isArray(data) ? data : []
      });
    }

    if (action === 'get_leaderboard') {
      const resData = await fetch(`${supabaseUrl}/rest/v1/contributions?select=points,user_id`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
        cache: 'no-store'
      });
      const data = await resData.json();
      if (!Array.isArray(data)) console.error('get_leaderboard error:', data);
      const validData = Array.isArray(data) ? data : [];
      
      const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
      const coupleConfig = await loadCoupleConfig(supabaseUrl, sbKey);
      
      // Calculate pooled points for couple package
      const coupleUserIds = new Set(allUsers.filter(u => isCoupleMember(u, coupleConfig)).map(u => u.id));
      let coupleTotalPoints = 0;
      validData.forEach(c => {
        if (coupleUserIds.has(c.user_id)) {
          coupleTotalPoints += (c.points || 0);
        }
      });
      
      const scores = {};
      validData.forEach(c => {
        const u = allUsers.find(au => au.id === c.user_id);
        const email = u ? u.email : 'Unknown';
        const username = u?.user_metadata?.username || (u ? u.email.split('@')[0] : 'Unknown');
        const userIsCouple = isCoupleMember(u, coupleConfig);
        if (!userIsCouple) {
          if (!scores[email]) {
            scores[email] = {
              points: 0,
              username,
              is_couple: false
            };
          }
          scores[email].points += (c.points || 0);
        }
      });

      const list = Object.keys(scores)
        .filter(k => scores[k].points > 0)
        .map(k => ({
          email: k,
          username: scores[k].username,
          points: scores[k].points,
          is_couple: false
        }));

      // Add 1 single combined couple entry only if coupleTotalPoints > 0
      if (coupleTotalPoints > 0 && coupleConfig) {
        const coupleUsers = allUsers.filter(u => isCoupleMember(u, coupleConfig));
        const coupleNames = coupleUsers.map(u => u?.user_metadata?.username || u.email.split('@')[0]);
        const coupleUsername = coupleNames.length > 0 ? coupleNames.join(' & ') : `${coupleConfig.partner1_email.split('@')[0]} & ${coupleConfig.partner2_email.split('@')[0]}`;
        const coupleLabel = getCoupleLabel(coupleConfig, allUsers);
        list.push({
          email: coupleUsers.map(u => u.email).join(', '),
          username: coupleUsername,
          points: coupleTotalPoints,
          is_couple: true,
          couple_label: coupleLabel
        });
      }
       
      const leaderboard = list.sort((a,b) => b.points - a.points);
                               
      return res.status(200).json({ success: true, leaderboard });
    }

    if (action === 'check_contribution') {
      // Allow super admin to bypass
      const isSuperAdmin = userData.email === (process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com');
      if (isSuperAdmin) {
        return res.status(200).json({ success: true, has_contributed: true });
      }
      // Allow guest users to bypass
      const isGuest = (userData.email && userData.email.match(/^guest_\d+_\d+@mrcapsules\.com$/)) ||
                      (userData.user_metadata && userData.user_metadata.is_guest);
      if (isGuest) {
        return res.status(200).json({ success: true, has_contributed: true });
      }
      
      // Check couple package
      const coupleConfig = await loadCoupleConfig(supabaseUrl, sbKey);
      if (isCoupleMember(userData, coupleConfig)) {
        const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
        const coupleUserIds = Array.from(new Set(allUsers.filter(u => isCoupleMember(u, coupleConfig)).map(u => u.id)));
        if (coupleUserIds.length > 0) {
          const filterParam = coupleUserIds.length > 1
            ? `user_id=in.(${coupleUserIds.join(',')})`
            : `user_id=eq.${userId}`;
          const resData = await fetch(`${supabaseUrl}/rest/v1/contributions?${filterParam}&select=created_at&order=created_at.desc&limit=1`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
            cache: 'no-store'
          });
          const data = await resData.json();
          if (Array.isArray(data) && data.length > 0) {
            const hasRecent = new Date(data[0].created_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            if (hasRecent) {
              return res.status(200).json({ success: true, has_contributed: true, is_couple: true });
            }
          }
        }
      }
      
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/check_user_contribution`, {
        method: 'POST',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ uid: userId }),
        cache: 'no-store'
      });
      if (!rpcRes.ok) throw new Error(await rpcRes.text());
      const hasContributed = await rpcRes.json();
      
      return res.status(200).json({ success: true, has_contributed: hasContributed });
    }

    if (action === 'get_couple_package') {
      const coupleConfig = await loadCoupleConfig(supabaseUrl, sbKey);
      if (!coupleConfig) {
        return res.status(200).json({ success: true, enabled: false, couple: [] });
      }
      const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
      const p1 = allUsers.find(u => (u.email || '').toLowerCase() === coupleConfig.partner1_email.toLowerCase());
      const p2 = allUsers.find(u => (u.email || '').toLowerCase() === coupleConfig.partner2_email.toLowerCase());
      return res.status(200).json({
        success: true,
        enabled: true,
        couple: [
          {
            id: p1?.id || coupleConfig.partner1_user_id,
            email: coupleConfig.partner1_email,
            username: p1?.user_metadata?.username || coupleConfig.partner1_email.split('@')[0],
            full_name: p1?.user_metadata?.full_name || p1?.user_metadata?.name || ''
          },
          {
            id: p2?.id || coupleConfig.partner2_user_id,
            email: coupleConfig.partner2_email,
            username: p2?.user_metadata?.username || coupleConfig.partner2_email.split('@')[0],
            full_name: p2?.user_metadata?.full_name || p2?.user_metadata?.name || ''
          }
        ]
      });
    }

    if (action === 'set_couple_package') {
      // Role check for admin actions
      const encEmail = encodeURIComponent(userData.email);
      const roleRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?identifier=eq.${encEmail}&select=role`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let roleData = [];
      if (roleRes.ok) roleData = await roleRes.json();
      const isSuperAdmin = userData.email === (process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com');
      const hasAdminRole = roleData && roleData.length > 0 && roleData[0].role === 'admin';
      if (!isSuperAdmin && !hasAdminRole) {
        return res.status(403).json({ error: 'Forbidden. Admin only.' });
      }

      const { partner1_email, partner2_email, unlink } = body;
      if (unlink) {
        // Delete couple config from DB
        await fetch(`${supabaseUrl}/rest/v1/couple_config?id=eq.1`, {
          method: 'DELETE',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        return res.status(200).json({ success: true, message: 'Couple package unlinked.' });
      }

      if (!partner1_email || !partner2_email) {
        return res.status(400).json({ error: 'Both partner emails are required.' });
      }

      const allUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
      const p1 = allUsers.find(u => (u.email || '').toLowerCase() === partner1_email.toLowerCase());
      const p2 = allUsers.find(u => (u.email || '').toLowerCase() === partner2_email.toLowerCase());

      if (!p1 || !p2) {
        return res.status(404).json({ error: 'One or both partners not found in user accounts.' });
      }

      // Upsert couple config into DB (singleton row id=1)
      const upsertRes = await fetch(`${supabaseUrl}/rest/v1/couple_config`, {
        method: 'POST',
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: 1,
          partner1_email: p1.email.toLowerCase(),
          partner1_user_id: p1.id,
          partner2_email: p2.email.toLowerCase(),
          partner2_user_id: p2.id,
          updated_at: new Date().toISOString()
        })
      });

      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        console.error('Failed to upsert couple_config:', errText);
        return res.status(500).json({ error: 'Failed to save couple config to database.' });
      }

      return res.status(200).json({
        success: true,
        message: 'Couple package successfully updated!',
        couple: [
          { id: p1.id, email: p1.email, username: p1.user_metadata?.username || p1.email.split('@')[0] },
          { id: p2.id, email: p2.email, username: p2.user_metadata?.username || p2.email.split('@')[0] }
        ]
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
