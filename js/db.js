/*
 * db.js — 로컬 오프라인 저장소 (IndexedDB)
 *
 * 모든 읽기/쓰기는 Promise 기반 함수로 노출됩니다.
 * 추후 Firebase Realtime Database와 동기화하려면 이 파일의 add()/remove() 안에서
 * 로컬 저장 성공 후 원격 쓰기를 추가로 호출하면 됩니다 (call site는 변경 불필요).
 * 참고: README.md의 "Firebase 연동" 섹션.
 */
const DB = (() => {
  const DB_NAME = 'glucocare-pro';
  const DB_VERSION = 1;
  const STORES = ['glucose', 'bp', 'weight', 'meal', 'exercise', 'medication', 'meta'];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        STORES.forEach((name) => {
          if (db.objectStoreNames.contains(name)) return;
          if (name === 'meta') {
            db.createObjectStore('meta', { keyPath: 'key' });
          } else {
            const store = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
            store.createIndex('by_timestamp', 'timestamp', { unique: false });
          }
        });
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async function add(storeName, record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      const req = store.add(record);
      req.onsuccess = () => resolve({ ...record, id: req.result });
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const store = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function remove(storeName, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      t.objectStore(storeName).delete(id);
      t.oncomplete = () => resolve(true);
      t.onerror = (e) => reject(e.target.error);
    });
  }

  async function getSince(storeName, sinceIso) {
    const all = await getAll(storeName);
    return all.filter((r) => r.timestamp >= sinceIso).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async function setMeta(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('meta', 'readwrite');
      t.objectStore('meta').put({ key, value });
      t.oncomplete = () => resolve(value);
      t.onerror = (e) => reject(e.target.error);
    });
  }

  async function getMeta(key, fallback = null) {
    const store = await tx('meta', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function seedIfEmpty() {
    const existing = await getAll('glucose');
    if (existing.length > 0) return false;

    const now = new Date();
    const iso = (d) => d.toISOString();
    const daysAgo = (n, h = 8, m = 0) => {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      d.setHours(h, m, 0, 0);
      return d;
    };

    const glucoseSeed = [];
    for (let day = 6; day >= 0; day--) {
      glucoseSeed.push({ timestamp: iso(daysAgo(day, 7, 30)), value: 92 + Math.round(Math.random() * 14), context: '공복', memo: '' });
      glucoseSeed.push({ timestamp: iso(daysAgo(day, 8, 45)), value: 138 + Math.round(Math.random() * 30), context: '식후1시간', memo: '' });
      glucoseSeed.push({ timestamp: iso(daysAgo(day, 12, 30)), value: 108 + Math.round(Math.random() * 12), context: '식전', memo: '' });
      glucoseSeed.push({ timestamp: iso(daysAgo(day, 14, 0)), value: 132 + Math.round(Math.random() * 34), context: '식후2시간', memo: '' });
      glucoseSeed.push({ timestamp: iso(daysAgo(day, 21, 30)), value: 104 + Math.round(Math.random() * 16), context: '취침전', memo: '' });
    }
    for (const g of glucoseSeed) await add('glucose', g);

    for (let day = 6; day >= 0; day--) {
      await add('bp', { timestamp: iso(daysAgo(day, 7, 0)), systolic: 122 + Math.round(Math.random() * 12), diastolic: 78 + Math.round(Math.random() * 8), pulse: 68 + Math.round(Math.random() * 10), memo: '' });
    }
    for (let day = 6; day >= 0; day -= 2) {
      await add('weight', { timestamp: iso(daysAgo(day, 7, 5)), value: Math.round((68 + Math.random() * 1.4) * 10) / 10, memo: '' });
    }

    const mealSeed = [
      { mealType: '아침', name: '현미밥, 된장국, 계란말이', carbs: 55, protein: 18, fat: 10, sodium: 620, gi: 55 },
      { mealType: '점심', name: '비빔밥', carbs: 78, protein: 20, fat: 14, sodium: 890, gi: 68 },
      { mealType: '저녁', name: '닭가슴살 샐러드', carbs: 22, protein: 34, fat: 9, sodium: 410, gi: 32 },
    ];
    for (let day = 2; day >= 0; day--) {
      for (const m of mealSeed) {
        await add('meal', { ...m, timestamp: iso(daysAgo(day, m.mealType === '아침' ? 8 : m.mealType === '점심' ? 12 : 19, 0)), photoNote: '' });
      }
    }

    await add('exercise', { timestamp: iso(daysAgo(1, 18, 30)), type: '걷기', minutes: 30, intensity: '보통' });
    await add('medication', { timestamp: iso(daysAgo(0, 8, 0)), name: '메트포르민', dose: '500mg', memo: '아침 식후' });

    return true;
  }

  return { open, add, getAll, remove, getSince, setMeta, getMeta, seedIfEmpty, STORES };
})();
