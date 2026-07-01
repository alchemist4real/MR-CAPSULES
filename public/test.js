
    const supabaseUrl = 'https://hdhvrlkizorscvehttzd.supabase.co';
    const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';
    const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

    let sessionToken = null;
    let currentTree = [];
    let currentPath = '';
    let isGridMode = false;
    let selectedFiles = new Set();

    const authOverlay = document.getElementById('authOverlay');
    const authMessage = document.getElementById('authMessage');
    const statusText = document.getElementById('statusText');
    const fileBrowser = document.getElementById('fileBrowser');
    const pathBreadcrumbs = document.getElementById('pathBreadcrumbs');
    const itemCount = document.getElementById('itemCount');
    const fileInput = document.getElementById('fileInput');

    // Search Filter Logic
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const val = e.target.value.toLowerCase();
      document.querySelectorAll('.file-item').forEach(el => {
        const name = el.querySelector('.file-name').textContent.toLowerCase();
        if (name.includes(val)) el.classList.remove('hidden');
        else el.classList.add('hidden');
      });
    });

    // Custom Modals Logic
    function customPrompt(title, defaultValue = '') {
      return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        const titleEl = document.getElementById('promptTitle');
        const inputEl = document.getElementById('promptInput');
        const btnCancel = document.getElementById('promptCancel');
        const btnConfirm = document.getElementById('promptConfirm');

        titleEl.textContent = title;
        inputEl.value = defaultValue;
        inputEl.style.display = 'block';
        modal.classList.remove('hidden');
        inputEl.focus();

        const cleanup = () => {
          modal.classList.add('hidden');
          btnCancel.onclick = null;
          btnConfirm.onclick = null;
        };

        btnCancel.onclick = () => { cleanup(); resolve(null); };
        btnConfirm.onclick = () => { cleanup(); resolve(inputEl.value); };
      });
    }

    function customConfirm(title) {
      return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        const titleEl = document.getElementById('promptTitle');
        const inputEl = document.getElementById('promptInput');
        const btnCancel = document.getElementById('promptCancel');
        const btnConfirm = document.getElementById('promptConfirm');

        titleEl.textContent = title;
        inputEl.style.display = 'none';
        modal.classList.remove('hidden');

        const cleanup = () => {
          modal.classList.add('hidden');
          btnCancel.onclick = null;
          btnConfirm.onclick = null;
        };

        btnCancel.onclick = () => { cleanup(); resolve(false); };
        btnConfirm.onclick = () => { cleanup(); resolve(true); };
      });
    }

    // Init Auth
    supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        verifyAdmin(session);
      } else {
        redirectToHome("Not logged in. Redirecting...");
      }
    });

    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        redirectToHome("Signed out. Redirecting...");
      }
    });

    async function verifyAdmin(session) {
      sessionToken = session.access_token;
      document.getElementById('userBadge').textContent = session.user.email;
      
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'check' })
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
          authOverlay.classList.add('hidden');
          window.adminsList = data.admins || [];
          if (data.isSuperAdmin) {
            window.isSuperAdmin = true;
            document.getElementById('adminTabs').style.display = 'flex';
            loadUsers();
          }
          loadTree();
        } else {
          redirectToHome(data.error || "Forbidden. You are not an admin.");
        }
      } catch(e) {
        redirectToHome("Verification failed: " + e.message);
      }
    }

    function redirectToHome(msg) {
      authOverlay.classList.remove('hidden');
      authMessage.textContent = msg;
      setTimeout(() => { window.location.href = '/'; }, 1500);
    }

    document.getElementById('btnSignOut').onclick = async () => {
      await supabaseClient.auth.signOut();
    };

    // Load Data
    async function loadTree() {
      statusText.textContent = 'Fetching repository...';
      fileBrowser.innerHTML = '';
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'tree' })
        });
        const data = await res.json();
        if (data.success && data.tree) {
          currentTree = data.tree.filter(i => i.path.startsWith('content/') || i.path.startsWith('cover/'));
          renderBrowser();
          statusText.textContent = 'Repository loaded.';
        } else {
          statusText.textContent = 'Failed to load tree: ' + data.error;
        }
      } catch(e) {
        statusText.textContent = 'Error: ' + e.message;
      }
    }

    function renderBrowser() {
      fileBrowser.innerHTML = '';
      
      // Breadcrumbs
      if (currentPath === '') {
        pathBreadcrumbs.innerHTML = '';
      } else {
        const parts = currentPath.replace(/\/$/, '').split('/');
        let html = '';
        let buildPath = '';
        parts.forEach((p, i) => {
          buildPath += p + '/';
          const isLast = i === parts.length - 1;
          html += `<span class="path-separator">/</span><span class="${isLast ? '' : 'path-link'}" data-path="${buildPath}">${p}</span>`;
        });
        pathBreadcrumbs.innerHTML = html;
        
        document.querySelectorAll('.path-link').forEach(el => {
          el.addEventListener('click', (e) => {
            currentPath = e.target.getAttribute('data-path');
            renderBrowser();
          });
        });
      }

      document.getElementById('pathRoot').onclick = () => { currentPath = ''; renderBrowser(); };

      // Map contents
      let items = new Map();
      currentTree.forEach(item => {
        if (item.path.startsWith(currentPath)) {
          const remainder = item.path.substring(currentPath.length);
          if (remainder.length === 0) return;
          
          const parts = remainder.split('/');
          const name = parts[0];
          const isFile = parts.length === 1 && item.type === 'blob';
          
          if (!items.has(name)) {
            items.set(name, {
              name: name,
              type: isFile ? 'file' : 'folder',
              path: currentPath + name + (isFile ? '' : '/'),
              sha: isFile ? item.sha : null
            });
          }
        }
      });

      const sortedItems = Array.from(items.values()).sort((a,b) => {
        if(a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'folder' ? -1 : 1;
      });

      if (sortedItems.length === 0 && currentPath === '') {
        sortedItems.push({name: 'content', type: 'folder', path: 'content/', sha: null});
        sortedItems.push({name: 'cover', type: 'folder', path: 'cover/', sha: null});
      }

      itemCount.textContent = `${sortedItems.length} items`;

      if (sortedItems.length === 0 && currentPath !== '') {
        fileBrowser.innerHTML = '<div style="padding:24px; color:#666; text-align:center;">Folder is empty</div>';
      }

      sortedItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-item';
        
        let icon = '';
        const isImg = item.name.match(/\.(jpg|jpeg|png|gif|webp)$/i);
        if (item.type === 'folder') {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
        } else if (isImg) {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
        } else {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
        }
        
        let cbHtml = '';
        if (item.type !== 'folder') {
          cbHtml = `<input type="checkbox" class="file-checkbox" data-path="${item.path}" data-sha="${item.sha}" ${selectedFiles.has(item.path) ? 'checked' : ''}>`;
        }
        
        div.innerHTML = `
          ${cbHtml}
          <div class="file-icon">${icon}</div>
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-actions">
            ${item.type !== 'folder' ? `
              ${item.name.endsWith('.html') ? `<button class="btn btn-edit-code" data-path="${item.path}" data-sha="${item.sha}" style="padding:4px 8px; font-size:11px;">Edit Code</button>` : ''}
              <button class="btn btn-download" data-path="${item.path}" style="padding:4px 8px; font-size:11px;">Download</button>
              <button class="btn btn-move" data-path="${item.path}" style="padding:4px 8px; font-size:11px;">Move</button>
              <button class="btn btn-rename" data-path="${item.path}" style="padding:4px 8px; font-size:11px;">Rename</button>
            ` : ''}
            <button class="btn danger btn-del" data-path="${item.path}" data-sha="${item.sha}" data-type="${item.type}" style="padding:4px 8px; font-size:11px;">Delete</button>
          </div>
        `;

        if (item.type === 'folder') {
          div.querySelector('.file-name').onclick = () => {
            currentPath = item.path;
            renderBrowser();
          };
        } else {
          div.querySelector('.file-name').onclick = () => {
             showPreview(item.path, isImg);
          };
        }

        const cb = div.querySelector('.file-checkbox');
        if (cb) {
          cb.onchange = (e) => {
            if (e.target.checked) selectedFiles.add(item.path);
            else selectedFiles.delete(item.path);
            updateBulkDeleteUI();
          };
        }

        const btnEdit = div.querySelector('.btn-edit-code');
        if (btnEdit) {
          btnEdit.onclick = async (e) => {
            const rawUrl = `https://raw.githubusercontent.com/alchemist4real/MR-CAPSULES/main/${item.path}`;
            const r = await fetch(rawUrl);
            const text = await r.text();
            
            const modal = document.getElementById('editorModal');
            document.getElementById('editorTitle').textContent = `Editing: ${item.name}`;
            modal.classList.remove('hidden');
            
            if (!window.cmEditor) {
              window.cmEditor = CodeMirror.fromTextArea(document.getElementById('codeEditor'), {
                lineNumbers: true,
                mode: "htmlmixed",
                theme: "darcula"
              });
            }
            window.cmEditor.setValue(text);
            setTimeout(() => window.cmEditor.refresh(), 100);
            
            document.getElementById('editorCancel').onclick = () => { modal.classList.add('hidden'); };
            document.getElementById('editorSave').onclick = async (ev) => {
              ev.target.textContent = 'Saving...';
              const newContent = window.cmEditor.getValue();
              const base64 = btoa(unescape(encodeURIComponent(newContent)));
              await adminAction('upload', { path: item.path, contentBase64: base64, sha: item.sha });
              modal.classList.add('hidden');
              ev.target.textContent = 'Save Changes';
              loadTree();
            };
          };
        }

        const btnDownload = div.querySelector('.btn-download');
        if (btnDownload) {
          btnDownload.onclick = () => {
            const rawUrl = `https://raw.githubusercontent.com/alchemist4real/MR-CAPSULES/main/${item.path}`;
            const a = document.createElement('a');
            a.href = rawUrl;
            a.download = item.name;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          };
        }

        const btnMove = div.querySelector('.btn-move');
        if (btnMove) {
          btnMove.onclick = async (e) => {
            const newDir = await customPrompt("Enter new directory path (e.g. content/semester 1/):", currentPath);
            if (!newDir || newDir === currentPath) return;
            const newPath = newDir.replace(/\/$/, '') + '/' + item.name;
            e.target.textContent = '...';
            adminAction('rename_file', { path: item.path, newPath: newPath })
              .then(() => loadTree());
          };
        }

        const btnRename = div.querySelector('.btn-rename');
        if (btnRename) {
          btnRename.onclick = async (e) => {
            const oldPath = item.path;
            const newName = await customPrompt("Enter new file name:", item.name);
            if (!newName || newName === item.name) return;
            const newPath = currentPath + newName;
            
            e.target.textContent = '...';
            adminAction('rename_file', { path: oldPath, newPath: newPath })
              .then(() => loadTree());
          };
        }

        div.querySelector('.btn-del').onclick = async (e) => {
          const p = e.target.getAttribute('data-path');
          const s = e.target.getAttribute('data-sha');
          const t = e.target.getAttribute('data-type');
          
          if(t === 'folder') {
            alert('Folder deletion via UI not supported directly. Delete files inside it.');
            return;
          }

          if(await customConfirm('Delete ' + p + '?')) {
            e.target.textContent = '...';
            adminAction('delete', { path: p, sha: s }).then(() => loadTree());
          }
        };

        fileBrowser.appendChild(div);
      });
    }

    async function adminAction(action, payload) {
      statusText.textContent = `Processing ${action}...`;
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action, ...payload })
        });
        const data = await res.json();
        if (data.success) {
          statusText.textContent = `Success: ${action}`;
          if (action !== 'add_admin') {
            setTimeout(loadTree, 1000);
          } else {
            const msg = document.getElementById('adminMsg');
            msg.textContent = 'Admin added!';
            msg.style.color = '#4CAF50';
          }
        } else {
          statusText.textContent = `Error: ${data.error}`;
        }
      } catch(e) {
        statusText.textContent = `Error: ${e.message}`;
      }
    }

    // Actions
    document.getElementById('btnRefresh').onclick = loadTree;
    
    document.getElementById('btnToggleView').onclick = () => {
      isGridMode = !isGridMode;
      if (isGridMode) {
        fileBrowser.classList.add('grid-mode');
        document.getElementById('iconList').innerHTML = '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>';
      } else {
        fileBrowser.classList.remove('grid-mode');
        document.getElementById('iconList').innerHTML = '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>';
      }
    };

    document.getElementById('btnBulkDelete').onclick = async () => {
      if (selectedFiles.size === 0) return;
      if (!(await customConfirm(`Delete ${selectedFiles.size} selected files?`))) return;
      
      const filesToDelete = [];
      selectedFiles.forEach(path => {
        const item = currentTree.find(i => i.path === path);
        if (item && item.type !== 'folder') {
          filesToDelete.push({ path: item.path, sha: item.sha });
        }
      });
      
      document.getElementById('btnBulkDelete').textContent = 'Deleting...';
      adminAction('delete_files', { files: filesToDelete }).then(() => {
        selectedFiles.clear();
        updateBulkDeleteUI();
        loadTree();
      });
    };

    const viewFilesEl = document.getElementById('viewFiles');
    const dragOverlay = document.getElementById('dragOverlay');
    
    viewFilesEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      dragOverlay.classList.add('drag-active');
    });
    viewFilesEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (e.relatedTarget && !viewFilesEl.contains(e.relatedTarget)) {
        dragOverlay.classList.remove('drag-active');
      }
    });
    viewFilesEl.addEventListener('drop', (e) => {
      e.preventDefault();
      dragOverlay.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        uploadFilesSequential(Array.from(e.dataTransfer.files));
      }
    });

    document.getElementById('lightboxClose').onclick = () => {
      document.getElementById('lightboxModal').classList.add('hidden');
      document.getElementById('lightboxImage').classList.add('hidden');
      document.getElementById('lightboxText').classList.add('hidden');
    };

    function updateBulkDeleteUI() {
      const btn = document.getElementById('btnBulkDelete');
      if (selectedFiles.size > 0) {
        btn.style.display = 'flex';
        document.getElementById('bulkCount').textContent = selectedFiles.size;
      } else {
        btn.style.display = 'none';
      }
    }

    async function showPreview(path, isImg) {
      const modal = document.getElementById('lightboxModal');
      const img = document.getElementById('lightboxImage');
      const txt = document.getElementById('lightboxText');
      modal.classList.remove('hidden');
      img.classList.add('hidden');
      txt.classList.add('hidden');

      const rawUrl = `https://raw.githubusercontent.com/alchemist4real/MR-CAPSULES/main/${path}`;

      if (isImg) {
        img.src = rawUrl;
        img.classList.remove('hidden');
      } else {
        txt.textContent = "Loading preview...";
        txt.classList.remove('hidden');
        try {
          const r = await fetch(rawUrl);
          const text = await r.text();
          txt.textContent = text;
        } catch(e) {
          txt.textContent = "Failed to load content preview. You can open it in GitHub directly: " + `https://github.com/alchemist4real/MR-CAPSULES/blob/main/${path}`;
        }
      }
    }
    
    async function uploadFilesSequential(files) {
      let processed = 0;
      statusText.textContent = `Uploading 0/${files.length}...`;

      for (const file of files) {
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result.split(',')[1]);
          reader.readAsDataURL(file);
        });

        const path = currentPath + file.name;
        const existing = currentTree.find(i => i.path === path);
        
        await adminAction('upload', { path, contentBase64: base64, sha: existing ? existing.sha : null });
        processed++;
        statusText.textContent = `Uploaded ${processed}/${files.length}`;
      }
      loadTree();
    }

    document.getElementById('btnUpload').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      if (e.target.files.length > 0) {
        uploadFilesSequential(Array.from(e.target.files));
      }
    };

    document.getElementById('btnNewFolder').onclick = async () => {
      const name = await customPrompt("Enter new folder name:");
      if(name && name.trim()) {
        const path = currentPath + name.trim() + '/.gitkeep';
        const base64 = btoa(' '); 
        adminAction('upload', { path, contentBase64: base64 });
      }
    };

    // Tabs Logic
    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = (e) => {
        const targetTab = e.currentTarget;
        document.querySelectorAll('.tab').forEach(tx => tx.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(vx => vx.classList.remove('active'));
        targetTab.classList.add('active');
        document.getElementById(targetTab.getAttribute('data-target')).classList.add('active');
      }
    });

    // Users Logic
    async function loadUsers() {
      const userBrowser = document.getElementById('userBrowser');
      userBrowser.innerHTML = '<div style="padding:24px; color:#666; text-align:center;">Loading users...</div>';
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'get_users' })
        });
        const data = await res.json();
        if (data.success) {
          renderUsers(data.users);
        } else {
          userBrowser.innerHTML = `<div style="padding:24px; color:#FF6B6B;">Failed to load users: ${data.error}</div>`;
        }
      } catch(e) {
        userBrowser.innerHTML = `<div style="padding:24px; color:#FF6B6B;">Error: ${e.message}</div>`;
      }
    }

    function renderUsers(users) {
      const userBrowser = document.getElementById('userBrowser');
      userBrowser.innerHTML = '';
      document.getElementById('itemCount').textContent = `${users.length} users`;

      users.forEach(u => {
        const email = u.email;
        const meta = u.user_metadata || {};
        const username = meta.username || '-';
        const isBanned = meta.banned === true;
        
        const isAdmin = window.adminsList && (window.adminsList.includes(email) || window.adminsList.includes(username));

        const card = document.createElement('div');
        card.className = 'user-card';
        
        let badgesHtml = '';
        if (isAdmin) badgesHtml += '<span class="badge badge-admin">ADMIN</span>';
        if (isBanned) badgesHtml += '<span class="badge badge-banned">BANNED</span>';

        card.innerHTML = `
          <div class="user-card-header">
            <div>
              <div class="user-email">${email}</div>
              <div class="user-meta">@${username} &bull; ${new Date(u.created_at).toLocaleDateString()}</div>
            </div>
            <div class="user-badges">${badgesHtml}</div>
          </div>
          
          <div class="card-actions">
            ${window.isSuperAdmin ? `
              ${isAdmin ? 
                `<button class="btn-card btn-revoke" data-target="${email}">Revoke Admin</button>` : 
                `<button class="btn-card primary btn-make-admin" data-target="${email}">Make Admin</button>`
              }
              <button class="btn-card ${isBanned ? 'primary' : 'danger'} btn-ban" data-id="${u.id}" data-banned="${isBanned}">
                ${isBanned ? 'Unban' : 'Ban'}
              </button>
              <button class="btn-card danger btn-del-user" data-id="${u.id}">Delete</button>
            ` : ''}
          </div>
        `;

        if (card.querySelector('.btn-make-admin')) {
          card.querySelector('.btn-make-admin').onclick = async (e) => {
            if(await customConfirm(`Make ${email} an Admin?`)) {
              e.target.textContent = '...';
              adminAction('add_admin', { newAdmin: email }).then(() => loadUsers());
            }
          };
        }

        if (card.querySelector('.btn-revoke')) {
          card.querySelector('.btn-revoke').onclick = async (e) => {
            if(await customConfirm(`Remove admin privileges for ${email}?`)) {
              e.target.textContent = '...';
              adminAction('remove_admin', { targetAdmin: email }).then(() => {
                 window.adminsList = window.adminsList.filter(a => a !== email);
                 loadUsers();
              });
            }
          };
        }

        if (card.querySelector('.btn-ban')) {
          card.querySelector('.btn-ban').onclick = async (e) => {
            const actionText = isBanned ? 'unban' : 'ban';
            if(await customConfirm(`Are you sure you want to ${actionText} ${email}?`)) {
              e.target.textContent = '...';
              const newMeta = { ...meta, banned: !isBanned };
              adminAction('ban_user', { userId: u.id, user_metadata: newMeta }).then(() => loadUsers());
            }
          };
        }

        if (card.querySelector('.btn-del-user')) {
          card.querySelector('.btn-del-user').onclick = async (e) => {
            if(await customConfirm(`WARNING: This will permanently delete the user ${email} from the database. This action cannot be undone. Proceed?`)) {
              e.target.textContent = '...';
              adminAction('delete_user', { userId: u.id }).then(() => loadUsers());
            }
          };
        }

        userBrowser.appendChild(card);
      });
    }

    document.getElementById('btnRefreshUsers').onclick = loadUsers;

  