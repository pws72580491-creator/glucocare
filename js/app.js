/*
 * app.js — 화면 라우팅과 전체 조립
 */
(function () {
  const TYPE_META = {
    glucose: { icon: '🩸', label: '혈당', store: 'glucose' },
    bp: { icon: '❤️', label: '혈압', store: 'bp' },
    weight: { icon: '⚖️', label: '체중', store: 'weight' },
    meal: { icon: '🍚', label: '식단', store: 'meal' },
    exercise: { icon: '🏃', label: '운동', store: 'exercise' },
    medication: { icon: '💊', label: '약물', store: 'medication' },
  };

  const state = {
    view: 'dashboard',
    recordFilter: 'all',
    chartRange: 30,
    pendingMealAnalysis: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function nowTimeStr(d = new Date()) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtTime(iso) { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtDateTime(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`; }
  function isToday(iso) { return todayStr(new Date(iso)) === todayStr(); }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------------------------------------------------------------- routing
  function goto(view) {
    state.view = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    render();
  }

  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tabbar button');
    if (tabBtn) goto(tabBtn.dataset.view);
    const linkBtn = e.target.closest('[data-goto]');
    if (linkBtn) goto(linkBtn.dataset.goto);
  });

  // ------------------------------------------------------------ data utils
  async function fetchAllTyped() {
    const entries = await Promise.all(
      Object.keys(TYPE_META).map(async (type) => {
        const rows = await DB.getAll(TYPE_META[type].store);
        return rows.map((r) => ({ ...r, _type: type }));
      })
    );
    const all = entries.flat();
    attachMealDeltas(all);
    return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  // 식사 기록에 "식후 혈당 변화(Δ)"를 붙여준다 — 식사와 혈당 기록을 함께 보기 위함
  function attachMealDeltas(all) {
    const meals = all.filter((r) => r._type === 'meal');
    const glucose = all.filter((r) => r._type === 'glucose');
    if (!meals.length || !glucose.length) return;
    Insights.matchMealsToGlucose(meals, glucose).forEach((m) => {
      const target = meals.find((x) => x.id === m.meal.id);
      if (target) target._delta = m.delta;
    });
  }

  async function fetchSinceTyped(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const entries = await Promise.all(
      Object.keys(TYPE_META).map(async (type) => {
        const rows = await DB.getSince(TYPE_META[type].store, since);
        return rows.map((r) => ({ ...r, _type: type }));
      })
    );
    return entries.flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  function describeRecord(r) {
    const t = r._type;
    if (t === 'glucose') {
      const out = Insights.isOutOfRange(r.value);
      return { title: r.context || '혈당', meta: fmtDateTime(r.timestamp), value: `${r.value} mg/dL`, alert: out };
    }
    if (t === 'bp') {
      const out = r.systolic >= 140 || r.diastolic >= 90;
      return { title: '혈압', meta: fmtDateTime(r.timestamp) + (r.pulse ? ` · 맥박 ${r.pulse}` : ''), value: `${r.systolic}/${r.diastolic}`, alert: out };
    }
    if (t === 'weight') {
      return { title: '체중', meta: fmtDateTime(r.timestamp), value: `${r.value} kg`, alert: false };
    }
    if (t === 'meal') {
      const hasDelta = r._delta !== null && r._delta !== undefined;
      const deltaText = hasDelta ? ` · 식후 변화 ${r._delta > 0 ? '+' : ''}${r._delta}` : '';
      return {
        title: `${r.mealType} · ${r.name}`,
        meta: `${fmtDateTime(r.timestamp)} · 탄수 ${r.carbs}g · 나트륨 ${r.sodium}mg${deltaText}`,
        value: `GI ${r.gi ?? '-'}`,
        alert: hasDelta && r._delta > 60,
      };
    }
    if (t === 'exercise') {
      return { title: r.type, meta: fmtDateTime(r.timestamp) + (r.intensity ? ` · ${r.intensity}` : ''), value: `${r.minutes}분`, alert: false };
    }
    if (t === 'medication') {
      return { title: r.name, meta: fmtDateTime(r.timestamp) + (r.memo ? ` · ${r.memo}` : ''), value: r.dose || '', alert: false };
    }
    return { title: '기록', meta: '', value: '', alert: false };
  }

  function recordRowHtml(r) {
    const meta = TYPE_META[r._type];
    const d = describeRecord(r);
    return `
      <div class="record-row" data-id="${r.id}" data-type="${r._type}">
        <div class="icon">${meta.icon}</div>
        <div class="body">
          <div class="title">${d.title}</div>
          <div class="meta">${d.meta}</div>
        </div>
        <div class="value${d.alert ? ' alert' : ''}">${d.value}</div>
        <button class="del" aria-label="삭제" data-del="${r.id}" data-del-type="${r._type}">✕</button>
      </div>`;
  }

  document.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const store = TYPE_META[del.dataset.delType].store;
      await DB.remove(store, Number(del.dataset.del));
      toast('삭제되었습니다');
      render();
    }
  });

  // ------------------------------------------------------------- dashboard
  async function renderDashboard() {
    const all = await fetchAllTyped();
    const todays = all.filter((r) => isToday(r.timestamp));

    const glucoseToday = todays.filter((r) => r._type === 'glucose');
    const avg = glucoseToday.length ? Math.round(glucoseToday.reduce((a, r) => a + r.value, 0) / glucoseToday.length) : null;
    $('#heroGlucose').textContent = avg ?? '–';

    const statusEl = $('#heroStatus');
    if (avg === null) {
      statusEl.textContent = '오늘 기록 없음';
      statusEl.className = 'status-chip';
    } else {
      const out = Insights.isOutOfRange(avg);
      statusEl.textContent = out ? '목표 범위 이탈' : '목표 범위 유지 중';
      statusEl.className = 'status-chip ' + (out ? 'out-range' : 'in-range');
    }

    const bpToday = todays.filter((r) => r._type === 'bp').sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    $('#heroBp').textContent = bpToday ? `${bpToday.systolic}/${bpToday.diastolic}` : '–';

    const wToday = [...all].filter((r) => r._type === 'weight').sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    $('#heroWeight').textContent = wToday ? `${wToday.value}kg` : '–';

    const mealsToday = todays.filter((r) => r._type === 'meal');
    $('#heroMeals').textContent = mealsToday.length ? `${mealsToday.length}회` : '0회';

    renderTimeline(todays);

    $('#dashboardRecordList').innerHTML = todays.length
      ? todays.slice(0, 8).map(recordRowHtml).join('')
      : `<div class="empty-state"><div class="glyph">📝</div><p>오늘 기록이 아직 없어요.<br>오른쪽 위 + 버튼으로 첫 기록을 남겨보세요.</p></div>`;
  }

  function renderTimeline(todays) {
    const track = $('#timelineTrack');
    track.innerHTML = '<div class="timeline-axis"></div>';
    const pct = (iso) => {
      const d = new Date(iso);
      return ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
    };
    todays.filter((r) => r._type === 'glucose').forEach((r) => {
      const el = document.createElement('div');
      const out = Insights.isOutOfRange(r.value);
      el.className = 'timeline-point' + (out ? ' high' : '');
      el.style.left = pct(r.timestamp) + '%';
      el.innerHTML = `<span class="tip">${r.value}</span>`;
      track.appendChild(el);
    });
    todays.filter((r) => r._type === 'meal').forEach((r) => {
      const el = document.createElement('div');
      el.className = 'timeline-meal';
      el.style.left = pct(r.timestamp) + '%';
      el.textContent = '🍽️';
      track.appendChild(el);
    });
  }

  // --------------------------------------------------------------- records
  async function renderRecords() {
    const all = await fetchAllTyped();
    const filtered = state.recordFilter === 'all' ? all : all.filter((r) => r._type === state.recordFilter);
    $('#recordFullList').innerHTML = filtered.length
      ? filtered.slice(0, 200).map(recordRowHtml).join('')
      : `<div class="empty-state"><div class="glyph">📭</div><p>표시할 기록이 없습니다.</p></div>`;
  }

  $('#recordTypeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-tab');
    if (!btn) return;
    $$('#recordTypeTabs .seg-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.recordFilter = btn.dataset.type;
    renderRecords();
  });

  // ---------------------------------------------------------------- charts
  async function renderCharts() {
    const rows = await fetchSinceTyped(state.chartRange);
    const glucose = rows.filter((r) => r._type === 'glucose');
    const bp = rows.filter((r) => r._type === 'bp');
    const weight = rows.filter((r) => r._type === 'weight');

    const a1c = Insights.estimateA1c(glucose.length ? glucose.reduce((a, r) => a + r.value, 0) / glucose.length : null);
    $('#a1cValue').textContent = a1c ? `${a1c}%` : '–';

    Charts.lineChart($('#chartGlucose'),
      [{ label: '혈당', color: '#1F5C52', points: glucose.map((r) => ({ t: new Date(r.timestamp).getTime(), v: r.value })) }],
      { targetMin: Insights.GLUCOSE_TARGET.min, targetMax: Insights.GLUCOSE_TARGET.max, yMin: 50, yMax: 260 }
    );

    Charts.lineChart($('#chartBp'), [
      { label: '수축기', color: '#1F5C52', points: bp.map((r) => ({ t: new Date(r.timestamp).getTime(), v: r.systolic })) },
      { label: '이완기', color: '#C97A22', points: bp.map((r) => ({ t: new Date(r.timestamp).getTime(), v: r.diastolic })) },
    ], { yMin: 50, yMax: 170 });

    Charts.lineChart($('#chartWeight'),
      [{ label: '체중', color: '#3F7A56', points: weight.map((r) => ({ t: new Date(r.timestamp).getTime(), v: r.value })) }]
    );
  }

  $('#chartRangeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-tab');
    if (!btn) return;
    $$('#chartRangeTabs .seg-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chartRange = Number(btn.dataset.range);
    renderCharts();
  });

  // ---------------------------------------------------------------- report
  async function renderReport() {
    const rows = await fetchSinceTyped(30);
    const glucose = rows.filter((r) => r._type === 'glucose').map((r) => r.value);
    const bp = rows.filter((r) => r._type === 'bp');
    const weight = rows.filter((r) => r._type === 'weight');
    const s = Insights.stats(glucose);
    const tir = Insights.timeInRange(glucose);
    const a1c = Insights.estimateA1c(s.avg);
    const avgSys = bp.length ? Math.round(bp.reduce((a, r) => a + r.systolic, 0) / bp.length) : null;
    const avgDia = bp.length ? Math.round(bp.reduce((a, r) => a + r.diastolic, 0) / bp.length) : null;
    const lastWeight = weight.length ? weight[weight.length - 1].value : null;

    const table = [
      ['기간', '최근 30일'],
      ['평균 혈당', s.avg ? `${s.avg} mg/dL` : '–'],
      ['최저 / 최고 혈당', s.avg ? `${s.min} / ${s.max} mg/dL` : '–'],
      ['목표 범위 유지율', tir !== null ? `${tir}%` : '–'],
      ['예상 당화혈색소', a1c ? `${a1c}%` : '–'],
      ['평균 혈압', avgSys ? `${avgSys}/${avgDia} mmHg` : '–'],
      ['최근 체중', lastWeight ? `${lastWeight} kg` : '–'],
    ];
    $('#reportTable').innerHTML = table.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

    const buckets = [
      { label: '저혈당', test: (v) => v < 70, color: '#B24632' },
      { label: '정상', test: (v) => v >= 70 && v <= 140, color: '#3F7A56' },
      { label: '주의', test: (v) => v > 140 && v <= 180, color: '#C97A22' },
      { label: '고혈당', test: (v) => v > 180, color: '#B24632' },
    ];
    const counts = buckets.map((b) => glucose.filter(b.test).length);
    Charts.barChart($('#chartReport'), buckets.map((b) => b.label), counts, buckets.map((b) => b.color));
  }

  $('#btnPrintReport').addEventListener('click', () => window.print());

  $('#btnExportCsv').addEventListener('click', async () => {
    const rows = await fetchSinceTyped(30);
    const header = ['구분', '일시', '항목1', '항목2', '항목3', '메모'];
    const lines = rows.map((r) => {
      if (r._type === 'glucose') return ['혈당', r.timestamp, r.value, r.context, '', r.memo || ''];
      if (r._type === 'bp') return ['혈압', r.timestamp, r.systolic, r.diastolic, r.pulse || '', r.memo || ''];
      if (r._type === 'weight') return ['체중', r.timestamp, r.value, '', '', r.memo || ''];
      if (r._type === 'meal') return ['식단', r.timestamp, r.name, r.carbs, r.sodium, r.mealType];
      if (r._type === 'exercise') return ['운동', r.timestamp, r.type, r.minutes, r.intensity || '', ''];
      if (r._type === 'medication') return ['약물', r.timestamp, r.name, r.dose || '', '', r.memo || ''];
      return [];
    });
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glucocare_report_${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ----------------------------------------------------------------- share
  async function renderShare() {
    let code = await DB.getMeta('shareCode');
    if (!code) {
      code = Array.from({ length: 6 }, () => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 34)]).join('');
      await DB.setMeta('shareCode', code);
    }
    $('#shareCode').textContent = code.split('').join(' ');
  }

  $('#btnCopyCode').addEventListener('click', async () => {
    const code = (await DB.getMeta('shareCode')) || '';
    try {
      await navigator.clipboard.writeText(code);
      toast('공유 코드를 복사했어요');
    } catch {
      toast(code);
    }
  });

  // ------------------------------------------------------------- add sheet
  const sheetOverlay = $('#sheetOverlay');
  const sheetContent = $('#sheetContent');

  function openSheet(html) {
    sheetContent.innerHTML = html;
    sheetOverlay.classList.add('active');
  }
  function closeSheet() {
    sheetOverlay.classList.remove('active');
    state.pendingMealAnalysis = null;
  }
  sheetOverlay.addEventListener('click', (e) => { if (e.target === sheetOverlay) closeSheet(); });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close-sheet]')) closeSheet(); });

  $('#btnQuickAdd').addEventListener('click', () => openSheet(addMenuHtml()));

  function addMenuHtml() {
    const items = [
      ['glucose', '🩸', '혈당'], ['bp', '❤️', '혈압'], ['weight', '⚖️', '체중'],
      ['meal', '🍚', '식단'], ['exercise', '🏃', '운동'], ['medication', '💊', '약물'],
    ];
    return `
      <div class="sheet-handle"></div>
      <div class="sheet-head"><h2>기록 추가</h2><button data-close-sheet aria-label="닫기">✕</button></div>
      <div class="add-menu">
        ${items.map(([type, icon, label]) => `<button data-add-type="${type}"><span class="glyph">${icon}</span>${label}</button>`).join('')}
      </div>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-type]');
    if (btn) openSheet(formHtml(btn.dataset.addType));
  });

  function chipGroup(name, options, selected) {
    return `<div class="chip-select" data-chip-group="${name}">
      ${options.map((o) => `<button type="button" class="chip${o === selected ? ' active' : ''}" data-chip-value="${o}">${o}</button>`).join('')}
      <input type="hidden" name="${name}" value="${selected || options[0]}">
    </div>`;
  }

  function formHtml(type) {
    const now = new Date();
    const dateTimeFields = `
      <div class="field row2">
        <div><label>날짜</label><input type="date" name="date" value="${todayStr(now)}" required></div>
        <div><label>시간</label><input type="time" name="time" value="${nowTimeStr(now)}" required></div>
      </div>`;

    if (type === 'glucose') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>🩸 혈당 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="glucose">
          <div class="field"><label>혈당 (mg/dL)</label><input type="number" name="value" min="20" max="600" placeholder="예: 105" required></div>
          <div class="field"><label>측정 시점</label>${chipGroup('context', ['공복', '식전', '식후1시간', '식후2시간', '취침전', '기타'], '식전')}</div>
          ${dateTimeFields}
          <div class="field"><label>메모 (선택)</label><textarea name="memo" placeholder="컨디션, 특이사항 등"></textarea></div>
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    if (type === 'bp') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>❤️ 혈압 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="bp">
          <div class="field row2">
            <div><label>수축기 (mmHg)</label><input type="number" name="systolic" min="60" max="260" placeholder="120" required></div>
            <div><label>이완기 (mmHg)</label><input type="number" name="diastolic" min="30" max="180" placeholder="80" required></div>
          </div>
          <div class="field"><label>맥박 (선택)</label><input type="number" name="pulse" min="30" max="220" placeholder="72"></div>
          ${dateTimeFields}
          <div class="field"><label>메모 (선택)</label><textarea name="memo"></textarea></div>
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    if (type === 'weight') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>⚖️ 체중 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="weight">
          <div class="field"><label>체중 (kg)</label><input type="number" step="0.1" name="value" min="20" max="300" placeholder="예: 68.5" required></div>
          ${dateTimeFields}
          <div class="field"><label>메모 (선택)</label><textarea name="memo"></textarea></div>
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    if (type === 'exercise') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>🏃 운동 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="exercise">
          <div class="field"><label>운동 종류</label><input type="text" name="type" placeholder="걷기, 자전거 등" required></div>
          <div class="field"><label>운동 시간 (분)</label><input type="number" name="minutes" min="1" max="600" placeholder="30" required></div>
          <div class="field"><label>강도</label>${chipGroup('intensity', ['가벼움', '보통', '강함'], '보통')}</div>
          ${dateTimeFields}
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    if (type === 'medication') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>💊 약물 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="medication">
          <div class="field"><label>약품명</label><input type="text" name="name" placeholder="예: 메트포르민" required></div>
          <div class="field"><label>용량 (선택)</label><input type="text" name="dose" placeholder="예: 500mg"></div>
          ${dateTimeFields}
          <div class="field"><label>메모 (선택)</label><textarea name="memo" placeholder="식전/식후 등"></textarea></div>
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    if (type === 'meal') {
      return `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>🍚 식단 기록</h2><button data-close-sheet aria-label="닫기">✕</button></div>
        <form id="recordForm" data-type="meal">
          <div class="field"><label>식사 구분</label>${chipGroup('mealType', ['아침', '점심', '저녁', '간식'], mealTypeGuess())}</div>
          <div class="field">
            <label>사진으로 기록 (선택)</label>
            <div class="photo-drop" id="photoDrop">
              <div class="glyph">📷</div>
              <p>음식 사진을 올리면 미리보기가 표시됩니다.<br>사진 → 음식명 자동 인식은 Vision API 연동 후 지원됩니다.<br>지금은 아래에서 음식 이름으로 영양을 자동 매칭해보세요.</p>
            </div>
            <input type="file" accept="image/*" id="photoInput" style="display:none">
          </div>
          <div class="field">
            <label>음식 이름</label>
            <input type="text" name="name" id="mealNameInput" list="foodList" placeholder="예: 비빔밥" required autocomplete="off">
            <datalist id="foodList">${FoodDB.TABLE.map((f) => `<option value="${f.name}">`).join('')}</datalist>
          </div>
          <div id="aiAnalysisSlot"></div>
          <div class="field row2" style="margin-top:var(--space-3)">
            <div><label>탄수화물 (g)</label><input type="number" name="carbs" id="mealCarbs" value="0"></div>
            <div><label>단백질 (g)</label><input type="number" name="protein" id="mealProtein" value="0"></div>
          </div>
          <div class="field row2">
            <div><label>지방 (g)</label><input type="number" name="fat" id="mealFat" value="0"></div>
            <div><label>나트륨 (mg)</label><input type="number" name="sodium" id="mealSodium" value="0"></div>
          </div>
          <div class="field"><label>혈당지수 (GI, 선택)</label><input type="number" name="gi" id="mealGi" value="0"></div>
          ${dateTimeFields}
          <button class="btn primary" type="submit">저장</button>
        </form>`;
    }
    return '';
  }

  function mealTypeGuess() {
    const h = new Date().getHours();
    if (h < 10) return '아침';
    if (h < 15) return '점심';
    if (h < 21) return '저녁';
    return '간식';
  }

  // chip toggling (event delegation, works for any chip-select group inside the sheet)
  sheetContent.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const group = chip.closest('[data-chip-group]');
    $$('.chip', group).forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    $('input[type=hidden]', group).value = chip.dataset.chipValue;
    if (group.dataset.chipGroup === 'mealType') renderMealAnalysis();
  });

  // meal photo preview (decorative — no real vision processing without an API key)
  sheetContent.addEventListener('click', (e) => {
    if (e.target.closest('#photoDrop')) $('#photoInput').click();
  });
  sheetContent.addEventListener('change', (e) => {
    if (e.target.id === 'photoInput' && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = () => {
        $('#photoDrop').outerHTML = `<img class="photo-preview" src="${reader.result}" alt="식사 사진 미리보기"><div class="photo-drop" id="photoDrop" style="padding:12px"><p>사진이 첨부되었습니다. 아래 음식 이름으로 영양 정보를 매칭하세요.</p></div>`;
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  });

  function currentMealValues() {
    return {
      carbs: Number($('#mealCarbs')?.value || 0),
      protein: Number($('#mealProtein')?.value || 0),
      fat: Number($('#mealFat')?.value || 0),
      sodium: Number($('#mealSodium')?.value || 0),
      gi: Number($('#mealGi')?.value || 0),
    };
  }

  function renderMealAnalysis(match) {
    const slot = $('#aiAnalysisSlot');
    if (!slot) return;
    const values = match || currentMealValues();
    const score = FoodDB.estimateMealScore(values);
    slot.innerHTML = `
      ${match ? `
      <div class="ai-analysis">
        <div class="head">✨ 영양 자동 분석</div>
        <div class="nutrient-grid">
          <div class="n"><div class="val">${match.carbs}g</div><div class="lab">탄수화물</div></div>
          <div class="n"><div class="val">${match.protein}g</div><div class="lab">단백질</div></div>
          <div class="n"><div class="val">${match.fat}g</div><div class="lab">지방</div></div>
        </div>
        <div class="note">참고용 추정치예요 (신뢰도 ${Math.round(match.confidence * 100)}%). 실제 섭취량에 맞게 아래 값을 조정하세요.</div>
      </div>` : ''}
      <div class="meal-score">
        <div class="ring ${score.tier}">${score.score}</div>
        <div class="text"><b>식사 점수 ${score.score}점</b><br>${score.comment}</div>
      </div>`;
  }

  let mealNameDebounce;
  sheetContent.addEventListener('input', (e) => {
    if (e.target.id === 'mealNameInput') {
      clearTimeout(mealNameDebounce);
      mealNameDebounce = setTimeout(() => {
        const match = FoodDB.matchByName(e.target.value);
        if (match) {
          $('#mealCarbs').value = match.carbs;
          $('#mealProtein').value = match.protein;
          $('#mealFat').value = match.fat;
          $('#mealSodium').value = match.sodium;
          $('#mealGi').value = match.gi;
          renderMealAnalysis(match);
        }
      }, 350);
    }
    if (['mealCarbs', 'mealProtein', 'mealFat', 'mealSodium', 'mealGi'].includes(e.target.id)) {
      renderMealAnalysis();
    }
  });

  // ------------------------------------------------------------ form submit
  sheetContent.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target.closest('#recordForm');
    if (!form) return;
    const type = form.dataset.type;
    const fd = new FormData(form);
    const date = fd.get('date'), time = fd.get('time');
    const timestamp = new Date(`${date}T${time}`).toISOString();

    let record = { timestamp };
    if (type === 'glucose') record = { ...record, value: Number(fd.get('value')), context: fd.get('context'), memo: fd.get('memo') || '' };
    if (type === 'bp') record = { ...record, systolic: Number(fd.get('systolic')), diastolic: Number(fd.get('diastolic')), pulse: fd.get('pulse') ? Number(fd.get('pulse')) : null, memo: fd.get('memo') || '' };
    if (type === 'weight') record = { ...record, value: Number(fd.get('value')), memo: fd.get('memo') || '' };
    if (type === 'exercise') record = { ...record, type: fd.get('type'), minutes: Number(fd.get('minutes')), intensity: fd.get('intensity') };
    if (type === 'medication') record = { ...record, name: fd.get('name'), dose: fd.get('dose') || '', memo: fd.get('memo') || '' };
    if (type === 'meal') record = {
      ...record, mealType: fd.get('mealType'), name: fd.get('name'),
      carbs: Number(fd.get('carbs') || 0), protein: Number(fd.get('protein') || 0),
      fat: Number(fd.get('fat') || 0), sodium: Number(fd.get('sodium') || 0), gi: Number(fd.get('gi') || 0),
      photoNote: '',
    };

    await DB.add(TYPE_META[type].store, record);
    toast('기록을 저장했어요');
    closeSheet();
    render();
  });

  // ------------------------------------------------------------- render all
  async function render() {
    $('#topbarDate').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    if (state.view === 'dashboard') await renderDashboard();
    if (state.view === 'records') await renderRecords();
    if (state.view === 'charts') await renderCharts();
    if (state.view === 'report') await renderReport();
    if (state.view === 'share') await renderShare();
  }

  window.addEventListener('resize', () => { if (state.view === 'charts') renderCharts(); });

  // ---------------------------------------------------------------- init
  (async function init() {
    await DB.seedIfEmpty();
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js'); } catch (err) { /* offline shell optional */ }
    }
    render();
  })();
})();
