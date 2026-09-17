// 3-Division Workflow & Tasks Logic
let currentUserDivision = null;
let currentUserId = null;
let isAdminUser = false;
window.currentDivisionId = 'all';

// WebKit/Safari-safe date parser
function parseSafeDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? null : dateStr;
    if (typeof dateStr === 'number') return new Date(dateStr);
    if (typeof dateStr === 'string') {
        let sanitized = dateStr.trim();
        // Convert Postgres 'YYYY-MM-DD HH:MM:SS' to ISO 'YYYY-MM-DDTHH:MM:SS'
        if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(sanitized)) {
            sanitized = sanitized.replace(' ', 'T');
        }
        const d = new Date(sanitized);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}
window.parseSafeDate = parseSafeDate;

document.addEventListener('DOMContentLoaded', () => {
    // Wait for sessionToken to be populated by admin.js
    if (window.sessionToken) {
        initWorkflow();
    } else {
        window.addEventListener('adminReady', () => initWorkflow(), { once: true });
    }
    // Fallback timeout in case event was missed
    setTimeout(() => {
        if (window.sessionToken && !window._workflowInitialized) initWorkflow();
    }, 5000);

    // Setup Refresh buttons
    document.getElementById('btnRefreshTasks')?.addEventListener('click', loadTasks);
    document.getElementById('btnRefreshDivisions')?.addEventListener('click', loadDivisions);
    
    // Bind tab events to load data when activated
    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', (e) => {
            const target = e.currentTarget.getAttribute('data-target');
            if(target === 'viewTasks') {
                if(!window.allTasks) loadTasks();
            }
            if(target === 'viewUsers') {
                if(!window.divisionData) loadDivisions();
            }
            if(target === 'viewDashboard') {
                if(!window.contributionsLoaded) window.loadContributions();
            }
        });
    });
    
    window.loadDivisions = loadDivisions;
});

async function apiCall(endpoint, payload) {
    if(!sessionToken) return { error: 'No session' };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(`/api/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return await res.json();
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') return { error: 'Request timed out (30s)' };
        return { error: e.message };
    }
}

async function initWorkflow() {
    window._workflowInitialized = true;
    const { data: { user } } = await supabaseClient.auth.getUser();
    if(user) currentUserId = user.id;

    // Check if user has admin badge in the UI (set by admin.js verifyAdmin)
    const badge = document.getElementById('userBadge');
    isAdminUser = badge && (badge.dataset.role === 'admin' || badge.dataset.role === 'superadmin');

    // Show couple sidebar widget only for admin users
    if (isAdminUser) {
        const coupleWidget = document.getElementById('coupleSidebarWidget');
        if (coupleWidget) {
            coupleWidget.style.display = '';
            // Load couple config to populate sidebar names
            apiCall('contributions', { action: 'get_couple_package' }).then(coupleRes => {
                const sidebarNames = document.getElementById('coupleSidebarNames');
                if (coupleRes && coupleRes.success && Array.isArray(coupleRes.couple) && coupleRes.couple.length >= 2) {
                    if (sidebarNames) sidebarNames.textContent = `${coupleRes.couple[0].username} & ${coupleRes.couple[1].username}`;
                } else {
                    if (sidebarNames) sidebarNames.textContent = 'Not configured';
                }
            }).catch(() => {});
        }
    }

    const divRes = await apiCall('divisions', { action: 'get_my_division' });
    
    if(divRes.success && divRes.division) {
        currentUserDivision = divRes.division.division_id;
        const waInput = document.getElementById('myWaInput');
        if (waInput && divRes.division.whatsapp) {
            waInput.value = divRes.division.whatsapp;
        }
    } else if (divRes.success && !divRes.division) {
        // User has no division, show picker
        if (!isAdminUser) {
            const divModal = document.getElementById('divisionPickerModal');
            if (divModal) {
                if (window.ModalManager) ModalManager.open(divModal);
                else divModal.classList.add('active');
            }
        }
    }

    // Bind static task creation & refresh buttons
    const btnCreateTask = document.getElementById('btnCreateTask');
    if (btnCreateTask) {
        btnCreateTask.onclick = () => createNewTaskPrompt();
    }
    const btnRefreshTasks = document.getElementById('btnRefreshTasks');
    if (btnRefreshTasks) {
        btnRefreshTasks.onclick = async () => {
            if (typeof withButtonLoading === 'function') {
                await withButtonLoading(btnRefreshTasks, async () => {
                    await loadTasks();
                    showToast('Tasks refreshed', 'success');
                }, 'Refreshing...');
            } else {
                await loadTasks();
                showToast('Tasks refreshed', 'success');
            }
        };
    }
    const btnRefreshOrg = document.getElementById('btnRefreshOrganization');
    if (btnRefreshOrg) {
        btnRefreshOrg.onclick = async () => {
            if (typeof withButtonLoading === 'function') {
                await withButtonLoading(btnRefreshOrg, async () => {
                    await loadDivisions();
                    if (window.loadUsers) await window.loadUsers();
                    showToast('Organization data refreshed', 'success');
                }, 'Refreshing...');
            } else {
                await loadDivisions();
                if (window.loadUsers) await window.loadUsers();
                showToast('Organization data refreshed', 'success');
            }
        };
    }
    const btnAddDivMem = document.getElementById('btnAddDivisionMember');
    if (btnAddDivMem) {
        btnAddDivMem.onclick = () => window.promptAddMember(window.currentDivisionId);
    }

    // Real-time subscription for divisions (debounced)
    if (window.supabaseClient) {
        let divReloadTimer = null;
        window.supabaseClient
            .channel('public:division_members')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'division_members' }, payload => {
                if(document.getElementById('viewUsers')?.classList.contains('active')) {
                    // Debounce: wait 500ms before reloading to batch rapid changes
                    clearTimeout(divReloadTimer);
                    divReloadTimer = setTimeout(() => loadDivisions(), 500);
                }
            })
            .subscribe();
    }

    // If a tab was already clicked before initWorkflow finished, load its data now
    if(document.getElementById('viewTasks')?.classList.contains('active')) {
        if(!window.allTasks) loadTasks();
    }
    if(document.getElementById('viewUsers')?.classList.contains('active')) {
        if(!window.divisionData) loadDivisions();
    }
    if(document.getElementById('viewDashboard')?.classList.contains('active')) {
        if(!window.contributionsLoaded) window.loadContributions();
    }
}

window.joinDivision = async function(divId) {
    showToast('Bergabung dengan divisi...');
    const res = await apiCall('divisions', { action: 'join_division', division_id: divId });
    if(res.success) {
        const divModal = document.getElementById('divisionPickerModal');
        if (divModal) {
            if (window.ModalManager) ModalManager.close(divModal);
            else divModal.classList.remove('active');
        }
        showToast('Berhasil bergabung!', 'success');
        setTimeout(() => window.location.reload(), 1000);
    } else {
        showToast('Gagal: ' + res.error, 'error');
    }
};

// =======================
// TASKS (KANBAN)
// =======================
async function loadTasks() {
    // Dynamically check admin status here because verifyAdmin in admin.js finishes asynchronously
    const badge = document.getElementById('userBadge');
    isAdminUser = badge && (badge.dataset.role === 'admin' || badge.dataset.role === 'superadmin');

    const btnCreateTask = document.getElementById('btnCreateTask');
    if (btnCreateTask && (isAdminUser || currentUserDivision === 'management')) {
        btnCreateTask.style.display = 'inline-flex';
        btnCreateTask.onclick = () => createNewTaskPrompt();
    }

    const cols = ['open', 'in_progress', 'developed', 'in_review', 'done'];
    cols.forEach(c => {
        const el = document.querySelector(`#col-${c} .kanban-task-list`);
        if (el) el.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted);">Loading... <div style="display:inline-block; width:16px; height:16px; border:2px solid var(--border-light); border-radius:50%; border-top-color:var(--text-main); animation:spin 1s ease-in-out infinite; margin-left:8px; vertical-align:middle;"></div></div>';
    });
    const res = await apiCall('tasks', { action: 'list_tasks' });
    if(res.success) {
        window.allTasks = res.tasks || [];
        
        // Dynamically update category dropdowns
        const uniqueCategories = new Set(['CBT', 'OSCE', 'Video', 'Summary']);
        window.allTasks.forEach(t => { if(t.category) uniqueCategories.add(t.category); });
        
        const filterCatEl = document.getElementById('filterTaskCategory');
        if (filterCatEl) {
            const currentVal = filterCatEl.value;
            filterCatEl.innerHTML = '<option value="all">All Categories</option>';
            uniqueCategories.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c; opt.textContent = c;
                filterCatEl.appendChild(opt);
            });
            filterCatEl.value = currentVal;
        }
        
        const taskCatEl = document.getElementById('taskCategory');
        if (taskCatEl) {
            const currentVal = taskCatEl.value;
            taskCatEl.innerHTML = '';
            uniqueCategories.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c; opt.textContent = c;
                taskCatEl.appendChild(opt);
            });
            const newOpt = document.createElement('option');
            newOpt.value = '__NEW__';
            newOpt.textContent = '+ Add New Category...';
            newOpt.style.fontWeight = 'bold';
            taskCatEl.appendChild(newOpt);
            taskCatEl.value = currentVal;
            if(!taskCatEl.value) taskCatEl.value = 'CBT';
        }

        if(window.applyTaskFilters) {
            window.applyTaskFilters();
        } else {
            renderKanban(window.allTasks);
            if (typeof renderTasksAsSyllabus === 'function') {
                renderTasksAsSyllabus(window.allTasks);
            }
        }
    } else {
        showToast('Failed to load tasks: ' + res.error, 'error');
    }
}

