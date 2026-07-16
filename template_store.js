// テンプレート（自治体ごとの様式定義）をブラウザのlocalStorageに保存・読込する
// テンプレートの中身は { id, name, createdAt, pdfBase64, pages: [{ widthPt, heightPt, fields: [...] }] }
const TemplateStore = (() => {
  const STORAGE_KEY = 'shinsei_form_templates_v1';

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('テンプレートの読込に失敗しました', e);
      return [];
    }
  }

  function saveAll(templates) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  }

  function list() {
    return loadAll()
      .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, pageCount: t.pages.length }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function get(id) {
    const t = loadAll().find(t => t.id === id) || null;
    return t ? normalizeTemplate(t) : null;
  }

  // このアプリは開発中に項目のデータ形式（点+半径 → 矩形 等）を何度か変更してきた。
  // 古い形式のまま保存されているテンプレートを読み込んだ時にwidth/height等が欠けて
  // 画面に出てこなくなる・クリックできなくなる、といった不具合を防ぐため、
  // 読み込み時に必ずこの関数を通して現在の形式に補正する
  function normalizeField(field) {
    const f = Object.assign({}, field);
    if (!(typeof f.width === 'number' && isFinite(f.width) && f.width > 0)) {
      f.width = (typeof f.rx === 'number' ? f.rx * 2 : 0) || f.maxWidth || 80;
    }
    if (!(typeof f.height === 'number' && isFinite(f.height) && f.height > 0)) {
      f.height = (typeof f.ry === 'number' ? f.ry * 2 : 0) || ((f.fontSize || 11) * 1.5);
    }
    if (!(typeof f.x === 'number' && isFinite(f.x))) f.x = 0;
    if (!(typeof f.y === 'number' && isFinite(f.y))) f.y = 0;
    if (!f.type) f.type = 'text';
    if ((f.type === 'text' || f.type === 'boxed') && !(typeof f.fontSize === 'number' && f.fontSize > 0)) {
      f.fontSize = 11;
    }
    if (f.type === 'boxed') {
      if (!(typeof f.cellCount === 'number' && f.cellCount > 0)) f.cellCount = 1;
      if (typeof f.cellGap !== 'number' || !isFinite(f.cellGap)) f.cellGap = 0;
    }
    return f;
  }

  function normalizeTemplate(t) {
    return Object.assign({}, t, {
      pages: (t.pages || []).map(p => Object.assign({}, p, { fields: (p.fields || []).map(normalizeField) })),
    });
  }

  function save(template) {
    const templates = loadAll();
    const idx = templates.findIndex(t => t.id === template.id);
    if (idx >= 0) {
      templates[idx] = template;
    } else {
      templates.push(template);
    }
    saveAll(templates);
  }

  function remove(id) {
    saveAll(loadAll().filter(t => t.id !== id));
  }

  // バックアップ用：PDF本体・座標定義を含む全データをそのまま返す（他デバイスへの引っ越し・職場内共有用）
  function exportAll() {
    return loadAll().map(normalizeTemplate);
  }

  // バックアップファイルの読み込み：同じidのテンプレートは上書き、新しいidは追加
  function importAll(templates) {
    if (!Array.isArray(templates)) throw new Error('バックアップファイルの形式が正しくありません');
    templates.forEach(t => {
      if (t && t.id && t.name && Array.isArray(t.pages)) save(t);
    });
    return templates.length;
  }

  // 全テンプレートで実際に使われているテキスト項目のラベルを重複なく集める。
  // 入力単語リストの項目名を「1から手打ち」させず、既存の項目名から選べるようにするために使う
  function listAllTextFieldLabels() {
    const labels = new Set();
    loadAll().forEach(t => {
      (t.pages || []).forEach(p => {
        (p.fields || []).forEach(f => {
          if (f.type === 'text' && f.label) labels.add(f.label);
        });
      });
    });
    return Array.from(labels).sort((a, b) => a.localeCompare(b, 'ja'));
  }

  function makeId() {
    return 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function makeFieldId() {
    return 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  return { list, get, save, remove, exportAll, importAll, makeId, makeFieldId, listAllTextFieldLabels };
})();
