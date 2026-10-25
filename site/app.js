const $ = (id) => document.getElementById(id);
const state = { recorder: null, stream: null, chunks: [], seconds: 0, timer: null, recordingUrl: null, recorded: false, documentText: '' };

function notice(message) {
  $('notice').textContent = message;
  $('notice').classList.remove('hidden');
  $('notice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearNotice() { $('notice').classList.add('hidden'); }
function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.oldLabel ||= button.textContent;
  button.textContent = busy ? label : button.dataset.oldLabel;
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
  if (!response.ok) throw new Error(data.detail || 'Something went wrong. Please try again.');
  return data;
}
const jsonOptions = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mimeOptions = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

function updateCounts() {
  $('character-count').textContent = `${$('character').value.length} / 6000`;
  $('dialogue-count').textContent = `${$('dialogue').value.length} / 2500`;
}
function updateTimer() {
  state.seconds += 1;
  $('record-timer').textContent = `${String(Math.floor(state.seconds / 60)).padStart(2, '0')}:${String(state.seconds % 60).padStart(2, '0')}`;
  if (state.seconds >= 30) stopRecording();
}
async function startRecording() {
  clearNotice();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { notice('This browser cannot record audio. You can type the line instead.'); return; }
  try {
    const mimeType = mimeOptions.find((type) => MediaRecorder.isTypeSupported(type));
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.seconds = 0;
    $('record-timer').textContent = '00:00';
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = finishRecording;
    state.recorder.start();
    state.timer = setInterval(updateTimer, 1000);
    $('record-button').classList.add('recording');
    $('record-label').textContent = 'Stop recording';
    $('record-status').textContent = 'Recording your take…';
  } catch (error) { notice(error.name === 'NotAllowedError' ? 'Microphone access was declined. You can type the line instead.' : 'Could not start the microphone. Please try typing the line.'); }
}
function stopRecording() {
  if (state.recorder?.state === 'recording') state.recorder.stop();
  clearInterval(state.timer);
  state.stream?.getTracks().forEach((track) => track.stop());
  $('record-button').classList.remove('recording');
  $('record-label').textContent = 'Start recording';
}
async function finishRecording() {
  const type = state.recorder.mimeType || state.chunks[0]?.type || 'audio/webm';
  const blob = new Blob(state.chunks, { type });
  if (blob.size < 1000) { $('record-status').textContent = 'No audio was captured'; notice('The recording was too short. Please try again.'); return; }
  state.recordingUrl = URL.createObjectURL(blob);
  state.recorded = true;
  $('recorded-audio').src = state.recordingUrl;
  $('recording-preview').classList.remove('hidden');
  $('record-status').textContent = 'Transcribing with Sarvam…';
  $('record-button').disabled = true;
  const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, `take.${extension}`);
  try {
    const result = await api('/api/transcribe', { method: 'POST', body: form });
    $('dialogue').value = result.transcript;
    if (result.language_code) {
      const code = result.language_code.startsWith('en') ? 'en-IN' : result.language_code;
      if ([...$('language').options].some((option) => option.value === code)) $('language').value = code;
    }
    $('transcript-note').textContent = 'Transcribed by Sarvam. Check and edit any words before feedback.';
    $('record-status').textContent = 'Take saved · transcript ready to review';
    updateCounts();
  } catch (error) { $('record-status').textContent = 'Take saved · transcription unavailable'; notice(`${error.message} You can enter the line manually and keep your recording.`); }
  finally { $('record-button').disabled = false; }
}
function removeRecording() {
  state.recorded = false;
  state.recordingUrl = null;
  $('recorded-audio').removeAttribute('src');
  $('recording-preview').classList.add('hidden');
  $('record-status').textContent = 'Best for a line under 30 seconds';
  $('transcript-note').textContent = 'Your words stay yours. We suggest a delivery, not a rewrite.';
}

async function uploadSketch(file) {
  clearNotice();
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { notice('Please choose a sketch under 8 MB.'); return; }
  $('sketch-result').classList.remove('hidden');
  $('sketch-name').textContent = file.name;
  $('sketch-text').textContent = 'Reading your sketch…';
  const form = new FormData(); form.append('file', file);
  try {
    let result = await api('/api/document', { method: 'POST', body: form });
    if (result.status === 'processing') {
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(2500);
        result = await api(`/api/document/${encodeURIComponent(result.job_id)}`);
        if (result.status === 'complete') break;
      }
    }
    if (result.status !== 'complete' || !result.text?.trim()) throw new Error('The sketch could not be read yet. Paste the relevant details in the notes above.');
    state.documentText = result.text;
    $('sketch-text').textContent = `${result.source}: ${result.text.slice(0, 650)}${result.text.length > 650 ? '…' : ''}`;
  } catch (error) { state.documentText = ''; $('sketch-text').textContent = 'No text extracted. Add the important details in the notes above.'; notice(error.message); }
}

