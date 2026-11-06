import {describe,it,expect,afterEach,vi} from 'vitest';
import {DEFAULT_PREFERENCES, PREFERENCES_KEY, getPreferences, parsePreferences, previewPreferences, resolveLanguage, savePreferences, subscribePreferences, validatePreferences} from '../../src/ui/preferences';
import {t,setLocale} from '../../src/ui/i18n';
import {MESSAGES} from '../../src/ui/locales/messages';
import {PARTS} from '../../src/core/library';
afterEach(()=>{previewPreferences(DEFAULT_PREFERENCES);setLocale('en');vi.unstubAllGlobals();});
describe('application preferences',()=>{
  it('stores only validated preferences and survives unavailable storage',()=>{
    const values=new Map<string,string>([['microsim.apiKey','kept'],['microsim.autosave.circuit','kept']]);
    vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>values.set(key,value)});
    expect(savePreferences({...DEFAULT_PREFERENCES,language:'uk',apiKey:'not copied'})).toBe(true);
    expect(parsePreferences(values.get(PREFERENCES_KEY)!)).toMatchObject({language:'uk'});
    expect(values.get(PREFERENCES_KEY)).not.toContain('apiKey');expect(values.get('microsim.apiKey')).toBe('kept');expect(values.get('microsim.autosave.circuit')).toBe('kept');
    vi.stubGlobal('localStorage',{setItem:()=>{throw new Error('unavailable');}});
    expect(savePreferences({...DEFAULT_PREFERENCES,language:'ru'})).toBe(false);expect(getPreferences().language).toBe('ru');
  });
  it('recovers damaged storage and ignores unsupported values and unrelated fields',()=>{
    expect(parsePreferences('{broken')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('null')).toEqual(DEFAULT_PREFERENCES);
    expect(validatePreferences({language:'de',theme:'invalid',textSize:1000,showGrid:'false',autosaveSeconds:-1,apiKey:'secret',schematic:{}})).toEqual(DEFAULT_PREFERENCES);
    expect(validatePreferences({language:'uk',theme:'midnight',textSize:17,snapToGrid:false,autosaveSeconds:30})).toMatchObject({language:'uk',theme:'midnight',textSize:17,snapToGrid:false,autosaveSeconds:30});
  });
  it('selects an explicit language or the first supported browser preference',()=>{
    expect(resolveLanguage('ru',['uk-UA'])).toBe('ru');
    expect(resolveLanguage('system',['de-DE','uk-UA','en'])).toBe('uk');
    expect(resolveLanguage('system',['ru_RU','en'])).toBe('ru');
    expect(resolveLanguage('system',['fr'])).toBe('en');
  });
  it('previews and restores settings without exposing mutable shared state',()=>{
    const before=getPreferences(),changes:boolean[]=[];const stop=subscribePreferences(p=>changes.push(p.showGrid));
    previewPreferences({...before,showGrid:false});expect(getPreferences().showGrid).toBe(false);
    const copy=getPreferences();copy.showGrid=true;expect(getPreferences().showGrid).toBe(false);
    previewPreferences(before);expect(getPreferences()).toEqual(before);stop();
    expect(changes).toEqual([false,true]);
  });
});
describe('Ukrainian and Russian UI catalogs',()=>{
  it('covers every built-in component property label',()=>{
    for(const part of PARTS)for(const parameter of part.params){
      expect(t(parameter.label,'uk'),`${part.kind}: ${parameter.label}`).not.toBe(parameter.label);
      expect(t(parameter.label,'ru'),`${part.kind}: ${parameter.label}`).not.toBe(parameter.label);
    }
  });
  it('has a complete, nonempty pair for every translated message and preserves parameters',()=>{
    const parameters=(s:string)=>[...s.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();
    for(const [source,pair]of Object.entries(MESSAGES)){
      expect(pair,source).toHaveLength(2);
      for(const text of pair){expect(text.trim(),source).not.toBe('');expect(parameters(text),source).toEqual(parameters(source));}
    }
  });
  it('translates controls, whitespace and ellipsis without changing English',()=>{
    expect(t('Settings','en')).toBe('Settings');expect(t('Settings','uk')).toBe('Налаштування');
    expect(t('Settings','ru')).toBe('Настройки');expect(t(' Save as... ','uk')).toBe(' Зберегти як… ');
    expect(t('Stop at ','ru')).toBe('Остановить на ');
  });
  it('preserves opaque parameters, circuit text, engineering units and source code',()=>{
    expect(t('Place X1.U2','uk')).toBe('Розмістити X1.U2');
    expect(t('Delete “File” and everything on it? You can undo this.','ru')).toBe('Удалить «File» и всё её содержимое? Это действие можно отменить.');
    expect(t('Choose an analysis (Ctrl+Return)','uk')).toBe('Вибрати аналіз (Ctrl+Return)');
    for(const source of ['V1 IN 0 DC 5\nR1 IN OUT 1k\n.end','MOVLW 0x10','499.9 mV rms','X1.R2','my custom circuit'])expect(t(source,'uk')).toBe(source);
  });
});
