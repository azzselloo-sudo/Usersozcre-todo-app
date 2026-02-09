// === Firebase References ===
const auth = firebase.auth();
const db = firebase.firestore();

// Enable offline persistence
db.enablePersistence().catch(err => {
    if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence: multiple tabs open');
    } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence: not supported');
    }
});

// === State ===
let todos = [];
let categories = [];
let selectedCategory = '';
let currentUser = null;
let unsubTodos = null;
let unsubCategories = null;

// Calendar state
const now = new Date();
let calYear = now.getFullYear();
let calMonth = now.getMonth();
let calSelectedDate = null;

// === DOM ===
const authScreen = document.getElementById('auth-screen');
const appContainer = document.getElementById('app-container');
const googleLoginBtn = document.getElementById('google-login-btn');
const authError = document.getElementById('auth-error');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout-btn');
const todoInput = document.getElementById('todo-input');
const addBtn = document.getElementById('add-btn');
const categoryInput = document.getElementById('category-input');
const categoryChips = document.getElementById('category-chips');
const filterCategory = document.getElementById('filter-category');
const todoList = document.getElementById('todo-list');
const emptyMsg = document.getElementById('empty-msg');
const prevMonthBtn = document.getElementById('prev-month');
const nextMonthBtn = document.getElementById('next-month');
const calMonthLabel = document.getElementById('cal-month-label');
const calDays = document.getElementById('cal-days');
const calDetail = document.getElementById('cal-detail');
const calDetailTitle = document.getElementById('cal-detail-title');
const calDetailList = document.getElementById('cal-detail-list');

// === Firestore Helpers ===
function userTodosRef() {
    return db.collection('users').doc(currentUser.uid).collection('todos');
}

function userCategoriesRef() {
    return db.collection('users').doc(currentUser.uid).collection('meta').doc('categories');
}

