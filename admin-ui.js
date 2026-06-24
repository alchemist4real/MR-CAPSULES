// Admin Dashboard Logic

let currentAdminSession = null;
let currentAdminTree = [];
let currentAdminPath = '';

const adminSection = document.getElementById('adminSection');
const superAdminSection = document.getElementById('superAdminSection');
const btnOpenAdmin = document.getElementById('btnOpenAdmin');
const adminDashboardModal = document.getElementById('adminDashboardModal');
const btnAdminClose = document.getElementById('btnAdminClose');
const adminFileBrowser = document.getElementById('adminFileBrowser');
const adminPathRoot = document.getElementById('adminPathRoot');
const adminPathBreadcrumbs = document.getElementById('adminPathBreadcrumbs');
const adminStatus = document.getElementById('adminStatus');

const btnAdminUpload = document.getElementById('btnAdminUpload');
const adminFileInput = document.getElementById('adminFileInput');
const btnAdminNewFolder = document.getElementById('btnAdminNewFolder');
const btnAdminRefresh = document.getElementById('btnAdminRefresh');
const btnAddAdmin = document.getElementById('btnAddAdmin');
const newAdminInput = document.getElementById('newAdminInput');
const adminMsg = document.getElementById('adminMsg');

// Automatically hook into Supabase auth changes
function initAdminAuth() {
  if (window.supabaseClient) {
    window.supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (session && session.access_token) {
        checkAdminStatus(session.access_token);
      }
    });

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session && session.access_token) {
        checkAdminStatus(session.access_token);
      } else {
        if(adminSection) adminSection.style.display = 'none';
        currentAdminSession = null;
      }
    });
  } else {
    setTimeout(initAdminAuth, 500);
  }
}
initAdminAuth();

async function checkAdminStatus(token) {
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ action: 'check' })
    });
    
    const data = await res.json();
    if (res.ok && data.success && adminSection) {
      currentAdminSession = token;
      adminSection.style.display = 'block';
      if (data.isSuperAdmin && superAdminSection) {
        superAdminSection.style.display = 'block';
      }
    } else {
      if (adminSection) {
        adminSection.style.display = 'block';
        adminSection.innerHTML = `<div style="color:red; font-size:11px;">Admin API Error: ${data.error || 'Unknown'}</div>`;
      }
    }
  } catch(e) {
    if (adminSection) {
      adminSection.style.display = 'block';
      adminSection.innerHTML = `<div style="color:red; font-size:11px;">Admin Fetch Error: ${e.message}</div>`;
    }
  }
}

// Modal Toggle
if(btnOpenAdmin) {
  btnOpenAdmin.addEventListener('click', () => {
    adminDashboardModal.classList.add('active');
    loadAdminTree();
  });
}
if(btnAdminClose) {
  btnAdminClose.addEventListener('click', () => {
    adminDashboardModal.classList.remove('active');
  });
}

async function loadAdminTree() {
  adminStatus.textContent = 'Loading repository...';
  adminFileBrowser.innerHTML = '';
  try {
    const res = await fetch('/api/content');
    const data = await res.json();
    if (data.tree) {
      currentAdminTree = data.tree.filter(i => i.path.startsWith('content/') || i.path.startsWith('cover/'));
      renderFileBrowser();
      adminStatus.textContent = '';
    } else {
      adminStatus.textContent = 'Failed to load content tree.';
    }
  } catch(e) {
    adminStatus.textContent = 'Error: ' + e.message;
  }
}

