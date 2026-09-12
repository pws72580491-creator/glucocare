/*
 * foodDb.js — 음식 매칭 · 식사 점수
 *
 * 실제 사진 → 음식 인식은 api/analyze-meal.js(Vercel 서버리스 함수)가 Gemini Vision으로
 * 처리합니다(v1.1.0~). 이 파일은 그 결과를 다듬고 보완하는 역할입니다:
 *   1) FoodDB.TABLE — 자주 먹는 한식 위주의 영양 참고 테이블 (탄수화물/단백질/지방/나트륨/GI)
 *   2) FoodDB.matchByName(query) — 음식 이름(직접 입력 또는 AI가 인식한 이름)으로 테이블을
 *      검색해 검수된 값으로 대체하는 기능 — AI 추정치보다 이쪽을 신뢰도 높게 취급합니다
 *      (js/app.js의 handleMealPhotoFile 참고)
 *   3) FoodDB.estimateMealScore(meal) — 저장될 영양 수치를 기준으로 한 식사 점수/코멘트
 *
 * 사진 없이 이름만 입력해도 매칭이 되도록 만들어서, 카메라를 쓸 수 없는 상황(오프라인,
 * 배포 환경에 서버리스 함수 미설정 등)에도 이 파일만으로 폴백이 가능합니다.
 */
const FoodDB = (() => {
  // 100g 또는 1인분 기준 대략값 — 참고용 수치이며 실제 섭취량에 따라 달라집니다.
  const TABLE = [
    { name: '현미밥', carbs: 45, protein: 4, fat: 1, sodium: 2, gi: 55 },
    { name: '흰쌀밥', carbs: 48, protein: 3, fat: 0.5, sodium: 2, gi: 73 },
    { name: '된장국', carbs: 6, protein: 6, fat: 3, sodium: 780, gi: 25 },
    { name: '계란말이', carbs: 3, protein: 12, fat: 9, sodium: 320, gi: 0 },
    { name: '비빔밥', carbs: 78, protein: 20, fat: 14, sodium: 890, gi: 68 },
    { name: '김치찌개', carbs: 12, protein: 16, fat: 14, sodium: 1450, gi: 30 },
    { name: '된장찌개', carbs: 14, protein: 15, fat: 9, sodium: 1200, gi: 32 },
    { name: '삼겹살', carbs: 0, protein: 24, fat: 36, sodium: 60, gi: 0 },
    { name: '닭가슴살 샐러드', carbs: 10, protein: 34, fat: 9, sodium: 380, gi: 20 },
    { name: '냉면', carbs: 88, protein: 14, fat: 6, sodium: 1600, gi: 60 },
    { name: '떡볶이', carbs: 68, protein: 8, fat: 10, sodium: 1350, gi: 82 },
    { name: '김밥', carbs: 60, protein: 10, fat: 8, sodium: 780, gi: 65 },
    { name: '라면', carbs: 78, protein: 10, fat: 16, sodium: 1900, gi: 73 },
    { name: '잡곡밥', carbs: 42, protein: 5, fat: 1.5, sodium: 2, gi: 48 },
    { name: '샐러드', carbs: 8, protein: 3, fat: 4, sodium: 120, gi: 15 },
    { name: '고구마', carbs: 27, protein: 2, fat: 0.2, sodium: 6, gi: 55 },
    { name: '바나나', carbs: 23, protein: 1, fat: 0.3, sodium: 1, gi: 51 },
    { name: '두부조림', carbs: 5, protein: 14, fat: 8, sodium: 520, gi: 15 },
    { name: '순두부찌개', carbs: 8, protein: 14, fat: 12, sodium: 1100, gi: 25 },
    { name: '오므라이스', carbs: 72, protein: 16, fat: 18, sodium: 980, gi: 70 },
  ];

  function normalize(s) {
    return (s || '').toLowerCase().replace(/\s+/g, '');
  }

  // 아주 단순한 부분일치 검색 (한글 자모 분해 없이 포함 여부만 비교)
  function matchByName(query) {
    const q = normalize(query);
    if (!q) return null;
    let best = null;
    for (const item of TABLE) {
      const n = normalize(item.name);
      if (n === q) return { ...item, confidence: 0.97 };
      // 부분일치는 최소 2글자부터만 시도한다 — 한 글자짜리 검색어(입력 중간
      // 상태 포함)는 다른 음식 이름 안에 우연히 포함되는 경우가 많아서
      // (예: "구" → "고구마") 엉뚱한 음식이 잘못 매칭되기 쉽다.
      if (q.length >= 2 && (n.includes(q) || q.includes(n))) {
        if (!best || n.length < normalize(best.name).length) best = item;
      }
    }
    return best ? { ...best, confidence: 0.72 } : null;
  }

  function estimateMealScore(meal) {
    // 아주 단순한 휴리스틱 점수 — 실제 서비스에서는 개인별 목표·과거 반응을 반영해야 합니다.
    let score = 100;
    const reasons = [];
    if (meal.gi >= 70) { score -= 25; reasons.push('혈당지수(GI)'); }
    else if (meal.gi >= 55) { score -= 10; reasons.push('혈당지수(GI)'); }
    if (meal.sodium >= 1200) { score -= 20; reasons.push('나트륨'); }
    else if (meal.sodium >= 800) { score -= 10; reasons.push('나트륨'); }
    if (meal.carbs >= 80) { score -= 15; reasons.push('탄수화물'); }
    else if (meal.carbs >= 60) { score -= 5; reasons.push('탄수화물'); }
    if (meal.fat >= 35) { score -= 10; reasons.push('지방'); }
    if (meal.protein >= 20) score += 5;
    score = Math.max(30, Math.min(100, score));

    let tier = 'good';
    let comment = '탄수화물과 나트륨 균형이 양호한 식사예요.';
    if (score < 55) {
      tier = 'low';
      comment = reasons.length
        ? `${reasons.join('·')}이(가) 높은 편이에요. 식이섬유나 단백질을 더해보세요.`
        : '전반적으로 부담이 있는 식사예요.';
    } else if (score < 78) {
      tier = 'mid';
      comment = reasons.length
        ? `나쁘지 않지만 ${reasons.join('·')} 비중을 조금 줄이면 더 좋아요.`
        : '나쁘지 않지만 정제 탄수화물 비중을 조금 줄이면 더 좋아요.';
    }
    return { score, tier, comment };
  }

  return { TABLE, matchByName, estimateMealScore };
})();
// verify.js(Node)에서 순수 로직만 불러와 검증할 수 있도록 하는 가드 — 브라우저에서는
// module이 없으므로 이 줄은 아무 영향이 없다.
if (typeof module !== 'undefined' && module.exports) module.exports = FoodDB;
