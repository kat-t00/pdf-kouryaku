// テンプレート作成モード：PDFを読み込み、ドラッグで範囲を指定して入力項目として登録する
// 「被保険者番号」のような1文字ずつマス目が分かれた項目にも対応（マス目タイプ）
const Editor = (() => {
  let pdfDoc = null;
  let originalArrayBuffer = null; // テンプレート保存用に手元に残しておく元データ
  let pageNumber = 1;
  let pageCount = 1;
  let pagesData = []; // 0始まり配列。各要素 { widthPt, heightPt, fields: [] }
  let editingTemplateId = null;
  let pendingCopySourceId = null; // 「コピーして新規作成」で選んだコピー元テンプレートのid
  // 「未保存の変更」の判定は、以前は「下書きがlocalStorageに存在するか」だけを見ていたが、
  // 様式を開く・ズームするだけでも下書き自動保存の仕組み上ドラフトが作られてしまい、
  // 何も変更していないのに警告が出る不具合の元になっていた。実際にユーザーが編集した時だけ
  // trueにするこのフラグで判定する（pushUndoSnapshot()と同じタイミングでtrueにする）
  let isDirty = false;
  let selectedFieldId = null; // 選択中の項目のみ複製・削除ボタンを表示する（密集した項目同士の干渉を防ぐため）
  let clipboardField = null; // Ctrl+Cでコピーした項目の内容（Ctrl+Vで貼り付ける）
  let undoStack = []; // 元に戻す用のpagesDataスナップショット（JSON文字列）
  let redoStack = [];
  const MAX_UNDO_STEPS = 50;

  const fileInput = document.getElementById('pdfFileInput');
  const fileNameLabel = document.getElementById('editorFileName');
  const canvas = document.getElementById('editorCanvas');
  const overlay = document.getElementById('editorOverlay');
  const pageNav = document.getElementById('editorPageNav');
  const pageLabel = document.getElementById('editorPageLabel');
  const prevBtn = document.getElementById('editorPrevPage');
  const nextBtn = document.getElementById('editorNextPage');
  const stageWrap = document.getElementById('editorStageWrap');
  const zoomOutBtn = document.getElementById('editorZoomOutBtn');
  const zoomInBtn = document.getElementById('editorZoomInBtn');
  const zoomFitBtn = document.getElementById('editorZoomFitBtn');
  const zoomLabel = document.getElementById('editorZoomLabel');
  const undoBtn = document.getElementById('editorUndoBtn');
  const redoBtn = document.getElementById('editorRedoBtn');
  const zoom = PdfUtils.createZoomControl();
  const fieldListEl = document.getElementById('editorFieldList');
  const fieldEmptyEl = document.getElementById('editorFieldEmpty');
  const nameInput = document.getElementById('templateNameInput');
  const saveBtn = document.getElementById('saveTemplateBtn');
  const statusEl = document.getElementById('editorStatusMsg');
  const templateListEl = document.getElementById('editorTemplateList');
  const templateEmptyEl = document.getElementById('editorTemplateEmpty');
  const exportTemplatesBtn = document.getElementById('exportTemplatesBtn');
  const importTemplatesInput = document.getElementById('importTemplatesInput');
  const backupStatusEl = document.getElementById('backupStatusMsg');

  // 項目の設定パネル（サイドバーに固定表示。様式やプレビューに重ならない）
  const fieldEditPlaceholder = document.getElementById('fieldEditPlaceholder');
  const fieldEditForm = document.getElementById('fieldEditForm');
  const labelInput = document.getElementById('modalLabelInput');
  const typeSelect = document.getElementById('modalTypeSelect');
  const multilineRow = document.getElementById('fieldMultilineRow');
  const multilineInput = document.getElementById('modalMultilineInput');
  const alignRow = document.getElementById('fieldAlignRow');
  const alignSelect = document.getElementById('modalAlignSelect');
  const fontSizeRow = document.getElementById('fieldFontSizeRow');
  const cellCountRow = document.getElementById('fieldCellCountRow');
  const fontSizeInput = document.getElementById('modalFontSizeInput');
  const fontSizeValue = document.getElementById('modalFontSizeValue');
  const cellCountInput = document.getElementById('modalCellCountInput');
  const cellCountValue = document.getElementById('modalCellCountValue');
  const cellGapInput = document.getElementById('modalCellGapInput');
  const cellGapValue = document.getElementById('modalCellGapValue');
  const fieldCancelBtn = document.getElementById('modalCancelBtn');
  const fieldOkBtn = document.getElementById('modalOkBtn');
  const fieldDuplicateBtn = document.getElementById('modalDuplicateBtn');
  let editSession = null; // { existingField, pixelRect, previewEl, onSave }

  const DEFAULT_FONT_SIZE = 11;
  const DEFAULT_CELL_COUNT = 6;
  const DEFAULT_CELL_GAP = 0;
  const MIN_BOX_PX = 6; // これより小さいドラッグは誤操作とみなして無視する（狭いマス目・小さい印字欄にも対応できるよう小さめに設定。細かく作りたい時はズームインしてから操作すると掴みやすい）

  function currentPage() {
    return pagesData[pageNumber - 1];
  }

  function makeFieldId() {
    return TemplateStore.makeFieldId();
  }

  // ===== 作業中の下書きを自動保存（個人情報を含まないPDF様式・項目定義のみ） =====
  let draftSaveTimer = null;
  let restoringDraft = false;

  function scheduleDraftSave() {
    if (restoringDraft || !originalArrayBuffer) return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraftNow, 600);
  }

  function saveDraftNow() {
    if (!originalArrayBuffer) return;
    DraftStore.save({
      editingTemplateId,
      name: nameInput.value,
      pdfBase64: PdfUtils.arrayBufferToBase64(originalArrayBuffer),
      pages: pagesData,
      savedAt: new Date().toISOString(),
    });
  }

  async function restoreDraftIfAny() {
    const draft = DraftStore.get();
    if (!draft || !draft.pdfBase64) return;
    restoringDraft = true;
    try {
      originalArrayBuffer = PdfUtils.base64ToArrayBuffer(draft.pdfBase64);
      pagesData = draft.pages || [];
      editingTemplateId = draft.editingTemplateId || null;
      nameInput.value = draft.name || '';
      await loadFromArrayBuffer(originalArrayBuffer, (draft.name || '下書き') + '.pdf');
      isDirty = true; // 復元した下書きは、正式保存されていない状態そのものなので「未保存」扱いにする
      showStatus('前回の続きの下書きを復元しました');
    } catch (e) {
      console.error('下書きの復元に失敗しました', e);
    } finally {
      restoringDraft = false;
    }
  }

  // 「🆕 新規作成」：読み込んだPDF・作業中の項目・下書きをクリアし、初回起動時と同じ空の状態に戻す。
  // 一度PDFを読み込むと、リロードしても下書き復元でずっとそのPDFが開いた状態になってしまうため、
  // ユーザーが意図的に空の状態へ戻れる手段として追加した
  function resetEditor() {
    if (isDirty && !confirm('保存されていない変更が失われます。新規作成してよろしいですか？')) return;
    clearTimeout(draftSaveTimer);
    DraftStore.clear();

    pdfDoc = null;
    originalArrayBuffer = null;
    pageNumber = 1;
    pageCount = 1;
    pagesData = [];
    editingTemplateId = null;
    pendingCopySourceId = null;
    isDirty = false;
    clipboardField = null;
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    selectField(null);
    closeFieldEditor();

    fileInput.value = '';
    fileNameLabel.textContent = '';
    nameInput.value = '';
    saveBtn.disabled = true;
    pageNav.classList.add('hidden');

    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
    overlay.innerHTML = '';
    fieldListEl.innerHTML = '';
    fieldEmptyEl.classList.remove('hidden');

    showStatus('新規作成しました');
  }

  async function loadFromFile(file) {
    const buf = await file.arrayBuffer();
    originalArrayBuffer = buf;
    await loadFromArrayBuffer(buf, file.name);
    editingTemplateId = null;
  }

  async function loadFromArrayBuffer(buf, label) {
    pdfDoc = await PdfUtils.loadPdf(buf.slice(0));
    pageCount = pdfDoc.numPages;
    pageNumber = 1;
    if (!pagesData.length) {
      pagesData = Array.from({ length: pageCount }, () => ({ widthPt: 0, heightPt: 0, fields: [] }));
    }
    // 別の様式を開いた時は、前の様式の元に戻す履歴を持ち越さない
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    // 開いた直後はまだ何も編集していないので「未保存の変更」扱いにはしない
    // （下書き復元の場合はrestoreDraftIfAny側でこの直後にtrueへ戻す）
    isDirty = false;
    fileNameLabel.textContent = label || '';
    pageNav.classList.toggle('hidden', pageCount <= 1);
    saveBtn.disabled = false;
    await renderCurrentPage();
    // 新しい様式を開いた時は、まず全体表示に合わせる（密集した項目も見渡してから編集できるように）
    zoom.fitToView(stageWrap);
    updateZoomLabel();
    await renderCurrentPage();
  }

  function updateZoomLabel() {
    zoomLabel.textContent = zoom.getLabel();
  }

  zoomOutBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.zoomOut(); updateZoomLabel(); rerenderForZoom(); });
  zoomInBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.zoomIn(); updateZoomLabel(); rerenderForZoom(); });
  zoomFitBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.fitToView(stageWrap); updateZoomLabel(); rerenderForZoom(); });

  // トラックパッドのピンチイン・アウトはブラウザにctrl+wheelとして伝わるため、そのままだと
  // ページ全体がブラウザの拡大縮小になってしまう。ここで検知して自前のズームに差し替える
  stageWrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !pdfDoc) return;
    e.preventDefault();
    if (e.deltaY < 0) zoom.zoomIn(); else zoom.zoomOut();
    updateZoomLabel();
    rerenderForZoom();
  }, { passive: false });

  // キーボード操作：+/-/0でズーム、選択中の項目があれば矢印キーで位置を微調整できる
  // （Shiftを押しながらだと大きく動く）。他のテキスト入力欄にフォーカスがある時は横取りしない
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('modeEditor').classList.contains('hidden')) return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!pdfDoc) return;

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoom.zoomIn(); updateZoomLabel(); rerenderForZoom();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoom.zoomOut(); updateZoomLabel(); rerenderForZoom();
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      zoom.fitToView(stageWrap); updateZoomLabel(); rerenderForZoom();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelectedField();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteClipboardField();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      selectField(null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFieldId) {
      e.preventDefault();
      pushUndoSnapshot();
      currentPage().fields = currentPage().fields.filter(f => f.id !== selectedFieldId);
      selectedFieldId = null;
      renderFieldBoxes();
      renderFieldList();
      return;
    }

    if (!selectedFieldId) return;
    const field = currentPage().fields.find(f => f.id === selectedFieldId);
    if (!field) return;
    const step = e.shiftKey ? 5 : 1; // pt単位（画面px単位ではないので、ズーム倍率に関わらず同じ量だけ動く）
    if (e.key === 'ArrowUp') { e.preventDefault(); pushUndoSnapshot(); field.y += step; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pushUndoSnapshot(); field.y -= step; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pushUndoSnapshot(); field.x -= step; }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pushUndoSnapshot(); field.x += step; }
    else return;
    renderFieldBoxes();
    renderFieldList();
  });

  async function renderCurrentPage() {
    const size = await PdfUtils.renderPageToCanvas(pdfDoc, pageNumber, canvas, zoom.getScale());
    if (!pagesData[pageNumber - 1].widthPt) {
      pagesData[pageNumber - 1].widthPt = size.widthPt;
      pagesData[pageNumber - 1].heightPt = size.heightPt;
    }
    zoom.setPageSize(pagesData[pageNumber - 1].widthPt, pagesData[pageNumber - 1].heightPt);
    pageLabel.textContent = `${pageNumber} / ${pageCount} ページ`;
    renderFieldBoxes();
    renderFieldList();
  }

  // ズームだけを変えた時の再描画。ページの中身（項目の一覧）自体は変わらないので、
  // renderFieldList()は呼ばない（呼ぶと下書き自動保存が予約され、何も変更していないのに
  // 「未保存の変更があります」の警告が出てしまう不具合になるため）
  async function rerenderForZoom() {
    await PdfUtils.renderPageToCanvas(pdfDoc, pageNumber, canvas, zoom.getScale());
    zoom.setPageSize(pagesData[pageNumber - 1].widthPt, pagesData[pageNumber - 1].heightPt);
    renderFieldBoxes();
  }

  // ===== 元に戻す・やり直し =====
  // 項目の追加・移動・リサイズ・削除・編集・複製など、構造が変わる操作の直前に必ず呼ぶ。
  // pagesData全体をJSON文字列としてスナップショットするシンプルな方式（データ量が小さいので十分速い）
  function pushUndoSnapshot() {
    undoStack.push(JSON.stringify(pagesData));
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack = []; // 新しい変更をしたら、それ以前の「やり直し」履歴は無効になる
    updateUndoRedoButtons();
    isDirty = true;
    // 下書き自動保存も「実際に編集した時」だけ予約する（renderFieldList側で無条件に予約していると、
    // テンプレを開いて眺めただけでも下書きが作られてしまい、リロード後に「未保存」扱いで
    // 復元されてしまう不具合になるため。ここでisDirtyがtrueになるタイミングと揃えている）
    scheduleDraftSave();
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(pagesData));
    pagesData = JSON.parse(undoStack.pop());
    selectedFieldId = null;
    renderFieldBoxes();
    renderFieldList();
    updateUndoRedoButtons();
    showStatus('元に戻しました');
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(pagesData));
    pagesData = JSON.parse(redoStack.pop());
    selectedFieldId = null;
    renderFieldBoxes();
    renderFieldList();
    updateUndoRedoButtons();
    showStatus('やり直しました');
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // ===== 項目ボックスの描画 =====
  function renderFieldBoxes() {
    // 項目名はホバー時にtitle属性のツールチップで表示しているが、ツールチップが表示された
    // 状態のまま要素をDOMから消すと、ブラウザが消すタイミングを逃して文字だけがゴーストのように
    // 画面に残ってしまうことがある。消す直前にtitleを外しておくことでこれを防ぐ
    overlay.querySelectorAll('.field-box').forEach(el => { el.removeAttribute('title'); el.remove(); });
    const page = currentPage();
    page.fields.forEach(field => addFieldBoxElement(field, page.heightPt));
  }

  function selectField(fieldId) {
    if (selectedFieldId === fieldId) return;
    selectedFieldId = fieldId;
    overlay.querySelectorAll('.field-box.selected').forEach(el => el.classList.remove('selected'));
    if (fieldId) {
      const boxEl = overlay.querySelector(`[data-field-id="${fieldId}"]`);
      if (boxEl) boxEl.classList.add('selected');
    }
  }

  function addFieldBoxElement(field, heightPt) {
    const pos = PdfUtils.pdfRectToPixel(field, heightPt, zoom.getScale());
    const box = document.createElement('div');
    box.className = 'field-box ' + field.type + (field.id === selectedFieldId ? ' selected' : '');
    box.dataset.fieldId = field.id; // 項目一覧からのジャンプ・ハイライトで参照する
    box.style.left = pos.left + 'px';
    box.style.top = pos.top + 'px';
    box.style.width = pos.width + 'px';
    box.style.height = pos.height + 'px';

    // チェック・丸囲みは印刷物の実サイズに合わせて小さく作ることが多いため、
    // ボタン類を枠の角に重ねて置くと枠自体を覆ってしまい、クリックしたつもりが
    // 削除ボタンに当たって消えてしまう、という事故が起きていた。
    // そこで枠の上に完全にはみ出す「ツールバー」にボタンをまとめ、
    // 枠の大きさに関わらず本体（移動・ダブルクリック編集の対象）を必ず邪魔しないようにする。
    // さらに、項目が密集した申請書ではこのツールバー自体が隣の項目と重なって邪魔になるため、
    // 常時表示はせず、クリックして選択した項目だけ表示する（CSSの.selectedで切り替え）
    // 項目名も常時表示すると干渉するため、ホバー時のツールチップのみで確認する
    box.title = field.label || '';

    const toolbar = document.createElement('div');
    toolbar.className = 'box-toolbar';

    const dupBtn = document.createElement('span');
    dupBtn.className = 'box-dup';
    dupBtn.textContent = '⧉';
    dupBtn.title = '複製（同じ設定のまま新しい項目を作ります）';
    dupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateField(field);
    });
    toolbar.appendChild(dupBtn);

    const delBtn = document.createElement('span');
    delBtn.className = 'box-del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndoSnapshot();
      currentPage().fields = currentPage().fields.filter(f => f.id !== field.id);
      if (selectedFieldId === field.id) selectedFieldId = null;
      renderFieldBoxes();
      renderFieldList();
    });
    toolbar.appendChild(delBtn);

    box.appendChild(toolbar);

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'box-resize';
    box.appendChild(resizeHandle);

    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectField(field.id);
      startResize(e, field, box);
    });

    box.addEventListener('mousedown', (e) => {
      if (e.target === delBtn || e.target === dupBtn || e.target === resizeHandle) return;
      e.stopPropagation();
      selectField(field.id);
      startMove(e, field, box);
    });

    box.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editField(field);
    });

    overlay.appendChild(box);
  }

  const SNAP_TOLERANCE_PX = 5; // これ以内に他の項目の端・中央が来たら吸着させる（Canva等のスマートガイドと同じ考え方）

  function startMove(downEvent, field, boxEl) {
    const startClientX = downEvent.clientX;
    const startClientY = downEvent.clientY;
    const startLeft = parseFloat(boxEl.style.left);
    const startTop = parseFloat(boxEl.style.top);
    const boxW = parseFloat(boxEl.style.width);
    const boxH = parseFloat(boxEl.style.height);
    const heightPt = currentPage().heightPt;

    // 他の項目の左端・中央・右端／上端・中央・下端を、揃えられる候補ラインとして集めておく
    const guidesX = [];
    const guidesY = [];
    currentPage().fields.forEach(f => {
      if (f.id === field.id) return;
      const p = PdfUtils.pdfRectToPixel(f, heightPt, zoom.getScale());
      guidesX.push(p.left, p.left + p.width / 2, p.left + p.width);
      guidesY.push(p.top, p.top + p.height / 2, p.top + p.height);
    });

    function findSnap(value, guides) {
      let best = null;
      let bestDiff = SNAP_TOLERANCE_PX;
      guides.forEach(g => {
        const diff = Math.abs(g - value);
        if (diff < bestDiff) { bestDiff = diff; best = g; }
      });
      return best;
    }

    function onMove(moveEvent) {
      let newLeft = startLeft + (moveEvent.clientX - startClientX);
      let newTop = startTop + (moveEvent.clientY - startClientY);

      // 自分の左端・中央・右端のいずれかが、他の項目のガイドに近ければそこへ吸着する
      let snappedX = null;
      [0, boxW / 2, boxW].some(offset => {
        const snap = findSnap(newLeft + offset, guidesX);
        if (snap == null) return false;
        newLeft = snap - offset;
        snappedX = snap;
        return true;
      });
      let snappedY = null;
      [0, boxH / 2, boxH].some(offset => {
        const snap = findSnap(newTop + offset, guidesY);
        if (snap == null) return false;
        newTop = snap - offset;
        snappedY = snap;
        return true;
      });

      boxEl.style.left = newLeft + 'px';
      boxEl.style.top = newTop + 'px';
      showAlignGuides(snappedX, snappedY);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      hideAlignGuides();
      const finalLeft = parseFloat(boxEl.style.left);
      const finalTop = parseFloat(boxEl.style.top);
      // クリックしただけ（選択のみ）で実際には動いていない場合は、無駄な元に戻す履歴を作らない
      if (finalLeft !== startLeft || finalTop !== startTop) pushUndoSnapshot();
      field.x = finalLeft / zoom.getScale();
      field.y = heightPt - field.height - (finalTop / zoom.getScale());
      renderFieldList();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ドラッグ中だけ表示する、揃った位置を示す細い線（縦・横1本ずつ使い回す）
  let guideVEl = null;
  let guideHEl = null;

  function showAlignGuides(x, y) {
    if (!guideVEl) {
      guideVEl = document.createElement('div');
      guideVEl.className = 'align-guide align-guide-v';
      overlay.appendChild(guideVEl);
    }
    if (!guideHEl) {
      guideHEl = document.createElement('div');
      guideHEl.className = 'align-guide align-guide-h';
      overlay.appendChild(guideHEl);
    }
    if (x != null) { guideVEl.style.left = x + 'px'; guideVEl.style.display = 'block'; }
    else { guideVEl.style.display = 'none'; }
    if (y != null) { guideHEl.style.top = y + 'px'; guideHEl.style.display = 'block'; }
    else { guideHEl.style.display = 'none'; }
  }

  function hideAlignGuides() {
    if (guideVEl) guideVEl.style.display = 'none';
    if (guideHEl) guideHEl.style.display = 'none';
  }

  function startResize(downEvent, field, boxEl) {
    const boxLeft = parseFloat(boxEl.style.left);
    const boxTop = parseFloat(boxEl.style.top);
    const startWidth = parseFloat(boxEl.style.width);
    const startHeight = parseFloat(boxEl.style.height);
    const heightPt = currentPage().heightPt;

    function onMove(moveEvent) {
      const rect = overlay.getBoundingClientRect();
      const curX = moveEvent.clientX - rect.left;
      const curY = moveEvent.clientY - rect.top;
      const w = Math.max(curX - boxLeft, MIN_BOX_PX);
      const h = Math.max(curY - boxTop, MIN_BOX_PX);
      boxEl.style.width = w + 'px';
      boxEl.style.height = h + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const widthPx = parseFloat(boxEl.style.width);
      const heightPx = parseFloat(boxEl.style.height);
      if (widthPx !== startWidth || heightPx !== startHeight) pushUndoSnapshot();
      field.width = widthPx / zoom.getScale();
      field.height = heightPx / zoom.getScale();
      field.y = heightPt - field.height - (boxTop / zoom.getScale());
      renderFieldBoxes();
      renderFieldList();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // 同じ種類・文字サイズ・マス設定のまま、真下に少し間隔を空けて複製する（チェックリストのような
  // 縦並びの項目を量産するとき用。チェック欄や丸囲みは小さく密集しがちで、PDF上でドラッグして
  // 新規作成しようとすると隣の項目に触れて動かしてしまうことがあるため、ドラッグ操作を介さずに
  // 複製できるこの経路を用意している）
  // 項目のコピー＆貼り付け（Ctrl+C / Ctrl+V）。⧉複製ボタンと同じ「真下に少しずらして複製」の仕組みを
  // 再利用しつつ、コピー元を覚えておくことで別の項目を選んでからでも同じ内容を貼り付けられる
  function copySelectedField() {
    if (!selectedFieldId) return;
    const field = currentPage().fields.find(f => f.id === selectedFieldId);
    if (!field) return;
    clipboardField = Object.assign({}, field);
    showStatus(`「${field.label}」をコピーしました（Ctrl+Vで貼り付け）`);
  }

  function pasteClipboardField() {
    if (!clipboardField) return;
    clipboardField = Object.assign({}, duplicateField(clipboardField));
  }

  function duplicateField(field) {
    pushUndoSnapshot();
    const heightPt = currentPage().heightPt;
    const pos = PdfUtils.pdfRectToPixel(field, heightPt, zoom.getScale());
    const gap = 6;
    const offsetY = pos.height + gap;
    const newRect = PdfUtils.pixelRectToPdfRect(
      pos.left, pos.top + offsetY,
      pos.left + pos.width, pos.top + offsetY + pos.height,
      heightPt, zoom.getScale()
    );
    const newField = Object.assign({}, field, newRect, { id: makeFieldId() });
    currentPage().fields.push(newField);
    selectedFieldId = newField.id;
    renderFieldBoxes();
    renderFieldList();
    return newField;
  }

  // ===== ドラッグで新規項目を作成 =====
  let dragState = null;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay || !pdfDoc) return;
    selectField(null); // 何もない場所をクリックしたら選択を解除する
    const rect = overlay.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    const dragBox = document.createElement('div');
    dragBox.className = 'field-drag';
    dragBox.style.left = startX + 'px';
    dragBox.style.top = startY + 'px';
    overlay.appendChild(dragBox);
    dragState = { startX, startY, curX: startX, curY: startY, dragBox };
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const rect = overlay.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const left = Math.min(curX, dragState.startX);
    const top = Math.min(curY, dragState.startY);
    dragState.dragBox.style.left = left + 'px';
    dragState.dragBox.style.top = top + 'px';
    dragState.dragBox.style.width = Math.abs(curX - dragState.startX) + 'px';
    dragState.dragBox.style.height = Math.abs(curY - dragState.startY) + 'px';
    dragState.curX = curX;
    dragState.curY = curY;
  });

  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    const { startX, startY, curX, curY, dragBox } = dragState;
    dragState = null;
    overlay.removeChild(dragBox);

    if (Math.abs(curX - startX) < MIN_BOX_PX || Math.abs(curY - startY) < MIN_BOX_PX) return;

    const pixelRect = {
      left: Math.min(startX, curX),
      top: Math.min(startY, curY),
      width: Math.abs(curX - startX),
      height: Math.abs(curY - startY),
    };
    const heightPt = currentPage().heightPt;
    const pdfRect = PdfUtils.pixelRectToPdfRect(startX, startY, curX, curY, heightPt, zoom.getScale());

    openFieldModal(null, pixelRect, (result) => {
      const field = Object.assign({ id: makeFieldId() }, pdfRect, result);
      currentPage().fields.push(field);
      selectedFieldId = field.id;
      renderFieldBoxes();
      renderFieldList();
    });
  });

  function editField(field) {
    const heightPt = currentPage().heightPt;
    const pixelRect = PdfUtils.pdfRectToPixel(field, heightPt, zoom.getScale());
    openFieldModal(field, pixelRect, (result) => {
      Object.assign(field, result);
      renderFieldBoxes();
      renderFieldList();
    });
  }

  // ===== 項目の種類・見え方を決めるモーダル（実寸のライブプレビュー付き） =====
  function openFieldModal(existingField, pixelRect, onSave) {
    closeFieldEditor(); // 前の編集セッションが残っていれば片付ける

    const previewEl = document.createElement('div');
    previewEl.style.position = 'absolute';
    previewEl.style.left = pixelRect.left + 'px';
    previewEl.style.top = pixelRect.top + 'px';
    previewEl.style.width = pixelRect.width + 'px';
    previewEl.style.height = pixelRect.height + 'px';
    overlay.appendChild(previewEl);

    editSession = { existingField, pixelRect, previewEl, onSave };

    fieldEditPlaceholder.classList.add('hidden');
    fieldEditForm.classList.remove('hidden');
    labelInput.value = existingField ? existingField.label : '';
    typeSelect.value = existingField ? existingField.type : 'text';
    multilineInput.checked = existingField ? !!existingField.multiline : false;
    alignSelect.value = (existingField && (existingField.align === 'center' || existingField.align === 'right')) ? existingField.align : 'left';
    fontSizeInput.value = existingField && existingField.fontSize ? existingField.fontSize : DEFAULT_FONT_SIZE;
    cellCountInput.value = existingField && existingField.cellCount ? existingField.cellCount : DEFAULT_CELL_COUNT;
    cellGapInput.value = existingField && existingField.cellGap != null ? existingField.cellGap : DEFAULT_CELL_GAP;
    fieldOkBtn.textContent = existingField ? '更新' : '追加';
    fieldDuplicateBtn.classList.toggle('hidden', !existingField);

    refreshFieldPreview();
    labelInput.focus();
  }

  function closeFieldEditor() {
    if (editSession && editSession.previewEl && editSession.previewEl.parentNode) {
      editSession.previewEl.parentNode.removeChild(editSession.previewEl);
    }
    editSession = null;
    fieldEditForm.classList.add('hidden');
    fieldEditPlaceholder.classList.remove('hidden');
  }

  function syncFieldFormVisibility() {
    const type = typeSelect.value;
    multilineRow.classList.toggle('hidden', type !== 'text');
    alignRow.classList.toggle('hidden', type !== 'text');
    fontSizeRow.classList.toggle('hidden', type !== 'text' && type !== 'boxed');
    cellCountRow.classList.toggle('hidden', type !== 'boxed');
    // チェック・丸囲みはPDFへの反映が位置だけで決まり、項目名は一覧での見分け以外に使わないため任意にしている
    labelInput.placeholder = (type === 'checkbox' || type === 'circle')
      ? '空欄なら自動で名前が付きます（例：チェック1）'
      : '';
  }

  // チェック・丸囲みで項目名が空欄の時に使う自動採番（同じページの同種項目数+1）
  function autoLabelFor(type) {
    const prefix = type === 'checkbox' ? 'チェック' : '丸囲み';
    const excludeId = editSession && editSession.existingField ? editSession.existingField.id : null;
    const count = currentPage().fields.filter(f => f.type === type && f.id !== excludeId).length;
    return prefix + (count + 1);
  }

  function refreshFieldPreview() {
    if (!editSession) return;
    syncFieldFormVisibility();
    fontSizeValue.textContent = fontSizeInput.value + 'pt';
    cellCountValue.textContent = cellCountInput.value + '個';
    cellGapValue.textContent = cellGapInput.value + 'pt';
    updatePreview(editSession.previewEl, editSession.pixelRect, {
      type: typeSelect.value,
      label: labelInput.value,
      multiline: multilineInput.checked,
      align: alignSelect.value,
      fontSize: parseFloat(fontSizeInput.value) || DEFAULT_FONT_SIZE,
      cellCount: parseInt(cellCountInput.value, 10) || DEFAULT_CELL_COUNT,
      cellGap: parseFloat(cellGapInput.value) || 0,
    });
  }

  // 項目の設定パネルの操作は、画面に1つしか存在しないのでリスナーは最初に一度だけ登録する
  labelInput.addEventListener('input', refreshFieldPreview);
  typeSelect.addEventListener('change', refreshFieldPreview);
  multilineInput.addEventListener('change', refreshFieldPreview);
  alignSelect.addEventListener('change', refreshFieldPreview);
  fontSizeInput.addEventListener('input', refreshFieldPreview);
  cellCountInput.addEventListener('input', refreshFieldPreview);
  cellGapInput.addEventListener('input', refreshFieldPreview);
  fieldCancelBtn.addEventListener('click', closeFieldEditor);
  fieldOkBtn.addEventListener('click', () => {
    if (!editSession) return;
    const type = typeSelect.value;
    let label = labelInput.value.trim();
    if (!label) {
      if (type === 'checkbox' || type === 'circle') {
        label = autoLabelFor(type);
      } else {
        labelInput.focus();
        return;
      }
    }
    const result = { label, type };
    if (type === 'text') {
      result.multiline = multilineInput.checked;
      result.align = alignSelect.value;
    }
    if (type === 'text' || type === 'boxed') result.fontSize = parseFloat(fontSizeInput.value) || DEFAULT_FONT_SIZE;
    if (type === 'boxed') {
      result.cellCount = parseInt(cellCountInput.value, 10) || DEFAULT_CELL_COUNT;
      result.cellGap = parseFloat(cellGapInput.value) || 0;
    }
    const onSave = editSession.onSave;
    closeFieldEditor();
    pushUndoSnapshot(); // 新規追加・既存項目の設定変更、どちらもここでまとめて履歴に記録する
    onSave(result);
  });
  fieldDuplicateBtn.addEventListener('click', () => {
    if (!editSession || !editSession.existingField) return;
    const newField = duplicateField(editSession.existingField);
    closeFieldEditor();
    // 複製した項目をすぐ編集状態にする → 「複製」を連打するだけでチェックリストを量産できる
    editField(newField);
  });
  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fieldOkBtn.click();
  });

  // 実際の枠の中に、指定フォントサイズ・マス数で文字がどう乗るかをそのまま描画する
  function updatePreview(previewEl, pixelRect, opts) {
    const scale = zoom.getScale();
    previewEl.className = 'field-preview' + (opts.type === 'checkbox' ? ' checkbox' : opts.type === 'circle' ? ' circle' : '');
    previewEl.innerHTML = '';

    if (opts.type === 'text') {
      if (opts.multiline) previewEl.classList.add('multiline');
      const span = document.createElement('span');
      span.className = 'preview-text';
      span.textContent = opts.label || 'サンプル文字';
      span.style.fontSize = (opts.fontSize * scale) + 'px';
      span.style.width = '100%';
      span.style.textAlign = (opts.align === 'center' || opts.align === 'right') ? opts.align : 'left';
      previewEl.appendChild(span);
    } else if (opts.type === 'boxed') {
      const count = Math.max(opts.cellCount, 1);
      const gapPx = (opts.cellGap || 0) * scale;
      const cellWidthPx = Math.max((pixelRect.width - (count - 1) * gapPx) / count, 4);
      const sample = '0123456789';
      for (let i = 0; i < count; i++) {
        const cell = document.createElement('div');
        cell.className = 'preview-cell';
        cell.style.left = (i * (cellWidthPx + gapPx)) + 'px';
        cell.style.width = cellWidthPx + 'px';
        cell.style.borderRight = i < count - 1 ? '' : 'none';
        const span = document.createElement('span');
        span.className = 'preview-text';
        span.textContent = sample[i % 10];
        span.style.fontSize = (opts.fontSize * scale) + 'px';
        cell.appendChild(span);
        previewEl.appendChild(cell);
      }
    } else if (opts.type === 'checkbox') {
      const span = document.createElement('span');
      span.className = 'preview-text';
      span.textContent = '✓';
      span.style.fontSize = Math.min(pixelRect.height * 0.8, 28) + 'px';
      span.style.color = '#c0392b';
      previewEl.appendChild(span);
    }
    // circle: 枠自体が丸い破線になるのでプレビュー内容は不要
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function typeLabel(type) {
    if (type === 'checkbox') return 'チェック';
    if (type === 'circle') return '丸囲み';
    if (type === 'boxed') return 'マス目';
    return 'テキスト';
  }

  function renderFieldList() {
    // 下書き保存は「実際に編集した時」だけpushUndoSnapshot()側で予約する（このrenderFieldList()は
    // ページ切り替え・ズーム等、編集を伴わない再描画からも呼ばれるため、ここでは予約しない）
    const page = currentPage();
    fieldListEl.innerHTML = '';
    fieldEmptyEl.classList.toggle('hidden', page.fields.length > 0);
    page.fields.forEach(field => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = field.label;
      left.style.cursor = 'pointer';
      left.title = 'クリックするとPDF上のこの項目までスクロールします';
      left.addEventListener('click', () => scrollFieldIntoView(field));
      const typeTag = document.createElement('span');
      typeTag.className = 'field-type-tag';
      typeTag.textContent = typeLabel(field.type);
      left.appendChild(typeTag);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-danger';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        pushUndoSnapshot();
        page.fields = page.fields.filter(f => f.id !== field.id);
        if (selectedFieldId === field.id) selectedFieldId = null;
        renderFieldBoxes();
        renderFieldList();
      });
      li.appendChild(left);
      li.appendChild(delBtn);
      fieldListEl.appendChild(li);
    });
  }

  // 項目一覧のクリックで、スクロールして見えなくなっている項目までPDFプレビューを自動スクロールし、
  // 一瞬ハイライトして「消えたわけではない」ことがひと目でわかるようにする
  function scrollFieldIntoView(field) {
    const pos = PdfUtils.pdfRectToPixel(field, currentPage().heightPt, zoom.getScale());
    const targetTop = pos.top - (stageWrap.clientHeight - pos.height) / 2;
    stageWrap.scrollTo({ top: Math.max(targetTop, 0), left: 0, behavior: 'smooth' });

    const boxEl = overlay.querySelector(`[data-field-id="${field.id}"]`);
    if (boxEl) {
      boxEl.classList.add('field-box-flash');
      setTimeout(() => boxEl.classList.remove('field-box-flash'), 1200);
    }
  }

  function showStatus(message, isError) {
    statusEl.innerHTML = `<div class="status-msg ${isError ? 'err' : 'ok'}">${message}</div>`;
    setTimeout(() => { statusEl.innerHTML = ''; }, 3500);
  }

  function saveTemplate() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); showStatus('テンプレート名を入力してください', true); return false; }
    if (!pdfDoc || !originalArrayBuffer) { showStatus('先にPDFを読み込んでください', true); return false; }

    const template = {
      id: editingTemplateId || TemplateStore.makeId(),
      name,
      createdAt: new Date().toISOString(),
      pdfBase64: PdfUtils.arrayBufferToBase64(originalArrayBuffer),
      pages: pagesData.map(p => ({ widthPt: p.widthPt, heightPt: p.heightPt, fields: p.fields })),
    };
    TemplateStore.save(template);
    editingTemplateId = template.id;
    // 直前の編集で予約されていた下書き自動保存(600msデバウンス)が正式保存の「後」に発火すると、
    // 消したはずの下書きが復活して「未保存の変更」扱いになってしまうため、ここで確実に止める
    clearTimeout(draftSaveTimer);
    DraftStore.clear(); // 正式なテンプレートとして保存できたので、下書きの役目は終わり
    isDirty = false;
    showStatus('テンプレートを保存しました');
    renderTemplateList();
    if (window.Filler) Filler.refreshTemplateOptions();
    return true;
  }

  function renderTemplateList() {
    const templates = TemplateStore.list();
    templateListEl.innerHTML = '';
    templateEmptyEl.classList.toggle('hidden', templates.length > 0);
    templates.forEach(t => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.innerHTML = `${escapeHtml(t.name)}<br><span class="tpl-meta">${t.pageCount}ページ・${new Date(t.createdAt).toLocaleDateString('ja-JP')}</span>`;
      const actions = document.createElement('div');

      actions.style.display = 'flex';
      actions.style.flexWrap = 'wrap';
      actions.style.gap = '6px';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn-outline';
      editBtn.textContent = '📂 開いて編集';
      editBtn.title = 'このテンプレートを上のプレビューに読み込んで編集します';
      editBtn.addEventListener('click', () => loadTemplateForEdit(t.id));

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-outline';
      copyBtn.textContent = '📋 コピーして新規作成';
      copyBtn.title = '他の自治体の似た様式を作る時、この項目定義を新しいPDFにコピーして使い回せます';
      copyBtn.addEventListener('click', () => {
        pendingCopySourceId = t.id;
        showStatus(`「${t.name}」をコピー元にしました。続けて新しいPDFを選んでください`);
        fileInput.click();
      });

      const backupBtn = document.createElement('button');
      backupBtn.className = 'btn-outline';
      backupBtn.textContent = '📤 このテンプレだけバックアップ';
      backupBtn.title = 'このテンプレート1件だけをJSONファイルに書き出します';
      backupBtn.addEventListener('click', () => exportSingleTemplate(t.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-danger';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        if (!confirm(`「${t.name}」を削除しますか？`)) return;
        TemplateStore.remove(t.id);
        renderTemplateList();
        if (window.Filler) Filler.refreshTemplateOptions();
      });

      actions.appendChild(editBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(backupBtn);
      actions.appendChild(delBtn);
      li.appendChild(info);
      li.appendChild(actions);
      templateListEl.appendChild(li);
    });
  }

  function showBackupStatus(message, isError) {
    backupStatusEl.innerHTML = `<div class="status-msg ${isError ? 'err' : 'ok'}">${message}</div>`;
    setTimeout(() => { backupStatusEl.innerHTML = ''; }, 4000);
  }

  // テンプレート配列をJSONファイルとしてダウンロードする共通処理（全件バックアップ・個別バックアップの両方で使う）
  function downloadTemplatesAsJson(templates, filenameBase) {
    const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenameBase}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 全テンプレート（PDF本体＋座標定義）を1つのJSONファイルに書き出す。他のPC・職場内での共有用
  function exportTemplates() {
    const templates = TemplateStore.exportAll();
    if (!templates.length) { showBackupStatus('保存されたテンプレートがありません', true); return; }
    downloadTemplatesAsJson(templates, '申請書テンプレート_全件バックアップ');
    showBackupStatus(`${templates.length}件のテンプレートをバックアップしました`);
  }

  // 1件だけをバックアップ。「必要な様式だけ職場の他メンバーに渡したい」というケース向け。
  // ファイル形式は全件バックアップと同じ配列(要素数1)なので、読み込み側は同じインポート経路で扱える
  function exportSingleTemplate(id) {
    const template = TemplateStore.get(id);
    if (!template) return;
    downloadTemplatesAsJson([template], `申請書テンプレート_${template.name}`);
    showBackupStatus(`「${template.name}」をバックアップしました`);
  }

  // バックアップファイルを読み込み、中に複数テンプレートが入っている場合は
  // 「受け手側が必要な分だけ選んで取り込める」よう、一覧から選択させてから取り込む
  async function importTemplatesFromFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const templates = Array.isArray(parsed) ? parsed : [parsed];
      if (!templates.length || !templates.every(t => t && t.id && t.name && Array.isArray(t.pages))) {
        throw new Error('バックアップファイルの形式が正しくありません');
      }
      openImportPickerModal(templates);
    } catch (e) {
      console.error(e);
      showBackupStatus('バックアップファイルの読み込みに失敗しました：' + e.message, true);
    }
  }

  // バックアップファイルに含まれるテンプレートを一覧表示し、チェックを入れたものだけ取り込む
  function openImportPickerModal(templates) {
    const existingIds = new Set(TemplateStore.list().map(t => t.id));

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const rows = templates.map((t, i) => {
      const overwriteNote = existingIds.has(t.id)
        ? '<span style="color:#d9822b;">（同名IDが既にあるため上書きされます）</span>'
        : '';
      return `
        <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--color-border);">
          <input type="checkbox" class="import-pick-checkbox" data-index="${i}" checked style="width:auto;margin-top:3px;">
          <span>${escapeHtml(t.name)}<br>
            <span class="tpl-meta">${(t.pages || []).length}ページ${overwriteNote}</span>
          </span>
        </label>`;
    }).join('');
    backdrop.innerHTML = `
      <div class="modal-box" style="width:380px;max-height:80vh;overflow:auto;">
        <h3>取り込むテンプレートを選択（${templates.length}件見つかりました）</h3>
        <div id="importPickerList">${rows}</div>
        <div class="modal-actions">
          <button class="btn-outline" id="importPickerCancelBtn">キャンセル</button>
          <button class="btn-primary" id="importPickerOkBtn">選択したものを取り込む</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    function close() {
      document.body.removeChild(backdrop);
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('#importPickerCancelBtn').addEventListener('click', close);
    backdrop.querySelector('#importPickerOkBtn').addEventListener('click', () => {
      const checked = Array.from(backdrop.querySelectorAll('.import-pick-checkbox'))
        .filter(cb => cb.checked)
        .map(cb => templates[parseInt(cb.dataset.index, 10)]);
      if (!checked.length) { close(); return; }
      const count = TemplateStore.importAll(checked);
      showBackupStatus(`${count}件のテンプレートを読み込みました`);
      renderTemplateList();
      if (window.Filler) Filler.refreshTemplateOptions();
      close();
    });
  }

  exportTemplatesBtn.addEventListener('click', exportTemplates);
  importTemplatesInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importTemplatesFromFile(file);
    importTemplatesInput.value = '';
  });

  async function loadTemplateForEdit(id) {
    const template = TemplateStore.get(id);
    if (!template) return;
    originalArrayBuffer = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    pagesData = template.pages.map(p => ({ widthPt: p.widthPt, heightPt: p.heightPt, fields: JSON.parse(JSON.stringify(p.fields)) }));
    editingTemplateId = template.id;
    nameInput.value = template.name;
    await loadFromArrayBuffer(originalArrayBuffer, template.name + '.pdf');
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pagesData = [];
    editingTemplateId = null;
    const copySourceId = pendingCopySourceId;
    pendingCopySourceId = null;
    await loadFromFile(file);
    if (copySourceId) applyCopiedFields(copySourceId);
  });

  const newBtn = document.getElementById('editorNewBtn');
  newBtn.addEventListener('click', resetEditor);

  // 別の自治体の似た様式を作る時、既存テンプレートの項目定義（種類・ラベル・文字サイズ・座標）を
  // 新しいPDFにそのままコピーする。多くの様式は項目の並びが似ているため、位置調整だけで済むことが多い
  function applyCopiedFields(sourceId) {
    const source = TemplateStore.get(sourceId);
    if (!source) return;
    let copiedCount = 0;
    source.pages.forEach((srcPage, i) => {
      if (!pagesData[i]) return; // 新しいPDFの方がページ数が少ない場合はここで打ち切り
      pagesData[i].fields = srcPage.fields.map(f => Object.assign({}, f, { id: makeFieldId() }));
      copiedCount += srcPage.fields.length;
    });
    isDirty = true; // 項目をコピーしただけでまだ保存していない状態
    scheduleDraftSave(); // クラッシュ時の復旧用に、コピーした内容も下書きに残す
    renderFieldBoxes();
    renderFieldList();
    showStatus(`「${source.name}」から${copiedCount}件の項目をコピーしました。位置を新しい様式に合わせて調整してください`);
  }

  prevBtn.addEventListener('click', () => {
    if (pageNumber > 1) { pageNumber--; renderCurrentPage(); }
  });
  nextBtn.addEventListener('click', () => {
    if (pageNumber < pageCount) { pageNumber++; renderCurrentPage(); }
  });

  saveBtn.addEventListener('click', saveTemplate);
  nameInput.addEventListener('input', scheduleDraftSave);

  function init() {
    renderTemplateList();
    restoreDraftIfAny();
  }

  function hasUnsavedChanges() {
    return isDirty;
  }

  return { init, renderTemplateList, hasUnsavedChanges, saveTemplate };
})();
