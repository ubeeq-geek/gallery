export type AppearancePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'ubeeq.appearance';
export const APPEARANCE_CHANGE_EVENT = 'ubeeq:appearance-change';

const isAppearancePreference = (value: string | null): value is AppearancePreference => (
  value === 'system' || value === 'light' || value === 'dark'
);

export const readAppearancePreference = (): AppearancePreference => {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
  return isAppearancePreference(stored) ? stored : 'system';
};

export const resolveAppearance = (preference: AppearancePreference): 'light' | 'dark' => {
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyAppearancePreference = (preference = readAppearancePreference()) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.appearance = preference;
  root.dataset.colorScheme = resolveAppearance(preference);
};

export const setAppearancePreference = (preference: AppearancePreference) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
  applyAppearancePreference(preference);
  window.dispatchEvent(new CustomEvent<AppearancePreference>(APPEARANCE_CHANGE_EVENT, { detail: preference }));
};

export const initializeAppearance = () => {
  if (typeof window === 'undefined') return;
  applyAppearancePreference();

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemChange = () => {
    if (readAppearancePreference() === 'system') applyAppearancePreference('system');
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY) applyAppearancePreference();
  };

  media.addEventListener('change', handleSystemChange);
  window.addEventListener('storage', handleStorage);
};
