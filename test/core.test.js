'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

function lines(parsed) {
  return parsed.items.filter((i) => i.type === 'line').map((i) => [i.character, i.text]);
}
function names(parsed) {
  return parsed.characters.map((c) => c.name);
}

test('block style: name on its own line, speech below', () => {
  const p = Core.parseScript(`
INT. KITCHEN - NIGHT

Maya stirs a pot.

MAYA
You're late.

THEO (CONT'D)
I know.
I'm sorry.

MAYA (quietly)
Sit down.

THEO
Fine.
`);
  assert.deepEqual(names(p), ['MAYA', 'THEO']);
  assert.deepEqual(lines(p), [
    ['MAYA', "You're late."],
    ['THEO', "I know.\nI'm sorry."],
    ['MAYA', '(quietly)\nSit down.'],
    ['THEO', 'Fine.']
  ]);
  assert.equal(p.items[0].type, 'scene');
  assert.equal(p.items[1].type, 'direction');
});

test('colon style, mixed case names, stage directions in parentheses', () => {
  const p = Core.parseScript(`Setting: A bus stop.

Juliet: Is this the 42?
Romeo: It was, an hour ago.
(A bus roars past.)
Juliet (laughing): Of course it was.
Romeo: Of course.`);
  assert.deepEqual(names(p), ['JULIET', 'ROMEO']);
  assert.deepEqual(lines(p), [
    ['JULIET', 'Is this the 42?'],
    ['ROMEO', 'It was, an hour ago.'],
    ['JULIET', '(laughing) Of course it was.'],
    ['ROMEO', 'Of course.']
  ]);
  const dirs = p.items.filter((i) => i.type === 'direction').map((i) => i.text);
  assert.deepEqual(dirs, ['Setting: A bus stop.', '(A bus roars past.)']);
});

test('period style used in published plays, with honorifics', () => {
  const p = Core.parseScript(`ACT ONE

MRS. GRANT. Places, everyone.
TOBY. Already in place.
MRS. GRANT. Then why are you holding a sandwich?
TOBY. Props.`);
  assert.deepEqual(names(p), ['MRS. GRANT', 'TOBY']);
  assert.equal(p.items[0].type, 'scene');
  assert.equal(p.items[0].text, 'ACT ONE');
  assert.equal(lines(p)[2][1], 'Then why are you holding a sandwich?');
});

test('continuation lines join the speech until a blank line', () => {
  const p = Core.parseScript(`ROSALIND: All the world's a stage,
And all the men and women merely players.

ORLANDO: Who said that?
ROSALIND: Someone.`);
  assert.equal(lines(p)[0][1], "All the world's a stage,\nAnd all the men and women merely players.");
});

test('one-line characters are kept when the style is clearly in use', () => {
  const p = Core.parseScript(`ANNA
Line one.

BEN
Line two.

ANNA
Line three.

BEN
Line four.

WAITER
Anything else?

ANNA
No.`);
  assert.deepEqual(names(p), ['ANNA', 'BEN', 'WAITER']);
});

test('caps directions and transitions are not mistaken for characters', () => {
  const p = Core.parseScript(`ANNA
One.

BEN
Two.

ANNA
Three.

BEN
Four.

MOMENTS LATER
Ben is gone.

CUT TO:

LIGHTS UP. The room is empty.`);
  assert.deepEqual(names(p), ['ANNA', 'BEN']);
  const dirs = p.items.filter((i) => i.type === 'direction').map((i) => i.text);
  assert.ok(dirs.includes('CUT TO:'));
  assert.ok(dirs.some((d) => d.startsWith('MOMENTS LATER')));
  assert.ok(dirs.includes('LIGHTS UP. The room is empty.'));
});

test('single mixed-case "Word: text" lines are treated as directions', () => {
  const p = Core.parseScript(`Lighting: warm amber.
Sam: Hello.
Lee: Hi.
Sam: Bye.
Lee: Bye.`);
  assert.deepEqual(names(p), ['SAM', 'LEE']);
  assert.equal(p.items[0].type, 'direction');
});

test('fountain title page, forced character, notes and boneyard', () => {
  const p = Core.parseScript(`Title: The Understudy
Author: Someone

@McCLANE
Yippee. [[cut this?]]

/* an old
scene */
.FLASHBACK - THE STAGE

!SILENCE
`);
  assert.equal(p.title, 'The Understudy');
  assert.deepEqual(lines(p), [['MCCLANE', 'Yippee.']]);
  assert.equal(p.items[1].type, 'scene');
  assert.equal(p.items[1].text, 'FLASHBACK - THE STAGE');
  assert.equal(p.items[2].type, 'direction');
});

