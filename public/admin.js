let supabaseClient = null;
Object.defineProperty(window, 'supabaseClient', { get() { return supabaseClient; }, set(v) { supabaseClient = v; } });

    // GitHub raw content base URL (points to dedicated content repo MR-CAPSULES-CONTENT)
    const GITHUB_RAW_BASE = window.CONTENT_RAW_BASE || 'https://raw.githubusercontent.com/alchemist4real/MR-CAPSULES-CONTENT/main';

    // UTF-8 safe base64 encoding
    function utf8ToBase64(str) {
      const bytes = new TextEncoder().encode(str);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    // WebKit/Safari compatible clipboard writer with execCommand fallback
    async function safeCopyToClipboard(text) {
      if (!text) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (err) {
        console.warn("navigator.clipboard.writeText failed, trying execCommand fallback:", err);
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const success = document.execCommand('copy');
        document.body.removeChild(ta);
        return success;
      } catch (e) {
        console.error("execCommand fallback failed:", e);
        return false;
      }
    }
    window.safeCopyToClipboard = safeCopyToClipboard;

    let sessionToken = null;
    let currentPath = '';
    let currentTree = [];
    let fileCache = {};
    
    // Expose to window for cross-script access (admin-workflow.js)
    Object.defineProperty(window, 'currentPath', { get() { return currentPath; }, set(v) { currentPath = v; } });
    Object.defineProperty(window, 'currentTree', { get() { return currentTree; }, set(v) { currentTree = v; } });
    Object.defineProperty(window, 'sessionToken', { get() { return sessionToken; }, set(v) { sessionToken = v; } });

    async function fetchFileSecureBlob(path, mimeType = 'application/octet-stream') {
        const res = await adminAction('download', { path });
        if (!res.success || !res.contentBase64) throw new Error("Failed to download: " + (res.error || 'Unknown error'));
        const fetchRes = await fetch(`data:${mimeType};base64,${res.contentBase64}`);
        return await fetchRes.blob();
    }

    async function fetchFileSecureText(path) {
        const res = await adminAction('download', { path });
        if (!res.success || !res.contentBase64) throw new Error("Failed to download: " + (res.error || 'Unknown error'));
        const fetchRes = await fetch(`data:application/octet-stream;base64,${res.contentBase64}`);
        return await fetchRes.text();
    }

    let isGridMode = true;
    let selectedFiles = new Set();

    function sanitize(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    window.hybridLogs = [];
    
    window.fetchHybridLogs = async function() {
      try {
        const { data, error } = await supabaseClient.from('activity_logs').select('*').order('time', { ascending: false }).limit(100);
        if (!error && data) {
          window.hybridLogs = data.map(d => ({
            id: d.log_id,
            type: d.type,
            time: new Date(d.time).getTime(),
            user: d.user_name,
            email: d.email,
            devStr: d.dev_str
          }));
          window.renderHybridLogs();
        }
      } catch(e) { console.error("Error formatting hybrid logs:", e); }
    };
    
    window.renderHybridLogs = function() {
      var logList = document.getElementById('activityLogList');
      if (!logList) return;
      logList.innerHTML = '';
      
      var sorted = window.hybridLogs.slice().sort(function(a, b) { return b.time - a.time; });
      
      sorted.forEach(function(log) {
        var item = document.createElement('div');
        item.style.padding = '12px 24px';
        item.style.borderBottom = '1px solid var(--border-light)';
        item.style.animation = 'fadeIn 0.3s ease';
        
        var timeStr = new Date(log.time).toLocaleString();
        if (log.type === 'login') {
          item.innerHTML = '<div style="font-size:13px; font-weight:600; color:var(--c4);">' + timeStr + ' - [SYSTEM: LOGIN]</div>' +
            '<div style="font-weight:700; font-size:14.5px; margin-top:2px; word-break:break-word;">' + sanitize(log.user) + '</div>' +
            '<div style="font-size:14px; margin-top:2px; word-break:break-all;">' + sanitize(log.email || '') + '</div>' +
            '<div style="font-size:12px; color:var(--text-muted); opacity:0.95; margin-top:4px; word-break:break-all;">Devices: ' + sanitize(log.devStr || 'Unknown') + '</div>';
        } else if (log.type === 'online') {
          item.innerHTML = '<div style="font-size:13px; font-weight:600; color:var(--c4);">' + timeStr + ' - [LIVE PRESENCE]</div>' +
            '<div style="font-weight:700; font-size:14.5px; color:var(--text-main); margin-top:2px; word-break:break-word;">' + sanitize(log.user) + ' came online</div>';
        } else if (log.type === 'offline') {
          item.innerHTML = '<div style="font-size:13px; font-weight:600; color:var(--text-muted);">' + timeStr + ' - [LIVE PRESENCE]</div>' +
            '<div style="font-weight:700; font-size:14.5px; color:var(--danger); margin-top:2px; word-break:break-word;">' + sanitize(log.user) + ' went offline</div>';
        }
        logList.appendChild(item);
      });
      if (sorted.length === 0) {
         logList.innerHTML = '<div id="activityPlaceholder" style="padding:24px; color:var(--text-muted); text-align:center;">Waiting for activity...</div>';
      }
    };
    
    window.addHybridLog = async function(log) {
       const exists = window.hybridLogs.find(l => l.id === log.id);
       if (!exists) {
          window.hybridLogs.push(log);
          window.hybridLogs.sort(function(a, b) { return b.time - a.time; });
          if (window.hybridLogs.length > 200) window.hybridLogs = window.hybridLogs.slice(0, 200);
           try {
             await supabaseClient.from('activity_logs').upsert({
                log_id: log.id,
                type: log.type,
                time: new Date(log.time).toISOString(),
                user_name: log.user,
                email: log.email || null,
                dev_str: log.devStr || null
             }, { onConflict: 'log_id' });
          } catch(e) { console.error("Error inserting activity log:", e); }
       }
    };

    const authOverlay = document.getElementById('authOverlay');
    const authMessage = document.getElementById('authMessage');
    const _statusTextEl = document.getElementById('statusText');
    const _statusBarEl = document.querySelector('.status-bar');
    let _statusTimeout;
    const statusText = {
      set textContent(val) {
        if(_statusTextEl) _statusTextEl.textContent = val;
        if(_statusBarEl) {
          _statusBarEl.classList.add('active');
          clearTimeout(_statusTimeout);
          _statusTimeout = setTimeout(() => _statusBarEl.classList.remove('active'), 3000);
        }
      }
    };
    const fileBrowser = document.getElementById('fileBrowser');
    const pathBreadcrumbs = document.getElementById('pathBreadcrumbs');
    const _itemCountEl = document.getElementById('itemCount');
    const itemCount = {
      set textContent(val) {
        if(_itemCountEl) _itemCountEl.textContent = val;
        if(_statusBarEl) {
          _statusBarEl.classList.add('active');
          clearTimeout(_statusTimeout);
          _statusTimeout = setTimeout(() => _statusBarEl.classList.remove('active'), 3000);
        }
      }
    };
    const fileInput = document.getElementById('fileInput');

    // Search Filter Logic (150ms debounced)
    let searchTimeout;
    document.getElementById('searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const val = e.target.value.toLowerCase();
        document.querySelectorAll('.file-item').forEach(el => {
          const name = el.querySelector('.file-name')?.textContent.toLowerCase() || '';
          el.classList.toggle('hidden', !name.includes(val));
        });
      }, 150);
    });

    // ============================================================================
    // UNIFIED MODAL MANAGER WITH DYNAMIC Z-INDEX STACKING
    // Ensures nested modals stack correctly without z-index collisions,
    // traps focus, handles Escape key close, and restores focus cleanly.
    // ============================================================================
    const ModalManager = (function () {
      const modalStack = [];
      let keydownListenerAttached = false;
      const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const BASE_Z = 10000;

      function handleGlobalKeydown(e) {
        if (modalStack.length === 0) return;
        const currentModalInfo = modalStack[modalStack.length - 1];
        const { modalEl, options } = currentModalInfo;

        if (e.key === 'Escape' || e.keyCode === 27) {
          if (options.closeOnEscape !== false) {
            e.preventDefault();
            close(modalEl, { reason: 'escape' });
          }
          return;
        }

        if (e.key === 'Tab' || e.keyCode === 9) {
          const focusables = Array.from(modalEl.querySelectorAll(FOCUSABLE_SELECTOR))
            .filter(el => (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement) && !el.disabled);

          if (focusables.length === 0) {
            e.preventDefault();
            return;
          }

          const firstEl = focusables[0];
          const lastEl = focusables[focusables.length - 1];

          if (e.shiftKey) {
            if (document.activeElement === firstEl || !modalEl.contains(document.activeElement)) {
              e.preventDefault();
              lastEl.focus();
            }
          } else {
            if (document.activeElement === lastEl || !modalEl.contains(document.activeElement)) {
              e.preventDefault();
              firstEl.focus();
            }
          }
        }
      }

      function ensureListener() {
        if (!keydownListenerAttached) {
          document.addEventListener('keydown', handleGlobalKeydown, true);
          keydownListenerAttached = true;
        }
      }

      function open(modalEl, options = {}) {
        if (!modalEl) return;
        ensureListener();

        // Calculate dynamic z-index to guarantee top-most stacking for nested modals
        const currentZ = BASE_Z + ((modalStack.length + 1) * 20);
        modalEl.style.zIndex = currentZ;

        const previousActiveElement = document.activeElement;
        const modalInfo = { modalEl, previousActiveElement, options, onClose: options.onClose || null, zIndex: currentZ };
        modalStack.push(modalInfo);

        modalEl.classList.add('active');
        modalEl.classList.remove('hidden');
        modalEl.setAttribute('aria-modal', 'true');
        modalEl.setAttribute('role', 'dialog');

        setTimeout(() => {
          const initialFocus = options.initialFocusEl || modalEl.querySelector(FOCUSABLE_SELECTOR);
          if (initialFocus && typeof initialFocus.focus === 'function') initialFocus.focus();
        }, 60);
      }

      function close(modalEl, resultData = null) {
        if (!modalEl) return;
        const stackIdx = modalStack.findIndex(item => item.modalEl === modalEl);
        let modalInfo = null;
        if (stackIdx !== -1) {
          [modalInfo] = modalStack.splice(stackIdx, 1);
        }

        modalEl.classList.remove('active');
        if (modalEl.id === 'lightboxModal') {
          modalEl.classList.add('hidden');
        }
        modalEl.style.zIndex = '';
        modalEl.removeAttribute('aria-modal');

        if (modalInfo && typeof modalInfo.onClose === 'function') {
          try { modalInfo.onClose(resultData); } catch (e) { console.error('Error in modal onClose:', e); }
        }

        // Restore focus to previous active element or previous modal in stack
        if (modalInfo && modalInfo.previousActiveElement && typeof modalInfo.previousActiveElement.focus === 'function') {
          modalInfo.previousActiveElement.focus();
        } else if (modalStack.length > 0) {
          const topModal = modalStack[modalStack.length - 1];
          const topFocusable = topModal.modalEl.querySelector(FOCUSABLE_SELECTOR);
          if (topFocusable) topFocusable.focus();
        }
      }

      function isTopModal(modalEl) {
        if (modalStack.length === 0) return false;
        return modalStack[modalStack.length - 1].modalEl === modalEl;
      }

      function getActiveCount() {
        return modalStack.length;
      }

      return { open, close, isTopModal, getActiveCount };
    })();

    window.ModalManager = ModalManager;

    // Custom Modals Logic
    window.customPrompt = function customPrompt(title, defaultValue = '') {
      return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        const titleEl = document.getElementById('promptTitle');
        const inputEl = document.getElementById('promptInput');
        const btnCancel = document.getElementById('promptCancel');
        const btnConfirm = document.getElementById('promptConfirm');
        const btnHeaderCancel = document.getElementById('promptHeaderCancel');

        let msgEl = document.getElementById('promptMessageText');
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.id = 'promptMessageText';
          msgEl.className = 'prompt-message-text';
          inputEl.parentNode.insertBefore(msgEl, inputEl);
        }

        if (title.length > 30) {
          titleEl.textContent = 'INPUT REQUIRED';
          msgEl.textContent = title;
          msgEl.style.display = 'block';
        } else {
          titleEl.textContent = title;
          msgEl.style.display = 'none';
        }

        inputEl.value = defaultValue;
        inputEl.style.display = 'block';
        btnCancel.style.display = '';
        btnConfirm.textContent = 'Confirm';

        let resolved = false;
        const cleanupAndResolve = (val) => {
          if (resolved) return;
          resolved = true;
          if (msgEl) msgEl.style.display = 'none';
          btnCancel.onclick = null;
          btnConfirm.onclick = null;
          inputEl.onkeydown = null;
          if (btnHeaderCancel) btnHeaderCancel.onclick = null;
          ModalManager.close(modal);
          resolve(val);
        };

        btnCancel.onclick = () => cleanupAndResolve(null);
        btnConfirm.onclick = () => cleanupAndResolve(inputEl.value);
        if (btnHeaderCancel) {
          btnHeaderCancel.onclick = () => cleanupAndResolve(null);
        }

        inputEl.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            cleanupAndResolve(inputEl.value);
          }
        };

        ModalManager.open(modal, {
          initialFocusEl: inputEl,
          onClose: () => cleanupAndResolve(null)
        });
      });
    };

    window.customConfirm = function customConfirm(title, message = '') {
      return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        const titleEl = document.getElementById('promptTitle');
        const inputEl = document.getElementById('promptInput');
        const btnCancel = document.getElementById('promptCancel');
        const btnConfirm = document.getElementById('promptConfirm');
        const btnHeaderCancel = document.getElementById('promptHeaderCancel');

        let msgEl = document.getElementById('promptMessageText');
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.id = 'promptMessageText';
          msgEl.className = 'prompt-message-text';
          inputEl.parentNode.insertBefore(msgEl, inputEl);
        }

        if (message) {
          titleEl.textContent = title;
          msgEl.textContent = message;
        } else if (title.length > 25) {
          titleEl.textContent = 'CONFIRM ACTION';
          msgEl.textContent = title;
        } else {
          titleEl.textContent = title;
          msgEl.textContent = '';
        }
        msgEl.style.display = msgEl.textContent ? 'block' : 'none';

        inputEl.style.display = 'none';
        btnCancel.style.display = '';
        btnConfirm.textContent = 'Confirm';

        let resolved = false;
        const cleanupAndResolve = (val) => {
          if (resolved) return;
          resolved = true;
          if (msgEl) msgEl.style.display = 'none';
          inputEl.style.display = '';
          btnCancel.onclick = null;
          btnConfirm.onclick = null;
          if (btnHeaderCancel) btnHeaderCancel.onclick = null;
          ModalManager.close(modal);
          resolve(val);
        };

        btnCancel.onclick = () => cleanupAndResolve(false);
        btnConfirm.onclick = () => cleanupAndResolve(true);
        if (btnHeaderCancel) {
          btnHeaderCancel.onclick = () => cleanupAndResolve(false);
        }

        ModalManager.open(modal, {
          initialFocusEl: btnConfirm,
          onClose: () => cleanupAndResolve(false)
        });
      });
    };

    window.customAlert = function customAlert(title, msg) {
      if (!msg) { msg = title; title = 'Alert'; }
      return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        const titleEl = document.getElementById('promptTitle');
        const inputEl = document.getElementById('promptInput');
        const btnCancel = document.getElementById('promptCancel');
        const btnConfirm = document.getElementById('promptConfirm');
        const btnHeaderCancel = document.getElementById('promptHeaderCancel');

        titleEl.textContent = title;
        inputEl.style.display = 'none';

        let msgEl = document.getElementById('promptMessageText');
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.id = 'promptMessageText';
          msgEl.className = 'prompt-message-text';
          inputEl.parentNode.insertBefore(msgEl, inputEl);
        }
        msgEl.textContent = msg;
        msgEl.style.display = 'block';

        btnCancel.style.display = 'none';
        btnConfirm.textContent = 'OK';

        let resolved = false;
        const cleanupAndResolve = () => {
          if (resolved) return;
          resolved = true;
          msgEl.style.display = 'none';
          inputEl.style.display = '';
          btnCancel.style.display = '';
          btnConfirm.textContent = 'Confirm';
          btnConfirm.onclick = null;
          if (btnHeaderCancel) btnHeaderCancel.onclick = null;
          ModalManager.close(modal);
          resolve();
        };

        btnConfirm.onclick = () => cleanupAndResolve();
        if (btnHeaderCancel) btnHeaderCancel.onclick = () => cleanupAndResolve();

        ModalManager.open(modal, {
          initialFocusEl: btnConfirm,
          onClose: () => cleanupAndResolve()
        });
      });
    };

    // Inline Login Form Helper for iPad/Private Browsing/Direct link access
    function showAdminLoginForm() {
      authOverlay.classList.remove('hidden');
      const spinner = document.getElementById('authSpinner');
      if (spinner) spinner.style.display = 'none';
      const authMsg = document.getElementById('authMessage');
      if (authMsg) authMsg.style.display = 'none';
      const loginForm = document.getElementById('adminLoginForm');
      if (loginForm) {
        loginForm.style.display = 'flex';
        const emailInput = document.getElementById('adminLoginEmail');
        const passInput = document.getElementById('adminLoginPassword');
        const submitBtn = document.getElementById('btnAdminLoginSubmit');
        const errEl = document.getElementById('adminLoginError');

        const doLogin = async () => {
          const email = emailInput?.value.trim();
          const password = passInput?.value;
          if (!email || !password) {
            if (errEl) { errEl.textContent = 'Please enter email and password'; errEl.style.display = 'block'; }
            return;
          }
          if (errEl) errEl.style.display = 'none';
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in...'; }
          try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            if (data && data.session) {
              loginForm.style.display = 'none';
              if (spinner) spinner.style.display = '';
              if (authMsg) { authMsg.style.display = ''; authMsg.textContent = 'Verifying permissions...'; }
              await verifyAdmin(data.session);
            }
          } catch (err) {
            if (errEl) { errEl.textContent = err.message || 'Login failed'; errEl.style.display = 'block'; }
          } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign In'; }
          }
        };

        if (submitBtn) submitBtn.onclick = doLogin;
        if (passInput) passInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
        if (emailInput) emailInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
        setTimeout(() => emailInput?.focus(), 100);
      }
    }

    // Init Auth
    (async function initSupabaseAndAuth() {
        try {
            const envRes = await fetch('/api/env');
            const env = await envRes.json();
            supabaseClient = window.supabase.createClient(env.url, env.key);
            
            supabaseClient.auth.getSession().then(({ data: { session } }) => {
              if (session) {
                verifyAdmin(session);
              } else {
                showAdminLoginForm();
              }
            }).catch(err => {
              console.warn("Session error:", err);
              showAdminLoginForm();
            });

            supabaseClient.auth.onAuthStateChange((event, session) => {
              if (event === 'SIGNED_OUT') {
                showAdminLoginForm();
              } else if (event === 'SIGNED_IN' && session) {
                verifyAdmin(session);
              }
            });
        } catch (e) {
            console.error("Failed to load environment or initialize Supabase", e);
            redirectToHome("Initialization failed. Check connection.");
        }
    })();

    async function verifyAdmin(session) {
      sessionToken = session.access_token;
      window.dispatchEvent(new CustomEvent('adminReady', { detail: { token: sessionToken } }));
      const badgeEl = document.getElementById('userBadge');
      const username = session.user.user_metadata?.username || session.user.email.split('@')[0];
      const email = session.user.email || '';
      const initials = (username.length >= 2 ? username.substring(0, 2) : username).toUpperCase();
      
      if (badgeEl) badgeEl.textContent = session.user.user_metadata?.username || session.user.email;
      
      const mobileInitialsEl = document.getElementById('mobileUserInitials');
      if (mobileInitialsEl) mobileInitialsEl.textContent = initials;
      const mobileAvatarEl = document.getElementById('mobileUserAvatarLarge');
      if (mobileAvatarEl) mobileAvatarEl.textContent = initials;
      const mobileNameEl = document.getElementById('mobileUserNameDisplay');
      if (mobileNameEl) mobileNameEl.textContent = username;
      const mobileEmailEl = document.getElementById('mobileUserEmailDisplay');
      if (mobileEmailEl) mobileEmailEl.textContent = email;
      const mobileWaInput = document.getElementById('mobileWaInput');
      if (mobileWaInput && session.user.user_metadata?.whatsapp) {
        mobileWaInput.value = session.user.user_metadata.whatsapp;
      }

      const btnMobileMenu = document.getElementById('btnMobileUserMenu');
      if (btnMobileMenu) {
        btnMobileMenu.onclick = () => {
          const modal = document.getElementById('mobileUserModal');
          if (modal) {
            if (window.ModalManager) window.ModalManager.open(modal);
            else modal.classList.add('active');
          }
        };
      }

      const btnSignOutMobile = document.getElementById('btnSignOutMobile');
      if (btnSignOutMobile) {
        btnSignOutMobile.onclick = () => {
          if (supabaseClient) supabaseClient.auth.signOut().then(() => window.location.href = '/');
          else window.location.href = '/';
        };
      }

      const btnSaveWaMobile = document.getElementById('btnSaveWaMobile');
      if (btnSaveWaMobile) {
        btnSaveWaMobile.onclick = async () => {
          const waInput = document.getElementById('mobileWaInput');
          const wa = waInput ? waInput.value.trim() : '';
          const saveFn = async () => {
            if (typeof apiCall === 'function') {
              const wRes = await apiCall('divisions', { action: 'update_whatsapp', whatsapp: wa });
              if (wRes && wRes.success) showToast('WhatsApp updated!', 'success');
              else showToast('Failed: ' + (wRes?.error || 'Unknown error'), 'error');
            }
          };
          if (typeof withButtonLoading === 'function') {
            await withButtonLoading(btnSaveWaMobile, saveFn, 'Saving...');
          } else {
            await saveFn();
          }
        };
      }
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'check' }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        
        if (res.ok && data.success) {
          authOverlay.classList.add('hidden');
          document.getElementById('adminTabs').classList.remove('hidden');
          
          window.isSuperAdmin = !!data.isSuperAdmin;
          window.isAdmin = !!(data.isAdmin || data.isSuperAdmin);
          if (badgeEl) badgeEl.dataset.role = window.isSuperAdmin ? 'superadmin' : (window.isAdmin ? 'admin' : 'user');

          const mobileBadgesEl = document.getElementById('mobileUserBadges');
          if (mobileBadgesEl) {
            let bHtml = '';
            if (window.isSuperAdmin) bHtml += '<span class="badge badge-admin">SUPERADMIN</span>';
            else if (window.isAdmin) bHtml += '<span class="badge badge-admin">ADMIN</span>';
            else bHtml += '<span class="badge badge-member">MEMBER</span>';
            if (session.user.user_metadata?.division) {
              bHtml += `<span class="badge badge-division">${sanitize(session.user.user_metadata.division.toUpperCase())}</span>`;
            }
            mobileBadgesEl.innerHTML = bHtml;
          }

          // Initialize all views data
          loadUsers();
          if (typeof loadDivisions !== 'undefined') loadDivisions(); else if (window.loadDivisions) window.loadDivisions();
          if (typeof loadTasks !== 'undefined') loadTasks(); else if (window.loadTasks) window.loadTasks();
          if (window.loadContributions) window.loadContributions();
          fetchHybridLogs();
          
          try {
            if (supabaseClient) {
              window.sessionRoom = supabaseClient.channel('online-users', {
                config: { broadcast: { self: true, ack: true } }
              });
              window.sessionRoom.on('presence', { event: 'sync' }, () => {
                const state = window.sessionRoom.presenceState();
                const count = Object.keys(state).length;
                const el = document.getElementById('dashOnlineCount');
                if (el) el.textContent = count;
                // Mark online user cards
                var cards = document.querySelectorAll('#userBrowser .user-card');
                var emailMap = new Map();
                cards.forEach(function(c) {
                  c.setAttribute('data-online', 'false');
                  var emailEl = c.querySelector('.user-email');
                  if (emailEl) emailMap.set(emailEl.textContent, c);
                });
                Object.values(state).forEach(function(presences) {
                  presences.forEach(function(p) {
                    if (p.user && p.email) {
                      var card = emailMap.get(p.email);
                      if (card) card.setAttribute('data-online', 'true');
                    }
                  });
                });
              }).on('presence', { event: 'join' }, ({ key, newPresences }) => {
                newPresences.forEach(function(p) {
                  var name = (p.email || p.user || 'Unknown');
                  window.addHybridLog({
                     id: 'online_' + name + '_' + Date.now(),
                     type: 'online',
                     time: Date.now(),
                     user: name
                  });
                });
                window.renderHybridLogs();
              }).on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                leftPresences.forEach(function(p) {
                  var name = (p.email || p.user || 'Unknown');
                  window.addHybridLog({
                     id: 'offline_' + name + '_' + Date.now(),
                     type: 'offline',
                     time: Date.now(),
                     user: name
                  });
                });
                window.renderHybridLogs();
              }).subscribe(async (status) => {
                 if (status === 'SUBSCRIBED') {
                    var tEmail = (badgeEl ? badgeEl.textContent : '') || 'Admin';
                    var tNow = Date.now();
                    await window.sessionRoom.track({ user: 'auth-user', email: tEmail, joined_at: new Date().toISOString() });
                    
                    window.addHybridLog({
                       id: 'online_' + tEmail + '_' + tNow,
                       type: 'online',
                       time: tNow,
                       user: tEmail
                    });
                    window.renderHybridLogs();
                 }
              });

              // Real-time Database Subscriptions
              const updateAndRender = () => {
                if (window.lastLoadedUsers && window.lastBannedDevs) {
                  renderUsers(window.lastLoadedUsers, window.lastBannedDevs);
                  const dashTotalUsers = document.getElementById('dashTotalUsers');
                  if (dashTotalUsers) dashTotalUsers.textContent = window.lastLoadedUsers.length;
                }
              };

              window.dbChannel = supabaseClient.channel('db-changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, payload => {
                   if (!window.lastLoadedUsers) return;
                   if (payload.eventType === 'DELETE') {
                     window.lastLoadedUsers = window.lastLoadedUsers.filter(u => u.id !== payload.old.id);
                   } else if (payload.eventType === 'INSERT') {
                     window.lastLoadedUsers.push({
                       id: payload.new.id,
                       email: payload.new.email,
                       created_at: payload.new.created_at,
                       user_metadata: { username: payload.new.username },
                       app_metadata: { banned: payload.new.banned },
                       role: 'user'
                     });
                   } else if (payload.eventType === 'UPDATE') {
                     const u = window.lastLoadedUsers.find(u => u.id === payload.new.id);
                     if (u) {
                       u.email = payload.new.email;
                       u.user_metadata = u.user_metadata || {};
                       u.user_metadata.username = payload.new.username;
                       u.app_metadata = u.app_metadata || {};
                       u.app_metadata.banned = payload.new.banned;
                     }
                   }
                   updateAndRender();
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'user_roles' }, payload => {
                   if (!window.lastLoadedUsers) return;
                   if (payload.eventType === 'DELETE') {
                     const u = window.lastLoadedUsers.find(u => u.email === payload.old.identifier || (u.user_metadata||{}).username === payload.old.identifier);
                     if (u) u.role = 'user';
                   } else {
                     const u = window.lastLoadedUsers.find(u => u.email === payload.new.identifier || (u.user_metadata||{}).username === payload.new.identifier);
                     if (u) u.role = payload.new.role;
                   }
                   updateAndRender();
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'user_devices' }, payload => {
                   clearTimeout(window._deviceChangeTimer);
                   window._deviceChangeTimer = setTimeout(() => loadUsers(), 800);
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, payload => {
                   window._cachedBannedDevices = null;
                   loadUsers();
                })
                .subscribe();
            }

            // Setup Broadcast announcement button
            const btnSendAnn = document.getElementById('btnSendAnnouncement');
            if (btnSendAnn) {
              btnSendAnn.onclick = async () => {
                 const txtInput = document.getElementById('announcementText');
                 const txt = txtInput ? txtInput.value.trim() : '';
                 if (!txt) {
                   if (window.showToast) window.showToast('Please enter an announcement message', 'error');
                   return;
                 }
                 await withButtonLoading(btnSendAnn, async () => {
                   try {
                     if (window.sessionRoom) {
                       await window.sessionRoom.send({
                          type: 'broadcast',
                          event: 'announcement',
                          payload: { message: txt }
                       });
                     }
                     if (txtInput) txtInput.value = '';
                     if (window.showToast) window.showToast('Announcement broadcasted successfully!', 'success');
                   } catch(err) {
                     console.error("Broadcast failed:", err);
                     if (window.showToast) window.showToast('Broadcast error: ' + err.message, 'error');
                   }
                 }, 'Sending...');
              };
            }

            // Setup Config Switches
            const cfgRes = await adminAction('get_config');
            const toggle = document.getElementById('toggleSignup');
            const toggleGuest = document.getElementById('toggleGuest');
            const toggleMaint = document.getElementById('toggleMaintenance');
            
            if (cfgRes && cfgRes.success) {
              window.configSha = cfgRes.sha;
              const configObj = cfgRes.config || {};
              if (toggle) toggle.checked = configObj.allowSignup !== false;
              if (toggleGuest) toggleGuest.checked = configObj.allowGuest !== false;
              if (toggleMaint) toggleMaint.checked = configObj.maintenanceMode === true;
            } else {
              window.configSha = null;
              if (toggle) toggle.checked = true;
              if (toggleGuest) toggleGuest.checked = true;
              if (toggleMaint) toggleMaint.checked = false;
            }
            
            const updateConfig = async () => {
              const isAllowed = toggle ? toggle.checked : true;
              const isGuestAllowed = toggleGuest ? toggleGuest.checked : true;
              const isMaint = toggleMaint ? toggleMaint.checked : false;
              await adminAction('update_config', { allowSignup: isAllowed, allowGuest: isGuestAllowed, maintenanceMode: isMaint });
            };
            
            if (toggle) {
              toggle.onchange = async (e) => {
                 if (!await customConfirm('Are you sure you want to change allow signup setting?')) {
                   e.target.checked = !e.target.checked;
                   return;
                 }
                 await updateConfig();
              };
            }
            if (toggleGuest) {
              toggleGuest.onchange = async (e) => {
                 if (!await customConfirm('Are you sure you want to ' + (e.target.checked ? 'enable' : 'disable') + ' guest access?')) {
                   e.target.checked = !e.target.checked;
                   return;
                 }
                 await updateConfig();
              };
            }
            if (toggleMaint) {
              toggleMaint.onchange = async (e) => {
                 if (!await customConfirm('Are you sure you want to toggle maintenance mode?')) {
                   e.target.checked = !e.target.checked;
                   return;
                 }
                 await updateConfig();
                 if (window.sessionRoom) {
                   try {
                     await window.sessionRoom.send({
                        type: 'broadcast',
                        event: e.target.checked ? 'maintenance_on' : 'maintenance_off',
                        payload: {}
                     });
                   } catch(err) { console.error(err); }
                 }
              };
            }
          } catch(e) { console.error("Admin setup error:", e); }
          
          loadTree();
        } else {
          // If token might be stale (401/403), try refreshing session once
          if (!verifyAdmin._retried && (res.status === 401 || res.status === 403)) {
            verifyAdmin._retried = true;
            try {
              const { data: refreshData } = await supabaseClient.auth.refreshSession();
              if (refreshData?.session) {
                return verifyAdmin(refreshData.session);
              }
            } catch(re) {}
          }
          verifyAdmin._retried = false;
          redirectToHome(data.error || "Forbidden. You are not an admin.");
        }
      } catch(e) {
        // On timeout or network error, retry once with refreshed token
        if (!verifyAdmin._retried) {
          verifyAdmin._retried = true;
          try {
            const { data: refreshData } = await supabaseClient.auth.refreshSession();
            if (refreshData?.session) {
              return verifyAdmin(refreshData.session);
            }
          } catch(re) {}
        }
        verifyAdmin._retried = false;
        redirectToHome(e.name === 'AbortError' ? "Verification timed out. Check your connection." : "Verification failed: " + e.message);
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
    window.loadTree = loadTree;
    async function loadTree() {
      statusText.textContent = 'Fetching repository...';
      fileBrowser.innerHTML = '';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'tree' }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (data.success && data.tree) {
          currentTree = data.tree.filter(i => i.path.startsWith('content/') || i.path.startsWith('cover/'));
          renderBrowser();
          statusText.textContent = 'Repository loaded.';
        } else {
          statusText.textContent = 'Failed to load tree: ' + data.error;
        }
      } catch(e) {
        clearTimeout(timeoutId);
        statusText.textContent = e.name === 'AbortError' ? 'Loading timed out (30s). Try refreshing.' : 'Error: ' + e.message;
      }
    }

    window.renderBrowser = renderBrowser;
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
        fileBrowser.innerHTML = '<div style="padding:24px; color:var(--text-muted); text-align:center;">Folder is empty</div>';
      }

      sortedItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-item';
        
        let icon = '';
        const isImg = item.name.match(/\.(jpg|jpeg|png|gif|webp)$/i);
        if (item.type === 'folder') {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
        } else if (isImg) {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
        } else {
          icon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
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
            ${item.type !== 'folder' ? `<button class="btn btn-actions" style="font-family:var(--font-mono); font-size:18px; min-width:36px; min-height:36px; display:inline-flex; align-items:center; justify-content:center; background:transparent; border:none; cursor:pointer; border-radius:4px;" data-json='${encodeURIComponent(JSON.stringify(item))}'>⋮</button>` : ''}
          </div>
        `;

        if (item.type === 'folder') {
          div.querySelector('.file-name').onclick = () => {
            currentPath = item.path;
            renderBrowser();
          };
        } else {
          div.querySelector('.file-name').onclick = () => {
             showPreview(item, isImg);
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

        const btnAct = div.querySelector('.btn-actions');
        if (btnAct) {
          btnAct.onclick = () => openContextModal(item);
        }

        fileBrowser.appendChild(div);
      });
    }

    function openContextModal(item) {
      const modal = document.getElementById('contextModal');
      const container = document.getElementById('contextActions');
      document.getElementById('contextTitle').textContent = item.name;
      
      let html = '';
      if (item.type !== 'folder') {
        if (item.name.endsWith('.html')) {
          html += `<button class="btn-unified" id="ctxEdit">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            <span>Edit Code</span>
          </button>`;
        }
        html += `<button class="btn-unified primary" id="ctxCreateTask">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>Create Task</span>
        </button>`;
        html += `<button class="btn-unified" id="ctxDownload">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Download</span>
        </button>`;
        html += `<button class="btn-unified" id="ctxMove">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line></svg>
          <span>Move</span>
        </button>`;
        html += `<button class="btn-unified" id="ctxRename">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
          <span>Rename</span>
        </button>`;
      }
      html += `<button class="btn-unified danger" id="ctxDelete">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        <span>Delete</span>
      </button>`;
      container.innerHTML = html;
      
      ModalManager.open(modal);
      
      const contextCancelBtn = document.getElementById('contextCancel');
      if (contextCancelBtn) {
        contextCancelBtn.onclick = () => ModalManager.close(modal);
      }
      
      if (document.getElementById('ctxEdit')) {
        document.getElementById('ctxEdit').onclick = async () => {
          ModalManager.close(modal);
          openEditor(item);
        };
      }
      if (document.getElementById('ctxDownload')) {
        document.getElementById('ctxDownload').onclick = async () => {
          ModalManager.close(modal);
          try {
            const blob = await fetchFileSecureBlob(item.path);
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = item.name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          } catch(e) {
            console.error(e);
            showToast('Download via API failed. Opening fallback...', 'error');
            window.open(`${GITHUB_RAW_BASE}/${item.path}`, '_blank');
          }
        };
      }
      if (document.getElementById('ctxMove')) {
        document.getElementById('ctxMove').onclick = async (e) => {
          ModalManager.close(modal);
          const newDir = await customPrompt("Enter new directory path (e.g. content/semester 1/):", currentPath);
          if (!newDir || newDir === currentPath) return;
          adminAction('rename_file', { path: item.path, newPath: newDir.replace(/\/$/, '') + '/' + item.name }).then(() => loadTree()).catch(e => showToast('Move failed: ' + e.message, 'error'));
        };
      }
      if (document.getElementById('ctxRename')) {
        document.getElementById('ctxRename').onclick = async () => {
          ModalManager.close(modal);
          const newName = await customPrompt("Enter new file name:", item.name);
          if (!newName || newName === item.name) return;
          adminAction('rename_file', { path: item.path, newPath: currentPath + newName }).then(() => loadTree()).catch(e => showToast('Rename failed: ' + e.message, 'error'));
        };
      }
      if (document.getElementById('ctxCreateTask')) {
        document.getElementById('ctxCreateTask').onclick = () => {
          ModalManager.close(modal);
          window._prefilledTaskPath = item.path;
          const tasksTab = document.querySelector('.tab[data-target="viewTasks"]');
          if (tasksTab) tasksTab.click();
          if (typeof createNewTaskPrompt === 'function') {
             createNewTaskPrompt();
          } else {
             const btnCreate = document.getElementById('btnCreateTask');
             if (btnCreate) btnCreate.click();
          }
        };
      }
      if (document.getElementById('ctxDelete')) {
        document.getElementById('ctxDelete').onclick = async () => {
          ModalManager.close(modal);
          if (item.type === 'folder') {
            const folderFiles = currentTree.filter(f => f.path.startsWith(item.path) && f.type === 'blob');
            if (folderFiles.length === 0) {
              customAlert('Folder is already empty.');
              return;
            }
            if (!await customConfirm(`Delete folder "${item.name}" and all ${folderFiles.length} files inside? This cannot be undone.`)) return;
            const files = folderFiles.map(f => ({ path: f.path }));
            statusText.textContent = `Deleting ${files.length} files...`;
            await adminAction('delete_files', { files });
            return;
          }
          if(await customConfirm('Delete ' + item.path + '?')) {
            adminAction('delete', { path: item.path, sha: item.sha }).then(() => loadTree()).catch(e => showToast('Delete failed: ' + e.message, 'error'));
          }
        };
      }
    }

    async function adminAction(action, payload) {
      statusText.textContent = `Processing ${action}...`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action, ...payload }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (data.success) {
          statusText.textContent = `Success: ${action}`;
          showToast(`Action successful: ${action.replace('_', ' ')}`, 'success');
          return data;
        } else {
          statusText.textContent = `Error: ${data.error}`;
          customAlert(`Error: ${data.error}`);
          return { success: false, error: data.error };
        }
      } catch(e) {
        clearTimeout(timeoutId);
        const errorMsg = e.name === 'AbortError' ? `Timeout: ${action} took too long (30s)` : 'Network error: ' + e.message;
        statusText.textContent = errorMsg;
        customAlert(errorMsg);
        return { success: false, error: errorMsg };
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
      }).catch(e => {
        showToast('Bulk delete failed: ' + e.message, 'error');
        document.getElementById('btnBulkDelete').textContent = 'Delete Selected';
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
      const lb = document.getElementById('lightboxModal');
      if (window.ModalManager) ModalManager.close(lb);
      else lb.classList.add('hidden');
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

    window.showPreview = showPreview;
    async function showPreview(item, isImg) {
      if (!isImg && (item.name.endsWith('.html') || item.name.endsWith('.css') || item.name.endsWith('.js'))) {
        openEditor(item);
        return;
      }
      
      const modal = document.getElementById('lightboxModal');
      const img = document.getElementById('lightboxImage');
      const txt = document.getElementById('lightboxText');
      
      img.classList.add('hidden');
      txt.classList.add('hidden');
      ModalManager.open(modal);

      const rawUrl = `${GITHUB_RAW_BASE}/${encodeURI(item.path)}`;

      // Update Header
      document.getElementById('lightboxFilename').textContent = item.name;
      
      document.getElementById('lightboxBtnNewTab').onclick = () => {
        window.open(rawUrl, '_blank');
      };
      document.getElementById('lightboxBtnDownload').onclick = async () => {
        try {
          const blob = await fetchFileSecureBlob(item.path);
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = item.name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        } catch(e) {
          console.error(e);
          showToast('Download via API failed. Opening fallback...', 'error');
          window.open(rawUrl, '_blank');
        }
      };

      if (isImg) {
        img.src = rawUrl;
        img.classList.remove('hidden');
      } else {
        txt.textContent = "Loading preview...";
        txt.classList.remove('hidden');
        try {
          const text = await fetchFileSecureText(item.path);
          txt.textContent = text;
        } catch(e) {
          const contentRepo = window.CONTENT_REPO_URL || 'https://github.com/alchemist4real/MR-CAPSULES-CONTENT';
          txt.textContent = "Failed to load content preview. You can open it in GitHub directly: " + `${contentRepo}/blob/main/${item.path}`;
        }
      }
    }
    
    let editorLiveUpdateTimeout = null;
    let isFullscreen = false;

    window.openEditor = openEditor;
    async function openEditor(item) {
      window.currentEditorItem = item;
      const rawUrl = `${GITHUB_RAW_BASE}/${encodeURI(item.path)}`;
      const emodal = document.getElementById('editorModal');
      const emodalContainer = document.getElementById('editorModalContainer');
      document.getElementById('editorTitle').textContent = `Editing: ${item.name}`;
      ModalManager.open(emodal);
      
      const iframe = document.getElementById('editorPreview');
      
      if (!window.cmEditor) {
        window.cmEditor = CodeMirror.fromTextArea(document.getElementById('codeEditor'), { 
          lineNumbers: true, 
          mode: "htmlmixed", 
          theme: "darcula",
          autoCloseBrackets: true,
          autoCloseTags: true,
          lineWrapping: true,
          extraKeys: {"Ctrl-F": "findPersistent"}
        });

        // Setup live preview debounce
        window.cmEditor.on("change", () => {
          clearTimeout(editorLiveUpdateTimeout);
          editorLiveUpdateTimeout = setTimeout(() => {
             if (window.currentEditorItem && window.currentEditorItem.name.endsWith('.html')) {
                iframe.srcdoc = window.cmEditor.getValue();
             }
          }, 800);
        });

        // Setup resizer
        const resizer = document.getElementById('editorResizer');
        const editorPane = document.getElementById('editorPane');
        const previewPane = document.getElementById('previewPane');
        const splitContainer = document.getElementById('editorSplitContainer');
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
          isResizing = true;
          resizer.classList.add('dragging');
          iframe.style.pointerEvents = 'none'; // Prevent iframe from swallowing mouse events
        });

        document.addEventListener('mousemove', (e) => {
          if (!isResizing) return;
          const containerRect = splitContainer.getBoundingClientRect();
          let newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
          if (newWidth < 10) newWidth = 10;
          if (newWidth > 90) newWidth = 90;
          editorPane.style.width = `${newWidth}%`;
          previewPane.style.width = `${100 - newWidth}%`;
        });

        document.addEventListener('mouseup', () => {
          if (isResizing) {
            isResizing = false;
            resizer.classList.remove('dragging');
            // Re-enable pointer events if it's not being dragged
            iframe.style.pointerEvents = 'auto';
            window.cmEditor.refresh();
          }
        });
      }
      
      try {
        const text = await fetchFileSecureText(item.path);
        window.cmEditor.setValue(text);
        if (item.name.endsWith('.html')) {
           iframe.srcdoc = text;
        } else {
           iframe.srcdoc = `<html><body style="font-family:'Courier New', Courier, monospace; padding:20px;">Preview not available for this file type.</body></html>`;
        }
      } catch(e) {
        window.cmEditor.setValue("Error loading file: " + e.message);
      }
      setTimeout(() => window.cmEditor.refresh(), 100);
      
      document.getElementById('editorFullscreen').onclick = () => {
         isFullscreen = !isFullscreen;
         if(isFullscreen) {
            emodalContainer.classList.add('fullscreen');
         } else {
            emodalContainer.classList.remove('fullscreen');
         }
         setTimeout(() => window.cmEditor.refresh(), 100);
      };

      document.getElementById('editorClose').onclick = () => ModalManager.close(emodal);
      document.getElementById('editorCancel').onclick = () => ModalManager.close(emodal);
      document.getElementById('editorSave').onclick = async (ev) => {
        ev.target.textContent = 'Saving...';
        const content = window.cmEditor.getValue();
        const base64 = utf8ToBase64(content);
        await adminAction('upload', { path: item.path, contentBase64: base64, sha: item.sha });
        ev.target.textContent = 'Save Changes';
        ModalManager.close(emodal);
        loadTree();
      };
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
        const targetId = targetTab.getAttribute('data-target');
        if (!targetId) return; // Allow default link behavior for tabs without data-target (e.g. docs link)
        document.querySelectorAll('.tab').forEach(tx => tx.classList.remove('active'));
        document.querySelectorAll('.view-section, .view-section-row').forEach(vx => vx.classList.remove('active'));
        targetTab.classList.add('active');
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.classList.add('active');
          if (targetId === 'viewApiKeys' && typeof window.loadApiKeys === 'function') {
            window.loadApiKeys();
          } else if (targetId === 'viewDashboard') {
            if (typeof window.fetchHybridLogs === 'function') window.fetchHybridLogs();
            if (typeof window.loadContributions === 'function') window.loadContributions();
          } else if (targetId === 'viewFiles') {
            if (typeof window.loadTree === 'function' && (!window.currentTree || window.currentTree.length === 0)) window.loadTree();
          } else if (targetId === 'viewUsers') {
            if (typeof window.loadDivisions === 'function' && !window.divisionData) window.loadDivisions();
            if (typeof window.loadUsers === 'function') window.loadUsers();
          } else if (targetId === 'viewTasks') {
            if (typeof window.loadTasks === 'function') window.loadTasks();
          }
        }
      };
    });

    // Users Logic
    window.loadUsers = loadUsers;
    async function loadUsers(divIdFilter = null) {
      const filterToUse = (divIdFilter && divIdFilter !== 'all') ? divIdFilter : (window.currentDivisionId && window.currentDivisionId !== 'all' ? window.currentDivisionId : null);
      const userBrowser = document.getElementById('userBrowser');
      userBrowser.innerHTML = '<div style="padding:48px; color:var(--text-muted); text-align:center; font-size:18px;">Loading users... <div style="display:inline-block; width:20px; height:20px; border:3px solid var(--border-light); border-radius:50%; border-top-color:var(--text-main); animation:spin 1s ease-in-out infinite; margin-left:10px; vertical-align:middle;"></div></div>';
        // Use cached banned devices to avoid redundant API calls on every loadUsers
        let bannedDevs = window._cachedBannedDevices || [];
        if (!window._cachedBannedDevices) {
          try {
             const cfgData = await adminAction('get_config');
             if (cfgData && cfgData.success && cfgData.config) {
               bannedDevs = cfgData.config.bannedDevices || [];
               window._cachedBannedDevices = bannedDevs;
             }
          } catch(e) { console.error("Error fetching config for banned devs:", e); }
        }

      const userController = new AbortController();
      const userTimeoutId = setTimeout(() => userController.abort(), 30000);
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
          body: JSON.stringify({ action: 'get_users' }),
          signal: userController.signal
        });
        clearTimeout(userTimeoutId);
        const data = await res.json();
        if (data.success) {
          window.allUsersCache = data.users;
          let displayUsers = data.users;
          if (filterToUse && window.divisionData) {
              const div = window.divisionData.find(d => d.id === filterToUse);
              if (div && div.members) {
                  const memberEmails = div.members.map(m => typeof m === 'string' ? m : m.email);
                  displayUsers = displayUsers.filter(u => memberEmails.includes(u.email));
              } else {
                  displayUsers = [];
              }
          }
          
          window.lastLoadedUsers = displayUsers;
          window.lastBannedDevs = bannedDevs;
          renderUsers(displayUsers, bannedDevs);
          
          const dashTotalUsers = document.getElementById('dashTotalUsers');
          if(dashTotalUsers) dashTotalUsers.textContent = data.users.length;
        } else {
          userBrowser.innerHTML = `<div style="padding:48px; color:var(--danger); text-align:center;">Failed to load users: ${data.error}</div>`;
        }
      } catch (e) {
        clearTimeout(userTimeoutId);
        userBrowser.innerHTML = `<div style="padding:48px; color:var(--danger); text-align:center;">Failed to load users: ${e.name === 'AbortError' ? 'Request timed out (30s)' : e.message}</div>`;
      }
    }

    function fmtTime(sec) {
      sec = parseInt(sec, 10) || 0;
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600).toString().padStart(2, '0');
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
      const s = (sec % 60).toString().padStart(2, '0');
      if (d > 0) return d + 'd ' + h + ':' + m + ':' + s;
      return h + ':' + m + ':' + s;
    }

    function renderDashboard(users, globalStats) {
      document.getElementById('dashTotalUsers').textContent = users.length;
      
      // Use globalStats from the backend API (bypasses RLS)
      var uptimeEl = document.getElementById('dashTotalUptime');
      if (globalStats && globalStats.total_uptime !== undefined) {
        window.lastKnownUptime = globalStats.total_uptime;
        window.lastFetchTime = Date.now();
        uptimeEl.textContent = fmtTime(globalStats.total_uptime);
      } else {
        uptimeEl.textContent = '00:00:00';
      }
      
      // Populate hybrid logs from user data (local only, no DB upserts)
      // Only do this once to avoid re-processing on every renderDashboard call
      if (!window._dashboardLogsPopulated) {
        window._dashboardLogsPopulated = true;
        users.forEach(function(u) {
          if (!u.last_sign_in_at) return;
          var meta = u.user_metadata || {};
          var devArr = Array.isArray(meta.devices) ? meta.devices : [];
          var devStr = devArr.length > 0 ? devArr.map(function(d){ return d.name || d.id.substr(0,10); }).join(', ') : (meta.deviceId || 'Unknown');
          
          var logEntry = {
             id: 'login_' + u.id + '_' + u.last_sign_in_at,
             type: 'login',
             time: new Date(u.last_sign_in_at).getTime(),
             user: (meta.username || 'Unknown'),
             email: u.email,
             devStr: devStr
          };
          // Push directly to the array WITHOUT calling addHybridLog (which does DB upsert)
          var exists = window.hybridLogs.find(function(l) { return l.id === logEntry.id; });
          if (!exists) window.hybridLogs.push(logEntry);
        });
        window.hybridLogs.sort(function(a, b) { return b.time - a.time; });
        if (window.hybridLogs.length > 200) window.hybridLogs = window.hybridLogs.slice(0, 200);
        window.renderHybridLogs();
      }
    }

    window.userViewMode = localStorage.getItem('mrc_user_view_mode') || 'grid';

    window.toggleUserViewMode = function() {
      window.userViewMode = window.userViewMode === 'grid' ? 'table' : 'grid';
      localStorage.setItem('mrc_user_view_mode', window.userViewMode);
      updateUserViewModeUI();
    };

    function updateUserViewModeUI() {
      const gridEl = document.getElementById('userBrowser');
      const tableEl = document.getElementById('userTableWrapper');
      const labelEl = document.getElementById('userViewModeLabel');
      const iconEl = document.getElementById('iconUserViewMode');

      if (!gridEl || !tableEl) return;

      if (window.userViewMode === 'table') {
        gridEl.classList.add('hidden');
        tableEl.classList.remove('hidden');
        if (labelEl) labelEl.textContent = 'Grid View';
        if (iconEl) {
          iconEl.innerHTML = '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>';
        }
      } else {
        gridEl.classList.remove('hidden');
        tableEl.classList.add('hidden');
        if (labelEl) labelEl.textContent = 'Table View';
        if (iconEl) {
          iconEl.innerHTML = '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>';
        }
      }
    }

    function bindUserActionEvents(cardOrRow, u, email, isBanned) {
      const btnMake = cardOrRow.querySelector('.btn-make-admin');
      if (btnMake) {
        btnMake.onclick = async () => {
          if (await customConfirm(`Make ${email} an Admin?`)) {
            await withButtonLoading(btnMake, async () => {
              await adminAction('add_admin', { targetUserId: u.id, identifier: email });
              loadUsers();
            }, 'Updating...');
          }
        };
      }

      const btnRevoke = cardOrRow.querySelector('.btn-revoke');
      if (btnRevoke) {
        btnRevoke.onclick = async () => {
          if (await customConfirm(`Remove admin privileges for ${email}?`)) {
            await withButtonLoading(btnRevoke, async () => {
              await adminAction('remove_admin', { identifier: email });
              loadUsers();
            }, 'Updating...');
          }
        };
      }

      const btnBan = cardOrRow.querySelector('.btn-ban');
      if (btnBan) {
        btnBan.onclick = async () => {
          const actionText = isBanned ? 'unban' : 'ban';
          if (await customConfirm(`Are you sure you want to ${actionText} ${email}?`)) {
            await withButtonLoading(btnBan, async () => {
              await adminAction('ban_user', { userId: u.id, banned: !isBanned });
              loadUsers();
            }, 'Updating...');
          }
        };
      }

      const btnReset = cardOrRow.querySelector('.btn-reset-pwd');
      if (btnReset) {
        btnReset.onclick = async () => {
          const newPassword = await customPrompt(`Enter new password for ${email}:`, 'MrCapsules2026!');
          if (newPassword && newPassword.trim() !== '') {
            if (newPassword.trim().length < 6) {
              customAlert('Password must be at least 6 characters long.');
              return;
            }
            await withButtonLoading(btnReset, async () => {
              const res = await adminAction('reset_user_password', { userId: u.id, newPassword: newPassword.trim() });
              if (res && res.success) {
                showToast('Password for ' + email + ' reset successfully!', 'success');
              }
            }, 'Resetting...');
          }
        };
      }

      const btnDel = cardOrRow.querySelector('.btn-del-user');
      if (btnDel) {
        btnDel.onclick = async () => {
          if (await customConfirm(`WARNING: This will permanently delete the user ${email} from the database. This action cannot be undone. Proceed?`)) {
            await withButtonLoading(btnDel, async () => {
              await adminAction('delete_user', { userId: u.id });
              loadUsers();
            }, 'Deleting...');
          }
        };
      }

      const btnRemoveDiv = cardOrRow.querySelector('.btn-remove-div');
      if (btnRemoveDiv) {
        btnRemoveDiv.onclick = async (e) => {
          const targetEmail = e.target.getAttribute('data-email');
          if (window.removeMember) {
            window.removeMember(targetEmail, window.currentDivisionId);
          }
        };
      }

      const devBtns = cardOrRow.querySelectorAll('.btn-block-dev');
      devBtns.forEach(btn => {
        btn.onclick = async (e) => {
          const devId = e.target.getAttribute('data-dev');
          const currentlyBanned = e.target.getAttribute('data-banned') === 'true';
          if (!devId) return;

          if (!await customConfirm(`Are you sure you want to ${currentlyBanned ? 'unban' : 'block'} this device?`)) return;

          await withButtonLoading(btn, async () => {
            try {
              const cfgData = await adminAction('get_config');
              if (!cfgData || !cfgData.success) throw new Error(cfgData?.error || "Failed to get config from backend");
              const configObj = cfgData.config || {};
              let arr = configObj.bannedDevices || [];

              if (currentlyBanned) {
                arr = arr.filter(id => id !== devId);
              } else {
                if (!arr.includes(devId)) arr.push(devId);
              }

              await adminAction('update_config', { bannedDevices: arr });
              window._cachedBannedDevices = arr;

              if (window.sessionRoom) {
                try {
                  if (!currentlyBanned) {
                    await window.sessionRoom.send({ type: 'broadcast', event: 'ban_device', payload: { deviceId: devId } });
                  } else {
                    await window.sessionRoom.send({ type: 'broadcast', event: 'unban_device', payload: { deviceId: devId } });
                  }
                } catch (realtimeErr) { console.warn('Realtime notify failed:', realtimeErr); }
              }
              loadUsers();
            } catch (err) {
              customAlert('Error updating config: ' + err.message);
            }
          }, 'Updating...');
        };
      });

      const deleteDevBtns = cardOrRow.querySelectorAll('.btn-delete-dev');
      deleteDevBtns.forEach(btn => {
        btn.onclick = async (e) => {
          const devId = e.target.getAttribute('data-dev');
          const targetUserId = e.target.getAttribute('data-userid');
          const targetEmail = e.target.getAttribute('data-email');
          if (!devId || !targetUserId) return;

          if (!await customConfirm(`Delete device "${devId.substr(0,14)}..." from user ${targetEmail}?`)) return;

          await withButtonLoading(btn, async () => {
            try {
              const res = await adminAction('remove_user_device', { userId: targetUserId, deviceId: devId });
              if (res && res.success) {
                showToast(`Device deleted successfully from ${targetEmail}`, 'success');
                loadUsers();
              } else {
                throw new Error(res ? res.error : 'Failed to delete device');
              }
            } catch (err) {
              customAlert('Error deleting device: ' + err.message);
            }
          }, 'Deleting...');
        };
      });
    }

    function renderUsers(users, bannedDevs) {
      bannedDevs = bannedDevs || [];
      const userBrowser = document.getElementById('userBrowser');
      const userTableBody = document.getElementById('userTableBody');
      const summaryEl = document.getElementById('userCountSummary');
      const itemCountEl = document.getElementById('itemCount');

      if (userBrowser) userBrowser.innerHTML = '';
      if (userTableBody) userTableBody.innerHTML = '';

      let adminCount = 0;
      let bannedCount = 0;
      let guestCount = 0;

      users.forEach(u => {
        const meta = u.user_metadata || {};
        const appMeta = u.app_metadata || {};
        if (u.role === 'admin') adminCount++;
        if (appMeta.banned === true || meta.banned === true) bannedCount++;
        if (meta.is_guest === true || (!u.email && meta.username?.startsWith('guest_'))) guestCount++;
      });

      const statsText = `Total: ${users.length} • Admins: ${adminCount} • Banned: ${bannedCount}`;
      if (summaryEl) summaryEl.textContent = statsText;
      if (itemCountEl) itemCountEl.textContent = `${users.length} users`;

      if (users.length === 0) {
        const emptyHtml = '<div style="grid-column: 1 / -1; padding: 48px 24px; color: var(--text-muted); text-align: center; font-family: var(--font-primary); font-size: 15px;">NO MEMBERS FOUND IN THIS VIEW</div>';
        if (userBrowser) userBrowser.innerHTML = emptyHtml;
        if (userTableBody) userTableBody.innerHTML = `<tr><td colspan="7" style="padding: 36px; text-align: center; color: var(--text-muted); font-family: var(--font-primary);">NO MEMBERS FOUND</td></tr>`;
        return;
      }

      users.forEach(u => {
        const email = u.email || '';
        const meta = u.user_metadata || {};
        const appMeta = u.app_metadata || {};
        const username = meta.username || email.split('@')[0] || 'Anonymous';
        const isBanned = appMeta.banned === true || meta.banned === true;
        const isAdmin = u.role === 'admin';
        const division = meta.division || '';
        const isGuest = meta.is_guest === true || username.startsWith('guest_');

        const devices = Array.isArray(meta.devices) ? meta.devices.slice() : [];
        if (typeof meta.deviceId === 'string' && !devices.some(d => d.id === meta.deviceId)) {
          devices.push({ id: meta.deviceId, added: u.created_at });
        }

        let initials = (username.length >= 2 ? username.substring(0, 2) : username).toUpperCase();
        if (!initials.trim()) initials = 'U';

        let badgesHtml = '';
        if (isAdmin) badgesHtml += '<span class="badge badge-admin">ADMIN</span>';
        else badgesHtml += '<span class="badge badge-member">MEMBER</span>';
        if (division) badgesHtml += `<span class="badge badge-division">${sanitize(division.toUpperCase())}</span>`;
        if (isBanned) badgesHtml += '<span class="badge badge-banned">BANNED</span>';
        if (isGuest) badgesHtml += '<span class="badge badge-guest">GUEST</span>';

        let deviceRowsHtml = '';
        if (devices.length > 0) {
          // Sort devices: most recently seen first
          devices.sort((a, b) => {
            const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0;
            const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
            return tb - ta;
          });
          devices.forEach(dev => {
            const isDevBanned = bannedDevs.includes(dev.id);
            const devName = dev.name || 'Unknown';
            // Calculate relative last-seen time
            let lastSeenStr = '';
            let isStale = false;
            if (dev.last_seen) {
              const diff = Date.now() - new Date(dev.last_seen).getTime();
              const mins = Math.floor(diff / 60000);
              const hrs = Math.floor(diff / 3600000);
              const days = Math.floor(diff / 86400000);
              if (mins < 2) lastSeenStr = 'just now';
              else if (mins < 60) lastSeenStr = mins + 'm ago';
              else if (hrs < 24) lastSeenStr = hrs + 'h ago';
              else lastSeenStr = days + 'd ago';
              isStale = days > 30;
            } else {
              lastSeenStr = 'never';
              isStale = true;
            }
            const staleStyle = isStale ? 'opacity:0.45; text-decoration:line-through;' : '';
            deviceRowsHtml += `
              <div class="user-device-item" style="${staleStyle}">
                <div style="display:flex; flex-direction:column; gap:2px; min-width:0; flex:1;">
                  <span class="user-device-id" title="${sanitize(dev.id)}" style="font-weight:500;">${sanitize(devName)}</span>
                  <span style="font-size:11px; color:var(--text-muted);">${sanitize(dev.id.substring(0, 12))}… · ${lastSeenStr}</span>
                </div>
                <div class="user-device-actions">
                  <button class="btn-dev-action ${isDevBanned ? '' : 'danger'} btn-block-dev" data-dev="${sanitize(dev.id)}" data-banned="${isDevBanned}">
                    ${isDevBanned ? 'Unban' : 'Block'}
                  </button>
                  <button class="btn-dev-action danger btn-delete-dev" data-dev="${sanitize(dev.id)}" data-userid="${sanitize(u.id)}" data-email="${sanitize(email)}" title="Remove Device">
                    Delete
                  </button>
                </div>
              </div>
            `;
          });
        }

        let actionsHtml = '';
        if (window.isSuperAdmin) {
          if (window.currentDivisionId && window.currentDivisionId !== 'all') {
            actionsHtml += `<button class="btn-card danger btn-remove-div" data-email="${sanitize(email)}">Remove Div</button>`;
          }
          if (isAdmin) {
            actionsHtml += `<button class="btn-card btn-revoke" data-target="${sanitize(email)}">Revoke Admin</button>`;
          } else {
            actionsHtml += `<button class="btn-card primary btn-make-admin" data-target="${sanitize(email)}">Make Admin</button>`;
          }
          actionsHtml += `<button class="btn-card ${isBanned ? 'primary' : 'danger'} btn-ban" data-id="${sanitize(u.id)}" data-banned="${isBanned}">${isBanned ? 'Unban' : 'Ban'}</button>`;
          actionsHtml += `<button class="btn-card primary btn-reset-pwd" data-id="${sanitize(u.id)}">Reset Pwd</button>`;
          actionsHtml += `<button class="btn-card danger btn-del-user" data-id="${sanitize(u.id)}">Delete</button>`;
        }

        // Render Card for Grid View
        if (userBrowser) {
          const card = document.createElement('div');
          card.className = 'user-card';
          card.setAttribute('data-banned', isBanned ? 'true' : 'false');
          card.setAttribute('data-admin', isAdmin ? 'true' : 'false');
          card.setAttribute('data-online', 'false');
          card.setAttribute('data-guest', isGuest ? 'true' : 'false');

          const joinedDate = u.created_at ? new Date(u.created_at).toLocaleDateString() : '-';

          card.innerHTML = `
            <div class="user-card-header">
              <div class="user-avatar-badge">${sanitize(initials)}</div>
              <div class="user-card-main-info">
                <div class="user-card-top-line">
                  <div class="user-username">${sanitize(username)}</div>
                </div>
                <div class="user-email-text" title="${sanitize(email)}">${sanitize(email || 'No email registered')}</div>
                <div class="user-badges-wrap">${badgesHtml}</div>
              </div>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); font-family:var(--font-secondary); padding: 2px 0;">
              <span>Joined: ${joinedDate}</span>
              <span>${devices.length} Device${devices.length === 1 ? '' : 's'}</span>
            </div>
            ${devices.length > 0 ? `
              <div class="user-device-drawer">
                <div class="user-device-drawer-header btn-toggle-dev-list" onclick="const dl = this.nextElementSibling; dl.style.display = (dl.style.display === 'none' || !dl.style.display) ? 'flex' : 'none';">
                  <span class="device-count-badge">Devices Registered (${devices.length})</span>
                  <span>Toggle List &darr;</span>
                </div>
                <div class="user-device-list" style="display:none;">
                  ${deviceRowsHtml}
                </div>
              </div>
            ` : ''}
            <div class="card-actions">${actionsHtml}</div>
          `;

          bindUserActionEvents(card, u, email, isBanned);
          userBrowser.appendChild(card);
        }

        // Render Row for Table View
        if (userTableBody) {
          const tr = document.createElement('tr');
          tr.className = 'user-table-row';
          tr.setAttribute('data-banned', isBanned ? 'true' : 'false');
          tr.setAttribute('data-admin', isAdmin ? 'true' : 'false');
          tr.setAttribute('data-online', 'false');
          tr.setAttribute('data-guest', isGuest ? 'true' : 'false');

          const joinedDate = u.created_at ? new Date(u.created_at).toLocaleDateString() : '-';

          tr.innerHTML = `
            <td>
              <div style="display:flex; align-items:center; gap:8px;">
                <div class="user-avatar-badge" style="width:28px; height:28px; min-width:28px; font-size:11px;">${sanitize(initials)}</div>
                <span style="font-weight:700; color:var(--c3); font-family:var(--font-primary);">${sanitize(username)}</span>
              </div>
            </td>
            <td><span class="user-email-text" style="font-size:13px;">${sanitize(email || '-')}</span></td>
            <td><span class="badge badge-division">${sanitize(division ? division.toUpperCase() : 'NONE')}</span></td>
            <td>${isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge badge-member">MEMBER</span>'}</td>
            <td><span style="font-family:var(--font-secondary); font-size:12.5px;">${devices.length} Dev</span></td>
            <td><span style="font-family:var(--font-secondary); font-size:12px; color:var(--text-muted);">${joinedDate}</span></td>
            <td><div class="user-table-actions">${actionsHtml}</div></td>
          `;

          bindUserActionEvents(tr, u, email, isBanned);
          userTableBody.appendChild(tr);
        }
      });

      updateUserViewModeUI();
      if (window.applyUserFilters) window.applyUserFilters();
    }

    const btnRefreshDash = document.getElementById('btnRefreshDashboard');
    if (btnRefreshDash) {
      btnRefreshDash.onclick = async () => {
        await withButtonLoading(btnRefreshDash, async () => {
          if (window.fetchHybridLogs) await window.fetchHybridLogs();
          if (window.loadContributions) await window.loadContributions();
          if (window.loadUsers) await window.loadUsers();
          showToast('Dashboard analytics refreshed', 'success');
        }, 'Refreshing...');
      };
    }

    const btnGuestCleanup = document.getElementById('btnGuestCleanup');
    if (btnGuestCleanup) {
      btnGuestCleanup.onclick = async () => {
        const resultEl = document.getElementById('guestCleanupResult');
        const hoursInput = document.getElementById('guestCleanupHours');
        let maxAgeHours = parseInt(hoursInput && hoursInput.value, 10);
        if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) maxAgeHours = 24;
        resultEl.textContent = `Processing... (guests older than ${maxAgeHours}h)`;
        resultEl.style.color = 'var(--text-muted)';
        await withButtonLoading(btnGuestCleanup, async () => {
          try {
            const data = await adminAction('cleanup_guests', { max_age_hours: maxAgeHours });
            if (data && data.success !== false) {
              resultEl.style.color = 'var(--text-main)';
              resultEl.textContent = `[SUCCESS] Deleted ${data.deleted || 0}/${data.total_guests_found || 0} guests (> ${data.max_age_hours || maxAgeHours}h old)` +
                ((data.failed || 0) > 0 ? ` — ${data.failed} failed` : '');
              showToast(`Cleaned ${data.deleted || 0} stale guests`, 'success');
              if (window.loadUsers) window.loadUsers();
              if ((data.failed || 0) > 0 && Array.isArray(data.errors) && data.errors.length > 0) {
                console.warn('cleanup_guests errors:', data.errors);
                const first = data.errors[0];
                showToast(`Some guests failed: ${(first.error || first.table || 'unknown error').slice(0, 120)}`, 'error');
              }
            } else {
              resultEl.style.color = 'var(--danger)';
              resultEl.textContent = `[ERROR] ${data?.error || 'Failed to cleanup guests'}`;
            }
          } catch(e) {
            resultEl.style.color = 'var(--danger)';
            resultEl.textContent = `[ERROR] ${e.message}`;
            showToast(e.message, 'error');
          }
        }, 'Cleaning...');
      };
    }

    window.currentFilter = 'all';
    window.applyUserFilters = function() {
        const searchInput = document.getElementById('searchUsersInput');
        const val = searchInput ? searchInput.value.toLowerCase().trim() : '';
        const cards = document.querySelectorAll('#userBrowser .user-card');
        const rows = document.querySelectorAll('#userTableBody .user-table-row');
        
        let visibleCount = 0;

        function checkMatch(el) {
            let show = true;
            if (window.currentFilter === 'banned') show = el.getAttribute('data-banned') === 'true';
            else if (window.currentFilter === 'admin') show = el.getAttribute('data-admin') === 'true';
            else if (window.currentFilter === 'online') show = el.getAttribute('data-online') === 'true';
            else if (window.currentFilter === 'guest') show = el.getAttribute('data-guest') === 'true';

            if (show && val) {
                const text = (el.textContent || '').toLowerCase();
                if (!text.includes(val)) {
                    show = false;
                }
            }
            return show;
        }

        cards.forEach(card => {
            const show = checkMatch(card);
            card.style.display = show ? '' : 'none';
            if (show) visibleCount++;
        });

        rows.forEach(row => {
            const show = checkMatch(row);
            row.style.display = show ? '' : 'none';
        });

        const counterEl = document.getElementById('userCountSummary');
        if (counterEl) {
            const total = (window.lastLoadedUsers || []).length;
            counterEl.textContent = `Showing ${visibleCount}/${total} Members`;
        }
    };

    const searchUsersInputEl = document.getElementById('searchUsersInput');
    if (searchUsersInputEl) {
      searchUsersInputEl.addEventListener('input', () => {
        if (window.applyUserFilters) window.applyUserFilters();
      });
    }

    // User Filter Buttons & Mobile Filter Dropdown wiring
    document.querySelectorAll('.user-filter').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.user-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        window.currentFilter = btn.getAttribute('data-filter') || 'all';
        const mobileSelect = document.getElementById('mobileUserFilterSelect');
        if (mobileSelect) mobileSelect.value = window.currentFilter;
        if (window.applyUserFilters) window.applyUserFilters();
      };
    });

    const mobileFilterSelect = document.getElementById('mobileUserFilterSelect');
    if (mobileFilterSelect) {
      mobileFilterSelect.onchange = (e) => {
        window.currentFilter = e.target.value || 'all';
        document.querySelectorAll('.user-filter').forEach(b => {
          if (b.getAttribute('data-filter') === window.currentFilter) b.classList.add('active');
          else b.classList.remove('active');
        });
        if (window.applyUserFilters) window.applyUserFilters();
      };
    }

    // User polling removed in favor of Supabase realtime channel (users_changed)

    window.lastKnownUptime = window.lastKnownUptime || 0;
    window.lastFetchTime = window.lastFetchTime || Date.now();

    if (window._uptimeDisplayTimer) clearInterval(window._uptimeDisplayTimer);
    if (window._uptimeFetchTimer) clearInterval(window._uptimeFetchTimer);

    // Smooth counter - update display every second
    window._uptimeDisplayTimer = setInterval(() => {
      const el = document.getElementById('dashTotalUptime');
      if (!el || !window.lastKnownUptime) return;
      const elapsed = Math.floor((Date.now() - window.lastFetchTime) / 1000);
      el.textContent = fmtTime(window.lastKnownUptime + elapsed);
    }, 1000);

    // Fetch real value every 30 seconds
    window._uptimeFetchTimer = setInterval(async function() {
      try {
        var res = await fetch('/api/uptime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionToken },
          body: JSON.stringify({ action: 'get' })
        });
        var data = await res.json();
        if (data.success && data.total_uptime !== undefined) {
          window.lastKnownUptime = data.total_uptime;
          window.lastFetchTime = Date.now();
        }
      } catch(e) { console.error("Error fetching uptime logs:", e); }
    }, 30000);

    /* ══ PERSONA ENGINE (Synced from Main Site) ══ */
    function applyAdminPersona(p) {
      const isMrs = (p === 'mrs');
      const mrText = isMrs ? 'Mrs. Capsules' : 'Mr. Capsules';
      document.title = isMrs ? 'Mrs. Capsules · Admin' : 'Mr. Capsules · Admin';
      document.querySelectorAll('.dock-brand b, .nav-brand span, .brand span, .sc-brand span').forEach(el => {
        el.textContent = mrText;
      });
      document.querySelectorAll('.credit-footer').forEach(el => {
        if (isMrs) {
          el.innerHTML = el.innerHTML.replace(/\bMr\.\s*Capsules\b/g, 'Mrs. Capsules');
        } else {
          el.innerHTML = el.innerHTML.replace(/\bMrs\.\s*Capsules\b/g, 'Mr. Capsules');
        }
      });
      document.body.classList.toggle('persona-mrs', isMrs);
      document.body.classList.toggle('persona-mr', !isMrs);
    }

    const savedAdminPersona = localStorage.getItem('mr_persona') || 'mr';
    applyAdminPersona(savedAdminPersona);

    window.addEventListener('storage', (e) => {
      if (e.key === 'mr_persona') {
        applyAdminPersona(e.newValue || 'mr');
      }
    });

    // ============================================================================
    // UNIFIED TOAST MANAGER
    // Enforces max 5 toast stack, textContent injection for XSS protection, 
    // auto-dismiss, progress bar controls, and zero-emoji SVG icons.
    // ============================================================================
    const ToastManager = (function () {
      const MAX_STACK = 5;
      const DEFAULT_DURATION = 3000;
      const activeToasts = [];

      function getContainer() {
        let container = document.getElementById('toastContainer');
        if (!container) {
          container = document.createElement('div');
          container.id = 'toastContainer';
          container.className = 'toast-container';
          document.body.appendChild(container);
        }
        return container;
      }

      function createIconSvg(type) {
        const svgMap = {
          success: '<polyline points="20 6 9 17 4 12"></polyline>',
          error: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
          warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
          info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>'
        };
        const pathContent = svgMap[type] || svgMap.info;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', `toast-icon toast-icon-${type}`);
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.innerHTML = pathContent;
        return svg;
      }

      function removeToast(toastObj) {
        const idx = activeToasts.indexOf(toastObj);
        if (idx === -1) return;
        
        activeToasts.splice(idx, 1);
        clearTimeout(toastObj.timeoutId);

        const el = toastObj.element;
        el.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 300);
      }

      function show(msg, type = 'info', duration = DEFAULT_DURATION) {
        const container = getContainer();

        while (activeToasts.length >= MAX_STACK) {
          removeToast(activeToasts[0]);
        }

        const toast = document.createElement('div');
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.className = `toast toast-${type}`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'toast-content';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon-container';
        iconSpan.appendChild(createIconSvg(type));

        const msgSpan = document.createElement('span');
        msgSpan.className = 'toast-message';
        msgSpan.textContent = String(msg);

        contentDiv.appendChild(iconSpan);
        contentDiv.appendChild(msgSpan);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Close toast');
        closeBtn.innerHTML = '&times;';

        const progressBar = document.createElement('div');
        progressBar.className = 'toast-progress';
        progressBar.style.animationDuration = `${duration}ms`;

        toast.appendChild(contentDiv);
        toast.appendChild(closeBtn);
        toast.appendChild(progressBar);
        container.appendChild(toast);

        const toastObj = {
          element: toast,
          timeoutId: null,
          remaining: duration,
          startTime: Date.now()
        };

        function dismiss() {
          removeToast(toastObj);
        }

        function startTimer() {
          toastObj.startTime = Date.now();
          toastObj.timeoutId = setTimeout(dismiss, toastObj.remaining);
        }

        function pauseTimer() {
          clearTimeout(toastObj.timeoutId);
          toastObj.remaining -= Date.now() - toastObj.startTime;
          if (toastObj.remaining < 0) toastObj.remaining = 0;
        }

        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          dismiss();
        });

        toast.addEventListener('mouseenter', () => {
          pauseTimer();
          progressBar.style.animationPlayState = 'paused';
        });

        toast.addEventListener('mouseleave', () => {
          startTimer();
          progressBar.style.animationPlayState = 'running';
        });

        activeToasts.push(toastObj);
        startTimer();
      }

      return { show, removeToast };
    })();

    window.showToast = function (msg, type = 'info') {
      ToastManager.show(msg, type);
    };

    function setButtonLoading(btn, isLoading, loadingText = 'Processing...') {
      const el = typeof btn === 'string' ? document.querySelector(btn) : btn;
      if (!el) return;
      if (isLoading) {
        if (el.dataset.isLoading === 'true') return;
        el.dataset.isLoading = 'true';
        el.dataset.originalHtml = el.innerHTML;
        el.dataset.originalDisabled = el.disabled ? 'true' : 'false';
        el.disabled = true;
        el.classList.add('btn-loading');
        el.innerHTML = `<svg class="btn-spinner" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" style="animation:spin 0.8s linear infinite; margin-right:6px; vertical-align:middle;"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg><span>${loadingText}</span>`;
      } else {
        if (el.dataset.isLoading !== 'true') return;
        el.disabled = el.dataset.originalDisabled === 'true';
        el.innerHTML = el.dataset.originalHtml || el.innerHTML;
        el.classList.remove('btn-loading');
        delete el.dataset.isLoading;
        delete el.dataset.originalHtml;
        delete el.dataset.originalDisabled;
      }
    }

    async function withButtonLoading(btn, asyncFn, loadingText = 'Processing...') {
      setButtonLoading(btn, true, loadingText);
      try {
        return await asyncFn();
      } finally {
        setButtonLoading(btn, false);
      }
    }

    window.setButtonLoading = setButtonLoading;
    window.withButtonLoading = withButtonLoading;
    document.addEventListener('DOMContentLoaded', () => {
        const searchInput = document.getElementById('searchUsersInput');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                if(window.applyUserFilters) window.applyUserFilters();
            });
        }
    });

