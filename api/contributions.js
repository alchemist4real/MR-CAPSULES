// Couple & Synergy Contribution Package — DB-backed multi-couple system
// High performance caching & instant profile resolution

let cachedProfiles = null;
let lastProfilesFetch = 0;

async function getFastUsers(supabaseUrl, sbKey) {
  const now = Date.now();
  if (cachedProfiles && (now - lastProfilesFetch < 60000)) {
    return cachedProfiles;
  }
  try {
    // 1. Fetch from public.profiles (extremely fast, ~20-30ms)
    const res = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id,email,username`, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store'
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        cachedProfiles = data.map(p => ({
          id: p.id,
          email: p.email,
          username: p.username || (p.email ? p.email.split('@')[0] : 'Unknown'),
          user_metadata: { username: p.username || (p.email ? p.email.split('@')[0] : 'Unknown') }
        }));
        lastProfilesFetch = now;
        return cachedProfiles;
      }
    }
  } catch (err) {
    console.warn('Fast profiles fetch failed, falling back to auth admin:', err.message);
  }

  // Fallback to fetchAllAdminUsers if profiles table is empty or failed
  const authUsers = await fetchAllAdminUsers(supabaseUrl, sbKey);
  cachedProfiles = authUsers;
  lastProfilesFetch = now;
  return cachedProfiles;
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

async function loadAllCoupleConfigs(supabaseUrl, sbKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/couple_config?select=*&order=created_at.asc`, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store'
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('Failed to load couple configs:', e.message);
    return [];
  }
}

