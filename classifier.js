// ─── read prefs from storage ──────────────────────────────────
function getPrefs() {
  return new Promise(resolve => {
    chrome.storage.local.get(['prefs', 'groqKey'], d => {
      resolve({
        preferred: d.prefs?.preferred || [],
        blocked:   d.prefs?.blocked   || [],
        mode:      d.prefs?.mode      || 'balanced',
        groqKey:   d.groqKey          || ''
      });
    });
  });
}

// ─── local keyword rule engine (zero latency, no API) ────────
function classifyLocal(item, prefs) {
  const text = `${item.title} ${item.channel} ${item.hashtags.join(' ')} ${item.description || ''}`.toLowerCase();

  // Check blocked keywords
  for (const t of prefs.blocked) {
    if (text.includes(t.toLowerCase())) {
      return { decision: 'BLOCK', source: 'local-keyword', reason: 'matched blocked keyword: "' + t + '"' };
    }
  }

  // Check preferred keywords
  const preferredHits = prefs.preferred.filter(t => text.includes(t.toLowerCase()));

  if (prefs.mode === 'strict' && preferredHits.length === 0) {
    return { decision: 'SKIP', source: 'local-keyword', reason: 'strict mode and no preferred keywords matched' };
  }

  if (preferredHits.length > 0) {
    return { decision: 'SHOW', source: 'local-keyword', reason: 'matched preferred: ' + preferredHits.join(', ') };
  }

  return { decision: 'UNCERTAIN', source: 'local-keyword', reason: 'no keyword match, escalating to Groq LLM' };
}

// ─── Groq LLM classification ─────────────────────────────────
async function classifyGroq(item, prefs) {
  if (!prefs.groqKey) return { decision: 'SHOW', source: 'no-groq-key', reason: 'no API key set' };

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${prefs.groqKey}`
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        max_tokens:  60,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a content relevance classifier for a social media feed filter.

You will receive content metadata and user preferences. Analyze ALL of the following personalization factors:
1. VIDEO TITLE — the main text describing the content
2. CHANNEL/CREATOR — who made this content (creator reputation/niche)
3. HASHTAGS — topic tags associated with the content
4. DESCRIPTION — any additional text/context provided

Based on these factors, decide if the content matches the user's interests.

Reply in this EXACT format (two lines only):
DECISION: SHOW or SKIP or BLOCK
REASON: one sentence explaining why

Rules:
- BLOCK = content matches a blocked topic (always remove)
- SKIP = content does not match any preferred topic (in strict mode) or is low relevance
- SHOW = content matches preferred topics or is generally acceptable`
          },
          {
            role: 'user',
            content: `USER PREFERENCES:
- Preferred topics: ${prefs.preferred.join(', ') || 'not specified'}
- Blocked topics: ${prefs.blocked.join(', ') || 'none'}
- Mode: ${prefs.mode} (${prefs.mode === 'strict' ? 'ONLY show preferred topics' : 'block explicit, pass rest'})

CONTENT TO CLASSIFY:
- Title: "${item.title}"
- Channel: "${item.channel}"
- Hashtags: ${item.hashtags.length ? item.hashtags.join(', ') : 'none'}
- Description: "${item.description || 'none'}"

Classify this content:`
          }
        ]
      })
    });

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';

    // Parse the response
    const decisionMatch = raw.match(/DECISION:\s*(SHOW|SKIP|BLOCK)/i);
    const reasonMatch = raw.match(/REASON:\s*(.+)/i);

    const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'SHOW';
    const reason = reasonMatch ? reasonMatch[1].trim() : raw.substring(0, 100);

    return { decision, source: 'groq-llm', reason };

  } catch (e) {
    return { decision: 'SHOW', source: 'groq-error', reason: 'API error: ' + e.message };
  }
}

// ─── unified classifier: local first, Groq fallback ──────────
async function classify(item, prefs) {
  const local = classifyLocal(item, prefs);
  if (local.decision !== 'UNCERTAIN') return local;
  return classifyGroq(item, prefs);
}

// ─── session stats helpers ────────────────────────────────────
function incrementStat(key) {
  chrome.storage.local.get('stats', d => {
    const stats  = d.stats || { shown: 0, skipped: 0, blocked: 0 };
    stats[key]   = (stats[key] || 0) + 1;
    chrome.storage.local.set({ stats });
  });
}
