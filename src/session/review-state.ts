import { ReviewState } from './types.js';

export function aggregateReviewStates(states: readonly ReviewState[]): ReviewState {
  if (states.includes(ReviewState.failed)) return ReviewState.failed;
  if (states.includes(ReviewState.needs_review)) return ReviewState.needs_review;
  if (!states.length || states.includes(ReviewState.unknown)) return ReviewState.unknown;
  return states.every(state => state === ReviewState.not_applicable) ? ReviewState.not_applicable : ReviewState.passed;
}
