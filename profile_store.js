// 入力単語リスト：氏名・主治医名・医療機関名など、様式をまたいで使い回す値をlocalStorageに保存する。
// キーは項目名（テンプレート作成時に付けたラベルと完全一致させて対応づける）。
// 1つの項目名につき複数の候補値をストックできる（例：主治医名は担当利用者ごとに違うため）
const ProfileStore = (() => {
  const STORAGE_KEY = 'shinsei_form_profile_v1';

  function getAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      // 旧形式（項目名: 文字列1つ）で保存されたデータをここで配列に変換して読み込む
      Object.keys(data).forEach(label => {
        if (typeof data[label] === 'string') data[label] = data[label] ? [data[label]] : [];
      });
      return data;
    } catch (e) {
      console.error('入力単語リストの読込に失敗しました', e);
      return {};
    }
  }

  function saveAll(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function getCandidates(label) {
    return getAll()[label] || [];
  }

  // 同じ値が既にあれば増やさない
  function addCandidate(label, value) {
    const v = (value || '').trim();
    if (!v) return;
    const data = getAll();
    const list = data[label] || [];
    if (!list.includes(v)) list.push(v);
    data[label] = list;
    saveAll(data);
  }

  function removeCandidate(label, value) {
    const data = getAll();
    if (!data[label]) return;
    data[label] = data[label].filter(v => v !== value);
    if (data[label].length === 0) delete data[label];
    saveAll(data);
  }

  function removeLabel(label) {
    const data = getAll();
    delete data[label];
    saveAll(data);
  }

  return { getAll, getCandidates, addCandidate, removeCandidate, removeLabel };
})();
