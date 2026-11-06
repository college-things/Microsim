import { appendLocalized, bindProperties, setText, setLocale } from './i18n';
import { DEFAULT_PREFERENCES, getPreferences, previewPreferences, resolveLanguage, savePreferences, type Preferences } from './preferences';
export function applyAppearance(p:Preferences):void {
  const dark=p.theme==='dark'||p.theme==='midnight'||p.theme==='contrast'||p.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches;
  const root=document.documentElement;
  root.dataset.theme=p.theme==='system'?(dark?'dark':'light'):p.theme;
  root.dataset.accent=p.accent;
  root.dataset.reducedMotion=String(p.reducedMotion);
  root.style.setProperty('--ui-font-size',`${p.textSize}px`);
  root.lang=resolveLanguage(p.language,navigator.languages);
  setLocale(resolveLanguage(p.language,navigator.languages));
}
type Dialog=(title:string,build:(body:HTMLElement,close:()=>void)=>void,dismiss?:()=>void)=>void;
export function showSettings(dialog:Dialog,readKey:()=>string,writeKey:(value:string)=>void,done:(saved:boolean)=>void):void {
  const original=getPreferences();let draft={...original},committed=false;
  dialog('Settings',(box,close)=>{
    box.classList.add('settings-dialog');
    const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const node=document.createElement(tag);setText(node,text);return node;};
    const intro=make('p','Changes preview immediately. Save keeps them for next time; Cancel restores your previous settings.');intro.className='muted';box.append(intro);
    const form=make('div');form.className='settings-sections';box.append(form);
    const preview=()=>previewPreferences(draft);
    const section=(name:string)=>{const group=make('fieldset');group.append(make('legend',name));form.append(group);return group;};
    const choice=<K extends keyof Preferences>(host:HTMLElement,label:string,key:K,choices:readonly (readonly [Preferences[K],string])[])=>{
      const row=make('label');row.className='settings-row';const name=make('span',label),select=make('select');
      bindProperties(select,{ariaLabel:label});
      for(const [value,text]of choices){const option=make('option',text);option.value=String(value);select.append(option);}
      select.value=String(draft[key]);select.onchange=()=>{const value=choices.find(([v])=>String(v)===select.value)![0];draft={...draft,[key]:value};preview();};
      row.append(name,select);host.append(row);
    };
    const flag=(host:HTMLElement,label:string,key:'showGrid'|'snapToGrid'|'showVoltages'|'reducedMotion')=>{
      const row=make('label');row.className='settings-check';const input=make('input');input.type='checkbox';input.checked=draft[key];bindProperties(input,{ariaLabel:label});
      input.onchange=()=>{draft={...draft,[key]:input.checked};preview();};row.append(input,make('span',label));host.append(row);
    };
    const render=()=>{
      form.replaceChildren();
      const general=section('General');
      choice(general,'Language','language',[['system','System default'],['en','English'],['uk','Українська'],['ru','Русский']]);
      const note=make('p','Language changes the interface only. Circuit text, SPICE, assembly, expressions and units stay unchanged.');note.className='muted';general.append(note);
      const appearance=section('Appearance');
      choice(appearance,'Theme','theme',[['system','System'],['light','Light'],['dark','Dark'],['midnight','Midnight'],['contrast','High contrast']]);
      choice(appearance,'Accent color','accent',[['teal','Teal'],['blue','Blue'],['violet','Violet'],['amber','Amber']]);
      choice(appearance,'Text size','textSize',[[13,'Default'],[15,'Large'],[17,'Extra large']]);
      flag(appearance,'Reduce motion','reducedMotion');
      const editor=section('Editor');flag(editor,'Show grid','showGrid');flag(editor,'Snap to grid','snapToGrid');flag(editor,'Show live wire voltages','showVoltages');
      const recovery=section('Recovery');choice(recovery,'Autosave delay','autosaveSeconds',[[2,'2 seconds'],[5,'5 seconds'],[10,'10 seconds'],[30,'30 seconds']]);
      const recoveryNote=make('p','Recovery copies are saved locally after edits and when you leave the app. They do not replace saving your circuit file.');recoveryNote.className='muted';recovery.append(recoveryNote);
    };
    render();
    const assistant=make('fieldset');assistant.append(make('legend','Assistant'));
    const row=make('label');row.className='field';const key=make('input');key.type='password';key.value=readKey();key.autocomplete='off';key.placeholder='sk-ant-...';bindProperties(key,{ariaLabel:'Anthropic API key'});appendLocalized(row,'Anthropic API key',key);assistant.append(row);
    assistant.append(make('p',('__TAURI_INTERNALS__' in window)?"Stored unencrypted in this app's local storage on this computer.":'Kept only until you close this tab.'),make('p','Your circuit and messages go to Anthropic only when you use the assistant.'));box.append(assistant);
    const resetNote=make('p','Restoring defaults changes preferences only. Your circuits and assistant key are kept.');resetNote.className='muted';box.append(resetNote);
    const actions=make('div');actions.className='dialog-actions settings-actions';
    const button=(label:string,action:()=>void,primary=false)=>{const node=make('button',label);node.type='button';if(primary)node.className='primary';node.onclick=action;actions.append(node);return node;};
    button('Restore defaults',()=>{draft={...DEFAULT_PREFERENCES};preview();render();});
    button('Cancel',close);
    button('Save',()=>{const saved=savePreferences(draft);writeKey(key.value.trim());committed=true;close();done(saved);},true);
    box.append(actions);
  },()=>{if(!committed)previewPreferences(original);});
}
