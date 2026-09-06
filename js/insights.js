/*
 * insights.js — 계산 로직 (진단 대체 아님, 참고용)
 */
const Insights = (() => {
  const GLUCOSE_TARGET = { min: 70, max: 140 };

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

  return { GLUCOSE_TARGET, estimateA1c, stats, timeInRange, matchMealsToGlucose, isOutOfRange };
})();