window.applyTaskFilters = function() {
    if (!window.allTasks) return;
    let filtered = window.allTasks;
    
    const filterCatEl = document.getElementById('filterTaskCategory');
    const search = (document.getElementById('filterTaskSearch') ? document.getElementById('filterTaskSearch').value.toLowerCase() : '');
    const category = (filterCatEl ? filterCatEl.value : 'all');
    const semester = (document.getElementById('filterTaskSemester') ? document.getElementById('filterTaskSemester').value : 'all');
    const assignee = (document.getElementById('filterTaskAssignee') ? document.getElementById('filterTaskAssignee').value : 'all');
    
    if(search) {
        filtered = filtered.filter(t => 
            (t.title && t.title.toLowerCase().includes(search)) || 
            (t.description && t.description.toLowerCase().includes(search))
        );
    }
    if(category !== 'all') {
        filtered = filtered.filter(t => t.category === category);
    }
    if(semester !== 'all') {
        filtered = filtered.filter(t => t.semester === parseInt(semester));
    }
    if(assignee !== 'all') {
        if(assignee === 'me') {
            filtered = filtered.filter(t => t.assigned_to === currentUserId);
        } else if (assignee === 'unassigned') {
            filtered = filtered.filter(t => !t.assigned_to);
        }
    }
    
    renderKanban(filtered);
    if (typeof renderTasksAsSyllabus === 'function') {
        renderTasksAsSyllabus(filtered);
    }
};

function renderKanban(tasks) {
    const cols = {
        'open': document.querySelector('#col-open .kanban-task-list'),
        'in_progress': document.querySelector('#col-in_progress .kanban-task-list'),
        'developed': document.querySelector('#col-developed .kanban-task-list'),
        'in_review': document.querySelector('#col-in_review .kanban-task-list'),
        'done': document.querySelector('#col-done .kanban-task-list')
    };

    // Clear columns
    Object.values(cols).forEach(c => { if(c) c.innerHTML = ''; });

    tasks.forEach(task => {
        const col = cols[task.status];
        if(!col) return;

        const el = document.createElement('div');
        el.className = 'kanban-card';
        
        let displayDesc = task.description || '';
        let dueDateStr = '';
        let dueColor = 'var(--text-muted)';
        const dueMatch = displayDesc.match(/\[Due:\s*([^\]]+)\]/);
        if (dueMatch) {
            dueDateStr = dueMatch[1];
            displayDesc = displayDesc.replace(dueMatch[0], '').trim();
            const dueD = parseSafeDate(dueDateStr);
            const dueTime = dueD ? dueD.getTime() : 0;
            const now = Date.now();
            if (dueTime && dueTime < now) dueColor = 'var(--danger)';
            else if (dueTime && dueTime < now + 86400000 * 3) dueColor = 'var(--accent)';
        }

        let meta = `<div style="font-size:13.5px; margin-bottom:6px;"><span style="color:var(--text-main); font-weight:600;">Sem:</span> ${task.semester || '-'} | <span style="color:var(--text-main); font-weight:600;">Blk:</span> ${task.block || '-'}</div>`;
        if (task.assigned_to_user) {
            meta += `<div style="font-size:13.5px; margin-bottom:6px;"><span style="color:var(--text-main); font-weight:600;">Dev:</span> ${task.assigned_to_user.username || task.assigned_to_user.email.split('@')[0]}</div>`;
        }
        if (task.reviewed_by_user) {
            meta += `<div style="font-size:13.5px; margin-bottom:6px;"><span style="color:var(--text-main); font-weight:600;">Rev:</span> ${task.reviewed_by_user.username || task.reviewed_by_user.email.split('@')[0]}</div>`;
        }
        
        let activeDateLabel = '';
        let activeDateVal = '';
        if (task.status === 'open' && task.created_at) { activeDateLabel = 'Created'; activeDateVal = task.created_at; }
        else if (task.status === 'in_progress' && task.assigned_at) { activeDateLabel = 'Assigned'; activeDateVal = task.assigned_at; }
        else if (task.status === 'developed' && task.submitted_at) { activeDateLabel = 'Submitted'; activeDateVal = task.submitted_at; }
        else if (task.status === 'in_review' && task.review_started_at) { activeDateLabel = 'Reviewed'; activeDateVal = task.review_started_at; }
        else if (task.status === 'done' && task.completed_at) { activeDateLabel = 'Done'; activeDateVal = task.completed_at; }
        
        if (activeDateVal) {
            const actD = parseSafeDate(activeDateVal);
            meta += `<div style="margin-top:6px; font-size:13px;"><span style="color:var(--text-main); font-weight:600;">${activeDateLabel}:</span> <span>${actD ? actD.toLocaleDateString() : '-'}</span></div>`;
        }

        if (dueDateStr) {
            meta += `<div style="margin-top:6px; font-size:13px;"><span style="color:var(--text-main); font-weight:600;">Due:</span> <span style="color:${dueColor}; font-weight:bold;">${dueDateStr}</span></div>`;
        }
        if (task.target_path) {
            meta += `<div style="margin-top:6px; font-size:13px;"><span style="color:var(--text-main); font-weight:600;">File:</span> <span style="font-family:var(--font-mono); color:var(--accent); font-weight:600;">${sanitize(task.target_path)}</span></div>`;
        }

        el.dataset.taskId = task.id;
        el.innerHTML = `
            <div style="font-weight:700; font-size:16.5px; margin-bottom:8px; line-height:1.3; color:var(--text-main);">${sanitize(task.title)}</div>
            <div style="color:var(--text-main); opacity:0.9; font-size:14px; margin-bottom:12px; line-height:1.5;">${sanitize(displayDesc)}</div>
            ${meta}
        `;
        
        col.appendChild(el);
    });

    initTaskKanbanDelegation();
}

