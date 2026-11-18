/** Keyboard movement uses action positions and supports both labelled layouts.
 * Event.key additionally accepts the user's active AZERTY/QWERTY mapping. */
export function freeCameraAction(event: Pick<KeyboardEvent, 'code' | 'key'>) {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'z' || event.code === 'KeyW') return 'forward';
  if (key === 's' || event.code === 'KeyS') return 'back';
  if (key === 'a' || key === 'q' || event.code === 'KeyA') return 'left';
  if (key === 'd' || event.code === 'KeyD') return 'right';
  if (key === 'e' || event.code === 'KeyE') return 'up';
  if (key === 'c' || event.code === 'KeyC') return 'down';
  return undefined;
}
export function typingOrDialog(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],[role="menu"],[role="listbox"],[data-keyboard-managed]',
    )
  );
}
