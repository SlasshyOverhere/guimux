import { ask, message } from "@tauri-apps/plugin-dialog";

// Tauri's webview does not implement window.confirm/alert, so destructive
// actions must go through plugin-dialog. Browser dev falls back to the
// native JS dialogs.
export async function confirmDialog(text: string): Promise<boolean> {
  try {
    return await ask(text, { title: "guimux", kind: "warning" });
  } catch {
    return window.confirm(text);
  }
}

export async function errorDialog(text: string): Promise<void> {
  try {
    await message(text, { title: "guimux", kind: "error" });
  } catch {
    window.alert(text);
  }
}
