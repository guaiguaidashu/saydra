// Offline checks for the live preview: when a sentence settles, what the preview
// shows while audio streams in, and how that text is laid out on the card.
// Usage: npm run test:live
import { createLivePreview, GAP_MS, LIVE_RATE as RATE, sentenceEnd } from '../src/main/asr/live'
import { acceptTidy, displayText, joinLive, revealStep } from '../src/shared/live-text'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}

const voice = (sec: number) => new Float32Array(Math.round(sec * RATE)).map(() => (Math.random() - 0.5) * 0.3)
const quiet = (sec: number) => new Float32Array(Math.round(sec * RATE)).map(() => (Math.random() - 0.5) * 0.004)
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}

// --- when a sentence settles ------------------------------------------------
const short = concat(voice(2), quiet(0.5))
check('a short phrase before a breath keeps growing', sentenceEnd(short, 0, short.length) === null)
const done = concat(voice(4), quiet(0.5))
const cut = sentenceEnd(done, 0, done.length)
check('a sentence followed by a pause settles', cut !== null && Math.abs(cut / RATE - 4.2) < 0.05, `cut at ${cut && cut / RATE}`)
const resumed = concat(voice(4), quiet(0.5), voice(0.5))
const missed = sentenceEnd(resumed, 0, resumed.length)
check('a pause between reads still settles', missed !== null && Math.abs(missed / RATE - 4.2) < 0.05, `cut at ${missed && missed / RATE}`)
const breath = concat(voice(4), quiet(0.25), voice(0.5))
check('a breath does not split a sentence', sentenceEnd(breath, 0, breath.length) === null)
const run = concat(voice(8), quiet(0.15), voice(2.5))
const forced = sentenceEnd(run, 0, run.length)
check(
  'no pause in 10 s: cut at the quietest spot',
  forced !== null && forced / RATE > 7.95 && forced / RATE < 8.2,
  `cut at ${forced && forced / RATE}`
)
const offset = concat(voice(5), quiet(0.5), voice(4), quiet(0.5))
const second = sentenceEnd(offset, 5.3 * RATE, offset.length)
check('later sentences measure from their own start', second !== null && Math.abs(second / RATE - 9.7) < 0.05, `cut at ${second && second / RATE}`)

// --- streaming --------------------------------------------------------------
// A fake model that "hears" one character per second of voice.
async function fakeTranscribe(samples: Float32Array): Promise<string> {
  await new Promise((r) => setTimeout(r, 20))
  let voiced = 0
  for (let s = 0; s + RATE / 10 <= samples.length; s += RATE / 10) {
    let e = 0
    for (let i = s; i < s + RATE / 10; i++) e += samples[i] * samples[i]
    if (Math.sqrt(e / (RATE / 10)) > 0.01) voiced++
  }
  return '字'.repeat(Math.round(voiced / 10))
}

async function stream(
  audio: Float32Array,
  onView: (v: { text: string; full: string; split: number }) => void,
  reads: (s: Float32Array) => void
) {
  // What the card is told: the words, and where the settled part ends. A sentence
  // that settles was the tail a moment ago, so the words can be the same while the
  // card still changes — the tail turns white.
  const live = createLivePreview(
    async (s) => (reads(s), fakeTranscribe(s)),
    (done, tail) => onView({ text: done.join('') + tail, ...joinLive(displayText(done, [], tail)) })
  )
  const chunk = RATE / 5 // 200 ms, like the recorder; fed 4x faster than real time
  for (let at = 0; at < audio.length; at += chunk) {
    live.push(audio.subarray(at, at + chunk))
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, GAP_MS * 4))
  await live.stop()
  return live.stats()
}

