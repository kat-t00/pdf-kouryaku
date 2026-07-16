// モード切り替え（テンプレート作成 ⇄ 入力・出力）と初期化
(function () {
  const tabs = document.querySelectorAll('.mode-tab[data-mode]'); // ヘルプボタンはタブではないのでdata-mode指定のもののみ対象にする
  const sections = {
    editor: document.getElementById('modeEditor'),
    filler: document.getElementById('modeFiller'),
    correction: document.getElementById('modeCorrection'),
    profile: document.getElementById('modeProfile'),
  };

  let currentMode = 'editor';

  function switchTo(mode, tab) {
    currentMode = mode;
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Object.keys(sections).forEach(key => {
      sections[key].classList.toggle('hidden', key !== mode);
    });
    if (mode === 'filler') Filler.refreshTemplateOptions();
    if (mode === 'profile') Profile.render();
  }

  // 「自動保存＝正式なテンプレート保存」と誤解しやすいので、未保存の変更を残したまま
  // テンプレート作成タブを離れようとしたら、ここで一度確認する（その場で保存もできるようにする）
  function showUnsavedChangesModal(onDiscard) {
    const realNameInput = document.getElementById('templateNameInput');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-box modal-box-wide">
        <h3>テンプレートが未保存です</h3>
        <p style="font-size:13px;color:#6b7a90;line-height:1.6;margin:0 0 4px;">
          自動保存はブラウザを閉じた時の復旧用の下書きで、テンプレート一覧への正式な保存とは別物です。<br>
          このまま移動すると、今の変更は「入力・出力」タブではまだ使えません。
        </p>
        <label>テンプレート名</label>
        <input type="text" id="unsavedNameInput" placeholder="例：〇〇市 要介護認定申請書">
        <div id="unsavedModalError" style="font-size:12px;color:#d9534f;margin-top:4px;"></div>
        <div class="modal-actions modal-actions-stack">
          <button class="btn-primary" id="unsavedSaveBtn">今すぐ保存して移動</button>
          <button class="btn-outline" id="unsavedDiscardBtn">保存せず移動</button>
          <button class="btn-outline" id="unsavedCancelBtn">キャンセル</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const nameInEl = backdrop.querySelector('#unsavedNameInput');
    const errorEl = backdrop.querySelector('#unsavedModalError');
    nameInEl.value = realNameInput.value;
    nameInEl.focus();

    function close() {
      document.body.removeChild(backdrop);
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('#unsavedCancelBtn').addEventListener('click', close);
    backdrop.querySelector('#unsavedDiscardBtn').addEventListener('click', () => {
      close();
      onDiscard();
    });
    backdrop.querySelector('#unsavedSaveBtn').addEventListener('click', () => {
      const name = nameInEl.value.trim();
      if (!name) { errorEl.textContent = 'テンプレート名を入力してください'; nameInEl.focus(); return; }
      realNameInput.value = name;
      const saved = Editor.saveTemplate();
      if (saved) {
        close();
        onDiscard();
      } else {
        errorEl.textContent = '保存に失敗しました（PDFが読み込まれているか確認してください）';
      }
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (currentMode === 'editor' && mode !== 'editor' && Editor.hasUnsavedChanges()) {
        showUnsavedChangesModal(() => switchTo(mode, tab));
        return;
      }
      switchTo(mode, tab);
    });
  });

  const usageGuideModal = document.getElementById('usageGuideModal');
  document.getElementById('usageGuideBtn').addEventListener('click', () => {
    usageGuideModal.classList.remove('hidden');
  });
  document.getElementById('usageGuideCloseBtn').addEventListener('click', () => {
    usageGuideModal.classList.add('hidden');
  });
  usageGuideModal.addEventListener('click', (e) => {
    if (e.target === usageGuideModal) usageGuideModal.classList.add('hidden');
  });

  Editor.init();
  Filler.init();
  Correction.init();
  Profile.init();
})();
