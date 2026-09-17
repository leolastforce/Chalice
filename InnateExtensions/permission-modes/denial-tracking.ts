/**
 * Classifier denial tracking (CC denialTracking.ts).
 * Escalates to manual prompting after repeated classifier blocks.
 */

export type DenialTrackingState = {
	consecutiveDenials: number
	totalDenials: number
}

export const DENIAL_LIMITS = {
	maxConsecutive: 3,
	maxTotal: 20,
} as const

export function createDenialTrackingState(): DenialTrackingState {
	return {
		consecutiveDenials: 0,
		totalDenials: 0,
	}
}

export function recordClassifierDenial(
	state: DenialTrackingState,
): DenialTrackingState {
	return {
		consecutiveDenials: state.consecutiveDenials + 1,
		totalDenials: state.totalDenials + 1,
	}
}

export function recordClassifierSuccess(
	state: DenialTrackingState,
): DenialTrackingState {
	if (state.consecutiveDenials === 0) return state
	return {
		...state,
		consecutiveDenials: 0,
	}
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
	return (
		state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
		state.totalDenials >= DENIAL_LIMITS.maxTotal
	)
}