function initTaskKanbanDelegation() {
    const kanban = document.getElementById('taskKanban');
    if (!kanban || kanban.dataset.delegated === 'true') return;
    kanban.dataset.delegated = 'true';

    kanban.addEventListener('click', (e) => {
        const card = e.target.closest('.kanban-card');
        if (!card || !kanban.contains(card)) return;
        const taskId = card.dataset.taskId;
        const task = (window.allTasks || []).find(t => String(t.id) === String(taskId));
        if (task) openTaskModal(task);
    });
}

async function createNewTaskPrompt() {
    const modal = document.getElementById('createTaskModal');
    const titleEl = document.getElementById('taskTitle');
    const catEl = document.getElementById('taskCategory');
    const prioEl = document.getElementById('taskPriority');
    const semEl = document.getElementById('taskSemester');
    const blockEl = document.getElementById('taskBlock');
    const descEl = document.getElementById('taskDescription');
    const targetEl = document.getElementById('taskTargetPath');
    const assignEl = document.getElementById('taskAssignTo');
    const btnCancel = document.getElementById('taskCancel');
    const btnConfirm = document.getElementById('taskConfirm');

    titleEl.value = '';
    descEl.value = '';
    blockEl.value = '';
    if (targetEl) targetEl.value = window._prefilledTaskPath || '';
    window._prefilledTaskPath = ''; // reset after opening
    
    // Ensure the new category logic is attached only once
    if (!catEl.hasAttribute('data-new-cat-bound')) {
        catEl.addEventListener('change', async (e) => {
            if (e.target.value === '__NEW__') {
                const newCat = await customPrompt("Enter new category name:");
                if (newCat && newCat.trim()) {
                    const opt = document.createElement('option');
                    opt.value = newCat.trim();
                    opt.textContent = newCat.trim();
                    catEl.insertBefore(opt, catEl.lastElementChild);
                    catEl.value = newCat.trim();
                } else {
                    catEl.value = 'CBT';
                }
            }
        });
        catEl.setAttribute('data-new-cat-bound', 'true');
    }
    
    if (assignEl) {
        assignEl.innerHTML = '<option value="">-- Unassigned --</option>';
        apiCall('divisions', { action: 'get_divisions' }).then(res => {
            if (res.success) {
                const devDiv = res.divisions.find(d => d.id === 'development');
                if (devDiv && devDiv.members) {
                    devDiv.members.forEach(m => {
                        const opt = document.createElement('option');
                        const email = typeof m === 'string' ? m : m.email;
                        const username = typeof m === 'string' ? m.split('@')[0] : (m.username || m.email.split('@')[0]);
                        opt.value = email; 
                        opt.textContent = username;
                        assignEl.appendChild(opt);
                    });
                }
            }
        });
    }

    if (window.ModalManager) ModalManager.open(modal);
    else modal.classList.add('active');

    return new Promise((resolve) => {
        let isResolved = false;
        const cleanup = () => {
            if (isResolved) return;
            isResolved = true;
            if (window.ModalManager) ModalManager.close(modal);
            else modal.classList.remove('active');
            btnCancel.onclick = null;
            btnConfirm.onclick = null;
        };
        btnCancel.onclick = () => { cleanup(); resolve(null); };
        btnConfirm.onclick = async () => {
            const title = titleEl.value.trim();
            if(!title) return showToast('Title is required', 'error');
            
            const dueDateEl = document.getElementById('taskDueDate');
            let descText = descEl.value.trim();
            if (dueDateEl && dueDateEl.value) {
                descText += (descText ? '\n\n' : '') + '[Due: ' + dueDateEl.value + ']';
            }
            
            const payload = {
                action: 'create_task',
                title: title,
                category: catEl.value,
                priority: prioEl.value,
                semester: semEl.value,
                block: blockEl.value.trim() || 'General',
                description: descText,
                target_path: targetEl ? targetEl.value.trim() : null,
                assigned_to_email: assignEl && assignEl.value ? assignEl.value : null
            };
            cleanup();
            showToast('Creating task...');
            const res = await apiCall('tasks', payload);
            if(res.success) {
                showToast('Task created', 'success');
                loadTasks();
            } else {
                showToast(res.error, 'error');
            }
            resolve();
        };
    });
}

window.toggleTasksView = function() {
    const view = document.getElementById('tasksViewToggle').value;
    const kanban = document.getElementById('taskKanban');
    const syllabus = document.getElementById('syllabusTableContainer');
    const mobileKanbanSelect = document.getElementById('kanbanMobileColumnSelect');
    if (view === 'kanban') {
        kanban.classList.remove('hidden');
        kanban.style.display = 'flex';
        syllabus.classList.add('hidden');
        syllabus.style.display = '';
        if (mobileKanbanSelect) mobileKanbanSelect.classList.remove('hidden');
    } else {
        kanban.classList.add('hidden');
        kanban.style.display = '';
        syllabus.classList.remove('hidden');
        syllabus.style.display = '';
        if (mobileKanbanSelect) mobileKanbanSelect.classList.add('hidden');
    }
}

window.switchMobileKanbanColumn = function(colId) {
    const kanbanCols = document.querySelectorAll('.kanban-column');
    kanbanCols.forEach(col => {
        if (colId === 'all') {
            col.classList.remove('mobile-hidden');
        } else {
            if (col.id === colId) {
                col.classList.remove('mobile-hidden');
            } else {
                col.classList.add('mobile-hidden');
            }
        }
    });
};

function renderTasksAsSyllabus(tasks) {
    const tbody = document.getElementById('syllabusTableBody');
    if(!tbody) return;
    tbody.innerHTML = '';
    
    if(tasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:36px; color:var(--text-muted); font-family:var(--font-primary); font-size:14px;">NO TASKS FOUND IN SYLLABUS</td></tr>';
        return;
    }
    
    // Group tasks by Semester and Block
    const grouped = {};
    tasks.forEach(t => {
        const key = `SEMESTER ${t.semester || '-'} / ${t.block || '-'}`;
        if(!grouped[key]) grouped[key] = [];
        grouped[key].push(t);
    });
    
    const sortedKeys = Object.keys(grouped).sort();
    
    let html = '';
    sortedKeys.forEach(key => {
        // Group Header
        html += `<tr class="syllabus-group-header-row"><td colspan="6" class="syllabus-group-header-td">${key} (${grouped[key].length} Tasks)</td></tr>`;
        
        grouped[key].forEach(t => {
            const badgeClass = 
                t.status === 'open' ? 'badge-member' : 
                (t.status === 'done' ? 'badge-admin' : 'badge-banned');
            
            const assignee = t.assigned_to_user ? (t.assigned_to_user.username || t.assigned_to_user.email.split('@')[0]) : '<span style="color:var(--text-muted); font-style:italic;">Unassigned</span>';
            
            html += `<tr class="syllabus-row" data-task-id="${t.id}">
                <td style="white-space:nowrap; font-weight:700;">${sanitize(t.semester || '-')} / ${sanitize(t.block || '-')}</td>
                <td style="font-weight:700; word-break:break-word; max-width:320px; color:var(--c3); font-family:var(--font-primary); font-size:14px;">${sanitize(t.title)}</td>
                <td style="white-space:nowrap;"><span class="badge badge-division">${sanitize(t.category || '-')}</span></td>
                <td style="white-space:nowrap;"><span class="badge ${badgeClass}">${sanitize((t.status || '').toUpperCase())}</span></td>
                <td style="word-break:break-all; max-width:180px; font-size:12.5px;">${assignee}</td>
                <td style="white-space:nowrap; text-align:right;"><button class="btn-card primary" style="min-height:28px; padding:4px 10px; font-size:11px;">View Details</button></td>
            </tr>`;
        });
    });
    
    tbody.innerHTML = html;
    
    // Bind click handlers programmatically
    tbody.querySelectorAll('.syllabus-row').forEach(row => {
        row.addEventListener('click', () => {
            const taskId = row.getAttribute('data-task-id');
            const task = tasks.find(t => t.id === taskId);
            if (task) openTaskModal(task);
        });
    });
}

