export const CREATOR_PROFILE_CHANGED_EVENT = 'ubeeq:creator-profile-changed';

export function notifyCreatorProfileChanged() {
  window.dispatchEvent(new Event(CREATOR_PROFILE_CHANGED_EVENT));
}
