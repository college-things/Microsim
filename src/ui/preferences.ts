export type Language = 'system' | 'en' | 'uk' | 'ru';
export type Theme = 'system' | 'light' | 'dark' | 'midnight' | 'contrast';
export interface Preferences {
  language: Language; theme: Theme; accent: 'teal' | 'blue' | 'violet' | 'amber';
  textSize: 13 | 15 | 17; showGrid: boolean; snapToGrid: boolean;
  showVoltages: boolean; reducedMotion: boolean; autosaveSeconds: 2 | 5 | 10 | 30;
}
export const PREFERENCES_KEY = 'microsim.preferences.v1';
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  language: 'system', theme: 'system', accent: 'teal', textSize: 13,
  showGrid: true, snapToGrid: true, showVoltages: true, reducedMotion: false, autosaveSeconds: 2,
});
export function validatePreferences(value: unknown): Preferences {
  const p = value && typeof value === 'object' ? value as Partial<Preferences> : {};
  const choice = <T>(v: unknown, choices: readonly T[], fallback: T): T => choices.includes(v as T) ? v as T : fallback;
  const flag = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  return {
    language: choice(p.language, ['system','en','uk','ru'] as const, 'system'),
    theme: choice(p.theme, ['system','light','dark','midnight','contrast'] as const, 'system'),
    accent: choice(p.accent, ['teal','blue','violet','amber'] as const, 'teal'),
    textSize: choice(p.textSize, [13,15,17] as const, 13),
    showGrid: flag(p.showGrid,true), snapToGrid: flag(p.snapToGrid,true),
    showVoltages: flag(p.showVoltages,true), reducedMotion: flag(p.reducedMotion,false),
    autosaveSeconds: choice(p.autosaveSeconds,[2,5,10,30] as const,2),
  };
}
export function parsePreferences(text: string | null): Preferences {
  try { return validatePreferences(JSON.parse(text ?? '{}')); } catch { return {...DEFAULT_PREFERENCES}; }
}
export function resolveLanguage(language: Language, languages: readonly string[]): 'en'|'uk'|'ru' {
  if (language !== 'system') return language;
  for (const name of languages) {
    const code=name.toLowerCase().split(/[-_]/)[0];
    if (code==='uk'||code==='ru'||code==='en') return code;
  }
  return 'en';
}
let current: Preferences = {...DEFAULT_PREFERENCES};
const listeners = new Set<(p: Preferences)=>void>();
export const getPreferences = (): Preferences => ({...current});
export function subscribePreferences(listener: (p: Preferences)=>void): ()=>void {
  listeners.add(listener); return ()=>listeners.delete(listener);
}
export function previewPreferences(value: unknown): void {
  current=validatePreferences(value); for(const listener of listeners)listener(getPreferences());
}
export function savePreferences(value: unknown): boolean {
  const p=validatePreferences(value); let saved=true;
  try { localStorage.setItem(PREFERENCES_KEY,JSON.stringify(p)); } catch { saved=false; }
  previewPreferences(p); return saved;
}
export function initializePreferences(): void {
  try { current=parsePreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { current={...DEFAULT_PREFERENCES}; }
  window.addEventListener('storage',event=>{
    try {
      if(event.storageArea===localStorage&&(event.key===PREFERENCES_KEY||event.key===null))previewPreferences(parsePreferences(event.newValue));
    } catch { /* Storage can become unavailable after initialization. */ }
  });
}
