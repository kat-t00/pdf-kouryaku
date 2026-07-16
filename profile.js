// 入力単語リスト：氏名・主治医名・医療機関名など、様式をまたいで使い回したい値を項目名ごとに
// 複数ストックしておき、入力・出力モードで都度どれを使うか選べるようにする画面
const Profile = (() => {
  const listEl = document.getElementById('profileList');
  const emptyEl = document.getElementById('profileEmpty');
  const addBtn = document.getElementById('profileAddBtn');
  const expandedLabels = new Set(); // どの項目名を開いているか（render()をまたいで維持する）

  // 項目名ごとに折りたたんで表示する（登録が増えるとページが際限なく縦に伸びて探しにくくなるため）。
  // ブラウザ標準の<details>を使うと、開閉状態の管理・キーボード操作対応が自前実装なしで手に入る。
  // render()は候補の追加・削除のたびに全体を作り直すため、開閉状態は別途expandedLabelsで覚えておき、
  // 作り直した後も開いていた項目が閉じてしまわないようにしている
  function render() {
    const data = ProfileStore.getAll();
    const labels = Object.keys(data);
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', labels.length > 0);
    labels.forEach(label => {
      const values = data[label] || [];
      const li = document.createElement('li');
      li.className = 'word-list-group';

      const details = document.createElement('details');
      details.open = expandedLabels.has(label);
      details.addEventListener('toggle', () => {
        if (details.open) expandedLabels.add(label);
        else expandedLabels.delete(label);
      });
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="word-list-label-text">${escapeHtml(label)}</span><span class="word-list-count">${values.length}件</span>`;
      details.appendChild(summary);

      const valuesEl = document.createElement('div');
      valuesEl.className = 'word-list-values';
      values.forEach(value => {
        const chip = document.createElement('span');
        chip.className = 'word-chip';
        chip.textContent = value;
        const chipDel = document.createElement('span');
        chipDel.className = 'word-chip-del';
        chipDel.textContent = '×';
        chipDel.title = 'この候補を削除';
        chipDel.addEventListener('click', () => {
          ProfileStore.removeCandidate(label, value);
          render();
        });
        chip.appendChild(chipDel);
        valuesEl.appendChild(chip);
      });
      details.appendChild(valuesEl);

      const addRow = document.createElement('div');
      addRow.className = 'word-list-add-row';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = '新しい候補を追加';
      const addValueBtn = document.createElement('button');
      addValueBtn.className = 'btn-outline';
      addValueBtn.textContent = '＋追加';
      function addValue() {
        const v = addInput.value.trim();
        if (!v) return;
        ProfileStore.addCandidate(label, v);
        addInput.value = '';
        render();
      }
      addValueBtn.addEventListener('click', addValue);
      addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addValue(); });
      addRow.appendChild(addInput);
      addRow.appendChild(addValueBtn);
      details.appendChild(addRow);

      const delLabelBtn = document.createElement('button');
      delLabelBtn.className = 'btn-danger';
      delLabelBtn.textContent = 'この項目名ごと削除';
      delLabelBtn.style.marginTop = '8px';
      delLabelBtn.addEventListener('click', () => {
        if (!confirm(`「${label}」の候補をすべて削除しますか？`)) return;
        ProfileStore.removeLabel(label);
        render();
      });
      details.appendChild(delLabelBtn);

      li.appendChild(details);
      listEl.appendChild(li);
    });
  }

  function openNewLabelModal() {
    // 項目名は1から手打ちさせず、これまでテンプレートで実際に使った項目名を候補として出す
    // （入力候補＝datalist。一覧にない新しい項目名を自由に入力することもできる）
    const knownLabels = TemplateStore.listAllTextFieldLabels();
    const datalistOptions = knownLabels.map(l => `<option value="${escapeHtml(l)}">`).join('');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-box">
        <h3>項目を追加</h3>
        <label>項目名（テンプレートで使っている項目名から選べます。一覧にない名前も入力できます）</label>
        <input type="text" id="profileLabelInput" list="profileLabelSuggestions" placeholder="例：主治医名" autocomplete="off">
        <datalist id="profileLabelSuggestions">${datalistOptions}</datalist>
        <label>候補となる値（例：山田医師）</label>
        <input type="text" id="profileValueInput" placeholder="例：山田医師">
        <div class="modal-actions">
          <button class="btn-outline" id="profileCancelBtn">キャンセル</button>
          <button class="btn-primary" id="profileOkBtn">追加</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const labelInput = backdrop.querySelector('#profileLabelInput');
    const valueInput = backdrop.querySelector('#profileValueInput');
    labelInput.focus();

    function close() {
      document.body.removeChild(backdrop);
    }
    backdrop.querySelector('#profileCancelBtn').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('#profileOkBtn').addEventListener('click', () => {
      const label = labelInput.value.trim();
      const value = valueInput.value.trim();
      if (!label) { labelInput.focus(); return; }
      ProfileStore.addCandidate(label, value);
      close();
      render();
    });
    valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') backdrop.querySelector('#profileOkBtn').click();
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  addBtn.addEventListener('click', openNewLabelModal);

  function init() {
    render();
  }

  return { init, render };
})();
