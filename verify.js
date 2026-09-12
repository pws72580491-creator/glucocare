/*
 * verify.js — 의존성 없는 회귀 검증 스크립트 (v1.5.0에서 추가)
 *
 * 그동안 CHANGELOG에는 "N개 시나리오로 확인"이라고만 적혀 있고, 그 시나리오를 다시
 * 실행해볼 방법이 코드로는 남아있지 않았다. 이 파일은 그중 순수 계산 로직만 —
 * FoodDB(음식 매칭·식사 점수)와 Insights(eA1C·통계·목표범위) — 골라서 실제로
 * 재실행 가능한 형태로 옮겨 담았다.
 *
 * app.js/db.js/charts.js는 포함하지 않는다: DOM과 IndexedDB에 의존하기 때문에
 * 여기서 의미 있게 테스트하려면 jsdom 같은 브라우저 환경 흉내가 필요한데, 이
 * 프로젝트는 빌드 과정도 의존성도 없는 걸 원칙으로 하고 있어서 그 원칙을 깨면서까지
 * 넣을 정도는 아니라고 판단했다. 대신 버그가 실제로 났던 적이 있는(matchByName)
 * 순수 로직 쪽을 우선했다.
 *
 * 실행: node verify.js
 */
const assert = require('assert');
const FoodDB = require('./js/foodDb.js');
const Insights = require('./js/insights.js');

let passed = 0;
let failed = 0;
function check(desc, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`✗ ${desc}`);
    console.error(`  ${err.message}`);
  }
}

// ---------------------------------------------------------- FoodDB.matchByName
check('1글자 검색어는 매칭 안 함 (v1.3.1 회귀 방지: "구"가 "고구마"에 잘못 매칭되던 버그)', () => {
  assert.strictEqual(FoodDB.matchByName('구'), null);
});
check('2글자 이상 부분일치는 매칭됨 (부분일치 confidence 0.72)', () => {
  const r = FoodDB.matchByName('비빔');
  assert.ok(r && r.name === '비빔밥');
  assert.strictEqual(r.confidence, 0.72);
});
check('정확히 일치하면 confidence 0.97', () => {
  const r = FoodDB.matchByName('현미밥');
  assert.ok(r && r.confidence === 0.97);
});
check('빈 문자열/공백만 있는 검색어는 null', () => {
  assert.strictEqual(FoodDB.matchByName(''), null);
  assert.strictEqual(FoodDB.matchByName('   '), null);
});
check('테이블에 없는 이름은 null', () => {
  assert.strictEqual(FoodDB.matchByName('아무도안먹는음식'), null);
});

// ----------------------------------------------------- FoodDB.estimateMealScore
check('지방 35g 이상이면 감점 (v1.4.0에서 추가된 기준, 다른 조건 동일 비교)', () => {
  const withFat = FoodDB.estimateMealScore({ gi: 30, sodium: 200, carbs: 20, fat: 40, protein: 5 });
  const withoutFat = FoodDB.estimateMealScore({ gi: 30, sodium: 200, carbs: 20, fat: 10, protein: 5 });
  assert.ok(withFat.score < withoutFat.score, `${withFat.score} < ${withoutFat.score} 이어야 함`);
});
check('지방이 감점에 기여하면 코멘트에 "지방"이 언급됨', () => {
  const r = FoodDB.estimateMealScore({ gi: 65, sodium: 900, carbs: 20, fat: 40, protein: 5 });
  assert.ok(r.score < 78, `mid/low 등급이어야 함 (score=${r.score})`);
  assert.ok(r.comment.includes('지방'), `코멘트: "${r.comment}"`);
});
check('지방이 낮으면 코멘트에 "지방"이 없음 (다른 요인만 언급)', () => {
  const r = FoodDB.estimateMealScore({ gi: 75, sodium: 200, carbs: 20, fat: 10, protein: 5 });
  assert.ok(r.score < 78, `mid/low 등급이어야 함 (score=${r.score})`);
  assert.ok(r.comment.includes('혈당지수'), `코멘트: "${r.comment}"`);
  assert.ok(!r.comment.includes('지방'), `코멘트: "${r.comment}"`);
});
check('점수는 30 밑으로 내려가지 않음 (바닥값 clamp)', () => {
  const r = FoodDB.estimateMealScore({ gi: 100, sodium: 3000, carbs: 300, fat: 200, protein: 0 });
  assert.strictEqual(r.score, 30);
});
check('단백질 20g 이상이면 가점', () => {
  const withProtein = FoodDB.estimateMealScore({ gi: 60, sodium: 200, carbs: 20, fat: 5, protein: 25 });
  const withoutProtein = FoodDB.estimateMealScore({ gi: 60, sodium: 200, carbs: 20, fat: 5, protein: 5 });
  assert.ok(withProtein.score > withoutProtein.score, `${withProtein.score} > ${withoutProtein.score} 이어야 함`);
});