function renderFileBrowser() {
  adminFileBrowser.innerHTML = '';
  
  // Breadcrumbs
  if (currentAdminPath === '') {
    adminPathBreadcrumbs.innerHTML = '';
  } else {
    const parts = currentAdminPath.replace(/\/$/, '').split('/');
    let html = '';
    let buildPath = '';
    parts.forEach((p, i) => {
      buildPath += p + '/';
      const isLast = i === parts.length - 1;
      html += ` / <span style="${isLast ? '' : 'cursor:pointer; text-decoration:underline;'}" data-path="${buildPath}" class="bc-link">${p}</span>`;
    });
    adminPathBreadcrumbs.innerHTML = html;
    
    document.querySelectorAll('.bc-link').forEach(el => {
      el.addEventListener('click', (e) => {
        if(e.target.style.cursor === 'pointer') {
          currentAdminPath = e.target.getAttribute('data-path');
          renderFileBrowser();
        }
      });
    });
  }

  adminPathRoot.onclick = () => { currentAdminPath = ''; renderFileBrowser(); };

  // Determine contents of currentAdminPath
  let items = new Map(); // name -> { type, path, sha }

  currentAdminTree.forEach(item => {
    if (item.path.startsWith(currentAdminPath)) {
      const remainder = item.path.substring(currentAdminPath.length);
      if (remainder.length === 0) return; // exactly the folder itself
      
      const parts = remainder.split('/');
      const name = parts[0];
      const isFile = parts.length === 1 && item.type === 'blob';
      
      if (!items.has(name)) {
        items.set(name, {
          name: name,
          type: isFile ? 'file' : 'folder',
          path: currentAdminPath + name + (isFile ? '' : '/'),
          sha: isFile ? item.sha : null
        });
      }
    }
  });

  const sortedItems = Array.from(items.values()).sort((a,b) => {
    if(a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'folder' ? -1 : 1;
  });

  if (sortedItems.length === 0 && currentAdminPath !== '') {
    adminFileBrowser.innerHTML = '<div style="padding:10px; color:#666;">Empty folder</div>';
  } else if (sortedItems.length === 0 && currentAdminPath === '') {
    // Inject base folders manually if tree is totally empty
    sortedItems.push({name: 'content', type: 'folder', path: 'content/', sha: null});
    sortedItems.push({name: 'cover', type: 'folder', path: 'cover/', sha: null});
  }

  sortedItems.forEach(item => {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.padding = '8px';
    div.style.borderBottom = '1px solid var(--border-light)';
    
    const icon = item.type === 'folder' ? '📁' : '📄';
    const cursor = item.type === 'folder' ? 'pointer' : 'default';
    
    div.innerHTML = `
      <span style="margin-right:10px;">${icon}</span>
      <span style="flex:1; cursor:${cursor}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" class="item-name">${item.name}</span>
      <button class="btn-text btn-del" data-path="${item.path}" data-sha="${item.sha}" data-type="${item.type}" style="color:#FF6B6B; font-size:11px; padding:4px 8px;">Delete</button>
    `;

    if (item.type === 'folder') {
      div.querySelector('.item-name').onclick = () => {
        currentAdminPath = item.path;
        renderFileBrowser();
      };
    }

    div.querySelector('.btn-del').onclick = (e) => {
      const type = e.target.getAttribute('data-type');
      const p = e.target.getAttribute('data-path');
      const sha = e.target.getAttribute('data-sha');
      
      if (type === 'folder') {
        alert("Delete the files inside the folder to remove the folder.");
        return;
      }

      if (confirm(`Delete ${p}?`)) {
        adminAction('delete', { path: p, sha: sha });
      }
    };

    adminFileBrowser.appendChild(div);
  });
}

async function adminAction(action, payload) {
  if (!currentAdminSession) return alert("Not authenticated");
  adminStatus.textContent = `Processing ${action}...`;
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentAdminSession}`
      },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json();
    if (data.success) {
      adminStatus.textContent = `Success: ${action}`;
      if (action !== 'add_admin') {
        setTimeout(loadAdminTree, 1000);
      } else {
        adminMsg.textContent = 'Admin added successfully.';
        adminMsg.style.color = '#4CAF50';
      }
    } else {
      adminStatus.textContent = `Error: ${data.error}`;
      if (action === 'add_admin') adminMsg.textContent = data.error;
    }
  } catch(e) {
    adminStatus.textContent = `Error: ${e.message}`;
  }
}

// Upload Logic
if(btnAdminUpload) {
  btnAdminUpload.onclick = () => adminFileInput.click();
}
if(adminFileInput) {
  adminFileInput.onchange = (e) => {
    const files = e.target.files;
    if (!files.length) return;
    
    let processed = 0;
    adminStatus.textContent = `Uploading 0/${files.length}...`;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        const path = currentAdminPath + file.name;
        
        let existingSha = null;
        const existing = currentAdminTree.find(i => i.path === path);
        if (existing) existingSha = existing.sha;

        adminAction('upload', { path, contentBase64: base64, sha: existingSha }).then(() => {
          processed++;
          adminStatus.textContent = `Uploaded ${processed}/${files.length}`;
          if(processed === files.length) {
            setTimeout(loadAdminTree, 1500);
            adminFileInput.value = ''; // Reset
          }
        });
      };
      reader.readAsDataURL(file);
    });
  };
}

if(btnAdminNewFolder) {
  btnAdminNewFolder.onclick = () => {
    const name = prompt("Enter folder name:");
    if(name) {
      const path = currentAdminPath + name + '/.gitkeep';
      const base64 = btoa(' '); 
      adminAction('upload', { path, contentBase64: base64 });
    }
  };
}

if(btnAdminRefresh) {
  btnAdminRefresh.onclick = loadAdminTree;
}

if(btnAddAdmin) {
  btnAddAdmin.onclick = () => {
    const val = newAdminInput.value.trim();
    if(val) {
      adminMsg.textContent = 'Adding...';
      adminMsg.style.color = '#888';
      adminAction('add_admin', { newAdmin: val });
    }
  };
}
