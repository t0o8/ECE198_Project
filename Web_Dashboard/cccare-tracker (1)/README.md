# CCCARE exercise tracking

A prototype website for sub-problem 2, exercise tracking and measurement. The instructor sees up to 30 participants at once. Each participant has a block showing their workout (several exercises, each with sets and reps), their movement quality and exertion, and what they are doing wrong. When the instructor ends the session, everyone gets a results page with a percentage success, a breakdown by exercise, and a Progress graph across earlier sessions.

The site is plain HTML, CSS and JavaScript. There is no build step and no libraries, and it works offline.

## Running it

- **From your computer:** unzip the folder and open `index.html` in Chrome or Edge. This was tested in Chromium, which both are built on. Firefox reportedly keeps browser storage separate for each local file, so signing in may not carry over to the next page there. In Firefox, use a hosted copy or a local server instead.
- **Local server:** run `python3 -m http.server 8000` in this folder and go to <http://localhost:8000>. This works in any browser.

Because the patient screen follows the instructor's session through this browser's storage, see them both at once by opening `instructor.html` in one tab (signed in as the instructor) and `patient.html` in another (signed in as the patient), in the same browser.

## Connecting a backend

Out of the box everything is kept in the browser, so the site runs with no server. To keep the data on a server instead:

1. **Use the reference server.** Run `python3 server/server.py` in this folder (Python 3.8 or later, no packages needed) and open <http://localhost:8000>. The server serves the site and the API together, so nothing needs configuring. It stores the data in `server/data.json` (not committed to git), checks sign-ins on the server with hashed passwords, and lets patient screens follow the instructor from other devices. Add `--host 0.0.0.0` to let phones and laptops on the same network connect.
2. **Use your own server.** Implement the endpoints in [API.md](API.md), in any language, then set `apiBase` in `js/config.js` to its address. You can also add `?api=https://your-server/api` to any page's address to try it without editing anything. `?api=off` switches back to browser storage.

Behind the scenes, all saving and loading goes through one file, `js/store.js`. Each page runs inside `CC.start(...)`, which loads the signed-in person's data from the backend first. If the backend can't be reached, the page says so and doesn't fail silently. Saving a session, a profile or the roster waits for the server's answer. If the save fails, the page shows the reason, and for a session it offers to try again.

The reference server is a starting point, not a hardened production server. Put it behind HTTPS before real patient data goes near it.

## Putting it online

It is a static site, so any static host works. Two free options:

**Netlify Drop (about a minute)**

1. Go to <https://app.netlify.com/drop>.
2. Drag `cccare-tracker.zip`, or the unzipped folder, onto the page.
3. Sign up for a free account when asked. Without an account the site is deleted after about an hour.

**GitHub Pages (a few minutes, stays up)**

1. Create a new **public** repository at <https://github.com/new>, for example `cccare-tracker`. Free accounts need a public repository for Pages.
2. On the new repository's page, choose **uploading an existing file**. Drag in everything *inside* the unzipped folder, not the folder itself, then commit.
3. Open **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose `main` and `/ (root)`, and save.
4. After a minute or two the site is at `https://<your-username>.github.io/cccare-tracker/`.

Sample accounts (the username is not case-sensitive, the password is):

| Role | Username | Password |
| --- | --- | --- |
| Instructor | `InsU` | `InsP` |
| Patient | `PatU` | `PatP` (linked to participant 01) |

On the sign-in page, enter a username and password; the account decides whether you go to the instructor or patient pages. First-time users press **Sign up**, choose a username and password, and pick **Instructor** or **Patient**. A new patient account is linked to the first block number no other account uses, and that block's name on the roster is set to the username until the instructor changes it. New accounts are kept in this browser's `localStorage`, passwords included, so this is only for the prototype.

## Pages

