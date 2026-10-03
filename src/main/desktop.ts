import { app, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from 'electron';
import { join } from 'node:path';

/*
 * Windows integration: icon next to the clock (Hormiga keeps syncing and alerting with the window closed),
 * start with Windows in the background, and a red dot on the taskbar icon when there are unread alerts.
 * Only for the installed app: in development and tests the window closes normally.
 */

function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png');
}

/** 16×16 red dot (BGRA bitmap) for the taskbar overlay. */
function redDot(): NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const i = (y * size + x) * 4;
      if (d <= 6.5) {
        buf[i] = 0x3a; buf[i + 1] = 0x3a; buf[i + 2] = 0xd9; buf[i + 3] = 0xff;
      } else if (d <= 7.5) {
        buf[i] = 0xff; buf[i + 1] = 0xff; buf[i + 2] = 0xff; buf[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export interface DesktopActions {
  show(): void;
  syncNow(): void;
  quit(): void;
}

export class Desktop {
  private tray: Tray | null = null;
  private dot: NativeImage | null = null;
  private hintShown = false;
  quitting = false;

  constructor(private readonly actions: DesktopActions) {}

  /** Tray and login items only make sense for the installed app. */
  get enabled(): boolean {
    return app.isPackaged && process.platform === 'win32' && !process.env.HORMIGA_USER_DATA;
  }

  ensureTray(unread: number): void {
    if (!this.enabled) return;
    if (!this.tray) {
      this.tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
      this.tray.setToolTip('Hormiga');
      this.tray.on('click', () => this.actions.show());
    }
    this.tray.setToolTip(unread ? `Hormiga · ${unread} ${unread === 1 ? 'aviso sin leer' : 'avisos sin leer'}` : 'Hormiga');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Hormiga', click: () => this.actions.show() },
        { label: unread ? `Ver avisos (${unread})` : 'Sin avisos nuevos', enabled: unread > 0, click: () => this.actions.show() },
        { label: 'Buscar extractos ahora', click: () => this.actions.syncNow() },
        { type: 'separator' },
        { label: 'Salir de Hormiga', click: () => this.actions.quit() },
      ]),
    );
  }

  /** Red dot on the taskbar icon while there are unread alerts. */
  setUnread(win: BrowserWindow | null, unread: number): void {
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
    this.dot ??= redDot();
    win.setOverlayIcon(unread ? this.dot : null, unread ? `${unread} avisos sin leer` : '');
    this.ensureTray(unread);
  }

  /** Called on window close: hide to the tray instead of quitting (setting). Returns true if it hid. */
  hideInsteadOfClose(win: BrowserWindow, trayOnClose: boolean): boolean {
    if (!this.enabled || !trayOnClose || this.quitting) return false;
    win.hide();
    if (!this.hintShown && this.tray) {
      this.hintShown = true;
      this.tray.displayBalloon({ title: 'Hormiga sigue en segundo plano', content: 'Seguirá buscando tus extractos y avisándote. Para cerrarla del todo: clic derecho en este icono → Salir.', iconType: 'info' });
    }
    return true;
  }

  applyLoginItem(openAtLogin: boolean): void {
    if (!this.enabled) return;
    app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
  }

  get startedHidden(): boolean {
    return process.argv.includes('--hidden');
  }
}
