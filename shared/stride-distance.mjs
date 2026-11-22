/** Recorded displacement between contiguous samples from the same live pawn. */
export function strideDisplacement(from, to, seconds) {
  if (
    !from?.alive ||
    !to?.alive ||
    from.id !== to.id ||
    from.team !== to.team ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 0.25
  )
    return;
  const horizontal = Math.hypot(to.x - from.x, to.y - from.y);
  const vertical = to.z - from.z;
  const distance = Math.hypot(horizontal, vertical);
  if (
    !Number.isFinite(distance) ||
    Math.abs(vertical) > 128 ||
    distance > Math.max(128, 4096 * seconds)
  )
    return;
  return { horizontal, vertical };
}

export function strideCentimeters(from, to, seconds) {
  const displacement = strideDisplacement(from, to, seconds);
  return displacement ? Math.round(displacement.horizontal * 2.54) : 0;
}
