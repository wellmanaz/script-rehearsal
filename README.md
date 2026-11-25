# Script Rehearsal

Run your lines against the rest of the cast. Pick the part you're playing, and the app plays everyone else's lines in order: your castmates' own recordings where they've made them, the device's voice where they haven't. Your lines show as first letters (or hidden, or in full) until you've said them.

It's a static web app with no server and no build step. Scripts and recordings stay in the browser on your device.

## What works in this first version

- **Add a script** by pasting text or opening a `.txt` / `.fountain` file. The app finds the characters, scenes and stage directions and shows you what it found before you save.
- **Pick your parts.** One or more characters; everyone else is played for you.
- **Rehearse.** Start from the beginning or any scene, optionally stopping at the end of that scene. Tap **Next** (or press Space) when you've said your line; **Reveal** shows it if you're stuck; **Back** or tapping a line jumps around. Cue pickup (tight, natural, relaxed) sets the pause before the next line comes in.
- **Record lines.** For each line of a character, record, re-record, play back, or hear the cue first. Recorded lines replace the device voice in every rehearsal.
- **Record yourself while rehearsing**, then play the whole run back with your takes in place.
- **Share recordings with the cast.** "Share my recordings" saves a file with your part's recordings (or opens the share sheet on a phone). A castmate adds it with "Add castmates' recordings" and hears your voice for your lines. Lines are matched by their words, so small differences between copies of the script are fine, and nobody's recordings of their own part get overwritten.
- Works on phones: large buttons, keeps the screen awake during a run, light and dark mode.

## Script formats

Speaker names in capitals work best. Any of these layouts:

```
MAYA
You're late.

THEO: I know.

MS. OKAFOR. Places, everyone.
```

- Scene headings such as `SCENE 2`, `ACT ONE`, `INT. KITCHEN - NIGHT` or Fountain's `.HEADING` and `# Section` split the script into scenes you can rehearse one at a time.
- Stage directions go in parentheses or on their own lines. Delivery notes like `MAYA (quietly)` are shown with the line but not read aloud.
- Fountain extras are understood: a title page, `@Forced` character names, `[[notes]]`, `/* boneyard */` and `!` forced action.
- Mixed-case names (`Juliet: ...`) work once a name appears at least twice, so headings like `Setting: ...` aren't mistaken for characters.

PDFs aren't read yet. Copy the text out of the PDF and paste it.

## Running it

Open `index.html` in a browser, or serve the folder:

```
npm start            # serves on http://localhost:8080
```

Recording needs the microphone, which browsers only allow on `https://` pages or `localhost`. Hosting the folder on GitHub Pages (Settings > Pages > deploy from the default branch) gives you an https address that works on phones.

## Tests

```
npm test             # script parsing, line masking, matching shared recordings (no install needed)
npm install
npm run test:ui      # walks the whole app in jsdom with fake speech, audio and microphone
```

## Code layout

- `js/core.js` – script parser and other pure logic, shared by the app and the tests
- `js/store.js` – IndexedDB for scripts and recordings, localStorage for settings
- `js/audio.js` – device voice, playback, microphone recording
- `js/app.js` – screens and the rehearsal engine
- `js/sample.js` – a short original scene to try the app with

## Not built yet

These came up in the original brainstorm and are the likely next steps:

- **Shared cast space:** recordings and director notes synced through a small backend instead of passed around as files.
- **Director notes** on a line, visible to that actor.
- **Hands-free practice:** move on automatically when you stop speaking, and check your line against the script with speech recognition.
- **PDF import**, since most theatre scripts arrive as PDFs.
- **Read-through capture** (the copyright-friendly idea): build the script from a recorded read-through instead of uploading text.
