/*
 * api/analyze-meal.js — 식사 사진 → 음식 이름 · 영양 추정 (Gemini Vision)
 *
 * 이 파일은 Vercel 서버리스 함수입니다. GEMINI_API_KEY는 여기(서버)에만 존재하고
 * 브라우저로는 절대 내려가지 않습니다 — 클라이언트는 사진만 이 엔드포인트로
 * 보내고, 결과(JSON)만 돌려받습니다.
 *
 * 필요한 설정: Vercel 프로젝트 → Settings → Environment Variables →
 *   GEMINI_API_KEY = (Google AI Studio에서 발급한 키)
 * 설정 후 재배포해야 반영됩니다.
 *
 * 주의: 사진은 분석을 위해 Google Gemini API로 전송됩니다. 클라이언트에는
 * 압축된 이미지만 보내지만, 민감한 사진은 올리지 않는 게 좋습니다.
 */

// Google이 몇 주~몇 달 간격으로 모델을 은퇴시키고 새 버전을 냅니다
// (2026-09 기준: 2.0 계열은 이미 종료, 2.5-pro도 종료 예정 — 3.x 계열이 현재 라인업).
// 그래서 기본값을 배열로 두고, 첫 모델이 404(모델 자체가 없음)면 자동으로 다음 모델을
// 시도합니다. GEMINI_MODEL 환경변수를 설정하면 그 모델 하나만 씁니다(자동 폴백 없음).
// 404가 계속 나면 https://ai.google.dev/gemini-api/docs/models 에서 현재 모델명을 확인하세요.
const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];

const PROMPT = `당신은 한국 음식 사진을 보고 무엇인지 알아내는 영양 분석 도우미입니다.
사진 속 음식을 보고 아래 JSON 형식으로만 답하세요. 다른 설명, 마크다운, 코드블록 없이 JSON 객체 하나만 출력하세요.

{
  "name": "음식 이름 (한국어, 2~12자, 예: 비빔밥)",
  "carbs_g": 1인분 기준 탄수화물(g, 숫자만),
  "protein_g": 단백질(g, 숫자만),
  "fat_g": 지방(g, 숫자만),
  "sodium_mg": 나트륨(mg, 숫자만),
  "gi": 혈당지수 추정치(0~100, 숫자만),
  "confidence": 이 추정에 대한 확신도(0~1 사이 숫자),
  "note": "한 문장짜리 짧은 설명 (분량 추정 근거나 불확실한 이유 등)"
}

사진에 음식이 여러 개면 가장 비중이 큰 음식 하나로 답하세요.
확실하지 않으면 confidence를 낮게 주세요. 음식 사진이 아니면 name을 빈 문자열로 두세요.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[analyze-meal] GEMINI_API_KEY가 설정되어 있지 않습니다.');
    res.status(500).json({
      error: 'GEMINI_API_KEY가 서버에 설정되어 있지 않아요. Vercel 프로젝트 Settings → Environment Variables에 추가한 뒤 다시 배포해주세요.',
    });
    return;
  }

  const body = req.body || {};
  const { imageBase64, mimeType } = body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: '이미지 데이터가 없어요.' });
    return;
  }
  if (!mimeType || !/^image\/(jpeg|jpg|png|webp)$/.test(mimeType)) {
    res.status(400).json({ error: '지원하지 않는 이미지 형식이에요.' });
    return;
  }
  // Vercel 서버리스 함수의 요청 본문은 4.5MB로 제한됩니다. base64는 원본보다
  // 약 33% 커지므로, 여유를 두고 이 시점에서 한 번 더 막습니다
  // (클라이언트에서 이미 리사이즈해서 보내지만 방어적으로 재확인).
  if (imageBase64.length > 6 * 1024 * 1024) {
    res.status(413).json({ error: '이미지가 너무 커요. 사진을 다시 선택해보세요.' });
    return;
  }

  const configuredModel = process.env.GEMINI_MODEL;
  const modelsToTry = configuredModel ? [configuredModel] : DEFAULT_MODELS;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    const isLastModel = i === modelsToTry.length - 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: mimeType, data: imageBase64 } },
                  { text: PROMPT },
                ],
              },
            ],
            generationConfig: { temperature: 0.2, response_mime_type: 'application/json' },
          }),
        }
      );
      clearTimeout(timeout);

      if (geminiRes.status === 404 && !isLastModel) {
        // 이 모델명이 없어졌을 뿐일 수 있으니, 다음 후보 모델로 넘어간다.
        console.error(`[analyze-meal] 모델 ${model} 404 — 다음 모델(${modelsToTry[i + 1]})로 재시도`);
        continue;
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => '');
        console.error(`[analyze-meal] Gemini API 오류 (model=${model}, status=${geminiRes.status}):`, errText.slice(0, 500));
        const hint = geminiRes.status === 404
          ? ' 시도한 모델을 모두 찾지 못했어요. GEMINI_MODEL 환경변수나 코드의 DEFAULT_MODELS를 최신 모델명으로 바꿔주세요 (https://ai.google.dev/gemini-api/docs/models).'
          : '';
        res.status(502).json({ error: `Gemini API 오류 (${geminiRes.status})${hint}`, detail: errText.slice(0, 300) });
        return;
      }

      const data = await geminiRes.json();
      const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
        && data.candidates[0].content.parts[0].text;
      if (!raw) {
        res.status(502).json({ error: 'Gemini 응답에서 결과를 찾지 못했어요.' });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        console.error('[analyze-meal] Gemini 응답 JSON 파싱 실패. 원문:', raw.slice(0, 500));
        res.status(502).json({ error: 'Gemini 응답을 해석하지 못했어요.' });
        return;
      }

      const name = String(parsed.name || '').trim().slice(0, 30);
      if (!name) {
        res.status(422).json({ error: '사진에서 음식을 알아보지 못했어요. 이름을 직접 입력해주세요.' });
        return;
      }

      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
      console.log(`[analyze-meal] 성공: "${name}" (model=${model}, confidence=${parsed.confidence})`);
      res.status(200).json({
        name,
        carbs_g: clamp(Number(parsed.carbs_g), 0, 300),
        protein_g: clamp(Number(parsed.protein_g), 0, 200),
        fat_g: clamp(Number(parsed.fat_g), 0, 200),
        sodium_mg: clamp(Number(parsed.sodium_mg), 0, 6000),
        gi: clamp(Number(parsed.gi), 0, 100),
        confidence: clamp(Number(parsed.confidence), 0, 1),
        note: String(parsed.note || '').trim().slice(0, 200),
      });
      return;
    } catch (err) {
      clearTimeout(timeout);
      if (err && err.name === 'AbortError') {
        console.error(`[analyze-meal] 타임아웃 (model=${model}, 12초 초과)`);
        res.status(504).json({ error: '분석이 너무 오래 걸려서 중단했어요. 다시 시도해주세요.' });
        return;
      }
      console.error('[analyze-meal] 예외 발생:', err);
      res.status(500).json({ error: '분석 중 오류가 발생했어요.', detail: String(err).slice(0, 300) });
      return;
    }
  }
};
