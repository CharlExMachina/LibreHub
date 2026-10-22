// Frames captured from a real A50 X (base station firmware 1.2.18) on 2026-10-20.
// Full logs: docs/evidence/captures/. Each entry is the exact report minus trailing zero padding.
// swid 0xE/0xA = G Hub's agent, 0xB = our own requests, 0 = unsolicited device event.

export const CAPTURED = {
  // --- discovery (G Hub agent startup, sniff-agent-start.txt)
  rootGetFeatureSet: '02 0c 06 00 00 0e 01 00 01',
  featureSetCount: '02 0c 04 00 01 0e 18 00',
  featureSetFrom0: '02 0c 3c 00 01 1b 0e 00 00 00 02 00 01 00 01 01 0a 00 06 01 02 00 01 01 00 00 06 01 01 00 02 01 04 00 04 01 08 00 03 02 00 00 04 06 04 00 02 06 09 00 02 03 03 00 04 08 00 00 01 02 0d 00 01',
  featureSetFrom14: '02 0c 2c 00 01 1b 0a 03 05 00 01 01 10 00 01 06 0b 00 01 01 03 00 01 00 04 00 04 02 0e 00 02 08 06 00 01 08 05 00 01 08 01 00 01 08 07 00 01',
  featureSetPastEnd: '02 0c 05 00 ff 01 1b 05',

  // --- device information
  deviceInfoHardware: '02 0c 0c 00 04 0e 24 07 00 00 00 00 00 00 0b',
  deviceInfoFirmware: '02 0c 0d 00 04 1e 01 02 00 12 04 6d 61 69 6e',
  deviceInfoSerial: '02 0c 10 00 04 2e 0c 30 30 30 30 58 58 30 58 30 58 30 30',
  deviceModelName: '02 0c 09 00 05 2e 05 41 35 30 20 58',
  deviceName: '02 0c 0c 00 05 0e 1e 07 43 61 72 6c 6f 73 27',
  battery: '02 0c 06 00 06 0e 5f 5f',
  btHostCount: '02 0c 04 00 0e 0e 01 00',
  btHostAddress: '02 0c 09 00 0e 1e 00 00 5e 00 53 01',
  btHostName: '02 0c 21 00 0e 2e 30 1c 45 78 61 6d 70 6c 65 20 42 6c 75 65 74 6f 6f 74 68 20 48 6f 73 74 20 30 31 32 33 34',

  // --- sidetone (idx 9)
  sidetoneGet: '02 0c 07 00 09 0b 01 01 ff 06',
  sidetoneInfo: '02 0c 06 00 09 2e ee 00 07',
  sidetoneSetRequest: '02 0c 06 00 09 1b 01 ff 05',
  sidetoneSetAck: '02 0c 03 00 09 1b',
  sidetoneEvent: '02 0c 07 00 09 00 01 01 ff 05',
  sidetoneSetBadLength: '02 0c 05 00 ff 09 1b 03',
  sidetoneSetOutOfRange: '02 0c 05 00 ff 09 1b 0b',

  // --- device volume (idx 8)
  volumeGet: '02 0c 06 00 08 0b 1f 00 15',
  volumeInfo: '02 0c 04 00 08 3b 16 00',
  volumeSetRequest: '02 0c 05 00 08 1b ff 13',
  volumeEventLevel19: '02 0c 06 00 08 00 1c 00 13',
  volumeEventMuted: '02 0c 06 00 08 00 1f 01 15',
  volumeSetWrongChannel: '02 0c 05 00 ff 08 1b 05',

  // --- game/voice balance (idx 10)
  mixGet: '02 0c 04 00 0a 0b 06 00',
  mixInfo: '02 0c 06 00 0a 2e 0c 05 04',
  mixEvent: '02 0c 04 00 0a 00 05 00',

  // --- sleep timer (idx 7); all events below were produced by G Hub's own writes
  sleepGet: '02 0c 05 00 07 0b 3c 1e',
  sleepEvent15: '02 0c 05 00 07 00 3c 0f',
  sleepEventNever: '02 0c 05 00 07 00 3c 00',
  sleepEvent60: '02 0c 05 00 07 00 3c 3c',
  // a 1-byte write ("1e") is accepted but leaves [1e][00]: minutes = 0, i.e. never. Don't do this.
  sleepAfterOneByteWrite: '02 0c 05 00 07 0b 1e 00',

  // --- base station brightness (idx 15) and settings checksum (Profile, idx 18)
  brightnessGet: '02 0c 04 00 0f 0b 64 00',
  settingsChecksumEvent: '02 0c 09 00 12 00 00 00 f8 72 0e ad',

  // --- headset tones (idx 16)
  tonesGet: '02 0c 04 00 10 0b 01 00',
  tonesEventMinimal: '02 0c 04 00 10 00 02 00',

  // --- noise gate (MixerMic, idx 22)
  gateSupported: '02 0c 08 00 16 3e 04 00 01 02 04',
  gateGet: '02 0c 04 00 16 1e 00 00',
  gateSetAck: '02 0c 03 00 16 2b',
  gateEventHome: '02 0c 04 00 16 00 01 00',
  gateEventTournament: '02 0c 04 00 16 00 04 00',

  // --- stream-port routing (MixerAudio, idx 12)
  routingInputs: '02 0c 14 00 0c 0e 04 0a 00 00 00 06 00 00 01 09 00 00 02 07 00 00 03',
  routingOutputs: '02 0c 09 00 0c 1e 01 09 00 00 00 0f',
  routingInfo: '02 0c 07 00 0c 4e 04 e0 00 21',
  routingState: '02 0c 12 00 0c 5b 1a 00 04 00 10 01 01 10 00 02 10 01 03 10',
  routingSetGame25Request: '02 0c 13 00 0c 6b 00 1a 00 04 00 10 01 01 08 00 02 10 01 03 10',
  routingEventGame25: '02 0c 13 00 0c 20 00 1a 00 04 00 10 01 01 08 00 02 10 01 03 10',

  // --- equalizer (AdvancedParaEQ, idx 13)
  eqInfo: '02 0c 1c 00 0d 0e 02 31 fa 06 00 f1 00 00 00 01 0a 55 f0 31 fa 06 00 f1 00 00 00 1e 0a 55 f0',
  eqActiveSlot: '02 0c 04 00 0d 3b 03 00',
  // headphones onboard presets 0 (Default), 1 (Gaming), 2 (Media)
  eqHeadphonesPreset0: '02 0c 35 00 0d 5e 00 14 16 00 78 00 32 16 00 78 00 7d 16 00 78 00 fa 16 00 78 01 f4 16 00 78 03 e8 16 00 78 09 c4 16 00 78 13 88 16 00 78 27 10 16 00 78 4e 20 16 00 78',
  eqHeadphonesPreset1: '02 0c 35 00 0d 5e 00 14 16 00 14 00 32 16 00 1e 00 7d 16 00 32 00 fa 16 00 50 01 f4 16 00 78 03 e8 16 00 a0 09 c4 16 00 b4 13 88 16 00 b4 27 10 16 00 b4 4e 20 16 00 b4',
  eqHeadphonesPreset2: '02 0c 35 00 0d 5e 00 14 16 00 c8 00 32 16 00 b4 00 7d 16 00 a0 00 fa 16 00 6e 01 f4 16 00 6e 03 e8 16 00 8c 09 c4 16 00 a0 13 88 16 00 96 27 10 16 00 82 4e 20 16 00 6e',
  // mic onboard presets 0 (Default), 1 (Competition), 2 (Broadcast); read-only mic presets report q = 0
  eqMicPreset0: '02 0c 35 00 0d 5e 00 50 00 00 78 00 96 00 00 78 00 fa 00 00 78 01 90 00 00 78 03 20 00 00 78 05 dc 00 00 78 09 c4 00 00 78 13 88 00 00 78 27 10 00 00 78 4a 38 00 00 78',
  eqMicPreset1: '02 0c 35 00 0d 5e 00 50 00 00 3c 00 96 00 00 3c 00 fa 00 00 5a 01 90 00 00 78 03 20 00 00 78 05 dc 00 00 8c 09 c4 00 00 96 13 88 00 00 96 27 10 00 00 96 4a 38 00 00 a0',
  eqMicPreset2: '02 0c 35 00 0d 5e 00 50 00 00 c8 00 96 00 00 c8 00 fa 00 00 aa 01 90 00 00 96 03 20 00 00 78 05 dc 00 00 78 09 c4 00 00 78 13 88 00 00 82 27 10 00 00 8c 4a 38 00 00 8c',
  eqMicLive: '02 0c 36 00 0d 1b 00 00 50 16 00 78 00 96 16 00 78 00 fa 16 00 78 01 90 16 00 78 03 20 16 00 78 05 dc 16 00 78 09 c4 16 00 78 13 88 16 00 78 27 10 16 00 78 4a 38 16 00 78',
  // G Hub applying "Gaming" to the headphones (event), and our own flat write to the mic (request)
  eqEventHeadphonesGaming: '02 0c 38 00 0d 00 01 03 00 00 14 16 00 14 00 32 16 00 1e 00 7d 16 00 32 00 fa 16 00 50 01 f4 16 00 78 03 e8 16 00 a0 09 c4 16 00 b4 13 88 16 00 b4 27 10 16 00 b4 4e 20 16 00 b4',
  eqApplyMicFlatRequest: '02 0c 38 00 0d 2b 00 03 00 00 50 16 00 78 00 96 16 00 78 00 fa 16 00 78 01 90 16 00 78 03 20 16 00 78 05 dc 16 00 78 09 c4 16 00 78 13 88 16 00 78 27 10 16 00 78 4a 38 16 00 78',
} as const;

/** The 24-entry feature table: [index, id, version]. */
export const FEATURE_TABLE: [number, number, number][] = [
  [0, 0x0000, 2], [1, 0x0001, 1], [2, 0x010a, 6], [3, 0x0102, 1], [4, 0x0100, 6], [5, 0x0101, 2],
  [6, 0x0104, 4], [7, 0x0108, 3], [8, 0x0200, 4], [9, 0x0604, 2], [10, 0x0609, 2], [11, 0x0303, 4],
  [12, 0x0800, 1], [13, 0x020d, 1], [14, 0x0305, 1], [15, 0x0110, 1], [16, 0x060b, 1], [17, 0x0103, 1],
  [18, 0x0004, 4], [19, 0x020e, 2], [20, 0x0806, 1], [21, 0x0805, 1], [22, 0x0801, 1], [23, 0x0807, 1],
];