void (async () => {
  const views: { text: string; full: string; split: number }[] = []
  let longest = 0
  // 4 s, pause, 5 s, pause, 3 s: 12 characters in all
  const speech = concat(voice(4), quiet(0.6), voice(5), quiet(0.6), voice(3))
  const stats = await stream(speech, (v) => views.push(v), (s) => (longest = Math.max(longest, s.length / RATE)))
  const texts = views.map((v) => v.text)
  const last = texts.at(-1) ?? ''
  // The card is told the words and where the settled part ends, so what has to
  // change every time is that pair: a sentence that settles was the tail a
  // moment ago, so the words may be the same while the card still changes.
  check(
    'preview grows as the user talks',
    views.length >= 3 &&
      views.every((v, i) => i === 0 || v.full !== views[i - 1].full || v.split !== views[i - 1].split),
    views.map((v) => `${v.full}#${v.split}`).join(' | ')
  )
  check('preview ends with everything said', last.length === 12, `${last.length} chars: ${texts.join(' | ')}`)
  check('settled sentences are not read again', longest < 6.5, `longest read ${longest.toFixed(1)} s`)
  check('reads are counted', stats.runs >= 3 && stats.maxMs > 0, JSON.stringify(stats))

  // A sentence that settles was the tail a moment ago: the words on the card do
  // not change, only their place does — the tail turns white. The card must be
  // told that, so what it gets has to change even when the words do not.
  {
    const views: { full: string; split: number }[] = []
    const preview = createLivePreview(fakeTranscribe, (done, tail) => {
      views.push(joinLive(displayText(done, [], tail)))
    })
    preview.push(voice(4))
    await new Promise((r) => setTimeout(r, GAP_MS * 2)) // the read sees the voice, no pause yet
    preview.push(quiet(0.25))
    await new Promise((r) => setTimeout(r, GAP_MS * 2)) // 250 ms of quiet: too short to settle
    preview.push(quiet(0.3))
    await new Promise((r) => setTimeout(r, GAP_MS * 2)) // 550 ms of quiet: the sentence settles
    await preview.stop()
    const last = views.at(-1)
    check(
      'a settled sentence is shown as settled',
      !!last && last.split > 0 && last.full.length > 0,
      JSON.stringify(views)
    )
  }

  // stop() waits for the read in flight, and nothing is read after it
  let reading = 0
  let after = 0
  let stopped = false
  const live = createLivePreview(async () => {
    if (stopped) after++
    reading++
    await new Promise((r) => setTimeout(r, 300))
    reading--
    return '字'
  }, () => {})
  live.push(voice(2))
  await new Promise((r) => setTimeout(r, GAP_MS + 50))
  await live.stop()
  stopped = true
  check('stop waits for the read in flight', reading === 0)
  await new Promise((r) => setTimeout(r, GAP_MS * 3))
  check('nothing is read after stop', after === 0)

  // A long dictation: the buffer drops settled sentences instead of keeping 15 minutes.
  const long = createLivePreview(async () => '字', () => {})
  for (let i = 0; i < 40; i++) {
    long.push(concat(voice(4), quiet(0.6)))
    await new Promise((r) => setTimeout(r, GAP_MS * 2))
  }
  await long.stop()
  check('long dictations keep reading', long.stats().runs >= 40, JSON.stringify(long.stats()))

  // --- the card --------------------------------------------------------------
  const raw = displayText(['效果还是可以的', '我觉得'], [], '结构太固定')
  check('before the tidy, settled sentences join with a comma', raw.settled === '效果还是可以的，我觉得' && raw.tail === '结构太固定', JSON.stringify(raw))
  const half = displayText(['嗯效果还是可以的', '我觉得'], ['效果，还是可以的。'], '结构太固定')
  check('a tidied sentence replaces the raw one, its full stop a comma', half.settled === '效果，还是可以的，我觉得' && half.tail === '结构太固定', JSON.stringify(half))
  const ended = displayText(['明天开会'], ['明天开会。'], '')
  check('no full stop while still talking', ended.settled === '明天开会' && ended.tail === '', JSON.stringify(ended))
  const asking = displayText(['你觉得怎么样'], ['你觉得怎么样？'], '然后')
  check('marks between sentences stay', asking.settled === '你觉得怎么样？' && asking.tail === '然后', JSON.stringify(asking))
  const english = displayText(['I use Claude', 'Code daily'], [], '')
  check('english sentences join with a comma and space', english.settled === 'I use Claude, Code daily', JSON.stringify(english))
  const empty = displayText(['嗯', '明天开会'], [''], '')
  check('a sentence tidied to nothing leaves no stray comma', empty.settled === '明天开会', JSON.stringify(empty))
  const kept = displayText(Array.from({ length: 50 }, () => '字'.repeat(10)), [], '尾巴')
  check('only the end of a long dictation is kept', kept.settled.replace(/，/g, '').length === 200, String(kept.settled.length))
  check('english across settled and tail keeps a space', joinLive({ settled: 'I use Claude,', tail: 'Code' }).full === 'I use Claude, Code')
  const joined = joinLive({ settled: '结构太固定了', tail: '就每次' })
  check('the tail follows a comma, which belongs to the settled part', joined.full === '结构太固定了，就每次' && joined.split === 7, JSON.stringify(joined))
  check('a question mark needs no comma', joinLive({ settled: '对吧？', tail: '然后' }).full === '对吧？然后')

  // the light tidy may add marks and drop fillers, nothing else
  check('tidy: marks and dropped fillers pass', acceptTidy('呃那个那个我们先把这个版本发出去然后再说', '那个我们先把这个版本发出去，然后再说。'))
  check('tidy: stutters dropped pass', acceptTidy('就是这个这个结构太固定了', '就是这个结构太固定了。'))
  check('tidy: english case is not a change', acceptTidy('OK那我们就这么定了', 'ok，那我们就这么定了。'))
  check('tidy: only fillers may come back empty', acceptTidy('嗯', '') && !acceptTidy('明天下午三点开会', ''))
  check('tidy: a changed word is rejected', !acceptTidy('版本号是零点二点十五', '版本号是0.2.15'))
  check('tidy: an answer is rejected', !acceptTidy('帮我查一下北京明天的天气', '北京明天晴，最高 20 度。'))
  check('tidy: added words are rejected', !acceptTidy('明天开会', '明天上午开会'))
  check('tidy: dropping too much is rejected', !acceptTidy('这个功能我觉得做得还不错但是有两个问题', '这个功能不错'))

  const grow = revealStep('提出三', '提出三个问题')
  check('new words are typed out', grow.now === '提出三' && grow.pending === '个问题', JSON.stringify(grow))
  const fix = revealStep('提出相作', '提出三个问题')
  check('corrections show at once, only the growth is typed', fix.now === '提出三个' && fix.pending === '问题', JSON.stringify(fix))
  const shrink = revealStep('提出相作用', '提出三')
  check('shorter text replaces at once', shrink.now === '提出三' && shrink.pending === '', JSON.stringify(shrink))

  console.log(failed ? `\n${failed} failed` : '\nall passed')
  process.exit(failed ? 1 : 0)
})()