function openTaskModal(task) {
    window.currentOpenedTask = task;
    const isDev = currentUserDivision === 'development' || isAdminUser;
    const isRev = currentUserDivision === 'review' || isAdminUser;
    const isMgmt = currentUserDivision === 'management' || isAdminUser;
    const isMyTask = task.assigned_to === currentUserId;

    let actionsHtml = '';
    if (task.status === 'open' && isDev) {
        actionsHtml += `<button class="btn-unified primary" onclick="updateTask('${task.id}', 'claim_task')">Claim Task</button>`;
    } else if (task.status === 'in_progress' && (isMyTask || isMgmt)) {
        if (isMyTask) actionsHtml += `<button class="btn-unified" onclick="updateTask('${task.id}', 'unclaim_task')">Unclaim</button>`;
        actionsHtml += `<button class="btn-unified primary" onclick="updateTask('${task.id}', 'submit_task')">Submit for Review</button>`;
    } else if (task.status === 'developed' && isRev) {
        actionsHtml += `<button class="btn-unified primary" onclick="updateTask('${task.id}', 'start_review')">Start Review</button>`;
    } else if (task.status === 'in_review' && isRev) {
        actionsHtml += `<button class="btn-unified danger" onclick="updateTask('${task.id}', 'reject_task')">Reject</button>`;
        actionsHtml += `<button class="btn-unified primary" onclick="updateTask('${task.id}', 'approve_task')">Approve (Done)</button>`;
    }

    // Re-submit: pull task back from developed/in_review to in_progress for rework
    if ((task.status === 'developed' || task.status === 'in_review') && (isMyTask || isMgmt)) {
        actionsHtml += `<button class="btn-unified warning" onclick="updateTask('${task.id}', 'resubmit_task')">Re-submit (Pull Back)</button>`;
    }

    // Re-Review: send a done task back to in_review
    if (task.status === 'done' && (isRev || isMgmt)) {
        actionsHtml += `<button class="btn-unified warning" onclick="updateTask('${task.id}', 're_review_task')">Re-Review Task</button>`;
    }

    // Retrack: reopen a done task back to open (full reset)
    if (task.status === 'done' && isMgmt) {
        actionsHtml += `<button class="btn-unified warning" onclick="updateTask('${task.id}', 'retrack_task')">Retrack (Reopen)</button>`;
    }

    // Reset Phase / Re-Plan (any active status)
    if ((task.status !== 'open') && (isMgmt || isDev || isRev)) {
        actionsHtml += `<button class="btn-unified muted" onclick="updateTask('${task.id}', 'reset_phase')">Reset Phase / Re-Plan</button>`;
    }

    // Delete Task Button (for Management or Admin)
    if (isMgmt) {
        actionsHtml += `<button class="btn-unified danger-fill" onclick="updateTask('${task.id}', 'delete_task')">Delete Task</button>`;
    }

    const modal = document.getElementById('contextModal');
    document.getElementById('contextTitle').textContent = task.title;
    const acts = document.getElementById('contextActions');
    
    let details = `<div style="font-size:14px; margin-bottom:20px; padding:20px; background:var(--c1); border:var(--border-main); border-radius:var(--radius-card); line-height:1.6; min-width:0; overflow:hidden;">
        <div style="margin-bottom:8px;"><b>Status:</b> <span class="badge" style="background:var(--bg-main); border:1px solid var(--border-light); padding:4px 8px; margin-left:4px;">${task.status.toUpperCase()}</span></div>
        <div style="margin-bottom:8px;"><b>Category:</b> ${task.category || '-'}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap; min-width:0;">
            <span style="min-width:0; overflow-wrap:break-word; word-break:break-all; flex:1;"><b>Developer:</b> ${task.assigned_to_user ? task.assigned_to_user.email : 'Unassigned'}</span>
            ${task.assigned_to_user && task.assigned_to_user.whatsapp ? `<a href="https://wa.me/${task.assigned_to_user.whatsapp}?text=Hi, regarding Mr. Capsules task '${task.title}'" target="_blank" class="btn-card primary" style="text-decoration:none; flex-shrink:0;">Contact WA</a>` : ''}
        </div>
        <div style="margin-bottom:8px;"><b>Reviewer:</b> ${task.reviewed_by_user ? (task.reviewed_by_user.username || task.reviewed_by_user.email.split('@')[0]) : 'Unassigned'}</div>
        ${task.target_path ? `<div style="margin-top:16px; word-break:break-all; overflow-wrap:anywhere;"><b>Target File:</b> <span style="font-family:var(--font-mono); color:var(--accent);">${task.target_path}</span></div>` : ''}
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border-light);">
            <div style="font-size:12px; font-weight:700; color:var(--text-muted); margin-bottom:8px; text-transform:uppercase; letter-spacing:1px;">Timeline</div>
            <div style="display:grid; grid-template-columns:auto 1fr; gap:6px 16px; font-size:13px;">
                <span style="color:var(--text-muted)">Created:</span> <span>${task.created_at && parseSafeDate(task.created_at) ? parseSafeDate(task.created_at).toLocaleString() : '-'}</span>
                <span style="color:var(--text-muted)">Assigned:</span> <span>${task.assigned_at && parseSafeDate(task.assigned_at) ? parseSafeDate(task.assigned_at).toLocaleString() : '-'}</span>
                <span style="color:var(--text-muted)">Submitted:</span> <span>${task.submitted_at && parseSafeDate(task.submitted_at) ? parseSafeDate(task.submitted_at).toLocaleString() : '-'}</span>
                <span style="color:var(--text-muted)">Reviewed:</span> <span>${task.review_started_at && parseSafeDate(task.review_started_at) ? parseSafeDate(task.review_started_at).toLocaleString() : '-'}</span>
                <span style="color:var(--text-muted)">Completed:</span> <span>${task.completed_at && parseSafeDate(task.completed_at) ? parseSafeDate(task.completed_at).toLocaleString() : '-'}</span>
            </div>
        </div>
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border-light);">
            <div style="font-weight:700; margin-bottom:8px;">Description & Notes:</div>
            <div style="white-space:pre-wrap; word-break:break-word; overflow-wrap:break-word; color:var(--text-main);">${task.description || 'No description provided.'}</div>
        </div>
        <div style="margin-top:12px;"><button class="btn-card w-100" style="justify-content:center;" onclick="loadTaskLogs('${task.id}')">View Activity Logs</button></div>
        <div id="taskLogsContainer_${task.id}" style="margin-top:8px; max-height:150px; overflow-y:auto;"></div>
    </div>`;

    if (task.target_path) {
        actionsHtml = `<button class="btn-unified primary" style="flex:1;" onclick="openTaskFile('${task.target_path}')">Open File in Editor</button>` + actionsHtml;
    }

    acts.innerHTML = details + `<div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">${actionsHtml}</div>`;
    if (window.ModalManager) ModalManager.open(modal);
    else modal.classList.add('active');
}