// === Helpers ===
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateKr(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${weekdays[d.getDay()]})`;
}

function isOverdue(deadline) {
    return deadline && deadline < todayStr();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// === Auth Functions ===
function isMobile() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function signInWithGoogle() {
    authError.textContent = '';
    const provider = new firebase.auth.GoogleAuthProvider();
    if (isMobile()) {
        auth.signInWithRedirect(provider);
    } else {
        auth.signInWithPopup(provider).catch(err => {
            console.error('Login error:', err);
            if (err.code === 'auth/popup-closed-by-user') {
                authError.textContent = '로그인이 취소되었습니다';
            } else if (err.code === 'auth/popup-blocked') {
                auth.signInWithRedirect(provider);
            } else {
                authError.textContent = '로그인 실패: ' + err.message;
            }
        });
    }
}

function signOutUser() {
    auth.signOut().catch(err => {
        console.error('Logout error:', err);
    });
}

// === Auth Events ===
googleLoginBtn.addEventListener('click', signInWithGoogle);
logoutBtn.addEventListener('click', signOutUser);

// Handle redirect result (mobile Google login)
auth.getRedirectResult().catch(err => {
    console.error('Redirect login error:', err);
    if (err.code !== 'auth/popup-closed-by-user') {
        authError.textContent = '로그인 실패: ' + err.message;
    }
});

// === Auth State Observer ===
auth.onAuthStateChanged(async user => {
    if (user) {
        currentUser = user;

        // Update user bar
        userAvatar.src = user.photoURL || '';
        userName.textContent = user.displayName || user.email;

        // Show app, hide auth
        authScreen.style.display = 'none';
        appContainer.style.display = '';

        // Migrate localStorage data if needed
        await migrateLocalStorage(user.uid);

        // Load initial data
        await loadFromFirestore(user.uid);

        // Render
        renderCategoryChips();
        renderFilterOptions();
        render();

        // Start real-time listeners
        startRealtimeListeners(user.uid);
    } else {
        currentUser = null;

        // Stop listeners
        stopRealtimeListeners();

        // Clear state
        todos = [];
        categories = [];
        selectedCategory = '';

        // Show auth, hide app
        authScreen.style.display = '';
        appContainer.style.display = 'none';
    }
});

// === localStorage → Firestore Migration ===
async function migrateLocalStorage(uid) {
    const localTodos = localStorage.getItem('todos');
    const localCategories = localStorage.getItem('categories');

    if (!localTodos && !localCategories) return;

    const parsedTodos = localTodos ? JSON.parse(localTodos) : [];
    const parsedCategories = localCategories ? JSON.parse(localCategories) : [];

    if (parsedTodos.length === 0 && parsedCategories.length === 0) return;

    // Check if Firestore already has data (skip if so)
    const snapshot = await userTodosRef().limit(1).get();
    if (!snapshot.empty) {
        // Firestore already has data, just clean up localStorage
        localStorage.removeItem('todos');
        localStorage.removeItem('categories');
        return;
    }

    // Batch write todos
    const batch = db.batch();

    parsedTodos.forEach(todo => {
        const ref = userTodosRef().doc(todo.id);
        batch.set(ref, {
            id: todo.id,
            text: todo.text,
            category: todo.category || '',
            deadline: todo.deadline || null,
            completed: !!todo.completed,
            completedAt: todo.completedAt || null,
            createdAt: todo.createdAt || new Date().toISOString()
        });
    });

    if (parsedCategories.length > 0) {
        batch.set(userCategoriesRef(), { list: parsedCategories });
    }

    await batch.commit();

    // Clean up localStorage
    localStorage.removeItem('todos');
    localStorage.removeItem('categories');
}

// === Firestore Load ===
async function loadFromFirestore(uid) {
    // Load todos
    const todosSnap = await userTodosRef().get();
    todos = todosSnap.docs.map(doc => doc.data());

    // Load categories
    const catSnap = await userCategoriesRef().get();
    if (catSnap.exists) {
        categories = catSnap.data().list || [];
    } else {
        categories = [];
    }
}

// === Real-time Listeners ===
function startRealtimeListeners(uid) {
    stopRealtimeListeners();

    unsubTodos = userTodosRef().onSnapshot(snapshot => {
        todos = snapshot.docs.map(doc => doc.data());
        render();
    });

    unsubCategories = userCategoriesRef().onSnapshot(doc => {
        if (doc.exists) {
            categories = doc.data().list || [];
        } else {
            categories = [];
        }
        renderCategoryChips();
        renderFilterOptions();
    });
}

function stopRealtimeListeners() {
    if (unsubTodos) { unsubTodos(); unsubTodos = null; }
    if (unsubCategories) { unsubCategories(); unsubCategories = null; }
}

// === Firestore Save Helpers ===
function saveCategories() {
    if (!currentUser) return;
    userCategoriesRef().set({ list: categories }).catch(err => {
        console.error('Failed to save categories:', err);
    });
}

// === Category Management ===
function ensureCategory(name) {
    if (!name || categories.includes(name)) return;
    categories.push(name);
    saveCategories();
    renderCategoryChips();
    renderFilterOptions();
}

function deleteCategory(name) {
    categories = categories.filter(c => c !== name);
    if (selectedCategory === name) {
        selectedCategory = '';
        categoryInput.value = '';
    }
    saveCategories();
    renderCategoryChips();
    renderFilterOptions();
}

function renderCategoryChips() {
    categoryChips.innerHTML = '';
    categories.forEach(cat => {
        const chip = document.createElement('span');
        chip.className = 'chip' + (selectedCategory === cat ? ' active' : '');

        const label = document.createElement('span');
        label.textContent = cat;

        const x = document.createElement('span');
        x.className = 'chip-x';
        x.textContent = '\u00d7';
        x.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCategory(cat);
        });

        chip.appendChild(label);
        chip.appendChild(x);

        chip.addEventListener('click', () => {
            if (selectedCategory === cat) {
                selectedCategory = '';
                categoryInput.value = '';
            } else {
                selectedCategory = cat;
                categoryInput.value = cat;
            }
            renderCategoryChips();
        });

        categoryChips.appendChild(chip);
    });
}

function renderFilterOptions() {
    const val = filterCategory.value;
    filterCategory.innerHTML = '<option value="">전체 카테고리</option>' +
        categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    filterCategory.value = val;
}

// === Todo CRUD (Firestore) ===
function addTodo() {
    const text = todoInput.value.trim();
    if (!text || !currentUser) return;

    const catName = categoryInput.value.trim() || selectedCategory;
    if (catName) ensureCategory(catName);

    const todo = {
        id: generateId(),
        text: text,
        category: catName,
        deadline: null,
        completed: false,
        completedAt: null,
        createdAt: new Date().toISOString()
    };

    // Optimistic update
    todos.push(todo);
    render();

    todoInput.value = '';
    todoInput.focus();

    // Firestore write
    userTodosRef().doc(todo.id).set(todo).catch(err => {
        console.error('Failed to add todo:', err);
        // Rollback
        todos = todos.filter(t => t.id !== todo.id);
        render();
    });
}

function toggleTodo(id) {
    const todo = todos.find(t => t.id === id);
    if (!todo || !currentUser) return;

    // Optimistic update
    const prevCompleted = todo.completed;
    const prevCompletedAt = todo.completedAt;
    todo.completed = !todo.completed;
    todo.completedAt = todo.completed ? new Date().toISOString() : null;
    render();

    // Firestore write
    userTodosRef().doc(id).update({
        completed: todo.completed,
        completedAt: todo.completedAt
    }).catch(err => {
        console.error('Failed to toggle todo:', err);
        // Rollback
        todo.completed = prevCompleted;
        todo.completedAt = prevCompletedAt;
        render();
    });
}

function deleteTodo(id) {
    if (!currentUser) return;

    // Optimistic update
    const removed = todos.find(t => t.id === id);
    todos = todos.filter(t => t.id !== id);
    render();

    // Firestore write
    userTodosRef().doc(id).delete().catch(err => {
        console.error('Failed to delete todo:', err);
        // Rollback
        if (removed) {
            todos.push(removed);
            render();
        }
    });
}

function updateDeadline(id, newDeadline) {
    const todo = todos.find(t => t.id === id);
    if (!todo || !currentUser) return;

    // Optimistic update
    const prevDeadline = todo.deadline;
    todo.deadline = newDeadline || null;
    render();

    // Firestore write
    userTodosRef().doc(id).update({
        deadline: todo.deadline
    }).catch(err => {
        console.error('Failed to update deadline:', err);
        // Rollback
        todo.deadline = prevDeadline;
        render();
    });
}

// === Render ===
function render() {
    renderList();
    if (document.getElementById('calendar-view').classList.contains('active')) {
        renderCalendar();
    }
}

// === List View ===
function renderList() {
    todoList.innerHTML = '';
    const filter = filterCategory.value;
    const pending = todos.filter(t => {
        if (t.completed) return false;
        if (filter && t.category !== filter) return false;
        return true;
    });

    if (pending.length === 0) {
        emptyMsg.style.display = 'block';
    } else {
        emptyMsg.style.display = 'none';
        pending.forEach(todo => {
            todoList.appendChild(createTodoElement(todo));
        });
    }
}

function createTodoElement(todo) {
    const li = document.createElement('li');
    li.className = 'todo-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.completed;
    checkbox.addEventListener('change', () => toggleTodo(todo.id));

    const content = document.createElement('div');
    content.className = 'todo-content';

    const textDiv = document.createElement('div');
    textDiv.className = 'todo-text';
    textDiv.textContent = todo.text;

    const meta = document.createElement('div');
    meta.className = 'todo-meta';

    if (todo.category) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-category';
        badge.textContent = todo.category;
        meta.appendChild(badge);
    }

    if (todo.deadline) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-deadline';
        if (!todo.completed && isOverdue(todo.deadline)) {
            badge.classList.add('overdue');
            badge.textContent = '기한초과 ' + todo.deadline;
        } else {
            badge.textContent = '마감 ' + todo.deadline;
        }
        badge.title = '클릭하여 변경';
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            showInlineDeadline(todo.id, meta);
        });
        meta.appendChild(badge);
    }

    content.appendChild(textDiv);
    content.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    if (!todo.deadline) {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn-sm btn-deadline';
        dlBtn.textContent = '마감일';
        dlBtn.addEventListener('click', () => showInlineDeadline(todo.id, meta));
        actions.appendChild(dlBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-sm btn-delete';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => deleteTodo(todo.id));
    actions.appendChild(delBtn);

    li.appendChild(checkbox);
    li.appendChild(content);
    li.appendChild(actions);

    return li;
}

function showInlineDeadline(todoId, metaEl) {
    if (metaEl.querySelector('.inline-date-input')) return;

    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'inline-date-input';
    input.value = todo.deadline || '';

    input.addEventListener('change', () => {
        updateDeadline(todoId, input.value);
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (metaEl.contains(input)) {
                metaEl.removeChild(input);
            }
        }, 250);
    });

    metaEl.appendChild(input);
    input.focus();
    try { input.showPicker(); } catch (e) { /* ok */ }
}

// === Calendar View ===
function renderCalendar() {
    calMonthLabel.textContent = `${calYear}년 ${calMonth + 1}월`;
    calDays.innerHTML = '';

    const firstDay = new Date(calYear, calMonth, 1);
    const lastDay = new Date(calYear, calMonth + 1, 0);
    const startDow = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    const today = todayStr();

    // Previous month padding
    const prevLastDay = new Date(calYear, calMonth, 0).getDate();
    for (let i = startDow - 1; i >= 0; i--) {
        const day = document.createElement('div');
        day.className = 'cal-day other-month';
        const num = document.createElement('span');
        num.className = 'cal-day-num';
        num.textContent = prevLastDay - i;
        day.appendChild(num);
        calDays.appendChild(day);
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const day = document.createElement('div');
        day.className = 'cal-day';

        if (dateStr === today) day.classList.add('today');
        if (dateStr === calSelectedDate) day.classList.add('selected');

        const num = document.createElement('span');
        num.className = 'cal-day-num';
        num.textContent = d;
        day.appendChild(num);

        // Collect events for this day
        const dayDeadlines = todos.filter(t => t.deadline === dateStr);
        const dayCompleted = todos.filter(t => t.completed && formatDate(t.completedAt) === dateStr);

        // Build preview items: deadline first, then completed
        const previews = [];
        dayDeadlines.forEach(t => previews.push({ text: t.text, type: 'deadline' }));
        dayCompleted.forEach(t => previews.push({ text: t.text, type: 'completed' }));

        const maxShow = 2;
        const shown = previews.slice(0, maxShow);
        const remaining = previews.length - shown.length;

        shown.forEach(item => {
            const preview = document.createElement('div');
            preview.className = 'cal-preview cal-preview-' + item.type;
            preview.textContent = item.text;
            day.appendChild(preview);
        });

        if (remaining > 0) {
            const more = document.createElement('div');
            more.className = 'cal-preview-more';
            more.textContent = '+' + remaining;
            day.appendChild(more);
        }

        day.addEventListener('click', () => {
            calSelectedDate = calSelectedDate === dateStr ? null : dateStr;
            renderCalendar();
        });

        calDays.appendChild(day);
    }

    // Next month padding
    const totalCells = startDow + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const day = document.createElement('div');
        day.className = 'cal-day other-month';
        const num = document.createElement('span');
        num.className = 'cal-day-num';
        num.textContent = i;
        day.appendChild(num);
        calDays.appendChild(day);
    }

    // Detail panel
    if (calSelectedDate) {
        renderCalDetail(calSelectedDate);
    } else {
        calDetail.style.display = 'none';
    }
}

function renderCalDetail(dateStr) {
    const deadlineItems = todos.filter(t => t.deadline === dateStr);
    const completedItems = todos.filter(t => t.completed && formatDate(t.completedAt) === dateStr);

    if (deadlineItems.length === 0 && completedItems.length === 0) {
        calDetail.style.display = 'block';
        calDetailTitle.textContent = formatDateKr(dateStr);
        calDetailList.innerHTML = '<li class="cal-empty">이 날짜에 항목이 없습니다</li>';
        return;
    }

    calDetail.style.display = 'block';
    calDetailTitle.textContent = formatDateKr(dateStr);
    calDetailList.innerHTML = '';

    if (deadlineItems.length > 0) {
        const header = document.createElement('li');
        header.className = 'cal-section-header cal-section-header-deadline';
        header.textContent = '마감 (' + deadlineItems.length + ')';
        calDetailList.appendChild(header);

        deadlineItems.forEach(todo => {
            const item = document.createElement('li');
            item.className = 'cal-item' + (todo.completed ? ' done' : '');

            const text = document.createElement('span');
            text.className = 'cal-item-text';
            text.textContent = todo.text;
            item.appendChild(text);

            if (todo.category) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-category';
                badge.textContent = todo.category;
                item.appendChild(badge);
            }

            if (todo.completed) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-completed';
                badge.textContent = '완료';
                item.appendChild(badge);
            } else if (isOverdue(todo.deadline)) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-deadline overdue';
                badge.textContent = '기한초과';
                item.appendChild(badge);
            }

            calDetailList.appendChild(item);
        });
    }

    if (completedItems.length > 0) {
        const header = document.createElement('li');
        header.className = 'cal-section-header cal-section-header-completed';
        header.textContent = '완료 (' + completedItems.length + ')';
        calDetailList.appendChild(header);

        completedItems.forEach(todo => {
            const item = document.createElement('li');
            item.className = 'cal-item done';

            const text = document.createElement('span');
            text.className = 'cal-item-text';
            text.textContent = todo.text;
            item.appendChild(text);

            if (todo.category) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-category';
                badge.textContent = todo.category;
                item.appendChild(badge);
            }

            calDetailList.appendChild(item);
        });
    }
}

// === View Toggle ===
document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.view + '-view').classList.add('active');

        if (btn.dataset.view === 'calendar') {
            renderCalendar();
        }
    });
});

// === Events ===
addBtn.addEventListener('click', addTodo);
todoInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') addTodo();
});

categoryInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') {
        const name = categoryInput.value.trim();
        if (name) {
            ensureCategory(name);
            selectedCategory = name;
            renderCategoryChips();
        }
    }
});

categoryInput.addEventListener('input', () => {
    const val = categoryInput.value.trim();
    if (categories.includes(val)) {
        selectedCategory = val;
    } else {
        selectedCategory = '';
    }
    renderCategoryChips();
});

filterCategory.addEventListener('change', renderList);

prevMonthBtn.addEventListener('click', () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    calSelectedDate = null;
    renderCalendar();
});

nextMonthBtn.addEventListener('click', () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    calSelectedDate = null;
    renderCalendar();
});