test('the bundled sample scene parses into its three characters', () => {
  const raw = require('../js/sample.js').text;
  const p = Core.parseScript(raw);
  assert.deepEqual(names(p), ['MAYA', 'THEO', 'MS. OKAFOR']);
  assert.equal(p.title, 'The Callback');
  assert.ok(p.items.some((i) => i.type === 'scene'));
  for (const c of p.characters) assert.ok(c.lines >= 3, c.name + ' has lines');
});

test('maskLine shows first letters and keeps delivery notes', () => {
  assert.equal(Core.maskLine("To be, or not to be: that's it.", 'first'), "T b, o n t b: t i.");
  assert.equal(Core.maskLine('(softly) Go home.', 'first'), '(softly) G h.');
  assert.equal(Core.maskLine('Go home.', 'hidden'), '');
  assert.equal(Core.maskLine('Go home.', 'full'), 'Go home.');
});

test('spokenText drops parentheticals and emphasis', () => {
  assert.equal(Core.spokenText('(beat) I *really* mean it [aside]'), 'I really mean it');
});

test('scriptIdFor ignores line-ending and BOM differences', () => {
  assert.equal(Core.scriptIdFor('﻿A: hi\r\nB: yo\r\n'), Core.scriptIdFor('A: hi\nB: yo'));
  assert.notEqual(Core.scriptIdFor('A: hi'), Core.scriptIdFor('A: hey'));
});

test('buildRun and sceneEnd select the spoken lines of one scene', () => {
  const p = Core.parseScript(`SCENE 1
A: one
B: two
A: three
B: four

SCENE 2
A: five
B: six`);
  const scenes = Core.sceneList(p.items);
  assert.equal(scenes.length, 2);
  const end = Core.sceneEnd(p.items, scenes[0].index);
  const run = Core.buildRun(p.items, scenes[0].index, end);
  assert.deepEqual(run.map((i) => p.items[i].text), ['one', 'two', 'three', 'four']);
  const all = Core.buildRun(p.items, 0);
  assert.equal(all.length, 6);
});

test('cueFor returns the previous line within the scene', () => {
  const p = Core.parseScript(`SCENE 1
A: one
B: two
SCENE 2
A: three`);
  const two = p.items.find((i) => i.text === 'two');
  const three = p.items.find((i) => i.text === 'three');
  assert.equal(Core.cueFor(p.items, two.index).text, 'one');
  assert.equal(Core.cueFor(p.items, three.index), null);
});

test('matchImported finds lines by position, then by character and words', () => {
  const mine = Core.parseScript(`A: one\nB: two\nA: three\nB: four`);
  const theirs = Core.parseScript(`(A note at the top.)\nA: one\nB: two\nA: three\nB: four`);
  const entries = theirs.items
    .filter((i) => i.type === 'line' && i.character === 'B')
    .map((i) => ({ i: i.index, character: i.character, lineHash: Core.lineHash(i) }));
  entries.push({ i: 99, character: 'B', lineHash: 'deadbeef' });
  const { matches, unmatched } = Core.matchImported(mine.items, entries);
  assert.deepEqual(matches.map((m) => mine.items[m.index].text), ['two', 'four']);
  assert.equal(unmatched.length, 1);
});

test('matchImported does not reuse a line for repeated words', () => {
  const p = Core.parseScript(`A: yes\nB: no\nA: yes\nB: no`);
  const entries = p.items
    .filter((i) => i.type === 'line' && i.character === 'A')
    .map((i) => ({ i: 50, character: 'A', lineHash: Core.lineHash(i) }));
  const { matches } = Core.matchImported(p.items, entries);
  assert.deepEqual(matches.map((m) => m.index), [0, 2]);
});

test('chunkForSpeech keeps chunks under the limit', () => {
  const long = 'This is a sentence that goes on. '.repeat(20) + 'word '.repeat(80);
  const chunks = Core.chunkForSpeech(long, 100);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= 100, c.length + ': ' + c);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), Core.spokenText(long));
});

test('assignVoices spreads characters across English voices', () => {
  const voices = [
    { voiceURI: 'fr', lang: 'fr-FR' },
    { voiceURI: 'en1', lang: 'en-US', default: true },
    { voiceURI: 'en2', lang: 'en-GB' }
  ];
  const v = Core.assignVoices(['A', 'B', 'C'], voices);
  assert.equal(v.A.voiceURI, 'en1');
  assert.equal(v.B.voiceURI, 'en2');
  assert.equal(v.C.voiceURI, 'en1');
  assert.notEqual(v.A.pitch, v.C.pitch);
  const none = Core.assignVoices(['A', 'B'], []);
  assert.equal(none.A.voiceURI, null);
  assert.notEqual(none.A.pitch, none.B.pitch);
});
