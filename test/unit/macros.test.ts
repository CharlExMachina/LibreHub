import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFor } from '../../src/mouse/actions.js';
import { acquireAgentLock, agentLockHolder } from '../../src/mouse/agent.js';
import { DOUBLE_CLICK, formatMacro, keyForChar, macroSectorsFor, packMacros, parseMacro, readMacro, textToSteps } from '../../src/mouse/macros.js';
import { decodeMacro, encodeMacro, Modifier, sectorCrcOk } from '../../src/mouse/onboard.js';
import { formatFreestyle, parseAssignment, parseFreestyle, SoftwareStore } from '../../src/mouse/software.js';
import { toHex } from '../../src/mouse/hidpp.js';

describe('macros the mouse plays', () => {
  it('types text as key taps, with Shift for capitals and symbols (US layout)', () => {
    const steps = textToSteps('Hi!');
    expect(toHex(encodeMacro(steps))).toBe('43 02 0b 44 02 0b 43 00 0c 44 00 0c 43 02 1e 44 02 1e ff');
    expect(keyForChar(' ')).toEqual({ usage: 0x2c, shift: false });
    expect(keyForChar('?')).toEqual({ usage: 0x38, shift: true });
    expect(() => textToSteps('café')).toThrow(/printable ASCII/);
    expect(() => textToSteps('')).toThrow(/empty/);
  });

  it('is the same "hi" macro that typed on the real mouse, apart from the pause', () => {
    // lab.txt test 3: 43 00 0b 44 00 0b 40 00 1e 43 00 0c 44 00 0c ff typed "hi".
    expect(toHex(encodeMacro(textToSteps('hi')))).toBe('43 00 0b 44 00 0b 43 00 0c 44 00 0c ff');
  });

  it.each([
    ['text:Hello, World!', 'text:Hello, World!'],
    ['double-click', 'double-click'],
    ['macro:ctrl+c, 50ms, ctrl+v', 'macro:ctrl+c, 50ms, ctrl+v'],
    ['macro:down:shift, a, up:shift, mouse:left, media:mute, wheel:-3, hwheel:2', 'macro:down:shift, a, up:shift, mouse:left, media:mute, wheel:-3, hwheel:2'],
    ['macro:down:mouse:right, 200ms, up:mouse:right', 'macro:down:mouse:right, 200ms, up:mouse:right'],
    ['macro:delay:20, key:gui+space', 'macro:20ms, gui+space'],
  ])('%s round-trips through the mouse format', (input, shown) => {
    const a = parseAssignment(input);
    if (a.kind !== 'macro') throw new Error('expected a macro');
    expect(formatMacro(decodeMacro(encodeMacro(a.steps)))).toBe(shown);
  });

  it('shows a macro of plain key taps as text only when it is printable text', () => {
    expect(formatMacro(parseMacro('enter'))).toBe('macro:enter');
    expect(formatMacro(parseMacro('ctrl+a'))).toBe('macro:ctrl+a');
    expect(formatMacro(DOUBLE_CLICK)).toBe('double-click');
  });

  it('rejects bad steps with a useful message', () => {
    expect(() => parseMacro('ctrl+c,,ctrl+v')).toThrow(/empty macro step/);
    expect(() => parseMacro('0ms')).toThrow(/1..65535/);
    expect(() => parseMacro('wheel:500')).toThrow(/-128..127/);
    expect(() => parseMacro('mouse:thumb')).toThrow(/unknown mouse button/);
    expect(() => parseMacro('hyper+a')).toThrow(/unknown modifier/);
  });

  it('gives each profile two sectors of its own', () => {
    expect([1, 2, 3, 4, 5].map(macroSectorsFor)).toEqual([[6, 7], [8, 9], [10, 11], [12, 13], [14, 15]]);
    expect(() => macroSectorsFor(6)).toThrow(RangeError);
  });

  it('packs macros first-fit into the sectors, checksummed, and refuses what does not fit', () => {
    const long = textToSteps('a'.repeat(40)); // 241 bytes
    const short = textToSteps('ok');
    const packed = packMacros([long, short, short], [6, 7], 255);
    // 241 + 13 bytes would overflow sector 6 (253 usable), so both short ones go to sector 7.
    expect(packed.pointers).toEqual([{ sector: 6, offset: 0 }, { sector: 7, offset: 0 }, { sector: 7, offset: 13 }]);
    expect([...packed.sectors.values()].every(sectorCrcOk)).toBe(true);
    expect(readMacro(packed.sectors.get(7), 13)).toEqual(short);
    expect(() => packMacros([textToSteps('a'.repeat(43))], [6, 7], 255)).toThrow(/at most 253/);
    expect(() => packMacros([long, long, long], [6, 7], 255)).toThrow(/more than the 506 bytes/);
    expect(readMacro(new Uint8Array(255).fill(0xff), 0)).toBeUndefined();
  });
});

