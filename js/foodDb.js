/*
 * foodDb.js — 음식 인식 · 영양 분석
 *
 * 실제 사진 인식(AI 음식 인식)은 이미지 분류 모델(API) 없이는 브라우저에서 처리할 수 없습니다.
 * 이 파일은 두 가지를 제공합니다:
 *   1) FoodDB.TABLE — 자주 먹는 한식 위주의 영양 참고 테이블 (탄수화물/단백질/지방/나트륨/GI)
 *   2) FoodDB.matchByName(query) — 음식 이름으로 테이블을 검색해 값을 자동 채워주는 보조 기능
 *
 * 사진을 올리면 이름 검색 UI로 자연스럽게 이어지도록 구성했습니다.
 * 실제 사진 → 음식명 인식을 붙이려면, 기존 "발주관리" 앱에서 쓰신 Gemini Vision 패턴처럼
 * js/aiVision.example.js 를 참고해 이미지 base64를 멀티모달 모델에 전달하고,
 * 반환된 음식명을 FoodDB.matchByName()에 넘기면 됩니다.
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
      if (n.includes(q) || q.includes(n)) {
        if (!best || n.length < normalize(best.name).length) best = item;
      }
    }
    return best ? { ...best, confidence: 0.72 } : null;
  }

  function estimateMealScore(meal) {
    // 아주 단순한 휴리스틱 점수 — 실제 서비스에서는 개인별 목표·과거 반응을 반영해야 합니다.
    let score = 100;
    if (meal.gi >= 70) score -= 25; else if (meal.gi >= 55) score -= 10;
    if (meal.sodium >= 1200) score -= 20; else if (meal.sodium >= 800) score -= 10;
    if (meal.carbs >= 80) score -= 15; else if (meal.carbs >= 60) score -= 5;
    if (meal.protein >= 20) score += 5;
    score = Math.max(30, Math.min(100, score));

    let tier = 'good';
    let comment = '탄수화물과 나트륨 균형이 양호한 식사예요.';
    if (score < 55) {
      tier = 'low';
      comment = '혈당지수(GI)와 나트륨이 높은 편이에요. 식이섬유나 단백질을 더해보세요.';
    } else if (score < 78) {
      tier = 'mid';
      comment = '나쁘지 않지만 정제 탄수화물 비중을 조금 줄이면 더 좋아요.';
    }
    return { score, tier, comment };
  }

  return { TABLE, matchByName, estimateMealScore };
})();
