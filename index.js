// Vercel Edge Function: прокси для redSBA (Gemini / Groq / OpenRouter)
// Регион зафиксирован на Франкфурт, чтобы Google не резал по региону.
// Env (Vercel -> Settings -> Environment Variables): GEMINI_KEY, GROQ_KEY, OPENROUTER_KEY

export const config = { runtime: "edge", regions: ["fra1"] };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const fail = (status, message) => json({ error: { message } }, status);

async function callGemini(model, messages, temperature) {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const body = { contents, generationConfig: { temperature } };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_KEY,
      },
      body: JSON.stringify(body),
    }
  );
  const text = await r.text();
  if (!r.ok) return { status: r.status, text };
  const d = JSON.parse(text);
  const parts = d.candidates?.[0]?.content?.parts || [];
  return { answer: parts.map((p) => p.text || "").join("") };
}

async function callOpenAI(url, key, model, messages, temperature, extra = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extra },
    body: JSON.stringify({ model, messages, temperature }),
  });
  const text = await r.text();
  if (!r.ok) return { status: r.status, text };
  const d = JSON.parse(text);
  return { answer: d.choices?.[0]?.message?.content || "" };
}

export default async function handler(req) {
  if (req.method !== "POST") return fail(405, "POST only");

  let b;
  try {
    b = await req.json();
  } catch {
    return fail(400, "bad json");
  }

  const { provider, model } = b;
  const temperature = typeof b.temperature === "number" ? b.temperature : 0.7;
  const messages =
    Array.isArray(b.messages) && b.messages.length
      ? b.messages
      : [{ role: "user", content: b.text || "" }];

  let res;
  try {
    if (provider === "gemini") {
      res = await callGemini(model, messages, temperature);
    } else if (provider === "groq") {
      res = await callOpenAI(
        "https://api.groq.com/openai/v1/chat/completions",
        process.env.GROQ_KEY, model, messages, temperature
      );
    } else if (provider === "openrouter") {
      res = await callOpenAI(
        "https://openrouter.ai/api/v1/chat/completions",
        process.env.OPENROUTER_KEY, model, messages, temperature,
        { "HTTP-Referer": "https://redsba.app", "X-Title": "redSBA" }
      );
    } else {
      return fail(400, "unknown provider: " + provider);
    }
  } catch (e) {
    return fail(502, "proxy error: " + e.message);
  }

  if (res.status) {
    let msg = res.text;
    try {
      const j = JSON.parse(res.text);
      msg = j.error?.message || j.message || res.text;
    } catch {}
    return fail(res.status, String(msg).slice(0, 500));
  }
  return json({ answer: res.answer, provider, model });
}
