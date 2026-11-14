'use strict';

/* ============================================================
 * じしょ — 自分だけの辞書アプリ
 * データはすべて localStorage に保存する（サーバー不要）
 * ============================================================ */

const STORAGE_KEY = 'app-jisyo:v1';

/* ---------- 保存と読み込み ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function newDict(name) {
  return { id: uid(), name, entries: [] };
}

function defaultState() {
  const d = newDict('わたしの辞書');
  return { version: 1, currentId: d.id, dicts: [d] };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.dicts) || s.dicts.length === 0) return defaultState();
    if (!s.dicts.some(d => d.id === s.currentId)) s.currentId = s.dicts[0].id;
    return s;
  } catch (e) {
    console.warn('読み込みに失敗しました', e);
    return defaultState();
  }
}

let saveWarned = false;
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存に失敗しました', e);
    if (!saveWarned) {
      toast('このブラウザでは保存できませんでした。書き出しでバックアップしてね');
      saveWarned = true;
    }
  }
}

let state = loadState();

const currentDict = () => state.dicts.find(d => d.id === state.currentId);

/* ---------- 文字の正規化（検索・並び替え用） ---------- */

// 全角/半角・大小文字・カタカナ/ひらがなの違いを吸収する
function normalize(str) {
  return (str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function sortKey(entry) {
  return normalize(entry.reading || entry.word);
}

const KANA_ROWS = [
  ['あ', 'ぁあぃいぅうぇえぉおゔ'],
  ['か', 'かがきぎくぐけげこごゕゖ'],
  ['さ', 'さざしじすずせぜそぞ'],
  ['た', 'ただちぢっつづてでとど'],
  ['な', 'なにぬねの'],
  ['は', 'はばぱひびぴふぶぷへべぺほぼぽ'],
  ['ま', 'まみむめも'],
  ['や', 'ゃやゅゆょよ'],
  ['ら', 'らりるれろ'],
  ['わ', 'ゎわゐゑをん'],
];

function groupLabel(entry) {
  const ch = sortKey(entry).charAt(0);
  if (!ch) return 'その他';
  for (const [label, chars] of KANA_ROWS) {
    if (chars.includes(ch)) return label + '行';
  }
  if (/[a-z]/.test(ch)) return ch.toUpperCase();
  if (/[0-9]/.test(ch)) return '0-9';
  return 'その他';
}

// 五十音順では かな → 英字 → 数字 → その他 の順に並べる
function scriptRank(entry) {
  const g = groupLabel(entry);
  if (g.endsWith('行')) return 0;
  if (/^[A-Z]$/.test(g)) return 1;
  if (g === '0-9') return 2;
  return 3;
}

const collator = new Intl.Collator('ja');

/* ---------- 画面の要素 ---------- */

const $ = sel => document.querySelector(sel);
const els = {
  dictList: $('#dictList'),
  newDict: $('#newDict'),
  renameDict: $('#renameDict'),
  deleteDict: $('#deleteDict'),
  dictTitle: $('#dictTitle'),
  kanaIndex: $('#kanaIndex'),
  indexNote: $('#indexNote'),
  search: $('#search'),
  sort: $('#sort'),
  addBtn: $('#addBtn'),
  emptyAdd: $('#emptyAdd'),
  tagBar: $('#tagBar'),
  filters: $('.filters'),
  stats: $('#stats'),
  list: $('#list'),
  empty: $('#empty'),
  dialog: $('#entryDialog'),
  form: $('#entryForm'),
  dialogTitle: $('#dialogTitle'),
  deleteEntry: $('#deleteEntry'),
  cancelEntry: $('#cancelEntry'),
  tagList: $('#tagList'),
  exportJson: $('#exportJson'),
  exportCsv: $('#exportCsv'),
  exportPdf: $('#exportPdf'),
  printView: $('#printView'),
  importFile: $('#importFile'),
  toast: $('#toast'),
};

const ui = {
  query: '',
  activeTag: null,
  editingId: null,
  animateNext: true, // 次の描画で項目をふわっと出すか（初回・辞書切り替え時）
};

try {
  const savedSort = localStorage.getItem(STORAGE_KEY + ':sort');
  if (savedSort) els.sort.value = savedSort;
} catch (e) { /* 使えない環境では無視 */ }

/* ---------- 描画 ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// 検索語の部分を <mark> で強調した要素を返す
function highlight(text, query) {
  const frag = document.createDocumentFragment();
  if (!query || !text) {
    frag.append(text || '');
    return frag;
  }
  const normText = normalize(text);
  // NFKC で長さが変わる文字があると位置がずれるので、その場合は強調しない
  if (normText.length !== text.length) {
    frag.append(text);
    return frag;
  }
  let i = 0;
  let idx;
  while ((idx = normText.indexOf(query, i)) !== -1) {
    frag.append(text.slice(i, idx));
    frag.append(el('mark', {}, text.slice(idx, idx + query.length)));
    i = idx + query.length;
  }
  frag.append(text.slice(i));
  return frag;
}

function allTags(dict) {
  const set = new Set();
  dict.entries.forEach(e => (e.tags || []).forEach(t => set.add(t)));
  return [...set].sort(collator.compare);
}

function renderDictList() {
  els.dictList.replaceChildren(
    ...state.dicts.map(d => el('li', {},
      el('button', {
        type: 'button',
        'aria-current': String(d.id === state.currentId),
        onclick: () => switchDict(d.id),
      },
        el('span', { class: 'name' }, d.name),
        el('span', { class: 'count' }, d.entries.length),
      )
    ))
  );
}

function renderTags(dict) {
  const tags = allTags(dict);
  if (ui.activeTag && !tags.includes(ui.activeTag)) ui.activeTag = null;
  els.tagBar.replaceChildren();
  els.tagList.replaceChildren(...tags.map(t => el('option', { value: t })));
  if (tags.length === 0) return;
  const mk = (label, value) =>
    el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(ui.activeTag === value),
      onclick: () => { ui.activeTag = value; render(); },
    }, label);
  els.tagBar.append(mk('すべて', null), ...tags.map(t => mk('#' + t, t)));
}

function filteredEntries(dict) {
  const q = normalize(ui.query.trim());
  let list = dict.entries.filter(e => {
    if (ui.activeTag && !(e.tags || []).includes(ui.activeTag)) return false;
    if (!q) return true;
    return [e.word, e.reading, e.meaning, e.example, (e.tags || []).join(' ')]
      .some(f => normalize(f).includes(q));
  });

  switch (els.sort.value) {
    case 'new': list.sort((a, b) => b.createdAt - a.createdAt); break;
    case 'old': list.sort((a, b) => a.createdAt - b.createdAt); break;
    case 'updated': list.sort((a, b) => b.updatedAt - a.updatedAt); break;
    default: list.sort((a, b) =>
      scriptRank(a) - scriptRank(b) || collator.compare(sortKey(a), sortKey(b)));
  }

  // 検索中は「見出し語に一致」を先に出す
  if (q) {
    const rank = e => normalize(e.word).startsWith(q) || normalize(e.reading).startsWith(q) ? 0
      : normalize(e.word).includes(q) || normalize(e.reading).includes(q) ? 1 : 2;
    list = list
      .map((e, i) => ({ e, i, r: rank(e) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(x => x.e);
  }
  return list;
}

// 見出し（あ行・E など）を大きな1文字と補足に分ける
function splitGroup(label) {
  if (label.endsWith('行')) return { char: label[0], sub: label, latin: false };
  if (/^[A-Z]$/.test(label)) return { char: label, sub: 'alphabet', latin: true };
  if (label === '0-9') return { char: '#', sub: '数字', latin: true };
  return { char: '…', sub: 'その他', latin: false };
}

const INDEX_KEYS = [
  ...KANA_ROWS.map(([label]) => ({ text: label, groups: [label + '行'] })),
  { text: 'A–Z', groups: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), latin: true },
  { text: '#', groups: ['0-9', 'その他'], latin: true },
];

function renderKanaIndex(present, usable) {
  els.indexNote.hidden = usable;
  els.kanaIndex.replaceChildren(...INDEX_KEYS.map(k => {
    const target = k.groups.find(g => present.has(g));
    return el('button', {
      type: 'button',
      class: k.latin ? 'latin' : '',
      'aria-label': k.text + (k.text.length === 1 && !k.latin ? '行へ' : 'へ'),
      ...(usable && target ? {} : { disabled: '' }),
      onclick: () => {
        const head = els.list.querySelector(`[data-group="${target}"]`);
        if (head) head.scrollIntoView({ block: 'start' });
      },
    }, k.text);
  }));
}

function renderEntry(e, q) {
  return el('button', {
    class: 'entry',
    type: 'button',
    onclick: () => openDialog(e.id),
  },
    el('span', { class: 'entry-headword' },
      el('span', { class: 'entry-word' }, highlight(e.word, q)),
      e.reading ? el('span', { class: 'entry-reading' }, highlight(e.reading, q)) : null,
    ),
    el('span', { class: 'entry-body' },
      el('p', { class: 'entry-meaning' }, highlight(e.meaning, q)),
      e.example ? el('p', { class: 'entry-example' }, highlight(e.example, q)) : null,
      (e.tags && e.tags.length)
        ? el('span', { class: 'entry-tags' }, ...e.tags.map(t => el('span', { class: 'tag' }, '#' + t)))
        : null,
    ),
    el('span', { class: 'entry-edit', 'aria-hidden': 'true' }, '編集 →'),
  );
}

function render() {
  const dict = currentDict();
  renderDictList();
  renderTags(dict);
  els.dictTitle.textContent = dict.name;
  document.title = `${dict.name} — JISYO`;

  const q = normalize(ui.query.trim());
  const list = filteredEntries(dict);
  const total = dict.entries.length;

  els.stats.textContent = total === 0 ? '0 words'
    : (q || ui.activeTag) ? `${list.length} / ${total} words`
    : `${total} words`;

  els.empty.hidden = total !== 0;
  els.filters.hidden = total === 0;
  els.list.hidden = total === 0;
  els.list.classList.toggle('animate', ui.animateNext);
  ui.animateNext = false;
  els.list.replaceChildren();

  const showGroups = els.sort.value === 'kana' && !q;
  const counts = new Map();
  if (showGroups) list.forEach(e => {
    const g = groupLabel(e);
    counts.set(g, (counts.get(g) || 0) + 1);
  });
  renderKanaIndex(new Set(counts.keys()), showGroups);

  if (total !== 0 && list.length === 0) {
    els.list.append(el('p', { class: 'no-result' }, '見つかりませんでした。'));
    return;
  }

  let lastGroup = null;
  let i = 0;
  for (const e of list) {
    if (showGroups) {
      const g = groupLabel(e);
      if (g !== lastGroup) {
        const { char, sub, latin } = splitGroup(g);
        const head = el('div', { class: 'group-head', 'data-group': g },
          el('span', { class: 'group-char' + (latin ? ' latin' : '') }, char),
          el('span', { class: 'group-sub' }, `${sub}・${counts.get(g)}語`),
        );
        head.style.setProperty('--i', Math.min(i++, 15));
        els.list.append(head);
        lastGroup = g;
      }
    }
    const node = renderEntry(e, q);
    node.style.setProperty('--i', Math.min(i++, 15));
    els.list.append(node);
  }
}

/* ---------- 追加・編集ダイアログ ---------- */

function parseTags(str) {
  return [...new Set(
    (str || '').split(/[,、，\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean)
  )];
}

function openDialog(id = null) {
  ui.editingId = id;
  const f = els.form.elements;
  const entry = id ? currentDict().entries.find(e => e.id === id) : null;

  els.dialogTitle.textContent = entry ? 'ことばを編集' : 'ことばを追加';
  els.deleteEntry.hidden = !entry;
  f.word.value = entry ? entry.word : (ui.query.trim() || '');
  f.reading.value = entry ? entry.reading || '' : '';
  f.meaning.value = entry ? entry.meaning : '';
  f.example.value = entry ? entry.example || '' : '';
  f.tags.value = entry ? (entry.tags || []).join(', ') : (ui.activeTag || '');

  els.dialog.showModal();
  f.word.focus();
}

els.form.addEventListener('submit', ev => {
  ev.preventDefault();
  const f = els.form.elements;
  const data = {
    word: f.word.value.trim(),
    reading: f.reading.value.trim(),
    meaning: f.meaning.value.trim(),
    example: f.example.value.trim(),
    tags: parseTags(f.tags.value),
  };
  if (!data.word || !data.meaning) return;

  const dict = currentDict();
  const now = Date.now();
  if (ui.editingId) {
    const entry = dict.entries.find(e => e.id === ui.editingId);
    Object.assign(entry, data, { updatedAt: now });
    toast('保存しました');
  } else {
    const dup = dict.entries.find(e => normalize(e.word) === normalize(data.word));
    if (dup && !confirm(`「${dup.word}」はもう登録されています。別の項目として追加する？`)) return;
    dict.entries.push({ id: uid(), ...data, createdAt: now, updatedAt: now });
    toast(`「${data.word}」を追加しました`);
  }
  saveState();
  els.dialog.close();
  render();
});

els.cancelEntry.addEventListener('click', () => els.dialog.close());

els.deleteEntry.addEventListener('click', () => {
  const dict = currentDict();
  const entry = dict.entries.find(e => e.id === ui.editingId);
  if (!entry || !confirm(`「${entry.word}」を削除する？`)) return;
  dict.entries = dict.entries.filter(e => e.id !== ui.editingId);
  saveState();
  els.dialog.close();
  render();
  toast('削除しました');
});

/* ---------- 辞書の切り替え・作成・名前変更・削除 ---------- */

function switchDict(id) {
  if (id === state.currentId) return;
  state.currentId = id;
  ui.activeTag = null;
  ui.animateNext = true;
  saveState();
  render();
}

els.newDict.addEventListener('click', () => {
  const name = prompt('新しい辞書の名前', '新しい辞書');
  if (!name || !name.trim()) return;
  const d = newDict(name.trim());
  state.dicts.push(d);
  saveState();
  switchDict(d.id);
  toast(`「${d.name}」を作りました`);
});

els.renameDict.addEventListener('click', () => {
  const dict = currentDict();
  const name = prompt('辞書の名前', dict.name);
  if (!name || !name.trim()) return;
  dict.name = name.trim();
  saveState();
  render();
});

els.deleteDict.addEventListener('click', () => {
  const dict = currentDict();
  if (state.dicts.length === 1) {
    toast('辞書が1つだけのときは削除できません');
    return;
  }
  if (!confirm(`「${dict.name}」（${dict.entries.length}語）を削除する？\n元に戻せません。`)) return;
  state.dicts = state.dicts.filter(d => d.id !== dict.id);
  saveState();
  switchDict(state.dicts[0].id);
  toast('辞書を削除しました');
});

/* ---------- 検索・並び替え ---------- */

els.search.addEventListener('input', () => {
  ui.query = els.search.value;
  render();
});

els.sort.addEventListener('change', () => {
  try { localStorage.setItem(STORAGE_KEY + ':sort', els.sort.value); } catch (e) { /* 無視 */ }
  render();
});

els.addBtn.addEventListener('click', () => openDialog());
els.emptyAdd.addEventListener('click', () => openDialog());

// キーボードショートカット: "/" で検索、"n" で追加
document.addEventListener('keydown', ev => {
  if (els.dialog.open) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (ev.key === '/' && !typing) { ev.preventDefault(); els.search.focus(); }
  else if (ev.key === 'n' && !typing && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); openDialog(); }
  else if (ev.key === 'Escape' && document.activeElement === els.search) {
    els.search.value = ''; ui.query = ''; render();
  }
});

/* ---------- 書き出し ---------- */

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

els.exportJson.addEventListener('click', () => {
  download(`jisyo-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json');
  toast('すべての辞書を書き出しました');
});

const CSV_HEADER = ['見出し語', '読み', '意味', '例文・メモ', 'タグ'];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

els.exportCsv.addEventListener('click', () => {
  const dict = currentDict();
  const rows = [CSV_HEADER, ...dict.entries.map(e =>
    [e.word, e.reading, e.meaning, e.example, (e.tags || []).join(' ')])];
  // 先頭の BOM で Excel でも文字化けしない
  const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  download(`${safeName(dict.name)}-${today()}.csv`, csv, 'text/csv');
  toast(`「${dict.name}」をCSVで書き出しました`);
});

/* ---------- PDF（印刷用ページを組んでブラウザの「PDFに保存」を使う） ---------- */
// 日本語フォントをそのまま使えるよう、PDFライブラリではなく印刷機能で書き出す

function formatDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function buildPrintView(dict, list) {
  const filters = [];
  if (ui.activeTag) filters.push('#' + ui.activeTag);
  if (ui.query.trim()) filters.push(`「${ui.query.trim()}」で検索`);
  const sortLabel = els.sort.selectedOptions[0].textContent;
  const showGroups = els.sort.value === 'kana';

  const cover = el('header', { class: 'pv-head' },
    el('p', { class: 'pv-mark' }, 'JISYO', el('span', {}, '.')),
    el('h1', { class: 'pv-title' }, dict.name),
    el('p', { class: 'pv-meta' },
      `${list.length}語`, el('span', {}, '／'), sortLabel,
      filters.length ? el('span', {}, '／') : null,
      filters.length ? filters.join('・') : null,
      el('span', {}, '／'), formatDate(),
    ),
  );

  const body = el('div', { class: 'pv-body' });
  let lastGroup = null;
  for (const e of list) {
    if (showGroups) {
      const g = groupLabel(e);
      if (g !== lastGroup) {
        const { char, sub, latin } = splitGroup(g);
        body.append(el('h2', { class: 'pv-group' },
          el('span', { class: 'pv-group-char' + (latin ? ' latin' : '') }, char),
          el('span', { class: 'pv-group-sub' }, sub),
        ));
        lastGroup = g;
      }
    }
    body.append(el('article', { class: 'pv-entry' },
      el('p', { class: 'pv-word' },
        e.word,
        e.reading ? el('span', { class: 'pv-reading' }, e.reading) : null,
      ),
      el('p', { class: 'pv-meaning' }, e.meaning),
      e.example ? el('p', { class: 'pv-example' }, e.example) : null,
      (e.tags && e.tags.length)
        ? el('p', { class: 'pv-tags' }, e.tags.map(t => '#' + t).join('　'))
        : null,
    ));
  }

  els.printView.replaceChildren(cover, body);
}

els.exportPdf.addEventListener('click', async () => {
  const dict = currentDict();
  const list = filteredEntries(dict);
  if (list.length === 0) {
    toast('書き出すことばがありません');
    return;
  }
  buildPrintView(dict, list);

  // 保存するファイル名の候補はページのタイトルになる
  const prevTitle = document.title;
  document.title = `${safeName(dict.name)}-${today()}`;
  const restore = () => {
    document.title = prevTitle;
    els.printView.replaceChildren();
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);

  try { await document.fonts.ready; } catch (e) { /* 無視 */ }
  window.print();
});

/* ---------- 読み込み ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const word = String(raw.word ?? '').trim();
  const meaning = String(raw.meaning ?? '').trim();
  if (!word || !meaning) return null;
  const now = Date.now();
  return {
    id: uid(),
    word,
    reading: String(raw.reading ?? '').trim(),
    meaning,
    example: String(raw.example ?? '').trim(),
    tags: Array.isArray(raw.tags) ? parseTags(raw.tags.join(',')) : parseTags(String(raw.tags ?? '')),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

// 現在の辞書にことばを追加する（見出し語と意味が同じものはスキップ）
function mergeInto(dict, rawEntries) {
  const seen = new Set(dict.entries.map(e => normalize(e.word) + '\n' + normalize(e.meaning)));
  let added = 0;
  for (const raw of rawEntries) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const key = normalize(e.word) + '\n' + normalize(e.meaning);
    if (seen.has(key)) continue;
    seen.add(key);
    dict.entries.push(e);
    added++;
  }
  return added;
}

function importJson(data) {
  // バックアップ形式: { dicts: [...] } → 辞書ごと追加
  if (data && Array.isArray(data.dicts)) {
    let dicts = 0, words = 0;
    for (const src of data.dicts) {
      if (!src || !Array.isArray(src.entries)) continue;
      const baseName = String(src.name || '読み込んだ辞書');
      let target = state.dicts.find(d => d.name === baseName);
      if (!target) {
        target = newDict(baseName);
        state.dicts.push(target);
        dicts++;
      }
      words += mergeInto(target, src.entries);
    }
    return `辞書${dicts}個を追加、${words}語を読み込みました`;
  }
  // 1つの辞書 { name, entries } またはことばの配列 → 今の辞書に追加
  const entries = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
  if (!entries) throw new Error('形式が違います');
  const n = mergeInto(currentDict(), entries);
  return `${n}語を読み込みました`;
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('空のファイルです');
  const first = rows[0].map(c => c.trim().toLowerCase());
  const hasHeader = first[0] === '見出し語' || first[0] === 'word';
  const body = hasHeader ? rows.slice(1) : rows;
  const entries = body.map(r => ({
    word: r[0], reading: r[1], meaning: r[2], example: r[3], tags: r[4],
  }));
  const n = mergeInto(currentDict(), entries);
  return `${n}語を読み込みました`;
}

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  els.importFile.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const isJson = /\.json$/i.test(file.name) || /^\s*[\[{]/.test(text);
    const msg = isJson ? importJson(JSON.parse(text)) : importCsv(text);
    saveState();
    render();
    toast(msg);
  } catch (e) {
    console.error(e);
    toast('読み込めませんでした：' + e.message);
  }
});

/* ---------- トースト ---------- */

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

render();