window.loadTaskLogs = async function(taskId) {
    const container = document.getElementById('taskLogsContainer_' + taskId);
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:13px; padding:12px;">Loading logs...</div>';
    const res = await apiCall('tasks', { action: 'get_task_logs', task_id: taskId });
    if(res.success) {
        if(res.logs.length === 0) {
            container.innerHTML = '<div style="font-size:13px; color:var(--text-muted); padding:12px; text-align:center;">No activity logs found.</div>';
            return;
        }
        
        // Find latest rejection note if task is in progress
        const isRejected = window.currentOpenedTask && window.currentOpenedTask.status === 'in_progress';
        let rejectNoteHtml = '';
        if (isRejected) {
            const lastReject = res.logs.find(l => l.action === 'rejected');
            if (lastReject && lastReject.note) {
                rejectNoteHtml = `<div style="margin-bottom:14px; padding:12px; background:transparent; border:1.5px solid var(--danger); border-radius:var(--radius-card);">
                    <div style="font-size:12px; font-weight:bold; color:var(--danger); text-transform:uppercase; letter-spacing:0.5px;">Latest Rejection Reason</div>
                    <div style="font-size:13.5px; color:var(--text-main); margin-top:6px; line-height:1.4;">"${lastReject.note}"</div>
                </div>`;
            }
        }

        container.innerHTML = rejectNoteHtml + res.logs.map(l => {
            let noteHtml = l.note ? `<div style="color:var(--text-main); font-style:italic; margin-top:6px; padding-left:10px; border-left:2px solid var(--border-medium); font-size:13px;">"${l.note}"</div>` : '';
            let actionColor = 'var(--accent)';
            if (l.action === 'rejected' || l.action === 'deleted') actionColor = 'var(--danger)';
            else if (l.action === 'phase_reset' || l.action === 'retracked') actionColor = 'color-mix(in srgb, var(--danger) 65%, var(--c1))';
            else if (l.action === 're_review_requested' || l.action === 'resubmitted') actionColor = 'var(--accent)';

            return `<div style="font-size:13px; border-bottom:1px solid var(--border-light); padding:10px 0;">
                <div><span style="color:${actionColor}; font-weight:700;">${l.action.replace(/_/g, ' ').toUpperCase()}</span> by <b>${l.user ? (l.user.username || l.user.email.split('@')[0]) : 'System'}</b></div>
                <div style="color:var(--text-muted); font-size:12px; margin-top:3px;">${l.created_at && parseSafeDate(l.created_at) ? parseSafeDate(l.created_at).toLocaleString() : '-'}</div>
                ${noteHtml}
            </div>`;
        }).join('');
    } else {
        container.innerHTML = `<div style="color:var(--danger); font-size:13px; padding:12px;">Failed to load logs.</div>`;
    }
}

window.updateTask = async function(taskId, action) {
    let note = '';
    let payloadExtra = {};

    if (action === 'delete_task') {
        const confirmDelete = await customConfirm("Are you sure you want to permanently delete this task? This action cannot be undone.");
        if (!confirmDelete) return;
    } else if (action === 'reset_phase') {
        const reason = await customPrompt("Mandatory: Please state the reason for resetting / re-planning this task phase:");
        if (!reason || !reason.trim()) {
            showToast('Reset reason is required.', 'error');
            return;
        }
        note = reason.trim();
        const unassignConfirm = await customConfirm("Do you also want to UNASSIGN the developer so anyone can claim this task again?");
        payloadExtra = { new_status: 'open', unassign: unassignConfirm };
    } else if (action === 're_review_task') {
        const reReviewNote = await customPrompt("Mandatory: Please provide notes / feedback for re-reviewing this task:");
        if (!reReviewNote || !reReviewNote.trim()) {
            showToast('Re-review note is required.', 'error');
            return;
        }
        note = reReviewNote.trim();
    } else if (action === 'retrack_task') {
        const retrackNote = await customPrompt("Mandatory: Why is this completed task being reopened?");
        if (!retrackNote || !retrackNote.trim()) {
            showToast('Retrack reason is required.', 'error');
            return;
        }
        note = retrackNote.trim();
        const confirmRetrack = await customConfirm("This will fully reset the task to OPEN status, unassign the developer, and clear all timestamps. Continue?");
        if (!confirmRetrack) return;
    } else if (action === 'resubmit_task') {
        const resubmitNote = await customPrompt("Mandatory: Why is this task being pulled back for rework?");
        if (!resubmitNote || !resubmitNote.trim()) {
            showToast('Re-submit reason is required.', 'error');
            return;
        }
        note = resubmitNote.trim();
    } else if (action === 'reject_task') {
        note = await customPrompt("Mandatory: Please provide a reason for rejecting this task:");
        if (!note || !note.trim()) {
            showToast('Rejection reason is required.', 'error');
            return;
        }
    } else if (action === 'submit_task') {
        note = await customPrompt("Optional: Any notes for the reviewer?");
    } else if (action === 'approve_task') {
        note = await customPrompt("Optional: Any final notes?");
    }

    const ctxModal = document.getElementById('contextModal');
    if (ctxModal) {
        if (window.ModalManager) ModalManager.close(ctxModal);
        else ctxModal.classList.remove('active');
    }
    showToast('Updating task...');
    const payload = { action, task_id: taskId, note: note ? note.trim() : null, ...payloadExtra };
    const res = await apiCall('tasks', payload);
    if(res.success) {
        showToast(action === 'delete_task' ? 'Task deleted' : 'Task updated', 'success');
        loadTasks();
    } else {
        showToast('Error: ' + res.error, 'error');
    }
};

window.openTaskFile = function(path) {
    const ctxModal = document.getElementById('contextModal');
    if (ctxModal) {
        if (window.ModalManager) ModalManager.close(ctxModal);
        else ctxModal.classList.remove('active');
    }
    // Switch to Files tab
    const filesTab = document.querySelector('.tab[data-target="viewFiles"]');
    if(filesTab) filesTab.click();
    
    if (window.currentTree) {
        const node = window.currentTree.find(n => n.path === path);
        if (node) {
            // Navigate to the file's parent directory first
            const parts = path.split('/');
            parts.pop(); // remove filename
            window.currentPath = parts.length > 0 ? parts.join('/') + '/' : '';
            if (window.renderBrowser) window.renderBrowser();
            
            // Open the file using the editor or preview
            const isImg = node.path.match(/\.(jpg|jpeg|png|gif|webp)$/i);
            const isCode = node.path.match(/\.(html|css|js)$/i);
            const item = { name: node.path.split('/').pop(), path: node.path, sha: node.sha, type: 'file' };
            
            if (isCode && window.openEditor) {
                window.openEditor(item);
            } else if (window.showPreview) {
                window.showPreview(item, !!isImg);
            } else {
                showToast('File found: ' + path, 'info');
            }
        } else {
            showToast('File not found in tree. Try refreshing Files tab.', 'error');
        }
    }
};

// =======================
// DIVISIONS
// =======================
window.selectDivision = function(divId) {
    window.currentDivisionId = divId;
    
    // Sync mobile division dropdown if exists
    const mobileDivSelect = document.getElementById('mobileDivisionSelect');
    if (mobileDivSelect && mobileDivSelect.value !== divId) {
        mobileDivSelect.value = divId;
    }
    
    // Clear active class from all sidebar buttons
    const btnAll = document.getElementById('btnDivFilterAll');
    if(btnAll) btnAll.classList.remove('active');
    
    document.querySelectorAll('.btn-div-item').forEach(b => {
        b.classList.remove('active');
    });

    if(divId === 'all') {
        if(btnAll) {
            btnAll.classList.add('active');
        }
        if(document.getElementById('orgViewTitle')) document.getElementById('orgViewTitle').textContent = 'All Users';
        if(document.getElementById('orgViewDesc')) document.getElementById('orgViewDesc').textContent = 'Manage all registered members in the system.';
        if(document.getElementById('btnAddDivisionMember')) document.getElementById('btnAddDivisionMember').style.display = 'none';
    } else {
        const btn = document.querySelector('.btn-div-item[data-id="' + divId + '"]');
        if(btn) {
            btn.classList.add('active');
        }
        
        const div = window.divisionData ? window.divisionData.find(d => d.id === divId) : null;
        if(div) {
            if(document.getElementById('orgViewTitle')) document.getElementById('orgViewTitle').textContent = div.name;
            if(document.getElementById('orgViewDesc')) document.getElementById('orgViewDesc').textContent = 'Viewing members of ' + div.name;
        }
        if(document.getElementById('btnAddDivisionMember')) document.getElementById('btnAddDivisionMember').style.display = 'inline-block';
    }
    
    if(window.loadUsers) {
        window.loadUsers(divId);
    }
};