function put(id, value) { $(id).textContent = value || '—'; }
function renderRecommendations(items) {
  $('recommendations').replaceChildren();
  items.slice(0, 3).forEach((item, index) => {
    const card = document.createElement('article'); card.className = 'reference-card';
    const number = document.createElement('span'); number.textContent = `0${index + 1}`;
    const title = document.createElement('h4'); title.textContent = item.character || 'Character reference';
    const film = document.createElement('p'); film.className = 'film'; film.textContent = item.film || '';
    const why = document.createElement('p'); why.textContent = item.why || '';
    const observe = document.createElement('p');
    const bold = document.createElement('b'); bold.textContent = 'Watch for: ';
    observe.append(bold, document.createTextNode(item.observe || ''));
    card.append(number, title, film, why, observe);
    $('recommendations').append(card);
  });
}
function renderFeedback(result, dialogue) {
  put('interpretation', result.interpretation); put('emotion', result.emotion);
  put('subtext', result.subtext); put('strengths', result.strengths);
  put('delivery', result.delivery); put('emphasis', (result.emphasis || []).join(' · '));
  put('pauses', result.pauses); put('original-copy', `“${dialogue}”`);
  put('improved-copy', `“${result.demo_text || dialogue}”`);
  put('change-summary', result.change_summary);
  $('adjustments').replaceChildren();
  (result.adjustments || []).forEach((tip) => { const li = document.createElement('li'); li.textContent = tip; $('adjustments').append(li); });
  renderRecommendations(result.recommendations || []);
  $('results').classList.remove('hidden');
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function makeVoice(text, pace) {
  const result = await api('/api/voice', jsonOptions({ text, pace, language_code: $('language').value }));
  return result.audio;
}
async function getFeedback() {
  clearNotice();
  const character = $('character').value.trim();
  const dialogue = $('dialogue').value.trim();
  if (!character) { $('character').focus(); notice('Tell us a little about the character first.'); return; }
  if (!dialogue) { $('dialogue').focus(); notice('Record or enter a line first.'); return; }
  if (character.length > 6000 || dialogue.length > 2500) { notice('Shorten the notes or line to fit the character limits.'); return; }
  setBusy($('feedback-button'), true, 'Preparing your notes…');
  try {
    const result = await api('/api/feedback', jsonOptions({ character, dialogue, document_text: state.documentText, recorded: state.recorded }));
    renderFeedback(result, dialogue);
    $('original-player').removeAttribute('src');
    $('improved-player').removeAttribute('src');
    if (state.recorded && state.recordingUrl) {
      $('original-player').src = state.recordingUrl;
      $('original-caption').textContent = 'Your actual recorded performance';
    } else {
      $('original-caption').textContent = 'Sarvam AI neutral reading of your typed line';
    }
    const tasks = [makeVoice(result.demo_text || dialogue, 0.88).then((url) => { $('improved-player').src = url; })];
    if (!state.recorded) tasks.push(makeVoice(dialogue, 1.0).then((url) => { $('original-player').src = url; }));
    const done = await Promise.allSettled(tasks);
    if (done.some((entry) => entry.status === 'rejected')) notice('Your feedback is ready, but a voice demonstration could not be generated. Please try again later.');
  } catch (error) { notice(error.message); }
  finally { setBusy($('feedback-button'), false); }
}

$('character').addEventListener('input', updateCounts);
$('dialogue').addEventListener('input', updateCounts);
$('record-button').addEventListener('click', () => state.recorder?.state === 'recording' ? stopRecording() : startRecording());
$('discard-recording').addEventListener('click', removeRecording);
$('sketch').addEventListener('change', (event) => uploadSketch(event.target.files[0]));
$('remove-sketch').addEventListener('click', () => { state.documentText = ''; $('sketch').value = ''; $('sketch-result').classList.add('hidden'); });
$('feedback-button').addEventListener('click', getFeedback);
$('practice-again').addEventListener('click', () => { $('dialogue-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('record-button').focus(), 450); });