// ═══════════════════════════════════════════════════════════════
// API KEYS MODULE — appended to admin.js
// Uses: window.sessionToken (set by verifyAdmin at line 250)
//       showToast() (defined at line ~1551)
//       customConfirm() (defined at line ~193)
//       sanitize() (defined at line ~42)
// All functions are scoped in an IIFE to avoid global leaks.
// ═══════════════════════════════════════════════════════════════

(function initApiKeysModule() {
  window._lastCreatedKey = '';

  function bindKeyEvents() {
    var btnRefresh = document.getElementById('btnRefreshApiKeys');
    if (btnRefresh) btnRefresh.onclick = loadApiKeys;

    var btnGenerate = document.getElementById('btnGenerateApiKey');
    if (btnGenerate) btnGenerate.onclick = generateApiKey;

    var newKeyNameInput = document.getElementById('newKeyName');
    if (newKeyNameInput) {
      newKeyNameInput.onkeydown = function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          generateApiKey();
        }
      };
    }

    // Modal Copy & Close events
    var btnCopyCreatedKey = document.getElementById('btnCopyCreatedKey');
    if (btnCopyCreatedKey) btnCopyCreatedKey.onclick = copyCreatedKey;

    var btnCloseModalDone = document.getElementById('btnCloseApiKeyModalDone');
    if (btnCloseModalDone) {
      btnCloseModalDone.onclick = function() {
        var modal = document.getElementById('apiKeyCreatedModal');
        if (window.ModalManager) ModalManager.close(modal);
        else if (modal) modal.classList.remove('active');
        loadApiKeys();
      };
    }

    var btnModalCopyAntigravityConfig = document.getElementById('btnModalCopyAntigravityConfig');
    if (btnModalCopyAntigravityConfig) {
      btnModalCopyAntigravityConfig.onclick = async function() {
        var k = window._lastCreatedKey || (document.getElementById('createdApiKeyInput')?.value) || 'mrc_your_api_key_here';
        var configObj = {
          mcpServers: {
            "mr-capsules": {
              url: window.location.origin + "/api/mcp",
              headers: {
                "x-api-key": k
              }
            }
          }
        };
        var ok = await safeCopyToClipboard(JSON.stringify(configObj, null, 2));
        var orig = btnModalCopyAntigravityConfig.innerText;
        btnModalCopyAntigravityConfig.innerText = ok ? '✓ Config Tersalin!' : 'Gagal Salin';
        setTimeout(function() { btnModalCopyAntigravityConfig.innerText = orig; }, 1800);
      };
    }

    var btnModalCopyClaudeConfig = document.getElementById('btnModalCopyClaudeConfig');
    if (btnModalCopyClaudeConfig) {
      btnModalCopyClaudeConfig.onclick = async function() {
        var k = window._lastCreatedKey || (document.getElementById('createdApiKeyInput')?.value) || 'mrc_your_api_key_here';
        var claudeConfig = {
          mcpServers: {
            "mr-capsules": {
              command: "npx",
              args: ["-y", "mcp-remote", window.location.origin + "/api/mcp", "--header", "x-api-key: " + k]
            }
          }
        };
        var ok = await safeCopyToClipboard(JSON.stringify(claudeConfig, null, 2));
        var orig = btnModalCopyClaudeConfig.innerText;
        btnModalCopyClaudeConfig.innerText = ok ? '✓ Config Claude Tersalin!' : 'Gagal Salin';
        setTimeout(function() { btnModalCopyClaudeConfig.innerText = orig; }, 1800);
      };
    }

    var btnModalCopyBearerHeader = document.getElementById('btnModalCopyBearerHeader');
    if (btnModalCopyBearerHeader) {
      btnModalCopyBearerHeader.onclick = async function() {
        var k = window._lastCreatedKey || (document.getElementById('createdApiKeyInput')?.value) || 'mrc_your_api_key_here';
        var headerStr = 'Authorization: Bearer ' + k;
        var ok = await safeCopyToClipboard(headerStr);
        var orig = btnModalCopyBearerHeader.innerText;
        btnModalCopyBearerHeader.innerText = ok ? '✓ Header Tersalin!' : 'Gagal Salin';
        setTimeout(function() { btnModalCopyBearerHeader.innerText = orig; }, 1800);
      };
    }

    // Connector Section Copy Handlers
    var btnCopyAntigravityConfig = document.getElementById('btnCopyAntigravityConfig');
    if (btnCopyAntigravityConfig) {
      btnCopyAntigravityConfig.onclick = async function() {
        var apiKeyVal = window._lastCreatedKey || 'mrc_your_api_key_here';
        var configObj = {
          mcpServers: {
            "mr-capsules": {
              url: window.location.origin + "/api/mcp",
              headers: {
                "x-api-key": apiKeyVal
              }
            }
          }
        };
        var ok = await safeCopyToClipboard(JSON.stringify(configObj, null, 2));
        var orig = btnCopyAntigravityConfig.innerText;
        btnCopyAntigravityConfig.innerText = ok ? '✓ Config Copied!' : 'Copy Failed';
        setTimeout(function() { btnCopyAntigravityConfig.innerText = orig; }, 1500);
      };
    }

    var btnCopyAntigravityEndpoint = document.getElementById('btnCopyAntigravityEndpoint');
    if (btnCopyAntigravityEndpoint) {
      btnCopyAntigravityEndpoint.onclick = async function() {
        var ep = window.location.origin + '/api/mcp';
        var ok = await safeCopyToClipboard(ep);
        var orig = btnCopyAntigravityEndpoint.innerText;
        btnCopyAntigravityEndpoint.innerText = ok ? '✓ Copied Endpoint!' : 'Copy Failed';
        setTimeout(function() { btnCopyAntigravityEndpoint.innerText = orig; }, 1500);
      };
    }

    var btnCopyClaudeEndpoint = document.getElementById('btnCopyClaudeEndpoint');
    if (btnCopyClaudeEndpoint) {
      btnCopyClaudeEndpoint.onclick = async function() {
        var ep = window.location.origin + '/api/mcp';
        var ok = await safeCopyToClipboard(ep);
        var orig = btnCopyClaudeEndpoint.innerText;
        btnCopyClaudeEndpoint.innerText = ok ? '✓ URL Endpoint Tersalin!' : 'Gagal Salin';
        setTimeout(function() { btnCopyClaudeEndpoint.innerText = orig; }, 1500);
      };
    }

    var btnCopyOpenApiUrl = document.getElementById('btnCopyOpenApiUrl');
    if (btnCopyOpenApiUrl) {
      btnCopyOpenApiUrl.onclick = async function() {
        var preset = (document.getElementById('chatGptPresetSelect')?.value) || 'essential';
        var url = window.location.origin + '/api/openapi.json?category=' + encodeURIComponent(preset);
        var ok = await safeCopyToClipboard(url);
        var orig = btnCopyOpenApiUrl.innerText;
        btnCopyOpenApiUrl.innerText = ok ? 'Copied!' : 'Copy Failed';
        setTimeout(function() { btnCopyOpenApiUrl.innerText = orig; }, 1500);
      };
    }

    var btnCopyOpenApiJson = document.getElementById('btnCopyOpenApiJson');
    if (btnCopyOpenApiJson) {
      btnCopyOpenApiJson.onclick = async function() {
        var preset = (document.getElementById('chatGptPresetSelect')?.value) || 'essential';
        var url = '/api/openapi.json?category=' + encodeURIComponent(preset);
        btnCopyOpenApiJson.innerText = 'Fetching...';
        try {
          var res = await fetch(url);
          var json = await res.json();
          var ok = await safeCopyToClipboard(JSON.stringify(json, null, 2));
          btnCopyOpenApiJson.innerText = ok ? 'JSON Copied!' : 'Copy Failed';
          setTimeout(function() { btnCopyOpenApiJson.innerText = 'Copy JSON'; }, 1500);
        } catch(e) {
          btnCopyOpenApiJson.innerText = 'Error!';
          setTimeout(function() { btnCopyOpenApiJson.innerText = 'Copy JSON'; }, 1500);
        }
      };
    }

    var btnCopyGptPrompt = document.getElementById('btnCopyGptPrompt');
    if (btnCopyGptPrompt) {
      btnCopyGptPrompt.onclick = async function() {
        var prompt = 'Anda adalah Medical AI Assistant MR-CAPSULES & DoctorTablet. Anda terhubung ke database modul kedokteran dan catatan klinis via Actions.\n\nAturan Wajib Pembuatan Catatan Medis (doctortablet_save_note):\n1. Analisis & petakan struktur hirarki topik terlebih dahulu.\n2. Tulis materi dengan high-density reasoning, studi kasus, & jebakan ujian (BUKAN transkrip slide PPT mentah).\n3. WAJIB sertakan Callouts GitHub ([!NOTE], [!TIP], [!WARNING]), Tabel komparasi, Diagram Mermaid, dan Rumus Matematika/Skor Medis dalam format LaTeX ($...$ / $$...$$).\n4. Parameter author WAJIB nama lengkap pengguna tanpa gelar akademis (misal: "Ahmad Muqorrobin", jangan sertakan "dr." atau "S.Ked").';
        var ok = await safeCopyToClipboard(prompt);
        var orig = btnCopyGptPrompt.innerText;
        btnCopyGptPrompt.innerText = ok ? '✓ Prompt Copied to Clipboard!' : 'Copy Failed';
        setTimeout(function() { btnCopyGptPrompt.innerText = orig; }, 2000);
      };
    }

    var tab = document.getElementById('tabApiKeys');
    if (tab) {
      tab.addEventListener('click', function() {
        setTimeout(loadApiKeys, 50);
      });
    }
  }

  // Bind events immediately if DOM is ready, and also listen for adminReady
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindKeyEvents);
  } else {
    bindKeyEvents();
  }
  window.addEventListener('adminReady', function() {
    bindKeyEvents();
    loadApiKeys();
  });

  window.loadApiKeys = loadApiKeys;

  // POST to /api/mcp using existing session JWT with localStorage fallback
  async function mcpCall(method, params) {
    var tok = window.sessionToken;
    if (!tok) {
      try {
        var stored = localStorage.getItem('sb-hdhvrlkizorscvehttzd-auth-token');
        if (stored) {
          var parsed = JSON.parse(stored);
          tok = parsed.access_token || parsed.currentSession?.access_token;
          if (tok) window.sessionToken = tok;
        }
      } catch(e) {}
    }
    if (!tok) throw new Error('Not authenticated');

    var res = await fetch('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tok
      },
      body: JSON.stringify({ method: method, params: params || {} })
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');
    return data.result;
  }

  async function loadOAuthTokens() {
    var oauthListEl = document.getElementById('oauthTokensList');
    var statOauthSessions = document.getElementById('statOauthSessions');
    if (!oauthListEl) return;

    oauthListEl.innerHTML = '<div style="color:var(--text-muted); font-size:14px; padding:24px; text-align:center;">Memuat sesi OAuth...</div>';

    try {
      var result = await mcpCall('oauth_tokens_list', {});
      var tokens = result.tokens || [];

      if (statOauthSessions) {
        statOauthSessions.textContent = tokens.length;
      }

      if (tokens.length === 0) {
        oauthListEl.innerHTML = '<div style="color:var(--text-muted); font-size:13.5px; padding:20px; text-align:center; border:1px dashed var(--border-light); border-radius:10px;">Belum ada sesi OAuth aktif. Hubungkan melalui Antigravity, Claude, atau ChatGPT untuk membuat sesi OAuth.</div>';
        return;
      }

      oauthListEl.innerHTML = tokens.map(function(t) {
        var created = new Date(t.created_at).toLocaleString();
        var expires = t.expires_at ? new Date(t.expires_at).toLocaleString() : 'Tanpa batas waktu';
        var cid = (t.client_id || '').toLowerCase();
        var isAntigravity = cid.includes('antigravity') || cid.includes('gemini');
        var isChatGPT = cid.includes('chatgpt') || cid.includes('openai');
        var clientName = isAntigravity ? 'Google Antigravity Connector' : (isChatGPT ? 'ChatGPT Connector' : 'Claude AI Connector');
        var badgeStyle = isAntigravity ? 'background:var(--c4); color:var(--c1);' : 'background:var(--accent-soft); color:var(--accent);';

        return '<div class="api-key-item-card">' +
          '<div style="flex:1; min-width:240px;">' +
            '<div style="font-weight:700; font-size:14.5px; color:var(--text-main); margin-bottom:6px; display:flex; align-items:center; gap:8px;">' +
              '<span style="color:var(--c4); font-weight:700;">' + clientName + '</span>' +
              '<span style="font-size:11px; ' + badgeStyle + ' padding:3px 8px; border-radius:99px; font-weight:800;">ACTIVE</span>' +
            '</div>' +
            '<div style="font-size:13px; color:var(--text-main); margin-bottom:6px; word-break:break-all;">Akun: <strong>' + sanitize(t.user_email) + '</strong></div>' +
            '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">' +
              '<code style="font-size:12px; background:var(--bg-inset); padding:3px 8px; border-radius:4px; color:var(--c4); font-weight:700;">' + sanitize(t.token_prefix) + '</code>' +
              '<button class="btn-unified sm" onclick="window._copyKeyPrefix(\'' + sanitize(t.token_prefix).replace(/'/g, "\\'") + '\')" style="padding:2px 8px; font-size:11px;">📋 Salin</button>' +
              '<span style="font-size:12.5px; color:var(--text-muted);">Diotorisasi: ' + created + '</span>' +
              '<span style="font-size:12.5px; color:var(--text-muted);">&middot; Kadaluarsa: ' + expires + '</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn-unified sm danger" style="flex-shrink:0;" onclick="window._revokeOAuthToken(\'' + sanitize(t.token_id).replace(/'/g, "\\'") + '\', \'' + sanitize(t.user_email).replace(/'/g, "\\'") + '\', \'' + clientName.replace(/'/g, "\\'") + '\')">Putuskan Koneksi</button>' +
        '</div>';
      }).join('');

    } catch (err) {
      if (statOauthSessions) statOauthSessions.textContent = '-';
      oauthListEl.innerHTML = '<div style="color:var(--danger); padding:16px;">Gagal memuat sesi OAuth: ' + sanitize(err.message) + '</div>';
    }
  }

  window._revokeOAuthToken = async function(tokenId, userEmail, clientName) {
    var name = clientName || 'AI Connector';
    var confirmed = await customConfirm('Putuskan koneksi ' + name + ' untuk akun "' + userEmail + '"? Sesi ini akan kehilangan akses tools MCP.');
    if (!confirmed) return;
    try {
      await mcpCall('oauth_tokens_revoke', { token_id: tokenId });
      showToast(name + ' berhasil diputuskan', 'success');
      loadOAuthTokens();
    } catch (err) {
      showToast('Gagal: ' + err.message, 'error');
    }
  };

  async function loadApiKeys() {
    var listEl = document.getElementById('apiKeysList');
    var statActiveKeys = document.getElementById('statActiveKeys');
    var quotaBadge = document.getElementById('apiKeysQuotaBadge');
    if (!listEl) return;

    loadOAuthTokens();

    listEl.innerHTML = '<div style="color:var(--text-muted); font-size:14px; padding:24px; text-align:center;">Memuat daftar kunci API...</div>';

    try {
      var result = await mcpCall('apikeys_list', {});
      var keys = result.keys || [];

      if (statActiveKeys) {
        statActiveKeys.textContent = keys.length + ' / 5';
      }
      if (quotaBadge) {
        quotaBadge.textContent = keys.length + ' / 5 Aktif';
      }

      if (keys.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:32px 16px; color:var(--text-muted); border:1px dashed var(--border-light); border-radius:10px;">' +
          '<div style="font-size:32px; margin-bottom:8px;">🔑</div>' +
          '<div style="font-weight:700; font-size:14.5px; color:var(--text-main); margin-bottom:4px;">Belum Ada Kunci API Developer</div>' +
          '<div style="font-size:13px; margin-bottom:14px; color:var(--text-muted);">Buat kunci baru di atas untuk menghubungkan AI Assistant (Antigravity, Claude, ChatGPT) atau skrip Anda.</div>' +
          '<button class="btn-unified primary sm" onclick="document.getElementById(\'newKeyName\')?.focus()">+ Buat Kunci Sekarang</button>' +
        '</div>';
        return;
      }

      listEl.innerHTML = keys.map(function(k) {
        var created = new Date(k.created_at).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' });
        var lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Belum pernah';
        var isExpired = k.expires_at && new Date(k.expires_at) < new Date();
        var expiresInfo = k.expires_at ? (isExpired ? ('Kadaluarsa sejak ' + new Date(k.expires_at).toLocaleDateString('id-ID')) : ('Berlaku s/d ' + new Date(k.expires_at).toLocaleDateString('id-ID'))) : 'Tanpa batas waktu';
        var statusBadge = isExpired ? '<span class="api-key-badge-expired">● KADALUARSA</span>' : '<span class="api-key-badge-active">● AKTIF</span>';

        return '<div class="api-key-item-card">' +
          '<div style="flex:1; min-width:240px;">' +
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">' +
              '<strong style="font-size:15px; color:var(--text-main); word-break:break-word;">' + sanitize(k.name) + '</strong>' +
              statusBadge +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">' +
              '<code style="font-size:12.5px; background:var(--bg-inset); padding:3px 8px; border-radius:6px; color:var(--c4); font-weight:700;">' + sanitize(k.key_prefix) + '...</code>' +
              '<button class="btn-unified sm" onclick="window._copyKeyPrefix(\'' + sanitize(k.key_prefix).replace(/'/g, "\\'") + '\')" title="Salin Prefix Identifier" style="padding:2px 8px; font-size:11px;">📋 Salin Prefix</button>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:12.5px; color:var(--text-muted);">' +
              '<span>📅 Dibuat: ' + created + '</span>' +
              '<span>&middot; ⚡ Dipakai: ' + lastUsed + '</span>' +
              '<span>&middot; 📊 ' + (k.request_count || 0) + ' req</span>' +
              '<span>&middot; ⏳ ' + expiresInfo + '</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn-unified sm danger" style="flex-shrink:0;" onclick="window._revokeApiKey(\'' + k.id + '\', \'' + sanitize(k.name).replace(/'/g, "\\'") + '\')">🗑️ Cabut Kunci</button>' +
        '</div>';
      }).join('');

    } catch (err) {
      if (statActiveKeys) statActiveKeys.textContent = '-';
      if (quotaBadge) quotaBadge.textContent = 'Error';
      listEl.innerHTML = '<div style="color:var(--danger); padding:16px;">Gagal memuat kunci API: ' + sanitize(err.message) + '</div>';
    }
  }

  async function generateApiKey() {
    var nameInput = document.getElementById('newKeyName');
    var expirySelect = document.getElementById('newKeyExpiry');
    var btn = document.getElementById('btnGenerateApiKey');

    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      showToast('Masukkan nama atau deskripsi kunci API', 'error');
      if (nameInput) nameInput.focus();
      return;
    }

    var expiresInDays = (expirySelect && expirySelect.value) ? parseInt(expirySelect.value, 10) : null;

    if (btn) { btn.disabled = true; btn.textContent = 'Membuat Kunci...'; }

    try {
      var result = await mcpCall('apikeys_create', { name: name, expires_in_days: expiresInDays });

      window._lastCreatedKey = result.raw_key;

      // 1. Automatically copy to clipboard immediately!
      await safeCopyToClipboard(result.raw_key);

      // 2. Put key into modal input
      var keyInput = document.getElementById('createdApiKeyInput');
      if (keyInput) keyInput.value = result.raw_key;

      // 3. Clear form inputs
      if (nameInput) nameInput.value = '';
      if (expirySelect) expirySelect.value = '';

      // 4. Open Dedicated High-Visibility Modal
      var modal = document.getElementById('apiKeyCreatedModal');
      if (window.ModalManager) {
        ModalManager.open(modal);
      } else if (modal) {
        modal.classList.add('active');
      }

      showToast('✓ Kunci API berhasil dibuat & disalin ke clipboard!', 'success');
      loadApiKeys();
    } catch (err) {
      showToast('Gagal membuat API key: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '+ Buat Kunci API'; }
    }
  }

  async function copyCreatedKey() {
    var key = window._lastCreatedKey || (document.getElementById('createdApiKeyInput')?.value) || '';
    if (!key) return;
    var ok = await safeCopyToClipboard(key);
    var textEl = document.getElementById('btnCopyCreatedKeyText');
    var iconEl = document.getElementById('btnCopyCreatedKeyIcon');
    if (ok) {
      if (textEl) textEl.textContent = '✓ Kunci Tersalin!';
      if (iconEl) iconEl.textContent = '✅';
      showToast('Kunci API tersalin ke clipboard!', 'success');
      setTimeout(function() {
        if (textEl) textEl.textContent = 'Salin Kunci';
        if (iconEl) iconEl.textContent = '📋';
      }, 2000);
    } else {
      showToast('Gagal menyalin kunci', 'error');
    }
  }

  // Copy key prefix helper with toast
  window._copyKeyPrefix = async function(prefix) {
    if (!prefix) return;
    var ok = await safeCopyToClipboard(prefix);
    if (ok) {
      showToast('Prefix "' + prefix + '" tersalin ke clipboard!', 'success');
    } else {
      showToast('Gagal menyalin prefix', 'error');
    }
  };

  // Used by onclick= in rendered key cards. Must be global.
  window._revokeApiKey = async function(keyId, keyName) {
    var confirmed = await customConfirm('Cabut kunci API "' + keyName + '"? Layanan atau AI yang menggunakan kunci ini akan kehilangan akses seketika.');
    if (!confirmed) return;
    try {
      await mcpCall('apikeys_revoke', { key_id: keyId });
      showToast('Kunci API "' + keyName + '" berhasil dicabut', 'success');
      loadApiKeys();
    } catch (err) {
      showToast('Gagal mencabut kunci: ' + err.message, 'error');
    }
  };
})();