| File | Who | What it does |
| --- | --- | --- |
| `index.html` | everyone | Sign in, or sign up as an instructor or patient. |
| `instructor.html` | instructor | Set up the class (1 to 30 participants, a name and a full workout for each), then the live dashboard. Each row's workout is a dropdown. **Edit** opens the workout editor: sets, reps and rest (15 to 300 seconds) per exercise, and an exercise library of square cards with an animation of each exercise (muscles worked in red), grouped and filterable by muscle group. **Copy to all** applies one person's workout to everyone. During a session, **Pause** freezes the clock, rest countdowns and rep counting for everyone until **Resume**. |
| `profile.html` | both | Your profile: picture (cropped and shrunk to 256 px), birthday and a biography of up to 500 characters. Linked from the header on every page. |
| `patient.html` | patient | One large block for the signed-in patient. It can't be started by the patient: it goes live on its own when the instructor starts the class, and opens the patient's results when the instructor ends it. |
| `session-results.html` | instructor | Everyone's results for a session. A row opens that patient's results. |
| `patient-results.html` | both | One patient's results: overall success, a row per exercise, what went wrong, and the **Progress** button. Patients can only open their own results. |

A blank name shows as "Patient" plus the block number. **End session** asks for a second press within four seconds so it can't be ended by accident.

## What the numbers mean

A **workout** is a list of exercises, each done for a number of **sets** of a number of **reps** (for example, sit-to-stand, 2 sets of 10).

**Exercise success**, 0 to 100%, is how closely the sets were done as planned, multiplied by the average movement quality of that exercise's reps:

```
adherence = 1 − (sum over sets of |reps done − reps planned| + reps past the last set) / total planned reps
exercise success = adherence × average quality
```

**Workout success** combines the exercises, weighted by how many reps each one plans. For example, 2 sets of 10 done as 10 and 10 at 85% quality scores 85%. Done as 10 and 5, or as 10 and 15, at 85% quality it scores 64%. Stopping a set short and going past it cost the same, because both came up in the brief. To change the rule, edit the scoring functions in `js/score.js`.

**The wheels.** Each live block has two. The big wheel is the current exercise: it fills to that exercise's success and shows the set it's on ("set 2 of 3") and the reps done in that set ("6/10 reps"). The small wheel beside it is the whole session, with the sets finished so far ("2/6 sets"). Each exercise row shows its sets finished. A wheel's colour, red through orange and yellow to green, is how well the exercise (or, for the session wheel, the average of the exercises) is going, so it doesn't just track progress: only finished sets count toward adherence, so a good start shows green while the wheel is still nearly empty. On results pages the wheel's colour is the average of the exercises' success. The percentage is always printed in the middle for anyone who can't tell the colours apart.

**Session results** put a coloured box next to each person's reps, sets finished, quality and exertion, red (poor) to green (good). Reps lose points for going over as well as stopping short; exertion is judged by its peak, green up to 5 of 10 and red at 9 or more. The rules are `statScore` in `js/ui.js`.

**The patient screen** shows an encouraging message above the block that changes every 18 seconds or so, suited to the moment (starting, working, good form, resting, nearly done, finished, paused). The messages are `CHEERS` in `js/pages/patient.js`.

**The strip along the bottom** turns black with a pulsing red outline when something needs attention, and shows the message only (no topic label):

- Very hard effort, 8 or more out of 10
- Reps over the planned count for the current set, or past the last set
- A form fault reported by the camera, such as "Knees caving inward on the way up"

A form fault, or going over the planned reps, only counts as an error once at least 2 reps show it (`errorReps` in `LIMITS`). This applies live and in the saved results.
- No reps for a while (the time ticks over into minutes, hours and days)

On the patient's screen each message also carries a short cue, such as "Keep your knees in line with your toes."

**Exercises.** The library has 22 exercises in seven groups:

| Group | Exercises |
| --- | --- |
| Legs | sit-to-stand, mini squat, heel raise, squat, lunge, Romanian deadlift, glute bridge |
| Chest | wall push-up, push-up |
| Back | bent-over row, superman |
| Arms | bicep curl, overhead tricep extension |
| Shoulders | front arm raise, shoulder press |
| Core | plank, crunch, bird dog |
| Cardio | jumping jacks, high knees, mountain climbers, jump squat |

Each exercise added from the library starts with its own usual sets and reps (for example squat 3×12, jumping jacks 3×30). The plank is held for time, so its "reps per set" are seconds, shown as `3×30s`. The camera pipeline sends one `rep` event per second held.

The thresholds are in `LIMITS` in `js/score.js`. The exercises, their faults and the patient cues are in `js/exercises.js`; the sample starting workouts are `CC.WORKOUTS` in the same file.

**Ending early.** If the instructor ends the session before someone has finished, their result only counts the exercises they reached, and the sets of the current exercise up to the one they were on; exercises they never got to aren't counted against them. The session results page then opens with an alert saying the session was ended early and where each unfinished person stopped (exercise, set and reps in that set). That patient's results page shows the same note.