function findUserCouple(user, coupleConfigs) {
  if (!user || !Array.isArray(coupleConfigs)) return null;
  const email = (user.email || '').toLowerCase().trim();
  const userId = user.id;

  for (const c of coupleConfigs) {
    if (c.is_active === false) continue;
    const p1Email = (c.partner1_email || '').toLowerCase().trim();
    const p2Email = (c.partner2_email || '').toLowerCase().trim();
    if (userId && (userId === c.partner1_user_id || userId === c.partner2_user_id)) {
      return c;
    }
    if (email && (email === p1Email || email === p2Email)) {
      return c;
    }
  }
  return null;
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
    // ════════════════════════════════════════════════════════════════
    // 1. GET MY CONTRIBUTIONS
    // ════════════════════════════════════════════════════════════════
    if (action === 'get_my_contributions') {
      const [coupleConfigs, allUsers] = await Promise.all([
        loadAllCoupleConfigs(supabaseUrl, sbKey),
        getFastUsers(supabaseUrl, sbKey)
      ]);
      const userCouple = findUserCouple(userData, coupleConfigs);
      let targetUserIds = [userId];
      let coupleLabel = null;

      if (userCouple) {
        const p1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (userCouple.partner1_email || '').toLowerCase().trim());
        const p2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (userCouple.partner2_email || '').toLowerCase().trim());
        const p1Id = p1?.id || userCouple.partner1_user_id;
        const p2Id = p2?.id || userCouple.partner2_user_id;
        const ids = [p1Id, p2Id].filter(Boolean);
        if (ids.length > 0) targetUserIds = Array.from(new Set(ids));
        
        const name1 = p1?.user_metadata?.username || p1?.username || userCouple.partner1_email.split('@')[0];
        const name2 = p2?.user_metadata?.username || p2?.username || userCouple.partner2_email.split('@')[0];
        const title = userCouple.package_name && userCouple.package_name !== 'Couple Package' ? userCouple.package_name : `${name1} & ${name2}`;
        coupleLabel = `Paket Couple: ${title}`;
      }

      const filterParam = targetUserIds.length > 1
        ? `user_id=in.(${targetUserIds.join(',')})`
        : `user_id=eq.${userId}`;

      const resData = await fetch(`${supabaseUrl}/rest/v1/contributions?${filterParam}&order=created_at.desc`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
        cache: 'no-store'
      });
      const data = await resData.json();

      return res.status(200).json({
        success: true,
        is_couple: !!userCouple,
        couple_package: coupleLabel,
        contributions: Array.isArray(data) ? data : []
      });
    }

    // ════════════════════════════════════════════════════════════════
    // 2. GET LEADERBOARD (FAST & MULTI-COUPLE AWARE)
    // ════════════════════════════════════════════════════════════════
    if (action === 'get_leaderboard') {
      const [resContribs, coupleConfigs, allUsers] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/contributions?select=points,user_id,created_at`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
          cache: 'no-store'
        }).then(r => r.json()).catch(() => []),
        loadAllCoupleConfigs(supabaseUrl, sbKey),
        getFastUsers(supabaseUrl, sbKey)
      ]);

      const validData = Array.isArray(resContribs) ? resContribs : [];
      const activeCouples = coupleConfigs.filter(c => c.is_active !== false);

      const coupleUserMap = new Map();
      const couplePointsMap = new Map();

      activeCouples.forEach(c => {
        couplePointsMap.set(c.id, 0);
        if (c.partner1_user_id) coupleUserMap.set(c.partner1_user_id, c);
        if (c.partner2_user_id) coupleUserMap.set(c.partner2_user_id, c);

        const u1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner1_email || '').toLowerCase().trim());
        const u2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner2_email || '').toLowerCase().trim());
        if (u1) coupleUserMap.set(u1.id, c);
        if (u2) coupleUserMap.set(u2.id, c);
      });

      const individualScores = {};

      validData.forEach(c => {
        const pts = c.points || 0;
        const couple = coupleUserMap.get(c.user_id);
        if (couple) {
          couplePointsMap.set(couple.id, (couplePointsMap.get(couple.id) || 0) + pts);
        } else {
          if (!individualScores[c.user_id]) {
            const u = allUsers.find(au => au.id === c.user_id);
            const email = u ? u.email : 'Unknown';
            const username = u?.user_metadata?.username || u?.username || (email.includes('@') ? email.split('@')[0] : 'Unknown');
            individualScores[c.user_id] = { points: 0, email, username, is_couple: false };
          }
          individualScores[c.user_id].points += pts;
        }
      });

      const leaderboard = [];

      Object.values(individualScores).forEach(item => {
        if (item.points > 0) {
          leaderboard.push(item);
        }
      });

      activeCouples.forEach(c => {
        const totalPts = couplePointsMap.get(c.id) || 0;
        if (totalPts > 0) {
          const u1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner1_email || '').toLowerCase().trim());
          const u2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner2_email || '').toLowerCase().trim());
          const name1 = u1?.user_metadata?.username || u1?.username || c.partner1_email.split('@')[0];
          const name2 = u2?.user_metadata?.username || u2?.username || c.partner2_email.split('@')[0];
          const coupleTitle = c.package_name && c.package_name !== 'Couple Package' ? c.package_name : `${name1} & ${name2}`;

          leaderboard.push({
            couple_id: c.id,
            email: `${c.partner1_email}, ${c.partner2_email}`,
            username: coupleTitle,
            points: totalPts,
            is_couple: true,
            couple_label: `Paket Couple: ${coupleTitle}`
          });
        }
      });

      leaderboard.sort((a, b) => b.points - a.points);
      return res.status(200).json({ success: true, leaderboard });
    }

    // ════════════════════════════════════════════════════════════════
    // 3. CHECK CONTRIBUTION ACCESS
    // ════════════════════════════════════════════════════════════════
    if (action === 'check_contribution') {
      const isSuperAdmin = userData.email === (process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com');
      if (isSuperAdmin) {
        return res.status(200).json({ success: true, has_contributed: true });
      }
      const isGuest = (userData.email && userData.email.match(/^guest_\d+_\d+@mrcapsules\.com$/)) ||
                      (userData.user_metadata && userData.user_metadata.is_guest);
      if (isGuest) {
        return res.status(200).json({ success: true, has_contributed: true });
      }

      const coupleConfigs = await loadAllCoupleConfigs(supabaseUrl, sbKey);
      const userCouple = findUserCouple(userData, coupleConfigs);
      if (userCouple) {
        const allUsers = await getFastUsers(supabaseUrl, sbKey);
        const p1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (userCouple.partner1_email || '').toLowerCase().trim());
        const p2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (userCouple.partner2_email || '').toLowerCase().trim());
        const coupleUserIds = Array.from(new Set([p1?.id || userCouple.partner1_user_id, p2?.id || userCouple.partner2_user_id].filter(Boolean)));
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

    // ════════════════════════════════════════════════════════════════
    // 4. GET COUPLE PACKAGES (ALL PACKAGES & METRICS)
    // ════════════════════════════════════════════════════════════════
    if (action === 'get_couple_package' || action === 'get_couple_packages') {
      const [coupleConfigs, allUsers, allContribs] = await Promise.all([
        loadAllCoupleConfigs(supabaseUrl, sbKey),
        getFastUsers(supabaseUrl, sbKey),
        fetch(`${supabaseUrl}/rest/v1/contributions?select=points,created_at,user_id&order=created_at.desc`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Cache-Control': 'no-cache' },
          cache: 'no-store'
        }).then(r => r.json()).catch(() => [])
      ]);

      const validContribs = Array.isArray(allContribs) ? allContribs : [];
      const packages = coupleConfigs.map(c => {
        const p1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner1_email || '').toLowerCase().trim());
        const p2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === (c.partner2_email || '').toLowerCase().trim());
        const p1Id = p1?.id || c.partner1_user_id;
        const p2Id = p2?.id || c.partner2_user_id;
        const name1 = p1?.user_metadata?.username || p1?.username || c.partner1_email.split('@')[0];
        const name2 = p2?.user_metadata?.username || p2?.username || c.partner2_email.split('@')[0];

        let p1Points = 0;
        let p2Points = 0;
        let p1Last = null;
        let p2Last = null;

        validContribs.forEach(cb => {
          if (cb.user_id === p1Id) {
            p1Points += (cb.points || 0);
            if (!p1Last) p1Last = cb.created_at;
          } else if (cb.user_id === p2Id) {
            p2Points += (cb.points || 0);
            if (!p2Last) p2Last = cb.created_at;
          }
        });

        const pooledPoints = p1Points + p2Points;
        let lastContributedAt = null;
        if (p1Last && p2Last) {
          lastContributedAt = new Date(p1Last) > new Date(p2Last) ? p1Last : p2Last;
        } else {
          lastContributedAt = p1Last || p2Last || null;
        }

        const hasActiveAccess = lastContributedAt 
          ? new Date(lastContributedAt) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          : false;

        return {
          id: c.id,
          package_name: c.package_name || `${name1} & ${name2}`,
          is_active: c.is_active !== false,
          pooled_points: pooledPoints,
          has_active_access: hasActiveAccess,
          last_contributed_at: lastContributedAt,
          created_at: c.created_at,
          updated_at: c.updated_at,
          partner1: {
            id: p1Id,
            email: c.partner1_email,
            username: name1,
            points: p1Points,
            last_contributed_at: p1Last
          },
          partner2: {
            id: p2Id,
            email: c.partner2_email,
            username: name2,
            points: p2Points,
            last_contributed_at: p2Last
          }
        };
      });

      const firstPkg = packages[0] || null;
      return res.status(200).json({
        success: true,
        enabled: packages.length > 0,
        packages: packages,
        // Single-couple backward compatibility
        pooled_points: firstPkg ? firstPkg.pooled_points : 0,
        last_contributed_at: firstPkg ? firstPkg.last_contributed_at : null,
        has_active_access: firstPkg ? firstPkg.has_active_access : false,
        couple: firstPkg ? [firstPkg.partner1, firstPkg.partner2] : []
      });
    }

    // ════════════════════════════════════════════════════════════════
    // 5. SET / UNLINK / SWAP COUPLE PACKAGE (MULTI-COUPLE SUPPORT)
    // ════════════════════════════════════════════════════════════════
    if (action === 'set_couple_package') {
      const username = userData.user_metadata?.username;
      const encEmail = encodeURIComponent(userData.email);
      const identifierQuery = username ? `or=(identifier.eq.${encEmail},identifier.eq.${encodeURIComponent(username)})` : `identifier=eq.${encEmail}`;
      const roleRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?${identifierQuery}&select=role`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let roleData = [];
      if (roleRes.ok) roleData = await roleRes.json();
      const isSuperAdmin = userData.email === (process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com');
      const hasAdminRole = roleData && roleData.length > 0 && roleData[0].role === 'admin';
      if (!isSuperAdmin && !hasAdminRole) {
        return res.status(403).json({ error: 'Forbidden. Admin only.' });
      }

      const { partner1_email, partner2_email, package_name, unlink, swap, couple_id } = body;

      // UNLINK ACTION
      if (unlink) {
        let deleteUrl = `${supabaseUrl}/rest/v1/couple_config`;
        if (couple_id) {
          deleteUrl += `?id=eq.${couple_id}`;
        } else {
          const allCouples = await loadAllCoupleConfigs(supabaseUrl, sbKey);
          if (allCouples.length === 1) {
            deleteUrl += `?id=eq.${allCouples[0].id}`;
          } else {
            return res.status(400).json({ error: 'Harap tentukan ID pasangan yang ingin dihapus.' });
          }
        }
        const delRes = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!delRes.ok) {
          const errText = await delRes.text();
          return res.status(500).json({ error: 'Gagal melepas pasangan: ' + errText });
        }
        return res.status(200).json({ success: true, message: 'Paket couple berhasil dilepas (unlinked).' });
      }

      // SWAP ROLES ACTION
      if (swap) {
        if (!couple_id) return res.status(400).json({ error: 'Parameter couple_id dibutuhkan untuk swap peran.' });
        const targetRes = await fetch(`${supabaseUrl}/rest/v1/couple_config?id=eq.${couple_id}&select=*`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!targetRes.ok) return res.status(404).json({ error: 'Data pasangan tidak ditemukan.' });
        const targetData = await targetRes.json();
        if (!Array.isArray(targetData) || targetData.length === 0) return res.status(404).json({ error: 'Pasangan tidak ditemukan.' });
        const cur = targetData[0];

        const patchRes = await fetch(`${supabaseUrl}/rest/v1/couple_config?id=eq.${couple_id}`, {
          method: 'PATCH',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partner1_email: cur.partner2_email,
            partner1_user_id: cur.partner2_user_id,
            partner2_email: cur.partner1_email,
            partner2_user_id: cur.partner1_user_id,
            updated_at: new Date().toISOString()
          })
        });
        if (!patchRes.ok) return res.status(500).json({ error: 'Gagal menukar peran partner.' });
        return res.status(200).json({ success: true, message: 'Peran Partner 1 & 2 berhasil ditukar.' });
      }

      // CREATE OR UPDATE ACTION
      if (!partner1_email || !partner2_email) {
        return res.status(400).json({ error: 'Email kedua partner wajib diisi.' });
      }
      if (partner1_email.toLowerCase().trim() === partner2_email.toLowerCase().trim()) {
        return res.status(400).json({ error: 'Partner 1 dan Partner 2 tidak boleh orang yang sama!' });
      }

      const allUsers = await getFastUsers(supabaseUrl, sbKey);
      const p1 = allUsers.find(u => (u.email || '').toLowerCase().trim() === partner1_email.toLowerCase().trim());
      const p2 = allUsers.find(u => (u.email || '').toLowerCase().trim() === partner2_email.toLowerCase().trim());

      if (!p1 || !p2) {
        return res.status(404).json({ error: 'Salah satu atau kedua akun partner tidak ditemukan dalam sistem.' });
      }

      const name1 = p1?.user_metadata?.username || p1?.username || partner1_email.split('@')[0];
      const name2 = p2?.user_metadata?.username || p2?.username || partner2_email.split('@')[0];
      const pkgName = package_name ? package_name.trim() : `${name1} & ${name2}`;

      if (couple_id) {
        // Update existing couple package without touching others
        const patchRes = await fetch(`${supabaseUrl}/rest/v1/couple_config?id=eq.${couple_id}`, {
          method: 'PATCH',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            package_name: pkgName,
            partner1_email: p1.email.toLowerCase().trim(),
            partner1_user_id: p1.id,
            partner2_email: p2.email.toLowerCase().trim(),
            partner2_user_id: p2.id,
            updated_at: new Date().toISOString()
          })
        });
        if (!patchRes.ok) {
          const errText = await patchRes.text();
          return res.status(500).json({ error: 'Gagal memperbarui konfigurasi pasangan: ' + errText });
        }
      } else {
        // INSERT BRAND NEW COUPLE PACKAGE (Never overwrites existing couples!)
        const insertRes = await fetch(`${supabaseUrl}/rest/v1/couple_config`, {
          method: 'POST',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            package_name: pkgName,
            partner1_email: p1.email.toLowerCase().trim(),
            partner1_user_id: p1.id,
            partner2_email: p2.email.toLowerCase().trim(),
            partner2_user_id: p2.id,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          return res.status(500).json({ error: 'Gagal menambahkan pasangan baru: ' + errText });
        }
      }

      return res.status(200).json({
        success: true,
        message: couple_id ? 'Paket pasangan berhasil diperbarui!' : 'Paket pasangan baru berhasil ditambahkan!',
        package_name: pkgName
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