describe('assignments, software actions and Freestyle', () => {
  it('keeps the case of text and commands, and the binding syntax still works', () => {
    expect(parseAssignment('open:/Applications/Calculator.app')).toEqual({ kind: 'software', action: { type: 'open', target: '/Applications/Calculator.app' } });
    expect(parseAssignment('RUN: notify-send "Hi There"')).toEqual({ kind: 'software', action: { type: 'run', command: 'notify-send "Hi There"' } });
    expect(parseAssignment('key:ctrl+T')).toEqual({ kind: 'binding', binding: { type: 'key', modifiers: Modifier.lctrl, usage: 0x17 } });
    expect(parseAssignment('disabled')).toEqual({ kind: 'binding', binding: { type: 'disabled' } });
    expect(() => parseAssignment('open:')).toThrow(/needs an app/);
  });

  it('opens and runs with the platform tools', () => {
    expect(commandFor({ type: 'open', target: 'https://example.com' }, 'darwin')).toEqual(['open', ['https://example.com']]);
    expect(commandFor({ type: 'open', target: 'firefox.desktop' }, 'linux')).toEqual(['xdg-open', ['firefox.desktop']]);
    expect(commandFor({ type: 'run', command: 'loginctl lock-session' }, 'linux')).toEqual(['/bin/sh', ['-c', 'loginctl lock-session']]);
  });

  it('reads Freestyle colours left to right and maps them to G Hub\'s LED numbers', () => {
    const f = parseFreestyle('#ff0000,#ff8000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ffffff')!;
    expect(f).toEqual({ 3: '#ff0000', 4: '#ff8000', 8: '#ffff00', 7: '#00ff00', 6: '#00ffff', 5: '#0000ff', 2: '#ff00ff', 1: '#ffffff' });
    expect(formatFreestyle(f)).toBe('#ff0000,#ff8000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ffffff');
    expect(Object.values(parseFreestyle('00ffff')!)).toEqual(new Array(8).fill('#00ffff'));
    expect(parseFreestyle('off')).toBeNull();
    expect(() => parseFreestyle('#ff0000,#00ff00')).toThrow(/8 colours/);
    expect(() => parseFreestyle('red')).toThrow(/#rrggbb/);
  });

  it('stores settings per profile, drops what it cannot trust, and removes empty profiles', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'g502x-')), 'sub', 'g502x.json');
    const store = new SoftwareStore(file);
    expect(await store.read()).toEqual({ version: 1, profiles: {} });
    await store.update(2, (p) => {
      p.actions.base.g9 = { type: 'open', target: 'https://example.com' };
    });
    expect((await store.read()).profiles['2'].actions.base.g9).toEqual({ type: 'open', target: 'https://example.com' });
    await store.update(2, (p) => {
      delete p.actions.base.g9;
    });
    expect(await store.read()).toEqual({ version: 1, profiles: {} });
    writeFileSync(file, JSON.stringify({ profiles: { 1: { actions: { base: { g9: { type: 'run' }, nope: { type: 'run', command: 'x' }, back: { type: 'run', command: 'ok' } } }, freestyle: { 1: '#00FF00', 9: '#000000', 2: 'red' } }, 7: {} } }));
    expect(await store.read()).toEqual({ version: 1, profiles: { 1: { actions: { base: { back: { type: 'run', command: 'ok' } }, gshift: {} }, freestyle: { 1: '#00ff00' } } } });
    writeFileSync(file, '{ not json');
    await expect(store.read()).rejects.toThrow(/not valid JSON/);
  });

  it('lets one agent run at a time and takes over a lock left by a dead process', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'g502x-')), 'agent.lock');
    const release = acquireAgentLock(file)!;
    expect(release).toBeTypeOf('function');
    expect(agentLockHolder(file)).toBe(process.pid);
    writeFileSync(file, '1'); // pid 1 is alive (and not us)
    expect(acquireAgentLock(file)).toBeNull();
    writeFileSync(file, '999999999'); // no such process
    const again = acquireAgentLock(file)!;
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    again();
    expect(existsSync(file)).toBe(false);
  });
});
