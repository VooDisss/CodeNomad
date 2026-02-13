/**
 * RAF Chain Protection Utility
 * Prevents RequestAnimationFrame chain oscillation that causes scroll bounce
 */

interface RAFPendingState {
  scroll: boolean
  layout: boolean
  resize: boolean
}

const rafPending: RAFPendingState = {
  scroll: false,
  layout: false,
  resize: false,
}

/**
 * Safe wrapper for requestAnimationFrame that prevents chain oscillation
 * by ensuring only one RAF of each type can be pending at a time
 */
export function safeRequestAnimationFrame(
  type: keyof RAFPendingState,
  callback: FrameRequestCallback
): number {
  // If already pending, skip to prevent oscillation
  if (rafPending[type]) {
    return 0
  }

  rafPending[type] = true

  return requestAnimationFrame((timestamp) => {
    rafPending[type] = false
    callback(timestamp)
  })
}

/**
 * Cancel a pending RAF and clear its state
 */
export function cancelSafeRAF(type: keyof RAFPendingState, id: number): void {
  if (id && id !== 0) {
    cancelAnimationFrame(id)
    rafPending[type] = false
  }
}

/**
 * Check if a RAF of specific type is currently pending
 */
export function isRAFPending(type: keyof RAFPendingState): boolean {
  return rafPending[type]
}

/**
 * Batch multiple DOM operations into a single RAF to prevent layout thrashing
 */
export function batchDOMOperations(operations: () => void): void {
  if (isRAFPending('layout')) {
    return
  }

  safeRequestAnimationFrame('layout', () => {
    operations()
  })
}