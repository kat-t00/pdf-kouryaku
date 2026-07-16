// 入力・出力モードの「作業中の入力内容」を自動保存する（genogram_appなどと同じ考え方）
// ここは氏名・住所などの個人情報を含みうるため、あくまで作業中の一時的な保険として扱う。
// 「この入力内容を保存」でファイルに書き出したら、ローカルの控えとしての役目は終わるのでクリアする
const FillDraftStore = (() => {
  const KEY = 'shinsei_form_fill_draft_v1';

  function save(draft) {
    localStorage.setItem(KEY, JSON.stringify(draft));
  }

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('入力内容の下書きの読込に失敗しました', e);
      return null;
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  return { save, get, clear };
})();