async function loadDivisions() {
    const res = await apiCall('divisions', { action: 'get_divisions' });
    if(res.success && res.divisions) {
        window.divisionData = res.divisions;
        const list = document.getElementById('divisionSidebarList');
        const mobileDivSelect = document.getElementById('mobileDivisionSelect');
        
        if (mobileDivSelect) {
            mobileDivSelect.innerHTML = '<option value="all">Division: All Members</option>';
            res.divisions.forEach(div => {
                const opt = document.createElement('option');
                opt.value = div.id;
                opt.textContent = `Division: ${div.name} (${div.member_count})`;
                mobileDivSelect.appendChild(opt);
            });
            if (window.currentDivisionId) {
                mobileDivSelect.value = window.currentDivisionId;
            }
        }
        
        if(!list) return; // wait until DOM is ready or exists
        
        // Remove only dynamic division buttons with data-id attribute, preserving static #btnDivFilterAll
        list.querySelectorAll('.btn-div-item[data-id]').forEach(el => el.remove());
        
        // Ensure static #btnDivFilterAll button is properly wired
        const btnAll = document.getElementById('btnDivFilterAll');
        if (btnAll) {
            btnAll.onclick = () => window.selectDivision('all');
            if (!window.currentDivisionId || window.currentDivisionId === 'all') {
                btnAll.classList.add('active');
            } else {
                btnAll.classList.remove('active');
            }
        }

        // Show WA Config for all users
        const waConfig = document.getElementById('waConfigContainer');
        if(waConfig) waConfig.style.display = 'block';
        
        // Re-bind WA save
        const btnSaveWa = document.getElementById('btnSaveWa');
        if(btnSaveWa) {
            btnSaveWa.onclick = async () => {
                const waInput = document.getElementById('myWaInput');
                const wa = waInput ? waInput.value.trim() : '';
                if (typeof withButtonLoading === 'function') {
                    await withButtonLoading(btnSaveWa, async () => {
                        const wRes = await apiCall('divisions', { action: 'update_whatsapp', whatsapp: wa });
                        if(wRes && wRes.success) showToast('WhatsApp updated successfully!', 'success');
                        else showToast('Failed: ' + (wRes?.error || 'Unknown error'), 'error');
                    }, 'Saving...');
                } else {
                    showToast('Saving...');
                    const wRes = await apiCall('divisions', { action: 'update_whatsapp', whatsapp: wa });
                    if(wRes && wRes.success) showToast('WhatsApp updated successfully!', 'success');
                    else showToast('Failed: ' + (wRes?.error || 'Unknown error'), 'error');
                }
            };
        }
        
        res.divisions.forEach(div => {
            const btn = document.createElement('button');
            btn.className = 'btn-div-item';
            btn.setAttribute('data-id', div.id);
            btn.setAttribute('data-initials', div.name.substring(0, 2).toUpperCase());
            if(window.currentDivisionId === div.id) {
                btn.classList.add('active');
            }
            
            btn.innerHTML = `<span class="div-name">${div.name}</span> <span class="div-count" style="font-size:13px; opacity:0.7; font-family:var(--font-mono);">${div.member_count}</span>`;
            
            btn.onclick = () => window.selectDivision(div.id);
            list.appendChild(btn);
        });
        
        // If current division is not 'all', refresh the user view
        if(window.currentDivisionId && window.currentDivisionId !== 'all') {
            window.selectDivision(window.currentDivisionId);
        }
    }
}

async function getCachedOrFreshUsers() {
    if (Array.isArray(window.lastLoadedUsers) && window.lastLoadedUsers.length > 0) {
        return window.lastLoadedUsers;
    }
    if (Array.isArray(window.allUsersCache) && window.allUsersCache.length > 0) {
        return window.allUsersCache;
    }
    try {
        const res = await fetch('/api/admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
            body: JSON.stringify({ action: 'get_users' })
        });
        const data = await res.json();
        if (data && data.success && Array.isArray(data.users)) {
            window.lastLoadedUsers = data.users;
            window.allUsersCache = data.users;
            return data.users;
        }
    } catch(e) {}
    return [];
}

