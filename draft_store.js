// テンプレート作成モードの「作業中の下書き」を自動保存する（genogram_appなどと同じ考え方）
// 個人情報は含まない（PDF様式と項目の位置定義のみ）ので、ここはlocalStorageに残して問題ない
const DraftStore = (() => {
  const KEY = 'shinsei_form_editor_draft_v1';

  function save(draft) {
    localStorage.setItem(KEY, JSON.stringify(draft));
  }

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('下書きの読込に失敗しました', e);
      return null;
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  return { save, get, clear };
})();
