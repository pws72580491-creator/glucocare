/*
 * insights.js — 계산 로직 (진단 대체 아님, 참고용)
 */
const Insights = (() => {
  const GLUCOSE_TARGET = { min: 70, max: 140 };
  const GLUCOSE_HIGH = 180; // 이 값을 넘으면 '고혈당' 구간 (리포트 분포차트 기준)

  // 리포트 탭 "기간 내 혈당 분포" 차트의 구간 정의.
  // GLUCOSE_TARGET/GLUCOSE_HIGH을 바꾸면 이 구간도 함께 따라간다 — 예전엔 app.js에
  // 70/140/180이 따로 하드코딩돼 있어서, 목표범위를 여기서만 바꾸면 리포트 차트와
  // 어긋날 수 있었다.
  const GLUCOSE_ZONES = [
    { key: 'low', label: '저혈당', test: (v) => v < GLUCOSE_TARGET.min, color: '#B24632' },
    { key: 'normal', label: '정상', test: (v) => v >= GLUCOSE_TARGET.min && v <= GLUCOSE_TARGET.max, color: '#3F7A56' },
    { key: 'caution', label: '주의', test: (v) => v > GLUCOSE_TARGET.max && v <= GLUCOSE_HIGH, color: '#C97A22' },
    { key: 'high', label: '고혈당', test: (v) => v > GLUCOSE_HIGH, color: '#B24632' },
  ];

  // ADAG 연구 기반 공식: eAG(mg/dL) = 28.7 × A1C − 46.7  →  A1C = (eAG + 46.7) / 28.7
  function estimateA1c(avgGlucoseMgdl) {
    if (!avgGlucoseMgdl || avgGlucoseMgdl <= 0) return null;
    const a1c = (avgGlucoseMgdl + 46.7) / 28.7;
    return Math.round(a1c * 10) / 10;
  }

  function stats(values) {
    if (!values.length) return { avg: null, min: null, max: null, std: null };
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
    return { avg: Math.round(avg), min, max, std: Math.round(Math.sqrt(variance)) };
  }

  function timeInRange(values, min = GLUCOSE_TARGET.min, max = GLUCOSE_TARGET.max) {
    if (!values.length) return null;
    const inRange = values.filter((v) => v >= min && v <= max).length;
    return Math.round((inRange / values.length) * 100);
  }

  // 각 식사 이후 2시간 이내의 혈당 기록을 찾아 매칭 (식사-혈당 연동 뷰용)
  function matchMealsToGlucose(meals, glucoseReadings, windowMinutes = 150) {
    return meals.map((meal) => {
      const mealTime = new Date(meal.timestamp).getTime();
      const after = glucoseReadings
        .map((g) => ({ ...g, t: new Date(g.timestamp).getTime() }))
        .filter((g) => g.t >= mealTime && g.t - mealTime <= windowMinutes * 60000)
        .sort((a, b) => a.t - b.t);
      const before = glucoseReadings
        .map((g) => ({ ...g, t: new Date(g.timestamp).getTime() }))
        .filter((g) => g.t < mealTime && mealTime - g.t <= 60 * 60000)
        .sort((a, b) => b.t - a.t);

      const postReading = after[0] || null;
      const preReading = before[0] || null;
      const delta = postReading && preReading ? postReading.value - preReading.value : null;
      return { meal, preReading, postReading, delta };
    });
  }

  function isOutOfRange(value, min = GLUCOSE_TARGET.min, max = GLUCOSE_TARGET.max) {
    return value < min || value > max;
  }

  return { GLUCOSE_TARGET, GLUCOSE_HIGH, GLUCOSE_ZONES, estimateA1c, stats, timeInRange, matchMealsToGlucose, isOutOfRange };
})();
// verify.js(Node)에서 순수 로직만 불러와 검증할 수 있도록 하는 가드 — 브라우저에서는
// module이 없으므로 이 줄은 아무 영향이 없다.
if (typeof module !== 'undefined' && module.exports) module.exports = Insights;