window.renderAddMemberUserDropdown = function(targetDivId, usersList) {
    const selectUser = document.getElementById('selectMemberUser');
    const showAllCheckbox = document.getElementById('chkShowAllUsersForDivision');
    if (!selectUser) return;

    const users = usersList || window.lastLoadedUsers || window.allUsersCache || [];
    const showAll = showAllCheckbox ? showAllCheckbox.checked : false;

    // Collect all emails already in any division (or in the target division)
    const assignedEmails = new Set();
    const targetDivEmails = new Set();

    if (Array.isArray(window.divisionData)) {
        window.divisionData.forEach(d => {
            if (Array.isArray(d.members)) {
                d.members.forEach(m => {
                    const em = (typeof m === 'string' ? m : m.email || '').toLowerCase();
                    if (em) {
                        assignedEmails.add(em);
                        if (d.id === targetDivId) {
                            targetDivEmails.add(em);
                        }
                    }
                });
            }
        });
    }

    let filteredUsers = users;
    if (!showAll) {
        // Only show users who haven't joined ANY division yet
        filteredUsers = users.filter(u => {
            const email = (u.email || '').toLowerCase();
            const hasDivMeta = !!(u.user_metadata?.division);
            const isAssigned = assignedEmails.has(email);
            return !hasDivMeta && !isAssigned;
        });
    } else {
        // If showAll is checked, only exclude users who are ALREADY in the target division
        filteredUsers = users.filter(u => {
            const email = (u.email || '').toLowerCase();
            const isInTargetDiv = targetDivEmails.has(email);
            const hasTargetDivMeta = (u.user_metadata?.division === targetDivId);
            return !isInTargetDiv && !hasTargetDivMeta;
        });
    }

    selectUser.innerHTML = '';

    if (filteredUsers.length === 0) {
        selectUser.innerHTML = '<option value="">-- Tidak ada user baru (Semua user sudah bergabung divisi) --</option>';
        return;
    }

    selectUser.innerHTML = `<option value="">-- Pilih User (${filteredUsers.length} user belum join) --</option>`;

    // Sort users alphabetically
    const sortedUsers = [...filteredUsers].sort((a, b) => {
        const nameA = (a.user_metadata?.username || a.email || '').toLowerCase();
        const nameB = (b.user_metadata?.username || b.email || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });

    sortedUsers.forEach(u => {
        const username = u.user_metadata?.username || u.email.split('@')[0];
        const currentDiv = u.user_metadata?.division ? ` [Divisi saat ini: ${u.user_metadata.division}]` : '';
        const opt = document.createElement('option');
        opt.value = u.email;
        opt.textContent = `${username} (${u.email})${currentDiv}`;
        selectUser.appendChild(opt);
    });
};

window.promptAddMember = async function(divId) {
    let targetDivId = divId || window.currentDivisionId;
    if (!targetDivId || targetDivId === 'all') targetDivId = 'development';

    const modal = document.getElementById('addDivisionMemberModal');
    const selectUser = document.getElementById('selectMemberUser');
    const selectDiv = document.getElementById('selectMemberDivision');
    const selectRole = document.getElementById('selectMemberRole');
    const showAllCheckbox = document.getElementById('chkShowAllUsersForDivision');

    if (!modal || !selectUser) return;

    if (selectDiv) selectDiv.value = targetDivId;
    if (selectRole) selectRole.value = 'member';
    if (showAllCheckbox) showAllCheckbox.checked = false;

    selectUser.innerHTML = '<option value="">Loading unassigned users...</option>';
    if (window.ModalManager) window.ModalManager.open(modal);
    else modal.classList.add('active');

    // Ensure divisionData is loaded
    if (!window.divisionData && typeof loadDivisions === 'function') {
        await loadDivisions();
    }

    const users = await getCachedOrFreshUsers();
    window.renderAddMemberUserDropdown(targetDivId, users);
};

window.closeAddMemberModal = function() {
    const modal = document.getElementById('addDivisionMemberModal');
    if (!modal) return;
    if (window.ModalManager) window.ModalManager.close(modal);
    else modal.classList.remove('active');
};

window.submitAddMember = async function() {
    const selectUser = document.getElementById('selectMemberUser');
    const selectDiv = document.getElementById('selectMemberDivision');
    const selectRole = document.getElementById('selectMemberRole');

    const email = selectUser ? selectUser.value.trim() : '';
    const divId = selectDiv ? selectDiv.value : 'development';
    const role = selectRole ? selectRole.value : 'member';

    if (!email) return showToast('Pilih user terlebih dahulu', 'error');

    showToast('Assigning member...');
    const res = await apiCall('divisions', {
        action: 'assign_member',
        target_email: email,
        division_id: divId,
        role: role
    });

    if (res && res.success) {
        showToast(`Berhasil menambahkan ${email} ke divisi ${divId} (${role})!`, 'success');
        window.closeAddMemberModal();
        if (typeof loadDivisions === 'function') loadDivisions();
        if (typeof loadUsers === 'function') loadUsers();
    } else {
        showToast('Failed: ' + (res?.error || 'Unknown error'), 'error');
    }
};

window.openManageCoupleModal = async function() {
    const modal = document.getElementById('manageCoupleModal');
    const p1Select = document.getElementById('selectCouplePartner1');
    const p2Select = document.getElementById('selectCouplePartner2');
    const statusText = document.getElementById('coupleCurrentStatusText');

    if (!modal || !p1Select || !p2Select) return;

    p1Select.innerHTML = '<option value="">Loading users...</option>';
    p2Select.innerHTML = '<option value="">Loading users...</option>';

    if (window.ModalManager) window.ModalManager.open(modal);
    else modal.classList.add('active');

    const [users, coupleRes] = await Promise.all([
        getCachedOrFreshUsers(),
        apiCall('contributions', { action: 'get_couple_package' })
    ]);

    const sortedUsers = [...users].sort((a, b) => {
        const nameA = (a.user_metadata?.username || a.email || '').toLowerCase();
        const nameB = (b.user_metadata?.username || b.email || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });

    p1Select.innerHTML = '<option value="">-- Pilih Partner 1 --</option>';
    p2Select.innerHTML = '<option value="">-- Pilih Partner 2 --</option>';

    sortedUsers.forEach(u => {
        const username = u.user_metadata?.username || u.email.split('@')[0];
        const text = `${username} (${u.email})`;

        const opt1 = document.createElement('option');
        opt1.value = u.email;
        opt1.textContent = text;
        p1Select.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = u.email;
        opt2.textContent = text;
        p2Select.appendChild(opt2);
    });

    if (coupleRes && coupleRes.success && Array.isArray(coupleRes.couple) && coupleRes.couple.length >= 2) {
        const p1 = coupleRes.couple[0];
        const p2 = coupleRes.couple[1];
        p1Select.value = p1.email;
        p2Select.value = p2.email;
        if (statusText) statusText.textContent = `${p1.username} (${p1.email}) & ${p2.username} (${p2.email})`;
        const sidebarNames = document.getElementById('coupleSidebarNames');
        if (sidebarNames) sidebarNames.textContent = `${p1.username} & ${p2.username}`;
    } else {
        p1Select.value = '';
        p2Select.value = '';
        if (statusText) statusText.textContent = 'Belum ada couple yang dikonfigurasi';
    }
};

window.closeManageCoupleModal = function() {
    const modal = document.getElementById('manageCoupleModal');
    if (!modal) return;
    if (window.ModalManager) window.ModalManager.close(modal);
    else modal.classList.remove('active');
};

window.saveCouplePackage = async function() {
    const p1Select = document.getElementById('selectCouplePartner1');
    const p2Select = document.getElementById('selectCouplePartner2');

    const email1 = p1Select ? p1Select.value.trim() : '';
    const email2 = p2Select ? p2Select.value.trim() : '';

    if (!email1 || !email2) return showToast('Pilih kedua partner couple', 'error');
    if (email1.toLowerCase() === email2.toLowerCase()) return showToast('Partner 1 dan Partner 2 tidak boleh sama', 'error');

    showToast('Saving couple package...');
    const res = await apiCall('contributions', {
        action: 'set_couple_package',
        partner1_email: email1,
        partner2_email: email2
    });

    if (res && res.success) {
        showToast('Paket Contribution Couple berhasil disimpan!', 'success');
        window.closeManageCoupleModal();
        if (typeof window.loadContributions === 'function') window.loadContributions();
        const sidebarNames = document.getElementById('coupleSidebarNames');
        if (sidebarNames && res.couple) {
            sidebarNames.textContent = `${res.couple[0].username} & ${res.couple[1].username}`;
        }
        const statusText = document.getElementById('coupleCurrentStatusText');
        if (statusText && res.couple) {
            statusText.textContent = `${res.couple[0].username} (${res.couple[0].email}) & ${res.couple[1].username} (${res.couple[1].email})`;
        }
    } else {
        showToast('Failed: ' + (res?.error || 'Unknown error'), 'error');
    }
};

window.unlinkCouplePackage = async function() {
    if (!await customConfirm('Apakah Anda yakin ingin memisahkan (unlink) akun couple ini?')) return;
    showToast('Unlinking couple package...');
    const res = await apiCall('contributions', {
        action: 'set_couple_package',
        unlink: true
    });

    if (res && res.success) {
        showToast('Couple package unlinked', 'success');
        window.closeManageCoupleModal();
        if (typeof window.loadContributions === 'function') window.loadContributions();
        const sidebarNames = document.getElementById('coupleSidebarNames');
        if (sidebarNames) sidebarNames.textContent = 'None (Unlinked)';
        const statusText = document.getElementById('coupleCurrentStatusText');
        if (statusText) statusText.textContent = 'Belum ada couple yang dikonfigurasi';
    } else {
        showToast('Failed: ' + (res?.error || 'Unknown error'), 'error');
    }
};

window.removeMember = async function(email, divId) {
    if(!await customConfirm('Remove ' + email + ' from this division?')) return;
    showToast('Removing...');
    const res = await apiCall('divisions', { action: 'remove_member', target_email: email, division_id: divId });
    if(res && res.success) { 
        showToast('Removed successfully!', 'success'); 
        loadDivisions(); 
    } else { 
        showToast('Failed: ' + (res?.error || 'Unknown error'), 'error'); 
    }
};

// =======================
// CONTRIBUTIONS
// =======================
window.loadContributions = async function() {
    window.contributionsLoaded = true;
    const resMe = await apiCall('contributions', { action: 'get_my_contributions' });
    if(resMe.success) {
        const total = resMe.contributions.reduce((sum, c) => sum + c.points, 0);
        const myPointsEl = document.getElementById('myPoints');
        if (myPointsEl) {
            myPointsEl.textContent = total;
        if (resMe.is_couple || resMe.couple_package) {
                myPointsEl.title = resMe.couple_package || 'Couple Package Active';
            }
        }
        
        // check 30 days
        const hasRecent = resMe.contributions.some(c => {
            const cd = parseSafeDate(c.created_at);
            return cd && cd.getTime() > (Date.now() - 30 * 24 * 60 * 60 * 1000);
        });
        const statusEl = document.getElementById('contributionStatus');
        const isCouple = resMe.is_couple || resMe.couple_package;
        if(hasRecent || isAdminUser) {
            statusEl.innerHTML = isCouple 
                ? '<span style="font-weight:bold; color:var(--text-main);">💑 Couple Package Active (Access Granted)</span>' 
                : 'Active Contributor (Access Granted)';
            statusEl.style.color = 'var(--text-main)';
        } else {
            statusEl.textContent = isCouple
                ? '💑 Couple Inactive for 30 days (Access Revoked)'
                : 'Inactive for 30 days (Access Revoked)';
            statusEl.style.color = 'var(--danger)';
        }
    } else {
        console.error('Failed to get contributions:', resMe);
        showToast('Error getting contributions: ' + (resMe.error || 'Unknown'), 'error');
    }

    const resLeader = await apiCall('contributions', { action: 'get_leaderboard' });
    if(resLeader.success) {
        const list = document.getElementById('leaderboardList');
        list.innerHTML = '';
        if(!resLeader.leaderboard || resLeader.leaderboard.length === 0) {
            list.innerHTML = '<li style="padding:16px 24px; text-align:center; color:var(--text-muted); font-size:13px;">Belum ada kontributor dengan poin.</li>';
        } else {
            resLeader.leaderboard.forEach((u, i) => {
                const medal = i === 0 ? '1st' : (i === 1 ? '2nd' : (i === 2 ? '3rd' : `${i+1}.`));
                const coupleBadge = u.is_couple ? ` <span style="font-size:12px; vertical-align:middle;" title="${u.couple_label || 'Couple Package'}">💑</span>` : '';
                list.innerHTML += `
                    <li style="display:flex; justify-content:space-between; padding:12px 24px; border-bottom:1px solid var(--border-light); align-items:center; gap:12px; min-width:0;">
                        <div style="display:flex; gap:16px; align-items:center; min-width:0; flex:1;">
                            <span style="font-size:16px; font-weight:600; width:24px; flex-shrink:0;">${medal}</span>
                            <span style="font-size:14px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${u.username || u.email.split('@')[0]}${coupleBadge}</span>
                        </div>
                        <div style="font-weight:700; color:var(--accent); flex-shrink:0;">${u.points} pts</div>
                    </li>
                `;
            });
        }
    } else {
        console.error('Failed to get leaderboard:', resLeader);
        showToast('Error getting leaderboard: ' + (resLeader.error || 'Unknown'), 'error');
    }
}

// =======================
// CBT REVIEW SCRAPPER
// =======================
// CBT Review - bound inside the main DOMContentLoaded at line 6
// (listeners merged into the main DOMContentLoaded above)
document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.tab[data-target="viewDashboard"]')?.addEventListener('click', () => {
        window.loadContributions();
    });
    
    document.getElementById('btnLoadReviewFile')?.addEventListener('click', async () => {
        const pathEl = document.getElementById('reviewFilePath');
        if(!pathEl) return showToast('Review panel not available', 'error');
        const path = pathEl.value.trim();
        if(!path) return showToast('Please enter a file path', 'error');

        showToast('Fetching HTML from GitHub...');
        // We reuse the existing adminAction 'download' from admin.js to get the file
        // To do this we have to fetch directly via our own custom call because adminAction is not exported
        const res = await fetch('/api/admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
            body: JSON.stringify({ action: 'download', path })
        });
        const data = await res.json();
        if(data.success) {
            parseCBTHtml(path, data.content);
        } else {
            showToast('Failed to load: ' + data.error, 'error');
        }
    });
});

