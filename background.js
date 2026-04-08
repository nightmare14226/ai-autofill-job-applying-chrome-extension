// ============================================================
// background.js – AutoApply Service Worker
// Handles OpenAI API calls from popup & content scripts.
// ============================================================

// ---- OpenAI helpers ----

/**
 * Call OpenAI Chat Completions API.
 * @param {string} apiKey
 * @param {string} model
 * @param {Array}  messages  – [{role,content}, ...]
 * @param {number} temperature
 * @returns {Promise<string>} assistant reply text
 */
async function callOpenAI(apiKey, model, messages, temperature = 0.7) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `OpenAI ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ---- System prompts ----

const COVER_LETTER_SYSTEM = `You write cover letters that sound like a real person wrote them — not a robot, not a template.

Your job: read the candidate's resume and the job description, then write a cover letter that feels genuine and conversational.

Rules:
- Write the way a smart, friendly person actually talks. Use everyday words. No corporate buzzwords like "synergy", "leverage", "spearheaded", "endeavor", or "I am writing to express my interest".
- Start with something natural — maybe why this job caught their eye, or a quick personal connection to the work. NEVER start with "Dear Hiring Manager, I am writing to apply for..."
- Show (don't just list) how their experience fits what the company needs. Use short, specific examples from the resume.
- Keep it 3-4 paragraphs, around 250-300 words. Shorter is better than longer.
- Sound confident but not braggy. It's okay to show some personality and enthusiasm.
- End naturally — something like looking forward to chatting, not "I would welcome the opportunity to discuss how my qualifications align with your needs."
- NEVER make up experience, skills, or facts that aren't in the resume.
- Match the tone the user asked for, but always keep it feeling human.
- Output ONLY the cover letter text. No commentary, no "Here's your cover letter:" prefix.`;

const FORM_FILLER_SYSTEM = `You help someone fill out a job application form. Write every answer the way a real person would — casual, clear, and honest. No robotic or corporate-speak.

You get:
1. The person's resume.
2. Their personal info (name, email, phone, etc.).
3. A list of form fields with labels and types.

How to answer each field:
- Simple stuff (name, email, phone, location, linkedin) → use exactly what they gave you.
- Open-ended questions ("Why do you want this job?", "Tell us about yourself") → write like a human being, not a cover letter generator. Use short sentences, plain words, and be specific. It's okay to be a little informal. Imagine you're explaining it to a friend.
- "Years of experience with X?" → give an honest number based on the resume. If it's not clear, give your best estimate and round to a whole number.
- Salary questions → say "Open to discussion" unless context suggests otherwise.
- Yes/no questions → answer honestly based on the resume. When unsure, go with "Yes".
- NEVER make up skills, jobs, degrees, or anything not in the resume.
- Short-answer fields: 1-3 sentences max. Keep it natural.
- Essay/long-answer fields: 3-5 sentences, still conversational.

CRITICAL rules for RADIO BUTTON fields (type: "radio"):
- The field will list available options like: options: ["Yes", "No"] or options: ["0-2 years", "3-5 years", "5+ years"].
- You MUST return one of the EXACT option texts as your answer. Do NOT rephrase or paraphrase.
- Pick the option that honestly matches the resume. If unsure, pick the most reasonable/common one.
- Example: if options are ["Yes", "No"] and the question is "Are you authorized to work in the US?", return "Yes" (not "yes" or "I am" or "true").

CRITICAL rules for SELECT/DROPDOWN fields (type: "select" or "custom-select"):
- The field will list available options like: options: ["Select...", "United States", "Canada", "United Kingdom"].
- You MUST return one of the EXACT option texts as your answer. Copy it character-for-character.
- NEVER return the placeholder option (e.g. "Select...", "Choose...", "-- Select --").
- Pick the option that best matches the candidate's info or resume.
- If none fit perfectly, pick the closest one.

CRITICAL writing style rules for ALL text answers:
- Don't start with "I am" — vary your sentence openings.
- Avoid: "passionate about", "thrive in", "eager to", "I believe", "leverage", "utilize", "spearhead".
- Use contractions (I've, I'm, don't, wasn't).
- It should sound like something a person would actually type, not something ChatGPT would write.

Respond ONLY with valid JSON: an array of objects, each with "fieldId" and "answer".
Example: [{"fieldId":"field_0","answer":"John Doe"},{"fieldId":"field_1","answer":"Yes"},{"fieldId":"field_2","answer":"3-5 years"},{"fieldId":"field_3","answer":"United States"}]`;

// ---- Message handlers ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'generateCoverLetter') {
    handleCoverLetter(message.payload)
      .then((coverLetter) => sendResponse({ coverLetter }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.action === 'fillForm') {
    handleFillForm(message.payload)
      .then((answers) => sendResponse({ answers }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'answerSingleField') {
    handleSingleField(message.payload)
      .then((answer) => sendResponse({ answer }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ---- Cover letter generation ----

async function handleCoverLetter({ resumeText, fullName, jobDescription, extra, tone, model }) {
  const data = await chrome.storage.local.get(['openaiKey']);
  const apiKey = data.openaiKey;
  if (!apiKey) throw new Error('OpenAI API key not set.');

  let userPrompt = `CANDIDATE NAME: ${fullName}\n\nRESUME:\n${resumeText}\n\nJOB DESCRIPTION:\n${jobDescription}`;
  if (tone) userPrompt += `\n\nTONE: ${tone}`;
  if (extra) userPrompt += `\n\nADDITIONAL INSTRUCTIONS: ${extra}`;

  return callOpenAI(apiKey, model || 'gpt-4o-mini', [
    { role: 'system', content: COVER_LETTER_SYSTEM },
    { role: 'user', content: userPrompt },
  ]);
}

// ---- Batch form fill ----

async function handleFillForm({ fields, pageContext }) {
  const data = await chrome.storage.local.get([
    'openaiKey',
    'model',
    'tone',
    'resumeText',
    'fullName',
    'email',
    'phone',
    'location',
    'linkedin',
    'portfolio',
  ]);

  const apiKey = data.openaiKey;
  if (!apiKey) throw new Error('OpenAI API key not set.');
  if (!data.resumeText) throw new Error('Resume not saved yet.');

  const personalInfo = [
    `Name: ${data.fullName || ''}`,
    `Email: ${data.email || ''}`,
    `Phone: ${data.phone || ''}`,
    `Location: ${data.location || ''}`,
    `LinkedIn: ${data.linkedin || ''}`,
    `Portfolio: ${data.portfolio || ''}`,
  ].join('\n');

  const fieldsDesc = fields
    .map((f, i) => {
      let desc = `[field_${i}] label: "${f.label}"  type: ${f.type}`;
      if (f.options && f.options.length > 0) {
        desc += `\n    ⚠️ MUST pick one of these EXACT options: ${JSON.stringify(f.options)}`;
      }
      if (f.placeholder) {
        desc += `  placeholder: "${f.placeholder}"`;
      }
      return desc;
    })
    .join('\n');

  const userPrompt = `PERSONAL DETAILS:\n${personalInfo}\n\nRESUME:\n${data.resumeText}\n\nPAGE CONTEXT (job posting):\n${pageContext || '(not available)'}\n\nFORM FIELDS:\n${fieldsDesc}\n\nProvide answers for all fields as JSON array.`;

  const raw = await callOpenAI(apiKey, data.model || 'gpt-4o-mini', [
    { role: 'system', content: FORM_FILLER_SYSTEM },
    { role: 'user', content: userPrompt },
  ], 0.6);

  // Parse JSON from response (strip markdown fences if present)
  const jsonStr = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error('AI returned invalid JSON. Raw: ' + raw.slice(0, 300));
  }
}

// ---- Single field answer ----

async function handleSingleField({ label, fieldType, options, pageContext }) {
  const data = await chrome.storage.local.get([
    'openaiKey',
    'model',
    'resumeText',
    'fullName',
    'email',
    'phone',
    'location',
    'linkedin',
    'portfolio',
  ]);

  const apiKey = data.openaiKey;
  if (!apiKey) throw new Error('OpenAI API key not set.');

  const personalInfo = `Name: ${data.fullName || ''} | Email: ${data.email || ''} | Phone: ${data.phone || ''} | Location: ${data.location || ''} | LinkedIn: ${data.linkedin || ''} | Portfolio: ${data.portfolio || ''}`;

  let userPrompt = `PERSONAL INFO: ${personalInfo}\n\nRESUME:\n${data.resumeText}\n\nPAGE CONTEXT: ${pageContext || '(not available)'}\n\nQUESTION/LABEL: "${label}"\nFIELD TYPE: ${fieldType}`;

  if (options && options.length > 0) {
    userPrompt += `\nAVAILABLE OPTIONS: ${JSON.stringify(options)}`;
  }

  userPrompt += '\n\nProvide ONLY the answer value, nothing else.';

  const SINGLE_FIELD_SYSTEM = `You answer a single job application question on behalf of the candidate.

Write the way a real person types — simple words, short sentences, contractions are fine.
DO NOT sound like a chatbot or a cover letter. Sound like someone casually but thoughtfully filling out a form.

Avoid these words/phrases: "passionate", "thrive", "eager", "I believe", "leverage", "utilize", "spearhead", "endeavor", "I am writing", "align with".

Use info from the resume only — never make stuff up.

IMPORTANT for RADIO and SELECT/DROPDOWN fields:
- If AVAILABLE OPTIONS are listed, you MUST return one of the EXACT option texts. Copy it character-for-character.
- Do NOT rephrase, abbreviate, or reword the option. Return it exactly as shown.
- Never return a placeholder like "Select..." or "Choose one".

Respond with ONLY the answer text. No explanation, no quotes, no "Answer:" prefix.`;

  return callOpenAI(apiKey, data.model || 'gpt-4o-mini', [
    { role: 'system', content: SINGLE_FIELD_SYSTEM },
    { role: 'user', content: userPrompt },
  ], 0.5);
}
