// 入力・出力モード：保存済みテンプレートを選び、PDFの上に入力欄を重ねて表示・出力する
const Filler = (() => {
  let template = null;
  let pdfDoc = null;
  let pageNumber = 1;
  let values = {}; // fieldId -> 文字列 or true/false（チェック）
  let cachedFontBytes = null;

  const select = document.getElementById('templateSelect');
  const canvas = document.getElementById('fillerCanvas');
  const overlay = document.getElementById('fillerOverlay');
  const pageNav = document.getElementById('fillerPageNav');
  const pageLabel = document.getElementById('fillerPageLabel');
  const prevBtn = document.getElementById('fillerPrevPage');
  const nextBtn = document.getElementById('fillerNextPage');
  const stageWrap = document.getElementById('fillerStageWrap');
  const zoomOutBtn = document.getElementById('fillerZoomOutBtn');
  const zoomInBtn = document.getElementById('fillerZoomInBtn');
  const zoomFitBtn = document.getElementById('fillerZoomFitBtn');
  const zoomLabel = document.getElementById('fillerZoomLabel');
  const zoom = PdfUtils.createZoomControl();
  const exportBtn = document.getElementById('exportPdfBtn');
  const openBtn = document.getElementById('openPdfBtn');
  const autoFillBtn = document.getElementById('autoFillBtn');
  const saveToProfileBtn = document.getElementById('saveToProfileBtn');
  const caseLabelInput = document.getElementById('caseLabelInput');
  const saveCaseBtn = document.getElementById('saveCaseBtn');
  const loadCaseBtn = document.getElementById('loadCaseBtn');
  const loadCaseInput = document.getElementById('loadCaseInput');
  const caseFileStatusEl = document.getElementById('caseFileStatusMsg');
  const statusEl = document.getElementById('fillerStatusMsg');
  // 対応ブラウザ（Chrome/Edge等）で開いた・保存したファイルのハンドル。
  // これがあれば「保存」を押した時に新しいファイルを増やさずそのまま上書きできる
  let currentCaseFileHandle = null;
  const fieldStatusListEl = document.getElementById('fillerFieldStatusList');
  const fieldStatusEmptyEl = document.getElementById('fillerFieldStatusEmpty');

  // ===== 入力内容の自動保存（個人情報を含みうるため、あくまで作業中の一時的な保険） =====
  let fillDraftTimer = null;
  let restoringFillDraft = false;

  function scheduleFillDraftSave() {
    if (restoringFillDraft || !template) return;
    clearTimeout(fillDraftTimer);
    fillDraftTimer = setTimeout(saveFillDraftNow, 600);
  }

  function saveFillDraftNow() {
    if (!template) return;
    FillDraftStore.save({
      templateId: template.id,
      clientLabel: caseLabelInput.value,
      pageNumber,
      values,
      savedAt: new Date().toISOString(),
    });
  }

  async function restoreFillDraftIfAny() {
    const draft = FillDraftStore.get();
    if (!draft || !draft.templateId) return;
    const tpl = TemplateStore.get(draft.templateId);
    if (!tpl) { FillDraftStore.clear(); return; }
    restoringFillDraft = true;
    try {
      select.value = tpl.id;
      caseLabelInput.value = draft.clientLabel || '';
      await activateTemplate(tpl, draft.values || {});
      pageNumber = Math.min(draft.pageNumber || 1, template.pages.length);
      pageNav.classList.toggle('hidden', template.pages.length <= 1);
      await renderCurrentPage();
      showStatus('前回の入力内容を復元しました');
    } finally {
      restoringFillDraft = false;
    }
  }

  async function refreshTemplateOptions() {
    const current = select.value;
    const templates = TemplateStore.list();
    select.innerHTML = '<option value="">-- テンプレートを選択 --</option>';
    templates.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name}（${t.pageCount}ページ）`;
      select.appendChild(opt);
    });
    if (templates.some(t => t.id === current)) select.value = current;

    // テンプレート作成モードで、今まさに開いているテンプレートが更新されていたら、
    // 入力済みの値はそのまま保った上で様式（PDF・項目位置）だけ最新化する
    if (template) {
      const latest = TemplateStore.get(template.id);
      if (!latest) {
        resetView();
        showStatus('編集中のテンプレートが削除されたため選択が解除されました', true);
      } else if (latest.createdAt !== template.createdAt) {
        const keepPageNumber = pageNumber;
        template = latest;
        const buf = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
        pdfDoc = await PdfUtils.loadPdf(buf);
        pageNumber = Math.min(keepPageNumber, template.pages.length);
        pageNav.classList.toggle('hidden', template.pages.length <= 1);
        await renderCurrentPage();
        showStatus('テンプレートが更新されたため様式を最新化しました（入力内容はそのまま残っています）');
      }
    }
  }

  function resetView() {
    FillDraftStore.clear();
    currentCaseFileHandle = null;
    template = null;
    values = {};
    pdfDoc = null;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    overlay.innerHTML = '';
    pageNav.classList.add('hidden');
    exportBtn.disabled = true;
    openBtn.disabled = true;
    autoFillBtn.disabled = true;
    saveToProfileBtn.disabled = true;
    saveCaseBtn.disabled = true;
  }

  // テンプレート本体（PDF＋項目定義）と、入力済みの値（未指定なら空）を画面に反映する
  async function activateTemplate(tpl, initialValues) {
    template = tpl;
    values = initialValues || {};
    const buf = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    pdfDoc = await PdfUtils.loadPdf(buf);
    pageNumber = 1;
    pageNav.classList.toggle('hidden', template.pages.length <= 1);
    exportBtn.disabled = false;
    openBtn.disabled = false;
    autoFillBtn.disabled = false;
    saveToProfileBtn.disabled = false;
    saveCaseBtn.disabled = false;
    await renderCurrentPage();
    // 新しい様式を開いた時は、まず全体表示に合わせる（密集した項目も見渡してから入力できるように）
    zoom.fitToView(stageWrap);
    updateZoomLabel();
    await renderCurrentPage();
  }

  function updateZoomLabel() {
    zoomLabel.textContent = zoom.getLabel();
  }

  zoomOutBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.zoomOut(); updateZoomLabel(); renderCurrentPage(); });
  zoomInBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.zoomIn(); updateZoomLabel(); renderCurrentPage(); });
  zoomFitBtn.addEventListener('click', () => { if (!pdfDoc) return; zoom.fitToView(stageWrap); updateZoomLabel(); renderCurrentPage(); });

  // トラックパッドのピンチイン・アウトはブラウザにctrl+wheelとして伝わるため、そのままだと
  // ページ全体がブラウザの拡大縮小になってしまう。ここで検知して自前のズームに差し替える
  stageWrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !pdfDoc) return;
    e.preventDefault();
    if (e.deltaY < 0) zoom.zoomIn(); else zoom.zoomOut();
    updateZoomLabel();
    renderCurrentPage();
  }, { passive: false });

  // キーボードの+/-/0でもズームできるようにする（入力欄にフォーカスがある時は横取りしない）
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('modeFiller').classList.contains('hidden')) return;
    const active = document.activeElement;
    // チェック・丸囲みのトグルやマス目もinput要素だが、クリック/入力直後にズームのキー操作まで
    // 効かなくなるのは行き過ぎなので、横取りの対象はテキスト系の入力欄だけにする
    const isTextInput = (active.tagName === 'INPUT' && active.type !== 'checkbox') || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
    if (isTextInput) return;
    if (!pdfDoc) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom.zoomIn(); updateZoomLabel(); renderCurrentPage(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom.zoomOut(); updateZoomLabel(); renderCurrentPage(); }
    else if (e.key === '0') { e.preventDefault(); zoom.fitToView(stageWrap); updateZoomLabel(); renderCurrentPage(); }
  });

  async function loadTemplate(id) {
    const tpl = TemplateStore.get(id);
    if (!tpl) { resetView(); return; }
    caseLabelInput.value = '';
    currentCaseFileHandle = null; // 白紙から始めるので、以前開いていたファイルとの上書き紐付けは解除する
    caseFileStatusEl.textContent = '';
    await activateTemplate(tpl, {});
  }

  async function renderCurrentPage() {
    await PdfUtils.renderPageToCanvas(pdfDoc, pageNumber, canvas, zoom.getScale());
    zoom.setPageSize(template.pages[pageNumber - 1].widthPt, template.pages[pageNumber - 1].heightPt);
    pageLabel.textContent = `${pageNumber} / ${template.pages.length} ページ`;
    renderInputs();
  }

  function renderInputs() {
    overlay.innerHTML = '';
    const page = template.pages[pageNumber - 1];
    // Tabキーで上から下・左から右の自然な順に移動できるよう、見た目の位置(PDF座標。ズームに影響されない)で
    // 並び替えてから連番のtabIndexを振る。DOM挿入順（＝項目を作った順）のままだと、後から追加した
    // 上部の項目に飛べない等、読み上げ順とズレて使いにくくなるため
    const sortedFields = [...page.fields].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 8) return b.y - a.y; // PDF座標はy値が大きいほど上。8pt以上離れていれば別の行とみなす
      return a.x - b.x;
    });
    let tabIndex = 1;
    sortedFields.forEach(field => {
      const pos = PdfUtils.pdfRectToPixel(field, page.heightPt, zoom.getScale());
      if (field.type === 'checkbox' || field.type === 'circle') {
        renderMarkToggle(field, pos, tabIndex++);
      } else if (field.type === 'boxed') {
        tabIndex = renderBoxedCellInputs(field, pos, tabIndex);
      } else {
        const input = document.createElement(field.multiline ? 'textarea' : 'input');
        if (!field.multiline) input.type = 'text';
        input.className = 'fill-input' + (field.multiline ? ' fill-textarea' : '');
        input.dataset.fieldId = field.id;
        input.tabIndex = tabIndex++;
        input.style.left = pos.left + 'px';
        input.style.top = pos.top + 'px';
        input.style.width = pos.width + 'px';
        input.style.height = pos.height + 'px';
        input.style.fontSize = ((field.fontSize || 11) * zoom.getScale()) + 'px';
        input.style.textAlign = (field.align === 'center' || field.align === 'right') ? field.align : 'left';
        // 項目名（「月」「日」「主治医」等）をプレースホルダーとして常時表示すると、狭い欄では
        // 特に見づらく主張が強すぎるとの指摘のため表示しない。確認したい時だけホバーのtitleで見せる
        input.title = field.label;
        input.value = values[field.id] || '';
        input.addEventListener('input', () => { values[field.id] = input.value; onValueChanged(); });
        overlay.appendChild(input);

        // 単語リストに候補が複数ある項目は、この場でどれを使うか選べるボタンを入力欄のすぐ横に出す
        // （サイドバーの一覧から探して選ぶのは遠くて分かりにくいという指摘のため、フィールド本体に統合した）
        const candidates = ProfileStore.getCandidates(field.label);
        if (candidates.length > 1) {
          renderCandidatePicker(field, pos, candidates, input);
        }
      }
    });
    renderFieldStatusList();
  }

  // 入力欄のすぐ右に「▾」ボタンを置き、クリックするとその場に候補の一覧を出す
  function renderCandidatePicker(field, pos, candidates, input) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'field-candidate-btn';
    btn.textContent = '▾';
    btn.title = `候補から選ぶ（${candidates.length}件）`;
    btn.style.left = (pos.left + pos.width + 2) + 'px';
    btn.style.top = pos.top + 'px';
    btn.style.height = pos.height + 'px';
    overlay.appendChild(btn);

    // 候補ボタンは、様式の文字と重なって邪魔にならないよう、その入力欄を選択中の時だけ表示する
    input.addEventListener('focus', () => btn.classList.add('visible'));
    input.addEventListener('blur', () => {
      // ボタンをクリックした時のmousedownでフォーカスを奪わないようにしているので、
      // ここで消えるのは「本当に他の場所をクリック/Tabで移動した」時だけになる
      const dropdownOpen = !!overlay.querySelector('.field-candidate-dropdown');
      if (!dropdownOpen) btn.classList.remove('visible');
    });
    // ボタンをクリックしても入力欄のフォーカスが外れないようにする（外れるとボタンが即座に消えてクリックが成立しなくなるため）
    btn.addEventListener('mousedown', (e) => e.preventDefault());

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = overlay.querySelector('.field-candidate-dropdown');
      if (existing) existing.remove();

      const dropdown = document.createElement('div');
      dropdown.className = 'field-candidate-dropdown';
      dropdown.style.left = pos.left + 'px';
      dropdown.style.top = (pos.top + pos.height + 4) + 'px';
      dropdown.addEventListener('mousedown', (e) => e.preventDefault()); // 候補クリックでも入力欄のフォーカスを外さない

      function closeDropdown() {
        dropdown.remove();
        document.removeEventListener('mousedown', closeOnOutsideClick);
      }

      candidates.forEach(c => {
        const row = document.createElement('div');
        row.textContent = c;
        if (values[field.id] === c) row.classList.add('current');
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          values[field.id] = c;
          input.value = c;
          onValueChanged();
          closeDropdown();
        });
        dropdown.appendChild(row);
      });
      overlay.appendChild(dropdown);

      // 他の場所をクリックしたら閉じる
      function closeOnOutsideClick(ev) {
        if (!dropdown.contains(ev.target) && ev.target !== btn) closeDropdown();
      }
      setTimeout(() => document.addEventListener('mousedown', closeOnOutsideClick), 0);
    });
  }

  // 入力の変更があるたびに、自動保存の予約とサイドバーの入力状況一覧の更新をまとめて行う
  function onValueChanged() {
    scheduleFillDraftSave();
    renderFieldStatusList();
  }

  function typeLabel(type) {
    if (type === 'checkbox') return 'チェック';
    if (type === 'circle') return '丸囲み';
    if (type === 'boxed') return 'マス目';
    return 'テキスト';
  }

  // サイドバーの「このページの入力状況」一覧。クリックでPDF上の該当項目までスクロールし、
  // チェック・丸囲みはここからも直接ON/OFFを切り替えられる（小さい枠を狙いにくい場合の代替手段）
  function renderFieldStatusList() {
    fieldStatusListEl.innerHTML = '';
    if (!template) {
      fieldStatusEmptyEl.classList.remove('hidden');
      return;
    }
    const page = template.pages[pageNumber - 1];
    fieldStatusEmptyEl.classList.toggle('hidden', page.fields.length > 0);
    page.fields.forEach(field => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.style.cursor = 'pointer';
      left.title = 'クリックでPDF上のこの項目までスクロールします';
      left.addEventListener('click', () => scrollFieldIntoView(field));

      const typeTag = document.createElement('span');
      typeTag.className = 'field-type-tag';

      if (field.type === 'checkbox' || field.type === 'circle') {
        const checked = !!values[field.id];
        left.textContent = field.label;
        typeTag.textContent = checked ? `✓ ${typeLabel(field.type)}` : `未選択（${typeLabel(field.type)}）`;
        typeTag.style.cursor = 'pointer';
        typeTag.title = 'クリックでON/OFFを切り替えます';
        typeTag.addEventListener('click', (e) => {
          e.stopPropagation();
          values[field.id] = !values[field.id];
          renderInputs();
        });
      } else {
        const v = values[field.id];
        left.textContent = field.label + '：' + (v ? String(v) : '(未入力)');
        typeTag.textContent = typeLabel(field.type);
      }
      left.appendChild(typeTag);

      // 単語リストに候補が複数ある項目は、PDF上の入力欄のすぐ横にある「▾」ボタンで選べる。
      // ここでは「候補がある」ことだけ示し、実際の選択はフィールド本体側で行う
      if (field.type === 'text') {
        const candidates = ProfileStore.getCandidates(field.label);
        if (candidates.length > 1) {
          const hint = document.createElement('span');
          hint.className = 'field-type-tag';
          hint.textContent = `候補${candidates.length}件`;
          left.appendChild(hint);
        }
      }

      li.appendChild(left);
      fieldStatusListEl.appendChild(li);
    });
  }

  // スクロールで画面外に出た項目でも、一覧クリックでPDFプレビューを自動スクロール＆一瞬ハイライトして場所を教える
  function scrollFieldIntoView(field) {
    const page = template.pages[pageNumber - 1];
    const pos = PdfUtils.pdfRectToPixel(field, page.heightPt, zoom.getScale());
    const targetTop = pos.top - (stageWrap.clientHeight - pos.height) / 2;
    stageWrap.scrollTo({ top: Math.max(targetTop, 0), left: 0, behavior: 'smooth' });
    overlay.querySelectorAll(`[data-field-id="${field.id}"]`).forEach(el => {
      el.classList.add('field-box-flash');
      setTimeout(() => el.classList.remove('field-box-flash'), 1200);
    });
  }

  // チェック／丸囲みタイプ：ブラウザ標準のチェックボックスではなく、実際に出力される
  // マーク（✓・○）そのものの見た目でクリック切り替えできるようにする
  // 以前はrole="checkbox"付きの自作divで実装していたが、ブラウザによってクリックが
  // 正しく反映されないことが分かったため、確実に動作するネイティブの<input type="checkbox">を
  // 使う方式に変更した（見た目はCSSで✓・○として描画し、チェックボックスらしい見た目は消す）
  function renderMarkToggle(field, pos, tabIndex) {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'fill-mark-toggle ' + field.type;
    toggle.dataset.fieldId = field.id;
    toggle.tabIndex = tabIndex;
    toggle.style.left = pos.left + 'px';
    toggle.style.top = pos.top + 'px';
    toggle.style.width = pos.width + 'px';
    toggle.style.height = pos.height + 'px';
    toggle.style.fontSize = Math.min(pos.height * 0.85, 26) + 'px';
    toggle.title = field.label;
    toggle.checked = !!values[field.id];
    toggle.addEventListener('change', () => {
      values[field.id] = toggle.checked;
      onValueChanged();
    });
    overlay.appendChild(toggle);
  }

  // マス目タイプ：テンプレート作成時と同じマス幅・間隔・文字サイズで、1マス1入力欄を並べる
  // （背景はほぼ透明なので、印刷済みの罫線が見えたまま実寸で入力できる）
  function renderBoxedCellInputs(field, pos, tabIndexStart) {
    const scale = zoom.getScale();
    const count = Math.max(field.cellCount || 1, 1);
    const gapPx = (field.cellGap || 0) * scale;
    const cellWidth = Math.max((pos.width - (count - 1) * gapPx) / count, 4);
    const fontSizePx = (field.fontSize || 11) * scale;

    const stored = values[field.id] || '';
    const chars = Array.from({ length: count }, (_, i) => stored[i] || '');
    const cellInputs = [];

    function commit() {
      values[field.id] = chars.join('').replace(/\s+$/, '');
      onValueChanged();
    }

    // 漢字変換（IME）は「確定時に複数文字がまとめて入る」「変換中に何度もinputが発火する」ため、
    // 変換中は何もせず、確定した時にまとめて後続のマスへ振り分ける
    function finalizeCell(i, cellInput) {
      const text = cellInput.value;
      if (text.length <= 1) {
        chars[i] = text;
        commit();
        if (text && i < count - 1) cellInputs[i + 1].focus();
        return;
      }
      for (let j = 0; j < text.length && (i + j) < count; j++) {
        chars[i + j] = text[j];
        cellInputs[i + j].value = text[j];
      }
      commit();
      cellInputs[Math.min(i + text.length, count - 1)].focus();
    }

    for (let i = 0; i < count; i++) {
      const cellInput = document.createElement('input');
      cellInput.type = 'text';
      cellInput.className = 'fill-cell-input';
      cellInput.dataset.fieldId = field.id;
      cellInput.tabIndex = tabIndexStart + i;
      cellInput.style.left = (pos.left + i * (cellWidth + gapPx)) + 'px';
      cellInput.style.top = pos.top + 'px';
      cellInput.style.width = cellWidth + 'px';
      cellInput.style.height = pos.height + 'px';
      cellInput.style.fontSize = fontSizePx + 'px';
      cellInput.title = field.label;
      cellInput.value = chars[i];
      cellInput.addEventListener('input', (e) => {
        if (e.isComposing) return; // IME変換中の中間状態は無視する
        finalizeCell(i, cellInput);
      });
      cellInput.addEventListener('compositionend', () => {
        finalizeCell(i, cellInput);
      });
      cellInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !cellInput.value && i > 0) {
          cellInputs[i - 1].focus();
        } else if (e.key === 'ArrowLeft' && i > 0) {
          cellInputs[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < count - 1) {
          cellInputs[i + 1].focus();
        }
      });
      overlay.appendChild(cellInput);
      cellInputs.push(cellInput);
    }
    return tabIndexStart + count;
  }

  // fetch()は使わない（file://でダブルクリック起動した場合に読み込めなくなるため）。
  // notosansjp_base64.jsで埋め込んだbase64文字列からその場で復元する
  function loadFontBytes() {
    if (!cachedFontBytes) {
      cachedFontBytes = PdfUtils.base64ToArrayBuffer(NOTO_SANS_JP_BASE64);
    }
    return cachedFontBytes;
  }

  // 手書き・スタンプの記入色に合わせて黒系で描く（赤色は「未記入の目印」と紛らわしいという指摘のため）
  const MARK_COLOR = PDFLib.rgb(0.05, 0.05, 0.1);

  // チェック欄は文字コードに依存しない「レ」のような二本線で描く（フォントの記号有無に左右されないため）
  function drawCheckMark(page, cx, cy, size) {
    const s = size;
    const x = cx - s / 2;
    const y = cy - s / 2;
    page.drawLine({ start: { x: x, y: y + s * 0.35 }, end: { x: x + s * 0.35, y: y }, thickness: 1.4, color: MARK_COLOR });
    page.drawLine({ start: { x: x + s * 0.35, y: y }, end: { x: x + s, y: y + s * 0.9 }, thickness: 1.4, color: MARK_COLOR });
  }

  function drawCircleMark(page, cx, cy, rx, ry) {
    page.drawEllipse({
      x: cx, y: cy, xScale: rx, yScale: ry,
      borderColor: MARK_COLOR,
      borderWidth: 1.5,
    });
  }

  // 配置設定(left/center/right)に応じて、描画する文字列のx座標を求める
  function alignedX(field, textWidth) {
    if (field.align === 'center') return field.x + (field.width - textWidth) / 2;
    if (field.align === 'right') return field.x + field.width - textWidth - 2;
    return field.x + 2;
  }

  // 枠の幅(maxWidth)を超える場合は、収まるまでフォントサイズを縮小する
  function fitFontSize(font, text, baseSize, maxWidth) {
    if (!maxWidth) return baseSize;
    const width = font.widthOfTextAtSize(text, baseSize);
    if (width <= maxWidth) return baseSize;
    return Math.max(baseSize * (maxWidth / width), 6);
  }

  // マス目タイプ：1文字ずつマスの中央に配置する（被保険者番号などの枠に合わせる。テンプレ作成時のプレビューと同じ計算式）
  function drawBoxedText(page, font, field, text) {
    const count = field.cellCount || 1;
    const gap = field.cellGap || 0;
    const cellWidth = Math.max((field.width - (count - 1) * gap) / count, 2);
    const baseY = field.y + field.height * 0.22;
    for (let i = 0; i < Math.min(text.length, count); i++) {
      const ch = text[i];
      const size = fitFontSize(font, ch, field.fontSize || 11, cellWidth - 2);
      const charWidth = font.widthOfTextAtSize(ch, size);
      const cellLeft = field.x + i * (cellWidth + gap);
      const cx = cellLeft + (cellWidth - charWidth) / 2;
      page.drawText(ch, { x: cx, y: baseY, size, font, color: PDFLib.rgb(0.05, 0.05, 0.1) });
    }
  }

  // 改行(\n)ごとに段落を分け、それぞれ枠の幅を超えたら1文字単位で自動的に折り返す
  // （日本語は単語の区切りにスペースを使わないため、単語単位ではなく文字単位で折り返す）
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

  // 複数行タイプ：枠の幅で自動折り返し、枠の高さに収まらない場合はfitFontSizeと同じ考え方で
  // 収まるまでフォントサイズを縮小する。それでも入りきらない行は枠の外に出るため描画を打ち切る
  function drawMultilineText(page, font, field, text) {
    const maxWidth = Math.max(field.width - 4, 4);
    let size = field.fontSize || 11;
    let lines = wrapTextToLines(font, text, size, maxWidth);
    let lineHeight = size * 1.3;
    while (lines.length * lineHeight > field.height && size > 6) {
      size -= 0.5;
      lineHeight = size * 1.3;
      lines = wrapTextToLines(font, text, size, maxWidth);
    }
    let y = field.y + field.height - lineHeight * 0.9;
    for (const line of lines) {
      if (y < field.y) break; // 枠に入りきらない行はここで描画を打ち切る
      if (line) {
        const lineWidth = font.widthOfTextAtSize(line, size);
        page.drawText(line, { x: alignedX(field, lineWidth), y, size, font, color: PDFLib.rgb(0.05, 0.05, 0.1) });
      }
      y -= lineHeight;
    }
  }

  async function buildFilledPdf() {
    const { PDFDocument, rgb } = PDFLib;
    const bytes = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    const pdfLibDoc = await PDFDocument.load(bytes);
    pdfLibDoc.registerFontkit(fontkit);
    const fontBytes = await loadFontBytes();
    const font = await pdfLibDoc.embedFont(fontBytes, { subset: false });
    const pages = pdfLibDoc.getPages();

    template.pages.forEach((pageData, i) => {
      const pdfPage = pages[i];
      pageData.fields.forEach(field => {
        const value = values[field.id];
        const cx = field.x + field.width / 2;
        const cy = field.y + field.height / 2;
        if (field.type === 'checkbox') {
          if (value) drawCheckMark(pdfPage, cx, cy, Math.min(field.width, field.height) * 0.8);
        } else if (field.type === 'circle') {
          if (value) drawCircleMark(pdfPage, cx, cy, field.width / 2, field.height / 2);
        } else if (field.type === 'boxed') {
          if (value && String(value).trim()) drawBoxedText(pdfPage, font, field, String(value).trim());
        } else if (field.multiline) {
          if (value && String(value).trim()) drawMultilineText(pdfPage, font, field, String(value));
        } else if (value && String(value).trim()) {
          const text = String(value);
          const baseSize = field.fontSize || 11;
          const size = fitFontSize(font, text, baseSize, field.width);
          const textWidth = font.widthOfTextAtSize(text, size);
          pdfPage.drawText(text, {
            x: alignedX(field, textWidth),
            y: field.y + field.height * 0.22,
            size,
            font,
            color: rgb(0.05, 0.05, 0.1),
          });
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
    if (!template) return;
    showStatus('PDFを作成しています…');
    try {
      const pdfBytes = await buildFilledPdf();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${template.name}_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('PDFをダウンロードしました');
    } catch (e) {
      console.error(e);
      showStatus('PDFの作成に失敗しました：' + e.message, true);
    }
  }

  async function exportAndOpen() {
    if (!template) return;
    showStatus('PDFを作成しています…');
    try {
      const pdfBytes = await buildFilledPdf();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      showStatus('新しいタブで開きました');
    } catch (e) {
      console.error(e);
      showStatus('PDFの作成に失敗しました：' + e.message, true);
    }
  }

  // プロフィールに登録済みの値を、同じ項目名のテキスト欄に反映する（すでに入力済みの欄は上書きしない）
  // 候補が1件しかない項目だけを自動入力する（複数候補がある項目は「どれを使うか」を
  // 機械的に決められないため、このボタンでは触らず「このページの入力状況」から選んでもらう）
  function autoFillFromProfile() {
    if (!template) return;
    let count = 0;
    template.pages.forEach(page => {
      page.fields.forEach(field => {
        if (field.type !== 'text' || values[field.id]) return;
        const candidates = ProfileStore.getCandidates(field.label);
        if (candidates.length === 1) {
          values[field.id] = candidates[0];
          count++;
        }
      });
    });
    renderInputs();
    if (count > 0) scheduleFillDraftSave();
    showStatus(count > 0 ? `${count}件を自動入力しました` : '候補が1件だけの項目がありませんでした');
  }

  // 現在入力されている値を、項目名をキーにして単語リストへ候補として追加する（既存の候補は消さない）
  function saveCurrentToProfile() {
    if (!template) return;
    let count = 0;
    template.pages.forEach(page => {
      page.fields.forEach(field => {
        if (field.type === 'text') {
          const v = values[field.id];
          if (v && String(v).trim()) {
            ProfileStore.addCandidate(field.label, String(v).trim());
            count++;
          }
        }
      });
    });
    showStatus(`${count}件を単語リストに追加しました`);
  }

  function sanitizeFileNamePart(s) {
    return s.replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  // 様式（PDF＋項目定義）と入力済みの答えの両方を1つのファイルにまとめて書き出す
  // 利用者様ごとのフォルダに保管しておけば、後日このファイルを開くだけで続きから修正・再提出できる。
  //
  // 対応ブラウザ（Chrome/Edge等のFile System Access API対応ブラウザ）では、
  // 既に開いた・保存したファイルのハンドルを覚えておき、同じファイルへの上書き保存ができる
  // （そうしないと保存するたびに新しいファイルがどんどん増えてしまうため）。
  // 非対応ブラウザ（Safari/Firefox等）では、従来通り毎回ダウンロードする方式にフォールバックする
  async function saveCaseFile() {
    if (!template) return;
    const record = {
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      clientLabel: caseLabelInput.value.trim(),
      template,
      values,
    };
    const json = JSON.stringify(record, null, 2);
    const labelPart = record.clientLabel ? `_${sanitizeFileNamePart(record.clientLabel)}` : '';
    const suggestedName = `${sanitizeFileNamePart(template.name)}${labelPart}_${new Date().toISOString().slice(0, 10)}.json`;

    if (currentCaseFileHandle) {
      try {
        const writable = await currentCaseFileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        FillDraftStore.clear();
        caseFileStatusEl.textContent = `📎 「${currentCaseFileHandle.name}」に上書き保存しました`;
        showStatus('入力データを上書き保存しました');
        return;
      } catch (e) {
        console.error(e);
        currentCaseFileHandle = null; // ハンドルが無効になっている可能性があるので、以降は新規保存に切り替える
      }
    }

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: '入力データ(.json)', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        currentCaseFileHandle = handle; // 次回からはこのボタンで同じファイルに上書きできる
        FillDraftStore.clear();
        caseFileStatusEl.textContent = `📎 「${handle.name}」として保存しました（次回からはこのボタンで上書き保存されます）`;
        showStatus('入力データを保存しました');
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // 保存先の選択をキャンセルした
        console.error(e);
        // 何らかの理由で失敗した場合は、下の従来方式にフォールスルーする
      }
    }

    // フォールバック：File System Access API非対応ブラウザは、従来通りダウンロードする
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    FillDraftStore.clear();
    showStatus('入力データを保存しました。利用者様のフォルダなどに保管してください');
  }

  async function loadCaseFile(file, handle) {
    try {
      const text = await file.text();
      const record = JSON.parse(text);
      if (!record.template || !Array.isArray(record.template.pages)) {
        throw new Error('ファイルの形式が正しくありません');
      }
      caseLabelInput.value = record.clientLabel || '';
      currentCaseFileHandle = handle || null;
      caseFileStatusEl.textContent = handle
        ? `📎 「${handle.name}」を編集中（保存すると上書きされます）`
        : '';
      // テンプレートがまだ一覧に残っていれば、新しく追加された項目なども反映されるよう最新版を優先して使う。
      // 一覧に見つからない場合（削除済み・別のPCで開いた等）だけ、ファイルに埋め込まれた保存時点の様式にフォールバックする
      const latest = TemplateStore.get(record.template.id);
      const templateToUse = latest || record.template;
      select.value = latest ? latest.id : '';
      await activateTemplate(templateToUse, record.values || {});
      showStatus(
        `入力データを読み込みました（${templateToUse.name}）` +
        (latest ? '' : '※このテンプレートは一覧に見つからなかったため、保存時点の様式をそのまま使用しています')
      );
    } catch (e) {
      console.error(e);
      showStatus('入力データの読み込みに失敗しました：' + e.message, true);
    }
  }

  // 入力中に閉じたり移動したりして消えてしまわないよう、未保存の入力があれば警告する
  window.addEventListener('beforeunload', (e) => {
    const hasValue = template && Object.values(values).some(v => v !== '' && v != null && v !== false);
    if (hasValue) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  select.addEventListener('change', () => loadTemplate(select.value));
  autoFillBtn.addEventListener('click', autoFillFromProfile);
  saveToProfileBtn.addEventListener('click', saveCurrentToProfile);
  saveCaseBtn.addEventListener('click', saveCaseFile);

  // 対応ブラウザではshowOpenFilePickerでファイルハンドルごと取得し、後の上書き保存に使えるようにする。
  // 非対応ブラウザでは従来通りの<input type="file">にフォールバックする
  loadCaseBtn.addEventListener('click', async () => {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: '入力データ(.json)', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        await loadCaseFile(file, handle);
      } catch (e) {
        if (e.name !== 'AbortError') console.error(e);
      }
      return;
    }
    loadCaseInput.click();
  });
  loadCaseInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadCaseFile(file);
    loadCaseInput.value = '';
  });
  prevBtn.addEventListener('click', () => { if (pageNumber > 1) { pageNumber--; renderCurrentPage(); } });
  nextBtn.addEventListener('click', () => { if (pageNumber < template.pages.length) { pageNumber++; renderCurrentPage(); } });
  exportBtn.addEventListener('click', exportAndDownload);
  openBtn.addEventListener('click', exportAndOpen);
  caseLabelInput.addEventListener('input', scheduleFillDraftSave);

  async function init() {
    await restoreFillDraftIfAny();
    refreshTemplateOptions();
  }

  return { init, refreshTemplateOptions };
})();
