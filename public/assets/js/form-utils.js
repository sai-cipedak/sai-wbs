export function getIntakePayload(form) {
  const data = new FormData(form);
  return {
    title: String(data.get('title') || '').trim(),
    narrative: String(data.get('narrative') || '').trim(),
    incidentDate: String(data.get('incidentDate') || '').trim() || null,
    incidentTimeText: String(data.get('incidentTimeText') || '').trim() || null,
    locationText: String(data.get('locationText') || '').trim() || null,
    peopleInvolvedText: String(data.get('peopleInvolvedText') || '').trim() || null,
    childSafetyRisk: data.get('childSafetyRisk') === 'yes',
    ongoingRisk: data.get('ongoingRisk') === 'yes',
  };
}

export function setBusy(button, busy, busyLabel = 'Mengirim…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent || '';
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || 'Kirim';
    button.disabled = false;
  }
}

export function showMessage(element, message, kind = 'info') {
  if (!element) return;
  element.textContent = message;
  element.className = `form-message ${kind}`;
  element.hidden = false;
}
