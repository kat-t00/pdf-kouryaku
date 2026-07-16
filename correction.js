// 修正モード：すでに入力済みのPDFを読み込み、直したい部分だけ白抜き→上書きする
// テンプレートとしては保存せず、その場でPDF出力するだけの一回限りの編集。
// テンプレート作成モード（editor.js）と同じ操作感（ズーム・選択制ツールバー・
// 元に戻す/やり直し・キーボードショートカット・アラインメントガイド）に揃えている
const Correction = (() => {
  let pdfDoc = null;
  let originalArrayBuffer = null;
  let pageNumber = 1;
  let pageCount = 1;
  let pagesData = []; // 0始まり配列。各要素 { widthPt, heightPt, corrections: [] }
  let cachedFontBytes = null;
  let selectedId = null; // 選択中の修正箇所のみ複製・削除ボタンを表示する
  let clipboardCorrection = null; // Ctrl+Cでコピーした内容
  let undoStack = [];
  let redoStack = [];
  const MAX_UNDO_STEPS = 50;
  const MIN_BOX_PX = 6;
  const DEFAULT_FONT_SIZE = 11;

  const fileInput = document.getElementById('correctionFileInput');
  const fileNameLabel = document.getElementById('correctionFileName');
  const canvas = document.getElementById('correctionCanvas');
  const overlay = document.getElementById('correctionOverlay');
  const pageNav = document.getElementById('correctionPageNav');
  const pageLabel = document.getElementById('correctionPageLabel');
  const prevBtn = document.getElementById('correctionPrevPage');
  const nextBtn = document.getElementById('correctionNextPage');
  const stageWrap = document.getElementById('correctionStageWrap');
  const zoomOutBtn = document.getElementById('correctionZoomOutBtn');
  const zoomInBtn = document.getElementById('correctionZoomInBtn');
  const zoomFitBtn = document.getElementById('correctionZoomFitBtn');
  const zoomLabel = document.getElementById('correctionZoomLabel');
  const undoBtn = document.getElementById('correctionUndoBtn');
  const redoBtn = document.getElementById('correctionRedoBtn');
  const zoom = PdfUtils.createZoomControl();
  const listEl = document.getElementById('correctionList');
  const emptyEl = document.getElementById('correctionEmpty');
  const exportBtn = document.getElementById('correctionExportBtn');
  const openBtn = document.getElementById('correctionOpenBtn');
  const statusEl = document.getElementById('correctionStatusMsg');

  // 修正内容の設定パネル（サイドバーに固定表示。テンプレ作成モードのfieldEditPanelと同じ考え方）
  const editPlaceholder = document.getElementById('correctionEditPlaceholder');
  const editForm = document.getElementById('correctionEditForm');
  const typeSelect = document.getElementById('corrTypeSelect');
  const textExtra = document.getElementById('corrTextExtra');
  const textInput = document.getElementById('corrTextInput');
  const multilineInput = document.getElementById('corrMultilineInput');
  const alignSelect = document.getElementById('corrAlignSelect');
  const fontSizeInput = document.getElementById('corrFontSizeInput');
  const fontSizeValue = document.getElementById('corrFontSizeValue');
  const dupBtn = document.getElementById('corrDuplicateBtn');
  const cancelBtn = document.getElementById('corrCancelBtn');
  const okBtn = document.getElementById('corrOkBtn');
  let editSession = null; // { existing, pixelRect, previewEl, onSave }

  function currentPage() {
    return pagesData[pageNumber - 1];
  }

  function makeId() {
    return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function loadFromFile(file) {
    originalArrayBuffer = await file.arrayBuffer();
    pdfDoc = await PdfUtils.loadPdf(originalArrayBuffer.slice(0));
    pageCount = pdfDoc.numPages;
    pageNumber = 1;
    pagesData = Array.from({ length: pageCount }, () => ({ widthPt: 0, heightPt: 0, corrections: [] }));
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    selectedId = null;
    closeEditPanel();
    fileNameLabel.textContent = file.name;
    pageNav.classList.toggle('hidden', pageCount <= 1);
    exportBtn.disabled = false;
    openBtn.disabled = false;
    await renderCurrentPage();
    // 読み込んだ直後は様式全体が見えるよう全体表示に合わせる
    zoom.fitToView(stageWrap);
    updateZoomLabel();
    await renderCurrentPage();
  }

  function updateZoomLabel() {
    zoomLabel.textContent = zoom.getLabel();
  }

  async function renderCurrentPage() {
    const size = await PdfUtils.renderPageToCanvas(pdfDoc, pageNumber, canvas, zoom.getScale());
    if (!pagesData[pageNumber - 1].widthPt) {
      pagesData[pageNumber - 1].widthPt = size.widthPt;
      pagesData[pageNumber - 1].heightPt = size.heightPt;
    }
    zoom.setPageSize(pagesData[pageNumber - 1].widthPt, pagesData[pageNumber - 1].heightPt);
    pageLabel.textContent = `${pageNumber} / ${pageCount} ページ`;
    renderCorrectionBoxes();
    renderList();
  }

  // ズームだけの再描画：中身（修正箇所の一覧）は変わらないので、renderList()は呼ばない
  // （呼ぶと[[project_shinsei_form_app]]で見つかった「ズームしただけで未保存扱いになる」不具合と
  // 同じパターンを再発させてしまう。修正モードは下書き保存の仕組みは無いが、念のため同じ設計にしておく）
  async function rerenderForZoom() {
    await PdfUtils.renderPageToCanvas(pdfDoc, pageNumber, canvas, zoom.getScale());
    zoom.setPageSize(pagesData[pageNumber - 1].widthPt, pagesData[pageNumber - 1].heightPt);
    renderCorrectionBoxes();
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

  // ===== 元に戻す・やり直し =====
  function pushUndoSnapshot() {
    undoStack.push(JSON.stringify(pagesData));
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(pagesData));
    pagesData = JSON.parse(undoStack.pop());
    selectedId = null;
    closeEditPanel();
    renderCorrectionBoxes();
    renderList();
    updateUndoRedoButtons();
    showStatus('元に戻しました');
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(pagesData));
    pagesData = JSON.parse(redoStack.pop());
    selectedId = null;
    closeEditPanel();
    renderCorrectionBoxes();
    renderList();
    updateUndoRedoButtons();
    showStatus('やり直しました');
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // ===== キーボード操作：+/-/0でズーム、選択中の箇所は矢印キーで微調整、Ctrl+C/V・Delete・Escape =====
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('modeCorrection').classList.contains('hidden')) return;
    const active = document.activeElement;
    // チェックのON/OFFトグル自体もinput要素なので、クリックした直後はそこにフォーカスが残る。
    // 「テキスト入力中は横取りしない」の対象はテキスト系の入力欄だけにして、
    // トグルをクリックした直後にDelete/矢印キー等が効かなくなるのを防ぐ
    const isTextInput = (active.tagName === 'INPUT' && active.type !== 'checkbox') || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
    if (isTextInput) return;
    if (!pdfDoc) return;

    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom.zoomIn(); updateZoomLabel(); rerenderForZoom(); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom.zoomOut(); updateZoomLabel(); rerenderForZoom(); return; }
    if (e.key === '0') { e.preventDefault(); zoom.fitToView(stageWrap); updateZoomLabel(); rerenderForZoom(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') { e.preventDefault(); selectCorrection(null); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      pushUndoSnapshot();
      currentPage().corrections = currentPage().corrections.filter(c => c.id !== selectedId);
      selectedId = null;
      closeEditPanel();
      renderCorrectionBoxes();
      renderList();
      return;
    }

    if (!selectedId) return;
    const c = currentPage().corrections.find(x => x.id === selectedId);
    if (!c) return;
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowUp') { e.preventDefault(); pushUndoSnapshot(); c.y += step; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pushUndoSnapshot(); c.y -= step; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pushUndoSnapshot(); c.x -= step; }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pushUndoSnapshot(); c.x += step; }
    else return;
    renderCorrectionBoxes();
    renderList();
  });

  // ===== 選択状態 =====
  function selectCorrection(id) {
    if (selectedId === id) return;
    selectedId = id;
    overlay.querySelectorAll('.correction-box.selected').forEach(el => el.classList.remove('selected'));
    if (id) {
      const el = overlay.querySelector(`[data-correction-id="${id}"]`);
      if (el) el.classList.add('selected');
    }
  }

  // ===== コピー＆貼り付け =====
  function copySelected() {
    if (!selectedId) return;
    const c = currentPage().corrections.find(x => x.id === selectedId);
    if (!c) return;
    clipboardCorrection = Object.assign({}, c);
    showStatus('修正箇所をコピーしました（Ctrl+Vで貼り付け）');
  }

  function pasteClipboard() {
    if (!clipboardCorrection) return;
    clipboardCorrection = Object.assign({}, duplicateCorrection(clipboardCorrection));
  }

  function duplicateCorrection(c) {
    pushUndoSnapshot();
    const heightPt = currentPage().heightPt;
    const pos = PdfUtils.pdfRectToPixel(c, heightPt, zoom.getScale());
    const gap = 6;
    const offsetY = pos.height + gap;
    const newRect = PdfUtils.pixelRectToPdfRect(
      pos.left, pos.top + offsetY,
      pos.left + pos.width, pos.top + offsetY + pos.height,
      heightPt, zoom.getScale()
    );
    const newCorrection = Object.assign({}, c, newRect, { id: makeId() });
    currentPage().corrections.push(newCorrection);
    selectedId = newCorrection.id;
    renderCorrectionBoxes();
    renderList();
    return newCorrection;
  }

  // ===== ドラッグで新規修正箇所を作成 =====
  const SNAP_TOLERANCE_PX = 5;
  let dragState = null;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay || !pdfDoc) return;
    selectCorrection(null);
    const rect = overlay.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    const dragBox = document.createElement('div');
    dragBox.className = 'correction-drag';
    dragBox.style.left = startX + 'px';
    dragBox.style.top = startY + 'px';
    overlay.appendChild(dragBox);
    dragState = { startX, startY, dragBox };
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const rect = overlay.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const left = Math.min(curX, dragState.startX);
    const top = Math.min(curY, dragState.startY);
    const width = Math.abs(curX - dragState.startX);
    const height = Math.abs(curY - dragState.startY);
    dragState.dragBox.style.left = left + 'px';
    dragState.dragBox.style.top = top + 'px';
    dragState.dragBox.style.width = width + 'px';
    dragState.dragBox.style.height = height + 'px';
    dragState.curX = curX;
    dragState.curY = curY;
  });

  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    const { startX, startY, dragBox } = dragState;
    const curX = dragState.curX != null ? dragState.curX : startX;
    const curY = dragState.curY != null ? dragState.curY : startY;
    dragState = null;

    if (Math.abs(curX - startX) < MIN_BOX_PX || Math.abs(curY - startY) < MIN_BOX_PX) {
      overlay.removeChild(dragBox);
      return; // 小さすぎる範囲は誤操作とみなして無視
    }

    const heightPt = currentPage().heightPt;
    const pdfRect = PdfUtils.pixelRectToPdfRect(startX, startY, curX, curY, heightPt, zoom.getScale());
    const pixelRect = {
      left: Math.min(startX, curX),
      top: Math.min(startY, curY),
      width: Math.abs(curX - startX),
      height: Math.abs(curY - startY),
    };
    overlay.removeChild(dragBox);

    openEditPanel(null, pixelRect, (type, text, multiline, align, fontSize) => {
      pushUndoSnapshot();
      // チェック・丸囲みは「その種類を選んだ＝マークを付けたい」という意図なので、まずON状態で作る。
      // 入力・出力モードと同じく、後からクリックしてON/OFFを切り替えられる
      const correction = Object.assign({ id: makeId(), type, text: text || '', multiline, align, fontSize, checked: true }, pdfRect);
      correction.maxWidth = pdfRect.width - 4;
      correction.rx = pdfRect.width / 2;
      correction.ry = pdfRect.height / 2;
      currentPage().corrections.push(correction);
      selectedId = correction.id;
      renderCorrectionBoxes();
      renderList();
    });
  });

  function renderCorrectionBoxes() {
    overlay.querySelectorAll('.correction-box').forEach(el => el.remove());
    const page = currentPage();
    page.corrections.forEach(c => addCorrectionElement(c, page.heightPt));
  }

  function addCorrectionElement(correction, heightPt) {
    const pos = PdfUtils.pdfRectToPixel(correction, heightPt, zoom.getScale());
    const box = document.createElement('div');
    const isMark = correction.type === 'checkbox' || correction.type === 'circle';
    const isOff = isMark && correction.checked === false;
    // チェック・丸囲みはPDF出力でも白抜きしない（既に印刷された枠線を隠さない）ので、
    // 画面上の見た目もそれに合わせて半透明にする（テキストタイプだけ、白抜きを予告する不透明表示のまま）
    box.className = 'correction-box'
      + (isMark ? ' mark-type' : '')
      + (correction.type === 'circle' ? ' mark-circle' : '')
      + (correction.id === selectedId ? ' selected' : '')
      + (isOff ? ' mark-off' : '');
    box.dataset.correctionId = correction.id;
    box.style.left = pos.left + 'px';
    box.style.top = pos.top + 'px';
    box.style.width = pos.width + 'px';
    box.style.height = pos.height + 'px';

    if (correction.type === 'text') {
      // 確定後の枠内表示も、編集パネルのライブプレビューと同じ実際のフォントサイズ・配置・複数行設定を反映する
      // （以前は固定11px・1行のみの見た目だったため、設定したはずの大きさ・配置が反映されない不具合になっていた）
      const span = document.createElement('span');
      span.className = 'correction-text-preview' + (correction.multiline ? ' multiline' : '');
      span.textContent = correction.text || '(白抜きのみ)';
      span.style.fontSize = ((correction.fontSize || DEFAULT_FONT_SIZE) * zoom.getScale()) + 'px';
      span.style.width = '100%';
      span.style.textAlign = (correction.align === 'center' || correction.align === 'right') ? correction.align : 'left';
      box.appendChild(span);
    } else if (correction.type === 'checkbox' || correction.type === 'circle') {
      // 入力・出力モードの.fill-mark-toggleと同じ、実際に出力される✓・○そのものの見た目でクリック切り替えできる
      // ネイティブのcheckboxを使う（以前はチェックだけプレーンな「✓」文字を表示するだけで押しても
      // 何も起きず、丸囲みは常時ON固定でトグルする手段が無かった不具合の修正。入力・出力モードでは
      // チェック・丸囲みとも同じ仕組みでON/OFFできるので、修正モードもそれに揃えた）
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'fill-mark-toggle ' + correction.type;
      toggle.style.fontSize = Math.min(pos.height * 0.85, 26) + 'px';
      toggle.checked = correction.checked !== false; // 未設定（古いデータ）はONとして扱う
      toggle.title = 'クリックでON/OFFを切り替えます';
      toggle.addEventListener('mousedown', (e) => e.stopPropagation()); // 枠のドラッグ移動と衝突させない
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        selectCorrection(correction.id); // クリックした箇所を選択状態にする（複製・削除ボタンを出すため）
      });
      toggle.addEventListener('change', () => {
        pushUndoSnapshot();
        correction.checked = toggle.checked;
        // 丸囲みはON/OFFで枠の見た目自体は変わらないため、薄く表示してひと目で分かるようにする
        box.classList.toggle('mark-off', !toggle.checked);
      });
      box.appendChild(toggle);
    }

    // 複製・削除ボタンは選択中の箇所だけ表示（テンプレ作成モードと同じ、密集回避のための設計）
    const toolbar = document.createElement('div');
    toolbar.className = 'box-toolbar';

    const dupIcon = document.createElement('span');
    dupIcon.className = 'box-dup';
    dupIcon.textContent = '⧉';
    dupIcon.title = '複製（同じ設定のまま新しい修正箇所を作ります）';
    dupIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateCorrection(correction);
    });
    toolbar.appendChild(dupIcon);

    const delIcon = document.createElement('span');
    delIcon.className = 'box-del';
    delIcon.textContent = '×';
    delIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndoSnapshot();
      currentPage().corrections = currentPage().corrections.filter(c => c.id !== correction.id);
      if (selectedId === correction.id) selectedId = null;
      closeEditPanel();
      renderCorrectionBoxes();
      renderList();
    });
    toolbar.appendChild(delIcon);

    box.appendChild(toolbar);

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'box-resize';
    box.appendChild(resizeHandle);

    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectCorrection(correction.id);
      startResize(e, correction, box);
    });

    box.addEventListener('mousedown', (e) => {
      if (e.target === delIcon || e.target === dupIcon || e.target === resizeHandle) return;
      e.stopPropagation();
      selectCorrection(correction.id);
      startMove(e, correction, box);
    });

    box.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editCorrection(correction);
    });

    overlay.appendChild(box);
  }

  function startMove(downEvent, correction, boxEl) {
    const startClientX = downEvent.clientX;
    const startClientY = downEvent.clientY;
    const startLeft = parseFloat(boxEl.style.left);
    const startTop = parseFloat(boxEl.style.top);
    const boxW = parseFloat(boxEl.style.width);
    const boxH = parseFloat(boxEl.style.height);
    const heightPt = currentPage().heightPt;

    const guidesX = [];
    const guidesY = [];
    currentPage().corrections.forEach(c => {
      if (c.id === correction.id) return;
      const p = PdfUtils.pdfRectToPixel(c, heightPt, zoom.getScale());
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
      if (finalLeft !== startLeft || finalTop !== startTop) pushUndoSnapshot();
      correction.x = finalLeft / zoom.getScale();
      correction.y = heightPt - correction.height - (finalTop / zoom.getScale());
      renderList();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startResize(downEvent, correction, boxEl) {
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
      correction.width = widthPx / zoom.getScale();
      correction.height = heightPx / zoom.getScale();
      correction.y = heightPt - correction.height - (boxTop / zoom.getScale());
      // maxWidth/rx/ryは枠のサイズから決まる補助値なので追従させる。fontSizeはユーザーが
      // パネルで選んだ値をそのまま尊重し、リサイズのたびに上書きしない
      correction.maxWidth = correction.width - 4;
      correction.rx = correction.width / 2;
      correction.ry = correction.height / 2;
      renderCorrectionBoxes();
      renderList();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ドラッグ中だけ表示するアラインメントガイド
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

  function typeLabel(type) {
    if (type === 'checkbox') return 'チェック';
    if (type === 'circle') return '丸囲み';
    return 'テキスト';
  }

  function renderList() {
    const page = currentPage();
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', page.corrections.length > 0);
    page.corrections.forEach(c => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.style.cursor = 'pointer';
      left.addEventListener('click', () => selectCorrection(c.id));

      const typeTag = document.createElement('span');
      typeTag.className = 'field-type-tag';

      // チェック・丸囲みは入力・出力モードの一覧と同じく、ON/OFFの状態を表示してここからも切り替えられる
      // （PDF上の小さい枠を正確にクリックしにくい時の代替手段としても使える）
      if (c.type === 'checkbox' || c.type === 'circle') {
        const checked = c.checked !== false;
        left.textContent = '';
        typeTag.textContent = checked ? `✓ ${typeLabel(c.type)}` : `未選択（${typeLabel(c.type)}）`;
        typeTag.style.cursor = 'pointer';
        typeTag.title = 'クリックでON/OFFを切り替えます';
        typeTag.addEventListener('click', (e) => {
          e.stopPropagation();
          pushUndoSnapshot();
          c.checked = !checked;
          renderCorrectionBoxes();
          renderList();
        });
      } else {
        left.textContent = c.text || '(白抜きのみ)';
        typeTag.textContent = typeLabel(c.type);
      }
      left.appendChild(typeTag);
      const delBtnEl = document.createElement('button');
      delBtnEl.className = 'btn-danger';
      delBtnEl.textContent = '削除';
      delBtnEl.addEventListener('click', () => {
        pushUndoSnapshot();
        page.corrections = page.corrections.filter(x => x.id !== c.id);
        if (selectedId === c.id) { selectedId = null; closeEditPanel(); }
        renderCorrectionBoxes();
        renderList();
      });
      li.appendChild(left);
      li.appendChild(delBtnEl);
      listEl.appendChild(li);
    });
  }

  // ===== 修正内容の設定パネル（サイドバー常設。テンプレ作成モードのfieldEditPanelと同じ考え方で、
  // 実際のフォントサイズ・配置がその場で分かるライブプレビュー付き） =====
  function openEditPanel(existing, pixelRect, onSave) {
    if (editSession && editSession.previewEl && editSession.previewEl.parentNode) {
      editSession.previewEl.parentNode.removeChild(editSession.previewEl);
    }
    const rect = pixelRect || PdfUtils.pdfRectToPixel(existing, currentPage().heightPt, zoom.getScale());
    const previewEl = document.createElement('div');
    previewEl.style.position = 'absolute';
    previewEl.style.left = rect.left + 'px';
    previewEl.style.top = rect.top + 'px';
    previewEl.style.width = rect.width + 'px';
    previewEl.style.height = rect.height + 'px';
    overlay.appendChild(previewEl);

    editSession = { existing, pixelRect: rect, previewEl, onSave };
    editPlaceholder.classList.add('hidden');
    editForm.classList.remove('hidden');
    typeSelect.value = existing ? existing.type : 'text';
    textInput.value = existing && existing.text ? existing.text : '';
    multilineInput.checked = existing ? !!existing.multiline : false;
    alignSelect.value = (existing && (existing.align === 'center' || existing.align === 'right')) ? existing.align : 'left';
    fontSizeInput.value = existing && existing.fontSize ? existing.fontSize : DEFAULT_FONT_SIZE;
    dupBtn.classList.toggle('hidden', !existing);
    okBtn.textContent = existing ? '更新' : '追加';
    refreshEditPreview();
    textInput.focus();
  }

  function closeEditPanel() {
    if (editSession && editSession.previewEl && editSession.previewEl.parentNode) {
      editSession.previewEl.parentNode.removeChild(editSession.previewEl);
    }
    editSession = null;
    editForm.classList.add('hidden');
    editPlaceholder.classList.remove('hidden');
  }

  function syncEditFormVisibility() {
    textExtra.classList.toggle('hidden', typeSelect.value !== 'text');
  }

  function refreshEditPreview() {
    if (!editSession) return;
    syncEditFormVisibility();
    fontSizeValue.textContent = fontSizeInput.value + 'pt';
    updateCorrectionPreview(editSession.previewEl, {
      type: typeSelect.value,
      text: textInput.value,
      multiline: multilineInput.checked,
      align: alignSelect.value,
      fontSize: parseFloat(fontSizeInput.value) || DEFAULT_FONT_SIZE,
    });
  }

  // 実際の枠の中に、指定フォントサイズ・配置で文字がどう乗るかをそのまま描画する（テンプレ作成モードと同じ考え方）
  function updateCorrectionPreview(previewEl, opts) {
    const scale = zoom.getScale();
    previewEl.className = 'field-preview' + (opts.type === 'checkbox' ? ' checkbox' : opts.type === 'circle' ? ' circle' : '');
    previewEl.innerHTML = '';

    if (opts.type === 'text') {
      if (opts.multiline) previewEl.classList.add('multiline');
      const span = document.createElement('span');
      span.className = 'preview-text';
      span.textContent = opts.text || 'サンプル文字';
      span.style.fontSize = (opts.fontSize * scale) + 'px';
      span.style.width = '100%';
      span.style.textAlign = (opts.align === 'center' || opts.align === 'right') ? opts.align : 'left';
      previewEl.appendChild(span);
    } else if (opts.type === 'checkbox') {
      const span = document.createElement('span');
      span.className = 'preview-text';
      span.textContent = '✓';
      span.style.fontSize = Math.min(previewEl.offsetHeight * 0.8, 28) + 'px';
      span.style.color = '#c0392b';
      previewEl.appendChild(span);
    }
    // circle: 枠自体が丸い破線になるのでプレビュー内容は不要
  }

  function editCorrection(correction) {
    selectCorrection(correction.id);
    openEditPanel(correction, null, (type, text, multiline, align, fontSize) => {
      pushUndoSnapshot();
      correction.type = type;
      correction.text = text || '';
      correction.multiline = multiline;
      correction.align = align;
      correction.fontSize = fontSize;
      if (correction.checked == null) correction.checked = true; // 古いデータ・種類変更時の初期値
      renderCorrectionBoxes();
      renderList();
    });
  }

  typeSelect.addEventListener('change', refreshEditPreview);
  textInput.addEventListener('input', refreshEditPreview);
  multilineInput.addEventListener('change', refreshEditPreview);
  alignSelect.addEventListener('change', refreshEditPreview);
  fontSizeInput.addEventListener('input', refreshEditPreview);
  cancelBtn.addEventListener('click', closeEditPanel);
  okBtn.addEventListener('click', () => {
    if (!editSession) return;
    const onSave = editSession.onSave;
    closeEditPanel();
    onSave(
      typeSelect.value,
      textInput.value.trim(),
      multilineInput.checked,
      alignSelect.value,
      parseFloat(fontSizeInput.value) || DEFAULT_FONT_SIZE
    );
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
  });
  dupBtn.addEventListener('click', () => {
    if (!editSession || !editSession.existing) return;
    const newCorrection = duplicateCorrection(editSession.existing);
    closeEditPanel();
    editCorrection(newCorrection);
  });

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // fetch()は使わない（file://でダブルクリック起動した場合に読み込めなくなるため）。
  // notosansjp_base64.jsで埋め込んだbase64文字列からその場で復元する
  function loadFontBytes() {
    if (!cachedFontBytes) {
      cachedFontBytes = PdfUtils.base64ToArrayBuffer(NOTO_SANS_JP_BASE64);
    }
    return cachedFontBytes;
  }

  function fitFontSize(font, text, baseSize, maxWidth) {
    if (!maxWidth) return baseSize;
    const width = font.widthOfTextAtSize(text, baseSize);
    if (width <= maxWidth) return baseSize;
    return Math.max(baseSize * (maxWidth / width), 6);
  }

  // 配置設定(left/center/right)に応じて、描画する文字列のx座標を求める（入力・出力モードと同じ考え方）
  function alignedX(c, textWidth) {
    if (c.align === 'center') return c.x + (c.width - textWidth) / 2;
    if (c.align === 'right') return c.x + c.width - textWidth - 2;
    return c.x + 2;
  }

  // 改行(\n)ごとの段落を分け、それぞれ枠の幅を超えたら1文字単位で自動的に折り返す
  function wrapTextToLines(font, text, size, maxWidth) {
    const lines = [];
    text.split('\n').forEach(paragraph => {
      if (paragraph === '') { lines.push(''); return; }
      let current = '';
      for (const ch of paragraph) {
        const test = current + ch;
        if (current && font.widthOfTextAtSize(test, size) > maxWidth) {
          lines.push(current);
          current = ch;
        } else {
          current = test;
        }
      }
      lines.push(current);
    });
    return lines;
  }

  function drawMultilineCorrectionText(page, font, c, rgb) {
    const maxWidth = Math.max(c.width - 4, 4);
    let size = c.fontSize || DEFAULT_FONT_SIZE;
    let lines = wrapTextToLines(font, c.text, size, maxWidth);
    let lineHeight = size * 1.3;
    while (lines.length * lineHeight > c.height && size > 6) {
      size -= 0.5;
      lineHeight = size * 1.3;
      lines = wrapTextToLines(font, c.text, size, maxWidth);
    }
    let y = c.y + c.height - lineHeight * 0.9;
    for (const line of lines) {
      if (y < c.y) break; // 枠に入りきらない行はここで描画を打ち切る
      if (line) {
        const lineWidth = font.widthOfTextAtSize(line, size);
        page.drawText(line, { x: alignedX(c, lineWidth), y, size, font, color: rgb(0.05, 0.05, 0.1) });
      }
      y -= lineHeight;
    }
  }

  async function buildCorrectedPdf() {
    const { PDFDocument, rgb } = PDFLib;
    const pdfLibDoc = await PDFDocument.load(originalArrayBuffer.slice(0));
    pdfLibDoc.registerFontkit(fontkit);
    const fontBytes = await loadFontBytes();
    const font = await pdfLibDoc.embedFont(fontBytes, { subset: false });
    const pages = pdfLibDoc.getPages();

    pagesData.forEach((pageData, i) => {
      const pdfPage = pages[i];
      pageData.corrections.forEach(c => {
        // チェック・丸囲みは、どちらもPDFに既に印刷されているマス目・選択肢の上にマークを付け足すのが
        // 目的なので、白抜きしてしまうと印刷済みの枠線ごと消えてしまう。白抜きは「文字を書き直す」の時だけ行う
        if (c.type === 'text') {
          pdfPage.drawRectangle({ x: c.x, y: c.y, width: c.width, height: c.height, color: rgb(1, 1, 1) });
        }

        if (c.type === 'checkbox') {
          // 白抜き（元の内容を消す）はチェックのON/OFFに関わらず行うが、✓自体はONの時だけ描く
          // （OFFにした修正箇所は「その場所を白く消しただけ」の結果になる）
          if (c.checked !== false) {
            const s = Math.min(c.width, c.height) * 0.8;
            const cx = c.x + (c.width - s) / 2;
            const cy = c.y + (c.height - s) / 2;
            pdfPage.drawLine({ start: { x: cx, y: cy + s * 0.35 }, end: { x: cx + s * 0.35, y: cy }, thickness: 1.4, color: rgb(0.05, 0.05, 0.1) });
            pdfPage.drawLine({ start: { x: cx + s * 0.35, y: cy }, end: { x: cx + s, y: cy + s * 0.9 }, thickness: 1.4, color: rgb(0.05, 0.05, 0.1) });
          }
        } else if (c.type === 'circle') {
          // OFFにした丸囲みは「結局囲まない」という意図なので、白抜きと同じく何も描かない
          if (c.checked !== false) {
            pdfPage.drawEllipse({
              x: c.x + c.width / 2, y: c.y + c.height / 2,
              xScale: c.rx, yScale: c.ry,
              borderColor: rgb(0.05, 0.05, 0.1),
              borderWidth: 1.5,
            });
          }
        } else if (c.text) {
          if (c.multiline) {
            drawMultilineCorrectionText(pdfPage, font, c, rgb);
          } else {
            const size = fitFontSize(font, c.text, c.fontSize || DEFAULT_FONT_SIZE, c.maxWidth);
            const textWidth = font.widthOfTextAtSize(c.text, size);
            pdfPage.drawText(c.text, {
              x: alignedX(c, textWidth),
              y: c.y + c.height * 0.22,
              size,
              font,
              color: rgb(0.05, 0.05, 0.1),
            });
          }
        }
      });
    });

    return pdfLibDoc.save();
  }

  function showStatus(message, isError) {
    statusEl.innerHTML = `<div class="status-msg ${isError ? 'err' : 'ok'}">${message}</div>`;
    setTimeout(() => { statusEl.innerHTML = ''; }, 4000);
  }

  async function exportAndDownload() {
    if (!pdfDoc) return;
    showStatus('PDFを作成しています…');
    try {
      const pdfBytes = await buildCorrectedPdf();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `修正_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('PDFをダウンロードしました');
    } catch (e) {
      console.error(e);
      showStatus('PDFの作成に失敗しました：' + e.message, true);
    }
  }

  async function exportAndOpen() {
    if (!pdfDoc) return;
    showStatus('PDFを作成しています…');
    try {
      const pdfBytes = await buildCorrectedPdf();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      showStatus('新しいタブで開きました');
    } catch (e) {
      console.error(e);
      showStatus('PDFの作成に失敗しました：' + e.message, true);
    }
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadFromFile(file);
  });
  prevBtn.addEventListener('click', () => { if (pageNumber > 1) { pageNumber--; selectedId = null; closeEditPanel(); renderCurrentPage(); } });
  nextBtn.addEventListener('click', () => { if (pageNumber < pageCount) { pageNumber++; selectedId = null; closeEditPanel(); renderCurrentPage(); } });
  exportBtn.addEventListener('click', exportAndDownload);
  openBtn.addEventListener('click', exportAndOpen);

  function init() {}

  return { init };
})();
