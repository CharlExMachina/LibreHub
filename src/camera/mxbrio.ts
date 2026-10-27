// The MX Brio, one control at a time: reads every setting G Hub shows, writes one, and reads the
// firmware version and serial number from Logitech's device info unit.

import { SETTINGS, SETTING_KEYS, type CameraSettings, type SettingKey } from './settings.js';
import type { CameraTransport } from './transport.js';
import { CONTROLS } from './uvc.js';

export interface CameraInfo {
  model: string;
  serial: string;
  /** major.minor.build, as G Hub shows it (1.1.394). */
  firmware: string;
}

/** Device info unit selectors (Logitech's "Device Information" extension unit). */
const INFO_FIRMWARE = 1;
const INFO_SERIAL = 7;

export class MxBrio {
  private cachedInfo?: CameraInfo;

  constructor(readonly transport: CameraTransport) {}

  async info(): Promise<CameraInfo> {
    if (this.cachedInfo) return this.cachedInfo;
    const fw = await this.transport.readBytes('deviceInfo', INFO_FIRMWARE);
    const serial = await this.transport.readBytes('deviceInfo', INFO_SERIAL);
    this.cachedInfo = {
      model: 'MX Brio',
      serial: new TextDecoder().decode(serial).replace(/\0+$/, ''),
      firmware: `${fw[0]}.${fw[1]}.${fw[2] | (fw[3] << 8)}`,
    };
    return this.cachedInfo;
  }

  /** Every setting, as the camera has it now. */
  async readSettings(): Promise<CameraSettings> {
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const key of SETTING_KEYS) out[key] = SETTINGS[key].fromRaw(await this.transport.read(CONTROLS[SETTINGS[key].control]));
    return out as CameraSettings;
  }

  /** Write one setting's raw value (see settings.ts toRaw / writePlan). */
  async write(key: SettingKey, raw: number): Promise<void> {
    await this.transport.write(CONTROLS[SETTINGS[key].control], raw);
  }

  async microphone(): Promise<boolean> {
    return (await this.transport.read(CONTROLS.microphone)) !== 0;
  }

  /**
   * Turn the microphones on or off. The camera keeps this through power cycles, and restarts to
   * show up with (or without) its audio device: it is gone from USB for about four seconds.
   */
  async setMicrophone(on: boolean): Promise<void> {
    await this.transport.write(CONTROLS.microphone, on ? 1 : 0);
  }

  close(): void {
    this.transport.close();
  }
}