let currentReviewContent = '';
let currentReviewPath = '';
let parsedQuestions = [];

function parseCBTHtml(path, html) {
    currentReviewContent = html;
    currentReviewPath = path;
    parsedQuestions = [];

    const fileNameEl = document.getElementById('reviewFileName');
    if (fileNameEl) fileNameEl.textContent = path.split('/').pop();
    const editorAreaEl = document.getElementById('reviewEditorArea');
    if (editorAreaEl) editorAreaEl.style.display = 'flex';
    const listEl = document.getElementById('reviewQuestionsList');
    if (listEl) listEl.innerHTML = '';

    // A simple regex parser for CBT structure
    // Assumes structure: <div class="soal">...</div>, <div class="pilihan">...</div>, dll.
    // If the HTML is complex, we use a DOM parser.
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Trying to find standard question blocks. Usually encapsulated in cards or lists.
    // Let's look for elements that have text matching "Soal" or input radios.
    const questions = doc.querySelectorAll('.soal, [class*="question"]');
    
    if(questions.length === 0) {
        if (listEl) listEl.innerHTML = '<div style="padding:16px; background:transparent; color:var(--danger); border:1.5px solid var(--danger); border-radius:var(--radius-card);">No standard question blocks found. This scrapper supports specific CBT HTML formats. You can still use the raw HTML editor in the Files tab.</div>';
        return;
    }

    showToast(`Found ${questions.length} questions`);
    
    // For each container, render a minimal editor block.
    // (In a full implementation, we would extract exact text, bind to inputs, and rebuild HTML on save.
    // Since the actual format is unknown, we will provide a raw HTML block editor per question for the reviewer).
    
    questions.forEach((q, idx) => {
        if (listEl) {
            const block = document.createElement('div');
            block.className = 'review-question-card';
            block.style.cssText = 'background:var(--bg-main); padding:16px; border-radius:var(--radius-card); border:var(--border-main);';
            
            block.innerHTML = `
                <div style="font-weight:bold; margin-bottom:8px;">Soal #${idx + 1}</div>
                <textarea id="q_edit_${idx}" class="auth-input" style="width:100%; height:120px; font-family:var(--font-mono); font-size:12px; margin-bottom:8px;">${q.outerHTML}</textarea>
                <button class="btn-unified xs danger btn-report-issue">Report Issue</button>
            `;

            block.querySelector('.btn-report-issue').addEventListener('click', async () => {
                const desc = await customPrompt(`Report issue for Question #${idx + 1}:`);
                if(!desc) return;
                const r = await apiCall('admin', {
                    action: 'report_issue',
                    task_id: window.currentReviewTaskId || 'manual',
                    issue_type: 'content_error',
                    question_index: idx + 1,
                    description: desc
                });
                if(r.success) showToast('Issue reported!', 'success');
                else showToast('Failed: ' + r.error, 'error');
            });

            listEl.appendChild(block);
        }
        parsedQuestions.push({ node: q, idx });
    });

    const btnSave = document.getElementById('btnSaveReview');
    if (btnSave) {
        btnSave.onclick = async () => {
            parsedQuestions.forEach(pq => {
                const editEl = document.getElementById(`q_edit_${pq.idx}`);
                if (!editEl) return;
                const newHtml = editEl.value;
                const temp = document.createElement('div');
                temp.innerHTML = newHtml;
                if(temp.firstElementChild) {
                    pq.node.replaceWith(temp.firstElementChild);
                }
            });

            const finalHtml = doc.documentElement.outerHTML;
            const base64 = utf8ToBase64(finalHtml);

            showToast('Saving to GitHub...');
            const res = await fetch('/api/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
                body: JSON.stringify({ action: 'upload', path: currentReviewPath, contentBase64: base64 })
            });
            const data = await res.json();
            if(data.success) {
                showToast('Saved successfully!', 'success');
            } else {
                showToast('Save failed: ' + data.error, 'error');
            }
        };
    }
}
