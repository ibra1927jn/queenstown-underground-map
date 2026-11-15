/**
 * The small status pill ("Loading buildings…").
 */

const DONE_VISIBLE_MS = 2200;
const ERROR_VISIBLE_MS = 9000;

export function createStatus(element) {
  const text = element.querySelector('.status__text');
  let hideTimer;

  function show(message, kind, hideAfterMs) {
    clearTimeout(hideTimer);
    text.textContent = message;
    element.className = kind ? `status status--${kind}` : 'status';
    element.hidden = false;
    if (hideAfterMs) hideTimer = setTimeout(() => (element.hidden = true), hideAfterMs);
  }

  return {
    /** Work in progress: stays until replaced. */
    busy: (message) => show(message),
    /** Finished: shown briefly. */
    done: (message) => show(message, 'done', DONE_VISIBLE_MS),
    /** Something failed: shown longer, in red. */
    error: (message) => show(message, 'error', ERROR_VISIBLE_MS),
    /** The page could not start: stays on screen until it is reloaded. */
    fatal: (message) => show(message, 'error'),
    clear() {
      clearTimeout(hideTimer);
      element.hidden = true;
    },
  };
}
