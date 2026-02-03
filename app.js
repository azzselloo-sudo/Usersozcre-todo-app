const todoInput = document.getElementById('todo-input');
const addBtn = document.getElementById('add-btn');
const todoList = document.getElementById('todo-list');

// 할 일 추가
function addTodo() {
    const text = todoInput.value.trim();

    if (!text) {
        return;
    }

    const li = document.createElement('li');
    li.className = 'todo-item';

    li.innerHTML = `
        <input type="checkbox">
        <span>${text}</span>
        <button class="delete-btn">삭제</button>
    `;

    // 완료 체크 이벤트
    const checkbox = li.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', function() {
        li.classList.toggle('completed', this.checked);
    });

    // 삭제 버튼 이벤트
    const deleteBtn = li.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', function() {
        li.remove();
    });

    todoList.appendChild(li);
    todoInput.value = '';
    todoInput.focus();
}

// 추가 버튼 클릭
addBtn.addEventListener('click', addTodo);

// Enter 키로 추가
todoInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        addTodo();
    }
});