**Nickname.** On the profile page, anyone can set a nickname of up to 30 characters. It's shown on their own screens instead of their username (the header, and for patients their live screen and results), and the encouraging messages use it. The username still shows on the profile, as @username.

**Profile picture.** On the profile page, the paperclip chooses a picture file. The camera button asks the browser for camera access, shows a mirrored preview with the square that will be used, and takes the picture. Browsers only allow the camera on `https://` pages and `localhost`; elsewhere, and when access is blocked, the page says so and the paperclip still works. The camera turns off as soon as the picture is taken, cancelled or the page is left.

**Motion.** Pages ease in, and fade out before the next one opens (for example after signing in). The sign-in and sign-up forms slide in when switching between them. Starting a session fades the set-up away and brings the blocks in one after another; ending it folds the blocks away before the results come in row by row. Dropdowns and panels (the workout lists, the workout editor, "How success is worked out", the ended-early details, Progress) slide open and shut. Switching night mode spreads the new colours out in a circle from the button, in browsers that support view transitions (Chrome and Edge); others fade the colours over. Everything moves instantly instead for anyone whose system is set to reduce motion. The code is `js/motion.js` and the motion section of `css/style.css`.

**Look.** Text is set in DM Sans (bundled in `css/fonts/`, SIL Open Font License). The moon button in the top right switches night mode; the choice is remembered in this browser. The GitHub button next to it opens the repository.

## Safety: possible emergencies

During a live session, each block shows what the person is doing, under their name: **Exercising**, **Resting**, **Waiting to start**, **Finished**, or **Not moving for …**. The last one appears when the camera has seen no movement for 30 seconds, or for 30 seconds beyond the planned rest.

If someone may be hurt, exhausted or unconscious, their whole block gets a thick pulsing red outline, with a red warning banner across the top. They're also listed first, in red, as **Possible emergency** above the grid. The signs (`Tracker.dangers` in `js/score.js`, thresholds in `LIMITS`):

| Alert | When |
| --- | --- |
| May be unconscious | fallen, or on the floor during a standing exercise, and not moving for 15 seconds |
| May be hurt | the camera reports a fall; or on the floor during a standing exercise; or form suddenly 30 points worse than usual, then they stop mid-set |
| May be exhausted | effort 9.5 of 10, or 9 of 10 for 20 seconds; or very hard effort with form suddenly much worse |

These are reasons to go and check, not a diagnosis: the camera can't be certain. **Checked, OK** on the banner stops the pulsing once the instructor has seen to them. The banner stays until the signs clear, and a different alert pulses again. The patient's own screen shows "Are you OK? Your instructor has been alerted" with what to do, and stops the encouraging messages. Alerts keep working while the session is paused. Every alert is saved with the results, so it shows on the session results page and in the patient's "To work on" list.

Floor exercises (push-up, plank, crunch, glute bridge, superman, bird dog, mountain climbers) are marked `floor: true` in `js/exercises.js`, so being on the floor during them is normal.

The simulator gives each person a 2% chance of a simulated emergency (a fall, fainting, or exhaustion). To see them on purpose, add `?incidents=3` to `instructor.html` to make three people have one, together with `?speed=10` so it happens quickly.

## How the patient screen follows the instructor

The patient can't start or stop a session. While a session runs, the instructor's page writes each participant's live block to this browser's storage twice a second. The patient page reads its own block from there, so it goes live when the instructor starts and opens the results when the instructor ends. This works for tabs in the **same browser on the same computer**. Across different devices it would need a small relay server (the same WebSocket server described below could carry it).

## Connecting the camera, neural network and ESP32

Without any setup, a simulator in the browser makes up the data. To use real data, run a WebSocket server on the machine running the neural network, then open:

```
instructor.html?feed=ws://192.168.1.20:8765
```

The address is remembered for that browser tab. Use `?feed=off` to go back to the simulator.

The server sends JSON messages, one at a time or several in an array:

```json
{ "type": "rep", "pid": "P03", "quality": 82, "faults": ["knees_in"], "exercise": "sit_to_stand" }
{ "type": "exertion", "pid": "P03", "value": 6 }
{ "type": "faults", "pid": "P03", "faults": ["lean_forward"] }
{ "type": "motion", "pid": "P03", "level": 0.6 }
{ "type": "posture", "pid": "P03", "posture": "fallen" }
```

