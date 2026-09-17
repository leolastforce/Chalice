/**
 * Auto-mode classifier denial / unavailable messages (CC messages.ts subset).
 */

export const DENIAL_WORKAROUND_GUIDANCE =
	`IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, ` +
	`e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, ` +
	`e.g. do not use your ability to run tests to execute non-test actions. ` +
	`You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. ` +
	`If you believe this capability is essential to complete the user's request, STOP and explain to the user ` +
	`what you were trying to do and why you need this permission. Let the user decide how to proceed.`

export const AUTO_MODE_REJECTION_PREFIX =
	"Permission for this action has been denied. Reason: "

export function isClassifierDenial(content: string): boolean {
	return content.startsWith(AUTO_MODE_REJECTION_PREFIX)
}

export function buildYoloRejectionMessage(reason: string): string {
	const ruleHint =
		`To allow this type of action in the future, the user can add a permission rule like ` +
		`Bash(prompt: <description of allowed action>) to their settings. ` +
		`At the end of your session, recommend what permission rules to add so you don't get blocked again.`

	return (
		`${AUTO_MODE_REJECTION_PREFIX}${reason}. ` +
		`If you have other tasks that don't depend on this action, continue working on those. ` +
		`${DENIAL_WORKAROUND_GUIDANCE} ` +
		ruleHint
	)
}

export function buildClassifierUnavailableMessage(
	toolName: string,
	classifierModel: string,
): string {
	return (
		`${classifierModel} is temporarily unavailable, so auto mode cannot determine the safety of ${toolName} right now. ` +
		`Wait briefly and then try this action again. ` +
		`If it keeps failing, continue with other tasks that don't require this action and come back to it later. ` +
		`Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.`
	)
}
