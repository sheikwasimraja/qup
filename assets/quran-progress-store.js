(function () {
  const DB_NAME = 'quran-progress-tracker-db-v2';
  const STORE_NAME = 'app-state';
  const DATA_KEY = 'rows';
  const META_KEY = 'seed-version';
  const DEFAULT_PENDING_KEY = 'quran-progress-pending-changes';
  const LOCAL_SNAPSHOT_KEY = 'quran-progress-saved-snapshot-v1';
  const seedRows = Array.isArray(window.QURAN_PROGRESS_SEED) ? window.QURAN_PROGRESS_SEED : [];
  const seedVersion = window.QURAN_PROGRESS_SEED_VERSION || `seed-${seedRows.length}`;

  let dbPromise;
  let lastPersistenceMode = 'indexeddb';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function repairUtf8Mojibake(value) {
    if (typeof value !== 'string' || !/[\u00D8\u00D9]/.test(value)) {
      return value;
    }

    try {
      const bytes = Uint8Array.from(Array.from(value, (char) => char.charCodeAt(0) & 0xFF));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      return value;
    }
  }

  function hasArabicScript(value) {
    return typeof value === 'string' && /[\u0600-\u06FF]/.test(value);
  }

  function syncArabicFromSeed(rows) {
    if (!Array.isArray(rows) || !Array.isArray(seedRows) || rows.length !== seedRows.length) {
      return { rows, changed: false };
    }

    let changed = false;
    const syncedRows = rows.map((row, index) => {
      if (!row || typeof row !== 'object') {
        return row;
      }

      const nextRow = { ...row };
      const currentArabic = nextRow['Quran Arabic'];
      const seedArabic = seedRows[index] && seedRows[index]['Quran Arabic'];

      if (typeof currentArabic === 'string' && typeof seedArabic === 'string') {
        const repairedArabic = repairUtf8Mojibake(currentArabic);
        const shouldReplaceFromSeed =
          !hasArabicScript(repairedArabic) ||
          /[\u00D8\u00D9]/.test(currentArabic);

        if (shouldReplaceFromSeed && hasArabicScript(seedArabic) && currentArabic !== seedArabic) {
          nextRow['Quran Arabic'] = seedArabic;
          changed = true;
        } else if (repairedArabic !== currentArabic) {
          nextRow['Quran Arabic'] = repairedArabic;
          changed = true;
        }
      }

      return nextRow;
    });

    return { rows: syncedRows, changed };
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) {
      return [];
    }

    let changed = false;
    const normalizedRows = rows.map((row) => {
      if (!row || typeof row !== 'object') {
        return row;
      }

      const nextRow = { ...row };

      if (typeof nextRow['Quran Arabic'] === 'string') {
        const repairedArabic = repairUtf8Mojibake(nextRow['Quran Arabic']);
        if (repairedArabic !== nextRow['Quran Arabic']) {
          nextRow['Quran Arabic'] = repairedArabic;
          changed = true;
        }
      }

      return nextRow;
    });

    const syncedRows = syncArabicFromSeed(normalizedRows);
    return { rows: syncedRows.rows, changed: changed || syncedRows.changed };
  }

  function openDb() {
    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  function readLocalSnapshot() {
    try {
      const raw = window.localStorage.getItem(LOCAL_SNAPSHOT_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.rows)) {
        return null;
      }

      const normalized = normalizeRows(clone(parsed.rows));
      return {
        rows: normalized.rows,
        seedVersion: parsed.seedVersion || null,
        changed: normalized.changed
      };
    } catch (error) {
      return null;
    }
  }

  function writeLocalSnapshot(rows) {
    window.localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify({
      seedVersion,
      savedAt: new Date().toISOString(),
      rows: clone(rows)
    }));
  }

  async function readValue(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function writeValue(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(value, key);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function ensureInitialized() {
    const localSnapshot = readLocalSnapshot();
    let storedRows;
    let storedSeedVersion;
    let dbAvailable = true;

    try {
      [storedRows, storedSeedVersion] = await Promise.all([
        readValue(DATA_KEY),
        readValue(META_KEY)
      ]);
    } catch (error) {
      dbAvailable = false;
    }

    if (Array.isArray(storedRows) && storedRows.length) {
      const normalizedStored = normalizeRows(clone(storedRows));

      if (dbAvailable && normalizedStored.changed) {
        await writeValue(DATA_KEY, normalizedStored.rows);
      }

      if (dbAvailable && storedSeedVersion !== seedVersion) {
        await writeValue(META_KEY, seedVersion);
      }

      try {
        writeLocalSnapshot(normalizedStored.rows);
      } catch (error) {
        // Keep IndexedDB as the source of truth when local snapshot mirroring fails.
      }

      lastPersistenceMode = dbAvailable ? 'indexeddb' : 'local';
      return normalizedStored.rows;
    }

    if (localSnapshot && Array.isArray(localSnapshot.rows) && localSnapshot.rows.length) {
      if (dbAvailable) {
        try {
          await Promise.all([
            writeValue(DATA_KEY, localSnapshot.rows),
            writeValue(META_KEY, localSnapshot.seedVersion || seedVersion)
          ]);
          lastPersistenceMode = 'indexeddb';
        } catch (error) {
          lastPersistenceMode = 'local';
        }
      } else {
        lastPersistenceMode = 'local';
      }

      if (localSnapshot.changed) {
        try {
          writeLocalSnapshot(localSnapshot.rows);
        } catch (error) {
          // Ignore local snapshot rewrite failures.
        }
      }

      return localSnapshot.rows;
    }

    const normalizedSeed = normalizeRows(clone(seedRows));
    const initialRows = normalizedSeed.rows;

    let localSaved = false;
    try {
      writeLocalSnapshot(initialRows);
      localSaved = true;
    } catch (error) {
      localSaved = false;
    }

    if (dbAvailable) {
      try {
        await Promise.all([
          writeValue(DATA_KEY, initialRows),
          writeValue(META_KEY, seedVersion)
        ]);
        lastPersistenceMode = 'indexeddb';
        return initialRows;
      } catch (error) {
        if (localSaved) {
          lastPersistenceMode = 'local';
          return initialRows;
        }
        throw error;
      }
    }

    if (localSaved) {
      lastPersistenceMode = 'local';
      return initialRows;
    }

    throw new Error('Browser storage is not available.');
  }

  function applyPendingChanges(rows, pendingKey = DEFAULT_PENDING_KEY) {
    const raw = window.localStorage.getItem(pendingKey);
    if (!raw) {
      return rows;
    }

    let pendingChanges;
    try {
      pendingChanges = JSON.parse(raw);
    } catch (error) {
      return rows;
    }

    if (!pendingChanges || typeof pendingChanges !== 'object') {
      return rows;
    }

    const rowIdField = rows.some((row) => row && row['S.no'] !== undefined) ? 'S.no' : null;

    rows.forEach((row, index) => {
      const rowKey = rowIdField && row && row[rowIdField] !== undefined && row[rowIdField] !== null
        ? String(row[rowIdField])
        : String(index);
      const changeSet = pendingChanges[rowKey];

      if (!changeSet || typeof changeSet !== 'object') {
        return;
      }

      Object.entries(changeSet).forEach(([field, value]) => {
        row[field] = value;
      });
    });

    return rows;
  }

  async function getSavedRows() {
    return clone(await ensureInitialized());
  }

  async function getWorkingRows(options = {}) {
    const pendingKey = options.pendingKey || DEFAULT_PENDING_KEY;
    return applyPendingChanges(await getSavedRows(), pendingKey);
  }

  async function saveRows(rows) {
    if (!Array.isArray(rows) || rows.some((row) => !isPlainObject(row))) {
      throw new Error('Invalid rows payload.');
    }

    const clonedRows = normalizeRows(clone(rows)).rows;
    let localError = null;
    let dbError = null;

    try {
      writeLocalSnapshot(clonedRows);
    } catch (error) {
      localError = error;
    }

    try {
      await Promise.all([
        writeValue(DATA_KEY, clonedRows),
        writeValue(META_KEY, seedVersion)
      ]);
    } catch (error) {
      dbError = error;
    }

    if (dbError && localError) {
      throw dbError;
    }

    lastPersistenceMode = dbError ? 'local' : 'indexeddb';
    return clonedRows;
  }

  function createBackupPayload(rows, metadata = {}) {
    if (!Array.isArray(rows) || rows.some((row) => !isPlainObject(row))) {
      throw new Error('Invalid rows payload.');
    }

    return {
      app: 'quran-progress-tracker',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      seedVersion,
      rowCount: rows.length,
      ...metadata,
      rows: clone(rows)
    };
  }

  async function importBackupPayload(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.rows)
        ? payload.rows
        : null;

    if (!Array.isArray(rows) || rows.some((row) => !isPlainObject(row))) {
      throw new Error('Backup file does not contain valid rows.');
    }

    return saveRows(rows);
  }

  async function resetSavedRowsToSeed() {
    const clonedRows = normalizeRows(clone(seedRows)).rows;
    writeLocalSnapshot(clonedRows);
    try {
      await Promise.all([
        writeValue(DATA_KEY, clonedRows),
        writeValue(META_KEY, seedVersion)
      ]);
      lastPersistenceMode = 'indexeddb';
    } catch (error) {
      lastPersistenceMode = 'local';
    }
    window.localStorage.removeItem(DEFAULT_PENDING_KEY);
    return clonedRows;
  }

  function clearPendingChanges(pendingKey = DEFAULT_PENDING_KEY) {
    window.localStorage.removeItem(pendingKey);
  }

  function getColumnList(hiddenColumns) {
    const hiddenSet = new Set(hiddenColumns || []);
    return [...seedRows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => {
        if (!hiddenSet.has(key)) {
          set.add(key);
        }
      });
      return set;
    }, new Set())];
  }

  window.QuranProgressStore = {
    applyPendingChanges,
    clearPendingChanges,
    createBackupPayload,
    getColumnList,
    getLastPersistenceMode: () => lastPersistenceMode,
    getSavedRows,
    getWorkingRows,
    importBackupPayload,
    resetSavedRowsToSeed,
    saveRows,
    seedVersion
  };
})();
