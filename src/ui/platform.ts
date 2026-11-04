// Desktop integration. The native shell uses real dialogs and menus; the browser build uses web APIs.
export const isTauri = () => "__TAURI_INTERNALS__" in window;
export const isMac = () => navigator.platform.toLowerCase().includes("mac");

export interface OpenedFile {
  name: string;
  path?: string;
  bytes: Uint8Array;
}

// WebKit collects an input nothing refers to while its picker is open, and the chosen file is
// then lost with no error. This also covers browsers that never report a cancelled picker.
let pickerInput: HTMLInputElement | undefined;

export async function openFile(extensions: string[]): Promise<OpenedFile | undefined> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: "Circuits", extensions }] });
    if (typeof path !== "string") return undefined;
    return { name: path.split(/[\\/]/).pop() ?? path, path, bytes: await readFile(path) };
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    pickerInput = input;
    input.type = "file";
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const file = input.files?.[0];
      try {
        resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : undefined);
      } catch (error) {
        reject(error);
      }
      if (pickerInput === input) pickerInput = undefined;
    };
    input.oncancel = () => {
      resolve(undefined);
      if (pickerInput === input) pickerInput = undefined;
    };
    input.click();
  });
}

/** Asks where to save, unless `path` says. Returns the path used, or undefined if cancelled. */
export async function saveFile(suggestedName: string, extension: string, contents: string, path?: string): Promise<string | undefined> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const target = path ?? await save({ defaultPath: suggestedName, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!target) return undefined;
    await writeTextFile(target, contents);
    return target;
  }
  // Browsers offer no save confirmation, so all this knows is that a download was started. A
  // browser may ask first, and the file has to stay available for as long as that takes.
  const url = URL.createObjectURL(new Blob([contents], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return suggestedName;
}

/** The Mac menu bar's spelling of a shortcut. Plain keys go through keydown, so they get none. */
export function nativeAccelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut || !/(Cmd|Ctrl)\+/.test(shortcut)) return undefined;
  return shortcut.replace(/^(Cmd|Ctrl)/, "CmdOrCtrl").replace(/Return$/, "Enter");
}

export interface NativeMenuItem {
  label: string;
  action: () => void;
  accelerator?: string;
}

/** Puts menus in the Mac menu bar. Returns false when not running in the desktop shell. */
export async function installNativeMenu(appName: string, menus: Record<string, NativeMenuItem[]>): Promise<boolean> {
  if (!isTauri()) return false;
  const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await import("@tauri-apps/api/menu");
  const app = await Submenu.new({
    text: appName,
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Hide" }),
      // The standard Quit item is reported to skip close handling, which would lose unsaved work.
      await MenuItem.new({
        text: `Quit ${appName}`,
        accelerator: "CmdOrCtrl+Q",
        action: async () => {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().close();
        },
      }),
    ],
  });
  const submenus = [app];
  for (const [text, entries] of Object.entries(menus)) {
    const items = [];
    if (text === "Edit") {
      // Mac text fields get copy, paste and undo only through these standard items. Actions
      // on the sheet reach the app through keydown and the copy, cut and paste events.
      for (const item of ["Undo", "Redo", "Cut", "Copy", "Paste", "SelectAll", "Separator"] as const) {
        items.push(await PredefinedMenuItem.new({ item }));
      }
    }
    for (const entry of entries) {
      items.push(await MenuItem.new({ text: entry.label, accelerator: entry.accelerator, action: entry.action }));
    }
    submenus.push(await Submenu.new({ text, items }));
  }
  const menu = await Menu.new({ items: submenus });
  await menu.setAsAppMenu();
  return true;
}

/** Asks before closing the window while there is unsaved work. */
export async function guardWindowClose(isDirty: () => boolean, confirmClose: () => Promise<boolean>): Promise<void> {
  if (!isTauri()) {
    window.addEventListener("beforeunload", (event) => {
      if (isDirty()) event.preventDefault();
    });
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    if (await confirmClose()) await win.destroy();
  });
}