// ------------------------------------------------------------ Insights.estimateA1c
check('eA1C 공식(ADAG): eAG 154 → A1C 7.0', () => {
  assert.strictEqual(Insights.estimateA1c(154), 7);
});
check('평균 혈당이 0/null이면 null', () => {
  assert.strictEqual(Insights.estimateA1c(0), null);
  assert.strictEqual(Insights.estimateA1c(null), null);
});

// ------------------------------------------------------------------ Insights.stats
check('평균/최소/최대 계산', () => {
  const s = Insights.stats([100, 110, 90, 120]);
  assert.strictEqual(s.avg, 105);
  assert.strictEqual(s.min, 90);
  assert.strictEqual(s.max, 120);
});
check('빈 배열이면 전부 null', () => {
  assert.strictEqual(Insights.stats([]).avg, null);
});

// --------------------------------------------- Insights.isOutOfRange / timeInRange
check('목표범위 경계값(70, 140)은 범위 "내"로 판정 (경계 포함)', () => {
  assert.strictEqual(Insights.isOutOfRange(70), false);
  assert.strictEqual(Insights.isOutOfRange(140), false);
  assert.strictEqual(Insights.isOutOfRange(69), true);
  assert.strictEqual(Insights.isOutOfRange(141), true);
});
check('목표범위 유지율(%) 계산', () => {
  assert.strictEqual(Insights.timeInRange([70, 140, 200, 60]), 50);
});

// --------------------------------------------------------- Insights.GLUCOSE_ZONES
// v1.5.0: 리포트 탭 분포차트가 예전엔 70/140/180을 따로 하드코딩했는데, 이제
// GLUCOSE_TARGET/GLUCOSE_HIGH에서 파생된 이 배열을 直접 참조한다. 구간 경계가
// 어긋나지 않는지 확인.
check('GLUCOSE_ZONES 4구간 경계가 GLUCOSE_TARGET/GLUCOSE_HIGH와 일치', () => {
  const z = Insights.GLUCOSE_ZONES;
  assert.strictEqual(z.length, 4);
  assert.strictEqual(z.find((x) => x.key === 'low').test(69), true);
  assert.strictEqual(z.find((x) => x.key === 'normal').test(70), true);
  assert.strictEqual(z.find((x) => x.key === 'normal').test(140), true);
  assert.strictEqual(z.find((x) => x.key === 'caution').test(141), true);
  assert.strictEqual(z.find((x) => x.key === 'caution').test(180), true);
  assert.strictEqual(z.find((x) => x.key === 'high').test(181), true);
});

// ----------------------------------------------------- Insights.matchMealsToGlucose
check('식후 150분 이내 첫 혈당 + 식전 60분 이내 가장 가까운 혈당을 매칭', () => {
  const meal = { timestamp: '2026-09-12T08:00:00.000Z' };
  const glucose = [
    { timestamp: '2026-09-12T07:30:00.000Z', value: 100 }, // 식전 30분
    { timestamp: '2026-09-12T09:00:00.000Z', value: 150 }, // 식후 60분 (150분 이내)
    { timestamp: '2026-09-12T11:00:00.000Z', value: 130 }, // 식후 180분 (창 밖)
  ];
  const [m] = Insights.matchMealsToGlucose([meal], glucose);
  assert.strictEqual(m.preReading.value, 100);
  assert.strictEqual(m.postReading.value, 150);
  assert.strictEqual(m.delta, 50);
});
check('식후 150분을 넘는 기록만 있으면 매칭 안 함', () => {
  const meal = { timestamp: '2026-09-12T08:00:00.000Z' };
  const glucose = [{ timestamp: '2026-09-12T11:00:00.000Z', value: 130 }];
  const [m] = Insights.matchMealsToGlucose([meal], glucose);
  assert.strictEqual(m.postReading, null);
  assert.strictEqual(m.delta, null);
});

console.log(`\n${passed}개 통과, ${failed}개 실패`);
if (failed > 0) {
  console.log('일부 실패 — 위 내용을 확인하세요.');
  process.exitCode = 1;
} else {
  console.log('전체 통과');
}
