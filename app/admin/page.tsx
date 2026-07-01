'use client';
import React, { useEffect, useState, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';

export default function AdminPage() {
  const [session, setSession] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('files');
  const [errorMsg, setErrorMsg] = useState('');
  
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) verifyAdmin(session);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) verifyAdmin(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  const verifyAdmin = async (sess: any) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // Cookies handled by Next.js
        body: JSON.stringify({ action: 'check' })
      });
      const data = await res.json();
      if (data.success && data.isSuperAdmin) {
        setIsAdmin(true);
      } else {
        setErrorMsg('Forbidden. Not an admin.');
      }
    } catch (e) {
      setErrorMsg('Error verifying admin status.');
    }
    setLoading(false);
  };

  const signIn = async () => {
    // In a real app, use a proper login form or OAuth
    const email = prompt('Email:');
    const password = prompt('Password:');
    if (email && password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) alert(error.message);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setIsAdmin(false);
  };

  if (loading) {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" style={{ width: 40, height: 40, border: '3px solid var(--border-light)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
      <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
    </div>;
  }

  if (!session || !isAdmin) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <h1 style={{ fontFamily: 'var(--font-mono)', fontSize: 42, fontWeight: 700, letterSpacing: '0.08em' }}>MR CAPSULES</h1>
        <p style={{ opacity: 0.4, letterSpacing: '0.25em', marginBottom: 24, fontSize: 14 }}>SYSTEM ACCESS</p>
        {errorMsg && <p style={{ color: '#FF6B6B', marginBottom: 16 }}>{errorMsg}</p>}
        <button className="btn primary" onClick={signIn}>Login to Continue</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflow: 'hidden', paddingBottom: 60, display: 'flex' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-main)' }}>
          
          <div className="toolbar" style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
             <h2 style={{ fontSize: 18, margin: 0 }}>{activeTab.toUpperCase()}</h2>
          </div>
          
          <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            {activeTab === 'files' && <FilesView />}
            {activeTab === 'dashboard' && <DashboardView />}
            {activeTab === 'users' && <UsersView />}
          </div>

        </div>
      </div>

      <div className="bottom-dock" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, height: 60,
        background: 'var(--bg-main)', borderTop: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 100
      }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <a href="/" className="btn" style={{ padding: '4px 8px' }}>← Site</a>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700 }}>MR CAPSULES Admin</div>
        </div>
        
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`btn ${activeTab === 'dashboard' ? 'primary' : ''}`} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
          <button className={`btn ${activeTab === 'files' ? 'primary' : ''}`} onClick={() => setActiveTab('files')}>Files</button>
          <button className={`btn ${activeTab === 'users' ? 'primary' : ''}`} onClick={() => setActiveTab('users')}>Users</button>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session.user.email}</span>
          <button className="btn" onClick={signOut}>Sign Out</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------
// Sub-components
// ---------------------------------

function FilesView() {
  const [files, setFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTree = async () => {
    setLoading(true);
    const res = await fetch('/api/admin', { method: 'POST', body: JSON.stringify({ action: 'tree' }) });
    const data = await res.json();
    if (data.success) {
      setFiles(data.tree);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTree();
  }, []);

  const handleDelete = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    await fetch('/api/admin', { method: 'POST', body: JSON.stringify({ action: 'delete', path }) });
    fetchTree();
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
         <button className="btn primary" onClick={fetchTree}>Refresh Files</button>
      </div>
      {loading ? <p>Loading files...</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
          {files.map(f => (
            <div key={f.path} style={{ border: '1px solid var(--border-light)', padding: 16, background: 'var(--bg-card)' }}>
              <div style={{ fontSize: 14, wordBreak: 'break-all', marginBottom: 12 }}>{f.path}</div>
              <button className="btn danger" onClick={() => handleDelete(f.path)}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardView() {
  return <div><h3>Dashboard Analytics</h3><p>Stats will appear here.</p></div>;
}

function UsersView() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin', { method: 'POST', body: JSON.stringify({ action: 'get_users' }) })
      .then(r => r.json())
      .then(d => { if(d.success) setUsers(d.users); setLoading(false); });
  }, []);

  return (
    <div>
      {loading ? <p>Loading users...</p> : (
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-light)' }}>
              <th style={{ padding: 12 }}>Email</th>
              <th style={{ padding: 12 }}>Created At</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: 12 }}>{u.email}</td>
                <td style={{ padding: 12 }}>{new Date(u.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
