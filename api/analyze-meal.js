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

// 429/500/502/503/504나 네트워크 예외, 타임아웃은 보통 일시적인 과부하라서
// 같은 모델로 잠깐 기다렸다가 한 번 더 시도해볼 가치가 있습니다.
// (404는 모델 자체가 없는 것이므로 재시도하지 않고 바로 다음 모델로 넘어갑니다.)
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES_PER_MODEL = 1; // 모델당 최대 시도 횟수 = 1(최초) + 1(재시도) = 2
const RETRY_DELAY_MS = 700;
const PER_ATTEMPT_TIMEOUT_MS = 8000; // 모델 최대 2개 × 시도 최대 2번 = 4번, 8초씩이면 최악의 경우도 Vercel maxDuration(45초) 안에 들어옴

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  let lastFailure = null;

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    const isLastModel = mi === modelsToTry.length - 1;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      const isLastAttemptForModel = attempt === MAX_RETRIES_PER_MODEL;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);

      let geminiRes;
      try {
        geminiRes = await fetch(
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
      } catch (err) {
        clearTimeout(timeout);
        const isAbort = err && err.name === 'AbortError';
        const label = isAbort ? '타임아웃' : '네트워크 예외';
        console.error(`[analyze-meal] ${label} (model=${model}, attempt=${attempt + 1}/${MAX_RETRIES_PER_MODEL + 1}):`, isAbort ? `${PER_ATTEMPT_TIMEOUT_MS}ms 초과` : err);
        lastFailure = { kind: isAbort ? 'timeout' : 'exception', model, detail: String(err) };
        if (!isLastAttemptForModel) { await sleep(RETRY_DELAY_MS); continue; }
        if (!isLastModel) break; // 다음 모델로
        res.status(isAbort ? 504 : 500).json({
          error: isAbort ? '분석이 너무 오래 걸려서 중단했어요. 다시 시도해주세요.' : '분석 중 오류가 발생했어요.',
          detail: String(err).slice(0, 300),
        });
        return;
      }
      clearTimeout(timeout);

      if (geminiRes.status === 404) {
        // 모델명 자체가 없어진 경우 — 재시도해도 의미 없으니 바로 다음 모델로.
        console.error(`[analyze-meal] 모델 ${model} 404 (모델을 찾을 수 없음)`);
        lastFailure = { kind: 'not-found', model, status: 404 };
        break; // 재시도 루프 탈출 → 다음 모델
      }

      if (RETRYABLE_STATUSES.has(geminiRes.status)) {
        const errText = await geminiRes.text().catch(() => '');
        console.error(`[analyze-meal] 일시적 오류 (model=${model}, attempt=${attempt + 1}/${MAX_RETRIES_PER_MODEL + 1}, status=${geminiRes.status}):`, errText.slice(0, 300));
        lastFailure = { kind: 'retryable', model, status: geminiRes.status, detail: errText };
        if (!isLastAttemptForModel) { await sleep(RETRY_DELAY_MS); continue; }
        break; // 이 모델에서 재시도 소진 → 다음 모델로
      }

      if (!geminiRes.ok) {
        // 404도 아니고 재시도 대상도 아닌 오류(예: 400 잘못된 요청, 403 권한 문제) —
        // 모델을 바꾸거나 재시도해도 똑같이 실패할 가능성이 높으므로 바로 실패 처리.
        const errText = await geminiRes.text().catch(() => '');
        console.error(`[analyze-meal] Gemini API 오류 (model=${model}, status=${geminiRes.status}):`, errText.slice(0, 500));
        res.status(502).json({ error: `Gemini API 오류 (${geminiRes.status})`, detail: errText.slice(0, 300) });
        return;
      }

      // ------- 성공 -------
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
      console.log(`[analyze-meal] 성공: "${name}" (model=${model}, attempt=${attempt + 1}, confidence=${parsed.confidence})`);
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
    }
  }

  // 모든 모델·재시도가 실패
  console.error('[analyze-meal] 모든 모델/재시도 실패:', lastFailure);
  const status = lastFailure && lastFailure.status;
  const hint = status === 404
    ? ' GEMINI_MODEL 환경변수나 코드의 DEFAULT_MODELS를 최신 모델명으로 바꿔주세요 (https://ai.google.dev/gemini-api/docs/models).'
    : ' 구글 서버가 일시적으로 과부하 상태일 수 있어요. 잠시 후 다시 시도해주세요.';
  res.status(502).json({
    error: `여러 번 시도했지만 사진 분석에 실패했어요.${hint}`,
    detail: lastFailure,
  });
};
