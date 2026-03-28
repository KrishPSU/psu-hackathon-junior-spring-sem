// ─── load saved values on open ────────────────────────────────
chrome.storage.local.get(['prefs', 'groqKey', 'stats'], d => {
  if (d.groqKey) document.getElementById('groq-key').value = d.groqKey;
  if (d.prefs) {
    document.getElementById('preferred').value = (d.prefs.preferred || []).join(', ');
    document.getElementById('blocked').value   = (d.prefs.blocked   || []).join(', ');
    document.getElementById('mode').value      = d.prefs.mode || 'balanced';
  }
  const s = d.stats || {};
  document.getElementById('s-shown').textContent   = s.shown   || 0;
  document.getElementById('s-skipped').textContent = s.skipped || 0;
  document.getElementById('s-blocked').textContent = s.blocked || 0;
});

// ─── save on button click ─────────────────────────────────────
document.getElementById('save').addEventListener('click', () => {
  const split = str => str.split(',').map(s => s.trim()).filter(Boolean);

  chrome.storage.local.set({
    groqKey: document.getElementById('groq-key').value.trim(),
    prefs: {
      preferred: split(document.getElementById('preferred').value),
      blocked:   split(document.getElementById('blocked').value),
      mode:      document.getElementById('mode').value
    }
  }, () => {
    const btn = document.getElementById('save');
    btn.textContent = 'Saved';
    setTimeout(() => btn.textContent = 'Save preferences', 1200);
  });
});