- `pid` is the block number, written as `"P03"`, `"3"` or `3`.
- `rep` is one finished repetition. `quality` is 0 to 100. `faults` lists the fault codes seen during that rep, or is empty. `exercise` is optional: when given, the rep is counted against that exercise in the workout; when left out, reps fill the workout in order, and a pause of about 15 seconds starts the next set.
- `exertion` is on a 0 to 10 scale. It can come from a heart-rate sensor on the ESP32 or be estimated from movement.
- `faults` on its own sends live form feedback between reps.
- `motion` is how much the person is moving, `level` 0 (completely still) to 1, sent every second or two. It drives "Not moving" and the unconscious alert. Without it, only "No reps for …" can be shown.
- `posture` is `upright` (standing, sitting or kneeling), `floor` (lying) or `fallen` (a fall was seen), sent when it changes. It drives the hurt and unconscious alerts.
- While the session is paused, reps and form feedback are ignored, but `motion`, `posture` and `exertion` still count, so alerts keep working.
- Fault codes are listed per exercise in `js/exercises.js`. An unknown code is shown as plain text.

When a session starts, the dashboard sends `{"type":"session","state":"start","participants":["P01",…],"workouts":{…}}`, where `workouts` maps each station to its planned exercises, sets, reps and rest seconds. It sends `{"type":"session","state":"pause"}` and `{"type":"session","state":"resume"}` when the instructor pauses (events that arrive while paused are ignored), and `{"type":"session","state":"end"}` when the session ends. Invalid messages are ignored.

A minimal test server in Python (`pip install websockets`). This is an untested sketch:

```python
import asyncio, json, random
import websockets

async def handler(ws):
    hello = json.loads(await ws.recv())          # the "session start" message
    stations = hello.get("participants", ["P01"])
    while True:
        await ws.send(json.dumps({"type": "rep", "pid": random.choice(stations),
                                  "quality": random.randint(55, 98), "faults": []}))
        await asyncio.sleep(1)

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

asyncio.run(main())
```

If the site is served over `https://`, browsers block plain `ws://` connections, so use `wss://`. Opening the site from a file or from `http://localhost` avoids this.

## Demo tips

- Add `?speed=3` to `instructor.html` to make the simulator three times faster. The patient screen follows along at the same speed.
- The progress graphs start with sample history: 14 Tuesday and Thursday classes before today, labelled "sample". Sessions you run are added after them.
- **Reset sample data**, in the instructor footer, deletes saved sessions, names and workouts.

## Limits of the prototype

- Sign-in is checked in the browser against hard-coded passwords, and all data is kept in the browser's `localStorage`. This is fine for a demo but not for real patient data. A real deployment needs server-side sign-in and storage that meets Ontario's health privacy law (PHIPA).
- The patient screen follows the instructor only within the same browser on one computer. Separate devices need a relay server.
- Exertion and form scores are only as good as the pipeline that sends them. The website displays and scores what it receives.

## Files

```
API.md                   the REST API a backend provides
server/server.py         reference backend: serves the site and the API (plain Python)
js/config.js             where data is kept: this browser, or a backend
index.html               sign in and sign up
instructor.html          set-up, workout editor and live dashboard
patient.html             patient's live block, driven by the instructor
session-results.html     instructor: everyone's results
patient-results.html     one patient's results and progress graphs
profile.html             picture, birthday and biography
css/style.css            all styling
img/exercises/*.gif      exercise animations (muscles worked in red)
tools/make_exercise_gifs.py  renders those animations in 3D (needs numpy and Pillow; about 3 minutes per exercise on 8 cores; --preview for quick stills)
js/motion.js             page fades, sliding dropdowns and panels, the night-mode reveal
js/theme.js              night mode and the GitHub button (loaded in each page's head)
js/util.js               helpers (dates, durations, random numbers, safe element building)
js/exercises.js          exercises, fault messages, cues, sample workouts
js/score.js              workout scoring, thresholds, live tracker
js/store.js              accounts, roster, sessions, profiles, live link: browser storage or the backend
js/feed.js               simulator and WebSocket feed
js/ui.js                 wheel, bars, participant block, shared page parts
js/chart.js              progress line graph
js/pages/*.js            one script per page
```
