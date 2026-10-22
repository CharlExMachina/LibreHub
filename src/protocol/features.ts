// Feature IDs reported by the A50 X (firmware 1.2.18) through the FeatureSet feature.
// Names come from G Hub's own C++ class names (devio::FeatureXXXX...) where it has one.

export const Feature = {
  ROOT: 0x0000,
  FEATURE_SET: 0x0001,
  PROFILE: 0x0004,
  DEVICE_INFO: 0x0100,
  DEVICE_NAME: 0x0101,
  UNKNOWN_0102: 0x0102,
  MEMFAULT: 0x0103,
  BATTERY: 0x0104,
  AUTO_SLEEP: 0x0108,
  GENERIC_DFU: 0x010a,
  LED_BRIGHTNESS: 0x0110,
  VOLUME: 0x0200,
  PARAMETRIC_EQ: 0x020d,
  MIC_TEST: 0x020e,
  UNKNOWN_0303: 0x0303,
  BT_HOST_INFO: 0x0305,
  SIDETONE: 0x0604,
  GAME_VOICE_MIX: 0x0609,
  HEADSET_TONES: 0x060b,
  MIXER_AUDIO: 0x0800,
  MIXER_MIC: 0x0801,
  UNKNOWN_0805: 0x0805,
  UNKNOWN_0806: 0x0806,
  UNKNOWN_0807: 0x0807,
} as const;

export type FeatureId = (typeof Feature)[keyof typeof Feature];

export const FEATURE_NAMES: Record<number, string> = {
  0x0000: 'Root',
  0x0001: 'FeatureSet',
  0x0004: 'Profile',
  0x0100: 'DeviceInfo',
  0x0101: 'DeviceName',
  0x0102: '(unnamed 0102)',
  0x0103: 'Memfault',
  0x0104: 'BatterySOC',
  0x0108: 'AutoSleep',
  0x010a: 'GenericDFU',
  0x0110: 'LEDBrightness',
  0x0200: 'VolumeSet',
  0x020d: 'AdvancedParaEQ',
  0x020e: 'MicTest',
  0x0303: '(unnamed 0303)',
  0x0305: 'BtHostInfo',
  0x0604: 'HeadsetAudioSidetone',
  0x0609: 'HeadsetMix',
  0x060b: 'HeadsetTones',
  0x0800: 'MixerAudio',
  0x0801: 'MixerMic',
  0x0805: '(unnamed 0805)',
  0x0806: '(unnamed 0806)',
  0x0807: '(unnamed 0807)',
};

export function featureName(id: number): string {
  return FEATURE_NAMES[id] ?? `0x${id.toString(16).padStart(4, '0')}`;
}
