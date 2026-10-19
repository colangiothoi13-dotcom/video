import test from 'node:test';
import assert from 'node:assert/strict';
const subtitles = await import('../lib/subtitles.mjs');

test('SRT timestamps preserve hours and milliseconds', () => {
  assert.equal(typeof subtitles.formatSrtTimestamp, 'function', 'timestamp formatter must exist');
  assert.equal(subtitles.formatSrtTimestamp(3723.004), '01:02:03,004');
  assert.equal(subtitles.formatSrtTimestamp(59.9996), '00:01:00,000');
});

test('SRT preserves Vietnamese, emoji and explicit cue timing', () => {
  assert.equal(typeof subtitles.toSrt, 'function', 'SRT serializer must exist');
  const cues = [{id:'c1', sourceId:'s1', start:0.125, end:2.5, original:'Hello',text:'Xin chào Việt Nam! 🌿'}];
  assert.equal(subtitles.toSrt(cues), '1\n00:00:00,125 --> 00:00:02,500\nXin chào Việt Nam! 🌿\n');
});

test('long cues split into two readable lines with original source and bounded nonoverlapping times', () => {
  assert.equal(typeof subtitles.normalizeCues, 'function', 'cue normalizer must exist');
  const text = 'Xin chào Việt Nam 🌿 và tất cả các bạn đang theo dõi chương trình hôm nay. '.repeat(5);
  const cues = subtitles.normalizeCues([{id:'whisper-7', start:1, end:12, text, original:'Original sentence'}], 10);
  assert.ok(cues.length > 1);
  assert.equal(cues.map(c=>c.text.replaceAll('\n',' ')).join(' '), text.trim());
  for (const [index, cue] of cues.entries()) {
    assert.equal(cue.sourceId,'whisper-7');
    assert.equal(cue.original,'Original sentence');
    assert.ok(cue.start >= 0 && cue.start < cue.end && cue.end <= 10);
    assert.ok(cue.text.split('\n').length <= 2);
    assert.ok(cue.text.split('\n').every(line => [...line].length <= 42));
    assert.equal(typeof cue.readingWarning,'boolean');
    if (index) assert.ok(cues[index-1].end <= cue.start);
  }
  assert.equal(cues.at(-1).end,10);
  assert.ok(cues.some(c=>c.readingWarning));
});

test('reversed timestamps are rejected and overlapping segments become valid cues', () => {
  assert.equal(typeof subtitles.normalizeCues, 'function');
  assert.throws(()=>subtitles.normalizeCues([{start:2,end:1,text:'lỗi'}], 3), /thời gian/i);
  const cues = subtitles.normalizeCues([{id:1,start:0,end:2,text:'Một'},{id:2,start:1,end:3,text:'Hai'}],3);
  assert.equal(cues[1].start,2);
  assert.throws(()=>subtitles.normalizeCues([{start:NaN,end:1,text:'lỗi'}],3), /thời gian/i);
});

test('ASS styles reject unknown values and captions cannot inject override commands', () => {
  assert.equal(typeof subtitles.toAss,'function');
  const cue = {start:0,end:2,text:'Xin {\\pos(0,0)} chào\nViệt Nam 🌿'};
  for (const style of ['classic','box']) {
    const ass = subtitles.toAss([cue],style);
    assert.match(ass,/Việt Nam 🌿/);
    assert.match(ass,/Dialogue: 0,0:00:00\.00,0:00:02\.00/);
    assert.ok(!ass.includes('{\\pos(0,0)}'));
  }
  assert.throws(()=>subtitles.toAss([cue],'unknown'), /kiểu/i);
});
