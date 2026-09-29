import { execFile } from 'node:child_process';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Logger } from '../core/services/context';
import type { SecretVault } from '../core/email/types';
import { AppError } from '../core/errors';
import type { LockStatus } from '../shared/types';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const PIN_SECRET = 'lock.pin';
const PIN_RE = /^\d{4,8}$/;

/*
 * App lock. While locked, the main process refuses every IPC channel except the lock ones, so the interface cannot
 * read any data even if it tried. The PIN is never stored: only a salted scrypt hash, inside the system's secure store
 * (DPAPI). Windows Hello (fingerprint, face or Windows PIN) uses the system's UserConsentVerifier.
 * Note: this protects the app, not the database file on disk (see docs/security.md).
 */
export class AppLock {
  private locked = false;
  private failures = 0;
  private blockedUntil = 0;
  private helloCache: boolean | null = null;

  constructor(
    private readonly vault: SecretVault,
    private readonly settings: () => { enabled: boolean; windowsHello: boolean; autoLockMinutes: number },
    private readonly log: Logger,
    private readonly emit: (s: LockStatus) => void,
  ) {}

  async init(): Promise<void> {
    this.locked = this.settings().enabled && (await this.hasPin());
  }

  isLocked(): boolean {
    return this.locked;
  }

  async status(): Promise<LockStatus> {
    const s = this.settings();
    return {
      enabled: s.enabled,
      locked: this.locked,
      pinSet: await this.hasPin(),
      helloAvailable: await this.helloAvailable(),
      windowsHello: s.windowsHello,
      autoLockMinutes: s.autoLockMinutes,
      retryAfterSeconds: Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000)),
    };
  }

  private async hasPin(): Promise<boolean> {
    return !!(await this.vault.get(PIN_SECRET));
  }

  async setPin(pin: string, currentPin?: string): Promise<void> {
    if (!PIN_RE.test(pin)) throw new AppError('VALIDATION', 'El PIN debe tener entre 4 y 8 cifras.');
    if ((await this.hasPin()) && !(await this.check(currentPin ?? ''))) throw new AppError('VALIDATION', 'El PIN actual no es correcto.');
    const salt = randomBytes(16);
    const hash = await scrypt(pin, salt, 32);
    await this.vault.set(PIN_SECRET, JSON.stringify({ v: 1, salt: salt.toString('base64'), hash: hash.toString('base64') }));
    this.log.info('lock.pin_set');
  }

  async removePin(currentPin: string): Promise<void> {
    if (!(await this.check(currentPin))) throw new AppError('VALIDATION', 'El PIN no es correcto.');
    await this.vault.delete(PIN_SECRET);
    this.locked = false;
  }

  private async check(pin: string): Promise<boolean> {
    const raw = await this.vault.get(PIN_SECRET);
    if (!raw) return false;
    const { salt, hash } = JSON.parse(raw) as { salt: string; hash: string };
    const expected = Buffer.from(hash, 'base64');
    const got = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  lock(): void {
    if (!this.settings().enabled || this.locked) return;
    this.locked = true;
    this.log.info('lock.locked');
    void this.status().then(this.emit);
  }

  async unlockWithPin(pin: string): Promise<LockStatus> {
    if (Date.now() < this.blockedUntil) throw new AppError('VALIDATION', 'Demasiados intentos. Espera unos segundos.');
    if (await this.check(pin)) {
      this.failures = 0;
      this.locked = false;
      this.log.info('lock.unlocked', { method: 'pin' });
    } else {
      this.failures++;
      // Growing pause after 3 wrong attempts: 5 s, 10 s, 20 s… up to 5 minutes.
      if (this.failures >= 3) this.blockedUntil = Date.now() + Math.min(300, 5 * 2 ** (this.failures - 3)) * 1000;
      this.log.warn('lock.failed', { attempts: this.failures });
      throw new AppError('VALIDATION', 'PIN incorrecto.');
    }
    const s = await this.status();
    this.emit(s);
    return s;
  }

  async unlockWithHello(): Promise<LockStatus> {
    if (!this.settings().windowsHello || !(await this.helloAvailable())) throw new AppError('VALIDATION', 'Windows Hello no está disponible. Usa tu PIN.');
    const result = await runHello('verify');
    if (result !== 'Verified') throw new AppError('VALIDATION', result === 'Canceled' ? 'Cancelado.' : 'Windows Hello no ha podido verificarte. Usa tu PIN.');
    this.locked = false;
    this.failures = 0;
    this.log.info('lock.unlocked', { method: 'hello' });
    const s = await this.status();
    this.emit(s);
    return s;
  }

  async helloAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    this.helloCache ??= (await runHello('check').catch(() => '')) === 'Available';
    return this.helloCache;
  }
}

const HELLO_SCRIPT = (mode: 'check' | 'verify') => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
${mode === 'check'
    ? `$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync(); $type = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]`
    : `$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Desbloquear Hormiga'); $type = [Windows.Security.Credentials.UI.UserConsentVerificationResult]`}
$t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; Write-Output $t.Result`;

/** Runs a fixed PowerShell script (no user input) against the Windows Hello API. */
function runHello(mode: 'check' | 'verify'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELLO_SCRIPT(mode)],
      { windowsHide: true, timeout: mode === 'check' ? 15000 : 120000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });
}
