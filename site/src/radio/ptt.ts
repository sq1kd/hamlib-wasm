/**
 * The PTT button: held, it keys the radio; released, it unkeys it.
 *
 * Shared by both panels, so React's and the landing page's behave alike.
 * Each press sends one `setPtt(true)` and each release one `setPtt(false)`,
 * never derived from the last poll, so a quick tap cannot send TX twice.
 * The pointer is captured, so sliding off the button does not drop the key,
 * and anything that ends the hold (a cancelled touch, a lost window, the
 * button going away) releases it.
 */
export function bindPtt(button: HTMLButtonElement, setPtt: (on: boolean) => void): () => void {
  let held = false;

  const press = (): void => {
    if (!held && !button.disabled) {
      held = true;
      button.dataset.held = '';
      setPtt(true);
    }
  };

  const release = (): void => {
    if (held) {
      held = false;
      delete button.dataset.held;
      setPtt(false);
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }

    button.setPointerCapture(event.pointerId);
    press();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();

      if (!event.repeat) {
        press();
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      release();
    }
  };

  const onContextMenu = (event: Event): void => { event.preventDefault(); };

  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('keydown', onKeyDown);
  button.addEventListener('keyup', onKeyUp);
  button.addEventListener('blur', release);
  button.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', release);

  return () => {
    release();
    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('pointerup', release);
    button.removeEventListener('pointercancel', release);
    button.removeEventListener('lostpointercapture', release);
    button.removeEventListener('keydown', onKeyDown);
    button.removeEventListener('keyup', onKeyUp);
    button.removeEventListener('blur', release);
    button.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('blur', release);
  };
}
